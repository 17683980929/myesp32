/**
 * lcd.h — ST7305 400×300 单色屏驱动
 *
 * 绘制约定：fb_set_pixel(x, y, ink) 里 ink=1 画黑点。
 * 硬件要求 bit=1 为白，所以 flush 时整体取反。
 */
#pragma once

#include <stdint.h>
#include <stddef.h>
#include "esp_err.h"

#define LCD_W   400
#define LCD_H   300

/** 初始化 SPI + 面板 + 帧缓冲（PSRAM）。失败会 abort。 */
void lcd_init(void);

/** 清屏。ink=1 → 黑屏，ink=0 → 白屏 */
void lcd_clear(int ink);

/** 画一个点 */
void lcd_pixel(int x, int y, int ink);

/** 1bpp 位图 blit。data 行优先 MSB 在前，1 = 有墨。
 *  invert=1 时取反（桌宠帧就是这种，背景 0）。 */
void lcd_blit(const uint8_t *data, int w, int h, int dx, int dy, int invert);

/** 带遮罩的 1bpp blit（两层渲染用）：只有 mask 位为 1 的像素才写。
 *  data 和 mask 都是 w×h、行优先 MSB 在前；mask 里 0 的像素保持原样（背景透出来）。
 *  整行 mask 全 0 时直接跳过，所以角色层只占一小块时开销接近零。 */
void lcd_blit_mask(const uint8_t *data, const uint8_t *mask,
                   int w, int h, int dx, int dy, int invert);

/** 实线矩形（只描边） */
void lcd_rect(int x, int y, int w, int h, int ink);

/** 填充矩形 */
void lcd_fill(int x, int y, int w, int h, int ink);

/** 水平线 */
void lcd_hline(int x, int y, int w, int ink);

/** 把帧缓冲推到屏幕（整个 15000 字节） */
void lcd_flush(void);
