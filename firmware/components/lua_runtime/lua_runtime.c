/**
 * lua_runtime.c — Lua 解释器运行时（M5）
 *
 * 设计要点：
 *   - 单任务独占 lua_State（Lua 本身非线程安全）；WS 线程只投递队列。
 *   - 每次执行（部署/开机脚本/定时器回调）都设 2 秒墙钟超时（debug hook
 *     每 2 万条指令查一次；sys.delay 的等待时间不计入）。
 *   - 自定义分配器，整个状态内存上限 128KB（超限返回 NULL，Lua 报内存错误）。
 *   - 白名单 API：display / pet / sensor / sys / timer；扩展能力 gpio /
 *     audio / rtc / wifi / ble / sys.reboot 需脚本第一行 `-- @perm` 声明；
 *     io / os / package / debug 标准库不加载，dofile / loadfile 摘掉。
 *   - 每次部署先关旧状态再建新状态：脚本互不污染、旧定时器自然清空。
 *   - 持久化：执行成功才写 /fatfs/scripts/active.lua（写失败只告警）；
 *     开机执行失败则改名 active.broken.lua，不再重跑（防开机循环）。
 *
 * 脚本可用的 API（详见 register_apis / open_sandbox）：
 *   display.clear()  display.text(x, y, s[, size])  display.rect(x, y, w, h[, filled])
 *   display.flush()  display.close()               -- close：主动关画布回主页
 *   pet.state("happy")            -- idle/blink/listening/.../charging，返回是否认识
 *                                 -- "auto" = 交还自动状态（脚本控制结束）
 *   sensor.temp() sensor.hum() sensor.battery() sensor.voltage()
 *   sys.millis() sys.delay(ms≤1000) sys.log(...)   print(...)
 *   sys.on("key_click"/"key_double"/"open_timetable"/"open_env"/"canvas_close"/"canvas_next"/"round_1..3", fn)  -- 事件绑定（重复注册=替换）
 *   timer.after(ms, fn) timer.every(ms, fn)        -- 最多 16 个
 */

#include "lua_runtime.h"
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <ctype.h>
#include <sys/stat.h>
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_heap_caps.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "esp_vfs_fat.h"
#include "wear_levelling.h"
#include "sensors.h"
#include "pcf85063.h"
#include "ui.h"
#include "audio.h"
#include "wifi_sta.h"
#include "ble.h"
#include "driver/gpio.h"
#include "esp_system.h"
#include "esp_http_client.h"
#include "esp_crt_bundle.h"
#include <dirent.h>
#include "lua.h"
#include "lauxlib.h"
#include "lualib.h"

static const char *TAG = "lua";

#define LUA_MEM_CAP       (128 * 1024)
/* Lua 任务栈：必须在内部 RAM —— 脚本部署会写 fatfs，flash 写入期间 cache 关闭、
 * PSRAM 不可访问，栈放在 PSRAM 会直接崩。
 * 6144 字 = 24KB：实测跑完 fatfs 挂载 + 开机脚本 + 框架加载后水位是
 * "余量 4524/8192 字"（即只用了 3668 字），降到 6144 仍留 ~9.9KB 余量。 */
#define LUA_STACK_WORDS   6144
#define EXEC_TIMEOUT_US   (2000 * 1000)
#define OUT_CAP           2048
#define CODE_MAX          6144
#define TIMER_MAX         16
#define DEPLOY_Q_LEN      4

#define MOUNT_POINT       "/fatfs"
#define SCRIPT_DIR        MOUNT_POINT "/scripts"
#define USER_DIR          MOUNT_POINT "/user"
#define ACTIVE_PATH       SCRIPT_DIR "/active.lua"
#define TMP_PATH          SCRIPT_DIR "/tmp.lua"
#define BROKEN_PATH       SCRIPT_DIR "/active.broken.lua"
#define FS_FILE_MAX       8192
#define NET_BODY_MAX      16384

/* ── 运行时状态 ────────────────────────────────────────────────────── */

static lua_State      *s_L;
static TaskHandle_t    s_task;
static QueueHandle_t   s_q;
static lua_result_cb_t s_result_cb;
static wl_handle_t     s_wl;
static int             s_fs_ok;

static int             s_mem_used;         /* 分配器统计 */
static int64_t         s_exec_start_us;    /* 本次执行墙钟起点 */
static int64_t         s_paused_us;        /* sys.delay 累计暂停时间 */
static int             s_hook_active;      /* 只在执行脚本主体时计时 */

/* ── 能力权限 ──────────────────────────────────────────────────────────
 * 脚本第一行的 `-- @perm gpio,audio,...` 决定能调用哪些扩展 API。
 * 旧的 display/sensor/timer/sys 基础 API 不需要声明；扩展 API 默认拒绝。 */
#define PERM_GPIO      (1u << 0)
#define PERM_GPIO_ALL  (1u << 1)
#define PERM_AUDIO     (1u << 2)
#define PERM_RTC       (1u << 3)
#define PERM_WIFI      (1u << 4)
#define PERM_BLE       (1u << 5)
#define PERM_SYS       (1u << 6)
#define PERM_FS        (1u << 7)
#define PERM_NET       (1u << 8)

static uint32_t s_perms;

static void parse_perms(const char *code)
{
    s_perms = 0;
    if (!code) return;

    const char *p = code;
    for (int line = 0; line < 12 && p && *p; line++) {
        const char *nl = strchr(p, '\n');
        size_t len = nl ? (size_t)(nl - p) : strlen(p);
        const char *at = NULL;
        for (size_t i = 0; i + 5 <= len; i++) {
            if (!strncmp(p + i, "@perm", 5)) {
                at = p + i + 5;
                break;
            }
        }
        if (at) {
            char buf[160];
            size_t n = 0;
            while (at < p + len && n < sizeof(buf) - 1) buf[n++] = *at++;
            buf[n] = 0;

            char *s = buf;
            while (*s) {
                while (*s == ',' || *s == ' ' || *s == '\t' || *s == '\r') s++;
                char *tok = s;
                while (*s && *s != ',' && *s != ' ' && *s != '\t' && *s != '\r') s++;
                if (s == tok) continue;
                char saved = *s;
                *s = 0;
                if (!strcmp(tok, "gpio")) s_perms |= PERM_GPIO;
                else if (!strcmp(tok, "gpio:all")) s_perms |= PERM_GPIO | PERM_GPIO_ALL;
                else if (!strcmp(tok, "audio")) s_perms |= PERM_AUDIO;
                else if (!strcmp(tok, "rtc")) s_perms |= PERM_RTC;
                else if (!strcmp(tok, "wifi")) s_perms |= PERM_WIFI;
                else if (!strcmp(tok, "ble")) s_perms |= PERM_BLE;
                else if (!strcmp(tok, "sys")) s_perms |= PERM_SYS;
                else if (!strcmp(tok, "fs")) s_perms |= PERM_FS;
                else if (!strcmp(tok, "net")) s_perms |= PERM_NET;
                /* display/sensor/timer 是默认能力，写了也不影响 */
                if (!saved) break;
                *s = saved;
                s++;
            }
            break;
        }
        if (!nl) break;
        p = nl + 1;
    }
}

static int need_perm(lua_State *L, uint32_t bit, const char *name)
{
    if (s_perms & bit) return 0;
    return luaL_error(L, "权限不足：%s（脚本第一行加 -- @perm %s）", name, name);
}

/* 以下三块都放 PSRAM：合计 ~10KB 内部 RAM 让给 BLE 主机/控制器 */
static char            *s_out;             /* 回执输出（print/sys.log/返回值） */
static int             s_out_len;
static int             s_capture;          /* 只有部署执行期间收集输出 */
static char            *s_err;             /* 最近一次错误文本 */
static char            *s_code_buf;        /* 开机脚本 / 回滚脚本缓冲 */

