/**
 * services/weather.mjs — 天气（wttr.in 主源，Open-Meteo 备用）
 *
 * 板子不直接联网，服务器拉好天气后随信息栏一起推给设备。
 *
 * wttr.in 的 lang=zh 参数实测不可靠（返回的 lang_zh 还是英文），
 * 所以这里自己维护一张英文→中文的映射表。按「越具体越先匹配」排序。
 *
 * 国内服务器上 wttr.in 经常整站连不上；失败自动切 Open-Meteo。
 * Open-Meteo 的地理编码查不到县级中文名（如“通城县”），
 * 可在 data/weather-cities.json 里直接补经纬度。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CITY_COORDS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), "../../data/weather-cities.json");
let cityCoordsCache;
function cityCoords(city) {
  if (cityCoordsCache === undefined) {
    try { cityCoordsCache = JSON.parse(readFileSync(CITY_COORDS_PATH, "utf8")); }
    catch { cityCoordsCache = {}; }
  }
  const v = cityCoordsCache?.[city];
  const lat = Number(v?.lat), lon = Number(v?.lon);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

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

/** 单日预报：天气现象取中午 12 点，降雨概率取全天最高。 */
function forecastDay(d) {
  const hourly = Array.isArray(d.hourly) ? d.hourly : [];
  const noon = hourly.find((x) => parseInt(x.time, 10) === 1200) || hourly[Math.floor(hourly.length / 2)];

  let rain = 0;
  for (const h of hourly) {
    const v = parseInt(h.chanceofrain, 10);
    if (Number.isFinite(v) && v > rain) rain = v;
  }

  return {
    date: d.date,
    text: toChinese(noon?.weatherDesc?.[0]?.value ?? ""),
    min: parseInt(d.mintempC, 10),
    max: parseInt(d.maxtempC, 10),
    rainChance: rain,
  };
}

/** 通用 JSON 请求（带超时） */
async function fetchJson(url, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "curl/8.0" },   /* wttr.in 对浏览器 UA 会返回 HTML */
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`请求超时（${timeoutMs}ms）`);
    /* fetch failed 只是壳，真正原因在 cause（ENOTFOUND / ECONNREFUSED / 证书…） */
    const cause = e.cause?.code || e.cause?.message;
    throw new Error(cause ? `${e.message}（${cause}）` : e.message);
  } finally {
    clearTimeout(timer);
  }
}

