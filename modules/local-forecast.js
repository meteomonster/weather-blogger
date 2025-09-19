/**
 * local-forecast.js
 * * "Эксперт" по локальной погоде. Генерирует абзац текста
 * с детальным прогнозом для Риги.
 */
import { GoogleGenerativeAI } from "@google/generative-ai";

function buildDateLabels(dailyTime, tz) {
    const todayStr = new Date().toLocaleString("sv-se", { timeZone: tz }).slice(0, 10);
    return dailyTime.map(iso => {
        const d = new Date(`${iso}T00:00:00Z`);
        const human = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: tz }).format(d);
        if (iso === todayStr) return `Сегодня, ${human}`;
        return human;
    });
}

/**
 * Генерирует текстовый блок с прогнозом погоды.
 * @param {object} weatherData Данные от met-no-api.
 * @param {object} geminiConfig Конфигурация для Gemini (genAI, model, generationConfig).
 * @returns {Promise<string>} Готовый абзац текста.
 */
export async function generateLocalForecastSection(weatherData, geminiConfig) {
    const { genAI, modelName, generationConfig, location } = geminiConfig;

    const dataPayload = {
        dates: buildDateLabels(weatherData.time, location.TIMEZONE),
        ...weatherData,
    };

    const prompt = `
Твоя роль: Метеоролог-синоптик.
Твоя задача: Написать краткий, но ёмкий абзац с прогнозом погоды в Риге на неделю. Опиши общую тенденцию (похолодание/потепление) и затем пройдись по дням, указывая дневную и ночную температуру и преобладающее направление ветра. Не добавляй вступлений и заключений, только сам прогноз.

ДАННЫЕ:
${JSON.stringify(dataPayload, null, 2)}
`;

    const model = genAI.getGenerativeModel({ model: modelName, generationConfig });
    const result = await model.generateContent(prompt);
    return result.response.text().trim();
}
