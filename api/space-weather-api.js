/**
 * space-weather-api.js
 * Модуль для получения прогноза геомагнитной активности (Kp-индекс)
 * для оценки вероятности северного сияния от NOAA.
 */
import axios from "axios";

export async function getSpaceWeatherData() {
  try {
    // Этот API возвращает JSON в текстовом формате с комментариями
    const url = `https://services.swpc.noaa.gov/products/noaa-planetary-k-index-3-day.json`;
    const { data } = await axios.get(url, { timeout: 15000 });

    if (!Array.isArray(data) || data.length < 2) {
      throw new Error("Неверный формат данных от NOAA SWPC");
    }

    // Данные начинаются со второй строки (первая - заголовок)
    const forecastEntries = data.slice(1);
    // Находим первый прогноз на ближайшее время
    const latestForecast = forecastEntries.find(entry => entry[2] === 'forecast');

    if (!latestForecast) {
      return null;
    }

    return {
      kp_index: parseFloat(latestForecast[1]),
    };
  } catch (error) {
    console.warn(`    -> Не удалось получить данные о космопогоде: ${error.message}`);
    return null;
  }
}
