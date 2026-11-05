/**
 * services/express.mjs — 快递查询（内置技能 handler）
 *
 * 用快递100 正式 API（不是那个免 key 的网页接口）：
 *   - 单号识别：https://www.kuaidi100.com/autonumber/auto?num=&key=
 *   - 实时查询：https://poll.kuaidi100.com/poll/query.do
 *     POST customer / sign / param，sign = MD5(key + param + customer) 大写
 *
 * 为什么不用免 key 的 /query 接口：实测无效单号（0000000000000）会返回
 * 别人的真实轨迹，同一个号每次还不同。那种数据宁可没有，也不能给用户看。
 *
 * 配置：server/config.json → express.customer / express.key
 *      （api.kuaidi100.com 注册后获取；管理页「快递查询」可直接填）
 *
 * 隐私：单号只在内存里拼请求；对话层的工具调用/结果日志对 get_express 做了脱敏
 *      （device.mjs），不把单号和地址写进云端日志。结果缓存 5 分钟。
 */

import { createHash } from "node:crypto";
import { getConfig } from "../config.mjs";

const TTL = 5 * 60 * 1000;
const TIMEOUT = 10000;
const cache = new Map();   /* "code:number" -> { at, text } */

/* 常用快递公司：中文名/拼音/代码 → 快递100 的 com */
const CARRIERS = {
  顺丰: "shunfeng", 顺丰速运: "shunfeng", sf: "shunfeng", shunfeng: "shunfeng",
  圆通: "yuantong", 圆通速递: "yuantong", yt: "yuantong", yuantong: "yuantong",
  中通: "zhongtong", 中通快递: "zhongtong", zto: "zhongtong", zhongtong: "zhongtong",
  韵达: "yunda", 韵达快递: "yunda", yd: "yunda", yunda: "yunda",
  申通: "shentong", 申通快递: "shentong", sto: "shentong", shentong: "shentong",
  京东: "jd", 京东物流: "jd", jd: "jd",
  极兔: "jtexpress", 极兔速递: "jtexpress", jt: "jtexpress", jtexpress: "jtexpress",
  ems: "ems", 邮政: "youzhengguonei", 邮政快递: "youzhengguonei", 中国邮政: "youzhengguonei",
  德邦: "debangkuaidi", 德邦快递: "debangkuaidi", 德邦物流: "debangwuliu",
  百世: "huitongkuaidi", 百世快递: "huitongkuaidi",
  宅急送: "zhaijisong", 天天: "tiantian", 天天快递: "tiantian",
  优速: "youshuwuliu", 优速快递: "youshuwuliu",
  丰网: "fengwang", 菜鸟: "cainiao",
};

const NAMES = {
  shunfeng: "顺丰", yuantong: "圆通", zhongtong: "中通", yunda: "韵达",
  shentong: "申通", jd: "京东物流", jtexpress: "极兔", ems: "EMS",
  youzhengguonei: "邮政", debangkuaidi: "德邦", debangwuliu: "德邦",
  huitongkuaidi: "百世", zhaijisong: "宅急送", tiantian: "天天",
  youshuwuliu: "优速", fengwang: "丰网", cainiao: "菜鸟",
};

/* 单号前缀 → 公司。只作为"单号识别接口失败"时的兜底，不靠它做唯一判断 */
const RULES = [
  [/^SF\d{10,}$/i, "shunfeng"],
  [/^YT\d{10,}$/i, "yuantong"],
  [/^YD\d{10,}$/i, "yunda"],
  [/^JD[A-Z0-9]{10,}$/i, "jd"],
  [/^JT\d{10,}$/i, "jtexpress"],
  [/^STO[A-Z0-9]{10,}$/i, "shentong"],
  [/^DPK\d{10,}$/i, "debangkuaidi"],
  [/^[A-Z]{2}\d{9}CN$/i, "ems"],
  [/^(78|68|73|75|76)\d{10,}$/, "zhongtong"],
  [/^(77|88|66|55|56)\d{10,}$/, "shentong"],
];

const STATE = {
  0: "运输中", 1: "已揽收", 2: "疑难件", 3: "已签收", 4: "已退签",
  5: "派送中", 6: "已退回", 7: "转投", 8: "清关中", 9: "拒签",
  10: "待清关", 11: "待上门", 12: "派送异常", 13: "签收失败", 14: "拒收",
};

const CONFIG_HINT =
  "快递查询还没配置。去 api.kuaidi100.com 注册，" +
  "把「授权码 customer」和「密钥 key」填到管理页的「快递查询」，保存后就能查。";

function normalizeCarrier(input) {
  const s = String(input || "").trim().toLowerCase();
  if (!s) return "";
  return CARRIERS[s] || (/^[a-z]+$/.test(s) ? s : "");
}

