/**
 * audio.c — 音频链路：ES8311（喇叭）+ ES7210（麦克风）+ I2S + Opus
 *
 * 硬件配置对齐厂家已验证过的方案（10_FactoryProgram / 07_Audio_Test）：
 *   - I2S 先按 TDM（4 槽）建通道；esp_codec_dev 以 {16000, 2, 16} 打开编解码器时，
 *     会把通道重配成「2 槽 × 16bit」，与播放帧一致（全双工共用时钟）。
 *   - 麦克风 ES7210 四路全选（与出厂程序一致）。mic 数 ≥3 时驱动把芯片切到
 *     TDM 输出（REG12=0x02）；2 通道读取时每帧 2 个 16bit 字。
 *     串口实测：每个 16bit 字 = 一路麦克风样点（偶=麦A、奇=麦B 交织），
 *     幅度小（空载 ±12、近距离说话 ±300~1500）。直接按 16bit 用 + 数字增益：
 *     上行取偶数字 ×8（录音和喂唤醒词共用）。
 *     （教训：16bit 字不能拆成两个 8bit 用 —— 低 8bit 是样点取模 256 的锯齿，
 *      放大后就是电流音；实时直通只要增益超过回授阈值就自激啸叫。）
 *   - 喇叭 ES8311 走 DAC，PA 使能在 AUD_PA_PIN（GPIO46）。
 *
 * 上行：麦克风 20ms×3 → 解包单声道 960 采样 → Opus 编码（60ms/帧）→ ws_send_audio()
 * 下行：ws 二进制帧 → 队列 → 播放任务解码 → 复制双声道 → 写 I2S
 *
 * BOOT 短按 = 音量循环（增大→顶档静音→再循环，带提示音）。
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
#include "wake.h"

static const char *TAG = "audio";

#define FRAME_SAMPLES   960          /* 60ms @16kHz（与服务器约定一致） */
#define READ_CHUNK      320          /* 每次读 20ms（单声道采样数） */
#define MAX_OPUS_FRAME  400          /* 单帧 opus 上限（字节） */

/* 任务栈字节数（换算成 FreeRTOS 的「字」再传，见 audio_init） */
#define MIC_STACK_BYTES   40960      /* opus_encode 用 alloca，峰值约 30KB */
#define PLAY_STACK_BYTES  16384      /* opus_decode + 提示音合成 */

static esp_codec_dev_handle_t s_play = NULL;
static esp_codec_dev_handle_t s_rec  = NULL;
static i2s_chan_handle_t      s_tx   = NULL;
static i2s_chan_handle_t      s_rx   = NULL;
static volatile int           s_ready = 0;

/* ── 上行 ───────────────────────────────────────────────────────────── */

static volatile int s_rec_on    = 0;
static volatile int s_enc_reset = 0;

/* ── 下行 ───────────────────────────────────────────────────────────── */

#define PLAYQ_SLOTS  160         /* ≈9.6 秒缓冲：设备端偶发卡顿 1 秒也不至于撑爆丢帧 */
typedef struct {
    uint16_t len;
    uint8_t  data[MAX_OPUS_FRAME];
} play_frame_t;

static QueueHandle_t  s_playq = NULL;
static StaticQueue_t  s_playq_static;
static volatile int   s_play_finishing = 0;   /* tts_stop 已到 */
static volatile int   s_play_done      = 0;   /* 队列播完（main 读一次清） */
static volatile int   s_playing        = 0;
static volatile int   s_stream_open    = 0;   /* tts_start 后开闸；结束后丢迟到帧 */
static volatile int   s_stream_act_ms  = 0;   /* 最近一次帧活动时刻（看门狗用） */
static volatile int   s_frames_pushed  = 0;   /* 已入队帧数（字幕同步，tts_start 清零） */
static volatile int   s_frames_played  = 0;   /* 已播帧数（字幕同步） */
static volatile int   s_beep_req       = 0;   /* 音量反馈音请求（播放任务消费） */
static volatile int   s_chime_req      = 0;   /* 唤醒提示音请求（播放任务消费） */
static volatile int   s_alarm_req      = 0;   /* 闹钟提示音请求 */

