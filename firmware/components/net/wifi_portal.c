/**
 * wifi_portal.c — 配网门户（类小智方案）
 *
 * 板子开热点（MyEsp32-XXXX，开放），跑一个 HTTP 配网页面：
 *   - DNS 劫持：所有域名都解析到 192.168.4.1 → 手机自动弹出配网页
 *   - GET  /      配网页面（预填当前 ssid/host/token）
 *   - GET  /scan  扫描附近 WiFi（JSON）
 *   - POST /save  保存到 NVS → 延迟重启
 * STA 若在后台连上了（老配置其实可用 / 刚保存完）→ 自动重启进正常模式。
 */

#include "wifi_portal.h"
#include "wifi_cfg.h"
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_http_server.h"
#include "driver/gpio.h"
#include "lwip/sockets.h"
#include "lwip/inet.h"
#include "hw_config.h"

static const char *TAG = "portal";
static char s_ap_ssid[24];
static int  s_restarting = 0;          /* 已安排重启，防止重复 */

/* ── 热点名 ────────────────────────────────────────────────────────── */

void wifi_portal_ap_name(char *buf, size_t n)
{
    uint8_t mac[6] = { 0 };
    esp_read_mac(mac, ESP_MAC_WIFI_SOFTAP);
    snprintf(buf, n, "MyEsp32-%02X%02X", mac[4], mac[5]);
}

/* ── 开机长按 KEY 检测 ─────────────────────────────────────────────── */

bool wifi_portal_key_held(void)
{
    gpio_config_t c = {
        .pin_bit_mask = 1ULL << KEY_BTN_PIN,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
    };
    if (gpio_config(&c) != ESP_OK) return false;
    if (gpio_get_level(KEY_BTN_PIN) != 0) return false;    /* 没按 → 立即返回 */

    for (int i = 0; i < 30; i++) {                          /* 按住 3 秒才认 */
        vTaskDelay(pdMS_TO_TICKS(100));
        if (gpio_get_level(KEY_BTN_PIN) != 0) return false;
    }
    ESP_LOGI(TAG, "开机检测到 KEY 长按 → 强制配网");
    return true;
}

/* ── 配网网页（PAGE_A + 动态字段 + PAGE_B）────────────────────────── */

static const char PAGE_A[] =
    "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
    "<title>MyEsp32 配网</title><style>"
    "body{font-family:system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;"
    "margin:0;background:#eef1f5;color:#222;-webkit-text-size-adjust:100%}"
    ".card{max-width:430px;margin:18px auto;background:#fff;border-radius:14px;"
    "padding:22px;box-shadow:0 4px 16px rgba(0,0,0,.08)}"
    "h1{font-size:19px;margin:0} .sub{font-size:13px;color:#888;margin:4px 0 10px}"
    "label{display:block;margin:14px 0 6px;font-size:13px;color:#555}"
    "input{width:100%;box-sizing:border-box;padding:11px;font-size:16px;"
    "border:1px solid #d5d9e0;border-radius:9px;outline:none}"
    "input:focus{border-color:#2b6cff}"
    ".row{display:flex;gap:8px} .row input{flex:1}"
    "button{font-size:15px;border:0;border-radius:9px;background:#2b6cff;color:#fff;"
    "padding:11px 16px;cursor:pointer}"
    "button.ghost{background:#e8edf7;color:#2b6cff;white-space:nowrap}"
    "#aps .ap{padding:10px 12px;margin-top:6px;background:#f4f6fa;border-radius:9px;"
    "font-size:15px;cursor:pointer}"
    "#save{width:100%;margin-top:22px;padding:14px;font-size:16px}"
    ".hint{font-size:12px;color:#99a0ab;line-height:1.8;margin-top:14px}"
    "</style></head><body><div class=\"card\">"
    "<h1>MyEsp32 配网</h1>"
    "<div class=\"sub\">桌面宠物 · 在这里设置 WiFi 和服务器</div>";

