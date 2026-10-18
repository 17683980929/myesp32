/**
 * pcf85063.c — PCF85063 实时时钟
 *
 * 寄存器（BCD）：0x04 秒(bit7=OS) 0x05 分 0x06 时(24h) 0x07 日
 *                0x08 星期 0x09 月 0x0A 年
 * （0x00/0x01 控制寄存器，0x02 Offset，0x03 RAM）
 * 时间无效时（OS=1）用编译时间 +8 小时写入，保证离线也有完整时间；
 * 以后服务器连上后可用 pcf85063_set() 校正。
 */

#include "pcf85063.h"
#include <stdio.h>
#include <string.h>
#include "driver/i2c_master.h"
#include "esp_log.h"
#include "sensors.h"
#include "hw_config.h"

static const char *TAG = "rtc";
static i2c_master_dev_handle_t s_dev = NULL;

/* ── BCD ───────────────────────────────────────────────────────────── */

static uint8_t bcd2bin(uint8_t v) { return (uint8_t)((v >> 4) * 10 + (v & 0x0F)); }
static uint8_t bin2bcd(uint8_t v) { return (uint8_t)(((v / 10) << 4) | (v % 10)); }

/* ── I2C 寄存器读写 ────────────────────────────────────────────────── */

static int rd(uint8_t *buf, size_t n)
{
    uint8_t reg = 0x04;                  /* PCF85063A: 秒寄存器 0x04 */
    if (!s_dev) return -1;
    if (i2c_master_transmit(s_dev, &reg, 1, 100) != ESP_OK) return -1;
    if (i2c_master_receive(s_dev, buf, n, 100) != ESP_OK) return -1;
    return 0;
}

static int wr(const uint8_t *buf, size_t n)
{
    uint8_t tmp[8];
    if (!s_dev || n > 7) return -1;
    tmp[0] = 0x04;
    memcpy(tmp + 1, buf, n);
    return i2c_master_transmit(s_dev, tmp, n + 1, 100) == ESP_OK ? 0 : -1;
}

/* ── 公历 ↔ 天数（Howard Hinnant 算法，无时区依赖）───────────────── */

