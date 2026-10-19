/**
 * config.mjs — 配置读写
 *
 * 配置存 server/config.json。首次启动如果不存在，用内置默认值创建。
 * 配置网页（/admin）改的就是这个文件，改完即时生效（服务内部读缓存）。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..");
export const CONFIG_PATH = path.join(ROOT, "config.json");

export const DEFAULT_CONFIG = {
  server: {
    port: 8080,
    host: "0.0.0.0",
    /** 设备连接鉴权 token。空字符串 = 不鉴权（公网部署必须设置） */
    authToken: "",
    /** 配置网页密码。空字符串 = 不鉴权（公网部署必须设置） */
    adminPassword: "",
  },
  device: {
    name: "MyEsp32",
    /** 允许连接的设备 MAC 白名单，空数组 = 不限制 */
    macAllowList: [],
  },
  wifi: {
    /** 下发给设备的 WiFi（SoftAP 配网时可覆盖） */
    ssid: "",
    password: "",
  },
  weather: {
    enabled: true,
    source: "wttr.in",
    city: "北京",
    /** 多久拉一次天气（秒） */
    refreshSec: 600,
  },
  news: {
    enabled: true,
    /** 新闻源：auto=头条主源、微博兜底；也可写 toutiao / weibo */
    source: "auto",
    /** 默认取几条（1~10） */
    count: 6,
    /** 缓存时长（秒） */
    refreshSec: 600,
  },
  info: {
    /** 信息栏推送间隔（秒） */
    pushSec: 60,
  },
  llm: {
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    apiKey: "",
    model: "deepseek-flash",
    maxTokens: 4096,
    temperature: 0.7,
    /** 允许模型调用工具（查天气/新闻/控制屏幕等）；个别网关不支持时自动降级 */
    tools: true,
    systemPrompt:
      "你叫小鱼，是一个桌面语音助手，说话自然、口语化，像一个真人朋友。" +
      "回答长度跟着内容走：简单的事一两句说清，复杂的事、需要解释的内容就把话讲透；" +
      "每次都要把回答讲完整再收尾，该短则短、该长则长——不为了短而漏掉关键信息，也不啰嗦。" +
      "不要列表、不要 markdown、不要解释思考过程。" +
      "【连续对话】这是语音连续对话：如果你判断用户可能还想接着说、或刚才的内容还有明显的后续可以展开，" +
      "就用一句简短的问句收尾（比如“需要我再详细讲讲吗？”），说完后能直接听到用户的回答；" +
      "如果已经讲完，就正常收尾，不要为了问而问。" +
      "【重要例外】当用户要求讲故事、讲得更详细或更长、或提到时长（比如“5分钟的故事”）时：" +
      "要把内容当口播稿来写，按每分钟约 240 字写足（提到 5 分钟就写到 1200 字以上），" +
      "情节不够就用对话、动作、环境描写展开；没写够目标长度之前绝对不能收尾、不能总结，" +
      "结尾只允许出现在故事真正讲完之后，宁可写长也不要写短。" +
      "【技能】你有工具可以查实时天气、热点新闻、当前日期时间、板子状态（电量/室内温湿度）；" +
      "还能操作屏幕：打开课表、打开环境与电池页、关闭画布、切到下一个功能页。" +
      "用户提到这类事情时，直接调用对应工具拿真实结果再回答，不要说查不了；" +
      "执行屏幕操作（打开课表等）后简短确认即可，不要用问句收尾。",
  },
  asr: {
    provider: "tencent",
    appId: "",
    secretId: "",
    secretKey: "",
    engine: "16k_zh",
  },
  tts: {
    provider: "baidu",
    speed: 5,
  },
  lua: {
    /** 当前生效的脚本内容 */
    activeScript: "",
    /** 上一版，用于回滚 */
    prevScript: "",
  },
};

/** 深合并：对象递归，数组和标量直接覆盖 */
function deepMerge(base, patch) {
  if (Array.isArray(patch) || patch === null || typeof patch !== "object") {
    return patch === undefined ? base : patch;
  }
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = k in base && typeof base[k] === "object" && base[k] !== null && !Array.isArray(base[k])
      ? deepMerge(base[k], v)
      : v;
  }
  return out;
}

let cache = null;

export function loadConfig() {
  if (cache) return cache;

  if (!existsSync(CONFIG_PATH)) {
    cache = structuredClone(DEFAULT_CONFIG);
    writeFileSync(CONFIG_PATH, JSON.stringify(cache, null, 2), "utf8");
    return cache;
  }

  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    /* 用默认值补齐缺失字段，老配置升级不会炸 */
    cache = deepMerge(structuredClone(DEFAULT_CONFIG), raw);
  } catch (e) {
    throw new Error(`config.json 解析失败: ${e.message}`);
  }
  return cache;
}

export function saveConfig(patch) {
  const next = deepMerge(loadConfig(), patch);
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), "utf8");

  /* 原地更新，不替换对象 —— 上层（ctx.config）持有的是同一个引用，
     一旦替换成新对象，各模块读到的还是旧配置。 */
  for (const k of Object.keys(cache)) delete cache[k];
  Object.assign(cache, next);
  return cache;
}

export function getConfig() {
  return loadConfig();
}

/** 给配置网页用的脱敏副本：密钥只回显是否已配置 */
export function maskedConfig() {
  const c = structuredClone(loadConfig());
  const mask = (v) => (v ? "••••••" + String(v).slice(-4) : "");
  c.llm.apiKey = mask(c.llm.apiKey);
  c.asr.secretId = mask(c.asr.secretId);
  c.asr.secretKey = mask(c.asr.secretKey);
  c.server.authToken = mask(c.server.authToken);
  c.server.adminPassword = mask(c.server.adminPassword);
  c.wifi.password = mask(c.wifi.password);
  return c;
}

/** 判断提交上来的值是不是"没改"（脱敏占位） */
export function isMasked(v) {
  return typeof v === "string" && v.startsWith("••••••");
}
