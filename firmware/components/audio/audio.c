/**
 * audio.c — 音频链路：ES8311（喇叭）+ ES7210（麦克风）+ I2S + Opus
 *
 * 硬件配置对齐厂家已验证过的方案（10_FactoryProgram / 07_Audio_Test）：
 *   - I2S 先按 TDM（4 槽）建通道；esp_codec_dev 以 {16000, 2, 16} 打开编解码器时，
 *     会把通道重配成「2 槽 × 16bit」，与播放帧一致（全双工共用时钟）。
 *   - 麦克风 ES7210 选 MIC1|MIC2（普通 I2S：L=MIC1，R=MIC2），16bit。
 *     若能正常听到回声说明接线如此；若无声把 mic_selected 换成 MIC1|MIC3 再试。
 *   - 喇叭 ES8311 走 DAC，PA 使能在 AUD_PA_PIN（GPIO46）。
 *
 * 上行：麦克风 20ms×3 → 下混单声道 960 采样 → Opus 编码（60ms/帧）→ ws_send_audio()
 * 下行：ws 二进制帧 → 队列 → 播放任务解码 → 复制双声道 → 写 I2S
 *
 * BOOT 按住 = 麦克风直通喇叭（本地自检，不经过网络）。
 */

#include "audio.h"
#include <string.h>
#include <math.h>
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "driver/i2s_std.h"
#include "driver/i2s_tdm.h"
#include "esp_codec_dev.h"
#include "esp_codec_dev_defaults.h"
#include "es8311_codec.h"
#include "es7210_adc.h"
#include "opus.h"
#include "hw_config.h"
#include "sensors.h"
#include "ws_client.h"

static const char *TAG = "audio";

#define FRAME_SAMPLES   960          /* 60ms @16kHz（与服务器约定一致） */
#define READ_CHUNK      320          /* 每次读 20ms（单声道采样数） */
#define MAX_OPUS_FRAME  400          /* 单帧 opus 上限（字节） */

static esp_codec_dev_handle_t s_play = NULL;
static esp_codec_dev_handle_t s_rec  = NULL;
static i2s_chan_handle_t      s_tx   = NULL;
static i2s_chan_handle_t      s_rx   = NULL;
static volatile int           s_ready = 0;

/* ── 上行 ───────────────────────────────────────────────────────────── */

static volatile int s_rec_on    = 0;
static volatile int s_enc_reset = 0;
static volatile int s_echo_on   = 0;

/* ── 下行 ───────────────────────────────────────────────────────────── */

#define PLAYQ_SLOTS  96
typedef struct {
    uint16_t len;
    uint8_t  data[MAX_OPUS_FRAME];
} play_frame_t;

static QueueHandle_t  s_playq = NULL;
static StaticQueue_t  s_playq_static;
static volatile int   s_play_finishing = 0;   /* tts_stop 已到 */
static volatile int   s_play_done      = 0;   /* 队列播完（main 读一次清） */
static volatile int   s_playing        = 0;

/* ── 麦克风任务（录音 / 直通自检）────────────────────────────────────── */

