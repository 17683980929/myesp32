/**
 * build-law.mjs — 抓法律原文，切成 docs 技能条目
 *
 * 数据源：yibit/LawRefBook（原文来自国家法律法规数据库 flk.npc.gov.cn）
 * 通过 jsDelivr 取，国内直连 GitHub raw 基本不通。
 *
 * 用法：node server/tools/build-law.mjs
 * 产物：server/data/law/*.md
 *
 * 为什么要转换：skills.mjs 的 docs 检索按 "### " 切条目、按二元组打分。
 * 原始文件里 "###" 是「第X节」，一条会塞进几十个法条（还会被 entryChars 截断）。
 * 这里改成一条法条一个条目，标题带章节名（标题命中权重是正文的 4 倍）。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "data", "law");

const REPO = "yibit/LawRefBook@0.4.0";
const HOSTS = [
  "https://gcore.jsdelivr.net/gh/",
  "https://testingcf.jsdelivr.net/gh/",
  "https://fastly.jsdelivr.net/gh/",
];

/** 每部法律：输出文件名 → 源文件列表（民法典按编拆开，需要按顺序合并） */
const LAWS = [
  {
    out: "民法典.md",
    title: "中华人民共和国民法典",
    parts: [
      "法律法规/民法典/总则.md",
      "法律法规/民法典/物权编.md",
      "法律法规/民法典/合同编.md",
      "法律法规/民法典/人格权编.md",
      "法律法规/民法典/婚姻家庭编.md",
      "法律法规/民法典/继承编.md",
      "法律法规/民法典/侵权责任编.md",
      "法律法规/民法典/附则.md",
    ],
  },
  { out: "劳动合同法.md", title: "中华人民共和国劳动合同法", parts: ["法律法规/社会法/劳动合同法.md"] },
  { out: "劳动法.md", title: "中华人民共和国劳动法", parts: ["法律法规/社会法/劳动法.md"] },
  { out: "消费者权益保护法.md", title: "中华人民共和国消费者权益保护法", parts: ["法律法规/民法商法/消费者权益保护法.md"] },
];

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
      if (text.length < 200) throw new Error(`内容太短（${text.length}）`);
      return text;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`${rel}: ${lastErr?.message || "全部镜像都失败"}`);
}

/** 把一部法律的 Markdown 拆成 [{no, ctx, body}] */
function splitArticles(md) {
  const out = [];
  let ctx = "";
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const body = cur.body.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    if (body) out.push({ no: cur.no, ctx: cur.ctx, body });
    cur = null;
  };

  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { if (cur) cur.body.push(""); continue; }
    if (/^#{1,6}\s/.test(line)) {
      flush();
      if (!/^#\s/.test(line)) ctx = line.replace(/^#{2,6}\s+/, "").replace(/\s+/g, " ").trim();
      continue;
    }
    /* 法条开头：第X条（中文数字）。有的条款正文在同一行，有的换行 */
    const m = /^第([一二三四五六七八九十百千零〇两]{1,8})条\s*[　 ]*(.*)$/.exec(line);
    if (m) {
      flush();
      cur = { no: `第${m[1]}条`, ctx, body: m[2] ? [m[2]] : [] };
      continue;
    }
    if (cur) cur.body.push(line);
    /* 法条之外的说明文字（目录、修订说明）直接丢掉 */
  }
  flush();
  return out;
}

function render(title, entries) {
  const head = `# ${title}\n\n` +
    `共 ${entries.length} 条。每条以 "### 第X条" 开头、章节名放在正文首行，供 server/src/services/skills.mjs 检索。\n`;
  /* 章节名放正文而不是标题：标题命中是正文的 4 倍权重，
   * 放标题会让"租赁"这种词把整章（比如融资租赁合同）全顶上来。 */
  const body = entries.map((e) => {
    const tag = e.ctx ? `（${e.ctx}）\n` : "";
    return `### ${e.no}\n${tag}${e.body}`;
  }).join("\n\n");
  return head + "\n" + body + "\n";
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  let total = 0;

  for (const law of LAWS) {
    const chunks = [];
    for (const p of law.parts) chunks.push(await fetchText(p));
    const entries = splitArticles(chunks.join("\n\n"));
    if (entries.length < 3) throw new Error(`${law.out}: 只切出 ${entries.length} 条，格式可能变了`);

    const md = render(law.title, entries);
    writeFileSync(path.join(OUT_DIR, law.out), md);
    total += entries.length;
    console.log(`${law.out.padEnd(20)} ${String(entries.length).padStart(4)} 条  ${(md.length / 1024).toFixed(0)}KB`);
  }

  console.log(`\n合计 ${total} 条 → ${OUT_DIR}`);
}

main().catch((e) => {
  console.error("失败：", e.message);
  process.exit(1);
});
