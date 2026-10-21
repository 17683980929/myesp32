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
import { getConfig, CONFIG_PATH } from "./config.mjs";
import { WeatherCache } from "./services/weather.mjs";
import { getHotNews } from "./services/news.mjs";
import { WsGateway } from "./ws-gateway.mjs";
import { handleHttp } from "./http-admin.mjs";
import { reloadSkills } from "./services/skills.mjs";
import { startReminders } from "./services/reminders.mjs";

const config = getConfig();
const weather = new WeatherCache();
const devices = new Set();

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

server.listen(config.server.port, config.server.host, async () => {
  const { port, host, authToken, adminPassword } = config.server;

  console.log("");
  console.log("  ┌────────────────────────────────────────────────┐");
  console.log("  │  MyEsp32 桌面宠物 · 服务器                     │");
  console.log("  └────────────────────────────────────────────────┘");
  console.log(`   配置网页   http://<服务器IP>:${port}/admin`);
  console.log(`   设备连接   ws://<服务器IP>:${port}/device`);
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
