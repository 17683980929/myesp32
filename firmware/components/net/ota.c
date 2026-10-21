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

#define OTA_STACK_WORDS  2048      /* 8KB 内部栈 */
#define OTA_BUF_SIZE     4096      /* 内部下载缓冲 */
#define OTA_MIN_INTERNAL (24 * 1024)

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

static void ota_task(void *arg)
{
    (void)arg;

    esp_http_client_config_t cfg = {
        .url = s_url,
        .timeout_ms = 20000,
        .keep_alive_enable = false,
    };
    esp_http_client_handle_t cli = esp_http_client_init(&cfg);
    if (!cli) { fail("http init"); goto out; }

    if (esp_http_client_open(cli, 0) != ESP_OK) { fail("connect"); goto out_cli; }
    int content_len = esp_http_client_fetch_headers(cli);
    int status = esp_http_client_get_status_code(cli);
    if (status != 200) {
        ESP_LOGE(TAG, "HTTP %d", status);
        fail("http status");
        goto out_cli;
    }
    ESP_LOGI(TAG, "开始下载：%d 字节", content_len);

    const esp_partition_t *upd = esp_ota_get_next_update_partition(NULL);
    if (!upd) { fail("no partition"); goto out_cli; }

    esp_ota_handle_t oh = 0;
    esp_err_t e = esp_ota_begin(upd, OTA_SIZE_UNKNOWN, &oh);
    if (e != ESP_OK) { fail("ota begin"); goto out_cli; }

    uint8_t *buf = heap_caps_malloc(OTA_BUF_SIZE, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    if (!buf) { esp_ota_abort(oh); fail("no buffer"); goto out_cli; }

    int total = 0, last_reported = -1;
    for (;;) {
        int n = esp_http_client_read(cli, (char *)buf, OTA_BUF_SIZE);
        if (n < 0) { free(buf); esp_ota_abort(oh); fail("read"); goto out_cli; }
        if (n == 0) break;
        if (esp_ota_write(oh, buf, n) != ESP_OK) {
            free(buf); esp_ota_abort(oh); fail("write"); goto out_cli;
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

    e = esp_ota_end(oh);
    if (e != ESP_OK) { fail("ota end"); goto out_cli; }

    e = esp_ota_set_boot_partition(upd);
    if (e != ESP_OK) { fail("set boot"); goto out_cli; }

    ESP_LOGI(TAG, "固件写入完成（%d 字节，分区 %s），重启生效", total, upd->label);
    s_pct = 100;
    ws_send_json("{\"t\":\"ota\",\"p\":100}");
    vTaskDelay(pdMS_TO_TICKS(1500));
    esp_restart();

out_cli:
    esp_http_client_close(cli);
    esp_http_client_cleanup(cli);
out:
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
                                       s_stack, &s_tcb, 0)) {
        s_running = 0;
        s_pct = -1;
        return -2;
    }
    ESP_LOGI(TAG, "OTA 开始：%s", s_url);
    return 0;
}
