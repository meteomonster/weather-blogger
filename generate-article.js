// generate-article.js (v4 — живой стиль, анти‑галлюцинации, больше пользы)
//
// Требуется: Node 18+ и package.json с { "type": "module" }
// ENV:
//   BLOG_LAT, BLOG_LON, BLOG_PLACE, BLOG_TZ
//   GEMINI_API_KEY, GEMINI_MODEL (опц.)
// Запуск: node generate-article.js morning|afternoon|evening|night
//
// Что исправлено/улучшено по сравнению с v3:
// • Больше «журнальности»: короткий ёмкий лид, вариативные фразы вместо канцелярита,
//   никакого «столбики термометров» и «небольшие осадки». Текст — живой, но точный.
// • Никаких выдуманных часов: «Погода сейчас» показывает локальное время из API (current.time)
//   форматом «по состоянию на HH:MM».
// • «Неделя в одном взгляде» стала предметной: даём диапазон индекса комфорта (min–max),
//   выделяем 1–2 лучших дня и 1–2 самых «колючих».
// • «Детально по дням»: строго целые Tмакс/Tмин, направления ветра — словами,
//   «без осадков» пишем только при сумме < 0.2 мм; иначе — шкала от «мороси» до «ливня».
// • «Ночное небо»: дополнительные кандидаты для наблюдений (astro_index ≥ 4 и облачность ≤ 40%),
//   плюс динамика длины дня от вчера к сегодня.
// • «За пределами окна»: вместо расплывчатого «магнитудой 6» — выбираем реальный максимум за 24ч
//   (магнитуда + локация) и самый сильный тропический циклон (имя + ветер).
// • «Источники и ссылки»: только те URL, что реально дернули, короткие и понятные.
// • Анти‑глюки: жёсткие правила в промпте — не придумывать числа, не использовать штампы,
//   не писать «без осадков», если precip_sum_mm ≥ 0.2.
//
// Автор: MeteomonsteR

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

const TOD_ALIASES = { morning: "утро", afternoon: "день", evening: "вечер", night: "ночь" };
const TOD_RU = { morning: "утренний", afternoon: "дневной", evening: "вечерний", night: "ночной" };
const timeOfDayArg = (process.argv[2] || "morning").toLowerCase();
const timeOfDay = ["morning","afternoon","evening","night"].includes(timeOfDayArg) ? timeOfDayArg : "morning";
const timeOfDayRu = TOD_RU[timeOfDay];
const timeOfDaySingleWord = TOD_ALIASES[timeOfDay];

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error("Ошибка: переменная окружения GEMINI_API_KEY не задана.");
  process.exit(1);
}
const genAI = new GoogleGenerativeAI(API_KEY);

const MODEL_PRIMARY = process.env.GEMINI_MODEL || "gemini-1.5-pro-latest";
const MODEL_FALLBACKS = ["gemini-1.5-flash-latest", "gemini-1.5-flash"];

/* ──────────────────────────────────────────────────────────────────────────
   1) ВСПОМОГАТЕЛЬНЫЕ
   ────────────────────────────────────────────────────────────────────────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isoDateInTZ(date, tz) {
  return new Date(date).toLocaleString("sv-SE", { timeZone: tz }).slice(0, 10); // YYYY-MM-DD
}
function isFiniteNum(x) {
  return typeof x === "number" && Number.isFinite(x);
}
function roundInt(x) {
  return isFiniteNum(x) ? Math.round(x) : null;
}
function round1(x) {
  return isFiniteNum(x) ? Math.round(x * 10) / 10 : null;
}
function dayOfYearKey(iso) {
  return iso?.slice(5, 10);
}
function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v));
}
function sanitizeText(t) {
  return String(t || "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[>#*_`]+/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
function seedFromDate() {
  const iso = isoDateInTZ(new Date(), TZ);
  return Number(iso.replace(/-/g, "")) % 2147483647;
}
function pickBySeed(arr, seed) {
  if (!arr?.length) return null;
  const idx = seed % arr.length;
  return arr[idx];
}
function toLocalHM(isoOrDate, tz = TZ) {
  try {
    const d = new Date(isoOrDate);
    const p = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: tz });
    return p;
  } catch {
    return null;
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   1a) ВЕТЕР
   ────────────────────────────────────────────────────────────────────────── */

