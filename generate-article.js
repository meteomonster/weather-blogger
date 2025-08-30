import axios from "axios";
import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "fs";

/**
 * generate-article.js
 * — Берёт почасовой прогноз MET.NO (YR.no), агрегирует в дневные показатели на 7 дней
 * — Получает исторические рекорды именно на сегодняшнюю календарную дату
 * — Готовит чистый промпт без техблоков в ответе (данные — в <DATA_JSON>)
 * — Генерирует объёмный, «человечный» текст Gemini и сохраняет в JSON
 */

// 1) Безопасность: берём API-ключ из секретов GitHub
const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error("Ошибка: Секрет GEMINI_API_KEY не найден. Добавьте его в GitHub Secrets.");
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(API_KEY);

// 2) Параметры запуска
const timeOfDay = (process.argv[2] || "morning").toLowerCase();
const TOD_RU = { morning: "утренний", afternoon: "дневной", evening: "вечерний", night: "ночной" };
const timeOfDayRu = TOD_RU[timeOfDay] || timeOfDay; // на случай, если придёт что-то иное

// 3) Утилиты
function toISODateInTZ(date, tz) {
  // Возвращает YYYY-MM-DD в заданной таймзоне
  const s = new Date(date).toLocaleString("sv-SE", { timeZone: tz });
  return s.slice(0, 10);
}

