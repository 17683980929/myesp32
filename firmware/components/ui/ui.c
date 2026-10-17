/**
 * ui.c — 400×300 单色界面
 *
 * 左半 0..199：桌宠（200×267 帧垂直居中）
 * 右半 200..399：信息栏（7 段时钟 + 图标 + 数字）
 *
 * 设计决定：信息栏用「图标 + 数字」而不是中文标签 —— 单色 1bpp 下
 * 图标比文字更清晰，而且省掉一整套中文字体。
 */

#include "ui.h"
#include <stdio.h>
#include <string.h>
#include "lcd.h"
#include "font5x7.h"
#include "pet_frames.h"
#include "sensors.h"

#ifndef PET_W
#define PET_W            200
#endif
#ifndef PET_H
#define PET_H            267
#endif

/* ── 文本（font5x7，支持 1/2/3 倍放大）────────────────────────────── */

static void draw_text(int x, int y, const char *s, int scale, int ink)
{
    for (; *s; s++) {
        const uint8_t *g = font5x7_glyph(*s);
        for (int row = 0; row < 7; row++) {
            uint8_t bits = g[row];
            for (int col = 0; col < 5; col++) {
                if (bits & (0x80 >> col)) {
                    for (int sy = 0; sy < scale; sy++)
                        for (int sx = 0; sx < scale; sx++)
                            lcd_pixel(x + col * scale + sx, y + row * scale + sy, ink);
                }
            }
        }
        x += 6 * scale;
    }
}

static int text_w(const char *s, int scale)
{
    int n = 0;
    while (*s++) n++;
    return n * 6 * scale - scale;
}

/* ── 7 段数字（时钟用，任意尺寸）──────────────────────────────────── */

/* 0..9 的七段码：A B C D E F G */
static const uint8_t SEG[10] = { 0x3F, 0x06, 0x5B, 0x4F, 0x66, 0x6D, 0x7D, 0x07, 0x7F, 0x6F };

static void seg_digit(int x, int y, int d, int h, int ink)
{
    /* 段厚度 = h/5 */
    int t = h / 5 + 1;
    int w = h / 2;                       /* 单个数字宽 */
    int a[7][4] = {                      /* A B C D E F G 的矩形 */
        { t, 0,           w - 2 * t, t },        /* A 上 */
        { w - t, t,       t,   h/2 - t },          /* B 右上 */
        { w - t, h/2 + 1, t,   h/2 - t - 1 },      /* C 右下 */
        { t, h - t,       w - 2*t, t },            /* D 下 */
        { 0, h/2 + 1,     t,   h/2 - t - 1 },      /* E 左下 */
        { 0, t,           t,   h/2 - t },          /* F 左上 */
        { t, h/2 - t/2,   w - 2*t, t },            /* G 中 */
    };
    uint8_t mask = SEG[d & 0x0F];
    for (int s = 0; s < 7; s++) {
        if (!(mask & (0x40 >> s))) continue;
        lcd_fill(x + a[s][0], y + a[s][1], a[s][2], a[s][3], ink);
    }
}

static void seg_time(int x, int y, const char *hhmm, int h, int ink)
{
    /* "14:32" —— 冒号画成两个方块 */
    int digit_w = h / 2 + h / 8;
    for (const char *p = hhmm; *p; p++) {
        if (*p == ':') {
            int d = digit_w / 2;
            lcd_fill(x, y + h / 3, d, d, ink);
            lcd_fill(x, y + 2 * h / 3 - d, d, d, ink);
            x += d + h / 6;
        } else if (*p >= '0' && *p <= '9') {
            seg_digit(x, y, *p - '0', h, ink);
            x += digit_w + h / 10;
        }
    }
}

/* ── 图标（程序化绘制，免字体）────────────────────────────────────── */

/** 温度计：圆头 + 竖管 + 刻度 */
static void icon_therm(int x, int y, int s, int ink)
{
    int r = s / 5;
    lcd_fill(x + s / 4, y + s / 3, r * 2, s / 2, ink);
    lcd_fill(x + s / 4 + r / 2, y + s / 3 + r, r, s / 3, ink);
    for (int i = 0; i < 3; i++)
        lcd_hline(x + s * 2 / 3, y + s / 3 + i * (s / 4), s / 3, ink);
}

