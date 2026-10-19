/**
 * ws_client.c — WebSocket 客户端
 *
 * 用 espressif/esp_websocket_client 托管组件。
 * 收到消息后解析成 ws_event_t 回调给上层（main → ui）。
 */

#include "ws_client.h"
#include <string.h>
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_websocket_client.h"
#include "cJSON.h"
#include "esp_mac.h"
#include "esp_timer.h"

static const char *TAG = "ws";
static esp_websocket_client_handle_t s_cli = NULL;
static ws_handler_t s_handler = NULL;
static ws_bin_handler_t s_bin_handler = NULL;
static dev_info_t s_info = { .weather_temp = -1, .room_t = -1, .room_h = -1, .battery = -1 };

/* 文本帧组装缓冲：esp_websocket_client 1.4+ 按每次 read 分片派发
 * （payload_offset/payload_len），大帧会拆成多次回调——攒齐整包再解析。
 * 缓冲里的字符串仅在本次回调期间引用（上层自己会拷贝）。 */
static char s_rx_text[7168];
static int  s_rx_len;

/* 最近一次收到应用层数据的毫秒时刻（esp_timer 基准；服务器 ping 不算）。
 * 网络看门狗据此判断链路是否"假死"（关联在、实际收发已断）。 */
static volatile int64_t s_last_rx_ms;

/* 上行健康跟踪：最近一次成功发送时刻 + 连续失败计数。
 * 库内部锁被长占时，300ms 超时全灭、连续失败累积 →
 * 供网络看门狗判定"上行锁死"（典型：连接名义在线但什么都发不出去）。 */
static volatile int64_t s_last_tx_ok_ms;
static volatile int     s_tx_fail_streak;

static void tx_result(int ok)
{
    if (ok) {
        s_last_tx_ok_ms = esp_timer_get_time() / 1000;
        s_tx_fail_streak = 0;
    } else if (s_tx_fail_streak < 100000) {
        s_tx_fail_streak++;
    }
}

dev_info_t *ws_client_info(void) { return &s_info; }

void ws_client_set_handler(ws_handler_t handler) { s_handler = handler; }

void ws_client_set_bin_handler(ws_bin_handler_t handler) { s_bin_handler = handler; }

static void dispatch(const ws_event_t *ev) { if (s_handler) s_handler(ev); }

