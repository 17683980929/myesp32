/**
 * fetch-life-guide.mjs — 把《高性价比人生指南》正文拉到 server/data/life-guide/
 *
 * 只拉 book/*.md + README.md + index.html（约 2.3MB），不进 git。
 * 重新拉取：node server/tools/fetch-life-guide.mjs
 *
 * 注意：GitHub 未鉴权 API 每小时 60 次，34 章 + 2 个文件刚好够；
 * 中途 403 就等一小时再跑一遍（已下载的文件会被覆盖，不影响）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "eternity4719/HowToLiveBetter";
const REF = "main";
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data/life-guide");

const api = async (p) => {
  const r = await fetch(`https://api.github.com/repos/${REPO}/${p}?ref=${REF}`);
  if (!r.ok) throw new Error(`API ${p}: HTTP ${r.status}`);
  return r.json();
};

async function blob(sha) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/git/blobs/${sha}`);
  if (!r.ok) throw new Error(`blob ${sha}: HTTP ${r.status}`);
  const j = await r.json();
  return Buffer.from(j.content, "base64");
}

mkdirSync(path.join(OUT, "book"), { recursive: true });

for (const name of ["README.md", "index.html"]) {
  const j = await api(`contents/${name}`);
  writeFileSync(path.join(OUT, name), await blob(j.sha));
  console.log("✓", name);
}

const book = await api("contents/book");
for (const f of book) {
  if (!f.name.endsWith(".md")) continue;
  writeFileSync(path.join(OUT, "book", f.name), await blob(f.sha));
  console.log("✓ book/" + f.name);
}

console.log("done →", OUT);
