/**
 * services/timetable.mjs — 课表读取（语音问答 / 定时提醒共用）
 *
 * 运行时课表放在 server/runtime/timetable.json：
 *   - server/data/timetable.json 是 git 里的"出厂模板"，CI 每次部署都会覆盖它；
 *   - 管理页保存的课表属于运行时数据，不能再放回 data/，否则下次部署被旧模板冲掉。
 *
 * 兼容老部署：runtime 文件不存在时，优先从 config.lua.activeScript 的 DATA 段恢复
 * （设备脚本是管理页保存时一起写的，代表最新课表），失败才退回 data/ 模板。
 *
 * rounds 里存的是字母（A/B/...），classes 是管理页可编辑的班级名。
 * 屏幕、语音问答和提醒必须用同一份映射，不能各自写死。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { getConfig, ROOT } from "../config.mjs";

const RUNTIME_DIR = path.join(ROOT, "runtime");
const TT_PATH = path.join(RUNTIME_DIR, "timetable.json");
const SEED_PATH = path.join(ROOT, "data", "timetable.json");
const LET = "ABCDEFGHIJKLMNOPQRST";
const DAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/** 从 framework.lua 的 DATA 段恢复课表（管理页保存时写入 activeScript） */
function fromLua(code) {
  const s = String(code || "");
  const rs = /local RS=\{([\s\S]*?)\n\}/.exec(s);
  if (!rs) return null;

  const rounds = [...rs[1].matchAll(/\{([^{}]*)\}/g)]
    .map((m) => [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]));
  if (rounds.length !== 3) return null;
  if (rounds.some((r) => r.length !== 13 || r.some((x) => x.length !== 7))) return null;

  const inline = (name) => {
    const m = new RegExp(`local ${name}=\\{([^}]*)\\}`).exec(s);
    return m ? m[1] : "";
  };
  const cn = [...inline("CN").matchAll(/([A-T])="([^"]*)"/g)]
    .map((m) => [m[1], m[2]])
    .sort((a, b) => a[0].localeCompare(b[0]));
  const letters = cn.map((x) => x[0]).join("");
  if (!cn.length || letters !== LET.slice(0, cn.length)) return null;

  const list = (name) => [...inline(name).matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  const labels = list("GUT");
  const times = list("PT");
  const ends = list("PE");
  if (labels.length !== 13 || times.length !== 13 || ends.length !== 13) return null;
  if (times.some((t) => !/^\d{1,2}:\d{2}$/.test(t)) || ends.some((t) => !/^\d{1,2}:\d{2}$/.test(t)))
    return null;

  return {
    classes: cn.map((x) => x[1]),
    periods: labels.map((label, i) => ({ label, time: times[i], end: ends[i] })),
    rounds,
  };
}

/** 首次运行：runtime 不存在时建立，优先用设备脚本里的最新课表 */
function ensure() {
  if (existsSync(TT_PATH)) return;
  try {
  const seed = readJson(SEED_PATH) || {};
  const recovered = fromLua(getConfig()?.lua?.activeScript);
  const tt = {
    ...seed,
    days: Array.isArray(seed.days) && seed.days.length === 7 ? seed.days : DAYS,
    ...(recovered || {}),
    note: recovered ? "课表：从设备脚本 DATA 段恢复（部署不再覆盖）" : (seed.note || ""),
    source: recovered ? "lua" : "seed",
    updated: new Date().toISOString().slice(0, 10),
  };
  mkdirSync(RUNTIME_DIR, { recursive: true });
  writeFileSync(TT_PATH, JSON.stringify(tt, null, 2) + "\n", "utf8");
  } catch {
    /* 运行时目录不可写：退回只读模板，不能因此把定时提醒带崩 */
  }
}

/** 原始课表（不做 round 映射）。管理页读写用这个。 */
export function loadTimetableRaw() {
  ensure();
  const tt = readJson(TT_PATH) || readJson(SEED_PATH);
  return tt ? { ...tt, source: tt.source || (existsSync(TT_PATH) ? "runtime" : "seed") } : null;
}

/** 管理页保存的目标路径（首次调用会先 ensure） */
export function timetablePath() {
  ensure();
  return TT_PATH;
}

/** 把某一轮字母格子换成班级名（纯函数，便于测试） */
export function mapRounds(tt, round) {
  const key = tt?.rounds?.[round - 1];
  if (!key) return tt;
  const classes = Array.isArray(tt.classes) ? tt.classes : [];
  const byLetter = {};
  classes.forEach((c, i) => {
    if (i < LET.length) byLetter[LET[i]] = String(c);
  });
  return {
    ...tt,
    grid: key.map((row) => [...row].map((ch) => (ch === "-" ? null : byLetter[ch] ?? null))),
  };
}

export function loadTimetable() {
  const tt = loadTimetableRaw();
  if (!tt) return null;
  return mapRounds(tt, Number(getConfig().timetable?.round) || 0);
}
