/**
 * sensors.h — 板载传感器：SHTC3 温湿度 + 电池电压
 */
#pragma once
#include <stdint.h>
#include "esp_err.h"
#include "driver/i2c_master.h"

/** 初始化 I2C 总线 + ADC */
void sensors_init(void);

/** 共享 I2C 总线句柄（RTC 等外设挂在同一条总线上），init 之前返回 NULL */
i2c_master_bus_handle_t sensors_i2c_bus(void);

/** SHTC3 读温湿度。失败返回非 0，值不变 */
esp_err_t sensors_read_th(float *temp_c, float *hum);

/** 电池百分比 0-100（5s 缓存 + 中位数/EMA + 迟滞，避免 99/100 抖动） */
int sensors_battery_pct(void);

/** 电池电压 mV（5s 缓存 + 中位数/EMA 滤波后的值） */
int sensors_battery_mv(void);
