/**
 * lcd.c — ST7305 400×300 单色屏驱动
 *
 * 初始化序列、像素映射（横屏 LUT 公式）全部来自厂家 display_bsp.cpp，
 * 之前已在真机上验证过（ESP-Claw 的适配也用同一套公式）。
 *
 * 像素 → 字节映射（横屏）：
 *   inv_y   = 299 - y
 *   byte_x  = x / 2          (0..199)
 *   block_y = inv_y / 4      (0..74)
 *   index   = byte_x * 75 + block_y
 *   bit     = 7 - ((inv_y % 4) * 2 + (x % 2))
 *
 * 极性约定（全工程统一）：
 *   所有绘制函数的 `ink` 参数：1 = 黑（有墨），0 = 白
 *   lcd_clear(0) = 白底，lcd_clear(1) = 黑底
 *   硬件要求 bit=1 为白，所以 fb 里 1=白、flush 时取反
 */

#include "lcd.h"
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/spi_master.h"
#include "driver/gpio.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_vendor.h"
#include "esp_lcd_panel_ops.h"
#include "esp_heap_caps.h"
#include "hw_config.h"

static esp_lcd_panel_io_handle_t s_io = NULL;
static uint8_t *s_fb = NULL;          /* 1 = 白，0 = 黑（与硬件一致） */
static uint8_t *s_out = NULL;         /* 取反后的发送缓冲 */
#define FB_LEN (LCD_W * LCD_H / 8)

static void lcd_cmd(uint8_t cmd)
{
    esp_lcd_panel_io_tx_param(s_io, cmd, NULL, 0);
}

static void lcd_cmd_data(uint8_t cmd, const uint8_t *data, size_t len)
{
    esp_lcd_panel_io_tx_param(s_io, cmd, data, len);
}

void lcd_init(void)
{
    /* SPI 总线 */
    spi_bus_config_t bus = {
        .mosi_io_num = LCD_MOSI_PIN,
        .sclk_io_num = LCD_SCLK_PIN,
        .miso_io_num = -1,
        .quadwp_io_num = -1,
        .quadhd_io_num = -1,
        .max_transfer_sz = FB_LEN,
    };
    ESP_ERROR_CHECK(spi_bus_initialize(LCD_SPI_HOST, &bus, SPI_DMA_CH_AUTO));

    /* 面板 IO（DC + CS + 10MHz mode0，同厂家） */
    esp_lcd_panel_io_spi_config_t io_cfg = {
        .dc_gpio_num = LCD_DC_PIN,
        .cs_gpio_num = LCD_CS_PIN,
        .pclk_hz = LCD_PCLK_HZ,
        .lcd_cmd_bits = 8,
        .lcd_param_bits = 8,
        .spi_mode = 0,
        .trans_queue_depth = 10,
    };
    ESP_ERROR_CHECK(esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)LCD_SPI_HOST,
                                             &io_cfg, &s_io));

    /* 复位脚 */
    gpio_config_t rst = {
        .pin_bit_mask = 1ULL << LCD_RST_PIN,
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
    };
    ESP_ERROR_CHECK(gpio_config(&rst));
    gpio_set_level(LCD_RST_PIN, 1);

    /* 帧缓冲（PSRAM） */
    s_fb = heap_caps_malloc(FB_LEN, MALLOC_CAP_SPIRAM);
    s_out = heap_caps_malloc(FB_LEN, MALLOC_CAP_SPIRAM);
    assert(s_fb && s_out);
    memset(s_fb, 0x00, FB_LEN);       /* 白底 */

    /* ── ST7305 初始化序列（厂家原样）─────────────────────────────── */
    const struct { uint8_t cmd; uint8_t data[10]; uint8_t n; } seq[] = {
        {0xD6, {0x17, 0x02}, 2},                          /* NVM Load Control */
        {0xD1, {0x01}, 1},                                /* Booster Enable */
        {0xC0, {0x11, 0x04}, 2},                          /* Gate Voltage */
        {0xC1, {0x41, 0x41, 0x41, 0x41}, 4},              /* VSHP */
        {0xC2, {0x19, 0x19, 0x19, 0x19}, 4},
        {0xC4, {0x41, 0x41, 0x41, 0x41}, 4},
        {0xC5, {0x19, 0x19, 0x19, 0x19}, 4},
        {0xD8, {0xA6, 0xE9}, 2},
        {0xB2, {0x05}, 1},
        {0xB3, {0xE5, 0xF6, 0x05, 0x46, 0x77, 0x77, 0x77, 0x77, 0x76, 0x45}, 10},
        {0xB4, {0x05, 0x46, 0x77, 0x77, 0x77, 0x77, 0x76, 0x45}, 8},
        {0x62, {0x32, 0x03, 0x1F}, 3},
        {0xB7, {0x13}, 1},
        {0xB0, {0x64}, 1},
        {0x11, {0}, 0},                                   /* Sleep Out */
        {0xC9, {0x00}, 1},
        {0x36, {0x48}, 1},                                /* Memory Access */
        {0x3A, {0x11}, 1},                                /* Data Format */
        {0xB9, {0x20}, 1},
        {0xB8, {0x29}, 1},
        {0x21, {0}, 0},                                   /* Display Inversion On */
        {0x35, {0x00}, 1},
        {0xD0, {0xFF}, 1},
        {0x38, {0}, 0},
        {0x29, {0}, 0},                                   /* Display On */
    };

    for (size_t i = 0; i < sizeof(seq) / sizeof(seq[0]); i++) {
        if (seq[i].n == 0) {
            lcd_cmd(seq[i].cmd);
        } else {
            lcd_cmd_data(seq[i].cmd, seq[i].data, seq[i].n);
        }
        if (seq[i].cmd == 0x11) {
            vTaskDelay(pdMS_TO_TICKS(200));               /* Sleep Out 后必须等 */
        }
    }

    /* 地址窗口（厂家原样） */
    lcd_cmd(0x2A); lcd_cmd_data(0x2A, (uint8_t[]){0x12, 0x2A}, 2);
    lcd_cmd(0x2B); lcd_cmd_data(0x2B, (uint8_t[]){0x00, 0xC7}, 2);
    lcd_cmd(0x35); lcd_cmd_data(0x35, (uint8_t[]){0x00}, 1);

    lcd_clear(0);
    lcd_flush();
}

