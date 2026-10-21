/**
 * main.c — MyEsp32 固件入口
 *
 * 启动顺序：NVS → 传感器 → 屏幕 → WiFi（连不上/长按 KEY → 配网门户）→ WebSocket → 按键 → 主循环
 *
 * 主循环职责：
 *   - 每秒刷新主页（时钟走字）
 *   - 处理按键（KEY 翻页 + 功能页 5 秒回主页）
 *   - 处理服务器事件（info 到达时重绘）
 */

#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_attr.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "nvs_flash.h"

#include "hw_config.h"
#include "lcd.h"
#include "buttons.h"
#include "sensors.h"
#include "pcf85063.h"
#include "wifi_sta.h"
#include "wifi_cfg.h"
#include "wifi_portal.h"
#include "ws_client.h"
#include "ui.h"
#include "audio.h"
#include "wake.h"
#include "ble.h"
#include "lua_runtime.h"

static const char *TAG = "main";

static volatile int s_dirty = 1;        /* 需要重绘 */

/* 长按 BOOT 触发的"重启进重置门户"标记：RTC 内存跨软件重启保留，
 * 不占用已经耗尽的内部堆（NVS 写失败也不影响）。 */
#define BOOT_PORTAL_MAGIC 0x504F5254u   /* "PORT" */
RTC_NOINIT_ATTR static uint32_t s_boot_portal_flag;

/* ── 语音状态机（M4）───────────────────────────────────────────────── */

typedef enum { VOICE_IDLE = 0, VOICE_REC, VOICE_THINK, VOICE_SPEAK } voice_state_t;

static voice_state_t s_voice_state = VOICE_IDLE;
static int s_key_down_at = -1;          /* KEY 按下时刻（ms）；-1 = 未按 */
static int s_boot_down_at = -1;         /* BOOT 按下时刻（ms）；长按 8 秒进重置模式 */
static int s_key_voice = 0;             /* 本次按键已触发录音（防重复） */
static int s_voice_deadline = 0;        /* 思考阶段超时保护 */
static int s_sub_clear_at = 0;          /* 字幕延迟清除时刻 */
static uint32_t s_vol_clear_at = 0;     /* 音量浮层清除时刻 */
static uint32_t s_bt_clear_at = 0;      /* 蓝牙状态浮层清除时刻 */
static int s_rec_started_at = 0;        /* 进入录音的时刻（ms）；录音硬上限兜底 */
static int s_rec_auto_mode = 0;         /* 本次录音是自动聆听（VAD 收尾）还是手动长按 */

/* ── 字幕按播放进度显示 ──────────────────────────────────────────────
 * 服务器为了让设备端有缓冲，发帧比实时快（字幕消息也随之提前 ~2 秒到）。
 * 直接显示会"音画不同步"——把字幕连同「收到时的已入队帧数」入队，
 * 主循环里等播放帧计数追上再显示。 */
#define SUB_MAX   512
#define SUBQ_MAX  12

typedef struct {
    char text[SUB_MAX];
    int  at_frame;                  /* 本条字幕句子的首帧序号（收到时已入队帧数） */
    int  n_frames;                  /* 该句总帧数（服务器下发；0=未知，不翻页） */
} sub_item_t;

static sub_item_t s_subq[SUBQ_MAX];
static int s_subq_head = 0, s_subq_tail = 0;

static void subq_clear(void) { s_subq_head = s_subq_tail = 0; }

/* 当前正在播放的句子：长句超过一页（24 字）时按播放进度翻页 */
static char s_sub_cur[SUB_MAX] = "";
static int  s_sub_cur_at = 0;           /* 该句首帧序号 */
static int  s_sub_cur_frames = 0;       /* 该句总帧数（0=不翻页） */
static int  s_sub_cur_page = 0;         /* 当前显示到第几页 */
static void sub_cur_clear(void)
{
    s_sub_cur[0] = 0;
    s_sub_cur_at = s_sub_cur_frames = s_sub_cur_page = 0;
}

static void subq_push(const char *text, int at_frame, int n_frames)
{
    int next = (s_subq_tail + 1) % SUBQ_MAX;
    if (next == s_subq_head)                       /* 满：丢最旧 */
        s_subq_head = (s_subq_head + 1) % SUBQ_MAX;
    sub_item_t *it = &s_subq[s_subq_tail];
    snprintf(it->text, SUB_MAX, "%s", text ? text : "");
    it->at_frame = at_frame;
    it->n_frames = n_frames;
    s_subq_tail = next;
}

static int now_ms(void) { return (int)(xTaskGetTickCount() * portTICK_PERIOD_MS); }

static int s_wake_greet = 0;      /* 正在播放唤醒提示音（播完直接进入自动聆听） */
static int s_followup = 0;        /* 本轮回答以问句收尾：播完自动开麦（连续对话） */
/** 播报期间收到的脚本事件（如"打开课表"）：语音优先让画布让位，
 *  先暂存，等回到空闲画布可见了再执行（见 voice_to） */
static char s_pending_evt[16] = "";

static uint32_t s_stat_at = 0;    /* 下次上报板载状态（电量/温湿度）的时刻（ms） */

