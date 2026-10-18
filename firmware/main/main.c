/**
 * main.c — MyEsp32 固件入口
 *
 * 启动顺序：NVS → 传感器 → 屏幕 → WiFi（连不上/长按 KEY → 配网门户）→ WebSocket → 按键 → 主循环
 *
 * 主循环职责：
 *   - 每秒刷新主页（时钟走字）
 *   - 处理按键（KEY 翻页 + 功能页 5 秒回主页）
 *   - 处理服务器事件（info 到达时重绘）
 */

#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "nvs_flash.h"

#include "hw_config.h"
#include "lcd.h"
#include "buttons.h"
#include "sensors.h"
#include "pcf85063.h"
#include "wifi_sta.h"
#include "wifi_cfg.h"
#include "wifi_portal.h"
#include "ws_client.h"
#include "ui.h"
#include "audio.h"
#include "wake.h"

static const char *TAG = "main";

static int s_func_since = 0;
static volatile int s_dirty = 1;        /* 需要重绘 */

/* ── 语音状态机（M4）───────────────────────────────────────────────── */

typedef enum { VOICE_IDLE = 0, VOICE_REC, VOICE_THINK, VOICE_SPEAK } voice_state_t;

static voice_state_t s_voice_state = VOICE_IDLE;
static int s_key_down_at = -1;          /* KEY 按下时刻（ms）；-1 = 未按 */
static int s_key_voice = 0;             /* 本次按键已触发录音（防重复） */
static int s_voice_deadline = 0;        /* 思考阶段超时保护 */
static int s_sub_clear_at = 0;          /* 字幕延迟清除时刻 */

/* ── 字幕按播放进度显示 ──────────────────────────────────────────────
 * 服务器为了让设备端有缓冲，发帧比实时快（字幕消息也随之提前 ~2 秒到）。
 * 直接显示会"音画不同步"——把字幕连同「收到时的已入队帧数」入队，
 * 主循环里等播放帧计数追上再显示。 */
#define SUB_MAX   512
#define SUBQ_MAX  12

typedef struct {
    char text[SUB_MAX];
    int  at_frame;                  /* 本条字幕句子的首帧序号（收到时已入队帧数） */
    int  n_frames;                  /* 该句总帧数（服务器下发；0=未知，不翻页） */
} sub_item_t;

static sub_item_t s_subq[SUBQ_MAX];
static int s_subq_head = 0, s_subq_tail = 0;

static void subq_clear(void) { s_subq_head = s_subq_tail = 0; }

/* 当前正在播放的句子：长句超过一页（24 字）时按播放进度翻页 */
static char s_sub_cur[SUB_MAX] = "";
static int  s_sub_cur_at = 0;           /* 该句首帧序号 */
static int  s_sub_cur_frames = 0;       /* 该句总帧数（0=不翻页） */
static int  s_sub_cur_page = 0;         /* 当前显示到第几页 */
static void sub_cur_clear(void)
{
    s_sub_cur[0] = 0;
    s_sub_cur_at = s_sub_cur_frames = s_sub_cur_page = 0;
}

static void subq_push(const char *text, int at_frame, int n_frames)
{
    int next = (s_subq_tail + 1) % SUBQ_MAX;
    if (next == s_subq_head)                       /* 满：丢最旧 */
        s_subq_head = (s_subq_head + 1) % SUBQ_MAX;
    sub_item_t *it = &s_subq[s_subq_tail];
    snprintf(it->text, SUB_MAX, "%s", text ? text : "");
    it->at_frame = at_frame;
    it->n_frames = n_frames;
    s_subq_tail = next;
}

static int now_ms(void) { return (int)(xTaskGetTickCount() * portTICK_PERIOD_MS); }

static int s_wake_greet = 0;      /* 正在播放唤醒应答（播完直接进入自动聆听） */

