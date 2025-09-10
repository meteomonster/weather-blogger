import axios from "axios";
import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "fs";

/**
 * generate-article.js v2.0
 * — Почасовой MET.NO (YR.no) → дневные показатели на 7 дней
 * — Исторические рекорды для сегодняшнего календарного дня
 * — LIVE-лента: USGS (землетрясения), NOAA/NHC (тропические циклоны), IEM (торнадо)
 * — НОВИНКА: Предварительный анализ данных для выявления ключевых погодных событий (рекорды, перепады температур)
 * — НОВИНКА: Гибкий промпт, ориентированный на повествование, а не на шаблон
 * — Генерация Gemini (с fallback), сохранение JSON
 */

/* =========================
 * 0) Настройки вывода
 * ========================= */
const SHOW_SOURCE_URLS = false;

/* =========================
 * 1) Ключ и инициализация Gemini
 * ========================= */
const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error("Ошибка: Секрет GEMINI_API_KEY не найден. Добавьте его в переменные окружения/секреты CI.");
  process.exit(1);
}
const genAI = new GoogleGenerativeAI(API_KEY);

/* =========================
 * 2) Параметры запуска
 * ========================= */
const timeOfDay = (process.argv[2] || "morning").toLowerCase();
const TOD_RU = { morning: "утренний", afternoon: "дневной", evening: "вечерний", night: "ночной" };
const timeOfDayRu = TOD_RU[timeOfDay] || timeOfDay;

/* =========================
 * 3) Утилиты (без изменений)
 * ========================= */