typedef struct {
    int      ref;                          /* registry 引用；0=空槽 */
    uint32_t period_ms;
    uint32_t next_ms;
    uint8_t  one_shot;
} timer_slot_t;

static timer_slot_t    s_timers[TIMER_MAX];

typedef struct {
    int      id;                           /* ≥0：部署请求；-1：事件消息 */
    int      evt;                          /* 事件序号（id=-1 时有效） */
    int      check;                        /* 1 = dry-run，不持久化/不生效 */
    uint32_t stamp;                        /* 事件入队时刻（丢弃过期事件用） */
    char *code;                            /* 部署代码（堆上；任务里释放） */
} deploy_msg_t;

static uint32_t ms_now(void)
{
    return (uint32_t)(xTaskGetTickCount() * portTICK_PERIOD_MS);
}

/* ── 内存上限分配器 ────────────────────────────────────────────────── */

static void *lua_alloc(void *ud, void *ptr, size_t osize, size_t nsize)
{
    (void)ud;
    if (nsize == 0) {
        if (ptr) {
            s_mem_used -= (int)osize;
            heap_caps_free(ptr);
        }
        return NULL;
    }
    /* Lua 状态放 PSRAM：内部 RAM 要留给 BLE 控制器/音频/WS，
     * 之前 Lua 占内部堆导致 BLE 初始化 Malloc failed。 */
    if (!ptr) {
        if (s_mem_used + (int)nsize > LUA_MEM_CAP) return NULL;
        void *p = heap_caps_malloc(nsize, MALLOC_CAP_SPIRAM);
        if (p) s_mem_used += (int)nsize;
        return p;
    }
    if (nsize > osize && s_mem_used + (int)(nsize - osize) > LUA_MEM_CAP) return NULL;
    void *p = heap_caps_realloc(ptr, nsize, MALLOC_CAP_SPIRAM);
    if (p) s_mem_used += (int)nsize - (int)osize;
    return p;
}

/* ── 超时钩子 ──────────────────────────────────────────────────────── */

static void timeout_hook(lua_State *L, lua_Debug *ar)
{
    (void)ar;
    if (!s_hook_active) return;
    if (esp_timer_get_time() - s_exec_start_us - s_paused_us > EXEC_TIMEOUT_US)
        luaL_error(L, "脚本执行超时（超过 2 秒）");
}

/* ── 输出收集 ──────────────────────────────────────────────────────── */

static void out_reset(void)
{
    s_out_len = 0;
    s_out[0] = 0;
}

static void out_append(const char *s)
{
    if (!s) return;
    ESP_LOGI(TAG, "lua> %s", s);
    if (!s_capture) return;
    int l = (int)strlen(s);
    if (s_out_len + l > OUT_CAP - 4) return;   /* 满了就丢后面的（回执里有头就够） */
    memcpy(s_out + s_out_len, s, l);
    s_out_len += l;
    s_out[s_out_len] = 0;
}

/* ── 白名单 API ────────────────────────────────────────────────────── */

/** print / sys.log：参数转成一行文本，收集 + 打串口 */
static int collect_args(lua_State *L)
{
    int n = lua_gettop(L);
    char line[256];
    int used = 0;
    for (int i = 1; i <= n && used < (int)sizeof(line) - 2; i++) {
        const char *s = luaL_tolstring(L, i, NULL);
        if (!s) s = "?";
        if (i > 1 && used < (int)sizeof(line) - 2) line[used++] = '\t';
        for (const char *p = s; *p && used < (int)sizeof(line) - 2; p++) line[used++] = *p;
        lua_pop(L, 1);                        /* 弹出 tolstring 压入的字符串 */
    }
    line[used] = 0;
    out_append(line);
    return 0;
}

static int l_print(lua_State *L)   { return collect_args(L); }
static int l_sys_log(lua_State *L) { return collect_args(L); }

/* display.* */
static int l_display_clear(lua_State *L) { (void)L; ui_lua_clear(); return 0; }

static int l_display_text(lua_State *L)
{
    int x = (int)luaL_checkinteger(L, 1);
    int y = (int)luaL_checkinteger(L, 2);
    const char *s = luaL_checkstring(L, 3);
    int size = (int)luaL_optinteger(L, 4, 16);
    ui_lua_text(x, y, s, size);
    return 0;
}

static int l_display_rect(lua_State *L)
{
    int x = (int)luaL_checkinteger(L, 1);
    int y = (int)luaL_checkinteger(L, 2);
    int w = (int)luaL_checkinteger(L, 3);
    int h = (int)luaL_checkinteger(L, 4);
    int filled = lua_toboolean(L, 5);
    ui_lua_rect(x, y, w, h, filled);
    return 0;
}

static int l_display_flush(lua_State *L) { (void)L; ui_lua_flush(); return 0; }

/** display.close()：脚本主动关掉画布（固件不再内置"单击关画布"）。
 *  清保鲜 + 立即重绘一帧主页——关闭无感知延迟，不用等主循环下一跳。 */
static int l_display_close(lua_State *L)
{
    (void)L;
    ui_lua_release();
    ui_render();
    return 0;
}

/* pet.* */
static int l_pet_state(lua_State *L)
{
    const char *name = luaL_checkstring(L, 1);
    lua_pushboolean(L, ui_lua_pet_state(name));
    return 1;
}

/* sensor.*（2 秒内复用同一次读数，避免连读两条 I2C 时序） */
static float   s_st = -99, s_sh = -1;
static int64_t s_sensor_us;

static void sensor_refresh(void)
{
    int64_t now = esp_timer_get_time();
    if (now - s_sensor_us < 2000000) return;
    float t = -99, h = -1;
    sensors_read_th(&t, &h);
    s_st = t;
    s_sh = h;
    s_sensor_us = now;
}

static int l_sensor_temp(lua_State *L)    { sensor_refresh(); lua_pushnumber(L, s_st); return 1; }
static int l_sensor_hum(lua_State *L)     { sensor_refresh(); lua_pushnumber(L, s_sh); return 1; }
static int l_sensor_battery(lua_State *L) { lua_pushinteger(L, sensors_battery_pct()); return 1; }
static int l_sensor_voltage(lua_State *L) { lua_pushinteger(L, sensors_battery_mv()); return 1; }

/* sys.* */
static int l_sys_millis(lua_State *L)
{
    lua_pushinteger(L, (lua_Integer)ms_now());
    return 1;
}

static int l_sys_delay(lua_State *L)
{
    int ms = (int)luaL_checkinteger(L, 1);
    if (ms < 0) ms = 0;
    if (ms > 1000) ms = 1000;                 /* 单次等待不超过 1 秒；长等待用 timer */
    int64_t t0 = esp_timer_get_time();
    vTaskDelay(pdMS_TO_TICKS(ms));
    s_paused_us += esp_timer_get_time() - t0; /* 等得久不算超时 */
    return 0;
}

/** sys.clock() → 当天秒数(0..86399), 星期(0=周日)；读不到 RTC 返回 -1,-1 */
static int l_sys_clock(lua_State *L)
{
    int Y, Mo, D, Wd, H, Mi, S;
    if (pcf85063_get(&Y, &Mo, &D, &Wd, &H, &Mi, &S) != 0) {
        lua_pushinteger(L, -1);
        lua_pushinteger(L, -1);
        return 2;
    }
    lua_pushinteger(L, H * 3600 + Mi * 60 + S);
    lua_pushinteger(L, Wd % 7);
    return 2;
}

/* timer.* */
static void timers_clear(void)
{
    for (int i = 0; i < TIMER_MAX; i++)
        s_timers[i].ref = 0;                  /* 引用随 lua_State 关闭一起消失 */
}

