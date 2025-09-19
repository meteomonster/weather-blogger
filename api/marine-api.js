/**
 * marine-api.js
 * Модуль для получения данных о состоянии моря (температура воды, волны)
 * с помощью Open-Meteo Marine API.
 */
import axios from "axios";

export async function getMarineData(config) {
  try {
    const url = `https://marine-api.open-meteo.com/v1/marine?latitude=${config.LAT}&longitude=${config.LON}&current=wave_height,wave_direction,sea_surface_temperature`;
    const { data } = await axios.get(url, {
      headers: { "User-Agent": config.USER_AGENT },
      timeout: 15000,
    });
    return data.current || null;
  } catch (error) {
    console.warn(`    -> Не удалось получить данные о погоде на море: ${error.message}`);
    return null;
  }
}