static void voice_to(voice_state_t v)
{
    s_voice_state = v;
    /* 空闲、播报中都听唤醒词（播报中命中 → 用户优先：打断当前回答改听新的）；
     * 录音/思考中不听（录音里是用户自己的声音会自触发，思考中没意义） */
    wake_set_enabled(v == VOICE_IDLE || v == VOICE_SPEAK);
    switch (v) {
    case VOICE_REC:   ui_set_voice(UI_VOICE_LISTENING); break;
    case VOICE_THINK: ui_set_voice(UI_VOICE_THINKING);  break;
    case VOICE_SPEAK: ui_set_voice(UI_VOICE_SPEAKING);  break;
    default:
        ui_set_voice(UI_VOICE_NONE);
        s_voice_deadline = 0;
        break;
    }
    s_dirty = 1;
}

static void voice_start_rec(void)
{
    if (!audio_ready()) { ESP_LOGW(TAG, "录音不可用：音频未就绪"); return; }
    if (!ws_connected()) { ESP_LOGW(TAG, "录音不可用：未连接服务器"); return; }

    if (ui_get_page() != UI_PAGE_HOME) {
        ui_set_page(UI_PAGE_HOME);
        s_func_since = 0;
    }
    s_sub_clear_at = 0;
    ui_set_sub("");
    audio_rec_start();
    ws_send_json("{\"t\":\"rec\",\"s\":\"start\"}");
    voice_to(VOICE_REC);
    ESP_LOGI(TAG, "开始录音（松开 KEY 结束）");
}

/** 唤醒词触发后的自动聆听：VAD 判"说完"或超时后自动结束（不用按 KEY）。
 *  bargein=1：播报中打断进入（录音开头有喇叭尾音，VAD 会跳过几帧） */
static void voice_start_rec_auto(int bargein)
{
    if (!audio_ready() || !ws_connected()) { voice_to(VOICE_IDLE); return; }
    if (ui_get_page() != UI_PAGE_HOME) {
        ui_set_page(UI_PAGE_HOME);
        s_func_since = 0;
    }
    s_sub_clear_at = 0;
    ui_set_sub("");
    audio_rec_start_auto(bargein);
    ws_send_json("{\"t\":\"rec\",\"s\":\"start\"}");
    voice_to(VOICE_REC);
    ESP_LOGI(TAG, bargein ? "打断后直接聆听（说完自动结束）"
                          : "唤醒应答后自动聆听（说完自动结束）");
}

static void voice_stop_rec(void)
{
    audio_rec_stop();
    ws_send_json("{\"t\":\"rec\",\"s\":\"stop\"}");
    s_voice_deadline = now_ms() + 30000;
    voice_to(VOICE_THINK);
    ESP_LOGI(TAG, "结束录音，等服务器");
}

/** 没检测到有效说话：本地静默收尾 —— 不发录音、不说任何话。
 *  如果刚才是在播报中打断进来的，服务器看到 resume 会从断点续播。 */
static void voice_rec_void(void)
{
    audio_rec_stop();
    voice_to(VOICE_IDLE);                               /* 先回空闲，再通知服务器 */
    ws_send_json("{\"t\":\"rec\",\"s\":\"resume\"}");
}

/** 用户打断：停播放、清字幕与未显示队列，回空闲（随后 voice_start_rec 立即切到录音）。
 *  服务器收到新的 rec start 会作废上一轮回答（turn 失效），旧的迟到帧由
 *  on_ws_audio 的 REC/THINK 过滤丢弃。 */
static void voice_interrupt(void)
{
    s_wake_greet = 0;
    audio_play_stop();
    audio_rec_stop();
    subq_clear();
    sub_cur_clear();
    ui_set_sub("");
    s_sub_clear_at = 0;
    s_dirty = 1;
    voice_to(VOICE_IDLE);
}

/* ── 服务器校时 ────────────────────────────────────────────────────── */

