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
import { TOOLS, executeTool, matchLocalCommand } from "./services/tools.mjs";
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

/* ── 助手技能（工具调用）─────────────────────────────────────────────
 * 模型要工具 → 执行 → 带结果再生成（见 streamAnswer）。
 * 工具往来只存在于本轮临时消息里，不进长期历史（省 token 也不污染上下文）。 */
function parseToolArgs(s) {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return {}; }
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
    this.caps = [];
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
    this.luaWaiters = new Map();   /* id → resolve(fn)：等下发的 Lua 执行回执 */
    this.lastLua = null;           /* 最近一次 Lua 执行结果（诊断用） */
  }

  /* ── 发送 ─────────────────────────────────────────────────────────── */

  send(obj) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  sendBin(buf) {
    if (this.ws.readyState === 1) this.ws.send(buf, { binary: true });
  }

  /** 下发 Lua 并等设备回执（超时按失败返回），由 /api/lua 使用 */
  sendLua(id, code, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (r) => {
        if (done) return;
        done = true;
        this.luaWaiters.delete(id);
        resolve(r);
      };
      this.luaWaiters.set(id, finish);
      this.send({ t: "lua", id, code });
      /* 回执丢失时不能断言设备没执行：脚本在发送前已保存，设备可能已执行完 */
      setTimeout(() => finish({
        ok: false,
        timeout: true,
        out: `回执超时（${timeoutMs}ms，脚本已保存，设备可能已执行）`,
      }), timeoutMs);
    });
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
    for (const w of this.luaWaiters.values()) w({ ok: false, out: "设备断开" });
    this.luaWaiters.clear();
    try { this.opus.free(); } catch { /* ignore */ }
    log(`[${this.sid}] 会话结束`);
  }

  /** 某回合是否已作废（被新录音打断 / 会话关闭） */
  stale(turn) { return this.aborted || turn !== this.turn; }

  /** 等设备上报一次新状态（at 晚于 since）；超时返回 undefined，不拿旧值充数 */
  async waitBt(since, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const st = this.lastStat;
      if (st && st.at > since) return st.bt;
      await sleep(80);
    }
    return undefined;
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
      case DEV.REC:
        if (m.s === "start") return this.onRecStart();
        if (m.s === "resume") return this.onRecResume();
        return this.onRecStop();
      case DEV.BTN:   return this.onBtn(m);
      case DEV.STAT:
        this.lastStat = {
          bat: m.bat, room: m.room, vol: m.vol, bt: m.bt, rssi: m.rssi,
          up: m.up, ip: m.ip, ssid: m.ssid, bn: m.bn, at: Date.now(),
        };
        return;
      case DEV.LUA_RESULT: {
        log(`[${this.sid}] Lua#${m.id} ${m.ok ? "成功" : "失败"} ${m.out ?? ""}`);
        this.lastLua = { id: m.id, ok: !!m.ok, out: m.out ?? "", at: Date.now() };
        const w = this.luaWaiters.get(m.id);
        if (w) {
          this.luaWaiters.delete(m.id);
          w({ ok: !!m.ok, out: m.out ?? "" });
        }
        return;
      }
      case "pong": return;
      default:
        log(`[${this.sid}] 未知消息: ${m.t}`);
    }
  }

  async onHello(m) {
    this.mac = m.mac ?? "";
    this.fw = m.fw ?? "";
    this.caps = Array.isArray(m.caps) ? m.caps : [];
    log(`[${this.sid}] hello mac=${this.mac} fw=${this.fw} caps=${this.caps.join(",")}`);

    await this.pushInfo(true);
    this.send(build.helloAck(this.sid, this.page, buildTimeInfo(this.ctx.weather.data)));
  }

  onBtn(m) {
    if (m.k !== "key") return;
    /* 页面状态以设备为准：固件把单击完全交给 Lua 脚本（进入/切换/关闭），
     * 点击时所在页放在 m.p 里上报（home/portal；旧固件还会报 func）。
     * 服务器只记录（/api/status、日志），不自己翻页也不再回推设备。 */
    const p = m.p === "home" || m.p === "func" || m.p === "portal" ? m.p : null;
    if (p) this.page = p;
    if (m.e === "click") log(`[${this.sid}] KEY → ${this.page}${p ? "" : "（旧固件：无页字段）"}`);
    else if (m.e === "page") log(`[${this.sid}] 页面同步 → ${this.page}`);
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

      /* 本地直连指令：先执行、再让大模型确认。
       * 实测模型对重复的控制指令（"打开课表"第二遍）会改用嘴回答不调工具，
       * 导致时灵时不灵 —— 命中本地匹配就一定执行。 */
      let localNote = null;
      const local = matchLocalCommand(text);
      if (local) {
        let result;
        try {
          result = await executeTool(local.name, local.args, this.ctx, this);
        } catch (e) {
          result = `执行失败：${e.message}`;
        }
        log(`[${this.sid}] 本地指令: ${local.name}(${JSON.stringify(local.args)}) → ${result}`);
        localNote = `系统备注：用户这句话「${text}」已经由本地直连执行完毕，工具返回：「${result}」。` +
                    `不要重复执行、不要再调用任何工具，保持你的人设，用一两句话自然地确认结果即可。`;
      }

      /* 2) 大模型 + 语音合成，边生成边播 */
      await this.streamAnswer(text, myTurn, localNote);
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

  async streamAnswer(userText, myTurn, localNote = null) {
    const cfg = this.ctx.config;

    /* 生产者/消费者：LLM 出句 → 队列 → 发送循环按实时节奏发 */
    const queue = [];
    let producing = true;
    let firstAt = 0;
    /* 连续对话：回答以问句收尾（模型在等用户回话）→ tts_stop 带 fu=1，
     * 设备播完自动开麦。在 finally 里按完整文本判定（发送方读它时已定稿） */
    let ask = false;
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
      this.send(build.ttsStop(ask));
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
        ({ frames } = await withTimeout(textToOpusFrames(sentence, cfg.tts), TTS_TIMEOUT_MS));
      } catch (e) {
        log(`[${this.sid}] 句子合成失败: ${e.message}`);
        if (sent === 0) throw e;      /* 一句都没成 → 走道歉流程 */
        return false;                 /* 已有内容 → 干净收尾，设备播完队列自然结束 */
      }
      sent++;
      queue.push({ frames, text: sentence.trim() });
      return true;
    };

    /* 工具循环：模型要工具（本轮通常没有正文，也可能先来一句“让我查查”的引子）
     * → 执行并把结果喂回去再生成，最多 3 轮。工具消息不进长期历史。 */
    let toolsOn = cfg.llm.tools !== false;
    let msgs = [
      { role: "system", content: cfg.llm.systemPrompt },
      ...this.history.slice(-8),
    ];
    if (localNote) msgs.push({ role: "system", content: localNote });

    try {
      let toolRounds = 0;
      for (;;) {
        if (this.stale(myTurn)) break;
        const toolSink = { calls: [] };
        let stop = false;
        try {
          for await (const sentence of chatSentences({
            ...genOpts,
            messages: msgs,
            tools: toolsOn ? TOOLS : undefined,
            toolSink: toolsOn ? toolSink : undefined,
          })) {
            if (this.stale(myTurn)) break;
            if (!(await pushSentence(sentence))) { stop = true; break; }
          }
        } catch (e) {
          /* 个别网关不认 tools 参数：这一轮还什么都没生成 → 关掉工具重试一次 */
          if (toolsOn && toolRounds === 0 && sent === 0 && !full.trim() &&
              /tool|function|param|400|invalid/i.test(e.message)) {
            log(`[${this.sid}] 工具调用不可用（${e.message}）→ 降级纯对话`);
            toolsOn = false;
            continue;
          }
          throw e;
        }
        if (stop || this.stale(myTurn)) break;

        const calls = toolSink.calls.filter((c) => c.name);
        if (!calls.length) break;
        if (++toolRounds > 3) break;

        log(`[${this.sid}] 工具调用: ${calls.map((c) => `${c.name}(${(c.args || "").slice(0, 60)})`).join(" ")}`);
        const asstCalls = calls.map((c, i) => ({
          id: c.id || `call_${toolRounds}_${i}`,
          type: "function",
          function: { name: c.name, arguments: c.args || "{}" },
        }));
        msgs = [...msgs, { role: "assistant", content: null, tool_calls: asstCalls }];
        for (const c of asstCalls) {
          let result;
          try {
            result = await executeTool(c.function.name, parseToolArgs(c.function.arguments), this.ctx, this);
          } catch (e) {
            result = `工具执行失败：${e.message}`;
          }
          log(`[${this.sid}] 工具结果 ${c.function.name} → ${String(result).replace(/\s+/g, " ").slice(0, 100)}`);
          msgs.push({ role: "tool", tool_call_id: c.id, content: String(result) });
          if (this.stale(myTurn)) break;
        }
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
      ask = /[？?]\s*$/.test(full.trim());
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
      const { frames } = await withTimeout(textToOpusFrames(text, this.ctx.config.tts), TTS_TIMEOUT_MS);
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
      this.send(build.ttsStop(/[？?]\s*$/.test(text.trim())));
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
