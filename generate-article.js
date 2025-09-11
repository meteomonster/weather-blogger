// generate-article.js
// Требуется Node 18+ и package.json с { "type": "module" }

import axios from "axios";
import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "fs";

/* ──────────────────────────────────────────────────────────────────────────
   0) НАСТРОЙКИ
   ────────────────────────────────────────────────────────────────────────── */
const LAT = Number(process.env.BLOG_LAT || 56.95);
const LON = Number(process.env.BLOG_LON || 24.10);
const PLACE_LABEL = process.env.BLOG_PLACE || "Рига, Латвия";
const TZ = process.env.BLOG_TZ || "Europe/Riga";

const timeOfDay = (process.argv[2] || "morning").toLowerCase();
const TOD_RU = { morning: "утренний", afternoon: "дневной", evening: "вечерний", night: "ночной" };
const timeOfDayRu = TOD_RU[timeOfDay] || timeOfDay;

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error("Ошибка: переменная окружения GEMINI_API_KEY не задана.");
  process.exit(1);
}
const genAI = new GoogleGenerativeAI(API_KEY);

// Для качества текста лучше pro, но оставим фолбэки
const MODEL_PRIMARY = process.env.GEMINI_MODEL || "gemini-1.5-pro-latest";
const MODEL_FALLBACKS = ["gemini-1.5-flash-latest", "gemini-1.5-flash"];

