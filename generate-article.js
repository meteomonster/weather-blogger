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

// --- ИСПОЛЬЗУЕМ API MET.NO (YR.NO) ДЛЯ ВСЕХ ДАННЫХ ---
async function getWeatherData() {
  const lat = 56.95;
  const lon = 24.1;
  const url = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat}&lon=${lon}`;

  try {
    const response = await axios.get(url, {
        // API MET.NO требует указания User-Agent для идентификации запроса
        headers: { 'User-Agent': 'WeatherBloggerApp/1.0 https://github.com/meteomonster/weather-blogger' }
    });
    
    const timeseries = response.data.properties.timeseries;
    
    // Группируем почасовые данные по дням
    const dailyData = {};
    for (const entry of timeseries) {
        const date = entry.time.split('T')[0];
        if (!dailyData[date]) {
            dailyData[date] = [];
        }
        dailyData[date].push(entry.data.instant.details);
    }
    
    // Обрабатываем сгруппированные данные, чтобы получить мин/макс за каждый день
    const forecastDays = Object.keys(dailyData).slice(0, 7);
    const processedData = {
        time: forecastDays,
        temperature_2m_max: [],
        temperature_2m_min: [],
        apparent_temperature_max: [],
        apparent_temperature_min: [],
        wind_speed_10m_max: [],
        wind_gusts_10m_max: [],
        precipitation_amount_max: [],
        cloud_cover_max: [], 
    };

    for (const day of forecastDays) {
        const dayEntries = dailyData[day];
        
        processedData.temperature_2m_max.push(Math.max(...dayEntries.map(d => d.air_temperature)));
        processedData.temperature_2m_min.push(Math.min(...dayEntries.map(d => d.air_temperature)));
        processedData.apparent_temperature_max.push(Math.max(...dayEntries.map(d => d.air_temperature_percentile_90 || d.air_temperature)));
        processedData.apparent_temperature_min.push(Math.min(...dayEntries.map(d => d.air_temperature_percentile_10 || d.air_temperature)));
        processedData.wind_speed_10m_max.push(Math.max(...dayEntries.map(d => d.wind_speed)));
        processedData.wind_gusts_10m_max.push(Math.max(...dayEntries.map(d => d.wind_speed_of_gust)));
        processedData.cloud_cover_max.push(Math.max(...dayEntries.map(d => d.cloud_area_fraction)));

        const nextHourPrecipitation = timeseries
            .filter(entry => entry.time.startsWith(day) && entry.data.next_1_hours)
            .map(entry => entry.data.next_1_hours.summary.precipitation_amount);
        
        processedData.precipitation_amount_max.push(nextHourPrecipitation.length > 0 ? Math.max(...nextHourPrecipitation) : 0);
    }

    return processedData;

  } catch (error) {
    console.error("Не удалось получить данные о погоде от MET.NO:", error.response ? error.response.data : error.message);
    throw new Error("Ошибка получения данных о погоде.");
  }
}

async function getHistoricalRecord(date) {
    try {
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const url = `https://archive-api.open-meteo.com/v1/archive?latitude=56.95&longitude=24.1&start_date=1940-${month}-${day}&end_date=${date.getFullYear() - 1}-${month}-${day}&daily=temperature_2m_max,temperature_2m_min`;
        
        const response = await axios.get(url);
        const data = response.data.daily;
        
        if (!data || !data.time || data.time.length === 0) return "Исторические данные для этой даты не найдены.";

        const records = data.time.map((t, i) => ({
            year: new Date(t).getFullYear(),
            max: data.temperature_2m_max[i],
            min: data.temperature_2m_min[i],
        })).filter(r => r.max !== null && r.min !== null);

        if (records.length === 0) return "Недостаточно исторических данных для анализа.";

        const recordMax = records.reduce((prev, current) => (prev.max > current.max) ? prev : current);
        const recordMin = records.reduce((prev, current) => (prev.min < current.min) ? prev : current);

        return `Самый теплый день в истории (${recordMax.year} год): ${recordMax.max.toFixed(1)}°C. Самый холодный (${recordMin.year} год): ${recordMin.min.toFixed(1)}°C.`;
    } catch (error) {
        console.warn("Не удалось получить исторические данные:", error.message);
        return "Не удалось загрузить исторические данные.";
    }
}

