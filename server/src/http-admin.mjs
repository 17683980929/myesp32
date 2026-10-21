/**
 * http-admin.mjs — 配置网页 + REST API
 *
 * 路由：
 *   GET  /admin              配置网页
 *   GET  /api/config         读配置（密钥脱敏）
 *   POST /api/config         保存配置
 *   GET  /api/status         运行状态（在线设备、天气缓存）
 *   POST /api/weather/refresh 强制刷一次天气
 *   POST /api/say            让在线设备播报一句话（调试/通知）
 *   POST /api/lua            下发 Lua 脚本
 *   GET  /api/lua            读当前脚本
 *   GET  /                   静态文件（web/ 目录）
 *
 * 鉴权：配置了 server.adminPassword 就走 HTTP Basic（浏览器原生支持）。
 */

import { createReadStream, existsSync, statSync, readFileSync } from "node:fs";
import path from "node:path";
import { ROOT, getConfig, saveConfig, maskedConfig, isMasked } from "./config.mjs";
import { VOICE_GROUPS } from "./voices.mjs";

/* OTA 用的应用镜像：把 CI 下载的 myesp32.bin 放到这里即可
 * （我的烧录流程会在解压新包时自动更新它） */
const OTA_APP = path.resolve(ROOT, "../firmware/build/ota-app.bin");

function otaInfo() {
  if (!existsSync(OTA_APP)) return null;
  const st = statSync(OTA_APP);
  let version = "";
  try {
    const s = readFileSync(OTA_APP).toString("latin1");
    const all = s.match(/0\.1\.\d+/g);
    if (all && all.length) version = all[all.length - 1];
  } catch { /* 读不到就不显示版本 */ }
  return { size: st.size, mtime: st.mtimeMs, version };
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const WEB_ROOT = path.resolve(ROOT, "..", "web");
const log = (...a) => console.log("[http]", ...a);

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readBody(req, limit = 1024 * 512) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("请求体过大")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** HTTP Basic 校验 */
function checkAuth(req, res) {
  const cfg = getConfig();
  const pwd = cfg.server.adminPassword;
  if (!pwd) return true;

  const h = req.headers["authorization"] || "";
  if (h.startsWith("Basic ")) {
    const raw = Buffer.from(h.slice(6), "base64").toString("utf8");
    const idx = raw.indexOf(":");
    const pass = idx >= 0 ? raw.slice(idx + 1) : "";
    if (pass === pwd) return true;
  }

  res.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="MyEsp32 Admin", charset="UTF-8"',
    "Content-Type": "text/plain; charset=utf-8",
  });
  res.end("需要密码");
  return false;
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === "/" ? "/admin.html" : urlPath;
  const file = path.join(WEB_ROOT, path.normalize(rel).replace(/^([/\\])+/, ""));

  if (!file.startsWith(WEB_ROOT) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
    return;
  }

  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Content-Length": statSync(file).size,
  });
  createReadStream(file).pipe(res);
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {{config:object, weather:object, devices:Set, gateway:object}} ctx
 */
