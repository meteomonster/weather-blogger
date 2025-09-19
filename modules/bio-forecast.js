/**
 * bio-forecast.js
 * Раздел "Биопрогноз" с иконками и индексами самочувствия.
 */

function toDate(iso) {
  return new Date(`${iso}T12:00:00Z`);
}

function formatDateLabel(iso, timezone, options) {
  const date = toDate(iso);
  return new Intl.DateTimeFormat("ru-RU", { timeZone: timezone, ...options }).format(date);
}

function describeUV(index) {
  if (typeof index !== "number") {
    return { level: "нет данных", tip: "проверьте индекс ближе к полудню." };
  }
  if (index < 3) return { level: `низкий (${index.toFixed(1)})`, tip: "можно гулять без опаски, но очки не помешают." };
  if (index < 6) return { level: `умеренный (${index.toFixed(1)})`, tip: "к полудню пригодится SPF 30 и головной убор." };
  if (index < 8) return { level: `высокий (${index.toFixed(1)})`, tip: "обязателен SPF 50 и тенистые паузы после 12:00." };
  return { level: `очень высокий (${index.toFixed(1)})`, tip: "избегайте прямого солнца, ищите тень и пейте воду." };
}

function describePollen(value) {
  if (typeof value !== "number") return null;
  if (value <= 0) return "нет";
  if (value < 20) return `низко (${value.toFixed(0)})`;
  if (value < 60) return `средне (${value.toFixed(0)})`;
  return `высоко (${value.toFixed(0)})`;
}

function describePressure(day) {
  if (typeof day.pressureAvg !== "number") {
    return "нет данных по давлению";
  }
  const avg = Math.round(day.pressureAvg);
  const trend = typeof day.pressureTrend === "number" ? day.pressureTrend : 0;
  const trendText =
    trend > 4
      ? "резко растёт — возможна тяжесть в голове"
      : trend < -4
      ? "падает, бережём сосуды"
      : "без резких скачков";
  const span =
    typeof day.pressureMin === "number" && typeof day.pressureMax === "number"
      ? `(${Math.round(day.pressureMin)}–${Math.round(day.pressureMax)} hPa)`
      : "";
  return `${avg} hPa ${span} — ${trendText}`;
}

function computeEnergy(day) {
  let score = 65;
  if (typeof day.apparentAvg === "number") {
    score -= Math.abs(day.apparentAvg - 20) * 1.2;
  }
  if (typeof day.humidityAvg === "number") {
    if (day.humidityAvg > 70) score -= (day.humidityAvg - 70) * 0.6;
    if (day.humidityAvg < 40) score -= (40 - day.humidityAvg) * 0.4;
  }
  if (typeof day.pressureAvg === "number") {
    score -= Math.abs(day.pressureAvg - 1016) * 0.15;
  }
  if (typeof day.pressureTrend === "number") {
    score -= Math.min(Math.abs(day.pressureTrend) * 1.5, 12);
  }
  if (typeof day.uvIndex === "number" && day.uvIndex > 7) {
    score -= 5;
  }

  score = Math.max(0, Math.min(100, score));
  const gauge = Math.round(score / 10);

  if (score >= 70) {
    return { label: `⚡ Энергия ${gauge}/10`, text: "день бодрый, смело планируйте активные дела." };
  }
  if (score >= 55) {
    return { label: `🙂 Ровное самочувствие ${gauge}/10`, text: "поддерживайте темп, не забывая о перерывах и воде." };
  }
  if (score >= 40) {
    return { label: `😴 Сонливость ${gauge}/10`, text: "организуйте короткие паузы и лёгкие перекусы." };
  }
  return { label: `🛌 Минимум сил ${gauge}/10`, text: "лучше снизить нагрузку и поберечь себя." };
}

function describeTrend(trend) {
  if (typeof trend !== "number") return "без заметных скачков";
  if (trend > 4) return "давление растёт";
  if (trend < -4) return "давление падает";
  return "фон стабилен";
}

export async function generateBioForecastSection(bioData, airQualityData) {
  if (!bioData || !bioData.days?.length) {
    return "💚 Биопрогноз: данные временно недоступны.";
  }

  const timezone = bioData.timezone || "Europe/Riga";
  const today = bioData.days[0];
  const todayLabel = formatDateLabel(today.date, timezone, { weekday: "long", day: "numeric", month: "long" });
  const uv = describeUV(today.uvIndex);
  const pollenParts = [];
  if (airQualityData) {
    const birch = describePollen(airQualityData.birch_pollen);
    const grass = describePollen(airQualityData.grass_pollen);
    const ragweed = describePollen(airQualityData.ragweed_pollen);
    if (birch) pollenParts.push(`берёза — ${birch}`);
    if (grass) pollenParts.push(`злаки — ${grass}`);
    if (ragweed) pollenParts.push(`амброзия — ${ragweed}`);
  }
  const pollenText = pollenParts.length ? pollenParts.join(", ") : "данных пока нет";
  const pressureText = describePressure(today);
  const energy = computeEnergy(today);

  const outlookDays = bioData.days.slice(1, 3);
  const outlookLines = outlookDays.map((day) => {
    const label = formatDateLabel(day.date, timezone, { weekday: "short", day: "numeric" });
    const trend = describeTrend(day.pressureTrend);
    const uvShort = typeof day.uvIndex === "number" ? day.uvIndex.toFixed(1) : "?";
    const humidity = typeof day.humidityAvg === "number" ? `${Math.round(day.humidityAvg)}% влажности` : "влажность без данных";
    return `- ${label}: УФ ${uvShort}, ${trend}, ${humidity}.`;
  });

  return [
    "💚 Биопрогноз",
    `${todayLabel.charAt(0).toUpperCase()}${todayLabel.slice(1)} — заботимся о себе:`,
    `☀️ УФ: ${uv.level}. ${uv.tip}`,
    `🌿 Пыльца: ${pollenText}.`,
    `⚖️ Давление: ${pressureText}.`,
    `${energy.label}: ${energy.text}`,
    outlookLines.length ? "Прогноз на ближайшие дни:" : "",
    outlookLines.join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
}
