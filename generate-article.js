/**
 * generate-article.js
 * v6.2 (Plain Text & Sanitizer)
 * - Добавлено: строгая инструкция модели "без Markdown/звёздочек/лишних кавычек"
 * - Добавлено: sanitizeArticle() — постобработка текста (снятие **, *, `, маркеров списков, «умных» кавычек)
 * - Сохранён фикс CONFIG → local-forecast (из v6.1)
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "fs";

// Импорт сборщиков данных
import { getWeatherData } from "./api/met-no-api.js";
import { getGlobalEventsData } from "./api/nasa-api.js";
import { getHistoricalRecord } from "./api/open-meteo-api.js";
import { getAirQualityData } from "./api/air-quality-api.js";
import { getMarineData } from "./api/marine-api.js";
import { getSpaceWeatherData } from "./api/space-weather-api.js";
import { getGardeningData } from "./api/gardening-api.js";
import { getBioWeatherData } from "./api/bio-api.js";
import { getPhotographyData } from "./api/photography-api.js";

// Импорт генераторов разделов
import { generateLocalForecastSection } from "./modules/local-forecast.js";
import { generateGlobalEventsSection } from "./modules/global-events.js";
import { generateHistoricalContextSection } from "./modules/historical-context.js";
import { generateAirQualitySection } from "./modules/air-quality.js";
import { generateMarineSection } from "./modules/marine-forecast.js";
import { generateAuroraSection } from "./modules/aurora-forecast.js";
import { generateGardenerCornerSection } from "./modules/gardener-corner.js";
import { generateBioForecastSection } from "./modules/bio-forecast.js";
import { generatePhotographyGuideSection } from "./modules/photography-guide.js";

// База фактов
import { weatherFacts } from "./data/weather-facts.js";

/* ========================================================================== */
/* 0. КОНФИГУРАЦИЯ                                                            */
/* ========================================================================== */

const CONFIG = {
  LOCATION: { LAT: 56.95, LON: 24.1, TIMEZONE: "Europe/Riga" },
  API: { USER_AGENT: "WeatherBloggerApp/3.0 (+https://github.com/meteomonster/weather-blogger)" },
  GEMINI: {
    MODEL: process.env.GEMINI_MODEL_NAME || "gemini-1.5-flash",
    GENERATION_CONFIG: { temperature: 0.8, topP: 0.9, topK: 40, maxOutputTokens: 4000 },
  },
  OUTPUT: {
    ARCHIVE_PREFIX: "article",
    LATEST_FILENAME: "latest-article.json",
    USED_FACTS_LOG: "used-facts-log.json",
    SANITIZE: true,                     // <<< НОВОЕ: включить постобработку
    STRIP_SMART_QUOTES: true,           // <<< НОВОЕ: убирать «умные» кавычки
    STRIP_MARKDOWN_EMPHASIS: true,      // <<< НОВОЕ: убирать **жирный** и *курсив*
    STRIP_LIST_MARKERS: true            // <<< НОВОЕ: убирать -/•/> в начале строк
  },
};

/* ========================================================================== */
/* 1. ГЛАВНЫЙ ЗАПУСК                                                          */
/* ========================================================================== */

