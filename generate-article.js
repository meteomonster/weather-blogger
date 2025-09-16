// generate-article-v2.js
// Требуется Node 18+ и "type": "module" в package.json

import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "fs";

/* ──────────────────────────────────────────────────────────────────────────
   0) НАСТРОЙКИ
   ────────────────────────────────────────────────────────────────────────── */
const LAT = Number(process.env.BLOG_LAT || 56.95);
const LON = Number(process.env.BLOG_LON || 24.10);
const PLACE_LABEL = process.env.BLOG_PLACE || "Рига, Латвия";
const TZ = process.env.BLOG_TZ || "Europe/Riga";
const LOCALE = "ru-RU";
const USER_AGENT = "WeatherBloggerApp/4.0 (+https://github.com/meteomonster)";
// Markdown теперь по умолчанию для поддержки ссылок
const OUTPUT_FORMAT = (process.argv[3] || "md").toLowerCase(); // 'md' или 'txt'

const timeOfDay = (process.argv[2] || "morning").toLowerCase();
const TOD_RU = { morning: "утренний", afternoon: "дневной", evening: "вечерний", night: "ночной" };
const timeOfDayRu = TOD_RU[timeOfDay] || timeOfDay;

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error("❌ Ошибка: переменная окружения GEMINI_API_KEY не задана.");
  process.exit(1);
}
const genAI = new GoogleGenerativeAI(API_KEY);

const MODEL_PRIMARY = process.env.GEMINI_MODEL || "gemini-1.5-pro-latest";
const MODEL_FALLBACKS = ["gemini-1.5-flash-latest"];

/* ──────────────────────────────────────────────────────────────────────────
   1) ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
   ────────────────────────────────────────────────────────────────────────── */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isoDateInTZ = (date, tz) => new Date(date).toLocaleString("sv-SE", { timeZone: tz }).slice(0, 10);
const isFiniteNum = (x) => typeof x === "number" && Number.isFinite(x);
const round = (x, p = 0) => isFiniteNum(x) ? Number(x.toFixed(p)) : null;
const dayOfYearKey = (iso) => iso?.slice(5, 10);
const degToCompass = (d) => {
  if (!isFiniteNum(d)) return null;
  const dirs = ["С", "ССВ", "СВ", "ВСВ", "В", "ВЮВ", "ЮВ", "ЮЮВ", "Ю", "ЮЮЗ", "ЮЗ", "ЗЮЗ", "З", "ЗСЗ", "СЗ", "ССЗ"];
  return dirs[Math.round((d % 360) / 22.5) % 16];
};
const wmoCodeToText = (code) => {
    const map = { 0: "Ясно", 1: "Преимущественно ясно", 2: "Переменная облачность", 3: "Облачно", 45: "Туман", 48: "Изморозь", 51: "Лёгкая морось", 53: "Умеренная морось", 55: "Сильная морось", 61: "Лёгкий дождь", 63: "Умеренный дождь", 65: "Сильный дождь", 71: "Лёгкий снег", 73: "Умеренный снег", 75: "Сильный снег", 80: "Лёгкие ливни", 81: "Умеренные ливни", 82: "Сильные ливни", 95: "Гроза", 96: "Гроза с градом" };
    return map[code] || "Неизвестное явление";
};
const moonPhaseToText = (fraction) => {
    if (!isFiniteNum(fraction)) return "Неизвестно";
    if (fraction < 0.03 || fraction > 0.97) return "Новолуние";
    if (fraction < 0.22) return "Молодая луна";
    if (fraction < 0.28) return "Первая четверть";
    if (fraction < 0.47) return "Прибывающая луна";
    if (fraction < 0.53) return "Полнолуние";
    if (fraction < 0.72) return "Убывающая луна";
    if (fraction < 0.78) return "Последняя четверть";
    return "Старая луна";
};
const seedFromDate = () => Number(isoDateInTZ(new Date(), TZ).replace(/-/g, "")) % 2147483647;
const pickBySeed = (arr, seed) => arr?.length ? arr[seed % arr.length] : null;