static void voice_to(voice_state_t v)
{
    s_voice_state = v;
    ui_lua_release();                 /* 语音优先：脚本画布让位（脚本本身继续跑） */
    /* 空闲、播报中、思考中都听唤醒词（播报/思考中命中 → 用户优先：
     * 打断当前回答或放弃等待服务器，直接重开一轮）；
     * 录音中不听（录音里是用户自己的声音，会自触发） */
    wake_set_enabled(v == VOICE_IDLE || v == VOICE_SPEAK || v == VOICE_THINK);
    if (v != VOICE_REC) s_rec_started_at = 0;
    switch (v) {
    case VOICE_REC:   ui_set_voice(UI_VOICE_LISTENING); break;
    case VOICE_THINK: ui_set_voice(UI_VOICE_THINKING);  break;
    case VOICE_SPEAK: ui_set_voice(UI_VOICE_SPEAKING);  break;
    default:
        ui_set_voice(UI_VOICE_NONE);
        s_voice_deadline = 0;
        break;
    }
    s_dirty = 1;

    /* 播报期间暂存的脚本事件（如"打开课表"）：回空闲、画布可见了才执行 */
    if (v == VOICE_IDLE && s_pending_evt[0]) {
        ESP_LOGI(TAG, "执行暂存的脚本事件 %s", s_pending_evt);
        lua_runtime_event(s_pending_evt);
        s_pending_evt[0] = 0;
    }
}

static void voice_start_rec(void)
{
    if (!audio_ready()) { ESP_LOGW(TAG, "录音不可用：音频未就绪"); return; }
    if (!ws_connected()) { ESP_LOGW(TAG, "录音不可用：未连接服务器"); return; }

    ui_set_page(UI_PAGE_HOME);
    s_sub_clear_at = 0;
    ui_set_sub("");
    audio_rec_start();
    /* 开始消息发不出去（链路假死）→ 服务器根本收不到这段录音：
     * 直接不进录音态，别让用户对着"录音中"白等 */
    if (!ws_send_json("{\"t\":\"rec\",\"s\":\"start\"}")) {
        audio_rec_stop();
        ESP_LOGW(TAG, "录音开始消息发送失败，取消录音");
        ui_set_sub("网络忙，请稍后再试");
        s_dirty = 1;
        return;
    }
    voice_to(VOICE_REC);
    s_rec_auto_mode = 0;
    s_rec_started_at = now_ms();
    ESP_LOGI(TAG, "开始录音（松开 KEY 结束）");
}

/** 唤醒词触发后的自动聆听：VAD 判"说完"或超时后自动结束（不用按 KEY）。
 *  bargein=1：播报中打断进入（录音开头有喇叭尾音，VAD 会跳过几帧） */
static void voice_start_rec_auto(int bargein)
{
    if (!audio_ready() || !ws_connected()) { voice_to(VOICE_IDLE); return; }
    ui_set_page(UI_PAGE_HOME);
    s_sub_clear_at = 0;
    ui_set_sub("");
    audio_rec_start_auto(bargein);
    if (!ws_send_json("{\"t\":\"rec\",\"s\":\"start\"}")) {
        audio_rec_stop();
        ESP_LOGW(TAG, "自动聆听开始消息发送失败，取消");
        voice_to(VOICE_IDLE);
        ui_set_sub("网络忙，请稍后再试");
        s_dirty = 1;
        return;
    }
    voice_to(VOICE_REC);
    s_rec_auto_mode = 1;
    s_rec_started_at = now_ms();
    if (bargein) {
        ESP_LOGI(TAG, "打断后直接聆听（说完自动结束）");
    } else {
        ESP_LOGI(TAG, "自动聆听开始（说完自动结束）");
    }
}

static void voice_stop_rec(void)
{
    audio_rec_stop();
    /* 结束消息都发不出去 = 服务器收不到这段录音，等下去也等不到回答 */
    if (!ws_send_json("{\"t\":\"rec\",\"s\":\"stop\"}")) {
        ESP_LOGW(TAG, "录音结束消息发送失败，直接回空闲");
        voice_to(VOICE_IDLE);
        ui_set_sub("网络忙，这段没发出去");
        s_dirty = 1;
        return;
    }
    s_voice_deadline = now_ms() + 20000;
    voice_to(VOICE_THINK);
    ESP_LOGI(TAG, "结束录音，等服务器");
}

/** 没检测到有效说话：本地静默收尾 —— 不发录音、不说任何话。
 *  如果刚才是在播报中打断进来的，服务器看到 resume 会从断点续播。 */
static void voice_rec_void(void)
{
    audio_rec_stop();
    voice_to(VOICE_IDLE);                               /* 先回空闲，再通知服务器 */
    ws_send_json("{\"t\":\"rec\",\"s\":\"resume\"}");
}

/** 用户打断：停播放、清字幕与未显示队列，回空闲（随后 voice_start_rec 立即切到录音）。
 *  服务器收到新的 rec start 会作废上一轮回答（turn 失效），旧的迟到帧由
 *  on_ws_audio 的 REC/THINK 过滤丢弃。 */
static void voice_interrupt(void)
{
    s_wake_greet = 0;
    s_followup = 0;
    audio_play_stop();
    audio_rec_stop();
    subq_clear();
    sub_cur_clear();
    ui_set_sub("");
    s_sub_clear_at = 0;
    s_dirty = 1;
    voice_to(VOICE_IDLE);
}

/* ── 服务器校时 ────────────────────────────────────────────────────── */