/* 播放流沉默超时：tts_start 后 15 秒既没有帧流入、也没有声音在放
 * （服务器句子合成超时 12 秒；正常到不了）→ 判本轮结束并复位，
 * 防止服务器中途没了 tts_stop 时主状态机永远停在"说话中"。 */
#define PLAY_WATCHDOG_MS 15000

/* ── 自动聆听（唤醒流程）：静音检测自动结束录音 ─────────────────────── */

#define VAD_SPEECH_RMS   450     /* 说话判定门槛的下限（实际门槛见 vad_threshold()） */
#define VAD_SIL_FRAMES   22      /* 说完后连续安静 22×60ms ≈1.3 秒 → 结束 */
#define VAD_NOSPEECH_MS  6000    /* 一直没说话 6 秒 → 放弃 */
#define VAD_MAX_MS       15000   /* 总时长上限 15 秒 */

/* "有效说话"门槛：超过 VAD_SPEECH_RMS 的帧数 ≥3（180ms）才算用户真说了话；
 * 只闪 1~2 帧（咳嗽、桌椅声、唤醒词尾音）会被当"没说话"本地静默丢弃，不送 ASR */
#define VAD_MIN_VOICED   3

/* 环境底噪跟踪：只在空闲时更新（main 通过 audio_env_track 控制），录音时冻结。
 * 空调/风扇/音乐这类持续噪声会一直高于固定门槛 600，以前会被当成"一直在说话"，
 * 录音拖到 15 秒上限。这里用"快降慢升"估底噪，判定门槛 = 底噪×2.5（最低 450）。 */
#define NOISE_MIN        80.0f
#define NOISE_MAX        3000.0f
static float        s_noise = 150.0f;
static volatile int s_env_track = 0;

void audio_env_track(int on) { s_env_track = on ? 1 : 0; }

static float vad_threshold(void)
{
    float t = s_noise * 2.5f;
    if (t < (float)VAD_SPEECH_RMS) t = (float)VAD_SPEECH_RMS;
    if (t > 6000.0f) t = 6000.0f;
    return t;
}

/* 播报中打断进入的录音：开头几帧永远是喇叭尾音/房间混响（实测帧 1 电平
 * 达 6000~13000），从第 5 帧（300ms）起才计有效说话，防"尾音当指令" */
#define VAD_SKIP_BARGEIN 5
/* KEY 按下瞬间也带 1 帧功放尾音 */
#define VAD_SKIP_KEY     1

static volatile int s_rec_auto    = 0;   /* 唤醒流程的自动录音 */
static volatile int s_vad_stop    = 0;   /* 0=继续 1=说完 2=没说话 3=超时 */
static int          s_vad_spoke   = 0;   /* 本段录音里已检测到说话 */
static int          s_vad_sil_run = 0;   /* 连续安静帧数 */
static volatile int s_rec_auto_at = 0;   /* 自动录音起始时刻（ms） */
static int          s_vad_frames  = 0;   /* 本段录音已处理帧数 */
static int          s_vad_voiced  = 0;   /* 有效语音帧数（"用户真说了话"的判据） */
static int          s_vad_skip    = 0;   /* 开头跳过的帧数（尾音污染），按录音来源设置 */

/* ── 麦克风任务（录音 / 喂唤醒词）──────────────────────────────────── */

/* 槽位诊断：把每个 16bit 字拆成高/低 8bit 观察分布。
 * 实测：偶/奇字都载有信号（麦A/麦B 样点交织），低字节为取模值、不可当音频用。 */
