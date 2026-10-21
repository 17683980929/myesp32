/**
 * services/skills.mjs — 声明式技能（server/skills/*.json）
 *
 * 一个技能 = 一条 OpenAI 工具声明 + 一次 HTTP 请求 + 一个结果模板。
 * 加能力只需往 server/skills/ 丢一个 JSON，管理页点“重载技能”即可生效。
 *
 * JSON 格式：
 * {
 *   "name": "get_public_ip",                  // 工具名（字母数字下划线）
 *   "description": "…什么时候该调用…",          // 模型靠它判断
 *   "parameters": { "type": "object", "properties": { "city": { "type": "string" } } },
 *   "request": {
 *     "method": "GET",
 *     "url": "https://api.example.com/x?city={{city}}",   // {{参数}} 会被替换并 URL 编码
 *     "headers": { "X-Key": "…" },
 *     "body": "{\"q\":\"{{q}}\"}"                          // 非 GET 时可选（对象或字符串）
 *   },
 *   "render": "结果：{{data.price}}",           // 可选；不写就回原始 JSON（截断）
 *   "enabled": true                             // 可选，false 则不加载
 * }
 *
 * 约束：只允许 http/https；超时 8 秒；返回文本截断，避免污染上下文。
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "../config.mjs";

const DIR = path.join(ROOT, "skills");
const FETCH_TIMEOUT_MS = 8000;
const MAX_BODY = 8192;

let cache = [];
let lastError = "";
let loadedAt = 0;

export const skillsDir = () => DIR;
export const skillsError = () => lastError;
export const skillsLoadedAt = () => loadedAt;
export const loadedSkills = () => cache;

/** 重新扫描目录（启动时和管理页“重载”时调用） */
export function reloadSkills() {
  const list = [];
  const errs = [];
  let files = [];
  try {
    files = readdirSync(DIR).filter((f) => f.toLowerCase().endsWith(".json")).sort();
  } catch {
    files = [];
  }

  for (const f of files) {
    try {
      const j = JSON.parse(readFileSync(path.join(DIR, f), "utf8"));
      if (j.enabled === false) continue;
      if (!j.name || !/^[a-zA-Z0-9_]{2,40}$/.test(j.name)) throw new Error("name 只能字母数字下划线（2~40）");
      if (!j.description) throw new Error("缺 description");
      if (!j.request || !j.request.url) throw new Error("缺 request.url");
      if (list.some((s) => s.name === j.name)) throw new Error(`工具名重复：${j.name}`);
      list.push({
        name: j.name,
        description: String(j.description).slice(0, 300),
        parameters: (j.parameters && typeof j.parameters === "object")
          ? j.parameters
          : { type: "object", properties: {} },
        request: j.request,
        render: typeof j.render === "string" ? j.render : "",
        file: f,
      });
    } catch (e) {
      errs.push(`${f}: ${e.message}`);
    }
  }

  cache = list;
  lastError = errs.join("；");
  loadedAt = Date.now();
  return list;
}

/** 合并进 LLM 的 tools 数组 */
export function skillTools() {
  return cache.map((s) => ({
    type: "function",
    function: { name: s.name, description: s.description, parameters: s.parameters },
  }));
}

/* ── 模板 ──────────────────────────────────────────────────────────── */

function pick(obj, dotted) {
  let cur = obj;
  for (const k of String(dotted).split(".")) {
    if (cur == null) return "";
    cur = cur[k];
  }
  return cur == null ? "" : cur;
}

function tpl(str, data, encode) {
  return String(str).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => {
    const v = pick(data, k);
    const s = (v && typeof v === "object") ? JSON.stringify(v) : String(v);
    return encode ? encodeURIComponent(s) : s;
  });
}

/* ── 执行 ──────────────────────────────────────────────────────────── */

export async function runSkill(name, args = {}) {
  const s = cache.find((x) => x.name === name);
  if (!s) return `未知工具：${name}`;

  const r = s.request;
  const method = String(r.method || "GET").toUpperCase();
  const url = tpl(r.url, args, true);
  if (!/^https?:\/\//i.test(url)) return "技能配置错误：只允许 http/https 地址";

  const headers = {};
  for (const [k, v] of Object.entries(r.headers || {})) headers[k] = tpl(v, args, false);

  let body;
  if (method !== "GET" && method !== "HEAD" && r.body != null) {
    body = typeof r.body === "string" ? tpl(r.body, args, false) : JSON.stringify(r.body);
    if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type"))
      headers["Content-Type"] = "application/json";
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method, headers, body, signal: ac.signal });
    const text = (await res.text()).slice(0, MAX_BODY);
    if (!res.ok) return `技能 ${name} 请求失败：HTTP ${res.status} ${text.slice(0, 120)}`;

    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    if (s.render) return tpl(s.render, { data, value: data }, false).trim();
    return typeof data === "string" ? data.slice(0, 500) : JSON.stringify(data).slice(0, 900);
  } catch (e) {
    return `技能 ${name} 执行失败：${e.name === "AbortError" ? "请求超时" : e.message}`;
  } finally {
    clearTimeout(timer);
  }
}
