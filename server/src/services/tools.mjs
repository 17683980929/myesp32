/**
 * services/tools.mjs — 助手"技能"（LLM 工具调用）
 *
 * 设备链路不走外部 MCP 进程：工具直接内置在服务器里，由 device.mjs 的
 * 对话循环执行 —— 查天气 / 查新闻 / 报时间 / 板子状态 / 控制屏幕。
 * 加新技能 = TOOLS 里加一条声明 + executeTool 里加一个 case。
 */

import { build, buildTimeInfo } from "../protocol.mjs";
import { getHotNews } from "./news.mjs";
import { webSearch } from "./search.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* 课表数据（服务器侧，供"明天有没有课/今天几节"这类问答用；
 * 板子上的 Lua 画布是另一份展示用数据） */
const TT_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../data/timetable.json");
function loadTimetable() {
  try { return JSON.parse(readFileSync(TT_PATH, "utf8")); } catch { return null; }
}

const PAGE_ZH = { home: "主页", portal: "功能画布", func: "功能页" };
const BT_ZH = { 0: "关闭", 1: "广播中", 2: "已连接" };

/* 屏幕动作 → 固件脚本事件（framework.lua 用 sys.on 接）。
 * 固件会把语音期间收到的事件暂存，播报结束回空闲后再执行。 */
const SCREEN_ACTIONS = {
  timetable: { evt: "open_timetable", zh: "打开课表" },
  env:       { evt: "open_env",       zh: "打开数据面板（环境与电池）" },
  dashboard: { evt: "open_env",       zh: "打开数据面板（环境与电池）" },
  close:     { evt: "canvas_close",   zh: "关闭画布" },
  next:      { evt: "canvas_next",    zh: "切到下一个功能页" },
};

/* ── 工具声明（OpenAI 兼容 function calling）────────────────────────── */

