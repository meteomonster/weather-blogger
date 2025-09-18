/**
 * generate-article.js
 * v4.3 (Unique Facts Logic & Refinement)
 *
 * CHANGELOG:
 * - Replaced `getRandomFact` with `getUniqueRandomFact` to ensure each fact is used only once per cycle.
 * - The new logic tracks used facts in a `used-facts-log.json` file.
 * - When all facts from `weather-facts.js` have been used, the log is automatically cleared, and the cycle begins anew.
 * - This prevents repetition and keeps the articles fresh over a long period.
 */

import axios from "axios";
import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "fs";
import { weatherFacts } from "./weather-facts.js";

/* ========================================================================== */
/* 0. КОНФИГУРАЦИЯ                                                           */
/* ========================================================================== */

const CONFIG = {
  LOCATION: { LAT: 56.95, LON: 24.1, TIMEZONE: "Europe/Riga" },
  API: {
    USER_AGENT: "WeatherBloggerApp/1.3 (+https://github.com/meteomonster/weather-blogger)",
    TIMEOUT: 20000,
    RETRIES: 3,
  },
  GEMINI: {
    MODEL: "gemini-1.5-flash-latest",
    GENERATION_CONFIG: { temperature: 0.9, topP: 0.9, topK: 40, maxOutputTokens: 2500 },
  },
  OUTPUT: {
    ARCHIVE_PREFIX: "article",
    LATEST_FILENAME: "latest-article.json",
    USED_FACTS_LOG: "used-facts-log.json", // Файл для отслеживания фактов
  },
};

const TIME_OF_DAY_MAPPING_RU = {
  morning: "утренний",
  afternoon: "дневной",
  evening: "вечерний",
  night: "ночной",
};

/* ========================================================================== */
/* 1. ИНИЦИАЛИЗАЦИЯ GEMINI                                                    */
/* ========================================================================== */

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error("❌ Ошибка: Секрет GEMINI_API_KEY не найден в переменных окружения.");
  process.exit(1);
}
const genAI = new GoogleGenerativeAI(API_KEY);

/* ========================================================================== */
/* 2. ПАРАМЕТРЫ ЗАПУСКА                                                       */
/* ========================================================================== */

const timeOfDay = (process.argv[2] || "morning").toLowerCase();
const timeOfDayRu = TIME_OF_DAY_MAPPING_RU[timeOfDay] || timeOfDay;

/* ========================================================================== */
/* 3. УТИЛИТЫ                                                                 */
/* ========================================================================== */

/**
 * Выбирает уникальный случайный факт, отслеживая использованные факты в файле.
 * @returns {string} Уникальный случайный факт.
 */
function getUniqueRandomFact() {
  let usedIndices = [];
  try {
    if (fs.existsSync(CONFIG.OUTPUT.USED_FACTS_LOG)) {
      usedIndices = JSON.parse(fs.readFileSync(CONFIG.OUTPUT.USED_FACTS_LOG, "utf-8"));
    }
  } catch (e) {
    console.warn("⚠️ Не удалось прочитать лог использованных фактов, начинаю заново.");
    usedIndices = [];
  }

  const allIndices = Array.from(weatherFacts.keys());
  let availableIndices = allIndices.filter(index => !usedIndices.includes(index));

  if (availableIndices.length === 0) {
    console.log("ℹ️ Все факты были использованы. Начинаю цикл заново.");
    availableIndices = allIndices;
    usedIndices = [];
  }

  const randomIndex = availableIndices[Math.floor(Math.random() * availableIndices.length)];
  usedIndices.push(randomIndex);
  
  fs.writeFileSync(CONFIG.OUTPUT.USED_FACTS_LOG, JSON.stringify(usedIndices, null, 2), "utf-8");
  
  return weatherFacts[randomIndex];
}