static int timer_add(lua_State *L, int one_shot)
{
    int ms = (int)luaL_checkinteger(L, 1);
    luaL_checktype(L, 2, LUA_TFUNCTION);
    if (ms < 10) ms = 10;
    if (ms > 3600000) ms = 3600000;
    for (int i = 0; i < TIMER_MAX; i++) {
        if (!s_timers[i].ref) {
            lua_pushvalue(L, 2);
            s_timers[i].ref = luaL_ref(L, LUA_REGISTRYINDEX);
            s_timers[i].period_ms = (uint32_t)ms;
            s_timers[i].next_ms = ms_now() + (uint32_t)ms;
            s_timers[i].one_shot = (uint8_t)one_shot;
            lua_pushinteger(L, i + 1);        /* 句柄（当前用不到，保留） */
            return 1;
        }
    }
    return luaL_error(L, "定时器已满（最多 %d 个）", TIMER_MAX);
}

static int l_timer_after(lua_State *L) { return timer_add(L, 1); }
static int l_timer_every(lua_State *L) { return timer_add(L, 0); }

/* ── 事件绑定（sys.on）───────────────────────────────────────────────
 * 处理器存在 registry 引用里，随 lua_State 一起销毁（run_code 里复位）。
 * 事件从别的任务投递（按键任务），由 lua 任务串行执行，护栏同定时器。 */

#define EVT_COUNT 9
static const char *const s_evt_names[EVT_COUNT] = {
    "key_click", "key_double",                       /* 按键（脚本自己用） */
    "open_timetable", "open_env", "canvas_close", "canvas_next",   /* 服务器/助手技能 */
    "round_1", "round_2", "round_3",                 /* 补课轮次切换 */
};
static int s_evt_ref[EVT_COUNT] = {
    LUA_NOREF, LUA_NOREF, LUA_NOREF, LUA_NOREF, LUA_NOREF,
    LUA_NOREF, LUA_NOREF, LUA_NOREF, LUA_NOREF,
};
static uint32_t s_evt_min_stamp[EVT_COUNT];    /* 早于此时刻入队的同类事件作废（见 drop_pending） */

static int l_sys_on(lua_State *L)
{
    const char *name = luaL_checkstring(L, 1);
    luaL_checktype(L, 2, LUA_TFUNCTION);
    for (int i = 0; i < EVT_COUNT; i++) {
        if (strcmp(name, s_evt_names[i])) continue;
        if (s_evt_ref[i] != LUA_NOREF) luaL_unref(L, LUA_REGISTRYINDEX, s_evt_ref[i]);
        lua_pushvalue(L, 2);
        s_evt_ref[i] = luaL_ref(L, LUA_REGISTRYINDEX);   /* 重复注册 = 替换 */
        return 0;
    }
    char list[128] = "";
    for (int i = 0; i < EVT_COUNT; i++) {
        if (i) strncat(list, " / ", sizeof(list) - strlen(list) - 1);
        strncat(list, s_evt_names[i], sizeof(list) - strlen(list) - 1);
    }
    return luaL_error(L, "不支持的事件：%s（可用：%s）", name, list);
}

/* ── 扩展能力：GPIO / 音频 / RTC / 状态 / 重启 ─────────────────────── */

static int gpio_pin_ok(lua_State *L, int pin)
{
    if (pin < 0 || pin > 48) return luaL_error(L, "GPIO 引脚范围 0~48");
    if ((pin >= 26 && pin <= 37) || pin == 19 || pin == 20)
        return luaL_error(L, "GPIO%d 保留给 USB/Flash/PSRAM，不开放", pin);
    if (!(s_perms & PERM_GPIO_ALL)) {
        if (pin != 1 && pin != 2 && pin != 3 && pin != 43 && pin != 44)
            return luaL_error(L, "GPIO%d 需要 gpio:all 权限", pin);
    }
    return 0;
}

static int l_gpio_mode(lua_State *L)
{
    need_perm(L, PERM_GPIO, "gpio");
    int pin = (int)luaL_checkinteger(L, 1);
    gpio_pin_ok(L, pin);
    const char *mode = luaL_checkstring(L, 2);

    gpio_config_t io = { 0 };
    io.pin_bit_mask = 1ULL << pin;
    io.intr_type = GPIO_INTR_DISABLE;
    if (!strcmp(mode, "in")) {
        io.mode = GPIO_MODE_INPUT;
    } else if (!strcmp(mode, "in_pullup")) {
        io.mode = GPIO_MODE_INPUT;
        io.pull_up_en = GPIO_PULLUP_ENABLE;
    } else if (!strcmp(mode, "in_pulldown")) {
        io.mode = GPIO_MODE_INPUT;
        io.pull_down_en = GPIO_PULLDOWN_ENABLE;
    } else if (!strcmp(mode, "out")) {
        io.mode = GPIO_MODE_OUTPUT;
    } else {
        return luaL_error(L, "mode 只能是 in/out/in_pullup/in_pulldown");
    }

    lua_pushboolean(L, gpio_config(&io) == ESP_OK);
    return 1;
}

static int l_gpio_write(lua_State *L)
{
    need_perm(L, PERM_GPIO, "gpio");
    int pin = (int)luaL_checkinteger(L, 1);
    gpio_pin_ok(L, pin);
    int level = lua_toboolean(L, 2) ? 1 : 0;
    gpio_set_level(pin, level);
    lua_pushinteger(L, level);
    return 1;
}

static int l_gpio_read(lua_State *L)
{
    need_perm(L, PERM_GPIO, "gpio");
    int pin = (int)luaL_checkinteger(L, 1);
    gpio_pin_ok(L, pin);
    lua_pushinteger(L, gpio_get_level(pin));
    return 1;
}

static int l_gpio_toggle(lua_State *L)
{
    need_perm(L, PERM_GPIO, "gpio");
    int pin = (int)luaL_checkinteger(L, 1);
    gpio_pin_ok(L, pin);
    int level = !gpio_get_level(pin);
    gpio_set_level(pin, level);
    lua_pushinteger(L, level);
    return 1;
}

/* audio.* */
static int l_audio_volume(lua_State *L)
{
    need_perm(L, PERM_AUDIO, "audio");
    if (lua_gettop(L) >= 1 && !lua_isnil(L, 1)) {
        int vol = (int)luaL_checkinteger(L, 1);
        if (vol < 0) vol = 0;
        if (vol > 100) vol = 100;
        audio_volume_set(vol);
    }
    lua_pushinteger(L, audio_volume_get());
    return 1;
}

static int l_audio_chime(lua_State *L) { need_perm(L, PERM_AUDIO, "audio"); audio_play_wake_chime(); return 0; }
static int l_audio_alarm(lua_State *L) { need_perm(L, PERM_AUDIO, "audio"); audio_play_alarm(); return 0; }

/* rtc.* */
static int l_rtc_get(lua_State *L)
{
    need_perm(L, PERM_RTC, "rtc");
    int y = 0, mo = 0, d = 0, wd = 0, h = 0, mi = 0, s = 0;
    if (pcf85063_get(&y, &mo, &d, &wd, &h, &mi, &s) != 0) {
        lua_pushnil(L);
        return 1;
    }
    lua_createtable(L, 0, 7);
    lua_pushinteger(L, y);  lua_setfield(L, -2, "year");
    lua_pushinteger(L, mo); lua_setfield(L, -2, "mon");
    lua_pushinteger(L, d);  lua_setfield(L, -2, "day");
    lua_pushinteger(L, wd); lua_setfield(L, -2, "wday");
    lua_pushinteger(L, h);  lua_setfield(L, -2, "hour");
    lua_pushinteger(L, mi); lua_setfield(L, -2, "min");
    lua_pushinteger(L, s);  lua_setfield(L, -2, "sec");
    return 1;
}

