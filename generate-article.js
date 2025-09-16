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
const USER_AGENT = "WeatherBloggerApp/3.0 (+https://github.com/meteomonster)";
const OUTPUT_FORMAT = (process.argv[3] || "txt").toLowerCase(); // 'txt' или 'md'

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
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const degToCompass = (d) => {
  if (!isFiniteNum(d)) return null;
  const dirs = ["С", "ССВ", "СВ", "ВСВ", "В", "ВЮВ", "ЮВ", "ЮЮВ", "Ю", "ЮЮЗ", "ЮЗ", "ЗЮЗ", "З", "ЗСЗ", "СЗ", "ССЗ"];
  return dirs[Math.round((d % 360) / 22.5) % 16];
};
const wmoCodeToText = (code) => {
    const map = { 0: "Ясно", 1: "Преимущественно ясно", 2: "Переменная облачность", 3: "Облачно", 45: "Туман", 48: "Изморозь", 51: "Лёгкая морось", 53: "Умеренная морось", 55: "Сильная морось", 61: "Лёгкий дождь", 63: "Умеренный дождь", 65: "Сильный дождь", 71: "Лёгкий снег", 73: "Умеренный снег", 75: "Сильный снег", 80: "Лёгкие ливни", 81: "Умеренные ливни", 82: "Сильные ливни", 95: "Гроза", 96: "Гроза с градом" };
    return map[code] || "Неизвестное явление";
}
const seedFromDate = () => Number(isoDateInTZ(new Date(), TZ).replace(/-/g, "")) % 2147483647;
const pickBySeed = (arr, seed) => arr?.length ? arr[seed % arr.length] : null;

/** Безопасный вызов fetch с таймаутом */
async function safeFetch(url, options = {}, timeout = 15000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal, headers: { 'User-Agent': USER_AGENT, ...options.headers } });
        clearTimeout(timeoutId);
        if (!response.ok) throw new Error(`HTTP ${response.status} - ${response.statusText}`);
        return await response.json();
    } catch (e) {
        clearTimeout(timeoutId);
        console.warn(`safeFetch failed for ${url}:`, e.message);
        return null;
    }
}

/* ──────────────────────────────────────────────────────────────────────────
   2) СБОР ДАННЫХ
   ────────────────────────────────────────────────────────────────────────── */

