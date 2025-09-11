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

// Основной выпуск: morning / afternoon / evening / night
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
const MODEL_PRIMARY = process.env.GEMINI_MODEL || "gemini-1.5-pro-latest"; // Рекомендую более мощную модель для креативных задач
const MODEL_FALLBACKS = ["gemini-1.5-flash-latest"];

/* ──────────────────────────────────────────────────────────────────────────
   1) ВСПОМОГАТЕЛЬНЫЕ
   ────────────────────────────────────────────────────────────────────────── */
const sleep = (ms)=> new Promise(r=>setTimeout(r, ms));
function isoDateInTZ(date, tz) { return new Date(date).toLocaleString("sv-SE", { timeZone: tz }).slice(0,10); }
function isFiniteNum(x){ return typeof x==="number" && Number.isFinite(x); }
function roundInt(x){ return isFiniteNum(x) ? Math.round(x) : null; }
function dayOfYearKey(dateStr){ // "YYYY-MM-DD" -> "MM-DD" (без високосного учета)
  return dateStr?.slice(5,10);
}
function degToCompass(d) {
  if (!isFiniteNum(d)) return null;
  const dirs = ["С","ССВ","СВ","ВСВ","В","ВЮВ","ЮВ","ЮЮВ","Ю","ЮЮЗ","ЮЗ","ЗЮЗ","З","ЗСЗ","СЗ","ССЗ"];
  return dirs[Math.round((d % 360) / 22.5) % 16];
}
// Корректно усредняет углы (например, 359° и 1° -> 0°, а не 180°)
function circularMeanDeg(values) {
  const rad = values.filter(isFiniteNum).map(v => (v * Math.PI) / 180);
  if (!rad.length) return null;
  const x = rad.reduce((a,r)=>a+Math.cos(r),0)/rad.length;
  const y = rad.reduce((a,r)=>a+Math.sin(r),0)/rad.length;
  let deg = (Math.atan2(y,x)*180)/Math.PI; if (deg<0) deg+=360;
  return deg;
}
function sanitizeText(t) {
  return String(t||"")
    .replace(/```[\s\S]*?```/g,"")
    .replace(/[>#*_`]+/g,"")
    .trim();
}

/* ──────────────────────────────────────────────────────────────────────────
   2) ТЕКУЩАЯ ПОГОДА (Open‑Meteo)
   ────────────────────────────────────────────────────────────────────────── */
async function getCurrentWeather(lat=LAT, lon=LON) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,apparent_temperature,wind_speed_10m,wind_gusts_10m,precipitation,weather_code&timezone=auto&windspeed_unit=ms`;
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
      const next1 = e?.data?.next_1_hours;
      // Упрощенное получение осадков с помощью nullish coalescing
      const hourPr = next1?.summary?.precipitation_amount ?? next1?.details?.precipitation_amount ?? null;
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
      const prVals= arr.map(a=>a.pr).filter(isFiniteNum);

      const tmax = tVals.length? Math.max(...tVals): null;
      const tmin = tVals.length? Math.min(...tVals): null;
      const domDeg = circularMeanDeg(wdVals);

      return {
        date,
        tmax, tmin,
        tmax_int: roundInt(tmax),
        tmin_int: roundInt(tmin),
        ws_max: wsVals.length? Math.max(...wsVals): null,
        wg_max: wgVals.length? Math.max(...wgVals): null,
        wd_compass: degToCompass(domDeg),
        pr_sum: prVals.reduce((s,v)=>s+(v||0),0),
        pr_1h_max: prVals.length? Math.max(...prVals): 0
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
  const startRec  = 1979;
  const endRec    = (new Date().getUTCFullYear()) - 1;

  async function fetchDailyRange(startY, endY) {
    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${startY}-01-01&end_date=${endY}-12-31&daily=temperature_2m_max,temperature_2m_min&timezone=UTC`;
    const { data } = await axios.get(url, { timeout: 30000 });
    return data?.daily || {};
  }

  const [normalsData, recordsData] = await Promise.all([
      fetchDailyRange(startNorm, endNorm).catch(e => { console.warn("normals failed:", e.message); return {}; }),
      fetchDailyRange(startRec, endRec).catch(e => { console.warn("records failed:", e.message); return {}; })
  ]);

  const normals = {}, records = {};

  // Нормы
  const normMap = new Map();
  for (let i=0; i < (normalsData.time?.length || 0); i++){
      const mmdd = normalsData.time[i].slice(5,10);
      if (mmdd === "02-29") continue;
      const rec = normMap.get(mmdd) || { sumMax:0, sumMin:0, n:0 };
      if (isFiniteNum(normalsData.temperature_2m_max[i])) rec.sumMax += normalsData.temperature_2m_max[i];
      if (isFiniteNum(normalsData.temperature_2m_min[i])) rec.sumMin += normalsData.temperature_2m_min[i];
      rec.n++;
      normMap.set(mmdd, rec);
  }
  for (const [k,v] of normMap){
      normals[k] = { tmax_norm: v.n ? (v.sumMax / v.n) : null, tmin_norm: v.n ? (v.sumMin / v.n) : null };
  }

  // Рекорды
  const recMap = new Map();
  for (let i=0; i < (recordsData.time?.length || 0); i++){
      const mmdd = recordsData.time[i].slice(5,10);
      const y = +recordsData.time[i].slice(0,4);
      let rec = recMap.get(mmdd) || { recMax: -Infinity, yearMax: null, recMin: +Infinity, yearMin: null };
      if (isFiniteNum(recordsData.temperature_2m_max[i]) && recordsData.temperature_2m_max[i] > rec.recMax){ rec.recMax = recordsData.temperature_2m_max[i]; rec.yearMax = y; }
      if (isFiniteNum(recordsData.temperature_2m_min[i]) && recordsData.temperature_2m_min[i] < rec.recMin){ rec.recMin = recordsData.temperature_2m_min[i]; rec.yearMin = y; }
      recMap.set(mmdd, rec);
  }
  for (const [k,v] of recMap){
      records[k] = {
        tmax_record: isFiniteNum(v.recMax)? v.recMax : null, year_record_max: v.yearMax,
        tmin_record: isFiniteNum(v.recMin)? v.recMin : null, year_record_min: v.yearMin
      };
  }

  return { normals, records, base: { lat, lon, place: PLACE_LABEL } };
}

