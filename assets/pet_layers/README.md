# 分层桌宠素材（默认不启用，需要时手动开）

**当前是整帧模式**（人物和背景同一张图）。要用分层模式，先在本目录建一个空的 `ENABLE` 文件：

```bash
touch assets/pet_layers/ENABLE      # 启用分层
node tools/gen_pet_frames.mjs
rm assets/pet_layers/ENABLE         # 回整帧（记得重新生成）
```

分层的代价：桌子会挡住人物下半身（要靠前景层），胸像帧也会被裁断处影响，
看起来容易不融合；整帧模式没有这些问题，但背景不能单独静止。

## 需要的文件（都是 200 × 300 PNG）

| 文件 | 内容 | 说明 |
|---|---|---|
| `bg.png` | 背景板 | 只有场景（墙、钟、窗、桌、盆栽、杯子），**不含人物**。黑=墨，白=纸；带不带透明都行 |
| `01_idle.png` | 角色层 | **透明底**，只有人物。alpha ≥ 128 的像素算角色 |
| `02_idle_blink.png` … `16_drinking.png` | 其余 15 帧 | 同上，名字必须完全一致 |

16 个文件名（缺一个生成器会报错）：

```
01_idle  02_idle_blink  03_listening  04_thinking  05_speaking
06_happy 07_love        08_confused   09_sleepy    10_sleeping
11_salute 12_direct     13_patrol     14_note      15_charging
16_drinking
```

## 素材要求

- **背景必须完全一致**：16 张角色图底下不能各带一套背景，否则又会出现「背景在动」
- 角色要**整块带 alpha**：白色制服、白色帽檐也得是 alpha=255 的实心像素，
  否则贴图时背景会从白衣服里透出来（遮罩是"整块不透明"，不是"只涂黑线"）
- 尺寸严格 200×300；有 alpha 通道（RGBA PNG）
- 线稿风格沿用现在的：纯黑白，别带灰度/抗锯齿

## 生成后的效果

- `pet_frames.c` 会多出 `pet_bg[]`、每帧的 `pet_sm_XX_m[]`（遮罩）和 `pet_masks[]` 表
- 固件 `draw_pet()` 走 `#if PET_LAYERED` 分支：先 `lcd_blit(pet_bg)`，再
  `lcd_blit_mask(角色, 遮罩, dy)`
- 随机小动作的上下抖动（`pet_bob_dy`）在这条分支下才真正生效
- 闪存占用：背景 7.5KB + 每帧（角色 7.5KB + 遮罩 7.5KB）× 16 ≈ 248KB

## 没有这个目录时

生成器走**整帧模式**（`PET_LAYERED = 0`）：直接贴整张 200×300 的图，
背景和人物是同一张，不能单独位移——背景不会动，但角色也不会上下动。