async function safeFetch(url, options = {}, timeout = 15000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal, headers: { 'User-Agent': USER_AGENT, ...options.headers } });
        clearTimeout(timeoutId);
        if (!response.ok) throw new Error(`HTTP ${response.status} - ${response.statusText} for ${url}`);
        return await response.json();
    } catch (e) {
        clearTimeout(timeoutId);
        console.warn(`safeFetch failed:`, e.message);
        return null;
    }
}

/* ──────────────────────────────────────────────────────────────────────────
   2) СБОР ДАННЫХ
   ────────────────────────────────────────────────────────────────────────── */

/** Получение прогноза, текущей погоды, солнца и луны одним запросом */
async function getComprehensiveForecast(lat = LAT, lon = LON) {
    const vars = "weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,sunrise,sunset,daylight_duration,uv_index_max,precipitation_sum,precipitation_hours,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant,moon_phase";
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=${vars}&timezone=${encodeURIComponent(TZ)}&wind_speed_unit=ms&current=temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_gusts_10m`;

    const data = await safeFetch(url, {}, 20000);
    if (!data) throw new Error("Не удалось получить основной прогноз от Open-Meteo.");

    const d = data.daily || {};
    const days = (d.time || []).slice(0, 7).map((date, i) => ({
        date,
        t_max: d.temperature_2m_max?.[i] ?? null,
        t_min: d.temperature_2m_min?.[i] ?? null,
        t_max_app: d.apparent_temperature_max?.[i] ?? null,
        t_min_app: d.apparent_temperature_min?.[i] ?? null,
        pr_sum: d.precipitation_sum?.[i] ?? 0,
        pr_prob: d.precipitation_probability_max?.[i] ?? 0,
        ws_max: d.wind_speed_10m_max?.[i] ?? null,
        wg_max: d.wind_gusts_10m_max?.[i] ?? null,
        wd_dom: d.wind_direction_10m_dominant?.[i] ?? null,
        uv_max: d.uv_index_max?.[i] ?? null,
        wc: d.weather_code?.[i] ?? null,
        sunrise_iso: d.sunrise?.[i] ?? null,
        sunset_iso: d.sunset?.[i] ?? null,
        daylight_sec: d.daylight_duration?.[i] ?? null,
        moon_phase_frac: d.moon_phase?.[i] ?? null,
    }));

    const c = data.current || {};
    const current = {
        time: c.time || new Date().toISOString(),
        t: c.temperature_2m ?? null, t_app: c.apparent_temperature ?? null,
        ws: c.wind_speed_10m ?? null, wg: c.wind_gusts_10m ?? null,
        pr: c.precipitation ?? 0, wc: c.weather_code ?? null,
        tz: data.timezone || TZ
    };

    return { days, current, provider: "Open-Meteo", tz: TZ, place: PLACE_LABEL, lat, lon };
}

/** Получение климатических норм и рекордов */
async function getClimoAndRecords(lat = LAT, lon = LON) {
    const startNorm = 1991, endNorm = 2020;
    const startRec = 1979, endRec = new Date().getUTCFullYear() - 1;

    async function fetchDailyRange(startY, endY) {
        const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${startY}-01-01&end_date=${endY}-12-31&daily=temperature_2m_max,temperature_2m_min&timezone=UTC`;
        const data = await safeFetch(url, {}, 45000);
        return data?.daily || {};
    }

    const [normData, recData] = await Promise.all([
        fetchDailyRange(startNorm, endNorm),
        fetchDailyRange(startRec, endRec)
    ]);

    const processData = (dailyData, isRecords) => {
        const map = new Map();
        if (!dailyData) return map;
        const t = dailyData.time || [], tx = dailyData.temperature_2m_max || [], tn = dailyData.temperature_2m_min || [];
        for (let i = 0; i < t.length; i++) {
            const mmdd = t[i].slice(5, 10), y = +t[i].slice(0, 4);
            if (mmdd === "02-29") continue;
            if (isRecords) {
                let rec = map.get(mmdd) || { t_max_rec: -Infinity, year_max: null, t_min_rec: Infinity, year_min: null };
                if (isFiniteNum(tx[i]) && tx[i] > rec.t_max_rec) { rec.t_max_rec = tx[i]; rec.year_max = y; }
                if (isFiniteNum(tn[i]) && tn[i] < rec.t_min_rec) { rec.t_min_rec = tn[i]; rec.year_min = y; }
                map.set(mmdd, rec);
            } else {
                let norm = map.get(mmdd) || { sum_max: 0, sum_min: 0, n: 0 };
                if (isFiniteNum(tx[i])) { norm.sum_max += tx[i]; }
                if (isFiniteNum(tn[i])) { norm.sum_min += tn[i]; }
                norm.n++;
                map.set(mmdd, norm);
            }
        }
        return map;
    };

    const normMap = processData(normData, false);
    const normals = {};
    for (const [k, v] of normMap) normals[k] = { t_max_norm: v.n ? v.sum_max / v.n : null, t_min_norm: v.n ? v.sum_min / v.n : null };

    const recMap = processData(recData, true);
    const records = {};
    for (const [k, v] of recMap) records[k] = { ...v, t_max_rec: isFiniteNum(v.t_max_rec) ? v.t_max_rec : null, t_min_rec: isFiniteNum(v.t_min_rec) ? v.t_min_rec : null };

    return { normals, records };
}

