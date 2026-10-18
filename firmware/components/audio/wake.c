/**
 * wake.c — 语音唤醒词（ESP-SR WakeNet，独立使用，不启用 AFE）
 *
 * 用法（esp-sr 2.x 独立接口）：
 *   esp_srmodel_init("model") → 从 model 分区加载模型列表
 *   esp_srmodel_filter(models, "wn", NULL) → 取唯一的唤醒词模型
 *   esp_wn_handle_from_name → create(DET_MODE_95) → detect(块) > 0 命中
 *
 * 资源占用（WakeNet9 官方基准）：内部 RAM ≈16KB + PSRAM ≈324KB，
 * 每块推理 ≈3ms（约 9% 单核）—— 与 Opus 编解码完全够用。
 */

#include "wake.h"
#include <string.h>
#include "esp_log.h"
#include "esp_heap_caps.h"

#include "model_path.h"
#include "esp_wn_iface.h"
#include "esp_wn_models.h"

static const char *TAG = "wake";

static srmodel_list_t       *s_models  = NULL;
static const esp_wn_iface_t *s_wn      = NULL;
static model_iface_data_t   *s_data    = NULL;
static int                   s_chunk   = 0;      /* 每次 detect 的采样数 */
static int16_t              *s_buf     = NULL;   /* 累积缓冲（模型块大小） */
static int                   s_fill    = 0;
static volatile int          s_enabled = 0;
static volatile int          s_hit     = 0;

int wake_ready(void)   { return s_data != NULL; }
int wake_enabled(void) { return s_enabled; }

int wake_init(void)
{
    s_models = esp_srmodel_init("model");
    if (!s_models || s_models->num <= 0) {
        ESP_LOGW(TAG, "没找到 model 分区/语音模型，语音唤醒不可用");
        return -1;
    }
    char *name = esp_srmodel_filter(s_models, ESP_WN_PREFIX, NULL);
    if (!name) {
        ESP_LOGW(TAG, "模型包里没有唤醒词（检查 sdkconfig 的 SR_WN_* 选项）");
        return -1;
    }
    s_wn = esp_wn_handle_from_name(name);
    if (!s_wn) {
        ESP_LOGW(TAG, "取唤醒词接口失败: %s", name);
        return -1;
    }
    s_data = s_wn->create(name, DET_MODE_95);
    if (!s_data) {
        ESP_LOGW(TAG, "创建唤醒词实例失败: %s", name);
        return -1;
    }
    s_chunk = s_wn->get_samp_chunksize(s_data);
    s_buf = (int16_t *)heap_caps_malloc((size_t)s_chunk * sizeof(int16_t), MALLOC_CAP_DEFAULT);
    if (!s_buf) {
        ESP_LOGE(TAG, "唤醒缓冲分配失败");
        s_wn->destroy(s_data);
        s_data = NULL;
        return -1;
    }
    char *words = esp_srmodel_get_wake_words(s_models, name);
    ESP_LOGI(TAG, "语音唤醒就绪: %s(%s) 采样率 %d 块 %d 采样",
             name, words ? words : "?", s_wn->get_samp_rate(s_data), s_chunk);
    return 0;
}

void wake_set_enabled(int on)
{
    if (!s_data) return;
    if (on && !s_enabled) s_fill = 0;    /* 重开时丢掉半块旧数据 */
    s_enabled = on ? 1 : 0;
}

void wake_feed(const int16_t *pcm, int n)
{
    if (!s_enabled || !s_data || !s_buf || n <= 0) return;

    int i = 0;
    while (i < n) {
        int take = s_chunk - s_fill;
        if (take > n - i) take = n - i;
        memcpy(s_buf + s_fill, pcm + i, (size_t)take * sizeof(int16_t));
        s_fill += take;
        i += take;
        if (s_fill >= s_chunk) {
            s_fill = 0;
            int r = s_wn->detect(s_data, s_buf);
            if (r > 0) {                 /* 命中：等 main 接管（应答 + 聆听） */
                s_hit = 1;
                s_enabled = 0;
                ESP_LOGI(TAG, "听到唤醒词（detect=%d）", r);
                return;
            }
        }
    }
}

int wake_take_hit(void)
{
    int h = s_hit;
    if (h) s_hit = 0;
    return h;
}
