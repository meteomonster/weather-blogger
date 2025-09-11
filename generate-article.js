// generate-article.js
// ESM: убедитесь, что в package.json есть { "type": "module" }

import axios from "axios";
import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "fs";

/* ──────────────────────────────────────────────────────────────────────────
   0) ПАРАМЕТРЫ
   ────────────────────────────────────────────────────────────────────────── */
const LAT = Number(process.env.BLOG_LAT || 56.95);
const LON = Number(process.env.BLOG_LON || 24.10);
const PLACE_LABEL = process.env.BLOG_PLACE || "Рига, Латвия";
const TZ = process.env.BLOG_TZ || "Europe/Riga";

// Выпуск: morning / afternoon / evening / night
const timeOfDay = (process.argv[2] || "morning").toLowerCase();
const TOD_RU = { morning: "утренний", afternoon: "дневной", evening: "вечерний", night: "ночной" };
const timeOfDayRu = TOD_RU[timeOfDay] || timeOfDay;

// Gemini
const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error("Ошибка: переменная окружения GEMINI_API_KEY не задана.");
  process.exit(1);
}
const genAI = new GoogleGenerativeAI(API_KEY);
const MODEL_PRIMARY = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const MODEL_FALLBACKS = ["gemini-2.0-flash-exp", "gemini-1.5-flash-latest", "gemini-1.5-flash"];

/* ──────────────────────────────────────────────────────────────────────────
   1) ВСПОМОГАТЕЛЬНЫЕ
   ────────────────────────────────────────────────────────────────────────── */