static void slot_rms(const int16_t *w, int words, float rms[4])
{
    long acc[4] = { 0 };
    int n = words / 2;
    for (int i = 0; i < n; i++) {
        int8_t v[4] = {
            (int8_t)(w[i * 2] >> 8),     (int8_t)(w[i * 2] & 0xFF),
            (int8_t)(w[i * 2 + 1] >> 8), (int8_t)(w[i * 2 + 1] & 0xFF),
        };
        for (int k = 0; k < 4; k++) acc[k] += (long)v[k] * v[k];
    }
    for (int k = 0; k < 4; k++) rms[k] = sqrtf((float)acc[k] / n);
}

static void mic_task(void *arg)
{
    OpusEncoder *enc = NULL;
    static int16_t in[READ_CHUNK * 2];       /* 20ms 原始数据（共 1280 字节） */
    static int16_t mono[FRAME_SAMPLES];
    static uint8_t enc_buf[MAX_OPUS_FRAME];
    int fill = 0;
    int frames = 0;

    for (;;) {
        if (!s_rec_on) {
            fill = 0;
            /* 空闲且唤醒开启时常读麦克风喂唤醒词（与上行走同一个麦，同样 ×8 增益） */
            if (wake_ready() && wake_enabled()) {
                if (esp_codec_dev_read(s_rec, in, sizeof(in)) == ESP_CODEC_DEV_OK) {
                    for (int i = 0; i < READ_CHUNK; i++) {
                        int32_t v = (int32_t)in[i * 2] * 8;
                        if (v > 32000) v = 32000;
                        else if (v < -32000) v = -32000;
                        mono[i] = (int16_t)v;
                    }
                    wake_feed(mono, READ_CHUNK);

                    /* 空闲时更新底噪（快降慢升）；播放/录音时不更新，免得把喇叭声当底噪 */
                    if (s_env_track) {
                        double acc = 0;
                        for (int i = 0; i < READ_CHUNK; i++) acc += (double)mono[i] * mono[i];
                        float rms = (float)sqrt(acc / READ_CHUNK);
                        if (rms < s_noise) s_noise = s_noise * 0.6f + rms * 0.4f;
                        else               s_noise = s_noise * 0.99f + rms * 0.01f;
                        if (s_noise < NOISE_MIN) s_noise = NOISE_MIN;
                        if (s_noise > NOISE_MAX) s_noise = NOISE_MAX;
                    }
                } else {
                    vTaskDelay(pdMS_TO_TICKS(5));
                }
                continue;
            }
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

        /* 偶数字 = 1 号麦克风 16bit 样点 → ×8 数字增益 → 单声道。
         * （实测大声时样点 ±1500+，×16 会削顶失真；×8 兼顾小音量。）
         * 槽位/原始样本诊断日志保留，供后续复核。 */
        for (int i = 0; i < READ_CHUNK; i++) {
            int32_t v = (int32_t)in[i * 2] * 8;
            if (v > 32000) v = 32000;
            else if (v < -32000) v = -32000;
            mono[fill + i] = (int16_t)v;
        }
        fill += READ_CHUNK;

        if (fill >= FRAME_SAMPLES) {
            int n = opus_encode(enc, mono, FRAME_SAMPLES, enc_buf, sizeof(enc_buf));
            if (n > 0) {
                ws_send_audio(enc_buf, (size_t)n);
                if (++frames == 1) {
                    float sr[4];
                    slot_rms(in, READ_CHUNK * 2, sr);
                    ESP_LOGI(TAG, "上行原始样本: %04X %04X %04X %04X",
                             (uint16_t)in[0], (uint16_t)in[1], (uint16_t)in[2], (uint16_t)in[3]);
                    ESP_LOGI(TAG, "上行槽位 m1=%.0f m2=%.0f m3=%.0f m4=%.0f",
                             sr[0], sr[1], sr[2], sr[3]);
                }
                double acc = 0;                       /* double 防 32bit 溢出 */
                for (int i = 0; i < FRAME_SAMPLES; i++) acc += (double)mono[i] * mono[i];
                float rms = (float)sqrt(acc / FRAME_SAMPLES);
                if (frames == 1 || frames % 10 == 0)
                    ESP_LOGI(TAG, "上行第 %d 帧: %d 字节, 电平 RMS=%.0f", frames, n, rms);

                /* 有效语音帧计数（所有录音共用；开头跳过的帧不算 —— 打断时的
                 * 喇叭尾音、KEY 瞬间的功放尾音都会被跳过） */
                if (s_rec_on) {
                    s_vad_frames++;
                    if (rms > vad_threshold() && s_vad_frames > s_vad_skip)
                        s_vad_voiced++;
                }

                /* 自动聆听：VAD 判"说完"（或一直没说话/超时）→ 由 main 收尾 */
                if (s_rec_auto && !s_vad_stop) {
                    int t = (int)(xTaskGetTickCount() * portTICK_PERIOD_MS);
                    int voiced = (rms > vad_threshold()) && s_vad_frames > s_vad_skip;
                    if (voiced) {
                        s_vad_spoke = 1;
                        s_vad_sil_run = 0;
                    } else if (s_vad_spoke && ++s_vad_sil_run >= VAD_SIL_FRAMES) {
                        s_vad_stop = 1;
                        ESP_LOGI(TAG, "自动聆听：安静 %.1f 秒 → 判说完", VAD_SIL_FRAMES * 0.06f);
                    } else if (!s_vad_spoke && t - s_rec_auto_at > VAD_NOSPEECH_MS) {
                        s_vad_stop = 2;
                        ESP_LOGW(TAG, "自动聆听：%d 秒没等到说话", VAD_NOSPEECH_MS / 1000);
                    }
                    if (!s_vad_stop && t - s_rec_auto_at > VAD_MAX_MS) {
                        s_vad_stop = 3;
                        ESP_LOGW(TAG, "自动聆听：超 %d 秒强制结束", VAD_MAX_MS / 1000);
                    }
                }
            } else {
                ESP_LOGW(TAG, "opus_encode 返回 %d", n);
            }
            fill = 0;
        }
    }
}

/* ── 播放任务（解码 TTS）────────────────────────────────────────────── */

/* 音量反馈音：880Hz 120ms，首尾淡入淡出防爆音。只在播放任务里调用
 * （播放任务是唯一写 codec 的路径，避免和 TTS 写入交叉打架）。 */
static void play_beep(void)
{
    enum { BEEP_N = AUD_SAMPLE_HZ * 12 / 100 };      /* 1920 样点 = 120ms */
    static int16_t buf[BEEP_N * 2];
    const int fade = BEEP_N / 10;
    for (int i = 0; i < BEEP_N; i++) {
        int amp = 9000;
        if (i < fade)                amp = amp * i / fade;
        else if (i >= BEEP_N - fade) amp = amp * (BEEP_N - 1 - i) / fade;
        int16_t v = (int16_t)(amp * sinf(6.2831853f * 880.0f * (float)i / AUD_SAMPLE_HZ));
        buf[i * 2] = v;
        buf[i * 2 + 1] = v;
    }
    for (int off = 0; off < BEEP_N; ) {
        int n = BEEP_N - off;
        if (n > FRAME_SAMPLES) n = FRAME_SAMPLES;
        esp_codec_dev_write(s_play, buf + off * 2, n * 4);
        off += n;
    }
}

/* 唤醒提示音："叮咚"两声（E6 → A5，纯音 + 弱二次谐波），指数衰减，约 450ms。
 * 取代原来内置的人声应答"我在，有什么可以帮你？"——人声和后面的 TTS 播报
 * 声音不搭，换成 Siri 那种弹出音效。
 * 逐块合成：整段 7200 样点（28KB）放 .bss 太占内部 RAM，块缓冲走播放任务栈。 */
static void play_chime(void)
{
    enum {
        N1_LEN = AUD_SAMPLE_HZ * 11 / 100,      /* 叮 110ms */
        GAP    = AUD_SAMPLE_HZ *  4 / 100,      /* 间隔 40ms */
        N2_LEN = AUD_SAMPLE_HZ * 30 / 100,      /* 咚 300ms */
        TOTAL  = N1_LEN + GAP + N2_LEN,
        CHUNK  = 320,
        ATK    = 80,                            /* 5ms 淡入，防爆音 */
    };
    static const float FREQ[2] = { 1318.51f, 880.0f };
    static const float AMP[2]  = { 1.0f, 0.82f };
    static const int   OFF[2]  = { 0, N1_LEN + GAP };
    static const int   LEN[2]  = { N1_LEN, N2_LEN };
    int16_t out[CHUNK * 2];

    for (int base = 0; base < TOTAL; base += CHUNK) {
        int n = TOTAL - base;
        if (n > CHUNK) n = CHUNK;
        for (int i = 0; i < n; i++) {
            int t = base + i;
            float v = 0;
            for (int k = 0; k < 2; k++) {
                int lt = t - OFF[k];
                if (lt < 0 || lt >= LEN[k]) continue;
                float atk = lt < ATK ? (float)lt / ATK : 1.0f;
                float dec = expf(-(float)lt / (LEN[k] / 3.0f));
                float ph  = 6.2831853f * FREQ[k] * (float)lt / AUD_SAMPLE_HZ;
                v += AMP[k] * (sinf(ph) + 0.22f * sinf(2.0f * ph)) * atk * dec;
            }
            int32_t s = (int32_t)(v * 6800.0f);
            if (s > 30000) s = 30000;
            else if (s < -30000) s = -30000;
            out[i * 2] = (int16_t)s;
            out[i * 2 + 1] = (int16_t)s;
        }
        esp_codec_dev_write(s_play, out, n * 4);
    }
    vTaskDelay(pdMS_TO_TICKS(60));   /* 等 DMA 里的尾音出去，别被紧接着的录音当语音 */
}

/* 闹钟提示音：C6-E6-G6 琶音走两遍，末音拉长，约 1.4 秒。
 * 和唤醒"叮咚"分开，听见就知道是提醒，不是被叫醒。 */
static void play_alarm(void)
{
    enum { NOTE = AUD_SAMPLE_HZ * 16 / 100, GAP = AUD_SAMPLE_HZ * 3 / 100,
           LAST = AUD_SAMPLE_HZ * 45 / 100, CHUNK = 320, ATK = 80 };
    static const float F[6] = { 1046.5f, 1318.5f, 1568.0f, 1046.5f, 1318.5f, 1568.0f };
    int len[6], off[6], total = 0;
    for (int k = 0; k < 6; k++) {
        off[k] = total;
        len[k] = (k == 5) ? LAST : NOTE;
        total += len[k] + GAP;
    }
    int16_t out[CHUNK * 2];
    for (int base = 0; base < total; base += CHUNK) {
        int n = total - base;
        if (n > CHUNK) n = CHUNK;
        for (int i = 0; i < n; i++) {
            int t = base + i;
            float v = 0;
            for (int k = 0; k < 6; k++) {
                int lt = t - off[k];
                if (lt < 0 || lt >= len[k]) continue;
                float atk = lt < ATK ? (float)lt / ATK : 1.0f;
                float dec = expf(-(float)lt / (len[k] / 2.2f));
                float ph  = 6.2831853f * F[k] * (float)lt / AUD_SAMPLE_HZ;
                v += (sinf(ph) + 0.18f * sinf(2.0f * ph)) * atk * dec;
            }
            int32_t s = (int32_t)(v * 6200.0f);
            if (s > 30000) s = 30000;
            else if (s < -30000) s = -30000;
            out[i * 2] = (int16_t)s;
            out[i * 2 + 1] = (int16_t)s;
        }
        esp_codec_dev_write(s_play, out, n * 4);
    }
}

void audio_play_alarm(void)
{
    if (!s_ready || !s_playq) return;
    /* 不动 s_play_done：它只在"唤醒提示音播完"那条路径上被 main 消费，
     * 闹钟如果也置位，会在播报中被误判成"TTS 播完了"。 */
    xQueueReset(s_playq);
    s_stream_open = 0;
    s_frames_pushed = 0;
    s_frames_played = 0;
    s_alarm_req = 1;
}

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
        /* 看门狗：流开着但 15 秒无任何帧活动 → 判本轮结束（防卡"说话中"） */
        if (s_stream_open && !s_play_finishing &&
            (int)(xTaskGetTickCount() * portTICK_PERIOD_MS) - s_stream_act_ms > PLAY_WATCHDOG_MS) {
            ESP_LOGW(TAG, "播放流沉默超过 %d 秒，按播放结束处理", PLAY_WATCHDOG_MS / 1000);
            s_stream_open = 0;
            s_playing = 0;
            xQueueReset(s_playq);
            s_play_done = 1;
        }

        if (s_alarm_req) {
            s_alarm_req = 0;
            play_alarm();
            continue;
        }

        /* 唤醒提示音：直接合成播放，播完立刻通知 main 进入自动聆听 */
        if (s_chime_req) {
            s_chime_req = 0;
            play_chime();
            s_playing   = 0;
            s_play_done = 1;
            continue;
        }

        /* 音量反馈音：空闲才响（TTS 播放中音量已即时生效，不需要提示音） */
        if (s_beep_req) {
            s_beep_req = 0;
            if (!s_playing && !s_rec_on)
                play_beep();
        }

        if (!s_playing) {
            if (xQueueReceive(s_playq, &f, pdMS_TO_TICKS(100)) != pdTRUE) {
                if (s_play_finishing) {
                    s_play_finishing = 0;
                    s_stream_open = 0;
                    s_play_done = 1;
                }
                continue;
            }
            s_playing = 1;
        } else if (xQueueReceive(s_playq, &f, 0) != pdTRUE) {
            if (s_play_finishing) {
                s_playing = 0;
                s_play_finishing = 0;
                s_stream_open = 0;
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
            s_frames_played++;
            s_stream_act_ms = (int)(xTaskGetTickCount() * portTICK_PERIOD_MS);
        } else if (n < 0) {
            ESP_LOGW(TAG, "opus 解码失败: %d", n);
        }
    }
}