/** 用服务器下发的 info 校准 RTC；偏差大于 90 秒才写，避免秒位被反复重置 */
static void sync_time_from_server(void)
{
    dev_info_t *in = ws_client_info();
    if (in->mm < 1 || in->mm > 12 || in->dd < 1 || in->dd > 31) return;

    int hh = 0, mi = 0;
    if (sscanf(in->time, "%d:%d", &hh, &mi) != 2) return;
    if (hh < 0 || hh > 23 || mi < 0 || mi > 59) return;

    int Y, Mo, D, Wd, H, M, S;
    if (pcf85063_get(&Y, &Mo, &D, &Wd, &H, &M, &S) != 0) return;   /* 年份沿用 RTC */

    if (Mo == in->mm && D == in->dd) {
        int rtc_sod = H * 3600 + M * 60 + S;
        int srv_sod = hh * 3600 + mi * 60;
        int diff = rtc_sod > srv_sod ? rtc_sod - srv_sod : srv_sod - rtc_sod;
        if (diff > 43200) diff = 86400 - diff;      /* 跨午夜 */
        if (diff <= 90) return;
    }

    if (pcf85063_set(Y, in->mm, in->dd, hh, mi, 0) == 0)
        ESP_LOGI(TAG, "RTC 校时 → %04d-%02d-%02d %02d:%02d", Y, in->mm, in->dd, hh, mi);
}

/* ── 服务器事件 → UI ───────────────────────────────────────────────── */

static void on_ws_event(const ws_event_t *ev)
{
    switch (ev->kind) {
    case WS_EVT_INFO:
        sync_time_from_server();
        s_dirty = 1;
        break;
    case WS_EVT_SUB: {
        /* 服务器发帧领先声音约 2 秒（缓冲），字幕消息也是提前到的——
         * 先记下「收到时已入队帧数」，等对应首帧真的播出去再显示（主循环里处理） */
        int pushed = 0;
        audio_play_stats(&pushed, NULL);
        subq_push(ev->text, pushed, ev->frames);
        break;
    }
    case WS_EVT_STT:
        s_dirty = 1;
        break;
    case WS_EVT_PAGE: {
        /* UI 的页面状态是唯一真相，切页必须走 ui_set_page() */
        ui_page_t p = strcmp(ev->name, "func") == 0 ? UI_PAGE_FUNC : UI_PAGE_HOME;
        ui_set_page(p);
        if (p == UI_PAGE_FUNC)
            s_func_since = (int)(xTaskGetTickCount() * portTICK_PERIOD_MS);
        s_dirty = 1;
        break;
    }
    case WS_EVT_CONNECTED:
        s_dirty = 1;
        break;
    case WS_EVT_TTS_START:
        audio_play_reset();
        subq_clear();
        sub_cur_clear();
        s_sub_clear_at = 0;
        ui_set_sub("");
        if (s_voice_state != VOICE_REC) voice_to(VOICE_SPEAK);
        s_dirty = 1;
        break;
    case WS_EVT_TTS_STOP:
        audio_play_finish();
        break;
    case WS_EVT_ERROR:
        ESP_LOGW(TAG, "服务器错误: %s", ev->text);
        sub_cur_clear();
        ui_set_sub(ev->text);
        s_dirty = 1;
        break;
    case WS_EVT_DISCONNECTED:
        audio_play_stop();
        audio_rec_stop();
        subq_clear();
        sub_cur_clear();
        ui_set_sub("");
        s_sub_clear_at = 0;
        s_key_down_at = -1;
        if (s_voice_state != VOICE_IDLE) voice_to(VOICE_IDLE);
        s_dirty = 1;
        break;
    default:
        break;
    }
}

/* ── 按键 → 页面 ───────────────────────────────────────────────────── */

