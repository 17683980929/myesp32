/**
 * services/reminders.mjs — 定时播报（上下课 / 喝水 / 早间问候）
 *
 * 数据来源：data/timetable.json（她的教学课表）+ 北京时间。
 * 只在设备空闲（没在录音/对话）时播报，避免打断；一轮播完 12 秒内不再叠。
 *
 * config.json 的 reminders 段：
 *   enabled / classLeadMin / classEndAfterMin /
 *   waterEnabled / waterEveryMin / waterStartHour / waterEndHour /
 *   morningEnabled / morningHour / morningMinute
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT, getConfig } from "../config.mjs";

const TT_PATH = path.resolve(ROOT, "data/timetable.json");
const log = (...a) => console.log("[remind]", ...a);

function beijing() {
  const d = new Date(Date.now() + 8 * 3600e3);
  return {
    ymd: `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`,
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    wd: d.getUTCDay(),                                  /* 0=周日 */
    minute: d.getUTCHours() * 60 + d.getUTCMinutes(),
    hour: d.getUTCHours(),
    min: d.getUTCMinutes(),
  };
}

/** 距离下一个 MM-DD 还有几天（0 = 就是今天） */
function daysToAnniversary(mmdd, b) {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(String(mmdd || ""));
  if (!m) return null;
  const mm = Number(m[1]), dd = Number(m[2]);
  const today = Date.UTC(b.year, b.month - 1, b.day);
  let target = Date.UTC(b.year, mm - 1, dd);
  if (target < today) target = Date.UTC(b.year + 1, mm - 1, dd);
  return Math.round((target - today) / 86400e3);
}

function loadTimetable() {
  try { return JSON.parse(readFileSync(TT_PATH, "utf8")); } catch { return null; }
}

function toMin(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
}

export function startReminders(ctx) {
  const fired = new Set();
  let busyUntil = 0;

  const say = (text) => {
    const now = Date.now();
    if (now < busyUntil) return;
    const devs = [...ctx.devices].filter((d) => !d.busy && !d.recording);
    if (!devs.length) return;
    busyUntil = now + 12000;
    log(text);
    for (const d of devs) d.speakOne(text).catch(() => {});
  };

  const tick = () => {
    const cfg = getConfig().reminders || {};
    if (cfg.enabled === false) return;

    const b = beijing();
    if (fired.size > 400) fired.clear();

    /* 早间问候：天气 + 今天第一节课 */
    if (cfg.morningEnabled !== false) {
      const at = (cfg.morningHour ?? 6) * 60 + (cfg.morningMinute ?? 50);
      const key = `${b.ymd}:morning`;
      if (b.minute === at && !fired.has(key)) {
        fired.add(key);
        const tt = loadTimetable();
        const col = (b.wd + 6) % 7;
        let line = "今天没有课。";
        if (tt?.grid) {
          const cells = [];
          tt.grid.forEach((row, r) => {
            if (row[col]) cells.push(`${tt.periods[r].time} ${row[col]} 班`);
          });
          if (cells.length) line = `今天 ${cells.length} 节课，第一节 ${cells[0]}。`;
        }
        const w = ctx.weather?.data;
        const wtxt = (w && w.text && Number.isFinite(w.temp)) ? `今天${w.text}，${w.temp} 度。` : "";
        let ann = "";
        const a = cfg.anniversary;
        if (a?.enabled) {
          const days = daysToAnniversary(a.date, b);
          if (days === 0) ann = `今天是${a.label}。`;
          else if (days > 0) ann = `距离${a.label}还有 ${days} 天。`;
        }
        say(`早上好。${wtxt}${line}${ann}路上小心。`);
      }
    }

    const tt = loadTimetable();
    if (!tt?.grid) return;
    const col = (b.wd + 6) % 7;                          /* 0=周一 */

    /* 课前提醒 + 下课提醒 */
    const lead = cfg.classLeadMin ?? 10;
    const dur = cfg.classEndAfterMin ?? 45;
    (tt.periods || []).forEach((p, r) => {
      const cls = tt.grid[r]?.[col];
      if (!cls) return;
      const start = toMin(p.time);
      if (start < 0) return;

      if (b.minute === start - lead) {
        const key = `${b.ymd}:lead${r}`;
        if (!fired.has(key)) { fired.add(key); say(`还有 ${lead} 分钟上课，${p.time}，${cls} 班。`); }
      }
      if (b.minute === start + dur) {
        const key = `${b.ymd}:end${r}`;
        if (!fired.has(key)) { fired.add(key); say("这节课下课了，喝口水，歇一会儿。"); }
      }
    });

    /* 喝水提醒 */
    if (cfg.waterEnabled !== false) {
      const every = cfg.waterEveryMin ?? 60;
      const h0 = cfg.waterStartHour ?? 8;
      const h1 = cfg.waterEndHour ?? 17;
      if (b.hour >= h0 && b.hour < h1 && b.min % every === 0) {
        const key = `${b.ymd}:water${b.hour}:${b.min}`;
        if (!fired.has(key)) { fired.add(key); say("喝口水吧。"); }
      }
    }
  };

  const timer = setInterval(tick, 20000);
  tick();
  log("已启动（上下课 / 喝水 / 早间问候）");
  return () => clearInterval(timer);
}