function degToCompass(d) {
  if (!isFiniteNum(d)) return null;
  const dirs = ["С","ССВ","СВ","ВСВ","В","ВЮВ","ЮВ","ЮЮВ","Ю","ЮЮЗ","ЮЗ","ЗЮЗ","З","ЗСЗ","СЗ","ССЗ"];
  return dirs[Math.round((d % 360) / 22.5) % 16];
}
const RU_DIRECTION_WORDS = {
  "С": "северный", "ССВ": "северо‑северо‑восточный", "СВ": "северо‑восточный", "ВСВ": "восточно‑северо‑восточный",
  "В": "восточный", "ВЮВ": "восточно‑юго‑восточный", "ЮВ": "юго‑восточный", "ЮЮВ": "юго‑юго‑восточный",
  "Ю": "южный", "ЮЮЗ": "юго‑юго‑западный", "ЮЗ": "юго‑западный", "ЗЮЗ": "западно‑юго‑западный",
  "З": "западный", "ЗСЗ": "западно‑северо‑западный", "СЗ": "северо‑западный", "ССЗ": "северо‑северо‑западный"
};
function abbrToWords(abbr) {
  return abbr && RU_DIRECTION_WORDS[abbr] ? RU_DIRECTION_WORDS[abbr] : null;
}
function circularMeanDeg(values) {
  const rad = (values || []).filter(isFiniteNum).map(v => (v * Math.PI) / 180);
  if (!rad.length) return null;
  const x = rad.reduce((a, r) => a + Math.cos(r), 0) / rad.length;
  const y = rad.reduce((a, r) => a + Math.sin(r), 0) / rad.length;
  let deg = (Math.atan2(y, x) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  return deg;
}

/* ──────────────────────────────────────────────────────────────────────────
   2) ТЕКУЩАЯ ПОГОДА (Open‑Meteo)
   ────────────────────────────────────────────────────────────────────────── */

function buildOpenMeteoCurrentURL(lat = LAT, lon = LON) {
  return (
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,apparent_temperature,wind_speed_10m,wind_gusts_10m,precipitation,weather_code` +
    `&timezone=auto&windspeed_unit=ms`
  );
}

async function getCurrentWeather(lat = LAT, lon = LON) {
  const url = buildOpenMeteoCurrentURL(lat, lon);
  try {
    const { data } = await axios.get(url, { timeout: 12000 });
    const c = data?.current || {};
    return {
      time: c.time || new Date().toISOString(),
      t: isFiniteNum(c.temperature_2m) ? c.temperature_2m : null,
      at: isFiniteNum(c.apparent_temperature) ? c.apparent_temperature : null,
      ws: isFiniteNum(c.wind_speed_10m) ? c.wind_speed_10m : null,
      wg: isFiniteNum(c.wind_gusts_10m) ? c.wind_gusts_10m : null,
      pr: isFiniteNum(c.precipitation) ? c.precipitation : 0,
      wc: isFiniteNum(c.weather_code) ? c.weather_code : null,
      tz: data?.timezone || TZ,
      url // для прозрачности
    };
  } catch (e) {
    console.warn("getCurrentWeather:", e.message);
    return null;
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   3) ПРОГНОЗ (MET.NO)
   ────────────────────────────────────────────────────────────────────────── */

function buildMetNoURL(lat = LAT, lon = LON) {
  return `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat}&lon=${lon}`;
}

async function getForecastMETNO(lat = LAT, lon = LON) {
  const url = buildMetNoURL(lat, lon);
  try {
    const { data } = await axios.get(url, {
      headers: { "User-Agent": "WeatherBloggerApp/4.0 (+https://github.com/meteomonster)" },
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

      const pr1h =
        isFiniteNum(next1?.summary?.precipitation_amount) ? next1.summary.precipitation_amount :
        isFiniteNum(next1?.details?.precipitation_amount) ? next1.details.precipitation_amount : null;

      const pop =
        isFiniteNum(next1?.details?.probability_of_precipitation)
          ? next1.details.probability_of_precipitation
          : null;

      byDay.get(isoLocal).push({
        t: isFiniteNum(inst.air_temperature) ? inst.air_temperature : null,
        ws: isFiniteNum(inst.wind_speed) ? inst.wind_speed : null,
        wg: isFiniteNum(inst.wind_speed_of_gust) ? inst.wind_speed_of_gust : null,
        wd: isFiniteNum(inst.wind_from_direction) ? inst.wind_from_direction : null,
        cc: isFiniteNum(inst.cloud_area_fraction) ? inst.cloud_area_fraction : null,
        pr: isFiniteNum(pr1h) ? pr1h : 0,
        pop: isFiniteNum(pop) ? pop : null
      });
    }

    const days = Array.from(byDay.keys()).sort().slice(0, 7).map((date) => {
      const arr = byDay.get(date) || [];
      const take = (sel) => arr.map(sel).filter(isFiniteNum);

      const tVals = take(a => a.t);
      const wsVals = take(a => a.ws);
      const wgVals = take(a => a.wg);
      const wdVals = take(a => a.wd);
      const ccVals = take(a => a.cc);
      const prVals = take(a => a.pr);
      const popVals = take(a => a.pop);

      const tmax = tVals.length ? Math.max(...tVals) : null;
      const tmin = tVals.length ? Math.min(...tVals) : null;
      const prSum = prVals.reduce((s, v) => s + (v || 0), 0);
      const prMax = prVals.length ? Math.max(...prVals) : 0;
      const wsMax = wsVals.length ? Math.max(...wsVals) : null;
      const wgMax = wgVals.length ? Math.max(...wgVals) : null;
      const domDeg = circularMeanDeg(wdVals);
      const ccMax = ccVals.length ? Math.max(...ccVals) : null;
      const popMax = popVals.length ? Math.max(...popVals) : null;

      const windAdj = (wsMax || 0) >= 8 ? 1 : 0;

      let comfort = 10;
      if (isFiniteNum(prSum)) {
        if (prSum >= 10) comfort -= 4;
        else if (prSum >= 5) comfort -= 2;
        else if (prSum >= 1) comfort -= 1;
      }
      if (isFiniteNum(wgMax)) {
        if (wgMax >= 22) comfort -= 3;
        else if (wgMax >= 16) comfort -= 2;
        else if (wgMax >= 10) comfort -= 1;
      }
      if (isFiniteNum(tmax)) {
        if (tmax >= 30 || tmax <= -5) comfort -= 3;
        else if (tmax >= 26 || tmax <= 0) comfort -= 2;
        else if (tmax >= 23) comfort -= 1;
      }
      comfort = clamp(Math.round(comfort), 0, 10);

      let astro = 0;
      if (isFiniteNum(ccMax)) {
        if (ccMax <= 25) astro = 5;
        else if (ccMax <= 40) astro = 4;
        else if (ccMax <= 60) astro = 3;
        else if (ccMax <= 80) astro = 2;
        else astro = 1;
      }
      if (isFiniteNum(wgMax) && wgMax >= 18) astro = Math.max(1, astro - 1);

      const compass = isFiniteNum(domDeg) ? degToCompass(domDeg) : null;

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
        wd_compass: compass,
        wd_words_ru: abbrToWords(compass),
        cloud_max: ccMax,
        pop_max: isFiniteNum(popMax) ? popMax : null,
        pr_sum: prSum,
        pr_1h_max: prMax,
        comfort_index: comfort,
        astro_index: astro
      };
    });

    return { days, provider: "MET.NO", tz: TZ, place: PLACE_LABEL, lat: LAT, lon: LON, url };
  } catch (e) {
    console.error("getForecastMETNO:", e.message);
    throw e;
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   4) СОЛНЦЕ (Open‑Meteo)
   ────────────────────────────────────────────────────────────────────────── */

function buildOpenMeteoSunURL(lat = LAT, lon = LON) {
  return (
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&daily=sunrise,sunset&forecast_days=8&timezone=${encodeURIComponent(TZ)}&timeformat=iso8601`
  );
}

