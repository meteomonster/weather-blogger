/**
 * space-weather-api.js
 * v2.0 (API Endpoint Fix)
 * - ИСПРАВЛЕНО: URL для получения данных о K-индексе обновлен на
 * рабочий эндпоинт NOAA. Старый вызывал ошибку 404.
 */
import axios from "axios";

export async function getSpaceWeatherData() {
  try {
    // ИСПРАВЛЕНО: Используется новый, работающий URL для получения K-индекса
    const url = `https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json`;
    const { data } = await axios.get(url, { timeout: 15000 });

    if (!Array.isArray(data) || data.length < 2) {
      throw new Error("Неверный формат данных от NOAA SWPC");
    }

    // Данные начинаются со второй строки (первая - заголовок)
    // Берём последнюю запись, так как она самая актуальная
    const latestEntry = data[data.length - 1];
    
    if (!latestEntry || latestEntry.length < 2) {
        return null;
    }

    return {
      kp_index: parseFloat(latestEntry[1]),
    };
  } catch (error) {
    console.warn(`    -> Не удалось получить данные о космопогоде: ${error.message}`);
    return null;
  }
}

