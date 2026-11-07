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
import { reloadSkills, loadedSkills, skillsError, skillsDir, saveSkill, deleteSkill } from "./services/skills.mjs";
import { listParcels, addParcel, removeParcel } from "./services/parcels.mjs";
import { parseSms } from "./services/parcel-sms.mjs";
import { loadTimetableRaw, timetablePath } from "./services/timetable.mjs";
import { generateLuaProposal, validateLua, luaBaseHash } from "./services/lua-ai.mjs";
import { build } from "./protocol.mjs";
import { opusStatus, textToOpusFrames, textToPcm16k, pcmToWav } from "./services/tts.mjs";
import { createASR } from "./services/asr.mjs";

/* OTA 用的应用镜像：把 CI 下载的 myesp32.bin 放到这里即可
 * （我的烧录流程会在解压新包时自动更新它） */
const OTA_APP = path.resolve(ROOT, "../firmware/build/ota-app.bin");

/* 服务端自更新：CI 上传 zip → 管理页应用 → 进程退出由 NSSM 拉起 */
const UPD_DIR = path.join(ROOT, ".update");
const UPD_ZIP = path.join(UPD_DIR, "server.zip");
const UPD_META = path.join(UPD_DIR, "pending.json");
const VERSION_FILE = path.join(ROOT, "VERSION");

/* 运行日志：run-loop.cmd 把 stdout/stderr 重定向到 server 根目录。
 * 管理页只读最后 256KB，避免日志涨到几十 MB 时把内存打满。
 *
 * 仓库里那份 run-loop.cmd 是写 firmware/build/ 的，云上部署版写 server/ 旁边，
 * 两种都可能出现。同名文件取**较新的那份**——否则面板会一直停在几个月前的旧日志上。 */
const LOG_FILES = [
  { name: "server.log", file: path.join(ROOT, "server.log") },
  { name: "server.err.log", file: path.join(ROOT, "server.err.log") },
  { name: "supervisor.log", file: path.join(ROOT, "supervisor.log") },
  { name: "server.log", file: path.join(ROOT, "..", "firmware", "build", "server.log") },
  { name: "supervisor.log", file: path.join(ROOT, "..", "firmware", "build", "supervisor.log") },
];

function pickLogFiles() {
  const byName = new Map();
  for (const c of LOG_FILES) {
    let mtime = -1;
    try { mtime = statSync(c.file).mtimeMs; } catch { /* 不存在 */ }
    const prev = byName.get(c.name);
    if (!prev || mtime > prev.mtime) byName.set(c.name, { ...c, mtime });
  }
  return [...byName.values()];
}

function tailLog(file, maxLines) {
  if (!existsSync(file)) return "(没有这个日志文件)";
  try {
    const st = statSync(file);
    const maxBytes = 256 * 1024;
    const fd = openSync(file, "r");
    let text;
    try {
      let start = Math.max(0, st.size - maxBytes);
      const len = st.size - start;
      if (len <= 0) return "";
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, start);

      /* 编码判定：NSSM / PowerShell 重定向写出来的日志是 UTF-16LE 且**没有 BOM**，
       * 只按 BOM 判断会把中文全解成乱码（面板上就是一堆方块）。
       * 取开头 4KB 统计奇/偶字节里的 0：UTF-16LE 的 ASCII 字符高字节恒为 0，
       * 偶数字节里几乎没有 0，据此区分。命中后按 2 字节对齐再解码。 */
      const n = Math.min(buf.length, 4096);
      let oddZero = 0, evenZero = 0;
      for (let i = 0; i < n; i++) {
        if (buf[i] === 0) { if (i % 2) oddZero++; else evenZero++; }
      }
      const bom16 = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe;
      const utf16 = bom16 || (oddZero > n * 0.25 && evenZero < n * 0.05);

      let body = buf;
      if (utf16) {
        if (body[0] === 0xff && body[1] === 0xfe) body = body.subarray(2);
        if (start % 2) body = body.subarray(1);   /* 切在半个字符上会整体错位 */
        text = body.toString("utf16le");
      } else {
        text = body.toString("utf8");
        /* cmd 的 >> 重定向按系统代码页（中文 Windows 是 GBK）原样写入，
         * 用 UTF-8 解会变成一堆 �；这时改按 GBK 再试一次，谁的错误少用谁。
         * supervisor.log 里的“周一”就是这么来的。 */
        if (text.includes("\uFFFD")) {
          const bad = (s) => (s.match(/\uFFFD/g) || []).length;
          try {
            const g = new TextDecoder("gbk").decode(body);
            if (bad(g) < bad(text)) text = g;
          } catch { /* 环境没有 ICU：维持 UTF-8 */ }
        }
      }
    } finally {
      closeSync(fd);
    }
    text = text.replace(/^\uFEFF/, "");
    return text.split(/\r?\n/).slice(-maxLines).join("\n");
  } catch (e) {
    return `读取失败：${e.message}`;
  }
}

/** 同一台设备可能残留多个 WS 会话（半开 TCP/重连）：按 MAC 去重，保留最近有上行的 */
function uniqueDevices(devices) {
  const byKey = new Map();
  for (const d of devices) {
    const key = d.mac || d.sid;
    const prev = byKey.get(key);
    if (!prev || (d.lastRxAt || 0) > (prev.lastRxAt || 0)) byKey.set(key, d);
  }
  return [...byKey.values()];
}

/* ── 创造模式：Lua AI 后台任务 ───────────────────────────────────────
 * 模型生成可能跑 30~90 秒，不能挂在 HTTP 请求上（nginx 会 504）。
 * POST /api/lua/ai 只启动任务，管理页轮询 /api/lua/ai/status 拿步骤和结果。 */
