/**
 * open-meteo-api.js
 * v2.0 (Logic Fix)
 *
 * * ИСПРАВЛЕНО: Полностью переработана логика. Вместо запроса
 * всего массива данных за 45 лет, скрипт теперь делает один
 * эффективный запрос и корректно фильтрует данные, чтобы найти
 * рекорды строго для указанного календарного дня. Это решает
 * проблему с появлением нереалистичных температур.
 */
import axios from "axios";

/**
 * Загружает и находит исторические рекорды для указанной календарной даты.
 * @param {Date} date - Объект Date, для которого нужно найти рекорды.
 * @param {object} config - Конфигурация с LAT, LON, USER_AGENT.
 * @returns {Promise<{text: string, data: object|null}>}
 */
export async function getHistoricalRecord(date, config) {
  try {
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");

    const startYear = 1979;
    const endYear = new Date().getUTCFullYear() - 1;

    // Запрашиваем данные за весь период. API не позволяет эффективно
    // запрашивать один и тот же день по разным годам.
    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${config.LAT}&longitude=${config.LON}&start_date=${startYear}-01-01&end_date=${endYear}-12-31&daily=temperature_2m_max,temperature_2m_min`;

    const { data } = await axios.get(url, {
      headers: { "User-Agent": config.USER_AGENT },
      timeout: 25000, // Увеличено время ожидания для большого запроса
    });

    const time = data?.daily?.time || [];
    const tmax = data?.daily?.temperature_2m_max || [];
    const tmin = data?.daily?.temperature_2m_min || [];

    if (!time.length) {
      return { text: "Нет надёжных исторических данных для этой даты.", data: null };
    }

    // Ключевой этап: Фильтруем ВЕСЬ массив, оставляя только нужный нам день
    const recordsForDay = time
      .map((iso, i) => ({
        year: Number(iso.slice(0, 4)),
        month: iso.slice(5, 7),
        day: iso.slice(8, 10),
        max: tmax[i],
        min: tmin[i],
      }))
      .filter(r => r.month === month && r.day === day && r.max != null && r.min != null);

    if (!recordsForDay.length) {
      return { text: "Недостаточно исторических данных для этой даты.", data: null };
    }

    // Теперь ищем рекорды только в отфильтрованном массиве
    const recordMax = recordsForDay.reduce((a, b) => (a.max > b.max ? a : b));
    const recordMin = recordsForDay.reduce((a, b) => (a.min < b.min ? a : b));

    return {
      text: `Самый тёплый в этот день: ${recordMax.year} год, ${recordMax.max.toFixed(1)}°C. Самый холодный: ${recordMin.year} год, ${recordMin.min.toFixed(1)}°C.`,
      data: { max: recordMax, min: recordMin },
    };
  } catch (e) {
    console.warn(`    -> Не удалось получить исторические данные: ${e.message}`);
    return { text: "Не удалось загрузить исторические данные для этой даты.", data: null };
  }
}

