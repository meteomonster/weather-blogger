import axios from "axios";
import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "fs";

/**
 * generate-article.js (Open‑Meteo edition)
 * — Берёт прогноз ровно в том же формате, что и метеограмма на сайте (Open‑Meteo, почасовой)
 * — Агрегирует в дневные сводки на 7 дней + сохраняет первые 24 часа для «План на сутки»
 * — Подтягивает «вчера по факту» из Архива (те же эндпоинты, что вкладка «Архив»)
 * — Готовит чистый промпт без Markdown. Итог — структурированный «человечный» текст
 * — Сохраняет JSON: latest-article.json и article-YYYY-MM-DD-{tod}.json
 */

// 1) Безопасность: ключ Gemini из секретов CI
const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error("Ошибка: Секрет GEMINI_API_KEY не найден. Добавьте его в GitHub Secrets.");
  process.exit(1);
}
const genAI = new GoogleGenerativeAI(API_KEY);

// 2) Параметры запуска
const timeOfDay = (process.argv[2] || "morning").toLowerCase(); // morning | afternoon | evening | night
const TOD_RU = { morning: "утренний", afternoon: "дневной", evening: "вечерний", night: "ночной" };
const timeOfDayRu = TOD_RU[timeOfDay] || "выпуск";

const LAT = parseFloat(process.env.LAT || "56.9496");
const LON = parseFloat(process.env.LON || "24.1052");
const TZ  = process.env.TZ || "Europe/Riga";
const CITY_LABEL = process.env.CITY_LABEL || "Рига, Латвия";

