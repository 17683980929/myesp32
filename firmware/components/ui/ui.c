/**
 * ui.c — 400×300 单色界面
 *
 * 左半 0..199：桌宠（200×267 帧垂直居中）
 * 右半 200..399：信息栏（7 段时钟 + 图标 + 中文标签 + 数值）
 *
 * 时钟走 PCF85063 RTC，秒级刷新（主循环每秒重绘）。
 * 中文标签用 16×16 点阵（font_cjk，由 tools/gen_cjk.ps1 生成）。
 */

#include "ui.h"
#include <stdio.h>
#include <string.h>
#include "lcd.h"
#include "font5x7.h"
#include "font_cjk.h"
#include "pet_frames.h"
#include "sensors.h"
#include "pcf85063.h"

#ifndef PET_W
#define PET_W            200
#endif
#ifndef PET_H
#define PET_H            267
#endif

#define PANEL_X          208
#define PANEL_SEP_W      (LCD_W - PANEL_X - 8)

/* ── 文本（font5x7，支持 1/2/3 倍放大）────────────────────────────── */

/** 度符号：3×3 圆环（` 字符），按 scale 放大 */
static void draw_degree(int x, int y, int scale, int ink)
{
    static const uint8_t ring[3] = { 0x2, 0x5, 0x2 };   /* 010 / 101 / 010 */
    for (int r = 0; r < 3; r++)
        for (int c = 0; c < 3; c++)
            if (ring[r] & (0x4 >> c))
                for (int sy = 0; sy < scale; sy++)
                    for (int sx = 0; sx < scale; sx++)
                        lcd_pixel(x + c * scale + sx, y + r * scale + sy, ink);
}

