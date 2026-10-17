/**
 * wifi_sta.h — WiFi 客户端（站点模式）
 */
#pragma once
#include "esp_err.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"

/** 连上并拿到 IP 后返回 */
esp_err_t wifi_sta_start(const char *ssid, const char *password);

/** 等待 IP（阻塞） */
esp_err_t wifi_sta_wait(int timeout_ms);

/** 拿到 IP 后读字符串，如 "192.168.1.55" */
void wifi_sta_ip(char *buf, int len);

extern EventGroupHandle_t wifi_events;
#define WIFI_EVT_GOT_IP  BIT0