/* ── 对外接口 ───────────────────────────────────────────────────────── */

int audio_ready(void) { return s_ready; }

void audio_rec_start(void)
{
    s_rec_auto = 0; s_vad_stop = 0;
    s_vad_frames = 0; s_vad_voiced = 0; s_vad_skip = VAD_SKIP_KEY;
    s_enc_reset = 1; s_rec_on = 1;
}
void audio_rec_stop(void)  { s_rec_on = 0; s_rec_auto = 0; }
int  audio_rec_active(void) { return s_rec_on; }

/* 唤醒后的自动聆听：录音 + 静音检测（VAD）自动结束。
 * bargein=1：播报中被打断进入（开头 5 帧是喇叭尾音，不计有效说话） */
void audio_rec_start_auto(int bargein)
{
    s_rec_auto    = 1;
    s_vad_stop    = 0;
    s_vad_spoke   = 0;
    s_vad_sil_run = 0;
    s_vad_frames  = 0;
    s_vad_voiced  = 0;
    s_vad_skip    = bargein ? VAD_SKIP_BARGEIN : 0;
    s_rec_auto_at = (int)(xTaskGetTickCount() * portTICK_PERIOD_MS);
    s_enc_reset   = 1;
    s_rec_on      = 1;
    ESP_LOGI(TAG, "自动聆听：底噪 %.0f，说话门槛 %.0f", s_noise, vad_threshold());
}

