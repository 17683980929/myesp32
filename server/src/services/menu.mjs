/**
 * services/menu.mjs — 「今天吃什么」（内置技能 handler）
 *
 * 菜谱语料就在 data/recipes，不需要联网：
 * 随机挑几道，尽量荤素汤主食各来一个，而不是三道全是肉。
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "../config.mjs";

const DIR = path.join(ROOT, "data", "recipes");
const TTL = 10 * 60 * 1000;

/* 配餐时优先从这几类里挑，甜品/饮品/调料不参与"正餐" */
const MEAL_CATEGORIES = ["荤菜", "素菜", "汤羹", "主食", "水产"];
const ALL_CATEGORIES = [...MEAL_CATEGORIES, "早餐", "甜品", "饮品", "半成品", "调料"];

let cache = { at: 0, items: [] };

function loadDishes() {
  if (Date.now() - cache.at < TTL && cache.items.length) return cache.items;
  const items = [];
  try {
    for (const f of readdirSync(DIR).filter((x) => x.endsWith(".md"))) {
      const text = readFileSync(path.join(DIR, f), "utf8");
      for (const part of text.split(/^### /m).slice(1)) {
        const nl = part.indexOf("\n");
        const title = (nl < 0 ? part : part.slice(0, nl)).trim();
        const body = nl < 0 ? "" : part.slice(nl + 1);
        const cat = (body.match(/^分类：(.+)$/m) || [])[1]?.trim() || f.replace(/\.md$/, "");
        /* 标题里的别名去掉，只留主名："宫保鸡丁（宫爆鸡丁）" → 宫保鸡丁 */
        const name = title.replace(/（.*?）/g, "").trim();
        if (name && cat) items.push({ name, cat });
      }
    }
  } catch {
    /* 语料没生成时返回空，handler 会给出提示 */
  }
  cache = { at: Date.now(), items };
  return items;
}

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export async function menuAnswer(args = {}) {
  const all = loadDishes();
  if (!all.length) return "菜谱还没生成：先跑 node server/tools/build-recipe.mjs。";

  const want = Math.min(6, Math.max(1, Number(args.count) || 3));
  const catArg = String(args.category || "").trim();
  const cat = ALL_CATEGORIES.includes(catArg) ? catArg : "";

  let pool = cat ? all.filter((x) => x.cat === cat) : all.filter((x) => MEAL_CATEGORIES.includes(x.cat));
  if (!pool.length) pool = all;

  const picked = [];
  const used = new Set();

  if (!cat) {
    /* 先保证一荤一素，再从汤/主食/水产里补——不要出现"三道全是肉"或"没有青菜" */
    const first = shuffle(["荤菜", "水产"])[0];
    const order = [...new Set([first, "素菜", ...shuffle(["汤羹", "主食", "水产", "荤菜"])])];
    for (const c of order) {
      if (picked.length >= want) break;
      const one = shuffle(pool.filter((x) => x.cat === c && !used.has(x.name)))[0];
      if (one) {
        picked.push(one);
        used.add(one.name);
      }
    }
  }
  for (const one of shuffle(pool)) {
    if (picked.length >= want) break;
    if (!used.has(one.name)) {
      picked.push(one);
      used.add(one.name);
    }
  }

  const body = picked.map((x) => `${x.name}（${x.cat}）`).join("、");
  return `今天可以吃：${body}。\n（随机配的，想换一道就说「换一个」。）`;
}