static int l_rtc_set(lua_State *L)
{
    need_perm(L, PERM_RTC, "rtc");
    int y  = (int)luaL_checkinteger(L, 1);
    int mo = (int)luaL_checkinteger(L, 2);
    int d  = (int)luaL_checkinteger(L, 3);
    int h  = (int)luaL_checkinteger(L, 4);
    int mi = (int)luaL_checkinteger(L, 5);
    int s  = (int)luaL_checkinteger(L, 6);
    lua_pushboolean(L, pcf85063_set(y, mo, d, h, mi, s) == 0);
    return 1;
}

/* wifi.status() / ble.status()：只读 */
static int l_wifi_status(lua_State *L)
{
    need_perm(L, PERM_WIFI, "wifi");
    char ip[24] = { 0 }, ssid[40] = { 0 };
    wifi_sta_ip(ip, sizeof(ip));
    wifi_sta_ssid(ssid, sizeof(ssid));

    lua_createtable(L, 0, 4);
    lua_pushboolean(L, wifi_sta_connected());
    lua_setfield(L, -2, "connected");
    lua_pushstring(L, ip);
    lua_setfield(L, -2, "ip");
    lua_pushstring(L, ssid);
    lua_setfield(L, -2, "ssid");
    lua_pushinteger(L, wifi_sta_rssi());
    lua_setfield(L, -2, "rssi");
    return 1;
}

static int l_ble_status(lua_State *L)
{
    need_perm(L, PERM_BLE, "ble");
    lua_createtable(L, 0, 2);
    lua_pushstring(L, ble_state_str());
    lua_setfield(L, -2, "state");
    lua_pushstring(L, ble_name());
    lua_setfield(L, -2, "name");
    return 1;
}

static int l_sys_reboot(lua_State *L)
{
    need_perm(L, PERM_SYS, "sys");
    ESP_LOGW(TAG, "Lua 脚本请求重启");
    esp_restart();
    return 0;
}

/* ── 文件沙箱：/fatfs/user（通过 flash 代理读写）───────────────────── */

static int fs_user_write(const char *name, const char *data);
static int fs_user_read(const char *name, char *buf, int cap);
static int fs_user_list(char *buf, int cap);
static int fs_user_remove(const char *name);

static bool fs_name_ok(const char *name)
{
    size_t n = strlen(name);
    if (n == 0 || n > 32) return false;
    if (!strcmp(name, ".") || !strcmp(name, "..")) return false;
    for (size_t i = 0; i < n; i++) {
        unsigned char c = (unsigned char)name[i];
        if (!isalnum(c) && c != '_' && c != '-' && c != '.') return false;
    }
    return true;
}

static int l_fs_write(lua_State *L)
{
    need_perm(L, PERM_FS, "fs");
    const char *name = luaL_checkstring(L, 1);
    if (!fs_name_ok(name)) return luaL_error(L, "文件名只能 1~32 位字母/数字/._-，不能带路径");
    const char *data = luaL_checkstring(L, 2);
    if (strlen(data) > FS_FILE_MAX) return luaL_error(L, "文件内容最多 %d 字节", FS_FILE_MAX);

    int64_t t0 = esp_timer_get_time();
    int rc = fs_user_write(name, data);
    s_paused_us += esp_timer_get_time() - t0;
    lua_pushboolean(L, rc == 0);
    return 1;
}

static int l_fs_read(lua_State *L)
{
    need_perm(L, PERM_FS, "fs");
    const char *name = luaL_checkstring(L, 1);
    if (!fs_name_ok(name)) return luaL_error(L, "文件名不合法");

    char *buf = heap_caps_malloc(FS_FILE_MAX + 1, MALLOC_CAP_SPIRAM);
    if (!buf) return luaL_error(L, "内存不足");
    int64_t t0 = esp_timer_get_time();
    int n = fs_user_read(name, buf, FS_FILE_MAX);
    s_paused_us += esp_timer_get_time() - t0;
    if (n < 0) lua_pushnil(L);
    else lua_pushlstring(L, buf, (size_t)n);
    free(buf);
    return 1;
}

static int l_fs_list(lua_State *L)
{
    need_perm(L, PERM_FS, "fs");
    char *buf = heap_caps_malloc(4096, MALLOC_CAP_SPIRAM);
    if (!buf) return luaL_error(L, "内存不足");
    int64_t t0 = esp_timer_get_time();
    int n = fs_user_list(buf, 4095);
    s_paused_us += esp_timer_get_time() - t0;
    if (n < 0) lua_pushnil(L);
    else lua_pushlstring(L, buf, (size_t)n);
    free(buf);
    return 1;
}

static int l_fs_remove(lua_State *L)
{
    need_perm(L, PERM_FS, "fs");
    const char *name = luaL_checkstring(L, 1);
    if (!fs_name_ok(name)) return luaL_error(L, "文件名不合法");

    int64_t t0 = esp_timer_get_time();
    int rc = fs_user_remove(name);
    s_paused_us += esp_timer_get_time() - t0;
    lua_pushboolean(L, rc == 0);
    return 1;
}

/* ── 网络：net.get / net.post（同步，最长 15 秒；HTTPS 用证书包）───── */

static int net_result(lua_State *L, int status, const char *body, size_t len, const char *err)
{
    lua_createtable(L, 0, 3);
    lua_pushinteger(L, status);
    lua_setfield(L, -2, "status");
    lua_pushlstring(L, body ? body : "", len);
    lua_setfield(L, -2, "body");
    lua_pushstring(L, err ? err : "");
    lua_setfield(L, -2, "error");
    return 1;
}

static int net_request(lua_State *L, int post)
{
    need_perm(L, PERM_NET, "net");
    const char *url = luaL_checkstring(L, 1);
    size_t url_len = strlen(url);
    if (url_len < 8 || url_len > 500)
        return net_result(L, 0, NULL, 0, "URL 长度不合法");
    if (strncmp(url, "http://", 7) && strncmp(url, "https://", 8))
        return net_result(L, 0, NULL, 0, "只支持 http:// 或 https://");

    const char *body = NULL;
    size_t body_len = 0;
    int arg = 2;
    if (post) {
        body = luaL_checklstring(L, 2, &body_len);
        if (body_len > 8192)
            return net_result(L, 0, NULL, 0, "请求体最多 8192 字节");
        arg = 3;
    }
    int timeout = (int)luaL_optinteger(L, arg, 8000);
    if (timeout < 2000) timeout = 2000;
    if (timeout > 15000) timeout = 15000;

    if (!wifi_sta_connected())
        return net_result(L, 0, NULL, 0, "WiFi 未连接");

    char *out = heap_caps_malloc(NET_BODY_MAX + 1, MALLOC_CAP_SPIRAM);
    if (!out) return net_result(L, 0, NULL, 0, "内存不足");
    out[0] = 0;

    int status = 0, out_len = 0;
    char errbuf[96] = "";
    esp_http_client_config_t cfg = {
        .url = url,
        .timeout_ms = timeout,
        .crt_bundle_attach = esp_crt_bundle_attach,
    };
    esp_http_client_handle_t c = esp_http_client_init(&cfg);
    if (!c) {
        free(out);
        return net_result(L, 0, NULL, 0, "HTTP 初始化失败");
    }

    if (post) {
        esp_http_client_set_method(c, HTTP_METHOD_POST);
        esp_http_client_set_header(c, "Content-Type", "application/json");
    }

    int64_t t0 = esp_timer_get_time();
    esp_err_t e = esp_http_client_open(c, post ? (int)body_len : 0);
    if (e == ESP_OK && post && body_len) {
        int w = esp_http_client_write(c, body, body_len);
        if (w != (int)body_len) e = ESP_FAIL;
    }
    if (e == ESP_OK) {
        int64_t content_len = esp_http_client_fetch_headers(c);
        if (content_len < 0) e = ESP_FAIL;
    }
    if (e == ESP_OK) {
        status = esp_http_client_get_status_code(c);
        int n;
        while (out_len < NET_BODY_MAX) {
            n = esp_http_client_read(c, out + out_len, NET_BODY_MAX - out_len);
            if (n <= 0) break;
            out_len += n;
        }
        out[out_len] = 0;
    }
    s_paused_us += esp_timer_get_time() - t0;

    esp_http_client_close(c);
    esp_http_client_cleanup(c);
    if (e != ESP_OK && !errbuf[0]) snprintf(errbuf, sizeof(errbuf), "%s", esp_err_to_name(e));

    int r = net_result(L, status, out, (size_t)out_len, errbuf);
    free(out);
    return r;
}