async function generateArticle(weatherData, timeOfDay) {
  const today = new Date();
  const dateOptions = { day: 'numeric', month: 'long', timeZone: 'Europe/Riga' };
  const dates = weatherData.time.map((dateStr, i) => {
      const date = new Date(dateStr + "T00:00:00Z");
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

  const maxWindSpeedInForecast = Math.max(...weatherData.wind_speed_10m_max);
  let windGustsDataString = "";
  if (maxWindSpeedInForecast > 10) {
      windGustsDataString = `\n- Макс. порывы ветра: ${weatherData.wind_gusts_10m_max.map((w, i) => `${dates[i]}: ${w.toFixed(1)} м/с`).join("; ")}`;
  }
  
  const precipitationDataString = weatherData.precipitation_amount_max.map((p, i) => {
      if (p > 0) return `${dates[i]}: возможны осадки (до ${p.toFixed(1)} мм/час)`;
      return `${dates[i]}: без существенных осадков`;
  }).join("; ");

  const cloudCoverDataString = weatherData.cloud_cover_max.map((c, i) => `${dates[i]}: до ${c.toFixed(0)}%`).join("; ");

  const prompt = `
Твоя роль: Опытный и харизматичный метеоролог, который ведёт популярный блог о погоде в Риге. Твой стиль — лёгкий, образный и немного литературный, но при этом технически безупречный. Ты объясняешь сложные вещи простым языком, используя яркие метафоры.

Твоя задача: Написать эксклюзивный синоптический обзор для читателей блога. Сейчас нужно подготовить ${timeOfDay} выпуск.

СТРОГИЕ ПРАВИЛА ФОРМАТИРОВАНИЯ (ОБЯЗАТЕЛЬНО К ВЫПОЛНЕНИЮ):
1. НИКАКОГО MARKDOWN: Не используй символы ##, **, * или любые другие. Только чистый текст.
2. ТОЛЬКО РЕАЛЬНЫЕ ДАТЫ: Вместо "1-й день", "2-й день" используй настоящие даты.
3. ПОДЗАГОЛОВКИ: Каждый подзаголовок (например, "Детальный прогноз по дням") должен быть на отдельной строке. После подзаголовка ОБЯЗАТЕЛЬНО должна быть одна пустая строка.

СТРУКТУРА СТАТЬИ:

Заголовок: Придумай яркий и интригующий заголовок, отражающий суть погоды.

Вступление: Дружелюбное приветствие, соответствующее времени суток (${timeOfDay}). Создание настроения.

Синоптическая картина с высоты птичьего полёта: Проведи обширный анализ метеокарты. Определи, какой барический центр (циклон или антициклон) сейчас доминирует над регионом Балтийского моря. Опиши его происхождение (например, атлантический, скандинавский), текущее положение и прогнозируемую траекторию движения. Расскажи, как его циркуляция и связанные с ним атмосферные фронты (тёплые, холодные) повлияют на погоду в Риге в ближайшие дни. Обязательно используй данные об облачности и движении воздушных масс.

Детальный прогноз по дням:
${dates[0]} — подробно утро, день, вечер, ночь: температура, температура по ощущению, облачность, осадки, ветер и его порывы (если они значительны).
${dates[1]} — прогноз на следующий день.
Прогноз на 2–3 дня вперёд — кратко, с датами ${dates[2]} и ${dates[3]}.

Почему так, а не иначе: Объяснение физики процессов простым языком с метафорами.

Совет от метеоролога: Один-два практических совета на основе прогноза. ${maxWindSpeedInForecast > 10 ? "Обязательно упомяни сильные порывы ветра, так как они ожидаются." : "Сделай акцент на температуре по ощущению."}

Мини-рубрика “А вы знали, что…”: Любопытный факт из мира метеорологии.

Мини-рубрика “Сегодня в истории”: ${historicalRecord}.

Мини-рубрика “Примета дня”: Народная примета о погоде с научным пояснением.

Завершение: Позитивное или философское завершение с пожеланием читателям.

НЕОБРАБОТАННЫЕ ДАННЫЕ ДЛЯ ТВОЕГО АНАЛИЗА:
- Температура воздуха (мин/макс): ${weatherData.temperature_2m_min.map((t, i) => `${dates[i]}: ${t.toFixed(1)}°C...${weatherData.temperature_2m_max[i].toFixed(1)}°C`).join("; ")}
- Температура по ощущению (мин/макс): ${weatherData.apparent_temperature_min.map((t, i) => `${dates[i]}: ${t.toFixed(1)}°C...${weatherData.apparent_temperature_max[i].toFixed(1)}°C`).join("; ")}
- Данные по осадкам: ${precipitationDataString}
- Макс. скорость ветра: ${weatherData.wind_speed_10m_max.map((w, i) => `${dates[i]}: ${w.toFixed(1)} м/с`).join("; ")}${windGustsDataString}
- Облачность (макс. % покрытия): ${cloudCoverDataString}
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
