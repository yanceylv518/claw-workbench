const DEFAULT_TIMEOUT_MS = Number(process.env.WEATHER_SKILL_TIMEOUT_MS || process.env.WECHAT_WEATHER_TIMEOUT_MS || 12000);

function weatherCodeLabel(code) {
  const labels = {
    0: "晴",
    1: "大部晴朗",
    2: "多云",
    3: "阴",
    45: "有雾",
    48: "雾凇",
    51: "小毛毛雨",
    53: "毛毛雨",
    55: "较强毛毛雨",
    61: "小雨",
    63: "中雨",
    65: "大雨",
    71: "小雪",
    73: "中雪",
    75: "大雪",
    80: "阵雨",
    81: "较强阵雨",
    82: "强阵雨",
    95: "雷雨",
    96: "雷雨伴冰雹",
    99: "强雷雨伴冰雹",
  };
  return labels[code] || "天气变化";
}

async function fetchJsonWithTimeout(url, timeoutMs, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 160)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function normalizeWttrWeather(payload) {
  const rows = Array.isArray(payload?.weather) ? payload.weather : [];
  if (!rows.length) return null;
  const daily = {
    time: [],
    weather_label: [],
    temperature_2m_max: [],
    temperature_2m_min: [],
    precipitation_probability_max: [],
  };
  for (const row of rows.slice(0, 7)) {
    const hourly = Array.isArray(row.hourly) ? row.hourly : [];
    const noon = hourly[Math.floor(hourly.length / 2)] || hourly[0] || {};
    const labels = Array.isArray(noon.lang_zh) ? noon.lang_zh : noon.weatherDesc;
    const rainValues = hourly.map((item) => Number(item.chanceofrain)).filter(Number.isFinite);
    daily.time.push(row.date);
    daily.weather_label.push(String(labels?.[0]?.value || "天气变化"));
    daily.temperature_2m_max.push(Number(row.maxtempC));
    daily.temperature_2m_min.push(Number(row.mintempC));
    daily.precipitation_probability_max.push(rainValues.length ? Math.max(...rainValues) : Number(noon.chanceofrain || 0));
  }
  return daily.time.length ? daily : null;
}

async function fetchWttrWeather(city, timeoutMs, place = null) {
  const query = place?.latitude && place?.longitude
    ? `~${place.latitude},${place.longitude}`
    : encodeURIComponent(city);
  const url = new URL(`https://wttr.in/${query}`);
  url.searchParams.set("format", "j1");
  url.searchParams.set("lang", "zh");
  const payload = await fetchJsonWithTimeout(url, timeoutMs, {
    headers: { "User-Agent": "openclaw-weather-skill/1.0" },
  });
  const daily = normalizeWttrWeather(payload);
  if (!daily) return null;
  const area = payload?.nearest_area?.[0] || {};
  const resolvedPlace = {
    name: place?.name || area.areaName?.[0]?.value || city,
    admin1: place?.admin1 || area.region?.[0]?.value || "",
  };
  return { ok: true, source: "wttr", place: resolvedPlace, daily };
}

async function fetchOpenMeteoWeather(city, range, timeoutMs) {
  const geoUrl = new URL("https://geocoding-api.open-meteo.com/v1/search");
  geoUrl.searchParams.set("name", city);
  geoUrl.searchParams.set("count", "1");
  geoUrl.searchParams.set("language", "zh");
  geoUrl.searchParams.set("format", "json");
  const geo = await fetchJsonWithTimeout(geoUrl, timeoutMs);
  const place = Array.isArray(geo?.results) ? geo.results[0] : null;
  if (!place) return { ok: false, reason: "city-not-found" };

  const forecastUrl = new URL("https://api.open-meteo.com/v1/forecast");
  forecastUrl.searchParams.set("latitude", String(place.latitude));
  forecastUrl.searchParams.set("longitude", String(place.longitude));
  forecastUrl.searchParams.set("daily", "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max");
  forecastUrl.searchParams.set("timezone", "auto");
  forecastUrl.searchParams.set("forecast_days", range === "week" ? "7" : "3");
  try {
    const forecast = await fetchJsonWithTimeout(forecastUrl, timeoutMs);
    return { ok: true, source: "open-meteo", place, daily: forecast.daily };
  } catch (error) {
    const fallback = await fetchWttrWeather(city, timeoutMs, place);
    if (fallback) return fallback;
    throw error;
  }
}

export async function runWeatherSkill({ city, range = "today", timeoutMs = DEFAULT_TIMEOUT_MS, logger } = {}) {
  const targetCity = String(city || "").trim();
  if (!targetCity) return { ok: false, reason: "missing-city" };

  try {
    return await fetchOpenMeteoWeather(targetCity, range, timeoutMs);
  } catch (error) {
    logger?.("WARN", "Weather skill primary source failed; fallback starting", {
      city: targetCity,
      range,
      error: String(error?.message || error),
    });
    const fallback = await fetchWttrWeather(targetCity, timeoutMs).catch((fallbackError) => {
      logger?.("WARN", "Weather skill fallback source failed", {
        city: targetCity,
        range,
        error: String(fallbackError?.message || fallbackError),
      });
      return null;
    });
    if (fallback) return fallback;
    throw error;
  }
}