static const char PAGE_B[] =
    "<button id=\"save\" onclick=\"save()\">保存并重启</button>"
    "<div class=\"hint\">保存后设备自动重启并连接，热点会关闭。<br>"
    "没自动弹出本页面时，用浏览器打开 <b>192.168.4.1</b>。<br>"
    "以后重新配网：开机时长按 KEY 三秒。</div></div>"
    "<script>"
    "async function scan(){var b=document.getElementById('aps');"
    "b.textContent='扫描中…';"
    "try{var a=await(await fetch('/scan')).json();b.textContent='';"
    "if(!a.length){b.textContent='没扫到，直接手动输入也行';return;}"
    "for(var i=0;i<a.length;i++){var d=document.createElement('div');"
    "d.className='ap';d.textContent=a[i].s+'  ('+a[i].r+' dBm)';"
    "d.setAttribute('data-s',a[i].s);"
    "d.onclick=function(){document.getElementById('ssid').value="
    "this.getAttribute('data-s');};"
    "b.appendChild(d);}}catch(e){b.textContent='扫描失败，可直接手动输入';}}"
    "async function save(){var s=document.getElementById('ssid').value;"
    "if(!s){alert('请填 WiFi 名称');return;}"
    "var p=new URLSearchParams();p.set('ssid',s);"
    "p.set('pass',document.getElementById('pass').value);"
    "p.set('host',document.getElementById('host').value);"
    "p.set('token',document.getElementById('token').value);"
    "try{await fetch('/save',{method:'POST',"
    "headers:{'Content-Type':'application/x-www-form-urlencoded'},body:p});"
    "document.body.innerHTML='<div class=card><h1>已保存 ✓</h1>"
    "<p>设备正在重启并连接 WiFi，几秒后看屏幕提示。</p></div>';}"
    "catch(e){alert('保存失败，请重试');}}"
    "</script></body></html>";

static char s_page[6144];

static void html_escape(const char *in, char *out, size_t out_sz)
{
    size_t o = 0;
    for (; *in && o + 7 < out_sz; in++) {
        const char *rep = NULL;
        switch (*in) {
        case '&':  rep = "&amp;";  break;
        case '<':  rep = "&lt;";   break;
        case '>':  rep = "&gt;";   break;
        case '"':  rep = "&quot;"; break;
        default:   out[o++] = *in; continue;
        }
        for (const char *p = rep; *p; p++) out[o++] = *p;
    }
    out[o] = 0;
}

/* 安全追加（防越界，网页 / JSON 共用；越界时静默截断） */
static int jcat(char *buf, int cap, int len, const char *fmt, ...)
{
    if (len < 0) return 0;
    if (len >= cap - 2) return cap - 2;
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(buf + len, (size_t)(cap - len), fmt, ap);
    va_end(ap);
    if (n < 0) return len;
    if (n > cap - 1 - len) n = cap - 1 - len;
    return len + n;
}

static void build_page(void)
{
    wifi_cfg_t cfg;
    wifi_cfg_load(&cfg);

    char ssid[256], host[256], token[256];
    html_escape(cfg.ssid,  ssid,  sizeof(ssid));
    html_escape(cfg.host,  host,  sizeof(host));
    html_escape(cfg.token, token, sizeof(token));

    int len = 0;
    len = jcat(s_page, sizeof(s_page), len, "%s", PAGE_A);
    len = jcat(s_page, sizeof(s_page), len,
        "<label>WiFi 名称（只支持 2.4GHz）</label>"
        "<div class=\"row\"><input id=\"ssid\" value=\"%s\" placeholder=\"输入或点右侧扫描\">"
        "<button type=\"button\" class=\"ghost\" onclick=\"scan()\">扫描</button></div>"
        "<div id=\"aps\"></div>"
        "<label>WiFi 密码（开放网络留空）</label><input id=\"pass\" type=\"password\">"
        "<label>服务器地址（host:port，可留空）</label><input id=\"host\" value=\"%s\">"
        "<label>服务器 Token（可留空）</label><input id=\"token\" value=\"%s\">",
        ssid, host, token);
    jcat(s_page, sizeof(s_page), len, "%s", PAGE_B);
}

/* ── HTTP 处理器 ───────────────────────────────────────────────────── */

static esp_err_t h_root(httpd_req_t *r)
{
    httpd_resp_set_type(r, "text/html; charset=utf-8");
    return httpd_resp_sendstr(r, s_page);
}

