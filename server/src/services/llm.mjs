/**
 * services/llm.mjs — 大模型调用（DeepSeek，OpenAI 兼容）
 *
 * 两个要点：
 *  1. 模型名用 deepseek-flash。旧名 deepseek-v4-flash 仍可调用但已下线，
 *     实际由 DeepSeek-V4.1-Flash 服务、按 Flash 计费。
 *  2. 思考模式默认关闭 —— 语音场景下思考会明显拉长首字延迟。
 *
 * 流式返回 + 按句切分：第一句生成完就能送去 TTS 开播，不用等整段写完。
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
 */
export async function* chatStream(o) {
  const {
    apiKey,
    baseUrl = "https://api.deepseek.com",
    model = "deepseek-flash",
    messages,
    thinking = false,
    maxTokens = 300,
    temperature = 0.7,
    timeoutMs = 30000,
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
          const delta = JSON.parse(data).choices?.[0]?.delta?.content;
          if (delta) yield delta;
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
