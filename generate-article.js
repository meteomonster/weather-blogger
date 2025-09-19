/**
 * generate-article.js
 * v6.0 (Modular Expansion)
 * - Интегрированы три новых раздела: качество воздуха, морской прогноз и
 * прогноз северного сияния.
 * - Добавлены новые API-модули и модули-эксперты.
 * - Главный скрипт обновлен для параллельного вызова всех 7 модулей.
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

// Импорт генераторов разделов
import { generateLocalForecastSection } from "./modules/local-forecast.js";
import { generateGlobalEventsSection } from "./modules/global-events.js";
import { generateHistoricalContextSection } from "./modules/historical-context.js";
import { generateAirQualitySection } from "./modules/air-quality.js";
import { generateMarineSection } from "./modules/marine-forecast.js";
import { generateAuroraSection } from "./modules/aurora-forecast.js";


// Импорт базы фактов
import { weatherFacts } from "./data/weather-facts.js";

/* ========================================================================== */
/* 0. КОНФИГУРАЦИЯ                                                           */
/* ========================================================================== */

const CONFIG = {
  LOCATION: { LAT: 56.95, LON: 24.1, TIMEZONE: "Europe/Riga" },
  API: { USER_AGENT: "WeatherBloggerApp/3.0 (+https://github.com/meteomonster/weather-blogger)" },
  GEMINI: {
    MODEL: "gemini-1.5-flash-latest",
    GENERATION_CONFIG: { temperature: 0.8, topP: 0.9, topK: 40, maxOutputTokens: 4000 },
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
    const rigaDate = getTodayForTimezone(CONFIG.LOCATION.TIMEZONE);

    console.log("📊 [1/4] Сбор данных (параллельно)...");
    const [
        weatherData,
        globalEvents,
        historicalData,
        airQualityData,
        marineData,
        spaceWeatherData
    ] = await Promise.all([
        logPromise(getWeatherData({ ...CONFIG.LOCATION, ...CONFIG.API }), "Прогноз погоды"),
        logPromise(getGlobalEventsData(), "Мировые события"),
        logPromise(getHistoricalRecord(rigaDate, { ...CONFIG.LOCATION, ...CONFIG.API }), "Исторические рекорды"),
        logPromise(getAirQualityData({ ...CONFIG.LOCATION, ...CONFIG.API }), "Качество воздуха"),
        logPromise(getMarineData({ ...CONFIG.LOCATION, ...CONFIG.API }), "Морской прогноз"),
        logPromise(getSpaceWeatherData(), "Космопогода"),
    ]);
    const funFact = getUniqueRandomFact();
    console.log("    ✅ Все данные собраны");

    console.log("✍️  [2/4] Генерация разделов статьи (параллельно)...");
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
    ] = await Promise.all([
        logPromise(generateLocalForecastSection(weatherData, geminiConfig), "Абзац о прогнозе"),
        logPromise(generateGlobalEventsSection(globalEvents, geminiConfig), "Абзац о событиях"),
        logPromise(generateHistoricalContextSection(historicalData, funFact, geminiConfig), "Абзац об истории"),
        logPromise(generateAirQualitySection(airQualityData, geminiConfig), "Абзац о качестве воздуха"),
        logPromise(generateMarineSection(marineData, geminiConfig), "Абзац о море"),
        logPromise(generateAuroraSection(spaceWeatherData, geminiConfig), "Абзац о северном сиянии"),
    ]);
    console.log("    ✅ Все разделы сгенерированы");

    console.log("📝 [3/4] Сборка финальной статьи...");
    const finalPrompt = `
Твоя роль: Главный редактор, который собирает из готовых блоков цельную и увлекательную статью для ${timeOfDayRu} выпуска погодного блога Риги.
Твоя задача: Написать яркий заголовок, сильное вступление и логичное заключение. Между готовыми блоками сделай плавные, логичные переходы. НЕ переписывай текст ассистентов, а именно компонуй его в единый рассказ.

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

<КАЧЕСТВО_ВОЗДУХА>
${airQualitySection}
</КАЧЕСТВО_ВОЗДУХА>

<МОРСКОЙ_ВЕСТНИК>
${marineSection}
</МОРСКОЙ_ВЕСТНИК>

<КОСМИЧЕСКИЙ_ДОЗОР>
${auroraSection}
</КОСМИЧЕСКИЙ_ДОЗОР>
`;
    
    const model = geminiConfig.genAI.getGenerativeModel({ model: geminiConfig.modelName, generationConfig: geminiConfig.generationConfig });
    const result = await model.generateContent(finalPrompt);
    const articleText = result.response.text().trim();
    
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
    const partValue = (type) => parts.find(p => p.type === type)?.value || '';
    const dateString = `${partValue('year')}-${partValue('month')}-${partValue('day')}`;
    return new Date(`${dateString}T12:00:00Z`);
}

function logPromise(promise, name) {
    console.log(`    -> Запускаю: ${name}...`);
    return promise.then(result => {
        console.log(`    ✅ Готово: ${name}`);
        return result;
    });
}

function getUniqueRandomFact() {
  let usedIndices = [];
  const logFile = CONFIG.OUTPUT.USED_FACTS_LOG;
  try {
    if (fs.existsSync(logFile)) {
      usedIndices = JSON.parse(fs.readFileSync(logFile, "utf-8"));
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
  fs.writeFileSync(logFile, JSON.stringify(usedIndices, null, 2), "utf-8");
  
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

