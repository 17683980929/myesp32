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
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
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

static const char *TAG = "main";

static int s_func_since = 0;
static volatile int s_dirty = 1;        /* 需要重绘 */

/* ── 语音状态机（M4）───────────────────────────────────────────────── */

typedef enum { VOICE_IDLE = 0, VOICE_REC, VOICE_THINK, VOICE_SPEAK } voice_state_t;

static voice_state_t s_voice_state = VOICE_IDLE;
static int s_key_down_at = -1;          /* KEY 按下时刻（ms）；-1 = 未按 */
static int s_key_voice = 0;             /* 本次按键已触发录音（防重复） */
static int s_voice_deadline = 0;        /* 思考阶段超时保护 */
static int s_sub_clear_at = 0;          /* 字幕延迟清除时刻 */

static int now_ms(void) { return (int)(xTaskGetTickCount() * portTICK_PERIOD_MS); }

static void voice_to(voice_state_t v)
{
    s_voice_state = v;
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
}

static void voice_start_rec(void)
{
    if (!audio_ready()) { ESP_LOGW(TAG, "录音不可用：音频未就绪"); return; }
    if (!ws_connected()) { ESP_LOGW(TAG, "录音不可用：未连接服务器"); return; }

    if (ui_get_page() != UI_PAGE_HOME) {
        ui_set_page(UI_PAGE_HOME);
        s_func_since = 0;
    }
    s_sub_clear_at = 0;
    ui_set_sub("");
    audio_rec_start();
    ws_send_json("{\"t\":\"rec\",\"s\":\"start\"}");
    voice_to(VOICE_REC);
    ESP_LOGI(TAG, "开始录音（松开 KEY 结束）");
}

