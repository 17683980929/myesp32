/**
 * wifi_sta.c — WiFi 站点模式（自动重连 + BSSID 黑名单换节点）
 *
 * 为什么需要黑名单：同一个 SSID 可能由多台 Mesh 节点广播。副节点回程断了时，
 * 板子能关联上去、却拿不到 DHCP / 到不了服务器；而 ESP-IDF 默认只看信号强度，
 * 会一直往那个"假接入"的节点上撞。这里的策略：
 *   - 在同一个节点上 2 分钟仍连不上服务器（ws_connected()==0）→ 守护任务
 *     直接按开机的扫描缓存拉黑并切换（不创建任务、不再分配内存）；
 *   - 扫同 SSID 的其他 BSSID，把当前节点拉黑 10 分钟，锁定信号最好的另一个节点重连；
 *   - 没有其他节点就不拉黑（避免把自己锁死），60 秒后再试。
 *
 * 说明：BSSID 锁定只用于"切过去"这一次——断开重连时会把 bssid_set 清掉，
 * 避免副节点修好/主节点挂了以后永远回不来。
 */

#include "wifi_sta.h"
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_timer.h"
#include "nvs_flash.h"
#include "esp_netif.h"
#include "esp_heap_caps.h"

static const char *TAG = "wifi";
EventGroupHandle_t wifi_events;
static int s_retry = 0;

/* ── 节点状态 ──────────────────────────────────────────────────────── */

static char     s_ssid[33];
static char     s_pass[64];
static uint8_t  s_bssid[6];          /* 当前关联的 BSSID */
static volatile bool s_assoc;        /* L2 已关联（不一定有 IP） */
static uint32_t s_assoc_at;          /* 本次关联时刻（ms，32 位原子读写） */
static volatile bool s_paused;       /* 暂停自动重连（进配网/重置模式） */

/* 指定节点重连（只用于一次切换） */
static bool     s_have_target;
static uint8_t  s_target[6];
static bool     s_pinned;            /* 当前 STA 配置里 bssid_set=1 */

/* ── BSSID 黑名单（RAM，10 分钟）───────────────────────────────────── */

#define BL_MAX  8
#define BL_MS   600000              /* 拉黑 10 分钟 */
#define SCAN_MAX 24

typedef struct {
    uint8_t bssid[6];
    int64_t until;                  /* 0 = 空槽 */
} bl_entry_t;

static bl_entry_t s_bl[BL_MAX];

/* 同 SSID 可见节点缓存：开机（堆最富裕时）扫一次，换节点时只读缓存。
 * 实机教训：坏节点上反复重连两分钟后内部堆已被耗尽，此时再
 * xTaskCreate/calloc 都会失败，换节点逻辑永远执行不了。 */
static wifi_ap_record_t s_scan[SCAN_MAX];
static int     s_scan_n;
static int64_t s_scan_at;

/* 链路健康回调（由 main 接到 ws_connected）*/
static wifi_sta_health_fn s_health;
static void guard_task(void *arg);

static int64_t now_ms64(void)
{
    return esp_timer_get_time() / 1000;
}

static bool bl_has(const uint8_t *bssid)
{
    int64_t now = now_ms64();
    for (int i = 0; i < BL_MAX; i++)
        if (s_bl[i].until > now && memcmp(s_bl[i].bssid, bssid, 6) == 0)
            return true;
    return false;
}

static void bl_add(const uint8_t *bssid)
{
    int64_t now = now_ms64();
    int slot = -1;

    /* 已有 → 续期 */
    for (int i = 0; i < BL_MAX; i++) {
        if (memcmp(s_bl[i].bssid, bssid, 6) == 0) {
            s_bl[i].until = now + BL_MS;
            return;
        }
    }
    /* 空槽 / 过期槽 */
    for (int i = 0; i < BL_MAX; i++) {
        if (s_bl[i].until <= now) { slot = i; break; }
    }
    /* 全满 → 换掉最早过期的 */
    if (slot < 0) {
        slot = 0;
        for (int i = 1; i < BL_MAX; i++)
            if (s_bl[i].until < s_bl[slot].until) slot = i;
    }
    memcpy(s_bl[slot].bssid, bssid, 6);
    s_bl[slot].until = now + BL_MS;
}

/* ── STA 配置（BSSID 锁定 / 解锁）───────────────────────────────────── */