export async function handleHttp(req, res, ctx) {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;

  /* ── 固件下载（设备 OTA 用；不带鉴权，设备没有密码）────────────── */
  if (p === "/firmware/app.bin" && req.method === "GET") {
    if (!existsSync(OTA_APP)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("no firmware");
      return;
    }
    const st = statSync(OTA_APP);
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": st.size,
    });
    createReadStream(OTA_APP).pipe(res);
    return;
  }

  try {
    /* ── API ──────────────────────────────────────────────────────── */
    if (p.startsWith("/api/")) {
      if (!checkAuth(req, res)) return;

      if (p === "/api/voices" && req.method === "GET") {
        return json(res, 200, { groups: VOICE_GROUPS });
      }

      if (p === "/api/config" && req.method === "GET") {
        return json(res, 200, maskedConfig());
      }

      if (p === "/api/config" && req.method === "POST") {
        const body = JSON.parse(await readBody(req));

        /* 脱敏占位（••••）表示"这一项没改"，剔掉这些字段，
           否则会把占位符当成真密钥存进配置 */
        const stripMasked = (obj) => {
          for (const [k, v] of Object.entries(obj)) {
            if (v && typeof v === "object" && !Array.isArray(v)) stripMasked(v);
            else if (isMasked(v)) delete obj[k];
          }
          return obj;
        };

        saveConfig(stripMasked(body));
        log("配置已更新");
        return json(res, 200, { ok: true, config: maskedConfig() });
      }

      if (p === "/api/status" && req.method === "GET") {
        return json(res, 200, {
          uptimeSec: Math.round(process.uptime()),
          devices: [...ctx.devices].map((d) => ({
            sid: d.sid,
            mac: d.mac,
            fw: d.fw,
            page: d.page,
            busy: d.busy,
            recording: d.recording,
            stat: d.lastStat,
            ota: d.ota,
          })),
          weather: ctx.weather.data,
          weatherError: ctx.weather.lastError,
        });
      }

      if (p === "/api/weather/refresh" && req.method === "POST") {
        ctx.weather.fetchedAt = 0;
        const w = await ctx.weather.get(getConfig().weather);
        return json(res, 200, { ok: !!w, weather: w, error: ctx.weather.lastError });
      }

      if (p === "/api/say" && req.method === "POST") {
        const { text } = JSON.parse(await readBody(req));
        if (typeof text !== "string" || !text.trim())
          return json(res, 400, { ok: false, msg: "缺少 text" });
        const list = [...ctx.devices];
        for (const d of list) d.speakOne(text.trim()).catch(() => {});
        log(`让设备播报 → ${list.length} 台`);
        return json(res, 200, { ok: true, sent: list.length });
      }

      if (p === "/api/lua" && req.method === "GET") {
        return json(res, 200, getConfig().lua);
      }

      if (p === "/api/lua" && req.method === "POST") {
        const { code } = JSON.parse(await readBody(req));
        if (typeof code !== "string") return json(res, 400, { ok: false, msg: "缺少 code" });
        if (code.length > 6000)
          return json(res, 400, { ok: false, msg: `脚本过长（${code.length} 字符，上限 6000）` });

        const cfg = getConfig();
        saveConfig({ lua: { prevScript: cfg.lua.activeScript, activeScript: code } });

        /* 推给所有在线设备，等执行回执（每台最多 8 秒；热点/弱网回执可能慢） */
        const id = Date.now() % 100000;
        const list = [...ctx.devices];
        if (!list.length) {
          log("下发 Lua 脚本 → 0 台设备（已保存）");
          return json(res, 200, { ok: true, sent: 0, id, results: [] });
        }
        const results = await Promise.all(list.map((d) => d.sendLua(id, code, 8000)));
        log(`下发 Lua 脚本 → ${list.length} 台设备：${results.map((r) => (r.ok ? "成功" : r.timeout ? "回执超时" : "失败")).join(" ")}`);
        return json(res, 200, { ok: true, sent: list.length, id, results });
      }

      if (p === "/api/ota" && req.method === "GET") {
        return json(res, 200, {
          file: otaInfo(),
          devices: [...ctx.devices].map((d) => ({ sid: d.sid, fw: d.fw, ota: d.ota })),
        });
      }

      if (p === "/api/ota" && req.method === "POST") {
        const list = [...ctx.devices];
        if (!list.length) return json(res, 400, { ok: false, msg: "没有在线设备" });
        if (!existsSync(OTA_APP)) return json(res, 400, { ok: false, msg: "服务器上没有固件（把 myesp32.bin 放到 firmware/build/ota-app.bin）" });

        /* 用设备这条连接上的服务器地址：设备就是从那个 IP 连过来的，一定可达 */
        const localIp = list[0].ws?._socket?.localAddress;
        const port = req.socket.localPort || 8080;
        const host = localIp ? `${localIp}:${port}` : (req.headers.host || `127.0.0.1:${port}`);
        const dst = `http://${host}/firmware/app.bin`;

        for (const d of list) d.startOta(dst);
        log(`推送 OTA → ${list.length} 台：${dst}`);
        return json(res, 200, { ok: true, sent: list.length, url: dst, file: otaInfo() });
      }

      return json(res, 404, { ok: false, msg: "未知接口" });
    }

    /* ── 静态页面 ─────────────────────────────────────────────────── */
    if (p === "/admin" || p === "/admin/") {
      if (!checkAuth(req, res)) return;
      return serveStatic(req, res, "/admin.html");
    }

    return serveStatic(req, res, p);
  } catch (e) {
    log(`请求异常 ${p}: ${e.message}`);
    json(res, 500, { ok: false, msg: e.message });
  }
}
