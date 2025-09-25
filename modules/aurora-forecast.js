/**
 * aurora-forecast.js
 * "Эксперт-астрофизик": Генерирует абзац о вероятности северного сияния.
 */
import { GoogleGenerativeAI } from "@google/generative-ai";

const HEADING = "🌌 Космический дозор";

const KP_THRESHOLD = 5;

const fallbackAuroraText = (kp) =>
  `${HEADING}\n\nГеомагнитный фон повышен: прогнозируемый Kp-индекс около ${kp}. Есть шанс увидеть северное сияние — выбирайте тёмные площадки с видом на север и следите за сводками в реальном времени.`;

export async function generateAuroraSection(spaceData, geminiConfig) {
  if (!spaceData || spaceData.kp_index == null) {
    return null;
  }

  const kp = Number(spaceData.kp_index);
  if (!Number.isFinite(kp) || kp < KP_THRESHOLD) {
    return null;
  }

  const prompt = `
Твоя роль: Астрофизик, ведущий рубрику "Космический дозор".
Твоя задача: На основе Kp-индекса, написать краткий (2-3 предложения) и понятный
прогноз вероятности увидеть северное сияние над Латвией. Объясни, что значит
текущий Kp-индекс. Kp-индекс 5 и выше - хороший шанс, ниже 4 - маловероятно.
Тон — дружелюбный и вдохновляющий, как у наставника ночных наблюдателей.

Данные для анализа:
Kp-индекс: ${spaceData.kp_index}

Пример вывода (для Kp=2): "Охотникам за северным сиянием сегодня придётся
набраться терпения. Геомагнитное поле Земли спокойно, прогнозируемый Kp-индекс
составляет всего ${spaceData.kp_index}, что делает появление Авроры над Латвией
маловероятным."
Пример вывода (для Kp=5): "Внимание, любители ночного неба! Геомагнитное поле
возмущено, прогнозируемый Kp-индекс достиг отметки ${spaceData.kp_index}! Это
означает, что с наступлением темноты есть реальный шанс увидеть северное сияние
даже в наших широтах."
`;

  try {
    const model = geminiConfig.genAI.getGenerativeModel({ model: geminiConfig.modelName });
    const result = await model.generateContent(prompt);
    return `${HEADING}\n\n${result.response.text().trim()}`;
  } catch (error) {
    console.warn(`    -> Ошибка генерации раздела об авроре: ${error.message}`);
    return fallbackAuroraText(kp.toFixed(1));
  }
}