/**
 * Выполняет GET-запрос с несколькими попытками в случае неудачи.
 * @param {string} url URL для запроса.
 * @param {object} options Опции для axios.
 * @returns {Promise<object>} Промис, который разрешается с данными ответа.
 */
async function fetchWithRetry(url, options) {
  for (let i = 0; i < CONFIG.API.RETRIES; i++) {
    try {
      const response = await axios.get(url, options);
      return response.data;
    } catch (error) {
      const isLastAttempt = i === CONFIG.API.RETRIES - 1;
      const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
      console.warn(`⚠️ Попытка ${i + 1} запроса к ${url} не удалась: ${errorMessage}`);
      if (isLastAttempt) {
        throw new Error(`Не удалось получить данные с ${url} после ${CONFIG.API.RETRIES} попыток.`);
      }
      const delay = Math.pow(2, i) * 1000;
      await new Promise(res => setTimeout(res, delay));
    }
  }
}

function toISODateInTZ(date, tz) {
  return new Date(date).toLocaleString("sv-se", { timeZone: tz }).slice(0, 10);
}

function sanitizeArticle(text) {
  if (!text) return "";
  return String(text).replace(/```[\s\S]*?```/g, "").replace(/[>#*_`]+/g, "").trim();
}

function circularMeanDeg(values) {
  const rad = values.filter(v => typeof v === "number" && !Number.isNaN(v)).map(v => (v * Math.PI) / 180);
  if (!rad.length) return null;
  const avgX = rad.reduce((acc, r) => acc + Math.cos(r), 0) / rad.length;
  const avgY = rad.reduce((acc, r) => acc + Math.sin(r), 0) / rad.length;
  let deg = (Math.atan2(avgY, avgX) * 180) / Math.PI;
  return deg < 0 ? deg + 360 : deg;
}

const COMPASS_DIRECTIONS = ["С", "ССВ", "СВ", "ВСВ", "В", "ВЮВ", "ЮВ", "ЮЮВ", "Ю", "ЮЮЗ", "ЮЗ", "ЗЮЗ", "З", "ЗСЗ", "СЗ", "ССЗ"];

function degToCompass(d) {
  if (d == null) return null;
  return COMPASS_DIRECTIONS[Math.round((d % 360) / 22.5) % 16];
}

const roundArr = arr => arr.map(v => (typeof v === "number" ? Math.round(v) : null));

function buildDateLabels(dailyTime) {
  const tz = CONFIG.LOCATION.TIMEZONE;
  const todayStr = toISODateInTZ(new Date(), tz);
  const tomorrowStr = toISODateInTZ(new Date(Date.now() + 864e5), tz);
  return dailyTime.map(iso => {
    const d = new Date(`${iso}T00:00:00Z`);
    const human = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: tz }).format(d);
    const weekday = new Intl.DateTimeFormat("ru-RU", { weekday: "long", timeZone: tz }).format(d).toLowerCase();
    if (iso === todayStr) return `Сегодня, ${human}`;
    if (iso === tomorrowStr) return `Завтра, ${human}`;
    return `В${/^(в|с)/.test(weekday) ? "о" : ""} ${weekday}, ${human}`;
  });
}

// Функции getWeatherData, getHistoricalRecord, getGlobalEvents, analyzeWeatherData без изменений

