/**
 * index.mjs — 启动入口
 *
 * 一个 HTTP 服务同时承担：
 *   - 配置网页（/admin）与 REST API（/api/*）
 *   - 设备 WebSocket 网关（/device）
 *
 * 所以对外只需要开一个端口。
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { getConfig, CONFIG_PATH } from "./config.mjs";
import { WeatherCache } from "./services/weather.mjs";
import { getHotNews } from "./services/news.mjs";
import { WsGateway } from "./ws-gateway.mjs";
import { handleHttp } from "./http-admin.mjs";
import { reloadSkills } from "./services/skills.mjs";
import { startReminders } from "./services/reminders.mjs";

/* 进程级兜底：这个进程是 nginx 的唯一上游，一退出管理页立刻 502。
 * 崩溃原因除了走 stderr（run-loop 重定向到 server.err.log），再单独落一份
 * crash.log —— 防止重定向失效、日志轮转或守护把 stderr 丢掉时没有证据。
 * 未捕获异常记录后退出，交给 NSSM / run-loop 拉起；
 * unhandledRejection 只记日志不退出，避免单个异步请求把整站带走。 */
const CRASH_LOG = path.join(path.dirname(CONFIG_PATH), "crash.log");
const CRASH_MAX_BYTES = 512 * 1024;

/** 生命周期事件落盘： boot / health / exit / fatal / stall 全写同一份文件。
 *  同步 append，进程被外部硬杀（TerminateProcess / 关控制台）之前也能留下
 *  「最后存活时间」——旧版只有 uncaughtException 才写，无声死亡完全没证据。 */
function writeLife(kind, detail = "") {
  const line = `[${new Date().toISOString()}] ${kind} pid=${process.pid} ` +
               `uptime=${Math.round(process.uptime())}s ${detail}\n`;
  try {
    const st = fs.statSync(CRASH_LOG);
    if (st.size > CRASH_MAX_BYTES) {
      /* 轮转：保留后半，避免管理页 tail 256KB 只剩几个月前的旧记录 */
      const buf = fs.readFileSync(CRASH_LOG);
      fs.writeFileSync(CRASH_LOG, buf.subarray(Math.max(0, buf.length - CRASH_MAX_BYTES / 2)));
    }
  } catch { /* 文件不存在 / 读写失败都不影响主流程 */ }
  try { fs.appendFileSync(CRASH_LOG, line, "utf8"); } catch { /* ignore */ }
}
function writeCrash(kind, e) {
  writeLife(kind, "");
  const detail = (e?.stack || e?.message || String(e)) + "\n\n";
  try { fs.appendFileSync(CRASH_LOG, detail, "utf8"); } catch { /* ignore */ }
}
process.on("exit", (code) => {
  try {
    console.log(`[exit] code=${code} at=${new Date().toISOString()}`);
  } catch {
    /* 退出阶段 stdout 可能已关闭 */
  }
  writeLife("exit", `code=${code}`);
});
process.on("unhandledRejection", (e) => {
  console.error("[fatal] unhandledRejection:", e?.stack || e?.message || e);
});
process.on("uncaughtException", (e) => {
  console.error("[fatal] uncaughtException:", e?.stack || e?.message || e);
  writeCrash("uncaughtException", e);
  setTimeout(() => process.exit(1), 100);
});

const config = getConfig();
const weather = new WeatherCache();
const devices = new Set();

/* 崩溃排查：每次启动记一行，之后每 2 分钟记一次内存 + 在线会话数。
 * 半夜挂掉时，最后几条 [health] 能看出是不是内存/会话数一路涨到爆。
 * rss 超过阈值就主动退出让守护拉起：被系统 OOM 硬杀通常连日志都留不下。 */