function toISODateInTZ(date, tz) {
  const s = new Date(date).toLocaleString("sv-SE", { timeZone: tz });
  return s.slice(0, 10);
}
function sanitizeArticle(text) {
  if (!text) return "";
  let t = String(text);
  t = t.replace(/```[\s\S]*?```/g, "");
  t = t.replace(/[>#*_`]+/g, "");
  t = t.replace(/^\s+/, "").replace(/\s+$/, "");
  return t;
}
function circularMeanDeg(values) {
  const rad = values
    .filter(v => typeof v === "number" && !Number.isNaN(v))
    .map(v => (v * Math.PI) / 180);
  if (!rad.length) return null;
  const x = rad.reduce((acc, r) => acc + Math.cos(r), 0) / rad.length;
  const y = rad.reduce((acc, r) => acc + Math.sin(r), 0) / rad.length;
  let deg = (Math.atan2(y, x) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  return deg;
}
function degToCompass(d) {
  if (d == null) return null;
  const dirs = ["С","ССВ","СВ","ВСВ","В","ВЮВ","ЮВ","ЮЮВ","Ю","ЮЮЗ","ЮЗ","ЗЮЗ","З","ЗСЗ","СЗ","ССЗ"];
  const ix = Math.round((d % 360) / 22.5) % 16;
  return dirs[ix];
}
const roundArr = arr => arr.map(v => (typeof v === "number" ? Math.round(v) : null));


/* =========================
 * 4) MET.NO → дневные массивы (без изменений)
 * ========================= */
async function getWeatherData() {
    // ... (код этой функции остаётся без изменений)
  const lat = 56.95, lon = 24.1;
  const url = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat}&lon=${lon}`;
  try {
    const response = await axios.get(url, {
      headers: { "User-Agent": "WeatherBloggerApp/1.0 (+https://github.com/meteomonster/weather-blogger)" },
      timeout: 20000
    });
    const timeseries = response.data?.properties?.timeseries || [];
    if (!timeseries.length) throw new Error("Пустой timeseries в ответе MET.NO");
    const byDay = new Map();
    for (const entry of timeseries) {
      const iso = entry.time;
      const day = iso.slice(0, 10);
      const inst = entry?.data?.instant?.details || {};
      const next1 = entry?.data?.next_1_hours || null;
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push({
        air_temperature: inst.air_temperature,
        wind_speed: inst.wind_speed,
        wind_gust: inst.wind_speed_of_gust,
        wind_dir: inst.wind_from_direction,
        cloud: inst.cloud_area_fraction,
        precip_next1h:
          next1?.summary?.precipitation_amount ??
          next1?.details?.precipitation_amount ??
          null
      });
    }
    const forecastDays = Array.from(byDay.keys()).sort().slice(0, 7);
    const processed = {
      time: forecastDays,
      temperature_2m_max: [], temperature_2m_min: [],
      apparent_temperature_max: [], apparent_temperature_min: [],
      wind_speed_10m_max: [], wind_gusts_10m_max: [],
      wind_direction_dominant: [],
      precipitation_amount_max: [], cloud_cover_max: [],
      sunrise: [], sunset: []
    };
    for (const day of forecastDays) {
      const arr = byDay.get(day) || [];
      const temps = arr.map(a => a.air_temperature).filter(n => typeof n === "number");
      const winds = arr.map(a => a.wind_speed).filter(n => typeof n === "number");
      const gusts = arr.map(a => a.wind_gust).filter(n => typeof n === "number");
      const clouds = arr.map(a => a.cloud).filter(n => typeof n === "number");
      const dirs = arr.map(a => a.wind_dir).filter(n => typeof n === "number");
      const pr1h = arr.map(a => a.precip_next1h).filter(n => typeof n === "number");
      const tMax = temps.length ? Math.max(...temps) : null;
      const tMin = temps.length ? Math.min(...temps) : null;
      const windAdj = (winds.length && Math.max(...winds) >= 8) ? 1 : 0;
      const appMax = tMax != null ? tMax - windAdj : null;
      const appMin = tMin != null ? tMin - windAdj : null;
      processed.temperature_2m_max.push(tMax);
      processed.temperature_2m_min.push(tMin);
      processed.apparent_temperature_max.push(appMax);
      processed.apparent_temperature_min.push(appMin);
      processed.wind_speed_10m_max.push(winds.length ? Math.max(...winds) : null);
      processed.wind_gusts_10m_max.push(gusts.length ? Math.max(...gusts) : null);
      processed.cloud_cover_max.push(clouds.length ? Math.max(...clouds) : null);
      const domDir = circularMeanDeg(dirs);
      processed.wind_direction_dominant.push({ deg: domDir, compass: domDir == null ? null : degToCompass(domDir) });
      processed.precipitation_amount_max.push(pr1h.length ? Math.max(...pr1h) : 0);
      processed.sunrise.push("");
      processed.sunset.push("");
    }
    processed.temperature_2m_max_int = roundArr(processed.temperature_2m_max);
    processed.temperature_2m_min_int = roundArr(processed.temperature_2m_min);
    processed.apparent_temperature_max_int = roundArr(processed.apparent_temperature_max);
    processed.apparent_temperature_min_int = roundArr(processed.apparent_temperature_min);
    return processed;
  } catch (error) {
    console.error("Не удалось получить данные о погоде от MET.NO:", error.response?.data || error.message);
    throw new Error("Ошибка получения данных о погоде.");
  }
}

/* =========================
 * 5) Исторические рекорды (возвращает объект для анализа)
 * ========================= */
async function getHistoricalRecord(date) {
  // ... (код почти без изменений, но теперь возвращает структурированный объект)
  try {
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    const startYear = 1979;
    const endYear = date.getUTCFullYear() - 1;
    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=56.95&longitude=24.1&start_date=${startYear}-${month}-${day}&end_date=${endYear}-${month}-${day}&daily=temperature_2m_max,temperature_2m_min`;
    const { data } = await axios.get(url, { timeout: 20000 });
    const t = data?.daily?.time || [];
    const tmax = data?.daily?.temperature_2m_max || [];
    const tmin = data?.daily?.temperature_2m_min || [];
    if (!t.length) return { text: "Нет надёжных исторических данных для этой даты.", data: null };
    const recs = t.map((iso, i) => ({
      year: Number(iso.slice(0, 4)),
      max: tmax[i],
      min: tmin[i]
    })).filter(r => r.max != null && r.min != null);
    if (!recs.length) return { text: "Недостаточно исторических данных для этой даты.", data: null };
    const recordMax = recs.reduce((a, b) => (a.max > b.max ? a : b));
    const recordMin = recs.reduce((a, b) => (a.min < b.min ? a : b));
    return {
        text: `Самый тёплый в этот день: ${recordMax.year} год, ${recordMax.max.toFixed(1)}°C. Самый холодный: ${recordMin.year} год, ${recordMin.min.toFixed(1)}°C.`,
        data: { max: recordMax, min: recordMin }
    };
  } catch (e) {
    console.warn("Не удалось получить исторические данные:", e.message);
    return { text: "Не удалось загрузить исторические данные для этой даты.", data: null };
  }
}

/* =========================
 * 6) LIVE-лента экстремальных событий (без изменений)
 * ========================= */
async function getGlobalEvents() {
    // ... (код этой функции остаётся без изменений)
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  const events = {
    earthquakes: [],
    tropical_cyclones: [],
    tornadoes: [],
    sources: {}
  };
  try {
    const eqUrl = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=${year}-${month}-${day}T00:00:00&endtime=${year}-${month}-${day}T23:59:59&minmagnitude=5.0`;
    const { data } = await axios.get(eqUrl, { timeout: 15000 });
    events.earthquakes = (data?.features || []).map(f => ({
      magnitude: f.properties?.mag,
      location: f.properties?.place,
      time_utc: new Date(f.properties?.time),
      detailUrl: f.properties?.url || null
    }));
    events.sources.earthquakes = eqUrl;
  } catch (e) { console.warn("Не удалось получить данные о землетрясениях:", e.message); }
  try {
    const hurricaneUrl = `https://www.nhc.noaa.gov/CurrentStorms.json`;
    const { data } = await axios.get(hurricaneUrl, { timeout: 15000 });
    const basinMap = { AL: "Атлантический океан", EP: "восточная часть Тихого океана", CP: "центральная часть Тихого океана" };
    if (data && data.storms) {
      events.tropical_cyclones = data.storms.map(storm => {
        const intensityMatch = storm.intensity ? storm.intensity.match(/(\d+)\s*KT/) : null;
        const windSpeedKnots = intensityMatch ? parseInt(intensityMatch[1], 10) : 0;
        const windSpeedKmh = Math.round(windSpeedKnots * 1.852);
        return {
          name: `${storm.classification} «${storm.name}»`,
          windSpeedKmh,
          location: basinMap[storm.basin] || storm.basin,
          nhcUrl: "https://www.nhc.noaa.gov/"
        };
      });
    }
    events.sources.tropical_cyclones = hurricaneUrl;
  } catch (e) { console.warn("Не удалось получить данные о тропических циклонах от NOAA:", e.message); }
  try {
    const startTime = `${year}-${month}-${day}T00:00:00Z`;
    const endTime = now.toISOString();
    const tornadoUrl = `https://mesonet.agron.iastate.edu/api/1/sbw_by_time.geojson?sts=${startTime}&ets=${endTime}&phenomena=TO`;
    const { data } = await axios.get(tornadoUrl, { timeout: 15000 });
    events.tornadoes = (data?.features || []).map(f => ({
      wfo: f.properties?.wfo,
      location: f.properties?.lsr_provider,
      issued_utc: new Date(f.properties?.issue),
      expires_utc: new Date(f.properties?.expire),
      moreInfo: "https://mesonet.agron.iastate.edu/"
    }));
    events.sources.tornadoes = tornadoUrl;
  } catch (e) { console.warn("Не удалось получить данные о торнадо от IEM:", e.message); }
  return events;
}

/* =========================
 * 7) Подписи дат (без изменений)
 * ========================= */
function buildDateLabels(dailyTime) {
    // ... (код этой функции остаётся без изменений)
  const tz = "Europe/Riga";
  const todayStr = toISODateInTZ(new Date(), tz);
  const tomorrowStr = toISODateInTZ(new Date(Date.now() + 864e5), tz);
  return dailyTime.map((iso) => {
    const d = new Date(`${iso}T00:00:00Z`);
    const human = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: tz }).format(d);
    const weekday = new Intl.DateTimeFormat("ru-RU", { weekday: "long", timeZone: tz }).format(d).toLowerCase();
    if (iso === todayStr) return `Сегодня, ${human}`;
    if (iso === tomorrowStr) return `Завтра, ${human}`;
    const needsO = /^(в|с)/.test(weekday) ? "о" : "";
    return `В${needsO} ${weekday}, ${human}`;
  });
}