/* 读一次即清：1=说完 2=没说话 3=超时 0=继续录 */
int audio_rec_vad_stop(void)
{
    int v = s_vad_stop;
    if (v) s_vad_stop = 0;
    return v;
}

/* 本段录音里用户是否真的说了话（有效语音帧数 ≥ VAD_MIN_VOICED）；
 * 返回 0 = 只有杂音/尾音碎片 → 本地静默收尾，不送 ASR */
int audio_rec_heard_speech(void) { return s_vad_voiced >= VAD_MIN_VOICED; }

void audio_play_reset(void)
{
    if (!s_ready) return;
    s_play_finishing = 0;
    s_play_done = 0;
    s_chime_req = 0;
    s_stream_open = 1;
    s_stream_act_ms = (int)(xTaskGetTickCount() * portTICK_PERIOD_MS);
    s_frames_pushed = 0;
    s_frames_played = 0;
    xQueueReset(s_playq);
}

void audio_play_push(const uint8_t *opus, size_t len)
{
    if (!s_ready || !s_playq || len == 0 || len > MAX_OPUS_FRAME) return;
    if (!s_stream_open) return;                  /* 流已结束/被打断：丢弃迟到帧 */
    play_frame_t f;
    f.len = (uint16_t)len;
    memcpy(f.data, opus, len);
    if (xQueueSend(s_playq, &f, 0) == pdTRUE) {
        s_frames_pushed++;
        s_stream_act_ms = (int)(xTaskGetTickCount() * portTICK_PERIOD_MS);
    } else {
        ESP_LOGW(TAG, "播放队列满，丢帧 (queue=%d)", (int)uxQueueMessagesWaiting(s_playq));
    }
}