(async () => {
  const timeOfDay = (process.argv[2] || "morning").toLowerCase();
  const timeOfDayRu = { morning: "утренний", afternoon: "дневной", evening: "вечерний", night: "ночной" }[timeOfDay] || timeOfDay;

  console.log(`🚀 Запуск генерации (${timeOfDayRu})...`);

  try {
    const rigaDate = getTodayForTimezone(CONFIG.LOCATION.TIMEZONE);

    console.log("📊 [1/4] Сбор данных (параллельно)...");
    const [
      weatherData,
      globalEvents,
      historicalData,
      airQualityData,
      marineData,
      spaceWeatherData,
      gardeningData,
      bioWeatherData,
      photoGuideData,
    ] = await Promise.all([
      logPromise(getWeatherData({ ...CONFIG.LOCATION, ...CONFIG.API }), "Прогноз погоды"),
      logPromise(getGlobalEventsData(), "Мировые события"),
      logPromise(getHistoricalRecord(rigaDate, { ...CONFIG.LOCATION, ...CONFIG.API }), "Исторические рекорды"),
      logPromise(getAirQualityData({ ...CONFIG.LOCATION, ...CONFIG.API }), "Качество воздуха"),
      logPromise(getMarineData({ ...CONFIG.LOCATION, ...CONFIG.API }), "Морской прогноз"),
      logPromise(getSpaceWeatherData(), "Космопогода"),
      logPromise(getGardeningData({ ...CONFIG.LOCATION, ...CONFIG.API }), "Агропрогноз"),
      logPromise(getBioWeatherData({ ...CONFIG.LOCATION, ...CONFIG.API }), "Биометео показатели"),
      logPromise(getPhotographyData({ ...CONFIG.LOCATION, ...CONFIG.API }), "Фото-гид"),
    ]);

    const [funFactRaw, closingFactRaw] = getUniqueRandomFacts(2);
    const funFact = funFactRaw ?? "Погода полна сюрпризов — мы уже готовим новые факты.";
    const closingFact = closingFactRaw ?? funFact;
    console.log("    ✅ Все данные собраны");

    console.log("✍️  [2/4] Генерация разделов (параллельно)...");
    const geminiConfig = {
      genAI: new GoogleGenerativeAI(process.env.GEMINI_API_KEY),
      modelName: CONFIG.GEMINI.MODEL,
      generationConfig: CONFIG.GEMINI.GENERATION_CONFIG,
    };

    const [
      localSection,
      globalSection,
      historySection,
      airQualitySection,
      marineSection,
      auroraSection,
      gardenerSection,
      bioSection,
      photoSection,
    ] = await Promise.all([
      // ВАЖНО: передаём CONFIG (фикс v6.1)
      logPromise(generateLocalForecastSection(weatherData, geminiConfig, CONFIG), "Абзац о прогнозе"),
      logPromise(generateGlobalEventsSection(globalEvents, geminiConfig), "Абзац о событиях"),
      logPromise(generateHistoricalContextSection(historicalData, funFact, geminiConfig), "Абзац об истории"),
      logPromise(generateAirQualitySection(airQualityData, geminiConfig), "Абзац о качестве воздуха"),
      logPromise(
        generateMarineSection(marineData, geminiConfig, {
          date: rigaDate,
          timezone: CONFIG.LOCATION.TIMEZONE,
          weatherData,
        }),
        "Абзац о море"
      ),
      logPromise(generateAuroraSection(spaceWeatherData, geminiConfig), "Абзац о северном сиянии"),
      logPromise(generateGardenerCornerSection(gardeningData), "Уголок садовода"),
      logPromise(generateBioForecastSection(bioWeatherData, airQualityData), "Биопрогноз"),
      logPromise(generatePhotographyGuideSection(photoGuideData), "Гид фотографа"),
    ]);
    console.log("    ✅ Разделы получены");

    const sectionDefinitions = [
      { key: "local", label: "Прогноз на неделю", tag: "ЛОКАЛЬНЫЙ_ПРОГНОЗ_РИГА", text: localSection },
      { key: "global", label: "События в мире", tag: "ГЛОБАЛЬНЫЕ_СОБЫТИЯ", text: globalSection },
      { key: "history", label: "Истории и факты", tag: "ИСТОРИЯ_И_ФАКТЫ", text: historySection },
      { key: "air", label: "Качество воздуха", tag: "КАЧЕСТВО_ВОЗДУХА", text: airQualitySection },
      { key: "marine", label: "Морской вестник", tag: "МОРСКОЙ_ВЕСТНИК", text: marineSection },
      { key: "garden", label: "Уголок садовода", tag: "УГОЛОК_САДОВОДА", text: gardenerSection },
      { key: "bio", label: "Биопрогноз", tag: "БИОПРОГНОЗ", text: bioSection },
      { key: "photo", label: "Гид фотографа", tag: "ФОТОГИД", text: photoSection },
      { key: "aurora", label: "Космический дозор", tag: "КОСМИЧЕСКИЙ_ДОЗОР", text: auroraSection },
    ];

    sectionDefinitions
      .filter((section) => !section.text || !String(section.text).trim())
      .forEach((section) =>
        console.log(`    ℹ️ Раздел "${section.label}" пропущен — нет актуальных данных.`)
      );

    const availableSections = sectionDefinitions.filter(
      (section) => typeof section.text === "string" && section.text.trim().length > 0
    );

    if (!availableSections.length) {
      throw new Error("Нет блоков для сборки статьи — проверьте источники данных.");
    }

    console.log(
      `    📚 В выпуск войдут блоки: ${availableSections.map((section) => section.label).join(", ")}`
    );

    const blockInstruction = availableSections
      .map(
        (section, idx) =>
          `${idx + 1}. ${section.label} — используй текст между тегами <${section.tag}>…</${section.tag}>.`
      )
      .join("\n");

    const blocksPayload = availableSections
      .map((section) => `<${section.tag}>\n${section.text}\n</${section.tag}>`)
      .join("\n\n");

    const blockNames = availableSections.map((section) => section.label).join(" → ");

    console.log("📝 [3/4] Сборка финальной статьи...");
    const finalPrompt = `
Твоя роль: Главный редактор, который собирает из готовых блоков цельную и увлекательную статью для ${timeOfDayRu} выпуска погодного блога Риги.

Жёсткие требования к форматированию:
- ПИШИ ТОЛЬКО ПРОСТОЙ ТЕКСТ БЕЗ MARKDOWN.
- Никаких **звёздочек**, _подчёркиваний_, #заголовков, >цитат, списков с «-»/«•».
- Не используй типографские кавычки «…»/„…“/“…” — если нужна прямая речь, используй обычные "двойные" только внутри фразы, но в этой статье прямой речи нет.
- Не ставь слова в кавычки «для красоты».

Твоя задача: Написать яркий заголовок, тёплое вступление и логичное заключение. Между готовыми блоками сделай плавные, дружелюбные переходы. НЕ переписывай текст ассистентов, а компонуй его в единый рассказ.

Структура статьи:
1) Заголовок (одна строка).
2) Вступление (2–3 предложения).
3) Дальше используй подготовленные блоки (по порядку): ${blockNames}.
   Для ориентира воспользуйся чек-листом:
${blockInstruction}
   Перед каждым блоком — короткая подводка (1 предложение). Сам текст блока оставь как есть (без переформулировок).
4) Короткий вывод (1–2 предложения).
5) Финальный раздел «Послесловие» (2–3 предложения), используй факт: ${closingFact}

Готовые блоки:
${blocksPayload}`.trim();

    const model = geminiConfig.genAI.getGenerativeModel({
      model: geminiConfig.modelName,
      generationConfig: geminiConfig.generationConfig,
    });

    const result = await model.generateContent(finalPrompt);
    let articleText = result.response.text().trim();

    if (CONFIG.OUTPUT.SANITIZE) {
      const before = articleText.length;
      articleText = sanitizeArticle(articleText, {
        stripMarkdown: CONFIG.OUTPUT.STRIP_MARKDOWN_EMPHASIS,
        stripSmartQuotes: CONFIG.OUTPUT.STRIP_SMART_QUOTES,
        stripListMarkers: CONFIG.OUTPUT.STRIP_LIST_MARKERS,
      });
      const after = articleText.length;
      console.log(`🧹 Санитайзер: очищено ${(before-after)>=0?(before-after):0} символов, итоговая длина ${after}`);
    }

    console.log("\n=== Финальная статья ===\n");
    console.log(articleText);
    console.log("\n========================\n");

    console.log("💾 [4/4] Сохранение результата...");
    saveArticle(articleText, timeOfDay, CONFIG.GEMINI.MODEL);
    console.log("\n🎉 Готово!");

  } catch (error) {
    console.error("\n❌ КРИТИЧЕСКАЯ ОШИБКА:", error.message, error.stack);
    process.exit(1);
  }
})();

