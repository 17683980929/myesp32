/**
 * ble.h — BLE 从机（NimBLE）：广播、连接、状态
 *
 * 只做“能被手机搜到/连接”的最小外设：GAP 名称 + Device Information Service。
 * 不涉及业务协议；首次打开时才初始化协议栈，关闭时停止广播。
 */
#pragma once

typedef enum {
    BLE_OFF = 0,
    BLE_ADVERTISING = 1,
    BLE_CONNECTED = 2,
} ble_state_t;

/** 首次打开时惰性初始化；成功返回 0。 */
int ble_init(void);

/** 打开发送广播 / 关闭并断开连接；可重复调用。 */
void ble_set_enabled(int on);

/** 主循环里调用：广播启动被控制器拒绝时按 ADV_RETRY_MS 重试（内存紧张是暂时的）。 */
void ble_poll(void);

int ble_enabled(void);
ble_state_t ble_state(void);

/** 广播名（"MyEsp32-XXXX"）；协议栈还没初始化时为空串。 */
const char *ble_name(void);

/** "关闭" / "广播中" / "已连接"（UI 用） */
const char *ble_state_str(void);
