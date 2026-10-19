/**
 * services/news.mjs — 热点新闻（免注册源 + 缓存 + 兜底）
 *
 * 给"小鱼"的 get_news 工具用。主源头条热榜（纯 JSON），兜底微博热搜（JSON）。
 * 数据缓存在内存 refreshSec 秒；刷新失败时沿用旧缓存。
 */

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
const TIMEOUT_MS = 8000;

async function fetchToutiao() {
  const r = await fetch("https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc", {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`头条 HTTP ${r.status}`);
  const j = await r.json();
  const list = (j?.data ?? []).map((x) => x?.Title).filter(Boolean);
  if (!list.length) throw new Error("头条返回空列表");
  return list;
}

async function fetchWeibo() {
  const r = await fetch("https://weibo.com/ajax/side/hotSearch", {
    headers: { "User-Agent": UA, Referer: "https://weibo.com/" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`微博 HTTP ${r.status}`);
  const j = await r.json();
  const list = (j?.data?.realtime ?? [])
    .filter((x) => x && x.word && !x.is_ad)
    .map((x) => x.word);
  if (!list.length) throw new Error("微博返回空列表");
  return list;
}

const SOURCES = {
  toutiao: { name: "头条热榜", fetch: fetchToutiao },
  weibo: { name: "微博热搜", fetch: fetchWeibo },
};
const AUTO_ORDER = ["toutiao", "weibo"];

let cache = { list: [], source: "", at: 0 };
let inflight = null;

async function refresh(order) {
  let lastErr = null;
  for (const key of order) {
    const src = SOURCES[key];
    if (!src) continue;
    try {
      const list = await src.fetch();
      cache = { list, source: src.name, at: Date.now() };
      return cache;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`新闻源都失败了（${lastErr?.message ?? "无可用源"}）`);
}

/**
 * 取热点列表（缓存内直接返回，过期才刷新；并发调用共享同一次刷新）。
 * @param {{source?:string, refreshSec?:number}} [cfg]
 * @returns {Promise<{list:string[], source:string, at:number}>}
 */
export async function getHotNews(cfg = {}) {
  const ttl = Math.max(60, Number(cfg.refreshSec) || 600) * 1000;
  if (cache.list.length && Date.now() - cache.at < ttl) return cache;

  if (!inflight) {
    const order = cfg.source && cfg.source !== "auto"
      ? [cfg.source, ...AUTO_ORDER]
      : AUTO_ORDER.slice();
    inflight = refresh([...new Set(order)])
      .catch((e) => {
        if (cache.list.length) {          /* 刷新失败：用旧数据兜底，30 秒后再试 */
          cache = { ...cache, at: Date.now() - ttl + 30000 };
          return cache;
        }
        throw e;
      })
      .finally(() => { inflight = null; });
  }
  return inflight;
}
