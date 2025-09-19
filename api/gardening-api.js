/**
 * gardening-api.js
 * Модуль для получения почвенных и аграрных параметров
 * через Open-Meteo Forecast API.
 */
import axios from "axios";

const FORECAST_DAYS = 7;

function average(values) {
  const valid = values.filter((v) => typeof v === "number" && !Number.isNaN(v));
  if (!valid.length) return null;
  return valid.reduce((sum, v) => sum + v, 0) / valid.length;
}

function sum(values) {
  const valid = values.filter((v) => typeof v === "number" && !Number.isNaN(v));
  if (!valid.length) return 0;
  return valid.reduce((acc, v) => acc + v, 0);
}

function max(values) {
  const valid = values.filter((v) => typeof v === "number" && !Number.isNaN(v));
  if (!valid.length) return null;
  return Math.max(...valid);
}

function min(values) {
  const valid = values.filter((v) => typeof v === "number" && !Number.isNaN(v));
  if (!valid.length) return null;
  return Math.min(...valid);
}

export async function getGardeningData(config) {
  try {
    const tz = config.TIMEZONE || "auto";
    const params = new URLSearchParams({
      latitude: config.LAT,
      longitude: config.LON,
      timezone: tz,
      forecast_days: String(FORECAST_DAYS),
      hourly: [
        "soil_temperature_0cm",
        "soil_moisture_0_1cm",
        "temperature_2m",
        "precipitation_probability",
        "precipitation",
      ].join(","),
      daily: [
        "temperature_2m_min",
        "temperature_2m_max",
        "precipitation_sum",
        "precipitation_probability_max",
      ].join(","),
    });

    const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
    const { data } = await axios.get(url, {
      headers: { "User-Agent": config.USER_AGENT },
      timeout: 20000,
    });

    const hourly = data?.hourly;
    const daily = data?.daily;
    if (!hourly?.time?.length || !daily?.time?.length) {
      return null;
    }

    const buckets = new Map();
    hourly.time.forEach((iso, index) => {
      const day = iso.slice(0, 10);
      if (!buckets.has(day)) {
        buckets.set(day, {
          soilTemps: [],
          soilMoisture: [],
          airTemps: [],
          precipitation: [],
          precipitationProb: [],
        });
      }
      const bucket = buckets.get(day);
      const soilTemp = hourly.soil_temperature_0cm?.[index];
      if (typeof soilTemp === "number") bucket.soilTemps.push(soilTemp);
      const soilMoist = hourly.soil_moisture_0_1cm?.[index];
      if (typeof soilMoist === "number") bucket.soilMoisture.push(soilMoist);
      const airTemp = hourly.temperature_2m?.[index];
      if (typeof airTemp === "number") bucket.airTemps.push(airTemp);
      const precip = hourly.precipitation?.[index];
      if (typeof precip === "number") bucket.precipitation.push(precip);
      const precipProb = hourly.precipitation_probability?.[index];
      if (typeof precipProb === "number") bucket.precipitationProb.push(precipProb);
    });

    const days = daily.time.slice(0, FORECAST_DAYS).map((iso, idx) => {
      const bucket = buckets.get(iso) || {
        soilTemps: [],
        soilMoisture: [],
        airTemps: [],
        precipitation: [],
        precipitationProb: [],
      };

      const soilTempMin = min(bucket.soilTemps);
      const soilTempMax = max(bucket.soilTemps);
      const soilTempAvg = average(bucket.soilTemps);
      const soilMoistMin = min(bucket.soilMoisture);
      const soilMoistMax = max(bucket.soilMoisture);
      const soilMoistAvg = average(bucket.soilMoisture);
      const airTempMin = daily.temperature_2m_min?.[idx] ?? min(bucket.airTemps);
      const airTempMax = daily.temperature_2m_max?.[idx] ?? max(bucket.airTemps);
      const precipSum =
        typeof daily.precipitation_sum?.[idx] === "number"
          ? daily.precipitation_sum[idx]
          : sum(bucket.precipitation);
      const precipProbability =
        typeof daily.precipitation_probability_max?.[idx] === "number"
          ? daily.precipitation_probability_max[idx]
          : max(bucket.precipitationProb);

      return {
        date: iso,
        soilTempMin,
        soilTempMax,
        soilTempAvg,
        soilMoistMin,
        soilMoistMax,
        soilMoistAvg,
        airTempMin,
        airTempMax,
        precipSum,
        precipProbability,
      };
    });

    return { days, timezone: tz };
  } catch (error) {
    console.warn(`    -> Не удалось получить агропрогноз: ${error.message}`);
    return null;
  }
}
