/**
 * services/llm.mjs — 大模型调用（DeepSeek，OpenAI 兼容）
 *
 * 两个要点：
 *  1. 模型名用 deepseek-flash。旧名 deepseek-v4-flash 仍可调用但已下线，
 *     实际由 DeepSeek-V4.1-Flash 服务、按 Flash 计费。
 *  2. 思考模式默认关闭 —— 语音场景下思考会明显拉长首字延迟。
 *
 * 流式返回 + 按句切分：第一句生成完就能送去 TTS 开播，不用等整段写完。
 *
 * 工具调用（function calling）：传 tools 声明后，模型可能先要工具——
 * 这时流里的 tool_calls 增量按 index 拼好，收进调用方给的 toolSink.calls，
 * 文本照常 yield（通常是空的，或只有一句"让我查查"的引子）。
 */

const SENT_END = /[。！？；!?;\n]/;
const RETRY_DELAYS_MS = [700, 1800];      /* 503/429/网络抖动：最多再试 2 次 */
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 给设备/用户看的短错误；详细原始响应只进服务器日志 */
export class LlmError extends Error {
  constructor(message, friendly, status) {
    super(message);
    this.name = "LlmError";
    this.friendly = friendly || message;
    this.status = status;
  }
}

function friendlyLlmError(status, detail) {
  const d = String(detail || "").toLowerCase();
  if (status === 503 || /too busy|overloaded|service is too busy/.test(d))
    return "大模型服务繁忙，请稍后再试";
  if (status === 429) return "请求太频繁，请稍后再试";
  if (status === 401 || status === 403) return "大模型鉴权失败，请检查 API Key";
  if (status >= 500) return "大模型服务暂时不可用，请稍后再试";
  return `大模型请求失败（HTTP ${status}）`;
}

/**
 * 流式对话，yield 增量文本。
 * @param {object} o
 * @param {string} o.apiKey
 * @param {string} [o.baseUrl]
 * @param {string} [o.model]
 * @param {Array<{role:string,content:string}>} o.messages
 * @param {boolean} [o.thinking] 默认 false
 * @param {Array} [o.tools] 工具声明（OpenAI 兼容）
 * @param {{calls:Array}} [o.toolSink] 收集流里的 tool_calls（{id,name,args}）
 */
export async function* chatStream(o) {
  const {
    apiKey,
    baseUrl = "https://api.deepseek.com",
    model = "deepseek-flash",
    messages,
    thinking = false,
    tools,
    toolSink,
    maxTokens = 300,
    temperature = 0.7,
    /* 流是"边收边用"的：长故事可能要连续生成 1~3 分钟，只要流还在动就不该掐 */
    timeoutMs = 180000,
  } = o;

  if (!apiKey) throw new Error("未配置 LLM API Key");

  const body = {
    model,
    messages,
    stream: true,
    max_tokens: maxTokens,
    temperature,
    /* DeepSeek 思考模式默认开启，语音场景必须显式关掉 */
    thinking: thinking ? { type: "enabled" } : { type: "disabled" },
  };
  if (tools?.length) body.tools = tools;

  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  let res;
  let streamTimer;
  for (let attempt = 0; ; attempt++) {
    const attemptAc = new AbortController();
    const attemptTimer = setTimeout(() => attemptAc.abort(), timeoutMs);
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: attemptAc.signal,
      });
    } catch (e) {
      clearTimeout(attemptTimer);
      if (e.name === "AbortError")
        throw new LlmError("LLM 请求超时", "大模型响应超时，请稍后再试");
      if (attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw new LlmError(`LLM 网络错误: ${e.message}`, "网络不稳定，没连上大模型");
    }

    if (res.ok) {
      streamTimer = attemptTimer;
      break;
    }

    const txt = await res.text().catch(() => "");
    clearTimeout(attemptTimer);
    if (attempt < RETRY_DELAYS_MS.length && RETRY_STATUS.has(res.status)) {
      await sleep(RETRY_DELAYS_MS[attempt]);
      continue;
    }
    throw new LlmError(
      `LLM HTTP ${res.status}: ${txt.slice(0, 200)}`,
      friendlyLlmError(res.status, txt),
      res.status);
  }

  const decoder = new TextDecoder();
  let buf = "";
  try {
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        try {
          const delta = JSON.parse(data).choices?.[0]?.delta;
          if (!delta) continue;
          if (delta.content) yield delta.content;
          /* 工具调用增量按 index 拼接：id/name 通常只在首包，arguments 逐包累加 */
          if (toolSink && Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const i = tc.index ?? 0;
              const slot = (toolSink.calls[i] ??= { id: "", name: "", args: "" });
              if (tc.id) slot.id = tc.id;
              if (tc.function?.name && !slot.name) slot.name = tc.function.name;
              if (tc.function?.arguments) slot.args += tc.function.arguments;
            }
          }
        } catch { /* 半包 JSON，忽略 */ }
      }
    }
  } catch (e) {
    if (e.name === "AbortError")
      throw new LlmError("LLM 流读取超时", "大模型响应超时，请稍后再试");
    throw e;
  } finally {
    clearTimeout(streamTimer);
  }
}

/** 流式对话 + 按句切分，yield 完整句子 */
export async function* chatSentences(o) {
  let acc = "";
  for await (const delta of chatStream(o)) {
    acc += delta;
    let m;
    while ((m = SENT_END.exec(acc))) {
      const end = m.index + 1;
      const sent = acc.slice(0, end);
      acc = acc.slice(end);
      if (sent.trim()) yield sent;
    }
  }
  if (acc.trim()) yield acc;
}
