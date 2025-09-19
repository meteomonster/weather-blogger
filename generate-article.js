/**
 * generate-article.js
 * v5.2 (Fix & Enhanced Logging)
 * * ИСПРАВЛЕНО: Критическая опечатка `getGenerModel` -> `getGenerativeModel`.
 * * УЛУЧШЕНО: Добавлено детальное логирование для всех асинхронных
 * операций, чтобы точно отслеживать, какой этап выполняется.
 */
import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "fs";

// Импорт сборщиков данных
import { getWeatherData } from "./api/met-no-api.js";
import { getGlobalEventsData } from "./api/nasa-api.js";
import { getHistoricalRecord } from "./api/open-meteo-api.js";

// Импорт генераторов разделов
import { generateLocalForecastSection } from "./modules/local-forecast.js";
import { generateGlobalEventsSection } from "./modules/global-events.js";
import { generateHistoricalContextSection } from "./modules/historical-context.js";

// Импорт базы фактов из папки /data/
import { weatherFacts } from "./data/weather-facts.js";

/* ========================================================================== */
/* 0. КОНФИГУРАЦИЯ                                                           */
/* ========================================================================== */

const CONFIG = {
  LOCATION: { LAT: 56.95, LON: 24.1, TIMEZONE: "Europe/Riga" },
  API: { USER_AGENT: "WeatherBloggerApp/2.0 (+https://github.com/meteomonster/weather-blogger)" },
  GEMINI: {
    MODEL: "gemini-1.5-flash-latest",
    GENERATION_CONFIG: { temperature: 0.8, topP: 0.9, topK: 40, maxOutputTokens: 3000 },
  },
  OUTPUT: {
    ARCHIVE_PREFIX: "article",
    LATEST_FILENAME: "latest-article.json",
    USED_FACTS_LOG: "used-facts-log.json",
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
    // --- ЭТАП 1: Параллельный сбор всех данных ---
    console.log("📊 [1/4] Сбор данных (параллельно)...");
    const [weatherData, globalEvents, historicalData] = await Promise.all([
        logPromise(getWeatherData({ ...CONFIG.LOCATION, ...CONFIG.API }), "Прогноз погоды (MET.NO)"),
        logPromise(getGlobalEventsData(), "Мировые события (NASA)"),
        logPromise(getHistoricalRecord(new Date(), { ...CONFIG.LOCATION, ...CONFIG.API }), "Исторические рекорды (Open-Meteo)")
    ]);
    const funFact = getUniqueRandomFact();
    console.log("    ✅ Все данные собраны");

    // --- ЭТАП 2: Параллельная генерация разделов ---
    console.log("✍️  [2/4] Генерация разделов статьи (параллельно)...");
    const geminiConfig = {
        genAI: new GoogleGenerativeAI(process.env.GEMINI_API_KEY),
        modelName: CONFIG.GEMINI.MODEL,
        generationConfig: CONFIG.GEMINI.GENERATION_CONFIG,
        location: CONFIG.LOCATION,
    };
    
    const [localSection, globalSection, historySection] = await Promise.all([
        logPromise(generateLocalForecastSection(weatherData, geminiConfig), "Абзац о прогнозе"),
        logPromise(generateGlobalEventsSection(globalEvents, geminiConfig), "Абзац о событиях"),
        logPromise(generateHistoricalContextSection(historicalData, funFact, geminiConfig), "Абзац об истории")
    ]);
    console.log("    ✅ Все разделы сгенерированы");

    // --- ЭТАП 3: Финальная сборка статьи ---
    console.log("📝 [3/4] Сборка финальной статьи...");
    const finalPrompt = `
Твоя роль: Главный редактор популярного блога о погоде в Риге. Твой стиль — живой, харизматичный, с легкой иронией.

Твоя задача: Собрать из готовых абзацев, написанных твоими ассистентами, единую, гладкую и увлекательную статью. Твоя работа — написать яркий заголовок, сильное вступление и логичное заключение, а также обеспечить плавные переходы между блоками. Не переписывай текст ассистентов, а именно компонуй его.

Вот готовые блоки от твоих экспертов:

<ЛОКАЛЬНЫЙ_ПРОГНОЗ_РИГА>
${localSection}
</ЛОКАЛЬНЫЙ_ПРОГНОЗ_РИГА>

<ГЛОБАЛЬНЫЕ_СОБЫТИЯ>
${globalSection}
</ГЛОБАЛЬНЫЕ_СОБЫТИЯ>

<ИСТОРИЯ_И_ФАКТЫ>
${historySection}
</ИСТОРИЯ_И_ФАКТЫ>

Теперь собери из этого цельную статью для ${timeOfDayRu} выпуска.
`;
    
    const model = geminiConfig.genAI.getGenerativeModel({ model: geminiConfig.modelName, generationConfig: geminiConfig.generationConfig });
    const result = await model.generateContent(finalPrompt);
    const articleText = result.response.text().trim();
    
    console.log("\n=== Финальная статья ===\n");
    console.log(articleText);
    console.log("\n========================\n");
    
    // --- ЭТАП 4: Сохранение ---
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

/**
 * Обертка для промисов, которая добавляет логирование начала и конца операции.
 * @param {Promise} promise Асинхронная операция.
 * @param {string} name Имя операции для лога.
 * @returns {Promise}
 */
function logPromise(promise, name) {
    console.log(`    -> Запускаю: ${name}...`);
    return promise.then(result => {
        console.log(`    ✅ Готово: ${name}`);
        return result;
    });
}

function getUniqueRandomFact() {
  let usedIndices = [];
  try {
    if (fs.existsSync(CONFIG.OUTPUT.USED_FACTS_LOG)) {
      usedIndices = JSON.parse(fs.readFileSync(CONFIG.OUTPUT.USED_FACTS_LOG, "utf-8"));
    }
  } catch { usedIndices = []; }
  
  const allIndices = Array.from(weatherFacts.keys());
  let availableIndices = allIndices.filter(index => !usedIndices.includes(index));
  
  if (availableIndices.length === 0) {
    availableIndices = allIndices;
    usedIndices = [];
  }
  
  const randomIndex = availableIndices[Math.floor(Math.random() * availableIndices.length)];
  usedIndices.push(randomIndex);
  fs.writeFileSync(CONFIG.OUTPUT.USED_FACTS_LOG, JSON.stringify(usedIndices, null, 2), "utf-8");
  
  return weatherFacts[randomIndex];
}

function saveArticle(articleText, timeOfDay, modelUsed) {
    const now = new Date();
    const fileDate = now.toISOString().slice(0, 10);
    const displayDate = now.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: CONFIG.LOCATION.TIMEZONE });
    
    const lines = articleText.split("\n");
    const title = lines[0]?.trim() || "Прогноз погоды в Риге";
    const content = lines.slice(1).join("\n").trim();
    
    const articleJson = { title, date: displayDate, time: timeOfDay, content, model: modelUsed };
    const archiveFileName = `${CONFIG.OUTPUT.ARCHIVE_PREFIX}-${fileDate}-${timeOfDay}.json`;
    
    fs.writeFileSync(archiveFileName, JSON.stringify(articleJson, null, 2), "utf-8");
    fs.writeFileSync(CONFIG.OUTPUT.LATEST_FILENAME, JSON.stringify(articleJson, null, 2), "utf-8");
    console.log(`    ✅ Статья сохранена в ${archiveFileName} и ${CONFIG.OUTPUT.LATEST_FILENAME}`);
}

