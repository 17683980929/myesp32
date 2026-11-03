/**
 * preview_ui.mjs — 在 PC 上渲染主页，验证布局（不烧板也能看效果）
 *
 * 直接用固件里的点阵字体（font5x7.c / font_cjk.c）和刚生成的 pet_frames.c，
 * 按 ui.c 的坐标逐像素画一张 400×300 PNG（放大 2 倍输出）。
 *
 * 用法：node tools/preview_ui.mjs [输出文件]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const W = 400, H = 300;
const fb = new Uint8Array(W * H);          /* 1 = 墨 */

const px = (x, y, ink = 1) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  fb[y * W + x] = ink ? 1 : 0;
};
const hline = (x, y, w, ink = 1) => { for (let i = 0; i < w; i++) px(x + i, y, ink); };
const fill = (x, y, w, h, ink = 1) => { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) px(x + i, y + j, ink); };
const rect = (x, y, w, h, ink = 1) => {
  for (let i = 0; i < w; i++) { px(x + i, y, ink); px(x + i, y + h - 1, ink); }
  for (let j = 0; j < h; j++) { px(x, y + j, ink); px(x + w - 1, y + j, ink); }
};

/* ── 字体 ─────────────────────────────────────────────────────────── */

function numbersIn(text, startMarker, endMarker) {
  const a = text.indexOf(startMarker);
  const b = text.indexOf(endMarker, a);
  return (text.slice(a, b).match(/0x[0-9A-Fa-f]+/g) || []).map((h) => parseInt(h, 16));
}

const f5 = readFileSync("firmware/components/ui/font5x7.c", "utf8");
const glyphFlat = numbersIn(f5, "glyphs[][7]", "};");
const glyphs = [];
for (let i = 0; i + 6 < glyphFlat.length; i += 7) glyphs.push(glyphFlat.slice(i, i + 7));
const idxTable = numbersIn(f5, "static const uint8_t idx[95]", "};");

const glyphOf = (ch) => {
  const u = ch.charCodeAt(0);
  if (u < 0x20 || u > 0x7e) return glyphs[83];
  const i = idxTable[u - 0x20];
  return glyphs[i === 0xff ? 83 : i];
};

const fc = readFileSync("firmware/components/ui/font_cjk.c", "utf8");
const cjkFlat = numbersIn(fc, "cjk_rows[][16]", "};");
const cjkRows = [];
for (let i = 0; i + 15 < cjkFlat.length; i += 16) cjkRows.push(cjkFlat.slice(i, i + 16));
const cjkCps = numbersIn(fc, "cjk_cps[]", "};");
const cjkMap = new Map();
for (let i = 0; i < cjkCps.length; i++) cjkMap.set(cjkCps[i], cjkRows[i]);

/* ── 文本（与 ui.c 同算法）────────────────────────────────────────── */

const textW = (s, scale) => [...s].length * 6 * scale - scale;

function drawDegree(x, y, scale, ink = 1) {
  const ring = [0x2, 0x5, 0x2];
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      if (ring[r] & (0x4 >> c))
        for (let sy = 0; sy < scale; sy++)
          for (let sx = 0; sx < scale; sx++) px(x + c * scale + sx, y + r * scale + sy, ink);
}

function drawText(x, y, s, scale = 1, ink = 1) {
  for (const ch of s) {
    if (ch === "`") { drawDegree(x, y + scale, scale, ink); x += 4 * scale; continue; }
    const g = glyphOf(ch);
    for (let row = 0; row < 7; row++)
      for (let col = 0; col < 5; col++)
        if (g[row] & (0x80 >> col))
          for (let sy = 0; sy < scale; sy++)
            for (let sx = 0; sx < scale; sx++)
              px(x + col * scale + sx, y + row * scale + sy, ink);
    x += 6 * scale;
  }
}

const cjkW = (s, scale = 1) => [...s].length * 16 * scale;

function drawCjk(x, y, s, scale = 1, ink = 1) {
  for (const ch of s) {
    if (ch.charCodeAt(0) < 0x80) {
      drawText(x + Math.floor((11 * scale) / 2), y + Math.floor((9 * scale) / 2), ch, scale, ink);
      x += 16 * scale;
      continue;
    }
    const g = cjkMap.get(ch.codePointAt(0));
    if (g) {
      for (let row = 0; row < 16; row++) {
        const bits = g[row];
        if (!bits) continue;
        for (let col = 0; col < 16; col++)
          if (bits & (0x8000 >> col))
            for (let sy = 0; sy < scale; sy++)
              for (let sx = 0; sx < scale; sx++)
                px(x + col * scale + sx, y + row * scale + sy, ink);
      }
    }
    x += 16 * scale;
  }
}

