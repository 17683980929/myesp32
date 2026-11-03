/**
 * gen_pet_frames.mjs — 把桌宠素材转成固件用的 200×300 1bpp C 数组
 *
 * 两种素材模式，自动判断：
 *
 * ① 分层模式（推荐，素材到位后自动启用）
 *    目录：assets/pet_layers/
 *      bg.png              200×300 背景板（黑=墨；不带 alpha 也行）
 *      01_idle.png …       200×300 RGBA，alpha>0 的像素算角色，其余透出背景
 *    产物：pet_bg[] + 每帧 pet_sm_XX[]（角色墨点）+ pet_sm_XX_m[]（角色遮罩）
 *    固件：PET_LAYERED=1 → 先画背景板，再按遮罩贴角色，角色可以单独上下位移
 *
 * ② 整帧模式（当前素材就是这样）
 *    目录：assets/pet_v2/xiaozhi_police_pet_with_bg/300x400_阈值
 *      01_idle.png …       300×400 1-bit 黑白整帧（连背景一起画）
 *    产物：只有 pet_sm_XX[]，PET_LAYERED=0，固件整屏直贴，背景不能单独静止
 *
 * 用法：node tools/gen_pet_frames.mjs [素材目录] [输出目录]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { inflateSync, deflateSync } from "node:zlib";
import path from "node:path";

const LAYER_DIR = process.env.PET_LAYERS || "assets/pet_layers";
const SRC_DIR = process.argv[2] || "assets/pet_v2/xiaozhi_police_pet_with_bg/300x400_阈值";
const OUT_DIR = process.argv[3] || "firmware/components/ui";

const OUT_W = 200;
const OUT_H = 300;
const STRIDE = OUT_W / 8;
const FRAME_BYTES = STRIDE * OUT_H;

/* 覆盖率阈值：0.38 是拿 3 帧对比调出来的——0.5 会让墙上的窗框细线断掉，
 * 0.25 又会让制服阴影糊成一片 */
const COVER_T = 0.38;

/* 分层模式的版面修正（按 200×300 输出坐标系）：
 *  - CHAR_DY：整体纵向偏移。原画人物就站在桌子后面（桌面在腰胯高度），保持 0；
 *  - FG_RECTS：桌子在人物**前面**的部分。合成顺序 背景 → 角色 → 前景，
 *    这样人物被桌面厚板和左右前板挡住，只在中间开口（x 58..142）露出来，
 *    站姿/坐姿/胸像的裁断处都被桌子收掉，不会出现"浮在桌子上"。 */
const CHAR_DY = 10;   /* 下移 10px：脚(254→264)正好藏到底板后面，桌洞中间能看到身体 */

/* 逐帧纵向微调（在 CHAR_DY 基础上再加减）：
 * 全身帧统一 +0（脚正好落在地面线 268）；胸像/近景帧头画得更低，
 * 会被桌面厚板切在脸上，需要抬起来，让桌面切在胸口以下。 */
const FRAME_DY = {};   /* 各帧素材本身对齐，先不再单独偏移 */
const FG_RECTS = [
  [8, 194, 192, 208],    /* 桌面厚板 */
  [8, 208, 58, 270],     /* 左前板 */
  [142, 208, 192, 270],  /* 右前板 */
  [8, 264, 192, 272],    /* 底板（挡住脚和胸像的裁断处） */
];