function sanitizeArticle(text) {
  if (!text) return "";
  let t = String(text);

  // Убираем код-блоки/Markdown
  t = t.replace(/```[\s\S]*?```/g, "");
  t = t.replace(/[>#*_`]+/g, "");

  // Убираем лидирующие/хвостовые пустые строки
  t = t.replace(/^\s+/, "").replace(/\s+$/, "");

  // Удаляем возможную строку-дублирующийся заголовок ниже по тексту
  const lines = t.split("\n").map(l => l.replace(/\s+$/,""));
  const firstContentLineIndex = lines.findIndex(l => l.trim().length > 0);
  if (firstContentLineIndex > -1) {
    const titleLine = lines[firstContentLineIndex].trim();
    for (let i = firstContentLineIndex + 1; i < Math.min(lines.length, firstContentLineIndex + 8); i++) {
      if (lines[i].trim() === titleLine) {
        lines.splice(i, 1);
        break;
      }
    }
  }

  // Если сразу после заголовка идёт отдельная «дата»-строка — удаляем её (мы не просим выводить отдельную дату)
  const dateLike = /^\d{1,2}\s[а-яё]+\s20\d{2}\s?г?\.?/i;
  const idx = lines.findIndex(l => l.trim().length > 0);
  if (idx > -1 && idx + 1 < lines.length) {
    const next = lines[idx + 1].trim();
    if (dateLike.test(next)) {
      lines.splice(idx + 1, 1);
    }
  }

  t = lines.join("\n").trim() + "\n";
  return t;
}

function circularMeanDeg(values) {
  // Среднее направление ветра по кругу в градусах (0..360)
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
  const dirs = ["C", "ССВ", "СВ", "ВСВ", "В", "ВЮВ", "ЮВ", "ЮЮВ", "Ю", "ЮЮЗ", "ЮЗ", "ЗЮЗ", "З", "ЗСЗ", "СЗ", "ССЗ"];
  const ix = Math.round((d % 360) / 22.5) % 16;
  return dirs[ix];
}

// 4) Получение прогноза MET.NO и агрегация в дневные значения
async function getWeatherData() {
  const lat = 56.95;
  const lon = 24.1;
  const url = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat}&lon=${lon}`;

  try {
    const response = await axios.get(url, {
      headers: {
        // Требование MET.NO — корректный User-Agent
        "User-Agent": "WeatherBloggerApp/1.0 (+https://github.com/meteomonster/weather-blogger)"
      },
      timeout: 20000
    });

    const timeseries = response.data?.properties?.timeseries || [];
    if (!timeseries.length) throw new Error("Пустой timeseries в ответе MET.NO");

    // Сформируем карту: дата YYYY-MM-DD -> массив почасовых объектов (instant + next_1h)
    const byDay = new Map();
    for (const entry of timeseries) {
      const iso = entry.time; // "2025-08-30T12:00:00Z"
      const day = iso.slice(0, 10);
      const instant = entry?.data?.instant?.details || {};
      const next1 = entry?.data?.next_1_hours || null;

      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push({
        air_temperature: instant.air_temperature,                       // °C
        wind_speed: instant.wind_speed,                                 // м/с
        wind_gust: instant.wind_speed_of_gust,                          // м/с
        wind_dir: instant.wind_from_direction,                          // градусы
        cloud: instant.cloud_area_fraction,                             // %
        // Осадки на следующий час — MET.NO может класть в summary или details
        precip_next1h:
          next1?.summary?.precipitation_amount ??
          next1?.details?.precipitation_amount ??
          null
      });
    }

    // Берём 7 ближайших дат по возрастанию
    const forecastDays = Array.from(byDay.keys()).sort().slice(0, 7);

    const processed = {
      time: forecastDays,
      temperature_2m_max: [],
      temperature_2m_min: [],
      apparent_temperature_max: [],
      apparent_temperature_min: [],
      wind_speed_10m_max: [],
      wind_gusts_10m_max: [],
      wind_direction_dominant: [],
      precipitation_amount_max: [], // максимум по часу, мм/ч
      cloud_cover_max: [],          // максимум покрытия, %
      sunrise: [],                  // заглушки, если захотите заполнять из другого источника
      sunset: []
    };

    for (const day of forecastDays) {
      const arr = byDay.get(day) || [];
      const temps = arr.map(a => a.air_temperature).filter(n => typeof n === "number");
      const winds = arr.map(a => a.wind_speed).filter(n => typeof n === "number");
      const gusts = arr.map(a => a.wind_gust).filter(n => typeof n === "number");
      const clouds = arr.map(a => a.cloud).filter(n => typeof n === "number");
      const dirs = arr.map(a => a.wind_dir).filter(n => typeof n === "number");
      const pr1h = arr.map(a => a.precip_next1h).filter(n => typeof n === "number");

      // Макс/мин температура
      const tMax = temps.length ? Math.max(...temps) : null;
      const tMin = temps.length ? Math.min(...temps) : null;

      // «По ощущению» (эмпирически): при сильном ветре ощущается на 1°C прохладнее
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
      processed.wind_direction_dominant.push({
        deg: domDir,
        compass: domDir == null ? null : degToCompass(domDir)
      });

      processed.precipitation_amount_max.push(pr1h.length ? Math.max(...pr1h) : 0);

      processed.sunrise.push("");  // можно заполнить из отдельного источника
      processed.sunset.push("");
    }

    return processed;
  } catch (error) {
    console.error("Не удалось получить данные о погоде от MET.NO:", error.response?.data || error.message);
    throw new Error("Ошибка получения данных о погоде.");
  }
}

// 5) Исторические рекорды для ЭТОГО дня календаря (в Риге, по Open-Meteo Archive)
async function getHistoricalRecord(date) {
  try {
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    const startYear = 1979; // надёжный период для многих реанализов
    const endYear = date.getUTCFullYear() - 1;

    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=56.95&longitude=24.1&start_date=${startYear}-${month}-${day}&end_date=${endYear}-${month}-${day}&daily=temperature_2m_max,temperature_2m_min`;

    const { data } = await axios.get(url, { timeout: 20000 });
    const t = data?.daily?.time || [];
    const tmax = data?.daily?.temperature_2m_max || [];
    const tmin = data?.daily?.temperature_2m_min || [];

    if (!t.length) return "Нет надёжных исторических данных для этой даты.";

    // Оставляем только записи, где месяц/день совпадают (на случай, если API вернул диапазон)
    const recs = t.map((iso, i) => ({
      year: Number(iso.slice(0, 4)),
      month: iso.slice(5, 7),
      day: iso.slice(8, 10),
      max: tmax[i],
      min: tmin[i]
    })).filter(r => r.month === month && r.day === day && r.max != null && r.min != null);

    if (!recs.length) return "Недостаточно исторических данных для этой даты.";

    const recordMax = recs.reduce((a, b) => (a.max > b.max ? a : b));
    const recordMin = recs.reduce((a, b) => (a.min < b.min ? a : b));

    return `Самый тёплый в этот день: ${recordMax.year} год, ${recordMax.max.toFixed(1)}°C. Самый холодный: ${recordMin.year} год, ${recordMin.min.toFixed(1)}°C.`;
  } catch (e) {
    console.warn("Не удалось получить исторические данные:", e.message);
    return "Не удалось загрузить исторические данные для этой даты.";
  }
}

