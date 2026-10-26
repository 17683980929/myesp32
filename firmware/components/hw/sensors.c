/**
 * sensors.c — SHTC3 温湿度 + 电池 ADC
 *
 * SHTC3：I2C 0x70，命令字连续半字节流（16 位大端）。
 *   唤醒 0x3517 / 睡眠 0xB098 / 软复位 0x805D / 测量(T 在前, 正常模式) 0x7CA2
 *   读回 6 字节：T_MSB T_LSB T_CRC RH_MSB RH_LSB RH_CRC，CRC-8 多项式 0x31
 * 电池：ADC1_CH3，5s 缓存 + 15 点中位数 + EMA；百分比带迟滞
 *       （4.10V 进 100%，跌到 4.03V 才退出，其余每档 ±10mV 死区）。
 */

#include "sensors.h"
#include <stdbool.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "driver/i2c_master.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"
#include "esp_timer.h"
#include "esp_log.h"
#include "esp_check.h"
#include "hw_config.h"

static const char *TAG = "sensors";

static i2c_master_bus_handle_t s_bus = NULL;
static i2c_master_dev_handle_t s_shtc3 = NULL;
static adc_oneshot_unit_handle_t s_adc = NULL;
static adc_cali_handle_t s_cali = NULL;
static SemaphoreHandle_t s_bat_lock = NULL;

/* 电池缓存：UI 约 14fps 询一次，不能每次都读 ADC */
static int s_bat_mv = -1;
static int s_bat_pct = -1;
static int64_t s_bat_at_us = 0;

#define BAT_EMPTY_MV      3000
#define BAT_FULL_MV       4100
#define BAT_FULL_EXIT_MV  4030
#define BAT_STEP_DEAD_MV  10
#define BAT_CACHE_US      (5 * 1000 * 1000LL)

i2c_master_bus_handle_t sensors_i2c_bus(void) { return s_bus; }

/* ── CRC ───────────────────────────────────────────────────────────── */

static uint8_t crc8(const uint8_t *d, int len)
{
    uint8_t crc = 0xFF;
    for (int i = 0; i < len; i++) {
        crc ^= d[i];
        for (int b = 0; b < 8; b++)
            crc = (crc & 0x80) ? (uint8_t)((crc << 1) ^ 0x31) : (uint8_t)(crc << 1);
    }
    return crc;
}

/* ── 初始化 ────────────────────────────────────────────────────────── */

void sensors_init(void)
{
    /* I2C 主机总线（音频 codec 也在上面，但那是 M4 的事） */
    i2c_master_bus_config_t bus = {
        .i2c_port = 0,
        .sda_io_num = I2C_SDA_PIN,
        .scl_io_num = I2C_SCL_PIN,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = 1,
    };
    ESP_ERROR_CHECK(i2c_new_master_bus(&bus, &s_bus));

    i2c_device_config_t dev = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = SHTC3_ADDR,
        .scl_speed_hz = I2C_FREQ_HZ,
    };
    ESP_ERROR_CHECK(i2c_master_bus_add_device(s_bus, &dev, &s_shtc3));

    /* ADC（电池） */
    adc_oneshot_unit_init_cfg_t au = { .unit_id = ADC_UNIT_1 };
    ESP_ERROR_CHECK(adc_oneshot_new_unit(&au, &s_adc));

    adc_oneshot_chan_cfg_t cc = {
        .atten = ADC_ATTEN_DB_12,
        .bitwidth = ADC_BITWIDTH_12,
    };
    ESP_ERROR_CHECK(adc_oneshot_config_channel(s_adc, BAT_ADC_CH, &cc));

    adc_cali_curve_fitting_config_t cal = {
        .unit_id = ADC_UNIT_1,
        .atten = ADC_ATTEN_DB_12,
        .bitwidth = ADC_BITWIDTH_12,
    };
    if (adc_cali_create_scheme_curve_fitting(&cal, &s_cali) != ESP_OK) {
        s_cali = NULL;
        ESP_LOGW(TAG, "ADC 校准不可用，用原始值");
    }

    s_bat_lock = xSemaphoreCreateMutex();
    if (!s_bat_lock) ESP_LOGW(TAG, "电池采样锁创建失败");

    ESP_LOGI(TAG, "I2C + ADC 就绪");
}

/* ── SHTC3 ─────────────────────────────────────────────────────────── */

