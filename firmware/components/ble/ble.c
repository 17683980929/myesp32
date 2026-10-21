/**
 * ble.c — NimBLE 从机：可发现/可连接，仅暴露设备信息（DIS）
 *
 * 首次 ble_set_enabled(1) 才 nimble_port_init，避免不用蓝牙时占内部 RAM。
 * 关闭只停广播/断连接，协议栈保留（再次打开无需重新初始化）。
 *
 * 内部 RAM 很紧（WiFi + WakeNet + Opus + Lua 之后只剩几十 KB），控制器
 * 可能在 LE Set Advertising Enable 上回 HCI 0x07（Memory Capacity Exceeded）。
 * 这种失败是暂时的——播放/脚本活动会让堆起伏，所以 ble_poll() 会隔几秒重试。
 */

#include "ble.h"
#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_err.h"
#include "esp_mac.h"
#include "esp_heap_caps.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "host/ble_hs.h"
#include "host/ble_gap.h"
#include "host/ble_hs_adv.h"
#include "host/util/util.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"
#include "services/dis/ble_svc_dis.h"
#include "ws_client.h"

static const char *TAG = "ble";

#define ADV_RETRY_MS   2000        /* 广播启动失败后的重试间隔 */
#define ADV_RETRY_MAX  15          /* 最多重试次数（≈30 秒） */

static volatile int s_enabled;
static volatile int s_inited;
static volatile int s_synced;
static volatile int s_state = BLE_OFF;
static uint16_t s_conn = BLE_HS_CONN_HANDLE_NONE;
static uint8_t  s_own_addr_type;
static char     s_name[24];

static int      s_adv_fail;        /* 连续失败次数 */
static uint32_t s_adv_next_try;    /* 下次重试时刻（ms） */

static uint32_t now_ms(void)
{
    return (uint32_t)(xTaskGetTickCount() * portTICK_PERIOD_MS);
}

static int start_adv(void);

static int gap_event(struct ble_gap_event *event, void *arg)
{
    (void)arg;

    switch (event->type) {
    case BLE_GAP_EVENT_CONNECT:
        if (event->connect.status == 0) {
            s_conn = event->connect.conn_handle;
            s_state = BLE_CONNECTED;
            ESP_LOGI(TAG, "手机已连接（conn=%d）", s_conn);
        } else {
            ESP_LOGW(TAG, "连接失败（status=%d）", event->connect.status);
            s_state = BLE_OFF;
            if (s_enabled) start_adv();
        }
        return 0;

    case BLE_GAP_EVENT_DISCONNECT:
        ESP_LOGI(TAG, "手机断开（reason=%d）", event->disconnect.reason);
        s_conn = BLE_HS_CONN_HANDLE_NONE;
        s_state = BLE_OFF;
        if (s_enabled) start_adv();
        return 0;

    case BLE_GAP_EVENT_ADV_COMPLETE:
        s_state = BLE_OFF;
        if (s_enabled) start_adv();
        return 0;

    default:
        return 0;
    }
}