/** "06:42 AM" / "6:42 PM" → 当天第几分钟（wttr.in 的 astronomy 格式） */
function clockToMin(s) {
  const m = /(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(String(s || ""));
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const mi = parseInt(m[2], 10);
  const ap = (m[3] || "").toUpperCase();
  if (ap === "PM" && h !== 12) h += 12;
  if (ap === "AM" && h === 12) h = 0;
  if (!(h >= 0 && h < 24) || !(mi >= 0 && mi < 60)) return null;
  return h * 60 + mi;
}

/** "2026-11-04T06:42" → 当天第几分钟（Open-Meteo 的 daily.sunrise 格式） */
function isoToMin(s) {
  const m = /T(\d{2}):(\d{2})/.exec(String(s || ""));
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}

/** 主源：wttr.in */
async function fetchWttr(city) {
  const j = await fetchJson(`https://wttr.in/${encodeURIComponent(city)}?format=j1`, 6000);
  const cur = j?.current_condition?.[0];
  if (!cur) throw new Error("天气返回格式异常");

  const descRaw = cur.weatherDesc?.[0]?.value ?? "";
  const forecast = (Array.isArray(j.weather) ? j.weather : []).slice(0, 3).map(forecastDay);

  /* 今天的日出日落（设备拿它决定窗外画太阳还是月亮） */
  const astro = j?.weather?.[0]?.astronomy?.[0];
  const sunrise = clockToMin(astro?.sunrise);
  const sunset = clockToMin(astro?.sunset);

  return {
    text: toChinese(descRaw),
    temp: parseInt(cur.temp_C ?? "0", 10),
    humidity: parseInt(cur.humidity ?? "0", 10),
    city,
    at: Date.now(),
    sunrise,
    sunset,
    forecast,
  };
}

/** WMO 天气码 → 中文（Open-Meteo 备用源） */
const WMO_ZH = {
  0: "晴", 1: "少云", 2: "多云", 3: "阴", 45: "雾", 48: "冻雾",
  51: "毛毛雨", 53: "毛毛雨", 55: "浓毛毛雨", 56: "冻毛毛雨", 57: "强冻毛毛雨",
  61: "小雨", 63: "中雨", 65: "大雨", 66: "冻雨", 67: "强冻雨",
  71: "小雪", 73: "中雪", 75: "大雪", 77: "雪粒",
  80: "小阵雨", 81: "中阵雨", 82: "强阵雨", 85: "小阵雪", 86: "强阵雪",
  95: "雷阵雨", 96: "雷阵雨伴冰雹", 99: "强雷暴伴冰雹",
};
function wmoText(code) {
  return WMO_ZH[Number(code)] ?? "未知";
}

/** 备用源：Open-Meteo（免注册；优先用内置坐标，否则地理编码） */
async function fetchOpenMeteo(city) {
  let loc = cityCoords(city);
  if (loc) {
    console.log(`[weather] 使用内置坐标：${city} ${loc.lat},${loc.lon}`);
  } else {
    const g = await fetchJson(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}` +
      `&count=1&language=zh&format=json`, 6000);
    const hit = g?.results?.[0];
    if (!hit || !Number.isFinite(hit.latitude) || !Number.isFinite(hit.longitude))
      throw new Error(`城市定位失败（查不到「${city}」，可在 data/weather-cities.json 补经纬度）`);
    loc = { lat: hit.latitude, lon: hit.longitude };
  }

  const j = await fetchJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}` +
    `&current=temperature_2m,relative_humidity_2m,weather_code` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset` +
    `&timezone=Asia%2FShanghai&forecast_days=3`, 8000);
  const c = j?.current;
  if (!c || !Number.isFinite(Number(c.temperature_2m))) throw new Error("天气返回格式异常");

  const d = j.daily || {};
  const days = Array.isArray(d.time) ? d.time : [];
  const forecast = days.slice(0, 3).map((date, i) => ({
    date,
    text: wmoText(d.weather_code?.[i]),
    min: Math.round(Number(d.temperature_2m_min?.[i] ?? 0)),
    max: Math.round(Number(d.temperature_2m_max?.[i] ?? 0)),
    rainChance: Math.round(Number(d.precipitation_probability_max?.[i] ?? 0)),
  }));

  return {
    text: wmoText(c.weather_code),
    temp: Math.round(Number(c.temperature_2m)),
    humidity: Math.round(Number(c.relative_humidity_2m ?? 0)),
    city,
    at: Date.now(),
    sunrise: isoToMin(d.sunrise?.[0]),
    sunset: isoToMin(d.sunset?.[0]),
    forecast,
  };
}

/** 拉一次天气（当前 + 3 天预报）；wttr.in 失败自动切 Open-Meteo。
 *  wttr 失败后 10 分钟内直接走备用源，避免每次刷新都白等超时。 */
let wttrDownUntil = 0;

export async function fetchWeather(cfg) {
  const city = (cfg.city || "北京").trim();

  if (Date.now() < wttrDownUntil) {
    try {
      return await fetchOpenMeteo(city);
    } catch (e) {
      throw new Error(`天气源都失败：wttr=刚失败已暂时跳过；open-meteo=${e.message}`);
    }
  }

  try {
    return await fetchWttr(city);
  } catch (e1) {
    wttrDownUntil = Date.now() + 10 * 60_000;
    try {
      const w = await fetchOpenMeteo(city);
      console.log(`[weather] wttr 失败（${e1.message}），改用 Open-Meteo`);
      return w;
    } catch (e2) {
      throw new Error(`天气源都失败：wttr=${e1.message}；open-meteo=${e2.message}`);
    }
  }
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