function svDateInTZ(date, tz) { return new Date(date).toLocaleString("sv-SE", { timeZone: tz }); }
function isoDateInTZ(date, tz) { return svDateInTZ(date, tz).slice(0,10); }
function isFiniteNum(x){ return typeof x==="number" && Number.isFinite(x); }
function roundInt(x){ return isFiniteNum(x) ? Math.round(x) : null; }
function dayOfYearKey(dateStr){ return dateStr?.slice(5,10); } // "YYYY-MM-DD" → "MM-DD"
function degToCompass(d) {
  if (!isFiniteNum(d)) return null;
  const dirs = ["С","ССВ","СВ","ВСВ","В","ВЮВ","ЮВ","ЮЮВ","Ю","ЮЮЗ","ЮЗ","ЗЮЗ","З","ЗСЗ","СЗ","ССЗ"];
  return dirs[Math.round((d % 360) / 22.5) % 16];
}
function circularMeanDeg(values) {
  const rad = values.filter(isFiniteNum).map(v => (v * Math.PI) / 180);
  if (!rad.length) return null;
  const x = rad.reduce((a,r)=>a+Math.cos(r),0)/rad.length;
  const y = rad.reduce((a,r)=>a+Math.sin(r),0)/rad.length;
  let deg = (Math.atan2(y,x)*180)/Math.PI; if (deg<0) deg+=360;
  return deg;
}
function sanitizeText(t) {
  return String(t||"").replace(/```[\s\S]*?```/g,"").replace(/[>#*_`]+/g,"").trim();
}

/* ──────────────────────────────────────────────────────────────────────────
   2) ТЕКУЩАЯ ПОГОДА (Open‑Meteo)
   ────────────────────────────────────────────────────────────────────────── */
async function getCurrentWeather(lat=LAT, lon=LON) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
            + `&current=temperature_2m,apparent_temperature,wind_speed_10m,wind_gusts_10m,precipitation,weather_code`
            + `&timezone=auto&windspeed_unit=ms`;
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
   3) ПРОГНОЗ MET.NO → агрегация по дням
   ────────────────────────────────────────────────────────────────────────── */
async function getForecastMETNO(lat=LAT, lon=LON) {
  const url = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat}&lon=${lon}`;
  try {
    const { data } = await axios.get(url, {
      headers: { "User-Agent": "WeatherBloggerApp/1.0 (+https://github.com/meteomonster/weather-blogger)" },
      timeout: 20000
    });
    const ts = data?.properties?.timeseries || [];
    if (!ts.length) throw new Error("Пустой timeseries MET.NO");

    const byDay = new Map();
    for (const e of ts) {
      const inst = e?.data?.instant?.details || {};
      const n1 = e?.data?.next_1_hours || null;
      const hourPr = isFiniteNum(n1?.summary?.precipitation_amount) ? n1.summary.precipitation_amount
                    : isFiniteNum(n1?.details?.precipitation_amount) ? n1.details.precipitation_amount
                    : null;

      const isoLocal = isoDateInTZ(e.time, TZ);
      if (!byDay.has(isoLocal)) byDay.set(isoLocal, []);
      byDay.get(isoLocal).push({
        t: inst.air_temperature ?? null,
        ws: inst.wind_speed ?? null,
        wg: inst.wind_speed_of_gust ?? null,
        wd: inst.wind_from_direction ?? null,
        cc: inst.cloud_area_fraction ?? null,
        pr: hourPr
      });
    }

    const days = Array.from(byDay.keys()).sort().slice(0,7).map(date => {
      const arr = byDay.get(date) || [];
      const tVals = arr.map(a=>a.t).filter(isFiniteNum);
      const wsVals= arr.map(a=>a.ws).filter(isFiniteNum);
      const wgVals= arr.map(a=>a.wg).filter(isFiniteNum);
      const wdVals= arr.map(a=>a.wd).filter(isFiniteNum);
      const ccMax = arr.map(a=>a.cc).filter(isFiniteNum);
      const prVals= arr.map(a=>a.pr).filter(isFiniteNum);

      const tmax = tVals.length? Math.max(...tVals): null;
      const tmin = tVals.length? Math.min(...tVals): null;
      const domDeg = circularMeanDeg(wdVals);

      const prSum = prVals.reduce((s,v)=>s+(v||0),0);
      const prMax = prVals.length? Math.max(...prVals): 0;

      const windAdj = (wsVals.length && Math.max(...wsVals) >= 8) ? 1 : 0;

      return {
        date,
        tmax, tmin,
        tmax_int: roundInt(tmax),
        tmin_int: roundInt(tmin),
        app_tmax: isFiniteNum(tmax)? tmax - windAdj : null,
        app_tmin: isFiniteNum(tmin)? tmin - windAdj : null,
        ws_max: wsVals.length? Math.max(...wsVals): null,
        wg_max: wgVals.length? Math.max(...wgVals): null,
        wd_dom: isFiniteNum(domDeg)? domDeg : null,
        wd_compass: degToCompass(domDeg),
        cloud_max: ccMax.length? Math.max(...ccMax): null,
        pr_sum: prSum,
        pr_1h_max: prMax
      };
    });

    return { days, provider: "MET.NO", tz: TZ, place: PLACE_LABEL, lat, lon };
  } catch (e) {
    console.error("getForecastMETNO:", e.message);
    throw e;
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   4) КЛИМАТ (нормы 1991–2020) и РЕКОРДЫ (1979…прошлый год)
   ────────────────────────────────────────────────────────────────────────── */
async function getClimoAndRecords(lat=LAT, lon=LON) {
  const startNorm = 1991, endNorm = 2020;
  const startRec  = 1979;
  const endRec    = (new Date().getUTCFullYear()) - 1;

  async function fetchDailyRange(startY, endY) {
    const url = `https://archive-api.open-meteo.com/v1/archive`
      + `?latitude=${lat}&longitude=${lon}&start_date=${startY}-01-01&end_date=${endY}-12-31`
      + `&daily=temperature_2m_max,temperature_2m_min&timezone=UTC`;
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
    for (let i=0;i<t.length;i++){
      const mmdd = t[i].slice(5,10);
      if (mmdd === "02-29") continue;
      const rec = map.get(mmdd) || { sumMax:0, sumMin:0, n:0 };
      if (isFiniteNum(tx[i])) rec.sumMax += tx[i];
      if (isFiniteNum(tn[i])) rec.sumMin += tn[i];
      rec.n++;
      map.set(mmdd, rec);
    }
    for (const [k,v] of map){
      normals[k] = {
        tmax_norm: v.n ? (v.sumMax / v.n) : null,
        tmin_norm: v.n ? (v.sumMin / v.n) : null
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
    for (let i=0;i<t.length;i++){
      const mmdd = t[i].slice(5,10);
      const y = +t[i].slice(0,4);
      let rec = map.get(mmdd) || { recMax: -Infinity, yearMax: null, recMin: +Infinity, yearMin: null };
      if (isFiniteNum(tx[i]) && tx[i] > rec.recMax){ rec.recMax = tx[i]; rec.yearMax = y; }
      if (isFiniteNum(tn[i]) && tn[i] < rec.recMin){ rec.recMin = tn[i]; rec.yearMin = y; }
      map.set(mmdd, rec);
    }
    for (const [k,v] of map){
      records[k] = {
        tmax_record: isFiniteNum(v.recMax)? v.recMax : null,
        year_record_max: v.yearMax,
        tmin_record: isFiniteNum(v.recMin)? v.recMin : null,
        year_record_min: v.yearMin
      };
    }
  } catch (e) {
    console.warn("records failed:", e.message);
  }

  return { normals, records, base: { lat, lon, place: PLACE_LABEL } };
}

/* ──────────────────────────────────────────────────────────────────────────
   5) LIVE‑события: USGS / NHC / IEM (без URL в тексте)
   ────────────────────────────────────────────────────────────────────────── */
async function getGlobalEvents() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth()+1).padStart(2,"0");
  const d = String(now.getUTCDate()).padStart(2,"0");

  const out = { earthquakes: [], tropical_cyclones: [], tornadoes: [] };

  try {
    const eqUrl = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=${y}-${m}-${d}T00:00:00&endtime=${y}-${m}-${d}T23:59:59&minmagnitude=5.0`;
    const { data } = await axios.get(eqUrl, { timeout: 15000 });
    out.earthquakes = (data?.features || []).map(f => ({
      magnitude: f.properties?.mag ?? null,
      location: f.properties?.place ?? null,
      time_utc: f.properties?.time ? new Date(f.properties.time) : null
    }));
  } catch (e){ console.warn("USGS:", e.message); }

  try {
    const { data } = await axios.get("https://www.nhc.noaa.gov/CurrentStorms.json", { timeout: 15000 });
    const basins = { AL:"Атлантика", EP:"вост. Тихий океан", CP:"центр. Тихий океан" };
    if (data?.storms) {
      out.tropical_cyclones = data.storms.map(s => {
        const m = s.intensity?.match(/(\d+)\s*KT/);
        const kt = m ? parseInt(m[1], 10) : 0;
        return { name: `${s.classification} «${s.name}»`, wind_kmh: Math.round(kt * 1.852), basin: basins[s.basin] || s.basin };
      });
    }
  } catch (e){ console.warn("NHC:", e.message); }

  try {
    const start = `${y}-${m}-${d}T00:00:00Z`;
    const end = now.toISOString();
    const url = `https://mesonet.agron.iastate.edu/api/1/sbw_by_time.geojson?sts=${start}&ets=${end}&phenomena=TO`;
    const { data } = await axios.get(url, { timeout: 15000 });
    out.tornadoes = (data?.features || []).map(f => ({
      provider: f.properties?.lsr_provider || f.properties?.wfo || "NWS",
      issued_utc: f.properties?.issue ? new Date(f.properties.issue) : null,
      expires_utc: f.properties?.expire ? new Date(f.properties.expire) : null
    }));
  } catch (e){ console.warn("IEM:", e.message); }

  return out;
}