/* ── PNG 解码（非隔行；1/8bit 灰度、8bit RGB/RGBA、调色板）────────── */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** 读 PNG，返回 {w,h,isInk(x,y),alphaAt(x,y)} */
function readPng(file) {
  const buf = readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file}: 不是 PNG`);
  let off = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0;
  const idat = [];
  let palette = null;

  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; ctype = data[9]; interlace = data[12];
    } else if (type === "PLTE") palette = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (interlace) throw new Error(`${file}: 不支持隔行 PNG`);

  const raw = inflateSync(Buffer.concat(idat));
  const channels = ctype === 0 ? 1 : ctype === 2 ? 3 : ctype === 3 ? 1 : ctype === 4 ? 2 : 4;
  const bitsPP = channels * depth;
  const rowBytes = Math.ceil((w * bitsPP) / 8);
  const bpp = Math.max(1, Math.floor(bitsPP / 8));

  const out = Buffer.alloc(rowBytes * h);
  let prev = Buffer.alloc(rowBytes);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (rowBytes + 1)];
    const line = raw.subarray(y * (rowBytes + 1) + 1, (y + 1) * (rowBytes + 1));
    const cur = Buffer.alloc(rowBytes);
    for (let i = 0; i < rowBytes; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) v += paeth(a, b, c);
      cur[i] = v & 0xff;
    }
    cur.copy(out, y * rowBytes);
    prev = cur;
  }

  const isInk = (x, y) => {
    const rowBase = y * rowBytes;
    if (depth === 1) {
      const bit = (out[rowBase + (x >> 3)] >> (7 - (x & 7))) & 1;
      if (ctype === 0) return bit === 0;              /* 灰度：0=黑 */
      const p = palette ? palette[bit * 3] : 0;
      return p < 128;
    }
    if (depth === 8) {
      if (ctype === 0) return out[rowBase + x] < 128;
      if (ctype === 3) return palette[out[rowBase + x] * 3] < 128;
      if (ctype === 4) return out[rowBase + x * 2] < 128;
      const i = rowBase + x * channels;
      const lum = 0.299 * out[i] + 0.587 * out[i + 1] + 0.114 * out[i + 2];
      return lum < 128;
    }
    throw new Error(`不支持的位深 ${depth}`);
  };

  const alphaAt = (x, y) => {
    if (ctype !== 4 && ctype !== 6) return 255;
    const i = y * rowBytes + x * channels;
    return out[i + channels - 1];
  };

  return { w, h, isInk, alphaAt };
}

/* ── 打包 ─────────────────────────────────────────────────────────── */

function packBits(w, h, pred) {
  const stride = Math.ceil(w / 8);          /* 注意必须取整：200/8=25，写成 (w+7)/8 会得到 25.875 */
  const bm = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (pred(x, y)) bm[y * stride + (x >> 3)] |= 0x80 >> (x & 7);
  return bm;
}

/** 面积覆盖率下采样（整帧模式用，保住 1px 细线） */
function downsample(src, ow, oh, thr) {
  const frame = new Uint8Array(STRIDE * oh);
  const sx = src.w / ow, sy = src.h / oh;

  for (let dy = 0; dy < oh; dy++) {
    const y0 = dy * sy, y1 = y0 + sy;
    for (let dx = 0; dx < ow; dx++) {
      const x0 = dx * sx, x1 = x0 + sx;
      let ink = 0, area = 0;
      for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
        const wy = Math.min(y1, y + 1) - Math.max(y0, y);
        if (wy <= 0) continue;
        for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
          const wx = Math.min(x1, x + 1) - Math.max(x0, x);
          if (wx <= 0) continue;
          area += wx * wy;
          if (src.isInk(x, y)) ink += wx * wy;
        }
      }
      if (area > 0 && ink / area >= thr) {
        frame[dy * STRIDE + (dx >> 3)] |= 0x80 >> (dx & 7);
      }
    }
  }
  return frame;
}

/** 整幅纵向平移 n 像素（正=下移，负=上移；移出画面的部分丢掉） */
function shiftDown(bm, n) {
  if (!n) return bm;
  const out = new Uint8Array(bm.length);
  if (n > 0) {
    for (let y = 0; y + n < OUT_H; y++)
      out.set(bm.subarray(y * STRIDE, (y + 1) * STRIDE), (y + n) * STRIDE);
  } else {
    const k = -n;
    for (let y = k; y < OUT_H; y++)
      out.set(bm.subarray(y * STRIDE, (y + 1) * STRIDE), (y - k) * STRIDE);
  }
  return out;
}

/** 带 alpha 的缩放：返回 {char, mask}
 *  mask = alpha 覆盖率 ≥ 0.5；char = 不透明区域内墨点覆盖率 ≥ COVER_T */
function downsampleLayers(src, ow, oh, thr) {
  const char = new Uint8Array(STRIDE * oh);
  const mask = new Uint8Array(STRIDE * oh);
  const sx = src.w / ow, sy = src.h / oh;

  for (let dy = 0; dy < oh; dy++) {
    const y0 = dy * sy, y1 = y0 + sy;
    for (let dx = 0; dx < ow; dx++) {
      const x0 = dx * sx, x1 = x0 + sx;
      let area = 0, aSum = 0, inkSum = 0;
      for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
        const wy = Math.min(y1, y + 1) - Math.max(y0, y);
        if (wy <= 0) continue;
        for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
          const wx = Math.min(x1, x + 1) - Math.max(x0, x);
          if (wx <= 0) continue;
          const w = wx * wy;
          area += w;
          const a = src.alphaAt(x, y);
          aSum += (a / 255) * w;
          if (a >= 128 && src.isInk(x, y)) inkSum += w;
        }
      }
      if (area <= 0) continue;
      if (aSum / area >= 0.5) mask[dy * STRIDE + (dx >> 3)] |= 0x80 >> (dx & 7);
      if (inkSum / area >= thr) char[dy * STRIDE + (dx >> 3)] |= 0x80 >> (dx & 7);
    }
  }
  return { char, mask };
}

/* ── PNG 编码（预览用，灰度 8bit）────────────────────────────────── */

function writePngGray(file, w, h, get) {
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0;
    for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = get(x, y);
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
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]));
}

/* ── 帧清单：文件名前缀 → C 符号 ─────────────────────────────────── */

const FRAMES = [
  ["01_idle", "pet_sm_01_idle"],
  ["02_idle_blink", "pet_sm_02_idle_blink"],
  ["03_listening", "pet_sm_03_listening"],
  ["04_thinking", "pet_sm_04_thinking"],
  ["05_speaking", "pet_sm_05_speaking"],
  ["06_happy", "pet_sm_06_happy"],
  ["07_love", "pet_sm_07_love"],
  ["08_confused", "pet_sm_08_confused"],
  ["09_sleepy", "pet_sm_09_sleepy"],
  ["10_sleeping", "pet_sm_10_sleeping"],
  ["11_salute", "pet_sm_11_salute"],
  ["12_direct", "pet_sm_12_direct"],
  ["13_patrol", "pet_sm_13_patrol"],
  ["14_note", "pet_sm_14_note"],
  ["15_charging", "pet_sm_15_charging"],
  ["16_drinking", "pet_sm_16_water"],     /* 喝水帧：沿用旧符号名，ui.c 不用改 */
];

/* ── 主流程 ───────────────────────────────────────────────────────── */

/* 分层模式要显式开启：`assets/pet_layers/ENABLE` 存在才用。
 * 否则一律走整帧模式（人物和背景是一张图，背景不能单独动，但也不会穿帮）。 */
const layered = existsSync(path.join(LAYER_DIR, "bg.png")) &&
                existsSync(path.join(LAYER_DIR, "ENABLE"));
const previewDir = "assets/pet_frames_preview";
const wantPreview = OUT_DIR.includes("firmware");   /* 测试输出到临时目录时不覆盖正式预览 */
mkdirSync(path.resolve(previewDir), { recursive: true });

function emitArray(sym, bm, note = "") {
  let ones = 0;
  for (const b of bm) ones += [0, 1, 2, 3, 4, 5, 6, 7].filter((k) => (b >> k) & 1).length;
  let s = `/* ${note}${note ? " — " : ""}${ones}/${OUT_W * OUT_H} 墨点 (${((ones / (OUT_W * OUT_H)) * 100).toFixed(1)}%) */\n`;
  s += `const uint8_t ${sym}[${bm.length}] = {\n`;
  for (let i = 0; i < bm.length; i += 16) {
    s += "    " + Array.from(bm.subarray(i, i + 16), (b) => "0x" + b.toString(16).padStart(2, "0")).join(",") + ",\n";
  }
  return s + "};\n\n";
}

let cBody = "";
let total = 0;

if (layered) {
  const bg = readPng(path.join(LAYER_DIR, "bg.png"));
  const bgBits = (bg.w === OUT_W && bg.h === OUT_H)
    ? packBits(OUT_W, OUT_H, (x, y) => bg.isInk(x, y))
    : downsample(bg, OUT_W, OUT_H, COVER_T);
  cBody += emitArray("pet_bg", bgBits, "背景板");
  total += bgBits.length;

  for (const [file, sym] of FRAMES) {
    const src = readPng(path.join(LAYER_DIR, `${file}.png`));
    const { char: char0, mask: mask0 } = (src.w === OUT_W && src.h === OUT_H)
      ? { char: packBits(OUT_W, OUT_H, (x, y) => src.alphaAt(x, y) >= 128 && src.isInk(x, y)),
          mask: packBits(OUT_W, OUT_H, (x, y) => src.alphaAt(x, y) >= 128) }
      : downsampleLayers(src, OUT_W, OUT_H, COVER_T);
    const dy = CHAR_DY + (FRAME_DY[file] || 0);
    const char = shiftDown(char0, dy);
    const mask = shiftDown(mask0, dy);

    let covered = 0;
    for (const b of mask) covered += [0, 1, 2, 3, 4, 5, 6, 7].filter((k) => (b >> k) & 1).length;

    cBody += emitArray(sym, char, file);
    cBody += emitArray(`${sym}_m`, mask, `${file} 遮罩`);
    total += char.length + mask.length;

    if (wantPreview)
      writePngGray(path.resolve(previewDir, `${sym}.png`), OUT_W, OUT_H,
        (x, y) => ((char[y * STRIDE + (x >> 3)] >> (7 - (x & 7))) & 1 ? 0 : 255));

    console.log(`${file.padEnd(18)} → ${sym.padEnd(22)} 角色 ${((covered / (OUT_W * OUT_H)) * 100).toFixed(1)}%`);
  }

  /* 前景遮罩：桌面/前板/底板。合成时最后画一遍背景像素盖住角色，
   * 人物就"站在桌子后面"，胸像的裁断处也被桌子收掉 */
  const fg = new Uint8Array(FRAME_BYTES);
  for (const [x0, y0, x1, y1] of FG_RECTS)
    for (let y = y0; y < y1 && y < OUT_H; y++)
      for (let x = x0; x < x1 && x < OUT_W; x++)
        fg[y * STRIDE + (x >> 3)] |= 0x80 >> (x & 7);
  cBody += emitArray("pet_fg", fg, "桌子前景");
  total += fg.length;

  cBody += `const uint8_t *const pet_masks[PET_FRAME_COUNT] = {\n`;
  cBody += FRAMES.map(([, sym]) => `    ${sym}_m,`).join("\n") + "\n};\n";
} else {
  for (const [file, sym] of FRAMES) {
    const src = readPng(path.join(SRC_DIR, `${file}.png`));
    const frame = downsample(src, OUT_W, OUT_H, COVER_T);
    total += frame.length;
    cBody += emitArray(sym, frame, file);

    if (wantPreview)
      writePngGray(path.resolve(previewDir, `${sym}.png`), OUT_W, OUT_H,
        (x, y) => ((frame[y * STRIDE + (x >> 3)] >> (7 - (x & 7))) & 1 ? 0 : 255));

    let ones = 0;
    for (const b of frame) ones += [0, 1, 2, 3, 4, 5, 6, 7].filter((k) => (b >> k) & 1).length;
    console.log(`${file.padEnd(18)} → ${sym.padEnd(22)} 墨点 ${((ones / (OUT_W * OUT_H)) * 100).toFixed(1)}%`);
  }
}

const srcNote = layered ? "assets/pet_layers（背景板 + 角色透明层）" : SRC_DIR;

writeFileSync(path.join(OUT_DIR, "pet_frames.c"),
`/* 自动生成，请勿手改。
 * 来源：${srcNote}
 * 生成：node tools/gen_pet_frames.mjs
 * 规格：${OUT_W}×${OUT_H}，1bpp（MSB 在左），1 = 墨（黑），${STRIDE} 字节/行
 */
#include <stdint.h>
#include "pet_frames.h"

${cBody}`);

writeFileSync(path.join(OUT_DIR, "pet_frames.h"),
`/* 自动生成，请勿手改。来源: ${layered ? "pet_layers" : "300x400_阈值（值班室背景版）"} */
#ifndef PET_FRAMES_H
#define PET_FRAMES_H

#include <stdint.h>

#define PET_FRAME_W  ${OUT_W}
#define PET_FRAME_H  ${OUT_H}
#define PET_FRAME_STRIDE  ${STRIDE}
#define PET_FRAME_COUNT  ${FRAMES.length}

/* 1 = 素材是「背景板 + 角色层」：固件先画背景板，再按遮罩贴角色，
 *     角色可以单独上下位移，背景保持静止；
 * 0 = 整帧图（连背景一起画）：只能整屏直贴，背景会跟着动。 */
#define PET_LAYERED  ${layered ? 1 : 0}

${FRAMES.map(([, sym]) => `extern const uint8_t ${sym}[];`).join("\n")}

#if PET_LAYERED
extern const uint8_t pet_bg[];
extern const uint8_t pet_fg[];   /* 桌子前景：合成时最后盖一遍，人物被桌子挡住 */
extern const uint8_t *const pet_masks[PET_FRAME_COUNT];
#endif

#endif
`);

console.log(`\n模式：${layered ? "分层（背景板 + 角色遮罩）" : "整帧（单层）"}`);
console.log(`共 ${FRAMES.length} 帧，${FRAME_BYTES} 字节/张，合计 ${total} 字节 → ${path.join(OUT_DIR, "pet_frames.c")}`);
console.log(`预览 → ${path.resolve(previewDir)}`);
