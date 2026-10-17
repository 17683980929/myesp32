/**
 * buttons.c — KEY=18 / BOOT=0，低电平有效，带消抖
 *
 * 10ms 轮询，3 次采样消抖。
 * 事件：按下 → BTN_DOWN，松开 → BTN_UP，短按 → BTN_CLICK。
 * 长按（>600ms）不产生 CLICK，只产生 DOWN/UP。
 */

#include "buttons.h"
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"
#include "hw_config.h"

#define DEBOUNCE_TICKS  3
#define LONG_PRESS_MS   600

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
                        if (b->hold_ms < LONG_PRESS_MS)
                            s_cb(b->id, BTN_CLICK);
                        s_cb(b->id, BTN_UP);
                        b->pressed = 0;
                    }
                }
            } else {
                b->stable = 0;
            }

            if (b->pressed) b->hold_ms += 10;
        }
        vTaskDelay(pdMS_TO_TICKS(10));
    }
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

    xTaskCreate(poll_task, "btn", 3072, NULL, 5, NULL);
}
