/* 自动生成，请勿手改。生成器: tools/gen_font_5x7.py */
#pragma once
#include <stdint.h>

#define FONT5X7_W    5
#define FONT5X7_H    7
#define FONT5X7_ADV  6

/* 取一个字符的字形数据（7 字节，每行低 5 位有效，MSB 为左）。
   未收录的字符返回 '?' 的字形。返回 NULL 表示不打印。 */
const uint8_t *font5x7_glyph(char c);

/* 该字符的步进宽度（像素） */
uint8_t font5x7_advance(char c);