static void on_data(char *data, int len)
{
    ws_event_t ev = { 0 };

    cJSON *root = cJSON_ParseWithLength(data, len);
    if (!root) {
        s_last_rx_ms = esp_timer_get_time() / 1000;   /* 非 JSON 文本也算应用流量 */
        ESP_LOGW(TAG, "收到非 JSON 文本帧");
        return;
    }

    const char *t = cJSON_GetStringValue(cJSON_GetObjectItem(root, "t"));

    if (t && !strcmp(t, "ping")) {
        /* 服务器保活 ping：回 pong（服务器端判活用），但 ping 本身不算
         * "应用数据活跃"、不刷新 s_last_rx_ms——否则半死链路里只有 ping
         * 能通行时，网络看门狗永远不会触发（这次卡死排查的教训）。 */
        cJSON *ts = cJSON_GetObjectItem(root, "ts");
        char pong[64];
        snprintf(pong, sizeof(pong), "{\"t\":\"pong\",\"ts\":%lld}",
                 ts && cJSON_IsNumber(ts) ? (long long)ts->valuedouble : 0LL);
        ws_send_json(pong);
        cJSON_Delete(root);
        return;
    }

    s_last_rx_ms = esp_timer_get_time() / 1000;

    if (t && !strcmp(t, "info")) {
        ev.kind = WS_EVT_INFO;
        cJSON *v;
        if ((v = cJSON_GetObjectItem(root, "time")))
            strncpy(s_info.time, cJSON_GetStringValue(v) ?: "", sizeof(s_info.time) - 1);
        if ((v = cJSON_GetObjectItem(root, "date")))
            strncpy(s_info.date, cJSON_GetStringValue(v) ?: "", sizeof(s_info.date) - 1);
        if ((v = cJSON_GetObjectItem(root, "week")))
            strncpy(s_info.week, cJSON_GetStringValue(v) ?: "", sizeof(s_info.week) - 1);
        if ((v = cJSON_GetObjectItem(root, "mm")))  s_info.mm = v->valueint;
        if ((v = cJSON_GetObjectItem(root, "dd")))  s_info.dd = v->valueint;
        if ((v = cJSON_GetObjectItem(root, "wday"))) s_info.wday = v->valueint;
        cJSON *w = cJSON_GetObjectItem(root, "weather");
        if (w) {
            const char *txt = cJSON_GetStringValue(cJSON_GetObjectItem(w, "text"));
            if (txt) strncpy(s_info.weather, txt, sizeof(s_info.weather) - 1);
            const char *ct = cJSON_GetStringValue(cJSON_GetObjectItem(w, "city"));
            if (ct) strncpy(s_info.city, ct, sizeof(s_info.city) - 1);
            cJSON *tv = cJSON_GetObjectItem(w, "temp");
            s_info.weather_temp = (tv && !cJSON_IsNull(tv)) ? tv->valueint : -99;
        }
        dispatch(&ev);
    } else if (t && !strcmp(t, "page")) {
        ev.kind = WS_EVT_PAGE;
        const char *n = cJSON_GetStringValue(cJSON_GetObjectItem(root, "name"));
        strncpy(ev.name, n ?: "home", sizeof(ev.name) - 1);
        dispatch(&ev);
    } else if (t && !strcmp(t, "evt")) {
        ev.kind = WS_EVT_EVT;
        const char *n = cJSON_GetStringValue(cJSON_GetObjectItem(root, "n"));
        strncpy(ev.name, n ?: "", sizeof(ev.name) - 1);
        dispatch(&ev);
    } else if (t && !strcmp(t, "stt")) {
        ev.kind = WS_EVT_STT;
        const char *n = cJSON_GetStringValue(cJSON_GetObjectItem(root, "text"));
        strncpy(ev.text, n ?: "", sizeof(ev.text) - 1);
        dispatch(&ev);
    } else if (t && !strcmp(t, "tts_start")) {
        ev.kind = WS_EVT_TTS_START; dispatch(&ev);
    } else if (t && !strcmp(t, "tts_stop")) {
        ev.kind = WS_EVT_TTS_STOP;
        cJSON *fu = cJSON_GetObjectItem(root, "fu");
        ev.followup = (fu && cJSON_IsNumber(fu)) ? (fu->valueint != 0) : 0;
        dispatch(&ev);
    } else if (t && !strcmp(t, "sub")) {
        ev.kind = WS_EVT_SUB;
        const char *n = cJSON_GetStringValue(cJSON_GetObjectItem(root, "text"));
        strncpy(ev.text, n ?: "", sizeof(ev.text) - 1);
        cJSON *fr = cJSON_GetObjectItem(root, "frames");
        ev.frames = (fr && cJSON_IsNumber(fr)) ? fr->valueint : 0;
        dispatch(&ev);
    } else if (t && !strcmp(t, "lua")) {
        ev.kind = WS_EVT_LUA;
        cJSON *v = cJSON_GetObjectItem(root, "id");
        ev.lua_id = v ? v->valueint : 0;
        const char *code = cJSON_GetStringValue(cJSON_GetObjectItem(root, "code"));
        if (code && strlen(code) < sizeof(s_rx_text)) {
            ev.lua_code = code;              /* 指向组装缓冲，仅本次回调期间有效 */
        } else {
            ev.lua_code = NULL;          /* 缺失或过长：main 回错误给服务器 */
            ESP_LOGW(TAG, "lua 脚本%s", code ? "过长" : "缺失");
        }
        dispatch(&ev);
    } else if (t && !strcmp(t, "err")) {
        ev.kind = WS_EVT_ERROR;
        const char *n = cJSON_GetStringValue(cJSON_GetObjectItem(root, "msg"));
        strncpy(ev.text, n ?: "", sizeof(ev.text) - 1);
        dispatch(&ev);
    }

    cJSON_Delete(root);
}

