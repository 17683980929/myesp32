/**
 * services/asr.mjs — 语音识别（腾讯云「录音文件识别极速版」）
 *
 * 接口：POST https://asr.cloud.tencent.com/asr/flash/v1/<appid>?<参数>
 * 签名：Base64( HmacSHA1( "POST" + host + path?query, SecretKey ) )
 *       —— 注意是 HMAC-SHA1，不是云 API 3.0 的 TC3-HMAC-SHA256。
 *       —— 参数必须按字典序拼接，appid 写在 URL 路径里。
 *
 * 音频格式支持 pcm / wav / ogg-opus / mp3 / silk / speex / m4a / aac / amr。
 * 这里传 pcm（设备端解码 Opus 后就是 16kHz 单声道裸 PCM）。
 */

import crypto from "node:crypto";

const HOST = "asr.cloud.tencent.com";
const PATH_BASE = "/asr/flash/v1";

const ERRORS = {
  4001: "参数不合法",
  4002: "鉴权失败（检查 SecretId / SecretKey / AppId）",
  4003: "AppID 服务未开通，需在语音识别控制台开通",
  4004: "资源包耗尽",
  4005: "账户欠费",
  4006: "并发超限",
  4007: "音频解码失败（格式与 voice_format 不符）",
  4008: "上传超时",
  4009: "连接断开",
  4011: "音频过大（>100MB）",
  4012: "音频为空",
  5001: "服务端负载高，重试即可",
  5002: "识别失败",
  5003: "识别超时",
};

export class TencentASR {
  constructor({ appId, secretId, secretKey, engine = "16k_zh" }) {
    if (!appId || !secretId || !secretKey) {
      throw new Error("腾讯云 ASR 配置不完整（需要 appId / secretId / secretKey）");
    }
    this.appId = String(appId);
    this.secretId = secretId;
    this.secretKey = secretKey;
    this.engine = engine;
  }

  #buildQuery(extra = {}) {
    const params = {
      engine_type: this.engine,
      voice_format: "pcm",
      secretid: this.secretId,
      timestamp: Math.floor(Date.now() / 1000),
      first_channel_only: 1,
      speaker_diarization: 0,
      filter_dirty: 0,
      filter_modal: 0,
      filter_punc: 0,
      convert_num_mode: 1,
      word_info: 0,
      ...extra,
    };
    return Object.keys(params)
      .sort()                     /* 字典序是签名的硬性要求 */
      .map((k) => `${k}=${params[k]}`)
      .join("&");
  }

  #sign(query) {
    const origin = `POST${HOST}${PATH_BASE}/${this.appId}?${query}`;
    return crypto.createHmac("sha1", this.secretKey).update(origin).digest("base64");
  }

  /**
   * 识别一段音频。
   * @param {Buffer} audio 裸 PCM（16kHz 单声道 s16le）
   * @returns {Promise<{text:string, durationMs:number}>}
   */
  async recognize(audio, { voiceFormat = "pcm", timeoutMs = 15000 } = {}) {
    if (!audio || audio.length === 0) throw new Error("音频为空");

    const query = this.#buildQuery({ voice_format: voiceFormat });
    const url = `https://${HOST}${PATH_BASE}/${this.appId}?${query}`;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);

    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          Host: HOST,
          Authorization: this.#sign(query),
          "Content-Type": "application/octet-stream",
          "Content-Length": String(audio.length),
        },
        body: audio,
        signal: ac.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if (e.name === "AbortError") throw new Error("ASR 请求超时");
      throw new Error(`ASR 网络错误: ${e.message}`);
    }
    clearTimeout(timer);

    const body = await res.json().catch(() => null);
    if (!body) throw new Error(`ASR 返回非 JSON（HTTP ${res.status}）`);

    if (body.code !== 0) {
      const why = ERRORS[body.code] ?? body.message ?? "未知错误";
      throw new Error(`ASR 失败 [${body.code}] ${why}`);
    }

    return {
      text: (body.flash_result?.[0]?.text ?? "").trim(),
      durationMs: body.audio_duration ?? 0,
    };
  }
}

/** 按配置构造，缺配置返回 null */
export function createASR(cfg) {
  try {
    return new TencentASR({
      appId: cfg.appId,
      secretId: cfg.secretId,
      secretKey: cfg.secretKey,
      engine: cfg.engine,
    });
  } catch {
    return null;
  }
}