/** Получение мировых событий */
async function getGlobalEvents() {
    const [eqData, tcData] = await Promise.all([
        safeFetch(`https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=now-24hours&minmagnitude=5.5`),
        safeFetch("https://www.nhc.noaa.gov/CurrentStorms.json")
    ]);
    const earthquakes = (eqData?.features || []).map(f => ({ magnitude: f?.properties?.mag ?? null, location: f?.properties?.place ?? null }));
    let tropical_cyclones = [];
    if (tcData?.storms) tropical_cyclones = tcData.storms.map(s => {
        const m = s.intensity?.match(/(\d+)\s*KT/), kt = m ? parseInt(m[1], 10) : 0;
        return { name: `${s.classification} «${s.name}»`, wind_kmh: Math.round(kt * 1.852) };
    });
    return { earthquakes, tropical_cyclones };
}

/** Факт дня из офлайн-пула */
function getLocalFactOfDay() {
    const facts = [
        "Средний круговорот воды в атмосфере занимает около 9 дней — столько в среднем «живет» молекула водяного пара, прежде чем выпадет осадками.", "Кучево-дождевые облака могут достигать 12–16 км в высоту, проникая в стратосферу — это выше эшелона полёта большинства авиалайнеров.", "Запах «после дождя», называемый петрикор, — это аромат масел растений и химического соединения геосмина, которые поднимаются в воздух с сухой почвы.", "Тёплый воздух удерживает больше влаги: каждые +10°C почти удваивают его способность насыщаться водяным паром, что объясняет летние ливни.", "Град формируется в мощных восходящих потоках грозового облака: чем сильнее поток, тем крупнее градины, многократно замерзая и подтаивая.", "Радуга — это оптическое явление, которое можно увидеть, только стоя спиной к солнцу. Её центр всегда находится в точке, противоположной солнцу.", "Снежинки всегда имеют шестиугольную симметрию из-за молекулярной структуры воды, но не существует двух абсолютно одинаковых снежинок.", "Скорость звука в воздухе зависит от температуры. Поэтому раскаты грома от далёкой молнии слышны иначе, чем от близкой.", "«Тепловой купол» над городами — результат поглощения солнечной радиации асфальтом и бетоном. Температура в мегаполисе может быть на 5-8°C выше, чем в пригороде.", "Полярное сияние возникает, когда заряженные частицы солнечного ветра сталкиваются с молекулами газов в верхних слоях атмосферы Земли."
    ];
    return pickBySeed(facts, seedFromDate()) || facts[0];
}

/* ──────────────────────────────────────────────────────────────────────────
   3) АНАЛИТИКА И ИНСАЙТЫ
   ────────────────────────────────────────────────────────────────────────── */