/** 用服务器下发的 info 校准 RTC；偏差大于 90 秒才写，避免秒位被反复重置 */
static void sync_time_from_server(void)
{
    dev_info_t *in = ws_client_info();
    if (in->mm < 1 || in->mm > 12 || in->dd < 1 || in->dd > 31) return;

    int hh = 0, mi = 0;
    if (sscanf(in->time, "%d:%d", &hh, &mi) != 2) return;
    if (hh < 0 || hh > 23 || mi < 0 || mi > 59) return;

    int Y, Mo, D, Wd, H, M, S;
    if (pcf85063_get(&Y, &Mo, &D, &Wd, &H, &M, &S) != 0) return;   /* 年份沿用 RTC */

    if (Mo == in->mm && D == in->dd) {
        int rtc_sod = H * 3600 + M * 60 + S;
        int srv_sod = hh * 3600 + mi * 60;
        int diff = rtc_sod > srv_sod ? rtc_sod - srv_sod : srv_sod - rtc_sod;
        if (diff > 43200) diff = 86400 - diff;      /* 跨午夜 */
        if (diff <= 90) return;
    }

    if (pcf85063_set(Y, in->mm, in->dd, hh, mi, 0) == 0)
        ESP_LOGI(TAG, "RTC 校时 → %04d-%02d-%02d %02d:%02d", Y, in->mm, in->dd, hh, mi);
}

/* ── Lua 结果回执（M5）────────────────────────────────────────────── */

/** 把执行结果拼成 {"t":"lua","id":..,"ok":..,"out":".."} 发给服务器 */
static void on_lua_result(int id, bool ok, const char *out)
{
    const char *o = out ? out : "";
    size_t cap = strlen(o) * 6 + 96;          /* 最坏每字符转义成 \u00XX */
    char *buf = malloc(cap);
    if (!buf) return;
    size_t j = (size_t)snprintf(buf, cap, "{\"t\":\"lua\",\"id\":%d,\"ok\":%s,\"out\":\"",
                                id, ok ? "true" : "false");
    for (const unsigned char *p = (const unsigned char *)o; *p; p++) {
        const char *r = NULL;
        char e[8];
        switch (*p) {
        case '"':  r = "\\\""; break;
        case '\\': r = "\\\\"; break;
        case '\n': r = "\\n";  break;
        case '\r': r = "\\r";  break;
        case '\t': r = "\\t";  break;
        default:
            if (*p < 0x20) { snprintf(e, sizeof(e), "\\u%04x", *p); r = e; }
            break;
        }
        if (r) { size_t l = strlen(r); memcpy(buf + j, r, l); j += l; }
        else   { buf[j++] = (char)*p; }
    }
    buf[j++] = '"';
    buf[j++] = '}';
    buf[j] = 0;

    /* 热点/弱网下回执可能发送失败；重试 3 次，避免服务器把已执行的脚本判成失败 */
    int sent = 0;
    for (int i = 0; i < 3; i++) {
        if (ws_send_json(buf)) { sent = 1; break; }
        vTaskDelay(pdMS_TO_TICKS(100));
    }
    if (!sent) ESP_LOGW(TAG, "Lua#%d 回执发送失败（已重试 3 次）", id);

    free(buf);
}

/* ── 板载状态上报（电量/温湿度）────────────────────────────────────── */

/** 上报一次板载状态：{"t":"stat","bat":87,"room":{"t":25.3,"h":55.1}}
 *  （语音助手答"电量/室温/蓝牙"要用；温湿度读失败就只发电量）
 *  bn = BLE 广播名（协议栈起来之后才有）：助手能直接告诉用户手机里搜什么名字 */
static void stat_send(void)
{
    int bat = sensors_battery_pct();
    char msg[256];
    char ip[20];
    wifi_sta_ip(ip, sizeof(ip));
    int rssi = wifi_sta_rssi();
    int vol = audio_volume_get();
    int bt = (int)ble_state();
    int up = (int)(esp_timer_get_time() / 1000000);
    const char *bn = ble_name();
    char bn_part[32] = "";
    if (bn[0]) snprintf(bn_part, sizeof(bn_part), "\"bn\":\"%s\",", bn);

    /* SSID 是用户/配网页填的，转义掉会破坏 JSON 的字符（只用于展示） */
    char ssid[40];
    wifi_sta_ssid(ssid, sizeof(ssid));
    for (char *p = ssid; *p; p++)
        if (*p == '"' || *p == '\\' || (unsigned char)*p < 0x20) *p = '?';
    char net_part[64];
    snprintf(net_part, sizeof(net_part), "\"ssid\":\"%s\",", ssid);

    float t = 0, h = 0;
    if (sensors_read_th(&t, &h) == ESP_OK) {
        int t10 = (int)(t * 10 + (t >= 0 ? 0.5f : -0.5f));
        int h10 = (int)(h * 10 + 0.5f);
        int tf = t10 % 10, hf = h10 % 10;
        if (tf < 0) tf = -tf;
        if (hf < 0) hf = -hf;
        snprintf(msg, sizeof(msg),
                 "{\"t\":\"stat\",\"bat\":%d,\"vol\":%d,\"bt\":%d,\"rssi\":%d,\"up\":%d,"
                 "\"ip\":\"%s\",%s%s\"room\":{\"t\":%d.%d,\"h\":%d.%d}}",
                 bat, vol, bt, rssi, up, ip, net_part, bn_part, t10 / 10, tf, h10 / 10, hf);
    } else {
        snprintf(msg, sizeof(msg),
                 "{\"t\":\"stat\",\"bat\":%d,\"vol\":%d,\"bt\":%d,\"rssi\":%d,\"up\":%d,"
                 "\"ip\":\"%s\",%s%s\"noroom\":1}",
                 bat, vol, bt, rssi, up, ip, net_part, bn_part);
    }
    ws_send_json(msg);
}