/* ========================================================================== */
/* 4. ПОЛУЧЕНИЕ ДАННЫХ О ПОГОДЕ (MET.NO)                                      */
/* ========================================================================== */
async function getWeatherData() {
  const { LAT, LON } = CONFIG.LOCATION;
  const url = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${LAT}&lon=${LON}`;
  const data = await fetchWithRetry(url, {
    headers: { "User-Agent": CONFIG.API.USER_AGENT },
    timeout: CONFIG.API.TIMEOUT,
  });
  const timeseries = data?.properties?.timeseries || [];
  if (!timeseries.length) throw new Error("Пустой timeseries в ответе MET.NO");
  const byDay = new Map();
  for (const entry of timeseries) {
    const day = entry.time.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push({
      air_temperature: entry.data?.instant?.details?.air_temperature,
      wind_speed: entry.data?.instant?.details?.wind_speed,
      wind_gust: entry.data?.instant?.details?.wind_speed_of_gust,
      wind_dir: entry.data?.instant?.details?.wind_from_direction,
      cloud: entry.data?.instant?.details?.cloud_area_fraction,
      precip_next1h: entry.data?.next_1_hours?.details?.precipitation_amount ?? null,
    });
  }
  const forecastDays = Array.from(byDay.keys()).sort().slice(0, 7);
  const processed = {
    time: forecastDays,
    temperature_2m_max: [], temperature_2m_min: [],
    wind_speed_10m_max: [], wind_gusts_10m_max: [],
    wind_direction_dominant: [],
    precipitation_amount_max: [], cloud_cover_max: [],
  };
  for (const day of forecastDays) {
    const arr = byDay.get(day) || [];
    const temps = arr.map(a => a.air_temperature).filter(n => typeof n === "number");
    processed.temperature_2m_max.push(temps.length ? Math.max(...temps) : null);
    processed.temperature_2m_min.push(temps.length ? Math.min(...temps) : null);
    const winds = arr.map(a => a.wind_speed).filter(n => typeof n === "number");
    processed.wind_speed_10m_max.push(winds.length ? Math.max(...winds) : null);
    const gusts = arr.map(a => a.wind_gust).filter(n => typeof n === "number");
    processed.wind_gusts_10m_max.push(gusts.length ? Math.max(...gusts) : null);
    const clouds = arr.map(a => a.cloud).filter(n => typeof n === "number");
    processed.cloud_cover_max.push(clouds.length ? Math.max(...clouds) : null);
    const domDir = circularMeanDeg(arr.map(a => a.wind_dir));
    processed.wind_direction_dominant.push({ deg: domDir, compass: degToCompass(domDir) });
    const pr1h = arr.map(a => a.precip_next1h).filter(n => typeof n === "number");
    processed.precipitation_amount_max.push(pr1h.length ? Math.max(...pr1h) : 0);
  }
  processed.temperature_2m_max_int = roundArr(processed.temperature_2m_max);
  processed.temperature_2m_min_int = roundArr(processed.temperature_2m_min);
  return processed;
}

/* ========================================================================== */
/* 5. ПОЛУЧЕНИЕ ИСТОРИЧЕСКИХ РЕКОРДОВ                                          */
/* ========================================================================== */
async function getHistoricalRecord(date) {
  try {
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${CONFIG.LOCATION.LAT}&longitude=${CONFIG.LOCATION.LON}&start_date=1979-${month}-${day}&end_date=${date.getUTCFullYear() - 1}-${month}-${day}&daily=temperature_2m_max,temperature_2m_min`;
    const data = await fetchWithRetry(url, {
        headers: { "User-Agent": CONFIG.API.USER_AGENT },
        timeout: CONFIG.API.TIMEOUT
    });
    const { time, temperature_2m_max: tmax, temperature_2m_min: tmin } = data?.daily || {};
    if (!time || !time.length) return { text: "Нет надёжных исторических данных для этой даты.", data: null };
    const recs = time.map((iso, i) => ({ year: Number(iso.slice(0, 4)), month: iso.slice(5, 7), day: iso.slice(8, 10), max: tmax[i], min: tmin[i] })).filter(r => r.month === month && r.day === day && r.max != null && r.min != null);
    if (!recs.length) {
      console.warn("API Open-Meteo вернуло данные, но после фильтрации по дате ничего не осталось.");
      return { text: "Недостаточно исторических данных для этой даты.", data: null };
    }
    const recordMax = recs.reduce((a, b) => (a.max > b.max ? a : b));
    const recordMin = recs.reduce((a, b) => (a.min < b.min ? a : b));
    return {
      text: `Самый тёплый в этот день: ${recordMax.year} год, ${recordMax.max.toFixed(1)}°C. Самый холодный: ${recordMin.year} год, ${recordMin.min.toFixed(1)}°C.`,
      data: { max: recordMax, min: recordMin }
    };
  } catch (e) {
    console.warn(`Не удалось получить исторические данные: ${e.message}`);
    return { text: "Не удалось загрузить исторические данные для этой даты.", data: null };
  }
}

