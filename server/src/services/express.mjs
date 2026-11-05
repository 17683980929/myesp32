/**
 * services/express.mjs — 快递查询 + 「我的快递」清单
 *
 * 单号查询用快递100 正式 API（不是那个免 key 的网页接口）：
 *   - 单号识别：https://www.kuaidi100.com/autonumber/auto?num=&key=
 *   - 实时查询：https://poll.kuaidi100.com/poll/query.do
 *     POST customer / sign / param，sign = MD5(key + param + customer) 大写
 *
 * 为什么不用免 key 的 /query 接口：实测无效单号（0000000000000）会返回
 * 别人的真实轨迹，同一个号每次还不同。那种数据宁可没有，也不能给用户看。
 *
 * 「我的快递」：真正的手机号聚合接口是快递100/快递鸟的企业白标服务
 * （要营业执照 + 手机号查件授权书），个人 key 调不到。所以这里用本地清单：
 *   手机号只作绑定标识；单号查过一次就记住，之后问“我的快递到哪了”逐个汇总。
 *
 * 隐私：单号只在内存里拼请求；对话层日志对 get_express / my_parcels 脱敏
 *      （device.mjs），不把单号和地址写进云端日志。结果缓存 5 分钟。
 */

import { createHash } from "node:crypto";
import { getConfig } from "../config.mjs";
import { addParcel, listParcels, removeParcel } from "./parcels.mjs";

const TTL = 5 * 60 * 1000;
const TIMEOUT = 10000;
const cache = new Map();   /* "code:number:phone" -> { at, value } */

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

function normalizeNumber(input) {
  return String(input || "").replace(/[\s-]/g, "").toUpperCase();
}

function normalizeCarrier(input) {
  const s = String(input || "").trim().toLowerCase();
  if (!s) return "";
  return CARRIERS[s] || (/^[a-z]+$/.test(s) ? s : "");
}

function guessCarrier(number) {
  for (const [re, code] of RULES) if (re.test(number)) return code;
  return "";
}