// 6) Формирование человекочитаемых дат по массиву daily.time
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

    // во вторник / в среду и т.п.
    const needsO = /^(в|с)/.test(weekday) ? "о" : "";
    return `В${needsO} ${weekday}, ${human}`;
  });
}

// 7) Генерация статьи по промпту
async function generateArticle(weatherData, timeOfDayRu) {
  const tz = "Europe/Riga";
  const dates = buildDateLabels(weatherData.time);
  const todayRiga = new Date(new Date().toLocaleString("en-US", { timeZone: tz }));
  const historicalRecord = await getHistoricalRecord(new Date(Date.UTC(
    todayRiga.getFullYear(),
    todayRiga.getMonth(),
    todayRiga.getDate()
  )));

  // Флаги для усиления «Совета от метеоролога»
  const maxWind = Math.max(...weatherData.wind_speed_10m_max.filter(v => typeof v === "number"));
  const maxGust = Math.max(...weatherData.wind_gusts_10m_max.filter(v => typeof v === "number"));
  const highPrecip = Math.max(...weatherData.precipitation_amount_max);
  const feelsNoticeable = weatherData.apparent_temperature_min.some((tminF, i) => {
    const tmin = weatherData.temperature_2m_min[i];
    const tmaxF = weatherData.apparent_temperature_max[i];
    const tmax = weatherData.temperature_2m_max[i];
    return (tminF != null && tmin != null && Math.abs(tminF - tmin) > 1) ||
           (tmaxF != null && tmax != null && Math.abs(tmaxF - tmax) > 1);
  });

  const advisoryHints = [];
  if (Number.isFinite(maxGust) && maxGust >= 15) advisoryHints.push("Ожидаются сильные порывы ветра (15 м/с и выше).");
  if (Number.isFinite(highPrecip) && highPrecip >= 2) advisoryHints.push("Возможны интенсивные осадки (2 мм/ч и выше).");
  if (feelsNoticeable) advisoryHints.push("Температура 'по ощущению' заметно отличается от фактической.");

  const dataPayload = {
    dates,
    temperature_min: weatherData.temperature_2m_min,
    temperature_max: weatherData.temperature_2m_max,
    apparent_min: weatherData.apparent_temperature_min,
    apparent_max: weatherData.apparent_temperature_max,
    precipitation_amount_max: weatherData.precipitation_amount_max, // мм/ч
    cloud_cover_max: weatherData.cloud_cover_max,                   // %
    wind_speed_max: weatherData.wind_speed_10m_max,                 // м/с
    wind_gusts_max: weatherData.wind_gusts_10m_max,                 // м/с
    wind_direction_dominant: weatherData.wind_direction_dominant,   // {deg, compass}
    sunrise: weatherData.sunrise,
    sunset: weatherData.sunset
  };

  const prompt = `
Твоя роль: Опытный и харизматичный метеоролог, который ведёт популярный блог о погоде в Риге. Твой стиль — дружелюбный, образный и слегка ироничный, но при этом технически безупречный и профессионально точный. Ты объясняешь сложные процессы простым языком, используя метафоры к месту и не перегружая текст.

Твоя задача: Написать эксклюзивный синоптический обзор для читателей блога. Сейчас нужно подготовить ${timeOfDayRu} выпуск.

СТРОГИЕ ПРАВИЛА (ОБЯЗАТЕЛЬНО К ВЫПОЛНЕНИЮ):
1. Используй только предоставленные данные. Не придумывай и не изменяй цифры, даты или факты.
2. Никакого Markdown: не используй символы ##, **, * или любые другие. Только чистый текст.
3. Только реальные даты: не используй "1-й день", "2-й день". Применяй даты из блока данных.
4. Подзаголовки: каждый подзаголовок на отдельной строке, после него — одна пустая строка.
5. Не выводи отдельную строку с датой под заголовком. Заголовок — одна строка, затем сразу текст.
6. Безупречная грамотность русского языка, аккуратные предлоги и числительные.
7. Объём выпуска: 700–1100 слов. Каждый раздел должен быть содержательным, без воды.

СТРУКТУРА СТАТЬИ:
Заголовок
Вступление
Синоптическая картина с высоты птичьего полёта
Детальный прогноз по дням
Почему так, а не иначе
Совет от метеоролога
Мини-рубрика "А вы знали, что..."
Мини-рубрика "Сегодня в истории"
Мини-рубрика "Примета дня"
Завершение

ДЕТАЛИ СОДЕРЖАНИЯ:
— Вступление: дружелюбное приветствие, создай настроение и плавно подведи к главной теме недели.
— Синоптическая картина: опиши происхождение и положение барических центров (циклон/антициклон), связанные фронты (тёплый/холодный), адвекцию воздушных масс (откуда и куда идёт воздух), барический градиент и его влияние на ветер, роль Балтийского моря и суши. Укажи, как это отразится на температуре, облачности, вероятности и характере осадков, видимости, ветре и его порывах.
— Детальный прогноз по дням: для каждого из ближайших дней используй минимум 4–6 предложений. Дай ощущение «живого» дня: утро/день/вечер/ночь (если уместно), когда возможны «световые окна» без осадков, где погода будет комфортна (например, для прогулки у воды или парка), отметь направление ветра словами (используй компасные стороны из данных), укажи порывы, если они заметные (≥10 м/с), и крупные колебания облачности.
— Почему так, а не иначе: объясни механику происходящего простым языком (на уровне популярной метеорологии), 5–7 предложений.
— Совет от метеоролога: 3–5 практических рекомендаций одним цельным абзацем (одежда/зонт/планирование дел/прогулки/велосипед/у воды и т.п.). Учти подсказки ниже.
— "А вы знали, что...": один интересный факт из общей метеорологии (без цифр, которых нет в данных).
— "Сегодня в истории": используй ровно этот текст — он уже готов и проверен.
— "Примета дня": короткая народная примета + короткое научное пояснение, почему она может работать.
— Избегай сухих перечислений. Пиши живо и образно, но без перегруза.

Подсказки для раздела "Совет от метеоролога":
${advisoryHints.join(" ") || "Особых погодных рисков не ожидается, сделай акцент на комфорте и планировании активностей."}

ДАННЫЕ (не выводить в ответ, использовать только для анализа):

<DATA_JSON>
${JSON.stringify(dataPayload)}
</DATA_JSON>

<NOTE>
Сегодня в истории: ${historicalRecord}
</NOTE>
`;

  const model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash-latest",
    generationConfig: {
      temperature: 0.85,
      topP: 0.9,
      topK: 40,
      maxOutputTokens: 2000
    }
  });

  try {
    const result = await model.generateContent(prompt);
    return sanitizeArticle(result.response.text());
  } catch (error) {
    console.error("Ошибка при генерации статьи моделью Gemini:", error.message);
    throw new Error("Ошибка генерации текста.");
  }
}