/* ========================================================================== */
/* 6. ПОЛУЧЕНИЕ LIVE-ЛЕНТЫ СОБЫТИЙ                                            */
/* ========================================================================== */
async function getGlobalEvents() {
    const todayUTC = new Date().toISOString().slice(0, 10);
    const events = { earthquakes: [], tropical_cyclones: [] };
    const commonOptions = { timeout: 15000, headers: { "User-Agent": CONFIG.API.USER_AGENT } };
    try {
        const eqUrl = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=${todayUTC}T00:00:00&endtime=${todayUTC}T23:59:59&minmagnitude=5.0`;
        const data = await fetchWithRetry(eqUrl, commonOptions);
        events.earthquakes = (data?.features || []).map(f => ({ magnitude: f.properties?.mag, location: f.properties?.place }));
    } catch (e) { console.warn(`Не удалось получить данные о землетрясениях: ${e.message}`); }
    try {
        const stormsUrl = `https://eonet.gsfc.nasa.gov/api/v3/events?category=severeStorms&status=open&limit=5`;
        const data = await fetchWithRetry(stormsUrl, commonOptions);
        if (data?.events) {
            events.tropical_cyclones = data.events.map(event => ({
                name: event.title,
                windSpeedKmh: Math.round((event.geometry[event.geometry.length - 1].magnitudeValue || 0) * 1.852),
                location: "Global event"
            })).filter(s => s.windSpeedKmh > 63);
        }
    } catch (e) { console.warn(`Не удалось получить данные о тропических циклонах от NASA: ${e.message}`); }
    return events;
}

/* ========================================================================== */
/* 7. ПРЕДВАРИТЕЛЬНЫЙ АНАЛИЗ ДАННЫХ                                           */
/* ========================================================================== */
function analyzeWeatherData(weatherData, historicalRecord) {
    const insights = [];
    const { temperature_2m_max_int, time } = weatherData;
    const forecastTodayMax = temperature_2m_max_int[0];
    const { data: recordData } = historicalRecord;
    if (recordData && forecastTodayMax !== null) {
        const { max: recordMax } = recordData.max;
        if (forecastTodayMax >= recordMax) {
            insights.push(`Сегодняшний день может ПОБИТЬ исторический рекорд тепла (${recordMax.toFixed(1)}°C, ${recordData.max.year} г.), прогноз почти ${forecastTodayMax}°C!`);
        } else if (Math.abs(forecastTodayMax - recordMax) <= 2) {
            insights.push(`Сегодня мы близко подойдём к историческому рекорду тепла (${recordMax.toFixed(1)}°C, ${recordData.max.year} г.).`);
        }
    }
    for (let i = 0; i < time.length - 1; i++) {
        const tempToday = temperature_2m_max_int[i];
        const tempTomorrow = temperature_2m_max_int[i + 1];
        if (tempToday !== null && tempTomorrow !== null && Math.abs(tempToday - tempTomorrow) >= 7) {
            const change = tempTomorrow > tempToday ? 'резкое потепление' : 'РЕЗКОЕ ПОХОЛОДАНИЕ';
            insights.push(`Внимание: на горизонте ${change} с ${tempToday}°C до ${tempTomorrow}°C (с ${buildDateLabels([time[i]])[0]} на ${buildDateLabels([time[i + 1]])[0]}).`);
            break;
        }
    }
    return insights;
}

/* ========================================================================== */
/* 8. ГЕНЕРАЦИЯ СТАТЬИ                                                        */
/* ========================================================================== */

