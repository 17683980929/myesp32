/**
 * services/lua-ai.mjs — 创造模式：用大模型改设备上的 Lua 脚本
 *
 * 只做三件事：
 *   1. 把当前脚本 + Lua API/屏幕约束交给模型，要求输出完整替换脚本；
 *   2. 从模型文本里解析 SUMMARY + ```lua 代码块；
 *   3. 服务端先做静态约束检查（长度、API、事件、课表 DATA 段），
 *      真正的语法/运行时错误由设备回执兜底，apply 失败会自动回滚。
 */

import crypto from "node:crypto";
import { chatStream } from "./llm.mjs";

const CODE_LIMIT = 6000;
const MAX_LUA_ATTEMPTS = 3;
const DATA_RE = /-- >>>DATA[\s\S]*?-- <<<DATA\n?/;

const ALLOWED_API = {
  display: new Set(["clear", "text", "rect", "flush", "close"]),
  pet: new Set(["state"]),
  sensor: new Set(["temp", "hum", "battery", "voltage"]),
  sys: new Set(["millis", "delay", "log", "clock", "on", "reboot"]),
  timer: new Set(["after", "every"]),
  gpio: new Set(["mode", "read", "write", "toggle"]),
  audio: new Set(["volume", "chime", "alarm"]),
  rtc: new Set(["get", "set"]),
  wifi: new Set(["status"]),
  ble: new Set(["status"]),
};

const KNOWN_PERMS = new Set([
  "display", "sensor", "timer", "sys",
  "gpio", "gpio:all", "audio", "rtc", "wifi", "ble",
]);

const EVENTS = new Set([
  "key_click", "key_double",
  "open_timetable", "open_env", "canvas_close", "canvas_next",
  "round_1", "round_2", "round_3",
]);

const SYSTEM_PROMPT = `你是「小鱼」桌面宠物的 Lua UI 工程师。你只能修改设备上运行的那一份 Lua 脚本；不能改固件、服务器、配置，也不能新增 Lua API。

设备约束：
- 屏幕 400x300 单色 RLCD，只有 16px / 32px 两种字号；32px 一行约 12 个汉字。
- 每次绘制后 30 秒内不要再次重绘（会打断自动返回主页）；不要用 timer.every 做秒级刷新。
- 整份脚本必须 ≤ 6000 字符；当前脚本已接近上限，尽量小改。
- 设备端一次执行最多 2 秒；不要写死循环。
- 可用 API（只有这些）：
  display.clear()
  display.text(x, y, s, size)   size=16 或 32
  display.rect(x, y, w, h, fill) fill=true/false
  display.flush()
  display.close()
  pet.state("auto" 或 "sleeping")
  sensor.temp() sensor.hum() sensor.battery() sensor.voltage()
  sys.millis() sys.delay(ms) sys.log(...) sys.clock() sys.on(name, fn)
  timer.after(ms, fn) timer.every(ms, fn)
  标准库：base / coroutine / math / string / table / utf8；没有 io / os / package / debug，也没有 require / dofile / loadfile。

扩展能力（用到才在脚本第一行声明 -- @perm ...，没声明就调用会报“权限不足”；没用到不要声明）：
  gpio.mode(pin, "in"/"out"/"in_pullup"/"in_pulldown")  gpio.read(pin)  gpio.write(pin, 0/1)  gpio.toggle(pin)
    权限 gpio 默认只能 1,2,3,43,44；gpio:all 可操作除 USB(19,20)、Flash/PSRAM(26~37) 外的全部脚（可能影响屏幕/音频，慎用）
  audio.volume([0..100])  audio.chime()  audio.alarm()                         权限 audio
  rtc.get() -> {year,mon,day,wday,hour,min,sec}  rtc.set(year,mon,day,hour,min,sec)  权限 rtc
  wifi.status() -> {connected,ip,ssid,rssi}                                      权限 wifi
  ble.status() -> {state,name}                                                   权限 ble
  sys.reboot()                                                                   权限 sys
  示例：-- @perm gpio,audio
- sys.on 只支持：key_click, key_double, open_timetable, open_env, canvas_close, canvas_next, round_1, round_2, round_3。未知事件会报错；可选事件用 pcall 包住。
- 如果当前脚本包含 \`-- >>>DATA ... -- <<<DATA\` 段，必须原样保留（课表数据由服务器管理）；如果没有，不要新增。
- 保留现有脚本的页面和功能，除非用户明确要求删除；保留错误处理和防重入。
- 如果需求需要固件能力（新传感器 / 网络 / 新事件），不要编造 API；SUMMARY 里说明“Lua 做不到，需要固件支持”，不要输出代码块。
输出格式（严格）：
SUMMARY: 一句中文摘要（≤80 字）
\`\`\`lua
<完整的新脚本，不能省略、不能给 diff、不能写“其余不变”>
\`\`\``;

