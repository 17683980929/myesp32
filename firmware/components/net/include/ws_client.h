/**
 * ws_client.h — WebSocket 客户端（设备侧协议）
 */
#pragma once
#include <stdint.h>
#include <stddef.h>
#include "esp_err.h"

#ifndef MYESP32_FW
#define MYESP32_FW "0.1.11"
#endif

/** 信息栏数据（服务器下发的 + 板子本地读的） */
typedef struct {
    char time[8];        /* "14:32" */
    char date[20];       /* "10月18日"（UTF-8） */
    char week[12];       /* "周日" */
    char weather[20];    /* "阴" */
    char city[20];       /* "北京"（服务器配置的城市） */
    int  weather_temp;   /* 16，<-1 表示无 */
    int  mm, dd, wday;   /* 数字日期：月/日/星期(0=周日) */
    /* 本地读的 */
    float room_t;
    float room_h;
    int   battery;
} dev_info_t;

typedef enum {
    WS_EVT_CONNECTED,
    WS_EVT_DISCONNECTED,
    WS_EVT_INFO,
    WS_EVT_PAGE,
    WS_EVT_STT,
    WS_EVT_TTS_START,
    WS_EVT_TTS_STOP,
    WS_EVT_SUB,
    WS_EVT_LUA,
    WS_EVT_EVT,          /* 脚本事件（{t:"evt",n:"open_timetable"}）→ sys.on 处理器 */
    WS_EVT_ERROR,
} ws_event_kind_t;

typedef struct {
    ws_event_kind_t kind;
    /* 按类型取用（sub 是整句文本，UTF-8 最长 3B/字，留足 512） */
    char text[512];
    char name[16];
    int  lua_id;
    int  frames;         /* sub 专有：该句音频总帧数（0=未知，不翻页） */
    int  followup;       /* tts_stop 专有：1=回答以问句收尾，播完自动聆听 */
    int  value;          /* evt 专有：音量等数值参数 */
    const char *lua_code; /* lua 专有：脚本文本（仅回调期间有效；缺失/过长=NULL） */
} ws_event_t;

typedef void (*ws_handler_t)(const ws_event_t *ev);
typedef void (*ws_bin_handler_t)(const uint8_t *data, size_t len);

/** 注册事件回调（收到 info/page/sub 等消息时调用） */
void ws_client_set_handler(ws_handler_t handler);

/** 注册二进制帧回调（服务器下行的 Opus 音频帧） */
void ws_client_set_bin_handler(ws_bin_handler_t handler);

/** 服务器下发的信息栏数据（time/date/week/weather），本地项由 UI 自己填 */
dev_info_t *ws_client_info(void);

/**
 * 启动 WS 客户端并连接。
 * @param host_port "192.168.1.203:8080"
 * @param token     鉴权 token（可空）
 */
esp_err_t ws_client_start(const char *host_port, const char *token);

/** 发 JSON 控制消息（返回是否成功：链路假死/上行锁死时失败） */
int ws_send_json(const char *json);

/** 发一帧 Opus 音频 */
void ws_send_audio(const uint8_t *frame, size_t len);

int ws_connected(void);

/** 距最近一次收到服务器数据的毫秒数（网络看门狗用；开局起算） */
int64_t ws_idle_ms(void);

/** 上行锁死时长（毫秒）：连续发送失败 ≥5 次时返回距最近一次成功发送的
 *  毫秒数；链路正常时恒为 0（网络看门狗用） */
int64_t ws_tx_stall_ms(void);