// ========================================================================
// НОВЫЙ БЛОК: Предварительный анализ данных для поиска "изюминок"
// ========================================================================
function analyzeWeatherData(weatherData, historicalRecord) {
    const insights = [];
    const forecastTodayMax = weatherData.temperature_2m_max[0];
    const recordData = historicalRecord.data;

    // 1. Проверка на возможность побития рекорда
    if (recordData && forecastTodayMax !== null) {
        const recordMax = recordData.max.max;
        const diff = Math.abs(forecastTodayMax - recordMax);
        if (forecastTodayMax >= recordMax) {
            insights.push(`Сегодняшний день может побить исторический рекорд тепла (${recordMax.toFixed(1)}°C, ${recordData.max.year} г.), прогноз почти ${Math.round(forecastTodayMax)}°C!`);
        } else if (diff <= 2) {
            insights.push(`Сегодня мы близко подойдём к историческому рекорду тепла (${recordMax.toFixed(1)}°C, ${recordData.max.year} г.).`);
        }
    }

    // 2. Поиск резких перепадов температур в прогнозе
    for (let i = 0; i < weatherData.time.length - 1; i++) {
        const tempToday = weatherData.temperature_2m_max_int[i];
        const tempTomorrow = weatherData.temperature_2m_max_int[i+1];
        if (tempToday !== null && tempTomorrow !== null && Math.abs(tempToday - tempTomorrow) >= 7) {
            const change = tempTomorrow > tempToday ? 'резкое потепление' : 'резкое похолодание';
            insights.push(`Внимание: на горизонте ${change} с ${tempToday}°C (${weatherData.time[i]}) до ${tempTomorrow}°C (${weatherData.time[i+1]}).`);
            break; // Достаточно одного самого яркого события
        }
    }

    // 3. Поиск первого заморозка
    const firstFreeze = weatherData.temperature_2m_min_int.findIndex(t => t !== null && t <= 0);
    if (firstFreeze !== -1) {
        insights.push(`Прогнозируется первый заморозок в ночь на ${weatherData.time[firstFreeze]}.`);
    }

    // 4. Постоянный характер погоды (например, неделя дождей или солнца)
    const rainyDays = weatherData.precipitation_amount_max.filter(p => p > 0.5).length;
    if (rainyDays >= 5) {
        insights.push("Похоже, нас ждёт преимущественно дождливая неделя.");
    }
    const sunnyDays = weatherData.cloud_cover_max.filter(c => c < 40).length;
     if (sunnyDays >= 4 && rainyDays <= 1) {
        insights.push("Впереди несколько солнечных и преимущественно сухих дней.");
    }

    return insights;
}

