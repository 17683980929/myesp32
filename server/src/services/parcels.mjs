/**
 * services/parcels.mjs — 「我的快递」清单（本地持久化）
 *
 * 为什么不直接按手机号向快递公司查：
 *   快递100 的「手机号查快递」是合作伙伴白标接口（要营业执照 + 手机号查件授权书），
 *   快递鸟的手机号接口也是企业专享。个人 API key 调不到，硬接只会拿到假数据。
 *
 * 折中方案：手机号只作为绑定标识，单号查过一次就记到本地清单；
 *   之后问「我的快递到哪了」逐个查轨迹并汇总。
 *
 * 存储：server/parcels.json（已在 .gitignore；只存单号/公司/备注，不存手机号）
 * 保留：90 天，超时自动清掉，避免清单无限增长。
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import path from "node:path";
import { ROOT } from "../config.mjs";

const FILE = path.join(ROOT, "parcels.json");
const MAX_AGE = 90 * 24 * 3600 * 1000;

let cache = null;

function normalize(number) {
  return String(number || "").replace(/[\s-]/g, "").toUpperCase();
}

function load() {
  if (cache) return cache;
  cache = { items: [] };
  if (existsSync(FILE)) {
    try {
      const j = JSON.parse(readFileSync(FILE, "utf8"));
      if (Array.isArray(j?.items)) cache.items = j.items;
    } catch {
      /* 文件坏了就当空清单，不让它拖垮对话 */
    }
  }
  const cutoff = Date.now() - MAX_AGE;
  cache.items = cache.items.filter((x) => {
    const n = normalize(x?.number);
    if (!/^[A-Za-z0-9]{6,32}$/.test(n)) return false;
    return !x.addedAt || x.addedAt >= cutoff;
  });
  return cache;
}

function save() {
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2) + "\n", "utf8");
  renameSync(tmp, FILE);
}

export function listParcels() {
  const { items } = load();
  return [...items].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
}

export function addParcel(number, carrier = "", label = "") {
  const n = normalize(number);
  if (!/^[A-Za-z0-9]{6,32}$/.test(n)) return null;
  const list = load().items;
  const hit = list.find((x) => normalize(x.number) === n);
  if (hit) {
    if (carrier) hit.carrier = carrier;
    if (label) hit.label = label;
    save();
    return hit;
  }
  const item = { number: n, carrier: String(carrier || ""), label: String(label || ""), addedAt: Date.now() };
  list.push(item);
  save();
  return item;
}

export function removeParcel(number) {
  const n = normalize(number);
  const list = load().items;
  const i = list.findIndex((x) => normalize(x.number) === n);
  if (i < 0) return false;
  list.splice(i, 1);
  save();
  return true;
}

export function clearParcels() {
  load().items = [];
  save();
}
