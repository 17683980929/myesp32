/**
 * protocol.mjs — 设备 ↔ 服务器 协议定义
 *
 * 传输：WebSocket。控制消息用 JSON 文本帧，音频用二进制帧。
 *
 * 设计要点：
 *  1. 温湿度、电量由**板子本地读**（硬件就在板上），服务器只提供时间/日期/天气。
 *     少一次往返，且断网时这些信息仍然可用。
 *  2. 音频是裸 Opus 帧（16kHz 单声道 60ms），不带任何额外封装。
 */

export const PROTOCOL_VERSION = 1;

/* ── 设备 → 服务器 ────────────────────────────────────────────────────── */

export const DEV = {
  HELLO: "hello",   // { t, fw, mac, caps[] }
  REC: "rec",       // { t, s: "start" | "stop" | "resume" }   录音开始/结束/没说话（续播）
  BTN: "btn",       // { t, k: "key"|"boot", e: "click"|"down"|"up" }
  STAT: "stat",     // { t, bat, room:{t,h} }        板子本地状态，供服务器记录
  LUA_RESULT: "lua",// { t, id, ok, out }
  PONG: "pong",     // { t, ts }
};

/* ── 服务器 → 设备 ────────────────────────────────────────────────────── */

export const SRV = {
  HELLO_ACK: "hello_ack",  // { t, sid, pv, page, info }
  INFO: "info",            // { t, time, date, week, weather:{text,temp,city} }
  PAGE: "page",            // { t, name }（服务器已不再下发，仅保留解析兼容）
  REC_ACK: "rec_ack",      // { t, s }
  STT: "stt",              // { t, text }            识别结果（可做字幕）
  TTS_START: "tts_start",  // { t }
  TTS_STOP: "tts_stop",    // { t, fu }              fu=1：回答以问句收尾，设备播完自动聆听
  SUB: "sub",              // { t, text }            当前句子（字幕）
  LUA: "lua",              // { t, id, code }        下发脚本
  EVT: "evt",              // { t, n }               脚本事件 → sys.on 处理器（如 open_timetable）
  ERROR: "err",            // { t, msg }
  PING: "ping",            // { t, ts }
};

/* ── 构造辅助 ─────────────────────────────────────────────────────────── */

export const build = {
  helloAck: (sid, page, info) =>
    ({ t: SRV.HELLO_ACK, sid, pv: PROTOCOL_VERSION, page, info }),
  info: (info) => ({ t: SRV.INFO, ...info }),
  page: (name) => ({ t: SRV.PAGE, name }),
  stt: (text) => ({ t: SRV.STT, text }),
  ttsStart: () => ({ t: SRV.TTS_START }),
  ttsStop: (fu = false) => ({ t: SRV.TTS_STOP, fu: fu ? 1 : 0 }),
  sub: (text, frames = 0) => ({ t: SRV.SUB, text, frames }),
  lua: (id, code) => ({ t: SRV.LUA, id, code }),
  evt: (n) => ({ t: SRV.EVT, n }),
  err: (msg) => ({ t: SRV.ERROR, msg }),
  ping: () => ({ t: SRV.PING, ts: Date.now() }),
};

/* ── 时间/日期格式化（服务器侧统一算好，设备不用处理时区） ───────────── */

const WEEK_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/**
 * 生成信息栏的时间部分。时区固定东八区（可后续做成配置）。
 */
export function buildTimeInfo(weather) {
  const now = new Date(Date.now() + 8 * 3600 * 1000);   /* UTC+8 */
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const mm = String(now.getUTCMinutes()).padStart(2, "0");

  return {
    time: `${hh}:${mm}`,
    date: `${now.getUTCMonth() + 1}月${now.getUTCDate()}日`,
    week: WEEK_ZH[now.getUTCDay()],
    /* 数字字段：设备端没有中文字体，日期/星期用它渲染 */
    mm: now.getUTCMonth() + 1,
    dd: now.getUTCDate(),
    wday: now.getUTCDay(),
    weather: weather
      ? { text: weather.text, temp: weather.temp, city: weather.city ?? null }
      : { text: "--", temp: null, city: null },
  };
}