async function getSunData(lat = LAT, lon = LON) {
  const url = buildOpenMeteoSunURL(lat, lon);
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
   5) КЛИМАТ И РЕКОРДЫ — Open‑Meteo Archive
   ────────────────────────────────────────────────────────────────────────── */

function buildArchiveURL(lat = LAT, lon = LON, startY = 1991, endY = 2020) {
  return (
    `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}` +
    `&start_date=${startY}-01-01&end_date=${endY}-12-31` +
    `&daily=temperature_2m_max,temperature_2m_min&timezone=UTC`
  );
}

async function getClimoAndRecords(lat = LAT, lon = LON) {
  const startNorm = 1991, endNorm = 2020;
  const startRec = 1979, endRec = new Date().getUTCFullYear() - 1;

  async function fetchDailyRange(startY, endY) {
    const url = buildArchiveURL(lat, lon, startY, endY);
    const { data } = await axios.get(url, { timeout: 30000 });
    return { daily: data?.daily || {}, url };
  }

  // Нормы
  let normals = {}, normalsUrl = null;
  try {
    const { daily: d, url } = await fetchDailyRange(startNorm, endNorm);
    normalsUrl = url;
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
  let records = {}, recordsUrl = null;
  try {
    const { daily: d, url } = await fetchDailyRange(startRec, endRec);
    recordsUrl = url;
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

  return { normals, records, base: { lat: LAT, lon: LON, place: PLACE_LABEL }, urls: { normalsUrl, recordsUrl } };
}

/* ──────────────────────────────────────────────────────────────────────────
   6) МИРОВЫЕ СОБЫТИЯ (USGS, NHC)
   ────────────────────────────────────────────────────────────────────────── */

const USGS_EQ_URL = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=now-24hours&minmagnitude=5.5`;
const NHC_STORMS_URL = `https://www.nhc.noaa.gov/CurrentStorms.json`;

async function getGlobalEvents() {
  const out = { earthquakes: [], tropical_cyclones: [] };

  try {
    const { data } = await axios.get(USGS_EQ_URL, { timeout: 15000 });
    out.earthquakes = (data?.features || []).map(f => ({
      magnitude: isFiniteNum(f?.properties?.mag) ? f.properties.mag : null,
      location: f?.properties?.place || null
    }));
  } catch (e) {
    console.warn("USGS:", e.message);
  }

  try {
    const { data } = await axios.get(NHC_STORMS_URL, { timeout: 15000 });
    if (data?.storms) {
      out.tropical_cyclones = data.storms.map(s => {
        let kt = 0;
        if (typeof s.intensity === "string") {
          const mKT = s.intensity.match(/(\d+)\s*KT/i);
          if (mKT) kt = parseInt(mKT[1], 10);
          const mMPH = s.intensity.match(/(\d+)\s*MPH/i);
          if (!kt && mMPH) kt = Math.round(parseInt(mMPH[1], 10) * 0.868976);
        }
        const wind_kmh = isFiniteNum(kt) ? Math.round(kt * 1.852) : null;
        const name = s?.name ? `${s.classification || "Тропическая система"} «${s.name}»` : (s?.classification || "Тропическая система");
        return { name, wind_kmh };
      });
    }
  } catch (e) {
    console.warn("NHC:", e.message);
  }

  return out;
}

function selectWorldHighlights(events) {
  let topEq = null;
  for (const e of (events?.earthquakes || [])) {
    if (isFiniteNum(e.magnitude)) {
      if (!topEq || e.magnitude > topEq.magnitude) topEq = e;
    }
  }
  let topTC = null;
  for (const c of (events?.tropical_cyclones || [])) {
    if (isFiniteNum(c.wind_kmh)) {
      if (!topTC || c.wind_kmh > topTC.wind_kmh) topTC = c;
    }
  }
  return { topEq, topTC };
}

/* ──────────────────────────────────────────────────────────────────────────
   7) ФАКТ ДНЯ
   ────────────────────────────────────────────────────────────────────────── */

function getLocalFactOfDay() {
  const facts = [
    "Средний кругооборот воды в атмосфере занимает около 9 дней: столько «живет» водяной пар, прежде чем выпадет осадками.",
    "Кучево‑дождевые облака могут достигать 12–16 км в высоту — это выше полёта большинства лайнеров.",
    "Одно грозовое облако способно выделять энергии больше, чем небольшая электростанция за сутки.",
    "Запах «дождя» — это смесь озона, геосмина и растительных масел; на сухом грунте они пахнут особенно ярко.",
    "Тёплый воздух удерживает больше влаги: каждые +10°C почти удваивают потенциальную влажность.",
    "На Балтике бризы летом меняют температуру прибрежной полосы на 5–7°C всего за час.",
    "Самая ветреная сторона циклона в средних широтах — юго‑западная и западная периферия.",
    "Град формируется в мощных восходящих потоках: чем сильнее подъём, тем крупнее лёд успевает нарастить слои.",
    "Дождь из перистых облаков невозможен: слишком мало влаги и низкие скорости вертикальных движений.",
    "Морось — это осадки из капель <0,5 мм; именно она чаще всего ответственна за «мокрый туман»."
  ];
  return pickBySeed(facts, seedFromDate()) || facts[0];
}

/* ──────────────────────────────────────────────────────────────────────────
   8) АНАЛИТИКА И ОБЗОРЫ
   ────────────────────────────────────────────────────────────────────────── */

function buildInsights(forecast, climo, sunRows) {
  const insights = {
    anomalies: [],
    record_risk_high: [],
    record_risk_low: [],
    heavy_precip_days: [],
    windy_days: [],
    warm_spikes: [],
    cold_dips: [],
    headlines: [],
    daylight: sunRows || []
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
      insights.record_risk_high.push({
        date: d.date,
        forecast_tmax: d.tmax,
        record_tmax: recs.tmax_record,
        record_year: recs.year_record_max,
        delta: d.tmax - recs.tmax_record
      });
    }
    if (isFiniteNum(d.tmin) && isFiniteNum(recs.tmin_record) && d.tmin <= (recs.tmin_record + 1)) {
      insights.record_risk_low.push({
        date: d.date,
        forecast_tmin: d.tmin,
        record_tmin: recs.tmin_record,
        record_year: recs.year_record_min,
        delta: d.tmin - recs.tmin_record
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
  if (insights.record_risk_high.length || insights.record_risk_low.length) insights.headlines.push("Близко к температурным рекордам");
  if (insights.heavy_precip_days.length) insights.headlines.push("Периоды сильных осадков");
  if (insights.windy_days.length) insights.headlines.push("Порывистый ветер");

  return insights;
}

function buildOverviews(days) {
  const getVals = (sel) => days.map(sel).filter(isFiniteNum);
  const comfortVals = getVals(d => d.comfort_index);
  const astroVals = getVals(d => d.astro_index);

  const comfort = comfortVals.length
    ? {
        min: Math.min(...comfortVals),
        max: Math.max(...comfortVals),
        avg: Math.round(comfortVals.reduce((a,b)=>a+b,0)/comfortVals.length)
      }
    : { min: null, max: null, avg: null };

  const astro = astroVals.length
    ? {
        min: Math.min(...astroVals),
        max: Math.max(...astroVals),
        avg: Math.round(astroVals.reduce((a,b)=>a+b,0)/astroVals.length)
      }
    : { min: null, max: null, avg: null };

  const bestComfort = days.length ? Math.max(...days.map(d=>d.comfort_index ?? -Infinity)) : null;
  const worstComfort = days.length ? Math.min(...days.map(d=>d.comfort_index ?? Infinity)) : null;

  const bestDays = isFiniteNum(bestComfort) ? days.filter(d => d.comfort_index === bestComfort).map(d => d.date).slice(0, 2) : [];
  const toughDays = isFiniteNum(worstComfort) ? days.filter(d => d.comfort_index === worstComfort).map(d => d.date).slice(0, 2) : [];

  const stargazing = days
    .filter(d => (d.astro_index ?? 0) >= 4 && (!isFiniteNum(d.cloud_max) || d.cloud_max <= 40))
    .map(d => d.date)
    .slice(0, 3);

  return { comfort, astro, bestDays, toughDays, stargazing };
}

/* ──────────────────────────────────────────────────────────────────────────
   9) МЕТКИ ДАТ
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

function labelsMap(dates, tz = TZ) {
  const lab = dateLabels(dates, tz);
  const map = {};
  dates.forEach((d, i) => map[d] = lab[i]);
  return map;
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
        generationConfig: { temperature: 0.9, topP: 0.95, maxOutputTokens: 2600 }
      });
      console.log(`Модель → ${modelName}`);
      const r = await model.generateContent(prompt);
      const text = sanitizeText(r.response.text());
      if (text.length < 900) throw new Error("Слишком короткий ответ");
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
   11) ССЫЛКИ НА ИСТОЧНИКИ
   ────────────────────────────────────────────────────────────────────────── */

function buildSourceLinks({ lat = LAT, lon = LON, climoUrls = {}, forecastUrl, currentUrl }) {
  const links = [
    { label: "Open‑Meteo (текущая погода)", url: currentUrl || buildOpenMeteoCurrentURL(lat, lon) },
    { label: "Open‑Meteo (восход/закат)", url: buildOpenMeteoSunURL(lat, lon) },
    { label: "MET Norway (прогноз)", url: forecastUrl || buildMetNoURL(lat, lon) },
    { label: "Open‑Meteo Archive (нормы)", url: climoUrls.normalsUrl || buildArchiveURL(lat, lon, 1991, 2020) },
    { label: "Open‑Meteo Archive (рекорды)", url: climoUrls.recordsUrl || buildArchiveURL(lat, lon, 1979, new Date().getUTCFullYear() - 1) },
    { label: "USGS — Землетрясения (24ч, ≥5.5)", url: USGS_EQ_URL },
    { label: "NOAA/NHC — Текущие штормы", url: NHC_STORMS_URL }
  ];
  return { forArticle: links.slice(0, 6), all: links };
}

/* ──────────────────────────────────────────────────────────────────────────
   12) ПРОМПТ: «Журнальный выпуск v4»
   ────────────────────────────────────────────────────────────────────────── */

function buildPrompt({ forecast, climo, insights, current, events, sun, fact, timeOfDayRu, sourceLinksForArticle }) {
  const dates = forecast.days.map(d => d.date);
  const labelsArr = dateLabels(dates, TZ);
  const labelsByDate = labelsMap(dates, TZ);
  const overview = buildOverviews(forecast.days);
  const world = selectWorldHighlights(events);

  // Смена длины дня
  let daylight_delta_min = null;
  if (sun.length >= 2 && isFiniteNum(sun[0].daylight_min) && isFiniteNum(sun[1].daylight_min)) {
    daylight_delta_min = sun[0].daylight_min - sun[1].daylight_min;
  }

  const weekRows = forecast.days.map((d, i) => ({
    label: labelsArr[i],
    date: d.date,
    tmax: d.tmax_int,
    tmin: d.tmin_int,
    app_tmax: roundInt(d.app_tmax),
    app_tmin: roundInt(d.app_tmin),
    wind_gust: round1(d.wg_max),
    wind_dir_abbr: d.wd_compass,
    wind_dir_words: d.wd_words_ru,
    precip_sum_mm: round1(d.pr_sum || 0),
    precip_peak_mmph: round1(d.pr_1h_max || 0),
    precip_prob_max_pct: isFiniteNum(d.pop_max) ? Math.round(d.pop_max) : null,
    cloud_max_pct: isFiniteNum(d.cloud_max) ? Math.round(d.cloud_max) : null,
    comfort_index: d.comfort_index,
    astro_index: d.astro_index
  }));

  const keyToday = dayOfYearKey(dates[0]);
  const todayNorm = climo.normals[keyToday] || {};
  const todayRec  = climo.records[keyToday] || {};

  const DATA = {
    place: PLACE_LABEL,
    tz: TZ,
    time_of_day_label: timeOfDayRu,
    generated_at_local_iso: new Date().toLocaleString("sv-SE", { timeZone: TZ }),
    current: current ? {
      ...current,
      local_hm: toLocalHM(current.time, current.tz || TZ)
    } : null,
    week: weekRows,
    labels_by_date: labelsByDate,
    overview,
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
      earthquakes_count: (events.earthquakes || []).filter(e => isFiniteNum(e.magnitude)).length,
      strongest_eq_mag: (events.earthquakes || []).reduce((m, e) => (isFiniteNum(e.magnitude) ? Math.max(m, e.magnitude) : m), -Infinity),
      cyclones_count: (events.tropical_cyclones || []).length,
      max_cyclone_wind_kmh: (events.tropical_cyclones || []).reduce((m, c) => (isFiniteNum(c.wind_kmh) ? Math.max(m, c.wind_kmh) : m), -Infinity),
      top_eq: world.topEq || null,
      top_tc: world.topTC || null
    },
    astronomy: sun,
    fact_of_day: fact,
    attribution_words: "местный прогноз: MET.NO; текущая погода и астрономия: Open‑Meteo; климат и рекорды: Open‑Meteo Archive; мировые события: USGS и NOAA/NHC",
    source_links: sourceLinksForArticle
  };

  const prompt = `
Ты — опытный синоптик и автор городского журнала о погоде (${PLACE_LABEL}). Напиши ${timeOfDayRu} выпуск.

Стиль:
— Живой, современный, без штампов и канцелярита. Никаких фраз «столбики термометров», «погодные условия», «в целом», «на текущий момент», «небольшие осадки».
— Короткие абзацы, дыхание текста за счёт чередования длинных и коротких предложений.
— Чёткие числа только от DATA; если чего‑то нет — «данные недоступны».
— Единицы: °C, м/с, мм и мм/ч. Десятичные — через запятую (14,4 °C). Город — без лишних эпитетов.

Структура (строго в этом порядке; каждый заголовок — своей строкой, затем 1–3 абзаца):
Главная мысль дня
Метка дня и времени
Погода за окном сейчас
Неделя в одном взгляде
Детально по дням
Климат и вероятные рекорды
Риски: осадки и ветер
Ночное небо
За пределами окна
А вы знали?
Совет от метеоролога
Источники и ссылки
Финальный абзац

Правила разделов:
— «Главная мысль дня»: один абзац‑лид. Без клише. Опираться на insights.headlines и overview.bestDays/overview.toughDays.
— «Метка дня и времени»: строка вида «${isoDateInTZ(new Date(), TZ)} (${timeOfDaySingleWord})».
— «Погода за окном сейчас»: если DATA.current есть, то писать «По состоянию на HH:MM» (DATA.current.local_hm). Включить T, «ощущается», ветер (м/с) и порывы, кратко про осадки: 
   * если current.pr > 0 — «идёт слабый/умеренный дождь» (оценить только словом, без числа);
   * если 0 — «сухо».
— «Неделя в одном взгляде»: назвать 1–2 самых комфортных дня и 1–2 самых сложных (overview.bestDays / overview.toughDays по labels_by_date). Указать диапазон комфорта: «комфорт  от MIN до MAX из 10».
— «Детально по дням»: для КАЖДОГО дня один короткий абзац, начинай с labels_by_date[date]. Температуры ТОЛЬКО целые: week.tmax/ week.tmin (формат «днём +X°C, ночью +Y°C»). Ветер — словом из week.wind_dir_words (если нет, не выдумывать). 
   Осадки:
   * если precip_sum_mm < 0,2 — писать «сухо» или «шанс минимальный» (если есть precip_prob_max_pct ≤ 20).
   * если 0,2–2 мм — «кратковременные осадки/морось», 
   * если 2–8 мм — «дождь», 
   * если > 8 мм — «обильные осадки». 
   Добавь «пиковая интенсивность до Z мм/ч» если precip_peak_mmph ≥ 1.
— «Климат и вероятные рекорды»: сравнить сегодня с нормами (today.norm_tmax/today.norm_tmin). Если до рекорда по максимуму/минимуму «не хватает» — явно укажи разницу со знаком (например, «–4,0 °C до рекорда 2020 года»). Если близко (в пределах 1 °C) — написать «на грани рекорда».
— «Риски: осадки и ветер»: перечислить дни из insights.heavy_precip_days (по labels_by_date) и из insights.windy_days. Дай конкретные бытовые советы (зонт, парковка не под сухими деревьями, одежда).
— «Ночное небо»: опирайся на astro_index; если index ≥ 4 и облачность ≤ 40 — порекомендуй наблюдения; 2–3 — «осторожный оптимизм»; 0–1 — «шансов почти нет». Укажи смену длины дня (today.daylight_delta_min) со знаком.
— «За пределами окна»: если есть top_eq — «максимум M у …(локация)»; если есть top_tc — «самый сильный циклон — Имя, ветер до V км/ч». Обязательно фраза «по данным служб мониторинга землетрясений и ураганов».
— «А вы знали?»: разверни fact_of_day в 3–4 предложения с простым примером.
— «Совет от метеоролога»: одним абзацем 3–5 конкретных рекомендаций по одежде, маршруту, времени прогулок.
— «Источники и ссылки»: перечисли 3–6 ссылок из DATA.source_links форматом «Название — URL». Никаких других ссылок.
— «Финальный абзац»: лёгкое, мотивирующее завершение без штампов.

Жёсткие запреты:
1) Не придумывать время, дни недели, числа. Если данных нет — писать «данные недоступны».
2) Не писать «без осадков», если precip_sum_mm ≥ 0,2.
3) Не называть ветер «штормовым», если wg < 20 м/с.
4) Не использовать штампы: «столбики термометров», «погодные условия», «небольшие осадки», «в целом», «на текущий момент».

DATA (используй только для анализа, не выводи как JSON):
${JSON.stringify(DATA)}
`;

  return prompt;
}

/* ──────────────────────────────────────────────────────────────────────────
   13) СОХРАНЕНИЕ
   ────────────────────────────────────────────────────────────────────────── */

function splitTitleBody(fullText) {
  const lines = fullText.split(/\r?\n/).map((l) => l.trim());
  const first = lines.find((l) => l.length > 0) || "Прогноз погоды";
  const idx = lines.indexOf(first);
  const body = lines.slice(idx + 1).join("\n").trim();
  return { title: first, body };
}

function saveOutputs({ articleText, modelUsed, forecast, climo, insights, current, events, sun, sourceLinks }) {
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
    world: {
      ...events,
      highlights: selectWorldHighlights(events)
    },
    source_links_all: sourceLinks.all,
    article: { title, content: body }
  };

  const latest = {
    title,
    date: now.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: TZ }),
    time: timeOfDay,
    content: body,
    model: modelUsed,
    place: PLACE_LABEL
  };

  fs.writeFileSync(`article-${fileDate}-${timeOfDay}.json`, JSON.stringify(rich, null, 2), "utf-8");
  fs.writeFileSync(`latest-article.json`, JSON.stringify(latest, null, 2), "utf-8");
  console.log(`✅ Сохранено: article-${fileDate}-${timeOfDay}.json и latest-article.json`);
}

/* ──────────────────────────────────────────────────────────────────────────
   14) MAIN
   ────────────────────────────────────────────────────────────────────────── */

(async () => {
  console.log(`🚀 Генерация (${timeOfDayRu}, ${PLACE_LABEL})`);
  try {
    const [forecast, current, climo, events, sun] = await Promise.all([
      getForecastMETNO(),
      getCurrentWeather(),
      getClimoAndRecords(),
      getGlobalEvents(),
      getSunData()
    ]);

    const fact = getLocalFactOfDay();
    const insights = buildInsights(forecast, climo, sun);

    const sourceLinks = buildSourceLinks({
      lat: LAT, lon: LON,
      climoUrls: climo.urls,
      forecastUrl: forecast.url,
      currentUrl: current?.url
    });

    const prompt = buildPrompt({
      forecast, climo, insights, current, events, sun, fact, timeOfDayRu,
      sourceLinksForArticle: sourceLinks.forArticle
    });

    const { text, modelUsed } = await generateWithModels(prompt);

    saveOutputs({ articleText: text, modelUsed, forecast, climo, insights, current, events, sun, sourceLinks });

    console.log("✨ Готово.");
  } catch (e) {
    console.error("❌ Критическая ошибка:", e.message);
    process.exit(1);
  }
})();
