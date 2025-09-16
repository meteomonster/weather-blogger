import axios from "axios";
import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "fs";

/**
 * generate-article.js v3.2 (Historical Data Fix)
 * — Почасовой MET.NO → дневные показатели на 7 дней
 * — ИСПРАВЛЕНО: Корректное получение исторических рекордов строго для текущего календарного дня
 * — LIVE-лента: USGS, NOAA/NHC
 * — Предварительный анализ данных для выявления ключевых погодных событий
 * — Гибкий промпт, ориентированный на повествование
 * — Генерация Gemini, сохранение JSON
 */

/* =========================
 * 0) Настройки
 * ========================= */
const SHOW_SOURCE_URLS = false;

/* =========================
 * 1) Инициализация Gemini
 * ========================= */
const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error("Ошибка: Секрет GEMINI_API_KEY не найден.");
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
 * 3) Утилиты
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
function buildDateLabels(dailyTime) {
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

/* =========================
 * 4) Получение прогноза MET.NO
 * ========================= */
async function getWeatherData() {
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
      const day = entry.time.slice(0, 10);
      const inst = entry?.data?.instant?.details || {};
      const next1 = entry?.data?.next_1_hours || null;
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push({
        air_temperature: inst.air_temperature,
        wind_speed: inst.wind_speed,
        wind_gust: inst.wind_speed_of_gust,
        wind_dir: inst.wind_from_direction,
        cloud: inst.cloud_area_fraction,
        precip_next1h: next1?.details?.precipitation_amount ?? null
      });
    }
    const forecastDays = Array.from(byDay.keys()).sort().slice(0, 7);
    const processed = {
      time: forecastDays,
      temperature_2m_max: [], temperature_2m_min: [],
      wind_speed_10m_max: [], wind_gusts_10m_max: [],
      wind_direction_dominant: [],
      precipitation_amount_max: [], cloud_cover_max: []
    };
    for (const day of forecastDays) {
      const arr = byDay.get(day) || [];
      const temps = arr.map(a => a.air_temperature).filter(n => typeof n === "number");
      const winds = arr.map(a => a.wind_speed).filter(n => typeof n === "number");
      const gusts = arr.map(a => a.wind_gust).filter(n => typeof n === "number");
      const clouds = arr.map(a => a.cloud).filter(n => typeof n === "number");
      const dirs = arr.map(a => a.wind_dir).filter(n => typeof n === "number");
      const pr1h = arr.map(a => a.precip_next1h).filter(n => typeof n === "number");
      processed.temperature_2m_max.push(temps.length ? Math.max(...temps) : null);
      processed.temperature_2m_min.push(temps.length ? Math.min(...temps) : null);
      processed.wind_speed_10m_max.push(winds.length ? Math.max(...winds) : null);
      processed.wind_gusts_10m_max.push(gusts.length ? Math.max(...gusts) : null);
      processed.cloud_cover_max.push(clouds.length ? Math.max(...clouds) : null);
      const domDir = circularMeanDeg(dirs);
      processed.wind_direction_dominant.push({ deg: domDir, compass: domDir == null ? null : degToCompass(domDir) });
      processed.precipitation_amount_max.push(pr1h.length ? Math.max(...pr1h) : 0);
    }
    processed.temperature_2m_max_int = roundArr(processed.temperature_2m_max);
    processed.temperature_2m_min_int = roundArr(processed.temperature_2m_min);
    return processed;
  } catch (error) {
    console.error("Не удалось получить данные о погоде от MET.NO:", error.response?.data || error.message);
    throw new Error("Ошибка получения данных о погоде.");
  }
}

/* =========================
 * 5) Получение исторических рекордов (ИСПРАВЛЕНО)
 * ========================= */