/* ── 7 段数字 ─────────────────────────────────────────────────────── */

const SEG = [0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f];

function segDigit(x, y, d, h, ink = 1) {
  const t = Math.floor(h / 8) + 1;
  const w = Math.floor(h / 2) + t;
  const a = [
    [t, 0, w - 2 * t, t],
    [w - t, t, t, Math.floor(h / 2) - t],
    [w - t, Math.floor(h / 2), t, Math.floor(h / 2) - t],
    [t, h - t, w - 2 * t, t],
    [0, Math.floor(h / 2), t, Math.floor(h / 2) - t],
    [0, t, t, Math.floor(h / 2) - t],
    [t, Math.floor(h / 2) - Math.floor(t / 2), w - 2 * t, t],
  ];
  const mask = SEG[d & 0xf];
  for (let s = 0; s < 7; s++) {
    if (!(mask & (1 << s))) continue;
    fill(x + a[s][0], y + a[s][1], a[s][2], a[s][3], ink);
  }
}

function segTime(x, y, str, h, ink = 1) {
  const t = Math.floor(h / 8) + 1;
  const w = Math.floor(h / 2) + t;
  const gap = Math.floor(h / 10) + 1;
  for (const ch of str) {
    if (ch === ":") {
      fill(x, y + Math.floor(h / 4), t, t, ink);
      fill(x, y + Math.floor((3 * h) / 4) - t, t, t, ink);
      x += t + gap;
    } else if (ch >= "0" && ch <= "9") {
      segDigit(x, y, +ch, h, ink);
      x += w + gap;
    }
  }
}

function segTimeW(str, h) {
  const t = Math.floor(h / 8) + 1;
  const w = Math.floor(h / 2) + t;
  const gap = Math.floor(h / 10) + 1;
  let total = 0;
  for (const ch of str) {
    if (ch === ":") total += t + gap;
    else if (ch >= "0" && ch <= "9") total += w + gap;
  }
  return total > 0 ? total - gap : 0;
}

/* ── 图标（与 ui.c 一致）──────────────────────────────────────────── */

const isqrt = (v) => { let r = 0; while ((r + 1) * (r + 1) <= v) r++; return r; };

function disc(cx, cy, r, ink = 1) {
  for (let dy = -r; dy <= r; dy++) {
    let dx = 0;
    while ((dx + 1) * (dx + 1) + dy * dy <= r * r + r) dx++;
    hline(cx - dx, cy + dy, dx * 2 + 1, ink);
  }
}

function ring(cx, cy, r, ink = 1) {
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 <= r * r && d2 > (r - 1) * (r - 1)) px(cx + dx, cy + dy, ink);
    }
}

