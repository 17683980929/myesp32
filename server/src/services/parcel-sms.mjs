/**
 * services/parcel-sms.mjs — 从快递短信里提取单号
 *
 * 这是「手机号聚合」在没有企业授权时的可行替代：
 * 手机收到取件/签收短信 → 转发到 /api/parcel-hook → 这里提取单号 → 进「我的快递」。
 *
 * 只提取单号，不保存短信原文。规则：
 *   - 字母前缀单号（SF/YT/YD/JD/JT/STO/DPK）直接认
 *   - EMS 国际单号（EA123456789CN）
 *   - 纯数字单号必须出现在含"快递/取件/签收/驿站/单号"等上下文的短信里，
 *     并排除 11 位手机号、6 位验证码、订单号
 */

const CARRIER_WORDS = [
  ["顺丰", "shunfeng"], ["圆通", "yuantong"], ["中通", "zhongtong"],
  ["韵达", "yunda"], ["申通", "shentong"], ["京东", "jd"],
  ["极兔", "jtexpress"], ["EMS", "ems"], ["邮政", "youzhengguonei"],
  ["德邦", "debangkuaidi"], ["百世", "huitongkuaidi"],
  ["宅急送", "zhaijisong"], ["天天", "tiantian"],
];

const CONTEXT = /快递|包裹|快件|取件|签收|派送|驿站|快递柜|丰巢|菜鸟|物流|运单|单号/;
const LETTER = /(?<![A-Za-z0-9])(?:SF|YT|YD|JD|JT|STO|DPK)[A-Z0-9]{8,20}(?![A-Za-z0-9])/gi;
const EMS = /(?<![A-Za-z0-9])[A-Z]{2}\d{9}CN(?![A-Za-z0-9])/gi;
const DIGITS = /(?<![A-Za-z0-9])\d{10,20}(?![A-Za-z0-9])/g;

function guessByPrefix(n) {
  if (/^SF/i.test(n)) return "shunfeng";
  if (/^YT/i.test(n)) return "yuantong";
  if (/^YD/i.test(n)) return "yunda";
  if (/^JD/i.test(n)) return "jd";
  if (/^JT/i.test(n)) return "jtexpress";
  if (/^STO/i.test(n)) return "shentong";
  if (/^DPK/i.test(n)) return "debangkuaidi";
  if (/^[A-Z]{2}\d{9}CN$/i.test(n)) return "ems";
  return "";
}

/** 返回 [{ number, carrier }]，已去重、已转大写 */
export function parseSms(text) {
  const s = String(text || "").replace(/\s+/g, " ");
  if (!s) return [];

  const carrierWord = CARRIER_WORDS.find(([w]) => s.includes(w))?.[1] || "";
  const hasContext = CONTEXT.test(s);
  const found = new Map();

  const add = (raw, carrier = "") => {
    const n = String(raw).replace(/[\s-]/g, "").toUpperCase();
    if (!/^[A-Z0-9]{6,32}$/.test(n)) return;
    if (!found.has(n)) found.set(n, carrier);
  };

  for (const m of s.matchAll(LETTER)) add(m[0], carrierWord || guessByPrefix(m[0]));
  for (const m of s.matchAll(EMS)) add(m[0], "ems");

  /* 纯数字：只有短信在讲快递才认，避免把订单号/手机号/验证码当单号 */
  if (hasContext) {
    for (const m of s.matchAll(DIGITS)) {
      const n = m[0];
      if (/^1\d{10}$/.test(n)) continue;       /* 手机号 */
      /* "订单号 2026..." 这种是订单号，不是运单号；看紧邻的前 8 个字 */
      const before = s.slice(Math.max(0, m.index - 8), m.index);
      if (/订单|支付|流水|编号/.test(before)) continue;
      add(n, carrierWord);
    }
  }

  return [...found.entries()].map(([number, carrier]) => ({ number, carrier }));
}