// 8) Сохранение результата
function saveArticle(articleText, timeOfDay) {
  const now = new Date();
  const fileDate = now.toISOString().slice(0, 10);
  const displayDate = now.toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Riga"
  });

  const firstLine = articleText.split("\n").find(l => l.trim().length > 0) || "";
  const title = firstLine.replace(/[#*]/g, "").trim() || "Прогноз погоды в Риге";

  const articleJson = {
    title,
    date: displayDate,
    time: timeOfDay,
    content: articleText
  };

  const archiveFileName = `article-${fileDate}-${timeOfDay}.json`;
  fs.writeFileSync(archiveFileName, JSON.stringify(articleJson, null, 2), "utf-8");
  fs.writeFileSync("latest-article.json", JSON.stringify(articleJson, null, 2), "utf-8");

  console.log(`✅ Статья (${timeOfDay}) успешно сохранена в ${archiveFileName} и latest-article.json`);
}

// 9) Основной запуск
(async () => {
  console.log(`🚀 Запуск генерации статьи (${timeOfDay})...`);
  try {
    const weather = await getWeatherData();
    console.log("📊 Данные о погоде (MET.NO) получены и агрегированы.");

    const article = await generateArticle(weather, timeOfDayRu);
    console.log("✍️ Статья сгенерирована моделью Gemini.");

    console.log("\n=== Сгенерированная статья ===\n");
    console.log(article);
    console.log("\n============================\n");

    saveArticle(article, timeOfDay);
  } catch (error) {
    console.error("❌ Произошла критическая ошибка:", error.message);
    process.exit(1);
  }
})();