function lineSeg(x0, y0, x1, y1, ink = 1) {
  let dx = x1 > x0 ? x1 - x0 : x0 - x1, sx = x0 < x1 ? 1 : -1;
  let dy = y1 > y0 ? y0 - y1 : y1 - y0, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    px(x0, y0, ink);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

function iconTherm(x, y, s, ink = 1) {
  const r = Math.floor(s / 5);
  const cx = x + Math.floor((s * 2) / 5);
  const cy = y + s - r - 1;
  fill(cx - r + 1, y + r, 2, cy - y - r + 1, ink);
  fill(cx + r - 2, y + r, 2, cy - y - r + 1, ink);
  hline(cx - r + 1, y + r, r * 2 - 1, ink);
  fill(cx - 1, y + Math.floor(s / 2), 3, cy - (y + Math.floor(s / 2)) + 1, ink);
  disc(cx, cy, r, ink);
  for (let i = 0; i < 3; i++) hline(cx + r + 2, y + r + i * Math.floor(s / 5), Math.floor(s / 4), ink);
}

function iconDrop(x, y, s, ink = 1) {
  const cx = x + Math.floor(s / 2);
  const r = Math.floor((s * 3) / 10);
  const cy = y + s - r;
  const hTop = cy - y;
  for (let j = 0; j < s; j++) {
    const yy = y + j;
    let half;
    if (j < hTop) half = hTop > 0 ? Math.floor((r * j * j) / (hTop * hTop)) : r;
    else {
      const dy = yy - cy;
      const v = r * r - dy * dy;
      half = v > 0 ? isqrt(v) : 0;
    }
    if (half < 1) half = 1;
    hline(cx - half, yy, half * 2 + 1, ink);
  }
  fill(cx - Math.floor(r / 2) - 1, y + Math.floor((s * 2) / 3), 2, 3, 0);
}

function iconBattery(x, y, s, pct, ink = 1) {
  const bw = s, bh = Math.floor(s / 2);
  rect(x, y, bw, bh, ink);
  fill(x + bw, y + Math.floor(bh / 4), Math.floor(s / 8), Math.floor(bh / 2), ink);
  const inner = Math.floor(((bw - 4) * pct) / 100);
  if (inner > 0) fill(x + 2, y + 2, inner, bh - 4, ink);
}

function iconWeather(x, y, s, kind, ink = 1) {
  if (kind === 0) {
    const cx = x + Math.floor(s / 2), cy = y + Math.floor(s / 2), r = Math.floor(s / 4);
    const DIR = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
    ring(cx, cy, r, ink);
    for (const [dx, dy] of DIR)
      lineSeg(cx + dx * (r + 2), cy + dy * (r + 2), cx + dx * (r + 4), cy + dy * (r + 4), ink);
    return;
  }
  const r1 = Math.floor(s / 5), r2 = Math.floor(s / 4);
  const by = y + Math.floor((s * 3) / 5);
  disc(x + Math.floor((s * 3) / 10), by, r1, ink);
  disc(x + Math.floor((s * 11) / 20), y + Math.floor(s / 2), r2, ink);
  disc(x + Math.floor((s * 4) / 5), by, r1 - 1, ink);
  fill(x + Math.floor(s / 5), by, Math.floor((s * 3) / 5), r1, ink);
  if (kind === 3) {
    for (let i = 0; i < 3; i++) {
      const bx = x + Math.floor(s / 3) + i * Math.floor(s / 5);
      lineSeg(bx, y + Math.floor((s * 4) / 5), bx + 2, y + Math.floor((s * 4) / 5) + Math.floor(s / 5), ink);
    }
  }
}

/* ── 桌宠帧 ───────────────────────────────────────────────────────── */

const cFrames = readFileSync("firmware/components/ui/pet_frames.c", "utf8");
const frameArrays = new Map();
{
  const re = /const uint8_t (pet_sm_\w+)\[(\d+)\] = \{([\s\S]*?)\};/g;
  let m;
  while ((m = re.exec(cFrames))) {
    frameArrays.set(m[1], Buffer.from((m[3].match(/0x[0-9a-f]{2}/g) || []).map((h) => parseInt(h, 16))));
  }
}

function blit(data, w, h, dx, dy) {
  const stride = Math.ceil(w / 8);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      px(dx + x, dy + y, (data[y * stride + (x >> 3)] >> (7 - (x & 7))) & 1);
}

/* ── 布局（与 ui.c draw_panel_divider / draw_panel_cells / render_panel 一致）── */

const PANEL_X = 208;
const PANEL_SEP_W = W - PANEL_X - 8;
const BOX_L = 202, BOX_R = 396;

function renderHome(frameSym) {
  fb.fill(0);
  blit(frameArrays.get(frameSym), 200, 300, 0, 0);

  for (let y = 0; y < H; y++) px(BOX_L, y, 1);
  for (const y of [2, 72, 212, 298]) hline(BOX_L, y, BOX_R - BOX_L, 1);

  /* 块1 时间 */
  const tbuf = "14:32:07";
  segTime(PANEL_X + Math.floor((PANEL_SEP_W - segTimeW(tbuf, 38)) / 2), 8, tbuf, 38, 1);
  drawText(PANEL_X, 52, "2026-11-03", 2, 1);
  drawText(PANEL_X + PANEL_SEP_W - textW("TUE", 2), 52, "TUE", 2, 1);

  const vx = PANEL_X + 76;
  /* 块2 环境 */
  iconWeather(PANEL_X, 84, 24, 0, 1);
  drawCjk(PANEL_X + 32, 88, "通城", 1, 1);
  const ww1 = cjkW("晴", 1);
  drawCjk(vx, 88, "晴", 1, 1);
  drawText(vx + ww1, 88, " 18`C", 2, 1);

  iconTherm(PANEL_X, 118, 22, 1);
  drawCjk(PANEL_X + 32, 120, "温度", 1, 1);
  drawText(vx, 120, "24.5`C", 2, 1);

  iconDrop(PANEL_X, 150, 22, 1);
  drawCjk(PANEL_X + 32, 152, "湿度", 1, 1);
  drawText(vx, 152, "58%", 2, 1);

  iconBattery(PANEL_X, 186, 26, 76, 1);
  drawCjk(PANEL_X + 32, 184, "电量", 1, 1);
  drawText(vx, 184, "76%", 2, 1);

  /* 块3 状态 */
  const row = (y, label, value) => {
    if (/[^ -]/.test(label)) drawCjk(PANEL_X + 4, y, label, 1, 1);
    else drawText(PANEL_X + 4, y + 5, label, 1, 1);
    drawCjk(PANEL_X + PANEL_SEP_W - cjkW(value, 1) - 4, y, value, 1, 1);
  };
  row(218, "WiFi", "已连接");
  row(238, "服务器", "已连接");
  row(258, "蓝牙", "关闭");
  row(278, "雷达", "有人 0.6m");
}

/* ── PNG 输出（2 倍放大，纯黑白）──────────────────────────────────── */

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (b) => { let c = 0xffffffff; for (const v of b) c = CRC[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

function savePng(file, scale = 2) {
  const w = W * scale, h = H * scale;
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0;
    for (let x = 0; x < w; x++)
      raw[y * (w + 1) + 1 + x] = fb[Math.floor(y / scale) * W + Math.floor(x / scale)] ? 0 : 255;
  }
  const chunk = (type, data) => {
    const b = Buffer.alloc(12 + data.length);
    b.writeUInt32BE(data.length, 0);
    b.write(type, 4, "ascii");
    data.copy(b, 8);
    b.writeUInt32BE(crc32(b.subarray(4, 8 + data.length)), 8 + data.length);
    return b;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 0;
  writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]));
}

