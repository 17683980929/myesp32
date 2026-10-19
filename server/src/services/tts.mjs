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

  const ratio = sampleRate / SAMPLE_RATE;
  const outLen = Math.floor(samplesDecoded / ratio);
  const pcm = Buffer.alloc(outLen * 2);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, samplesDecoded - 1);
    const frac = pos - i0;
    let v = mono[i0] * (1 - frac) + mono[i1] * frac;
    v = Math.max(-1, Math.min(1, v));
    pcm.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  return pcm;
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
 * 一步到位：文字 → Opus 帧（按 provider 选引擎；腾讯失败可回退百度）
 * @param {string} text
 * @param {{provider?:string, speed?:number, tencent?:object}} opts 通常直接传 config.tts
 * @returns {Promise<{frames:Buffer[], durationMs:number}>}
 */
export async function textToOpusFrames(text, opts = {}) {
  const provider = opts.provider || "baidu";
  const chunks = splitTtsText(text, provider === "tencent" ? 100 : 140);

  const parts = [];
  for (const chunk of chunks) {
    let mp3;
    if (provider === "tencent") {
      try {
        mp3 = await tencentTTS(chunk, opts.tencent || {});
      } catch (e) {
        const fb = opts.tencent ? opts.tencent.fallbackBaidu : true;
        if (fb === false) throw e;
        console.error(`[tts] 腾讯合成失败（${e.message}），本句回退百度`);
        mp3 = await baiduTTS(chunk, { speed: opts.speed });
      }
    } else {
      mp3 = await baiduTTS(chunk, opts);
    }
    parts.push(await mp3ToPcm16k(mp3));
  }

  const pcm = parts.length === 1 ? parts[0] : Buffer.concat(parts);
  const frames = pcmToOpusFrames(pcm);
  return { frames, durationMs: (pcm.length / 2 / SAMPLE_RATE) * 1000 };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 上行：设备发来的 Opus 帧 → PCM（喂给 ASR）
 * ══════════════════════════════════════════════════════════════════════════ */

export class OpusToPcm {
  constructor() {
    this.dec = new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.AUDIO);
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
