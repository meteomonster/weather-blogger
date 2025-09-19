/**
 * nasa-api.js
 * * Специализированный модуль для получения данных о глобальных
 * событиях (пожары, вулканы, штормы) с помощью API NASA EONET
 * и данных о землетрясениях от USGS.
 */
import axios from "axios";

const CONFIG = {
  API: {
    USER_AGENT: "WeatherBloggerApp/2.0 (+https://github.com/meteomonster/weather-blogger)",
    TIMEOUT: 15000,
    RETRIES: 3,
  },
};

async function fetchWithRetry(url) {
  for (let i = 0; i < CONFIG.API.RETRIES; i++) {
    try {
      const response = await axios.get(url, {
        headers: { "User-Agent": CONFIG.API.USER_AGENT },
        timeout: CONFIG.API.TIMEOUT,
      });
      return response.data;
    } catch (error) {
      if (i === CONFIG.API.RETRIES - 1) return null; // Не ломаем всё, если один источник не ответил
      await new Promise(res => setTimeout(res, Math.pow(2, i) * 1000));
    }
  }
}

async function fetchEonetEvents(category, limit = 3) {
  const url = `https://eonet.gsfc.nasa.gov/api/v3/events?category=${category}&status=open&limit=${limit}&days=20`;
  const data = await fetchWithRetry(url);
  return data?.events?.map(event => ({ title: event.title })) || [];
}

async function fetchEarthquakes() {
  const url = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&minmagnitude=5.5&limit=5`;
  const data = await fetchWithRetry(url);
  return data?.features?.map(f => ({
    magnitude: f.properties?.mag?.toFixed(1),
    location: f.properties?.place,
  })) || [];
}

/**
 * Собирает данные о всех значимых глобальных событиях.
 * @returns {Promise<object>} Объект с массивами событий.
 */
export async function getGlobalEventsData() {
  const [wildfires, volcanoes, storms, earthquakes] = await Promise.all([
    fetchEonetEvents("wildfires"),
    fetchEonetEvents("volcanoes"),
    fetchEonetEvents("severeStorms", 5),
    fetchEarthquakes(),
  ]);
  return { wildfires, volcanoes, storms, earthquakes };
}