function guessCarrier(number) {
  for (const [re, code] of RULES) if (re.test(number)) return code;
  return "";
}

async function fetchJson(url, init = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT);
  try {
    const res = await fetch(url, { ...init, signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** 单号识别：返回 comCode；识别不出返回 ""（不抛错，交给前缀兜底） */
async function detectCarrier(number, key) {
  try {
    const arr = await fetchJson(
      `https://www.kuaidi100.com/autonumber/auto?num=${encodeURIComponent(number)}&key=${encodeURIComponent(key)}`,
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
    if (Array.isArray(arr) && arr[0]?.comCode) return String(arr[0].comCode).toLowerCase();
  } catch {
    /* 识别接口失败不致命，继续用前缀猜 */
  }
  return "";
}

/** 快递100 实时查询（正式 API，需要 customer/key） */
async function query(com, number, phone, customer, key) {
  const paramObj = { com, num: number };
  if (phone) paramObj.phone = phone;
  const param = JSON.stringify(paramObj);
  const sign = createHash("md5").update(key + param + customer).digest("hex").toUpperCase();
  const body = new URLSearchParams({ customer, sign, param });
  return fetchJson("https://poll.kuaidi100.com/poll/query.do", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0",
    },
    body,
  });
}

function format(code, number, j) {
  const name = NAMES[code] || code;

  if (j?.result === false || (j?.returnCode && j.returnCode !== "000" && j.returnCode !== "200")) {
    const msg = j?.message || j?.returnCode || "未知错误";
    if (/单号|无轨迹|没有|不存在|查询无结果/.test(msg)) {
      return `没有查到 ${number} 的轨迹。可能单号输错、还没揽收，或者快递公司不对。\n如果知道是哪家快递，告诉我名字，我再查一次。`;
    }
    return `查询 ${number} 失败：${msg}。`;
  }

  const list = Array.isArray(j?.data) ? j.data : [];
  if (!list.length || /查无结果/.test(list[0]?.context || "")) {
    return `没有查到 ${number} 的轨迹。可能单号输错、还没揽收，或者快递公司不对。\n如果知道是哪家快递，告诉我名字，我再查一次。`;
  }

  const latest = list[0] || {};
  const state = j?.state === "3" || latest.status === "签收"
    ? "已签收"
    : (STATE[String(j?.state)] || latest.status || "运输中");
  const when = String(latest.time || latest.ftime || "").slice(0, 16);
  const lines = [`${name} ${number}`, `当前：${state}${when ? `（${when}）` : ""}`];

  const recent = list.slice(0, 4);
  lines.push("最近轨迹：");
  recent.forEach((x, i) => {
    const t = String(x.time || x.ftime || "").slice(0, 16);
    const ctx = String(x.context || x.desc || "").replace(/\s+/g, " ").trim();
    lines.push(`${i + 1}. ${t}  ${ctx}`);
  });
  if (list.length > recent.length) lines.push(`（共 ${list.length} 条，只显示最近 ${recent.length} 条）`);
  return lines.join("\n");
}

export async function expressAnswer(args = {}) {
  const raw = String(args.number || args.nu || args.no || "").replace(/[\s-]/g, "");
  if (!/^[A-Za-z0-9]{6,32}$/.test(raw)) {
    return "单号看起来不对：请给 6~32 位字母数字（不要带空格或横线）。";
  }
  const number = raw.toUpperCase();

  const cfg = getConfig()?.express || {};
  const customer = String(cfg.customer || "").trim();
  const key = String(cfg.key || "").trim();
  if (!customer || !key) return CONFIG_HINT;

  const phone = String(args.phone || "").replace(/\D/g, "").slice(-4);
  let code = normalizeCarrier(args.carrier);
  if (!code) code = await detectCarrier(number, key);
  if (!code) code = guessCarrier(number);
  if (!code) {
    return `认不出 ${number} 是哪家快递。告诉我公司名（顺丰/圆通/中通/韵达/申通/京东/极兔/EMS/邮政/德邦/百世…），我再查。`;
  }

  const cacheKey = `${code}:${number}:${phone}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL) return hit.text;

  try {
    const j = await query(code, number, phone, customer, key);
    const text = format(code, number, j);
    /* "查无结果"不缓存：可能只是还没揽收，过几分钟再查就有了 */
    if (!text.startsWith("没有查到")) cache.set(cacheKey, { at: Date.now(), text });
    return text;
  } catch (e) {
    return `快递查询失败：${e.name === "AbortError" ? "请求超时" : e.message}。可以过一会儿再试。`;
  }
}
