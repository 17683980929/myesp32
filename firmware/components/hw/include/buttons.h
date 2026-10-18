/**
 * buttons.h — KEY=GPIO18（切页/双击）、BOOT=GPIO0（说话）
 */
#pragma once
#include <stdint.h>

typedef enum {
    BTN_KEY  = 0,     /* GPIO18 */
    BTN_BOOT = 1,     /* GPIO0  */
} btn_id_t;

typedef enum { BTN_CLICK, BTN_DOWN, BTN_UP, BTN_DOUBLE } btn_event_t;

typedef void (*btn_cb_t)(btn_id_t id, btn_event_t ev);

/** 初始化。回调在独立任务里执行（不是 ISR） */
void buttons_init(btn_cb_t cb);

/** 启用/停用 KEY 双击识别（脚本注册了 key_double 事件时才开，见 main）。
 *  启用后 KEY 短按先挂起等 ~300ms 窗口：只有一击 → 补报 BTN_CLICK（略延迟），
 *  窗口内第二击 → BTN_DOUBLE。停用时短按立即上报 BTN_CLICK（行为不变）。 */
void buttons_set_double(int on);
