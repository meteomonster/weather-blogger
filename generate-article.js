
/**
 * generate-article.js
 * v6.1 (Critical Fix)
 * - ИСПРАВЛЕНО: Главный скрипт теперь корректно передает объект CONFIG
 * в модуль local-forecast, устраняя ошибку 'Cannot read properties of undefined (reading 'TIMEZONE')'.
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
        gardenerSection,
        bioSection,
        photoSection,
    ] = await Promise.all([
        // --- ИСПРАВЛЕНИЕ ЗДЕСЬ ---
        logPromise(generateLocalForecastSection(weatherData, geminiConfig, CONFIG), "Абзац о прогнозе"),
        logPromise(generateGlobalEventsSection(globalEvents, geminiConfig), "Абзац о событиях"),
        logPromise(generateHistoricalContextSection(historicalData, funFact, geminiConfig), "Абзац об истории"),
        logPromise(generateAirQualitySection(airQualityData, geminiConfig), "Абзац о качестве воздуха"),
        logPromise(generateMarineSection(marineData, geminiConfig), "Абзац о море"),
        logPromise(generateAuroraSection(spaceWeatherData, geminiConfig), "Абзац о северном сиянии"),
        logPromise(generateGardenerCornerSection(gardeningData), "Уголок садовода"),
        logPromise(generateBioForecastSection(bioWeatherData, airQualityData), "Биопрогноз"),
        logPromise(generatePhotographyGuideSection(photoGuideData), "Гид фотографа"),
    ]);

    console.log("    ✅ Все разделы сгенерированы");

    console.log("📝 [3/4] Сборка финальной статьи...");
    const finalPrompt = `
Твоя роль: Главный редактор, который собирает из готовых блоков цельную и увлекательную статью для ${timeOfDayRu} выпуска погодного блога Риги.
Твоя задача: Написать яркий заголовок, тёплое вступление и логичное заключение. Между готовыми блоками сделай плавные, дружелюбные переходы. НЕ переписывай текст ассистентов, а именно компонуй его в единый рассказ.
Тон: дружелюбный, заботливый, разговорный — словно делишься новостями с хорошим знакомым.

Структура статьи:
1. Заголовок.
2. Вступление (2-3 предложения).
3. Затем блоки в следующем порядке: 🌤️ Прогноз на неделю → 🌍 События в мире → 📜 Истории и факты → 🌬️ Качество воздуха → 🌊 Морской прогноз → 🌿 Уголок садовода → 💚 Биопрогноз → 📸 Гид фотографа → 🌌 Космический дозор.
   Перед каждым заголовком добавь короткую дружескую подводку (1 предложение), но не изменяй текст и подзаголовок блока. Если заголовок уже присутствует, не дублируй его.
4. Заверши основную часть коротким выводом (1-2 предложения) в том же тоне.
5. Добавь финальный раздел «🔖 Послесловие» (2-3 предложения): пригласи читателя вернуться завтра и обыграй этот факт дня: ${closingFact}

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

<УГОЛОК_САДОВОДА>
${gardenerSection}
</УГОЛОК_САДОВОДА>

<БИОПРОГНОЗ>
${bioSection}
</БИОПРОГНОЗ>

<ФОТОГИД>
${photoSection}
</ФОТОГИД>

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

function getUniqueRandomFacts(count = 1) {
  const logFile = CONFIG.OUTPUT.USED_FACTS_LOG;
  let usedIndices = [];
  try {
    if (fs.existsSync(logFile)) {
      const parsed = JSON.parse(fs.readFileSync(logFile, "utf-8"));
      if (Array.isArray(parsed)) {
        usedIndices = parsed;
      }
    }
  } catch {
    usedIndices = [];
  }

  const allIndices = weatherFacts.map((_, index) => index);
  const chosen = [];

  for (let i = 0; i < count; i += 1) {
    let available = allIndices.filter(
      (index) => !usedIndices.includes(index) && !chosen.includes(index)
    );

    if (available.length === 0) {
      usedIndices = [];
      available = allIndices.filter((index) => !chosen.includes(index));
    }

    if (available.length === 0) {
      break;
    }

    const randomIndex = available[Math.floor(Math.random() * available.length)];
    chosen.push(randomIndex);
  }

  const updatedLog = Array.from(new Set([...usedIndices, ...chosen]));
  fs.writeFileSync(logFile, JSON.stringify(updatedLog, null, 2), "utf-8");

  return chosen.map((index) => weatherFacts[index]);
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