esp_err_t sensors_read_th(float *temp_c, float *hum)
{
    if (!s_shtc3) return ESP_ERR_INVALID_STATE;

    static float   s_last_t = 0, s_last_h = 0;
    static int     s_have_last = 0;
    static int     s_last_ok_ms = 0;

    uint8_t wake[2] = { 0x35, 0x17 };
    uint8_t meas[2] = { 0x7C, 0xA2 };
    uint8_t sleep_[2] = { 0xB0, 0x98 };

    /* 串口里偶发的 "measure" 失败 = SHTC3 被上一次半途失败留在了别的状态，
     * 或 I2C 瞬时抖动。这里重试 3 次；每次先补发 sleep 把传感器归一到
     * 已知状态（睡眠中收到 sleep 只会被 NACK，无副作用），再走标准流程。 */
    esp_err_t last = ESP_FAIL;
    for (int attempt = 0; attempt < 3; attempt++) {
        if (attempt) vTaskDelay(pdMS_TO_TICKS(5));

        i2c_master_transmit(s_shtc3, sleep_, 2, 100);   /* 归一化，成败不管 */
        vTaskDelay(pdMS_TO_TICKS(1));

        last = i2c_master_transmit(s_shtc3, wake, 2, 100);
        if (last != ESP_OK) continue;
        vTaskDelay(pdMS_TO_TICKS(1));

        last = i2c_master_transmit(s_shtc3, meas, 2, 100);
        if (last != ESP_OK) continue;
        vTaskDelay(pdMS_TO_TICKS(15));

        uint8_t d[6];
        last = i2c_master_receive(s_shtc3, d, 6, 200);
        i2c_master_transmit(s_shtc3, sleep_, 2, 100);   /* 读完就睡（成败都发） */
        if (last != ESP_OK) continue;

        if (crc8(d, 2) != d[2] || crc8(d + 3, 2) != d[5]) {
            last = ESP_ERR_INVALID_CRC;
            continue;
        }

        uint16_t rt = (d[0] << 8) | d[1];
        uint16_t rh = (d[3] << 8) | d[4];
        s_last_t = -45.0f + 175.0f * rt / 65536.0f;
        s_last_h = 100.0f * rh / 65536.0f;
        s_have_last = 1;
        s_last_ok_ms = (int)(xTaskGetTickCount() * portTICK_PERIOD_MS);
        if (attempt) ESP_LOGD(TAG, "重试 %d 次后读到温湿度", attempt);
        *temp_c = s_last_t;
        *hum = s_last_h;
        return ESP_OK;
    }

    /* 3 次都失败：60 秒内有过好读数就先沿用旧值 —— UI 每秒都读一次，
     * 单次瞬时失败不该让界面闪 "--"；超时才如实显示 -- */
    if (s_have_last &&
        (int)(xTaskGetTickCount() * portTICK_PERIOD_MS) - s_last_ok_ms < 60000) {
        *temp_c = s_last_t;
        *hum = s_last_h;
        return ESP_OK;
    }
    ESP_LOGW(TAG, "温湿度读取失败: %s", esp_err_to_name(last));
    return last;
}

/* ── 电池 ──────────────────────────────────────────────────────────── */

/* 电压 → 百分比：3.0V=0%，1% = 11mV，4.10V 及以上=100% */
static int bat_pct_from_mv(int mv)
{
    if (mv >= BAT_FULL_MV) return 100;
    if (mv <= BAT_EMPTY_MV) return 0;
    return (mv - BAT_EMPTY_MV) * 100 / 1100;
}

/* 百分比对应的下限电压，用于迟滞判断 */
static int bat_pct_boundary(int pct)
{
    return BAT_EMPTY_MV + pct * 1100 / 100;
}

/* 采 15 个点取中位数，再和上次值做 EMA。返回 false = 有效点太少 */
static bool battery_sample_mv(int *out)
{
    int vals[15];
    int n = 0;

    for (int i = 0; i < 15; i++) {
        int raw = 0, mv = 0;
        if (adc_oneshot_read(s_adc, BAT_ADC_CH, &raw) != ESP_OK) continue;
        if (s_cali) {
            if (adc_cali_raw_to_voltage(s_cali, raw, &mv) != ESP_OK) continue;
        } else {
            mv = raw * 3300 / 4095;
        }
        vals[n++] = mv * 3;             /* 分压比 ×3 */
    }
    if (n < 7) return false;

    /* 插入排序，15 个点足够快 */
    for (int i = 1; i < n; i++) {
        int x = vals[i], j = i - 1;
        while (j >= 0 && vals[j] > x) {
            vals[j + 1] = vals[j];
            j--;
        }
        vals[j + 1] = x;
    }

    int med = vals[n / 2];
    if (s_bat_mv <= 0) s_bat_mv = med;
    else s_bat_mv = (s_bat_mv * 3 + med + 2) / 4;

    *out = s_bat_mv;
    return true;
}

/* 调用时必须持有 s_bat_lock */
static void battery_refresh(int64_t now_us)
{
    int mv = 0;
    if (!battery_sample_mv(&mv)) {
        s_bat_at_us = now_us;           /* 失败也歇 5s，别在 UI 循环里狂读 */
        return;
    }

    int raw = bat_pct_from_mv(mv);
    if (s_bat_pct < 0) {
        s_bat_pct = raw;
    } else if (raw > s_bat_pct) {
        if (mv >= bat_pct_boundary(s_bat_pct + 1)) s_bat_pct++;
    } else if (raw < s_bat_pct) {
        int down = (s_bat_pct == 100) ? BAT_FULL_EXIT_MV
                                      : bat_pct_boundary(s_bat_pct) - BAT_STEP_DEAD_MV;
        if (mv <= down) s_bat_pct--;
    }

    s_bat_at_us = now_us;
    ESP_LOGD(TAG, "电池 %d mV -> %d%%", mv, s_bat_pct);
}

static int battery_cached(bool want_pct)
{
    if (!s_adc) return -1;

    if (s_bat_lock) xSemaphoreTake(s_bat_lock, portMAX_DELAY);
    int64_t now = esp_timer_get_time();
    if (s_bat_at_us == 0 || now - s_bat_at_us >= BAT_CACHE_US) battery_refresh(now);
    int v = want_pct ? s_bat_pct : s_bat_mv;
    if (s_bat_lock) xSemaphoreGive(s_bat_lock);
    return v;
}

int sensors_battery_pct(void)
{
    return battery_cached(true);
}

int sensors_battery_mv(void)
{
    return battery_cached(false);
}