static void voice_stop_rec(void)
{
    audio_rec_stop();
    ws_send_json("{\"t\":\"rec\",\"s\":\"stop\"}");
    s_voice_deadline = now_ms() + 30000;
    voice_to(VOICE_THINK);
    ESP_LOGI(TAG, "结束录音，等服务器");
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

/* ── 服务器事件 → UI ───────────────────────────────────────────────── */

static void on_ws_event(const ws_event_t *ev)
{
    switch (ev->kind) {
    case WS_EVT_INFO:
        sync_time_from_server();
        s_dirty = 1;
        break;
    case WS_EVT_SUB:
        ui_set_sub(ev->text);
        s_dirty = 1;
        break;
    case WS_EVT_STT:
        s_dirty = 1;
        break;
    case WS_EVT_PAGE: {
        /* UI 的页面状态是唯一真相，切页必须走 ui_set_page() */
        ui_page_t p = strcmp(ev->name, "func") == 0 ? UI_PAGE_FUNC : UI_PAGE_HOME;
        ui_set_page(p);
        if (p == UI_PAGE_FUNC)
            s_func_since = (int)(xTaskGetTickCount() * portTICK_PERIOD_MS);
        s_dirty = 1;
        break;
    }
    case WS_EVT_CONNECTED:
        s_dirty = 1;
        break;
    case WS_EVT_TTS_START:
        audio_play_reset();
        s_sub_clear_at = 0;
        ui_set_sub("");
        if (s_voice_state != VOICE_REC) voice_to(VOICE_SPEAK);
        s_dirty = 1;
        break;
    case WS_EVT_TTS_STOP:
        audio_play_finish();
        break;
    case WS_EVT_ERROR:
        ESP_LOGW(TAG, "服务器错误: %s", ev->text);
        ui_set_sub(ev->text);
        s_dirty = 1;
        break;
    case WS_EVT_DISCONNECTED:
        audio_play_stop();
        audio_rec_stop();
        s_key_down_at = -1;
        if (s_voice_state != VOICE_IDLE) voice_to(VOICE_IDLE);
        s_dirty = 1;
        break;
    default:
        break;
    }
}

/* ── 按键 → 页面 ───────────────────────────────────────────────────── */

static void on_button(btn_id_t id, btn_event_t ev)
{
    /* 诊断日志：每个按键事件都打一行（含按下/松开，看长按短按） */
    ESP_LOGI(TAG, "btn %s %s", id == BTN_KEY ? "KEY" : "BOOT",
             ev == BTN_DOWN ? "down" : (ev == BTN_CLICK ? "click" : "up"));

    if (id == BTN_KEY) {
        if (ev == BTN_DOWN) {
            s_key_down_at = now_ms();
            s_key_voice = 0;
        } else if (ev == BTN_UP) {
            /* 长按录音：松手结束（事件顺序：短按先 CLICK 再 UP） */
            if (s_voice_state == VOICE_REC) voice_stop_rec();
            s_key_down_at = -1;
        } else {                                        /* BTN_CLICK：短按翻页 */
            if (s_voice_state != VOICE_IDLE) return;    /* 语音中不翻页 */
            ui_page_t p = (ui_get_page() == UI_PAGE_HOME) ? UI_PAGE_FUNC : UI_PAGE_HOME;
            ui_set_page(p);
            if (p == UI_PAGE_FUNC)
                s_func_since = now_ms();
            s_dirty = 1;

            char msg[48];
            snprintf(msg, sizeof(msg), "{\"t\":\"btn\",\"k\":\"key\",\"e\":\"click\"}");
            ws_send_json(msg);
            ESP_LOGI(TAG, "KEY → %s", p == UI_PAGE_HOME ? "home" : "func");
        }
    } else {                                            /* BOOT：按住=麦克风直通自检 */
        if (ev == BTN_DOWN) {
            if (s_voice_state == VOICE_IDLE) audio_echo_set(1);
        } else if (ev == BTN_UP) {
            audio_echo_set(0);
        }
    }
}

/* ── 主循环 ────────────────────────────────────────────────────────── */

static void main_loop(void)
{
    TickType_t last = xTaskGetTickCount();
    for (;;) {
        uint32_t now = (uint32_t)(xTaskGetTickCount() * portTICK_PERIOD_MS);

        /* 功能页 5 秒后自动回主页 */
        if (ui_get_page() == UI_PAGE_FUNC && s_func_since &&
            now - (uint32_t)s_func_since > 5000) {
            ui_set_page(UI_PAGE_HOME);
            s_dirty = 1;
            ESP_LOGI(TAG, "功能页超时 → home");
        }

        /* KEY 长按 350ms → 开始录音（短按翻页不受影响） */
        if (s_key_down_at >= 0 && !s_key_voice && s_voice_state == VOICE_IDLE &&
            now - (uint32_t)s_key_down_at >= 350) {
            s_key_voice = 1;
            voice_start_rec();
        }

        /* 播放结束 → 回空闲（字幕保留 4 秒） */
        if (s_voice_state == VOICE_SPEAK && audio_play_finished()) {
            s_sub_clear_at = now_ms() + 4000;
            voice_to(VOICE_IDLE);
        }

        /* 等服务器超时保护 */
        if (s_voice_state == VOICE_THINK && s_voice_deadline &&
            now > (uint32_t)s_voice_deadline) {
            ESP_LOGW(TAG, "等服务器超时，回空闲");
            voice_to(VOICE_IDLE);
        }

        /* 字幕延迟清除 */
        if (s_sub_clear_at && now >= (uint32_t)s_sub_clear_at) {
            s_sub_clear_at = 0;
            ui_set_sub("");
            s_dirty = 1;
        }

        /* 每秒重绘一次（时钟走字）；脏标记或桌宠换帧时立即重绘 */
        int pet_changed = ui_tick(now);
        TickType_t nowT = xTaskGetTickCount();
        if (s_dirty || pet_changed || (nowT - last) >= pdMS_TO_TICKS(1000)) {
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
    audio_play_push(data, len);
}

/** 连上 WiFi 后的正常启动：WebSocket + 按键 + 主循环（不返回） */
static void boot_online(const wifi_cfg_t *cfg)
{
    ws_client_set_handler(on_ws_event);
    ws_client_set_bin_handler(on_ws_audio);
    ESP_ERROR_CHECK(ws_client_start(cfg->host, cfg->token));
    buttons_init(on_button);
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

    /* 开机长按 KEY 3 秒 → 强制进配网（放最前面，一上电就能按） */
    bool force_portal = wifi_portal_key_held();

    sensors_init();
    ESP_LOGI(TAG, "电池 %d mV / %d%%", sensors_battery_mv(), sensors_battery_pct());
    pcf85063_init();
    ui_init();
    ui_render();

    if (audio_init() != ESP_OK)
        ESP_LOGE(TAG, "音频初始化失败（语音对话不可用）");

    ESP_LOGI(TAG, "MyEsp32 %s 启动", MYESP32_FW);

    /* 配置：NVS（配网页保存）优先，其次编译期默认（CI Secrets / menuconfig） */
    static wifi_cfg_t cfg;
    wifi_cfg_load(&cfg);

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
