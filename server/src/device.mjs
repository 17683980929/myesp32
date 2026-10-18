/**
 * device.mjs — 一台设备的会话
 *
 * 负责：握手、收音频、跑对话链路（ASR→LLM→TTS）、定时推送信息栏。
 *
 * 音频下行用「生产者/消费者」：LLM 每切出一句就丢进队列，
 * 发送循环自适应节拍往外发（见下方节拍常量注释）。这样合成和播放能重叠，
 * 不用等整段回答合成完才开始播。
 */

import { randomUUID } from "node:crypto";
import { DEV, SRV, build, buildTimeInfo } from "./protocol.mjs";
import { createASR } from "./services/asr.mjs";
import { chatSentences } from "./services/llm.mjs";
import { textToOpusFrames, OpusToPcm, FRAME_MS } from "./services/tts.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[dev]", ...a);

/* ── 音频下发节拍控制 ─────────────────────────────────────────────────
 * 目标：设备端始终保持 ~2 秒左右缓冲。
 * 教训：按 60ms/帧的"实时"节奏发是错误的 —— setTimeout 实际 ≥60ms
 * （事件循环 + 定时器精度），加上网络抖动，设备端从第一帧起就持续欠载，
 * 表现就是全程卡顿 + 欠载爆音；句间 LLM 生成间隙也会直接断音。
 * 方案：领先 <2s 时按 30ms 快发建立缓冲；领先够了回落到 60ms 不再堆积。
 * 长回答也不会撑爆设备队列（96 帧 ≈ 5.7s）。 */
const FRAME_SEND_FAST_MS = Math.round(FRAME_MS * 0.5);   /* 30ms —— 快发 */
const FRAME_SEND_RT_MS   = FRAME_MS;                     /* 60ms —— 实时 */
const TARGET_LEAD_MS     = 2000;                         /* 设备端目标缓冲 */

export class DeviceSession {
  /**
   * @param {import("ws").WebSocket} ws
   * @param {object} ctx  { config, weather }
   */
  constructor(ws, ctx) {
    this.ws = ws;
    this.ctx = ctx;
    this.sid = randomUUID().slice(0, 8);
    this.mac = "";
    this.fw = "";
    this.page = "home";

    this.recording = false;
    this.opus = new OpusToPcm();
    this.history = [];
    this.aborted = false;
    this.busy = false;
    this.timers = [];
    this.lastStat = null;
  }

  /* ── 发送 ─────────────────────────────────────────────────────────── */

  send(obj) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  sendBin(buf) {
    if (this.ws.readyState === 1) this.ws.send(buf, { binary: true });
  }

  /* ── 生命周期 ─────────────────────────────────────────────────────── */

  start() {
    /* 心跳：25 秒一次，防止中间设备/NAT 断连 */
    this.timers.push(setInterval(() => this.send(build.ping()), 25000));

    /* 信息栏定时推送 */
    const pushMs = Math.max(10, this.ctx.config.info.pushSec || 60) * 1000;
    this.timers.push(setInterval(() => this.pushInfo(), pushMs));

    log(`[${this.sid}] 会话开始`);
  }

  close() {
    this.aborted = true;
    this.timers.forEach(clearInterval);
    this.timers = [];
    try { this.opus.free(); } catch { /* ignore */ }
    log(`[${this.sid}] 会话结束`);
  }

  /* ── 消息分发 ─────────────────────────────────────────────────────── */

  onMessage(data, isBinary) {
    if (isBinary) {
      if (this.recording) this.opus.push(Buffer.from(data));
      return;
    }

    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }

    switch (m.t) {
      case DEV.HELLO: return this.onHello(m);
      case DEV.REC:   return m.s === "start" ? this.onRecStart() : this.onRecStop();
      case DEV.BTN:   return this.onBtn(m);
      case DEV.STAT:  this.lastStat = { bat: m.bat, room: m.room, at: Date.now() }; return;
      case DEV.LUA_RESULT:
        log(`[${this.sid}] Lua#${m.id} ${m.ok ? "成功" : "失败"} ${m.out ?? ""}`);
        return;
      case "pong": return;
      default:
        log(`[${this.sid}] 未知消息: ${m.t}`);
    }
  }

  async onHello(m) {
    this.mac = m.mac ?? "";
    this.fw = m.fw ?? "";
    log(`[${this.sid}] hello mac=${this.mac} fw=${this.fw} caps=${(m.caps ?? []).join(",")}`);

    await this.pushInfo(true);
    this.send(build.helloAck(this.sid, this.page, buildTimeInfo(this.ctx.weather.data)));
  }

  onBtn(m) {
    if (m.k === "key" && m.e === "click") {
      /* 翻页由设备本地立即完成（不等网络），这里只做记录和同步 */
      this.page = this.page === "home" ? "func" : "home";
      log(`[${this.sid}] KEY → ${this.page}`);
      this.send(build.page(this.page));
    }
  }

  /* ── 录音 ─────────────────────────────────────────────────────────── */

  onRecStart() {
    if (this.busy) {
      this.send(build.err("正在说话，请稍后"));
      return;
    }
    this.recording = true;
    this.aborted = false;
    this.opus.reset();
    log(`[${this.sid}] 开始录音`);
  }

  async onRecStop() {
    if (!this.recording) return;
    this.recording = false;

    const pcm = this.opus.drain();
    const durMs = this.opus.durationMs;
    this.opus.reset();

    log(`[${this.sid}] 录音结束 ${durMs.toFixed(0)}ms / ${pcm.length} 字节`);
    if (pcm.length < 1600) {              /* < 50ms，基本是误触 */
      log(`[${this.sid}] 音频太短，忽略`);
      return;
    }

    await this.talk(pcm);
  }

  /* ── 一次对话 ─────────────────────────────────────────────────────── */

  async talk(pcm) {
    const cfg = this.ctx.config;
    this.busy = true;

    try {
      /* 1) 语音识别 */
      const asr = createASR(cfg.asr);
      if (!asr) throw new Error("未配置语音识别");

      const t0 = Date.now();
      const { text } = await asr.recognize(pcm);
      log(`[${this.sid}] ASR ${Date.now() - t0}ms → "${text}"`);

      if (!text) {
        await this.speakOne("我没听清，再说一次好吗？");
        return;
      }

      this.send(build.stt(text));
      this.history.push({ role: "user", content: text });

      /* 2) 大模型 + 语音合成，边生成边播 */
      await this.streamAnswer(text);
    } catch (e) {
      log(`[${this.sid}] 对话失败: ${e.message}`);
      this.send(build.err(e.message));
      await this.speakOne("抱歉，我这边出了点问题。");
    } finally {
      this.busy = false;
      this.aborted = false;
    }
  }

  async streamAnswer(userText) {
    const cfg = this.ctx.config;

    /* 生产者/消费者：LLM 出句 → 队列 → 发送循环按实时节奏发 */
    const queue = [];
    let producing = true;
    let firstAt = 0;
    const t0 = Date.now();

    const sender = (async () => {
      this.send(build.ttsStart());
      const t0 = Date.now();
      let audioMs = 0;                         /* 累计已发音频时长 */
      while (producing || queue.length) {
        if (this.aborted) break;
        if (!queue.length) { await sleep(8); continue; }
        const { frames, text } = queue.shift();
        this.send(build.sub(text));
        for (const f of frames) {
          if (this.aborted) break;
          this.sendBin(f);
          audioMs += FRAME_MS;
          const lead = audioMs - (Date.now() - t0);   /* 设备端缓冲估计 */
          await sleep(lead < TARGET_LEAD_MS ? FRAME_SEND_FAST_MS : FRAME_SEND_RT_MS);
        }
      }
      this.send(build.ttsStop());
    })();

    let full = "";
    try {
      for await (const sentence of chatSentences({
        apiKey: cfg.llm.apiKey,
        baseUrl: cfg.llm.baseUrl,
        model: cfg.llm.model,
        messages: [
          { role: "system", content: cfg.llm.systemPrompt },
          ...this.history.slice(-8),
        ],
        maxTokens: cfg.llm.maxTokens,
        temperature: cfg.llm.temperature,
      })) {
        if (this.aborted) break;
        full += sentence;

        if (!firstAt) {
          firstAt = Date.now();
          log(`[${this.sid}] 首句延迟 ${firstAt - t0}ms`);
        }

        const { frames } = await textToOpusFrames(sentence, { speed: cfg.tts.speed });
        queue.push({ frames, text: sentence.trim() });
      }
    } catch (e) {
      log(`[${this.sid}] LLM 失败: ${e.message}`);
      this.send(build.err(e.message));
    } finally {
      producing = false;
      await sender;
    }

    if (full) {
      this.history.push({ role: "assistant", content: full });
      if (this.history.length > 20) this.history = this.history.slice(-20);
      log(`[${this.sid}] 回答 ${full.length} 字`);
    }
  }

  /** 不经过 LLM，直接播一句话 */
  async speakOne(text) {
    try {
      const { frames } = await textToOpusFrames(text, { speed: this.ctx.config.tts.speed });
      this.send(build.ttsStart());
      this.send(build.sub(text));
      const t0 = Date.now();
      let audioMs = 0;
      for (const f of frames) {
        if (this.aborted) break;
        this.sendBin(f);
        audioMs += FRAME_MS;
        const lead = audioMs - (Date.now() - t0);
        await sleep(lead < TARGET_LEAD_MS ? FRAME_SEND_FAST_MS : FRAME_SEND_RT_MS);
      }
      this.send(build.ttsStop());
    } catch (e) {
      log(`[${this.sid}] 播报失败: ${e.message}`);
    }
  }

  /* ── 信息栏推送 ───────────────────────────────────────────────────── */

  async pushInfo(force = false) {
    if (!force && this.ws.readyState !== 1) return;
    try {
      const w = this.ctx.config.weather.enabled
        ? await this.ctx.weather.get(this.ctx.config.weather)
        : null;
      this.send(build.info(buildTimeInfo(w)));
    } catch (e) {
      log(`[${this.sid}] 推送信息失败: ${e.message}`);
    }
  }
}