async function getHistoricalRecord(date) {
  try {
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=56.95&longitude=24.1&start_date=1979-${month}-${day}&end_date=${date.getUTCFullYear() - 1}-${month}-${day}&daily=temperature_2m_max,temperature_2m_min`;
    
    const { data } = await axios.get(url, { 
        headers: { "User-Agent": "WeatherBloggerApp/1.0 (+https://github.com/meteomonster/weather-blogger)" },
        timeout: 20000 
    });

    const time = data?.daily?.time || [];
    const tmax = data?.daily?.temperature_2m_max || [];
    const tmin = data?.daily?.temperature_2m_min || [];

    if (!time.length) return { text: "Нет надёжных исторических данных для этой даты.", data: null };

    // ИСПРАВЛЕНО: Добавлен жёсткий фильтр, чтобы гарантировать, что мы используем данные только для нужного дня.
    const recs = time.map((iso, i) => ({
      year: Number(iso.slice(0, 4)),
      month: iso.slice(5, 7),
      day: iso.slice(8, 10),
      max: tmax[i],
      min: tmin[i]
    })).filter(r => r.month === month && r.day === day && r.max != null && r.min != null);

    if (!recs.length) {
        console.warn("API вернуло данные, но после фильтрации по дате ничего не осталось.");
        return { text: "Недостаточно исторических данных для этой даты.", data: null };
    }
    
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
 * 6) Получение LIVE-ленты экстремальных событий
 * ========================= */
async function getGlobalEvents() {
    const now = new Date();
    const todayUTC = now.toISOString().slice(0, 10);
    const events = { earthquakes: [], tropical_cyclones: [] };
    try {
      const eqUrl = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=${todayUTC}T00:00:00&endtime=${todayUTC}T23:59:59&minmagnitude=5.0`;
      const { data } = await axios.get(eqUrl, { timeout: 15000 });
      events.earthquakes = (data?.features || []).map(f => ({ magnitude: f.properties?.mag, location: f.properties?.place }));
    } catch (e) { console.warn("Не удалось получить данные о землетрясениях:", e.message); }
    try {
      const hurricaneUrl = `https://www.nhc.noaa.gov/CurrentStorms.json`;
      const { data } = await axios.get(hurricaneUrl, { timeout: 15000 });
      const basinMap = { AL: "Атлантический океан", EP: "восточная часть Тихого океана", CP: "центральная часть Тихого океана" };
      if (data?.storms) {
        events.tropical_cyclones = data.storms.map(storm => ({
          name: `${storm.classification} «${storm.name}»`,
          windSpeedKmh: Math.round((parseInt(storm.intensity.match(/(\d+)\s*KT/)?.[1] || '0', 10)) * 1.852),
          location: basinMap[storm.basin] || storm.basin
        }));
      }
    } catch (e) { console.warn("Не удалось получить данные о тропических циклонах от NOAA:", e.message); }
    return events;
}

/* =========================
 * 7) Предварительный анализ данных
 * ========================= */
function analyzeWeatherData(weatherData, historicalRecord) {
    const insights = [];
    const forecastTodayMax = weatherData.temperature_2m_max_int[0];
    const recordData = historicalRecord.data;

    // 1. Проверка на возможность побития рекорда
    if (recordData && forecastTodayMax !== null) {
        const recordMax = recordData.max.max;
        if (forecastTodayMax >= recordMax) {
            insights.push(`Сегодняшний день может ПОБИТЬ исторический рекорд тепла (${recordMax.toFixed(1)}°C, ${recordData.max.year} г.), прогноз почти ${forecastTodayMax}°C!`);
        } else if (Math.abs(forecastTodayMax - recordMax) <= 2) {
            insights.push(`Сегодня мы близко подойдём к историческому рекорду тепла (${recordMax.toFixed(1)}°C, ${recordData.max.year} г.).`);
        }
    }

    // 2. Поиск резких перепадов температур
    for (let i = 0; i < weatherData.time.length - 1; i++) {
        const tempToday = weatherData.temperature_2m_max_int[i];
        const tempTomorrow = weatherData.temperature_2m_max_int[i+1];
        if (tempToday !== null && tempTomorrow !== null && Math.abs(tempToday - tempTomorrow) >= 7) {
            const change = tempTomorrow > tempToday ? 'резкое потепление' : 'РЕЗКОЕ ПОХОЛОДАНИЕ';
            insights.push(`Внимание: на горизонте ${change} с ${tempToday}°C до ${tempTomorrow}°C (с ${buildDateLabels([weatherData.time[i]])[0]} на ${buildDateLabels([weatherData.time[i+1]])[0]}).`);
            break; 
        }
    }

    // 3. Поиск первого заморозка
    const firstFreezeIndex = weatherData.temperature_2m_min_int.findIndex(t => t !== null && t <= 0);
    if (firstFreezeIndex !== -1) {
        insights.push(`Прогнозируется ПЕРВЫЙ ЗАМОРОЗОК в ночь на ${buildDateLabels([weatherData.time[firstFreezeIndex]])[0]}.`);
    }

    // 4. Постоянный характер погоды
    const rainyDays = weatherData.precipitation_amount_max.filter(p => p > 0.5).length;
    if (rainyDays >= 5) {
        insights.push("Главная тема недели - затяжные дожди, готовьте зонты и терпение.");
    } else {
        const sunnyDays = weatherData.cloud_cover_max.filter(c => c !== null && c < 40).length;
        if (sunnyDays >= 4) {
            insights.push("Впереди несколько солнечных и преимущественно сухих дней - отличная возможность насладиться погодой.");
        }
    }

    return insights;
}

