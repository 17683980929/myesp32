/**
 * build-recipe.mjs — 抓家常菜谱，切成 docs 技能条目
 *
 * 数据源：Anduin2017/HowToCook（程序员做饭指南，Unlicense 公有领域）
 * 通过 jsDelivr 取（GitHub raw 在国内服务器上常不通）。
 *
 * 用法：node server/tools/build-recipe.mjs
 * 产物：server/data/recipes/<分类>.md
 *
 * 为什么要转换：skills.mjs 按 "### " 切条目、按二元组打分，
 * 而原文件是 "## 必备原料 / ## 计算 / ## 操作" 的多级结构，
 * 还有 "### 简易版本" 这种子标题——直接拼进去会把一道菜切成好几条。
 * 这里按菜重排成「原料 / 用量 / 做法」，子标题压成【】标记。
 */

import { mkdirSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "data", "recipes");

const REPO = "Anduin2017/HowToCook@1.6.0";
const HOSTS = [
  "https://gcore.jsdelivr.net/gh/",
  "https://testingcf.jsdelivr.net/gh/",
  "https://fastly.jsdelivr.net/gh/",
];
const API = `https://data.jsdelivr.com/v1/packages/gh/${REPO}?structure=flat`;

const CATEGORY_CN = {
  aquatic: "水产",
  breakfast: "早餐",
  condiment: "调料",
  dessert: "甜品",
  drink: "饮品",
  meat_dish: "荤菜",
  "semi-finished": "半成品",
  soup: "汤羹",
  staple: "主食",
  vegetable_dish: "素菜",
  template: "模板",
};

/* 常见叫法 → 菜名里的写法。只在标题/别名里补，不改正文。
 * 用户说"番茄炒蛋"时，标题是"西红柿炒鸡蛋"，二元组完全对不上。
 * oneWay：反向替换会造出"鸡鸡蛋"这种假词，只做单向。 */
const ALIAS = [
  { a: "西红柿", b: "番茄" },
  { a: "土豆", b: "马铃薯" },
  { a: "花菜", b: "菜花" },
  { a: "包菜", b: "卷心菜" },
  { a: "红薯", b: "地瓜" },
  { a: "桂鱼", b: "鳜鱼" },
  { a: "四季豆", b: "豆角" },
  { a: "青椒", b: "柿子椒" },
  { a: "鸡蛋", b: "蛋", oneWay: true },
  { a: "宫保鸡丁", b: "宫爆鸡丁", oneWay: true },
];

const BOILERPLATE = /如果您遵循本指南|请提出\s*Issue|Pull request|本指南.*改进|欢迎.*贡献/i;
const LIMIT = 1350;                 /* 单条正文上限，留余量给 entryChars=1400 */
const STEP_MAX = 220;

async function fetchText(rel) {
  let lastErr;
  for (const h of HOSTS) {
    const url = h + REPO + "/" + rel.split("/").map(encodeURIComponent).join("/");
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 20000);
      const res = await fetch(url, { signal: ac.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.length < 100) throw new Error(`内容太短（${text.length}）`);
      return text;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`${rel}: ${lastErr?.message || "全部镜像都失败"}`);
}

