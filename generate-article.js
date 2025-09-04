import axios from "axios";
import fs from "fs";
// Новый официальный SDK: https://github.com/googleapis/js-genai
import { GoogleGenAI } from "@google/genai";

/**
 * generate-article.js
 * — MET.NO (YR.no) → агрегируем почасовой прогноз в дневные показатели на 7 дней
 * — Open-Meteo Archive → исторические рекорды на сегодняшнюю календарную дату
 * — USGS FDSN → землетрясения за последние 24 часа
 * — NHC CurrentStorms.json → тропические циклоны (fail-closed при пустой выдаче)
 * — Gemini 2.5 Flash → детальный «человечный» выпуск, валидируем и сохраняем в JSON
 */

// 1) Безопасность
const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error("Ошибка: переменная окружения GEMINI_API_KEY не задана.");
  process.exit(1);
}
const ai = new GoogleGenAI({ apiKey: API_KEY });

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
  const rad = values.filter(v => typeof v === "number" && !Number.isNaN(v)).map(v => (v * Math.PI) / 180);
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
  const contact = process.env.METNO_CONTACT || "WeatherBloggerApp/1.0 (+https://github.com/meteomonster/weather-blogger)";
  const url = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat}&lon=${lon}`;

  try {
    const response = await axios.get(url, {
      headers: { "User-Agent": contact },
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
        wind_speed: instant.wind_speed,                 // м/с
        wind_gust: instant.wind_speed_of_gust,          // м/с
        wind_dir: instant.wind_from_direction,          // градусы
        cloud: instant.cloud_area_fraction,             // %
        precip_next1h:
          next1?.summary?.precipitation_amount ??
          next1?.details?.precipitation_amount ??
          null                                         // мм/ч
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

      const temps  = nums("air_temperature");
      const winds  = nums("wind_speed");
      const gusts  = nums("wind_gust");
      const clouds = nums("cloud");
      const dirs   = nums("wind_dir");
      const pr1h   = nums("precip_next1h");

      const tMax = temps.length ? Math.max(...temps) : null;
      const tMin = temps.length ? Math.min(...temps) : null;

      const windAdj = (winds.length && Math.max(...winds) >= 8) ? 1 : 0; // простая поправка по ощущению
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

      processed.sunrise.push(""); // можно добавить отдельный астрономический API
      processed.sunset.push("");
    }

    return processed;
  } catch (error) {
    console.error("Не удалось получить данные о погоде от MET.NO:", error.response?.data || error.message);
    throw new Error("Ошибка получения данных о погоде.");
  }
}

// 5) Исторические рекорды (Open‑Meteo Archive) для этой календарной даты
async function getHistoricalRecord(date) {
  try {
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day   = String(date.getUTCDate()).padStart(2, "0");
    const startYear = 1979;
    const endYear   = date.getUTCFullYear() - 1;

    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=56.95&longitude=24.1&start_date=${startYear}-${month}-${day}&end_date=${endYear}-${month}-${day}&daily=temperature_2m_max,temperature_2m_min`;

    const data = await fetchJsonSafe(url);
    const t    = data?.daily?.time || [];
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