console.log(`[boot] pid=${process.pid} node=${process.version} at=${new Date().toISOString()}`);
writeLife("boot", `node=${process.version}`);
const RSS_LIMIT_MB = Number(process.env.MYESP32_RSS_LIMIT_MB) || 512;
setInterval(() => {
  const m = process.memoryUsage();
  const rssMB = Math.round(m.rss / 1048576);
  const at = new Date().toISOString();
  console.log(
    `[health] at=${at} uptime=${Math.round(process.uptime())}s ` +
    `rss=${rssMB}MB heap=${Math.round(m.heapUsed / 1048576)}MB devices=${devices.size}`
  );
  writeLife("health", `rss=${rssMB}MB heap=${Math.round(m.heapUsed / 1048576)}MB devices=${devices.size}`);
  if (rssMB > RSS_LIMIT_MB) {
    const msg = `rss ${rssMB}MB 超过阈值 ${RSS_LIMIT_MB}MB，主动退出让守护拉起`;
    console.error(`[fatal] ${msg}`);
    writeCrash("rss-limit", msg);
    setTimeout(() => process.exit(1), 100);
  }
}, 2 * 60 * 1000).unref();

/* event loop 假死检测：进程还在、但 HTTP 不再响应时 nginx 同样报 502，
 * 而且这种情况不会触发 uncaughtException / exit，旧版完全留不下证据。
 * 定时器依赖同一个 loop，卡住期间两个都不跑；一旦恢复，时间漂移会被
 * 检查到，于是主动退出让 NSSM 拉起（比留一个半死不活的进程好）。 */
const STALL_MS = Number(process.env.MYESP32_STALL_MS) || 60_000;
let lastTick = Date.now();
setInterval(() => { lastTick = Date.now(); }, 1000).unref();
setInterval(() => {
  const gap = Date.now() - lastTick;
  if (gap > STALL_MS) {
    writeLife("stall", `event-loop 卡住 ${gap}ms`);
    console.error(`[fatal] event-loop 卡住 ${gap}ms，主动退出让守护拉起`);
    setTimeout(() => process.exit(1), 100);
  }
}, 5000).unref();

const ctx = { config, weather, devices };

/* 新闻缓存预热：第一次“查新闻”不用等网络 */
getHotNews(config.news ?? {}).catch(() => {});

const server = http.createServer((req, res) => {
  handleHttp(req, res, ctx).catch((e) => {
    console.error("[http] 未捕获异常:", e.message);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});

ctx.gateway = new WsGateway(server, ctx);
startReminders(ctx);

const skillList = reloadSkills();
if (skillList.length) console.log(`[skills] 已加载 ${skillList.length} 个声明式技能`);

/* 设备专用端口：只跑 WS，不暴露管理页/API（公网部署时 8080 可以只绑 127.0.0.1） */
const { devicePort, deviceHost } = config.server;
if (devicePort && devicePort !== config.server.port) {
  const devServer = http.createServer((req, res) => {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("device port");
  });
  ctx.deviceGateway = new WsGateway(devServer, ctx);
  devServer.listen(devicePort, deviceHost, () => {
    console.log(`   设备直连   ws://<公网IP>:${devicePort}/device（不经 nginx）`);
  });
}

server.listen(config.server.port, config.server.host, async () => {
  const { port, host, authToken, adminPassword } = config.server;

  console.log("");
  console.log("  ┌────────────────────────────────────────────────┐");
  console.log("  │  MyEsp32 桌面宠物 · 服务器                     │");
  console.log("  └────────────────────────────────────────────────┘");
  console.log(`   配置网页   http://${host}:${port}/admin${host === "127.0.0.1" ? "（只本机，请走 nginx）" : ""}`);
  console.log(`   设备连接   ws://<公网IP>:${config.server.devicePort || port}/device`);
  console.log(`   配置文件   ${CONFIG_PATH}`);
  console.log("");
  console.log(`   设备鉴权   ${authToken ? "已开启（token）" : "⚠ 未开启，任何人都能连"}`);
  console.log(`   网页密码   ${adminPassword ? "已开启" : "⚠ 未开启，公网必须设置"}`);
  console.log(`   LLM        ${config.llm.model} ${config.llm.apiKey ? "✓" : "⚠ 未配置 Key"}`);
  console.log(`   ASR        ${config.asr.provider} ${config.asr.secretKey ? "✓" : "⚠ 未配置密钥"}`);
  console.log(`   TTS        ${config.tts.provider}`);
  console.log(`   天气       ${config.weather.enabled ? config.weather.city : "已关闭"}`);
  console.log("");

  /* 预热天气缓存，省得第一台设备连上时没数据 */
  if (config.weather.enabled) {
    weather.get(config.weather).catch(() => {});
  }
});

/* 优雅退出 */
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`\n收到 ${sig}，正在退出…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
  });
}