static int l_net_get(lua_State *L)  { return net_request(L, 0); }
static int l_net_post(lua_State *L) { return net_request(L, 1); }

/* ── 注册与沙箱 ────────────────────────────────────────────────────── */

static void register_apis(lua_State *L)
{
    static const luaL_Reg f_display[] = {
        { "clear", l_display_clear }, { "text", l_display_text },
        { "rect",  l_display_rect },  { "flush", l_display_flush },
        { "close", l_display_close },
        { NULL, NULL }
    };
    static const luaL_Reg f_pet[] = {
        { "state", l_pet_state }, { NULL, NULL }
    };
    static const luaL_Reg f_sensor[] = {
        { "temp", l_sensor_temp }, { "hum", l_sensor_hum },
        { "battery", l_sensor_battery }, { "voltage", l_sensor_voltage },
        { NULL, NULL }
    };
    static const luaL_Reg f_sys[] = {
        { "millis", l_sys_millis }, { "delay", l_sys_delay }, { "log", l_sys_log },
        { "clock", l_sys_clock },
        { "on", l_sys_on },
        { "reboot", l_sys_reboot },
        { NULL, NULL }
    };
    static const luaL_Reg f_timer[] = {
        { "after", l_timer_after }, { "every", l_timer_every },
        { NULL, NULL }
    };
    static const luaL_Reg f_gpio[] = {
        { "mode", l_gpio_mode }, { "read", l_gpio_read },
        { "write", l_gpio_write }, { "toggle", l_gpio_toggle },
        { NULL, NULL }
    };
    static const luaL_Reg f_audio[] = {
        { "volume", l_audio_volume }, { "chime", l_audio_chime }, { "alarm", l_audio_alarm },
        { NULL, NULL }
    };
    static const luaL_Reg f_rtc[] = {
        { "get", l_rtc_get }, { "set", l_rtc_set },
        { NULL, NULL }
    };
    static const luaL_Reg f_wifi[] = {
        { "status", l_wifi_status },
        { NULL, NULL }
    };
    static const luaL_Reg f_ble[] = {
        { "status", l_ble_status },
        { NULL, NULL }
    };
    static const luaL_Reg f_fs[] = {
        { "write", l_fs_write }, { "read", l_fs_read },
        { "list", l_fs_list }, { "remove", l_fs_remove },
        { NULL, NULL }
    };
    static const luaL_Reg f_net[] = {
        { "get", l_net_get }, { "post", l_net_post },
        { NULL, NULL }
    };

    luaL_newlib(L, f_display); lua_setglobal(L, "display");
    luaL_newlib(L, f_pet);     lua_setglobal(L, "pet");
    luaL_newlib(L, f_sensor);  lua_setglobal(L, "sensor");
    luaL_newlib(L, f_sys);     lua_setglobal(L, "sys");
    luaL_newlib(L, f_timer);   lua_setglobal(L, "timer");
    luaL_newlib(L, f_gpio);    lua_setglobal(L, "gpio");
    luaL_newlib(L, f_audio);   lua_setglobal(L, "audio");
    luaL_newlib(L, f_rtc);     lua_setglobal(L, "rtc");
    luaL_newlib(L, f_wifi);    lua_setglobal(L, "wifi");
    luaL_newlib(L, f_ble);     lua_setglobal(L, "ble");
    luaL_newlib(L, f_fs);      lua_setglobal(L, "fs");
    luaL_newlib(L, f_net);     lua_setglobal(L, "net");
}

static void open_sandbox(lua_State *L)
{
    /* 选择性加载标准库（官方示例推荐做法：不用的库会被 --gc-sections 丢掉）：
     * base/coroutine/math/string/table/utf8；io/os/package/debug 一律不加载 */
    static const luaL_Reg libs[] = {
        { LUA_GNAME,       luaopen_base },
        { LUA_COLIBNAME,   luaopen_coroutine },
        { LUA_MATHLIBNAME, luaopen_math },
        { LUA_STRLIBNAME,  luaopen_string },
        { LUA_TABLIBNAME,  luaopen_table },
        { LUA_UTF8LIBNAME, luaopen_utf8 },
        { NULL, NULL },
    };
    for (const luaL_Reg *lib = libs; lib->func != NULL; lib++) {
        luaL_requiref(L, lib->name, lib->func, 1);
        lua_pop(L, 1);
    }
    /* dofile/loadfile 来自 base、能碰文件系统，摘掉 */
    lua_pushnil(L); lua_setglobal(L, "dofile");
    lua_pushnil(L); lua_setglobal(L, "loadfile");
    lua_pushcfunction(L, l_print);
    lua_setglobal(L, "print");
    lua_sethook(L, timeout_hook, LUA_MASKCOUNT, 20000);
}

/* ── 脚本执行 ──────────────────────────────────────────────────────── */

static int read_file(const char *path, char *buf, int cap)
{
    FILE *f = fopen(path, "rb");
    if (!f) return -1;
    int n = (int)fread(buf, 1, cap, f);
    fclose(f);
    buf[n] = 0;
    return n;
}

/* ── flash 写入代理 ──────────────────────────────────────────────────
 * Lua 任务栈放在 PSRAM（省 24KB 内部 RAM），但 flash 写入期间 cache 关闭、
 * PSRAM 不可访问 —— 所有写文件的调用都必须换到内部栈的任务上执行。
 * 读文件走 cache 映射，可以在 Lua 任务里做。 */

typedef enum { FIO_MOUNT = 0, FIO_SAVE, FIO_RENAME, FIO_READ, FIO_WRITE, FIO_REMOVE, FIO_LIST } fio_op_t;

typedef struct {
    fio_op_t    op;
    const char *a;
    const char *b;
    char       *out;          /* FIO_READ：读入缓冲 */
    int         out_cap;
} fio_req_t;

#define FIO_STACK_WORDS 2560          /* 10KB 内部栈：挂载实测用 2056 字，留 2KB 余量 */

static QueueHandle_t     s_fio_q;
static QueueHandle_t     s_fio_done;      /* 完成通知队列（放一个 int，不用信号量） */
static StaticTask_t      s_fio_tcb;
static StackType_t      *s_fio_stack;

static int fio_call(fio_op_t op, const char *a, const char *b);
static int fio_read(const char *path, char *buf, int cap);

static int persist_script_impl(const char *code)
{
    if (!s_fs_ok) return -1;
    FILE *f = fopen(TMP_PATH, "wb");
    if (!f) {
        ESP_LOGW(TAG, "写 %s 失败", TMP_PATH);
        return -1;
    }
    size_t n = strlen(code);
    size_t w = fwrite(code, 1, n, f);
    fclose(f);
    if (w != n) {
        ESP_LOGW(TAG, "写脚本不完整");
        remove(TMP_PATH);
        return -1;
    }
    remove(ACTIVE_PATH);
    if (rename(TMP_PATH, ACTIVE_PATH) != 0) {
        ESP_LOGW(TAG, "rename → active.lua 失败（本次已生效，但重启后不保留）");
        return -1;
    }
    ESP_LOGI(TAG, "脚本已保存 active.lua（%d 字节）", (int)n);
    return 0;
}

static void reply(int id, int ok, const char *out)
{
    if (id >= 0 && s_result_cb) s_result_cb(id, ok != 0, out ? out : "");
}