/** 音量变化后的屏幕反馈（BOOT 和语音指令共用） */
static void volume_feedback(void)
{
    ui_volume_overlay(audio_volume_get());
    s_vol_clear_at = now_ms() + 1500;
    s_dirty = 1;
}

/* ── 服务器事件 → UI ───────────────────────────────────────────────── */

static void on_ws_event(const ws_event_t *ev)
{
    switch (ev->kind) {
    case WS_EVT_INFO:
        sync_time_from_server();
        s_dirty = 1;
        break;
    case WS_EVT_SUB: {
        /* 服务器发帧领先声音约 2 秒（缓冲），字幕消息也是提前到的——
         * 先记下「收到时已入队帧数」，等对应首帧真的播出去再显示（主循环里处理） */
        int pushed = 0;
        audio_play_stats(&pushed, NULL);
        subq_push(ev->text, pushed, ev->frames);
        break;
    }
    case WS_EVT_STT:
        s_dirty = 1;
        break;
    case WS_EVT_LUA:
        if (!ev->lua_code) {
            char m[128];
            snprintf(m, sizeof(m),
                     "{\"t\":\"lua\",\"id\":%d,\"ok\":false,"
                     "\"out\":\"脚本缺失或过长（上限 6KB）\"}", ev->lua_id);
            ws_send_json(m);
        } else {
            lua_runtime_deploy(ev->lua_id, ev->lua_code);
        }
        break;
    case WS_EVT_PAGE: {
        /* 设备是页面唯一权威（服务器不再下发翻页）；仅认 "home" 兜底 */
        if (strcmp(ev->name, "home") == 0) ui_set_page(UI_PAGE_HOME);
        s_dirty = 1;
        break;
    }
    case WS_EVT_EVT:
        /* 服务器下发的脚本事件（助手技能，如 open_timetable）：
         * 空闲 → 直接交给脚本；语音中 → 暂存，播完回空闲再执行
         * （语音优先级更高，画布此刻会被让位清掉） */
        if (!ev->name[0]) break;

        /* 音量指令立即生效（不影响当前播报），并复用 BOOT 的浮层反馈 */
        if (!strcmp(ev->name, "volume_up"))     { audio_volume_up();     volume_feedback(); break; }
        if (!strcmp(ev->name, "volume_down"))   { audio_volume_down();   volume_feedback(); break; }
        if (!strcmp(ev->name, "volume_mute"))   { audio_volume_mute();   volume_feedback(); break; }
        if (!strcmp(ev->name, "volume_unmute")) { audio_volume_unmute(); volume_feedback(); break; }
        if (!strcmp(ev->name, "volume_set"))    { audio_volume_set(ev->value); volume_feedback(); break; }

        /* BLE 开关：立即生效，状态变化会触发一次 stat */
        if (!strcmp(ev->name, "bt_on"))  { ble_set_enabled(1); s_stat_at = 0; s_dirty = 1; break; }
        if (!strcmp(ev->name, "bt_off")) { ble_set_enabled(0); s_stat_at = 0; s_dirty = 1; break; }

        if (s_voice_state == VOICE_IDLE) {
            lua_runtime_event(ev->name);
        } else {
            snprintf(s_pending_evt, sizeof(s_pending_evt), "%s", ev->name);
            ESP_LOGI(TAG, "脚本事件 %s 暂存（播报结束后执行）", ev->name);
        }
        break;
    case WS_EVT_CONNECTED:
        s_stat_at = 0;                   /* 连上先补报一次板载状态 */
        s_dirty = 1;
        break;
    case WS_EVT_TTS_START:
        s_followup = 0;                  /* 新一轮回答开始：上一次的连续对话标记作废 */
        audio_play_reset();
        subq_clear();
        sub_cur_clear();
        s_sub_clear_at = 0;
        ui_set_sub("");
        if (s_voice_state != VOICE_REC) voice_to(VOICE_SPEAK);
        s_dirty = 1;
        break;
    case WS_EVT_TTS_STOP:
        s_followup = ev->followup;       /* 问句收尾 → 播完自动聆听（连续对话） */
        audio_play_finish();
        break;
    case WS_EVT_ERROR:
        ESP_LOGW(TAG, "服务器错误: %s", ev->text);
        sub_cur_clear();
        ui_set_sub(ev->text);
        s_dirty = 1;
        break;
    case WS_EVT_DISCONNECTED:
        audio_play_stop();
        audio_rec_stop();
        subq_clear();
        sub_cur_clear();
        ui_set_sub("");
        s_sub_clear_at = 0;
        s_key_down_at = -1;
        if (s_voice_state != VOICE_IDLE) voice_to(VOICE_IDLE);
        s_dirty = 1;
        break;
    default:
        break;
    }
}

/* ── 按键 → 脚本 ───────────────────────────────────────────────────── */

/* KEY 短按：固件不做任何内置动作（不翻页、不关画布）——"进入 / 切换 / 关闭"
 * 全部由脚本决定：脚本用 display.* 画、display.close() 关。
 * 脚本注册了 key_double 时，本动作要等 ~300ms 双击窗口裁决后才执行。 */
