/**
 * air-quality.js
 * "Эксперт-эколог": Генерирует абзац о качестве воздуха и пыльце.
 */
import { GoogleGenerativeAI } from "@google/generative-ai";

export async function generateAirQualitySection(airData, geminiConfig) {
  if (!airData) {
    return "Данные о качестве воздуха сегодня временно недоступны.";
  }

  const prompt = `
Твоя роль: Эколог-аналитик, пишущий для популярного блога.
Твоя задача: На основе данных JSON, написать краткий (2-3 предложения),
понятный и полезный абзац о качестве воздуха и уровне пыльцы в Риге.
Дай практический совет.

Данные для анализа:
${JSON.stringify(airData, null, 2)}

Пример вывода: "Дышите свободно! Качество воздуха в Риге сегодня отличное
(индекс AQI ${airData.european_aqi}), а концентрация пыльцы берёзы и трав
находится на низком уровне. Отличный день для прогулок и проветривания помещений."
`;

  try {
    const model = geminiConfig.genAI.getGenerativeModel({ model: geminiConfig.modelName });
    const result = await model.generateContent(prompt);
    return result.response.text().trim();
  } catch (error) {
    console.warn(`    -> Ошибка генерации раздела о качестве воздуха: ${error.message}`);
    return "Анализ качества воздуха провести не удалось.";
  }
}