static void on_event(void *handler_args, esp_event_base_t base, int32_t id, void *data)
{
    esp_websocket_event_data_t *e = (esp_websocket_event_data_t *)data;

    switch (id) {
    case WEBSOCKET_EVENT_CONNECTED: {
        ESP_LOGI(TAG, "已连接服务器");
        ws_event_t ev = { .kind = WS_EVT_CONNECTED };
        dispatch(&ev);

        /* 握手 */
        char msg[160];
        uint8_t mac[6];
        esp_read_mac(mac, ESP_MAC_WIFI_STA);
        snprintf(msg, sizeof(msg),
                 "{\"t\":\"hello\",\"fw\":\"" MYESP32_FW "\","
                 "\"mac\":\"%02x:%02x:%02x:%02x:%02x:%02x\","
                 "\"caps\":[\"audio\",\"lua\"]}",
                 mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
        /* 有限超时：连接刚建立也不无限持锁（链路半死会连 ws 任务一起卡住） */
        tx_result(esp_websocket_client_send_text(s_cli, msg, strlen(msg),
                                                 pdMS_TO_TICKS(1000)) >= 0);
        break;
    }
    case WEBSOCKET_EVENT_DISCONNECTED: {
        ESP_LOGW(TAG, "断开");
        ws_event_t ev = { .kind = WS_EVT_DISCONNECTED };
        dispatch(&ev);
        break;
    }
    case WEBSOCKET_EVENT_DATA:
        /* 应用数据活跃度由 on_data 按类型统计（ping 不算）；这里只管分片组装 */
        if (e->op_code == 0x1 && e->data_len > 0 && e->data_ptr) {
            /* 大帧会被拆成多次回调（一次 read 一段）：先攒齐再解析 */
            if (e->payload_offset == 0) s_rx_len = 0;
            if (s_rx_len >= 0 && s_rx_len + e->data_len < (int)sizeof(s_rx_text)) {
                memcpy(s_rx_text + s_rx_len, e->data_ptr, e->data_len);
                s_rx_len += e->data_len;
            } else {
                s_rx_len = -1;               /* 超过缓冲：整帧丢弃 */
            }
            if (e->payload_offset + e->data_len >= e->payload_len) {
                if (s_rx_len >= 0) {
                    s_rx_text[s_rx_len] = 0;
                    on_data(s_rx_text, s_rx_len);
                } else {
                    ESP_LOGW(TAG, "文本帧过长（%d 字节），忽略", (int)e->payload_len);
                }
                s_rx_len = 0;
            }
        } else if (e->op_code == 0x2 && e->data_len > 0 && e->data_ptr &&
                   e->payload_offset == 0 && e->data_len == e->payload_len) {
            /* 二进制音频帧（Opus，单帧远小于缓冲，不会被分片） */
            s_last_rx_ms = esp_timer_get_time() / 1000;
            if (s_bin_handler) s_bin_handler((const uint8_t *)e->data_ptr, (size_t)e->data_len);
        }
        break;
    case WEBSOCKET_EVENT_ERROR:
        ESP_LOGE(TAG, "错误");
        break;
    default:
        break;
    }
}

esp_err_t ws_client_start(const char *host_port, const char *token)
{
    char url[192];
    snprintf(url, sizeof(url), "ws://%s/device%s%s",
             host_port, token ? "?token=" : "", token ? token : "");

    esp_websocket_client_config_t cfg = {
        .uri = url,
        .buffer_size = 8192,             /* 要装下放大的 lua 帧（脚本 ≤6KB + JSON 开销） */
        .task_stack = 6144,              /* ws_event_t（含 512B 文本）在事件任务栈上构造 */
        .reconnect_timeout_ms = 5000,
        .network_timeout_ms = 10000,
    };
    s_cli = esp_websocket_client_init(&cfg);
    if (!s_cli) return ESP_FAIL;
    s_last_rx_ms = esp_timer_get_time() / 1000;
    s_last_tx_ok_ms = s_last_rx_ms;
    s_tx_fail_streak = 0;

    esp_websocket_register_events(s_cli, WEBSOCKET_EVENT_ANY, on_event, NULL);
    return esp_websocket_client_start(s_cli);
}

int ws_send_json(const char *json)
{
    /* 控制消息给个有限超时：socket 断线/阻塞时宁可丢这条消息，
     * 也不能把按键/主任务永久卡死（之前用 portMAX_DELAY 是隐患）；
     * 返回值让调用方决定是否继续（录音开始/结束要据此取消） */
    if (!s_cli) { tx_result(0); return 0; }
    int r = esp_websocket_client_send_text(s_cli, json, strlen(json), pdMS_TO_TICKS(300));
    tx_result(r >= 0);
    return r >= 0;
}

void ws_send_audio(const uint8_t *frame, size_t len)
{
    /* 有限超时：链路拥塞/假死时宁可丢这一帧音频，也不能让音频任务
     * 永久持住 ws 客户端内部锁（会把整条连接卡到连重连都做不了）。 */
    if (!s_cli || !esp_websocket_client_is_connected(s_cli)) { tx_result(0); return; }
    tx_result(esp_websocket_client_send_bin(s_cli, (const char *)frame, len,
                                            pdMS_TO_TICKS(300)) >= 0);
}

int ws_connected(void)
{
    return s_cli && esp_websocket_client_is_connected(s_cli);
}

int64_t ws_idle_ms(void)
{
    return esp_timer_get_time() / 1000 - s_last_rx_ms;
}

int64_t ws_tx_stall_ms(void)
{
    /* 连续失败 ≥5 次才算"上行锁死"（偶发单次丢弃不算）：
     * 返回距最近一次成功发送的毫秒数；链路正常时恒为 0。 */
    if (s_tx_fail_streak < 5) return 0;
    return esp_timer_get_time() / 1000 - s_last_tx_ok_ms;
}
