/**
 * radar.h — HLK-LD2410B-P 毫米波雷达
 *
 * 接线（板子背面 2×8 母座，以丝印为准）：
 *   VCC → 5V   注意：原接 VBUS(5V)，那是 USB 口的电，拔掉 USB 就没电，
 *              表现为「整机正常、只有雷达不亮」。电池脱线使用请改接
 *              18650 经升压模块输出的常开 5V，见
 *              hardware/enclosure/PRINT-SPEC-D.md「电池脱线供电改造」。
 *              不要把 VCC 直接接 3.3V：规格 5V / 70~80mA（峰值 120mA），
 *              板载 3V3 LDO 带不动，会让雷达和 ESP32 一起反复重启。
 *   GND → GND（升压模块、板子、雷达三者必须共地）
 *   EN(升压模块) → RADAR_PWR_GPIO（可选，见下方宏）
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

/* 电池脱线供电：升压模块 EN 脚。GP7 在当前板型上空闲（已用 0~5/8~14/16/18/40/41/45/46）。
 * 高电平 = 给雷达供电；没接 EN 线时这只是个悬空 IO，拉高拉低都无影响。
 * main.c 的 power_tick() 在电池电压过低时把它拉低，保住 ESP32 和屏幕。 */
#define RADAR_PWR_GPIO      7
#define RADAR_PWR_ON_LEVEL  1

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

/** 手动开关雷达电源（升压模块 EN）。没接 EN 线时只影响一个悬空 IO，
 *  不影响 UART/OUT 检测；重新上电会清掉 UART 残留字节。 */
void radar_power_set(bool on);

/** 软件上的电源允许状态（不代表实际电压） */
bool radar_power_on(void);