static void cfg_set_bssid(const uint8_t *bssid)
{
    wifi_config_t c = { 0 };
    /* SSID 恰好 32 字节时不能补 '\0'（缓冲区就是 32），用 strncpy */
    strncpy((char *)c.sta.ssid, s_ssid, sizeof(c.sta.ssid));
    strncpy((char *)c.sta.password, s_pass, sizeof(c.sta.password));
    if (bssid) {
        memcpy(c.sta.bssid, bssid, 6);
        c.sta.bssid_set = 1;
    }
    if (esp_wifi_set_config(WIFI_IF_STA, &c) != ESP_OK)
        ESP_LOGW(TAG, "设置 STA 配置失败");
}

/* ── 事件处理 ──────────────────────────────────────────────────────── */

static void on_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        if (!s_paused) esp_wifi_connect();

    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_CONNECTED) {
        wifi_event_sta_connected_t *e = (wifi_event_sta_connected_t *)data;
        memcpy(s_bssid, e->bssid, 6);
        s_assoc = true;
        s_assoc_at = (uint32_t)(xTaskGetTickCount() * portTICK_PERIOD_MS);
        ESP_LOGI(TAG, "已关联 " MACSTR "（通道 %d）", MAC2STR(e->bssid), e->channel);

    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        s_assoc = false;
        s_assoc_at = 0;
        xEventGroupClearBits(wifi_events, WIFI_EVT_GOT_IP);
        if (s_paused) return;

        s_retry++;

        /* 指定了目标节点：按目标 BSSID 连（只锁这一次） */
        if (s_have_target) {
            ESP_LOGW(TAG, "切换节点 → " MACSTR, MAC2STR(s_target));
            cfg_set_bssid(s_target);
            s_pinned = true;
            s_have_target = false;
            esp_wifi_connect();
        } else {
            /* 上次指定节点的连接失败/断开：先解除 BSSID 锁定再自动选网 */
            if (s_pinned) {
                cfg_set_bssid(NULL);
                s_pinned = false;
                ESP_LOGI(TAG, "解除节点锁定，恢复自动选网");
            }
            esp_wifi_connect();
        }

        if (s_retry <= 10 || s_retry % 50 == 0)
            ESP_LOGW(TAG, "断开，重连(%d)", s_retry);

    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *e = (ip_event_got_ip_t *)data;
        ESP_LOGI(TAG, "IP: " IPSTR, IP2STR(&e->ip_info.ip));
        s_retry = 0;
        xEventGroupSetBits(wifi_events, WIFI_EVT_GOT_IP);
    }
}

/* ── 扫描缓存 / 选节点 ─────────────────────────────────────────────── */

static void refresh_scan_cache(void)
{
    if (s_paused) return;

    esp_err_t e = esp_wifi_scan_start(NULL, true);
    if (e != ESP_OK) {
        ESP_LOGW(TAG, "扫描节点失败（%s），沿用旧缓存", esp_err_to_name(e));
        return;
    }

    uint16_t num = 0;
    esp_wifi_scan_get_ap_num(&num);
    if (num == 0) {
        esp_wifi_clear_ap_list();
        s_scan_n = 0;
        s_scan_at = now_ms64();
        ESP_LOGW(TAG, "扫描完成：0 个节点");
        return;
    }
    if (num > SCAN_MAX) num = SCAN_MAX;

    uint16_t got = num;
    esp_err_t r = esp_wifi_scan_get_ap_records(&got, s_scan);
    if (r == ESP_OK) {
        s_scan_n = got;
        s_scan_at = now_ms64();
        ESP_LOGI(TAG, "扫描完成：%d 个节点（缓存 %d 个）", num, got);
    } else {
        esp_wifi_clear_ap_list();
        s_scan_n = 0;
        ESP_LOGW(TAG, "读取扫描结果失败（%s）", esp_err_to_name(r));
    }
}

/* 同 SSID、非黑名单、非当前节点里挑信号最好的。
 * cur_rssi 回填当前节点在缓存中的信号（-127 = 没扫到）。 */
static int pick_alternative(const uint8_t *cur, int *cur_rssi, int *best_rssi)
{
    int best = -1;
    *cur_rssi = -127;
    *best_rssi = -127;

    for (int i = 0; i < s_scan_n; i++) {
        if (strncmp((const char *)s_scan[i].ssid, s_ssid, 32) != 0) continue;
        if (memcmp(s_scan[i].bssid, cur, 6) == 0) {
            *cur_rssi = s_scan[i].rssi;
            continue;
        }
        if (bl_has(s_scan[i].bssid)) continue;
        if (s_scan[i].rssi > *best_rssi) {
            best = i;
            *best_rssi = s_scan[i].rssi;
        }
    }
    return best;
}