void audio_play_finish(void) { if (s_ready) s_play_finishing = 1; }

/* 唤醒提示音（本地合成，不经过网络）：没有 tts_stop，播完直接标记结束，
 * main 读到 audio_play_finished() 就进入自动聆听。 */
void audio_play_wake_chime(void)
{
    if (!s_ready || !s_playq) return;

    s_play_finishing = 0;
    s_play_done      = 0;
    s_stream_open    = 0;      /* 提示音期间到达的 TTS 帧一律丢弃 */
    s_frames_pushed  = 0;
    s_frames_played  = 0;
    xQueueReset(s_playq);
    s_chime_req      = 1;
}

void audio_play_stop(void)
{
    if (!s_ready) return;
    xQueueReset(s_playq);
    s_chime_req = 0;           /* 打断时提示音也别响了 */
    s_alarm_req = 0;
    s_stream_open = 0;           /* 迟到帧丢弃，等下一次 tts_start 重新开闸 */
    s_play_finishing = 1;
    s_playing = 1;              /* 让播放任务尽快走「空 + finishing」分支收敛 */
}

int audio_play_finished(void)
{
    int d = s_play_done;
    if (d) s_play_done = 0;
    return d;
}

void audio_play_stats(int *pushed, int *played)
{
    if (pushed) *pushed = s_frames_pushed;
    if (played) *played = s_frames_played;
}

