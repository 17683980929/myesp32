/**
 * wifi_cfg.c — WiFi / 服务器配置读写
 *
 * NVS 命名空间 "wifi"，键：ssid / pass / host / token。
 * 读不到 NVS 值就用手 sdkconfig 的编译期默认（CI 的 Secrets 会注入到这里）。
 */

#include "wifi_cfg.h"
#include <string.h>
#include "sdkconfig.h"
#include "esp_log.h"
#include "nvs.h"

static const char *TAG = "wifi_cfg";
#define NS "wifi"

/* NVS 里有该键就覆盖到 dst，没有就保持原值 */
static void overlay(nvs_handle_t h, const char *key, char *dst, size_t sz)
{
    char tmp[128];
    size_t len = sizeof(tmp);
    if (nvs_get_str(h, key, tmp, &len) == ESP_OK)
        strlcpy(dst, tmp, sz);
}

void wifi_cfg_load(wifi_cfg_t *out)
{
    memset(out, 0, sizeof(*out));

    /* 1. 编译期默认（CI Secrets 注入 / menuconfig） */
    strlcpy(out->ssid,  CONFIG_WIFI_SSID,     sizeof(out->ssid));
    strlcpy(out->pass,  CONFIG_WIFI_PASSWORD, sizeof(out->pass));
    strlcpy(out->host,  CONFIG_SERVER_HOST,   sizeof(out->host));
    strlcpy(out->token, CONFIG_SERVER_TOKEN,  sizeof(out->token));

    /* 2. NVS 覆盖 */
    nvs_handle_t h;
    if (nvs_open(NS, NVS_READONLY, &h) == ESP_OK) {
        overlay(h, "ssid",  out->ssid,  sizeof(out->ssid));
        overlay(h, "pass",  out->pass,  sizeof(out->pass));
        overlay(h, "host",  out->host,  sizeof(out->host));
        overlay(h, "token", out->token, sizeof(out->token));
        nvs_close(h);
    }

    ESP_LOGI(TAG, "生效配置：ssid=%s host=%s",
             out->ssid[0] ? out->ssid : "(空)", out->host);
}

esp_err_t wifi_cfg_save(const wifi_cfg_t *cfg)
{
    nvs_handle_t h;
    esp_err_t e = nvs_open(NS, NVS_READWRITE, &h);
    if (e != ESP_OK) return e;

    e = nvs_set_str(h, "ssid", cfg->ssid);
    if (e == ESP_OK) e = nvs_set_str(h, "pass", cfg->pass);
    if (e == ESP_OK) e = nvs_set_str(h, "host", cfg->host);
    if (e == ESP_OK) e = nvs_set_str(h, "token", cfg->token);
    if (e == ESP_OK) e = nvs_commit(h);
    nvs_close(h);

    if (e == ESP_OK)
        ESP_LOGI(TAG, "已保存：ssid=%s host=%s", cfg->ssid, cfg->host);
    else
        ESP_LOGE(TAG, "保存失败：%s", esp_err_to_name(e));
    return e;
}