/* ──────────────────────────────────────────────────────────────────────────
   6) АНАЛИТИКА: нормы, рекорды, аномалии, кандидаты на рекорд
   ────────────────────────────────────────────────────────────────────────── */
function buildInsights(forecast, climo) {
  const insights = {
    anomalies: [],           // [{ date, tmax_anom, tmin_anom }]
    record_risk: [],         // [{ date, forecast_tmax, record_tmax, record_year, delta }]
    heavy_precip_days: [],   // [{ date, pr_sum, pr_1h_max }]
    windy_days: [],          // [{ date, ws_max, wg_max }]
    key_headlines: []        // заголовочные подсказки
  };

  for (const d of forecast.days) {
    const key = dayOfYearKey(d.date);
    const norm = climo.normals[key] || {};
    const recs = climo.records[key] || {};

    const tmax_anom = (isFiniteNum(d.tmax) && isFiniteNum(norm.tmax_norm)) ? (d.tmax - norm.tmax_norm) : null;
    const tmin_anom = (isFiniteNum(d.tmin) && isFiniteNum(norm.tmin_norm)) ? (d.tmin - norm.tmin_norm) : null;

    insights.anomalies.push({
      date: d.date, tmax_anom, tmin_anom,
      tmax_norm: norm.tmax_norm ?? null, tmin_norm: norm.tmin_norm ?? null
    });

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

  const maxWarmAnom = insights.anomalies
    .filter(a => isFiniteNum(a.tmax_anom))
    .sort((a,b)=>(b.tmax_anom||0)-(a.tmax_anom||0))[0];

  if (maxWarmAnom && maxWarmAnom.tmax_anom >= 4) insights.key_headlines.push("Тёплая волна");
  else if (maxWarmAnom && maxWarmAnom.tmax_anom <= -4) insights.key_headlines.push("Холодный провал");

  if (insights.record_risk.length) insights.key_headlines.push("Возможен температурный рекорд");
  if (insights.heavy_precip_days.length) insights.key_headlines.push("Периоды сильных осадков");
  if (insights.windy_days.length) insights.key_headlines.push("Порывистый ветер");

  return insights;
}

/* ──────────────────────────────────────────────────────────────────────────
   7) “Сегодняшний акцент” — сводка по текущей дате
   ────────────────────────────────────────────────────────────────────────── */
function buildTodayFocus(forecast, climo) {
  const todayIso = isoDateInTZ(new Date(), TZ);
  const today = forecast.days.find(d => d.date === todayIso);
  if (!today) return null;

  const key = dayOfYearKey(todayIso);
  const norm = climo.normals[key] || {};
  const recs = climo.records[key] || {};

  const nearWarmRecord = (isFiniteNum(today.tmax) && isFiniteNum(recs.tmax_record))
    ? (today.tmax >= recs.tmax_record - 1) : false;
  const nearColdRecord = (isFiniteNum(today.tmin) && isFiniteNum(recs.tmin_record))
    ? (today.tmin <= recs.tmin_record + 1) : false;

  return {
    date: todayIso,
    tmax_int: today.tmax_int,
    tmin_int: today.tmin_int,
    tmax_norm: norm.tmax_norm ?? null,
    tmin_norm: norm.tmin_norm ?? null,
    tmax_record: recs.tmax_record ?? null,
    year_record_max: recs.year_record_max ?? null,
    tmin_record: recs.tmin_record ?? null,
    year_record_min: recs.year_record_min ?? null,
    pr_sum: Number((today.pr_sum || 0).toFixed(1)),
    pr_1h_max: Number((today.pr_1h_max || 0).toFixed(1)),
    ws_max: today.ws_max ?? null,
    wg_max: today.wg_max ?? null,
    wd_compass: today.wd_compass ?? null,
    nearWarmRecord, nearColdRecord
  };
}

/* ──────────────────────────────────────────────────────────────────────────
   8) ГЕНЕРАЦИЯ ТЕКСТА (без клише, без ссылок)
   ────────────────────────────────────────────────────────────────────────── */
async function generateWithModels(prompt) {
  const chain = [MODEL_PRIMARY, ...MODEL_FALLBACKS];
  let lastErr = null;
  for (const modelName of chain) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: { temperature: 0.9, topP: 0.95, topK: 50, maxOutputTokens: 2000 }
      });
      console.log(`Модель → ${modelName}`);
      const r = await model.generateContent(prompt);
      const text = sanitizeText(r.response.text());
      if (text.length < 400) throw new Error("Слишком короткий ответ, пробую другую модель");
      return { text, modelUsed: modelName };
    } catch (e) {
      console.warn(`Не удалось с ${modelName}:`, e.message);
      lastErr = e;
    }
  }
  throw new Error(`Все модели не сработали: ${lastErr?.message || "unknown"}`);
}