static void on_button(btn_id_t id, btn_event_t ev)
{
    /* 诊断日志：每个按键事件都打一行（含按下/松开，看长按短按） */
    ESP_LOGI(TAG, "btn %s %s", id == BTN_KEY ? "KEY" : "BOOT",
             ev == BTN_DOWN ? "down" : (ev == BTN_CLICK ? "click" : "up"));

    if (id == BTN_KEY) {
        if (ev == BTN_DOWN) {
            s_key_down_at = now_ms();
            s_key_voice = 0;
        } else if (ev == BTN_UP) {
            /* 长按录音：松手结束（事件顺序：短按先 CLICK 再 UP）；
             * 松手时没检测到有效说话 → 静默收尾（不发录音、不说"没听清"） */
            if (s_voice_state == VOICE_REC) {
                if (audio_rec_heard_speech()) {
                    voice_stop_rec();
                } else {
                    ESP_LOGI(TAG, "松开 KEY 但没检测到说话 → 静默收尾");
                    voice_rec_void();
                }
            }
            s_key_down_at = -1;
        } else {                                        /* BTN_CLICK：短按翻页 */
            if (s_voice_state != VOICE_IDLE) return;    /* 语音中不翻页 */
            ui_page_t p = (ui_get_page() == UI_PAGE_HOME) ? UI_PAGE_FUNC : UI_PAGE_HOME;
            ui_set_page(p);
            if (p == UI_PAGE_FUNC)
                s_func_since = now_ms();
            s_dirty = 1;

            char msg[48];
            snprintf(msg, sizeof(msg), "{\"t\":\"btn\",\"k\":\"key\",\"e\":\"click\"}");
            ws_send_json(msg);
            ESP_LOGI(TAG, "KEY → %s", p == UI_PAGE_HOME ? "home" : "func");
        }
    } else {                                            /* BOOT：短按=音量循环（增大→顶档静音→循环） */
        if (ev == BTN_CLICK)
            audio_volume_cycle();
    }
}

/* ── 主循环 ────────────────────────────────────────────────────────── */