/* ========================================================================== */
/* 2. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ                                                 */
/* ========================================================================== */

function getTodayForTimezone(timeZone) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const val = (t) => parts.find(p => p.type === t)?.value || '';
  const dateString = `${val('year')}-${val('month')}-${val('day')}`;
  return new Date(`${dateString}T12:00:00Z`);
}

function logPromise(promise, name) {
  console.log(`    -> Запускаю: ${name}...`);
  return promise.then(result => { console.log(`    ✅ Готово: ${name}`); return result; });
}

function getUniqueRandomFacts(count = 1) {
  const logFile = CONFIG.OUTPUT.USED_FACTS_LOG;
  let usedIndices = [];
  try {
    if (fs.existsSync(logFile)) {
      const parsed = JSON.parse(fs.readFileSync(logFile, "utf-8"));
      if (Array.isArray(parsed)) usedIndices = parsed;
    }
  } catch { usedIndices = []; }

  const allIndices = weatherFacts.map((_, i) => i);
  const chosen = [];

  for (let i = 0; i < count; i++) {
    let available = allIndices.filter(idx => !usedIndices.includes(idx) && !chosen.includes(idx));
    if (available.length === 0) { usedIndices = []; available = allIndices.filter(idx => !chosen.includes(idx)); }
    if (available.length === 0) break;
    const rnd = available[Math.floor(Math.random() * available.length)];
    chosen.push(rnd);
  }

  const updatedLog = Array.from(new Set([...usedIndices, ...chosen]));
  fs.writeFileSync(logFile, JSON.stringify(updatedLog, null, 2), "utf-8");
  return chosen.map(i => weatherFacts[i]);
}