/* ── 对外接口 ──────────────────────────────────────────────────────── */

esp_err_t wifi_sta_start(const char *ssid, const char *password)
{
    esp_err_t e = nvs_flash_init();
    if (e == ESP_ERR_NVS_NO_FREE_PAGES || e == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ESP_ERROR_CHECK(nvs_flash_init());
    }

    strlcpy(s_ssid, ssid ? ssid : "", sizeof(s_ssid));
    strlcpy(s_pass, password ? password : "", sizeof(s_pass));
    s_paused = false;

    wifi_events = xEventGroupCreate();

    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t wc = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&wc));

    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_event, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_event, NULL));

    wifi_config_t wcfg = { 0 };
    strncpy((char *)wcfg.sta.ssid, s_ssid, sizeof(wcfg.sta.ssid));
    strncpy((char *)wcfg.sta.password, s_pass, sizeof(wcfg.sta.password));

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wcfg));
    ESP_ERROR_CHECK(esp_wifi_start());
    esp_wifi_set_ps(WIFI_PS_NONE);   /* 关省电：避免 beacon 超时断连 + 降低延迟 */

    xTaskCreate(guard_task, "wguard", 3072, NULL, 3, NULL);

    ESP_LOGI(TAG, "WiFi 启动，连接 %s", s_ssid);
    return ESP_OK;
}

esp_err_t wifi_sta_wait(int timeout_ms)
{
    EventBits_t b = xEventGroupWaitBits(wifi_events, WIFI_EVT_GOT_IP,
                                        pdFALSE, pdTRUE,
                                        pdMS_TO_TICKS(timeout_ms));
    return (b & WIFI_EVT_GOT_IP) ? ESP_OK : ESP_ERR_TIMEOUT;
}

void wifi_sta_ip(char *buf, int len)
{
    esp_netif_ip_info_t info;
    esp_netif_t *netif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    if (netif && esp_netif_get_ip_info(netif, &info) == ESP_OK) {
        snprintf(buf, len, IPSTR, IP2STR(&info.ip));
    } else {
        snprintf(buf, len, "?");
    }
}

int wifi_sta_connected(void)
{
    return wifi_events && (xEventGroupGetBits(wifi_events) & WIFI_EVT_GOT_IP);
}

int wifi_sta_rssi(void)
{
    wifi_ap_record_t ap;
    if (esp_wifi_sta_get_ap_info(&ap) == ESP_OK) return ap.rssi;
    return -127;
}

void wifi_sta_kick(void)
{
    /* 强制断开：on_event 的 STA_DISCONNECTED 分支随后会自动 esp_wifi_connect()。
     * 用于"僵尸关联"（AP 已把设备踢下线，但 deauth 帧丢了、设备不知道）——
     * 此状态下设备发出的所有数据都被 AP 丢弃，只有重新关联才能真正恢复。 */
    esp_wifi_disconnect();
}

int64_t wifi_sta_assoc_ms(void)
{
    if (!s_assoc) return -1;
    uint32_t now = (uint32_t)(xTaskGetTickCount() * portTICK_PERIOD_MS);
    return (int64_t)(now - s_assoc_at);
}

/* 守护任务在下面直接完成选节点/拉黑/切换（不再创建任务）。 */

void wifi_sta_pause(void)
{
    s_paused = true;
    s_have_target = false;
    /* 开机直接进重置门户时 WiFi 还没初始化（wifi_events == NULL），
     * 此时不能调用 esp_wifi_disconnect()。 */
    if (wifi_events) {
        xEventGroupClearBits(wifi_events, WIFI_EVT_GOT_IP);
        esp_wifi_disconnect();
    }
}

void wifi_sta_set_health_fn(wifi_sta_health_fn fn)
{
    s_health = fn;
}

/* ── 黑名单守护：在同一个节点上 2 分钟到不了服务器 → 拉黑换节点 ──────
 * 独立小任务（不依赖主循环/配网流程），开机进配网门户时也照常工作。
 * 计时跨"同节点重复关联"累计（链路抖动导致的重连不重置计时器；
 * 只有链路真正健康过、或换了节点，才重新从 0 开始计 2 分钟）。
 *
 * 关键：换节点只用 8 秒时扫描好的缓存，不再 calloc/xTaskCreate——
 * 实测坏节点上重连两分钟后内部堆已耗尽，任何分配都会失败。 */

