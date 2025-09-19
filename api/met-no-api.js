/**
 * met-no-api.js
 * * Модуль для получения и обработки данных прогноза погоды
 * от Норвежского метеорологического института (MET.NO).
 */
import axios from "axios";

// --- Утилиты, необходимые только для этого модуля ---
const roundArr = arr => arr.map(v => (typeof v === "number" ? Math.round(v) : null));

function circularMeanDeg(values) {
    const rad = values.filter(v => typeof v === "number" && !Number.isNaN(v)).map(v => (v * Math.PI) / 180);
    if (!rad.length) return null;
    const avgX = rad.reduce((acc, r) => acc + Math.cos(r), 0) / rad.length;
    const avgY = rad.reduce((acc, r) => acc + Math.sin(r), 0) / rad.length;
    let deg = (Math.atan2(avgY, avgX) * 180) / Math.PI;
    return deg < 0 ? deg + 360 : deg;
}

const COMPASS_DIRECTIONS = ["С", "ССВ", "СВ", "ВСВ", "В", "ВЮВ", "ЮВ", "ЮЮВ", "Ю", "ЮЮЗ", "ЮЗ", "ЗЮЗ", "З", "ЗСЗ", "СЗ", "ССЗ"];
function degToCompass(d) {
    if (d == null) return null;
    return COMPASS_DIRECTIONS[Math.round((d % 360) / 22.5) % 16];
}
// --- Конец утилит ---

/**
 * Загружает и агрегирует прогноз погоды для указанных координат.
 * @param {object} config Конфигурация с LAT, LON и USER_AGENT.
 * @returns {Promise<object>} Обработанные данные прогноза.
 */
export async function getWeatherData(config) {
    const { LAT, LON, USER_AGENT } = config;
    const url = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${LAT}&lon=${LON}`;
    
    const response = await axios.get(url, { headers: { "User-Agent": USER_AGENT }, timeout: 20000 });
    const timeseries = response.data?.properties?.timeseries || [];
    if (!timeseries.length) throw new Error("Пустой timeseries в ответе MET.NO");

    const byDay = new Map();
    for (const entry of timeseries) {
        const day = entry.time.slice(0, 10);
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day).push({
            air_temperature: entry.data?.instant?.details?.air_temperature,
            wind_dir: entry.data?.instant?.details?.wind_from_direction,
        });
    }

    const forecastDays = Array.from(byDay.keys()).sort().slice(0, 7);
    const processed = {
        time: forecastDays,
        temperature_2m_max: [],
        temperature_2m_min: [],
        wind_direction_dominant: [],
    };

    for (const day of forecastDays) {
        const dayData = byDay.get(day) || [];
        const temps = dayData.map(d => d.air_temperature).filter(t => t != null);
        processed.temperature_2m_max.push(temps.length ? Math.max(...temps) : null);
        processed.temperature_2m_min.push(temps.length ? Math.min(...temps) : null);
        const domDir = circularMeanDeg(dayData.map(d => d.wind_dir));
        processed.wind_direction_dominant.push(degToCompass(domDir));
    }

    processed.temperature_2m_max_int = roundArr(processed.temperature_2m_max);
    processed.temperature_2m_min_int = roundArr(processed.temperature_2m_min);
    return processed;
}