/** 真正开始广播；成功返回 0 并把状态置为「广播中」。 */
static int start_adv(void)
{
    if (!s_enabled || !s_synced || s_state == BLE_CONNECTED) return 0;

    struct ble_hs_adv_fields fields;
    memset(&fields, 0, sizeof(fields));
    fields.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    fields.name = (uint8_t *)s_name;
    fields.name_len = (uint8_t)strlen(s_name);
    fields.name_is_complete = 1;

    int rc = ble_gap_adv_set_fields(&fields);
    if (rc != 0) {
        ESP_LOGE(TAG, "设置广播数据失败：%d", rc);
        s_state = BLE_OFF;
        return rc;
    }

    struct ble_gap_adv_params advp;
    memset(&advp, 0, sizeof(advp));
    advp.conn_mode = BLE_GAP_CONN_MODE_UND;
    advp.disc_mode = BLE_GAP_DISC_MODE_GEN;
    advp.itvl_min = BLE_GAP_ADV_ITVL_MS(100);
    advp.itvl_max = BLE_GAP_ADV_ITVL_MS(150);

    rc = ble_gap_adv_start(s_own_addr_type, NULL, BLE_HS_FOREVER, &advp, gap_event, NULL);
    if (rc == 0 || rc == BLE_HS_EALREADY) {
        s_state = BLE_ADVERTISING;
        s_adv_fail = 0;
        ESP_LOGI(TAG, "广播中：%s", s_name);
        return 0;
    }

    s_state = BLE_OFF;
    if (++s_adv_fail == 1 || s_adv_fail >= ADV_RETRY_MAX)
        ESP_LOGW(TAG, "开始广播失败：%d（第 %d 次，内部堆空闲 %u B / 最大块 %u B）",
                 rc, s_adv_fail,
                 (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
                 (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));
    return rc;
}

static void on_sync(void)
{
    s_synced = 1;
    int rc = ble_hs_util_ensure_addr(0);
    if (rc != 0) {
        ESP_LOGE(TAG, "BLE 地址准备失败：%d", rc);
        return;
    }
    rc = ble_hs_id_infer_auto(0, &s_own_addr_type);
    if (rc != 0) {
        ESP_LOGE(TAG, "BLE 地址类型推断失败：%d", rc);
        return;
    }
    if (s_enabled) start_adv();
}

static void on_reset(int reason)
{
    ESP_LOGW(TAG, "BLE host reset：%d", reason);
    s_synced = 0;
    s_state = BLE_OFF;
}

static void host_task(void *param)
{
    (void)param;
    nimble_port_run();
    nimble_port_freertos_deinit();
}

int ble_init(void)
{
    if (s_inited) return 0;

    uint8_t mac[6] = { 0 };
    esp_read_mac(mac, ESP_MAC_WIFI_SOFTAP);   /* 与配网热点同名，便于识别 */
    snprintf(s_name, sizeof(s_name), "MyEsp32-%02X%02X", mac[4], mac[5]);

    ESP_LOGI(TAG, "协议栈初始化前内部堆：空闲 %u B / 最大块 %u B",
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));

    /* 控制器初始化时会一次性向内部 DMA 池申请一整块连续内存（实测 30,720B）。
     * 总空闲够、但最大连续块不够时就会 Malloc failed → 控制器内部 assert
     * → 整机重启（用户看到"开蓝牙就断网/闪退"）。先探测同样大小的连续块，
     * 不行就优雅放弃，让 UI/助手如实说蓝牙没起来，而不是重启。 */
    enum { BLE_CTRL_POOL = 30720 };
    void *probe = heap_caps_malloc(BLE_CTRL_POOL, MALLOC_CAP_INTERNAL | MALLOC_CAP_DMA);
    if (!probe) {
        ESP_LOGE(TAG, "内部连续内存不足（最大块 %u B < %d B），跳过蓝牙初始化",
                 (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_DMA),
                 BLE_CTRL_POOL);
        return -1;
    }
    heap_caps_free(probe);

    esp_err_t err = nimble_port_init();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "nimble_port_init 失败：%s（内部堆空闲 %u B）",
                 esp_err_to_name(err),
                 (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
        return -1;
    }

    ble_hs_cfg.sync_cb = on_sync;
    ble_hs_cfg.reset_cb = on_reset;

    ble_svc_gap_init();
    ble_svc_gatt_init();
    ble_svc_dis_init();
    ble_svc_dis_manufacturer_name_set("MyEsp32");
    ble_svc_dis_model_number_set("ESP32-S3-RLCD-4.2");
    ble_svc_dis_firmware_revision_set(MYESP32_FW);
    ble_svc_gap_device_name_set(s_name);

    nimble_port_freertos_init(host_task);
    s_inited = 1;
    ESP_LOGI(TAG, "BLE 初始化：%s（内部堆空闲 %u B / 最大块 %u B）", s_name,
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));
    return 0;
}

void ble_set_enabled(int on)
{
    if (on) {
        if (ble_init() != 0) {
            s_enabled = 0;
            s_state = BLE_OFF;
            return;
        }
        s_enabled = 1;
        s_adv_fail = 0;
        s_adv_next_try = now_ms();
        /* 状态不在这里预判：只有控制器真的接受了广播才显示"广播中"，
         * 否则屏幕会说谎（用户看到"广播中"但手机搜不到）。 */
        if (s_synced) start_adv();
        ESP_LOGI(TAG, "BLE 开启");
    } else {
        s_enabled = 0;
        s_adv_fail = ADV_RETRY_MAX;            /* 关掉就别再重试了 */
        if (s_state == BLE_ADVERTISING) ble_gap_adv_stop();
        if (s_conn != BLE_HS_CONN_HANDLE_NONE)
            ble_gap_terminate(s_conn, BLE_ERR_REM_USER_CONN_TERM);
        s_conn = BLE_HS_CONN_HANDLE_NONE;
        s_state = BLE_OFF;
        ESP_LOGI(TAG, "BLE 关闭");
    }
}

void ble_poll(void)
{
    if (!s_enabled || !s_synced || s_state != BLE_OFF) return;
    if (s_adv_fail >= ADV_RETRY_MAX) return;
    uint32_t now = now_ms();
    if ((int32_t)(now - s_adv_next_try) < 0) return;
    s_adv_next_try = now + ADV_RETRY_MS;
    start_adv();
}

int ble_enabled(void) { return s_enabled; }
ble_state_t ble_state(void) { return (ble_state_t)s_state; }

const char *ble_name(void) { return s_name; }

const char *ble_state_str(void)
{
    switch (s_state) {
    case BLE_ADVERTISING: return "广播中";
    case BLE_CONNECTED:   return "已连接";
    default:              return "关闭";
    }
}
