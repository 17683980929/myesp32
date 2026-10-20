/**
 * audio.h — 语音链路对外接口（ES8311 喇叭 + ES7210 麦克风 + Opus）
 *
 * 上行：录音 → Opus 60ms 帧 → ws_send_audio()
 * 下行：ws 二进制帧 → audio_play_push()
 */
#pragma once
#include <stdint.h>
#include <stddef.h>
#include "esp_err.h"

/** 初始化（需在 sensors_init 之后调用；失败返回非 0，语音功能不可用） */
esp_err_t audio_init(void);
int  audio_ready(void);

/* ── 上行（录音）────────────────────────────────────────────────────── */
void audio_rec_start(void);     /* 开始采集 + 编码 + 发送 */
void audio_rec_stop(void);
int  audio_rec_active(void);

/* ── 下行（播放 TTS）────────────────────────────────────────────────── */
void audio_play_reset(void);                            /* tts_start：清队列 */
void audio_play_push(const uint8_t *opus, size_t len);  /* 一帧 opus（可在 ws 回调里调） */
void audio_play_finish(void);                           /* tts_stop：队列播完即结束 */
void audio_play_stop(void);                             /* 立即停止（断线/用户打断） */
int  audio_play_finished(void);                         /* 读一次即清：一轮播放完成 */
void audio_play_stats(int *pushed, int *played);        /* 帧计数（tts_start 清零）：已入队 / 已播 */

/* ── 唤醒应答（本地内置"我在"，不经过网络；播完走 audio_play_finished()）── */
void audio_play_greeting(void);

/* ── 自动聆听（唤醒流程：录音 + 静音检测自动结束，无需按 KEY）────────── */
void audio_rec_start_auto(int bargein);  /* bargein=1：播报中打断进入（开头几帧是喇叭尾音，不计有效说话） */
int  audio_rec_vad_stop(void);           /* 读一次即清：1=说完 2=没说话 3=超时 0=继续 */
int  audio_rec_heard_speech(void);       /* 本段录音是否检测到有效说话（否 → 本地静默收尾） */

/* ── 音量 ───────────────────────────────────────────────────────────── */
void audio_set_volume(int vol); /* 0..100 */
void audio_volume_cycle(void);  /* BOOT 短按：逐档增大 → 顶档后静音 → 回到最小档循环（带反馈音） */
int  audio_volume_get(void);    /* 当前音量 0..100（0 = 静音） */
void audio_volume_set(int vol); /* 语音指定音量 0..100 */
void audio_volume_up(void);     /* 语音调大一档（到顶保持） */
void audio_volume_down(void);   /* 语音调小一档（到底为 0） */
void audio_volume_mute(void);
void audio_volume_unmute(void);
