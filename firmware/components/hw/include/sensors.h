/**
 * sensors.h — 板载传感器：SHTC3 温湿度 + 电池电压
 */
#pragma once
#include <stdint.h>
#include "esp_err.h"

/** 初始化 I2C 总线 + ADC */
void sensors_init(void);

/** SHTC3 读温湿度。失败返回非 0，值不变 */
esp_err_t sensors_read_th(float *temp_c, float *hum);

/** 电池百分比 0-100（ADC 读 10 次平均后按厂家公式换算） */
int sensors_battery_pct(void);

/** 电池电压 mV */
int sensors_battery_mv(void);
