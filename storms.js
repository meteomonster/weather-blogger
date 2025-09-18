/**
 * storms.js
 * v1.0 (Global Event Fetcher)
 *
 * Этот модуль отвечает за сбор данных о значимых глобальных событиях
 * (лесные пожары, извержения вулканов, сильные штормы)
 * с использованием различных внешних API.
 */

import axios from "axios";

const CONFIG = {
  API: {
    USER_AGENT: "WeatherBloggerApp/1.4 (+https://github.com/meteomonster/weather-blogger)",
    TIMEOUT: 15000,
    RETRIES: 3,
  },
};

/**
 * Выполняет GET-запрос с несколькими попытками в случае неудачи.
 * @param {string} url URL для запроса.
 * @returns {Promise<object>} Промис, который разрешается с данными ответа.
 */
async function fetchWithRetry(url) {
  for (let i = 0; i < CONFIG.API.RETRIES; i++) {
    try {
      const response = await axios.get(url, {
        headers: { "User-Agent": CONFIG.API.USER_AGENT },
        timeout: CONFIG.API.TIMEOUT,
      });
      return response.data;
    } catch (error) {
      const isLastAttempt = i === CONFIG.API.RETRIES - 1;
      const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
      console.warn(`⚠️ Попытка ${i + 1} запроса к ${url} не удалась: ${errorMessage}`);
      if (isLastAttempt) {
        // Не бросаем ошибку, а возвращаем null, чтобы не ломать весь процесс
        return null;
      }
      const delay = Math.pow(2, i) * 1000;
      await new Promise(res => setTimeout(res, delay));
    }
  }
}

/**
 * Получает события из API NASA EONET по указанной категории.
 * @param {string} category Категория событий (напр., 'wildfires', 'volcanoes').
 * @param {number} limit Максимальное количество событий.
 * @returns {Promise<object[]>} Массив отформатированных событий.
 */
async function fetchEonetEvents(category, limit = 3) {
  const url = `https://eonet.gsfc.nasa.gov/api/v3/events?category=${category}&status=open&limit=${limit}`;
  const data = await fetchWithRetry(url);
  if (!data?.events) return [];
  
  return data.events.map(event => ({
    title: event.title,
    source: event.sources?.[0]?.url || "N/A",
  }));
}

/**
 * Получает данные о землетрясениях магнитудой 5+ за последние 24 часа.
 * @returns {Promise<object[]>} Массив отформатированных данных о землетрясениях.
 */
async function fetchEarthquakes() {
    const todayUTC = new Date().toISOString().slice(0, 10);
    const url = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=${todayUTC}T00:00:00&minmagnitude=5.0`;
    const data = await fetchWithRetry(url);
    if (!data?.features) return [];

    return (data.features || []).map(f => ({ 
        magnitude: f.properties?.mag?.toFixed(1), 
        location: f.properties?.place 
    }));
}


/**
 * Основная функция, которая собирает все глобальные события параллельно.
 * @returns {Promise<object>} Объект с данными по всем категориям событий.
 */
export async function getGlobalEventsData() {
  console.log("    Собираю данные о глобальных событиях...");

  const results = await Promise.allSettled([
    fetchEonetEvents("wildfires"),
    fetchEonetEvents("volcanoes"),
    fetchEonetEvents("severeStorms", 5),
    fetchEarthquakes(),
  ]);

  const [wildfires, volcanoes, storms, earthquakes] = results.map(res =>
    res.status === 'fulfilled' ? res.value : []
  );

  return {
    wildfires,
    volcanoes,
    storms,
    earthquakes,
  };
}
