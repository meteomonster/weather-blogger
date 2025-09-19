/**
 * marine-forecast.js
 * "Эксперт-мореплаватель": Генерирует абзац о погоде на море.
 */
import { GoogleGenerativeAI } from "@google/generative-ai";

export async function generateMarineSection(marineData, geminiConfig) {
  if (!marineData) {
    return "Прогноз погоды для Рижского залива сегодня недоступен.";
  }

  const prompt = `
Твоя роль: Опытный смотритель маяка, который делится сводкой для побережья Риги.
Твоя задача: На основе данных JSON, написать краткий (2-3 предложения) и образный
абзац о температуре воды и волнении в Рижском заливе.

Данные для анализа:
${JSON.stringify(marineData, null, 2)}

Пример вывода: "Рижский залив сегодня спокоен. Температура воды составляет
освежающие ${Math.round(marineData.sea_surface_temperature)}°C, а с
${marineData.wave_direction.toFixed(0)} градусов дует лёгкий бриз,
поднимая волну не выше ${marineData.wave_height.toFixed(1)} метра. Идеальные
условия для прогулки у кромки воды."
`;

  try {
    const model = geminiConfig.genAI.getGenerativeModel({ model: geminiConfig.modelName });
    const result = await model.generateContent(prompt);
    return result.response.text().trim();
  } catch (error) {
    console.warn(`    -> Ошибка генерации морского раздела: ${error.message}`);
    return "Морской прогноз составить не удалось.";
  }
}