/* ──────────────────────────────────────────────────────────────────────────
   5) LIVE‑события: USGS / NHC / IEM
   ────────────────────────────────────────────────────────────────────────── */
async function getGlobalEvents() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth()+1).padStart(2,"0");
  const d = String(now.getUTCDate()).padStart(2,"0");
  const start = `${y}-${m}-${d}T00:00:00`;

  const out = {};

  try {
    const eqUrl = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=${start}&minmagnitude=5.0`;
    const { data } = await axios.get(eqUrl, { timeout: 15000 });
    out.earthquakes = (data?.features || []).map(f => ({
      magnitude: f.properties?.mag ?? null,
      location: f.properties?.place ?? null,
    }));
  } catch (e){ console.warn("USGS:", e.message); }

  try {
    const { data } = await axios.get("https://www.nhc.noaa.gov/CurrentStorms.json", { timeout: 15000 });
    if (data?.storms) {
      out.tropical_cyclones = data.storms.map(s => {
        const m = s.intensity?.match(/(\d+)\s*KT/);
        return {
          name: `${s.classification} «${s.name}»`,
          wind_kmh: Math.round((parseInt(m?.[1], 10) || 0) * 1.852),
        };
      });
    }
  } catch (e){ console.warn("NHC:", e.message); }
  
  // Убрал торнадо - они редко бывают глобально значимыми и часто дублируются другими событиями

  return out;
}

/* ──────────────────────────────────────────────────────────────────────────
   НОВОЕ: 5.5) ФАКТЫ ДНЯ
   ────────────────────────────────────────────────────────────────────────── */
async function getDailyFacts() {
    // ВАЖНО: Это функции-заглушки. Вы можете заменить их на реальные вызовы API.
    // Например, для исторических фактов можно использовать API `https://history.muffinlabs.com/date`
    // или парсить Википедию.
    async function getHistoricalEventsForToday() {
        // Пример: `const { data } = await axios.get(`https://history.muffinlabs.com/date`);`
        return [
            "1943 - День граненого стакана в СССР.",
            "1973 - Военный переворот в Чили, к власти приходит Аугусто Пиночет.",
            "2001 - Террористические акты в США, разрушившие башни-близнецы ВТЦ."
        ];
    }
    async function getHolidaysAndObservances() {
        // Можно парсить calend.ru или аналогичные ресурсы
        return [
            "Всероссийский день трезвости.",
            "День специалиста органов воспитательной работы Вооруженных Сил России.",
            "Начало индикта — церковное новолетие в православной традиции (по старому стилю)."
        ];
    }
    async function getWordOfTheDay() {
        // Можно использовать API словарей
        return {
            word: "Эфемерный",
            meaning: "Кратковременный, мимолетный, скоропреходящий. Происходит от греческого 'ephemeros' - однодневный."
        };
    }

    const [history, holidays, word] = await Promise.all([
        getHistoricalEventsForToday().catch(() => []),
        getHolidaysAndObservances().catch(() => []),
        getWordOfTheDay().catch(() => null)
    ]);

    return { history, holidays, word };
}


