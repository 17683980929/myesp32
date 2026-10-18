/**
 * services/weather.mjs — 天气（wttr.in，免注册）
 *
 * 板子不直接联网，服务器拉好天气后随信息栏一起推给设备。
 *
 * wttr.in 的 lang=zh 参数实测不可靠（返回的 lang_zh 还是英文），
 * 所以这里自己维护一张英文→中文的映射表。按「越具体越先匹配」排序。
 */

const WEATHER_MAP = [
  /* 先匹配长的、具体的，避免 "Patchy light rain" 被 "Light rain" 抢先 */
  ["patchy light rain with thunder", "雷阵雨"],
  ["patchy light rain", "零星小雨"],
  ["patchy light drizzle", "零星细雨"],
  ["patchy rain nearby", "周边有雨"],
  ["patchy snow nearby", "周边有雪"],
  ["patchy light snow", "零星小雪"],
  ["patchy moderate snow", "零星中雪"],
  ["patchy heavy snow", "零星大雪"],
  ["patchy sleet nearby", "周边有雨夹雪"],
  ["moderate or heavy rain with thunder", "雷雨"],
  ["moderate or heavy rain shower", "中到大雨"],
  ["moderate or heavy snow shower", "中到大雪"],
  ["moderate or heavy sleet", "中到大雨夹雪"],
  ["light rain shower", "小阵雨"],
  ["light sleet showers", "小范围雨夹雪"],
  ["light freezing rain", "冻雨"],
  ["heavy freezing rain", "强冻雨"],
  ["light drizzle", "毛毛雨"],
  ["heavy drizzle", "浓毛毛雨"],
  ["light rain", "小雨"],
  ["moderate rain", "中雨"],
  ["heavy rain", "大雨"],
  ["light snow", "小雪"],
  ["moderate snow", "中雪"],
  ["heavy snow", "大雪"],
  ["light sleet", "小雨夹雪"],
  ["thundery outbreaks", "雷阵雨"],
  ["blizzard", "暴风雪"],
  ["blowing snow", "风吹雪"],
  ["torrential rain shower", "暴雨"],
  ["smoky haze", "烟霾"],
  ["haze", "霾"],
  ["smoke", "烟"],
  ["freezing fog", "冻雾"],
  ["patchy fog", "局部有雾"],
  ["mist", "薄雾"],
  ["fog", "雾"],
  ["overcast", "阴"],
  ["partly cloudy", "多云"],
  ["cloudy", "阴天"],
  ["sunny", "晴"],
  ["clear", "晴"],
];

/** 英文天气描述 → 中文。匹配不到就原样返回（去掉首尾空格）。 */
export function toChinese(desc) {
  if (!desc) return "未知";
  const s = String(desc).toLowerCase().trim();
  for (const [en, zh] of WEATHER_MAP) {
    if (s.includes(en)) return zh;
  }
  return desc.trim();
}

/**
 * 拉一次当前天气。
 * @returns {Promise<{text:string, temp:number, humidity:number, city:string, at:number}>}
 */
export async function fetchWeather(cfg) {
  const city = (cfg.city || "北京").trim();
  const url = `https://wttr.in/${encodeURIComponent(city)}?format=j1`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 12000);
  let res;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": "curl/8.0" },   /* wttr.in 对浏览器 UA 会返回 HTML */
      signal: ac.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === "AbortError") throw new Error("天气请求超时");
    throw new Error(`天气网络错误: ${e.message}`);
  }
  clearTimeout(timer);

  if (!res.ok) throw new Error(`天气 HTTP ${res.status}`);

  const j = await res.json();
  const cur = j?.current_condition?.[0];
  if (!cur) throw new Error("天气返回格式异常");

  const descRaw = cur.weatherDesc?.[0]?.value ?? "";

  return {
    text: toChinese(descRaw),
    temp: parseInt(cur.temp_C ?? "0", 10),
    humidity: parseInt(cur.humidity ?? "0", 10),
    city,
    at: Date.now(),
  };
}

/** 带缓存的天气：refreshSec 内不重复请求 */
export class WeatherCache {
  constructor() {
    this.data = null;
    this.fetchedAt = 0;
    this.lastError = null;
  }

  async get(cfg) {
    const ttl = Math.max(60, (cfg.refreshSec || 600)) * 1000;
    const fresh = this.data && Date.now() - this.fetchedAt < ttl;

    if (fresh) return this.data;

    try {
      this.data = await fetchWeather(cfg);
      this.fetchedAt = Date.now();
      this.lastError = null;
      console.log(`[weather] ${this.data.city} ${this.data.text} ${this.data.temp}℃`);
    } catch (e) {
      this.lastError = e.message;
      console.warn(`[weather] 失败: ${e.message}`);
      /* 失败时沿用旧数据，没有旧数据就返回 null（设备那边显示 "--"） */
    }
    return this.data;
  }
}