/** 水滴 */
static void icon_drop(int x, int y, int s, int ink)
{
    for (int j = 0; j < s; j++) {
        int half = (j < s / 3) ? (j * s / 2 / (s / 3) / 2 + 1)
                               : (s / 2 - (j - s / 3) * (s / 2) / (s - s / 3));
        if (half < 1) half = 1;
        lcd_hline(x + s / 2 - half, y + j, half * 2, ink);
    }
}

/** 电池：外框 + 电极 + 电量条 */
static void icon_battery(int x, int y, int s, int pct, int ink)
{
    int bw = s, bh = s / 2;
    lcd_rect(x, y, bw, bh, ink);
    lcd_fill(x + bw, y + bh / 4, s / 8, bh / 2, ink);           /* 电极 */
    int inner = (bw - 4) * pct / 100;
    if (inner > 0) lcd_fill(x + 2, y + 2, inner, bh - 4, ink);
}

/** 云 + 太阳（天气用，kind 0=晴 1=多云 2=阴 3=雨） */
static void icon_weather(int x, int y, int s, int kind, int ink)
{
    if (kind == 0) {                     /* 晴：圆 + 8 条光线 */
        int r = s / 3;
        lcd_fill(x + s / 4, y + s / 4, r * 2, r * 2, ink);
        lcd_fill(x + s / 4 + r / 4, y + s / 4 + r / 4, r * 3 / 2, r * 3 / 2, 0);
        for (int i = 0; i < 8; i++) {
            /* 简化：4 条主方向光线 */
            if (i == 0) lcd_hline(x + s / 2 - r / 2, y - s / 8, r + s / 8, ink);
            if (i == 2) lcd_hline(x + s / 2 - r / 2, y + s - s / 4, r + s / 8, ink);
            if (i == 4) lcd_fill(x - s / 8, y + s / 2 - r / 2, s / 8, r + s / 8, ink);
            if (i == 6) lcd_fill(x + s - s / 4, y + s / 2 - r / 2, s / 8, r + s / 8, ink);
        }
        return;
    }
    /* 云（多云/阴/雨通用） */
    int r = s / 4;
    lcd_fill(x + s / 6, y + s / 2, s * 2 / 3, s / 3, ink);
    lcd_fill(x + s / 4, y + s / 4, r * 2, r * 2, ink);
    lcd_fill(x + s / 2, y + s / 5, r * 2 + s / 6, r * 2, ink);
    if (kind == 3) {                     /* 雨：3 条斜线 */
        for (int i = 0; i < 3; i++) {
            int bx = x + s / 4 + i * (s / 3);
            for (int j = 0; j < s / 4; j++)
                lcd_pixel(bx + j / 2, y + s * 3 / 4 + j, ink);
        }
    }
}

static int weather_kind(const char *text)
{
    if (strstr(text, "雨") || strstr(text, "雷")) return 3;
    if (strstr(text, "晴")) return 0;
    if (strstr(text, "云")) return 1;
    if (strstr(text, "阴") || strstr(text, "雾")) return 2;
    return 1;
}

/* ── 桌宠 ─────────────────────────────────────────────────────────── */

typedef enum { PET_IDLE, PET_BLINK, PET_THINKING, PET_SPEAKING } pet_state_t;

static pet_state_t s_pet = PET_IDLE;
static int s_frame_idx = 0;
static int s_blink_phase = 0;

static const uint8_t *PET_NAMES[PET_FRAME_COUNT] = {
    pet_sm_01_idle, pet_sm_02_idle_blink, pet_sm_03_listening,
    pet_sm_04_thinking, pet_sm_05_speaking, pet_sm_06_happy,
    pet_sm_07_love, pet_sm_08_confused, pet_sm_09_sleepy,
    pet_sm_10_sleeping, pet_sm_11_salute, pet_sm_12_direct,
    pet_sm_13_patrol, pet_sm_14_note, pet_sm_15_charging,
};

/* 帧数据 1=墨（黑），帧背景 0=白。与全工程约定一致，不用取反 */
static void draw_pet(void)
{
    const uint8_t *frame = PET_NAMES[s_frame_idx];
    int dx = (PET_W - PET_FRAME_W) / 2;              /* 0 */
    int dy = (LCD_H - PET_FRAME_H) / 2;              /* 16 */
    lcd_blit(frame, PET_FRAME_W, PET_FRAME_H, dx, dy, 0);
}