// 6) Глобальные события: землетрясения (USGS, последние 24 часа) + тропические циклоны (NHC)
async function getGlobalEvents() {
  const end = new Date().toISOString();
  const start = new Date(Date.now() - 24*60*60*1000).toISOString();
  const sourcesUsed = [];

  // Землетрясения
  let earthquakes = [];
  try {
    const eqUrl =
      `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=${start}&endtime=${end}&minmagnitude=5.0`;
    const eq = await fetchJsonSafe(eqUrl, { timeout: 15000 });
    if (eq?.features?.length) {
      earthquakes = eq.features.map(f => ({
        magnitude: f.properties?.mag ?? null,
        location:  f.properties?.place ?? "",
        time:      f.properties?.time ? new Date(f.properties.time) : null
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

    const candidates = [];
    if (Array.isArray(nhc)) candidates.push(...nhc);
    if (nhc && typeof nhc === "object") {
      for (const k of Object.keys(nhc)) if (Array.isArray(nhc[k])) candidates.push(...nhc[k]);
    }

    const toKmh = (value, unit) => {
      if (value == null) return null;
      const v = Number(value);
      if (!Number.isFinite(v)) return null;
      const u = String(unit || "").toLowerCase();
      if (u.includes("kt") || u.includes("knot")) return Math.round(v * 1.852);
      if (u.includes("mph")) return Math.round(v * 1.60934);
      if (u.includes("km"))  return Math.round(v);
      return Math.round(v * 1.852);
    };

    hurricanes = candidates
      .map(s => {
        const name   = s?.stormName || s?.name || s?.cyclone?.name || s?.advisory?.name || null;
        const basin  = s?.basin || s?.basinId || s?.stormBasin || null;
        const status = s?.status || s?.stormType || s?.type || null;

        const rawWind = s?.maxWind ?? s?.advisory?.maxWind ?? s?.intensity?.maxWind ?? null;
        const rawUnit = s?.windUnit || s?.units || s?.advisory?.windUnit || null;
        const maxWindKmh = toKmh(rawWind, rawUnit);

        const lat = s?.latitude ?? s?.lat ?? s?.center?.lat ?? null;
        const lon = s?.longitude ?? s?.lon ?? s?.center?.lon ?? null;
        const advisoryTime = s?.advisory?.advisoryTime || s?.advisoryTime || s?.issueTime || null;

        return {
          name, basin, status, maxWindKmh,
          position: (lat != null && lon != null) ? { lat, lon } : null,
          advisoryTime
        };
      })
      .filter(h => h.name || h.status || h.maxWindKmh != null);

    if (hurricanes.length) sourcesUsed.push({ kind: "tropical_cyclones", url: nhcUrl });
  } catch (e) {
    console.warn("Не удалось получить данные NHC:", e.message);
  }

  return { earthquakes, hurricanes, sourcesUsed };
}

// 7) Метки дат
function buildDateLabels(dailyTime) {
  const tz = "Europe/Riga";
  const todayStr    = toISODateInTZ(new Date(), tz);
  const tomorrowStr = toISODateInTZ(new Date(Date.now() + 864e5), tz);

  return dailyTime.map((iso) => {
    const d = new Date(`${iso}T00:00:00Z`);
    const human   = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: tz }).format(d);
    const weekday = new Intl.DateTimeFormat("ru-RU", { weekday: "long", timeZone: tz }).format(d).toLowerCase();

    if (iso === todayStr) return `Сегодня, ${human}`;
    if (iso === tomorrowStr) return `Завтра, ${human}`;

    const needsO = /^(в|с)/.test(weekday) ? "о" : "";
    return `В${needsO} ${weekday}, ${human}`;
  });
}

// 8) Валидация и длина по разделам
const HEADINGS = [
  "Вступление",
  "Экстремальные события в мире сегодня",
  "Обзор погоды с высоты птичьего полёта",
  "Детальный прогноз по дням",
  "Почему так, а не иначе",
  "Погода и история",
  "Погода и животные",
  "Моря и океаны",
  "Совет от метеоролога",
  "Мини-рубрика \"Сегодня в истории\"",
  "Мини-рубрика \"Примета дня\"",
  "Завершение"
];

const SECTION_WORD_TARGETS = {
  "Вступление": [120, 180],
  "Экстремальные события в мире сегодня": [130, 200],
  "Обзор погоды с высоты птичьего полёта": [150, 230],
  "Детальный прогноз по дням": [280, 520],   // 7 дней × 4–6 предложений
  "Почему так, а не иначе": [100, 160],
  "Погода и история": [120, 180],
  "Погода и животные": [110, 160],
  "Моря и океаны": [110, 160],
  "Совет от метеоролога": [80, 120],
  "Мини-рубрика \"Сегодня в истории\"": [12, 120],
  "Мини-рубрика \"Примета дня\"": [40, 100],
  "Завершение": [60, 110]
};

function splitBySections(text) {
  const sections = {};
  let current = "TITLE";
  sections[current] = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const h = HEADINGS.find(hh => line.trim() === hh);
    if (h) {
      current = h;
      if (!sections[current]) sections[current] = [];
      continue;
    }
    sections[current] = sections[current] || [];
    sections[current].push(line);
  }
  const joined = {};
  for (const [k, arr] of Object.entries(sections)) joined[k] = arr.join("\n").trim();
  return joined;
}

function wordCount(s) { return s ? s.trim().split(/\s+/).filter(Boolean).length : 0; }

function validateArticle(text) {
  const issues = [];
  const sections = splitBySections(text);

  // Проверка заголовка
  if (!sections.TITLE || !sections.TITLE.split("\n")[0]?.trim()) {
    issues.push("Отсутствует строка заголовка в начале текста.");
  }

  // Наличие всех рубрик и минимальный объём
  for (const h of HEADINGS) {
    if (!(h in sections)) {
      issues.push(`Отсутствует раздел: ${h}`);
      continue;
    }
    const [minWords] = SECTION_WORD_TARGETS[h] || [60, 9999];
    if (wordCount(sections[h]) < minWords) {
      issues.push(`Слишком короткий раздел: ${h} (менее ${minWords} слов).`);
    }
  }

  return { ok: issues.length === 0, issues, sections };
}

// 9) Генерация статьи (с одной попыткой исправления)
async function generateArticle(weatherData, timeOfDayRu) {
  const tz = "Europe/Riga";
  const dates = buildDateLabels(weatherData.time);
  const todayRiga = new Date(new Date().toLocaleString("en-US", { timeZone: tz }));

  const historicalRecord = await getHistoricalRecord(new Date(Date.UTC(
    todayRiga.getFullYear(), todayRiga.getMonth(), todayRiga.getDate()
  )));

  const global = await getGlobalEvents();
  console.log("🌍 Глобальные события (payload):", JSON.stringify(global, null, 2));

  const maxWind    = Math.max(...weatherData.wind_speed_10m_max.filter(v => typeof v === "number"));
  const maxGust    = Math.max(...weatherData.wind_gusts_10m_max.filter(v => typeof v === "number"));
  const highPrecip = Math.max(...weatherData.precipitation_amount_max);

  const feelsNoticeable = weatherData.apparent_temperature_min.some((tminF, i) => {
    const tmin  = weatherData.temperature_2m_min[i];
    const tmaxF = weatherData.apparent_temperature_max[i];
    const tmax  = weatherData.temperature_2m_max[i];
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
    wind_speed_max: weatherData.wind_speed_10m_max,   // м/с
    wind_gusts_max: weatherData.wind_gusts_10m_max,   // м/с
    wind_direction_dominant: weatherData.wind_direction_dominant, // {deg, compass}
    sunrise: weatherData.sunrise,
    sunset: weatherData.sunset,
    globalEvents: { earthquakes: global.earthquakes, hurricanes: global.hurricanes }
  };

  const hurricaneGuidance = global.hurricanes.length === 0
    ? "Если массив hurricanes пустой, напиши ровно: Активных тропических циклонов NHC не сообщает на сегодня."
    : "Если массив hurricanes не пуст, опиши только те циклоны, что в данных: имя (если есть), бассейн, статус, максимальный ветер в км/ч (поле maxWindKmh) и добавь 'по состоянию на HH:MM UTC', если есть advisoryTime. Ничего не придумывай сверх данных.";
  const earthquakeGuidance = global.earthquakes.length === 0
    ? "Если массив earthquakes пустой, напиши: USGS не сообщает о значимых землетрясениях M≥5.0 за последние 24 часа."
    : "Перечисли землетрясения из массива earthquakes: магнитуда (с одной десятичной), место, время события по местному времени Риги (укажи, что это конвертация).";

  const STYLE_RULES = `
СТИЛЬ И ЖИВОСТЬ:
— Пиши образно, но технически корректно. Короткие и длинные фразы чередуй для ритма.
— Используй метафоры точечно (не чаще 1–2 на раздел), избегай клише.
— Цифры всегда с единицами: °C, м/с, мм/ч, км/ч. Направления ветра — по компасу из данных.
— Если значение неизвестно (null) — не выдумывай, используй нейтральные формулировки: данных недостаточно, существенных осадков не ожидается и т.п.
— Не используй Markdown, не ставь маркеры списков. Подзаголовки — ровно как ниже.
— Заголовок статьи — одна строка (без слова «Заголовок»), затем пустая строка и раздел «Вступление».
— В «Детальном прогнозе» обязательно упоминай для каждого дня: ощущаемую погоду, окна без осадков (если есть), направление ветра словамИ, заметные порывы (≥10 м/с).
— Не придумывай географию фронтов и центров, если в данных нет явных подсказок: описывай их на уровне популярной метеорологии и логики региона Балтики.
— Время суток и настроение текста подстрой под выпуск: ${timeOfDayRu}.
`;

  const LENGTH_RULES = `
ЦЕЛИ ПО ОБЪЁМУ (слова, допускается ±10%):
Вступление: 120–180
Экстремальные события в мире сегодня: 130–200
Обзор погоды с высоты птичьего полёта: 150–230
Детальный прогноз по дням: 280–520
Почему так, а не иначе: 100–160
Погода и история: 120–180
Погода и животные: 110–160
Моря и океаны: 110–160
Совет от метеоролога: 80–120
Мини-рубрика "Сегодня в истории": 12–120 (используй текст из NOTE)
Мини-рубрика "Примета дня": 40–100
Завершение: 60–110
`;

  function buildPrompt(extraFix = "") {
    return `
Твоя роль: опытный и харизматичный метеоролог, ведущий блог о погоде в Риге. Стиль — дружелюбный, образный, но технически точный.

Задача: подготовить ${timeOfDayRu} выпуск с местной и глобальной картиной погоды.

СТРОГИЕ ПРАВИЛА:
1) Используй только предоставленные данные. Не придумывай и не изменяй цифры, даты или факты.
2) Никакого Markdown — только чистый текст.
3) Только реальные даты из блока данных. Заголовок — одна строка, далее разделы.
4) Подзаголовки — ровно так: 
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

${STYLE_RULES}
${LENGTH_RULES}

Инструкция для раздела «Экстремальные события в мире сегодня»:
${hurricaneGuidance}
${earthquakeGuidance}

Подсказки для «Совета от метеоролога»:
${advisoryHints.join(" ") || "Особых погодных рисков не ожидается, сделай акцент на комфорте и планировании активностей."}

ДАННЫЕ (не выводить в ответ, использовать только для анализа):
<DATA_JSON>
${JSON.stringify(dataPayload)}
</DATA_JSON>

<NOTE>
Сегодня в истории: ${historicalRecord}
</NOTE>

${extraFix}
`;
  }

  // Первая попытка
  const response1 = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: buildPrompt(),
    config: { temperature: 0.85, topP: 0.9, topK: 40, maxOutputTokens: 4500 }
  });
  let article = sanitizeArticle(response1.text || "");

  // Валидация
  const check1 = validateArticle(article);
  if (check1.ok) return { text: article, sourcesUsed: global.sourcesUsed };

  console.warn("⚠️ Обнаружены проблемы с разметкой/объёмом:", check1.issues);

  // Одна попытка исправления: просим переписать целиком, указав какие разделы не дотянули
  const fixNote = `
<REWRITE_REQUEST>
В предыдущем варианте найдены проблемы:
${check1.issues.map(i => `— ${i}`).join("\n")}
Пожалуйста, перепиши выпуск целиком, строго соблюдая заголовки и целевые объёмы по словам для каждого раздела.
</REWRITE_REQUEST>
  `.trim();

  const response2 = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: buildPrompt(fixNote),
    config: { temperature: 0.8, topP: 0.9, topK: 40, maxOutputTokens: 6000 }
  });
  article = sanitizeArticle(response2.text || "");
  const check2 = validateArticle(article);
  if (!check2.ok) console.warn("⚠️ После исправления всё ещё есть замечания:", check2.issues);

  return { text: article, sourcesUsed: global.sourcesUsed };
}

