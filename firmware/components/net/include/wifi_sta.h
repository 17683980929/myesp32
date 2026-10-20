/**
 * wifi_sta.h — WiFi 客户端（站点模式）
 */
#pragma once
#include <stdint.h>
#include "esp_err.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"

/** 连上并拿到 IP 后返回 */
esp_err_t wifi_sta_start(const char *ssid, const char *password);

/** 等待 IP（阻塞） */
esp_err_t wifi_sta_wait(int timeout_ms);

/** 拿到 IP 后读字符串，如 "192.168.1.55" */
void wifi_sta_ip(char *buf, int len);

/** 当前是否已连上（拿到 IP） */
int wifi_sta_connected(void);

/** 强制断开重连（事件处理器会自动重连；治"僵尸关联"） */
void wifi_sta_kick(void);

/** 距本次「关联成功」的毫秒数；当前没关联返回 -1。
 *  注意：关联 ≠ 拿到 IP——Mesh 副节点 DHCP 不通时，这个值会一直涨。 */
int64_t wifi_sta_assoc_ms(void);

/** 暂停 STA 自动重连（进配网 / WiFi 重置模式前调用） */
void wifi_sta_pause(void);

/** 链路健康回调（返回 1 = 已连上服务器，如 ws_connected）。
 *  黑名单守护任务用它判断"关联了但到不了服务器"；不设置就不启用黑名单。 */
typedef int (*wifi_sta_health_fn)(void);
void wifi_sta_set_health_fn(wifi_sta_health_fn fn);

extern EventGroupHandle_t wifi_events;
#define WIFI_EVT_GOT_IP  BIT0