static void key_click_action(void)
{
    char msg[64];
    snprintf(msg, sizeof(msg), "{\"t\":\"btn\",\"k\":\"key\",\"e\":\"click\",\"p\":\"%s\"}",
             ui_get_page() == UI_PAGE_HOME ? "home" : "portal");
    ws_send_json(msg);
    lua_runtime_event("key_click");
    ESP_LOGI(TAG, "KEY → 脚本");
}

static void on_button(btn_id_t id, btn_event_t ev)
{
    /* 诊断日志：每个按键事件都打一行（含按下/松开/双击，看长按短按） */
    ESP_LOGI(TAG, "btn %s %s", id == BTN_KEY ? "KEY" : "BOOT",
             ev == BTN_DOWN ? "down" : ev == BTN_CLICK ? "click" :
             ev == BTN_DOUBLE ? "double" : "up");

    if (id == BTN_KEY) {
        if (ev == BTN_DOWN) {
            s_key_down_at = now_ms();
            s_key_voice = 0;
        } else if (ev == BTN_UP) {
            /* 长按录音：松手结束（事件顺序：短按先 CLICK 再 UP）；
             * 松手时没检测到有效说话 → 静默收尾（不发录音、不说"没听清"） */
            if (s_voice_state == VOICE_REC) {
                if (audio_rec_heard_speech()) {
                    voice_stop_rec();
                } else {
                    ESP_LOGI(TAG, "松开 KEY 但没检测到说话 → 静默收尾");
                    voice_rec_void();
                }
            }
            s_key_down_at = -1;
        } else if (ev == BTN_CLICK) {                   /* 短按 → 脚本（进入/切换） */
            if (s_voice_state != VOICE_IDLE) return;    /* 语音中不进功能 */
            key_click_action();
        } else {                                        /* BTN_DOUBLE：脚本事件 */
            if (s_voice_state != VOICE_IDLE) return;
            ESP_LOGI(TAG, "KEY 双击 → lua 事件");
            lua_runtime_event("key_double");
        }
    } else {                                            /* BOOT：短按=音量循环；长按 8 秒=WiFi 重置 */
        if (ev == BTN_DOWN) {
            s_boot_down_at = now_ms();
        } else if (ev == BTN_UP) {
            s_boot_down_at = -1;
        } else if (ev == BTN_CLICK) {
            audio_volume_cycle();
            volume_feedback();
        }
    }
}

/** BOOT 长按 8 秒 → 等松开后重启进入 WiFi 重置模式。
 *  不能在当前进程里原地开 SoftAP：服务器长时间不可达时 WS 重连会把内部堆
 *  耗到 1~2KB，WiFi 驱动分配 beacon 缓冲失败直接 LoadProhibited panic。
 *  重启后在干净堆上只初始化屏幕 + 配网门户，AP 才能稳定起来。 */
static void enter_portal_mode(void)
{
    ESP_LOGW(TAG, "BOOT 长按 8 秒 → 松开后重启进入 WiFi 重置模式");
    s_boot_down_at = -1;

    voice_to(VOICE_IDLE);
    wake_set_enabled(0);
    audio_play_stop();
    audio_rec_stop();
    subq_clear();
    sub_cur_clear();
    ui_volume_overlay(-1);
    s_vol_clear_at = 0;
    ui_bt_overlay(-1);
    s_bt_clear_at = 0;
    ui_lua_release();
    ui_set_sub("松开 BOOT 进入重置模式");
    ui_render();

    /* 等 BOOT 真正松开：重启瞬间 GPIO0 仍为低会让 ROM 进下载模式。
     * 连续 200ms 高电平才算松开（消抖）。 */
    int released = 0;
    while (released < 4) {
        if (gpio_get_level(BOOT_BTN_PIN)) released++;
        else released = 0;
        vTaskDelay(pdMS_TO_TICKS(50));
    }

    s_boot_portal_flag = BOOT_PORTAL_MAGIC;
    ESP_LOGW(TAG, "BOOT 已松开，重启进入重置模式");
    esp_restart();
}

/* ── 主循环 ────────────────────────────────────────────────────────── */

