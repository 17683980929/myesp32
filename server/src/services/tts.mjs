/**
 * services/tts.mjs — 语音合成
 *
 * 链路：文字 → TTS(MP3) → mpg123 解码 → 16kHz 单声道 PCM → Opus 帧
 *
 * 两套引擎（config.tts.provider 选择）：
 *   - tencent：腾讯云语音合成（云 API 3.0 TextToVoice，TC3-HMAC-SHA256 签名）
 *   - baidu  ：百度翻译免费接口（备用/无密钥可用）
 *
 * 设备侧协议要求：Opus 16kHz 单声道 60ms 一帧（960 采样）。
 */

import crypto from "node:crypto";
import https from "node:https";
import { MPEGDecoder } from "mpg123-decoder";
import OpusScript from "opusscript";

export const SAMPLE_RATE = 16000;
export const CHANNELS = 1;
export const FRAME_MS = 60;
export const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000;   /* 960 */
const BYTES_PER_FRAME = FRAME_SAMPLES * 2;                      /* 1920 */

/** 百度翻译 TTS：文字 → MP3。免费接口有限流，退避重试。 */
async function baiduTTS(text, { speed = 5, retries = 3 } = {}) {
  const url =
    `https://fanyi.baidu.com/gettts?lan=zh&text=${encodeURIComponent(text)}` +
    `&spd=${speed}&source=web`;

  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
          Referer: "https://fanyi.baidu.com/",
        },
      });
      if (res.status === 503 || res.status === 429) throw new Error(`限流 ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 800) throw new Error(`返回过小（${buf.length}B）`);
      return buf;
    } catch (e) {
      lastErr = e;
      if (i < retries) await new Promise((r) => setTimeout(r, 700 * (i + 1)));
    }
  }
  throw new Error(`TTS 连续失败: ${lastErr.message}`);
}

/* ── 腾讯云语音合成（TextToVoice，云 API 3.0）────────────────────────────
 * 签名 TC3-HMAC-SHA256，返回 base64 MP3。
 * 密钥与「语音识别」可共用同一个腾讯云账号。 */

const TTS_HOST = "tts.tencentcloudapi.com";
const TTS_ERRORS = {
  "AuthFailure.SignatureFailure": "签名错误（检查 SecretId / SecretKey）",
  "AuthFailure.SecretIdNotFound": "SecretId 不存在",
  "FailedOperation.NoFreeAmount": "免费额度/资源包已用尽",
  "FailedOperation.UserNotRegistered": "未开通语音合成服务",
  "FailedOperation.ServiceIsolate": "服务被停用（多为欠费）",
  "LimitExceeded": "请求过于频繁（QPS 超限）",
  "RequestLimitExceeded": "请求过于频繁（QPS 超限）",
  "InvalidParameterValue": "参数不合法",
};

const sha256hex = (s) => crypto.createHash("sha256").update(s).digest("hex");
const hmac256 = (key, s) => crypto.createHmac("sha256", key).update(s).digest();

/** 腾讯云 TTS：一段文字 → MP3（Buffer）。失败抛错（含中文原因）。 */
export async function tencentTTS(text, cfg = {}) {
  const {
    secretId, secretKey, voiceType = 101001, speed = 0, volume = 0,
    region = "ap-guangzhou", timeoutMs = 8000, retries = 1,
  } = cfg;
  if (!secretId || !secretKey) throw new Error("未配置腾讯云 SecretId / SecretKey");

  const body = JSON.stringify({
    Text: text,
    SessionId: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    VoiceType: voiceType,
    Speed: speed,
    Volume: volume,
    SampleRate: SAMPLE_RATE,
    Codec: "mp3",
  });

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await tencentOnce(body, { secretId, secretKey, region, timeoutMs });
    } catch (e) {
      lastErr = e;
      if (!e.retriable || attempt === retries) break;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw lastErr;
}

async function tencentOnce(body, { secretId, secretKey, region, timeoutMs }) {
  /* TC3-HMAC-SHA256 签名 */
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const canonicalRequest =
    "POST\n/\n\n" +
    `content-type:application/json; charset=utf-8\nhost:${TTS_HOST}\n\n` +
    "content-type;host\n" +
    sha256hex(body);
  const scope = `${date}/tts/tc3_request`;
  const stringToSign =
    `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${sha256hex(canonicalRequest)}`;
  const kDate = hmac256("TC3" + secretKey, date);
  const kService = hmac256(kDate, "tts");
  const kSigning = hmac256(kService, "tc3_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`https://${TTS_HOST}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Host: TTS_HOST,
        "X-TC-Action": "TextToVoice",
        "X-TC-Timestamp": String(timestamp),
        "X-TC-Version": "2019-08-23",
        "X-TC-Region": region,
        Authorization:
          `TC3-HMAC-SHA256 Credential=${secretId}/${scope}, ` +
          `SignedHeaders=content-type;host, Signature=${signature}`,
      },
      body,
      signal: ac.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const err = new Error(e.name === "AbortError" ? "腾讯 TTS 请求超时" : `腾讯 TTS 网络错误: ${e.message}`);
    err.retriable = true;
    throw err;
  }
  clearTimeout(timer);

  const raw = await res.text().catch(() => "");
  let j = null;
  try { j = JSON.parse(raw); } catch { /* 非 JSON */ }
  if (!j || !j.Response) {
    const head = raw.replace(/\s+/g, " ").slice(0, 200);
    const err = new Error(`腾讯 TTS 返回异常（HTTP ${res.status}）：${head}`);
    err.retriable = res.status >= 500;
    throw err;
  }
  const r = j.Response;
  if (r.Error) {
    const why = TTS_ERRORS[r.Error.Code] || r.Error.Message || "未知错误";
    const err = new Error(`腾讯 TTS 失败 [${r.Error.Code}] ${why}`);
    err.retriable = r.Error.Code === "InternalError" || r.Error.Code === "RequestLimitExceeded";
    throw err;
  }
  const mp3 = Buffer.from(r.Audio || "", "base64");
  if (mp3.length < 800) throw new Error(`腾讯 TTS 音频过小（${mp3.length}B）`);
  return mp3;
}

