import axios from "axios";
import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "fs";

// 🔑 Твой API-ключ
const API_KEY = "AIzaSyCQF6mSwIyl3AUzfTVmJfN8kbOZvd8jsX0";
const genAI = new GoogleGenerativeAI(API_KEY);

// 🕑 Определяем аргумент (morning или evening)
const timeOfDay = process.argv[2] || "morning"; // по умолчанию "morning"

async function getWeatherData() {
  const url = "https://api.open-meteo.com/v1/forecast";
  const params = {
    latitude: 56.95,
    longitude: 24.1,
    daily: "temperature_2m_max,temperature_2m_min,precipitation_probability_max,windspeed_10m_max",
    timezone: "Europe/Riga"
  };

  const response = await axios.get(url, { params });
  return response.data.daily;
}

async function generateArticle(weatherData, timeOfDay) {
  const prompt = `
Представь, что ты метеоролог-журналист и пишешь прогноз для блога о погоде в Риге. 
Статья должна быть рассчитана на публикацию дважды в день: утром (прогноз на день) и вечером (прогноз на ночь и утро).

Сейчас нужно написать версию для: ${timeOfDay === "morning" ? "УТРА" : "ВЕЧЕРА"}.

Структура текста:
1. Вступление — дружеское приветствие (подходит для ${timeOfDay}).
2. Общая картина ближайших часов (циклон, антициклон, фронты).
3. Детализация прогноза:
   - Утром: прогноз на день (температура, осадки, ветер, давление).
   - Вечером: прогноз на ночь и утро.
4. Простое объяснение процессов (коротко и понятно).
5. Влияние на жизнь (советы).
6. Финал — лёгкое пожелание (утром — хорошего дня, вечером — спокойной ночи).

Вот синоптические данные:
- Температура по дням: ${weatherData.temperature_2m_min.map((t,i)=>`${t}°C...${weatherData.temperature_2m_max[i]}°C`).join(", ")}
- Вероятность осадков: ${weatherData.precipitation_probability_max.join("%, ")}%
- Скорость ветра: ${weatherData.windspeed_10m_max.join(" м/с, ")} м/с
`;

  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
  const result = await model.generateContent(prompt);
  return result.response.text();
}

function saveArticle(articleText, timeOfDay) {
  const today = new Date().toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric"
  });

  const articleJson = {
    title: articleText.split("\n")[0].replace(/[#*]/g, "").trim() || "Прогноз погоды в Риге",
    date: today,
    time: timeOfDay,
    content: articleText
  };

  fs.writeFileSync("latest-article.json", JSON.stringify(articleJson, null, 2), "utf-8");
  console.log(`✅ Статья (${timeOfDay}) сохранена в latest-article.json`);
}

(async () => {
  try {
    const weather = await getWeatherData();
    const article = await generateArticle(weather, timeOfDay);
    console.log("=== Статья для блога ===\n");
    console.log(article);
    saveArticle(article, timeOfDay);
  } catch (error) {
    console.error("Ошибка:", error);
  }
})();