/** dry-run 的 Lua mock：只替换硬件/界面副作用，脚本的语法和顶层逻辑照常执行 */
static const char MOCK_LUA[] =
    "local function _noop() end\n"
    "display={clear=_noop,text=_noop,rect=_noop,flush=_noop,close=_noop}\n"
    "pet={state=function() return true end}\n"
    "sensor={temp=function() return 25 end,hum=function() return 50 end,"
    "battery=function() return 80 end,voltage=function() return 4000 end}\n"
    "gpio={mode=function() return true end,read=function() return 0 end,"
    "write=function() return 0 end,toggle=function() return 0 end}\n"
    "audio={volume=function(v) return v or 50 end,chime=_noop,alarm=_noop}\n"
    "rtc={get=function() return {year=2026,mon=1,day=1,wday=0,hour=0,min=0,sec=0} end,"
    "set=function() return true end}\n"
    "wifi={status=function() return {connected=false,ip=\"\",ssid=\"\",rssi=-127} end}\n"
    "ble={status=function() return {state=\"mock\",name=\"\"} end}\n"
    "fs={write=function() return true end,read=function() return \"mock\" end,"
    "list=function() return \"\" end,remove=function() return true end}\n"
    "net={get=function() return {status=200,body=\"\",error=\"mock\"} end,"
    "post=function() return {status=200,body=\"\",error=\"mock\"} end}\n"
    "local _mt=0\n"
    "sys.millis=function() _mt=_mt+16 return _mt end\n"
    "sys.delay=_noop\n"
    "sys.log=_noop\n"
    "sys.clock=function() return 0,0 end\n"
    "sys.on=_noop\n"
    "sys.reboot=_noop\n"
    "print=_noop\n";

/** dry-run：把已注册的定时器回调各跑一次。
 *  动画脚本的错误在回调里（顶层只注册 timer），不跑一次就抓不到。 */
static int dry_run_timers(void)
{
    int refs[TIMER_MAX];
    for (int i = 0; i < TIMER_MAX; i++) refs[i] = s_timers[i].ref;

    for (int i = 0; i < TIMER_MAX; i++) {
        if (!refs[i]) continue;
        lua_settop(s_L, 0);
        lua_rawgeti(s_L, LUA_REGISTRYINDEX, refs[i]);
        if (!lua_isfunction(s_L, -1)) continue;
        if (lua_pcall(s_L, 0, 0, 0) != LUA_OK) {
            const char *err = lua_tostring(s_L, -1);
            snprintf(s_err, OUT_CAP, "定时器回调出错：%s", err ? err : "未知错误");
            lua_settop(s_L, 0);
            return -1;
        }
    }
    return 0;
}

/** 执行一段脚本：关旧状态 → 全新状态 → pcall。
 *  dry=1：先加载 Lua mock 覆盖硬件 API，只检查语法/顶层逻辑，不持久化。
 *  @return 1 成功 / 0 失败（错误文本在 s_err） */
static int run_code(const char *code, int persist, int dry)
{
    if (s_L) {
        lua_close(s_L);
        s_L = NULL;
    }
    s_mem_used = 0;
    timers_clear();
    parse_perms(code);
    for (int i = 0; i < EVT_COUNT; i++) {
        s_evt_ref[i] = LUA_NOREF;              /* 引用随旧状态销毁 */
        s_evt_min_stamp[i] = 0;
    }

    s_L = lua_newstate(lua_alloc, NULL, luaL_makeseed(NULL));
    if (!s_L) {
        snprintf(s_err, OUT_CAP, "内存不足，无法创建 Lua 状态");
        return 0;
    }
    open_sandbox(s_L);
    register_apis(s_L);

    out_reset();
    s_capture = dry ? 0 : 1;
    s_err[0] = 0;

    s_exec_start_us = esp_timer_get_time();
    s_paused_us = 0;
    s_hook_active = 1;

    if (dry) {
        int r = luaL_dostring(s_L, MOCK_LUA);
        if (r == LUA_OK) r = luaL_loadbuffer(s_L, code, strlen(code), "=script");
        if (r == LUA_OK) r = lua_pcall(s_L, 0, 1, 0);

        int ok = (r == LUA_OK);
        if (!ok) {
            const char *err = lua_tostring(s_L, -1);
            snprintf(s_err, OUT_CAP, "%s", err ? err : "未知错误");
            lua_settop(s_L, 0);
        } else if (dry_run_timers() != 0) {
            ok = 0;                      /* 定时器回调里出错，同样算检查失败 */
        }
        s_hook_active = 0;
        lua_close(s_L);
        s_L = NULL;
        timers_clear();
        for (int i = 0; i < EVT_COUNT; i++) {
            s_evt_ref[i] = LUA_NOREF;
            s_evt_min_stamp[i] = 0;
        }
        return ok;
    }

    int r = luaL_loadbuffer(s_L, code, strlen(code), "=script");
    if (r == LUA_OK) r = lua_pcall(s_L, 0, 1, 0);

    int ok = (r == LUA_OK);
    if (ok) {
        if (lua_gettop(s_L) >= 1 && !lua_isnil(s_L, -1)) {
            const char *ret = luaL_tolstring(s_L, -1, NULL);
            char line[280];
            snprintf(line, sizeof(line), "=> %s", ret ? ret : "?");
            out_append(line);
        }
        lua_settop(s_L, 0);
    } else {
        const char *err = lua_tostring(s_L, -1);
        snprintf(s_err, OUT_CAP, "%s", err ? err : "未知错误");
        lua_settop(s_L, 0);
    }

    s_hook_active = 0;
    s_capture = 0;

    if (ok && persist) fio_call(FIO_SAVE, code, NULL);
    return ok;
}

static void handle_deploy(const deploy_msg_t *m)
{
    ESP_LOGI(TAG, "Lua#%d 下发（%d 字节%s）", m->id, (int)strlen(m->code),
             m->check ? "，dry-run" : "");
    int ok = run_code(m->code, m->check ? 0 : 1, m->check);
    if (ok) {
        ESP_LOGI(TAG, "Lua#%d %s", m->id, m->check ? "dry-run 通过" : "执行成功");
    } else {
        ESP_LOGW(TAG, "Lua#%d %s：%s", m->id, m->check ? "dry-run 失败" : "执行失败", s_err);
    }
    reply(m->id, ok, ok ? (m->check ? "dry-run 通过" : s_out) : s_err);

    if (!m->check && !ok) {
        /* 回滚：重新跑持久化的上一版（active.lua 只在执行成功时才被覆盖，
         * 所以它就是上一版好脚本；首次部署失败则不存在，跳过） */
        if (s_fs_ok && fio_read(ACTIVE_PATH, s_code_buf, CODE_MAX) > 0) {
            ESP_LOGI(TAG, "回滚：重新执行上一版脚本");
            run_code(s_code_buf, 0, 0);
        }
    }
}

/** 事件回调：护栏同定时器（2 秒超时）；出错移除处理器并记串口 */
static void handle_event(int evt)
{
    if (evt < 0 || evt >= EVT_COUNT) return;
    const char *name = s_evt_names[evt];
    if (!s_L || s_evt_ref[evt] == LUA_NOREF) return;

    ESP_LOGI(TAG, "事件 %s → 脚本处理器", name);
    lua_settop(s_L, 0);
    lua_rawgeti(s_L, LUA_REGISTRYINDEX, s_evt_ref[evt]);

    uint32_t rel_seq = ui_lua_release_seq();
    s_exec_start_us = esp_timer_get_time();
    s_paused_us = 0;
    s_hook_active = 1;
    int r = lua_pcall(s_L, 0, 0, 0);
    s_hook_active = 0;
    if (ui_lua_release_seq() != rel_seq) {
        /* 执行期间用户单击关了画布 / 语音接管：保持让位，
         * 别让处理器结尾的 keepalive 把画布重新点亮 */
        ui_lua_release();
    }

    if (r != LUA_OK) {
        const char *err = lua_tostring(s_L, -1);
        ESP_LOGW(TAG, "事件 %s 处理器出错：%s（已移除）", name, err ? err : "?");
        lua_settop(s_L, 0);
        luaL_unref(s_L, LUA_REGISTRYINDEX, s_evt_ref[evt]);
        s_evt_ref[evt] = LUA_NOREF;
    }
}

