// generate-article.js (v3 — улучшенная версия)
//
// Требуется: Node 18+ и package.json с { "type": "module" }
// ENV: 
//   BLOG_LAT, BLOG_LON, BLOG_PLACE, BLOG_TZ
//   GEMINI_API_KEY, GEMINI_MODEL (опц.)
// Запуск: node generate-article.js morning|afternoon|evening|night
//
// Ключевые улучшения:
// 1) Точность и прозрачность: в статью добавлена финальная рубрика «Источники и ссылки» 
//    с короткими URL ровно тех эндпоинтов, откуда получены данные.
// 2) Читабельность: у модели есть жёсткая структура разделов и обновлённый стиль с
//    живыми, но точными формулировками, без канцелярита и перечислений "пуликами".
// 3) Анти‑галлюцинации: строгие правила — не придумывать числа, не "уточнять" то, чего нет в DATA.
//    Если данных нет — писать «данные недоступны». 
// 4) «Ветер словами»: кроме «ССВ/ЮЗ» добавлены нормальные русские словесные направления. 
//    Это помогает модели верно формулировать текст в разделе «Детально по дням».
// 5) Риск‑сигналы: доработаны инсайты (пики тепла/холода, сильный ветер/осадки) и явная логика
//    «почти рекорд» как по теплу, так и по холоду.
// 6) Лёгкая валидация и нормализация чисел, улучшенный sanitize, аккуратные округления.
// 7) Сохранение: вместе с богатыми данными сохраняются «source_links» и расширенная атрибуция.
// 8) Надёжность: бережные таймауты, User‑Agent для MET.NO, осторожный парсинг NHC/USGS.
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

// Для качества текста лучше pro, но оставим фолбэки:
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
  // Убираем кодовые блоки и лишние спецсимволы Markdown, оставляем обычные ссылки.
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
function fmtSigned(x, digits = 1) {
  if (!isFiniteNum(x)) return null;
  const s = x.toFixed(digits);
  return (x >= 0 ? "+" : "") + s;
}

/* ──────────────────────────────────────────────────────────────────────────
   1a) ВЕТЕР: 16 румбов — аббревиатуры и "словами"
   ────────────────────────────────────────────────────────────────────────── */

function degToCompass(d) {
  if (!isFiniteNum(d)) return null;
  const dirs = ["С","ССВ","СВ","ВСВ","В","ВЮВ","ЮВ","ЮЮВ","Ю","ЮЮЗ","ЮЗ","ЗЮЗ","З","ЗСЗ","СЗ","ССЗ"];
  return dirs[Math.round((d % 360) / 22.5) % 16];
}
const RU_DIRECTION_WORDS = {
  "С": "северный",
  "ССВ": "северо‑северо‑восточный",
  "СВ": "северо‑восточный",
  "ВСВ": "восточно‑северо‑восточный",
  "В": "восточный",
  "ВЮВ": "восточно‑юго‑восточный",
  "ЮВ": "юго‑восточный",
  "ЮЮВ": "юго‑юго‑восточный",
  "Ю": "южный",
  "ЮЮЗ": "юго‑юго‑западный",
  "ЮЗ": "юго‑западный",
  "ЗЮЗ": "западно‑юго‑западный",
  "З": "западный",
  "ЗСЗ": "западно‑северо‑западный",
  "СЗ": "северо‑западный",
  "ССЗ": "северо‑северо‑западный"
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

function buildMetNoURL(lat = LAT, lon = LON) {
  return `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat}&lon=${lon}`;
}

async function getForecastMETNO(lat = LAT, lon = LON) {
  const url = buildMetNoURL(lat, lon);
  try {
    const { data } = await axios.get(url, {
      headers: { "User-Agent": "WeatherBloggerApp/3.0 (+https://github.com/meteomonster)" },
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

      // Осадки за 1ч — в compact сводке бывает и в summary, и в details
      const pr1h =
        isFiniteNum(next1?.summary?.precipitation_amount) ? next1.summary.precipitation_amount :
        isFiniteNum(next1?.details?.precipitation_amount) ? next1.details.precipitation_amount : null;

      // Вероятность осадков (если попадает в compact; часто этого поля нет)
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

    const days = Array.from(byDay.keys())
      .sort()
      .slice(0, 7)
      .map((date) => {
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

        // Простая поправка "ощущается" при сильном ветре
        const windAdj = (wsMax || 0) >= 8 ? 1 : 0;

        // Индекс комфорта (0..10): осадки, ветер, температура (бережно)
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

        // Астро‑индекс (0..5): чем меньше облачность, тем выше; сильный порыв ухудшает
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
   4) СОЛНЦЕ (Open‑Meteo: восход/закат) — длина дня и динамика
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
   5) КЛИМАТ (нормы) и РЕКОРДЫ (архив) — Open‑Meteo Archive
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

  return { normals, records, base: { lat, lon, place: PLACE_LABEL }, urls: { normalsUrl, recordsUrl } };
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
        // intensity может быть в узлах "XX KT" или миль/час, но реже; парсим безопасно.
        let kt = 0;
        if (typeof s.intensity === "string") {
          const mKT = s.intensity.match(/(\d+)\s*KT/i);
          if (mKT) kt = parseInt(mKT[1], 10);
          const mMPH = s.intensity.match(/(\d+)\s*MPH/i);
          if (!kt && mMPH) kt = Math.round(parseInt(mMPH[1], 10) * 0.868976);
        }
        const wind_kmh = isFiniteNum(kt) ? Math.round(kt * 1.852) : null;
        const basin = s?.basin || s?.basinLatLong || null;
        const name = s?.name ? `${s.classification || "Тропическая система"} «${s.name}»` : (s?.classification || "Тропическая система");
        return { name, wind_kmh, basin };
      });
    }
  } catch (e) {
    console.warn("NHC:", e.message);
  }

  return out;
}