static esp_err_t h_scan(httpd_req_t *r)
{
    static char jbuf[1600];
    int len = 0;
    len = jcat(jbuf, sizeof(jbuf), len, "[");

    if (esp_wifi_scan_start(NULL, true) == ESP_OK) {
        uint16_t num = 0;
        esp_wifi_scan_get_ap_num(&num);
        if (num > 12) num = 12;
        wifi_ap_record_t *recs = calloc(num ? num : 1, sizeof(*recs));
        if (recs && esp_wifi_scan_get_ap_records(&num, recs) == ESP_OK) {
            /* RSSI 降序（插入排序，量小） */
            for (int i = 1; i < num; i++) {
                wifi_ap_record_t t = recs[i];
                int j = i - 1;
                while (j >= 0 && recs[j].rssi < t.rssi) { recs[j + 1] = recs[j]; j--; }
                recs[j + 1] = t;
            }
            int first = 1;
            for (int i = 0; i < num; i++) {
                if (!recs[i].ssid[0]) continue;
                if (len > (int)sizeof(jbuf) - 96) break;
                len = jcat(jbuf, sizeof(jbuf), len, "%s{\"s\":\"", first ? "" : ",");
                first = 0;
                for (const unsigned char *p = recs[i].ssid; *p; p++) {
                    if (*p == '"' || *p == '\\')
                        len = jcat(jbuf, sizeof(jbuf), len, "\\%c", *p);
                    else if (*p < 0x20)
                        len = jcat(jbuf, sizeof(jbuf), len, "?");
                    else
                        len = jcat(jbuf, sizeof(jbuf), len, "%c", (char)*p);
                }
                len = jcat(jbuf, sizeof(jbuf), len, "\",\"r\":%d}", recs[i].rssi);
            }
        }
        free(recs);
    }
    len = jcat(jbuf, sizeof(jbuf), len, "]");

    httpd_resp_set_type(r, "application/json");
    return httpd_resp_send(r, jbuf, len);
}