function sanitizeArticle(text, { stripMarkdown=true, stripSmartQuotes=true, stripListMarkers=true } = {}) {
  let s = text;

  if (stripMarkdown) {
    // **bold**, *italic*, __bold__, _italic_, `code`
    s = s.replace(/\*\*(.*?)\*\*/g, '$1')
         .replace(/__(.*?)__/g, '$1')
         .replace(/\*(.*?)\*/g, '$1')
         .replace(/_(.*?)_/g, '$1')
         .replace(/`([^`]*)`/g, '$1');
  }

  if (stripListMarkers) {
    // Убираем маркеры списков в начале строк: -, •, >
    s = s.replace(/(^|\n)\s*[-•>]\s+/g, '$1');
  }

  if (stripSmartQuotes) {
    // Убираем «умные» кавычки (оставляем обычные, если вдруг встречаются)
    s = s.replace(/[«»„“”]/g, '');
  }

  // Убираем двойные пустые строки больше двух подряд
  s = s.replace(/\n{3,}/g, '\n\n');

  // Нормализуем пробелы вокруг пунктуации
  s = s.replace(/\s+([.,!?;:])/g, '$1');

  return s.trim();
}

function saveArticle(articleText, timeOfDay, modelUsed) {
  const now = new Date();
  const fileDate = now.toISOString().slice(0, 10);
  const displayDate = now.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: CONFIG.LOCATION.TIMEZONE });

  const lines = articleText.split("\n");
  const title = (lines[0] || "Прогноз погоды в Риге").trim();
  const content = lines.slice(1).join("\n").trim();

  const articleJson = { title, date: displayDate, time: timeOfDay, content, model: modelUsed };
  const archiveFileName = `${CONFIG.OUTPUT.ARCHIVE_PREFIX}-${fileDate}-${timeOfDay}.json`;

  fs.writeFileSync(archiveFileName, JSON.stringify(articleJson, null, 2), "utf-8");
  fs.writeFileSync(CONFIG.OUTPUT.LATEST_FILENAME, JSON.stringify(articleJson, null, 2), "utf-8");
  console.log(`    ✅ Статья сохранена в ${archiveFileName} и ${CONFIG.OUTPUT.LATEST_FILENAME}`);
}