/* ── fatfs 与任务 ──────────────────────────────────────────────────── */

static int mount_fs_impl(void)
{
    esp_vfs_fat_mount_config_t cfg = {
        .format_if_mount_failed = true,
        .max_files = 4,
        .allocation_unit_size = 4096,
    };
    esp_err_t e = esp_vfs_fat_spiflash_mount_rw_wl(MOUNT_POINT, "fatfs", &cfg, &s_wl);
    if (e != ESP_OK) {
        ESP_LOGW(TAG, "fatfs 挂载失败（%s）：脚本可用但不持久化", esp_err_to_name(e));
        return -1;
    }
    mkdir(SCRIPT_DIR, 0777);                  /* 已存在则忽略 */
    mkdir(USER_DIR, 0777);                    /* Lua 文件沙箱 */
    s_fs_ok = 1;
    ESP_LOGI(TAG, "fatfs 就绪（%s）", MOUNT_POINT);
    return 0;
}

static int write_user_file(const char *path, const char *data)
{
    if (!path || !data) return -1;
    FILE *f = fopen(path, "wb");
    if (!f) return -1;
    size_t len = strlen(data);
    size_t w = fwrite(data, 1, len, f);
    fclose(f);
    return w == len ? 0 : -1;
}

static int list_dir_impl(const char *path, char *buf, int cap)
{
    DIR *d = opendir(path);
    if (!d) return -1;
    int n = 0;
    struct dirent *e;
    while ((e = readdir(d)) != NULL) {
        if (e->d_name[0] == '.') continue;
        int l = (int)strlen(e->d_name);
        if (n + l + 2 >= cap) break;
        memcpy(buf + n, e->d_name, (size_t)l);
        n += l;
        buf[n++] = '\n';
    }
    closedir(d);
    if (cap > 0) buf[n < cap ? n : cap - 1] = 0;
    return n;
}

static void fio_task(void *arg)
{
    (void)arg;
    fio_req_t r;
    for (;;) {
        if (xQueueReceive(s_fio_q, &r, portMAX_DELAY) != pdTRUE) continue;
        int rc = -1;
        switch (r.op) {
        case FIO_MOUNT:
            rc = mount_fs_impl();
            /* 挂载是这里最深的一条路径；打出余量，避免再次因为栈不够踩内存 */
            ESP_LOGI(TAG, "fatfs 挂载栈余量 %u 字（共 %d 字）",
                     (unsigned)uxTaskGetStackHighWaterMark(NULL), FIO_STACK_WORDS);
            break;
        case FIO_SAVE:
            rc = persist_script_impl(r.a);
            break;
        case FIO_RENAME:
            if (r.b) remove(r.b);
            rc = (r.a && r.b) ? rename(r.a, r.b) : -1;
            break;
        case FIO_READ:
            rc = read_file(r.a, r.out, r.out_cap);
            break;
        case FIO_WRITE:
            rc = write_user_file(r.a, r.b);
            break;
        case FIO_REMOVE:
            rc = r.a ? remove(r.a) : -1;
            break;
        case FIO_LIST:
            rc = list_dir_impl(r.a, r.out, r.out_cap);
            break;
        }
        int done = rc;
        if (xQueueSend(s_fio_done, &done, 0) != pdTRUE)
            ESP_LOGW(TAG, "flash 操作 %d 完成通知失败", (int)r.op);
    }
}

/** 在内部栈任务上执行一次 flash 操作（阻塞直到做完）。成功返回 0。 */
static int fio_call(fio_op_t op, const char *a, const char *b)
{
    if (!s_fio_q || !s_fio_done) return -1;
    fio_req_t r = { .op = op, .a = a, .b = b, .out = NULL, .out_cap = 0 };
    if (xQueueSend(s_fio_q, &r, pdMS_TO_TICKS(2000)) != pdTRUE) {
        ESP_LOGW(TAG, "flash 代理队列忙，操作 %d 丢弃", (int)op);
        return -1;
    }
    int done = -1;
    if (xQueueReceive(s_fio_done, &done, pdMS_TO_TICKS(15000)) != pdTRUE) {
        ESP_LOGW(TAG, "flash 操作 %d 超时", (int)op);
        return -1;
    }
    return done;
}

/** 由 flash 代理任务读文件（fatfs 的读也会走关闭 cache 的 flash 路径，
 *  PSRAM 栈的任务不能直接读）。返回读到的字节数，失败 <0。 */
static int fio_read(const char *path, char *buf, int cap)
{
    if (!s_fio_q || !s_fio_done) return -1;
    fio_req_t r = { .op = FIO_READ, .a = path, .b = NULL, .out = buf, .out_cap = cap };
    if (xQueueSend(s_fio_q, &r, pdMS_TO_TICKS(2000)) != pdTRUE) return -1;
    int n = -1;
    if (xQueueReceive(s_fio_done, &n, pdMS_TO_TICKS(15000)) != pdTRUE) {
        ESP_LOGW(TAG, "读 %s 超时", path);
        return -1;
    }
    return n;
}

static int fio_list(const char *path, char *buf, int cap)
{
    if (!s_fio_q || !s_fio_done) return -1;
    fio_req_t r = { .op = FIO_LIST, .a = path, .b = NULL, .out = buf, .out_cap = cap };
    if (xQueueSend(s_fio_q, &r, pdMS_TO_TICKS(2000)) != pdTRUE) return -1;
    int n = -1;
    if (xQueueReceive(s_fio_done, &n, pdMS_TO_TICKS(15000)) != pdTRUE) {
        ESP_LOGW(TAG, "列目录 %s 超时", path);
        return -1;
    }
    return n;
}

static int fs_user_path(const char *name, char *path, size_t cap)
{
    int n = snprintf(path, cap, "%s/%s", USER_DIR, name);
    return (n > 0 && (size_t)n < cap) ? 0 : -1;
}

static int fs_user_write(const char *name, const char *data)
{
    char path[64];
    if (fs_user_path(name, path, sizeof(path)) != 0) return -1;
    return fio_call(FIO_WRITE, path, data);
}

static int fs_user_read(const char *name, char *buf, int cap)
{
    char path[64];
    if (fs_user_path(name, path, sizeof(path)) != 0) return -1;
    return fio_read(path, buf, cap);
}

static int fs_user_list(char *buf, int cap)
{
    return fio_list(USER_DIR, buf, cap);
}

static int fs_user_remove(const char *name)
{
    char path[64];
    if (fs_user_path(name, path, sizeof(path)) != 0) return -1;
    return fio_call(FIO_REMOVE, path, NULL);
}

