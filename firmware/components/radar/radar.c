#include "radar.h"
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"
#include "driver/uart.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"

static const char *TAG = "radar";

#define RX_RING_SIZE    512             /* 雷达每 165ms 一帧 23B，512B 足够 */
#define PARSE_BUF_SIZE  256
#define FRAME_MAX_DATA  64
#define RADAR_STACK_WORDS 6144          /* 24KB，放 PSRAM；16KB 时余量只剩 ~1.9KB，诊断日志再加一点，留足 */

#define UART_FRESH_US   (3 * 1000 * 1000LL)
#define PRESENT_HOLD_US (1500 * 1000LL)
#define ABSENT_HOLD_US  (6000 * 1000LL)

/* ── 判定门限（2026-11-04 按实测日志重定）────────────────────────────
 *
 * 现场日志（模块每 30 秒一条）里，静止目标的距离在 39~99cm 之间来回跳，
 * 而原来的门限正好是 90cm —— 那个静态反射物每越过一次阈值，
 * 状态就在有人/无人之间翻一次，这是"反复横跳"的直接原因。
 *
 * 现在的做法：
 *   1) 静止目标收紧到 70cm（坐桌前实测 40~64cm，静态物在 80cm 以外）
 *   2) 静止目标还要能量 ≥30、距离 >12cm，滤掉弱反射和近场自反射
 *   3) 静止"只能维持、不能触发"——最近 2 分钟内没有任何运动命中时，
 *      光有静止目标不算有人（桌椅、墙、外壳永远静止，但不该判有人）
 *   4) 运动目标补上 1.6m 距离上限（原代码注释写了却没实现，
 *      窗外/走廊的人影会被当成有人）
 */
#define MOVE_MAX_CM      160            /* 运动目标最远 1.6m */
#define STILL_NEAR_CM    70             /* 静止目标最远 0.7m */
#define MIN_CM           12             /* 小于这个距离基本是自身外壳的近场反射 */
#define MOVE_MIN_ENERGY  50             /* 运动能量门限（原 30。实测有人时 81~100，
                                         * 噪声能到 43，取 50 把噪声挡在外面） */
#define STILL_MIN_ENERGY 30             /* 静止能量门限（原来完全没有） */
#define STILL_MEMORY_US  (120 * 1000 * 1000LL)   /* 静止维持需要最近 2 分钟有过运动 */

static radar_state_t s_state;
static portMUX_TYPE s_lock = portMUX_INITIALIZER_UNLOCKED;
static StaticTask_t s_task_tcb;
static StackType_t *s_task_stack;

static bool s_started;
static bool s_uart_ready;
static uint8_t s_buf[PARSE_BUF_SIZE];
static size_t s_buf_len;
static bool s_last_raw;
static int64_t s_raw_since_us;
static int64_t s_last_frame_us;
static int64_t s_last_move_us;    /* 最近一次"运动命中"的时刻，静止维持靠它 */
static uint8_t s_move_run;        /* 运动命中连续持续了几个采样周期（滤单帧误报） */
static uint8_t s_target_state;
static uint32_t s_rx_bytes;       /* UART 收到的原始字节数（诊断） */
static uint32_t s_frames;         /* 有效目标帧数（诊断） */
static uint8_t s_first[16];       /* 收到的前 16 字节（诊断） */
static size_t s_first_len;

/* 目标数据帧（旧协议）：FD FC FB FA | len(2) | 02 01 | state | move_dist(2) move_en |
 *              still_dist(2) still_en | detect_dist(2) | 55 00 | tail(4)
 * 目标数据帧（新协议，模块固件 V2.x）：F4 F3 F2 F1 | len(2) | 02 AA | 同样的数据布局 */