function buildInsights(forecast, climo) {
    const insights = { anomalies: [], record_risk: [], heavy_precip_days: [], windy_days: [], uv_index_risk: [], temp_swing_days: [], headlines: [] };
    for (let i = 0; i < forecast.days.length; i++) {
        const d = forecast.days[i];
        const key = dayOfYearKey(d.date), norm = climo.normals[key] || {}, recs = climo.records[key] || {};
        const anom_max = isFiniteNum(d.t_max) && isFiniteNum(norm.t_max_norm) ? d.t_max - norm.t_max_norm : null;
        insights.anomalies.push({ date: d.date, t_max_anom: anom_max, t_min_anom: isFiniteNum(d.t_min) && isFiniteNum(norm.t_min_norm) ? d.t_min - norm.t_min_norm : null });
        if (isFiniteNum(d.t_max) && isFiniteNum(recs.t_max_rec) && d.t_max >= recs.t_max_rec - 1) insights.record_risk.push({ date: d.date, forecast: d.t_max, record: recs.t_max_rec, year: recs.year_max });
        if ((d.pr_sum || 0) >= 10 || (d.pr_prob || 0) >= 80) insights.heavy_precip_days.push({ date: d.date, pr_sum: d.pr_sum, pr_prob: d.pr_prob });
        if ((d.wg_max || 0) >= 17) insights.windy_days.push({ date: d.date, ws_max: d.ws_max, wg_max: d.wg_max });
        if ((d.uv_max || 0) >= 6) insights.uv_index_risk.push({ date: d.date, uv_index: d.uv_max });
        if (i > 0) {
            const prev_t_max = forecast.days[i - 1].t_max;
            if (isFiniteNum(d.t_max) && isFiniteNum(prev_t_max) && Math.abs(d.t_max - prev_t_max) >= 7) insights.temp_swing_days.push({ date: d.date, prev_t: prev_t_max, current_t: d.t_max });
        }
    }
    const max_anomaly = Math.max(...insights.anomalies.map(a => Math.abs(a.t_max_anom || 0)));
    if (max_anomaly >= 5) {
        const anom = insights.anomalies.find(a => Math.abs(a.t_max_anom) === max_anomaly);
        insights.headlines.push(`${anom.t_max_anom > 0 ? 'Волна тепла' : 'Волна холода'} с аномалией до ${round(anom.t_max_anom, 0)}°C`);
    }
    if (insights.record_risk.length) insights.headlines.push("Риск температурного рекорда");
    if (insights.heavy_precip_days.length) insights.headlines.push("Ожидаются сильные осадки");
    if (insights.windy_days.length) insights.headlines.push("Периоды штормового ветра");
    return insights;
}

/* ──────────────────────────────────────────────────────────────────────────
   4) ГЕНЕРАЦИЯ ТЕКСТА (ПРОМПТ V4)
   ────────────────────────────────────────────────────────────────────────── */
