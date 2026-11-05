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

import { readdirSync, readFileSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { ROOT, getConfig } from "../config.mjs";
import { cityCoords } from "./weather.mjs";
import { calendarAnswer } from "./calendar.mjs";
import { menuAnswer } from "./menu.mjs";
import { expressAnswer } from "./express.mjs";

const DIR = path.join(ROOT, "skills");
const FETCH_TIMEOUT_MS = 8000;
const MAX_BODY = 8192;

/* 内置 handler：需要计算的技能（节假日倒计时之类）没法用「一次 HTTP + 模板」表达，
 * 放在服务端实现，JSON 里只写 type:"builtin" + handler 名字。 */
const BUILTINS = {
  calendar: calendarAnswer,
  menu: menuAnswer,
  express: expressAnswer,
};

let cache = [];
let lastError = "";
let loadedAt = 0;
const docCache = new Map();   /* skill.name → [{file, title, body}] */

export const skillsDir = () => DIR;
export const skillsError = () => lastError;
export const skillsLoadedAt = () => loadedAt;
export const loadedSkills = () => cache;

/** 重新扫描目录（启动时和管理页“重载”时调用） */
export function reloadSkills() {
  const list = [];
  const errs = [];
  docCache.clear();   /* 重载时把已解析的文档也丢掉，否则改了语料还读旧内容 */
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
      const type = j.type === "docs" ? "docs" : j.type === "builtin" ? "builtin" : "http";
      if (type === "http" && !j.request?.url) throw new Error("缺 request.url");
      if (type === "docs" && !j.dir) throw new Error("docs 技能缺 dir");
      if (type === "builtin" && !BUILTINS[j.handler])
        throw new Error(`内置技能缺 handler 或 handler 未知：${j.handler || "(空)"}`);
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
        /* builtin：服务端实现的 handler 名 */
        handler: type === "builtin" ? String(j.handler) : "",
        /* docs：本地 Markdown 检索 */
        dir: j.dir ? path.resolve(ROOT, j.dir) : "",
        maxEntries: Math.min(6, Math.max(1, Number(j.maxEntries) || 3)),
        entryChars: Math.min(2000, Math.max(300, Number(j.entryChars) || 800)),
        minScore: Math.min(60, Math.max(2, Number(j.minScore) || 10)),
        /* 菜谱这类"标题就是答案"的资料：查询开头必须命中菜名，
         * 否则"可乐鸡翅"会被"鸡翅"带到"空气炸锅鸡翅中" */
        headMatch: Boolean(j.headMatch),
        emergency: typeof j.emergency === "string" ? j.emergency : "",
        /* 口语 → 原文词的同义扩展：法条里不会出现"假货""押金"这种说法，
         * 不扩的话用户怎么问都查不到 */
        synonyms: (j.synonyms && typeof j.synonyms === "object") ? j.synonyms : null,
        /* 预检索触发词：决策语气 + 生活领域，两个都命中才自动查（避免误触发） */
        triggers: (j.triggers && typeof j.triggers === "object")
          ? {
              decision: String(j.triggers.decision || ""),
              domain: String(j.triggers.domain || ""),
              ask: String(j.triggers.ask || ""),
            }
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

/* ── 网页导入 / 删除（管理页「技能」卡片用）────────────────────────
 * 只允许写 server/skills/<name>.json，文件名由 name 派生，不接受任何路径。
 * 校验规则和 reloadSkills 保持一致，写文件之前先挡掉坏数据。
 */

function validateSkill(j) {
  if (!j || typeof j !== "object") throw new Error("不是一个 JSON 对象");
  const name = String(j.name || "");
  if (!/^[a-zA-Z0-9_]{2,40}$/.test(name)) throw new Error("name 只能字母数字下划线（2~40）");
  if (!j.description) throw new Error("缺 description");

  const type = j.type === "docs" ? "docs" : j.type === "builtin" ? "builtin" : "http";
  if (type === "http") {
    const url = String(j.request?.url || "");
    if (!url) throw new Error("http 技能缺 request.url");
    if (!/^https?:\/\//i.test(url)) throw new Error("request.url 只允许 http/https");
  } else if (type === "builtin") {
    if (!BUILTINS[j.handler]) throw new Error(`内置技能缺 handler 或 handler 未知：${j.handler || "(空)"}`);
  } else {
    if (!j.dir) throw new Error("docs 技能缺 dir");
    if (!existsSync(path.resolve(ROOT, String(j.dir))))
      throw new Error(`docs 目录不存在：${j.dir}`);
  }
  return { j, name, type };
}

/** 写入一个技能 JSON 并立即重载。overwrite=false 时同名文件会被拒绝。 */
export function saveSkill(text, { overwrite = false } = {}) {
  let raw;
  try {
    raw = JSON.parse(String(text || ""));
  } catch (e) {
    throw new Error(`JSON 解析失败：${e.message}`);
  }
  const { j, name } = validateSkill(raw);
  const file = path.join(DIR, `${name}.json`);
  if (existsSync(file) && !overwrite) throw new Error(`已存在同名技能 ${name}（勾选“覆盖同名”再提交）`);

  writeFileSync(file, JSON.stringify(j, null, 2) + "\n", "utf8");
  reloadSkills();
  if (!cache.some((s) => s.name === name)) throw new Error(lastError || "写入后仍未加载");
  return { name, file, count: cache.length };
}

/** 删除 server/skills/<name>.json 并重载 */
export function deleteSkill(name) {
  const n = String(name || "");
  if (!/^[a-zA-Z0-9_]{2,40}$/.test(n)) throw new Error("技能名不合法");
  const file = path.join(DIR, `${n}.json`);
  if (!existsSync(file)) throw new Error(`没有这个技能文件：${n}.json`);
  unlinkSync(file);
  reloadSkills();
  return { name: n, count: cache.length };
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
  return String(str).replace(/\{\{\s*([\w.@]+)\s*\}\}/g, (_, k) => {
    const v = pick(data, k);
    const s = (v && typeof v === "object") ? JSON.stringify(v) : String(v);
    return encode ? encodeURIComponent(s) : s;
  });
}

/* ── 本地文档检索（docs 类型）────────────────────────────────────── */

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

/** 菜谱类查询的"菜名头"：去掉疑问词和"需要什么材料"之类的尾缀，
 *  取前两个字（"番茄炒蛋怎么做" → 番茄）。headMatch 技能靠它挡掉
 *  "可乐鸡翅"被"鸡翅"带到"空气炸锅鸡翅中"这类误配。 */
function queryHead(q, synonyms) {
  let s = String(q).toLowerCase()
    .replace(/[？?！!。，,、\s]/g, "")
    .replace(/^(怎么做|如何做|怎样做)/, "")
    .replace(/^(我想|我要|想做|想吃|帮我|请问|今天|晚上|中午|早上|做|来|吃)+/, "");
  s = s.replace(/(怎么做|怎么烧|如何做|怎样做|的做法|做法|需要什么材料|需要什么|要什么材料|要什么|放多少.*|怎么弄|教程)$/, "");
  if (!s) return [];
  const head = s.slice(0, 2);
  const list = [head, ...(synonyms?.[head] || [])];
  return list.filter((x) => typeof x === "string" && x.length >= 2);
}

function searchDocs(s, query) {
  const all = loadDocs(s);
  if (!all.length) return null;

  const ts0 = terms(query);
  if (!ts0.length) return null;

  /* 同义扩展：用户说"假货"，法条里写的是"欺诈"；说"押金"，原文写"保证金/租金"。
   * 只做一次展开（不递归），避免越扩越偏。 */
  let ts = ts0;
  if (s.synonyms) {
    const extra = [];
    for (const t of ts0) {
      const add = s.synonyms[t];
      if (Array.isArray(add)) for (const x of add) if (typeof x === "string" && x) extra.push(x);
    }
    if (extra.length) ts = [...new Set([...ts0, ...extra])];
  }

  /* 菜谱：先按菜名头过滤候选，并要求查询里至少两个二元组命中标题。
   * 只卡"头两个字"不够——"番茄炒蛋"会靠别名"番茄"匹配到"西红柿牛腩（番茄牛腩）"。
   * 注意 IDF 仍要用全量语料算：在过滤后的小集合里算，df 接近 N，权重会被压成 0。 */
  let candidates = all;
  if (s.headMatch) {
    const heads = queryHead(query, s.synonyms);
    if (!heads.length) return null;
    const need = Math.min(2, ts0.length);
    candidates = all.filter((e) => {
      const title = e.title.toLowerCase();
      if (!heads.some((h) => title.includes(h))) return false;
      let hit = 0;
      for (const t of ts0) if (title.includes(t)) hit++;
      return hit >= need;
    });
    if (!candidates.length) return null;
  }

  /* IDF 加权：常见词（手机、不要）权重低，专有词（低钠盐、押金）权重高，
   * 避免一句"要不要买手机"把全书里所有提到"手机"的条目都捞出来。 */
  const N = all.length;
  const idf = {};
  for (const t of ts) {
    let df = 0;
    for (const e of all) if (e.title.includes(t) || e.body.includes(t)) df++;
    idf[t] = Math.log(1 + N / (1 + df));
  }

  const scored = [];
  for (const e of candidates) {
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
    const { decision, domain, ask } = s.triggers;

    /* ask：问定义/区别类（"什么是…""…和…的区别"），命中就检索，不需要领域词 */
    if (ask && new RegExp(ask).test(t)) {
      const text = searchDocs(s, t);
      if (text) return { name: s.name, text };
      continue;
    }

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

/** 模板内置变量：{{@city}} {{@lat}} {{@lon}} {{@today}}
 *  模型不知道今天几号、也不知道配置城市的经纬度，这两个只有服务器知道。 */
function builtinVars() {
  const out = { "@city": "", "@lat": "", "@lon": "" };
  try {
    const city = String(getConfig()?.weather?.city || "").trim();
    out["@city"] = city;
    const c = city ? cityCoords(city) : null;
    if (c) { out["@lat"] = String(c.lat); out["@lon"] = String(c.lon); }
  } catch {
    /* 配置读不到就留空，技能请求会自己失败，不影响其它功能 */
  }
  out["@today"] = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  return out;
}

export async function runSkill(name, args = {}) {
  const s = cache.find((x) => x.name === name);
  if (!s) return `未知工具：${name}`;
  if (s.type === "builtin") {
    try {
      return await BUILTINS[s.handler](args);
    } catch (e) {
      return `技能 ${name} 执行失败：${e?.message || e}`;
    }
  }
  if (s.type === "docs") {
    return searchDocs(s, args.query || args.q || args.keyword || "")
        || `技能 ${s.name}：书里没有检索到相关条目（可以换个说法再问，或检查文档是否已下载）。`;
  }

  const r = s.request;
  const vars = { ...args, ...builtinVars() };
  const method = String(r.method || "GET").toUpperCase();
  const url = tpl(r.url, vars, true);
  if (!/^https?:\/\//i.test(url)) return "技能配置错误：只允许 http/https 地址";

  const headers = {};
  for (const [k, v] of Object.entries(r.headers || {})) headers[k] = tpl(v, vars, false);

  let body;
  if (method !== "GET" && method !== "HEAD" && r.body != null) {
    body = typeof r.body === "string" ? tpl(r.body, vars, false) : JSON.stringify(r.body);
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
    if (s.render) return tpl(s.render, { ...vars, data, value: data }, false).trim();
    return typeof data === "string" ? data.slice(0, 500) : JSON.stringify(data).slice(0, 900);
  } catch (e) {
    return `技能 ${name} 执行失败：${e.name === "AbortError" ? "请求超时" : e.message}`;
  } finally {
    clearTimeout(timer);
  }
}