/**
 * Генерирует статью о погоде с помощью Google Gemini.
 * @param {object} weatherData Данные прогноза погоды.
 * @param {string} timeOfDayRu Время суток на русском (например, "утренний").
 * @returns {Promise<{article: string, modelUsed: string}>} Сгенерированная статья и использованная модель.
 */
async function generateArticle(weatherData, timeOfDayRu) {
  const todayRiga = new Date(new Date().toLocaleString("en-US", { timeZone: CONFIG.LOCATION.TIMEZONE }));
  
  console.log("    Получаю исторические рекорды...");
  const historicalRecord = await getHistoricalRecord(todayRiga);
  
  console.log("    Получаю данные о глобальных событиях...");
  const globalEvents = await getGlobalEvents();
  
  console.log("    Провожу предварительный анализ...");
  const analyticalHighlights = analyzeWeatherData(weatherData, historicalRecord);
  
  console.log("    Выбираю уникальный факт...");
  const funFact = getUniqueRandomFact(); // Используем новую функцию

  const dataPayload = {
    dates: buildDateLabels(weatherData.time),
    analytical_highlights: analyticalHighlights,
    temperature_min_int: weatherData.temperature_2m_min_int,
    temperature_max_int: weatherData.temperature_2m_max_int,
    precipitation_amount_max: weatherData.precipitation_amount_max,
    cloud_cover_max: weatherData.cloud_cover_max,
    wind_speed_max: weatherData.wind_speed_10m_max,
    wind_gusts_max: weatherData.wind_gusts_10m_max,
    wind_direction_dominant: weatherData.wind_direction_dominant.map(d => d.compass),
    globalEvents,
  };
  
  const prompt = `
Твоя роль: Опытный, харизматичный и немного ироничный метеоролог, который ведёт популярный блог о погоде в Риге. Ты не робот, зачитывающий цифры, а рассказчик, который находит в прогнозе погоды настоящую историю. Твой стиль — живой, образный, но всегда основанный на фактах.

Твоя задача: Написать эксклюзивный ${timeOfDayRu} синоптический обзор. Твоя главная цель — не просто перечислить данные, а создать увлекательное повествование, сделав акцент на самых интересных погодных событиях недели.

КЛЮЧЕВЫЕ МОМЕНТЫ НЕДЕЛИ (АНАЛИТИКА):
Я уже провёл предварительный анализ данных и выделил для тебя самое главное. Это основа твоего повествования:
<ANALYTICAL_HIGHLIGHTS>
${analyticalHighlights.length > 0 ? analyticalHighlights.join("\n") : "На этой неделе обойдётся без крайностей, погода будет довольно стабильной."}
</ANALYTICAL_HIGHLIGHTS>

ТВОЙ ТВОРЧЕСКИЙ ПОДХОД:
1.  **Найди Главного Героя:** Посмотри на <ANALYTICAL_HIGHLIGHTS>. Что самое важное на этой неделе? Резкое похолодание? Угроза рекорда? Затяжные дожди? Выбери ОДНО ключевое событие и сделай его центральной темой, "главным героем" твоего рассказа.
2.  **Свободное Повествование:** Забудь о строгой структуре. Построй живой рассказ. Начни с интриги, связанной с "главным героем", плавно перейди к деталям по дням, объясни причины (синоптическая ситуация), а затем вернись к основной теме в конце.
3.  **Избегай Клише:** Никаких "капризных дам", "дыхания атмосферы" и "осенней меланхолии". Ищи свежие, оригинальные метафоры или просто пиши прямо и по делу, но с харизмой.
4.  **Интегрируй Факты:** Не создавай отдельные блоки для мировых событий или фактов. Вплетай их в повествование там, где это уместно. Например: "Пока у нас тут намечается первый заморозок, в мировых океанах бушует [название шторма] со скоростью ветра до [скорость] км/ч. Опиши его мощь и потенциальную зону влияния. А знаете ли вы, что [интересный факт]?".
5.  **Текст должен быть цельным.** Не используй подзаголовки и Markdown.

ДАННЫЕ (НЕ выводить, использовать только для анализа):
<DATA_JSON>
${JSON.stringify(dataPayload, null, 2)}
</DATA_JSON>

<NOTE>
Исторический факт для сегодняшнего дня (вплети его в рассказ): ${historicalRecord.text}
</NOTE>

<FUN_FACT>
Интересный факт о погоде (вплети его в рассказ): ${funFact}
</FUN_FACT>
`;

  try {
    const model = genAI.getGenerativeModel({
      model: CONFIG.GEMINI.MODEL,
      generationConfig: CONFIG.GEMINI.GENERATION_CONFIG,
    });
    console.log(`    Генерирую текст моделью: ${CONFIG.GEMINI.MODEL}...`);
    const result = await model.generateContent(prompt);
    const text = sanitizeArticle(result.response.text());
    return { article: text, modelUsed: CONFIG.GEMINI.MODEL };
  } catch (e) {
    console.error(`❌ Модель "${CONFIG.GEMINI.MODEL}" не сработала: ${e.message}`);
    throw new Error(`Ошибка генерации текста Gemini.`);
  }
}

