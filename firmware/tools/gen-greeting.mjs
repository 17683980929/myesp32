/**
 * gen-greeting.mjs — 生成唤醒应答音频（本地内置，唤醒后立刻播放，不经过网络）
 *
 * 用服务器同款百度 TTS（server/src/services/tts.mjs）合成
 * → 切成 60ms opus 帧 → 写成固件 C 数组（components/audio/greeting_opus.c/.h）。
 *
 * 重新生成：node firmware/tools/gen-greeting.mjs
 * （需要 server/config.json 里的百度语音密钥，且本机可访问 baidu.com）
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { textToOpusFrames } from "../../server/src/services/tts.mjs";

const TEXT = "我在，有什么可以帮你？";

const here = dirname(fileURLToPath(import.meta.url));
const outC = join(here, "..", "components", "audio", "greeting_opus.c");
const outH = join(here, "..", "components", "audio", "include", "greeting_opus.h");

const { frames, durationMs } = await textToOpusFrames(TEXT);
const lens = frames.map((f) => f.length);
const blob = Buffer.concat(frames);

/* 每行 16 字节，读起来不难受 */
const hexRows = [];
for (let i = 0; i < blob.length; i += 16) {
  const row = [...blob.subarray(i, i + 16)].map((b) => "0x" + b.toString(16).padStart(2, "0"));
  hexRows.push("    " + row.join(", ") + ",");
}

const cSrc = `/* 本文件由 tools/gen-greeting.mjs 自动生成，勿手改（改文案/音色后重新生成即可）。
 * 内容：唤醒应答「${TEXT}」（百度 TTS，16kHz 单声道 Opus，60ms/帧）
 * 时长约 ${(durationMs / 1000).toFixed(2)} 秒，共 ${frames.length} 帧 / ${blob.length} 字节 */
#include "greeting_opus.h"

const unsigned char G_GREETING_BLOB[] = {
${hexRows.join("\n")}
};
const unsigned short G_GREETING_LENS[] = {
${(function () { const rows = []; for (let i = 0; i < lens.length; i += 20) rows.push("    " + lens.slice(i, i + 20).join(", ") + ","); return rows.join("\n"); })()}
};
const int G_GREETING_BYTES = (int)sizeof(G_GREETING_BLOB);
const int G_GREETING_FRAMES = ${frames.length};
`;

const hSrc = `/* 本文件由 tools/gen-greeting.mjs 自动生成，勿手改。 */
#pragma once

#ifdef __cplusplus
extern "C" {
#endif

extern const unsigned char G_GREETING_BLOB[];
extern const unsigned short G_GREETING_LENS[];
extern const int G_GREETING_BYTES;
extern const int G_GREETING_FRAMES;

#ifdef __cplusplus
}
#endif
`;

writeFileSync(outC, cSrc);
writeFileSync(outH, hSrc);
console.log(`OK: ${frames.length} 帧 / ${blob.length} 字节 / ${(durationMs / 1000).toFixed(2)}s -> ${outC}`);