function buildPromptV4({ forecast, climo, insights, fact, events }) {
    const dates = forecast.days.map((d) => d.date);
    const dateLabels = (dates, tz = TZ, locale = LOCALE) => {
        const today = isoDateInTZ(new Date(), tz), tomorrow = isoDateInTZ(new Date(Date.now() + 864e5), tz);
        return dates.map(iso => {
            const d = new Date(`${iso}T12:00:00Z`);
            const weekday = new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: tz }).format(d);
            if (iso === today) return `Сегодня (${weekday})`; if (iso === tomorrow) return `Завтра (${weekday})`;
            return `${new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long' }).format(d)} (${weekday})`;
        });
    };
    const labels = dateLabels(dates);

    const weekRows = forecast.days.map((d, i) => ({
        label: labels[i], date: d.date,
        temp: `${round(d.t_min, 0)}..${round(d.t_max, 0)}°C`, temp_feels_like: `${round(d.t_min_app, 0)}..${round(d.t_max_app, 0)}°C`,
        precip_mm: round(d.pr_sum, 1), precip_chance_pct: d.pr_prob,
        wind_gust_ms: round(d.wg_max, 1), wind_dir: degToCompass(d.wd_dom),
        weather_description: wmoCodeToText(d.wc), uv_index: round(d.uv_max, 1),
        moon_phase: moonPhaseToText(d.moon_phase_frac),
    }));
    
    const todayKey = dayOfYearKey(dates[0]);
    const todayNorm = climo.normals[todayKey] || {};
    const todayRec = climo.records[todayKey] || {};

    let daylight_delta_min = null;
    if (forecast.days.length >= 2 && isFiniteNum(forecast.days[0].daylight_sec) && isFiniteNum(forecast.days[1].daylight_sec)) {
        daylight_delta_min = Math.round((forecast.days[0].daylight_sec - forecast.days[1].daylight_sec) / 60);
    }
    
    const DATA = {
        meta: { place: PLACE_LABEL, tz: TZ, time_of_day: timeOfDayRu },
        useful_links: { weather_radar: "https://www.meteored.com/weather-radars/", local_service: "https://videscentrs.lvgmc.lv/", wikipedia_weather: "https://ru.wikipedia.org/wiki/Погода" },
        current: forecast.current ? { ...forecast.current, weather_description: wmoCodeToText(forecast.current.wc) } : null,
        week_forecast: weekRows, insights,
        today_context: {
            norm_tmax: round(todayNorm.t_max_norm, 1), record_tmax: round(todayRec.t_max_rec, 1),
            record_tmax_year: todayRec.year_max, daylight_delta_min
        },
        world_events: events, fact_of_day: fact,
    };

    return `
ТЫ — ПРЕВОСХОДНЫЙ РАССКАЗЧИК И МЕТЕОРОЛОГ, автор популярного блога о погоде в городе ${PLACE_LABEL}.
Твоя задача — написать ${timeOfDayRu} выпуск, превратив сухие данные в увлекательную, глубокую и полезную статью.

СТИЛЬ И ТОН:
- **Литературный и образный:** Пиши как для научно-популярного журнала или документального фильма. Используй метафоры ("атмосферный фронт, как театральный занавес", "антициклон — страж спокойствия").
- **Информативный и объясняющий:** Не просто говори "будет дождь", а объясняй, ПОЧЕМУ. Например: "тёплый и влажный воздух с Атлантики столкнётся с холодной массой, что приведёт к интенсивным осадкам".
- **Увлекательный:** Найди "главного героя" недели — циклон, антициклон, волну тепла — и построй вокруг него повествование.

ТРЕБОВАНИЯ К ФОРМАТИРОВАНИЮ (ОБЯЗАТЕЛЬНО):
- Используй Markdown: \`##\` для подзаголовков, \`**жирный**\` для акцентов, \`*курсив*\` для терминов.
- **ВСТАВЛЯЙ ССЫЛКИ:** Когда упоминаешь важный метеорологический термин (*циклон*, *атмосферный фронт*, *петрикор*, *кучево-дождевые облака* и т.д.), превращай его в ссылку на русскую Википедию. Пример: "[циклон](https://ru.wikipedia.org/wiki/Циклон)".

СТРУКТУРА СТАТЬИ:

1.  **Заголовок:** Яркий, интригующий, отражающий суть недели.
2.  **## Главный сюжет недели:** Начни с основного события. Опирайся на `insights.headlines`. Это задаст тон всей статье.
3.  **## Картина за окном:** Если есть данные `current`, опиши текущую погоду живописно, с ощущениями.
4.  **## Атмосферный сценарий на 7 дней:**
    * Расскажи историю недели. Где будет переломный момент? Какие дни станут кульминацией?
    * Опиши 2-3 самых значимых дня подробно: температура (обычная и по ощущениям), ветер, вероятность и характер осадков, облачность. Упомяни фазу луны для ночей.
    * Остальные дни опиши кратко, в контексте общего сюжета.
5.  **## Исторический контекст и небесная механика:**
    * Сравни сегодняшний день с климатической нормой и рекордом (`today_context`). Это аномалия или классика?
    * Расскажи об изменении длины дня (`daylight_delta_min`). Как это влияет на нас?
6.  **## Практический гид: риски и советы:**
    * Собери все риски из `insights` (сильный ветер, ливни, УФ-индекс) в один блок.
    * Дай четкие, не банальные советы. Не "берите зонт", а "ливни могут быть внезапными, лучше держать зонт в сумке даже если утром светит солнце".
7.  **## А вы знали?**
    * Глубоко раскрой `fact_of_day`. Объясни научную подоплёку и приведи яркий пример.
8.  **## Полезные ссылки:**
    * Создай список из 3-4 ссылок из `useful_links`. Например: "Следить за дождём на радаре", "Официальный прогноз от Латвийского центра погоды" и т.д.
9.  **Завершение:** Позитивный и вдохновляющий финальный абзац.

ИСХОДНЫЕ ДАННЫЕ (используй ТОЛЬКО их, не выдумывай):
${JSON.stringify(DATA, null, 2)}
`;
}


