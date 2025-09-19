/**
 * photography-api.js
 * Сбор данных для фото-гайда: золотые часы, облачность, прозрачность.
 */
import axios from "axios";

const FORECAST_DAYS = 3;

function average(values) {
  const valid = values.filter((v) => typeof v === "number" && !Number.isNaN(v));
  if (!valid.length) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function createBucket() {
  return {
    entries: [],
  };
}

function parseMinutesFromIso(iso) {
  const hour = Number(iso.slice(11, 13));
  const minute = Number(iso.slice(14, 16));
  if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
  return hour * 60 + minute;
}

export async function getPhotographyData(config) {
  try {
    const tz = config.TIMEZONE || "auto";
    const weatherParams = new URLSearchParams({
      latitude: config.LAT,
      longitude: config.LON,
      timezone: tz,
      forecast_days: String(FORECAST_DAYS),
      hourly: [
        "cloud_cover",
        "cloud_cover_low",
        "cloud_cover_mid",
        "cloud_cover_high",
        "visibility",
      ].join(","),
      daily: ["sunrise", "sunset", "moonrise", "moonset", "moon_phase"].join(","),
    });

    const aerosolParams = new URLSearchParams({
      latitude: config.LAT,
      longitude: config.LON,
      timezone: tz,
      forecast_days: String(FORECAST_DAYS),
      hourly: ["aerosol_optical_depth"].join(","),
    });

    const weatherUrl = `https://api.open-meteo.com/v1/forecast?${weatherParams.toString()}`;
    const aerosolUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?${aerosolParams.toString()}`;

    const [weatherResp, aerosolResp] = await Promise.all([
      axios.get(weatherUrl, { headers: { "User-Agent": config.USER_AGENT }, timeout: 20000 }),
      axios.get(aerosolUrl, { headers: { "User-Agent": config.USER_AGENT }, timeout: 20000 }),
    ]);

    const weatherHourly = weatherResp.data?.hourly;
    const weatherDaily = weatherResp.data?.daily;
    const aerosolHourly = aerosolResp.data?.hourly;

    if (!weatherHourly?.time?.length || !weatherDaily?.time?.length) {
      return null;
    }

    const cloudBuckets = new Map();
    weatherHourly.time.forEach((iso, idx) => {
      const day = iso.slice(0, 10);
      if (!cloudBuckets.has(day)) {
        cloudBuckets.set(day, createBucket());
      }
      const bucket = cloudBuckets.get(day);
      const minute = parseMinutesFromIso(iso);
      bucket.entries.push({
        minute,
        cloud: weatherHourly.cloud_cover?.[idx],
        cloudLow: weatherHourly.cloud_cover_low?.[idx],
        cloudMid: weatherHourly.cloud_cover_mid?.[idx],
        cloudHigh: weatherHourly.cloud_cover_high?.[idx],
        visibility: weatherHourly.visibility?.[idx],
      });
    });

    const aerosolBuckets = new Map();
    if (aerosolHourly?.time?.length) {
      aerosolHourly.time.forEach((iso, idx) => {
        const day = iso.slice(0, 10);
        if (!aerosolBuckets.has(day)) {
          aerosolBuckets.set(day, createBucket());
        }
        const bucket = aerosolBuckets.get(day);
        const minute = parseMinutesFromIso(iso);
        bucket.entries.push({
          minute,
          aod: aerosolHourly.aerosol_optical_depth?.[idx],
        });
      });
    }

    const days = weatherDaily.time.slice(0, FORECAST_DAYS).map((iso, idx) => {
      const bucket = cloudBuckets.get(iso) || createBucket();
      const nextDay = weatherDaily.time[idx + 1];
      const nextBucket = nextDay ? cloudBuckets.get(nextDay) : null;
      const aerosolBucket = aerosolBuckets.get(iso) || createBucket();
      const nextAerosolBucket = nextDay ? aerosolBuckets.get(nextDay) : null;

      const data = {
        date: iso,
        sunrise: weatherDaily.sunrise?.[idx] ?? null,
        sunset: weatherDaily.sunset?.[idx] ?? null,
        moonrise: weatherDaily.moonrise?.[idx] ?? null,
        moonset: weatherDaily.moonset?.[idx] ?? null,
        moonPhase: weatherDaily.moon_phase?.[idx] ?? null,
        morning: {},
        evening: {},
        night: {},
      };

      const sunriseMinutes = parseMinutesFromIso(data.sunrise ?? "");
      const sunsetMinutes = parseMinutesFromIso(data.sunset ?? "");

      const morningWindow = {
        start: sunriseMinutes,
        end: typeof sunriseMinutes === "number" ? sunriseMinutes + 60 : null,
      };
      const eveningWindow = {
        start: typeof sunsetMinutes === "number" ? Math.max(sunsetMinutes - 60, 0) : null,
        end: sunsetMinutes,
      };

      const nightWindow = { start: 22 * 60, end: 24 * 60 };
      const nightAfterMidnight = { start: 0, end: 2 * 60 };

      function collectAverage(bucketSource, window, extractor) {
        if (!window.start && window.start !== 0) return null;
        const selected = bucketSource.entries.filter((entry) => {
          if (entry.minute == null) return false;
          return entry.minute >= window.start && entry.minute <= window.end;
        });
        const values = selected.map(extractor).filter((v) => typeof v === "number" && !Number.isNaN(v));
        if (!values.length) return null;
        return average(values);
      }

      function collectNightAverage(primary, secondary, extractor) {
        const values = [];
        primary.entries.forEach((entry) => {
          if (entry.minute != null && entry.minute >= nightWindow.start && entry.minute <= nightWindow.end) {
            const value = extractor(entry);
            if (typeof value === "number" && !Number.isNaN(value)) values.push(value);
          }
        });
        if (secondary) {
          secondary.entries.forEach((entry) => {
            if (entry.minute != null && entry.minute >= nightAfterMidnight.start && entry.minute <= nightAfterMidnight.end) {
              const value = extractor(entry);
              if (typeof value === "number" && !Number.isNaN(value)) values.push(value);
            }
          });
        }
        if (!values.length) return null;
        return average(values);
      }

      data.morning = {
        window: morningWindow,
        cloud: collectAverage(bucket, morningWindow, (entry) => entry.cloud),
        visibility: collectAverage(bucket, morningWindow, (entry) => entry.visibility),
      };

      data.evening = {
        window: eveningWindow,
        cloud: collectAverage(bucket, eveningWindow, (entry) => entry.cloud),
        visibility: collectAverage(bucket, eveningWindow, (entry) => entry.visibility),
      };

      data.night = {
        cloud: collectNightAverage(bucket, nextBucket, (entry) => entry.cloud),
        transparency: collectNightAverage(aerosolBucket, nextAerosolBucket, (entry) => entry.aod),
        visibility: collectNightAverage(bucket, nextBucket, (entry) => entry.visibility),
      };

      return data;
    });

    return { days, timezone: tz };
  } catch (error) {
    console.warn(`    -> Не удалось получить данные для фото-гайда: ${error.message}`);
    return null;
  }
}
