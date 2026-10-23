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

import {
  createReadStream, existsSync, statSync, readFileSync,
  openSync, readSync, closeSync, mkdirSync, writeFileSync, renameSync, unlinkSync, rmSync, cpSync, readdirSync,
} from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { unzipTo } from "./unzip.mjs";
import { ROOT, getConfig, saveConfig, maskedConfig, isMasked } from "./config.mjs";
import { VOICE_GROUPS } from "./voices.mjs";
import { reloadSkills, loadedSkills, skillsError, skillsDir } from "./services/skills.mjs";
import { build } from "./protocol.mjs";

/* OTA 用的应用镜像：把 CI 下载的 myesp32.bin 放到这里即可
 * （我的烧录流程会在解压新包时自动更新它） */
const OTA_APP = path.resolve(ROOT, "../firmware/build/ota-app.bin");

/* 服务端自更新：CI 上传 zip → 管理页应用 → 进程退出由 NSSM 拉起 */
const UPD_DIR = path.join(ROOT, ".update");
const UPD_ZIP = path.join(UPD_DIR, "server.zip");
const UPD_META = path.join(UPD_DIR, "pending.json");
const VERSION_FILE = path.join(ROOT, "VERSION");

/** 读 ESP 镜像里的 app 描述符（0x20 起）：版本号 + 构建日期 */
function appDesc(file = OTA_APP) {
  try {
    const fd = openSync(file, "r");
    const buf = Buffer.alloc(0x100);
    readSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);
    if (buf.readUInt32LE(0x20) !== 0xabcd5432) return null;
    const str = (off, n) => buf.slice(off, off + n).toString("utf8").replace(/\0[\s\S]*$/, "").trim();
    return { version: str(0x30, 32), time: str(0x70, 16), date: str(0x80, 16) };
  } catch { return null; }
}

function otaInfo() {
  if (!existsSync(OTA_APP)) return null;
  const st = statSync(OTA_APP);
  const d = appDesc() || {};
  let version = d.version || "";
  // 描述符里的版本必须是 x.y.z；不是就用老办法扫字符串（兼容没写 PROJECT_VER 的镜像）
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    version = "";
    try {
      // 项目版本永远是 0.1.x；用这个窄模式，避免把内嵌 IP 或库版本当版本号
      const all = readFileSync(OTA_APP).toString("latin1").match(/\b0\.1\.\d+\b/g);
      if (all && all.length) version = all[all.length - 1];
    } catch { /* 忽略 */ }
  }
  const builtMs = d.date && d.time ? Date.parse(d.date + " " + d.time + " UTC") : 0;
  return { size: st.size, mtime: st.mtimeMs, version, builtMs };
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

