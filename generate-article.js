import axios from "axios";
import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "fs";

/**
 * generate-article.js
 * — Берёт почасовой прогноз MET.NO (YR.no), агрегирует в дневные показатели на 7 дней
 * — Получает исторические рекорды именно на сегодняшнюю календарную дату
 * — Генерирует «человечный» текст Gemini и сохраняет в JSON
 * — Глобальные события берём из надежных источников: USGS (землетрясения) и NHC (тропические циклоны)
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
const timeOfDayRu = TOD_RU[timeOfDay] || timeOfDay;

// 3) Утилиты
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
  const dirs = ["С", "ССВ", "СВ", "ВСВ", "В", "ВЮВ", "ЮВ", "ЮЮВ", "Ю", "ЮЮЗ", "ЮЗ", "ЗЮЗ", "З", "ЗСЗ", "СЗ", "ССЗ"];
  const ix = Math.round((d % 360) / 22.5) % 16;
  return dirs[ix];
}
async function fetchJsonSafe(url, opts = {}) {
  try {
    const { data } = await axios.get(url, { timeout: 20000, ...opts });
    return data;
  } catch (e) {
    console.warn(`WARN: не удалось загрузить ${url}:`, e.message);
    return null;
  }
}

// 4) MET.NO → дневная агрегация
async function getWeatherData() {
  const lat = 56.95;
  const lon = 24.1;
  const url = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat}&lon=${lon}`;

  try {
    const response = await axios.get(url, {
      headers: {
        // Требование MET.NO: идентифицирующий User-Agent
        "User-Agent": "WeatherBloggerApp/1.0 (+https://github.com/meteomonster/weather-blogger)"
      },
      timeout: 20000
    });

    const timeseries = response.data?.properties?.timeseries || [];
    if (!timeseries.length) throw new Error("Пустой timeseries в ответе MET.NO");

    const byDay = new Map();
    for (const entry of timeseries) {
      const iso = entry.time;
      const day = iso.slice(0, 10);
      const instant = entry?.data?.instant?.details || {};
      const next1 = entry?.data?.next_1_hours || null;

      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push({
        air_temperature: instant.air_temperature,
        wind_speed: instant.wind_speed,
        wind_gust: instant.wind_speed_of_gust,
        wind_dir: instant.wind_from_direction,
        cloud: instant.cloud_area_fraction,
        // MET.NO выдаёт осадки на следующий час; это «мм за час»
        precip_next1h:
          next1?.summary?.precipitation_amount ??
          next1?.details?.precipitation_amount ??
          null
      });
    }

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
      precipitation_amount_max: [],
      cloud_cover_max: [],
      sunrise: [],
      sunset: []
    };

    for (const day of forecastDays) {
      const arr = byDay.get(day) || [];
      const nums = k => arr.map(a => a[k]).filter(n => typeof n === "number");

      const temps = nums("air_temperature");
      const winds = nums("wind_speed");
      const gusts = nums("wind_gust");
      const clouds = nums("cloud");
      const dirs = nums("wind_dir");
      const pr1h  = nums("precip_next1h");

      const tMax = temps.length ? Math.max(...temps) : null;
      const tMin = temps.length ? Math.min(...temps) : null;

      // Простейшая поправка «по ощущению»
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

      // Можно при желании добавить рассвет/закат через отдельный API — сейчас пусто (не выдумываем).
      processed.sunrise.push("");
      processed.sunset.push("");
    }

    return processed;
  } catch (error) {
    console.error("Не удалось получить данные о погоде от MET.NO:", error.response?.data || error.message);
    throw new Error("Ошибка получения данных о погоде.");
  }
}

// 5) Исторические рекорды для ЭТОГО дня календаря (Open-Meteo Archive)
async function getHistoricalRecord(date) {
  try {
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    const startYear = 1979;
    const endYear = date.getUTCFullYear() - 1;

    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=56.95&longitude=24.1&start_date=${startYear}-${month}-${day}&end_date=${endYear}-${month}-${day}&daily=temperature_2m_max,temperature_2m_min`;

    const data = await fetchJsonSafe(url);
    const t = data?.daily?.time || [];
    const tmax = data?.daily?.temperature_2m_max || [];
    const tmin = data?.daily?.temperature_2m_min || [];

    if (!t.length) return "Нет надёжных исторических данных для этой даты.";

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

// 6) Глобальные события: землетрясения (USGS) + тропические циклоны (NHC)
async function getGlobalEvents() {
  const today = new Date();
  const isoDate = today.toISOString().split("T")[0];

  const sourcesUsed = [];

  // Землетрясения (USGS FDSN, M>=5.0 за текущие сутки UTC)
  let earthquakes = [];
  try {
    const eqUrl =
      `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=${isoDate}T00:00:00&endtime=${isoDate}T23:59:59&minmagnitude=5.0`;
    const eq = await fetchJsonSafe(eqUrl, { timeout: 15000 });
    if (eq?.features?.length) {
      earthquakes = eq.features.map(f => ({
        magnitude: f.properties?.mag ?? null,
        location: f.properties?.place ?? "",
        time: f.properties?.time ? new Date(f.properties.time) : null
      })).filter(e => typeof e.magnitude === "number");
      sourcesUsed.push({ kind: "earthquakes", url: eqUrl });
    }
  } catch (e) {
    console.warn("Не удалось получить данные о землетрясениях:", e.message);
  }

  // Тропические циклоны (NHC CurrentStorms.json — Атлантика и Вост. Тихий)
  let hurricanes = [];
  try {
    const nhcUrl = "https://www.nhc.noaa.gov/CurrentStorms.json";
    const nhc = await fetchJsonSafe(nhcUrl, { timeout: 15000 });

    // Структура может эволюционировать; парсим бережно.
    // В образцах NHC есть корневой объект с массивом текущих штормов; ищем любые массивы с объектами штормов.
    const candidates = [];
    if (Array.isArray(nhc)) candidates.push(...nhc);
    if (nhc && typeof nhc === "object") {
      for (const k of Object.keys(nhc)) {
        if (Array.isArray(nhc[k])) candidates.push(...nhc[k]);
      }
    }

    hurricanes = candidates
      .map(s => {
        // Нормализуем возможные поля
        const name = s?.stormName || s?.name || s?.cyclone?.name || s?.advisory?.name || null;
        const basin = s?.basin || s?.basinId || s?.stormBasin || null;
        const status = s?.status || s?.stormType || s?.type || null;
        const maxWind =
          s?.maxWind ?? s?.advisory?.maxWind ?? s?.intensity?.maxWind ?? null; // узлы или миль/ч — формат зависит от файла
        const lat = s?.latitude ?? s?.lat ?? s?.center?.lat ?? null;
        const lon = s?.longitude ?? s?.lon ?? s?.center?.lon ?? null;

        return {
          name,
          basin,
          status,
          maxWind,
          position: (lat != null && lon != null) ? { lat, lon } : null
        };
      })
      .filter(h => h.name || h.status || h.maxWind != null);

    if (hurricanes.length) {
      sourcesUsed.push({ kind: "tropical_cyclones", url: nhcUrl });
    }
  } catch (e) {
    console.warn("Не удалось получить данные NHC:", e.message);
  }

  return { earthquakes, hurricanes, sourcesUsed };
}

// 7) Формирование человекочитаемых дат
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

// 8) Генерация статьи (модель берёт только предоставленные данные)
async function generateArticle(weatherData, timeOfDayRu) {
  const tz = "Europe/Riga";
  const dates = buildDateLabels(weatherData.time);
  const todayRiga = new Date(new Date().toLocaleString("en-US", { timeZone: tz }));
  const historicalRecord = await getHistoricalRecord(new Date(Date.UTC(
    todayRiga.getFullYear(),
    todayRiga.getMonth(),
    todayRiga.getDate()
  )));
  const global = await getGlobalEvents();

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
    precipitation_amount_max: weatherData.precipitation_amount_max,
    cloud_cover_max: weatherData.cloud_cover_max,
    wind_speed_max: weatherData.wind_speed_10m_max,
    wind_gusts_max: weatherData.wind_gusts_10m_max,
    wind_direction_dominant: weatherData.wind_direction_dominant,
    sunrise: weatherData.sunrise,
    sunset: weatherData.sunset,
    globalEvents: { earthquakes: global.earthquakes, hurricanes: global.hurricanes }
  };

  const prompt = `
Твоя роль: Опытный и харизматичный метеоролог, который ведёт популярный блог о погоде в Риге. Твой стиль — дружелюбный, образный и слегка ироничный, но при этом технически безупречный и профессионально точный.

Твоя задача: Написать эксклюзивный синоптический обзор для читателей блога, уделяя внимание не только местной, но и глобальной картине погоды. Сейчас нужно подготовить ${timeOfDayRu} выпуск.

СТРОГИЕ ПРАВИЛА:
1. Используй только предоставленные данные. Не придумывай и не изменяй цифры, даты или факты.
2. Никакого Markdown — только чистый текст.
3. Только реальные даты из блока данных.
4. Подзаголовки — на отдельной строке, после — пустая строка.
5. Не выводи отдельной строкой дату под заголовком.
6. Безупречная грамотность.
7. Объём: 700–1100 слов.

СТРУКТУРА:
Заголовок
Вступление
Экстремальные события в мире сегодня
Обзор погоды с высоты птичьего полёта
Детальный прогноз по дням
Почему так, а не иначе
Погода и история
Погода и животные
Моря и океаны
Совет от метеоролога
Мини-рубрика "Сегодня в истории"
Мини-рубрика "Примета дня"
Завершение

Подсказки для "Совета от метеоролога":
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
    generationConfig: { temperature: 0.85, topP: 0.9, topK: 40, maxOutputTokens: 2000 }
  });

  try {
    const result = await model.generateContent(prompt);
    const generatedText = sanitizeArticle(result.response.text());
    return { text: generatedText, sourcesUsed: global.sourcesUsed };
  } catch (error) {
    console.error("Ошибка при генерации статьи моделью Gemini:", error.message);
    throw new Error("Ошибка генерации текста.");
  }
}

// 9) Сохранение результата
function saveArticle(articleText, timeOfDay, sourcesUsed) {
  const now = new Date();
  const fileDate = now.toISOString().slice(0, 10);
  const displayDate = now.toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Riga"
  });

  const lines = articleText.split("\n");
  const titleIndex = lines.findIndex(l => l.trim().length > 0);
  const title = titleIndex > -1 ? lines[titleIndex].trim() : "Прогноз погоды в Риге";
  const content = titleIndex > -1 ? lines.slice(titleIndex + 1).join("\n").trim() : articleText;

  const articleJson = {
    title,
    date: displayDate,
    time: timeOfDay,
    content,
    // Прозрачность: фиксируем источники данных, реально использованные при генерации
    sources: [
      { kind: "forecast", url: "https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=56.95&lon=24.1" },
      { kind: "climate_archive", url: "https://archive-api.open-meteo.com/v1/archive" },
      // динамические источники (с метками)
      ...sourcesUsed.map(s => ({ ...s, fetchedAt: now.toISOString() }))
    ]
  };

  const archiveFileName = `article-${fileDate}-${timeOfDay}.json`;
  fs.writeFileSync(archiveFileName, JSON.stringify(articleJson, null, 2), "utf-8");
  fs.writeFileSync("latest-article.json", JSON.stringify(articleJson, null, 2), "utf-8");

  console.log(`✅ Статья (${timeOfDay}) успешно сохранена в ${archiveFileName} и latest-article.json`);
}

// 10) Основной запуск
(async () => {
  console.log(`🚀 Запуск генерации статьи (${timeOfDay})...`);
  try {
    const weather = await getWeatherData();
    console.log("📊 Данные о погоде (MET.NO) получены и агрегированы.");

    const { text: article, sourcesUsed } = await generateArticle(weather, timeOfDayRu);
    console.log("✍️ Статья сгенерирована моделью Gemini.");

    console.log("\n=== Сгенерированная статья ===\n");
    console.log(article);
    console.log("\n============================\n");

    saveArticle(article, timeOfDay, sourcesUsed);
  } catch (error) {
    console.error("❌ Произошла критическая ошибка:", error.message);
    process.exit(1);
  }
})();