function formatWeatherDate(value, index) {
  if (index === 0) return "今天";
  if (index === 1) return "明天";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return String(value || "");
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function formatSingleDate(value, index) {
  const date = new Date(`${value}T00:00:00`);
  const dateText = Number.isNaN(date.getTime()) ? "" : `${date.getMonth() + 1}月${date.getDate()}日`;
  const prefix = index === 0 ? "今天" : index === 1 ? "明天" : "";
  return [prefix, dateText].filter(Boolean).join(" ");
}

function weatherAdvice(rainChance, minTemp, maxTemp, range = "today") {
  const parts = [];
  if (rainChance >= 60) parts.push(range === "week" ? "这几天有明显降雨概率，雨具最好随身放包里。" : "降雨概率偏高，建议带伞，出门前再看一下实时天气。");
  else if (rainChance >= 30) parts.push("有一定降雨可能，通勤可以备一把伞。");
  else parts.push("降雨风险不高，按正常出行准备就好。");

  const spread = Number(maxTemp) - Number(minTemp);
  if (Number.isFinite(spread) && spread >= 10) parts.push("早晚温差比较明显，可以带一件薄外套。");
  if (Number.isFinite(maxTemp) && maxTemp >= 30) parts.push("白天体感偏热，注意补水和防晒。");
  if (Number.isFinite(minTemp) && minTemp <= 8) parts.push("早晚偏冷，外出注意保暖。");
  return parts.join("");
}

function resolvePlaceName(city, place = {}) {
  const requestedCity = String(city || "").trim();
  const placeName = String(place.name || "").trim();
  const admin1 = String(place.admin1 || "").trim();
  const hasChineseCity = /[\u4e00-\u9fa5]/u.test(requestedCity);
  const displayCity = hasChineseCity && !/[\u4e00-\u9fa5]/u.test(placeName) ? requestedCity : placeName || requestedCity;
  const displayAdmin = hasChineseCity && !/[\u4e00-\u9fa5]/u.test(admin1) ? "" : admin1;
  return [displayCity, displayAdmin].filter(Boolean).join(" / ");
}

export function buildWeatherSkillReply(city, range, weather) {
  if (!weather?.ok) {
    return `我还没查到“${city}”的天气。你可以换成更明确的城市，比如“设置城市 成都”。`;
  }

  const daily = weather.daily || {};
  const times = Array.isArray(daily.time) ? daily.time : [];
  const max = Array.isArray(daily.temperature_2m_max) ? daily.temperature_2m_max : [];
  const min = Array.isArray(daily.temperature_2m_min) ? daily.temperature_2m_min : [];
  const codes = Array.isArray(daily.weather_code) ? daily.weather_code : [];
  const labels = Array.isArray(daily.weather_label) ? daily.weather_label : [];
  const rain = Array.isArray(daily.precipitation_probability_max) ? daily.precipitation_probability_max : [];
  const placeName = resolvePlaceName(city, weather.place);

  const indexes = range === "tomorrow" ? [1] : range === "week" ? [0, 1, 2, 3, 4, 5, 6] : [0];
  const availableIndexes = indexes.filter((index) => times[index]);
  const lines = [`${placeName || city}天气`];
  if (!availableIndexes.length) {
    lines.push("");
    lines.push("天气数据暂时不完整，稍后再试一下。");
    return lines.join("\n");
  }

  if (range !== "week") {
    const index = availableIndexes[0];
    const label = labels[index] || weatherCodeLabel(codes[index]);
    const minTemp = Math.round(min[index]);
    const maxTemp = Math.round(max[index]);
    const rainChance = Number(rain[index] ?? 0);
    lines.push("");
    lines.push(formatSingleDate(times[index], index));
    lines.push(`天气：${label}`);
    lines.push(`气温：${minTemp}-${maxTemp}°C`);
    lines.push(`降雨概率：${rainChance}%`);
    lines.push(`出行建议：${weatherAdvice(rainChance, minTemp, maxTemp, range)}`);
    return lines.join("\n");
  }

  lines.push("");
  for (const index of indexes) {
    if (!times[index]) continue;
    const dateLabel = formatWeatherDate(times[index], index);
    const label = labels[index] || weatherCodeLabel(codes[index]);
    lines.push(`${dateLabel}：${label}，${Math.round(min[index])}-${Math.round(max[index])}°C，降雨概率 ${rain[index] ?? 0}%`);
  }

  const maxRain = Math.max(...availableIndexes.map((index) => Number(rain[index] || 0)));
  const minTemp = Math.min(...availableIndexes.map((index) => Number(min[index])).filter(Number.isFinite));
  const maxTemp = Math.max(...availableIndexes.map((index) => Number(max[index])).filter(Number.isFinite));
  lines.push("");
  lines.push(`出行建议：${weatherAdvice(maxRain, minTemp, maxTemp, "week")}`);
  return lines.join("\n");
}
