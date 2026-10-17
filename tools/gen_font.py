#!/usr/bin/env python3
"""
gen_font.py — 从 LVGL 字体 C 文件提取 ASCII 点阵，生成 1bpp 字体表

背景：厂家固件里的 MiSans 字体是 4bpp 的 LVGL 格式，而我们的单色屏要 1bpp。
这个脚本把它阈值化成 1bpp，并打包成我们自己用的紧凑结构。

用法：
    python gen_font.py <输入 lv_font_*.c> <输出目录>

生成的 font_18.h / font_18.c 里，字形位图满足：
    行优先、每像素 1 bit、字节内 MSB 在前、每行按字节对齐
    1 = 有墨（黑），0 = 背景
"""

import re
import sys
import os

# ── 解析 ────────────────────────────────────────────────────────────────


def parse_bitmap(src: str):
    """glyph_bitmap[] 的字节数组"""
    m = re.search(r"glyph_bitmap\[\]\s*=\s*\{(.*?)\n\};", src, re.S)
    if not m:
        raise SystemExit("找不到 glyph_bitmap[]")
    return [int(x, 16) for x in re.findall(r"0x([0-9A-Fa-f]{2})", m.group(1))]


def parse_glyph_dsc(src: str):
    """glyph_dsc[] 的描述符列表"""
    m = re.search(r"glyph_dsc\[\]\s*=\s*\{(.*?)\n\};", src, re.S)
    if not m:
        raise SystemExit("找不到 glyph_dsc[]")

    out = []
    pat = re.compile(
        r"\{\s*\.bitmap_index\s*=\s*(\d+)\s*,\s*"
        r"\.adv_w\s*=\s*(\d+)\s*,\s*"
        r"\.box_w\s*=\s*(\d+)\s*,\s*"
        r"\.box_h\s*=\s*(\d+)\s*,\s*"
        r"\.ofs_x\s*=\s*(-?\d+)\s*,\s*"
        r"\.ofs_y\s*=\s*(-?\d+)\s*\}"
    )
    for g in pat.finditer(m.group(1)):
        out.append(
            dict(
                bitmap_index=int(g.group(1)),
                adv_w=int(g.group(2)),
                box_w=int(g.group(3)),
                box_h=int(g.group(4)),
                ofs_x=int(g.group(5)),
                ofs_y=int(g.group(6)),
            )
        )
    return out


def parse_meta(src: str):
    bpp = int(re.search(r"\.bpp\s*=\s*(\d+)", src).group(1))
    line_h = int(re.search(r"\.line_height\s*=\s*(\d+)", src).group(1))
    base_line = int(re.search(r"\.base_line\s*=\s*(\d+)", src).group(1))
    size = int(re.search(r"\*\s*Size:\s*(\d+)\s*px", src).group(1))
    return bpp, line_h, base_line, size


# ── 位图转换 ────────────────────────────────────────────────────────────