const out = process.argv[2] || "assets/ui_preview.png";
renderHome("pet_sm_01_idle");
savePng(out);
console.log("预览已生成:", out);

/* ── 几何自检：压线 / 出界 ────────────────────────────────────────── */

{
  const lines = [2, 72, 212, 298];
  const problems = [];

  /* 只看横线所在行之外的行，检查内容是否贴到/跨过边线 */
  for (const ly of lines) {
    for (const dy of [-1, 1]) {
      const y = ly + dy;
      if (y < 0 || y >= H) continue;
      let n = 0;
      for (let x = BOX_L + 1; x < BOX_R; x++) if (fb[y * W + x]) n++;
      if (n > 0) problems.push(`横线 y=${ly} 的 ${dy > 0 ? "下" : "上"}方一行有 ${n} 个墨点（内容贴线）`);
    }
  }

  /* 右栏内容是否越过右边线 */
  let maxX = 0;
  for (let y = 0; y < H; y++)
    for (let x = BOX_R + 1; x < W; x++) if (fb[y * W + x]) { maxX = Math.max(maxX, x); }
  if (maxX) problems.push(`右边线右侧（x>${BOX_R}）有墨点，最远 x=${maxX}`);

  /* 桌宠区是否越过竖线 */
  let petMaxX = 0;
  for (let y = 0; y < H; y++)
    for (let x = 200; x < BOX_L; x++) if (fb[y * W + x]) petMaxX = Math.max(petMaxX, x);
  if (petMaxX >= 200) problems.push(`桌宠区越过 x=199，最远 x=${petMaxX}`);

  /* 每块内容的纵向范围（用于核对留白） */
  const blocks = [[3, 71], [73, 211], [213, 297]];
  blocks.forEach(([y0, y1], i) => {
    let top = -1, bot = -1;
    for (let y = y0; y <= y1; y++) {
      let n = 0;
      for (let x = BOX_L + 1; x < BOX_R; x++) if (fb[y * W + x]) n++;
      if (n) { if (top < 0) top = y; bot = y; }
    }
    console.log(`块${i + 1} y=${y0}..${y1}：内容 ${top}..${bot}，上留白 ${top - y0}，下留白 ${y1 - bot}`);
  });

  console.log(problems.length ? "\n⚠ 几何问题：\n - " + problems.join("\n - ") : "\n✅ 几何自检通过（无压线/出界）");
}
