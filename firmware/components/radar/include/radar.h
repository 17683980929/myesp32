/**
 * radar.h — HLK-LD2410B-P 毫米波雷达
 *
 * 接线（板子背面 2×8 母座，以丝印为准）：
 *   VCC → VBUS(5V)      GND → GND
 *   OUT (pin1) → GP1    有人=高，无人=低
 *   UART_Tx (pin2) → GP2（ESP32 UART1 RX）
 *   UART_Rx (pin3) → GP3（ESP32 UART1 TX）
 *
 * OUT 和 UART 都能判有人：UART 有帧时用帧里的目标状态，从来没收到过帧才退回 OUT
 * （出过帧又断掉时不退回 OUT——那个脚会被环境光/悬空带跳）。
 *
 * 判定规则（2026-11 实测重定）：
 *   运动命中：能量 ≥40 且 12cm < 距离 ≤ 1.6m   → 可以触发"有人"
 *   静止命中：能量 ≥30 且 12cm < 距离 ≤ 0.7m   → 只能维持，不能触发
 *             （桌沿/椅背/外壳永远静止，光有静止目标不算有人；
 *               必须在最近 2 分钟内出现过运动命中）
 *   消抖：连续命中 1.5 秒判有人，连续无命中 6 秒判无人。
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