void audio_set_volume(int vol)
{
    if (s_play) esp_codec_dev_set_out_vol(s_play, vol);
}

/* 音量档位：BOOT 短按逐档增大；顶档再按 → 静音；静音再按 → 回到最小档循环。
 * 默认音量曲线 0..100 → -50..0dB，85→100 约 +7.5dB。
 * 注意：85 以上曾触发功放电流尖峰的 BOD 欠压复位（实测教训）；100 档需要
 * 实测，若复位则降档或改善供电。 */
static const int VOL_STEPS[] = { 25, 50, 75, 90, 100 };
static int s_vol_cur = 65;              /* 与 audio_init 里设置的默认一致 */
static int s_vol_before_mute = 65;

static void vol_apply(int v)
{
    if (v < 0) v = 0;
    if (v > 100) v = 100;
    audio_set_volume(v);
    s_vol_cur = v;
    s_beep_req = 1;                     /* 反馈音（播放任务空闲时响） */
}

void audio_volume_cycle(void)
{
    int next = VOL_STEPS[0];            /* 从静音(0)再按 → 回最小档重新开始 */
    if (s_vol_cur > 0) {
        next = 0;                       /* 默认递增；找不到更大档位 = 已到顶 → 静音 */
        for (int i = 0; i < (int)(sizeof(VOL_STEPS) / sizeof(VOL_STEPS[0])); i++) {
            if (VOL_STEPS[i] > s_vol_cur) { next = VOL_STEPS[i]; break; }
        }
    }
    vol_apply(next);
    ESP_LOGI(TAG, "音量 → %d%s", next, next ? "" : "（静音）");
}

