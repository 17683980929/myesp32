/**
 * ota.h — 从服务器下载固件写入备用 OTA 分区
 *
 * 触发：服务器 WS 下发 {"t":"ota","url":"http://…/firmware/app.bin"}
 * 流程：HTTP GET → esp_ota_begin/write/end → set_boot_partition → 重启
 * 失败不影响当前固件（esp_ota_end 会丢弃未完成的镜像）。
 */
#pragma once

/** 开始更新。返回 0=已启动，-1=已有任务在跑，-2=内部 RAM 不足（关蓝牙再试），
 *  -3=参数/分区问题。 */
int ota_start(const char *url);

/** -1=空闲，0..99=进行中，100=完成（即将重启），-2=失败。 */
int ota_percent(void);

/** 最近一次失败原因（英文短码，便于塞进 JSON） */
const char *ota_err(void);
