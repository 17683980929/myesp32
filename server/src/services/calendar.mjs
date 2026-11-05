/**
 * services/calendar.mjs — 中国日历 / 节假日（内置技能 handler）
 *
 * 两件事模型自己算不准：
 *   1) 今天农历几号、星期几、是不是调休上班
 *   2) 下一个假期还有几天（要跨年、要认调休）
 *
 * 农历：本地算法（1900–2100 年表），不依赖网络，也不会被接口限流。
 * 假期：timor.tech 年表（免 key），按年缓存 6 小时。
 *
 * 设计取舍：农历用本地表而不是调 API，是因为 apihubs 这类免费接口
 * 按 IP 限流（连续两次就 80006），而"今天农历几号"是随时会问的问题。
 */

const DAY = 86400000;
const TZ = 8 * 3600 * 1000;
const YEAR_TTL = 6 * 3600 * 1000;
const FETCH_TIMEOUT = 8000;

/* 1900–2100 年农历表：低 4 位 = 闰月月份（0=无闰月），
 * 0x10000 = 闰月是否 30 天，其余位从高到低表示 12 个月的大小月。 */
const LUNAR_INFO = [
  0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2,
  0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977,
  0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970,
  0x06566, 0x0d4a0, 0x0ea50, 0x06e95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950,
  0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557,
  0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5b0, 0x14573, 0x052b0, 0x0a9a8, 0x0e950, 0x06aa0,
  0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0,
  0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b6a0, 0x195a6,
  0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570,
  0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x055c0, 0x0ab60, 0x096d5, 0x092e0,
  0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5,
  0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930,
  0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530,
  0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45,
  0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0,
  0x14b63, 0x09370, 0x049f8, 0x04970, 0x064b0, 0x168a6, 0x0ea50, 0x06b20, 0x1a6c4, 0x0aae0,
  0x0a2e0, 0x0d2e3, 0x0c960, 0x0d557, 0x0d4a0, 0x0da50, 0x05d55, 0x056a0, 0x0a6d0, 0x055d4,
  0x052d0, 0x0a9b8, 0x0a950, 0x0b4a0, 0x0b6a6, 0x0ad50, 0x055a0, 0x0aba4, 0x0a5b0, 0x052b0,
  0x0b273, 0x06930, 0x07337, 0x06aa0, 0x0ad50, 0x14b55, 0x04b60, 0x0a570, 0x054e4, 0x0d160,
  0x0e968, 0x0d520, 0x0daa0, 0x16aa6, 0x056d0, 0x04ae0, 0x0a9d4, 0x0a2d0, 0x0d150, 0x0f252,
  0x0d520,
];

const MONTH_CN = ["正", "二", "三", "四", "五", "六", "七", "八", "九", "十", "冬", "腊"];
const NUM_CN = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
const WEEK_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

const yearCache = new Map();   /* 2026 -> { at, days } */

function ymd(d) {
  return d.toISOString().slice(0, 10);
}

function todayStr() {
  return ymd(new Date(Date.now() + TZ));
}

function addDays(date, n) {
  return ymd(new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY));
}

function diffDays(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
}

function weekday(date) {
  return WEEK_CN[new Date(`${date}T00:00:00Z`).getUTCDay()];
}

/** 支持 今天/明天/后天/2026-11-05/2026年11月5日 */
function normalizeDate(input) {
  const s = String(input || "").trim();
  if (!s) return todayStr();
  if (/^(今天|今日|现在)$/.test(s)) return todayStr();
  if (/^(明天|明日)$/.test(s)) return addDays(todayStr(), 1);
  if (/^后天$/.test(s)) return addDays(todayStr(), 2);
  const m = /^(\d{4})\D{0,2}(\d{1,2})\D{0,2}(\d{1,2})日?$/.exec(s);
  if (m) {
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }
  return todayStr();
}

/* ── 农历（本地计算）──────────────────────────────────────────────── */

const leapMonth = (y) => LUNAR_INFO[y - 1900] & 0xf;
const leapDays = (y) => (leapMonth(y) ? ((LUNAR_INFO[y - 1900] & 0x10000) ? 30 : 29) : 0);
const monthDays = (y, m) => ((LUNAR_INFO[y - 1900] & (0x10000 >> m)) ? 30 : 29);

function lunarYearDays(y) {
  let sum = 348;
  for (let i = 0x8000; i > 0x8; i >>= 1) sum += LUNAR_INFO[y - 1900] & i ? 1 : 0;
  return sum + leapDays(y);
}

function lunarDayName(d) {
  if (d === 10) return "初十";
  if (d === 20) return "二十";
  if (d === 30) return "三十";
  return "初十廿三"[Math.floor(d / 10)] + NUM_CN[d % 10];
}

/** 公历 → 农历。返回 "九月廿七" 这样的字符串，超出 1900–2100 返回 ""。 */
function lunarDate(y, m, d) {
  if (y < 1900 || y > 2100) return "";
  let offset = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1900, 0, 31)) / DAY);
  let temp = 0;
  let i;
  for (i = 1900; i < 2101 && offset > 0; i++) {
    temp = lunarYearDays(i);
    offset -= temp;
  }
  if (offset < 0) {
    offset += temp;
    i--;
  }
  const ly = i;
  const leap = leapMonth(i);
  let isLeap = false;
  for (i = 1; i < 13 && offset > 0; i++) {
    if (leap > 0 && i === leap + 1 && !isLeap) {
      --i;
      isLeap = true;
      temp = leapDays(ly);
    } else {
      temp = monthDays(ly, i);
    }
    if (isLeap && i === leap + 1) isLeap = false;
    offset -= temp;
  }
  if (offset === 0 && leap > 0 && i === leap + 1) {
    if (isLeap) isLeap = false;
    else {
      isLeap = true;
      --i;
    }
  }
  if (offset < 0) {
    offset += temp;
    --i;
  }
  return `${isLeap ? "闰" : ""}${MONTH_CN[i - 1]}月${lunarDayName(offset + 1)}`;
}

