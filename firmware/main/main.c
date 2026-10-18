/**
 * main.c — MyEsp32 固件入口
 *
 * 启动顺序：NVS → 传感器 → 屏幕 → WiFi → WebSocket → 按键 → 主循环
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
#include "ws_client.h"
#include "ui.h"

static const char *TAG = "main";

static int s_func_since = 0;
static volatile int s_dirty = 1;        /* 需要重绘 */

/* ── 服务器事件 → UI ───────────────────────────────────────────────── */

static void on_ws_event(const ws_event_t *ev)
{
    switch (ev->kind) {
    case WS_EVT_INFO:
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

    if (id == BTN_KEY && ev == BTN_CLICK) {
        /* 翻页设备本地完成（不等网络），只告诉服务器一声 */
        ui_page_t p = (ui_get_page() == UI_PAGE_HOME) ? UI_PAGE_FUNC : UI_PAGE_HOME;
        ui_set_page(p);
        if (p == UI_PAGE_FUNC)
            s_func_since = (int)(xTaskGetTickCount() * portTICK_PERIOD_MS);
        s_dirty = 1;

        char msg[48];
        snprintf(msg, sizeof(msg), "{\"t\":\"btn\",\"k\":\"key\",\"e\":\"click\"}");
        ws_send_json(msg);
        ESP_LOGI(TAG, "KEY → %s", p == UI_PAGE_HOME ? "home" : "func");
    }
}

/* ── 主循环 ────────────────────────────────────────────────────────── */

void app_main(void)
{
    ESP_ERROR_CHECK(nvs_flash_init());

    sensors_init();
    ESP_LOGI(TAG, "电池 %d mV / %d%%", sensors_battery_mv(), sensors_battery_pct());
    pcf85063_init();
    ui_init();

    ESP_LOGI(TAG, "MyEsp32 %s 启动", MYESP32_FW);

    /* WiFi（配网在 M7；现在用 menuconfig 里的值） */
    ESP_ERROR_CHECK(wifi_sta_start(CONFIG_WIFI_SSID, CONFIG_WIFI_PASSWORD));
    if (wifi_sta_wait(15000) != ESP_OK) {
        ESP_LOGE(TAG, "WiFi 连接失败，仍继续启动（屏幕会显示离线状态）");
    }

    /* WebSocket */
    ws_client_set_handler(on_ws_event);
    ESP_ERROR_CHECK(ws_client_start(CONFIG_SERVER_HOST, CONFIG_SERVER_TOKEN));

    buttons_init(on_button);

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