/* ========================================================================== */
/* 9. СОХРАНЕНИЕ РЕЗУЛЬТАТА                                                   */
/* ========================================================================== */

/**
 * Сохраняет сгенерированную статью в JSON файлы.
 * @param {string} articleText Текст статьи.
 * @param {string} timeOfDay Идентификатор времени суток (например, "morning").
 * @param {string} modelUsed Название использованной модели.
 */
function saveArticle(articleText, timeOfDay, modelUsed) {
  const now = new Date();
  const fileDate = now.toISOString().slice(0, 10);
  const displayDate = now.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: CONFIG.LOCATION.TIMEZONE });
  
  const lines = articleText.split("\n");
  const titleIndex = lines.findIndex(l => l.trim().length > 0);
  const title = titleIndex > -1 ? lines[titleIndex].trim() : "Прогноз погоды в Риге";
  const content = titleIndex > -1 ? lines.slice(titleIndex + 1).join("\n").trim() : articleText;
  
  const articleJson = { title, date: displayDate, time: timeOfDay, content, model: modelUsed };
  const archiveFileName = `${CONFIG.OUTPUT.ARCHIVE_PREFIX}-${fileDate}-${timeOfDay}.json`;
  
  fs.writeFileSync(archiveFileName, JSON.stringify(articleJson, null, 2), "utf-8");
  fs.writeFileSync(CONFIG.OUTPUT.LATEST_FILENAME, JSON.stringify(articleJson, null, 2), "utf-8");
  
  console.log(`✅ Статья (${timeOfDay}) сохранена в ${archiveFileName} и ${CONFIG.OUTPUT.LATEST_FILENAME}`);
}

/* ========================================================================== */
/* 10. ОСНОВНОЙ ЗАПУСК                                                        */
/* ========================================================================== */

(async () => {
  console.log(`🚀 Запуск генерации статьи (${timeOfDay})...`);
  try {
    console.log("📊 [1/3] Получаю данные о погоде...");
    const weatherData = await getWeatherData();
    
    console.log("✍️  [2/3] Генерирую статью...");
    const { article, modelUsed } = await generateArticle(weatherData, timeOfDayRu);
    
    console.log("\n=== Сгенерированная статья ===\n");
    console.log(article);
    console.log("\n============================\n");

    console.log("💾 [3/3] Сохраняю результат...");
    saveArticle(article, timeOfDay, modelUsed);
    
    console.log("\n🎉 Готово!");

  } catch (error) {
    console.error("\n❌ КРИТИЧЕСКАЯ ОШИБКА:", error.message);
    process.exit(1);
  }
})();