static void main_loop(void)
{
    /* 开机即空闲态，但 s_voice_state 是静态初始化成 IDLE 的、没走过 voice_to()，
     * 而唤醒使能只在 voice_to() 里打开——这里补一次，否则开机后首次语音唤醒
     * 不生效（要等一轮 KEY 对话结束回到 IDLE 后才被顺带打开）。 */
    voice_to(VOICE_IDLE);

    TickType_t last = xTaskGetTickCount();
    for (;;) {
        uint32_t now = (uint32_t)(xTaskGetTickCount() * portTICK_PERIOD_MS);

        /* BOOT 长按 8 秒 → 重启进 WiFi 重置模式。
         * 有符号差值：按键任务可能在本轮 now 之后才记录按下时刻。 */
        if (s_boot_down_at >= 0 &&
            (int32_t)(now - (uint32_t)s_boot_down_at) >= 8000)
            enter_portal_mode();

        /* 脚本注册了 key_double → 打开按键双击识别（单击上报延迟 ~300ms 裁决）；
         * 没有脚本关心时立刻关掉，单击行为回到即时。
         * 框架脚本只绑 key_click（单击 = 进入/切换/关闭），所以单击即时无延迟。 */
        {
            static int s_dbl_evt_on = 0;
            int want_dbl = lua_runtime_has_event("key_double");
            if (want_dbl != s_dbl_evt_on) {
                s_dbl_evt_on = want_dbl;
                buttons_set_double(want_dbl);
                ESP_LOGI(TAG, "key_double 事件 %s",
                         want_dbl ? "启用（单击延迟 300ms 裁决）" : "停用");
            }
        }

        /* KEY 长按 350ms → 开始录音（短按单击进功能不受影响）；
         * 说话/思考中长按 = 用户优先：打断当前回答，直接开始新提问 */
        if (s_key_down_at >= 0 && !s_key_voice && s_voice_state != VOICE_REC &&
            now - (uint32_t)s_key_down_at >= 350) {
            s_key_voice = 1;
            if (s_voice_state == VOICE_SPEAK || s_voice_state == VOICE_THINK) {
                ESP_LOGI(TAG, "用户打断（%s）→ 开始新录音",
                         s_voice_state == VOICE_SPEAK ? "说话中" : "思考中");
                voice_interrupt();
            }
            voice_start_rec();
        }

        /* 语音唤醒（模型"小宇同学"，喊"小鱼同学"）：
         *   - 空闲命中 → 本地"叮咚"提示音 → 提示音完自动聆听
         *   - 播报中命中 → 用户优先：打断当前回答，直接进入聆听（不用按 KEY） */
        if (wake_take_hit()) {
            if (s_wake_greet) {
                /* 应答播放期间的误触发：消费掉即可（播放完照常进入聆听） */
            } else if (s_voice_state == VOICE_IDLE) {
                audio_play_wake_chime();
                s_wake_greet = 1;
                s_sub_clear_at = 0;
                subq_clear();
                sub_cur_clear();
                ui_set_sub("");
                voice_to(VOICE_SPEAK);
                ESP_LOGI(TAG, "唤醒词触发 → 提示音后聆听");
            } else if (s_voice_state == VOICE_SPEAK || s_voice_state == VOICE_THINK) {
                ESP_LOGI(TAG, "%s听到唤醒词 → 打断重听",
                         s_voice_state == VOICE_SPEAK ?
                         "播报中" : "思考中（放弃等待服务器）");
                voice_interrupt();
                voice_start_rec_auto(1);
            }
            /* 录音中唤醒未使能（自己的声音会自触发），到不了这里 */
        }

        /* 播放结束 → 回空闲（字幕保留 4 秒）；唤醒提示音播完则直接开录；
         * 回答以问句收尾（fu=1）也直接开麦：用户不用按 KEY/唤醒词，直接答话即可 */
        if (s_voice_state == VOICE_SPEAK && audio_play_finished()) {
            if (s_wake_greet) {
                s_wake_greet = 0;
                voice_start_rec_auto(0);
            } else if (s_followup && !s_pending_evt[0]) {
                /* 有待执行的屏幕事件时不自动开麦：否则画布刚打开就被语音让位清掉 */
                s_followup = 0;
                ESP_LOGI(TAG, "回答以问句收尾 → 自动聆听（直接说话即可）");
                voice_start_rec_auto(0);
            } else {
                s_sub_clear_at = now_ms() + 4000;
                voice_to(VOICE_IDLE);
            }
        }

        /* 自动聆听：VAD 判说完/没说话/超时 → 有效说话才走提问流程；
         * 只有杂音/尾音碎片（或压根没说）→ 本地静默收尾，不送 ASR */
        if (s_voice_state == VOICE_REC) {
            int vs = audio_rec_vad_stop();
            if (vs == 3 || (vs == 1 && audio_rec_heard_speech())) {
                ESP_LOGI(TAG, "自动聆听结束（%s）", vs == 3 ? "超时" : "说完");
                voice_stop_rec();
            } else if (vs == 1) {
                ESP_LOGI(TAG, "自动聆听结束（说完但没听到有效说话）→ 静默收尾");
                voice_rec_void();
            } else if (vs == 2) {
                ESP_LOGI(TAG, "自动聆听结束（没说话）→ 静默收尾");
                voice_rec_void();
            }
        }

        /* 录音硬上限兜底：手动靠松键、自动靠 VAD 收尾——任一环节失效
         * （KEY 事件丢失 / 麦克风没帧 / VAD 不打点）都会永远停在"录音中"。
         * 自动 20 秒（VAD 自身 15 秒），手动 30 秒。
         * 差值必须有符号：自动聆听在本轮循环里才把 s_rec_started_at 设为
         * now_ms()，比循环开头取的 now 晚 1~2ms，无符号相减会下溢成 ~2^32，
         * 导致刚开录就命中 20 秒超时（唤醒应答后"立即结束"的根因）。 */
        if (s_voice_state == VOICE_REC && s_rec_started_at &&
            (int32_t)(now - (uint32_t)s_rec_started_at) >
                (int32_t)(s_rec_auto_mode ? 20000 : 30000)) {
            ESP_LOGW(TAG, "录音超时（%s，%d 秒上限），强制收尾",
                     s_rec_auto_mode ? "自动" : "手动", s_rec_auto_mode ? 20 : 30);
            if (audio_rec_heard_speech()) voice_stop_rec();
            else voice_rec_void();
        }

        /* 字幕：等对应句子的首帧真正播出去再显示（对齐声音）；
         * 长句超过一页（24 字）时按播放进度翻页，保证整句都看得到 */
        {
            int pushed = 0, played = 0;
            audio_play_stats(&pushed, &played);
            while (s_subq_head != s_subq_tail && played > s_subq[s_subq_head].at_frame) {
                sub_item_t *it = &s_subq[s_subq_head];
                snprintf(s_sub_cur, sizeof(s_sub_cur), "%s", it->text);
                s_sub_cur_at     = it->at_frame;
                s_sub_cur_frames = it->n_frames;
                s_sub_cur_page   = 0;
                ui_set_sub(s_sub_cur);
                s_dirty = 1;
                s_subq_head = (s_subq_head + 1) % SUBQ_MAX;
            }
            if (s_sub_cur[0] && s_sub_cur_frames > 0) {
                int pages = ui_sub_pages(s_sub_cur);
                if (pages > 1) {
                    /* 翻页滞后：TTS 句首有静音、句尾略慢，纯按比例翻会早几个字。
                     * 10% 余量实测仍偏快 → 加到 12.5%，长句最多滞后 18 帧（约 1.1 秒） */
                    int lag = s_sub_cur_frames / 8;
                    if (lag < 4) lag = 4;
                    if (lag > 18) lag = 18;
                    int prog = played - s_sub_cur_at - lag;
                    if (prog < 0) prog = 0;
                    if (prog > s_sub_cur_frames) prog = s_sub_cur_frames;
                    int page = (int)((long long)prog * pages / s_sub_cur_frames);
                    if (page >= pages) page = pages - 1;
                    if (page != s_sub_cur_page) {
                        s_sub_cur_page = page;
                        ui_set_sub_page(s_sub_cur, page);
                        s_dirty = 1;
                    }
                }
            }
            /* 诊断：说话中每 5 秒一行播放统计（纯 ASCII，抓包可直接分析） */
            static uint32_t s_play_log_at = 0;
            if (s_voice_state == VOICE_SPEAK && now - s_play_log_at > 5000) {
                s_play_log_at = now;
                ESP_LOGI(TAG, "play: pushed=%d played=%d inflight=%d",
                         pushed, played, pushed - played);
            }
        }

        /* 等服务器超时保护 */
        if (s_voice_state == VOICE_THINK && s_voice_deadline &&
            now > (uint32_t)s_voice_deadline) {
            ESP_LOGW(TAG, "等服务器超时，回空闲");
            voice_to(VOICE_IDLE);
        }

        /* BLE 状态变化（广播/连接/断开）→ 立即上报、刷新底部状态和中央浮层。
         * ble_poll 负责在广播启动被控制器拒绝（内部 RAM 一时不够）后重试。 */
        {
            static int s_last_bt = -1;
            ble_poll();
            int bt_now = (int)ble_state();
            if (s_last_bt < 0) {
                s_last_bt = bt_now;
                s_stat_at = 0;
            } else if (bt_now != s_last_bt) {
                s_last_bt = bt_now;
                s_stat_at = 0;
                s_dirty = 1;
                ui_bt_overlay(bt_now);
                s_bt_clear_at = now_ms() + 1500;
            }
        }

        /* 板载状态上报：连上后立即一次，之后每 30 秒（语音答"电量/室温/蓝牙"用它） */
        if (ws_connected() && (int32_t)(now - s_stat_at) >= 0) {
            stat_send();
            s_stat_at = now + 30000;
        }

        /* 网络看门狗 v2（治"僵尸关联/假死链路"）——
         * 假死 = 名义上连着、实际收发全断，两种表现：
         *   1) 90 秒收不到应用数据（服务器 ping 不算；正常 60 秒一推 info）；
         *   2) 上行连续失败 ≥15 秒（300ms 超时刷屏，ws 客户端内部锁被长占）。
         * 任一命中 → 强制重新关联 WiFi（断开→自动重连，破僵尸 TCP）。
         * 完全断线（没连接）交给 ws 自动重连，只给 5 分钟大限兜底。 */
        {
            static TickType_t s_wifi_kick_at = 0;
            int64_t idle = ws_idle_ms();
            int64_t stall = ws_tx_stall_ms();
            int bad = (ws_connected() && (idle > 90000 || stall > 15000)) ||
                      (idle > 300000);
            TickType_t th = ws_connected() ? pdMS_TO_TICKS(60000) : pdMS_TO_TICKS(300000);
            if (bad && (TickType_t)(xTaskGetTickCount() - s_wifi_kick_at) > th) {
                s_wifi_kick_at = xTaskGetTickCount();
                ESP_LOGW(TAG, "网络假死（无数据 %d 秒 / 上行锁死 %d 秒），强制重新关联 WiFi",
                         (int)(idle / 1000), (int)(stall / 1000));
                wifi_sta_kick();
            }
        }

        /* 字幕延迟清除 */
        if (s_sub_clear_at && now >= (uint32_t)s_sub_clear_at) {
            s_sub_clear_at = 0;
            sub_cur_clear();
            ui_set_sub("");
            s_dirty = 1;
        }

        /* 音量浮层超时清除 */
        if (s_vol_clear_at && now >= s_vol_clear_at) {
            s_vol_clear_at = 0;
            ui_volume_overlay(-1);
            s_dirty = 1;
        }

        /* 蓝牙状态浮层超时清除 */
        if (s_bt_clear_at && now >= s_bt_clear_at) {
            s_bt_clear_at = 0;
            ui_bt_overlay(-1);
            s_dirty = 1;
        }

        /* 每秒重绘一次（时钟走字）；脏标记或桌宠换帧时立即重绘。
         * Lua 画布保鲜期内跳过重绘（脚本在接管屏幕）。 */
        int pet_changed = ui_tick(now);
        TickType_t nowT = xTaskGetTickCount();
        if ((s_dirty || pet_changed || (nowT - last) >= pdMS_TO_TICKS(1000)) &&
            !ui_lua_hold_active()) {
            ui_render();
            s_dirty = 0;
            last = nowT;
        }

        vTaskDelay(pdMS_TO_TICKS(50));
    }
}