/* ── 文本切分（腾讯单次上限约 150 汉字，英文按 1/3 折算）─────────────── */

/** 超长文本切成多段，优先在标点处断；limit 单位≈汉字数 */
export function splitTtsText(text, limit = 100) {
  const out = [];
  let cur = "";
  let w = 0;
  let lastBreak = -1;
  const weight = (ch) => (ch.codePointAt(0) > 0x2e7f ? 1 : 0.34);
  const isBreak = (ch) => "，。！？；：、,.!?;:—…～~ \n".includes(ch);

  for (const ch of text) {
    cur += ch;
    w += weight(ch);
    if (isBreak(ch)) lastBreak = cur.length;
    if (w >= limit) {
      const cut = lastBreak > 0 && lastBreak < cur.length ? lastBreak : cur.length;
      const head = cur.slice(0, cut);
      cur = cur.slice(cut);
      if (head.trim()) out.push(head);
      w = [...cur].reduce((a, c) => a + weight(c), 0);
      lastBreak = -1;
    }
  }
  if (cur.trim()) out.push(cur);
  return out.length ? out : [text];
}

/** 单声道 Float32 → 16kHz Int16 PCM（线性插值重采样） */
function resampleToPcm16k(mono, sampleRate) {
  const n = mono.length;
  if (sampleRate === SAMPLE_RATE) {
    const out = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) {
      const v = Math.max(-1, Math.min(1, mono[i]));
      out.writeInt16LE(Math.round(v * 32767), i * 2);
    }
    return out;
  }
  const ratio = sampleRate / SAMPLE_RATE;
  const outLen = Math.max(1, Math.floor(n / ratio));
  const pcm = Buffer.alloc(outLen * 2);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, n - 1);
    const frac = pos - i0;
    let v = mono[i0] * (1 - frac) + mono[i1] * frac;
    v = Math.max(-1, Math.min(1, v));
    pcm.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  return pcm;
}

