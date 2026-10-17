/**
 * app_config.h — 引脚与常量（全部实测自厂家固件/原理图）
 *
 * 来源：
 *   厂家 10_FactoryProgram 的 user_config.h / port_bsp/*.c
 *   之前实测：ST7305 初始化序列、像素映射、按键 GPIO
 */
#pragma once

#include "driver/gpio.h"

/* ── 屏幕 ST7305，400×300，1bpp ─────────────────────────────────────── */
#define LCD_WIDTH        400
#define LCD_HEIGHT       300
#define LCD_FB_LEN       (LCD_WIDTH * LCD_HEIGHT / 8)    /* 15000 */
#define LCD_SPI_HOST     SPI3_HOST
#define LCD_MOSI_PIN     GPIO_NUM_12
#define LCD_SCLK_PIN     GPIO_NUM_11
#define LCD_CS_PIN       GPIO_NUM_40
#define LCD_DC_PIN       GPIO_NUM_5
#define LCD_RST_PIN      GPIO_NUM_41
#define LCD_PCLK_HZ      (10 * 1000 * 1000)              /* 厂家就是 10MHz */

/* 帧缓冲极性：bit=1 → 白，bit=0 → 黑（厂家 ColorWhite=0xFF 由此推断）。
   我们的绘制约定是 1=墨（黑），所以 blit 时取反。 */

/* ── 音频 ───────────────────────────────────────────────────────────── */
#define AUD_I2S_MCLK     GPIO_NUM_16
#define AUD_I2S_BCLK     GPIO_NUM_9
#define AUD_I2S_WS       GPIO_NUM_45
#define AUD_I2S_DIN      GPIO_NUM_10     /* 麦克风 */
#define AUD_I2S_DOUT     GPIO_NUM_8      /* 扬声器 */
#define AUD_PA_PIN       GPIO_NUM_46
#define AUD_SAMPLE_HZ    16000

/* ── I2C ────────────────────────────────────────────────────────────── */
#define I2C_SDA_PIN      GPIO_NUM_13
#define I2C_SCL_PIN      GPIO_NUM_14
#define I2C_FREQ_HZ      400000

#define SHTC3_ADDR       0x70
#define RTC_ADDR         0x51

/* ── 按键（低电平有效）─────────────────────────────────────────────── */
#define KEY_BTN_PIN      GPIO_NUM_18     /* 主页 ↔ 功能页 */
#define BOOT_BTN_PIN     GPIO_NUM_0      /* 说话（M4） */

/* ── 电池 ───────────────────────────────────────────────────────────── */
#define BAT_ADC_CH       ADC_CHANNEL_3   /* ADC1 */

/* ── 网络 ───────────────────────────────────────────────────────────── */
/* 开发期写死；SoftAP 配网（M7）会挪到 NVS */
#define WIFI_SSID        CONFIG_WIFI_SSID
#define WIFI_PASS        CONFIG_WIFI_PASSWORD

#ifndef CONFIG_SERVER_URL
#define SERVER_URL       "ws://192.168.1.203:8080/device?token="
#else
#define SERVER_URL       CONFIG_SERVER_URL
#endif

/* ── 界面布局 ───────────────────────────────────────────────────────── */
#define PET_W            200
#define PET_H            267
#define PET_FRAMES       15