static void main_loop(void)
{
    /* 开机即空闲态，但 s_voice_state 是静态初始化成 IDLE 的、没走过 voice_to()，
     * 而唤醒使能只在 voice_to() 里打开——这里补一次，否则开机后首次语音唤醒
     * 不生效（要等一轮 KEY 对话结束回到 IDLE 后才被顺带打开）。 */
    voice_to(VOICE_IDLE);

    TickType_t last = xTaskGetTickCount();
    for (;;) {
        uint32_t now = (uint32_t)(xTaskGetTickCount() * portTICK_PERIOD_MS);

        /* 功能页 5 秒后自动回主页 */
        if (ui_get_page() == UI_PAGE_FUNC && s_func_since &&
            now - (uint32_t)s_func_since > 5000) {
            ui_set_page(UI_PAGE_HOME);
            s_dirty = 1;
            ESP_LOGI(TAG, "功能页超时 → home");
        }

        /* KEY 长按 350ms → 开始录音（短按翻页不受影响）；
         * 说话/思考中长按 = 用户优先：打断当前回答，直接开始新提问 */
        if (s_key_down_at >= 0 && !s_key_voice && s_voice_state != VOICE_REC &&
            now - (uint32_t)s_key_down_at >= 350) {
            s_key_voice = 1;
            if (s_voice_state == VOICE_SPEAK || s_voice_state == VOICE_THINK) {
                ESP_LOGI(TAG, "用户打断（%s）→ 开始新录音",
                         s_voice_state == VOICE_SPEAK ? "说话中" : "思考中");
                voice_interrupt();
            }
            voice_start_rec();
        }

        /* 语音唤醒（模型"小宇同学"，喊"小鱼同学"）：
         *   - 空闲命中 → 本地应答"我在" → 应答完自动聆听
         *   - 播报中命中 → 用户优先：打断当前回答，直接进入聆听（不用按 KEY） */
        if (wake_take_hit()) {
            if (s_wake_greet) {
                /* 应答播放期间的误触发：消费掉即可（播放完照常进入聆听） */
            } else if (s_voice_state == VOICE_IDLE) {
                audio_play_greeting();
                s_wake_greet = 1;
                s_sub_clear_at = 0;
                subq_clear();
                sub_cur_clear();
                ui_set_sub("");
                voice_to(VOICE_SPEAK);
                ESP_LOGI(TAG, "唤醒词触发 → 应答后聆听");
            } else if (s_voice_state == VOICE_SPEAK) {
                ESP_LOGI(TAG, "播报中听到唤醒词 → 打断（说新事=作废旧回答，没说=续播）");
                voice_interrupt();
                voice_start_rec_auto(1);
            }
            /* 录音/思考中唤醒未使能，理论上到不了这里 */
        }

        /* 播放结束 → 回空闲（字幕保留 4 秒）；唤醒应答播完则直接开录 */
        if (s_voice_state == VOICE_SPEAK && audio_play_finished()) {
            if (s_wake_greet) {
                s_wake_greet = 0;
                voice_start_rec_auto(0);
            } else {
                s_sub_clear_at = now_ms() + 4000;
                voice_to(VOICE_IDLE);
            }
        }

        /* 自动聆听：VAD 判说完/没说话/超时 → 有效说话才走提问流程；
         * 只有杂音/尾音碎片（或压根没说）→ 本地静默收尾，不送 ASR */
        if (s_voice_state == VOICE_REC) {
            int vs = audio_rec_vad_stop();
            if (vs == 3 || (vs == 1 && audio_rec_heard_speech())) {
                ESP_LOGI(TAG, "自动聆听结束（%s）", vs == 3 ? "超时" : "说完");
                voice_stop_rec();
            } else if (vs == 1) {
                ESP_LOGI(TAG, "自动聆听结束（说完但没听到有效说话）→ 静默收尾");
                voice_rec_void();
            } else if (vs == 2) {
                ESP_LOGI(TAG, "自动聆听结束（没说话）→ 静默收尾");
                voice_rec_void();
            }
        }

        /* 字幕：等对应句子的首帧真正播出去再显示（对齐声音）；
         * 长句超过一页（24 字）时按播放进度翻页，保证整句都看得到 */
        {
            int pushed = 0, played = 0;
            audio_play_stats(&pushed, &played);
            while (s_subq_head != s_subq_tail && played > s_subq[s_subq_head].at_frame) {
                sub_item_t *it = &s_subq[s_subq_head];
                snprintf(s_sub_cur, sizeof(s_sub_cur), "%s", it->text);
                s_sub_cur_at     = it->at_frame;
                s_sub_cur_frames = it->n_frames;
                s_sub_cur_page   = 0;
                ui_set_sub(s_sub_cur);
                s_dirty = 1;
                s_subq_head = (s_subq_head + 1) % SUBQ_MAX;
            }
            if (s_sub_cur[0] && s_sub_cur_frames > 0) {
                int pages = ui_sub_pages(s_sub_cur);
                if (pages > 1) {
                    /* 翻页滞后：TTS 句首有静音、句尾略慢，纯按比例翻会早几个字。
                     * 10% 余量实测仍偏快 → 加到 12.5%，长句最多滞后 18 帧（约 1.1 秒） */
                    int lag = s_sub_cur_frames / 8;
                    if (lag < 4) lag = 4;
                    if (lag > 18) lag = 18;
                    int prog = played - s_sub_cur_at - lag;
                    if (prog < 0) prog = 0;
                    if (prog > s_sub_cur_frames) prog = s_sub_cur_frames;
                    int page = (int)((long long)prog * pages / s_sub_cur_frames);
                    if (page >= pages) page = pages - 1;
                    if (page != s_sub_cur_page) {
                        s_sub_cur_page = page;
                        ui_set_sub_page(s_sub_cur, page);
                        s_dirty = 1;
                    }
                }
            }
            /* 诊断：说话中每 5 秒一行播放统计（纯 ASCII，抓包可直接分析） */
            static uint32_t s_play_log_at = 0;
            if (s_voice_state == VOICE_SPEAK && now - s_play_log_at > 5000) {
                s_play_log_at = now;
                ESP_LOGI(TAG, "play: pushed=%d played=%d inflight=%d",
                         pushed, played, pushed - played);
            }
        }

        /* 等服务器超时保护 */
        if (s_voice_state == VOICE_THINK && s_voice_deadline &&
            now > (uint32_t)s_voice_deadline) {
            ESP_LOGW(TAG, "等服务器超时，回空闲");
            voice_to(VOICE_IDLE);
        }

        /* 字幕延迟清除 */
        if (s_sub_clear_at && now >= (uint32_t)s_sub_clear_at) {
            s_sub_clear_at = 0;
            sub_cur_clear();
            ui_set_sub("");
            s_dirty = 1;
        }

        /* 每秒重绘一次（时钟走字）；脏标记或桌宠换帧时立即重绘 */
        int pet_changed = ui_tick(now);
        TickType_t nowT = xTaskGetTickCount();
        if (s_dirty || pet_changed || (nowT - last) >= pdMS_TO_TICKS(1000)) {
            ui_render();
            s_dirty = 0;
            last = nowT;
        }

        vTaskDelay(pdMS_TO_TICKS(50));
    }
}

