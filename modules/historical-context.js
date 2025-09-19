/**
 * historical-context.js
 * * "Эксперт" по истории и фактам. Генерирует абзац,
 * связывающий исторический рекорд дня с интересным фактом.
 */
import { GoogleGenerativeAI } from "@google/generative-ai";

/**
 * Генерирует текстовый блок с историческим контекстом и фактом.
 * @param {object} historicalData Данные от open-meteo-api.
 * @param {string} funFact Интересный факт.
 * @param {object} geminiConfig Конфигурация для Gemini (genAI, model, generationConfig).
 * @returns {Promise<string>} Готовый абзац текста.
 */
export async function generateHistoricalContextSection(historicalData, funFact, geminiConfig) {
    const { genAI, modelName, generationConfig } = geminiConfig;

    const prompt = `
Твоя роль: Эрудит, историк погоды.
Твоя задача: Написать один плавный абзац, который начинается с исторического рекорда погоды на сегодня, а затем переходит к интересному факту, связывая их по смыслу. Например: "Сегодняшний день далек от рекордов... Кстати, о рекордах, а вы знали, что...".

ДАННЫЕ:
- Исторический контекст: ${historicalData.text}
- Интересный факт: ${funFact}
`;

    const model = genAI.getGenerativeModel({ model: modelName, generationConfig });
    const result = await model.generateContent(prompt);
    return result.response.text().trim();
}
