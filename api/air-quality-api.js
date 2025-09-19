/**
 * air-quality-api.js
 * Модуль для получения данных о качестве воздуха и уровне пыльцы
 * с помощью Open-Meteo Air-Quality API.
 */
import axios from "axios";

export async function getAirQualityData(config) {
  try {
    const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${config.LAT}&longitude=${config.LON}&current=european_aqi,pm2_5,birch_pollen,grass_pollen,ragweed_pollen&timezone=auto`;
    const { data } = await axios.get(url, {
      headers: { "User-Agent": config.USER_AGENT },
      timeout: 15000,
    });
    return data.current || null;
  } catch (error) {
    console.warn(`    -> Не удалось получить данные о качестве воздуха: ${error.message}`);
    return null; // Возвращаем null, чтобы не прерывать выполнение
  }
}
