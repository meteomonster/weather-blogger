// api/generate.js
import axios from "axios";
import { GoogleGenerativeAI } from "@google/generative-ai";

export default async function handler(req, res) {
  try {
    const API_KEY = process.env.GOOGLE_API_KEY; // ключ берём из переменных окружения на Vercel
    const genAI = new GoogleGenerativeAI(API_KEY);

    // получаем погоду из Open-Meteo
    const url = "https://api.open-meteo.com/v1/forecast";
    const params = {
      latitude: 56.95,
      longitude: 24.1,
      daily: "temperature_2m_max,temperature_2m_min,precipitation_probability_max,windspeed_10m_max",
      timezone: "Europe/Riga"
    };

    const weather = (await axios.get(url, { params })).data.daily;

    // определяем утро или вечер из query-параметра
    const timeOfDay = req.query.time || "morning";

    const prompt = `
Представь, что ты метеоролог-журналист и пишешь прогноз для блога о погоде в Риге.
Нужно написать версию для: ${timeOfDay === "morning" ? "УТРА" : "ВЕЧЕРА"}.

Структура:
1. Вступление
2. Общая картина ближайших часов
3. Детализация прогноза (${timeOfDay})
4. Простое объяснение процессов
5. Влияние на жизнь
6. Финал с пожеланием

Синоптические данные:
- Температура: ${weather.temperature_2m_min.map((t,i)=>`${t}°C...${weather.temperature_2m_max[i]}°C`).join(", ")}
- Осадки: ${weather.precipitation_probability_max.join("%, ")}%
- Ветер: ${weather.windspeed_10m_max.join(" м/с, ")} м/с
`;

    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const result = await model.generateContent(prompt);

    res.status(200).json({
      title: "Прогноз погоды в Риге",
      date: new Date().toLocaleDateString("ru-RU"),
      time: timeOfDay,
      content: result.response.text()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