static void mic_task(void *arg)
{
    OpusEncoder *enc = NULL;
    static int16_t in[READ_CHUNK * 2];       /* 20ms 立体声 */
    static int16_t mono[FRAME_SAMPLES];
    static uint8_t enc_buf[MAX_OPUS_FRAME];
    int fill = 0;
    int frames = 0;

    for (;;) {
        /* 自检模式：麦克风 → 喇叭（BOOT 按住） */
        if (s_echo_on) {
            static int echo_n = 0;
            if (esp_codec_dev_read(s_rec, in, sizeof(in)) == ESP_CODEC_DEV_OK) {
                esp_codec_dev_write(s_play, in, sizeof(in));
                if (++echo_n % 100 == 0) {           /* 每 2 秒打一次电平，便于诊断 */
                    long acc = 0;
                    for (int i = 0; i < READ_CHUNK * 2; i++) acc += (long)in[i] * in[i];
                    ESP_LOGI(TAG, "自检麦克风电平 RMS=%.0f", sqrtf((float)acc / (READ_CHUNK * 2)));
                }
            }
            continue;
        }

        if (!s_rec_on) {
            fill = 0;
            vTaskDelay(pdMS_TO_TICKS(20));
            continue;
        }

        /* 懒创建编码器（首次录音时） */
        if (!enc) {
            int err = 0;
            enc = opus_encoder_create(AUD_SAMPLE_HZ, 1, OPUS_APPLICATION_VOIP, &err);
            if (!enc || err != OPUS_OK) {
                ESP_LOGE(TAG, "opus 编码器创建失败: %d", err);
                enc = NULL;
                s_rec_on = 0;
                continue;
            }
            opus_encoder_ctl(enc, OPUS_SET_BITRATE(24000));
            opus_encoder_ctl(enc, OPUS_SET_COMPLEXITY(3));
        }
        if (s_enc_reset) {
            opus_encoder_ctl(enc, OPUS_RESET_STATE);
            s_enc_reset = 0;
            frames = 0;
        }

        if (esp_codec_dev_read(s_rec, in, sizeof(in)) != ESP_CODEC_DEV_OK) {
            vTaskDelay(pdMS_TO_TICKS(5));
            continue;
        }

        /* 下混：mono = (L + R) / 2 */
        for (int i = 0; i < READ_CHUNK; i++)
            mono[fill + i] = (int16_t)(((int)in[i * 2] + (int)in[i * 2 + 1]) / 2);
        fill += READ_CHUNK;

        if (fill >= FRAME_SAMPLES) {
            int n = opus_encode(enc, mono, FRAME_SAMPLES, enc_buf, sizeof(enc_buf));
            if (n > 0) {
                ws_send_audio(enc_buf, (size_t)n);
                if (++frames == 1 || frames % 50 == 0) {
                    long acc = 0;
                    for (int i = 0; i < FRAME_SAMPLES; i++) acc += (long)mono[i] * mono[i];
                    ESP_LOGI(TAG, "上行第 %d 帧: %d 字节, 电平 RMS=%.0f",
                             frames, n, sqrtf((float)acc / FRAME_SAMPLES));
                }
            } else {
                ESP_LOGW(TAG, "opus_encode 返回 %d", n);
            }
            fill = 0;
        }
    }
}

/* ── 播放任务（解码 TTS）────────────────────────────────────────────── */

static void play_task(void *arg)
{
    static int16_t pcm[FRAME_SAMPLES];
    static int16_t st[FRAME_SAMPLES * 2];    /* 单声道复制成双声道 */
    play_frame_t f;

    int err = 0;
    OpusDecoder *dec = opus_decoder_create(AUD_SAMPLE_HZ, 1, &err);
    if (!dec || err != OPUS_OK) {
        ESP_LOGE(TAG, "opus 解码器创建失败: %d", err);
        vTaskDelete(NULL);
        return;
    }

    for (;;) {
        if (!s_playing) {
            if (xQueueReceive(s_playq, &f, pdMS_TO_TICKS(100)) != pdTRUE) {
                if (s_play_finishing) { s_play_finishing = 0; s_play_done = 1; }
                continue;
            }
            s_playing = 1;
        } else if (xQueueReceive(s_playq, &f, 0) != pdTRUE) {
            if (s_play_finishing) {
                s_playing = 0;
                s_play_finishing = 0;
                s_play_done = 1;             /* 队列播完 → 通知 main 回空闲 */
            } else {
                vTaskDelay(pdMS_TO_TICKS(5)); /* 等下一帧（网络抖动） */
            }
            continue;
        }

        int n = opus_decode(dec, f.data, f.len, pcm, FRAME_SAMPLES, 0);
        if (n > 0) {
            for (int i = 0; i < n; i++) { st[i * 2] = pcm[i]; st[i * 2 + 1] = pcm[i]; }
            esp_codec_dev_write(s_play, st, n * 4);
        } else if (n < 0) {
            ESP_LOGW(TAG, "opus 解码失败: %d", n);
        }
    }
}

/* ── 对外接口 ───────────────────────────────────────────────────────── */

int audio_ready(void) { return s_ready; }

void audio_rec_start(void) { s_enc_reset = 1; s_rec_on = 1; }
void audio_rec_stop(void)  { s_rec_on = 0; }
int  audio_rec_active(void) { return s_rec_on; }

void audio_play_reset(void)
{
    if (!s_ready) return;
    s_play_finishing = 0;
    s_play_done = 0;
    xQueueReset(s_playq);
}

void audio_play_push(const uint8_t *opus, size_t len)
{
    if (!s_ready || !s_playq || len == 0 || len > MAX_OPUS_FRAME) return;
    play_frame_t f;
    f.len = (uint16_t)len;
    memcpy(f.data, opus, len);
    if (xQueueSend(s_playq, &f, 0) != pdTRUE)
        ESP_LOGW(TAG, "播放队列满，丢帧");
}

