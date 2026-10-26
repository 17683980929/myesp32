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
    /** 管理页/API 的绑定地址。公网部署建议 127.0.0.1，只让 nginx 转发 */
    host: "0.0.0.0",
    /** 设备 WS 专用端口：只挂 /device，给板子直连（不经过 nginx）。
     *  设成和 port 相同 = 不拆分（旧的单端口行为）。 */
    devicePort: 8081,
    /** 设备端口的绑定地址，公网部署要保持 0.0.0.0 */
    deviceHost: "0.0.0.0",
    /** CI 上传固件用的 token（GitHub Actions 的 secret）。空 = 关闭上传接口 */
    uploadToken: "",
    /** 设备连接鉴权 token。空字符串 = 不鉴权（公网部署必须设置） */
    authToken: "",
    /** 配置网页密码。空字符串 = 不鉴权（公网部署必须设置） */
    adminPassword: "",
    /** 公网访问基地址，例如 http://1.2.3.4:8080 或 https://pet.example.com。
     *  OTA 用它拼设备下载地址；留空则用"设备连接上看到的服务器地址"
     *  （局域网够用，云服务器上那是内网 IP，设备连不上）。 */
    publicUrl: "",
  },
  /** 定时播报：用课表 + 北京时间，到点让设备说一句 */
  reminders: {
    enabled: true,
    classLeadMin: 10,        /* 课前几分钟提醒 */
    classEndAfterMin: 40,    /* 上课后多少分钟算下课（补课表每节 40 分钟） */
    waterEnabled: true,      /* 喝水：她上完课后的课间中点提醒 */
    waterStartHour: 8,
    waterEndHour: 17,
    morningEnabled: true,
    morningHour: 6,
    morningMinute: 50,
    /** 纪念日/生日：早间问候里加一句"距离 X 还有 N 天"（date 用 MM-DD） */
    anniversary: { enabled: false, date: "", label: "纪念日" },
  },
  /** 板子显示哪一轮补课（1/2/3）。语音切换会改这里，重连时服务器再推给设备 */
  timetable: { round: 1 },
  /** 语音设的闹钟（服务器持久化）：[{ id, at, text }] */
  alarms: [],
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
  search: {
    enabled: true,
    /** 默认取几条（1~8） */
    count: 5,
    /** 同一关键词的缓存时长（秒） */
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
    /** 创造模式复杂 Lua 修改使用的模型；留空 = 与 model 相同 */
    luaModel: "",
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
      "【技能】你有工具可以查实时天气、明天/后天/未来三天的天气预报、热点新闻、当前日期时间、板子状态（电量/室内温湿度），也能联网搜索（最新消息、陌生名词、拿不准的事都先搜再答，别凭印象编）；" +
      "还能操作屏幕：打开课表、打开环境与电池页、关闭画布、切到下一个功能页。" +
      "用户提到这类事情时，直接调用对应工具拿真实结果再回答，不要说查不了；" +
      "执行屏幕操作（打开课表等）后简短确认即可，不要用问句收尾。" +
      "【天气】问明天、后天、接下来几天的天气时同样调用 get_weather，day 选对应项；" +
      "回答带上天气现象、最高最低温和降雨概率（用户问要不要带伞时尤其要说清概率），不要说只能查当前天气。" +
      "【课表】用户问今天/明天/昨天有没有课、有几节课、某天什么课、课表怎么安排时，调用 get_timetable；" +
      "回答时把节次、时间、班号都说清楚，不要只报节数。" +
      "【必须调工具】凡是改变板子状态或屏幕显示的指令（打开课表/面板、调音量、开关蓝牙），" +
      "每一次都要调用对应工具，哪怕你上一轮已经执行过、哪怕你觉得已经打开了——" +
      "绝不许只用嘴回答。",
  },
  asr: {
    provider: "tencent",
    appId: "",
    secretId: "",
    secretKey: "",
    engine: "16k_zh",
  },
  tts: {
    /** "tencent" = 腾讯云语音合成；"baidu" = 百度翻译免费接口（备用，无密钥可用） */
    provider: "tencent",
    /** 百度语速（0~15，5≈常速），provider=baidu 时生效 */
    speed: 5,
    /** 腾讯云（provider=tencent 时生效）；密钥可与「语音识别」共用同一账号 */
    tencent: {
      secretId: "",
      secretKey: "",
      /** 默认 402000 云晓芙（超自然·聊天女声）；完整分组目录见 src/voices.mjs */
      voiceType: 402000,
      /** 语速：-2~6，0 = 常速 */
      speed: 0,
      /** 音量：-10~10，0 = 正常 */
      volume: 0,
      region: "ap-guangzhou",
      /** 腾讯失败时本句回退百度（口播不能哑） */
      fallbackBaidu: true,
    },
  },
  lua: {
    /** 当前生效的脚本内容 */
    activeScript: "",
    /** 上一版，用于回滚 */
    prevScript: "",
    /** 创造模式：上一次 AI 修改前的脚本，用于“撤销上次 AI 修改” */
    aiPrevScript: "",
    aiPrevSummary: "",
    aiPrevAt: "",
    /** 最近几次 AI 应用/撤销的摘要（不含代码） */
    history: [],
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
  c.tts.tencent.secretId = mask(c.tts.tencent.secretId);
  c.tts.tencent.secretKey = mask(c.tts.tencent.secretKey);
  c.server.authToken = mask(c.server.authToken);
  c.server.adminPassword = mask(c.server.adminPassword);
  c.wifi.password = mask(c.wifi.password);
  return c;
}

/** 判断提交上来的值是不是"没改"（脱敏占位） */
export function isMasked(v) {
  return typeof v === "string" && v.startsWith("••••••");
}