/* =========================
 * 8) Генерация статьи
 * ========================= */
const MODEL_PRIMARY = "gemini-1.5-flash-latest";
async function generateArticle(weatherData, timeOfDayRu) {
  const tz = "Europe/Riga";
  const todayRiga = new Date(new Date().toLocaleString("en-US", { timeZone: tz }));
  const historicalRecord = await getHistoricalRecord(todayRiga);
  const analyticalHighlights = analyzeWeatherData(weatherData, historicalRecord);
  const globalEvents = await getGlobalEvents();

  const dataPayload = {
    dates: buildDateLabels(weatherData.time),
    analytical_highlights: analyticalHighlights,
    temperature_min_int: weatherData.temperature_2m_min_int,
    temperature_max_int: weatherData.temperature_2m_max_int,
    precipitation_amount_max: weatherData.precipitation_amount_max,
    cloud_cover_max: weatherData.cloud_cover_max,
    wind_speed_max: weatherData.wind_speed_10m_max,
    wind_gusts_max: weatherData.wind_gusts_10m_max,
    wind_direction_dominant: weatherData.wind_direction_dominant,
    globalEvents,
  };
    
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
Экстремальные события в мире сегодня (опиши события из globalEvents, в конце укажи источники словами: по данным USGS и NOAA/NHC)
Обзор погоды с высоты птичьего полёта (объясни синоптическую ситуацию: циклоны, фронты, воздушные массы)
Детальный прогноз по дням (опиши каждый день, не забывая вплетать аналитические моменты, где это уместно. Укажи направление ветра словами и порывы ≥10 м/с)
Почему так, а не иначе (простое объяснение, почему погода будет именно такой)
Погода и история / Погода и животные / Моря и океаны (выбери одну-две из этих тем и расскажи небольшую, уместную историю)
Совет от метеоролога (практичные рекомендации, основанные на прогнозе)
Мини-рубрика "Сегодня в истории" (используй текст из <NOTE>)
Завершение (краткое резюме и тёплое прощание)

ДАННЫЕ (НЕ выводить, использовать только для анализа):
<DATA_JSON>
${JSON.stringify(dataPayload, null, 2)}
</DATA_JSON>

<NOTE>
Сегодня в истории: ${historicalRecord.text}
</NOTE>
`;

  try {
    const model = genAI.getGenerativeModel({
      model: MODEL_PRIMARY,
      generationConfig: { temperature: 0.9, topP: 0.9, topK: 40, maxOutputTokens: 2500 }
    });
    console.log(`ℹ️  Генерирую текст моделью: ${MODEL_PRIMARY}`);
    const result = await model.generateContent(prompt);
    const text = sanitizeArticle(result.response.text());
    console.log(`✅ Использована модель: ${MODEL_PRIMARY}`);
    return { article: text, modelUsed: MODEL_PRIMARY };
  } catch (e) {
    console.error(`❌ Модель "${MODEL_PRIMARY}" не сработала: ${e.message}`);
    throw new Error(`Ошибка генерации текста Gemini.`);
  }
}

/* =========================
 * 9) Сохранение результата
 * ========================= */
function saveArticle(articleText, timeOfDay, modelUsed) {
  const now = new Date();
  const fileDate = now.toISOString().slice(0, 10);
  const displayDate = now.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Riga" });
  
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
 * 10) Основной запуск
 * ========================= */
(async () => {
  console.log(`🚀 Запуск генерации статьи (${timeOfDay})...`);
  try {
    const weatherData = await getWeatherData();
    console.log("📊 Данные MET.NO получены и агрегированы.");

    const { article, modelUsed } = await generateArticle(weatherData, timeOfDayRu);
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

