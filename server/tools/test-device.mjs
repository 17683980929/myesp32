/**
 * tools/test-device.mjs — 模拟一台设备，验证服务器
 *
 * 用法：
 *   node tools/test-device.mjs                      # 握手 + 收信息栏
 *   node tools/test-device.mjs --btn                # 额外模拟按 KEY 键
 *   node tools/test-device.mjs --token xxx          # 带鉴权
 *
 * 只验证协议层，不涉及音频（音频要真机才能测）。
 */

import WebSocket from "ws";

const ARGS = process.argv.slice(2);
const has = (f) => ARGS.includes(f);
const argOf = (f, d) => {
  const i = ARGS.indexOf(f);
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : d;
};

const HOST = argOf("--host", "127.0.0.1");
const PORT = argOf("--port", "8080");
const TOKEN = has("--token") ? argOf("--token", "") : "";
const STAY = parseInt(argOf("--stay", "8"), 10);      // 存活秒数（默认 8）
const LUA_FAIL = has("--lua-fail");                   // 模拟 Lua 执行失败

const url = `ws://${HOST}:${PORT}/device${TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : ""}`;

const t0 = Date.now();
const log = (...a) => console.log(`[${String(Date.now() - t0).padStart(6)}ms]`, ...a);

log(`连接 ${url}`);
const ws = new WebSocket(url);

ws.on("open", () => {
  log("✅ 已连接");
  log("→ hello");
  ws.send(JSON.stringify({
    t: "hello",
    fw: "0.1.0-test",
    mac: "aa:bb:cc:dd:ee:ff",
    caps: ["audio", "lua"],
  }));

  /* 模拟板子本地状态上报 */
  setTimeout(() => {
    log("→ stat（模拟本地温湿度/电量）");
    ws.send(JSON.stringify({ t: "stat", bat: 76, room: { t: 24.5, h: 58 } }));
  }, 500);

  if (has("--btn")) {
    setTimeout(() => {
      log("→ btn key click");
      ws.send(JSON.stringify({ t: "btn", k: "key", e: "click" }));
    }, 1200);
  }

  /* 默认 8 秒后收工（--stay 秒数可调） */
  setTimeout(() => {
    log("—— 测试结束 ——");
    ws.close();
    process.exit(0);
  }, STAY * 1000);
});

ws.on("message", (data, isBinary) => {
  if (isBinary) {
    log(`🔊 二进制帧 ${data.length} 字节`);
    return;
  }
  let m;
  try { m = JSON.parse(data.toString()); } catch { return; }

  switch (m.t) {
    case "hello_ack":
      log(`✅ hello_ack  sid=${m.sid}  协议版本=${m.pv}  页面=${m.page}`);
      break;
    case "info":
      log(`📊 info  时间=${m.time}  ${m.date} ${m.week}  天气=${m.weather?.text} ${m.weather?.temp}℃`);
      break;
    case "page":
      log(`📄 page → ${m.name}`);
      break;
    case "lua": {
      log(`📜 收到 Lua#${m.id}（${(m.code || "").length} 字符）`);
      setTimeout(() => {
        const out = LUA_FAIL ? "第 1 行: 模拟错误（--lua-fail）" : "模拟执行 OK\n=> 42";
        log(`→ lua id=${m.id} ok=${!LUA_FAIL}`);
        ws.send(JSON.stringify({ t: "lua", id: m.id, ok: !LUA_FAIL, out }));
      }, 200);
      break;
    }
    case "ping":
      ws.send(JSON.stringify({ t: "pong", ts: Date.now() }));
      break;
    case "err":
      log(`❌ 服务器报错: ${m.msg}`);
      break;
    default:
      log(`← ${m.t}`);
  }
});

ws.on("error", (e) => { log(`❌ ${e.message}`); process.exit(1); });
ws.on("close", (code) => log(`连接关闭 code=${code}`));