export function luaBaseHash(code) {
  return crypto.createHash("sha1").update(String(code || "")).digest("hex").slice(0, 16);
}

function extractDataBlock(code) {
  const m = String(code || "").match(DATA_RE);
  return m ? m[0].replace(/\n?$/, "\n") : "";
}

/** 去掉注释再做 API/危险函数检查，避免注释里的示例造成误报 */
function stripLuaComments(code) {
  return String(code || "")
    .replace(/--\[(=*)\[[\s\S]*?\]\1\]/g, "")
    .replace(/--[^\n]*/g, "");
}

function normalizeSummary(s, warnings) {
  let summary = String(s || "").replace(/\s+/g, " ").trim();
  if (!summary) {
    summary = "Lua 修改";
    warnings.push("模型没有给出摘要");
  }
  if (summary.length > 120) {
    summary = summary.slice(0, 118) + "…";
    warnings.push("摘要过长，已截断");
  }
  return summary;
}

/**
 * 从模型输出里取 SUMMARY 和代码块。取最长的 lua 块，避免示例块和正式脚本混淆。
 * @returns {{summary:string, code:string}}
 */
export function parseModelOutput(raw) {
  const text = String(raw || "").replace(/\r\n/g, "\n");
  let summary = "";
  const sm = text.match(/^\s*SUMMARY\s*[:：]\s*(.+)$/im);
  if (sm) summary = sm[1].trim();

  const blocks = [...text.matchAll(/```(?:lua)?\s*\n?([\s\S]*?)```/gi)]
    .map((m) => m[1].trim())
    .filter(Boolean);
  let code = "";
  if (blocks.length) {
    code = blocks.sort((a, b) => b.length - a.length)[0];
  } else {
    const cm = text.match(/(?:^|\n)\s*(?:CODE|LUA)\s*[:：]\s*\n([\s\S]*)$/i);
    if (cm) code = cm[1].trim();
    else if (/^\s*(?:local|function|display|--)/m.test(text)) code = text.trim();
    if (summary) code = code.replace(/^\s*SUMMARY\s*[:：].*$/im, "").trim();
  }
  code = code.replace(/^\s*(?:CODE|LUA)\s*[:：]\s*/i, "").trim();
  return { summary, code };
}

/**
 * 静态校验并规范化脚本：如果当前脚本有课表 DATA 段，则用服务器当前内容覆盖。
 * @param {string} rawCode 模型给出的脚本
 * @param {string} current 当前生效脚本（提供课表 DATA 段）
 * @returns {{ok:boolean, code:string, errors:string[], warnings:string[]}}
 */
