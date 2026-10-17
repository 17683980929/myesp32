/**
 * services/tts.mjs — 语音合成（百度翻译接口，免费）
 *
 * 链路：文字 → 百度 TTS(MP3) → mpg123 解码 → 16kHz 单声道 PCM → Opus 帧
 *
 * 设备侧协议要求：Opus 16kHz 单声道 60ms 一帧（960 采样）。
 */

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
 * 一步到位：文字 → Opus 帧
 * @returns {Promise<{frames:Buffer[], durationMs:number}>}
 */
export async function textToOpusFrames(text, opts = {}) {
  const mp3 = await baiduTTS(text, opts);
  const pcm = await mp3ToPcm16k(mp3);
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