// 3) Утилиты
function toISODateInTZ(date, tz) {
  const s = new Date(date).toLocaleString("sv-SE", { timeZone: tz });
  return s.slice(0, 10);
}
function hhmmFromUnix(sec, tz) {
  if (sec == null) return "";
  const d = new Date(sec * 1000);
  return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: tz });
}
function dayLabelRU(iso, tz) {
  const today = toISODateInTZ(new Date(), tz);
  const tomorrow = toISODateInTZ(new Date(Date.now() + 864e5), tz);
  const d = new Date(`${iso}T00:00:00Z`);
  const human = d.toLocaleDateString("ru-RU", { day: "numeric", month: "long", timeZone: tz });
  const wd = d.toLocaleDateString("ru-RU", { weekday: "long", timeZone: tz }).toLowerCase();
  if (iso === today) return `Сегодня, ${human}`;
  if (iso === tomorrow) return `Завтра, ${human}`;
  const needsO = /^(в|с)/.test(wd) ? "о" : "";
  return `В${needsO} ${wd}, ${human}`;
}
function sanitizeArticle(text) {
  if (!text) return "";
  let t = String(text);
  // Убираем код-блоки/Markdown (оставляем чистый текст; HTML не просим и не генерируем)
  t = t.replace(/```[\s\S]*?```/g, "");
  t = t.replace(/[>#*_`]+/g, "");
  return t.trim();
}
function sum(arr) { return arr.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0); }
function maxOrNull(arr) {
  const filt = arr.filter(v => Number.isFinite(v));
  return filt.length ? Math.max(...filt) : null;
}
function minOrNull(arr) {
  const filt = arr.filter(v => Number.isFinite(v));
  return filt.length ? Math.min(...filt) : null;
}

// 4) Прогноз (ровно как в метеограмме)
async function fetchForecast(lat, lon, tz) {
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${lat}&longitude=${lon}` +
    `&hourly=temperature_2m,dewpoint_2m,precipitation,weathercode,wind_gusts_10m,wind_speed_10m` +
    `&daily=sunrise,sunset` +
    `&forecast_days=7&timezone=${encodeURIComponent(tz)}&timeformat=unixtime` +
    `&windspeed_unit=ms&precipitation_unit=mm`;

  const { data } = await axios.get(url, { timeout: 20000 });
  const H = data?.hourly || {};
  const D = data?.daily || {};
  const times = (H.time || []).map(Number);
  if (!times.length) throw new Error("Нет почасового прогноза Open‑Meteo");

  const byDay = new Map(); // iso -> indices[]
  for (let i = 0; i < times.length; i++) {
    const iso = toISODateInTZ(new Date(times[i] * 1000), tz);
    if (!byDay.has(iso)) byDay.set(iso, []);
    byDay.get(iso).push(i);
  }
  const forecastDays = Array.from(byDay.keys()).sort().slice(0, 7);

  // Агрегация по дням из почасовых серий
  const dailyAgg = forecastDays.map((iso, idx) => {
    const idxs = byDay.get(iso) || [];
    const t = idxs.map(i => H.temperature_2m?.[i]);
    const pr = idxs.map(i => H.precipitation?.[i] ?? 0);
    const gust = idxs.map(i => H.wind_gusts_10m?.[i]);
    const wspd = idxs.map(i => H.wind_speed_10m?.[i]);

    return {
      iso,
      label: dayLabelRU(iso, tz),
      tmax: maxOrNull(t),
      tmin: minOrNull(t),
      precip_sum: sum(pr),
      precip_rate_max: maxOrNull(pr),
      wind_speed_max: maxOrNull(wspd),
      wind_gusts_max: maxOrNull(gust),
      sunrise: hhmmFromUnix(D.sunrise?.[idx], tz),
      sunset: hhmmFromUnix(D.sunset?.[idx], tz)
    };
  });

  // Почасовые на первые 24 часа для «План на сутки»
  const todayIso = toISODateInTZ(new Date(), tz);
  const todayIdxs = byDay.get(todayIso) || [];
  const next24Idxs = todayIdxs.slice(0, 24); // если прогноза меньше — сколько есть
  const hourlyToday = next24Idxs.map(i => ({
    t: new Date(times[i] * 1000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: tz }),
    temperature_2m: H.temperature_2m?.[i],
    dewpoint_2m: H.dewpoint_2m?.[i],
    precipitation: H.precipitation?.[i] ?? 0,
    weathercode: H.weathercode?.[i],
    wind_speed_10m: H.wind_speed_10m?.[i],
    wind_gusts_10m: H.wind_gusts_10m?.[i]
  }));

  return { dailyAgg, hourlyToday, forecastDays, raw: { hourly: H, daily: D, times } };
}

// 5) Архив: «вчера по факту» (как на вкладке «Архив»)
async function fetchArchiveDay(lat, lon, iso, tz) {
  const url =
    `https://archive-api.open-meteo.com/v1/archive` +
    `?latitude=${lat}&longitude=${lon}` +
    `&start_date=${iso}&end_date=${iso}` +
    `&hourly=temperature_2m,precipitation&timezone=${encodeURIComponent(tz)}`;

  const { data } = await axios.get(url, { timeout: 20000 });
  const H = data?.hourly || {};
  const times = H.time || [];
  if (!times.length) return null;

  const temps = (H.temperature_2m || []).filter(v => Number.isFinite(v));
  const prec  = (H.precipitation || []).map(v => Number(v) || 0);

  return {
    iso,
    label: new Date(`${iso}T00:00:00`).toLocaleDateString("ru-RU", { weekday: "long", day: "2-digit", month: "long", year: "numeric", timeZone: tz }),
    tmax: temps.length ? Math.max(...temps) : null,
    tmin: temps.length ? Math.min(...temps) : null,
    precip_sum: sum(prec)
  };
}

// 6) Подсказки-предупреждения
function buildAdvisories(dailyAgg) {
  const maxGust = maxOrNull(dailyAgg.map(d => d.wind_gusts_max));
  const maxRate = maxOrNull(dailyAgg.map(d => d.precip_rate_max));
  const minT    = minOrNull(dailyAgg.map(d => d.tmin));
  const hints = [];
  if (Number.isFinite(maxGust) && maxGust >= 15) hints.push("Ожидаются сильные порывы ветра (15 м/с и выше).");
  if (Number.isFinite(maxRate) && maxRate >= 2) hints.push("Возможны интенсивные осадки (≥ 2 мм/ч).");
  if (Number.isFinite(minT) && minT <= 1) hints.push("Ночью местами возможна скользкость из‑за подмораживания.");
  return hints;
}

// 7) Генерация статьи
async function generateArticle(payload) {
  const { cityLabel, tz, timeOfDayRu, dailyAgg, hourlyToday, archiveYesterday } = payload;

  // «Сводка на сегодня» (чтобы явно вставилось в текст без изобретения цифр)
  const today = dailyAgg.find(d => d.label.startsWith("Сегодня")) || dailyAgg[0];
  const todayChip = today ? [
    `Tmin ${today.tmin != null ? today.tmin.toFixed(1) : "—"}°C`,
    `Tmax ${today.tmax != null ? today.tmax.toFixed(1) : "—"}°C`,
    `Осадки сумм. ${today.precip_sum.toFixed(1)} мм`,
    `Порывы до ${today.wind_gusts_max != null ? today.wind_gusts_max.toFixed(0) : "—"} м/с`,
    today.sunrise && today.sunset ? `Световой день ${today.sunrise} — ${today.sunset}` : ""
  ].filter(Boolean).join(" · ") : "";

  // «План на сутки»: 4 квартала по 6 часов
  function planChunks(arr) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += 6) chunks.push(arr.slice(i, i + 6));
    return chunks.slice(0, 4).map(chunk => {
      if (!chunk.length) return null;
      const tFrom = chunk[0].t, tTo = chunk[chunk.length - 1].t;
      const tmin = minOrNull(chunk.map(x => x.temperature_2m));
      const tmax = maxOrNull(chunk.map(x => x.temperature_2m));
      const pr   = sum(chunk.map(x => x.precipitation));
      const gust = maxOrNull(chunk.map(x => x.wind_gusts_10m));
      return `${tFrom}–${tTo}: ${tmin?.toFixed(0) ?? "—"}…${tmax?.toFixed(0) ?? "—"}°C, осадки ${pr.toFixed(1)} мм, порывы до ${gust != null ? gust.toFixed(0) : "—"} м/с`;
    }).filter(Boolean);
  }
  const planToday = planChunks(hourlyToday);

  const advisoryHints = buildAdvisories(dailyAgg);

  const dataPayload = {
    cityLabel,
    tz,
    dailyAgg,
    hourlyToday,
    todayChip,
    planToday,
    archiveYesterday, // может быть null, тогда просим игнорировать
    advisoryHints
  };

  const prompt = `
Твоя роль: опытный, харизматичный метеоролог из Риги. Пиши дружелюбно, живо и без жаргона, но технически точно. Никакого Markdown, только чистый текст.

Задача: подготовить ${timeOfDayRu} выпуск блога «Наглядно о Погоде» для города ${cityLabel}. Вставь готовые числовые врезки из данных ниже — без выдумок.

СТРОГИЕ ПРАВИЛА:
1) Используй только предоставленные цифры. Ничего не придумывай.
2) Никакого Markdown и код-блоков. Только чистый текст и пустые строки как разделители.
3) Структура жёсткая (заголовки — одна строка, затем текст):
Заголовок
Вступление
Синоптическая картина с высоты птичьего полёта
Сводка на сегодня
План на сутки
Детальный прогноз по дням
Почему так, а не иначе
Вчера по факту
Совет от метеоролога
А вы знали, что...
Примета дня
Завершение

ТРЕБОВАНИЯ К СОДЕРЖАНИЮ:
— «Сводка на сегодня»: выведи одну строку‑врезку вида: ${todayChip ? todayChip : "Tmin …°C · Tmax …°C · Осадки сумм. … мм · Порывы до … м/с · Световой день … — …"}.
— «План на сутки»: 2–4 строки, каждая — один интервал из плана (если список пуст, напиши, что данных мало).
— «Детальный прогноз по дням»: по 4–6 предложений на день, используй метки дат/дней из dailyAgg.label. Отмечай окна без осадков, характер облачности, порывы (если ≥10 м/с), кратко по утро/день/вечер/ночь.
— «Вчера по факту»: если данные есть, выведи строку вида: Вчера, {archiveYesterday.label}: Tmin …°C, Tmax …°C, осадков за сутки … мм. Если нет — напиши, что архив за вчера недоступен.
— «Совет от метеоролога»: один абзац, 3–5 практических рекомендаций. Учитывай подсказки‑риски ниже.
— «Синоптическая картина» и «Почему так…»: объясни человеческим языком, как распределение давления и адвекция влияют на температуру, ветер, облака и осадки, но без выдуманных названий центров и без чисел, которых нет.
— «А вы знали, что...»: один факт из общей метеорологии (без цифр).
— «Примета дня»: короткая народная примета + краткое научное пояснение.

Подсказки‑риски (если список пуст — рисков нет): ${advisoryHints.join(" ") || "Особых погодных рисков не ожидается."}

ДАННЫЕ (использовать только для анализа, в ответ не выводить как JSON):

<DATA_JSON>
${JSON.stringify(dataPayload)}
</DATA_JSON>
`;

  const model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash-latest",
    generationConfig: { temperature: 0.85, topP: 0.9, topK: 40, maxOutputTokens: 2000 }
  });

  const result = await model.generateContent(prompt);
  return sanitizeArticle(result.response.text());
}

