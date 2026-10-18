/**
 * ui.h — 界面层：主页（桌宠+信息栏）/ 功能页
 */
#pragma once
#include <stdint.h>
#include "ws_client.h"

typedef enum { UI_PAGE_HOME = 0, UI_PAGE_FUNC = 1, UI_PAGE_PORTAL = 2 } ui_page_t;

/** 语音状态（影响桌宠表情 + 左区顶部状态字） */
typedef enum {
    UI_VOICE_NONE = 0,
    UI_VOICE_LISTENING,     /* 录音中 */
    UI_VOICE_THINKING,      /* 思考中 */
    UI_VOICE_SPEAKING,      /* 说话中 */
} ui_voice_t;

void ui_init(void);
void ui_set_page(ui_page_t p);
ui_page_t ui_get_page(void);

/** 切到配网页（显示热点名 + 提示），下一帧 ui_render() 画出来 */
void ui_show_portal(const char *ap_ssid);

/** 渲染当前页并刷屏（调用一次画一帧） */
void ui_render(void);

/** 页面自动刷新（桌宠眨眼等）。放到周期任务里调。
 *  返回 1 表示画面有变化（例如眨眼换帧），需要重绘 */
int ui_tick(uint32_t now_ms);

/** 服务器忙/空闲（影响桌宠状态） */
void ui_set_busy(int busy);

/** 语音状态（录音/思考/说话；NONE 时回到普通状态机） */
void ui_set_voice(ui_voice_t v);

/** 设置字幕（显示在信息栏底部） */
void ui_set_sub(const char *text);

/** 整句的页数（每页 24 字）；用于长句按播放进度翻页 */
int  ui_sub_pages(const char *text);

/** 显示整句的第 page 页（0 起）；page 越界时显示末页 */
void ui_set_sub_page(const char *text, int page);

/* ── Lua 画布（脚本接管屏幕，M5）────────────────────────────────────── */

/** 脚本绘制原语（内部带帧缓冲互斥 + 30 秒"保鲜"：保鲜期内主循环
 *  停止周期重绘，脚本画面得以保留；语音对话/按 KEY 时自动让位）。
 *  size 只是档位提示：<24 → 小字（ASCII 2x / 中文 1x），≥24 → 大字（3x / 2x） */
void ui_lua_clear(void);
void ui_lua_text(int x, int y, const char *s, int size);
void ui_lua_rect(int x, int y, int w, int h, int filled);
void ui_lua_flush(void);

/** 清掉画布保鲜 + 桌宠表情覆盖（按键/语音开始时调用） */
void ui_lua_release(void);

/** 释放序号：Lua 任务在跑脚本前后对比——执行期间发生过 release
 *  （用户单击关画布 / 语音接管）就补一次 release，保持让位 */
uint32_t ui_lua_release_seq(void);

/** 主循环用：现在是否该跳过周期重绘（画布保鲜中且没语音、在主页） */
int ui_lua_hold_active(void);

/** 脚本设置桌宠表情：idle/blink/listening/thinking/speaking/happy/love/
 *  confused/sleepy/sleeping/salute/direct/patrol/note/charging。
 *  返回 1 成功、0 名字不认识 */
int ui_lua_pet_state(const char *name);
