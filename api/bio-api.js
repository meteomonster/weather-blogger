/**
 * bio-api.js
 * Получение биометео-параметров: УФ-индекса, давления и влажности.
 */
import axios from "axios";

const FORECAST_DAYS = 5;

function average(values) {
  const valid = values.filter((v) => typeof v === "number" && !Number.isNaN(v));
  if (!valid.length) return null;
  return valid.reduce((sum, v) => sum + v, 0) / valid.length;
}

function min(values) {
  const valid = values.filter((v) => typeof v === "number" && !Number.isNaN(v));
  if (!valid.length) return null;
  return Math.min(...valid);
}

function max(values) {
  const valid = values.filter((v) => typeof v === "number" && !Number.isNaN(v));
  if (!valid.length) return null;
  return Math.max(...valid);
}

export async function getBioWeatherData(config) {
  try {
    const tz = config.TIMEZONE || "auto";
    const params = new URLSearchParams({
      latitude: config.LAT,
      longitude: config.LON,
      timezone: tz,
      forecast_days: String(FORECAST_DAYS),
      hourly: ["pressure_msl", "relative_humidity_2m", "apparent_temperature"].join(","),
      daily: [
        "uv_index_max",
        "uv_index_clear_sky_max",
        "apparent_temperature_max",
        "apparent_temperature_min",
        "temperature_2m_max",
        "temperature_2m_min",
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
    hourly.time.forEach((iso, idx) => {
      const day = iso.slice(0, 10);
      if (!buckets.has(day)) {
        buckets.set(day, {
          pressure: [],
          humidity: [],
          apparent: [],
        });
      }
      const bucket = buckets.get(day);
      const pressure = hourly.pressure_msl?.[idx];
      if (typeof pressure === "number") bucket.pressure.push(pressure);
      const humidity = hourly.relative_humidity_2m?.[idx];
      if (typeof humidity === "number") bucket.humidity.push(humidity);
      const apparent = hourly.apparent_temperature?.[idx];
      if (typeof apparent === "number") bucket.apparent.push(apparent);
    });

    const days = daily.time.slice(0, FORECAST_DAYS).map((iso, idx) => {
      const bucket = buckets.get(iso) || { pressure: [], humidity: [], apparent: [] };
      const pressureAvg = average(bucket.pressure);
      const humidityAvg = average(bucket.humidity);
      const apparentAvg = average(bucket.apparent);

      return {
        date: iso,
        uvIndex: daily.uv_index_max?.[idx] ?? null,
        uvIndexClearSky: daily.uv_index_clear_sky_max?.[idx] ?? null,
        apparentMax: daily.apparent_temperature_max?.[idx] ?? daily.temperature_2m_max?.[idx] ?? null,
        apparentMin: daily.apparent_temperature_min?.[idx] ?? daily.temperature_2m_min?.[idx] ?? null,
        tempMax: daily.temperature_2m_max?.[idx] ?? null,
        tempMin: daily.temperature_2m_min?.[idx] ?? null,
        pressureAvg,
        pressureMin: min(bucket.pressure),
        pressureMax: max(bucket.pressure),
        humidityAvg,
        humidityMin: min(bucket.humidity),
        humidityMax: max(bucket.humidity),
        apparentAvg,
      };
    });

    for (let i = 0; i < days.length; i++) {
      const prev = days[i - 1];
      if (prev && typeof days[i].pressureAvg === "number" && typeof prev.pressureAvg === "number") {
        days[i].pressureTrend = days[i].pressureAvg - prev.pressureAvg;
      } else {
        days[i].pressureTrend = null;
      }
    }

    return { days, timezone: tz };
  } catch (error) {
    console.warn(`    -> Не удалось получить данные для биопрогноза: ${error.message}`);
    return null;
  }
}