static void lua_task(void *arg)
{
    (void)arg;

    int mrc = fio_call(FIO_MOUNT, NULL, NULL);
    ESP_LOGI(TAG, "flash 代理就绪（mount rc=%d，内部堆 %u B / 最大块 %u B）", mrc,
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));

    /* 开机执行上次保存的脚本 */
    if (s_fs_ok) {
        int n = fio_read(ACTIVE_PATH, s_code_buf, CODE_MAX);
        if (n > 0) {
            ESP_LOGI(TAG, "开机脚本 active.lua（%d 字节）", n);
            if (!run_code(s_code_buf, 0, 0)) {
                ESP_LOGW(TAG, "开机脚本执行失败：%s → 改名不再重跑", s_err);
                fio_call(FIO_RENAME, ACTIVE_PATH, BROKEN_PATH);
            }
        }
    }

    /* 栈余量（字）：跑完挂载 + 开机脚本后的水位，用来校验栈大小够不够 */
    ESP_LOGI(TAG, "任务栈余量 %u 字（共 %d 字）",
             (unsigned)uxTaskGetStackHighWaterMark(NULL), LUA_STACK_WORDS);

    for (;;) {
        /* 到期最近的定时器决定等待时长（上限 1 秒） */
        uint32_t wait_ms = 1000;
        uint32_t next = 0;
        int has = 0;
        uint32_t now = ms_now();
        for (int i = 0; i < TIMER_MAX; i++) {
            if (!s_timers[i].ref) continue;
            if (!has || (int32_t)(s_timers[i].next_ms - next) < 0) {
                next = s_timers[i].next_ms;
                has = 1;
            }
        }
        if (has) {
            int32_t d = (int32_t)(next - now);
            if (d <= 0) wait_ms = 1;
            else if ((uint32_t)d < wait_ms) wait_ms = (uint32_t)d;
        }

        deploy_msg_t m;
        if (xQueueReceive(s_q, &m, pdMS_TO_TICKS(wait_ms)) == pdTRUE) {
            if (m.id >= 0) {
                handle_deploy(&m);
                free(m.code);
            } else if (m.evt >= 0 && m.evt < EVT_COUNT &&
                       (int32_t)(m.stamp - s_evt_min_stamp[m.evt]) < 0) {
                /* 过期事件（如画布已被单击关掉，队列里还没轮到执行的重画）：
                 * 丢弃，否则刚关掉又被重画出来 */
                ESP_LOGI(TAG, "事件 %s 已过期，忽略", s_evt_names[m.evt]);
            } else {
                handle_event(m.evt);
            }
            continue;
        }

        /* 到期的定时器回调 */
        now = ms_now();
        for (int i = 0; i < TIMER_MAX; i++) {
            timer_slot_t *t = &s_timers[i];
            if (!t->ref) continue;
            if ((int32_t)(now - t->next_ms) < 0) continue;
            if (!s_L) { t->ref = 0; continue; }

            lua_settop(s_L, 0);
            lua_rawgeti(s_L, LUA_REGISTRYINDEX, t->ref);
            s_exec_start_us = esp_timer_get_time();
            s_paused_us = 0;
            s_hook_active = 1;
            int r = lua_pcall(s_L, 0, 0, 0);
            s_hook_active = 0;

            if (r != LUA_OK) {
                const char *err = lua_tostring(s_L, -1);
                ESP_LOGW(TAG, "定时器#%d 出错：%s（已移除）", i + 1, err ? err : "?");
                lua_settop(s_L, 0);
                luaL_unref(s_L, LUA_REGISTRYINDEX, t->ref);
                t->ref = 0;
            } else if (t->one_shot) {
                luaL_unref(s_L, LUA_REGISTRYINDEX, t->ref);
                t->ref = 0;
            } else {
                t->next_ms += t->period_ms;
                if ((int32_t)(ms_now() - t->next_ms) > (int32_t)t->period_ms)
                    t->next_ms = ms_now() + t->period_ms;   /* 落后太多：跳到下一轮 */
            }
        }
    }
}

/* ── 对外接口 ──────────────────────────────────────────────────────── */

void lua_runtime_set_result_cb(lua_result_cb_t cb)
{
    s_result_cb = cb;
}

/* Lua 任务栈放 PSRAM（省 24KB 内部 RAM，给 BLE 控制器腾连续块）；
 * 写 flash 的调用都走 fio 代理任务（内部栈），见文件中部。
 * 因为栈在 PSRAM，任务固定钉在 core0（IDF 对外部栈任务的约束）。 */
static StaticTask_t s_lua_tcb;
static StackType_t *s_lua_stack;

void lua_runtime_start(void)
{
    if (s_task) return;
    s_out = heap_caps_malloc(OUT_CAP, MALLOC_CAP_SPIRAM);
    s_err = heap_caps_malloc(OUT_CAP, MALLOC_CAP_SPIRAM);
    s_code_buf = heap_caps_malloc(CODE_MAX + 1, MALLOC_CAP_SPIRAM);
    if (!s_out || !s_err || !s_code_buf) {
        ESP_LOGE(TAG, "Lua 回执/脚本缓冲分配失败（PSRAM 不足）");
        return;
    }
    s_q = xQueueCreate(DEPLOY_Q_LEN, sizeof(deploy_msg_t));
    s_fio_q = xQueueCreate(2, sizeof(fio_req_t));
    s_fio_done = xQueueCreate(1, sizeof(int));
    s_fio_stack = heap_caps_malloc(FIO_STACK_WORDS * sizeof(StackType_t),
                                   MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    if (!s_q || !s_fio_q || !s_fio_done || !s_fio_stack) {
        ESP_LOGE(TAG, "队列/flash 代理栈创建失败（内部 RAM 不足）");
        return;
    }
    if (!xTaskCreateStaticPinnedToCore(fio_task, "lua_fio", FIO_STACK_WORDS, NULL, 4,
                                       s_fio_stack, &s_fio_tcb, 0)) {
        ESP_LOGE(TAG, "flash 代理任务创建失败");
        return;
    }

    s_lua_stack = heap_caps_malloc(LUA_STACK_WORDS * sizeof(StackType_t), MALLOC_CAP_SPIRAM);
    if (!s_lua_stack) {
        ESP_LOGE(TAG, "Lua 任务栈分配失败（PSRAM 不足）");
        return;
    }
    s_task = xTaskCreateStaticPinnedToCore(lua_task, "lua", LUA_STACK_WORDS, NULL, 4,
                                           s_lua_stack, &s_lua_tcb, 0);
    if (!s_task) ESP_LOGE(TAG, "Lua 任务创建失败");
}

void lua_runtime_deploy(int id, const char *code, int check)
{
    if (!code) {
        reply(id, 0, "脚本为空");
        return;
    }
    if (!s_q || !s_task) {
        reply(id, 0, "Lua 运行时未就绪");
        return;
    }
    if (strlen(code) >= CODE_MAX) {
        reply(id, 0, "脚本过长（上限 6KB）");
        return;
    }
    deploy_msg_t m;
    m.id = id;
    m.evt = -1;
    m.check = check ? 1 : 0;
    m.stamp = 0;
    m.code = strdup(code);
    if (!m.code) {
        reply(id, 0, "内存不足");
        return;
    }
    if (xQueueSend(s_q, &m, 0) != pdTRUE) {
        free(m.code);
        reply(id, 0, "上一个脚本还在执行，稍后再试");
    }
}

void lua_runtime_event(const char *name)
{
    if (!name || !s_q) return;
    for (int i = 0; i < EVT_COUNT; i++) {
        if (strcmp(name, s_evt_names[i])) continue;
        if (s_evt_ref[i] == LUA_NOREF) return;      /* 没有脚本关心，直接丢 */
        deploy_msg_t m;
        m.id = -1;
        m.evt = i;
        m.check = 0;
        m.stamp = ms_now();
        m.code = NULL;
        if (xQueueSend(s_q, &m, 0) != pdTRUE)
            ESP_LOGW(TAG, "事件 %s 丢弃（队列满）", name);
        return;
    }
}

/** 作废队列里还没执行的某类事件（早于此刻入队的）。
 *  典型场景：单击关掉脚本画布后，清掉还在排队、会把画布重画出来的 key_double。 */
void lua_runtime_event_drop_pending(const char *name)
{
    if (!name) return;
    for (int i = 0; i < EVT_COUNT; i++) {
        if (strcmp(name, s_evt_names[i])) continue;
        s_evt_min_stamp[i] = ms_now();
        return;
    }
}

bool lua_runtime_has_event(const char *name)
{
    if (!name) return false;
    for (int i = 0; i < EVT_COUNT; i++)
        if (!strcmp(name, s_evt_names[i])) return s_evt_ref[i] != LUA_NOREF;
    return false;
}
