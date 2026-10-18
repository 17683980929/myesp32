/**
 * rtc.h — PCF85063 实时时钟（I2C 0x51，与 SHTC3 同总线）
 */
#pragma once

/**
 * 初始化：把 RTC 挂到传感器 I2C 总线上。
 * 若振荡器停过（OS=1，说明断电丢过时间），用编译时间（UTC+8）写入兜底。
 */
void rtc_init(void);

/**
 * 读当前时间。成功返回 0；RTC 不可用/时间无效返回 -1。
 * wday：0=周日 … 6=周六
 */
int rtc_get(int *year, int *mon, int *day, int *wday,
            int *hour, int *min, int *sec);

/** 写时间（供以后服务器校时用）。成功返回 0 */
int rtc_set(int year, int mon, int day, int hour, int min, int sec);