/* ──────────────────────────────────────────────────────────────────────────
   1) ВСПОМОГАТЕЛЬНЫЕ
   ────────────────────────────────────────────────────────────────────────── */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function isoDateInTZ(date, tz) {
  return new Date(date).toLocaleString("sv-SE", { timeZone: tz }).slice(0, 10);
}
function isFiniteNum(x) {
  return typeof x === "number" && Number.isFinite(x);
}
function roundInt(x) {
  return isFiniteNum(x) ? Math.round(x) : null;
}
function dayOfYearKey(iso) {
  return iso?.slice(5, 10);
}
function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v));
}
function degToCompass(d) {
  if (!isFiniteNum(d)) return null;
  const dirs = ["С","ССВ","СВ","ВСВ","В","ВЮВ","ЮВ","ЮЮВ","Ю","ЮЮЗ","ЮЗ","ЗЮЗ","З","ЗСЗ","СЗ","ССЗ"];
  return dirs[Math.round((d % 360) / 22.5) % 16];
}
function circularMeanDeg(values) {
  const rad = values.filter(isFiniteNum).map(v => (v * Math.PI) / 180);
  if (!rad.length) return null;
  const x = rad.reduce((a, r) => a + Math.cos(r), 0) / rad.length;
  const y = rad.reduce((a, r) => a + Math.sin(r), 0) / rad.length;
  let deg = (Math.atan2(y, x) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  return deg;
}
function sanitizeText(t) {
  // никакого Markdown + чистим пустые строки
  return String(t || "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[>#*_`]+/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
function safeAvg(arr) {
  const v = (arr || []).filter(isFiniteNum);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
function seedFromDate() {
  const iso = isoDateInTZ(new Date(), TZ); // YYYY-MM-DD
  return Number(iso.replace(/-/g, "")) % 2147483647;
}
function pickBySeed(arr, seed) {
  if (!arr?.length) return null;
  const idx = seed % arr.length;
  return arr[idx];
}

/* ──────────────────────────────────────────────────────────────────────────
   2) ТЕКУЩАЯ ПОГОДА (Open‑Meteo)
   ────────────────────────────────────────────────────────────────────────── */
async function getCurrentWeather(lat = LAT, lon = LON) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,apparent_temperature,wind_speed_10m,wind_gusts_10m,precipitation,weather_code` +
    `&timezone=auto&windspeed_unit=ms`;
  try {
    const { data } = await axios.get(url, { timeout: 12000 });
    const c = data?.current || {};
    return {
      time: c.time || new Date().toISOString(),
      t: c.temperature_2m ?? null,
      at: c.apparent_temperature ?? null,
      ws: c.wind_speed_10m ?? null,
      wg: c.wind_gusts_10m ?? null,
      pr: c.precipitation ?? 0,
      wc: c.weather_code ?? null,
      tz: data?.timezone || TZ
    };
  } catch (e) {
    console.warn("getCurrentWeather:", e.message);
    return null;
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   3) ПРОГНОЗ (MET.NO) — агрегируем суточные индикаторы
   ────────────────────────────────────────────────────────────────────────── */
async function getForecastMETNO(lat = LAT, lon = LON) {
  const url = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat}&lon=${lon}`;
  try {
    const { data } = await axios.get(url, {
      headers: { "User-Agent": "WeatherBloggerApp/2.0 (+https://github.com/meteomonster)" },
      timeout: 20000
    });
    const ts = data?.properties?.timeseries || [];
    if (!ts.length) throw new Error("Пустой timeseries MET.NO");

    const byDay = new Map();
    for (const e of ts) {
      const isoLocal = isoDateInTZ(e.time, TZ);
      if (!byDay.has(isoLocal)) byDay.set(isoLocal, []);
      const inst = e?.data?.instant?.details || {};
      const next1 = e?.data?.next_1_hours || null;
      const pr1h = isFiniteNum(next1?.summary?.precipitation_amount)
        ? next1.summary.precipitation_amount
        : isFiniteNum(next1?.details?.precipitation_amount)
        ? next1.details.precipitation_amount
        : null;

      byDay.get(isoLocal).push({
        t: inst.air_temperature ?? null,
        ws: inst.wind_speed ?? null,
        wg: inst.wind_speed_of_gust ?? null,
        wd: inst.wind_from_direction ?? null,
        cc: inst.cloud_area_fraction ?? null,
        pr: pr1h ?? 0
      });
    }

    const days = Array.from(byDay.keys()).sort().slice(0, 7).map((date) => {
      const arr = byDay.get(date) || [];
      const tVals = arr.map(a => a.t).filter(isFiniteNum);
      const wsVals = arr.map(a => a.ws).filter(isFiniteNum);
      const wgVals = arr.map(a => a.wg).filter(isFiniteNum);
      const wdVals = arr.map(a => a.wd).filter(isFiniteNum);
      const ccVals = arr.map(a => a.cc).filter(isFiniteNum);
      const prVals = arr.map(a => a.pr).filter(isFiniteNum);

      const tmax = tVals.length ? Math.max(...tVals) : null;
      const tmin = tVals.length ? Math.min(...tVals) : null;
      const prSum = prVals.reduce((s, v) => s + (v || 0), 0);
      const prMax = prVals.length ? Math.max(...prVals) : 0;
      const wsMax = wsVals.length ? Math.max(...wsVals) : null;
      const wgMax = wgVals.length ? Math.max(...wgVals) : null;
      const domDeg = circularMeanDeg(wdVals);
      const ccMax = ccVals.length ? Math.max(...ccVals) : null;

      // простая "ощущается" поправка на сильный ветер
      const windAdj = (wsMax || 0) >= 8 ? 1 : 0;

      // Индекс комфорта (0..10): осадки, ветер, температура
      let comfort = 10;
      if (isFiniteNum(prSum)) {
        if (prSum >= 8) comfort -= 4;
        else if (prSum >= 3) comfort -= 2;
        else if (prSum >= 1) comfort -= 1;
      }
      if (isFiniteNum(wgMax)) {
        if (wgMax >= 20) comfort -= 3;
        else if (wgMax >= 15) comfort -= 2;
        else if (wgMax >= 10) comfort -= 1;
      }
      if (isFiniteNum(tmax)) {
        if (tmax >= 30 || tmax <= -5) comfort -= 3;
        else if (tmax >= 26 || tmax <= 0) comfort -= 2;
        else if (tmax >= 23) comfort -= 1;
      }
      comfort = clamp(Math.round(comfort), 0, 10);

      // Индекс астропросмотра (0..5): облачность и ветер
      let astro = 0;
      if (isFiniteNum(ccMax)) {
        if (ccMax <= 25) astro = 5;
        else if (ccMax <= 40) astro = 4;
        else if (ccMax <= 60) astro = 3;
        else if (ccMax <= 80) astro = 2;
        else astro = 1;
      }
      if (isFiniteNum(wgMax) && wgMax >= 18) astro = Math.max(1, astro - 1);

      return {
        date,
        tmax, tmin,
        tmax_int: roundInt(tmax),
        tmin_int: roundInt(tmin),
        app_tmax: isFiniteNum(tmax) ? tmax - windAdj : null,
        app_tmin: isFiniteNum(tmin) ? tmin - windAdj : null,
        ws_max: wsMax,
        wg_max: wgMax,
        wd_dom: isFiniteNum(domDeg) ? domDeg : null,
        wd_compass: degToCompass(domDeg),
        cloud_max: ccMax,
        pr_sum: prSum,
        pr_1h_max: prMax,
        comfort_index: comfort, // 0..10
        astro_index: astro      // 0..5
      };
    });

    return { days, provider: "MET.NO", tz: TZ, place: PLACE_LABEL, lat, lon };
  } catch (e) {
    console.error("getForecastMETNO:", e.message);
    throw e;
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   4) СОЛНЦЕ (Open‑Meteo: восход/закат) — для длины дня и динамики
   ────────────────────────────────────────────────────────────────────────── */
async function getSunData(lat = LAT, lon = LON) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&daily=sunrise,sunset&forecast_days=8&timezone=${encodeURIComponent(TZ)}&timeformat=iso8601`;
  try {
    const { data } = await axios.get(url, { timeout: 12000 });
    const t = data?.daily?.time || [];
    const sr = data?.daily?.sunrise || [];
    const ss = data?.daily?.sunset || [];
    const rows = [];
    for (let i = 0; i < t.length; i++) {
      const srT = sr[i] ? new Date(sr[i]) : null;
      const ssT = ss[i] ? new Date(ss[i]) : null;
      const durMin = srT && ssT ? Math.round((ssT - srT) / 60000) : null;
      rows.push({
        date: t[i],
        sunrise_iso: sr[i] || null,
        sunset_iso: ss[i] || null,
        daylight_min: durMin
      });
    }
    return rows.slice(0, 7);
  } catch (e) {
    console.warn("getSunData:", e.message);
    return [];
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   5) КЛИМАТ (нормы) и РЕКОРДЫ (архив) — Open‑Meteo Archive
   ────────────────────────────────────────────────────────────────────────── */
async function getClimoAndRecords(lat = LAT, lon = LON) {
  const startNorm = 1991, endNorm = 2020;
  const startRec = 1979, endRec = new Date().getUTCFullYear() - 1;

  async function fetchDailyRange(startY, endY) {
    const url =
      `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}` +
      `&start_date=${startY}-01-01&end_date=${endY}-12-31` +
      `&daily=temperature_2m_max,temperature_2m_min&timezone=UTC`;
    const { data } = await axios.get(url, { timeout: 30000 });
    return data?.daily || {};
  }

  // Нормы
  let normals = {};
  try {
    const d = await fetchDailyRange(startNorm, endNorm);
    const t = d.time || [];
    const tx = d.temperature_2m_max || [];
    const tn = d.temperature_2m_min || [];
    const map = new Map();
    for (let i = 0; i < t.length; i++) {
      const mmdd = t[i].slice(5, 10);
      if (mmdd === "02-29") continue;
      const rec = map.get(mmdd) || { sumMax: 0, sumMin: 0, n: 0 };
      if (isFiniteNum(tx[i])) rec.sumMax += tx[i];
      if (isFiniteNum(tn[i])) rec.sumMin += tn[i];
      rec.n++;
      map.set(mmdd, rec);
    }
    for (const [k, v] of map) {
      normals[k] = {
        tmax_norm: v.n ? v.sumMax / v.n : null,
        tmin_norm: v.n ? v.sumMin / v.n : null
      };
    }
  } catch (e) {
    console.warn("normals failed:", e.message);
  }

  // Рекорды
  let records = {};
  try {
    const d = await fetchDailyRange(startRec, endRec);
    const t = d.time || [];
    const tx = d.temperature_2m_max || [];
    const tn = d.temperature_2m_min || [];
    const map = new Map();
    for (let i = 0; i < t.length; i++) {
      const mmdd = t[i].slice(5, 10);
      const y = +t[i].slice(0, 4);
      let rec = map.get(mmdd) || { recMax: -Infinity, yearMax: null, recMin: +Infinity, yearMin: null };
      if (isFiniteNum(tx[i]) && tx[i] > rec.recMax) { rec.recMax = tx[i]; rec.yearMax = y; }
      if (isFiniteNum(tn[i]) && tn[i] < rec.recMin) { rec.recMin = tn[i]; rec.yearMin = y; }
      map.set(mmdd, rec);
    }
    for (const [k, v] of map) {
      records[k] = {
        tmax_record: isFiniteNum(v.recMax) ? v.recMax : null,
        year_record_max: v.yearMax,
        tmin_record: isFiniteNum(v.recMin) ? v.recMin : null,
        year_record_min: v.yearMin
      };
    }
  } catch (e) {
    console.warn("records failed:", e.message);
  }

  return { normals, records, base: { lat, lon, place: PLACE_LABEL } };
}

/* ──────────────────────────────────────────────────────────────────────────
   6) МИРОВЫЕ СОБЫТИЯ (USGS, NHC)
   ────────────────────────────────────────────────────────────────────────── */
async function getGlobalEvents() {
  const out = { earthquakes: [], tropical_cyclones: [] };
  try {
    const eqUrl = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=now-24hours&minmagnitude=5.5`;
    const { data } = await axios.get(eqUrl, { timeout: 15000 });
    out.earthquakes = (data?.features || []).map(f => ({
      magnitude: f?.properties?.mag ?? null,
      location: f?.properties?.place ?? null
    }));
  } catch (e) { console.warn("USGS:", e.message); }

  try {
    const { data } = await axios.get("https://www.nhc.noaa.gov/CurrentStorms.json", { timeout: 15000 });
    if (data?.storms) {
      out.tropical_cyclones = data.storms.map(s => {
        const m = s.intensity?.match(/(\d+)\s*KT/);
        const kt = m ? parseInt(m[1], 10) : 0;
        return { name: `${s.classification} «${s.name}»`, wind_kmh: Math.round(kt * 1.852) };
      });
    }
  } catch (e) { console.warn("NHC:", e.message); }

  return out;
}

/* ──────────────────────────────────────────────────────────────────────────
   7) ФАКТЫ/РУБРИКИ ДНЯ — офлайн пул, стабильный выбор по дате
   ────────────────────────────────────────────────────────────────────────── */
function getLocalFactOfDay() {
  const facts = [
    "Средний кругооборот воды в атмосфере занимает около 9 дней: столько в среднем «живет» водяной пар, прежде чем выпадет осадками.",
    "Кучево‑дождевые облака могут достигать 12–16 км в высоту — это выше полёта большинства лайнеров.",
    "Одно грозовое облако способно выделять энергии больше, чем небольшая электростанция за сутки.",
    "Запах «дождя» — это смесь озона, геосмина и растительных масел, на сухом грунте они пахнут особенно ярко.",
    "Тёплый воздух может удерживать больше влаги: каждые +10°C почти удваивают потенциальную влажность.",
    "На Балтике бризы летом могут менять температуру прибрежной полосы на 5–7°С в течение часа.",
    "Самая «ветреная» сторона циклонов в наших широтах — юго‑западная и западная периферия.",
    "Град формируется в мощных восходящих потоках: чем сильнее подъём, тем крупнее лёд успевает «нарастить слои».",
    "Дождь из перистых облаков невозможен: слишком мало влаги и слишком низкие скорости вертикальных движений.",
    "Морось — это осадки из капель <0,5 мм; именно она чаще всего ответственна за «мокрый туман»."
  ];
  return pickBySeed(facts, seedFromDate()) || facts[0];
}

/* ──────────────────────────────────────────────────────────────────────────
   8) АНАЛИТИКА: аномалии, риски, вероятность рекорда, «сигналы»
   ────────────────────────────────────────────────────────────────────────── */
function buildInsights(forecast, climo, sunRows) {
  const insights = {
    anomalies: [],              // [{ date, tmax_anom, tmin_anom, tmax_norm, tmin_norm }]
    record_risk: [],           // [{ date, forecast_tmax, record_tmax, record_year, delta }]
    heavy_precip_days: [],     // [{ date, pr_sum, pr_1h_max }]
    windy_days: [],            // [{ date, ws_max, wg_max }]
    warm_spikes: [],           // даты с tmax_anom >= +4
    cold_dips: [],             // даты с tmax_anom <= -4
    headlines: [],             // для заголовка
    daylight: sunRows || []    // [{ date, daylight_min }]
  };

  for (const d of forecast.days) {
    const key = dayOfYearKey(d.date);
    const norm = climo.normals[key] || {};
    const recs = climo.records[key] || {};

    const tmax_anom = (isFiniteNum(d.tmax) && isFiniteNum(norm.tmax_norm)) ? (d.tmax - norm.tmax_norm) : null;
    const tmin_anom = (isFiniteNum(d.tmin) && isFiniteNum(norm.tmin_norm)) ? (d.tmin - norm.tmin_norm) : null;

    insights.anomalies.push({
      date: d.date,
      tmax_anom, tmin_anom,
      tmax_norm: norm.tmax_norm ?? null,
      tmin_norm: norm.tmin_norm ?? null
    });

    if (isFiniteNum(tmax_anom)) {
      if (tmax_anom >= 4) insights.warm_spikes.push(d.date);
      if (tmax_anom <= -4) insights.cold_dips.push(d.date);
    }

    if (isFiniteNum(d.tmax) && isFiniteNum(recs.tmax_record) && d.tmax >= (recs.tmax_record - 1)) {
      insights.record_risk.push({
        date: d.date,
        forecast_tmax: d.tmax,
        record_tmax: recs.tmax_record,
        record_year: recs.year_record_max,
        delta: d.tmax - recs.tmax_record
      });
    }

    if ((d.pr_sum || 0) >= 8 || (d.pr_1h_max || 0) >= 4) {
      insights.heavy_precip_days.push({ date: d.date, pr_sum: d.pr_sum, pr_1h_max: d.pr_1h_max });
    }
    if ((d.wg_max || 0) >= 18 || (d.ws_max || 0) >= 12) {
      insights.windy_days.push({ date: d.date, ws_max: d.ws_max, wg_max: d.wg_max });
    }
  }

  if (insights.warm_spikes.length) insights.headlines.push("Тёплая волна");
  if (insights.cold_dips.length) insights.headlines.push("Холодный провал");
  if (insights.record_risk.length) insights.headlines.push("Возможен температурный рекорд");
  if (insights.heavy_precip_days.length) insights.headlines.push("Периоды сильных осадков");
  if (insights.windy_days.length) insights.headlines.push("Порывистый ветер");

  return insights;
}

/* ──────────────────────────────────────────────────────────────────────────
   9) ЧЕЛОВЕЧЕСКИЕ МЕТКИ ДАТ
   ────────────────────────────────────────────────────────────────────────── */
function dateLabels(dates, tz = TZ) {
  const today = isoDateInTZ(new Date(), tz);
  const tomorrow = isoDateInTZ(new Date(Date.now() + 864e5), tz);
  return dates.map((iso) => {
    const d = new Date(`${iso}T12:00:00Z`);
    const human = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: tz }).format(d);
    const weekday = new Intl.DateTimeFormat("ru-RU", { weekday: "long", timeZone: tz }).format(d).toLowerCase();
    if (iso === today) return `Сегодня, ${human}`;
    if (iso === tomorrow) return `Завтра, ${human}`;
    const needsO = /^(в|с)/.test(weekday) ? "о" : "";
    return `В${needsO} ${weekday}, ${human}`;
  });
}