/* =========================
 * 8) Генерация (НОВЫЙ ПРОМПТ)
 * ========================= */
const MODEL_PRIMARY = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const MODEL_FALLBACKS = ["gemini-2.0-flash-exp", "gemini-1.5-flash-latest", "gemini-1.5-flash"];
async function generateWithModels(prompt) {
    // ... (код этой функции остаётся без изменений)
  const chain = [MODEL_PRIMARY, ...MODEL_FALLBACKS];
  let lastErr = null;
  for (const m of chain) {
    try {
      const model = genAI.getGenerativeModel({
        model: m,
        generationConfig: {
          temperature: 0.9, topP: 0.9, topK: 40, maxOutputTokens: 2000
        }
      });
      console.log(`ℹ️  Пытаюсь сгенерировать текст моделью: ${m}`);
      const result = await model.generateContent(prompt);
      const text = sanitizeArticle(result.response.text());
      console.log(`✅ Использована модель: ${m}`);
      return { text, modelUsed: m };
    } catch (e) {
      lastErr = e;
      console.warn(`⚠️  Модель "${m}" не сработала: ${e.message}`);
    }
  }
  throw new Error(`Все модели Gemini не ответили. Последняя ошибка: ${lastErr?.message || 'unknown'}`);
}
async function generateArticle(weatherData, timeOfDayRu) {
  const tz = "Europe/Riga";
  const dates = buildDateLabels(weatherData.time);
  const todayRiga = new Date(new Date().toLocaleString("en-US", { timeZone: tz }));
  const historicalRecord = await getHistoricalRecord(new Date(Date.UTC(
    todayRiga.getFullYear(), todayRiga.getMonth(), todayRiga.getDate()
  )));
  
  // ========================================================================
  // НОВИНКА: Получаем аналитические "изюминки"
  const analyticalHighlights = analyzeWeatherData(weatherData, historicalRecord);
  // ========================================================================

  const globalEvents = await getGlobalEvents();
  const dataPayload = {
    dates,
    analytical_highlights: analyticalHighlights, // <-- Передаём "изюминки" в модель
    temperature_min_int: weatherData.temperature_2m_min_int,
    temperature_max_int: weatherData.temperature_2m_max_int,
    apparent_min_int: weatherData.apparent_temperature_min_int,
    apparent_max_int: weatherData.apparent_temperature_max_int,
    precipitation_amount_max: weatherData.precipitation_amount_max,
    cloud_cover_max: weatherData.cloud_cover_max,
    wind_speed_max: weatherData.wind_speed_10m_max,
    wind_gusts_max: weatherData.wind_gusts_10m_max,
    wind_direction_dominant: weatherData.wind_direction_dominant,
    globalEvents,
  };

  const sourcesInstruction = SHOW_SOURCE_URLS
    ? "В конце раздела кратко укажи источники, используя URL из <DATA_JSON>."
    : "В конце раздела кратко укажи источники словами: по данным USGS, NOAA/NHC и IEM (без URL).";
    
  // ========================================================================
  // НОВИНКА: Полностью переработанный, более гибкий промпт
  // ========================================================================
  const prompt = `
Твоя роль: Опытный, харизматичный и немного ироничный метеоролог, который ведёт популярный блог о погоде в Риге. Ты не робот, зачитывающий цифры, а рассказчик, который находит в прогнозе погоды настоящую историю. Твой стиль — живой, образный, но всегда основанный на фактах.

Твоя задача: Написать эксклюзивный ${timeOfDayRu} синоптический обзор. Твоя главная цель — не просто перечислить данные, а создать увлекательное повествование, сделав акцент на самых интересных погодных событиях недели.

КЛЮЧЕВЫЕ МОМЕНТЫ НЕДЕЛИ (АНАЛИТИКА):
Я уже провёл предварительный анализ данных и выделил для тебя самое главное. Построй свой рассказ вокруг этих моментов, вплетая их в разные части статьи. Это основа твоего повествования:
<ANALYTICAL_HIGHLIGHTS>
${analyticalHighlights.length > 0 ? analyticalHighlights.join("\n") : "На этой неделе обойдётся без крайностей, погода будет довольно стабильной."}
</ANALYTICAL_HIGHLIGHTS>

ОБЩИЕ РЕКОМЕНДАЦИИ:
1.  **Будь оригинальным:** Не используй одни и те же шаблонные фразы в каждой статье. Каждый выпуск должен звучать свежо.
2.  **Структура — твой помощник, а не клетка:** Ниже предложена структура. Следуй ей в целом, но если для лучшего рассказа нужно объединить или поменять местами какие-то части — смело делай это.
3.  **Никакого Markdown:** Только чистый, гладкий текст.
4.  **Точность:** Всегда используй данные из блока <DATA_JSON>. Температуру указывай как целое число.

ПРЕДЛАГАЕМАЯ СТРУКТУРА СТАТЬИ:
Заголовок (яркий, отражающий суть недели)
Вступление (создай настроение, намекни на главную интригу недели из аналитики)
Экстремальные события в мире сегодня (опиши события из globalEvents, ${sourcesInstruction})
Обзор погоды с высоты птичьего полёта (объясни синоптическую ситуацию: циклоны, фронты, воздушные массы)
Детальный прогноз по дням (опиши каждый день, не забывая вплетать аналитические моменты, где это уместно. Укажи направление ветра словами и порывы ≥10 м/с)
Почему так, а не иначе (простое объяснение, почему погода будет именно такой)
Погода и история / Погода и животные / Моря и океаны (выбери одну-две из этих тем и расскажи небольшую, уместную историю)
Совет от метеоролога (практичные рекомендации, основанные на прогнозе)
Мини-рубрика "Сегодня в истории" (используй текст из <NOTE>)
Завершение (краткое резюме и тёплое прощание)

ДАННЫЕ (НЕ выводить, использовать только для анализа):
<DATA_JSON>
${JSON.stringify(dataPayload)}
</DATA_JSON>

<NOTE>
Сегодня в истории: ${historicalRecord.text}
</NOTE>
`;

  const { text, modelUsed } = await generateWithModels(prompt);
  return { article: text, modelUsed };
}