static long days_from_civil(int y, int m, int d)
{
    y -= m <= 2;
    long era = (y >= 0 ? y : y - 399) / 400;
    unsigned yoe = (unsigned)(y - era * 400);
    unsigned doy = (unsigned)((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1);
    unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097L + (long)doe - 719468L;
}

static void civil_from_days(long z, int *py, int *pm, int *pd)
{
    z += 719468;
    long era = (z >= 0 ? z : z - 146096) / 146097;
    unsigned doe = (unsigned)(z - era * 146097);
    unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    long y = (long)yoe + era * 400;
    unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    unsigned mp = (5 * doy + 2) / 153;
    unsigned d = doy - (153 * mp + 2) / 5 + 1;
    unsigned m = mp + (mp < 10 ? 3 : -9);
    *py = (int)(y + (m <= 2));
    *pm = (int)m;
    *pd = (int)d;
}

/* 编译时间（CI 在 UTC 环境编译） */
static void compile_time(int *Y, int *Mo, int *D, int *H, int *Mi, int *S)
{
    static const char *MN[12] = { "Jan","Feb","Mar","Apr","May","Jun",
                                  "Jul","Aug","Sep","Oct","Nov","Dec" };
    char mon[4] = { 0 };
    int d = 1, y = 2026, h = 0, mi = 0, s = 0;

    sscanf(__DATE__, "%3s %d %d", mon, &d, &y);
    sscanf(__TIME__, "%d:%d:%d", &h, &mi, &s);

    int m = 1;
    for (int i = 0; i < 12; i++)
        if (!strcmp(mon, MN[i])) m = i + 1;

    *Y = y; *Mo = m; *D = d; *H = h; *Mi = mi; *S = s;
}

/* ── 公共接口 ──────────────────────────────────────────────────────── */

void pcf85063_init(void)
{
    i2c_master_bus_handle_t bus = sensors_i2c_bus();
    if (!bus) {
        ESP_LOGW(TAG, "I2C 总线未就绪，RTC 不可用");
        return;
    }

    i2c_device_config_t cfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = RTC_ADDR,
        .scl_speed_hz = I2C_FREQ_HZ,
    };
    if (i2c_master_bus_add_device(bus, &cfg, &s_dev) != ESP_OK) {
        ESP_LOGW(TAG, "RTC 设备注册失败");
        s_dev = NULL;
        return;
    }

    uint8_t r[7];
    if (rd(r, 7) == 0 && !(r[0] & 0x80)) {
        ESP_LOGI(TAG, "RTC 有效：20%02X-%02X-%02X %02X:%02X:%02X",
                 bcd2bin(r[6]), bcd2bin(r[5] & 0x1F), bcd2bin(r[3] & 0x3F),
                 bcd2bin(r[2] & 0x3F), bcd2bin(r[1] & 0x7F), bcd2bin(r[0] & 0x7F));
        return;
    }

    /* 时间无效：用编译时间 +8 小时（北京时间）兜底 */
    int Y, Mo, D, H, Mi, S;
    compile_time(&Y, &Mo, &D, &H, &Mi, &S);

    long epoch = days_from_civil(Y, Mo, D) * 86400L + H * 3600L + Mi * 60L + S
                 + LOCAL_TZ_HOURS * 3600L;
    long days = epoch / 86400L;
    int sod = (int)(epoch % 86400L);
    civil_from_days(days, &Y, &Mo, &D);
    H = sod / 3600;
    Mi = sod / 60 % 60;
    S = sod % 60;

    if (pcf85063_set(Y, Mo, D, H, Mi, S) == 0) {
        ESP_LOGW(TAG, "RTC 无效，已用编译时间+8h 初始化："
                      "%04d-%02d-%02d %02d:%02d:%02d", Y, Mo, D, H, Mi, S);
    } else {
        ESP_LOGE(TAG, "RTC 写入失败");
    }
}

int pcf85063_set(int year, int mon, int day, int hour, int min, int sec)
{
    long days = days_from_civil(year, mon, day);
    int wd = (int)((days + 4) % 7);          /* 1970-01-01 是周四 */
    if (wd < 0) wd += 7;

    uint8_t b[7];
    b[0] = bin2bcd((uint8_t)sec);            /* bit7=0 清 OS 标志 */
    b[1] = bin2bcd((uint8_t)min);
    b[2] = bin2bcd((uint8_t)hour);           /* bit6=0 24 小时制 */
    b[3] = bin2bcd((uint8_t)day);
    b[4] = (uint8_t)wd;
    b[5] = bin2bcd((uint8_t)mon);
    b[6] = bin2bcd((uint8_t)(year % 100));
    return wr(b, 7);
}

int pcf85063_get(int *year, int *mon, int *day, int *wday,
                 int *hour, int *min, int *sec)
{
    uint8_t r[7];
    if (rd(r, 7) != 0) return -1;
    if (r[0] & 0x80) return -1;              /* OS=1：时间不可信 */

    *sec  = bcd2bin(r[0] & 0x7F);
    *min  = bcd2bin(r[1] & 0x7F);
    *hour = bcd2bin(r[2] & 0x3F);
    *day  = bcd2bin(r[3] & 0x3F);
    *wday = r[4] & 0x07;
    *mon  = bcd2bin(r[5] & 0x1F);
    *year = 2000 + bcd2bin(r[6]);

    /* 基本合法性检查，防止 I2C 噪声导致乱码时间 */
    if (*sec > 59 || *min > 59 || *hour > 23 ||
        *day < 1 || *day > 31 || *mon < 1 || *mon > 12)
        return -1;
    return 0;
}
