/**
 * services/presence.mjs — 雷达有人/无人状态（按 MAC 跨重连保留）
 *
 * known=false：雷达未知（没插 USB / 串口没帧），不能当“无人”；
 * present=true：有人。今日在座时长按北京时间累计，离开即结算。
 */

const TZ = 8 * 3600e3;

function bj(at) {
  const d = new Date(at + TZ);
  return {
    ymd: `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`,
    hhmm: `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`,
  };
}

export class PresenceState {
  constructor() {
    this.known = false;
    this.present = false;
    this.since = 0;
    this.absentAt = 0;        /* 这次“无人”从什么时候开始（只在 known 时记） */
    this.dayKey = "";
    this.dayMs = 0;
    this.dayFirst = "";
    this.dayLast = "";
    this.lastDist = -1;
    this.lastGreetAt = 0;     /* 跨会话的问候冷却 */
    this.transitions = [];    /* {at, present} 最近 20 条 */
  }

  update({ pres, uart, dist, at = Date.now() }) {
    const known = pres === 1 || uart === 1 || uart === true;
    const present = pres === 1;
    const t = bj(at);

    if (this.dayKey !== t.ymd) {
      this.dayKey = t.ymd;
      this.dayMs = 0;
      this.dayFirst = "";
      this.dayLast = "";
      this.transitions = [];
    }
    if (Number.isFinite(dist) && dist >= 0) this.lastDist = dist;

    const prevKnown = this.known;
    const prevPresent = this.present;

    if (!known) {
      /* 未知：结束当前在座计时，但不记“无人”，也不启动问候 */
      if (this.present) {
        this.dayMs += Math.max(0, at - this.since);
        this.present = false;
        this.since = 0;
        this.transitions.push({ at, present: 0, lost: true });
        if (this.transitions.length > 20) this.transitions.shift();
      }
      this.known = false;
      this.absentAt = 0;
      return {
        known: false, present: false,
        knownChanged: prevKnown !== false,
        presentChanged: prevPresent,
        enteredPresent: false,
        awayMs: 0,
      };
    }

    this.known = true;
    if (present) {
      const entered = !this.present;
      const awayMs = entered && this.absentAt ? at - this.absentAt : 0;
      if (entered) {
        this.present = true;
        this.since = at;
        if (!this.dayFirst) this.dayFirst = t.hhmm;
        this.dayLast = t.hhmm;
        this.transitions.push({ at, present: 1 });
        if (this.transitions.length > 20) this.transitions.shift();
      } else {
        this.dayLast = t.hhmm;
      }
      this.absentAt = 0;
      return {
        known: true, present: true,
        knownChanged: !prevKnown,
        presentChanged: prevPresent !== true,
        enteredPresent: entered,
        awayMs,
      };
    }

    if (this.present) {
      this.present = false;
      this.dayMs += Math.max(0, at - this.since);
      this.since = 0;
      this.transitions.push({ at, present: 0 });
      if (this.transitions.length > 20) this.transitions.shift();
    }
    if (!this.absentAt) this.absentAt = at;
    return {
      known: true, present: false,
      knownChanged: !prevKnown,
      presentChanged: prevPresent,
      enteredPresent: false,
      awayMs: 0,
    };
  }

  todayMs(at = Date.now()) {
    return this.dayMs + (this.present && this.since ? Math.max(0, at - this.since) : 0);
  }

  snapshot(at = Date.now()) {
    return {
      known: this.known,
      present: this.present,
      dist: this.lastDist,
      since: this.since || null,
      todayMs: this.todayMs(at),
      todayFirst: this.dayFirst || "",
      todayLast: this.dayLast || "",
      lastGreetAt: this.lastGreetAt || 0,
      transitions: this.transitions.slice(-8),
    };
  }
}

/* 按 MAC 共享：设备重连 / WebSocket 换会话不会丢掉今日统计和问候冷却 */
const book = new Map();

export function presenceFor(mac, id) {
  const key = mac || id || "unknown";
  let p = book.get(key);
  if (!p) {
    p = new PresenceState();
    book.set(key, p);
  }
  return p;
}

export function presenceBook() {
  return book;
}
