/**
 * wifi_cfg.h — WiFi / 服务器配置（NVS 持久化，编译期值兜底）
 *
 * 优先级：NVS（配网页面保存的）> sdkconfig（CI Secrets 注入的出厂值）> 空。
 * 每项独立覆盖：NVS 里没有的键用编译期默认值。
 */
#pragma once
#include "esp_err.h"

typedef struct {
    char ssid[64];
    char pass[64];
    char host[64];
    char token[64];
} wifi_cfg_t;

/** 读取最终生效配置 */
void wifi_cfg_load(wifi_cfg_t *out);

/** 保存到 NVS（配网页面用） */
esp_err_t wifi_cfg_save(const wifi_cfg_t *cfg);