void audio_volume_set(int vol)
{
    if (vol > 0) s_vol_before_mute = vol;
    vol_apply(vol);
}

void audio_volume_up(void)
{
    int next = VOL_STEPS[sizeof(VOL_STEPS) / sizeof(VOL_STEPS[0]) - 1];
    for (int i = 0; i < (int)(sizeof(VOL_STEPS) / sizeof(VOL_STEPS[0])); i++) {
        if (VOL_STEPS[i] > s_vol_cur) { next = VOL_STEPS[i]; break; }
    }
    vol_apply(next);
}

void audio_volume_down(void)
{
    int prev = 0;
    for (int i = 0; i < (int)(sizeof(VOL_STEPS) / sizeof(VOL_STEPS[0])); i++) {
        if (VOL_STEPS[i] < s_vol_cur) prev = VOL_STEPS[i];
    }
    vol_apply(prev);
}

void audio_volume_mute(void)
{
    if (s_vol_cur > 0) s_vol_before_mute = s_vol_cur;
    vol_apply(0);
}

void audio_volume_unmute(void)
{
    vol_apply(s_vol_before_mute > 0 ? s_vol_before_mute : 65);
}

int audio_volume_get(void) { return s_vol_cur; }

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

    /* 4) 编解码器：ES8311（DAC + PA）+ ES7210（四路麦克风全选，TDM 输出） */
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
        .mic_selected = ES7210_SEL_MIC1 | ES7210_SEL_MIC2 | ES7210_SEL_MIC3 | ES7210_SEL_MIC4,
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
    esp_codec_dev_set_out_vol(s_play, 65);        /* 85→65：压低功放电流尖峰，缓解 BOD 欠压复位 */
    esp_codec_dev_set_in_gain(s_rec, 35.0f);      /* 与出厂程序一致（有效 34.5dB） */

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
     * 编码峰值约 30KB，这里给 40KB；解码路径给 16KB。
     * 两个大栈都放 PSRAM，把内部 RAM 留给 BLE 控制器。
     *
     * xTaskCreateStatic 的深度单位是「字」（StackType_t = 4 字节），不是字节 ——
     * 传字节数会让 FreeRTOS 按 4 倍大小往缓冲区里灌填充值，直接踩烂后面的 PSRAM 堆。 */
    static StaticTask_t s_mic_tcb, s_play_tcb;
    static StackType_t *s_mic_stack, *s_play_stack;
    s_mic_stack = heap_caps_malloc(MIC_STACK_BYTES, MALLOC_CAP_SPIRAM);
    s_play_stack = heap_caps_malloc(PLAY_STACK_BYTES, MALLOC_CAP_SPIRAM);
    if (!s_mic_stack || !s_play_stack) {
        ESP_LOGE(TAG, "音频任务栈分配失败（PSRAM 不足）");
        return ESP_ERR_NO_MEM;
    }
    TaskHandle_t mic_h = xTaskCreateStaticPinnedToCore(
        mic_task, "audio_mic", MIC_STACK_BYTES / sizeof(StackType_t),
        NULL, 5, s_mic_stack, &s_mic_tcb, 1);
    TaskHandle_t play_h = xTaskCreateStaticPinnedToCore(
        play_task, "audio_play", PLAY_STACK_BYTES / sizeof(StackType_t),
        NULL, 5, s_play_stack, &s_play_tcb, 1);
    if (!mic_h || !play_h) {
        ESP_LOGE(TAG, "音频任务创建失败（内存不足？）");
        return ESP_FAIL;
    }

    s_ready = 1;
    ESP_LOGI(TAG, "音频就绪：ES8311+ES7210 @%dHz（麦克风四路 TDM，PA=GPIO%d），内部空闲堆 %u B",
             AUD_SAMPLE_HZ, AUD_PA_PIN, (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
    return ESP_OK;
}