export const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_time",
      description: "查询当前日期、星期和准确时间（北京时间）。用户问“现在几点”“今天几号”“星期几”时调用。",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "查询桌面宠物所在城市的实时天气（天气现象、温度、湿度）。用户问天气、问冷热、要不要带伞时调用。",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_news",
      description: "查询当前热点新闻标题（头条热榜）。用户问“有什么新闻”“最近发生什么了”“热点”时调用。回答时挑 3~5 条口语化说出来即可，不要把所有标题都念一遍。",
      parameters: {
        type: "object",
        properties: {
          count: { type: "integer", description: "要几条标题，默认 6（1~10）" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "联网搜索。用户说“帮我查一下…”“搜一下…”、问最新动态/陌生人名地名公司名/你不确定的事实时调用。query 用简短关键词（像搜索框里输入的那样，5~20 字）；天气、热点新闻、时间、板子状态用各自的专用工具，不要用这个。回答时用自己的话概括，不要念网址。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索关键词" },
          count: { type: "integer", description: "要几条结果，默认 5（1~8）" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_device_status",
      description: "查询桌面宠物板子自身的状态：电量、室内温度、湿度、音量、蓝牙状态、WiFi 信号/IP、运行时长、固件版本、屏幕当前页面。用户问板子/设备的电量、温度、音量、蓝牙、网络、状态时调用。",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_timetable",
      description: "查询用户的课表。用户问今天/明天/昨天有没有课、有几节课、某天什么课、课表怎么安排时调用。参数 day 可填 today / tomorrow / yesterday / 周一..周日，默认 today。回答时把节次、时间、班号都说清楚。",
      parameters: {
        type: "object",
        properties: {
          day: { type: "string", description: "today / tomorrow / yesterday / 周一 / 周二 … / 周日" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "control_screen",
      description: "控制桌面宠物的屏幕。用户说“打开课表/让我看看课表”→timetable；“打开数据面板/环境页/看看温度和电量”→dashboard；“关掉/收起”→close；“下一个/换一页”→next。env 与 dashboard 等价。执行后简短确认即可，不要反问。",
      parameters: {
        type: "object",
        properties: {
          feature: {
            type: "string",
            enum: ["timetable", "env", "dashboard", "close", "next"],
            description: "要执行的动作",
          },
        },
        required: ["feature"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_volume",
      description: "调节桌面宠物的音量。action=up 调大、down 调小、mute 静音、unmute 恢复、set 指定 level(0~100)。用户说声音大一点/小一点、静音、音量调到百分之几时调用。执行后简短确认。",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["up", "down", "mute", "unmute", "set"] },
          level: { type: "integer", minimum: 0, maximum: 100, description: "action=set 时的目标音量 0~100" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "control_bluetooth",
      description: "控制桌面宠物的 BLE 蓝牙。action=on 打开并开始广播、off 关闭、status 查询当前状态。用户说打开蓝牙/关闭蓝牙/蓝牙状态时调用；ESP32-S3 只有 BLE，没有经典蓝牙音频。执行后简短确认。",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["on", "off", "status"] },
        },
        required: ["action"],
      },
    },
  },
];

/* ── 本地直连指令（不等大模型）───────────────────────────────────────
 * 实测 DeepSeek 对"打开课表"这类指令，第一遍会调工具、第二三遍就改成
 * 用嘴回答（"已经打开了"），导致语音开关屏幕时灵时不灵。
 * 控制类短语在本地先精确匹配：命中 → 服务器直接执行，再把执行结果
 * 塞给大模型，让它只负责用人设的口吻确认。
 * 只匹配短、命令式的句子，别把"课表上有什么课"这种问题也劫走。 */
export function matchLocalCommand(text) {
  const t = String(text ?? "").trim().replace(/[。！？!?.,，、\s]+$/g, "");
  if (!t || t.length > 20) return null;

  /* 蓝牙：状态判断要放在开关前面，避免"蓝牙开着吗"被"开蓝牙"抢走 */
  if (/蓝牙.{0,8}(状态|怎么样|开着吗|开了吗|开了没|什么状态)/.test(t) ||
      /(状态|怎么样).{0,4}蓝牙/.test(t))
    return { name: "control_bluetooth", args: { action: "status" } };
  if (/(关闭|关掉|关了|关一下|关下)蓝牙/.test(t))
    return { name: "control_bluetooth", args: { action: "off" } };
  if (/(打开|开启|开一下|开下|开)蓝牙/.test(t))
    return { name: "control_bluetooth", args: { action: "on" } };

  /* 音量（支持阿拉伯数字和中文数字："音量调到50"、"调到百分之三十"） */
  const CN = "([零一二两三四五六七八九十百\\d]+)";
  const set = (v) => { const r = setVolume(typeof v === "number" ? v : cnNum(v)); return r || null; };
  let m = t.match(new RegExp("(调到|设为|设置成|设成|到)百分之" + CN));
  if (m && set(m[2])) return set(m[2]);
  m = t.match(new RegExp("百分之" + CN + "(的)?音量"));
  if (m && set(m[1])) return set(m[1]);
  m = t.match(new RegExp("音量.{0,4}(调到|设为|设置成|设成|到)" + CN));
  if (m && set(m[2])) return set(m[2]);
  m = t.match(/音量(\d{1,3})/);
  if (m && set(m[1])) return set(m[1]);
  m = t.match(/音量.{0,2}(\d{1,3})%/);
  if (m && set(m[1])) return set(m[1]);
  if (/静音/.test(t)) return { name: "set_volume", args: { action: "mute" } };
  if (/取消静音|恢复音量|不静音/.test(t)) return { name: "set_volume", args: { action: "unmute" } };
  if (/调大音量|音量.{0,2}大|声音.{0,3}大|大点声|大声一点/.test(t))
    return { name: "set_volume", args: { action: "up" } };
  if (/调小音量|音量.{0,2}小|声音.{0,3}小|小点声|小声一点/.test(t))
    return { name: "set_volume", args: { action: "down" } };

  /* 屏幕：必须带"打开/看看/切到"这类动词，避免劫走"课表上有什么课" */
  const OPEN = "(打开|开启|看看|看下|看一下|显示|调出|调出?来|进入|切到|切到?|翻到|我要看|给我看)";
  if (/画布/.test(t) && /(关闭|收起|关掉|关了)/.test(t))
    return { name: "control_screen", args: { feature: "close" } };
  if (/下一(页|个)|换一页|切换下一个/.test(t))
    return { name: "control_screen", args: { feature: "next" } };
  if (new RegExp(OPEN + ".*(课程表|课表)").test(t))
    return { name: "control_screen", args: { feature: "timetable" } };
  if (new RegExp(OPEN + ".*((数据|环境|状态)?面板|环境页)").test(t))
    return { name: "control_screen", args: { feature: "dashboard" } };

  return null;
}

function setVolume(level) {
  const n = parseInt(level, 10);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return { name: "set_volume", args: { action: "set", level: n } };
}

/** 中文数字 → 数值（零~一百；"三十"→30、"一百"→100） */
function cnNum(s) {
  if (!s) return NaN;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const D = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  let n = 0, num = 0;
  for (const ch of s) {
    if (ch in D) num = D[ch];
    else if (ch === "十") { n += (num || 1) * 10; num = 0; }
    else if (ch === "百") { n += (num || 1) * 100; num = 0; }
    else return NaN;
  }
  return n + num;
}

/* ── 工具执行（返回给模型看的文本；出错也返回文本，让模型自然收尾）── */

/**
 * @param {string} name 工具名
 * @param {object} args 模型给的参数
 * @param {{config:object, weather:object}} ctx 服务器上下文
 * @param {object} session 当前设备会话（DeviceSession）
 */
export async function executeTool(name, args = {}, ctx, session) {
  switch (name) {
    case "get_time": {
      const t = buildTimeInfo(null);
      const y = new Date(Date.now() + 8 * 3600e3).getUTCFullYear();
      return `现在是 ${y}年${t.date} ${t.week} ${t.time}（北京时间）。`;
    }

    case "get_weather": {
      const wc = ctx.config.weather ?? {};
      if (wc.enabled === false) return "天气功能没开启。";
      try {
        const w = await ctx.weather.get(wc);
        if (!w || !w.text) return "天气源暂时拿不到数据。";
        const h = Number.isFinite(w.humidity) ? `，湿度 ${w.humidity}%` : "";
        return `${w.city || wc.city}当前天气：${w.text}，气温 ${w.temp}℃${h}。`;
      } catch (e) {
        return `查天气失败：${e.message}`;
      }
    }

    case "get_news": {
      if (ctx.config.news?.enabled === false) return "新闻查询没开启。";
      const count = Math.min(10, Math.max(1, Math.round(Number(args.count)) || ctx.config.news?.count || 6));
      try {
        const { list, source } = await getHotNews(ctx.config.news ?? {});
        const items = list.slice(0, count).map((s, i) => `${i + 1}. ${s}`).join("\n");
        return `当前热点（来源：${source}）：\n${items}`;
      } catch (e) {
        return `查新闻失败：${e.message}`;
      }
    }

    case "web_search": {
      if (ctx.config.search?.enabled === false) return "联网搜索没开启。";
      const q = String(args.query ?? "").trim();
      if (!q) return "没给搜索关键词。";
      const count = Math.min(8, Math.max(1, Math.round(Number(args.count)) || ctx.config.search?.count || 5));
      try {
        const { source, items } = await webSearch(q, ctx.config.search ?? {}, count);
        const lines = items.map((it, i) => `${i + 1}. ${it.title}${it.snippet ? " — " + it.snippet : ""}`).join("\n");
        return `关于“${q}”的搜索结果（来源：${source}）：\n${lines}`;
      } catch (e) {
        return `搜索失败：${e.message}`;
      }
    }

    case "get_device_status": {
      const parts = [`固件 ${session.fw || "未知"}`, `机器码 ${session.mac || "未知"}`];
      if (session.page) parts.push(`屏幕当前在${PAGE_ZH[session.page] ?? session.page}`);
      const st = session.lastStat;
      if (st && Number.isFinite(st.bat) && st.bat >= 0) parts.push(`电量 ${st.bat}%`);
      else parts.push("电量读数暂无");
      const room = st?.room ?? {};
      if (Number.isFinite(room.t) && room.t > -50) parts.push(`室内温度 ${room.t.toFixed(1)}℃`);
      if (Number.isFinite(room.h) && room.h > -0.5) parts.push(`室内湿度 ${room.h}%`);
      if (st && Number.isFinite(st.vol)) parts.push(`音量 ${st.vol}%`);
      if (st && Number.isFinite(st.bt)) parts.push(`蓝牙${BT_ZH[st.bt] ?? st.bt}`);
      if (st?.bn) parts.push(`蓝牙广播名 ${st.bn}`);
      if (st?.ssid) parts.push(`WiFi ${st.ssid}`);
      if (st && Number.isFinite(st.rssi) && st.rssi > -127) parts.push(`WiFi 信号 ${st.rssi}dBm`);
      if (st?.ip) parts.push(`IP ${st.ip}`);
      if (st && Number.isFinite(st.up)) parts.push(`已运行 ${Math.floor(st.up / 60)} 分钟`);
      return `板子状态：${parts.join("；")}。`;
    }

    case "get_timetable": {
      const tt = loadTimetable();
      if (!tt || !Array.isArray(tt.grid)) return "课表数据还没配置好。";

      const DAYS = tt.days;
      const now = new Date(Date.now() + 8 * 3600e3);      /* 北京时间 */
      const todayIdx = (now.getUTCDay() + 6) % 7;         /* 0=周一 */
      const arg = String(args.day ?? "today").trim();
      let idx = todayIdx;
      if (arg === "明天" || arg === "tomorrow") idx = (todayIdx + 1) % 7;
      else if (arg === "昨天" || arg === "yesterday") idx = (todayIdx + 6) % 7;
      else {
        const i = DAYS.indexOf(arg);
        if (i >= 0) idx = i;
      }

      const d = new Date(now.getTime() + ((idx - todayIdx + 7) % 7) * 86400e3);
      const dateLabel = `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;

      const cells = [];
      for (let r = 0; r < tt.grid.length && r < tt.periods.length; r++) {
        const v = tt.grid[r]?.[idx];
        if (v) cells.push(`${tt.periods[r].label} ${tt.periods[r].time} ${v}班`);
      }
      if (!cells.length) return `${DAYS[idx]}（${dateLabel}）没有课。`;
      return `${DAYS[idx]}（${dateLabel}）共 ${cells.length} 节课：${cells.join("；")}。`;
    }

    case "control_screen": {
      const act = SCREEN_ACTIONS[String(args.feature ?? "").trim()];
      if (!act) return "未识别的屏幕动作（可用：timetable / dashboard / close / next）。";
      session.send(build.evt(act.evt));
      return `已发指令：${act.zh}（屏幕马上会更新）。`;
    }

    case "set_volume": {
      if (!(session.caps || []).includes("ctl")) {
        return "当前设备固件还不支持语音音量控制，需要先升级到 0.1.7。";
      }
      const action = String(args.action ?? "").trim();
      if (action === "set") {
        const level = Math.round(Number(args.level));
        if (!Number.isFinite(level) || level < 0 || level > 100) return "音量值需要是 0~100 的数字。";
        session.send(build.evt("volume_set", level));
        if (session.lastStat) session.lastStat.vol = level;
        return `已把音量调到 ${level}%。`;
      }
      const map = {
        up: ["volume_up", "调大音量"],
        down: ["volume_down", "调小音量"],
        mute: ["volume_mute", "静音"],
        unmute: ["volume_unmute", "恢复音量"],
      };
      const hit = map[action];
      if (!hit) return "未识别的音量动作（可用：up / down / mute / unmute / set）。";
      session.send(build.evt(hit[0]));
      return `已${hit[1]}。`;
    }

    case "control_bluetooth": {
      if (!(session.caps || []).includes("bt")) {
        return "当前设备固件还不支持 BLE 蓝牙控制，需要先升级到 0.1.8。";
      }
      const name = session.lastStat?.bn ? `，手机搜索「${session.lastStat.bn}」就能连` : "";
      const action = String(args.action ?? "").trim();
      if (action === "on") {
        const before = session.lastStat?.at ?? 0;
        session.send(build.evt("bt_on"));
        const bt = await session.waitBt(before, 1800);   /* 等设备回真实状态，别替它说谎 */
        const name2 = session.lastStat?.bn ? `，手机搜索「${session.lastStat.bn}」就能连` : "";
        if (bt === 1) return `蓝牙已打开并开始广播${name2}。`;
        if (bt === 2) return `蓝牙已打开，已经有手机连上了${name2}。`;
        if (bt === 0) return "设备回报蓝牙仍是关闭状态（广播没起来，通常是内部内存不足），请稍后再试一次。";
        return "打开蓝牙的指令已发出，但设备没有回报新状态（可能重启或掉线了），请稍后再问一次蓝牙状态。";
      }
      if (action === "off") {
        const before = session.lastStat?.at ?? 0;
        session.send(build.evt("bt_off"));
        const bt = await session.waitBt(before, 1200);
        if (bt === 0) return "已关闭蓝牙。";
        if (bt === undefined) return "关闭蓝牙的指令已发出，但设备没有回报新状态，请稍后再确认一次。";
        return "指令已发出，但设备回报蓝牙还没关掉，请再试一次。";
      }
      if (action === "status") {
        const bt = session.lastStat?.bt;
        if (!Number.isFinite(bt)) return "设备还没上报蓝牙状态，稍后再问一次。";
        return bt ? `蓝牙当前${BT_ZH[bt]}${name}。` : `蓝牙当前关闭。要打开的话直接说"打开蓝牙"。`;
      }
      return "未识别的蓝牙动作（可用：on / off / status）。";
    }

    default:
      return `未知工具：${name}`;
  }
}
