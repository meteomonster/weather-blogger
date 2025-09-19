/**
 * marine-forecast.js
 * v2.0 (Robustness Fix)
 * - ИСПРАВЛЕНО: Добавлена защита от null-значений, возвращаемых API.
 * Теперь, если температура воды или высота волн равны null, скрипт
 * не вызовет ошибку 'Cannot read properties of null (reading 'toFixed')',
 * а корректно обработает это.
 */

export async function generateMarineSection(marineData, geminiConfig) {
  if (!marineData) {
    return "Данные о погоде на море сегодня недоступны.";
  }

  // --- ИСПРАВЛЕНИЕ ЗДЕСЬ: Используем опциональную цепочку (?.) и оператор ??
  // для безопасного доступа к данным и предоставления запасного значения.
  const dataPayload = {
    water_temperature: marineData.temperature?.toFixed(1) ?? "неизвестно",
    wave_height: marineData.wave_height?.toFixed(1) ?? "неизвестно",
  };

  const prompt = `
Твоя роль: Морской синоптик, капитан дальнего плавания на пенсии.
Твоя задача: Написать короткий, но информативный абзац о погоде на побережье Рижского залива. Используй морскую терминологию, но так, чтобы было понятно и обычным людям.

ДАННЫЕ:
- Температура воды: ${dataPayload.water_temperature}°C
- Максимальная высота волны: ${dataPayload.wave_height} м
`;

  try {
    const { genAI, modelName, generationConfig } = geminiConfig;
    const model = genAI.getGenerativeModel({ model: modelName, generationConfig });
    const result = await model.generateContent(prompt);
    return result.response.text().trim();
  } catch (e) {
    console.error("    -> Ошибка при генерации раздела о море:", e.message);
    return "Не удалось сгенерировать прогноз погоды на море.";
  }
}

