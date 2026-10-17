/**
 * buttons.h — KEY=GPIO18（切页）、BOOT=GPIO0（说话）
 */
#pragma once
#include <stdint.h>

typedef enum {
    BTN_KEY  = 0,     /* GPIO18 */
    BTN_BOOT = 1,     /* GPIO0  */
} btn_id_t;

typedef enum { BTN_CLICK, BTN_DOWN, BTN_UP } btn_event_t;

typedef void (*btn_cb_t)(btn_id_t id, btn_event_t ev);

/** 初始化。回调在独立任务里执行（不是 ISR） */
void buttons_init(btn_cb_t cb);