/** WAV（RIFF）→ 16kHz 单声道 PCM。支持 8/16/24/32 位整数与 32 位浮点。 */
function wavToPcm16k(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE")
    throw new Error("不是 WAV 数据");

  let p = 12, fmt = null, data = null;
  while (p + 8 <= buf.length) {
    const id = buf.toString("ascii", p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    const body = p + 8;
    if (id === "fmt ") {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        rate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      const end = size > 0 && size !== 0xffffffff
        ? Math.min(body + size, buf.length)
        : buf.length;
      data = buf.subarray(body, end);
      if (fmt) break;
    }
    p = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error("WAV 解析失败（缺 fmt 或 data 块）");
  if (!fmt.channels || !fmt.rate) throw new Error("WAV 参数异常");

  const bytes = fmt.bits / 8;
  if (![1, 2, 3, 4].includes(bytes)) throw new Error(`不支持的 WAV 位深 ${fmt.bits}`);

  const total = Math.floor(data.length / (bytes * fmt.channels));
  const mono = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    let sum = 0;
    for (let c = 0; c < fmt.channels; c++) {
      const o = (i * fmt.channels + c) * bytes;
      let v;
      if (fmt.format === 3 && bytes === 4) v = data.readFloatLE(o);
      else if (bytes === 1) v = (data[o] - 128) / 128;
      else if (bytes === 2) v = data.readInt16LE(o) / 32768;
      else if (bytes === 3) v = (((data[o] | (data[o + 1] << 8) | (data[o + 2] << 16)) << 8) >> 8) / 8388608;
      else v = data.readInt32LE(o) / 2147483648;
      sum += v;
    }
    mono[i] = sum / fmt.channels;
  }
  return resampleToPcm16k(mono, fmt.rate);
}

/** MP3 → 16kHz 单声道 PCM（Int16 小端）。混单声道 + 线性重采样。 */
async function mp3ToPcm16k(mp3) {
  const dec = new MPEGDecoder();
  await dec.ready;
  const { channelData, samplesDecoded, sampleRate } = dec.decode(mp3);
  dec.free();

  if (!channelData?.length) throw new Error("MP3 解码失败");

  const ch = channelData.length;
  const mono = new Float32Array(samplesDecoded);
  for (let i = 0; i < samplesDecoded; i++) {
    let s = 0;
    for (let c = 0; c < ch; c++) s += channelData[c][i] || 0;
    mono[i] = s / ch;
  }
  return resampleToPcm16k(mono, sampleRate);
}

/**
 * 本地 TTS（自己部署的模型）→ 音频字节。
 *
 * 支持两种接口：
 *   openai    ：POST {base}/v1/audio/speech，OpenAI 兼容（Kokoro-FastAPI、openedai-speech、
 *               Fish Speech、多数本地封装都提供这个）
 *   gptsovits ：POST {base}/tts，GPT-SoVITS 的 api_v2.py
 *
 * 两种都要求返回 WAV；万一只给了裸 PCM，按 cfg.rawSampleRate 解释。
 */
/**
 * 只对「显式勾选了忽略证书」的本地 TTS 请求走这条路。
 *
 * frp 一类内网穿透常给 *.xxx.nyat.app 的泛域名证书，用自有域名访问会报
 * ERR_TLS_CERT_ALTNAME_INVALID；全局 fetch(undici) 无法只给单个请求关校验，
 * 所以改用 node:https 并单独设 rejectUnauthorized:false。
 * 作用域仅限本次请求，ASR / LLM / 天气等其它 HTTPS 调用不受影响。
 */
function postHttpsInsecure(url, raw, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: `${u.pathname}${u.search}`,
      method: "POST",
      headers: { ...headers, "Content-Length": Buffer.byteLength(raw) },
      rejectUnauthorized: false,
      timeout: timeoutMs,
    }, (res) => {
      const parts = [];
      res.on("data", (c) => parts.push(c));
      res.on("end", () => resolve({ status: res.statusCode || 0, buf: Buffer.concat(parts) }));
    });
    req.on("timeout", () => req.destroy(new Error(`本地 TTS 超时（${timeoutMs}ms）`)));
    req.on("error", reject);
    req.end(raw);
  });
}