/* ──────────────────────────────────────────────────────────────────────────
   6) АНАЛИТИКА: нормы, рекорды, аномалии
   ────────────────────────────────────────────────────────────────────────── */
function buildInsights(forecast, climo) {
  const insights = {
    anomalies: [], record_risk: [], heavy_precip_days: [], windy_days: [], key_headlines: []
  };

  for (const d of forecast.days) {
    const key = dayOfYearKey(d.date);
    const norm = climo.normals[key] || {};
    const recs = climo.records[key] || {};

    const tmax_anom = (isFiniteNum(d.tmax) && isFiniteNum(norm.tmax_norm)) ? (d.tmax - norm.tmax_norm) : null;
    insights.anomalies.push({ date: d.date, tmax_anom });

    if (isFiniteNum(d.tmax) && isFiniteNum(recs.tmax_record) && d.tmax >= (recs.tmax_record - 1)) {
      insights.record_risk.push({
        date: d.date,
        forecast_tmax: d.tmax,
        record_tmax: recs.tmax_record,
        record_year: recs.year_record_max,
      });
    }

    if ((d.pr_sum || 0) >= 8) {
      insights.heavy_precip_days.push({ date: d.date, pr_sum: d.pr_sum });
    }
    if ((d.wg_max || 0) >= 18) {
      insights.windy_days.push({ date: d.date, wg_max: d.wg_max });
    }
  }

  const maxAnom = Math.max(...insights.anomalies.map(a => a.tmax_anom || -Infinity).filter(isFiniteNum));
  const minAnom = Math.min(...insights.anomalies.map(a => a.tmax_anom || +Infinity).filter(isFiniteNum));

  if (maxAnom >= 5) insights.key_headlines.push("Аномальное тепло");
  if (minAnom <= -5) insights.key_headlines.push("Существенное похолодание");
  if (insights.record_risk.length) insights.key_headlines.push("Возможен температурный рекорд");
  if (insights.heavy_precip_days.length) insights.key_headlines.push("Периоды сильных дождей");
  if (insights.windy_days.length) insights.key_headlines.push("Штормовой ветер");

  return insights;
}

/* ──────────────────────────────────────────────────────────────────────────
   7) ПОДПИСИ ДАТ ДЛЯ ТЕКСТА
   ────────────────────────────────────────────────────────────────────────── */
