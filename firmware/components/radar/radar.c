#include "radar.h"
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"
#include "driver/uart.h"
#include "esp_log.h"
#include "esp_timer.h"

static const char *TAG = "radar";

#define RX_RING_SIZE    1024
#define PARSE_BUF_SIZE  256
#define FRAME_MAX_DATA  64

#define UART_FRESH_US   (3 * 1000 * 1000LL)
#define PRESENT_HOLD_US (1200 * 1000LL)
#define ABSENT_HOLD_US  (2500 * 1000LL)

static radar_state_t s_state;
static portMUX_TYPE s_lock = portMUX_INITIALIZER_UNLOCKED;

static bool s_started;
static bool s_uart_ready;
static uint8_t s_buf[PARSE_BUF_SIZE];
static size_t s_buf_len;
static bool s_last_raw;
static int64_t s_raw_since_us;
static int64_t s_last_frame_us;
static uint8_t s_target_state;

/* 目标数据帧：FD FC FB FA | len(2) | 02 01 | state | move_dist(2) move_en |
 *              still_dist(2) still_en | detect_dist(2) | 55 00 | tail(4) */
static void handle_frame(const uint8_t *f, uint16_t dlen)
{
    const uint8_t *d = f + 6;
    if (dlen != 13 || d[0] != 0x02 || d[1] != 0x01) return;

    uint8_t st = d[2];
    uint16_t mdist = (uint16_t)(d[3] | ((uint16_t)d[4] << 8));
    uint8_t  men   = d[5];
    uint16_t sdist = (uint16_t)(d[6] | ((uint16_t)d[7] << 8));
    uint8_t  sen   = d[8];
    uint16_t ddist = (uint16_t)(d[9] | ((uint16_t)d[10] << 8));

    s_target_state = st;
    s_last_frame_us = esp_timer_get_time();

    taskENTER_CRITICAL(&s_lock);
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
        if (!(p[0] == 0xFD && p[1] == 0xFC && p[2] == 0xFB && p[3] == 0xFA)) {
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
        if (p[total - 4] == 0x04 && p[total - 3] == 0x03 &&
            p[total - 2] == 0x02 && p[total - 1] == 0x01) {
            handle_frame(p, dlen);
            pos += total;
        } else {
            pos++;
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

    for (;;) {
        int64_t now = esp_timer_get_time();

        if (s_uart_ready) {
            int n = uart_read_bytes(RADAR_UART_PORT, chunk, sizeof(chunk), 0);
            if (n > 0) feed(chunk, (size_t)n);
        }

        bool uart_ok = s_last_frame_us != 0 && now - s_last_frame_us < UART_FRESH_US;
        bool out = gpio_get_level(RADAR_OUT_GPIO) != 0;
        bool raw = out || (uart_ok && s_target_state != 0);

        if (raw != s_last_raw) {
            s_last_raw = raw;
            s_raw_since_us = now;
        }

        radar_state_t snap;
        taskENTER_CRITICAL(&s_lock);
        snap = s_state;
        taskEXIT_CRITICAL(&s_lock);

        int64_t hold = raw ? PRESENT_HOLD_US : ABSENT_HOLD_US;
        if (raw != snap.present && now - s_raw_since_us >= hold) {
            taskENTER_CRITICAL(&s_lock);
            s_state.present = raw;
            taskEXIT_CRITICAL(&s_lock);
            snap.present = raw;
            ESP_LOGI(TAG, "雷达 → %s（OUT=%d UART=%d 距离=%dcm）",
                     raw ? "有人" : "无人", out, uart_ok, snap.detect_dist_cm);
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
            ESP_LOGI(TAG, "目标：%s%s 距离 %dcm（移动 %dcm/%d，静止 %dcm/%d）",
                     snap.moving ? "移动 " : "", snap.still ? "静止" : "无",
                     snap.detect_dist_cm, snap.move_dist_cm, snap.move_energy,
                     snap.still_dist_cm, snap.still_energy);
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

    if (xTaskCreate(radar_task, "radar", 3072, NULL, 3, NULL) != pdPASS) {
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
