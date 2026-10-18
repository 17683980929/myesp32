/**
 * sensors.c — SHTC3 温湿度 + 电池 ADC
 *
 * SHTC3：I2C 0x70，命令字连续半字节流（16 位大端）。
 *   唤醒 0x3517 / 睡眠 0xB098 / 软复位 0x805D / 测量(T 在前, 正常模式) 0x7CA2
 *   读回 6 字节：T_MSB T_LSB T_CRC RH_MSB RH_LSB RH_CRC，CRC-8 多项式 0x31
 * 电池：ADC1_CH3，读 10 次平均 ×3，厂家二次拟合公式。
 */

#include "sensors.h"
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/i2c_master.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"
#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"
#include "esp_log.h"
#include "esp_check.h"
#include "hw_config.h"

static const char *TAG = "sensors";

static i2c_master_bus_handle_t s_bus = NULL;
static i2c_master_dev_handle_t s_shtc3 = NULL;
static adc_oneshot_unit_handle_t s_adc = NULL;
static adc_cali_handle_t s_cali = NULL;

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

    ESP_LOGI(TAG, "I2C + ADC 就绪");
}

/* ── SHTC3 ─────────────────────────────────────────────────────────── */

esp_err_t sensors_read_th(float *temp_c, float *hum)
{
    if (!s_shtc3) return ESP_ERR_INVALID_STATE;

    /* 唤醒 → 测量(T 在前, 正常模式) → 读 6 字节 → 睡眠 */
    uint8_t wake[2] = { 0x35, 0x17 };
    uint8_t meas[2] = { 0x7C, 0xA2 };
    uint8_t sleep_[2] = { 0xB0, 0x98 };

    ESP_RETURN_ON_ERROR(i2c_master_transmit(s_shtc3, wake, 2, 100), TAG, "wake");
    vTaskDelay(pdMS_TO_TICKS(1));

    ESP_RETURN_ON_ERROR(i2c_master_transmit(s_shtc3, meas, 2, 100), TAG, "measure");
    vTaskDelay(pdMS_TO_TICKS(15));

    uint8_t d[6];
    esp_err_t e = i2c_master_receive(s_shtc3, d, 6, 200);
    if (e != ESP_OK) return e;

    i2c_master_transmit(s_shtc3, sleep_, 2, 100);       /* 读完就睡 */

    if (crc8(d, 2) != d[2] || crc8(d + 3, 2) != d[5]) {
        ESP_LOGW(TAG, "CRC 不匹配");
        return ESP_ERR_INVALID_CRC;
    }

    uint16_t rt = (d[0] << 8) | d[1];
    uint16_t rh = (d[3] << 8) | d[4];
    *temp_c = -45.0f + 175.0f * rt / 65536.0f;
    *hum    = 100.0f * rh / 65536.0f;
    return ESP_OK;
}

/* ── 电池 ──────────────────────────────────────────────────────────── */

static int battery_mv(void)
{
    int raw = 0, mv = 0;
    adc_oneshot_read(s_adc, BAT_ADC_CH, &raw);
    if (s_cali) adc_cali_raw_to_voltage(s_cali, raw, &mv);
    else mv = raw * 3300 / 4095;

    /* 分压比 ×3（厂家原样） */
    int voltage = mv * 3;

    /* 10 次平均降噪 */
    int sum = 0;
    for (int i = 0; i < 10; i++) {
        adc_oneshot_read(s_adc, BAT_ADC_CH, &raw);
        if (s_cali) adc_cali_raw_to_voltage(s_cali, raw, &mv);
        else mv = raw * 3300 / 4095;
        sum += mv * 3;
    }
    (void)voltage;
    return sum / 10;
}

int sensors_battery_pct(void)
{
    int v = battery_mv();
    /* 厂家二次拟合：v 单位 mV */
    int pct = (-1 * v * v + 9016 * v - 19189000) / 10000;
    if (pct > 100) pct = 100;
    if (pct < 0) pct = 0;
    return pct;
}

int sensors_battery_mv(void)
{
    return battery_mv();
}