static void handle_frame(const uint8_t *f, uint16_t dlen, bool new_proto)
{
    const uint8_t *d = f + 6;
    if (dlen != 13) return;
    if (new_proto) {
        if (d[0] != 0x02 || d[1] != 0xAA) return;
    } else {
        if (d[0] != 0x02 || d[1] != 0x01) return;
    }
    s_frames++;

    uint8_t st = d[2];
    uint16_t mdist = (uint16_t)(d[3] | ((uint16_t)d[4] << 8));
    uint8_t  men   = d[5];
    uint16_t sdist = (uint16_t)(d[6] | ((uint16_t)d[7] << 8));
    uint8_t  sen   = d[8];
    uint16_t ddist = (uint16_t)(d[9] | ((uint16_t)d[10] << 8));

    s_last_frame_us = esp_timer_get_time();

    taskENTER_CRITICAL(&s_lock);
    s_target_state = st;              /* 状态位和各路能量/距离要同一帧、同一把锁里更新 */
    s_state.moving = (st & 0x01) != 0;
    s_state.still  = (st & 0x02) != 0;
    s_state.move_dist_cm  = mdist;
    s_state.move_energy   = men;
    s_state.still_dist_cm = sdist;
    s_state.still_energy  = sen;
    s_state.detect_dist_cm = ddist;
    s_state.last_frame_ms = (uint32_t)(s_last_frame_us / 1000);
    taskEXIT_CRITICAL(&s_lock);
}

static void feed(const uint8_t *data, size_t n)
{
    if (n > sizeof(s_buf) - s_buf_len) {
        size_t keep = s_buf_len > 32 ? 32 : s_buf_len;
        memmove(s_buf, s_buf + s_buf_len - keep, keep);
        s_buf_len = keep;
        if (n > sizeof(s_buf) - s_buf_len) n = sizeof(s_buf) - s_buf_len;
    }
    memcpy(s_buf + s_buf_len, data, n);
    s_buf_len += n;

    size_t pos = 0;
    while (s_buf_len - pos >= 6) {
        const uint8_t *p = s_buf + pos;
        bool old_hdr = p[0] == 0xFD && p[1] == 0xFC && p[2] == 0xFB && p[3] == 0xFA;
        bool new_hdr = p[0] == 0xF4 && p[1] == 0xF3 && p[2] == 0xF2 && p[3] == 0xF1;
        if (!old_hdr && !new_hdr) {
            pos++;
            continue;
        }
        uint16_t dlen = (uint16_t)(p[4] | ((uint16_t)p[5] << 8));
        size_t total = 4 + 2 + (size_t)dlen + 4;
        if (dlen > FRAME_MAX_DATA || total > sizeof(s_buf)) {
            pos++;
            continue;
        }
        if (s_buf_len - pos < total) break;
        if (old_hdr) {
            if (p[total - 4] == 0x04 && p[total - 3] == 0x03 &&
                p[total - 2] == 0x02 && p[total - 1] == 0x01) {
                handle_frame(p, dlen, false);
                pos += total;
            } else {
                pos++;
            }
        } else {
            /* 新协议帧尾还没确认，先按长度/命令放行；命令在 handle_frame 里校验 */
            handle_frame(p, dlen, true);
            pos += total;
        }
    }
    if (pos) {
        memmove(s_buf, s_buf + pos, s_buf_len - pos);
        s_buf_len -= pos;
    }
}