const luaJobs = new Map();
let luaJobSeq = 0;
let luaJobRunning = 0;
const MAX_AUTO_REPAIR = 2;   /* 设备报错后最多自动重新生成 2 次 */

function currentLuaScript() {
  const cfg = getConfig();
  if (cfg.lua?.activeScript) return cfg.lua.activeScript;
  const tpl = path.join(ROOT, "data/framework.lua");
  return existsSync(tpl) ? readFileSync(tpl, "utf8") : "";
}

function makeLuaRepairRequest(request, code, error) {
  return (
    `用户原始需求：${request}\n\n` +
    `上一版脚本已通过静态校验，但设备预检查/加载失败：\n${error}\n\n` +
    `上一版脚本（供参考）：\n\`\`\`lua\n${code}\n\`\`\`\n\n` +
    `请基于当前脚本重新实现原需求，修复这个错误，输出完整脚本。`
  );
}

function startLuaJob({ request, current, llm }) {
  const id = ++luaJobSeq;
  const job = {
    id,
    status: "running",
    startedAt: Date.now(),
    steps: [{ at: Date.now(), text: "已读取当前脚本" }],
    result: null,
    error: null,
  };
  luaJobs.set(id, job);
  luaJobRunning++;

  const step = (text) => {
    job.steps.push({ at: Date.now(), text });
    if (job.steps.length > 20) job.steps.shift();
  };

  (async () => {
    try {
      const result = await generateLuaProposal({ request, current, llm, onStep: step });
      job.result = {
        ...result,
        baseHash: luaBaseHash(current),
        currentLen: current.length,
      };
      job.status = "done";
    } catch (e) {
      job.error = e.message || String(e);
      job.status = "error";
    } finally {
      luaJobRunning--;
      const t = setTimeout(() => luaJobs.delete(id), 10 * 60 * 1000);
      t.unref?.();
    }
  })();

  return job;
}

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