/** Получение прогноза, текущей погоды и данных о солнце одним запросом */
async function getComprehensiveForecast(lat = LAT, lon = LON) {
    const vars = "weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,sunrise,sunset,daylight_duration,uv_index_max,precipitation_sum,precipitation_hours,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,dominant_wind_direction_10m";
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
        wd_dom: d.dominant_wind_direction_10m?.[i] ?? null,
        uv_max: d.uv_index_max?.[i] ?? null,
        wc: d.weather_code?.[i] ?? null,
        sunrise_iso: d.sunrise?.[i] ?? null,
        sunset_iso: d.sunset?.[i] ?? null,
        daylight_sec: d.daylight_duration?.[i] ?? null,
    }));

    const c = data.current || {};
    const current = {
        time: c.time || new Date().toISOString(),
        t: c.temperature_2m ?? null,
        t_app: c.apparent_temperature ?? null,
        ws: c.wind_speed_10m ?? null,
        wg: c.wind_gusts_10m ?? null,
        pr: c.precipitation ?? 0,
        wc: c.weather_code ?? null,
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
        const t = dailyData.time || [];
        const tx = dailyData.temperature_2m_max || [];
        const tn = dailyData.temperature_2m_min || [];

        for (let i = 0; i < t.length; i++) {
            const mmdd = t[i].slice(5, 10);
            const y = +t[i].slice(0, 4);
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
    for (const [k, v] of normMap) {
        normals[k] = { t_max_norm: v.n ? v.sum_max / v.n : null, t_min_norm: v.n ? v.sum_min / v.n : null };
    }

    const recMap = processData(recData, true);
    const records = {};
    for (const [k, v] of recMap) {
        records[k] = { ...v, t_max_rec: isFiniteNum(v.t_max_rec) ? v.t_max_rec : null, t_min_rec: isFiniteNum(v.t_min_rec) ? v.t_min_rec : null };
    }

    return { normals, records };
}

/** Получение мировых событий */
async function getGlobalEvents() {
    const [eqData, tcData] = await Promise.all([
        safeFetch(`https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=now-24hours&minmagnitude=5.5`),
        safeFetch("https://www.nhc.noaa.gov/CurrentStorms.json")
    ]);

    const earthquakes = (eqData?.features || []).map(f => ({
        magnitude: f?.properties?.mag ?? null,
        location: f?.properties?.place ?? null,
    }));

    let tropical_cyclones = [];
    if (tcData?.storms) {
        tropical_cyclones = tcData.storms.map(s => {
            const m = s.intensity?.match(/(\d+)\s*KT/);
            const kt = m ? parseInt(m[1], 10) : 0;
            return { name: `${s.classification} «${s.name}»`, wind_kmh: Math.round(kt * 1.852) };
        });
    }

    return { earthquakes, tropical_cyclones };
}

/** Факт дня из офлайн-пула */
function getLocalFactOfDay() {
    const facts = [
        "Средний круговорот воды в атмосфере занимает около 9 дней — столько в среднем «живет» молекула водяного пара, прежде чем выпадет осадками.",
        "Кучево-дождевые облака могут достигать 12–16 км в высоту, проникая в стратосферу — это выше эшелона полёта большинства авиалайнеров.",
        "Запах «после дождя», называемый петрикор, — это аромат масел растений и химического соединения геосмина, которые поднимаются в воздух с сухой почвы.",
        "Тёплый воздух удерживает больше влаги: каждые +10°C почти удваивают его способность насыщаться водяным паром, что объясняет летние ливни.",
        "Град формируется в мощных восходящих потоках грозового облака: чем сильнее поток, тем крупнее градины, многократно замерзая и подтаивая.",
        "Радуга — это оптическое явление, которое можно увидеть, только стоя спиной к солнцу. Её центр всегда находится в точке, противоположной солнцу.",
        "Снежинки всегда имеют шестиугольную симметрию из-за молекулярной структуры воды, но не существует двух абсолютно одинаковых снежинок.",
        "Скорость звука в воздухе зависит от температуры. Поэтому раскаты грома от далёкой молнии слышны иначе, чем от близкой.",
        "«Тепловой купол» над городами — результат поглощения солнечной радиации асфальтом и бетоном. Температура в мегаполисе может быть на 5-8°C выше, чем в пригороде.",
        "Полярное сияние возникает, когда заряженные частицы солнечного ветра сталкиваются с молекулами газов в верхних слоях атмосферы Земли."
    ];
    return pickBySeed(facts, seedFromDate()) || facts[0];
}

/* ──────────────────────────────────────────────────────────────────────────
   3) АНАЛИТИКА И ИНСАЙТЫ
   ────────────────────────────────────────────────────────────────────────── */
function buildInsights(forecast, climo) {
    const insights = {
        anomalies: [], record_risk: [], heavy_precip_days: [], windy_days: [],
        uv_index_risk: [], temp_swing_days: [], headlines: []
    };

    for (let i = 0; i < forecast.days.length; i++) {
        const d = forecast.days[i];
        const key = dayOfYearKey(d.date);
        const norm = climo.normals[key] || {};
        const recs = climo.records[key] || {};

        const anom_max = isFiniteNum(d.t_max) && isFiniteNum(norm.t_max_norm) ? d.t_max - norm.t_max_norm : null;
        insights.anomalies.push({ date: d.date, t_max_anom: anom_max, t_min_anom: isFiniteNum(d.t_min) && isFiniteNum(norm.t_min_norm) ? d.t_min - norm.t_min_norm : null });

        if (isFiniteNum(d.t_max) && isFiniteNum(recs.t_max_rec) && d.t_max >= recs.t_max_rec - 1) {
            insights.record_risk.push({ date: d.date, forecast: d.t_max, record: recs.t_max_rec, year: recs.year_max });
        }
        if ((d.pr_sum || 0) >= 10 || (d.pr_prob || 0) >= 80) {
            insights.heavy_precip_days.push({ date: d.date, pr_sum: d.pr_sum, pr_prob: d.pr_prob });
        }
        if ((d.wg_max || 0) >= 17) {
            insights.windy_days.push({ date: d.date, ws_max: d.ws_max, wg_max: d.wg_max });
        }
        if ((d.uv_max || 0) >= 6) {
            insights.uv_index_risk.push({ date: d.date, uv_index: d.uv_max });
        }
        if (i > 0) {
            const prev_t_max = forecast.days[i-1].t_max;
            if (isFiniteNum(d.t_max) && isFiniteNum(prev_t_max) && Math.abs(d.t_max - prev_t_max) >= 7) {
                insights.temp_swing_days.push({ date: d.date, prev_t: prev_t_max, current_t: d.t_max });
            }
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
   4) ГЕНЕРАЦИЯ ТЕКСТА
   ────────────────────────────────────────────────────────────────────────── */

/** Промпт v3: «Харизматичный сторителлер» */
function buildPromptV3({ forecast, climo, insights, fact, events }) {
    const dates = forecast.days.map((d) => d.date);
    const dateLabels = (dates, tz = TZ, locale = LOCALE) => {
        const today = isoDateInTZ(new Date(), tz);
        const tomorrow = isoDateInTZ(new Date(Date.now() + 864e5), tz);
        return dates.map(iso => {
            const d = new Date(`${iso}T12:00:00Z`);
            const weekday = new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: tz }).format(d);
            if (iso === today) return `Сегодня (${weekday})`;
            if (iso === tomorrow) return `Завтра (${weekday})`;
            return `${new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long' }).format(d)} (${weekday})`;
        });
    }
    const labels = dateLabels(dates);

    const weekRows = forecast.days.map((d, i) => ({
        label: labels[i],
        date: d.date,
        temp: `${round(d.t_min, 0)}..${round(d.t_max, 0)}°C`,
        temp_feels_like: `${round(d.t_min_app, 0)}..${round(d.t_max_app, 0)}°C`,
        precip_mm: round(d.pr_sum, 1),
        precip_chance_pct: d.pr_prob,
        wind_gust_ms: round(d.wg_max, 1),
        wind_dir: degToCompass(d.wd_dom),
        weather_description: wmoCodeToText(d.wc),
        uv_index: round(d.uv_max, 1)
    }));
    
    const todayKey = dayOfYearKey(dates[0]);
    const todayNorm = climo.normals[todayKey] || {};
    const todayRec = climo.records[todayKey] || {};

    let daylight_delta_min = null;
    if (forecast.days.length >= 2 && isFiniteNum(forecast.days[0].daylight_sec) && isFiniteNum(forecast.days[1].daylight_sec)) {
        daylight_delta_min = Math.round((forecast.days[0].daylight_sec - forecast.days[1].daylight_sec) / 60);
    }
    
    const DATA = {
        meta: {
            place: PLACE_LABEL, tz: TZ, time_of_day: timeOfDayRu,
            attribution: "Прогноз: Open-Meteo. Климат: Open-Meteo Archive. События: USGS, NOAA/NHC."
        },
        current: forecast.current ? { ...forecast.current, weather_description: wmoCodeToText(forecast.current.wc) } : null,
        week_forecast: weekRows,
        insights,
        today_context: {
            norm_tmax: round(todayNorm.t_max_norm, 1),
            norm_tmin: round(todayNorm.t_min_norm, 1),
            record_tmax: round(todayRec.t_max_rec, 1),
            record_tmax_year: todayRec.year_max,
            daylight_delta_min
        },
        world_events: events,
        fact_of_day: fact,
    };

    return `
Ты — харизматичный научный коммуникатор и автор популярного блога о погоде в городе ${PLACE_LABEL}.
Твоя задача — написать ${timeOfDayRu} выпуск, превратив сухие данные в увлекательную историю.
Стиль: живой, образный, с элементами сторителлинга. Используй метафоры (например, «атмосферный фронт, как театральный занавес»), объясняй ПРИЧИНЫ явлений.
Избегай монотонных перечислений и канцеляризмов. Текст должен быть цельным, но с четко выделенными смысловыми блоками.
${OUTPUT_FORMAT === 'md' ? 'Используй Markdown для форматирования: ## для подзаголовков, **жирный** для акцентов, *курсив* для терминов.' : 'Не используй Markdown, только обычный текст.'}

СТРУКТУРА И СОДЕРЖАНИЕ:

1.  **Яркий заголовок и лид-абзац (1-2 предложения):** Сформулируй главную идею недели. Опирайся на headlines из insights. Это должно зацепить читателя.

2.  **Погода сейчас и её ощущения:** Если есть данные 'current', опиши, что за окном прямо сейчас. Не просто цифры, а ощущения: «утренний холод бодрит» или «ветер заставляет поежиться».

3.  **Ключевой сюжет недели:** Расскажи общую историю на 7 дней. Это будет неделя дождей, волна тепла, или, может, резкая смена декораций? Используй insights (anomalies, temp_swing_days) чтобы найти главный "конфликт" или "тему".

4.  **Путеводитель по дням:** Опиши 2-3 самых интересных дня подробно, а остальные — более сжато. Для каждого дня:
    * Назови дату и день недели (label).
    * Опиши характер погоды (weather_description), температуру (temp) и как она ощущается (temp_feels_like).
    * Упомяни осадки (precip_mm, precip_chance_pct) и ветер (wind_gust_ms, wind_dir).
    * Если есть УФ-риск (uv_index_risk), предупреди и дай совет.

5.  **В контексте истории (Климат и рекорды):**
    * Сравни сегодняшний день с климатической нормой (today_context.norm_tmax). Насколько мы отклонились от «сценария»?
    * Оцени шансы на рекорд (today_context.record_tmax). Мы близки к историческому максимуму или далеки?
    * Расскажи, как меняется длина дня (daylight_delta_min). День прибывает или убывает? На сколько минут?

6.  **Фокус на важном (Риски и рекомендации):**
    * Собери все предупреждения из insights (heavy_precip_days, windy_days) в один блок.
    * Дай практические советы: где лучше не парковать машину, стоит ли брать зонт, как защититься от солнца.

7.  **Интересный факт («А вы знали?»):**
    * Возьми fact_of_day и раскрой его. Объясни научную суть простыми словами и приведи пример из жизни.

8.  **Завершение:**
    * Лёгкий, позитивный финальный абзац. Пожелай читателям чего-то хорошего в контексте предстоящей погоды.
    * В самом конце, мелким шрифтом или отдельной строкой, укажи источники из meta.attribution.

ИСХОДНЫЕ ДАННЫЕ (используй только их, ничего не выдумывай):
${JSON.stringify(DATA, null, 2)}
`;
}

async function generateWithModels(prompt) {
    const chain = [MODEL_PRIMARY, ...MODEL_FALLBACKS];
    for (const modelName of chain) {
        try {
            console.log(`💬 Попытка с моделью: ${modelName}...`);
            const model = genAI.getGenerativeModel({
                model: modelName,
                generationConfig: { temperature: 0.8, topP: 0.95, maxOutputTokens: 4096 }
            });
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

    // Сохранение полного JSON-отчета для анализа
    const richReport = {
        meta: { generated_at: now.toISOString(), time_of_day: timeOfDay, model: modelUsed, place: PLACE_LABEL, lat: LAT, lon: LON, tz: TZ },
        article_text: articleText,
        data_sources: {
            current: forecast.current,
            forecast_days: forecast.days,
            climatology: {
                 normals_7d: forecast.days.map(d => ({ date: d.date, ...climo.normals[dayOfYearKey(d.date)] })),
                 records_7d: forecast.days.map(d => ({ date: d.date, ...climo.records[dayOfYearKey(d.date)] })),
            },
            insights,
            world_events: events
        }
    };
    fs.writeFileSync(`article-data-${fileSuffix}.json`, JSON.stringify(richReport, null, 2), "utf-8");
    console.log(`✅ Сохранен полный отчет: article-data-${fileSuffix}.json`);

    // Сохранение чистовой статьи
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
        // 1) Асинхронный сбор всех данных
        const results = await Promise.allSettled([
            getComprehensiveForecast(),
            getClimoAndRecords(),
            getGlobalEvents()
        ]);

        const forecastResult = results[0];
        if (forecastResult.status === 'rejected') throw forecastResult.reason;
        const forecast = forecastResult.value;

        const climoResult = results[1];
        if (climoResult.status === 'rejected') {
            console.warn("⚠️ Не удалось загрузить данные по климату, генерация продолжится без них.");
        }
        const climo = climoResult.value || { normals: {}, records: {} };

        const eventsResult = results[2];
        if (eventsResult.status === 'rejected') {
            console.warn("⚠️ Не удалось загрузить мировые события.");
        }
        const events = eventsResult.value || { earthquakes: [], tropical_cyclones: [] };

        console.log("📊 Данные успешно собраны.");

        // 2) Аналитика и факт дня
        const insights = buildInsights(forecast, climo);
        const fact = getLocalFactOfDay();
        console.log("🧠 Инсайты и факт дня подготовлены.");

        // 3) Генерация текста
        const prompt = buildPromptV3({ forecast, climo, insights, fact, events });
        const { text, modelUsed } = await generateWithModels(prompt);
        console.log(`✒️ Текст успешно сгенерирован моделью ${modelUsed}.`);

        // 4) Сохранение
        saveOutputs({ articleText: text, modelUsed, forecast, climo, insights, events });

        console.log("✨ Готово!");
    } catch (e) {
        console.error("\n❌ КРИТИЧЕСКАЯ ОШИБКА:", e.message);
        process.exit(1);
    }
})();
