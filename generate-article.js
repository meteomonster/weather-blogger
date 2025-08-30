import axios from "axios";
import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "fs";

// 1. БЕЗОПАСНОСТЬ: Берём API-ключ из секретов GitHub, а не храним его в коде.
// GitHub Actions автоматически подставит сюда ключ, который мы добавили в Secrets.
const API_KEY = process.env.GEMINI_API_KEY;

// Проверка, что ключ доступен. Если нет — скрипт остановится с ошибкой.
if (!API_KEY) {
  console.error("Ошибка: Секрет GEMINI_API_KEY не найден. Добавьте его в GitHub Secrets.");
  process.exit(1); // Завершить с кодом ошибки
}

const genAI = new GoogleGenerativeAI(API_KEY);

// 🕑 Аргумент командной строки (morning или evening), который передаёт GitHub Actions
const timeOfDay = process.argv[2] || "morning";

async function getWeatherData() {
  const url = "https://api.open-meteo.com/v1/forecast";
  const params = {
    latitude: 56.95,
    longitude: 24.1,
    daily: "temperature_2m_max,temperature_2m_min,precipitation_probability_max,windspeed_10m_max",
    timezone: "Europe/Riga",
    forecast_days: 7,
  };

  try {
    const response = await axios.get(url, { params });
    return response.data.daily;
  } catch (error) {
    console.error("Не удалось получить данные о погоде:", error.message);
    throw new Error("Ошибка получения данных о погоде.");
  }
}

async function generateArticle(weatherData, timeOfDay) {
  // 2. УЛУЧШЕНИЕ: Немного уточнили промпт для лучшего результата.
  const prompt = `
Твоя роль: Опытный метеоролог-журналист, который пишет увлекательные прогнозы для блога о погоде в Риге.
Твоя задача: Написать прогноз в зависимости от времени суток. Сейчас нужно подготовить ${timeOfDay === "morning" ? "УТРЕННИЙ" : "ВЕЧЕРНИЙ"} выпуск.

СТРУКТУРА СТАТЬИ:
1.  Заголовок: Яркий и тематический (например, "Балтийский бриз и Скандинавский гость: чего ждать от погоды?").
2.  Вступление: Дружелюбное приветствие, соответствующее ${timeOfDay === "morning" ? "утру" : "вечеру"}.
3.  Общая картина: Кратко опиши синоптическую ситуацию (какой циклон или антициклон влияет на регион, где проходят фронты).
4.  Детальный прогноз:
    * Если это УТРО: Сделай детальный прогноз на предстоящий день и краткий обзор на 2-3 последующих дня.
    * Если это ВЕЧЕР: Сделай детальный прогноз на ночь и следующий день, а также краткий обзор на 2-3 последующих дня.
5.  Метеорологическое объяснение: Очень просто объясни, почему погода будет именно такой (например, "южный ветер принесёт тёплый воздух").
6.  Практические советы: Дай небольшой совет (например, "захватите зонт" или "идеальное время для прогулок").
7.  Завершение: Пожелай читателям хорошего дня или спокойной ночи.

НЕОБРАБОТАННЫЕ ДАННЫЕ ДЛЯ АНАЛИЗА:
- Диапазон температур (мин/макс) на 7 дней: ${weatherData.temperature_2m_min.map((t, i) => `${t}°C...${weatherData.temperature_2m_max[i]}°C`).join(", ")}
- Максимальная вероятность осадков на 7 дней: ${weatherData.precipitation_probability_max.join("%, ")}%
- Максимальная скорость ветра на 7 дней: ${weatherData.windspeed_10m_max.join(" м/с, ")} м/с
`;

  // 3. УЛУЧШЕНИЕ: Используем актуальную и быструю модель.
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });
  
  try {
    const result = await model.generateContent(prompt);
    return result.response.text();
  } catch (error) {
     console.error("Ошибка при генерации статьи моделью Gemini:", error.message);
     throw new Error("Ошибка генерации текста.");
  }
}

function saveArticle(articleText, timeOfDay) {
  const now = new Date();

  // Даты для названий файлов и отображения
  const fileDate = now.toISOString().split("T")[0]; // YYYY-MM-DD
  const displayDate = now.toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Riga"
  });

  const articleJson = {
    title:
      articleText.split("\n")[0].replace(/[#*]/g, "").trim() ||
      "Прогноз погоды в Риге",
    date: displayDate,
    time: timeOfDay,
    content: articleText,
  };

  // Сохраняем архивный файл с уникальным именем
  const archiveFileName = `article-${fileDate}-${timeOfDay}.json`;
  fs.writeFileSync(archiveFileName, JSON.stringify(articleJson, null, 2), "utf-8");

  // Перезаписываем основной файл `latest-article.json` для сайта
  fs.writeFileSync(
    "latest-article.json",
    JSON.stringify(articleJson, null, 2),
    "utf-8"
  );

  console.log(`✅ Статья (${timeOfDay}) успешно сохранена в ${archiveFileName} и latest-article.json`);
}

// Главная функция для запуска
(async () => {
  console.log(`🚀 Запуск генерации статьи (${timeOfDay})...`);
  try {
    const weather = await getWeatherData();
    console.log("📊 Данные о погоде получены.");
    
    const article = await generateArticle(weather, timeOfDay);
    console.log("✍️ Статья сгенерирована моделью Gemini.");
    
    console.log("\n=== Сгенерированная статья ===\n");
    console.log(article);
    console.log("\n============================\n");
    
    saveArticle(article, timeOfDay);
  } catch (error) {
    console.error("❌ Произошла критическая ошибка в процессе генерации:", error.message);
    process.exit(1); // Завершить с кодом ошибки, чтобы GitHub Action показал сбой
  }
})();
