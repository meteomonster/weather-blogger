/**
 * global-events.js
 * * "Эксперт" по мировым событиям. Генерирует абзац текста
 * о самых значимых катаклизмах на планете.
 */
import { GoogleGenerativeAI } from "@google/generative-ai";

/**
 * Генерирует текстовый блок о глобальных событиях.
 * @param {object} eventsData Данные от nasa-api.
 * @param {object} geminiConfig Конфигурация для Gemini (genAI, model, generationConfig).
 * @returns {Promise<string>} Готовый абзац текста.
 */
export async function generateGlobalEventsSection(eventsData, geminiConfig) {
    const { genAI, modelName, generationConfig } = geminiConfig;

    // Проверяем, есть ли вообще о чем писать
    const hasEvents = Object.values(eventsData).some(arr => arr.length > 0);
    if (!hasEvents) {
        return "На глобальной арене сегодня на удивление спокойно, значимых природных катаклизмов не зафиксировано.";
    }

    const prompt = `
Твоя роль: Международный обозреватель природных явлений.
Твоя задача: Написать один абзац, кратко summarizing 1-2 самых значимых события из списка ниже. Сфокусируйся на самом мощном или необычном. Не перечисляй всё. Текст должен быть в стиле "Пока у нас тут свои заботы, планета живет своей жизнью...".

ДАННЫЕ О СОБЫТИЯХ:
${JSON.stringify(eventsData, null, 2)}
`;
    
    const model = genAI.getGenerativeModel({ model: modelName, generationConfig });
    const result = await model.generateContent(prompt);
    return result.response.text().trim();
}