function buildPrompt({ forecast, climo, insights, current, events, todayFocus, timeOfDayRu }) {
  const dates = forecast.days.map(d=>d.date);
  const labels = dates.map(iso => {
    const d = new Date(`${iso}T00:00:00Z`);
    const human = new Intl.DateTimeFormat("ru-RU",{ day:"numeric", month:"long", timeZone: TZ }).format(d);
    const weekday = new Intl.DateTimeFormat("ru-RU",{ weekday:"long", timeZone: TZ }).format(d).toLowerCase();
    const today = isoDateInTZ(new Date(), TZ);
    const tomorrow = isoDateInTZ(new Date(Date.now()+864e5), TZ);
    if (iso===today)    return `Сегодня, ${human}`;
    if (iso===tomorrow) return `Завтра, ${human}`;
    const needsO = /^(в|с)/.test(weekday) ? "о" : "";
    return `В${needsO} ${weekday}, ${human}`;
  });

  // Только нужные поля
  const DATA = {
    place: PLACE_LABEL,
    tz: TZ,
    time_of_day_label: timeOfDayRu,
    current,
    days: forecast.days.map((d,i)=>({
      label: labels[i],
      date: d.date,
      tmax_int: d.tmax_int, tmin_int: d.tmin_int,
      ws_max: d.ws_max, wg_max: d.wg_max,
      wd_compass: d.wd_compass,
      pr_sum: Number(d.pr_sum?.toFixed?.(1) ?? d.pr_sum ?? 0),
      pr_1h_max: Number(d.pr_1h_max?.toFixed?.(1) ?? d.pr_1h_max ?? 0),
      cloud_max: d.cloud_max
    })),
    normals: dates.map(iso=>{
      const k = dayOfYearKey(iso), n = climo.normals[k]||{};
      return { date: iso, tmax_norm: n.tmax_norm, tmin_norm: n.tmin_norm };
    }),
    records: dates.map(iso=>{
      const k = dayOfYearKey(iso), r = climo.records[k]||{};
      return { date: iso, tmax_record: r.tmax_record, year_record_max: r.year_record_max, tmin_record: r.tmin_record, year_record_min: r.year_record_min };
    }),
    insights,
    today_focus: todayFocus,
    global_events_summary: {
      earthquakes_count: (events.earthquakes||[]).length,
      strongest_eq_mag: (events.earthquakes||[]).reduce((m,e)=>isFiniteNum(e.magnitude)?Math.max(m,e.magnitude):m, -Infinity),
      cyclones_count: (events.tropical_cyclones||[]).length,
      max_cyclone_wind_kmh: (events.tropical_cyclones||[]).reduce((m,c)=>isFiniteNum(c.wind_kmh)?Math.max(m,c.wind_kmh):m, -Infinity),
      tornado_warnings_count: (events.tornadoes||[]).length
    },
    source_attribution_words: "местный прогноз: MET.NO; текущая погода: Open‑Meteo; глобальные события: USGS, NOAA/NHC, IEM"
  };

  // Инструкции: без шаблонов/клише, новые рубрики
  const prompt =
`Ты — опытный метеоролог и автор живого блога о погоде в ${PLACE_LABEL}.
Напиши ${timeOfDayRu} выпуск. Не используй Markdown и ссылки. Избегай клише и штампов, варьируй длину предложений, используй естественные переходы.

Структура (каждый заголовок — одна строка, затем абзацы):
Заголовок
Вступление
Сегодняшний акцент
Экстремальные события в мире сегодня
Обзор погоды с высоты
Детальный прогноз по дням
Почему так, а не иначе
Новая рубрика: Погодный факт дня
Погода и история
Погода и животные
Моря и океаны
А вы знали, что?
Совет от метеоролога
Завершение

Строгие требования:
— Используй только данные из блока DATA, числа не выдумывай.
— В «Детальном прогнозе по дням» используй только целые температуры (поля tmax_int и tmin_int).
— Ветер описывай словами (можно преобразовать "ССВ" в "северо‑северо‑восточный" и т. п.).
— Если today_focus указывает на близость к рекорду — скажи об этом прямо (с годом рекорда), а если прогноз выше рекорда — отметь высокую вероятность обновления.
— Если есть heavy_precip_days или windy_days в инсайтах — отметь риски и дай краткие практические советы.
— В блоке про мир укажи источники словами: по данным международных служб мониторинга землетрясений, ураганов и торнадо. Без URL.
— «Погодный факт дня» — небольшая научно‑популярная заметка, связанная с погодой/климатом/океаном/атмосферной физикой.
— «А вы знали, что?» — один абзац с занимательным фактом.
— Объём 700–1100 слов.

DATA (не выводить как JSON, использовать только для рассуждений):
${JSON.stringify(DATA)}
`;
  return prompt;
}