function maskPhone(p) {
  return p ? `••••••${String(p).slice(-4)}` : "";
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
async function queryOfficial(com, number, phone, customer, key) {
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

/** 解析快递100 返回，统一成 { found, state, when, latest, events, text, brief, error } */
function parseResult(code, number, j) {
  const name = NAMES[code] || code;
  const head = `${name} ${number}`;

  if (j?.result === false || (j?.returnCode && j.returnCode !== "000" && j.returnCode !== "200")) {
    const msg = j?.message || j?.returnCode || "未知错误";
    if (/单号|无轨迹|没有|不存在|查询无结果/.test(msg)) {
      return {
        found: false, state: "暂无轨迹",
        text: `没有查到 ${number} 的轨迹。可能单号输错、还没揽收，或者快递公司不对。\n如果知道是哪家快递，告诉我名字，我再查一次。`,
        brief: `${head}：暂无轨迹`,
      };
    }
    return {
      found: false, state: "查询失败", error: msg,
      text: `查询 ${number} 失败：${msg}。`,
      brief: `${head}：查询失败`,
    };
  }

  const list = Array.isArray(j?.data) ? j.data : [];
  if (!list.length || /查无结果/.test(list[0]?.context || "")) {
    return {
      found: false, state: "暂无轨迹",
      text: `没有查到 ${number} 的轨迹。可能单号输错、还没揽收，或者快递公司不对。\n如果知道是哪家快递，告诉我名字，我再查一次。`,
      brief: `${head}：暂无轨迹`,
    };
  }

  const latest = list[0] || {};
  const state = j?.state === "3" || latest.status === "签收"
    ? "已签收"
    : (STATE[String(j?.state)] || latest.status || "运输中");
  const when = String(latest.time || latest.ftime || "").slice(0, 16);
  const ctx = String(latest.context || latest.desc || "").replace(/\s+/g, " ").trim();

  const lines = [head, `当前：${state}${when ? `（${when}）` : ""}`];
  const recent = list.slice(0, 4);
  lines.push("最近轨迹：");
  recent.forEach((x, i) => {
    const t = String(x.time || x.ftime || "").slice(0, 16);
    const c = String(x.context || x.desc || "").replace(/\s+/g, " ").trim();
    lines.push(`${i + 1}. ${t}  ${c}`);
  });
  if (list.length > recent.length) lines.push(`（共 ${list.length} 条，只显示最近 ${recent.length} 条）`);

  return {
    found: true, state, when, latest, events: recent,
    text: lines.join("\n"),
    brief: `${head}：${state}${when ? `（${when}）` : ""}${ctx ? `，${ctx}` : ""}`,
  };
}

/**
 * 查一个单号。返回：
 *   { ok:false, error }                         参数/配置/公司/网络错误
 *   { ok:true, found, code, name, number, ... } 查询完成（found=false 表示暂无轨迹）
 */
export async function queryParcel(args = {}) {
  const number = normalizeNumber(args.number || args.nu || args.no);
  if (!/^[A-Za-z0-9]{6,32}$/.test(number)) {
    return { ok: false, error: "单号看起来不对：请给 6~32 位字母数字（不要带空格或横线）。" };
  }

  const cfg = getConfig()?.express || {};
  const customer = String(cfg.customer || "").trim();
  const key = String(cfg.key || "").trim();
  if (!customer || !key) return { ok: false, error: CONFIG_HINT };

  const phone = String(args.phone || "").replace(/\D/g, "").slice(-4);
  let code = normalizeCarrier(args.carrier);
  if (!code) code = await detectCarrier(number, key);
  if (!code) code = guessCarrier(number);
  if (!code) {
    return {
      ok: false,
      error: `认不出 ${number} 是哪家快递。告诉我公司名（顺丰/圆通/中通/韵达/申通/京东/极兔/EMS/邮政/德邦/百世…），我再查。`,
    };
  }

  const cacheKey = `${code}:${number}:${phone}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL) return { ok: true, ...hit.value };

  try {
    const j = await queryOfficial(code, number, phone, customer, key);
    const value = {
      code, name: NAMES[code] || code, number,
      ...parseResult(code, number, j),
    };
    /* "查无结果"不缓存：可能只是还没揽收，过几分钟再查就有了 */
    if (value.found) cache.set(cacheKey, { at: Date.now(), value });
    return { ok: true, ...value };
  } catch (e) {
    return { ok: false, error: `快递查询失败：${e.name === "AbortError" ? "请求超时" : e.message}。可以过一会儿再试。` };
  }
}

export async function expressAnswer(args = {}) {
  const r = await queryParcel(args);
  if (!r.ok) return r.error;
  /* 查到轨迹的单号自动进「我的快递」，之后不用再报单号；
   * 查无结果可能是单号打错，不自动记，避免清单被错号塞满 */
  if (r.found) addParcel(r.number, r.code);
  return r.text;
}

export async function myParcelsAnswer(args = {}) {
  const action = String(args.action || "list").toLowerCase();

  if (action === "add") {
    const r = await queryParcel({ number: args.number, carrier: args.carrier, phone: args.phone });
    if (!r.ok) return r.error;
    addParcel(r.number, r.code, args.label);
    return `记好了：${r.brief}。\n以后问「我的快递到哪了」就会一起报。`;
  }

  if (action === "remove") {
    const number = normalizeNumber(args.number);
    if (!number) return "要删哪个？告诉我单号。";
    return removeParcel(number) ? `从清单里删掉了 ${number}。` : `清单里没有 ${number}。`;
  }

  const items = listParcels();
  if (!items.length) {
    return "还没有记录快递。可以说「记一下快递，顺丰 SF123...」，或者先查一次单号，我会自动记住。";
  }

  const cfg = getConfig()?.express || {};
  if (!cfg.customer || !cfg.key) return CONFIG_HINT;

  const phone = maskPhone(cfg.phone);
  const results = [];
  for (const it of items.slice(0, 8)) {
    const r = await queryParcel({ number: it.number, carrier: it.carrier, phone: args.phone });
    /* 第一次查到公司就补进清单，下次不用再走单号识别 */
    if (r.ok && r.code && !it.carrier) addParcel(it.number, r.code, it.label);
    results.push({ it, r });
    await new Promise((ok) => setTimeout(ok, 120));   /* 给快递100 留点 QPS 余量 */
  }

  /* 在途的排前面，签收/暂无轨迹/失败的排后面 */
  const rank = (r) => {
    if (!r.ok) return 3;
    if (!r.found) return 2;
    return r.state === "已签收" ? 1 : 0;
  };
  results.sort((a, b) => rank(a.r) - rank(b.r));

  const lines = results.map(({ it, r }, i) => {
    const label = it.label ? `「${it.label}」` : "";
    if (!r.ok) return `${i + 1}. ${label}${it.number}：查询失败`;
    return `${i + 1}. ${label}${r.brief}`;
  });

  const head = `你有 ${items.length} 个快递${phone ? `（手机号 ${phone}）` : ""}：`;
  const tail = items.length > 8 ? `\n还有 ${items.length - 8} 个没显示，先去管理页删掉旧的吧。` : "";
  return head + "\n" + lines.join("\n") + tail;
}