function dateLabels(dates, tz=TZ) {
  const today = isoDateInTZ(new Date(), tz);
  const tomorrow = isoDateInTZ(new Date(Date.now()+864e5), tz);
  return dates.map(iso => {
    const d = new Date(`${iso}T12:00:00Z`); // Use midday to avoid timezone shifts
    const human = new Intl.DateTimeFormat("ru-RU",{ day:"numeric", month:"long", timeZone: tz }).format(d);
    if (iso===today)    return `Сегодня, ${human}`;
    if (iso===tomorrow) return `Завтра, ${human}`;
    const weekday = new Intl.DateTimeFormat("ru-RU",{ weekday:"long", timeZone: tz }).format(d);
    const needsO = /^(в|с)/.test(weekday) ? "о" : "";
    return `В${needsO} ${weekday.charAt(0).toUpperCase() + weekday.slice(1)}, ${human}`;
  });
}

/* ──────────────────────────────────────────────────────────────────────────
   8) ГЕНЕРАЦИЯ ТЕКСТА
   ────────────────────────────────────────────────────────────────────────── */
async function generateWithModels(prompt) {
  const chain = [MODEL_PRIMARY, ...MODEL_FALLBACKS];
  for (const modelName of chain) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: { temperature: 0.8, topP: 0.95, topK: 40, maxOutputTokens: 3500 }
      });
      console.log(`Модель → ${modelName}`);
      const r = await model.generateContent(prompt);
      const text = sanitizeText(r.response.text());
      if (text.length < 500) throw new Error("Слишком короткий ответ, пробую другую модель");
      return { text, modelUsed: modelName };
    } catch (e) {
      console.warn(`Не удалось с ${modelName}:`, e.message);
      await sleep(400);
    }
  }
  throw new Error(`Все модели не сработали.`);
}

function buildPrompt({ forecast, climo, insights, current, events, dailyFacts, timeOfDayRu }) {
  const dates = forecast.days.map(d=>d.date);
  const labels = dateLabels(dates, TZ);

  const DATA = {
    place: PLACE_LABEL,
    time_of_day_label: timeOfDayRu,
    current: current,
    days: forecast.days.map((d,i)=>({
      label: labels[i],
      date: d.date,
      tmax_int: d.tmax_int, tmin_int: d.tmin_int,
      wg_max: d.wg_max, // Исправлена опечатка (было gw_max)
      wd_compass: d.wd_compass,
      pr_sum: Number(d.pr_sum?.toFixed(1) || 0),
    })),
    normals: dates.map(iso=>{
      const k = dayOfYearKey(iso), n = climo.normals[k]||{};
      return { date: iso, tmax_norm: n.tmax_norm, tmin_norm: n.tmin_norm };
    }),
    records: dates.map(iso=>{
      const k = dayOfYearKey(iso), r = climo.records[k]||{};
      return { date: iso, tmax_record: r.tmax_record, year_record_max: r.year_record_max };
    }),
    insights: insights,
    global_events: events,
    daily_facts: dailyFacts, // НОВЫЕ ДАННЫЕ
    source_attribution_words: "местный прогноз: MET.NO; текущая погода: Open‑Meteo; глобальные события: USGS, NOAA/NHC"
  };

  const prompt =
`Ты — талантливый метеоролог и эрудированный автор популярного блога о погоде в ${PLACE_LABEL}.
Твоя задача — написать увлекательный и информативный ${timeOfDayRu} выпуск. Пиши живым, естественным языком, без канцеляризмов и клише. Текст должен быть связным и литературным. Не используй Markdown.

Обязательная структура (заголовки секций — одна строка, затем текст):
Заголовок (яркий и отражающий суть прогноза)
Вступление (начни с текущей обстановки за окном, если есть данные `current`)
Этот день в истории (подробно и интересно расскажи о 2-3 событиях)
Слово дня (объясни значение, этимологию и приведи пример использования в контексте погоды)
Праздники и события сегодня
Обзор погоды на неделю
Детальный прогноз по дням
Климатический контекст (сравни прогноз с нормами и рекордами)
Совет от метеоролога
Завершение

Строгие требования:
— Используй только данные из блока DATA. Не выдумывай цифры.
— В прогнозе используй целые температуры (tmax_int, tmin_int) и словесное направление ветра.
— **Сделай разделы 'Этот день в истории', 'Слово дня' и 'Праздники и события сегодня' максимально объемными и интересными. Это ключевая часть статьи.**
— Если есть риск рекорда (record_risk), ярко и акцентно сообщи об этом, указав год старого рекорда.
— Если есть сильные аномалии (anomalies), объясни, что это значит для жителей.
— Если есть дни с сильными осадками (heavy_precip_days) или ветром (windy_days), дай четкие рекомендации.
— Объём текста 900–1400 слов.

DATA (используй эти данные для написания статьи, не выводи их как JSON):
${JSON.stringify(DATA, null, 2)}
`;
  return prompt;
}