export function validateLua(rawCode, current) {
  const errors = [];
  const warnings = [];
  let code = String(rawCode || "").replace(/\r\n/g, "\n").trim();

  const fence = code.match(/```(?:lua)?\s*\n?([\s\S]*?)```/i);
  if (fence) code = fence[1].trim();
  if (!code) return { ok: false, code: "", errors: ["模型没有给出脚本"], warnings };

  const permMatch = code.match(/^[ \t]*--[ \t]*@perm[ \t]+(.+)$/m);
  const permTokens = permMatch
    ? [...new Set(permMatch[1].split(/[,\s]+/).filter(Boolean))]
    : [];
  for (const p of permTokens) {
    if (!KNOWN_PERMS.has(p)) errors.push(`不支持的权限：${p}`);
  }
  const hasPerm = (p) => permTokens.includes(p);
  const gpioPerm = hasPerm("gpio") || hasPerm("gpio:all");
  const permLine = permTokens.length ? `-- @perm ${permTokens.join(",")}\n` : "";
  code = code.replace(/^[ \t]*--[ \t]*@perm[^\n]*\n?/gm, "").trim();

  const currentBlock = extractDataBlock(current);
  const hasBlock = DATA_RE.test(code);
  const suppliedBlock = extractDataBlock(code);

  /* 去掉模型可能给出的多个/旧 DATA 段 */
  const body = code
    .replace(/-- >>>DATA[\s\S]*?-- <<<DATA\n?/g, "")
    .trim();
  if (!body) errors.push("脚本只有课表 DATA 段，没有主体");

  if (/^\s*--\s*(?:\.{3,}|…|省略|其余|同上|unchanged|same as before)/im.test(body) ||
      /<\.\.\.>|\bTODO\b/.test(body)) {
    errors.push("脚本里还有省略占位，不是完整脚本");
  }
  const diffish = body.split("\n").filter((l) => /^\s*[+-]\s/.test(l)).length;
  if (diffish >= 3) errors.push("看起来返回的是差异片段，不是完整脚本");

  if (currentBlock) {
    if (!hasBlock) warnings.push("模型没有保留课表 DATA 段，已自动补回");
    else if (suppliedBlock !== currentBlock) warnings.push("课表 DATA 段已用服务器当前内容替换");
    code = (currentBlock + "\n" + body + "\n").trim() + "\n";
  } else {
    if (hasBlock) warnings.push("当前脚本没有课表 DATA 段，已忽略模型生成的 DATA 段");
    code = body.trim() + "\n";
  }
  code = permLine + code;
  if (code.length > CODE_LIMIT) {
    errors.push(`脚本 ${code.length} 字符，超过上限 ${CODE_LIMIT}`);
  }

  const plain = stripLuaComments(code);
  const forbidden = [
    [/\b(?:dofile|loadfile)\b/, "dofile/loadfile 不可用"],
    [/\brequire\s*\(/, "require 不可用"],
    [/\b(?:io|os|package|debug)\s*[.:]/, "io/os/package/debug 不可用"],
    [/\bload\s*\(/, "load 不可用"],
    [/\bcollectgarbage\s*\(/, "collectgarbage 不可用"],
    [/\bsetmetatable\s*\(|\bgetmetatable\s*\(/, "setmetatable/getmetatable 不可用"],
    [/\brawset\s*\(|\brawget\s*\(/, "rawset/rawget 不可用"],
  ];
  for (const [re, msg] of forbidden) if (re.test(plain)) errors.push(msg);

  const apiRe = /\b(display|pet|sensor|sys|timer|gpio|audio|rtc|wifi|ble)\s*\.\s*([A-Za-z_]\w*)/g;
  const seen = new Set();
  let m;
  while ((m = apiRe.exec(plain))) {
    const ns = m[1], fn = m[2];
    const key = `${ns}.${fn}`;
    if (!ALLOWED_API[ns]?.has(fn) && !seen.has(key)) {
      seen.add(key);
      errors.push(`不支持的 API：${key}`);
    }
  }

  const permChecks = [
    [/\bgpio\s*\./, gpioPerm, "gpio"],
    [/\baudio\s*\./, hasPerm("audio"), "audio"],
    [/\brtc\s*\./, hasPerm("rtc"), "rtc"],
    [/\bwifi\s*\./, hasPerm("wifi"), "wifi"],
    [/\bble\s*\./, hasPerm("ble"), "ble"],
    [/\bsys\s*\.\s*reboot\s*\(/, hasPerm("sys"), "sys"],
  ];
  for (const [re, ok, name] of permChecks) {
    if (re.test(plain) && !ok) errors.push(`使用 ${name} 需要在第一行声明 -- @perm ${name}`);
  }
  if (permTokens.includes("gpio:all")) {
    warnings.push("gpio:all 可改屏幕/音频等占用脚，可能导致设备显示或声音异常");
  }
  if (/\bsys\s*\.\s*reboot\s*\(/.test(plain)) {
    warnings.push("脚本会重启设备");
  }

  const evRe = /sys\s*\.\s*on\s*\(\s*["']([^"']+)["']/g;
  while ((m = evRe.exec(plain))) {
    if (!EVENTS.has(m[1])) errors.push(`不支持的事件：${m[1]}`);
  }

  if (/\btimer\s*\.\s*every\s*\(/.test(plain)) {
    warnings.push("使用了 timer.every：定时重绘可能影响 30 秒自动回首页");
  }
  if (/\bwhile\s+true\b/.test(plain)) {
    warnings.push("脚本包含 while true，依赖运行时 2 秒超时兜底");
  }

  return { ok: errors.length === 0, code, errors, warnings, permissions: permTokens };
}

/**
 * 生成完整脚本；静态校验失败时把错误和上一版代码交回模型自动修正，
 * 最多 3 次尝试（含首次）。模型调用错误也会重试，最后一次仍失败则抛出。
 * @param {{request:string, current:string, llm:object, onStep?:(text:string)=>void, chat?:Function}} o
 */
export async function generateLuaProposal({ request, current, llm, onStep, chat = chatStream }) {
  if (!llm?.apiKey) throw new Error("未配置大模型 API Key");
  const step = (text) => {
    try { onStep?.(text); } catch { /* 进度回调不应影响生成 */ }
  };

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content:
        `当前脚本（${current.length} 字符）：\n\`\`\`lua\n${current}\n\`\`\`\n\n` +
        `用户需求：${request}`,
    },
  ];

  let attempts = 0;
  let lastError = "";

  for (let attempt = 1; attempt <= MAX_LUA_ATTEMPTS; attempt++) {
    attempts = attempt;
    step(attempt === 1 ? "请求模型生成完整脚本" : `请求模型修正（第 ${attempt} 次尝试）`);

    let raw = "";
    try {
      for await (const delta of chat({
        apiKey: llm.apiKey,
        baseUrl: llm.baseUrl,
        model: llm.model,
        messages,
        maxTokens: 4096,
        temperature: 0.2,
        thinking: false,
        timeoutMs: 60000,
      })) {
        raw += delta;
      }
    } catch (e) {
      lastError = e.message || String(e);
      if (attempt >= MAX_LUA_ATTEMPTS) throw e;
      step(`模型调用失败：${lastError}，重试`);
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }

    step("解析模型输出");
    const parsed = parseModelOutput(raw);
    const checked = validateLua(parsed.code, current);
    if (checked.ok && checked.code.trim() === String(current || "").trim()) {
      checked.ok = false;
      checked.errors.push("模型没有改变脚本");
    }
    const summary = normalizeSummary(parsed.summary, checked.warnings);

    if (checked.ok) {
      step(`第 ${attempt} 次静态校验通过`);
      return {
        ok: true,
        summary,
        code: checked.code,
        errors: checked.errors,
        warnings: checked.warnings,
        attempts,
      };
    }

    step(`第 ${attempt} 次校验未通过：${checked.errors.slice(0, 2).join("；").slice(0, 120)}`);
    if (attempt >= MAX_LUA_ATTEMPTS) {
      step(`重试 ${attempts} 次仍未通过`);
      return {
        ok: false,
        summary,
        code: checked.code,
        errors: checked.errors,
        warnings: checked.warnings,
        attempts,
      };
    }

    messages.push({ role: "assistant", content: raw });
    messages.push({
      role: "user",
      content:
        `上一版没有通过静态校验：\n${checked.errors.map((e) => `- ${e}`).join("\n")}\n\n` +
        `请逐条修正这些问题，重新输出完整脚本。要求：完整替换、不要 diff/省略、` +
        `保留课表 DATA 段（如果当前有）、只输出 SUMMARY + lua 代码块。`,
    });
    step("把校验错误交给模型修正");
  }

  throw new Error(lastError || "模型生成失败");
}
