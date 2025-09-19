/**
 * marine-forecast.js
 * v2.1 (Hardened)
 * - Защита от null/undefined и не-числовых значений (строки и т.п.)
 * - Аккуратные дефолты, чтобы раздел всегда генерировался
 */

const HEADING = "🌊 Морской прогноз";

const toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const fmt = (v, digits = 1) =>
  (typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "неизвестно");

export async function generateMarineSection(marineData, geminiConfig) {
  if (!marineData || typeof marineData !== "object") {
    return `${HEADING}\n\nДанные о погоде на море сегодня недоступны.`;
  }

  // Популярные алиасы полей на всякий случай
  const tempRaw =
    marineData.temperature ??
    marineData.seaTemp ??
    marineData.sea_temperature ??
    marineData.water_temperature;

  const waveRaw =
    marineData.wave_height ??
    marineData.waveHeight ??
    marineData.swell_height ??
    marineData.swellHeight;

  const temp = toNum(tempRaw);
  const wave = toNum(waveRaw);

  const dataPayload = {
    water_temperature: fmt(temp, 1), // °C
    wave_height: fmt(wave, 1),       // м
  };

  const prompt = `
Твоя роль: Морской синоптик, капитан дальнего плавания на пенсии.
Твоя задача: Написать короткий, но информативный абзац о погоде на побережье Рижского залива. Используй морскую терминологию, но понятно обычным людям. Тон — дружеский и поддерживающий, как у опытного шкипера, который делится советами с командой.

ДАННЫЕ:
- Температура воды: ${dataPayload.water_temperature}°C
- Максимальная высота волны: ${dataPayload.wave_height} м
`;

  try {
    if (!geminiConfig?.genAI) {
      // Фоллбек без ИИ — чтобы пайплайн не падал, даже если конфиг пустой
      return `${HEADING}\n\nТемпература воды: ${dataPayload.water_temperature}°C, волна до ${dataPayload.wave_height} м.`;
    }

    const { genAI, modelName, generationConfig } = geminiConfig;
    const model = genAI.getGenerativeModel({ model: modelName, generationConfig });
    const result = await model.generateContent(prompt);
    return `${HEADING}\n\n${result.response.text().trim()}`;
  } catch (e) {
    console.error("    -> Ошибка при генерации раздела о море:", e.message);
    return `${HEADING}\n\nТемпература воды: ${dataPayload.water_temperature}°C, волна до ${dataPayload.wave_height} м.`;
  }
}
