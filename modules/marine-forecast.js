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

const getLocalMonth = (date, timezone) => {
  if (!(date instanceof Date) || Number.isNaN(date.valueOf())) return null;
  try {
    const formatted = new Intl.DateTimeFormat("en-US", {
      month: "numeric",
      timeZone: timezone || "UTC",
    }).format(date);
    const month = Number(formatted);
    return Number.isFinite(month) ? month : null;
  } catch {
    return date.getUTCMonth() + 1;
  }
};

export async function generateMarineSection(marineData, geminiConfig, context = {}) {
  const month = getLocalMonth(context.date, context.timezone);
  const inSwimmingSeason = month != null && month >= 5 && month <= 9; // май–сентябрь (1-based)

  const airMax = toNum(context.weatherData?.temperature_2m_max?.[0]);
  const comfortableAir = typeof airMax === "number" && airMax >= 16;

  if (!inSwimmingSeason || !comfortableAir) {
    return null;
  }

  if (!marineData || typeof marineData !== "object") {
    return null;
  }

  // Популярные алиасы полей на всякий случай
  const tempRaw =
    marineData.temperature ??
    marineData.seaTemp ??
    marineData.sea_temperature ??
    marineData.sea_surface_temperature ??
    marineData.seaSurfaceTemperature ??
    marineData.water_temperature;

  const waveRaw =
    marineData.wave_height ??
    marineData.waveHeight ??
    marineData.swell_height ??
    marineData.swellHeight;

  const temp = toNum(tempRaw);
  if (typeof temp !== "number" || temp < 15) {
    return null;
  }

  const wave = toNum(waveRaw);
  const hasWave = typeof wave === "number";

  const fallbackSummary = () => {
    const parts = [`Температура воды держится около ${fmt(temp, 1)}°C.`];
    if (hasWave) {
      parts.push(`Высота волны достигает примерно ${fmt(wave, 1)} м.`);
    } else {
      parts.push("Высота волны не сообщается, держите связь с портовой службой на случай изменений.");
    }
    parts.push("Проверяйте оперативные бюллетени, особенно если планируете выход к вечеру.");
    return `${HEADING}\n\n${parts.join(" ")}`;
  };

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
    if (!geminiConfig?.genAI || !hasWave) {
      // Фоллбек без ИИ — чтобы пайплайн не падал, даже если конфиг пустой
      return fallbackSummary();
    }

    const { genAI, modelName, generationConfig } = geminiConfig;
    const model = genAI.getGenerativeModel({ model: modelName, generationConfig });
    const result = await model.generateContent(prompt);
    return `${HEADING}\n\n${result.response.text().trim()}`;
  } catch (e) {
    console.error("    -> Ошибка при генерации раздела о море:", e.message);
    return fallbackSummary();
  }
}