def glyph_to_1bpp(bitmap, dsc, bpp, threshold):
    """
    LVGL 字形位图 → 1bpp 打包（行优先、MSB 在前、每行字节对齐）

    关键：LVGL 的 4bpp 是**连续半字节流**，不是按行对齐的。
    实测 '!' 为 3x14 = 42 像素 = 21 字节，正好是下一个字形的 bitmap_index。
    所以像素索引直接是 y*w + x，每字节装两个像素，高半字节在前。
    """
    w, h = dsc["box_w"], dsc["box_h"]
    if w == 0 or h == 0:
        return b""

    stride_dst = (w + 7) // 8
    out = bytearray(stride_dst * h)
    base = dsc["bitmap_index"]

    for y in range(h):
        for x in range(w):
            pi = y * w + x            # 字形内的像素序号

            if bpp == 4:
                byte = bitmap[base + pi // 2]
                v = (byte >> 4) if (pi % 2 == 0) else (byte & 0x0F)
                ink = v >= threshold
            elif bpp == 8:
                v = bitmap[base + pi]
                ink = v >= threshold
            elif bpp == 1:
                byte = bitmap[base + pi // 8]
                ink = (byte >> (7 - (pi % 8))) & 1
            else:
                raise SystemExit(f"不支持的 bpp={bpp}")

            if ink:
                out[y * stride_dst + x // 8] |= 0x80 >> (x % 8)

    return bytes(out)


def c_array(data: bytes, per_line=16):
    lines = []
    for i in range(0, len(data), per_line):
        chunk = data[i : i + per_line]
        lines.append("    " + ",".join(f"0x{b:02X}" for b in chunk) + ",")
    return "\n".join(lines)


# ── 主流程 ──────────────────────────────────────────────────────────────


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        raise SystemExit(1)

    src_path, out_dir = sys.argv[1], sys.argv[2]
    src = open(src_path, encoding="utf-8", errors="ignore").read()

    bitmap = parse_bitmap(src)
    dscs = parse_glyph_dsc(src)
    bpp, line_h, base_line, size = parse_meta(src)

    # 4bpp 阈值取 8（即 >= 半亮算有墨）；1bpp 无需阈值
    threshold = 8 if bpp >= 4 else 1

    print(f"字体: {os.path.basename(src_path)}")
    print(f"  {size}px  bpp={bpp}  line_height={line_h}  base_line={base_line}")
    print(f"  字形描述符 {len(dscs)} 个，位图 {len(bitmap)} 字节")

    name = f"font{size}"
    glyphs = []
    missing = []

    for code in range(0x20, 0x7F):
        gid = code - 0x1F          # LVGL: id 0 保留, id 1 = 空格(0x20)
        if gid >= len(dscs):
            missing.append(chr(code))
            glyphs.append(None)
            continue
        d = dscs[gid]
        data = glyph_to_1bpp(bitmap, d, bpp, threshold)
        glyphs.append((d, data))

    if missing:
        print(f"  ⚠ 缺失字符: {''.join(missing)}")

    os.makedirs(out_dir, exist_ok=True)

    # ── 头文件 ──
    h_path = os.path.join(out_dir, f"{name}.h")
    with open(h_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(f"""/* 自动生成，请勿手改。来源: {os.path.basename(src_path)} */
#pragma once
#include <stdint.h>

/* 单个字形。位图：行优先、MSB 在前、每行字节对齐、1 = 有墨 */
typedef struct {{
    uint8_t  w;        /* 字形宽 */
    uint8_t  h;        /* 字形高 */
    int8_t   ofs_x;    /* 相对光标的 x 偏移 */
    int8_t   top_ofs;  /* 相对基线的顶部偏移（负数向上） */
    uint8_t  adv;      /* 步进宽度 */
    const uint8_t *bmp;
}} glyph_t;

#define {name.upper()}_SIZE      {size}
#define {name.upper()}_LINE_H    {line_h}
#define {name.upper()}_BASE_LINE {base_line}
#define {name.upper()}_FIRST     0x20
#define {name.upper()}_LAST      0x7E

extern const glyph_t {name}[{0x7F - 0x20}];
""")
    print(f"  → {h_path}")

    # ── 源文件 ──
    c_path = os.path.join(out_dir, f"{name}.c")
    with open(c_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(f'/* 自动生成，请勿手改。来源: {os.path.basename(src_path)} */\n')
        f.write(f'#include "{name}.h"\n\n')

        # 位图数据
        f.write("/* ---- 字形位图 ---- */\n")
        for idx, g in enumerate(glyphs):
            if g is None:
                continue
            d, data = g
            if not data:
                continue
            ch = chr(0x20 + idx)
            label = ch if ch not in ('"', "\\", "*") else "?"
            f.write(f"/* U+{0x20 + idx:04X} '{label}'  {d['box_w']}x{d['box_h']} */\n")
            f.write(f"static const uint8_t bmp_{idx:02X}[] = {{\n")
            f.write(c_array(data))
            f.write("\n};\n\n")

        # 字形表
        f.write(f"const glyph_t {name}[{0x7F - 0x20}] = {{\n")
        for idx, g in enumerate(glyphs):
            if g is None:
                f.write("    {0,0,0,0,0,0},\n")
                continue
            d, data = g
            adv = max(1, round(d["adv_w"] / 16))
            top_ofs = d["ofs_y"] - d["box_h"]
            if data:
                f.write(
                    f"    {{{d['box_w']},{d['box_h']},{d['ofs_x']},{top_ofs},{adv},bmp_{idx:02X}}},"
                    f"  /* 0x{0x20 + idx:02X} */\n"
                )
            else:
                f.write(
                    f"    {{0,0,0,0,{adv},0}},  /* 0x{0x20 + idx:02X} 空白 */\n"
                )
        f.write("};\n")

    print(f"  → {c_path}")

    # 统计
    total = sum(len(g[1]) for g in glyphs if g)
    print(f"  位图总大小 {total} 字节")


if __name__ == "__main__":
    main()
