/**
 * wifi_portal.h — 配网门户（类小智：板子开热点，手机网页配置）
 *
 * 触发条件：没有 WiFi 配置 / 开机 20 秒连不上 / 开机长按 KEY 3 秒。
 * 进去之后：手机连 MyEsp32-XXXX 热点 → 浏览器自动弹出配网页（DNS 劫持）→
 * 填 WiFi + 服务器地址 → 保存 NVS → 自动重启连网。
 */
#pragma once
#include <stdbool.h>
#include <stddef.h>

/** 开机时长按 KEY（GPIO18）3 秒 → true（强制进配网） */
bool wifi_portal_key_held(void);

/** 计算热点名（MyEsp32-XXXX，取 MAC 后两字节），写进 buf */
void wifi_portal_ap_name(char *buf, size_t n);

/**
 * 进入配网模式：开热点 + DNS 劫持 + 配网网页（各任务独立跑，本函数返回后照常工作）。
 * 保存配置、或 STA 后台自己连上了 → 自动重启进正常模式。
 * @param keep_sta STA 是否已在后台重连（启动超时进来时传 true）
 */
void wifi_portal_run(bool keep_sta);
