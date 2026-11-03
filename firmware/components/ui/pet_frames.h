/* 自动生成，请勿手改。来源: pet_layers */
#ifndef PET_FRAMES_H
#define PET_FRAMES_H

#include <stdint.h>

#define PET_FRAME_W  200
#define PET_FRAME_H  300
#define PET_FRAME_STRIDE  25
#define PET_FRAME_COUNT  16

/* 1 = 素材是「背景板 + 角色层」：固件先画背景板，再按遮罩贴角色，
 *     角色可以单独上下位移，背景保持静止；
 * 0 = 整帧图（连背景一起画）：只能整屏直贴，背景会跟着动。 */
#define PET_LAYERED  1

extern const uint8_t pet_sm_01_idle[];
extern const uint8_t pet_sm_02_idle_blink[];
extern const uint8_t pet_sm_03_listening[];
extern const uint8_t pet_sm_04_thinking[];
extern const uint8_t pet_sm_05_speaking[];
extern const uint8_t pet_sm_06_happy[];
extern const uint8_t pet_sm_07_love[];
extern const uint8_t pet_sm_08_confused[];
extern const uint8_t pet_sm_09_sleepy[];
extern const uint8_t pet_sm_10_sleeping[];
extern const uint8_t pet_sm_11_salute[];
extern const uint8_t pet_sm_12_direct[];
extern const uint8_t pet_sm_13_patrol[];
extern const uint8_t pet_sm_14_note[];
extern const uint8_t pet_sm_15_charging[];
extern const uint8_t pet_sm_16_water[];

#if PET_LAYERED
extern const uint8_t pet_bg[];
extern const uint8_t pet_fg[];   /* 桌子前景：合成时最后盖一遍，人物被桌子挡住 */
extern const uint8_t *const pet_masks[PET_FRAME_COUNT];
#endif

#endif
