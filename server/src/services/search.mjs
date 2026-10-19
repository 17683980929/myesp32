/**
 * services/search.mjs — 联网搜索（多引擎 + 缓存 + 兜底）
 *
 * 源顺序：360 → 搜狗 → 百度 → 必应。
 * 必应对部分中文查询会"静默降级"（返回首词字典页等垃圾），所以放最后，
 * 且所有源都过一遍关键词命中校验：结果里查不到查询词的源直接跳过。
 * 只取标题 + 摘要（语音场景用不到网址）。
 */

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const TIMEOUT_MS = 8000;
const CACHE_MAX = 64;

const CJK_RE = /[\u4e00-\u9fff]+/g;
const ALNUM_RE = /[a-z0-9]{2,}/gi;

const NAMED = {
  lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", amp: "&",
  nbsp: " ", ensp: " ", emsp: " ", ndash: "–", mdash: "—", hellip: "…", middot: "·",
};

/** HTML 片段 → 纯文本（去标签、解实体、压空白） */
function decode(s) {
  return String(s)
    .replace(/<[^>]*>/g, "")
    .replace(/&#(x?)([0-9a-fA-F]+);/g, (m, x, n) => {
      const cp = parseInt(n, x ? 16 : 10);
      return cp >= 32 && cp <= 0x10ffff ? String.fromCodePoint(cp) : " ";
    })
    .replace(/&([a-zA-Z#0-9]+);/g, (m, e) => (e in NAMED ? NAMED[e] : " "))
    .replace(/\s+/g, " ")
    .trim();
}

const clip = (s, n) => decode(s).slice(0, n);

function dedupe(items) {
  const seen = new Set();
  return items.filter((it) => {
    if (!it.title || seen.has(it.title)) return false;
    seen.add(it.title);
    return true;
  });
}

/* ---------- 相关性校验：结果里必须能查到查询词 ---------- */

/** 查询 → 词元集合（中文取二元组，英文/数字取整词） */
function tokensOf(text) {
  const set = new Set();
  const s = String(text).toLowerCase();
  for (const m of s.matchAll(CJK_RE)) {
    const run = m[0];
    if (run.length === 1) set.add(run);
    else for (let i = 0; i < run.length - 1; i++) set.add(run.slice(i, i + 2));
  }
  for (const m of s.matchAll(ALNUM_RE)) set.add(m[0]);
  return set;
}

/** 结果集至少命中若干词元，否则视为"降级页" */
function relevant(query, items) {
  const toks = tokensOf(query);
  if (!toks.size) return true;
  const text = items.map((i) => `${i.title} ${i.snippet}`).join(" ").toLowerCase();
  let hits = 0;
  for (const t of toks) if (text.includes(t) && ++hits >= (toks.size >= 3 ? 2 : 1)) return true;
  return false;
}

/* ---------- 各源解析 ---------- */

const JUNK_TITLE = /相关消息$|相关搜索$|相关推荐$|_第\d+页_|^大家还在搜$/;

function parse360(html, n) {
  const out = [];
  for (const m of html.matchAll(/<li class="res-list[^>]*>[\s\S]*?<\/li>/g)) {
    const b = m[0];
    const t = b.match(/<h3[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/);
    if (!t) continue;
    const title = clip(t[1], 60);
    if (!title || JUNK_TITLE.test(title)) continue;
    const s = b.match(/<span data-result-summary>([\s\S]*?)<\/span>/) || b.match(/<p[^>]*class="[^"]*res-desc[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    out.push({ title, snippet: s ? clip(s[1], 160) : "" });
    if (out.length >= n) break;
  }
  return dedupe(out);
}

function parseSogou(html, n) {
  const titles = [...html.matchAll(/<a name="dttl"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => clip(m[1], 60));
  const snips = [...html.matchAll(/<div[^>]*id="cacheresult_summary_\d+"[^>]*>([\s\S]*?)<\/div>/g)].map((m) => clip(m[1], 160));
  const out = [];
  for (let i = 0; i < titles.length; i++) {
    if (!titles[i] || JUNK_TITLE.test(titles[i])) continue;
    out.push({ title: titles[i], snippet: snips[i] || "" });
    if (out.length >= n) break;
  }
  return dedupe(out);
}

function parseBaidu(html, n) {
  const out = [];
  for (const part of html.split(/<div class="result c-container/).slice(1)) {
    const t = part.match(/<a[^>]*class="[^"]*cosc-title-a[^"]*"[^>]*>([\s\S]*?)<\/a>/) || part.match(/<h3[^>]*class="[^"]*\bt\b[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/) || part.match(/<h3[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/);
    if (!t) continue;
    const title = clip(t[1], 60);
    if (!title || JUNK_TITLE.test(title)) continue;
    const s = part.match(/data-module="abstract"[^>]*>([\s\S]*?)<\/(?:div|span)>/) || part.match(/<div[^>]*class="[^"]*c-abstract[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    out.push({ title, snippet: s ? clip(s[1], 160) : "" });
    if (out.length >= n) break;
  }
  return dedupe(out);
}

function parseBing(html, n) {
  const out = [];
  for (const m of html.matchAll(/<li class="b_algo[^>]*>[\s\S]*?<\/li>/g)) {
    const b = m[0];
    const t = b.match(/<h2[^>]*><a[^>]*>([\s\S]*?)<\/a><\/h2>/);
    if (!t) continue;
    const title = clip(t[1], 60);
    if (!title || JUNK_TITLE.test(title)) continue;
    const s = b.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    out.push({ title, snippet: s ? clip(s[1], 160) : "" });
    if (out.length >= n) break;
  }
  return dedupe(out);
}

const SOURCES = [
  { name: "360搜索", url: (q) => `https://www.so.com/s?q=${encodeURIComponent(q)}`, parse: parse360 },
  { name: "搜狗", url: (q) => `https://www.sogou.com/web?query=${encodeURIComponent(q)}`, parse: parseSogou },
  { name: "百度", url: (q) => `https://www.baidu.com/s?wd=${encodeURIComponent(q)}`, parse: parseBaidu },
  { name: "必应", url: (q) => `https://cn.bing.com/search?q=${encodeURIComponent(q)}&setlang=zh-CN&cc=CN&count=10`, parse: parseBing },
];

/** 关键词 → {data, at}（简易 LRU：超量删最早） */
const cache = new Map();

/**
 * 联网搜索。
 * @param {string} query 关键词
 * @param {{refreshSec?:number}} [cfg]
 * @param {number} [count] 要几条（1~8）
 * @returns {Promise<{query:string, source:string, items:Array<{title:string,snippet:string}>}>}
 */
export async function webSearch(query, cfg = {}, count = 5) {
  const q = String(query ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!q) throw new Error("搜索关键词为空");

  const ttl = Math.max(60, Number(cfg.refreshSec) || 600) * 1000;
  const hit = cache.get(q);
  if (hit && Date.now() - hit.at < ttl) {
    return { ...hit.data, items: hit.data.items.slice(0, count) };
  }

  const want = Math.max(count, 5);
  let lastErr = null;
  for (const src of SOURCES) {
    try {
      const r = await fetch(src.url(q), {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const items = src.parse(await r.text(), want);
      if (!items.length) throw new Error("解析不到结果");
      if (!relevant(q, items)) throw new Error("结果与查询不相关（疑似降级页）");
      const data = { query: q, source: src.name, items };
      cache.set(q, { data, at: Date.now() });
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
      return { ...data, items: items.slice(0, count) };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`搜索源都失败了（${lastErr?.message ?? "无可用源"}）`);
}
