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

const timeOfDay = (process.argv[2] || "morning").toLowerCase();
const TOD_RU = { morning: "утренний", afternoon: "дневной", evening: "вечерний", night: "ночной" };
const timeOfDayRu = TOD_RU[timeOfDay] || timeOfDay;

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error("Ошибка: переменная окружения GEMINI_API_KEY не задана.");
  process.exit(1);
}
const genAI = new GoogleGenerativeAI(API_KEY);
// Рекомендую использовать более мощную модель для креативных и объёмных текстов
const MODEL_PRIMARY = process.env.GEMINI_MODEL || "gemini-1.5-pro-latest";
const MODEL_FALLBACKS = ["gemini-1.5-flash-latest"];

/* ──────────────────────────────────────────────────────────────────────────
   1) ВСПОМОГАТЕЛЬНЫЕ
   ────────────────────────────────────────────────────────────────────────── */
const sleep = (ms)=> new Promise(r=>setTimeout(r, ms));
function isoDateInTZ(date, tz) { return new Date(date).toLocaleString("sv-SE", { timeZone: tz }).slice(0,10); }
function isFiniteNum(x){ return typeof x==="number" && Number.isFinite(x); }
function roundInt(x){ return isFiniteNum(x) ? Math.round(x) : null; }
function dayOfYearKey(dateStr){ return dateStr?.slice(5,10); }

function degToCompass(d) {
  if (!isFiniteNum(d)) return null;
  const dirs = ["С","ССВ","СВ","ВСВ","В","ВЮВ","ЮВ","ЮЮВ","Ю","ЮЮЗ","ЮЗ","ЗЮЗ","З","ЗСЗ","СЗ","ССЗ"];
  return dirs[Math.round((d % 360) / 22.5) % 16];
}

