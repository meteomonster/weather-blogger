/**
 * air-quality.js
 * "Эксперт-эколог": Генерирует абзац о качестве воздуха и пыльце.
 */
import { GoogleGenerativeAI } from "@google/generative-ai";

const HEADING = "🌬️ Качество воздуха";

export async function generateAirQualitySection(airData, geminiConfig) {
  if (!airData) {
    return `${HEADING}\n\nДанные о качестве воздуха сегодня временно недоступны.`;
  }

  const prompt = `
Твоя роль: Эколог-аналитик, пишущий для популярного блога.
Твоя задача: На основе данных JSON, написать краткий (2-3 предложения),
понятный и полезный абзац о качестве воздуха и уровне пыльцы в Риге.
Дай практический совет и делай это по-дружески, будто напоминаешь знакомым позаботиться о себе.

Данные для анализа:
${JSON.stringify(airData, null, 2)}

Пример вывода: "Дышите свободно! Качество воздуха в Риге сегодня отличное
(индекс AQI ${airData.european_aqi}), а концентрация пыльцы берёзы и трав
находится на низком уровне. Отличный день для прогулок и проветривания помещений."
`;

  try {
    const model = geminiConfig.genAI.getGenerativeModel({ model: geminiConfig.modelName });
    const result = await model.generateContent(prompt);
    return `${HEADING}\n\n${result.response.text().trim()}`;
  } catch (error) {
    console.warn(`    -> Ошибка генерации раздела о качестве воздуха: ${error.message}`);
    return `${HEADING}\n\nАнализ качества воздуха провести не удалось.`;
  }
}
