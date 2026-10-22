/**
 * ota.c — HTTP 下载固件 → 写入备用 OTA 分区 → 重启
 *
 * 任务栈和下载缓冲都必须在内部 RAM：写 flash 时 cache 关闭，PSRAM 不可访问。
 * 进度直接通过 WS 上报（每 5% 一条），main 轮询 ota_percent() 更新屏幕字幕。
 */

#include "ota.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "esp_log.h"
#include "esp_err.h"
#include "esp_http_client.h"
#include "esp_ota_ops.h"
#include "esp_heap_caps.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "ws_client.h"

static const char *TAG = "ota";

#define OTA_STACK_WORDS  3072      /* 12KB 内部栈：esp_ota_end 的图像校验调用链较深 */
#define OTA_BUF_SIZE     4096      /* 内部下载缓冲 */
#define OTA_MIN_INTERNAL (24 * 1024)

/* 把当前阶段也报给服务器：失败时能看出停在 write / verify / setboot 哪一步 */
static void report(const char *stage, int pct)
{
    char m[96];
    snprintf(m, sizeof(m), "{\"t\":\"ota\",\"p\":%d,\"m\":\"%s\"}", pct, stage);
    ws_send_json(m);
}

static volatile int  s_pct = -1;
static volatile int  s_running;
static char          s_err[48];
static char          s_url[160];
static StaticTask_t  s_tcb;
static StackType_t  *s_stack;

int ota_percent(void) { return s_pct; }
const char *ota_err(void) { return s_err; }

static void fail(const char *why)
{
    snprintf(s_err, sizeof(s_err), "%s", why ? why : "?");
    s_pct = -2;
    s_running = 0;
    ESP_LOGE(TAG, "OTA 失败：%s", s_err);
    char m[96];
    snprintf(m, sizeof(m), "{\"t\":\"ota\",\"p\":-2,\"m\":\"%s\"}", s_err);
    ws_send_json(m);
}

/* 一次完整下载；成功会直接重启（不返回），失败返回原因字符串 */
static const char *ota_try_once(void)
{
    esp_http_client_config_t cfg = {
        .url = s_url,
        .timeout_ms = 30000,
        .keep_alive_enable = false,
    };
    esp_http_client_handle_t cli = esp_http_client_init(&cfg);
    if (!cli) return "http init";

    const char *err = NULL;
    esp_ota_handle_t oh = 0;
    uint8_t *buf = NULL;

    if (esp_http_client_open(cli, 0) != ESP_OK) { err = "connect"; goto out; }
    int content_len = esp_http_client_fetch_headers(cli);
    if (esp_http_client_get_status_code(cli) != 200) { err = "http status"; goto out; }
    ESP_LOGI(TAG, "开始下载：%d 字节", content_len);

    const esp_partition_t *upd = esp_ota_get_next_update_partition(NULL);
    if (!upd) { err = "no partition"; goto out; }

    /* 必须传实际镜像大小：OTA_SIZE_UNKNOWN 会把整个 6.4MB 分区一次性擦掉，
     * 长擦除期间中断被关，实测直接触发 300ms 的 Interrupt WDT 重启。 */
    size_t img_size = (content_len > 0 && (size_t)content_len <= upd->size)
                      ? (size_t)content_len : OTA_SIZE_UNKNOWN;
    /* 擦分区要几十秒（2.4MB），期间界面会一直 0%——先报个状态 */
    s_pct = -1;
    ws_send_json("{\"t\":\"ota\",\"p\":-1,\"m\":\"擦除分区\"}");
    esp_err_t e = esp_ota_begin(upd, img_size, &oh);
    if (e != ESP_OK) { err = "ota begin"; goto out; }
    s_pct = 0;

    buf = heap_caps_malloc(OTA_BUF_SIZE, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    if (!buf) { err = "no buffer"; esp_ota_abort(oh); goto out; }

    int total = 0, last_reported = -1;
    for (;;) {
        int n = esp_http_client_read(cli, (char *)buf, OTA_BUF_SIZE);
        if (n < 0) { err = "read"; esp_ota_abort(oh); goto out; }
        if (n == 0) break;
        if (esp_ota_write(oh, buf, n) != ESP_OK) {
            err = "write"; esp_ota_abort(oh); goto out;
        }
        total += n;
        if (content_len > 0) {
            int pct = (int)((int64_t)total * 100 / content_len);
            if (pct > 99) pct = 99;
            if (pct / 5 != last_reported / 5) {
                last_reported = pct;
                s_pct = pct;
                char m[48];
                snprintf(m, sizeof(m), "{\"t\":\"ota\",\"p\":%d}", pct);
                ws_send_json(m);
            }
        }
    }
    free(buf);
    buf = NULL;

    if (total <= 0 || (content_len > 0 && total != content_len)) {
        err = "incomplete"; esp_ota_abort(oh); goto out;
    }

    report("verify", 96);
    if (esp_ota_end(oh) != ESP_OK) { err = "ota end"; goto out; }

    report("setboot", 98);
    if (esp_ota_set_boot_partition(upd) != ESP_OK) { err = "set boot"; goto out; }

    ESP_LOGI(TAG, "固件写入完成（%d 字节，分区 %s），重启生效", total, upd->label);
    s_pct = 100;
    report("done", 100);
    vTaskDelay(pdMS_TO_TICKS(1500));
    esp_restart();

out:
    if (buf) free(buf);
    esp_http_client_close(cli);
    esp_http_client_cleanup(cli);
    return err;
}

static void ota_task(void *arg)
{
    (void)arg;
    const char *err = "?";
    for (int i = 1; i <= 3; i++) {
        err = ota_try_once();
        if (!err) break;                       /* 成功不会走到这里（已重启） */
        ESP_LOGW(TAG, "第 %d 次下载失败：%s", i, err);
        if (i < 3) {
            s_pct = 0;                         /* 进度条回到 0，界面显示重试 */
            vTaskDelay(pdMS_TO_TICKS(2000));
        }
    }
    fail(err);
    s_running = 0;
    vTaskDelete(NULL);
}

int ota_start(const char *url)
{
    if (s_running) return -1;
    if (!url || strncmp(url, "http://", 7) != 0) return -3;
    if (!esp_ota_get_next_update_partition(NULL)) return -3;
    if (heap_caps_get_free_size(MALLOC_CAP_INTERNAL) < OTA_MIN_INTERNAL) return -2;

    if (!s_stack) {
        s_stack = heap_caps_malloc(OTA_STACK_WORDS * sizeof(StackType_t),
                                   MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
        if (!s_stack) return -2;
    }
    snprintf(s_url, sizeof(s_url), "%s", url);
    s_err[0] = 0;
    s_pct = 0;
    s_running = 1;
    if (!xTaskCreateStaticPinnedToCore(ota_task, "ota", OTA_STACK_WORDS, NULL, 4,
                                       s_stack, &s_tcb, 1)) {
        s_running = 0;
        s_pct = -1;
        return -2;
    }
    ESP_LOGI(TAG, "OTA 开始：%s", s_url);
    return 0;
}