function cleanInline(s) {
  return String(s)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 拆成 { name, intro, sections:[{title, lines}] }，把 ### 子标题压成【】 */
function splitSections(md) {
  const out = { name: "", intro: [], sections: [] };
  let cur = null;
  for (const raw of md.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim();
    if (/^#\s+/.test(line)) {
      out.name = line.replace(/^#\s+/, "").replace(/的做法$/, "").trim();
      continue;
    }
    if (/^##\s+/.test(line)) {
      cur = { title: line.replace(/^##\s+/, "").trim(), lines: [] };
      out.sections.push(cur);
      continue;
    }
    if (/^###+\s+/.test(line)) {
      if (cur) cur.lines.push(`【${line.replace(/^###+\s+/, "").trim()}】`);
      continue;
    }
    if (cur) cur.lines.push(line);
    else out.intro.push(line);
  }
  return out;
}

function sectionItems(sec, { keepLabels = false } = {}) {
  if (!sec) return [];
  const out = [];
  for (const raw of sec.lines) {
    const line = cleanInline(raw);
    if (!line) continue;
    if (BOILERPLATE.test(line)) continue;
    if (/^预估烹饪难度/.test(line)) continue;
    if (/^-{3,}$/.test(line)) continue;
    /* 先去掉列表符号，再判断是不是分组小标题 —— 否则 "- 必须配料" 会被当成原料 */
    const bare = line.replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, "");
    if (/^【.*】$/.test(bare)) {
      if (keepLabels) out.push(bare);
      continue;
    }
    if (/^(必须|进阶|可选|主料|辅料|调料|配料|其他)(配料|原料|材料)?$/.test(bare)) continue;
    out.push(bare);
  }
  return out;
}

/** 操作段常按「简易版本 / 复杂版本」分组。只取第一个够用的组，
 *  否则两个版本的做法会串成一条 16 步的流水账，还会被 entryChars 截断。 */
function pickSteps(sec) {
  const all = sectionItems(sec, { keepLabels: true });
  const groups = [];
  let cur = { label: "", items: [] };
  for (const line of all) {
    const m = /^【(.+)】$/.exec(line);
    if (m) {
      if (cur.items.length >= 2) groups.push(cur);
      cur = { label: m[1], items: [] };
    } else {
      cur.items.push(line);
    }
  }
  if (cur.items.length >= 2) groups.push(cur);
  if (!groups.length) return { steps: all.filter((x) => !/^【.*】$/.test(x)), note: "" };

  const first = groups[0];
  const note = groups.length > 1 ? `（另有做法：${groups.slice(1).map((g) => g.label).filter(Boolean).join("、")}）` : "";
  return { steps: first.items, note };
}

const cap = (s, n) => (s.length > n ? s.slice(0, n).replace(/[，、；\s]+$/, "") + "…" : s);

function aliasesFor(name) {
  const set = new Set();
  for (const { a, b, oneWay } of ALIAS) {
    if (name.includes(a)) set.add(name.split(a).join(b));
    if (!oneWay && name.includes(b)) set.add(name.split(b).join(a));
  }
  set.delete(name);
  return [...set].filter((x) => x.length >= 2).slice(0, 2);
}

function convert(md, category) {
  const doc = splitSections(md);
  if (!doc.name) throw new Error("找不到菜名（首行不是 # 标题）");

  const get = (kw) => doc.sections.find((s) => s.title.includes(kw));
  const ing = sectionItems(get("必备原料"));
  const calc = sectionItems(get("计算"));
  const { steps: rawSteps, note: stepNote } = pickSteps(get("操作"));
  const extra = sectionItems(get("附加内容"));
  const diff = (md.match(/预估烹饪难度[：:]\s*(★+)/) || [])[1] || "";

  if (!ing.length || !rawSteps.length) throw new Error(`原料或做法为空（原料 ${ing.length} / 步骤 ${rawSteps.length}）`);

  const steps = rawSteps.map((s) => cap(s, STEP_MAX));

  const alias = aliasesFor(doc.name);
  const lines = [];
  lines.push(`分类：${CATEGORY_CN[category] || category}`);
  if (diff) lines.push(`难度：${diff}`);
  if (alias.length) lines.push(`别名：${alias.join("、")}`);
  lines.push(`原料：${ing.join("、")}`);
  if (calc.length) lines.push(`用量：${cap(calc.join("；"), 460)}`);
  lines.push(`做法${stepNote}：`);
  steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  if (extra.length) lines.push(`备注：${cap(extra.join("；"), 220)}`);

  let body = lines.join("\n");
  if (body.length > LIMIT) {
    /* 先丢备注，再收用量，最后才动步骤（步骤是菜谱的骨架） */
    const noExtra = lines.filter((l) => !l.startsWith("备注："));
    body = noExtra.join("\n");
  }
  if (body.length > LIMIT) body = body.slice(0, LIMIT) + "…";

  return { name: doc.name, alias, body };
}

async function main() {
  const r = await fetch(API);
  if (!r.ok) throw new Error(`文件列表 HTTP ${r.status}`);
  const j = await r.json();
  const files = (j.files || []).map((f) => f.name)
    .filter((f) => /^\/dishes\/[^/]+\/[^/]+\/[^/]+\.md$/.test(f))
    .filter((f) => !f.includes("/template/"));

  console.log(`发现 ${files.length} 个菜谱文件`);

  const byName = new Map();   /* 同名菜（红烧肉/米饭在多个分类下重复）只留正文最全的一份 */
  for (const f of files) {
    const parts = f.split("/");
    const category = parts[2];
    try {
      const md = await fetchText(f.replace(/^\//, ""));
      const one = convert(md, category);
      const key = one.name;
      const prev = byName.get(key);
      const item = { ...one, category, body: one.body };
      if (!prev || item.body.length > prev.body.length) byName.set(key, item);
    } catch (e) {
      console.warn(`跳过 ${f}: ${e.message}`);
    }
  }

  mkdirSync(OUT_DIR, { recursive: true });
  /* 清掉上一次的产物：分类文件改名（英文→中文）后，旧文件会和新文件同时被扫到 */
  for (const f of readdirSync(OUT_DIR).filter((x) => x.endsWith(".md"))) {
    unlinkSync(path.join(OUT_DIR, f));
  }

  const groups = new Map();
  for (const item of byName.values()) {
    if (!groups.has(item.category)) groups.set(item.category, []);
    groups.get(item.category).push(item);
  }

  let total = 0;
  for (const [cat, items] of [...groups.entries()].sort()) {
    items.sort((a, b) => a.name.localeCompare(b.name, "zh"));
    const head = `# 家常菜谱 · ${CATEGORY_CN[cat] || cat}\n\n` +
      `来源：Anduin2017/HowToCook（Unlicense 公有领域）。每条以 "### 菜名" 开头，供 skills.mjs 检索。\n\n`;
    const body = items.map((it) => {
      const title = it.alias.length ? `${it.name}（${it.alias.join("/")}）` : it.name;
      return `### ${title}\n${it.body}`;
    }).join("\n\n");
    const file = path.join(OUT_DIR, `${CATEGORY_CN[cat] || cat}.md`);
    writeFileSync(file, head + body + "\n");
    total += items.length;
    console.log(`${(CATEGORY_CN[cat] || cat).padEnd(6)} ${String(items.length).padStart(3)} 道  ${(body.length / 1024).toFixed(0)}KB`);
  }

  console.log(`\n合计 ${total} 道菜 → ${OUT_DIR}`);
}

main().catch((e) => {
  console.error("失败：", e.message);
  process.exit(1);
});