/* ── 绘制 ──────────────────────────────────────────────────────────── */

void lcd_clear(int ink)
{
    /* ink=1 → 黑屏（位全 1）；ink=0 → 白屏（位全 0） */
    memset(s_fb, ink ? 0xFF : 0x00, FB_LEN);
}

void lcd_pixel(int x, int y, int ink)
{
    if (x < 0 || y < 0 || x >= LCD_W || y >= LCD_H) return;
    int inv_y = (LCD_H - 1) - y;
    int byte_x = x >> 1;
    int block_y = inv_y >> 2;
    uint32_t index = byte_x * (LCD_H / 4) + block_y;
    uint8_t bit = 7 - ((inv_y & 3) * 2 + (x & 1));

    /* ink=1 黑 → 硬件位 0；ink=0 白 → 硬件位 1 */
    if (ink)
        s_fb[index] &= ~(1 << bit);
    else
        s_fb[index] |= (1 << bit);
}

void lcd_blit(const uint8_t *data, int w, int h, int dx, int dy, int invert)
{
    int stride = (w + 7) / 8;
    for (int y = 0; y < h; y++) {
        for (int x = 0; x < w; x++) {
            int ink = (data[y * stride + (x >> 3)] >> (7 - (x & 7))) & 1;
            if (invert) ink = !ink;
            lcd_pixel(dx + x, dy + y, ink);
        }
    }
}

void lcd_rect(int x, int y, int w, int h, int ink)
{
    for (int i = 0; i < w; i++) { lcd_pixel(x + i, y, ink); lcd_pixel(x + i, y + h - 1, ink); }
    for (int j = 0; j < h; j++) { lcd_pixel(x, y + j, ink); lcd_pixel(x + w - 1, y + j, ink); }
}

void lcd_fill(int x, int y, int w, int h, int ink)
{
    for (int j = 0; j < h; j++)
        for (int i = 0; i < w; i++)
            lcd_pixel(x + i, y + j, ink);
}

void lcd_hline(int x, int y, int w, int ink)
{
    for (int i = 0; i < w; i++) lcd_pixel(x + i, y, ink);
}

void lcd_flush(void)
{
    /* fb 里 1=黑、0=白；硬件 bit=1 白 → 取反后发送 */
    for (int i = 0; i < FB_LEN; i++) s_out[i] = ~s_fb[i];

    lcd_cmd(0x2A); lcd_cmd_data(0x2A, (uint8_t[]){0x12, 0x2A}, 2);
    lcd_cmd(0x2B); lcd_cmd_data(0x2B, (uint8_t[]){0x00, 0xC7}, 2);
    esp_lcd_panel_io_tx_color(s_io, 0x2C, s_out, FB_LEN);
}