/** 服务器下行的 Opus 帧 → 播放队列 */
static void on_ws_audio(const uint8_t *data, size_t len)
{
    /* 录音/思考阶段属于新的语音回合：此时到达的都是上一轮回答的迟到帧
     * （用户打断场景），直接丢弃，避免旧声音盖在新录音上 */
    if (s_voice_state == VOICE_REC || s_voice_state == VOICE_THINK) return;
    audio_play_push(data, len);
}

/** 连上 WiFi 后的正常启动：WebSocket + 按键 + 主循环（不返回） */
static void boot_online(const wifi_cfg_t *cfg)
{
    ws_client_set_handler(on_ws_event);
    ws_client_set_bin_handler(on_ws_audio);
    ESP_ERROR_CHECK(ws_client_start(cfg->host, cfg->token));
    buttons_init(on_button);
    ESP_LOGI(TAG, "启动完成（服务器 %s）", cfg->host);
    main_loop();
}

void app_main(void)
{
    /* NVS：WiFi / 服务器配置存在这里（配网页写入） */
    esp_err_t ne = nvs_flash_init();
    if (ne == ESP_ERR_NVS_NO_FREE_PAGES || ne == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ESP_ERROR_CHECK(nvs_flash_init());
    }

    /* 开机长按 KEY 3 秒 → 强制进配网（放最前面，一上电就能按） */
    bool force_portal = wifi_portal_key_held();

    sensors_init();
    ESP_LOGI(TAG, "电池 %d mV / %d%%", sensors_battery_mv(), sensors_battery_pct());
    pcf85063_init();
    ui_init();
    ui_render();

    if (audio_init() != ESP_OK) {
        ESP_LOGE(TAG, "音频初始化失败（语音对话不可用）");
    } else if (wake_init() != 0) {
        ESP_LOGW(TAG, "语音唤醒不可用（其余功能正常）");
    }

    ESP_LOGI(TAG, "MyEsp32 %s 启动", MYESP32_FW);

    /* 配置：NVS（配网页保存）优先，其次编译期默认（CI Secrets / menuconfig） */
    static wifi_cfg_t cfg;
    wifi_cfg_load(&cfg);

    bool sta_running = false;
    if (!force_portal && cfg.ssid[0]) {
        ESP_ERROR_CHECK(wifi_sta_start(cfg.ssid, cfg.pass));
        sta_running = true;
        if (wifi_sta_wait(20000) == ESP_OK) {
            char ip[20];
            wifi_sta_ip(ip, sizeof(ip));
            ESP_LOGI(TAG, "WiFi 已连接（%s），IP %s", cfg.ssid, ip);
            boot_online(&cfg);                      /* 不返回 */
        }
        ESP_LOGW(TAG, "20 秒没连上 %s → 进配网模式", cfg.ssid);
    } else if (force_portal) {
        ESP_LOGW(TAG, "开机长按 KEY → 进配网模式");
    } else {
        ESP_LOGW(TAG, "还没有 WiFi 配置 → 进配网模式");
    }

    /* ── 配网模式：手机连热点后，浏览器打开 192.168.4.1 ── */
    char ap[24];
    wifi_portal_ap_name(ap, sizeof(ap));
    ui_show_portal(ap);
    ui_render();
    wifi_portal_run(sta_running);                   /* 保存 / 连上后自动重启 */
}