async function generateWithModels(prompt) {
    const chain = [MODEL_PRIMARY, ...MODEL_FALLBACKS];
    for (const modelName of chain) {
        try {
            console.log(`💬 Попытка с моделью: ${modelName}...`);
            const model = genAI.getGenerativeModel({ model: modelName, generationConfig: { temperature: 0.8, topP: 0.95, maxOutputTokens: 4096 } });
            const result = await model.generateContent(prompt);
            const text = result.response.text().trim();
            if (text.length < 500) throw new Error("Слишком короткий ответ от модели.");
            return { text, modelUsed: modelName };
        } catch (e) {
            console.warn(`⚠️ Модель ${modelName} не удалась:`, e.message);
            await sleep(500);
        }
    }
    throw new Error(`❌ Все модели не сработали.`);
}

/* ──────────────────────────────────────────────────────────────────────────
   5) СОХРАНЕНИЕ РЕЗУЛЬТАТА
   ────────────────────────────────────────────────────────────────────────── */
function saveOutputs({ articleText, modelUsed, forecast, climo, insights, events }) {
    const now = new Date();
    const fileDate = isoDateInTZ(now, TZ);
    const fileSuffix = `${fileDate}-${timeOfDay}`;
    const richReport = {
        meta: { generated_at: now.toISOString(), time_of_day: timeOfDay, model: modelUsed, place: PLACE_LABEL, lat: LAT, lon: LON, tz: TZ },
        article_text: articleText,
        data_sources: {
            current: forecast.current, forecast_days: forecast.days,
            climatology: {
                 normals_7d: forecast.days.map(d => ({ date: d.date, ...climo.normals[dayOfYearKey(d.date)] })),
                 records_7d: forecast.days.map(d => ({ date: d.date, ...climo.records[dayOfYearKey(d.date)] })),
            }, insights, world_events: events
        }
    };
    fs.writeFileSync(`article-data-${fileSuffix}.json`, JSON.stringify(richReport, null, 2), "utf-8");
    console.log(`✅ Сохранен полный отчет: article-data-${fileSuffix}.json`);

    const extension = OUTPUT_FORMAT === 'md' ? 'md' : 'txt';
    fs.writeFileSync(`article-${fileSuffix}.${extension}`, articleText, "utf-8");
    console.log(`✅ Сохранена статья: article-${fileSuffix}.${extension}`);
}

/* ──────────────────────────────────────────────────────────────────────────
   6) ГЛАВНАЯ ФУНКЦИЯ
   ────────────────────────────────────────────────────────────────────────── */
(async () => {
    console.log(`🚀 Старт генерации (${timeOfDayRu}, ${PLACE_LABEL})`);
    try {
        const results = await Promise.allSettled([ getComprehensiveForecast(), getClimoAndRecords(), getGlobalEvents() ]);

        const forecastResult = results[0];
        if (forecastResult.status === 'rejected') throw forecastResult.reason;
        const forecast = forecastResult.value;

        const climoResult = results[1];
        if (climoResult.status === 'rejected') console.warn("⚠️ Не удалось загрузить данные по климату, генерация продолжится без них.");
        const climo = climoResult.value || { normals: {}, records: {} };

        const eventsResult = results[2];
        if (eventsResult.status === 'rejected') console.warn("⚠️ Не удалось загрузить мировые события.");
        const events = eventsResult.value || { earthquakes: [], tropical_cyclones: [] };

        console.log("📊 Данные успешно собраны.");

        const insights = buildInsights(forecast, climo);
        const fact = getLocalFactOfDay();
        console.log("🧠 Инсайты и факт дня подготовлены.");

        const prompt = buildPromptV4({ forecast, climo, insights, fact, events });
        const { text, modelUsed } = await generateWithModels(prompt);
        console.log(`✒️ Текст успешно сгенерирован моделью ${modelUsed}.`);

        saveOutputs({ articleText: text, modelUsed, forecast, climo, insights, events });

        console.log("✨ Готово!");
    } catch (e) {
        console.error("\n❌ КРИТИЧЕСКАЯ ОШИБКА:", e.message);
        process.exit(1);
    }
})();


