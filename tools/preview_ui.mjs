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
import path from "node:path";

/* 本地开发：从仓库的 firmware/components/ui 读源码。
 * 云端部署：CI 把这些文件平铺到 server/data/preview/，用 PREVIEW_DATA_DIR 指过来。 */
const DATA_DIR = process.env.PREVIEW_DATA_DIR || "";
const readAsset = (rel) =>
  readFileSync(DATA_DIR ? path.join(DATA_DIR, path.basename(rel)) : rel, "utf8");

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

const f5 = readAsset("firmware/components/ui/font5x7.c");
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

const fc = readAsset("firmware/components/ui/font_cjk.c");
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

const cFrames = readAsset("firmware/components/ui/pet_frames.c");
const cHeader = readAsset("firmware/components/ui/pet_frames.h");
const LAYERED = /#define PET_LAYERED\s+1/.test(cHeader);
const frameArrays = new Map();
{
  const re = /const uint8_t (\w+)\[(\d+)\] = \{([\s\S]*?)\};/g;
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

/** 带遮罩贴图：只有 mask 位为 1 的像素才写（对应固件 lcd_blit_mask） */
function blitMask(data, mask, w, h, dx, dy) {
  const stride = Math.ceil(w / 8);
  for (let y = 0; y < h; y++) {
    if (!mask) continue;
    let any = false;
    for (let i = 0; i < stride; i++) if (mask[y * stride + i]) { any = true; break; }
    if (!any) continue;
    for (let x = 0; x < w; x++) {
      if (!((mask[y * stride + (x >> 3)] >> (7 - (x & 7))) & 1)) continue;
      px(dx + x, dy + y, (data[y * stride + (x >> 3)] >> (7 - (x & 7))) & 1);
    }
  }
}

/* ── 布局（与 ui.c draw_panel_divider / draw_panel_cells / render_panel 一致）── */

const PANEL_X = 208;
const PANEL_SEP_W = W - PANEL_X - 8;
const BOX_L = 202, BOX_R = 396;

/* ── 墙上挂钟（擦掉原图固定的指针，按真实时间重画）────────────────── */

const CLOCK_CX = 27, CLOCK_CY = 41, CLOCK_CLEAR_R = 25;

/* 60 个方向单位向量（×256）：sin/cos 表，固件里用同一张 */
const SIN60 = [], COS60 = [];
for (let i = 0; i < 60; i++) {
  SIN60.push(Math.round(256 * Math.sin((i * Math.PI) / 30)));
  COS60.push(Math.round(256 * Math.cos((i * Math.PI) / 30)));
}

/** len × v/256，四舍五入（和固件 mul256 一致） */
const mul256 = (len, v) => { const p = len * v; return p >= 0 ? Math.floor((p + 128) / 256) : -Math.floor((-p + 128) / 256); };
const proj = (len, tab, i) => mul256(len, tab[i]);

function drawWallClock(h, m) {
  disc(CLOCK_CX, CLOCK_CY, CLOCK_CLEAR_R, 0);          /* 擦掉原画的指针和刻度 */
  ring(CLOCK_CX, CLOCK_CY, 22, 1);                     /* 外圈 */
  ring(CLOCK_CX, CLOCK_CY, 21, 1);
  for (let i = 0; i < 12; i++) {                       /* 12 个刻度：贴着外圈往里伸 4px */
    const a = i * 5;
    lineSeg(CLOCK_CX + proj(16, SIN60, a), CLOCK_CY - proj(16, COS60, a),
            CLOCK_CX + proj(19, SIN60, a), CLOCK_CY - proj(19, COS60, a), 1);
  }
  const ha = ((h % 12) * 5 + Math.floor(m / 12)) % 60;
  lineSeg(CLOCK_CX, CLOCK_CY, CLOCK_CX + proj(9, SIN60, ha), CLOCK_CY - proj(9, COS60, ha), 1);
  lineSeg(CLOCK_CX, CLOCK_CY, CLOCK_CX + proj(14, SIN60, m), CLOCK_CY - proj(14, COS60, m), 1);
  px(CLOCK_CX, CLOCK_CY, 1);
}

/* ── 窗外：白天太阳 / 夜里月亮 ────────────────────────────────────── */

const SKY_CX = 191, SKY_CY = 46;
const RAY8 = [[0, -256], [181, -181], [256, 0], [181, 181], [0, 256], [-181, 181], [-256, 0], [-181, -181]];

function drawSky(day) {
  if (day) {
    ring(SKY_CX, SKY_CY, 4, 1);
    for (const [ux, uy] of RAY8) {
      lineSeg(SKY_CX + mul256(6, ux), SKY_CY + mul256(6, uy),
              SKY_CX + mul256(8, ux), SKY_CY + mul256(8, uy), 1);
    }
  } else {
    disc(SKY_CX, SKY_CY, 5, 1);                        /* 实心圆挖掉偏移的一块 → 弯月 */
    disc(SKY_CX + 3, SKY_CY - 2, 4, 0);
  }
}

function renderHome(frameSym, opts = {}) {
  fb.fill(0);
  if (LAYERED) {
    blit(frameArrays.get("pet_bg"), 200, 300, 0, 0);
    blitMask(frameArrays.get(frameSym), frameArrays.get(frameSym + "_m"), 200, 300, 0, 0);
    blitMask(frameArrays.get("pet_bg"), frameArrays.get("pet_fg"), 200, 300, 0, 0);
  } else {
    blit(frameArrays.get(frameSym), 200, 300, 0, 0);
  }

  drawWallClock(opts.h ?? 14, opts.m ?? 32);
  drawSky(opts.day ?? true);

  for (let y = 0; y < H; y++) px(BOX_L, y, 1);
  for (const y of [2, 72, 212, 298]) hline(BOX_L, y, BOX_R - BOX_L, 1);

  /* 块1 时间 */
  const tbuf = `${String(opts.h ?? 14).padStart(2, "0")}:${String(opts.m ?? 32).padStart(2, "0")}:${String(opts.s ?? 7).padStart(2, "0")}`;
  segTime(PANEL_X + Math.floor((PANEL_SEP_W - segTimeW(tbuf, 38)) / 2), 8, tbuf, 38, 1);
  /* 日期用当天真值，避免预览里出现写死的旧日期 */
  const now = new Date();
  const dt = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const dw = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][now.getDay()];
  drawText(PANEL_X, 52, dt, 2, 1);
  drawText(PANEL_X + PANEL_SEP_W - textW(dw, 2), 52, dw, 2, 1);

  /* 块2 环境 —— 数据可被 opts.env 覆盖（管理页传真实天气/电量），缺省用示例值 */
  const env = opts.env || {};
  const city = env.city || "通城";
  const cond = env.cond || "晴";
  const temp = env.temp ?? 18;
  const hum = env.hum ?? 58;
  const bat = env.bat ?? 76;
  const vx = Math.max(PANEL_X + 76, PANEL_X + 32 + cjkW(city, 1) + 6);

  iconWeather(PANEL_X, 84, 24, /雨|雪|云|阴|雾/.test(cond) ? 1 : 0, 1);
  drawCjk(PANEL_X + 32, 88, city, 1, 1);
  const ww1 = cjkW(cond, 1);
  drawCjk(vx, 88, cond, 1, 1);
  drawText(vx + ww1, 88, ` ${temp}\`C`, 2, 1);

  iconTherm(PANEL_X, 118, 22, 1);
  drawCjk(PANEL_X + 32, 120, "温度", 1, 1);
  drawText(vx, 120, "24.5`C", 2, 1);

  iconDrop(PANEL_X, 150, 22, 1);
  drawCjk(PANEL_X + 32, 152, "湿度", 1, 1);
  drawText(vx, 152, `${hum}%`, 2, 1);

  iconBattery(PANEL_X, 186, 26, bat, 1);
  drawCjk(PANEL_X + 32, 184, "电量", 1, 1);
  drawText(vx, 184, `${bat}%`, 2, 1);

  /* 块3 状态 */
  const st = opts.st || {};
  const row = (y, label, value) => {
    if (/[^\x00-\x7f]/.test(label)) drawCjk(PANEL_X + 4, y, label, 1, 1);
    else drawText(PANEL_X + 4, y + 5, label, 1, 1);
    drawCjk(PANEL_X + PANEL_SEP_W - cjkW(value, 1) - 4, y, value, 1, 1);
  };
  row(218, "WiFi", st.wifi || "已连接");
  row(238, "服务器", st.server || "已连接");
  row(258, "蓝牙", st.ble || "关闭");
  row(278, "雷达", st.radar || "有人 0.6m");
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
/* 可选参数：小时 分钟 day|night（用来预览挂钟指针和窗外日/月） */
const argH = Number(process.argv[3] ?? 14);
const argM = Number(process.argv[4] ?? 32);
const argDay = (process.argv[5] ?? "day") !== "night";
/* 可选：PREVIEW_DATA='{"env":{...},"st":{...}}' 用真实天气/电量/状态覆盖示例值（管理页用） */
let extra = {};
try { extra = JSON.parse(process.env.PREVIEW_DATA || "{}"); } catch { extra = {}; }
renderHome("pet_sm_01_idle", { h: argH, m: argM, day: argDay, env: extra.env, st: extra.st });
savePng(out);
console.log("预览已生成:", out, `${argH}:${String(argM).padStart(2, "0")}`, argDay ? "白天" : "夜晚");

/* DUMP=x0,y0,x1,y1 打印某个区域的 ASCII 图（调像素级布局用） */
if (process.env.DUMP) {
  const [dx0, dy0, dx1, dy1] = process.env.DUMP.split(",").map(Number);
  let hdr = "     ";
  for (let x = dx0; x <= dx1; x++) hdr += x % 10 === 0 ? String((x / 10) % 10) : " ";
  console.log(hdr);
  for (let y = dy0; y <= dy1; y++) {
    let row = String(y).padStart(3) + "  ";
    for (let x = dx0; x <= dx1; x++) row += fb[y * W + x] ? "#" : ".";
    console.log(row);
  }
}

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