async function localTTS(text, cfg = {}) {
  const base = String(cfg.baseUrl || "").trim().replace(/\/+$/, "");
  if (!base) throw new Error("本地 TTS 地址为空（管理页→语音合成→服务地址）");

  const mode = cfg.mode === "gptsovits" ? "gptsovits" : "openai";
  const timeout = Math.max(3000, Number(cfg.timeoutMs) || 20000);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);

  const headers = { "Content-Type": "application/json" };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

  let url, body;
  if (mode === "gptsovits") {
    url = `${base}/tts`;
    body = {
      text,
      text_lang: cfg.textLang || "zh",
      ref_audio_path: cfg.refAudioPath || "",
      prompt_text: cfg.promptText || "",
      prompt_lang: cfg.promptLang || "zh",
      /* 服务端已经按句子切好再送进来，这里不再二次切分（cut0 实测比 cut5 快 0.5s） */
      text_split_method: cfg.textSplitMethod || "cut0",
      media_type: "wav",
      streaming_mode: false,
      speed_factor: Number(cfg.speed) || 1,
      /* 单句推理开并行只会多花调度开销，实测关掉快 0.8s */
      parallel_infer: cfg.parallelInfer === true,
    };
  } else {
    url = `${base}/v1/audio/speech`;
    body = {
      model: cfg.model || "kokoro",
      input: text,
      voice: cfg.voice || "zf_xiaobei",
      response_format: "wav",
      speed: Number(cfg.speed) || 1,
    };
  }

  const raw = JSON.stringify(body);
  try {
    let status, buf;
    if (cfg.insecure === true && url.startsWith("https:")) {
      ({ status, buf } = await postHttpsInsecure(url, raw, headers, timeout));
    } else {
      const r = await fetch(url, {
        method: "POST", headers, body: raw, signal: ctl.signal,
      });
      status = r.status;
      buf = Buffer.from(await r.arrayBuffer());
    }
    if (status < 200 || status >= 300) {
      const detail = buf.toString("utf8").replace(/\s+/g, " ").slice(0, 160);
      throw new Error(`HTTP ${status}${detail ? "：" + detail : ""}`);
    }
    if (buf.length < 800) throw new Error(`返回音频过小（${buf.length}B）`);
    return buf;
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`本地 TTS 超时（${timeout}ms）`);
    /* undici 把连接错误包在 cause 里，直接抛 "fetch failed" 看不出是端口没开还是地址写错 */
    const code = e.cause?.code || e.code;
    if (code === "ERR_TLS_CERT_ALTNAME_INVALID" || code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
        code === "SELF_SIGNED_CERT_IN_CHAIN" || code === "CERT_HAS_EXPIRED") {
      throw new Error(`本地 TTS 证书校验失败（${code}）：地址与证书域名不匹配。` +
        `请在管理页本地 TTS 勾选「忽略 HTTPS 证书错误」，或改用证书匹配的域名`);
    }
    if (code) throw new Error(`本地 TTS 连接失败：${code}（${base}）`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** 本地返回的音频 → 16k PCM：WAV 优先，其次 MP3，最后当裸 PCM 处理 */
async function localAudioToPcm16k(buf, cfg = {}) {
  const isWav = buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF";
  const isMp3 = (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) ||
                (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0);
  if (isWav) return wavToPcm16k(buf);
  if (isMp3) return mp3ToPcm16k(buf);

  const rate = Math.max(8000, Number(cfg.rawSampleRate) || 24000);
  if (buf.length % 2) throw new Error("裸 PCM 长度不是偶数，无法按 s16le 解释");
  const n = buf.length / 2;
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) mono[i] = buf.readInt16LE(i * 2) / 32768;
  return resampleToPcm16k(mono, rate);
}

/** 云端兜底：优先腾讯（有密钥时），否则百度 */
async function cloudTTS(text, opts = {}) {
  if (opts.tencent && opts.tencent.secretId && opts.tencent.secretKey) {
    return tencentTTS(text, opts.tencent);
  }
  return baiduTTS(text, { speed: opts.speed });
}


/** PCM → Opus 帧数组（60ms/帧，24kbps） */
function pcmToOpusFrames(pcm) {
  const enc = new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.AUDIO);
  try { enc.encoderCTL(4002, 24000); } catch { /* OPUS_SET_BITRATE */ }

  const frames = [];
  for (let off = 0; off < pcm.length; off += BYTES_PER_FRAME) {
    let slice = pcm.subarray(off, Math.min(off + BYTES_PER_FRAME, pcm.length));
    if (slice.length < BYTES_PER_FRAME) {
      const pad = Buffer.alloc(BYTES_PER_FRAME);
      slice.copy(pad);
      slice = pad;
    }
    frames.push(Buffer.from(enc.encode(slice, FRAME_SAMPLES)));
  }
  enc.delete();
  return frames;
}

/**
 * 文字 → 16k/mono/s16 PCM（按 provider 选引擎）
 *
 * provider=local 时走自己部署的 TTS，失败按 local.fallback 决定是否回退云端
 * （有腾讯密钥就回退腾讯，否则百度），这样本地服务挂了也不至于哑巴。
 *
 * @param {string} text
 * @param {{provider?:string, speed?:number, tencent?:object, local?:object}} opts 通常直接传 config.tts
 * @returns {Promise<Buffer>}
 */
