/**
 * buttons.c — KEY=18 / BOOT=0，低电平有效，带消抖
 *
 * 10ms 轮询，3 次采样消抖。
 * 事件：按下 → BTN_DOWN，松开 → BTN_UP，短按 → BTN_CLICK。
 * 长按（>600ms）不产生 CLICK，只产生 DOWN/UP。
 * KEY 双击（buttons_set_double(1) 时启用）：短按先挂起，300ms 内第二击
 * → BTN_DOUBLE；窗口过去只有一击 → 补报 BTN_CLICK。
 */

#include "buttons.h"
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"
#include "hw_config.h"

#define DEBOUNCE_TICKS  3
#define LONG_PRESS_MS   600
#define DOUBLE_WINDOW_MS 300     /* 两次短按间隔 ≤ 此值 = 双击 */

typedef struct {
    btn_id_t id;
    gpio_num_t pin;
    int level;              /* 消抖后的电平：1=松开 0=按下 */
    int stable;             /* 连续一致计数 */
    int pressed;            /* 逻辑上的按下状态 */
    int hold_ms;
} btn_t;

static btn_t s_btns[2];
static btn_cb_t s_cb;
static volatile int s_dbl_on;        /* KEY 双击识别开关（主循环按脚本注册设置） */
static int s_click_pending;          /* 有一次 KEY 短按在等双击窗口 */
static int s_click_age;              /* 距那次短按过去的毫秒数（10ms 轮询累加） */

static void poll_task(void *arg)
{
    for (;;) {
        for (int i = 0; i < 2; i++) {
            btn_t *b = &s_btns[i];
            int raw = gpio_get_level(b->pin);          /* 0 = 按下 */

            if (raw != b->level) {
                if (++b->stable >= DEBOUNCE_TICKS) {
                    b->level = raw;

                    if (b->level == 0) {               /* 按下 */
                        b->pressed = 1;
                        b->hold_ms = 0;
                        s_cb(b->id, BTN_DOWN);
                    } else {                            /* 松开 */
                        if (b->hold_ms < LONG_PRESS_MS) {
                            if (b->id == BTN_KEY && s_dbl_on) {
                                if (s_click_pending) {  /* 窗口内第二击 → 双击 */
                                    s_click_pending = 0;
                                    s_cb(BTN_KEY, BTN_DOUBLE);
                                } else {                /* 挂起等窗口 */
                                    s_click_pending = 1;
                                    s_click_age = 0;
                                }
                            } else {
                                s_cb(b->id, BTN_CLICK);
                            }
                        }
                        s_cb(b->id, BTN_UP);
                        b->pressed = 0;
                    }
                }
            } else {
                b->stable = 0;
            }

            if (b->pressed) b->hold_ms += 10;
        }

        /* 双击窗口过去 → 把挂起的短按补报为 CLICK */
        if (s_click_pending) {
            s_click_age += 10;
            if (s_click_age > DOUBLE_WINDOW_MS) {
                s_click_pending = 0;
                s_cb(BTN_KEY, BTN_CLICK);
            }
        }

        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

void buttons_set_double(int on)
{
    s_dbl_on = on ? 1 : 0;              /* 挂起中的短按照旧走窗口补报，不清 */
}

void buttons_init(btn_cb_t cb)
{
    s_cb = cb;

    s_btns[0] = (btn_t){ BTN_KEY,  KEY_BTN_PIN,  1, 0, 0, 0 };
    s_btns[1] = (btn_t){ BTN_BOOT, BOOT_BTN_PIN, 1, 0, 0, 0 };

    gpio_config_t c = {
        .pin_bit_mask = (1ULL << KEY_BTN_PIN) | (1ULL << BOOT_BTN_PIN),
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
    };
    ESP_ERROR_CHECK(gpio_config(&c));

    /* 12KB：单击要拼 JSON 再走 lwIP 发出去，8KB 实测会栈溢出重启。别再压。 */
    xTaskCreate(poll_task, "btn", 3072, NULL, 5, NULL);
}
