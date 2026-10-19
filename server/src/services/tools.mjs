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

const PAGE_ZH = { home: "主页", portal: "功能画布", func: "功能页" };

/* 屏幕动作 → 固件脚本事件（framework.lua 用 sys.on 接）。
 * 固件会把语音期间收到的事件暂存，播报结束回空闲后再执行。 */
const SCREEN_ACTIONS = {
  timetable: { evt: "open_timetable", zh: "打开课表" },
  env:       { evt: "open_env",       zh: "打开环境与电池页" },
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
      description: "查询桌面宠物板子自身的状态：电量、室内温度、湿度、固件版本、屏幕当前页面。用户问板子/设备的电量、温度、状态时调用。",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "control_screen",
      description: "控制桌面宠物的屏幕。用户说“打开课表/让我看看课表”→timetable；“打开环境页/看看温度和电量”→env；“关掉/收起”→close；“下一个/换一页”→next。执行后简短确认即可，不要反问。",
      parameters: {
        type: "object",
        properties: {
          feature: {
            type: "string",
            enum: ["timetable", "env", "close", "next"],
            description: "要执行的动作",
          },
        },
        required: ["feature"],
      },
    },
  },
];

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
      return `板子状态：${parts.join("；")}。`;
    }

    case "control_screen": {
      const act = SCREEN_ACTIONS[String(args.feature ?? "").trim()];
      if (!act) return "未识别的屏幕动作（可用：timetable / env / close / next）。";
      session.send(build.evt(act.evt));
      return `已发指令：${act.zh}（屏幕马上会更新）。`;
    }

    default:
      return `未知工具：${name}`;
  }
}