/* ──────────────────────────────────────────────────────────────────────────
   9) СОХРАНЕНИЕ
   ────────────────────────────────────────────────────────────────────────── */
function pickTitleAndBody(fullText){
  const lines = fullText.split(/\r?\n/).map(l=>l.trim());
  const title = lines.find(l=>l.length>0) || "Прогноз погоды";
  const body = lines.slice(lines.indexOf(title) + 1).join("\n").trim();
  return { title, body };
}

function saveOutputs({ articleText, modelUsed, forecast, climo, insights, current, events, dailyFacts }) {
  const { title, body } = pickTitleAndBody(articleText);
  const now = new Date();
  const fileDate = now.toISOString().slice(0,10);

  const richData = {
    meta: { generated_at: now.toISOString(), time_of_day: timeOfDay, model: modelUsed, place: PLACE_LABEL },
    article: { title, content: body },
    current,
    forecast_days: forecast.days,
    climatology: { normals: climo.normals, records: climo.records }, // Сохраняем все, а не только на 7 дней
    insights,
    global_events: events,
    daily_facts: dailyFacts,
  };

  const latestArticle = {
    title,
    date: new Date().toLocaleDateString("ru-RU",{ day:"numeric", month:"long", year:"numeric", timeZone: TZ }),
    time: timeOfDay,
    content: body,
    model: modelUsed
  };

  fs.writeFileSync(`article-${fileDate}-${timeOfDay}.json`, JSON.stringify(richData, null, 2), "utf-8");
  fs.writeFileSync(`latest-article.json`, JSON.stringify(latestArticle, null, 2), "utf-8");
  console.log(`✅ Сохранено: article-${fileDate}-${timeOfDay}.json и latest-article.json`);
}

/* ──────────────────────────────────────────────────────────────────────────
   10) MAIN
   ────────────────────────────────────────────────────────────────────────── */
(async () => {
  console.log(`🚀 Генерация (${timeOfDayRu}, ${PLACE_LABEL})`);
  try {
    const [forecast, current, climo, events, dailyFacts] = await Promise.all([
      getForecastMETNO(),
      getCurrentWeather(),
      getClimoAndRecords(),
      getGlobalEvents(),
      getDailyFacts() // <-- Новый вызов
    ]);

    const insights = buildInsights(forecast, climo);
    const prompt = buildPrompt({ forecast, climo, insights, current, events, dailyFacts, timeOfDayRu });
    const { text, modelUsed } = await generateWithModels(prompt);

    saveOutputs({
      articleText: text, modelUsed, forecast, climo, insights, current, events, dailyFacts
    });

    console.log("✨ Готово.");
  } catch (e) {
    console.error("❌ Критическая ошибка:", e.message);
    process.exit(1);
  }
})();