static void draw_text(int x, int y, const char *s, int scale, int ink)
{
    for (; *s; s++) {
        if (*s == '`') {                 /* ` 表示度符号 */
            draw_degree(x, y + scale, scale, ink);
            x += 4 * scale;
            continue;
        }
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

/* ── 中文点阵（UTF-8 → 16×16 字形）────────────────────────────────── */

static uint32_t utf8_next(const char **ps)
{
    const unsigned char *s = (const unsigned char *)*ps;
    uint32_t cp;
    int n;
    if (s[0] < 0x80)               { cp = s[0];         n = 1; }
    else if ((s[0] & 0xE0) == 0xC0){ cp = s[0] & 0x1F;  n = 2; }
    else if ((s[0] & 0xF0) == 0xE0){ cp = s[0] & 0x0F;  n = 3; }
    else                           { cp = 0xFFFD;       n = 1; }

    for (int i = 1; i < n && s[i]; i++)
        cp = (cp << 6) | (s[i] & 0x3F);
    *ps += n;
    return cp;
}

static int cjk_text_w(const char *s, int scale)
{
    int n = 0;
    while (*s) { utf8_next(&s); n++; }
    return n * 16 * scale;
}

/** 字符串里是否含非 ASCII（走中文点阵） */
static int has_cjk(const char *s)
{
    while (*s) {
        if ((unsigned char)*s >= 0x80) return 1;
        s++;
    }
    return 0;
}

static void draw_cjk(int x, int y, const char *s, int scale, int ink)
{
    while (*s) {
        uint32_t cp = utf8_next(&s);
        const uint16_t *g = cjk_glyph(cp);
        if (g) {
            for (int row = 0; row < 16; row++) {
                uint16_t bits = g[row];
                if (!bits) continue;
                for (int col = 0; col < 16; col++) {
                    if (!(bits & (0x8000u >> col))) continue;
                    for (int sy = 0; sy < scale; sy++)
                        for (int sx = 0; sx < scale; sx++)
                            lcd_pixel(x + col * scale + sx, y + row * scale + sy, ink);
                }
            }
        }
        x += 16 * scale;             /* 未收录的字留空 */
    }
}

/* ── 7 段数字（时钟用，任意尺寸）──────────────────────────────────── */

/* 0..9 的七段码：A B C D E F G */
static const uint8_t SEG[10] = { 0x3F, 0x06, 0x5B, 0x4F, 0x66, 0x6D, 0x7D, 0x07, 0x7F, 0x6F };

static void seg_digit(int x, int y, int d, int h, int ink)
{
    int t = h / 8 + 1;                   /* 笔画厚度 */
    int w = h / 2 + t;                   /* 单个数字宽 */
    int a[7][4] = {                      /* A B C D E F G 的矩形 */
        { t, 0,             w - 2 * t, t },        /* A 上 */
        { w - t, t,         t,   h / 2 - t },      /* B 右上 */
        { w - t, h / 2 + 1, t,   h / 2 - t - 1 },  /* C 右下 */
        { t, h - t,         w - 2 * t, t },        /* D 下 */
        { 0, h / 2 + 1,     t,   h / 2 - t - 1 },  /* E 左下 */
        { 0, t,             t,   h / 2 - t },      /* F 左上 */
        { t, h / 2 - t / 2, w - 2 * t, t },        /* G 中 */
    };
    uint8_t mask = SEG[d & 0x0F];
    for (int s = 0; s < 7; s++) {
        if (!(mask & (0x40 >> s))) continue;
        lcd_fill(x + a[s][0], y + a[s][1], a[s][2], a[s][3], ink);
    }
}

static void seg_time(int x, int y, const char *hhmmss, int h, int ink)
{
    int t = h / 8 + 1;
    int w = h / 2 + t;
    int gap = h / 10 + 1;

    for (const char *p = hhmmss; *p; p++) {
        if (*p == ':') {
            lcd_fill(x, y + h / 4, t, t, ink);
            lcd_fill(x, y + 3 * h / 4 - t, t, t, ink);
            x += t + gap;
        } else if (*p >= '0' && *p <= '9') {
            seg_digit(x, y, *p - '0', h, ink);
            x += w + gap;
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
    if (kind == 0) {                     /* 晴：圆 + 4 条光线 */
        int r = s / 3;
        lcd_fill(x + s / 4, y + s / 4, r * 2, r * 2, ink);
        lcd_fill(x + s / 4 + r / 4, y + s / 4 + r / 4, r * 3 / 2, r * 3 / 2, 0);
        lcd_hline(x + s / 2 - r / 2, y - s / 8, r + s / 8, ink);
        lcd_hline(x + s / 2 - r / 2, y + s - s / 4, r + s / 8, ink);
        lcd_fill(x - s / 8, y + s / 2 - r / 2, s / 8, r + s / 8, ink);
        lcd_fill(x + s - s / 4, y + s / 2 - r / 2, s / 8, r + s / 8, ink);
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

int ui_tick(uint32_t now)
{
    pet_state_t prev_state = s_pet;
    int prev_idx = s_frame_idx;

    s_pet = s_busy ? PET_THINKING : PET_IDLE;
    pet_tick(now);

    return (s_pet != prev_state) || (s_frame_idx != prev_idx);
}

/* ── 主页右栏 ──────────────────────────────────────────────────────── */

static void render_panel(void)
{
    dev_info_t *info = ws_client_info();

    /* 本地传感器 */
    float t = -99, h = -99;
    if (sensors_read_th(&t, &h) != ESP_OK) {
        t = -99;
        h = -99;
    }
    int bat = sensors_battery_pct();

    /* 时钟：HH:MM:SS（RTC） */
    int Y = 0, Mo = 0, D = 0, Wd = 0, H = 0, Mi = 0, S = 0;
    int rtc_ok = (pcf85063_get(&Y, &Mo, &D, &Wd, &H, &Mi, &S) == 0);

    if (rtc_ok) {
        char tbuf[24];
        snprintf(tbuf, sizeof(tbuf), "%02d:%02d:%02d", H, Mi, S);
        seg_time(PANEL_X, 12, tbuf, 34, 1);
    } else {
        draw_text(PANEL_X, 18, "--:--:--", 2, 1);
    }

    /* 日期 + 星期 */
    static const char *WD[7] = { "SUN","MON","TUE","WED","THU","FRI","SAT" };
    char dline[40];
    if (rtc_ok)
        snprintf(dline, sizeof(dline), "%04d-%02d-%02d %s", Y, Mo, D, WD[Wd % 7]);
    else
        snprintf(dline, sizeof(dline), "----/--/-- ---");
    draw_text(PANEL_X, 52, dline, 2, 1);

    /* 分隔线 */
    lcd_hline(PANEL_X, 72, PANEL_SEP_W, 1);

    int vx = PANEL_X + 76;               /* 数值列 */

    /* 天气：图标 + 标签 + 天气文字（+ 室外温度） */
    icon_weather(PANEL_X, 80, 24, weather_kind(info->weather), 1);
    draw_cjk(PANEL_X + 32, 84, "天气", 1, 1);
    if (info->weather[0]) {
        int wx;
        if (has_cjk(info->weather)) {
            draw_cjk(vx, 84, info->weather, 1, 1);
            wx = cjk_text_w(info->weather, 1);
        } else {
            draw_text(vx, 89, info->weather, 1, 1);
            wx = text_w(info->weather, 1);
        }
        if (info->weather_temp > -99 && info->weather_temp < 100 &&
            vx + wx + 4 + 30 <= LCD_W - 8) {
            char wt[24];
            snprintf(wt, sizeof(wt), " %d`C", info->weather_temp);
            draw_text(vx + wx + 4, 89, wt, 1, 1);
        }
    } else {
        draw_text(vx, 89, "--", 1, 1);
    }

    /* 温度 */
    icon_therm(PANEL_X, 114, 22, 1);
    draw_cjk(PANEL_X + 32, 116, "温度", 1, 1);
    char tb[32];
    if (t > -50 && t < 150) snprintf(tb, sizeof(tb), "%.1f`C", t);
    else                    snprintf(tb, sizeof(tb), "--`C");
    draw_text(vx, 116, tb, 2, 1);

    /* 湿度 */
    icon_drop(PANEL_X, 146, 22, 1);
    draw_cjk(PANEL_X + 32, 148, "湿度", 1, 1);
    char hb[16];
    if (h >= 0) snprintf(hb, sizeof(hb), "%d%%", (int)(h + 0.5f));
    else        snprintf(hb, sizeof(hb), "--%%");
    draw_text(vx, 148, hb, 2, 1);

    /* 电量 */
    icon_battery(PANEL_X, 178, 26, bat, 1);
    draw_cjk(PANEL_X + 32, 180, "电量", 1, 1);
    char bb[16];
    snprintf(bb, sizeof(bb), "%d%%", bat);
    draw_text(vx, 180, bb, 2, 1);

    /* 底部状态：字幕 / 连接状态 */
    lcd_hline(PANEL_X, 212, PANEL_SEP_W, 1);
    if (s_sub[0])
        draw_text(PANEL_X, 222, s_sub, 1, 1);
}

/* ── 渲染 ──────────────────────────────────────────────────────────── */

void ui_render(void)
{
    if (s_page == UI_PAGE_FUNC) {
        lcd_clear(0);
        draw_cjk((LCD_W - 4 * 32) / 2, 110, "敬请期待", 2, 1);
        draw_text((LCD_W - text_w("COMING SOON", 2)) / 2, 170,
                  "COMING SOON", 2, 1);
        lcd_flush();
        return;                          /* 5 秒后回主页由 main 的 tick 判断 */
    }

    /* ── 主页 ── */
    lcd_clear(0);
    draw_pet();
    render_panel();
    lcd_flush();
}