/* ──────────────────────────────────────────────────────────────────────────
   10) ГЕНЕРАЦИЯ ТЕКСТА
   ────────────────────────────────────────────────────────────────────────── */
async function generateWithModels(prompt) {
  const chain = [MODEL_PRIMARY, ...MODEL_FALLBACKS];
  let lastErr = null;
  for (const modelName of chain) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: { temperature: 0.9, topP: 0.95, maxOutputTokens: 2200 }
      });
      console.log(`Модель → ${modelName}`);
      const r = await model.generateContent(prompt);
      const text = sanitizeText(r.response.text());
      if (text.length < 600) throw new Error("Слишком короткий ответ");
      return { text, modelUsed: modelName };
    } catch (e) {
      lastErr = e;
      console.warn(`Не удалось с ${modelName}:`, e.message);
      await sleep(400);
    }
  }
  throw new Error(`Все модели не сработали: ${lastErr?.message || "unknown"}`);
}

/* ──────────────────────────────────────────────────────────────────────────
   11) ПРОМПТ: «Журнальный выпуск v2»
   ────────────────────────────────────────────────────────────────────────── */
function buildPrompt({ forecast, climo, insights, current, events, sun, fact, timeOfDayRu }) {
  const dates = forecast.days.map((d) => d.date);
  const labels = dateLabels(dates, TZ);

  // Сжимаем данные в удобный для письма вид
  const weekRows = forecast.days.map((d, i) => ({
    label: labels[i],
    date: d.date,
    tmax: d.tmax_int,
    tmin: d.tmin_int,
    app_tmax: roundInt(d.app_tmax),
    app_tmin: roundInt(d.app_tmin),
    wind_gust: isFiniteNum(d.wg_max) ? Number(d.wg_max.toFixed(1)) : null,
    wind_dir: d.wd_compass,
    precip_sum_mm: Number((d.pr_sum || 0).toFixed(1)),
    precip_peak_mmph: Number((d.pr_1h_max || 0).toFixed(1)),
    cloud_max_pct: isFiniteNum(d.cloud_max) ? Math.round(d.cloud_max) : null,
    comfort_index: d.comfort_index, // 0..10
    astro_index: d.astro_index      // 0..5
  }));

  // Нормы/рекорды только для текущей даты и «самых острых» дней
  const keyToday = dayOfYearKey(dates[0]);
  const todayNorm = climo.normals[keyToday] || {};
  const todayRec  = climo.records[keyToday] || {};

  // Смена длины дня (сегодня против вчера)
  let daylight_delta_min = null;
  if (sun.length >= 2 && isFiniteNum(sun[0].daylight_min) && isFiniteNum(sun[1].daylight_min)) {
    daylight_delta_min = sun[0].daylight_min - sun[1].daylight_min;
  }

  const DATA = {
    place: PLACE_LABEL, tz: TZ, time_of_day_label: timeOfDayRu,
    current,
    week: weekRows,
    insights,
    today: {
      norm_tmax: isFiniteNum(todayNorm.tmax_norm) ? Number(todayNorm.tmax_norm.toFixed(1)) : null,
      norm_tmin: isFiniteNum(todayNorm.tmin_norm) ? Number(todayNorm.tmin_norm.toFixed(1)) : null,
      record_tmax: isFiniteNum(todayRec.tmax_record) ? Number(todayRec.tmax_record.toFixed(1)) : null,
      record_tmax_year: todayRec.year_record_max || null,
      record_tmin: isFiniteNum(todayRec.tmin_record) ? Number(todayRec.tmin_record.toFixed(1)) : null,
      record_tmin_year: todayRec.year_record_min || null,
      daylight_delta_min
    },
    world: {
      earthquakes_count: (events.earthquakes || []).length,
      strongest_eq_mag: (events.earthquakes || []).reduce((m, e) => (isFiniteNum(e.magnitude) ? Math.max(m, e.magnitude) : m), -Infinity),
      cyclones_count: (events.tropical_cyclones || []).length,
      max_cyclone_wind_kmh: (events.tropical_cyclones || []).reduce((m, c) => (isFiniteNum(c.wind_kmh) ? Math.max(m, c.wind_kmh) : m), -Infinity)
    },
    astronomy: sun, // массив по дням с восход/закат/длительность (мин)
    fact_of_day: fact,
    attribution_words: "местный прогноз: MET.NO; текущая погода и астрономия: Open‑Meteo; климат и рекорды: Open‑Meteo Archive; мировые события: USGS и NOAA/NHC"
  };

  // Новый формат рубрик — просим автора выбирать живые подзаголовки из набора
  const prompt = `
Ты — опытный метеоролог и автор городского журнала о погоде (${PLACE_LABEL}). Напиши ${timeOfDayRu} выпуск.
Никакого Markdown и ссылок. Дай свежую подачу, без клише и буллет‑списков — цельный, живой текст, но с чёткими разделами.

Сформируй материал в такой последовательности (каждый заголовок — одна строка, затем 1–3 абзаца):
Главная мысль дня
Погода за окном сейчас
Неделя в одном взгляде
Детально по дням
Климат и вероятные рекорды
Риски: осадки и ветер
Ночное небо
За пределами окна
А вы знали?
Совет от метеоролога
Финальный абзац

Наполнение разделов:
— «Главная мысль дня»: сформулируй ярко, опираясь на массив insights.headlines и сильные аномалии/риски.
— «Погода за окном сейчас»: используй блок current, если он есть (температура, ощущается, осадки, ветер).
— «Неделя в одном взгляде»: объясни крупными мазками, какие дни мягче/жёстче, где комфорт выше (используй comfort_index и astro_index).
— «Детально по дням»: для каждого дня используй ТОЛЬКО целые температуры (week.tmax, week.tmin). Обязательно назови направление ветра словами (north/east/south/west на русском — «север», «северо‑восток» и т.п.), отметь интенсивность осадков (precip_sum_mm и precip_peak_mmph) и «световые окна» без дождя.
— «Климат и вероятные рекорды»: сравни прогноз с нормами и рекордами для сегодняшнего календарного дня (today). Если прогноз бьёт рекорд — напиши об этом прямым текстом, иначе оцени «на расстоянии» (сколько не хватает).
— «Риски: осадки и ветер»: перечисли конкретные дни из insights.heavy_precip_days и insights.windy_days с краткими рекомендациями по поведению (зонты, парковка, берегитесь сухих деревьев и т.д.).
— «Ночное небо»: используй astro_index и облачность. Если индекс 4–5 — предложи наблюдения; 2–3 — осторожный оптимизм; 0–1 — почти без шансов.
— «За пределами окна»: кратко про мировые события (world) и обязательно фраза об источниках словами: по данным служб мониторинга землетрясений и ураганов.
— «А вы знали?»: разверни fact_of_day в 3–4 предложения (научное объяснение + бытовой пример).
— «Совет от метеоролога»: 3–5 практичных рекомендаций одним абзацем — исходя из рисков и аномалий.
— «Финальный абзац»: лёгкое, мотивирующее завершение.

Жёсткие правила:
1) Не выдумывай чисел и дат — используй только то, что есть в блоке DATA.
2) Температуры в «Детально по дням» — строго целые значения из week.tmax/week.tmin. Не округляй другие числа агрессивно.
3) Стиль — современный, разговорный, но без жаргона; избегай повторов и штампов.

DATA (используй только для анализа, не выводи как JSON):
${JSON.stringify(DATA)}
`;
  return prompt;
}

