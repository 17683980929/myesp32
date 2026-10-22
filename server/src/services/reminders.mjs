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
import { build } from "../protocol.mjs";

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
  try {
    const tt = JSON.parse(readFileSync(TT_PATH, "utf8"));
    const round = Number(getConfig().timetable?.round) || 0;
    const key = tt.rounds?.[round - 1];
    if (key) {
      const M = { A: "1", B: "18", C: "20", D: "24" };
      tt.grid = key.map((s) => [...s].map((ch) => (ch === "-" ? null : M[ch] || null)));
    }
    return tt;
  } catch { return null; }
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

    /* 课前提醒 */
    const lead = cfg.classLeadMin ?? 10;
    const dur = cfg.classEndAfterMin ?? 40;
    (tt.periods || []).forEach((p, r) => {
      const cls = tt.grid[r]?.[col];
      if (!cls) return;
      const start = toMin(p.time);
      if (start < 0) return;
      if (b.minute === start - lead) {
        const key = `${b.ymd}:lead${r}`;
        if (!fired.has(key)) { fired.add(key); say(`还有 ${lead} 分钟上课，${p.time}，${cls} 班。`); }
      }
    });

    /* 下课+喝水合并成一条，卡在她上完课后的课间中点（上课时提醒没人听得到）。
     * 课间 ≤30 分钟取中点；更长的（午休）下课 5 分钟后提醒一次，别吵午睡。 */
    if (cfg.waterEnabled !== false) {
      const periods = tt.periods || [];
      for (let r = 0; r < periods.length - 1; r++) {
        if (!tt.grid[r]?.[col]) continue;             /* 只在她刚上完课的课间提醒 */
        const end = toMin(periods[r].time) + dur;
        const next = toMin(periods[r + 1].time);
        if (end < 0 || next < 0 || next - end < 5) continue;
        const at = (next - end <= 30) ? Math.floor((end + next) / 2) : end + 5;
        if (b.minute === at) {
          const key = `${b.ymd}:water${r}`;
          if (!fired.has(key)) {
            fired.add(key);
            /* 先让桌宠冒气泡（固件 0.1.29+ 才认识这个事件），再播报 */
            for (const d of [...ctx.devices].filter((x) => !x.busy && !x.recording))
              d.send(build.evt("water_reminder"));
            say("下课啦，喝口水，歇一会儿。");
          }
        }
      }
    }
  };

  const timer = setInterval(tick, 20000);
  tick();
  log("已启动（上下课 / 喝水 / 早间问候）");
  return () => clearInterval(timer);
}