/* ──────────────────────────────────────────────────────────────────────────
   7) ФАКТЫ/РУБРИКИ ДНЯ — офлайн пул, стабильный выбор по дате
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
   8) АНАЛИТИКА: аномалии, риски, вероятность рекорда
   ────────────────────────────────────────────────────────────────────────── */

function buildInsights(forecast, climo, sunRows) {
  const insights = {
    anomalies: [],           // [{ date, tmax_anom, tmin_anom, tmax_norm, tmin_norm }]
    record_risk_high: [],    // [{ date, forecast_tmax, record_tmax, record_year, delta }]
    record_risk_low: [],     // [{ date, forecast_tmin, record_tmin, record_year, delta }]
    heavy_precip_days: [],   // [{ date, pr_sum, pr_1h_max }]
    windy_days: [],          // [{ date, ws_max, wg_max }]
    warm_spikes: [],         // даты с tmax_anom >= +4
    cold_dips: [],           // даты с tmax_anom <= -4
    headlines: [],           // живые заголовки
    daylight: sunRows || []  // [{ date, daylight_min }]
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
        generationConfig: { temperature: 0.85, topP: 0.95, maxOutputTokens: 2400 }
      });
      console.log(`Модель → ${modelName}`);
      const r = await model.generateContent(prompt);
      const text = sanitizeText(r.response.text());
      if (text.length < 700) throw new Error("Слишком короткий ответ");
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
   11) ССЫЛКИ НА ИСТОЧНИКИ — составляем сразу те же URL, что использовали
   ────────────────────────────────────────────────────────────────────────── */

function buildSourceLinks({ lat = LAT, lon = LON, climoUrls = {} }) {
  const links = [
    { label: "Open‑Meteo (текущая погода)", url: buildOpenMeteoCurrentURL(lat, lon) },
    { label: "Open‑Meteo (восход/закат)", url: buildOpenMeteoSunURL(lat, lon) },
    { label: "MET Norway (прогноз)", url: buildMetNoURL(lat, lon) },
    { label: "Open‑Meteo Archive (нормы)", url: climoUrls.normalsUrl || buildArchiveURL(lat, lon, 1991, 2020) },
    { label: "Open‑Meteo Archive (рекорды)", url: climoUrls.recordsUrl || buildArchiveURL(lat, lon, 1979, new Date().getUTCFullYear() - 1) },
    { label: "USGS — Землетрясения (24ч, ≥5.5)", url: USGS_EQ_URL },
    { label: "NOAA/NHC — Текущие штормы", url: NHC_STORMS_URL }
  ];
  // Максимум 6 ссылок в статью, но в JSON сохраним все:
  return { forArticle: links.slice(0, 6), all: links };
}

/* ──────────────────────────────────────────────────────────────────────────
   12) ПРОМПТ: «Журнальный выпуск v3»
   ────────────────────────────────────────────────────────────────────────── */

