/**
 * ui.h — 界面层：主页（桌宠+信息栏）/ 功能页
 */
#pragma once
#include "ws_client.h"

typedef enum { UI_PAGE_HOME = 0, UI_PAGE_FUNC = 1 } ui_page_t;

void ui_init(void);
void ui_set_page(ui_page_t p);
ui_page_t ui_get_page(void);

/** 渲染当前页并刷屏（调用一次画一帧） */
void ui_render(void);

/** 页面自动刷新（时钟走字、桌宠眨眼、按键状态）。放到周期任务里调 */
void ui_tick(uint32_t now_ms);

/** 服务器忙/空闲（影响桌宠状态） */
void ui_set_busy(int busy);

/** 设置字幕（显示在信息栏底部） */
void ui_set_sub(const char *text);
