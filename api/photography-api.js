/**
 * photography-api.js
 * Сбор данных для фото-гайда: золотые часы, облачность, прозрачность.
 */
import axios from "axios";
import SunCalc from "suncalc";

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

    const [weatherResult, aerosolResult] = await Promise.allSettled([
      axios.get(weatherUrl, { headers: { "User-Agent": config.USER_AGENT }, timeout: 20000 }),
      axios.get(aerosolUrl, { headers: { "User-Agent": config.USER_AGENT }, timeout: 20000 }),
    ]);

    if (weatherResult.status !== "fulfilled") {
      console.warn(
        `    -> Не удалось получить погодные данные для фото-гайда: ${weatherResult.reason?.message || weatherResult.reason}`
      );
      return buildFallbackPhotographyData(config, tz);
    }

    if (aerosolResult.status !== "fulfilled") {
      console.warn(
        `    -> Не удалось получить данные о прозрачности атмосферы: ${aerosolResult.reason?.message || aerosolResult.reason}`
      );
    }

    const weatherResp = weatherResult.value;
    const aerosolResp = aerosolResult.status === "fulfilled" ? aerosolResult.value : null;

    const weatherHourly = weatherResp.data?.hourly;
    const weatherDaily = weatherResp.data?.daily;
    const aerosolHourly = aerosolResp?.data?.hourly;

    if (!weatherHourly?.time?.length || !weatherDaily?.time?.length) {
      console.warn("    -> Погодные данные для фото-гайда вернулись без необходимых временных рядов.");
      return buildFallbackPhotographyData(config, tz);
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
    return buildFallbackPhotographyData(config, config.TIMEZONE || "auto");
  }
}

function buildFallbackPhotographyData(config, timezone) {
  const tz = timezone && timezone !== "auto" ? timezone : "UTC";
  const days = [];

  for (let offset = 0; offset < FORECAST_DAYS; offset += 1) {
    const { isoDate, baseDate } = getLocalDateInfo(tz, offset);
    const sunTimes = safeSunTimes(baseDate, config.LAT, config.LON);
    const moonTimes = safeMoonTimes(baseDate, config.LAT, config.LON);
    const moonIllum = safeMoonIllumination(baseDate);

    const morningWindow = buildWindow(sunTimes.sunrise, sunTimes.goldenHourEnd, tz);
    const eveningWindow = buildWindow(sunTimes.goldenHour, sunTimes.sunset, tz);

    days.push({
      date: isoDate,
      sunrise: toIsoString(sunTimes.sunrise),
      sunset: toIsoString(sunTimes.sunset),
      moonrise: toIsoString(moonTimes.rise),
      moonset: toIsoString(moonTimes.set),
      moonPhase: moonIllum.phase,
      morning: { window: morningWindow, cloud: null, visibility: null },
      evening: { window: eveningWindow, cloud: null, visibility: null },
      night: { cloud: null, transparency: null, visibility: null },
    });
  }

  return { days, timezone: tz };
}

function getLocalDateInfo(timezone, offsetDays) {
  const now = new Date();
  if (Number.isFinite(offsetDays)) {
    now.setUTCDate(now.getUTCDate() + offsetDays);
  }
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(now);
  const pick = (type) => parts.find((p) => p.type === type)?.value;
  const year = Number(pick("year"));
  const month = Number(pick("month"));
  const day = Number(pick("day"));
  const isoDate = [year, month, day].map((value, idx) => (idx === 0 ? String(value) : String(value).padStart(2, "0"))).join("-");
  return { isoDate, baseDate: new Date(Date.UTC(year, month - 1, day)) };
}

function safeSunTimes(date, lat, lon) {
  try {
    const times = SunCalc.getTimes(date, lat, lon);
    return {
      sunrise: times.sunrise,
      sunset: times.sunset,
      goldenHourEnd: times.goldenHourEnd || addMinutes(times.sunrise, 60),
      goldenHour: times.goldenHour || addMinutes(times.sunset, -60),
    };
  } catch {
    const fallbackSunrise = new Date(date.getTime() + 6 * 60 * 60 * 1000);
    const fallbackSunset = new Date(date.getTime() + 18 * 60 * 60 * 1000);
    return {
      sunrise: fallbackSunrise,
      sunset: fallbackSunset,
      goldenHourEnd: addMinutes(fallbackSunrise, 60),
      goldenHour: addMinutes(fallbackSunset, -60),
    };
  }
}

function safeMoonTimes(date, lat, lon) {
  try {
    const times = SunCalc.getMoonTimes(date, lat, lon, true);
    return { rise: times.rise, set: times.set };
  } catch {
    return { rise: null, set: null };
  }
}

function safeMoonIllumination(date) {
  try {
    const info = SunCalc.getMoonIllumination(date);
    return { phase: typeof info.phase === "number" ? Number(info.phase.toFixed(4)) : null };
  } catch {
    return { phase: null };
  }
}

function toIsoString(date) {
  return date instanceof Date && !Number.isNaN(date?.getTime?.()) ? date.toISOString() : null;
}

function addMinutes(date, minutes) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime()) || !Number.isFinite(minutes)) {
    return null;
  }
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function minutesOfDay(date, timezone) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  const minute = Number(parts.find((p) => p.type === "minute")?.value);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return hour * 60 + minute;
}

function buildWindow(startDate, endDate, timezone) {
  const start = minutesOfDay(startDate, timezone);
  const end = minutesOfDay(endDate, timezone);
  if (start == null && end == null) {
    return { start: null, end: null };
  }
  if (start == null) {
    return { start: end != null ? Math.max(end - 60, 0) : null, end };
  }
  if (end == null) {
    return { start, end: Math.min(start + 60, 24 * 60) };
  }
  return { start, end };
}