static void pet_tick(uint32_t now)
{
    switch (s_pet) {
    case PET_IDLE:
    case PET_BLINK:
        /* 每 3.2 秒眨一次眼，眨 160ms */
        if (s_blink_phase == 0 && (now % 3200) < 40) {
            s_frame_idx = 1;
            s_blink_phase = 1;
        } else if (s_blink_phase == 1 && (now % 3200) > 200) {
            s_frame_idx = 0;
            s_blink_phase = 0;
        }
        break;
    case PET_THINKING: s_frame_idx = 3; break;
    case PET_SPEAKING: s_frame_idx = 4; break;
    }
}

/* ── 页面 ──────────────────────────────────────────────────────────── */

static ui_page_t s_page = UI_PAGE_HOME;
static int s_busy = 0;
static char s_sub[64] = "";

void ui_init(void) { lcd_init(); }
void ui_set_page(ui_page_t p) { s_page = p; }
ui_page_t ui_get_page(void) { return s_page; }
void ui_set_busy(int busy) { s_busy = busy; }
void ui_set_sub(const char *text)
{
    strncpy(s_sub, text ? text : "", sizeof(s_sub) - 1);
    s_sub[sizeof(s_sub) - 1] = 0;
}

void ui_tick(uint32_t now)
{
    if (s_busy) s_pet = PET_THINKING;
    else s_pet = PET_IDLE;
    pet_tick(now);
}

void ui_render(void)
{
    dev_info_t *info = ws_client_info();

    /* 本地传感器 */
    float t = -1, h = -1;
    sensors_read_th(&t, &h);
    int bat = sensors_battery_pct();

    if (s_page == UI_PAGE_FUNC) {
        lcd_clear(0);
        draw_text((LCD_W - text_w("Coming Soon", 3)) / 2, (LCD_H - 7 * 3) / 2,
                  "Coming Soon", 3, 1);
        /* 注：中文字样"敬请期待"需要中文字体，M6 时生成点阵后替换 */
        lcd_flush();

        /* 5 秒后回主页（由 main 的 tick 判断） */
        return;
    }

    /* ── 主页 ── */
    lcd_clear(0);

    /* 左：桌宠 */
    draw_pet();

    /* 右：信息栏。x 从 208 开始，留 8px 边距 */
    int rx = 208;

    /* 时间（7 段，高 40px） */
    seg_time(rx, 12, info->time[0] ? info->time : "--:--", 40, 1);

    /* 日期 + 星期（数字，设备端没有中文字体） */
    static const char *WD[7] = { "SUN","MON","TUE","WED","THU","FRI","SAT" };
    char dline[24];
    snprintf(dline, sizeof(dline), "%d/%d  %s", info->mm, info->dd,
             WD[info->wday % 7]);
    draw_text(rx, 60, dline, 1, 1);

    /* 分隔线 */
    lcd_hline(rx, 78, LCD_W - rx - 8, 1);

    /* 天气：图标 + 文字/温度 */
    icon_weather(rx, 90, 24, weather_kind(info->weather), 1);
    char wbuf[24];
    if (info->weather_temp > -1)
        snprintf(wbuf, sizeof(wbuf), "%d", info->weather_temp);
    else
        snprintf(wbuf, sizeof(wbuf), "--");
    draw_text(rx + 34, 96, wbuf, 1, 1);

    /* 温湿度（图标 + 数字） */
    icon_therm(rx, 126, 22, 1);
    char tb[16];
    if (t > -50) snprintf(tb, sizeof(tb), "%.1f", t);
    else snprintf(tb, sizeof(tb), "--.-");
    draw_text(rx + 30, 132, tb, 1, 1);

    icon_drop(rx, 160, 22, 1);
    char hb[16];
    if (h > 0) snprintf(hb, sizeof(hb), "%d%%", (int)h);
    else snprintf(hb, sizeof(hb), "--");
    draw_text(rx + 30, 166, hb, 1, 1);

    /* 电量 */
    icon_battery(rx, 196, 26, bat, 1);
    char bb[12];
    snprintf(bb, sizeof(bb), "%d%%", bat);
    draw_text(rx + 36, 202, bb, 1, 1);

    /* 底部状态：字幕 / 连接状态 */
    lcd_hline(rx, 232, LCD_W - rx - 8, 1);
    if (s_sub[0]) {
        draw_text(rx, 244, s_sub, 1, 1);
    }

    lcd_flush();
}