function buildPrompt({ forecast, climo, insights, current, events, sun, fact, timeOfDayRu, sourceLinksForArticle }) {
  const dates = forecast.days.map((d) => d.date);
  const labels = dateLabels(dates, TZ);

  const weekRows = forecast.days.map((d, i) => ({
    label: labels[i],
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
    comfort_index: d.comfort_index, // 0..10
    astro_index: d.astro_index      // 0..5
  }));

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
    generated_at_local_iso: new Date().toLocaleString("sv-SE", { timeZone: TZ }),
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
      earthquakes_count: (events.earthquakes || []).filter(e => isFiniteNum(e.magnitude)).length,
      strongest_eq_mag: (events.earthquakes || []).reduce((m, e) => (isFiniteNum(e.magnitude) ? Math.max(m, e.magnitude) : m), -Infinity),
      cyclones_count: (events.tropical_cyclones || []).length,
      max_cyclone_wind_kmh: (events.tropical_cyclones || []).reduce((m, c) => (isFiniteNum(c.wind_kmh) ? Math.max(m, c.wind_kmh) : m), -Infinity)
    },
    astronomy: sun,
    fact_of_day: fact,
    attribution_words: "местный прогноз: MET.NO; текущая погода и астрономия: Open‑Meteo; климат и рекорды: Open‑Meteo Archive; мировые события: USGS и NOAA/NHC",
    source_links: sourceLinksForArticle // массив из {label, url} не более 6
  };

  const prompt = `
Ты — опытный синоптик и автор городского журнала о погоде (${PLACE_LABEL}). Напиши ${timeOfDayRu} выпуск.

Структура: каждый заголовок — отдельной строкой, затем 1–3 абзаца связного текста. Не используй маркированные списки. Допускаются короткие обычные ссылки (http...) ТОЛЬКО в разделе «Источники и ссылки».

Разделы (в строгом порядке):
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

Наполнение:
— «Главная мысль дня»: коротко, ёмко, на основе insights.headlines и наиболее заметных аномалий.
— «Метка дня и времени»: строка формата «${isoDateInTZ(new Date(), TZ)} (${timeOfDaySingleWord})».
— «Погода за окном сейчас»: температура, ощущается, ветер (м/с) и порывы, осадки — ТОЛЬКО если есть в DATA.current.
— «Неделя в одном взгляде»: объясни, какие дни теплее/прохладнее, спокойнее/ветреннее; ориентируйся на comfort_index и astro_index.
— «Детально по дням»: по каждому дню краткий абзац. Температуры — строго целые week.tmax/week.tmin. Обязательно назови направление ветра словами из week.wind_dir_words; учитывай суммы осадков (precip_sum_mm) и пиковую интенсивность (precip_peak_mmph), а также вероятности (precip_prob_max_pct), если они есть. Отмечай «световые окна» без дождя по косвенным признакам (малая сумма и пик).
— «Климат и вероятные рекорды»: сравни прогноз сегодняшнего дня с нормами и рекордами (today). Если до рекорда не хватает, укажи разницу с знаком. Учитывай как максимум (тепловой рекорд), так и минимум (холодовой рекорд), если это уместно.
— «Риски: осадки и ветер»: перечисли конкретные дни из insights.heavy_precip_days и insights.windy_days и дай краткие практичные рекомендации.
— «Ночное небо»: опирайся на astro_index и облачность, упомяни изменение длины дня (today.daylight_delta_min, если есть).
— «За пределами окна»: коротко про мировые события из DATA.world; обязательно фраза «по данным служб мониторинга землетрясений и ураганов».
— «А вы знали?»: развёрнуто поясни fact_of_day простыми словами + бытовой пример.
— «Совет от метеоролога»: один абзац из 3–5 конкретных рекомендаций по одежде/транспорту/планированию.
— «Источники и ссылки»: перечисли 3–6 ссылок из DATA.source_links как «Название — URL» (только из DATA; никаких сторонних).
— «Финальный абзац»: лёгкое, мотивирующее завершение.

Жёсткие правила:
1) Не выдумывай чисел и дат — используй ТОЛЬКО то, что есть в DATA. Если значение отсутствует — напиши «данные недоступны».
2) Температуры в «Детально по дням» — строго целые значения week.tmax/week.tmin.
3) Не преувеличивай и не смягчай риски — оцени их по фактам из DATA.
4) Стиль — современный, живой, без канцелярита и штампов. Короткие абзацы, никакого Markdown.
5) Ссылки разрешены только в разделе «Источники и ссылки» и только те, что даны в DATA.source_links.

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
    world: events,
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
    // 1) Данные
    const [forecast, current, climo, events, sun] = await Promise.all([
      getForecastMETNO(),
      getCurrentWeather(),
      getClimoAndRecords(),
      getGlobalEvents(),
      getSunData()
    ]);

    // 2) Факт дня — офлайн
    const fact = getLocalFactOfDay();

    // 3) Инсайты
    const insights = buildInsights(forecast, climo, sun);

    // 4) Ссылки к статье (ровно те же URL, что дергали выше)
    const sourceLinks = buildSourceLinks({ lat: LAT, lon: LON, climoUrls: climo.urls });

    // 5) Промпт → генерация
    const prompt = buildPrompt({ forecast, climo, insights, current, events, sun, fact, timeOfDayRu, sourceLinksForArticle: sourceLinks.forArticle });
    const { text, modelUsed } = await generateWithModels(prompt);

    // 6) Сохранение
    saveOutputs({ articleText: text, modelUsed, forecast, climo, insights, current, events, sun, sourceLinks });

    console.log("✨ Готово.");
  } catch (e) {
    console.error("❌ Критическая ошибка:", e.message);
    process.exit(1);
  }
})();
