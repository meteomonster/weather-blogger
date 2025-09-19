/**
 * local-forecast.js
 * v2.0 (Config Fix)
 * - ИСПРАВЛЕНО: Функция теперь корректно принимает и использует третий
 * аргумент `CONFIG` для доступа к TIMEZONE. Это устраняет ошибку.
 */

// Утилита для создания человекочитаемых дат
function buildDateLabels(dailyTime, tz) {
  // Защита от отсутствия часового пояса
  if (!tz) {
    throw new Error("Часовой пояс (tz) обязателен для функции buildDateLabels.");
  }

  const getLocalDate = (date) => new Date(date.toLocaleString("sv-SE", { timeZone: tz })).toISOString().slice(0, 10);

  const todayStr = getLocalDate(new Date());
  const tomorrowStr = getLocalDate(new Date(Date.now() + 864e5));

  return dailyTime.map((iso) => {
    const d = new Date(`${iso}T00:00:00Z`);
    const human = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: tz }).format(d);
    const weekday = new Intl.DateTimeFormat("ru-RU", { weekday: "long", timeZone: tz }).format(d).toLowerCase();

    if (iso === todayStr) return `Сегодня, ${human}`;
    if (iso === tomorrowStr) return `Завтра, ${human}`;

    const needsO = /^(в|с)/.test(weekday) ? "о" : "";
    return `В${needsO} ${weekday}, ${human}`;
  });
}


export async function generateLocalForecastSection(weatherData, geminiConfig, CONFIG) {
  if (!weatherData) {
    return "К сожалению, данные о местной погоде временно недоступны.";
  }
  
  // Проверка, что CONFIG передан корректно
  if (!CONFIG || !CONFIG.LOCATION || !CONFIG.LOCATION.TIMEZONE) {
      throw new Error("Объект CONFIG с TIMEZONE не был передан в generateLocalForecastSection.");
  }

  const dataPayload = {
    dates: buildDateLabels(weatherData.time, CONFIG.LOCATION.TIMEZONE),
    temperature_max: weatherData.temperature_2m_max.map(t => t?.toFixed(0)),
    temperature_min: weatherData.temperature_2m_min.map(t => t?.toFixed(0)),
    wind_speed_max: weatherData.wind_speed_10m_max.map(w => w?.toFixed(1)),
    wind_gusts_max: weatherData.wind_gusts_10m_max.map(w => w?.toFixed(1)),
    wind_direction: weatherData.wind_direction_dominant.map(d => d.compass),
  };

  const prompt = `
Твоя роль: Эксперт по локальной погоде в Риге.
Твоя задача: Написать ясный, детальный и немного образный абзац о погоде на неделю, основываясь на предоставленных данных. Сделай акцент на динамике: как меняется температура, когда ожидается самый сильный ветер.

ДАННЫЕ:
${JSON.stringify(dataPayload, null, 2)}
`;

  try {
    const { genAI, modelName, generationConfig } = geminiConfig;
    const model = genAI.getGenerativeModel({ model: modelName, generationConfig });
    const result = await model.generateContent(prompt);
    return result.response.text().trim();
  } catch (e) {
    console.error("    -> Ошибка при генерации раздела о прогнозе:", e.message);
    return "Не удалось сгенерировать детальный прогноз погоды.";
  }
}