function circularMeanDeg(values) {
  const rad = values.filter(isFiniteNum).map(v => (v * Math.PI) / 180);
  if (!rad.length) return null;
  const sumX = rad.reduce((a,r)=>a+Math.cos(r),0);
  const sumY = rad.reduce((a,r)=>a+Math.sin(r),0);
  let deg = (Math.atan2(sumY, sumX) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  return deg;
}

function sanitizeText(t) {
  return String(t||"").replace(/```[\s\S]*?```/g,"").replace(/[>#*_`]+/g,"").trim();
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
      t: c.temperature_2m ?? null,
      at: c.apparent_temperature ?? null,
      ws: c.wind_speed_10m ?? null,
      wg: c.wind_gusts_10m ?? null,
      pr: c.precipitation ?? 0,
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
      headers: { "User-Agent": "WeatherBloggerApp/1.0 (YourContact@example.com)" },
      timeout: 20000
    });
    const ts = data?.properties?.timeseries || [];
    if (!ts.length) throw new Error("Пустой timeseries MET.NO");

    const byDay = new Map();
    for (const e of ts) {
      const isoLocal = isoDateInTZ(e.time, TZ);
      if (!byDay.has(isoLocal)) byDay.set(isoLocal, []);
      const next1h = e?.data?.next_1_hours;
      byDay.get(isoLocal).push({
        t: e.data?.instant?.details?.air_temperature ?? null,
        ws: e.data?.instant?.details?.wind_speed ?? null,
        wg: e.data?.instant?.details?.wind_speed_of_gust ?? null,
        wd: e.data?.instant?.details?.wind_from_direction ?? null,
        pr: next1h?.summary?.precipitation_amount ?? next1h?.details?.precipitation_amount ?? null,
      });
    }

    const days = Array.from(byDay.keys()).sort().slice(0,7).map(date => {
      const arr = byDay.get(date);
      const tVals = arr.map(a=>a.t).filter(isFiniteNum);
      const wsVals= arr.map(a=>a.ws).filter(isFiniteNum);
      const wgVals= arr.map(a=>a.wg).filter(isFiniteNum);
      const wdVals= arr.map(a=>a.wd).filter(isFiniteNum);
      const prVals= arr.map(a=>a.pr).filter(isFiniteNum);
      const tmax = tVals.length ? Math.max(...tVals) : null;
      const tmin = tVals.length ? Math.min(...tVals) : null;
      return {
        date,
        tmax_int: roundInt(tmax),
        tmin_int: roundInt(tmin),
        tmax: tmax, // Сохраняем точное значение для анализа
        ws_max: wsVals.length? Math.max(...wsVals): null,
        wg_max: wgVals.length? Math.max(...wgVals): null,
        wd_compass: degToCompass(circularMeanDeg(wdVals)),
        pr_sum: prVals.reduce((s,v)=>s+v, 0),
      };
    });

    return { days, provider: "MET.NO", tz: TZ, place: PLACE_LABEL };
  } catch (e) {
    console.error("getForecastMETNO:", e.message);
    throw e;
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   4) КЛИМАТ И РЕКОРДЫ (Open-Meteo Archive)
   ────────────────────────────────────────────────────────────────────────── */
async function getClimoAndRecords(lat=LAT, lon=LON) {
  const startNorm = 1991, endNorm = 2020;
  const startRec  = 1979, endRec = new Date().getUTCFullYear() - 1;

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
  const normMap = new Map();
  for (let i=0; i < (normalsData.time?.length || 0); i++){
      const mmdd = normalsData.time[i].slice(5,10);
      if (mmdd === "02-29") continue;
      const rec = normMap.get(mmdd) || { sumMax:0, sumMin:0, n:0 };
      if (isFiniteNum(normalsData.temperature_2m_max[i])) { rec.sumMax += normalsData.temperature_2m_max[i]; rec.n++; }
      if (isFiniteNum(normalsData.temperature_2m_min[i])) rec.sumMin += normalsData.temperature_2m_min[i];
      normMap.set(mmdd, rec);
  }
  for (const [k,v] of normMap) normals[k] = { tmax_norm: v.n ? (v.sumMax / v.n) : null, tmin_norm: v.n ? (v.sumMin / v.n) : null };

  const recMap = new Map();
  for (let i=0; i < (recordsData.time?.length || 0); i++){
      const mmdd = recordsData.time[i].slice(5,10);
      const y = +recordsData.time[i].slice(0,4);
      let rec = recMap.get(mmdd) || { rMax: -Infinity, yMax: 0, rMin: +Infinity, yMin: 0 };
      if (isFiniteNum(recordsData.temperature_2m_max[i]) && recordsData.temperature_2m_max[i] > rec.rMax) { rec.rMax = recordsData.temperature_2m_max[i]; rec.yMax = y; }
      if (isFiniteNum(recordsData.temperature_2m_min[i]) && recordsData.temperature_2m_min[i] < rec.rMin) { rec.rMin = recordsData.temperature_2m_min[i]; rec.yMin = y; }
      recMap.set(mmdd, rec);
  }
  for (const [k,v] of recMap) records[k] = { tmax_rec: v.rMax, year_max: v.yMax, tmin_rec: v.rMin, year_min: v.yMin };

  return { normals, records };
}

/* ──────────────────────────────────────────────────────────────────────────
   5) ГЛОБАЛЬНЫЕ СОБЫТИЯ (USGS, NHC)
   ────────────────────────────────────────────────────────────────────────── */
async function getGlobalEvents() {
  const out = {};
  try {
    const eqUrl = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=now-24hours&minmagnitude=5.5`;
    const { data } = await axios.get(eqUrl, { timeout: 15000 });
    out.earthquakes = (data?.features || []).map(f => ({ mag: f.properties?.mag, place: f.properties?.place }));
  } catch (e){ console.warn("USGS:", e.message); }
  try {
    const { data } = await axios.get("https://www.nhc.noaa.gov/CurrentStorms.json", { timeout: 15000 });
    if (data?.storms) out.cyclones = data.storms.map(s => ({ name: `${s.classification} «${s.name}»` }));
  } catch (e){ console.warn("NHC:", e.message); }
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
        return [
            "1943 - На Гусевском хрустальном заводе выпущен первый советский гранёный стакан.",
            "1973 - Государственный переворот в Чили, в результате которого к власти пришёл генерал Аугусто Пиночет.",
            "2001 - Крупнейшая в истории серия террористических актов в США, в результате которых были разрушены башни-близнецы Всемирного торгового центра в Нью-Йорке."
        ];
    }
    async function getHolidaysAndObservances() {
        return [
            "Всероссийский день трезвости.",
            "День специалиста органов воспитательной работы Вооруженных Сил России.",
        ];
    }
    async function getFunFact() {
        return "В среднем облако кучевого типа весит около 500 тонн, что сравнимо с весом 80 слонов.";
    }

    const [history, holidays, funFact] = await Promise.all([
        getHistoricalEventsForToday().catch(() => []),
        getHolidaysAndObservances().catch(() => []),
        getFunFact().catch(() => null)
    ]);

    return { history, holidays, funFact };
}


/* ──────────────────────────────────────────────────────────────────────────
   6) АНАЛИТИКА: нормы, рекорды, аномалии
   ────────────────────────────────────────────────────────────────────────── */
function buildInsights(forecast, climo) {
  const insights = { anomalies: [], record_risk: [], heavy_precip: [], windy: [], headlines: [] };
  for (const d of forecast.days) {
    const key = dayOfYearKey(d.date);
    const norm = climo.normals[key];
    const rec = climo.records[key];
    if (norm && isFiniteNum(d.tmax) && isFiniteNum(norm.tmax_norm)) {
      insights.anomalies.push({ date: d.date, anom: d.tmax - norm.tmax_norm });
    }
    if (rec && isFiniteNum(d.tmax) && d.tmax >= rec.tmax_rec - 1) {
      insights.record_risk.push({ date: d.date, forecast: d.tmax, record: rec.tmax_rec, year: rec.year_max });
    }
    if (d.pr_sum >= 10) insights.heavy_precip.push({ date: d.date, pr: d.pr_sum });
    if (d.wg_max >= 18) insights.windy.push({ date: d.date, wg: d.wg_max });
  }

  const maxAnom = Math.max(0, ...insights.anomalies.map(a => a.anom));
  if (maxAnom >= 5) insights.headlines.push("Аномальное тепло");
  if (insights.record_risk.length > 0) insights.headlines.push("Возможен температурный рекорд");
  if (insights.heavy_precip.length > 0) insights.headlines.push("Сильные дожди");
  if (insights.windy.length > 0) insights.headlines.push("Штормовой ветер");
  return insights;
}

/* ──────────────────────────────────────────────────────────────────────────
   7) ПОДПИСИ ДАТ ДЛЯ ТЕКСТА
   ────────────────────────────────────────────────────────────────────────── */
function dateLabels(dates, tz=TZ) {
  const today = isoDateInTZ(new Date(), tz);
  const tomorrow = isoDateInTZ(new Date(Date.now()+864e5), tz);
  return dates.map(iso => {
    const d = new Date(`${iso}T12:00:00Z`); // Полдень, чтобы избежать сдвига дат
    const human = new Intl.DateTimeFormat("ru-RU",{ day:"numeric", month:"long", timeZone: tz }).format(d);
    if (iso===today)    return `Сегодня, ${human}`;
    if (iso===tomorrow) return `Завтра, ${human}`;
    const weekday = new Intl.DateTimeFormat("ru-RU",{ weekday:"long", timeZone: tz }).format(d);
    return `В ${weekday}, ${human}`;
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
        generationConfig: { temperature: 0.8, topP: 0.95, maxOutputTokens: 3500 }
      });
      console.log(`Модель → ${modelName}`);
      const result = await model.generateContent(prompt);
      const text = sanitizeText(result.response.text());
      if (text.length < 700) throw new Error("Слишком короткий ответ");
      return { text, modelUsed: modelName };
    } catch (e) {
      console.warn(`Не удалось с ${modelName}:`, e.message);
      await sleep(500);
    }
  }
  throw new Error(`Все модели не сработали.`);
}

function buildPrompt({ forecast, climo, insights, current, events, dailyFacts, timeOfDayRu }) {
  const dates = forecast.days.map(d=>d.date);
  const labels = dateLabels(dates, TZ);

  const DATA = {
    meta: { place: PLACE_LABEL, time_of_day: timeOfDayRu },
    current: current,
    days: forecast.days.map((d,i)=>({
      label: labels[i],
      tmax: d.tmax_int, tmin: d.tmin_int,
      wind_gust: d.wg_max,
      wind_dir: d.wd_compass,
      precip: Number(d.pr_sum?.toFixed(1) || 0),
    })),
    insights: insights,
    context: {
      normals: climo.normals,
      records: climo.records,
      global_events: events,
      daily_facts: dailyFacts,
    }
  };

  const prompt =
`Ты — талантливый метеоролог и эрудированный автор популярного блога о погоде в ${PLACE_LABEL}.
Твоя задача — написать увлекательный и информативный ${timeOfDayRu} выпуск. Пиши живым, естественным языком, без канцеляризмов и клише. Текст должен быть связным и литературным. Не используй Markdown.

Обязательная структура (заголовки секций — одна строка, затем текст):
Заголовок (яркий и отражающий суть прогноза)
Вступление (начни с текущей обстановки за окном, если есть данные 'current')
Этот день в истории (подробно и интересно расскажи о 2-3 событиях из данных)
Интересный факт дня (раскрой предоставленный факт в контексте науки или природы)
Праздники и события сегодня (кратко упомяни)
Обзор погоды на неделю (общая картина)
Детальный прогноз по дням
Климатический контекст (сравни прогноз с нормами и рекордами из данных)
Совет от метеоролога
Завершение

Строгие требования:
— Используй только данные из блока DATA. Не выдумывай цифры.
— **Сделай разделы 'Этот день в истории' и 'Интересный факт дня' максимально объемными и интересными. Это ключевая часть статьи.**
— Если есть риск рекорда ('record_risk'), ярко и акцентно сообщи об этом, указав год старого рекорда.
— Если есть сильные аномалии ('anomalies'), объясни, что это значит для жителей.
— Если есть дни с сильными осадками ('heavy_precip') или ветром ('windy'), дай четкие рекомендации.
— Объём текста 1000–1500 слов.

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
  const fileDate = isoDateInTZ(now, TZ);

  const richData = {
    meta: { generated_at: now.toISOString(), time_of_day: timeOfDay, model: modelUsed, place: PLACE_LABEL },
    article: { title, content: body },
    data_sources: { current, forecast_days: forecast.days, climo, insights, events, dailyFacts }
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
      getDailyFacts()
    ]);

    const insights = buildInsights(forecast, climo);
    const prompt = buildPrompt({ forecast, climo, insights, current, events, dailyFacts, timeOfDayRu });
    const { text, modelUsed } = await generateWithModels(prompt);

    saveOutputs({ articleText, text, modelUsed, forecast, climo, insights, current, events, dailyFacts });

    console.log("✨ Готово.");
  } catch (e) {
    console.error("❌ Критическая ошибка:", e.message);
    process.exit(1);
  }
})();