/* =========================
 * 9) Сохранение (без изменений)
 * ========================= */
function saveArticle(articleText, timeOfDay, modelUsed) {
    // ... (код этой функции остаётся без изменений)
  const now = new Date();
  const fileDate = now.toISOString().slice(0, 10);
  const displayDate = now.toLocaleDateString("ru-RU", {
    day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Riga"
  });
  const lines = articleText.split("\n");
  const titleIndex = lines.findIndex(l => l.trim().length > 0);
  const title = titleIndex > -1 ? lines[titleIndex].trim() : "Прогноз погоды в Риге";
  const content = titleIndex > -1 ? lines.slice(titleIndex + 1).join("\n").trim() : articleText;
  const articleJson = { title, date: displayDate, time: timeOfDay, content, model: modelUsed };
  const archiveFileName = `article-${fileDate}-${timeOfDay}.json`;
  fs.writeFileSync(archiveFileName, JSON.stringify(articleJson, null, 2), "utf-8");
  fs.writeFileSync("latest-article.json", JSON.stringify(articleJson, null, 2), "utf-8");
  console.log(`✅ Статья (${timeOfDay}) сохранена в ${archiveFileName} и latest-article.json (model=${modelUsed})`);
}

/* =========================
 * 10) Основной запуск (без изменений)
 * ========================= */
(async () => {
  console.log(`🚀 Запуск генерации статьи (${timeOfDay})...`);
  try {
    const weather = await getWeatherData();
    console.log("📊 Данные MET.NO получены и агрегированы.");
    const { article, modelUsed } = await generateArticle(weather, timeOfDayRu);
    console.log("✍️ Статья сгенерирована.");
    console.log("\n=== Сгенерированная статья ===\n");
    console.log(article);
    console.log("\n============================\n");
    saveArticle(article, timeOfDay, modelUsed);
  } catch (error) {
    console.error("❌ Критическая ошибка:", error.message);
    process.exit(1);
  }
})();
