/**
 * open-meteo-api.js
 * * Модуль для получения исторических данных о температурных рекордах
 * из архива Open-Meteo.
 */
import axios from "axios";

/**
 * Загружает исторические рекорды для указанной даты и координат.
 * @param {Date} date Дата.
 * @param {object} config Конфигурация с LAT, LON и USER_AGENT.
 * @returns {Promise<object>} Объект с текстовым описанием и данными рекордов.
 */
export async function getHistoricalRecord(date, config) {
  try {
    const { LAT, LON, USER_AGENT } = config;
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${LAT}&longitude=${LON}&start_date=1979-${month}-${day}&end_date=${date.getUTCFullYear() - 1}-${month}-${day}&daily=temperature_2m_max,temperature_2m_min`;
    
    const response = await axios.get(url, { headers: { "User-Agent": USER_AGENT }, timeout: 20000 });
    const data = response.data;
    
    const { time, temperature_2m_max: tmax, temperature_2m_min: tmin } = data?.daily || {};
    if (!time?.length) return { text: "Нет надёжных исторических данных для этой даты." };

    const recs = time.map((iso, i) => ({ year: Number(iso.slice(0, 4)), max: tmax[i], min: tmin[i] }))
        .filter(r => r.max != null && r.min != null);

    if (!recs.length) return { text: "Недостаточно исторических данных для этой даты." };

    const recordMax = recs.reduce((a, b) => (a.max > b.max ? a : b));
    const recordMin = recs.reduce((a, b) => (a.min < b.min ? a : b));
    
    return {
      text: `Исторический контекст: самый тёплый день (${recordMax.max.toFixed(1)}°C в ${recordMax.year} г.) и самый холодный (${recordMin.min.toFixed(1)}°C в ${recordMin.year} г.).`
    };
  } catch (e) {
    console.warn(`⚠️ Не удалось получить исторические данные: ${e.message}`);
    return { text: "Исторические данные сегодня недоступны." };
  }
}