/** 原样收二进制 body（固件上传用） */
function readRawBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("固件过大")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
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
    /* ── 服务端代码包上传（CI 用，同一个独立 token）───────────── */
    if (p === "/api/server-bundle" && req.method === "POST") {
      const want = String(getConfig().server.uploadToken || "");
      if (!want) return json(res, 403, { ok: false, msg: "服务器未配置 uploadToken" });
      if (String(req.headers["x-fw-token"] || "") !== want)
        return json(res, 403, { ok: false, msg: "token 不对" });

      const buf = await readRawBody(req, 16 * 1024 * 1024);
      mkdirSync(UPD_DIR, { recursive: true });
      writeFileSync(UPD_ZIP, buf);
      const meta = {
        sha: String(req.headers["x-commit"] || "").slice(0, 12),
        at: Date.now(),
        size: buf.length,
      };
      writeFileSync(UPD_META, JSON.stringify(meta));
      log(`服务端包已上传：${meta.sha} ${(buf.length / 1024).toFixed(0)}KB`);
      return json(res, 200, { ok: true, ...meta });
    }

    /* ── 固件上传（CI 直传，独立 token，不走网页密码）───────────── */
    if (p === "/api/firmware" && req.method === "POST") {
      const want = String(getConfig().server.uploadToken || "");
      if (!want) return json(res, 403, { ok: false, msg: "服务器未配置 uploadToken" });
      if (String(req.headers["x-fw-token"] || "") !== want)
        return json(res, 403, { ok: false, msg: "token 不对" });

      const buf = await readRawBody(req);
      if (buf.length < 0x100 || buf.readUInt32LE(0x20) !== 0xabcd5432)
        return json(res, 400, { ok: false, msg: "不是 ESP 固件镜像" });

      mkdirSync(path.dirname(OTA_APP), { recursive: true });
      const tmp = OTA_APP + ".tmp";
      writeFileSync(tmp, buf);
      // Windows 上 rename 偶尔被杀毒/索引服务短暂占用（EPERM）：重试几次，
      // 仍失败就直接覆盖写，别让一次瞬时锁把 CI 上传打回 500
      let moved = false;
      for (let i = 0; i < 5 && !moved; i++) {
        try { renameSync(tmp, OTA_APP); moved = true; }
        catch (e) {
          if (i === 4) {
            writeFileSync(OTA_APP, buf);
            try { unlinkSync(tmp); } catch { /* 忽略 */ }
            moved = true;
            log("rename 失败（" + (e.code || e.message) + "），已改为直接覆盖写入");
          } else {
            await new Promise((r) => setTimeout(r, 200));
          }
        }
      }
      const info = otaInfo();
      log(`固件已更新：${info.version} ${(buf.length / 1048576).toFixed(2)}MB ${info.built}`);
      return json(res, 200, { ok: true, ...info });
    }

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

      if (p === "/api/server-update" && req.method === "GET") {
        const pending = existsSync(UPD_META) ? JSON.parse(readFileSync(UPD_META, "utf8")) : null;
        const current = existsSync(VERSION_FILE) ? readFileSync(VERSION_FILE, "utf8").trim() : "";
        return json(res, 200, { pending, current });
      }

      if (p === "/api/server-update/apply" && req.method === "POST") {
        if (!existsSync(UPD_ZIP) || !existsSync(UPD_META))
          return json(res, 400, { ok: false, msg: "没有待应用的服务端包" });
        const meta = JSON.parse(readFileSync(UPD_META, "utf8"));
        const stage = path.join(UPD_DIR, "stage");
        const bak = path.join(UPD_DIR, "bak");
        rmSync(stage, { recursive: true, force: true });
        rmSync(bak, { recursive: true, force: true });
        const files = unzipTo(readFileSync(UPD_ZIP), stage, {
          allowPrefix: ["server/src/", "server/skills/", "server/data/", "web/", "server/package"],
        });
        const js = files.filter((f) => f.endsWith(".mjs"));
        if (!js.length) return json(res, 400, { ok: false, msg: "包里没有 .mjs，拒绝应用" });
        try {
          for (const f of js) execFileSync(process.execPath, ["--check", path.join(stage, f)], { stdio: "pipe" });
        } catch (e) {
          return json(res, 400, { ok: false, msg: "语法检查失败，已放弃：" + (e.stderr || e.message).toString().slice(0, 200) });
        }

        mkdirSync(bak, { recursive: true });
        const swapDir = (rel) => {
          const from = path.join(stage, rel);
          const live = path.resolve(ROOT, "..", rel);
          if (!existsSync(from)) return;
          if (existsSync(live)) renameSync(live, path.join(bak, rel.replace(/[\/]/g, "_")));
          renameSync(from, live);
        };
        try {
          ["server/src", "server/skills", "web"].forEach(swapDir);
          const dataFrom = path.join(stage, "server/data");
          if (existsSync(dataFrom)) cpSync(dataFrom, path.join(ROOT, "data"), { recursive: true, force: true });
          for (const f of ["package.json", "package-lock.json"]) {
            const from = path.join(stage, "server", f);
            if (existsSync(from)) cpSync(from, path.join(ROOT, f), { force: true });
          }
        } catch (e) {
          log("应用失败：" + e.message + "（备份在 .update/bak）");
          return json(res, 500, { ok: false, msg: "应用失败：" + e.message });
        }

        writeFileSync(VERSION_FILE, meta.sha + " " + new Date(meta.at).toISOString() + "\n");
        rmSync(UPD_ZIP, { force: true });
        rmSync(UPD_META, { force: true });
        log(`服务端已更新到 ${meta.sha}，重启中`);
        json(res, 200, { ok: true, sha: meta.sha });
        setTimeout(() => process.exit(0), 600);   /* NSSM 会自动拉起 */
        return;
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

      if (p === "/api/evt" && req.method === "POST") {
        const { n } = JSON.parse(await readBody(req));
        if (!n) return json(res, 400, { ok: false, msg: "缺少 n" });
        const list = [...ctx.devices];
        for (const d of list) d.send(build.evt(String(n)));
        log(`下发事件 ${n} → ${list.length} 台`);
        return json(res, 200, { ok: true, sent: list.length, n });
      }

      if (p === "/api/skills" && req.method === "GET") {
        return json(res, 200, {
          dir: skillsDir(),
          error: skillsError(),
          skills: loadedSkills().map((s) => ({
            name: s.name, description: s.description, file: s.file,
            method: s.type === "docs" ? "docs" : String(s.request.method || "GET").toUpperCase(),
            url: s.type === "docs" ? s.dir : s.request.url,
          })),
        });
      }

      if (p === "/api/skills/reload" && req.method === "POST") {
        const list = reloadSkills();
        log(`重载技能 → ${list.length} 个${skillsError() ? "（有错误：" + skillsError() + "）" : ""}`);
        return json(res, 200, {
          ok: true, count: list.length, error: skillsError(),
          skills: list.map((s) => ({ name: s.name, description: s.description, file: s.file })),
        });
      }

      if (p === "/api/ota" && req.method === "GET") {
        const file = otaInfo();
        return json(res, 200, {
          file,
          devices: [...ctx.devices].map((d) => ({
            sid: d.sid, fw: d.fw, ota: d.ota,
            updatable: !!(file && file.version && d.fw && d.fw !== file.version),
          })),
        });
      }

      if (p === "/api/ota" && req.method === "POST") {
        const list = [...ctx.devices];
        if (!list.length) return json(res, 400, { ok: false, msg: "没有在线设备" });
        if (!existsSync(OTA_APP)) return json(res, 400, { ok: false, msg: "服务器上没有固件（把 myesp32.bin 放到 firmware/build/ota-app.bin）" });

        /* 云服务器上"设备连接看到的本地地址"是内网 IP，必须用配置的公网地址；
         * 局域网部署留空时再退回本地地址 */
        const base = String(getConfig().server.publicUrl || "").replace(/\/+$/, "");
        const localIp = list[0].ws?._socket?.localAddress;
        const port = req.socket.localPort || 8080;
        const host = localIp ? `${localIp}:${port}` : (req.headers.host || `127.0.0.1:${port}`);
        const dst = base ? `${base}/firmware/app.bin` : `http://${host}/firmware/app.bin`;

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