/* ──────────────────────────────────────────────────────────────────────────
   9) СОХРАНЕНИЕ
   ────────────────────────────────────────────────────────────────────────── */
function pickTitleAndBody(fullText){
  const lines = fullText.split(/\r?\n/).map(l=>l.trim());
  const first = lines.find(l=>l.length>0) || "Прогноз погоды";
  const idx = lines.indexOf(first);
  const body = lines.slice(idx+1).join("\n").trim();
  return { title: first, body: body };
}

function saveOutputs({ articleText, modelUsed, forecast, climo, insights, current, events }) {
  const { title, body } = pickTitleAndBody(articleText);
  const now = new Date();
  const fileDate = now.toISOString().slice(0,10);

  const rich = {
    meta: {
      generated_at: now.toISOString(),
      time_of_day: timeOfDay,
      model: modelUsed,
      place: PLACE_LABEL,
      lat: LAT, lon: LON, tz: TZ
    },
    current,
    forecast_days: forecast.days,
    climatology: {
      normals: forecast.days.map(d=>{
        const k = dayOfYearKey(d.date), n = climo.normals[k]||{};
        return { date: d.date, tmax_norm: n.tmax_norm ?? null, tmin_norm: n.tmin_norm ?? null };
      }),
      records: forecast.days.map(d=>{
        const k = dayOfYearKey(d.date), r = climo.records[k]||{};
        return {
          date: d.date,
          tmax_record: r.tmax_record ?? null,
          year_record_max: r.year_record_max ?? null,
          tmin_record: r.tmin_record ?? null,
          year_record_min: r.year_record_min ?? null
        };
      })
    },
    insights,
    global_events: events,
    article: { title, content: body }
  };

  const articleJson = {
    title,
    date: new Date().toLocaleDateString("ru-RU",{ day:"numeric", month:"long", year:"numeric", timeZone: TZ }),
    time: timeOfDay,
    content: body,
    model: modelUsed
  };

  fs.writeFileSync(`article-${fileDate}-${timeOfDay}.json`, JSON.stringify(rich, null, 2), "utf-8");
  fs.writeFileSync(`latest-article.json`, JSON.stringify(articleJson, null, 2), "utf-8");
  console.log(`✅ Сохранено: article-${fileDate}-${timeOfDay}.json и latest-article.json`);
}

/* ──────────────────────────────────────────────────────────────────────────
   10) MAIN
   ────────────────────────────────────────────────────────────────────────── */
(async () => {
  console.log(`🚀 Генерация (${timeOfDayRu}, ${PLACE_LABEL})`);
  try {
    const [forecast, current, climo, events] = await Promise.all([
      getForecastMETNO(),
      getCurrentWeather(),
      getClimoAndRecords(),
      getGlobalEvents()
    ]);

    const insights = buildInsights(forecast, climo);
    const todayFocus = buildTodayFocus(forecast, climo);

    const prompt = buildPrompt({ forecast, climo, insights, current, events, todayFocus, timeOfDayRu });
    const { text, modelUsed } = await generateWithModels(prompt);

    saveOutputs({ articleText: text, modelUsed, forecast, climo, insights, current, events });
    console.log("✨ Готово.");
  } catch (e) {
    console.error("❌ Критическая ошибка:", e.message);
    process.exit(1);
  }
})();