// 8) Сохранение
function saveArticle(articleText, timeOfDay, tz, cityLabel) {
  const now = new Date();
  const fileDate = toISODateInTZ(now, tz);
  const displayDate = now.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: tz });

  const lines = articleText.split("\n");
  const titleIdx = lines.findIndex(l => l.trim().length > 0);
  const title = titleIdx > -1 ? lines[titleIdx].trim() : `Погода: ${cityLabel}`;
  const content = titleIdx > -1 ? lines.slice(titleIdx + 1).join("\n").trim() : articleText;

  const articleJson = { title, date: displayDate, time: timeOfDay, content };
  const archiveFileName = `article-${fileDate}-${timeOfDay}.json`;
  fs.writeFileSync(archiveFileName, JSON.stringify(articleJson, null, 2), "utf-8");
  fs.writeFileSync("latest-article.json", JSON.stringify(articleJson, null, 2), "utf-8");
  console.log(`✅ Статья (${timeOfDay}) для ${cityLabel} сохранена в ${archiveFileName} и latest-article.json`);
}

// 9) Основной запуск
(async () => {
  console.log(`🚀 Запуск генерации статьи (${timeOfDayRu}) для ${CITY_LABEL}…`);
  try {
    // Прогноз (как метеограмма)
    const { dailyAgg, hourlyToday } = await fetchForecast(LAT, LON, TZ);
    console.log("📊 Прогноз Open‑Meteo получен и агрегирован.");

    // Архив: вчера по факту (как во вкладке «Архив», там max=вчера)
    const yesterdayIso = toISODateInTZ(new Date(Date.now() - 864e5), TZ);
    let archiveYesterday = null;
    try {
      archiveYesterday = await fetchArchiveDay(LAT, LON, yesterdayIso, TZ);
    } catch { /* тихо продолжаем */ }

    const article = await generateArticle({
      cityLabel: CITY_LABEL,
      tz: TZ,
      timeOfDayRu,
      dailyAgg,
      hourlyToday,
      archiveYesterday
    });
    console.log("✍️ Статья сгенерирована моделью Gemini.");

    console.log("\n=== Сгенерированная статья ===\n");
    console.log(article);
    console.log("\n============================\n");

    saveArticle(article, timeOfDay, TZ, CITY_LABEL);
  } catch (error) {
    console.error("❌ Критическая ошибка:", error?.response?.data || error.message);
    process.exit(1);
  }
})();
