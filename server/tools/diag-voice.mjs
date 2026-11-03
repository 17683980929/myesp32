/**
 * diag-voice.mjs — 语音链路体检
 *
 * 依次跑：TTS 合成 → Opus 解码成 PCM → 喂 ASR → 问 LLM。
 * 三段都通 = 云端密钥/配额/网络没问题，故障在设备侧（连不上服务器、WiFi、固件）。
 *
 * 用法：
 *   node tools/diag-voice.mjs          # 全套
 *   node tools/diag-voice.mjs --tts    # 只测 TTS
 */

import { getConfig } from "../src/config.mjs";
import { textToOpusFrames, OpusToPcm } from "../src/services/tts.mjs";
import { createASR } from "../src/services/asr.mjs";
import { chatSentences } from "../src/services/llm.mjs";

const cfg = getConfig();
const only = process.argv[2] || "";
const t0 = Date.now();
const ms = (t) => `${String(Date.now() - t).padStart(6)}ms`;

let failed = 0;
async function stage(name, fn) {
  const t = Date.now();
  try {
    const out = await fn();
    console.log(`✅ ${name.padEnd(8)} ${ms(t)}  ${out}`);
    return true;
  } catch (e) {
    failed++;
    console.log(`❌ ${name.padEnd(8)} ${ms(t)}  ${e?.friendly || e?.message || e}`);
    return false;
  }
}

const SENTENCE = "你好，今天天气怎么样";
let pcm = null;

await stage("TTS", async () => {
  const { frames, durationMs } = await textToOpusFrames(SENTENCE, cfg.tts);
  if (!frames?.length) throw new Error("没有产出 Opus 帧");
  const dec = new OpusToPcm();
  for (const f of frames) dec.push(f);
  pcm = dec.drain();
  return `${frames.length} 帧 / ${Math.round(durationMs)}ms 音频 → PCM ${pcm.length} 字节`;
});

if (!only && pcm) {
  await stage("ASR", async () => {
    const asr = createASR(cfg.asr);
    if (!asr) throw new Error("ASR 未初始化（缺 appId/secretId/secretKey）");
    const r = await asr.recognize(pcm, { voiceFormat: "pcm", timeoutMs: 20000 });
    const text = typeof r === "string" ? r : r?.text;
    if (!text?.trim()) throw new Error("识别结果为空");
    return `识别为「${text.trim()}」`;
  });

  await stage("LLM", async () => {
    let out = "";
    for await (const s of chatSentences({
      apiKey: cfg.llm.apiKey,
      baseUrl: cfg.llm.baseUrl,
      model: cfg.llm.model,
      messages: [{ role: "user", content: "你好" }],
      maxTokens: 60,
      temperature: 0.7,
    })) {
      out += s;
      if (out.length > 30) break;
    }
    if (!out.trim()) throw new Error("模型没有返回内容");
    return `首句「${out.trim().slice(0, 28)}」`;
  });
}

console.log(`\n总耗时 ${ms(t0)} · ${failed ? `❌ ${failed} 段失败` : "✅ 全通（云端服务正常，查设备侧）"}`);
process.exit(failed ? 1 : 0);
