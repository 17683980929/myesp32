/**
 * gen_pet_frames.mjs — 把 300×400 1-bit 黑白帧转成固件用的 200×300 1bpp C 数组
 *
 * 用法：node tools/gen_pet_frames.mjs [素材目录] [输出目录]
 *   默认素材：assets/pet_v2/xiaozhi_police_pet_with_bg/300x400_阈值
 *   默认输出：firmware/components/ui/pet_frames.c / pet_frames.h
 *
 * 约定（与 lcd_blit 一致）：
 *   - 每行 25 字节（200/8），共 300 行 = 7500 字节
 *   - MSB 在左，bit=1 表示墨（黑）
 *   - 缩放用面积覆盖率 + 阈值，保住细线（纯最近邻会丢掉 1px 的墙线）
 *
 * 尺寸：源 3:4 → 屏上桌宠区 2:3，纵向拉伸约 12% 填满 200×300（上下不再留白边）。
 *   背景是白墙白地面，留白本来也不明显，但填满后桌面下沿和屏幕底边齐平，更像一整块背景。
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { inflateSync, deflateSync } from "node:zlib";
import path from "node:path";

const SRC_DIR = process.argv[2] || "assets/pet_v2/xiaozhi_police_pet_with_bg/300x400_阈值";
const OUT_DIR = process.argv[3] || "firmware/components/ui";

const OUT_W = 200;
const OUT_H = 300;
const STRIDE = OUT_W / 8;

/* 覆盖率阈值：0.38 是拿 3 帧对比调出来的——0.5 会让墙上的窗框细线断掉，
 * 0.25 又会让制服阴影糊成一片 */
const COVER_T = 0.38;

/* ── PNG 解码（只支持非隔行；1/8bit 灰度、8bit RGB/RGBA、调色板）──── */

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

/** 读 PNG，返回 {w,h} 与取墨函数 isInk(x,y) */
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
      const idx = bit;
      const p = palette ? palette[idx * 3] : 0;
      return p < 128;
    }
    if (depth === 8) {
      if (ctype === 0) return out[rowBase + x] < 128;
      if (ctype === 3) {
        const idx = out[rowBase + x];
        return palette[idx * 3] < 128;
      }
      const i = rowBase + x * channels;
      const lum = 0.299 * out[i] + 0.587 * out[i + 1] + 0.114 * out[i + 2];
      return lum < 128;
    }
    throw new Error(`不支持的位深 ${depth}`);
  };

  return { w, h, isInk };
}

/* ── 缩放：面积覆盖率 ─────────────────────────────────────────────── */

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
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
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

const previewDir = path.join(OUT_DIR, "../../../assets/pet_frames_preview");
mkdirSync(path.resolve(previewDir), { recursive: true });

let cBody = "";
let total = 0;

for (const [file, sym] of FRAMES) {
  const src = readPng(path.join(SRC_DIR, `${file}.png`));
  const frame = downsample(src, OUT_W, OUT_H, COVER_T);
  total += frame.length;

  let ones = 0;
  for (const b of frame) ones += (b & 0x0f).toString(2).replace(/0/g, "").length + (b >> 4).toString(2).replace(/0/g, "").length;

  cBody += `/* ${file} — 墨点 ${ones}/${OUT_W * OUT_H} (${((ones / (OUT_W * OUT_H)) * 100).toFixed(1)}%) */\n`;
  cBody += `const uint8_t ${sym}[${frame.length}] = {\n`;
  for (let i = 0; i < frame.length; i += 16) {
    const line = Array.from(frame.subarray(i, i + 16), (b) => "0x" + b.toString(16).padStart(2, "0")).join(",");
    cBody += `    ${line},\n`;
  }
  cBody += "};\n\n";

  writePngGray(
    path.resolve(previewDir, `${sym}.png`),
    OUT_W, OUT_H,
    (x, y) => ((frame[y * STRIDE + (x >> 3)] >> (7 - (x & 7))) & 1 ? 0 : 255)
  );

  console.log(`${file.padEnd(18)} → ${sym.padEnd(22)} 墨点 ${((ones / (OUT_W * OUT_H)) * 100).toFixed(1)}%`);
}

const cFile =
`/* 自动生成，请勿手改。
 * 来源：assets/pet_v2/xiaozhi_police_pet_with_bg/300x400_阈值
 * 生成：node tools/gen_pet_frames.mjs
 * 规格：${OUT_W}×${OUT_H}，1bpp（MSB 在左），1 = 墨（黑），25 字节/行
 */
#include <stdint.h>

${cBody}`;

writeFileSync(path.join(OUT_DIR, "pet_frames.c"), cFile);

writeFileSync(path.join(OUT_DIR, "pet_frames.h"),
`/* 自动生成，请勿手改。来源: 300x400_阈值（值班室背景版） */
#ifndef PET_FRAMES_H
#define PET_FRAMES_H

#include <stdint.h>

#define PET_FRAME_W  ${OUT_W}
#define PET_FRAME_H  ${OUT_H}
#define PET_FRAME_STRIDE  ${STRIDE}
#define PET_FRAME_COUNT  ${FRAMES.length}

${FRAMES.map(([, sym]) => `extern const uint8_t ${sym}[];`).join("\n")}

#endif
`);

console.log(`\n共 ${FRAMES.length} 帧，${total} 字节 → ${path.join(OUT_DIR, "pet_frames.c")}`);
console.log(`预览 → ${path.resolve(previewDir)}`);
