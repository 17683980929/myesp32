/**
 * wifi_sta.c — WiFi 站点模式（标准 ESP-IDF 流程，带自动重连）
 */

#include "wifi_sta.h"
#include <string.h>
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_log.h"
#include "nvs_flash.h"
#include "esp_netif.h"

static const char *TAG = "wifi";
EventGroupHandle_t wifi_events;
static int s_retry = 0;

static void on_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        if (s_retry++ < 20) {
            esp_wifi_connect();
            ESP_LOGW(TAG, "断开，重连(%d)", s_retry);
        } else {
            ESP_LOGE(TAG, "重连次数用尽");
        }
        xEventGroupClearBits(wifi_events, WIFI_EVT_GOT_IP);
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *e = (ip_event_got_ip_t *)data;
        ESP_LOGI(TAG, "IP: " IPSTR, IP2STR(&e->ip_info.ip));
        s_retry = 0;
        xEventGroupSetBits(wifi_events, WIFI_EVT_GOT_IP);
    }
}

esp_err_t wifi_sta_start(const char *ssid, const char *password)
{
    esp_err_t e = nvs_flash_init();
    if (e == ESP_ERR_NVS_NO_FREE_PAGES || e == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ESP_ERROR_CHECK(nvs_flash_init());
    }

    wifi_events = xEventGroupCreate();

    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t wc = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&wc));

    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_event, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_event, NULL));

    wifi_config_t wcfg = { 0 };
    strncpy((char *)wcfg.sta.ssid, ssid, sizeof(wcfg.sta.ssid));
    strncpy((char *)wcfg.sta.password, password, sizeof(wcfg.sta.password));

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wcfg));
    ESP_ERROR_CHECK(esp_wifi_start());

    ESP_LOGI(TAG, "WiFi 启动，连接 %s", ssid);
    return ESP_OK;
}

esp_err_t wifi_sta_wait(int timeout_ms)
{
    EventBits_t b = xEventGroupWaitBits(wifi_events, WIFI_EVT_GOT_IP,
                                        pdFALSE, pdTRUE,
                                        pdMS_TO_TICKS(timeout_ms));
    return (b & WIFI_EVT_GOT_IP) ? ESP_OK : ESP_ERR_TIMEOUT;
}

void wifi_sta_ip(char *buf, int len)
{
    esp_netif_ip_info_t info;
    esp_netif_t *netif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    if (netif && esp_netif_get_ip_info(netif, &info) == ESP_OK) {
        snprintf(buf, len, IPSTR, IP2STR(&info.ip));
    } else {
        snprintf(buf, len, "?");
    }
}
