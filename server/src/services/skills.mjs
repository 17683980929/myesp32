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

import { readdirSync, readFileSync, existsSync } from "node:fs";
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
      const type = j.type === "docs" ? "docs" : "http";
      if (type === "http" && !j.request?.url) throw new Error("缺 request.url");
      if (type === "docs" && !j.dir) throw new Error("docs 技能缺 dir");
      if (list.some((s) => s.name === j.name)) throw new Error(`工具名重复：${j.name}`);
      list.push({
        type,
        name: j.name,
        description: String(j.description).slice(0, 400),
        parameters: (j.parameters && typeof j.parameters === "object")
          ? j.parameters
          : { type: "object", properties: {} },
        request: j.request || {},
        render: typeof j.render === "string" ? j.render : "",
        /* docs：本地 Markdown 检索 */
        dir: j.dir ? path.resolve(ROOT, j.dir) : "",
        maxEntries: Math.min(6, Math.max(1, Number(j.maxEntries) || 3)),
        entryChars: Math.min(2000, Math.max(300, Number(j.entryChars) || 800)),
        minScore: Math.min(60, Math.max(2, Number(j.minScore) || 10)),
        emergency: typeof j.emergency === "string" ? j.emergency : "",
        /* 预检索触发词：决策语气 + 生活领域，两个都命中才自动查（避免误触发） */
        triggers: (j.triggers && typeof j.triggers === "object")
          ? { decision: String(j.triggers.decision || ""), domain: String(j.triggers.domain || "") }
          : null,
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

/* ── 本地文档检索（docs 类型）────────────────────────────────────── */

const docCache = new Map();   /* skill.name → [{file, title, body}] */

function loadDocs(s) {
  if (docCache.has(s.name)) return docCache.get(s.name);
  const out = [];
  if (s.dir && existsSync(s.dir)) {
    for (const f of readdirSync(s.dir).filter((x) => x.toLowerCase().endsWith(".md")).sort()) {
      const text = readFileSync(path.join(s.dir, f), "utf8");
      /* 以 "### " 开头的行作为一条；第一行之前的内容不要 */
      const parts = text.split(/^### /m);
      for (let i = 1; i < parts.length; i++) {
        const seg = parts[i];
        const nl = seg.indexOf("\n");
        const title = (nl < 0 ? seg : seg.slice(0, nl)).trim();
        const body = (nl < 0 ? "" : seg.slice(nl + 1)).trim();
        if (title) out.push({ file: f, title, body });
      }
    }
  }
  docCache.set(s.name, out);
  return out;
}

/** 中文按二元组、英文按单词切词（没有分词器时的折中）。
 *  常见虚词二元组会制造大量假命中，直接丢掉。 */
const STOP_BIGRAMS = new Set([
  "不要", "要不", "该不", "值不", "划不", "可以", "怎么", "什么", "这个", "那个",
  "一个", "有没", "没有", "是不", "不是", "多少", "时候", "帮我", "决定", "值吗",
  "用吗", "吗？", "怎么", "哪些", "哪个",
]);
function terms(q) {
  const t = [];
  for (const w of String(q).toLowerCase().match(/[a-z0-9_]{2,}/g) || []) t.push(w);
  for (const run of String(q).match(/[\u4e00-\u9fff]+/g) || []) {
    if (run.length === 1) t.push(run);
    else for (let i = 0; i + 2 <= run.length; i++) {
      const bg = run.slice(i, i + 2);
      if (!STOP_BIGRAMS.has(bg)) t.push(bg);
    }
  }
  return [...new Set(t)];
}

function searchDocs(s, query) {
  const entries = loadDocs(s);
  if (!entries.length) return null;

  const ts = terms(query);
  if (!ts.length) return null;

  /* IDF 加权：常见词（手机、不要）权重低，专有词（低钠盐、押金）权重高，
   * 避免一句"要不要买手机"把全书里所有提到"手机"的条目都捞出来。 */
  const N = entries.length;
  const idf = {};
  for (const t of ts) {
    let df = 0;
    for (const e of entries) if (e.title.includes(t) || e.body.includes(t)) df++;
    idf[t] = Math.log(1 + N / (1 + df));
  }

  const scored = [];
  for (const e of entries) {
    const title = e.title.toLowerCase();
    const body = e.body.toLowerCase();
    let score = 0;
    for (const t of ts) {
      if (title.includes(t)) score += idf[t] * 4;
      const hits = body.split(t).length - 1;
      if (hits > 0) score += idf[t] * Math.min(3, hits);
    }
    if (score >= s.minScore) scored.push({ ...e, score });
  }
  scored.sort((a, b) => b.score - a.score);

  if (!scored.length) return null;

  const picked = scored.slice(0, s.maxEntries);
  const chunks = picked.map((e) => {
    const body = e.body.length > s.entryChars ? e.body.slice(0, s.entryChars) + "…" : e.body;
    return `《${path.basename(e.file, ".md")}》${e.title}\n${body}`;
  });

  const head = [];
  if (s.emergency && /急救|昏迷|大出血|呼吸|自杀|轻生|着火|火灾|溺水|触电|中毒|中风|心梗|犯法|拘留|起诉|传唤/.test(query)) {
    head.push(s.emergency);
  }
  head.push(`（以下是从资料里检索到的 ${picked.length} 条原文，只能依据它们回答；每条注明标题出处，没查到就直说没写。）`);
  return head.join("\n") + "\n\n" + chunks.join("\n\n---\n\n");
}

/* ── 执行 ──────────────────────────────────────────────────────────── */

/** 本地预检索：模型经常"凭嘴回答"不调工具，所以命中触发词时先查好塞给它。
 *  返回 { name, text } 或 null。 */
export function preSkillFor(text) {
  const t = String(text || "");
  if (t.length < 4) return null;
  for (const s of cache) {
    if (s.type !== "docs" || !s.triggers) continue;
    const { decision, domain } = s.triggers;
    if (!decision || !domain) continue;
    if (!new RegExp(decision).test(t)) continue;
    if (!new RegExp(domain).test(t)) continue;
    /* 去掉"要不要/该不该"这类决策词再检索，否则它们会在全书里到处命中 */
    const q = t.replace(new RegExp(decision, "g"), " ");
    const text = searchDocs(s, q);
    if (!text) continue;                 /* 没查到就不塞，别让模型答"书里没写" */
    return { name: s.name, text };
  }
  return null;
}

export async function runSkill(name, args = {}) {
  const s = cache.find((x) => x.name === name);
  if (!s) return `未知工具：${name}`;
  if (s.type === "docs") {
    return searchDocs(s, args.query || args.q || args.keyword || "")
        || `技能 ${s.name}：书里没有检索到相关条目（可以换个说法再问，或检查文档是否已下载）。`;
  }

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
