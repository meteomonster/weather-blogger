import axios from "axios";
import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "fs";

// 1. БЕЗОПАСНОСТЬ: Берём API-ключ из секретов GitHub.
const API_KEY = process.env.GEMINI_API_KEY;

if (!API_KEY) {
  console.error("Ошибка: Секрет GEMINI_API_KEY не найден. Добавьте его в GitHub Secrets.");
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(API_KEY);
const timeOfDay = process.argv[2] || "morning";

// --- НОВОЕ: ФУНКЦИЯ ДЛЯ ПОЛУЧЕНИЯ ИСТОРИЧЕСКИХ ДАННЫХ ---
async function getHistoricalRecord(date) {
    try {
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const url = `https://archive-api.open-meteo.com/v1/archive?latitude=56.95&longitude=24.1&start_date=1940-${month}-${day}&end_date=${date.getFullYear() - 1}-${month}-${day}&daily=temperature_2m_max,temperature_2m_min`;
        
        const response = await axios.get(url);
        const data = response.data.daily;
        
        if (!data || !data.time || data.time.length === 0) {
            return "Исторические данные для этой даты не найдены.";
        }

        const records = data.time.map((t, i) => ({
            year: new Date(t).getFullYear(),
            max: data.temperature_2m_max[i],
            min: data.temperature_2m_min[i],
        })).filter(r => r.max !== null && r.min !== null);

        if (records.length === 0) {
            return "Недостаточно исторических данных для анализа.";
        }

        const recordMax = records.reduce((prev, current) => (prev.max > current.max) ? prev : current);
        const recordMin = records.reduce((prev, current) => (prev.min < current.min) ? prev : current);

        return `Самый теплый день (${recordMax.year} год): ${recordMax.max}°C. Самый холодный (${recordMin.year} год): ${recordMin.min}°C.`;
    } catch (error) {
        console.warn("Не удалось получить исторические данные:", error.message);
        return "Не удалось загрузить исторические данные.";
    }
}


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
  // --- НОВОЕ: ПОДГОТОВКА ДАТ И ИСТОРИЧЕСКИХ ДАННЫХ ---
  const today = new Date();
  const dateOptions = { day: 'numeric', month: 'long', timeZone: 'Europe/Riga' };
  const dates = weatherData.time.map((_, i) => {
      const date = new Date(today);
      date.setDate(today.getDate() + i);
      let prefix = "";
      if (i === 0) prefix = "Сегодня, ";
      if (i === 1) prefix = "Завтра, ";
      if (i > 1) {
          const weekdayOptions = { weekday: 'long', timeZone: 'Europe/Riga' };
          prefix = `В ${new Intl.DateTimeFormat('ru-RU', weekdayOptions).format(date)}, `;
      }
      return prefix + new Intl.DateTimeFormat('ru-RU', dateOptions).format(date);
  });
  
  const historicalRecord = await getHistoricalRecord(today);

  // --- НОВОЕ: ВАШ УЛУЧШЕННЫЙ ПРОМПТ ---
  const prompt = `
Твоя роль: Опытный и харизматичный метеоролог, который ведёт популярный блог о погоде в Риге. Твой стиль — лёгкий, образный и немного литературный, но при этом технически безупречный. Ты объясняешь сложные вещи простым языком, используя яркие метафоры.

Твоя задача: Написать эксклюзивный синоптический обзор для читателей блога. Сейчас нужно подготовить ${timeOfDay} выпуск.

СТРОГИЕ ПРАВИЛА ФОРМАТИРОВАНИЯ (ОБЯЗАТЕЛЬНО К ВЫПОЛНЕНИЮ):
1. НИКАКОГО MARKDOWN: Не используй символы ##, **, * или любые другие. Только чистый текст.
2. ТОЛЬКО РЕАЛЬНЫЕ ДАТЫ: Вместо "1-й день", "2-й день" используй настоящие даты.
3. БЕЗ ДВОЕТОЧИЙ В ЗАГОЛОВКАХ: В подзаголовках типа "Детальный прогноз" не ставь двоеточие в конце.

СТРУКТУРА СТАТЬИ:

Заголовок: Придумай яркий и интригующий заголовок, отражающий суть погоды.

Вступление: Дружелюбное приветствие, соответствующее времени суток (${timeOfDay}). Создание настроения.

Синоптическая картина "с высоты птичьего полёта": Описание процессов на метеокарте. Укажи, какой барический центр определяет погоду, его происхождение и движение. Расскажи о прохождении атмосферных фронтов и их влиянии на Ригу. Учитывай также влажность, облачность, движение воздушных масс и влияние Балтийского моря.

Детальный прогноз по дням:
${dates[0]} — подробно утро, день, вечер, ночь: температура, осадки, ветер.
${dates[1]} — прогноз на следующий день.
Прогноз на 2–3 дня вперёд — кратко, с датами ${dates[2]} и ${dates[3]}.

Почему так, а не иначе: Объяснение физики процессов простым языком с метафорами.

Совет от метеоролога: Один-два практических совета на основе прогноза.

Мини-рубрика “А вы знали, что…”: Любопытный факт из мира метеорологии.

Мини-рубрика “Сегодня в истории”: ${historicalRecord}.

Мини-рубрика “Примета дня”: Народная примета о погоде с научным пояснением.

Завершение: Позитивное или философское завершение с пожеланием читателям.

НЕОБРАБОТАННЫЕ ДАННЫЕ ДЛЯ ТВОЕГО АНАЛИЗА:
- Диапазон температур (мин/макс) на 7 дней: ${weatherData.temperature_2m_min.map((t, i) => `${dates[i]}: ${t}°C...${weatherData.temperature_2m_max[i]}°C`).join("; ")}
- Максимальная вероятность осадков на 7 дней: ${weatherData.precipitation_probability_max.map((p, i) => `${dates[i]}: ${p}%`).join("; ")}
- Максимальная скорость ветра на 7 дней: ${weatherData.windspeed_10m_max.map((w, i) => `${dates[i]}: ${w} м/с`).join("; ")}
`;

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
  const fileDate = now.toISOString().split("T")[0];
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

  const archiveFileName = `article-${fileDate}-${timeOfDay}.json`;
  fs.writeFileSync(archiveFileName, JSON.stringify(articleJson, null, 2), "utf-8");

  fs.writeFileSync(
    "latest-article.json",
    JSON.stringify(articleJson, null, 2),
    "utf-8"
  );

  console.log(`✅ Статья (${timeOfDay}) успешно сохранена в ${archiveFileName} и latest-article.json`);
}

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
    console.error("❌ Произошла критическая ошибка:", error.message);
    process.exit(1);
  }
})();