/** 读 WAV 头算时长（秒）；不是 WAV 或读不到返回 null */
function wavSeconds(file) {
  let fd;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, 8192, 0);
    if (n < 44 || buf.toString("ascii", 0, 4) !== "RIFF") return null;
    let off = 12, byteRate = 0, dataSize = 0;
    while (off + 8 <= n) {
      const id = buf.toString("ascii", off, off + 4);
      const sz = buf.readUInt32LE(off + 4);
      if (id === "fmt " && off + 20 <= n) byteRate = buf.readUInt32LE(off + 16);
      else if (id === "data") { dataSize = sz; break; }
      off += 8 + sz + (sz & 1);
    }
    if (!byteRate || !dataSize) return null;
    return Math.round((dataSize / byteRate) * 10) / 10;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* 已关 */ } }
  }
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

    /* ── 快递短信转发（手机端 SmsForwarder / 快捷指令，独立 token）──
     * 不走网页密码：手机转发器塞不进登录态。token 只允许"加单号"，不能读配置。 */
    if (p === "/api/parcel-hook" && req.method === "POST") {
      const want = String(getConfig().express?.hookToken || "");
      if (!want) return json(res, 403, { ok: false, msg: "未配置 hookToken" });
      const token = String(url.searchParams.get("token") || req.headers["x-parcel-token"] || "");
      if (token !== want) return json(res, 403, { ok: false, msg: "token 不对" });

      const raw = await readBody(req);
      let text = raw;
      try {
        const j = JSON.parse(raw);
        text = String(j.text || j.content || j.msg || j.message || j.sms || raw);
      } catch {
        /* 有些转发器发的是表单：text=...&from=... */
        if (/^(text|content|msg|message|sms)=/i.test(raw.trim())) {
          const q = new URLSearchParams(raw);
          text = q.get("text") || q.get("content") || q.get("msg") || q.get("message") || q.get("sms") || raw;
        }
      }
      const list = parseSms(text);
      if (!list.length) return json(res, 200, { ok: true, added: 0, msg: "没有识别到快递单号" });

      let added = 0;
      for (const it of list) if (addParcel(it.number, it.carrier, "短信")) added++;
      log(`短信导入快递 ${added} 个`);
      return json(res, 200, {
        ok: true, added, total: listParcels().length,
        numbers: list.map((x) => x.number),
      });
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

      if (p === "/api/logs" && req.method === "GET") {
        const n = Math.min(500, Math.max(20, Number(url.searchParams.get("lines")) || 200));
        return json(res, 200, {
          pid: process.pid,
          uptimeSec: Math.round(process.uptime()),
          files: pickLogFiles().map((x) => ({ name: x.name, path: x.file, text: tailLog(x.file, n) })),
        });
      }

      if (p === "/api/status" && req.method === "GET") {
        return json(res, 200, {
          uptimeSec: Math.round(process.uptime()),
          devices: uniqueDevices(ctx.devices).map((d) => ({
            sid: d.sid,
            mac: d.mac,
            fw: d.fw,
            page: d.page,
            busy: d.busy,
            recording: d.recording,
            stat: d.lastStat,
            presence: d.presence?.snapshot?.() ?? null,
            ota: d.ota,
          })),
          weather: ctx.weather.data,
          weatherError: ctx.weather.lastError,
          voice: opusStatus(),   /* opus 解码器是否可用：为 false 时设备会说"语音识别暂不可用" */
        });
      }

      if (p === "/api/weather/refresh" && req.method === "POST") {
        ctx.weather.fetchedAt = 0;
        const w = await ctx.weather.get(getConfig().weather);
        return json(res, 200, { ok: !!w, weather: w, error: ctx.weather.lastError });
      }

      /* 语音合成试听。
       * 默认只回时长/帧数；带 audio:true 直接回 WAV 给浏览器播放，这样能真听到音色对不对。
       * engine:"local" 是管理页「本地 TTS」卡片的试听专用：强制走本地并关掉回退，
       * 否则本地服务挂了会静默用云端音色合成成功，页面却显示 local，极难排查。
       * 失败把原始错误带回去。 */
      if (p === "/api/tts/test" && req.method === "POST") {
        let text = "你好，我是小智，这是语音合成的测试。";
        let wantAudio = false;
        let strictLocal = false;
        try {
          const j = JSON.parse(await readBody(req) || "{}");
          if (typeof j.text === "string" && j.text.trim()) text = j.text.trim().slice(0, 200);
          wantAudio = j.audio === true || j.audio === 1;
          strictLocal = j.engine === "local";
        } catch { /* 用默认文本 */ }
        let tts = getConfig().tts || {};
        if (strictLocal) {
          tts = {
            ...tts,
            provider: "local",
            strict: true,
            local: { ...(tts.local || {}), fallback: false },
          };
        }
        const t0 = Date.now();
        try {
          if (wantAudio) {
            const pcm = await textToPcm16k(text, tts);
            const wav = pcmToWav(pcm);
            res.writeHead(200, {
              "Content-Type": "audio/wav",
              "Content-Length": wav.length,
              "Cache-Control": "no-store",
              "X-Tts-Ms": String(Date.now() - t0),
              "X-Tts-Provider": String(tts.provider || "baidu"),
              "X-Tts-Strict": strictLocal ? "1" : "0",
            });
            return res.end(wav);
          }
          const r = await textToOpusFrames(text, tts);
          return json(res, 200, {
            ok: true, ms: Date.now() - t0, provider: tts.provider,
            frames: r.frames.length, durationMs: Math.round(r.durationMs),
          });
        } catch (e) {
          return json(res, 200, { ok: false, ms: Date.now() - t0, provider: tts.provider, msg: e.message });
        }
      }

      /* 语音链路自检：合成一句固定文本 → 再送 ASR 识别，闭环验证
       * TTS 引擎、音频格式、ASR 鉴权，全程不用设备/麦克风。
       * 分阶段计时，挂了能直接看出是 TTS 还是 ASR 的问题。 */
      if (p === "/api/asr/test" && req.method === "POST") {
        const expected = "今天天气怎么样";
        const t0 = Date.now();
        let pcm;
        try {
          pcm = await textToPcm16k(expected, getConfig().tts || {});
        } catch (e) {
          return json(res, 200, { ok: false, stage: "tts", msg: `TTS 合成失败：${e.message}` });
        }
        const ttsMs = Date.now() - t0;
        const t1 = Date.now();
        try {
          const asr = createASR(getConfig().asr);
          const r = await asr.recognize(pcm, { timeoutMs: 15000 });
          const got = String(r.text || "");
          const norm = (s) => s.replace(/[，。！？、,.!?\s]/g, "");
          return json(res, 200, {
            ok: true, ttsMs, asrMs: Date.now() - t1,
            provider: (getConfig().tts || {}).provider || "baidu",
            expected, got, match: norm(got) === norm(expected),
            bytes: pcm.length,
          });
        } catch (e) {
          return json(res, 200, {
            ok: false, stage: "asr", ttsMs, asrMs: Date.now() - t1, msg: e.message,
          });
        }
      }

      /* 参考音频列表：扫当前 refAudioPath 所在目录，给管理页做下拉用。
       * GPT-SoVITS 的音色就是靠这个文件决定的，选文件比手打绝对路径靠谱。 */
      if (p === "/api/tts/refs" && req.method === "GET") {
        const q = new URL(req.url, "http://x").searchParams;
        const lo = getConfig().tts?.local || {};
        const cur = String(lo.refAudioPath || "").replace(/\\/g, "/").replace(/\/{2,}/g, "/");
        let dir = (q.get("dir") || "").trim();
        if (!dir && cur) dir = path.dirname(cur);
        /* TTS 在另一台机器时（frp / Tailscale），这里扫的是本机目录，列出来的文件没有意义 */
        let remote = "";
        try {
          const u = new URL(lo.baseUrl || "");
          if (u.hostname && !["127.0.0.1", "localhost", "[::1]", "::1"].includes(u.hostname)) remote = u.hostname;
        } catch { /* 地址为空或写错，按本机处理 */ }
        if (remote) {
          return json(res, 200, {
            ok: false, remote: true, dir, files: [],
            msg: `TTS 跑在另一台机器（${remote}），这里扫不到它的目录；请手填那台机器上的绝对路径`,
          });
        }
        if (!dir) return json(res, 200, { ok: true, dir: "", files: [], msg: "还没填参考音频路径" });
        if (!existsSync(dir)) {
          return json(res, 200, {
            ok: false, dir, files: [],
            msg: "目录不存在——管理页要在跑 TTS 的那台机器上打开",
          });
        }
        const exts = [".wav", ".mp3", ".flac", ".ogg", ".m4a"];
        let files = [];
        try {
          files = readdirSync(dir)
            .filter((f) => exts.includes(path.extname(f).toLowerCase()))
            .map((f) => {
              const full = path.join(dir, f);
              let size = 0;
              try { size = statSync(full).size; } catch { /* 可能没权限 */ }
              return { name: f, path: full, size, dur: wavSeconds(full) };
            })
            .sort((a, b) => a.name.localeCompare(b.name));
        } catch (e) {
          return json(res, 200, { ok: false, dir, files: [], msg: `读目录失败：${e.message}` });
        }
        return json(res, 200, { ok: true, dir, files });
      }

      /* 屏幕预览：复用 tools/preview_ui.mjs 在服务端画一张 400×300 的 PNG。
       * 和固件同一套字体/坐标，改完布局先在这里看，不用烧板。
       * 天气/电量/雷达取当前真实值，室内温湿度没有来源仍是示例值。 */
      if (p === "/api/screen-preview" && req.method === "GET") {
        const q = new URL(req.url, "http://x").searchParams;
        const h = Math.min(23, Math.max(0, Number(q.get("h") ?? new Date().getHours()) || 0));
        const m = Math.min(59, Math.max(0, Number(q.get("m") ?? new Date().getMinutes()) || 0));
        const day = q.get("day") === "0" ? "night" : "day";

        const w = ctx.weather.data;
        const dev = uniqueDevices(ctx.devices)[0] || null;
        const stat = dev?.lastStat || null;
        const pres = dev?.presence?.snapshot?.() ?? null;
        const env = {
          city: String(w?.city || getConfig().weather?.city || "通城").replace(/[市县区旗]$/, "").slice(0, 3),
          cond: w?.text || "晴",
          temp: Number.isFinite(w?.temp) ? w.temp : 18,
          hum: Number.isFinite(w?.humidity) ? w.humidity : 58,
          bat: Number.isFinite(stat?.bat) ? stat.bat : 76,
        };
        const st = {
          wifi: dev ? "已连接" : "未连接",
          server: dev ? "已连接" : "未连接",
          ble: stat?.bt ? "开启" : "关闭",
          radar: pres?.known
            ? (pres.present ? `有人 ${(pres.dist / 100).toFixed(1)}m` : "无人")
            : "未接入",
        };

        const tmp = path.join(ROOT, ".preview.png");
        try {
          execFileSync(process.execPath,
            [path.join(ROOT, "..", "tools", "preview_ui.mjs"), tmp, String(h), String(m), day],
            {
              cwd: path.join(ROOT, ".."), timeout: 20000, stdio: "pipe",
              env: { ...process.env, PREVIEW_DATA: JSON.stringify({ env, st }) },
            });
          const png = readFileSync(tmp);
          res.writeHead(200, {
            "Content-Type": "image/png",
            "Content-Length": png.length,
            "Cache-Control": "no-store",
            "X-Preview-Live": dev ? "1" : "0",
          });
          return res.end(png);
        } catch (e) {
          const detail = String(e.stderr || e.message || "").slice(0, 300);
          return json(res, 200, { ok: false, msg: `渲染失败：${detail}` });
        }
      }

      if (p === "/api/say" && req.method === "POST") {
        const { text, gate } = JSON.parse(await readBody(req));
        if (typeof text !== "string" || !text.trim())
          return json(res, 400, { ok: false, msg: "缺少 text" });
        let list = [...ctx.devices];
        if (gate) {
          /* 走和提醒一样的“有人才播”门控；雷达未知时回退为全部空闲设备 */
          const known = list.filter((d) => d.presence?.known);
          list = known.length ? known.filter((d) => d.presence.present) : list;
          if (!list.length) return json(res, 200, { ok: true, sent: 0, msg: "现在判定无人，没有播报" });
        }
        for (const d of list) d.speakOne(text.trim()).catch(() => {});
        log(`让设备播报 → ${list.length} 台${gate ? "（雷达门控）" : ""}`);
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
          const dest = path.join(bak, rel.replace(/[\\/]/g, "_"));
          if (existsSync(live)) {
            try {
              renameSync(live, dest);
            } catch (e) {
              /* 目录被别的进程占着（资源管理器/编辑器/杀软扫描）：重命名会 EPERM。
                 退回覆盖复制，旧文件残留但代码都会被换掉，不影响运行。 */
              cpSync(from, live, { recursive: true, force: true });
              log("目录被占用，改为覆盖复制：" + rel + "（" + (e.code || e.message) + "）");
              return;
            }
          }
          try {
            renameSync(from, live);
          } catch (e) {
            cpSync(from, live, { recursive: true, force: true });
            log("替换失败，改为覆盖复制：" + rel + "（" + (e.code || e.message) + "）");
          }
        };
        try {
          ["server/src", "server/skills", "web"].forEach(swapDir);
          const dataFrom = path.join(stage, "server/data");
          if (existsSync(dataFrom)) {
            /* 部署包里的 data/timetable.json 是 git 里的出厂模板，会覆盖云端课表。
             * 如果 runtime 还没有课表、设备脚本里也没有 DATA 段可恢复，
             * 先把当前云端课表落到 runtime，避免这次部署把它冲掉。 */
            const liveTT = path.join(ROOT, "data", "timetable.json");
            const runtimeTT = path.join(ROOT, "runtime", "timetable.json");
            const luaCode = String(getConfig()?.lua?.activeScript || "");
            if (!existsSync(runtimeTT) && existsSync(liveTT) && !/local RS=\{/.test(luaCode)) {
              try {
                mkdirSync(path.dirname(runtimeTT), { recursive: true });
                cpSync(liveTT, runtimeTT);
                log("已把当前课表保存到 runtime（部署不覆盖）");
              } catch (e) {
                log("保存当前课表到 runtime 失败：" + e.message);
              }
            }
            cpSync(dataFrom, path.join(ROOT, "data"), { recursive: true, force: true });
          }
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

      /* 课表：读 / 存（存完重写 Lua 的 DATA 段并下发） */
      if (p === "/api/timetable" && req.method === "GET") {
        const tt = loadTimetableRaw();
        if (!tt) return json(res, 500, { ok: false, msg: "课表数据缺失" });
        return json(res, 200, {
          days: tt.days, periods: tt.periods, classes: tt.classes,
          rounds: tt.rounds, round: getConfig().timetable?.round || 1,
          source: tt.source || "runtime", updated: tt.updated || "",
        });
      }

      if (p === "/api/timetable" && req.method === "POST") {
        const body = JSON.parse(await readBody(req));
        const classes = Array.isArray(body.classes) ? body.classes.map((x) => String(x).trim()).filter(Boolean) : [];
        const periods = Array.isArray(body.periods) ? body.periods : [];
        const rounds = Array.isArray(body.rounds) ? body.rounds : [];
        if (!classes.length || classes.length > 20)
          return json(res, 400, { ok: false, msg: "班级数量需在 1~20 之间" });
        if (classes.some((c) => c.length > 8))
          return json(res, 400, { ok: false, msg: "班级名最长 8 个字" });
        if (periods.length !== 13)
          return json(res, 400, { ok: false, msg: "节次必须是 13 行" });
        for (const pd of periods) {
          if (!pd || typeof pd.label !== "string" || pd.label.length > 6 ||
              !/^\d{1,2}:\d{2}$/.test(pd.time || "") || !/^\d{1,2}:\d{2}$/.test(pd.end || ""))
            return json(res, 400, { ok: false, msg: "节次名称或时间不合法（HH:MM）" });
        }
        const LET = "ABCDEFGHIJKLMNOPQRST";
        const valid = new Set(["-", ...LET.slice(0, classes.length).split("")]);
        if (rounds.length !== 3 || rounds.some((r) => !Array.isArray(r) || r.length !== 13 ||
            r.some((x) => typeof x !== "string" || x.length !== 7 || [...x].some((ch) => !valid.has(ch)))))
          return json(res, 400, { ok: false, msg: "格子非法（可能有超出班级列表的字母）" });

        const ttPath = timetablePath();
        const tt = loadTimetableRaw() || {};
        tt.classes = classes;
        tt.periods = periods;
        tt.rounds = rounds;
        tt.updated = new Date().toISOString().slice(0, 10);
        tt.source = "runtime";
        writeFileSync(ttPath, JSON.stringify(tt, null, 2) + "\n");

        const q = (arr) => "{" + arr.map((x) => '"' + x + '"').join(",") + "}";
        const block =
          "-- >>>DATA 由服务器按网页编排重写，勿手改\n" +
          "local RS={\n" + rounds.map((r) => '{"' + r.join('","') + '"},').join("\n") + "\n}\n" +
          "local CN={" + classes.map((c, i) => LET[i] + '="' + c + '"').join(",") + "}\n" +
          "local GUT=" + q(periods.map((x) => x.label)) + "\n" +
          "local PT=" + q(periods.map((x) => x.time)) + "\n" +
          "local PE=" + q(periods.map((x) => x.end)) + "\n" +
          "-- <<<DATA\n";
        const cfg = getConfig();
        const re = /-- >>>DATA[\s\S]*?-- <<<DATA\n/;
        let code = String(cfg.lua?.activeScript || "");
        if (!re.test(code)) {
          const tpl = path.join(ROOT, "data/framework.lua");
          if (!existsSync(tpl))
            return json(res, 500, { ok: false, msg: "当前脚本里没有 DATA 段，先下发新版 framework.lua" });
          code = readFileSync(tpl, "utf8");
        }
        if (!re.test(code)) return json(res, 500, { ok: false, msg: "模板里也没有 DATA 段" });
        code = code.replace(re, block);
        if (code.length > 6000)
          return json(res, 400, { ok: false, msg: "生成后超过 6000 字符（" + code.length + "）" });

        saveConfig({ lua: { prevScript: cfg.lua?.activeScript || "", activeScript: code } });
        const id = Date.now() % 100000;
        const list = [...ctx.devices];
        const results = list.length ? await Promise.all(list.map((d) => d.sendLua(id, code, 8000))) : [];
        log("timetable saved+deployed: " + list.length + " dev, lua " + code.length);
        return json(res, 200, { ok: true, sent: list.length, codeLen: code.length, results });
      }

      if (p === "/api/lua" && req.method === "GET") {
        return json(res, 200, getConfig().lua);
      }

      if (p === "/api/lua" && req.method === "POST") {
        const { code } = JSON.parse(await readBody(req));
        if (typeof code !== "string") return json(res, 400, { ok: false, msg: "缺少 code" });
        if (code.length > 6000)
          return json(res, 400, { ok: false, msg: `脚本过长（${code.length} 字符，上限 6000）` });

        const cfg0 = getConfig();
        const old = cfg0.lua?.activeScript || "";
        const current = old || currentLuaScript();
        const checked = validateLua(code, current);
        if (!checked.ok)
          return json(res, 400, { ok: false, msg: "脚本没有通过校验", errors: checked.errors, warnings: checked.warnings });

        const list = [...ctx.devices];
        const privileged = (checked.permissions || []).filter((x) =>
          ["gpio", "gpio:all", "audio", "rtc", "wifi", "ble", "sys", "fs", "net"].includes(x)
        );
        if (privileged.length && list.length) {
          const needFw = privileged.some((x) => x === "fs" || x === "net") ? 38 : 37;
          const fwOk = list.every((d) => {
            const m = String(d.fw || "").match(/^0\.1\.(\d+)/);
            return m && Number(m[1]) >= needFw;
          });
          if (!fwOk)
            return json(res, 409, {
              ok: false,
              msg: `脚本申请了扩展权限，设备固件需 ≥ 0.1.${needFw}；请先 OTA 再下发`,
              errors: ["设备固件过低，无法加载扩展 Lua API"],
            });
        }

        /* 0.1.39+ 先 dry-run：语法/顶层逻辑/定时器回调通过才真正下发；
         * 老固件不支持 dry-run，退回直接下发 */
        const checkReady = list.length && list.every((d) => {
          const m = String(d.fw || "").match(/^0\.1\.(\d+)/);
          return m && Number(m[1]) >= 39;
        });
        if (checkReady) {
          const cid = Date.now() % 100000;
          const checks = await Promise.all(list.map((d) => d.sendLua(cid, checked.code, 10000, true)));
          const failed = checks.find((r) => !r.ok);
          if (failed) {
            const why = String(failed.out || (failed.timeout ? "预检查超时" : "设备预检查失败")).slice(0, 600);
            log(`下发 Lua 脚本：设备预检查失败（${why.slice(0, 100)}），未下发`);
            return json(res, 502, {
              ok: false,
              msg: "设备预检查失败，未下发",
              precheckFailed: true,
              results: checks,
              errors: [why],
              warnings: checked.warnings,
            });
          }
        }

        const oldPrev = cfg0.lua?.prevScript || "";
        saveConfig({ lua: { prevScript: old, activeScript: checked.code } });

        if (!list.length) {
          log("下发 Lua 脚本 → 0 台设备（已保存）");
          return json(res, 200, { ok: true, sent: 0, results: [], warnings: checked.warnings });
        }

        /* 推给所有在线设备，等执行回执（每台最多 8 秒；热点/弱网回执可能慢） */
        const id = (Date.now() + 1) % 100000;
        const results = await Promise.all(list.map((d) => d.sendLua(id, checked.code, 8000)));
        const okCount = results.filter((r) => r.ok).length;
        log(`下发 Lua 脚本 → ${list.length} 台设备：${results.map((r) => (r.ok ? "成功" : r.timeout ? "回执超时" : "失败")).join(" ")}`);

        if (okCount === 0) {
          saveConfig({ lua: { prevScript: oldPrev, activeScript: old } });
          const rid = (id + 1) % 100000;
          await Promise.all(list.map((d) => d.sendLua(rid, old, 8000))).catch(() => {});
          const failed = results.find((r) => !r.ok);
          const why = String(failed?.out || (failed?.timeout ? "回执超时" : "设备未返回错误信息")).slice(0, 600);
          log(`下发 Lua 脚本失败，已回滚：${why.slice(0, 100)}`);
          return json(res, 502, {
            ok: false,
            msg: "设备加载失败，已回滚上一版",
            rolledBack: true,
            results,
            errors: [why],
            warnings: checked.warnings,
          });
        }

        return json(res, 200, { ok: true, sent: list.length, id, results, warnings: checked.warnings });
      }

      /* ── 创造模式：Lua AI ───────────────────────────────────────── */
      if (p === "/api/lua/ai" && req.method === "POST") {
        if (luaJobRunning > 0)
          return json(res, 429, { ok: false, msg: "上一条生成还没结束，请稍等" });
        const body = JSON.parse(await readBody(req));
        const request = String(body.request || "").trim();
        if (!request) return json(res, 400, { ok: false, msg: "请先写需求" });
        if (request.length > 500)
          return json(res, 400, { ok: false, msg: "需求太长（上限 500 字）" });
        const cfg = getConfig();
        if (!cfg.llm?.apiKey)
          return json(res, 400, { ok: false, msg: "未配置大模型 API Key" });
        const current = currentLuaScript();
        if (!current)
          return json(res, 500, { ok: false, msg: "没有当前 Lua 脚本" });
        const job = startLuaJob({ request, current, llm: cfg.llm });
        log(`Lua AI 任务 #${job.id} 开始：${request.slice(0, 80)}`);
        return json(res, 200, { ok: true, jobId: job.id, steps: job.steps });
      }

      if (p === "/api/lua/ai/status" && req.method === "GET") {
        const u = new URL(req.url, "http://localhost");
        const id = Number(u.searchParams.get("id"));
        const job = luaJobs.get(id);
        if (!job) return json(res, 404, { ok: false, msg: "任务不存在或已过期" });
        return json(res, 200, {
          ok: true,
          status: job.status,
          steps: job.steps,
          result: job.result,
          error: job.error,
          elapsedMs: Date.now() - job.startedAt,
        });
      }

      if (p === "/api/lua/apply" && req.method === "POST") {
        const body = JSON.parse(await readBody(req));
        const code = typeof body.code === "string" ? body.code : "";
        const summary = String(body.summary || "AI 修改").replace(/\s+/g, " ").trim().slice(0, 120) || "AI 修改";
        const request = String(body.request || "").trim().slice(0, 500);
        const repairCount = Math.max(0, Math.min(MAX_AUTO_REPAIR, Number(body.repairCount) || 0));
        const current = currentLuaScript();
        if (!current) return json(res, 500, { ok: false, msg: "没有当前 Lua 脚本" });

        const checked = validateLua(code, current);
        if (!checked.ok)
          return json(res, 400, { ok: false, msg: "脚本没有通过校验", errors: checked.errors, warnings: checked.warnings });
        if (body.baseHash && body.baseHash !== luaBaseHash(current))
          return json(res, 409, { ok: false, msg: "当前脚本已变化（课表或手动下发），请重新生成" });
        if (checked.code.trim() === current.trim())
          return json(res, 400, { ok: false, msg: "脚本没有变化" });

        const list = [...ctx.devices];
        if (!list.length)
          return json(res, 409, { ok: false, msg: "当前没有在线设备；为避免服务器和设备脚本不一致，请等设备上线后再应用" });

        const privileged = (checked.permissions || []).filter((p) =>
          ["gpio", "gpio:all", "audio", "rtc", "wifi", "ble", "sys", "fs", "net"].includes(p)
        );
        if (privileged.length) {
          const needFw = privileged.some((p) => p === "fs" || p === "net") ? 38 : 37;
          const fwOk = list.every((d) => {
            const m = String(d.fw || "").match(/^0\.1\.(\d+)/);
            return m && Number(m[1]) >= needFw;
          });
          if (!fwOk) {
            return json(res, 409, {
              ok: false,
              msg: `脚本申请了扩展权限，设备固件需 ≥ 0.1.${needFw}；请先 OTA 再应用`,
              errors: ["设备固件过低，无法加载扩展 Lua API"],
            });
          }
        }

        const checkReady = list.every((d) => {
          const m = String(d.fw || "").match(/^0\.1\.(\d+)/);
          return m && Number(m[1]) >= 39;
        });
        if (checkReady) {
          const cid = Date.now() % 100000;
          const checks = await Promise.all(list.map((d) => d.sendLua(cid, checked.code, 10000, true)));
          const failedCheck = checks.find((r) => !r.ok);
          if (failedCheck) {
            const checkError = String(
              failedCheck.out || (failedCheck.timeout ? "预检查超时" : "设备预检查失败")
            ).slice(0, 600);
            const cfg0 = getConfig();
            if (repairCount < MAX_AUTO_REPAIR && request && luaJobRunning === 0 && cfg0.llm?.apiKey) {
              const job = startLuaJob({
                request: makeLuaRepairRequest(request, checked.code, checkError),
                current,
                llm: cfg0.llm,
              });
              log(`Lua AI 预检查失败，自动修正任务 #${job.id} 开始：${checkError.slice(0, 100)}`);
              return json(res, 502, {
                ok: false,
                msg: "设备预检查失败，未下发；正在让模型自动修正",
                precheckFailed: true,
                results: checks,
                repairJobId: job.id,
                repairCount: repairCount + 1,
                steps: job.steps,
                warnings: checked.warnings,
              });
            }
            return json(res, 502, {
              ok: false,
              msg: "设备预检查失败，未下发",
              precheckFailed: true,
              results: checks,
              errors: [checkError],
              warnings: checked.warnings,
            });
          }
        }

        const cfg = getConfig();
        const old = current;
        const oldPrev = cfg.lua?.prevScript || "";
        const oldAiPrevScript = cfg.lua?.aiPrevScript || "";
        const oldAiPrevSummary = cfg.lua?.aiPrevSummary || "";
        const oldAiPrevAt = cfg.lua?.aiPrevAt || "";
        const oldHistory = Array.isArray(cfg.lua?.history) ? cfg.lua.history : [];
        const at = new Date().toISOString();
        const entry = { at, summary, len: checked.code.length };

        saveConfig({
          lua: {
            prevScript: old,
            activeScript: checked.code,
            aiPrevScript: old,
            aiPrevSummary: summary,
            aiPrevAt: at,
            history: [...oldHistory, entry].slice(-10),
          },
        });

        const id = Date.now() % 100000;
        const results = await Promise.all(list.map((d) => d.sendLua(id, checked.code, 8000)));
        const okCount = results.filter((r) => r.ok).length;

        if (okCount === 0) {
          saveConfig({
            lua: {
              prevScript: oldPrev,
              activeScript: old,
              aiPrevScript: oldAiPrevScript,
              aiPrevSummary: oldAiPrevSummary,
              aiPrevAt: oldAiPrevAt,
              history: oldHistory,
            },
          });
          const rid = (id + 1) % 100000;
          await Promise.all(list.map((d) => d.sendLua(rid, old, 8000))).catch(() => {});

          const failed = results.find((r) => !r.ok);
          const deviceError = String(
            failed?.out || (failed?.timeout ? "回执超时" : "设备未返回错误信息")
          ).slice(0, 600);
          const cfg2 = getConfig();
          if (repairCount < MAX_AUTO_REPAIR && request && luaJobRunning === 0 && cfg2.llm?.apiKey) {
            const repairRequest = makeLuaRepairRequest(request, checked.code, deviceError);
            const job = startLuaJob({ request: repairRequest, current: old, llm: cfg2.llm });
            log(`Lua AI 设备报错，自动修正任务 #${job.id} 开始：${deviceError.slice(0, 100)}`);
            return json(res, 502, {
              ok: false,
              msg: "设备加载失败，已回滚；正在让模型根据设备错误自动修正",
              rolledBack: true,
              results,
              repairJobId: job.id,
              repairCount: repairCount + 1,
              steps: job.steps,
              warnings: checked.warnings,
            });
          }

          log(`Lua AI 下发失败，已回滚：${checked.code.length} 字符`);
          return json(res, 502, {
            ok: false,
            msg: "设备加载失败，已回滚上一版",
            rolledBack: true,
            results,
            warnings: checked.warnings,
          });
        }

        log(`Lua AI applied: ${checked.code.length} 字符，${okCount}/${list.length} 台成功，${summary}`);
        return json(res, 200, {
          ok: true,
          sent: list.length,
          results,
          codeLen: checked.code.length,
          warnings: checked.warnings,
        });
      }

      if (p === "/api/lua/rollback" && req.method === "POST") {
        const cfg = getConfig();
        const aiPrev = cfg.lua?.aiPrevScript || "";
        if (!aiPrev)
          return json(res, 400, { ok: false, msg: "没有可撤销的 AI 修改" });

        const old = currentLuaScript();
        const oldPrev = cfg.lua?.prevScript || "";
        const aiPrevSummary = cfg.lua?.aiPrevSummary || "AI 修改";
        const oldHistory = Array.isArray(cfg.lua?.history) ? cfg.lua.history : [];
        const checked = validateLua(aiPrev, old);
        if (!checked.ok)
          return json(res, 400, { ok: false, msg: "上一版脚本不合法，无法撤销", errors: checked.errors });
        if (checked.code.trim() === old.trim())
          return json(res, 400, { ok: false, msg: "脚本没有变化" });

        const list = [...ctx.devices];
        if (!list.length)
          return json(res, 409, { ok: false, msg: "当前没有在线设备，未撤销" });

        const id = Date.now() % 100000;
        const results = await Promise.all(list.map((d) => d.sendLua(id, checked.code, 8000)));
        const okCount = results.filter((r) => r.ok).length;
        if (okCount === 0)
          return json(res, 502, { ok: false, msg: "撤销下发失败，保留当前脚本", results });

        const at = new Date().toISOString();
        saveConfig({
          lua: {
            prevScript: old,
            activeScript: checked.code,
            aiPrevScript: "",
            aiPrevSummary: "",
            aiPrevAt: "",
            history: [...oldHistory, { at, summary: `撤销：${aiPrevSummary}`, len: checked.code.length }].slice(-10),
          },
        });
        log(`Lua AI 撤销成功：${checked.code.length} 字符，${okCount}/${list.length} 台`);
        return json(res, 200, {
          ok: true,
          sent: list.length,
          results,
          codeLen: checked.code.length,
          msg: `已撤销：${aiPrevSummary}`,
        });
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
            method: s.type === "docs" ? "docs" : s.type === "builtin" ? "builtin" : String(s.request.method || "GET").toUpperCase(),
            url: s.type === "docs" ? s.dir : s.type === "builtin" ? `内置：${s.handler}` : s.request.url,
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

      /* 「我的快递」清单：语音查过的单号会自动进来，也可以在网页删/补 */
      if (p === "/api/parcels" && req.method === "GET") {
        return json(res, 200, { items: listParcels() });
      }

      if (p === "/api/parcels/add" && req.method === "POST") {
        const b = JSON.parse(await readBody(req));
        const item = addParcel(b.number, b.carrier, b.label);
        if (!item) return json(res, 400, { ok: false, error: "单号不合法" });
        log(`记录快递 ${item.number}`);
        return json(res, 200, { ok: true, item });
      }

      if (p === "/api/parcels/delete" && req.method === "POST") {
        const b = JSON.parse(await readBody(req));
        const ok = removeParcel(b.number);
        return json(res, 200, ok
          ? { ok: true }
          : { ok: false, error: "清单里没有这个单号" });
      }

      /* 网页里粘贴一个技能 JSON 直接写进 server/skills/ 并热重载。
       * 只写 <name>.json，文件名由 name 派生，不碰别的路径。 */
      if (p === "/api/skills/import" && req.method === "POST") {
        try {
          const body = JSON.parse(await readBody(req));
          const r = saveSkill(String(body.json || ""), { overwrite: !!body.overwrite });
          log(`导入技能 ${r.name} → 共 ${r.count} 个`);
          return json(res, 200, { ok: true, ...r });
        } catch (e) {
          return json(res, 400, { ok: false, msg: e.message });
        }
      }

      if (p === "/api/skills/delete" && req.method === "POST") {
        try {
          const { name } = JSON.parse(await readBody(req));
          const r = deleteSkill(name);
          log(`删除技能 ${r.name} → 共 ${r.count} 个`);
          return json(res, 200, { ok: true, ...r });
        } catch (e) {
          return json(res, 400, { ok: false, msg: e.message });
        }
      }

      if (p === "/api/ota" && req.method === "GET") {
        const file = otaInfo();
        return json(res, 200, {
          file,
          devices: uniqueDevices(ctx.devices).map((d) => ({
            sid: d.sid, mac: d.mac, fw: d.fw, ota: d.ota,
            updatable: !!(file && file.version && d.fw && d.fw !== file.version),
          })),
        });
      }

      if (p === "/api/ota" && req.method === "POST") {
        const file = otaInfo();
        if (!existsSync(OTA_APP) || !file)
          return json(res, 400, { ok: false, msg: "服务器上没有固件（把 myesp32.bin 放到 firmware/build/ota-app.bin）" });
        if (!ctx.devices.size) return json(res, 400, { ok: false, msg: "没有在线设备" });

        /* 同一台设备只推一次；已经和目标版本相同的直接跳过——否则每点一次
         * “推送到设备”都会把同版本固件再刷一遍。 */
        const list = uniqueDevices(ctx.devices)
          .filter((d) => !(file.version && d.fw === file.version));
        if (!list.length) {
          return json(res, 200, {
            ok: true, sent: 0, file,
            msg: file.version ? `设备已经是最新版本 ${file.version}` : "没有需要更新的设备",
          });
        }

        /* 云服务器上"设备连接看到的本地地址"是内网 IP，必须用配置的公网地址；
         * 局域网部署留空时再退回本地地址 */
        const base = String(getConfig().server.publicUrl || "").replace(/\/+$/, "");
        const localIp = list[0].ws?._socket?.localAddress;
        const port = req.socket.localPort || 8080;
        const host = localIp ? `${localIp}:${port}` : (req.headers.host || `127.0.0.1:${port}`);
        const dst = base ? `${base}/firmware/app.bin` : `http://${host}/firmware/app.bin`;

        for (const d of list) d.startOta(dst);
        log(`推送 OTA → ${list.length} 台：${dst}`);
        return json(res, 200, { ok: true, sent: list.length, url: dst, file });
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