export async function textToPcm16k(text, opts = {}) {
  const provider = opts.provider || "baidu";
  const chunks = splitTtsText(text, provider === "tencent" ? 100 : 140);

  const parts = [];
  for (const chunk of chunks) {
    let pcm;
    if (provider === "local") {
      try {
        const audio = await localTTS(chunk, opts.local || {});
        pcm = await localAudioToPcm16k(audio, opts.local || {});
      } catch (e) {
        const fb = opts.local ? opts.local.fallback : true;
        if (fb === false) throw e;
        console.error(`[tts] 本地合成失败（${e.message}），本句回退云端`);
        pcm = await mp3ToPcm16k(await cloudTTS(chunk, opts));
      }
    } else if (provider === "tencent") {
      try {
        pcm = await mp3ToPcm16k(await tencentTTS(chunk, opts.tencent || {}));
      } catch (e) {
        const fb = opts.tencent ? opts.tencent.fallbackBaidu : true;
        if (fb === false) throw e;
        console.error(`[tts] 腾讯合成失败（${e.message}），本句回退百度`);
        pcm = await mp3ToPcm16k(await baiduTTS(chunk, { speed: opts.speed }));
      }
    } else {
      pcm = await mp3ToPcm16k(await baiduTTS(chunk, opts));
    }
    parts.push(pcm);
  }

  return parts.length === 1 ? parts[0] : Buffer.concat(parts);
}

/** 文字 → Opus 帧（下发设备用） */
export async function textToOpusFrames(text, opts = {}) {
  const pcm = await textToPcm16k(text, opts);
  const frames = pcmToOpusFrames(pcm);
  return { frames, durationMs: (pcm.length / 2 / SAMPLE_RATE) * 1000 };
}

/** 16k/mono/s16 PCM → WAV，给管理页试听用（浏览器不认裸 PCM） */
export function pcmToWav(pcm, rate = SAMPLE_RATE) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);          /* PCM 块大小 */
  h.writeUInt16LE(1, 20);           /* 格式 = PCM */
  h.writeUInt16LE(1, 22);           /* 单声道 */
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);    /* 字节率 */
  h.writeUInt16LE(2, 32);           /* 块对齐 */
  h.writeUInt16LE(16, 34);          /* 位深 */
  h.write("data", 36, "ascii");
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 上行：设备发来的 Opus 帧 → PCM（喂给 ASR）
 * ══════════════════════════════════════════════════════════════════════════ */

/* opusscript 的 Application 常量并非所有版本都导出（云端装过旧版就会抛），
 * 用数值兜底：2049 = OPUS_APPLICATION_AUDIO。 */
const OPUS_APP_AUDIO = (OpusScript.Application && OpusScript.Application.AUDIO) || 2049;
let s_opusErr = "";

/** 构造 Opus 解码器：逐个方案试，失败原因留在 s_opusErr 里给 /api/status 看 */
export function createOpusDecoder() {
  const tries = [
    ["Application.AUDIO", () => new OpusScript(SAMPLE_RATE, CHANNELS, OPUS_APP_AUDIO)],
    ["默认参数", () => new OpusScript(SAMPLE_RATE, CHANNELS)],
  ];
  for (const [label, fn] of tries) {
    try {
      s_opusErr = "";
      return fn();
    } catch (e) {
      s_opusErr = label + ": " + (e?.message || e);
    }
  }
  return null;
}

/** 语音识别是否可用（云端排查用） */
export function opusStatus() {
  return { ok: !s_opusErr, err: s_opusErr };
}

export class OpusToPcm {
  constructor() {
    this.dec = createOpusDecoder();
    if (!this.dec) throw new Error(s_opusErr || "Opus 解码器初始化失败");
    this.chunks = [];
    this.frames = 0;
    this.samples = 0;
  }

  push(frame) {
    if (!frame || frame.length === 0) return;
    try {
      const pcm = this.dec.decode(frame, FRAME_SAMPLES);
      this.chunks.push(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
      this.frames++;
      this.samples += FRAME_SAMPLES;
    } catch { /* 坏帧跳过 */ }
  }

  /** 取出累积 PCM 并清空 */
  drain() {
    if (!this.chunks.length) return Buffer.alloc(0);
    const out = Buffer.concat(this.chunks);
    this.chunks = [];
    return out;
  }

  get durationMs() {
    return (this.samples / SAMPLE_RATE) * 1000;
  }

  reset() {
    this.chunks = [];
    this.frames = 0;
    this.samples = 0;
  }

  free() {
    try { this.dec.delete(); } catch { /* 已释放 */ }
    this.chunks = [];
  }
}