/* 从 x-www-form-urlencoded 体里取一个字段（%XX 与 + 解码） */
static int hexval(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static void uform_get(const char *body, const char *key, char *out, size_t out_sz)
{
    out[0] = 0;
    size_t klen = strlen(key);
    const char *p = body;
    while (p && *p) {
        const char *amp = strchr(p, '&');
        size_t seg = amp ? (size_t)(amp - p) : strlen(p);
        const char *eq = memchr(p, '=', seg);
        if (eq && (size_t)(eq - p) == klen && strncmp(p, key, klen) == 0) {
            const char *vend = p + seg, *q = eq + 1;
            size_t o = 0;
            while (q < vend && o < out_sz - 1) {
                if (*q == '+') { out[o++] = ' '; q++; }
                else if (*q == '%' && q + 2 < vend) {
                    int hi = hexval(q[1]), lo = hexval(q[2]);
                    if (hi >= 0 && lo >= 0) { out[o++] = (char)(hi * 16 + lo); q += 3; }
                    else { out[o++] = *q++; }
                } else out[o++] = *q++;
            }
            out[o] = 0;
            return;
        }
        p = amp ? amp + 1 : NULL;
    }
}

static void restart_task(void *arg)
{
    (void)arg;
    vTaskDelay(pdMS_TO_TICKS(1500));      /* 让响应先发出去 */
    esp_restart();
}

static esp_err_t h_save(httpd_req_t *r)
{
    char body[768];
    int total = r->content_len;
    if (total <= 0 || total >= (int)sizeof(body)) {
        httpd_resp_send_err(r, HTTPD_400_BAD_REQUEST, "请求体过大或为空");
        return ESP_OK;
    }
    int got = 0;
    while (got < total) {
        int n = httpd_req_recv(r, body + got, total - got);
        if (n <= 0) {
            httpd_resp_send_err(r, HTTPD_400_BAD_REQUEST, "读取失败");
            return ESP_OK;
        }
        got += n;
    }
    body[got] = 0;

    wifi_cfg_t cfg;
    wifi_cfg_load(&cfg);

    char v[100];
    uform_get(body, "ssid", v, sizeof(v));
    if (v[0]) {
        if (strcmp(cfg.ssid, v) != 0) {
            /* 换网了：密码按表单为准（空 = 开放网络） */
            strlcpy(cfg.ssid, v, sizeof(cfg.ssid));
            uform_get(body, "pass", v, sizeof(v));
            strlcpy(cfg.pass, v, sizeof(cfg.pass));
        } else {
            /* 没换网：密码留空表示保持原密码 */
            uform_get(body, "pass", v, sizeof(v));
            if (v[0]) strlcpy(cfg.pass, v, sizeof(cfg.pass));
        }
    }
    if (!cfg.ssid[0]) {
        httpd_resp_send_err(r, HTTPD_400_BAD_REQUEST, "缺少 WiFi 名称");
        return ESP_OK;
    }

    uform_get(body, "host", v, sizeof(v));
    if (v[0]) strlcpy(cfg.host, v, sizeof(cfg.host));
    uform_get(body, "token", v, sizeof(v));
    strlcpy(cfg.token, v, sizeof(cfg.token));

    if (wifi_cfg_save(&cfg) != ESP_OK) {
        httpd_resp_send_err(r, HTTPD_500_INTERNAL_SERVER_ERROR, "保存失败");
        return ESP_OK;
    }
    ESP_LOGI(TAG, "配网保存：ssid=%s host=%s", cfg.ssid, cfg.host);

    httpd_resp_set_type(r, "text/html; charset=utf-8");
    httpd_resp_sendstr(r,
        "<!doctype html><meta charset=utf-8><title>已保存</title>"
        "<body style='font-family:sans-serif;text-align:center;padding-top:3em'>"
        "<h2>已保存 ✓</h2><p>设备正在重启并连接 WiFi…</p>");

    if (!s_restarting) {
        s_restarting = 1;
        xTaskCreate(restart_task, "rst", 2048, NULL, 5, NULL);
    }
    return ESP_OK;
}

/* 未知路径 → 302 回配网页（触发手机"登录网络"弹窗） */
static esp_err_t on_404(httpd_req_t *r, httpd_err_code_t err)
{
    if (err == HTTPD_404_NOT_FOUND) {
        httpd_resp_set_status(r, "302 Found");
        httpd_resp_set_hdr(r, "Location", "http://192.168.4.1/");
        return httpd_resp_send(r, NULL, 0);
    }
    return ESP_FAIL;
}

/* ── DNS 劫持：全部解析到 192.168.4.1 ─────────────────────────────── */

static void dns_task(void *arg)
{
    (void)arg;
    int sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (sock < 0) {
        ESP_LOGE(TAG, "DNS socket 创建失败");
        vTaskDelete(NULL);
        return;
    }

    struct sockaddr_in addr = { 0 };
    addr.sin_family = AF_INET;
    addr.sin_port = htons(53);
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    if (bind(sock, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        ESP_LOGE(TAG, "DNS 绑定 53 失败");
        close(sock);
        vTaskDelete(NULL);
        return;
    }
    ESP_LOGI(TAG, "DNS 劫持已启动 → 一切域名都指到 192.168.4.1");

    uint8_t in[512], out[512];
    for (;;) {
        struct sockaddr_in from;
        socklen_t fl = sizeof(from);
        int n = recvfrom(sock, in, sizeof(in), 0, (struct sockaddr *)&from, &fl);
        if (n < 12) continue;

        /* 跳过 QNAME（labels 直到 0x00），找 qtype */
        int p = 12;
        while (p < n && in[p]) p += in[p] + 1;
        if (p + 5 > n) continue;
        uint16_t qtype = (uint16_t)((in[p + 1] << 8) | in[p + 2]);
        int qend = p + 5;

        memcpy(out, in, qend);
        out[2] |= 0x80;                     /* QR = 1 */
        out[3] = 0x80;                      /* RA = 1, RCODE = 0 */
        out[8] = out[9] = out[10] = out[11] = 0;
        int olen = qend;

        if (qtype == 1) {                   /* A 记录 → 192.168.4.1 */
            static const uint8_t ans[16] = {
                0xC0, 0x0C,                 /* 名字指针 → 原查询 */
                0x00, 0x01, 0x00, 0x01,     /* TYPE A, CLASS IN */
                0x00, 0x00, 0x00, 0x3C,     /* TTL 60 */
                0x00, 0x04, 192, 168, 4, 1  /* 192.168.4.1 */
            };
            memcpy(out + olen, ans, sizeof(ans));
            olen += sizeof(ans);
            out[6] = 0; out[7] = 1;         /* ANCOUNT = 1 */
        } else {
            out[6] = 0; out[7] = 0;         /* 其它类型：空应答 */
        }
        sendto(sock, out, olen, 0, (struct sockaddr *)&from, fl);
    }
}

/* ── 启动门户 ──────────────────────────────────────────────────────── */

static void on_got_ip(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg; (void)base; (void)id; (void)data;
    if (s_restarting) return;
    s_restarting = 1;
    ESP_LOGI(TAG, "STA 已在后台连上 → 重启进入正常模式");
    xTaskCreate(restart_task, "rst", 2048, NULL, 5, NULL);
}

void wifi_portal_run(bool keep_sta)
{
    wifi_portal_ap_name(s_ap_ssid, sizeof(s_ap_ssid));
    build_page();

    /* 1. 基础设施（STA 已跑过则已就绪；重复调用安全） */
    (void)esp_netif_init();
    (void)esp_event_loop_create_default();  /* 已创建返回 INVALID_STATE，忽略 */

    wifi_mode_t m;
    bool started = (esp_wifi_get_mode(&m) == ESP_OK);
    if (!started) {
        wifi_init_config_t wc = WIFI_INIT_CONFIG_DEFAULT();
        ESP_ERROR_CHECK(esp_wifi_init(&wc));
    }

    /* 2. AP netif（默认 IP 192.168.4.1 + DHCP 服务器） */
    if (!esp_netif_get_handle_from_ifkey("WIFI_AP_DEF")) {
        esp_netif_t *ap_netif = esp_netif_create_default_wifi_ap();
        if (!ap_netif) ESP_LOGE(TAG, "创建 AP netif 失败");
    }

    /* 3. 切 APSTA（STA 短暂停一下会自己继续重连） */
    if (started) esp_wifi_stop();

    wifi_config_t ap = { 0 };
    strlcpy((char *)ap.ap.ssid, s_ap_ssid, sizeof(ap.ap.ssid));
    ap.ap.ssid_len = (uint8_t)strlen(s_ap_ssid);
    ap.ap.channel = 1;
    ap.ap.max_connection = 4;
    ap.ap.authmode = WIFI_AUTH_OPEN;
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_APSTA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_AP, &ap));
    ESP_ERROR_CHECK(esp_wifi_start());

    if (keep_sta)
        esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_got_ip, NULL);

    ESP_LOGI(TAG, "配网热点已开启：%s（开放网络）", s_ap_ssid);
    ESP_LOGI(TAG, "手机连上后浏览器打开 http://192.168.4.1");

    /* 4. DNS 劫持 + 配网网页 */
    xTaskCreate(dns_task, "dns", 3072, NULL, 4, NULL);

    httpd_handle_t srv = NULL;
    httpd_config_t hc = HTTPD_DEFAULT_CONFIG();
    hc.lru_purge_enable = true;
    ESP_ERROR_CHECK(httpd_start(&srv, &hc));

    httpd_uri_t u_root = { .uri = "/",     .method = HTTP_GET,  .handler = h_root };
    httpd_uri_t u_scan = { .uri = "/scan", .method = HTTP_GET,  .handler = h_scan };
    httpd_uri_t u_save = { .uri = "/save", .method = HTTP_POST, .handler = h_save };
    ESP_ERROR_CHECK(httpd_register_uri_handler(srv, &u_root));
    ESP_ERROR_CHECK(httpd_register_uri_handler(srv, &u_scan));
    ESP_ERROR_CHECK(httpd_register_uri_handler(srv, &u_save));
    httpd_register_err_handler(srv, HTTPD_404_NOT_FOUND, on_404);

    /* 到这里都由各任务接管；调用方（app_main）可以就此返回 */
}
