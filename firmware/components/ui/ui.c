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
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "lcd.h"
#include "font5x7.h"
#include "font_cjk.h"
#include "pet_frames.h"
#include "sensors.h"
#include "pcf85063.h"
#include "wifi_sta.h"

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
        if (cp < 0x80) {             /* ASCII：用 5x7 小点阵居中填进 16px 格（数字/字母不再空白） */
            char tmp[2] = { (char)cp, 0 };
            draw_text(x + (11 * scale) / 2, y + (9 * scale) / 2, tmp, scale, ink);
            x += 16 * scale;
            continue;
        }
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

/* 0..9 的七段码：bit0..bit6 = A(上) B(右上) C(右下) D(下) E(左下) F(左上) G(中) */
static const uint8_t SEG[10] = { 0x3F, 0x06, 0x5B, 0x4F, 0x66, 0x6D, 0x7D, 0x07, 0x7F, 0x6F };

static void seg_digit(int x, int y, int d, int h, int ink)
{
    int t = h / 8 + 1;                   /* 笔画厚度 */
    int w = h / 2 + t;                   /* 单个数字宽 */
    int a[7][4] = {                      /* A B C D E F G 的矩形 */
        { t, 0,             w - 2 * t, t },        /* A 上 */
        { w - t, t,         t, h / 2 - t },        /* B 右上 */
        { w - t, h / 2,     t, h / 2 - t },        /* C 右下（紧接 B，不留缝）*/
        { t, h - t,         w - 2 * t, t },        /* D 下 */
        { 0, h / 2,         t, h / 2 - t },        /* E 左下（紧接 F，不留缝）*/
        { 0, t,             t, h / 2 - t },        /* F 左上 */
        { t, h / 2 - t / 2, w - 2 * t, t },        /* G 中 */
    };
    uint8_t mask = SEG[d & 0x0F];
    for (int s = 0; s < 7; s++) {
        if (!(mask & (0x01 << s))) continue;       /* SEG 表 bit0..bit6 = A..G */
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

/** 7 段串的像素宽度（用于居中） */
static int seg_time_w(const char *s, int h)
{
    int t = h / 8 + 1;
    int w = h / 2 + t;
    int gap = h / 10 + 1;
    int total = 0;

    for (; *s; s++) {
        if (*s == ':')                     total += t + gap;
        else if (*s >= '0' && *s <= '9')   total += w + gap;
    }
    return total > 0 ? total - gap : 0;    /* 去掉末尾的间隔 */
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

typedef enum { PET_IDLE, PET_BLINK, PET_LISTENING, PET_THINKING, PET_SPEAKING } pet_state_t;

static pet_state_t s_pet = PET_IDLE;
static int s_frame_idx = 0;
static int s_blink_phase = 0;
static ui_voice_t s_voice = UI_VOICE_NONE;

/* Lua 画布（M5）：帧缓冲互斥 + 停止周期重绘的"保鲜"窗口 + 桌宠表情覆盖 */
static SemaphoreHandle_t s_fb_lock;
static uint32_t s_lua_hold_until;
static int s_lua_frame = -1;             /* ≥0 = 脚本指定的桌宠帧 */
static int s_lua_frame_prev = -2;
static uint32_t s_lua_rel_seq;           /* release 自增序号（执行期让位检测用） */

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
    /* 脚本指定的表情优先（说话/聆听等语音状态下让位给语音状态机） */
    int fi = (s_voice == UI_VOICE_NONE && s_lua_frame >= 0) ? s_lua_frame : s_frame_idx;
    if (fi < 0 || fi >= PET_FRAME_COUNT) fi = 0;
    const uint8_t *frame = PET_NAMES[fi];
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
    case PET_LISTENING: s_frame_idx = 2; break;
    case PET_THINKING: s_frame_idx = 3; break;
    case PET_SPEAKING: s_frame_idx = 4; break;
    }
}

/* ── 页面 ──────────────────────────────────────────────────────────── */

static ui_page_t s_page = UI_PAGE_HOME;
static int s_busy = 0;
static char s_sub[512] = "";             /* 一句话最长 ~170 字（UTF-8 最多 3B/字） */
static char s_portal_ap[32] = "";

void ui_init(void)
{
    lcd_init();
    if (!s_fb_lock) s_fb_lock = xSemaphoreCreateMutex();
}
void ui_set_page(ui_page_t p) { s_page = p; }
ui_page_t ui_get_page(void) { return s_page; }
void ui_set_busy(int busy) { s_busy = busy; }
void ui_set_voice(ui_voice_t v) { s_voice = v; }
void ui_show_portal(const char *ap_ssid)
{
    strlcpy(s_portal_ap, ap_ssid ? ap_ssid : "", sizeof(s_portal_ap));
    s_page = UI_PAGE_PORTAL;
}
void ui_set_sub(const char *text)
{
    strncpy(s_sub, text ? text : "", sizeof(s_sub) - 1);
    s_sub[sizeof(s_sub) - 1] = 0;
}

int ui_sub_pages(const char *text)
{
    if (!text) return 0;
    int n = 0;
    const char *p = text;
    while (*p) { utf8_next(&p); n++; }
    return (n + 23) / 24;                    /* 每页 24 字（16px/字，整行全宽） */
}

void ui_set_sub_page(const char *text, int page)
{
    if (!text || page < 0) { ui_set_sub(""); return; }
    const char *p = text;
    for (int i = 0; i < page * 24 && *p; i++) utf8_next(&p);
    const char *q = p;
    int n = 0;
    while (*q && n < 24) { utf8_next(&q); n++; }
    size_t len = (size_t)(q - p);
    if (len >= sizeof(s_sub)) len = sizeof(s_sub) - 1;
    memcpy(s_sub, p, len);
    s_sub[len] = 0;
}

int ui_tick(uint32_t now)
{
    pet_state_t prev_state = s_pet;
    int prev_idx = s_frame_idx;

    s_pet = (s_voice == UI_VOICE_LISTENING) ? PET_LISTENING :
            (s_voice == UI_VOICE_THINKING)  ? PET_THINKING  :
            (s_voice == UI_VOICE_SPEAKING)  ? PET_SPEAKING  :
            (s_busy ? PET_THINKING : PET_IDLE);
    pet_tick(now);

    int changed = (s_pet != prev_state) || (s_frame_idx != prev_idx) ||
                  (s_lua_frame != s_lua_frame_prev);
    s_lua_frame_prev = s_lua_frame;
    return changed;
}

/* ── 主页右栏 ──────────────────────────────────────────────────────── */

/** 天气行标签：用服务器配置的城市名（最多 2 个字），没下发就显示「天气」 */
static void city_label(char *dst, size_t n, const char *city)
{
    if (!city || !city[0]) { snprintf(dst, n, "%s", "天气"); return; }
    const char *p = city, *end = city;
    int cnt = 0;
    while (*p && cnt < 2) { utf8_next(&p); cnt++; end = p; }
    size_t len = (size_t)(end - city);
    if (len > n - 1) len = n - 1;
    memcpy(dst, city, len);
    dst[len] = 0;
}

/** 底部状态行：左边中文标签 + 右侧对齐的状态文字 */
static void status_row(int y, const char *label, const char *value)
{
    if (has_cjk(label)) draw_cjk(PANEL_X + 4, y, label, 1, 1);
    else                draw_text(PANEL_X + 4, y + 5, label, 1, 1);
    draw_cjk(PANEL_X + PANEL_SEP_W - cjk_text_w(value, 1) - 4, y, value, 1, 1);
}

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

    /* 时钟：HH:MM:SS（RTC），居中放大 */
    int Y = 0, Mo = 0, D = 0, Wd = 0, H = 0, Mi = 0, S = 0;
    int rtc_ok = (pcf85063_get(&Y, &Mo, &D, &Wd, &H, &Mi, &S) == 0);

    if (rtc_ok) {
        char tbuf[24];
        snprintf(tbuf, sizeof(tbuf), "%02d:%02d:%02d", H, Mi, S);
        int sw = seg_time_w(tbuf, 38);
        seg_time(PANEL_X + (PANEL_SEP_W - sw) / 2, 6, tbuf, 38, 1);
    } else {
        draw_text(PANEL_X + (PANEL_SEP_W - text_w("--:--:--", 2)) / 2, 18,
                  "--:--:--", 2, 1);
    }

    /* 日期 + 星期：左右分栏 */
    static const char *WD[7] = { "SUN","MON","TUE","WED","THU","FRI","SAT" };
    if (rtc_ok) {
        char db[40], wb[16];
        snprintf(db, sizeof(db), "%04d-%02d-%02d", Y, Mo, D);
        snprintf(wb, sizeof(wb), "%s", WD[Wd % 7]);
        draw_text(PANEL_X, 50, db, 2, 1);
        draw_text(PANEL_X + PANEL_SEP_W - text_w(wb, 2), 50, wb, 2, 1);
    } else {
        draw_text(PANEL_X, 50, "----/--/--", 2, 1);
        draw_text(PANEL_X + PANEL_SEP_W - text_w("---", 2), 50, "---", 2, 1);
    }

    /* 分隔线 */
    lcd_hline(PANEL_X, 72, PANEL_SEP_W, 1);

    int vx = PANEL_X + 76;               /* 数值列 */

    /* 天气：图标 + 城市标签 + 天气文字（1 倍）+ 气温（2 倍） */
    icon_weather(PANEL_X, 80, 24, weather_kind(info->weather), 1);
    char city[16];
    city_label(city, sizeof(city), info->city);
    if (has_cjk(city)) draw_cjk(PANEL_X + 32, 84, city, 1, 1);
    else               draw_text(PANEL_X + 32, 89, city, 1, 1);

    /* 天气文字保持 1 倍（和城市标签同高），气温 2 倍（和其他数值同规格） */
    const char *wtext = info->weather[0] ? info->weather : "--";
    char wtemp[16] = "";
    if (info->weather_temp > -99 && info->weather_temp < 100)
        snprintf(wtemp, sizeof(wtemp), " %d`C", info->weather_temp);

    int ww1 = has_cjk(wtext) ? cjk_text_w(wtext, 1) : text_w(wtext, 1);
    if (has_cjk(wtext)) draw_cjk(vx, 84, wtext, 1, 1);
    else                draw_text(vx, 89, wtext, 1, 1);

    if (wtemp[0]) {
        if (vx + ww1 + text_w(wtemp, 2) <= PANEL_X + PANEL_SEP_W)
            draw_text(vx + ww1, 84, wtemp, 2, 1);
        else
            draw_text(vx + ww1, 89, wtemp, 1, 1);          /* 实在放不下才降到 1 倍 */
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

    /* 电量（图标和文字视线对齐：文字墨迹 182..194，图标同高） */
    icon_battery(PANEL_X, 182, 26, bat, 1);
    draw_cjk(PANEL_X + 32, 180, "电量", 1, 1);
    char bb[16];
    snprintf(bb, sizeof(bb), "%d%%", bat);
    draw_text(vx, 180, bb, 2, 1);

    /* 底部：连接状态（WiFi / 服务器 / 蓝牙）+ 字幕 */
    lcd_hline(PANEL_X, 212, PANEL_SEP_W, 1);
    status_row(222, "WiFi", wifi_sta_connected() ? "已连接" : "未连接");
    status_row(242, "服务器", ws_connected() ? "已连接" : "未连接");
    status_row(262, "蓝牙", "未启用");
    if (s_sub[0]) {
        /* 字幕：整行全宽放在桌宠下方（16px/字），最多 24 字（超出截断），居中显示。
         * 原来只画右栏 11 字——长句"看起来缺字"就有它一份。 */
        const char *p = s_sub;
        int cnt = 0;
        while (*p && cnt < 24) { utf8_next(&p); cnt++; }
        size_t blen = (size_t)(p - s_sub);
        char line[80];
        if (blen > sizeof(line) - 1) blen = sizeof(line) - 1;
        memcpy(line, s_sub, blen);
        line[blen] = 0;
        draw_cjk((LCD_W - cnt * 16) / 2, 284, line, 1, 1);
    }
}

/* ── 渲染 ──────────────────────────────────────────────────────────── */

static void render_frame(void)
{
    if (s_page == UI_PAGE_PORTAL) {
        lcd_clear(0);
        const char *t1 = "配网模式";
        draw_cjk((LCD_W - cjk_text_w(t1, 2)) / 2, 30, t1, 2, 1);
        const char *t2 = "手机连接热点";
        draw_cjk((LCD_W - cjk_text_w(t2, 2)) / 2, 84, t2, 2, 1);
        draw_text((LCD_W - text_w(s_portal_ap, 2)) / 2, 138, s_portal_ap, 2, 1);
        const char *t3 = "浏览器打开";
        draw_cjk((LCD_W - cjk_text_w(t3, 1)) / 2, 176, t3, 1, 1);
        draw_text((LCD_W - text_w("192.168.4.1", 3)) / 2, 200, "192.168.4.1", 3, 1);
        lcd_flush();
        return;
    }

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

    /* 语音状态字（桌宠区顶部居中）：录音中 / 思考中 / 说话中 */
    static const char *VOICE_TXT[] = { "", "录音中", "思考中", "说话中" };
    if (s_voice != UI_VOICE_NONE) {
        const char *vt = VOICE_TXT[s_voice];
        draw_cjk((PET_W - cjk_text_w(vt, 1)) / 2, 0, vt, 1, 1);
    }

    render_panel();
    lcd_flush();
}

void ui_render(void)
{
    if (s_fb_lock) xSemaphoreTake(s_fb_lock, portMAX_DELAY);
    render_frame();
    if (s_fb_lock) xSemaphoreGive(s_fb_lock);
}

/* ── Lua 画布（M5）─────────────────────────────────────────────────── */

#define LUA_HOLD_MS 30000

static uint32_t now_ms_(void)
{
    return (uint32_t)(xTaskGetTickCount() * portTICK_PERIOD_MS);
}

/** 保鲜：每次脚本绘制都把"停止周期重绘"的窗口往后推 30 秒。
 *  脚本只画一次 → 30 秒后主页自然回来（不会把界面卡死）。
 *  同时把当前页锚回主页：画布只存在于主页层（hold_active 的页守卫、
 *  关画布后回主页都依赖这一点）。否则在"敬请期待"页双击打开画布时，
 *  页守卫让画布没有保鲜保护——下一秒整页重绘就把画布顶掉（闪一下又回来）。
 *  注意先写页再写计时：让 hold_active 的页条件先成立。 */
static void lua_keepalive(void)
{
    s_page = UI_PAGE_HOME;
    s_lua_hold_until = now_ms_() + LUA_HOLD_MS;
}

int ui_lua_hold_active(void)
{
    if (s_voice != UI_VOICE_NONE || s_page != UI_PAGE_HOME) return 0;
    return (int32_t)(s_lua_hold_until - now_ms_()) > 0;
}

void ui_lua_release(void)
{
    s_lua_hold_until = 0;
    s_lua_frame = -1;
    s_lua_rel_seq++;
}

uint32_t ui_lua_release_seq(void)
{
    return s_lua_rel_seq;
}

void ui_lua_clear(void)
{
    lua_keepalive();
    if (s_fb_lock) xSemaphoreTake(s_fb_lock, portMAX_DELAY);
    lcd_clear(0);
    if (s_fb_lock) xSemaphoreGive(s_fb_lock);
}

void ui_lua_text(int x, int y, const char *s, int size)
{
    lua_keepalive();
    if (!s || !*s) return;

    char tmp[1025];
    if (strlen(s) > 1024) {              /* 画不下那么多，防拖慢/越界 */
        memcpy(tmp, s, 1024);
        tmp[1024] = 0;
        s = tmp;
    }
    if (y < 0 || y >= LCD_H) return;
    if (x >= LCD_W || x < -32) return;

    int asc = size >= 24 ? 3 : 2;        /* ASCII：字高 ~7*scale */
    int csc = size >= 24 ? 2 : 1;        /* 中文：16*scale */
    if (s_fb_lock) xSemaphoreTake(s_fb_lock, portMAX_DELAY);
    if (has_cjk(s)) draw_cjk(x, y, s, csc, 1);
    else            draw_text(x, y, s, asc, 1);
    if (s_fb_lock) xSemaphoreGive(s_fb_lock);
}

void ui_lua_rect(int x, int y, int w, int h, int filled)
{
    lua_keepalive();
    if (w <= 0 || h <= 0) return;
    if (x >= LCD_W || y >= LCD_H) return;
    int x0 = x < 0 ? 0 : x;
    int y0 = y < 0 ? 0 : y;
    int cw = w, ch = h;
    if (cw > LCD_W - x0) cw = LCD_W - x0;    /* 关键：先夹住尺寸，否则 lcd_fill 死循环 */
    if (ch > LCD_H - y0) ch = LCD_H - y0;
    if (cw <= 0 || ch <= 0) return;
    if (s_fb_lock) xSemaphoreTake(s_fb_lock, portMAX_DELAY);
    if (filled) lcd_fill(x0, y0, cw, ch, 1);
    else        lcd_rect(x0, y0, cw, ch, 1);
    if (s_fb_lock) xSemaphoreGive(s_fb_lock);
}

void ui_lua_flush(void)
{
    lua_keepalive();
    if (s_fb_lock) xSemaphoreTake(s_fb_lock, portMAX_DELAY);
    lcd_flush();
    if (s_fb_lock) xSemaphoreGive(s_fb_lock);
}

int ui_lua_pet_state(const char *name)
{
    if (!name) return 0;
    if (!strcmp(name, "auto")) {             /* 交还自动状态：脚本控制结束 */
        s_lua_frame = -1;
        return 1;
    }
    static const struct { const char *n; int idx; } names[] = {
        { "idle", 0 }, { "blink", 1 }, { "listening", 2 }, { "thinking", 3 },
        { "speaking", 4 }, { "happy", 5 }, { "love", 6 }, { "confused", 7 },
        { "sleepy", 8 }, { "sleeping", 9 }, { "salute", 10 }, { "direct", 11 },
        { "patrol", 12 }, { "note", 13 }, { "charging", 14 },
    };
    for (size_t i = 0; i < sizeof(names) / sizeof(names[0]); i++) {
        if (!strcmp(name, names[i].n)) {
            s_lua_frame = names[i].idx;
            return 1;
        }
    }
    return 0;
}
