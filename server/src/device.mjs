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

/** 单句 TTS 合成超时：Baidu 偶发卡住会让设备端"沉默卡在说话中"，超时后干净收尾 */
const TTS_TIMEOUT_MS = 12000;
function withTimeout(p, ms) {
  let t;
  return Promise.race([
    p,
    new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`合成超时 ${ms}ms`)), ms); }),
  ]).finally(() => clearTimeout(t));
}

/* ── "要多久"解析（用户点名时长的长内容 → 用续讲把长度补到目标）───────
 * 例："讲一个5分钟的白雪公主" → 目标 5×240 = 1200 字。
 * 普通问答解析结果为 0，不续讲 —— 长度跟着内容走。 */
const CN_NUM = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function durationTargetChars(text) {
  let minutes = 0;
  let m = text.match(/(\d+(?:\.\d+)?)\s*分钟/);
  if (m) minutes = parseFloat(m[1]);
  if (!minutes) {
    m = text.match(/([一二两三四五六七八九十])\s*分钟/);
    if (m) minutes = CN_NUM[m[1]] || 0;
  }
  if (!minutes) {
    m = text.match(/半小时|半个小时/);
    if (m) minutes = 30;
  }
  if (!minutes) {
    m = text.match(/(\d+(?:\.\d+)?|[一两二])\s*个?\s*小时/);
    if (m) minutes = (CN_NUM[m[1]] || parseFloat(m[1])) * 60;
  }
  if (!minutes || minutes < 1 || minutes > 60) return 0;
  return Math.round(minutes * 240);
}

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
    this.turn = 0;              /* 对话回合号：新录音会 ++ 作废旧回合（用户打断） */
    this.streaming = 0;         /* 正在按实时节奏发音频的回合号（可挂起/续播） */
    this.hold = 0;              /* 挂起的回合号：打断后用户没说话 → 从断点续播 */
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
    this.turn++;                        /* 作废正在跑的回合（发送/生成循环立即退出） */
    this.timers.forEach(clearInterval);
    this.timers = [];
    try { this.opus.free(); } catch { /* ignore */ }
    log(`[${this.sid}] 会话结束`);
  }

  /** 某回合是否已作废（被新录音打断 / 会话关闭） */
  stale(turn) { return this.aborted || turn !== this.turn; }

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
      case DEV.REC:
        if (m.s === "start") return this.onRecStart();
        if (m.s === "resume") return this.onRecResume();
        return this.onRecStop();
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
      /* 播报中被打断：先挂起（不发新帧），等设备端判定——
       *   用户说新话 → talk() 开新回合，自然作废旧回答；
       *   没说话     → resume 消息，从断点续播。
       * 非流式阶段（如短句播报/思考中）没有可续的东西，维持作废语义。 */
      if (this.streaming) {
        this.hold = this.streaming;
        log(`[${this.sid}] 用户打断 → 暂停当前播报（等用户说话）`);
      } else {
        log(`[${this.sid}] 用户打断，作废上一轮回答`);
        this.turn++;
      }
    }
    this.recording = true;
    this.aborted = false;
    this.opus.reset();
    log(`[${this.sid}] 开始录音`);
  }

  /** 用户打断后没说话（设备端已本地静默）：把挂起的回答从断点续播 */
  onRecResume() {
    if (!this.recording) return;
    this.recording = false;
    this.opus.reset();                 /* 丢掉录音期间飘来的"静音"帧 */
    if (this.hold && this.hold === this.turn) {   /* 挂起的回合仍然有效才续播 */
      this.hold = 0;
      log(`[${this.sid}] 用户没说话 → 从断点继续播报`);
    } else {
      this.hold = 0;
      log(`[${this.sid}] 用户没说话 → 回到待命`);
    }
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
    const myTurn = ++this.turn;         /* 本回合编号：被新录音/断开作废时失效 */
    if (this.hold) this.hold = 0;       /* 说新事了：旧回合的挂起一并作废 */
    this.busy = true;

    try {
      /* 1) 语音识别 */
      const asr = createASR(cfg.asr);
      if (!asr) throw new Error("未配置语音识别");

      const t0 = Date.now();
      const { text } = await asr.recognize(pcm);
      if (this.stale(myTurn)) return;
      log(`[${this.sid}] ASR ${Date.now() - t0}ms → "${text}"`);

      if (!text) {
        await this.speakOne("我没听清，再说一次好吗？", myTurn);
        return;
      }

      this.send(build.stt(text));
      /* 清掉历史上没等到回答就被打断的提问：旧请求若留在上下文里，
       * 新问题容易被"接上"旧任务（前后串） */
      while (this.history.length && this.history[this.history.length - 1].role === "user")
        this.history.pop();
      this.history.push({ role: "user", content: text });

      /* 2) 大模型 + 语音合成，边生成边播 */
      await this.streamAnswer(text, myTurn);
    } catch (e) {
      if (this.stale(myTurn)) return;   /* 已被打断：连道歉都别播了 */
      log(`[${this.sid}] 对话失败: ${e.message}`);
      this.send(build.err(e.message));
      await this.speakOne("抱歉，我这边出了点问题。", myTurn);
    } finally {
      if (myTurn === this.turn) {       /* 只有最新回合负责收尾 */
        this.busy = false;
        this.aborted = false;
      }
    }
  }

  async streamAnswer(userText, myTurn) {
    const cfg = this.ctx.config;

    /* 生产者/消费者：LLM 出句 → 队列 → 发送循环按实时节奏发 */
    const queue = [];
    let producing = true;
    let firstAt = 0;
    const t0 = Date.now();

    this.streaming = myTurn;   /* 本回合可被"打断挂起"（hold），之后从断点续播 */

    const sender = (async () => {
      this.send(build.ttsStart());
      const t0s = Date.now();
      let audioMs = 0;                         /* 累计已发音频时长 */
      let cur = null, ci = 0;                  /* 当前句 / 句内帧指针 */
      let resend = true;                       /* 是否整句重发（首次 & 挂起恢复） */
      let wasHeld = false;
      while (producing || queue.length || cur) {
        if (this.stale(myTurn)) break;
        if (!cur) {
          if (!queue.length) { await sleep(8); continue; }
          cur = queue.shift();
          ci = 0;
          resend = true;
        }
        if (this.hold === myTurn) {
          /* 被打断挂起：不发帧；恢复时整句重发（设备端缓冲已清，
           * 字幕与声音重新对齐，最多重听一句） */
          resend = true;
          ci = 0;
          wasHeld = true;
          await sleep(30);
          continue;
        }
        if (resend) {
          if (wasHeld) {                       /* 挂起恢复：重开设备端播放流 */
            this.send(build.ttsStart());
            wasHeld = false;
          }
          this.send(build.sub(cur.text, cur.frames.length));
          resend = false;
        }
        if (this.stale(myTurn)) break;
        this.sendBin(cur.frames[ci]);
        audioMs += FRAME_MS;
        ci++;
        if (ci >= cur.frames.length) cur = null;
        const lead = audioMs - (Date.now() - t0s);  /* 设备端缓冲估计 */
        await sleep(lead < TARGET_LEAD_MS ? FRAME_SEND_FAST_MS : FRAME_SEND_RT_MS);
      }
      this.send(build.ttsStop());
    })();

    let full = "";
    let sent = 0;
    const genOpts = {
      apiKey: cfg.llm.apiKey,
      baseUrl: cfg.llm.baseUrl,
      model: cfg.llm.model,
      maxTokens: cfg.llm.maxTokens,
      temperature: cfg.llm.temperature,
    };

    /* 单句：累计文本 + 合成 + 入队；返回 false = 合成失败，应停止后续 */
    const pushSentence = async (sentence) => {
      full += sentence;
      if (!firstAt) {
        firstAt = Date.now();
        log(`[${this.sid}] 首句延迟 ${firstAt - t0}ms`);
      }
      /* 单句合成加超时：卡住的句子不能拖死整段回答（设备端会沉默卡"说话中"） */
      let frames;
      try {
        ({ frames } = await withTimeout(textToOpusFrames(sentence, { speed: cfg.tts.speed }), TTS_TIMEOUT_MS));
      } catch (e) {
        log(`[${this.sid}] 句子合成失败: ${e.message}`);
        if (sent === 0) throw e;      /* 一句都没成 → 走道歉流程 */
        return false;                 /* 已有内容 → 干净收尾，设备播完队列自然结束 */
      }
      sent++;
      queue.push({ frames, text: sentence.trim() });
      return true;
    };

    try {
      for await (const sentence of chatSentences({
        ...genOpts,
        messages: [
          { role: "system", content: cfg.llm.systemPrompt },
          ...this.history.slice(-8),
        ],
      })) {
        if (this.stale(myTurn)) break;
        if (!(await pushSentence(sentence))) break;
      }

      /* 用户点名了时长（"5 分钟的故事"）而第一轮没写够 → 续讲补到目标长度。
       * 音频按实时节奏发送（可能要好几分钟），续讲生成只要几秒，并行不占耳；
       * 被打断（stale）随时停；最多补 3 轮，防止模型原地绕圈。 */
      const targetChars = durationTargetChars(userText);
      for (let round = 1; targetChars > 0 && round <= 3 && !this.stale(myTurn) &&
                         full.length < targetChars * 0.9; round++) {
        const need = Math.max(120, targetChars - full.length);
        log(`[${this.sid}] 续讲第 ${round} 轮（已 ${full.length} 字 / 目标 ${targetChars} 字，还差约 ${need} 字）`);
        let added = 0;
        for await (const sentence of chatSentences({
          ...genOpts,
          messages: [
            { role: "system", content: cfg.llm.systemPrompt },
            ...this.history.slice(-8),
            { role: "assistant", content: full },
            { role: "user",
              content: `继续把刚才的回答讲完整：从刚才断掉的地方接着往下讲，不要重复已经讲过的内容，` +
                       `再多讲大约 ${need} 字（用户要的时长还没到），除非内容真的已经讲完了，` +
                       `否则不要做总结收尾，直接接着讲就行。` },
          ],
        })) {
          if (this.stale(myTurn)) break;
          if (!(await pushSentence(sentence))) break;
          added += sentence.length;
        }
        if (added < 20) break;        /* 模型没得讲了，别硬凑 */
      }
    } catch (e) {
      log(`[${this.sid}] LLM 失败: ${e.message}`);
      this.send(build.err(e.message));
    } finally {
      producing = false;
      await sender;
      if (this.streaming === myTurn) this.streaming = 0;
      if (this.hold === myTurn) this.hold = 0;   /* 回合结束了，挂起一并清掉 */
    }

    if (full && !this.stale(myTurn)) {
      this.history.push({ role: "assistant", content: full });
      if (this.history.length > 20) this.history = this.history.slice(-20);
      log(`[${this.sid}] 回答 ${full.length} 字`);
    }
  }

  /** 不经过 LLM，直接播一句话（沿用调用者的回合号，被打断即停） */
  async speakOne(text, myTurn = this.turn) {
    try {
      const { frames } = await withTimeout(textToOpusFrames(text, { speed: this.ctx.config.tts.speed }), TTS_TIMEOUT_MS);
      if (this.stale(myTurn)) return;
      this.send(build.ttsStart());
      this.send(build.sub(text, frames.length));
      const t0 = Date.now();
      let audioMs = 0;
      for (const f of frames) {
        if (this.stale(myTurn)) break;
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