// 10) Сохранение
function saveArticle(articleText, timeOfDay, sourcesUsed) {
  const now = new Date();
  const fileDate = now.toISOString().slice(0, 10);
  const displayDate = now.toLocaleDateString("ru-RU", {
    day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Riga"
  });

  const lines = articleText.split("\n");
  const titleIndex = lines.findIndex(l => l.trim().length > 0);
  const title   = titleIndex > -1 ? lines[titleIndex].trim() : "Прогноз погоды в Риге";
  const content = titleIndex > -1 ? lines.slice(titleIndex + 1).join("\n").trim() : articleText;

  const articleJson = {
    title,
    date: displayDate,
    time: timeOfDay,
    content,
    sources: [
      { kind: "forecast", url: "https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=56.95&lon=24.1" },
      { kind: "climate_archive", url: "https://archive-api.open-meteo.com/v1/archive" },
      ...sourcesUsed.map(s => ({ ...s, fetchedAt: now.toISOString() }))
    ]
  };

  const archiveFileName = `article-${fileDate}-${timeOfDay}.json`;
  fs.writeFileSync(archiveFileName, JSON.stringify(articleJson, null, 2), "utf-8");
  fs.writeFileSync("latest-article.json", JSON.stringify(articleJson, null, 2), "utf-8");
  console.log(`✅ Статья (${timeOfDay}) сохранена в ${archiveFileName} и latest-article.json`);
}

// 11) Запуск
(async () => {
  console.log(`🚀 Генерация статьи (${timeOfDay})...`);
  try {
    const weather = await getWeatherData();
    console.log("📊 MET.NO получен и агрегирован.");

    const { text: article, sourcesUsed } = await generateArticle(weather, timeOfDayRu);
    console.log("✍️ Статья готова.");

    console.log("\n=== Сгенерированная статья ===\n");
    console.log(article);
    console.log("\n============================\n");

    saveArticle(article, timeOfDay, sourcesUsed);
  } catch (error) {
    console.error("❌ Критическая ошибка:", error.message);
    process.exit(1);
  }
})();
