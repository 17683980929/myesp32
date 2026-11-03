/**
 * services/timetable.mjs — 课表读取（语音问答 / 定时提醒共用）
 *
 * rounds 里存的是字母（A/B/...），classes 是管理页可编辑的班级名。
 * 屏幕、语音问答和提醒必须用同一份映射，不能各自写死。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig } from "../config.mjs";

const TT_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../data/timetable.json");
const LET = "ABCDEFGHIJKLMNOPQRST";

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
  try {
    const tt = JSON.parse(readFileSync(TT_PATH, "utf8"));
    return mapRounds(tt, Number(getConfig().timetable?.round) || 0);
  } catch {
    return null;
  }
}