void audio_play_finish(void) { if (s_ready) s_play_finishing = 1; }

void audio_play_stop(void)
{
    if (!s_ready) return;
    xQueueReset(s_playq);
    s_play_finishing = 1;
    s_playing = 1;              /* 让播放任务尽快走「空 + finishing」分支收敛 */
}

int audio_play_finished(void)
{
    int d = s_play_done;
    if (d) s_play_done = 0;
    return d;
}

void audio_echo_set(int on)
{
    if (!s_ready) return;
    if (on && s_rec_on) return;          /* 录音中不做直通 */
    s_echo_on = on ? 1 : 0;
}
int audio_echo_active(void) { return s_echo_on; }

void audio_set_volume(int vol)
{
    if (s_play) esp_codec_dev_set_out_vol(s_play, vol);
}

/* ── 初始化 ─────────────────────────────────────────────────────────── */

esp_err_t audio_init(void)
{
    esp_err_t ret;

    /* 1) I2S：厂家同款 TDM 初始化（打开编解码器时会被重配为 2 槽 × 16bit） */
    i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_AUTO, I2S_ROLE_MASTER);
    chan_cfg.auto_clear = true;
    ret = i2s_new_channel(&chan_cfg, &s_tx, &s_rx);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "i2s_new_channel 失败: %s", esp_err_to_name(ret));
        return ret;
    }

    i2s_tdm_slot_mask_t slot_mask = I2S_TDM_SLOT0 | I2S_TDM_SLOT1 | I2S_TDM_SLOT2 | I2S_TDM_SLOT3;
    i2s_tdm_config_t tdm_cfg = {
        .clk_cfg  = I2S_TDM_CLK_DEFAULT_CONFIG(AUD_SAMPLE_HZ),
        .slot_cfg = I2S_TDM_PHILIPS_SLOT_DEFAULT_CONFIG(32, I2S_SLOT_MODE_STEREO, slot_mask),
        .gpio_cfg = {
            .mclk = AUD_I2S_MCLK,
            .bclk = AUD_I2S_BCLK,
            .ws   = AUD_I2S_WS,
            .dout = AUD_I2S_DOUT,
            .din  = AUD_I2S_DIN,
        },
    };
    tdm_cfg.slot_cfg.total_slot = 4;

    if ((ret = i2s_channel_init_tdm_mode(s_tx, &tdm_cfg)) != ESP_OK ||
        (ret = i2s_channel_init_tdm_mode(s_rx, &tdm_cfg)) != ESP_OK) {
        ESP_LOGE(TAG, "I2S TDM 初始化失败: %s", esp_err_to_name(ret));
        return ret;
    }
    i2s_channel_enable(s_tx);
    i2s_channel_enable(s_rx);

    /* 2) I2C 控制接口：复用传感器总线（不新建总线，避免抢占） */
    audio_codec_i2c_cfg_t i2c_out = { .port = 0, .addr = 0x30, .bus_handle = sensors_i2c_bus() }; /* ES8311: 7bit 0x18<<1 */
    audio_codec_i2c_cfg_t i2c_in  = { .port = 0, .addr = 0x80, .bus_handle = sensors_i2c_bus() }; /* ES7210: 7bit 0x40<<1 */
    const audio_codec_ctrl_if_t *ctrl_out = audio_codec_new_i2c_ctrl(&i2c_out);
    const audio_codec_ctrl_if_t *ctrl_in  = audio_codec_new_i2c_ctrl(&i2c_in);
    const audio_codec_gpio_if_t *gpio_if  = audio_codec_new_gpio();
    if (!ctrl_out || !ctrl_in || !gpio_if) {
        ESP_LOGE(TAG, "I2C 控制接口/GPIO 接口创建失败");
        return ESP_FAIL;
    }

    /* 3) I2S 数据接口（注入已建好的通道） */
    audio_codec_i2s_cfg_t i2s_cfg = { .port = 0, .rx_handle = s_rx, .tx_handle = s_tx };
    const audio_codec_data_if_t *data_if = audio_codec_new_i2s_data(&i2s_cfg);
    if (!data_if) {
        ESP_LOGE(TAG, "I2S 数据接口创建失败");
        return ESP_FAIL;
    }

    /* 4) 编解码器：ES8311（DAC + PA）+ ES7210（MIC1|MIC2） */
    es8311_codec_cfg_t es8311_cfg = {
        .ctrl_if = ctrl_out,
        .gpio_if = gpio_if,
        .codec_mode = ESP_CODEC_DEV_WORK_MODE_DAC,
        .pa_pin = AUD_PA_PIN,
        .pa_reverted = false,
        .master_mode = false,
        .use_mclk = true,
        .digital_mic = false,
        .invert_mclk = false,
        .invert_sclk = false,
        .hw_gain = { .pa_gain = 6.0f },
        .no_dac_ref = false,
        .mclk_div = 0,
    };
    const audio_codec_if_t *codec_out = es8311_codec_new(&es8311_cfg);

    es7210_codec_cfg_t es7210_cfg = {
        .ctrl_if = ctrl_in,
        .master_mode = false,
        .mic_selected = ES7210_SEL_MIC1 | ES7210_SEL_MIC2,
        .mclk_src = ES7210_MCLK_FROM_PAD,
        .mclk_div = 0,
    };
    const audio_codec_if_t *codec_in = es7210_codec_new(&es7210_cfg);
    if (!codec_out || !codec_in) {
        ESP_LOGE(TAG, "编解码器创建失败");
        return ESP_FAIL;
    }

    esp_codec_dev_cfg_t out_cfg = { .dev_type = ESP_CODEC_DEV_TYPE_OUT, .codec_if = codec_out, .data_if = data_if };
    esp_codec_dev_cfg_t in_cfg  = { .dev_type = ESP_CODEC_DEV_TYPE_IN,  .codec_if = codec_in,  .data_if = data_if };
    s_play = esp_codec_dev_new(&out_cfg);
    s_rec  = esp_codec_dev_new(&in_cfg);
    if (!s_play || !s_rec) {
        ESP_LOGE(TAG, "esp_codec_dev 创建失败");
        return ESP_FAIL;
    }

    esp_codec_dev_sample_info_t fs = {
        .bits_per_sample = 16,
        .channel = 2,
        .sample_rate = AUD_SAMPLE_HZ,
    };
    int r1 = esp_codec_dev_open(s_play, &fs);
    int r2 = esp_codec_dev_open(s_rec, &fs);
    if (r1 != ESP_CODEC_DEV_OK || r2 != ESP_CODEC_DEV_OK) {
        ESP_LOGE(TAG, "编解码器打开失败: play=%d rec=%d", r1, r2);
        return ESP_FAIL;
    }
    esp_codec_dev_set_out_vol(s_play, 85);
    esp_codec_dev_set_in_gain(s_rec, 32.0f);

    /* 5) 播放队列（优先放 PSRAM，失败退回内部 RAM）+ 两个任务 */
    uint8_t *qmem = heap_caps_malloc(PLAYQ_SLOTS * sizeof(play_frame_t), MALLOC_CAP_SPIRAM);
    if (qmem)
        s_playq = xQueueCreateStatic(PLAYQ_SLOTS, sizeof(play_frame_t), qmem, &s_playq_static);
    else
        s_playq = xQueueCreate(PLAYQ_SLOTS, sizeof(play_frame_t));
    if (!s_playq) {
        ESP_LOGE(TAG, "播放队列创建失败");
        return ESP_FAIL;
    }

    /* 栈必须给足：esp-opus 以 -DUSE_ALLOCA 编译，opus_encode/opus_decode 的临时
     * 缓冲全部走任务栈 —— 实测 6KB 第一帧编码就栈溢出（串口：
     * "***ERROR*** A stack overflow in task audio_mic"，随后崩溃重启）。
     * 编码峰值约 30KB，这里给 40KB；解码路径给 16KB。 */
    if (xTaskCreatePinnedToCore(mic_task,  "audio_mic",  40960, NULL, 5, NULL, 1) != pdPASS ||
        xTaskCreatePinnedToCore(play_task, "audio_play", 16384, NULL, 5, NULL, 1) != pdPASS) {
        ESP_LOGE(TAG, "音频任务创建失败（内存不足？）");
        return ESP_FAIL;
    }

    s_ready = 1;
    ESP_LOGI(TAG, "音频就绪：ES8311+ES7210 @%dHz（麦克风 MIC1|MIC2，PA=GPIO%d），内部空闲堆 %u B",
             AUD_SAMPLE_HZ, AUD_PA_PIN, (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
    return ESP_OK;
}