static void radar_task(void *arg)
{
    (void)arg;
    uint8_t chunk[128];
    bool last_uart = false;
    int64_t next_log_us = 0;
    int64_t next_stack_log_us = 0;
    int64_t next_uart_log_us = 0;
    int64_t next_probe_us = 0;

    for (;;) {
        int64_t now = esp_timer_get_time();

        if (s_uart_ready) {
            int n = uart_read_bytes(RADAR_UART_PORT, chunk, sizeof(chunk), 0);
            if (n > 0) {
                s_rx_bytes += (uint32_t)n;
                if (s_first_len < sizeof(s_first)) {
                    size_t cp = (size_t)n;
                    if (cp > sizeof(s_first) - s_first_len) cp = sizeof(s_first) - s_first_len;
                    memcpy(s_first + s_first_len, chunk, cp);
                    s_first_len += cp;
                }
                feed(chunk, (size_t)n);
            }
        }

        bool uart_ok = s_last_frame_us != 0 && now - s_last_frame_us < UART_FRESH_US;
        bool out = gpio_get_level(RADAR_OUT_GPIO) != 0;

        /* 状态位和距离/能量必须在同一把锁里取，否则会把上一帧的状态和这一帧的能量拼在一起 */
        radar_state_t snap;
        uint8_t st;
        taskENTER_CRITICAL(&s_lock);
        snap = s_state;
        st = s_target_state;
        taskEXIT_CRITICAL(&s_lock);

        /* 运动命中：能量够、距离在 (12cm, 1.6m] 内。
         * 上限很关键——没有上限时，窗外/走廊/别的房间有人走动也会判"有人"。 */
        bool move_hit = uart_ok && (st & 0x01) != 0 &&
                        snap.move_energy >= MOVE_MIN_ENERGY &&
                        snap.move_dist_cm > MIN_CM && snap.move_dist_cm <= MOVE_MAX_CM;

        /* 静止命中：桌前的静态物（桌沿/椅背/墙/外壳）永远静止，所以静止只能"维持"、
         * 不能"触发"——必须有最近的运动命中做前提。 */
        bool still_hit = uart_ok && (st & 0x02) != 0 &&
                         snap.still_energy >= STILL_MIN_ENERGY &&
                         snap.still_dist_cm > MIN_CM && snap.still_dist_cm <= STILL_NEAR_CM;

        /* 单帧误报不能刷新"最近运动"，否则一次噪声就能让静止目标维持两分钟。
         * 连续 3 个采样周期（约 0.3 秒、覆盖两帧以上）才算真的动过。 */
        if (move_hit) {
            if (s_move_run < 255) s_move_run++;
        } else {
            s_move_run = 0;
        }
        if (s_move_run >= 3) s_last_move_us = now;
        bool recent_move = s_last_move_us != 0 && now - s_last_move_us < STILL_MEMORY_US;

        bool raw;
        if (uart_ok) {
            raw = move_hit || (still_hit && recent_move);
        } else if (s_frames == 0) {
            raw = out;                    /* 从来没收到过帧：可能只接了 OUT，用它兜底 */
        } else {
            raw = false;                  /* 出过帧又断了：OUT 不可信（会被光敏/悬空带跳），判无人 */
        }

        if (raw != s_last_raw) {
            s_last_raw = raw;
            s_raw_since_us = now;
        }

        int64_t hold = raw ? PRESENT_HOLD_US : ABSENT_HOLD_US;
        if (raw != snap.present && now - s_raw_since_us >= hold) {
            taskENTER_CRITICAL(&s_lock);
            s_state.present = raw;
            taskEXIT_CRITICAL(&s_lock);
            snap.present = raw;
            ESP_LOGI(TAG, "雷达 → %s（运动 %dcm/%d %s，静止 %dcm/%d %s，OUT=%d UART=%d）",
                     raw ? "有人" : "无人",
                     snap.move_dist_cm, snap.move_energy, move_hit ? "✓" : "✗",
                     snap.still_dist_cm, snap.still_energy,
                     still_hit ? (recent_move ? "✓" : "✓但无近期运动") : "✗",
                     out, uart_ok);
        }

        if (uart_ok != last_uart) {
            last_uart = uart_ok;
            ESP_LOGI(TAG, "UART %s", uart_ok ? "开始出帧" : "3 秒没有有效帧");
        }

        taskENTER_CRITICAL(&s_lock);
        s_state.uart_ok = uart_ok;
        taskEXIT_CRITICAL(&s_lock);

        if (uart_ok && now >= next_log_us) {
            next_log_us = now + 30 * 1000 * 1000LL;
            int since_move = s_last_move_us ? (int)((now - s_last_move_us) / 1000000) : -1;
            ESP_LOGI(TAG, "目标：%s%s 最近运动 %ds 前 → 判%s（移动 %dcm/%d，静止 %dcm/%d）",
                     snap.moving ? "移动 " : "", snap.still ? "静止" : "无",
                     since_move, s_last_raw ? "有人" : "无人",
                     snap.move_dist_cm, snap.move_energy,
                     snap.still_dist_cm, snap.still_energy);
        }

        /* 栈余量：4KB 栈实测在 USB 串口日志处溢出，改成 16KB 后留一行观测 */
        if (now >= next_stack_log_us) {
            next_stack_log_us = now + 60 * 1000 * 1000LL;
            ESP_LOGI(TAG, "栈余量 %u 字节",
                     (unsigned)(uxTaskGetStackHighWaterMark(NULL) * sizeof(StackType_t)));
        }

        /* UART 诊断（没万用表时用）：
         *   没有有效帧时每 10 秒报一次原始字节数 + 开头 16 字节；
         *   完全没字节时每 2 秒发一个 0x55，方便把 GP2-GP3 短接做回环测试。
         *   0 字节 = 线/模块 TX 没信号；有字节但无帧 = 波特率/帧格式问题。 */
        if (!uart_ok && now >= next_uart_log_us) {
            next_uart_log_us = now + 10 * 1000 * 1000LL;
            char hex[3 * 16 + 1];
            int hi = 0;
            for (size_t i = 0; i < s_first_len; i++)
                hi += snprintf(hex + hi, sizeof(hex) - (size_t)hi, "%02X ", s_first[i]);
            hex[hi] = 0;
            ESP_LOGI(TAG, "UART 诊断：原始 %u 字节 / 目标帧 %u%s%s",
                     (unsigned)s_rx_bytes, (unsigned)s_frames,
                     s_first_len ? " / 开头 " : "", hex);
        }
        if (!uart_ok && s_uart_ready && s_rx_bytes == 0 && now >= next_probe_us) {
            next_probe_us = now + 2 * 1000 * 1000LL;
            uint8_t probe = 0x55;
            uart_write_bytes(RADAR_UART_PORT, &probe, 1);
        }

        vTaskDelay(pdMS_TO_TICKS(100));
    }
}