/** 服务器下行的 Opus 帧 → 播放队列 */
static void on_ws_audio(const uint8_t *data, size_t len)
{
    /* 录音/思考阶段属于新的语音回合：此时到达的都是上一轮回答的迟到帧
     * （用户打断场景），直接丢弃，避免旧声音盖在新录音上 */
    if (s_voice_state == VOICE_REC || s_voice_state == VOICE_THINK) return;
    audio_play_push(data, len);
}

/** 连上 WiFi 后的正常启动：WebSocket + 按键 + Lua + 主循环（不返回） */
static void boot_online(const wifi_cfg_t *cfg)
{
    ws_client_set_handler(on_ws_event);
    ws_client_set_bin_handler(on_ws_audio);
    ESP_ERROR_CHECK(ws_client_start(cfg->host, cfg->token));
    buttons_init(on_button);
    lua_runtime_set_result_cb(on_lua_result);
    lua_runtime_start();                     /* 挂载 fatfs、开机脚本、等下发（不阻塞） */
    ESP_LOGI(TAG, "启动完成（服务器 %s）", cfg->host);
    main_loop();
}

void app_main(void)
{
    /* NVS：WiFi / 服务器配置存在这里（配网页写入） */
    esp_err_t ne = nvs_flash_init();
    if (ne == ESP_ERR_NVS_NO_FREE_PAGES || ne == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ESP_ERROR_CHECK(nvs_flash_init());
    }

    if (esp_reset_reason() == ESP_RST_BROWNOUT)
        ESP_LOGW(TAG, "上次复位原因：BOD 欠压（可能音量过大）");

    /* 长按 BOOT 8 秒触发的重启：干净堆上直接进重置门户，
     * 不初始化音频/Lua/WS（它们占用内部 RAM，SoftAP 会分配失败）。 */
    bool boot_reset_portal = (s_boot_portal_flag == BOOT_PORTAL_MAGIC);
    s_boot_portal_flag = 0;
    if (boot_reset_portal) {
        ui_init();
        char ap[24];
        wifi_portal_ap_name(ap, sizeof(ap));
        ui_show_portal_mode(ap, 1);
        ui_render();
        ESP_LOGW(TAG, "重启进入 WiFi 重置模式：热点 %s → 192.168.4.1", ap);
        wifi_portal_run_reset();
        for (;;) vTaskDelay(pdMS_TO_TICKS(1000));
    }

    /* 开机长按 KEY 3 秒 → 强制进配网（放最前面，一上电就能按） */
    bool force_portal = wifi_portal_key_held();

    sensors_init();
    ESP_LOGI(TAG, "电池 %d mV / %d%%", sensors_battery_mv(), sensors_battery_pct());
    pcf85063_init();
    ui_init();
    ui_render();

    if (audio_init() != ESP_OK) {
        ESP_LOGE(TAG, "音频初始化失败（语音对话不可用）");
    } else if (wake_init() != 0) {
        ESP_LOGW(TAG, "语音唤醒不可用（其余功能正常）");
    }

    ESP_LOGI(TAG, "MyEsp32 %s 启动", MYESP32_FW);

    /* 配置：NVS（配网页保存）优先，其次编译期默认（CI Secrets / menuconfig） */
    static wifi_cfg_t cfg;
    wifi_cfg_load(&cfg);

    /* 网络健康回调：wifi_sta 的黑名单守护任务用它判断"关联了但到不了服务器"
     * （关联 2 分钟仍连不上 → 拉黑当前 BSSID 10 分钟换同 SSID 的另一节点） */
    wifi_sta_set_health_fn(ws_connected);

    bool sta_running = false;
    if (!force_portal && cfg.ssid[0]) {
        ESP_ERROR_CHECK(wifi_sta_start(cfg.ssid, cfg.pass));
        sta_running = true;
        if (wifi_sta_wait(20000) == ESP_OK) {
            char ip[20];
            wifi_sta_ip(ip, sizeof(ip));
            ESP_LOGI(TAG, "WiFi 已连接（%s），IP %s", cfg.ssid, ip);
            boot_online(&cfg);                      /* 不返回 */
        }
        ESP_LOGW(TAG, "20 秒没连上 %s → 进配网模式", cfg.ssid);
    } else if (force_portal) {
        ESP_LOGW(TAG, "开机长按 KEY → 进配网模式");
    } else {
        ESP_LOGW(TAG, "还没有 WiFi 配置 → 进配网模式");
    }

    /* ── 配网模式：手机连热点后，浏览器打开 192.168.4.1 ── */
    char ap[24];
    wifi_portal_ap_name(ap, sizeof(ap));
    ui_show_portal(ap);
    ui_render();
    wifi_portal_run(sta_running);                   /* 保存 / 连上后自动重启 */
}