static void guard_task(void *arg)
{
    (void)arg;
    uint32_t last_try = 0;
    uint32_t bad_since = 0;
    uint32_t noip_since = 0;
    uint32_t last_ip_kick = 0;
    uint8_t  track_bssid[6];
    int      tracking = 0;
    int64_t  last_mem_log = 0;

    /* 开机先扫：此时内部堆最富裕，缓存同 SSID 的候选节点。 */
    vTaskDelay(pdMS_TO_TICKS(8000));
    refresh_scan_cache();

    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(5000));
        uint32_t now = (uint32_t)(xTaskGetTickCount() * portTICK_PERIOD_MS);
        int64_t  now64 = now_ms64();

        if (now64 - last_mem_log >= 60000) {
            last_mem_log = now64;
            ESP_LOGI(TAG, "内部内存：空闲 %u B / 最大块 %u B",
                     (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
                     (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));
        }

        if (s_paused) { tracking = 0; noip_since = 0; continue; }
        if (!s_health) continue;                   /* 没接健康回调：不启用黑名单 */

        /* 链路健康（连上服务器了）→ 清零；之后定期刷新节点缓存 */
        if (s_health()) {
            tracking = 0;
            noip_since = 0;
            if (s_scan_n == 0 || now64 - s_scan_at > 600000)
                refresh_scan_cache();
            continue;
        }

        if (!s_assoc) { noip_since = 0; continue; } /* 没关联：没有可拉黑的对象 */

        /* 换了节点 → 从这个节点重新计时 */
        if (!tracking || memcmp(track_bssid, s_bssid, 6) != 0) {
            memcpy(track_bssid, s_bssid, 6);
            bad_since = now;
            noip_since = 0;
            tracking = 1;
            continue;
        }

        bool has_ip = wifi_sta_connected();

        if (!has_ip) {
            /* 关联了但没 IP：先重连要 DHCP，别急着给节点判死刑。
             * 60 秒重试一次；5 分钟还拿不到 IP 才换节点。 */
            if (!noip_since) noip_since = now;
            if (now - noip_since >= 60000 && now - last_ip_kick >= 60000) {
                last_ip_kick = now;
                ESP_LOGW(TAG, "关联 %u 秒仍无 IP → 重连重试 DHCP",
                         (unsigned)((now - noip_since) / 1000));
                esp_wifi_disconnect();
            }
            if (now - noip_since < 300000) continue;
        } else {
            noip_since = 0;
        }

        if (now - bad_since < 120000) continue;    /* 不满 2 分钟 */
        if (now - last_try < 60000) continue;      /* 换节点请求限流 */
        last_try = now;

        int cur_rssi = -127, best_rssi = -127;
        int best = pick_alternative(s_bssid, &cur_rssi, &best_rssi);

        if (best < 0) {
            ESP_LOGW(TAG, "节点 " MACSTR " 连不上服务器，但同 SSID 没有其他可用节点",
                     MAC2STR(s_bssid));
            if (now64 - s_scan_at > 60000) refresh_scan_cache();  /* 缓存可能过期 */
            continue;
        }

        /* 别换到明显更弱的节点（否则会被坏节点反向吸走）；5 分钟后放宽。 */
        if (cur_rssi > -127 && best_rssi < cur_rssi - 5 && now - bad_since < 300000) {
            ESP_LOGW(TAG, "候选 " MACSTR "（%d dBm）比当前 " MACSTR "（%d dBm）差，暂不切换",
                     MAC2STR(s_scan[best].bssid), best_rssi, MAC2STR(s_bssid), cur_rssi);
            continue;
        }

        ESP_LOGW(TAG, "节点 " MACSTR " 已 %u 秒连不上服务器 → 拉黑 10 分钟，改连 " MACSTR "（%d dBm）",
                 MAC2STR(s_bssid), (unsigned)((now - bad_since) / 1000),
                 MAC2STR(s_scan[best].bssid), best_rssi);

        bl_add(s_bssid);
        memcpy(s_target, s_scan[best].bssid, 6);
        s_have_target = true;
        esp_wifi_disconnect();                    /* 断开事件里按目标 BSSID 重连 */

        tracking = 0;                             /* 新节点重新计时 */
        noip_since = 0;
    }
}