void radar_start(void)
{
    if (s_started) return;
    s_started = true;

    gpio_config_t io = {
        .pin_bit_mask = 1ULL << RADAR_OUT_GPIO,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_ENABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    esp_err_t err = gpio_config(&io);
    if (err != ESP_OK)
        ESP_LOGE(TAG, "GP%d 配置失败：%s", RADAR_OUT_GPIO, esp_err_to_name(err));

    uart_config_t uc = {
        .baud_rate = RADAR_UART_BAUD,
        .data_bits = UART_DATA_8_BITS,
        .parity = UART_PARITY_DISABLE,
        .stop_bits = UART_STOP_BITS_1,
        .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
        .source_clk = UART_SCLK_DEFAULT,
    };
    err = uart_param_config(RADAR_UART_PORT, &uc);
    if (err == ESP_OK)
        err = uart_set_pin(RADAR_UART_PORT, RADAR_UART_TX_GPIO, RADAR_UART_RX_GPIO,
                           UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE);
    if (err == ESP_OK)
        err = uart_driver_install(RADAR_UART_PORT, RX_RING_SIZE, 0, 0, NULL, 0);
    if (err == ESP_OK) {
        s_uart_ready = true;
        uart_flush_input(RADAR_UART_PORT);
    } else {
        ESP_LOGE(TAG, "UART%d 初始化失败：%s（退化为只读 OUT）",
                 RADAR_UART_PORT, esp_err_to_name(err));
    }

    /* 栈放 PSRAM：雷达任务只碰 UART/GPIO/日志，不做 flash I/O，
     * 把内部 RAM 留给 BLE 控制器那块 30KB 连续内存。 */
    s_task_stack = heap_caps_malloc(RADAR_STACK_WORDS * sizeof(StackType_t), MALLOC_CAP_SPIRAM);
    if (!s_task_stack) {
        ESP_LOGE(TAG, "雷达任务栈分配失败（PSRAM 不足）");
        return;
    }
    if (!xTaskCreateStaticPinnedToCore(radar_task, "radar", RADAR_STACK_WORDS, NULL, 3,
                                       s_task_stack, &s_task_tcb, 0)) {
        ESP_LOGE(TAG, "雷达任务创建失败");
        return;
    }
    ESP_LOGI(TAG, "启动：OUT=GP%d UART%d TX=GP%d RX=GP%d %d 8N1",
             RADAR_OUT_GPIO, RADAR_UART_PORT, RADAR_UART_TX_GPIO,
             RADAR_UART_RX_GPIO, RADAR_UART_BAUD);
}

void radar_get(radar_state_t *out)
{
    if (!out) return;
    taskENTER_CRITICAL(&s_lock);
    *out = s_state;
    taskEXIT_CRITICAL(&s_lock);
}

bool radar_present(void)
{
    taskENTER_CRITICAL(&s_lock);
    bool p = s_state.present;
    taskEXIT_CRITICAL(&s_lock);
    return p;
}

bool radar_uart_ok(void)
{
    taskENTER_CRITICAL(&s_lock);
    bool ok = s_state.uart_ok;
    taskEXIT_CRITICAL(&s_lock);
    return ok;
}
