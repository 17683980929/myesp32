/**
 * lua_runtime.c — Lua 解释器运行时（M5）
 *
 * 设计要点：
 *   - 单任务独占 lua_State（Lua 本身非线程安全）；WS 线程只投递队列。
 *   - 每次执行（部署/开机脚本/定时器回调）都设 2 秒墙钟超时（debug hook
 *     每 2 万条指令查一次；sys.delay 的等待时间不计入）。
 *   - 自定义分配器，整个状态内存上限 128KB（超限返回 NULL，Lua 报内存错误）。
 *   - 白名单 API：display / pet / sensor / sys / timer；
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
 *   sys.on("key_click"/"key_double"/"open_timetable"/"open_env"/"canvas_close"/"canvas_next", fn)  -- 事件绑定（重复注册=替换）
 *   timer.after(ms, fn) timer.every(ms, fn)        -- 最多 16 个
 */

#include "lua_runtime.h"
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
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
#include "ui.h"
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
#define ACTIVE_PATH       SCRIPT_DIR "/active.lua"
#define TMP_PATH          SCRIPT_DIR "/tmp.lua"
#define BROKEN_PATH       SCRIPT_DIR "/active.broken.lua"

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

static char            s_out[OUT_CAP];     /* 回执输出（print/sys.log/返回值） */
static int             s_out_len;
static int             s_capture;          /* 只有部署执行期间收集输出 */
static char            s_err[OUT_CAP];     /* 最近一次错误文本 */

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

#define EVT_COUNT 6
static const char *const s_evt_names[EVT_COUNT] = {
    "key_click", "key_double",                       /* 按键（脚本自己用） */
    "open_timetable", "open_env", "canvas_close", "canvas_next",   /* 服务器/助手技能 */
};
static int s_evt_ref[EVT_COUNT] = {
    LUA_NOREF, LUA_NOREF, LUA_NOREF, LUA_NOREF, LUA_NOREF, LUA_NOREF,
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
        { "on", l_sys_on },
        { NULL, NULL }
    };
    static const luaL_Reg f_timer[] = {
        { "after", l_timer_after }, { "every", l_timer_every },
        { NULL, NULL }
    };

    luaL_newlib(L, f_display); lua_setglobal(L, "display");
    luaL_newlib(L, f_pet);     lua_setglobal(L, "pet");
    luaL_newlib(L, f_sensor);  lua_setglobal(L, "sensor");
    luaL_newlib(L, f_sys);     lua_setglobal(L, "sys");
    luaL_newlib(L, f_timer);   lua_setglobal(L, "timer");
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

typedef enum { FIO_MOUNT = 0, FIO_SAVE, FIO_RENAME } fio_op_t;

typedef struct {
    fio_op_t    op;
    const char *a;
    const char *b;
} fio_req_t;

#define FIO_STACK_WORDS 2048          /* 8KB 内部栈：fatfs 挂载/写文件够用 */

static QueueHandle_t     s_fio_q;
static QueueHandle_t     s_fio_done;      /* 完成通知队列（放一个 int，不用信号量） */
static StaticTask_t      s_fio_tcb;
static StackType_t      *s_fio_stack;

static int fio_call(fio_op_t op, const char *a, const char *b);

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

/** 执行一段脚本：关旧状态 → 全新状态 → pcall。
 *  @return 1 成功 / 0 失败（错误文本在 s_err） */
static int run_code(const char *code, int persist)
{
    if (s_L) {
        lua_close(s_L);
        s_L = NULL;
    }
    s_mem_used = 0;
    timers_clear();
    for (int i = 0; i < EVT_COUNT; i++) {
        s_evt_ref[i] = LUA_NOREF;              /* 引用随旧状态销毁 */
        s_evt_min_stamp[i] = 0;
    }

    s_L = lua_newstate(lua_alloc, NULL, luaL_makeseed(NULL));
    if (!s_L) {
        snprintf(s_err, sizeof(s_err), "内存不足，无法创建 Lua 状态");
        return 0;
    }
    open_sandbox(s_L);
    register_apis(s_L);

    out_reset();
    s_capture = 1;
    s_err[0] = 0;

    s_exec_start_us = esp_timer_get_time();
    s_paused_us = 0;
    s_hook_active = 1;

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
        snprintf(s_err, sizeof(s_err), "%s", err ? err : "未知错误");
        lua_settop(s_L, 0);
    }

    s_hook_active = 0;
    s_capture = 0;

    if (ok && persist) fio_call(FIO_SAVE, code, NULL);
    return ok;
}

static void handle_deploy(const deploy_msg_t *m)
{
    ESP_LOGI(TAG, "Lua#%d 下发（%d 字节）", m->id, (int)strlen(m->code));
    int ok = run_code(m->code, 1);
    if (ok) {
        ESP_LOGI(TAG, "Lua#%d 执行成功", m->id);
    } else {
        ESP_LOGW(TAG, "Lua#%d 执行失败：%s", m->id, s_err);
    }
    reply(m->id, ok, ok ? s_out : s_err);

    if (!ok) {
        /* 回滚：重新跑持久化的上一版（active.lua 只在执行成功时才被覆盖，
         * 所以它就是上一版好脚本；首次部署失败则不存在，跳过） */
        static char code[CODE_MAX + 1];
        if (s_fs_ok && read_file(ACTIVE_PATH, code, sizeof(code) - 1) > 0) {
            ESP_LOGI(TAG, "回滚：重新执行上一版脚本");
            run_code(code, 0);
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
    s_fs_ok = 1;
    ESP_LOGI(TAG, "fatfs 就绪（%s）", MOUNT_POINT);
    return 0;
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
            break;
        case FIO_SAVE:
            rc = persist_script_impl(r.a);
            break;
        case FIO_RENAME:
            if (r.b) remove(r.b);
            rc = (r.a && r.b) ? rename(r.a, r.b) : -1;
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
    fio_req_t r = { op, a, b };
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

static void lua_task(void *arg)
{
    (void)arg;

    int mrc = fio_call(FIO_MOUNT, NULL, NULL);
    ESP_LOGI(TAG, "flash 代理就绪（mount rc=%d，内部堆 %u B / 最大块 %u B）", mrc,
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));

    /* 开机执行上次保存的脚本 */
    if (s_fs_ok) {
        static char code[CODE_MAX + 1];
        int n = read_file(ACTIVE_PATH, code, sizeof(code) - 1);
        if (n > 0) {
            ESP_LOGI(TAG, "开机脚本 active.lua（%d 字节）", n);
            if (!run_code(code, 0)) {
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

void lua_runtime_deploy(int id, const char *code)
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