/* ── 节假日（timor.tech）──────────────────────────────────────────── */

async function fetchJson(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "MyEsp32-Calendar/1.0" },
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** 某年的节假日年表。失败时退回旧缓存，没有就空数组。 */
async function yearDays(year) {
  const hit = yearCache.get(year);
  const now = Date.now();
  if (hit && now - hit.at < YEAR_TTL) return hit.days;
  try {
    const j = await fetchJson(`https://timor.tech/api/holiday/year/${year}`);
    const days = Object.values(j?.holiday || {}).filter((x) => x && x.date);
    yearCache.set(year, { at: now, days });
    return days;
  } catch {
    return hit?.days || [];
  }
}

/** 把连续放假日并成一段。春节的"除夕/初一"会被并成一段，名字取春节。 */
function holidayGroups(days) {
  const hs = days
    .filter((d) => d.holiday === true && d.date)
    .sort((a, b) => a.date.localeCompare(b.date));

  const groups = [];
  for (const d of hs) {
    const last = groups[groups.length - 1];
    if (last && addDays(last.end, 1) === d.date) {
      last.end = d.date;
      if (!last.names.includes(d.name)) last.names.push(d.name);
    } else {
      groups.push({ start: d.date, end: d.date, names: [d.name] });
    }
  }
  for (const g of groups) {
    g.name = g.names.some((n) => n === "春节" || n === "除夕" || n === "初一")
      ? "春节"
      : (g.names[0] || "假期");
    g.days = diffDays(g.start, g.end) + 1;
  }
  return groups;
}

/** 数据源没覆盖到的年份：按公历固定日期兜底（春节/清明等没法算，只能略过）。 */
function fixedHolidays(from) {
  const y = Number(from.slice(0, 4));
  const cands = [];
  for (const yy of [y, y + 1]) {
    cands.push({ name: "元旦", start: `${yy}-01-01` });
    cands.push({ name: "劳动节", start: `${yy}-05-01` });
    cands.push({ name: "国庆节", start: `${yy}-10-01` });
  }
  return cands
    .filter((x) => x.start > from)
    .sort((a, b) => a.start.localeCompare(b.start))[0] || null;
}

/* ── 对外 ─────────────────────────────────────────────────────────── */

export async function calendarAnswer(args = {}) {
  const date = normalizeDate(args.date || args.query || "");
  const [y, m, d] = date.split("-").map(Number);

  const lunar = lunarDate(y, m, d);
  const parts = [`公历 ${y}年${m}月${d}日 ${weekday(date)}`];
  if (lunar) parts.push(`农历${lunar}`);

  /* 跨年：本年数据不够就再取下一年的（12 月之后元旦在明年） */
  const days = await yearDays(y);
  let groups = holidayGroups(days);
  if (!groups.some((g) => g.end >= date)) {
    const next = await yearDays(y + 1);
    groups = holidayGroups([...days, ...next]);
  }
  const current = groups.find((g) => g.start <= date && g.end >= date);

  const entry = days.find((x) => x.date === date);
  const wd = new Date(`${date}T00:00:00Z`).getUTCDay();
  let status;
  if (entry?.holiday === true) {
    const nth = current ? `，放假第 ${diffDays(current.start, date) + 1} 天` : "";
    status = `假期（${current?.name || entry.name}${nth}）`;
  } else if (entry?.holiday === false) {
    status = `调休补班（${entry.name}）`;
  } else {
    status = wd === 0 || wd === 6 ? "周末" : "工作日";
  }
  parts.push(status);

  const lines = [`今天是 ${parts.join("，")}。`];

  if (current) {
    const left = diffDays(date, current.end);
    lines.push(`正在放${current.name}假：${current.start} ~ ${current.end}，共 ${current.days} 天${left > 0 ? `，还剩 ${left} 天` : "，今天最后一天"}。`);
  } else {
    const next = groups.filter((g) => g.start > date).sort((a, b) => a.start.localeCompare(b.start))[0];
    if (next) {
      const n = diffDays(date, next.start);
      lines.push(`下一个假期：${next.name}，${next.start}（${weekday(next.start)}）开始，放到 ${next.end}，共 ${next.days} 天，还有 ${n} 天。`);
    } else {
      const fixed = fixedHolidays(date);
      if (fixed) {
        const n = diffDays(date, fixed.start);
        lines.push(`下一个假期：${fixed.name}，${fixed.start}（${weekday(fixed.start)}），还有 ${n} 天。放假安排还没公布，这是按公历固定日期估的。`);
      } else {
        lines.push("下一个假期：暂无数据。");
      }
    }
  }

  const overtime = days
    .filter((x) => x.holiday === false && x.date > date)
    .sort((a, b) => a.date.localeCompare(b.date))[0];
  lines.push(overtime
    ? `最近的调休补班：${overtime.date}（${weekday(overtime.date)}）${overtime.name}。`
    : "最近的调休补班：无（或安排尚未公布）。");

  return lines.join("\n");
}
