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

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === "AbortError") throw new Error("LLM 请求超时");
    throw new Error(`LLM 网络错误: ${e.message}`);
  }

  if (!res.ok) {
    clearTimeout(timer);
    const txt = await res.text().catch(() => "");
    throw new Error(`LLM HTTP ${res.status}: ${txt.slice(0, 200)}`);
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
  } finally {
    clearTimeout(timer);
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