/* ──────────────────────────────────────────────────────────────────────────
   12) СОХРАНЕНИЕ
   ────────────────────────────────────────────────────────────────────────── */
function splitTitleBody(fullText) {
  const lines = fullText.split(/\r?\n/).map((l) => l.trim());
  const first = lines.find((l) => l.length > 0) || "Прогноз погоды";
  const idx = lines.indexOf(first);
  const body = lines.slice(idx + 1).join("\n").trim();
  return { title: first, body };
}

function saveOutputs({ articleText, modelUsed, forecast, climo, insights, current, events, sun }) {
  const { title, body } = splitTitleBody(articleText);
  const now = new Date();
  const fileDate = isoDateInTZ(now, TZ);

  const rich = {
    meta: {
      generated_at: now.toISOString(),
      time_of_day: timeOfDay,
      model: modelUsed,
      place: PLACE_LABEL,
      lat: LAT,
      lon: LON,
      tz: TZ
    },
    current,
    forecast_days: forecast.days,
    sun,
    climatology: {
      normals_7d: forecast.days.map(d => {
        const k = dayOfYearKey(d.date), n = climo.normals[k] || {};
        return { date: d.date, tmax_norm: n.tmax_norm ?? null, tmin_norm: n.tmin_norm ?? null };
      }),
      records_7d: forecast.days.map(d => {
        const k = dayOfYearKey(d.date), r = climo.records[k] || {};
        return { date: d.date, tmax_record: r.tmax_record ?? null, year_record_max: r.year_record_max ?? null, tmin_record: r.tmin_record ?? null, year_record_min: r.year_record_min ?? null };
      })
    },
    insights,
    world: events,
    article: { title, content: body }
  };

  const latest = {
    title,
    date: new Date().toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: TZ }),
    time: timeOfDay,
    content: body,
    model: modelUsed
  };

  fs.writeFileSync(`article-${fileDate}-${timeOfDay}.json`, JSON.stringify(rich, null, 2), "utf-8");
  fs.writeFileSync(`latest-article.json`, JSON.stringify(latest, null, 2), "utf-8");
  console.log(`✅ Сохранено: article-${fileDate}-${timeOfDay}.json и latest-article.json`);
}

/* ──────────────────────────────────────────────────────────────────────────
   13) MAIN
   ────────────────────────────────────────────────────────────────────────── */
(async () => {
  console.log(`🚀 Генерация (${timeOfDayRu}, ${PLACE_LABEL})`);
  try {
    // 1) Данные
    const [forecast, current, climo, events, sun] = await Promise.all([
      getForecastMETNO(),
      getCurrentWeather(),
      getClimoAndRecords(),
      getGlobalEvents(),
      getSunData()
    ]);

    // 2) Факт дня (офлайн, чтобы не зависеть от внешних сервисов)
    const fact = getLocalFactOfDay();

    // 3) Инсайты
    const insights = buildInsights(forecast, climo, sun);

    // 4) Промпт → генерация
    const prompt = buildPrompt({ forecast, climo, insights, current, events, sun, fact, timeOfDayRu });
    const { text, modelUsed } = await generateWithModels(prompt);

    // 5) Сохранение
    saveOutputs({ articleText: text, modelUsed, forecast, climo, insights, current, events, sun });

    console.log("✨ Готово.");
  } catch (e) {
    console.error("❌ Критическая ошибка:", e.message);
    process.exit(1);
  }
})();
