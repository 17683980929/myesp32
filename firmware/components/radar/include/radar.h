/**
 * radar.h — HLK-LD2410B-P 毫米波雷达
 *
 * 接线（板子背面 2×8 母座，以丝印为准）：
 *   VCC → VBUS(5V)      GND → GND
 *   OUT (pin1) → GP1    有人=高，无人=低
 *   UART_Tx (pin2) → GP2（ESP32 UART1 RX）
 *   UART_Rx (pin3) → GP3（ESP32 UART1 TX）
 *
 * OUT 和 UART 都能判有人：UART 有帧时用帧里的目标状态，3 秒没帧退回 OUT。
 * 有人 1.2 秒、无人 2.5 秒消抖，避免刚坐下/起身时来回跳。
 */
#pragma once
#include <stdbool.h>
#include <stdint.h>

#define RADAR_OUT_GPIO      1
#define RADAR_UART_RX_GPIO  2
#define RADAR_UART_TX_GPIO  3
#define RADAR_UART_PORT     1
#define RADAR_UART_BAUD     256000

typedef struct {
    bool present;             /* 消抖后的有人状态 */
    bool uart_ok;             /* 最近 3 秒收到过有效目标帧 */
    bool moving;              /* 有移动目标 */
    bool still;               /* 有静止目标 */
    uint16_t detect_dist_cm;  /* 检测距离（cm），0=无目标 */
    uint16_t move_dist_cm;
    uint8_t  move_energy;
    uint16_t still_dist_cm;
    uint8_t  still_energy;
    uint32_t last_frame_ms;   /* 上电以来最后一帧的时刻（ms），0=还没收到 */
} radar_state_t;

/** 启动 GPIO + UART1 + 雷达任务；初始化失败只打日志，不影响其它功能 */
void radar_start(void);

/** 拷贝当前状态快照（任意任务可调） */
void radar_get(radar_state_t *out);

/** 消抖后的有人状态 */
bool radar_present(void);

/** UART 是否在正常出帧 */
bool radar_uart_ok(void);
