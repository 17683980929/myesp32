/**
 * wake.h — 语音唤醒词（ESP-SR WakeNet9，中文"你好小智"）
 *
 * 空闲时常开麦克风 → wake_feed() 喂 16k 单声道 → 命中后 main 接管
 * （本地应答"我在"→ 自动聆听）。模型来自 "model" 分区，
 * 具体哪个模型由 sdkconfig 的 SR_WN_* 选项决定（现在只有 nihaoxiaozhi_tts）。
 */
#pragma once
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** 加载唤醒模型；无 model 分区/模型时返回非 0（唤醒不可用，其余功能不受影响） */
int wake_init(void);

/** 模型是否就绪 */
int wake_ready(void);

/** 是否处于"听唤醒词"状态（空闲时开，说话/录音/思考时关，避免自触发） */
int wake_enabled(void);

void wake_set_enabled(int on);

/** 喂 16kHz 单声道 PCM（任意长度；内部按模型块大小切分） */
void wake_feed(const int16_t *pcm, int n);

/** 读一次即清：检测到唤醒词返回 1 */
int wake_take_hit(void);

#ifdef __cplusplus
}
#endif
