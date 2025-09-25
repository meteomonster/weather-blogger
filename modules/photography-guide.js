/**
 * photography-guide.js
 * Раздел "Гид фотографа" с золотыми часами и подсказками для ночной съёмки.
 */

function toDate(iso) {
  return new Date(`${iso}T12:00:00Z`);
}

function formatDateLabel(iso, timezone, options) {
  const date = toDate(iso);
  return new Intl.DateTimeFormat("ru-RU", { timeZone: timezone, ...options }).format(date);
}

function formatTime(iso, timezone) {
  if (!iso) return "—";
  const parsed = new Date(iso);
  if (!Number.isNaN(parsed.getTime())) {
    return new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: timezone }).format(parsed);
  }
  return iso.slice(11, 16) || "—";
}

function formatWindow(window) {
  if (!window || window.start == null || window.end == null) return "—";
  const toTime = (minutes) => {
    const hrs = Math.floor(minutes / 60) % 24;
    const mins = minutes % 60;
    return `${hrs.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}`;
  };
  return `${toTime(window.start)}–${toTime(window.end)}`;
}

function describeCloud(value) {
  if (typeof value !== "number") return "облачность без данных";
  const percent = Math.round(value);
  if (percent <= 15) return `почти чистое небо (~${percent}%)`;
  if (percent <= 40) return `легкая дымка (~${percent}%)`;
  if (percent <= 70) return `переменная облачность (~${percent}%)`;
  if (percent <= 90) return `густые облака (~${percent}%)`;
  return `полностью закрыто (~${percent}%)`;
}

function describeTransparency(value) {
  if (typeof value !== "number") return "прозрачность неизвестна";
  if (value < 0.08) return `атмосфера кристальная (AOD ~${value.toFixed(2)})`;
  if (value < 0.15) return `слегка дымка (AOD ~${value.toFixed(2)})`;
  if (value < 0.25) return `заметная дымка (AOD ~${value.toFixed(2)})`;
  return `плотная пелена (AOD ~${value.toFixed(2)})`;
}

function describeVisibility(value) {
  if (typeof value !== "number") return "видимость неизвестна";
  const km = value / 1000;
  if (km >= 20) return "видимость 20+ км";
  if (km >= 10) return `видимость ${km.toFixed(0)} км`;
  if (km >= 5) return `видимость ${km.toFixed(1)} км`;
  return `видимость ${km.toFixed(1)} км`;
}

function describeMoonPhase(phase) {
  if (typeof phase !== "number") return "фаза Луны не определена";
  if (phase < 0.05) return "новолуние";
  if (phase < 0.23) return "растущий серп";
  if (phase < 0.27) return "первая четверть";
  if (phase < 0.48) return "растущая Луна";
  if (phase < 0.52) return "полнолуние";
  if (phase < 0.73) return "убывающая Луна";
  if (phase < 0.77) return "последняя четверть";
  if (phase < 0.95) return "стареющий серп";
  return "новолуние";
}

function milkyWayHint(day, timezone) {
  const phase = typeof day.moonPhase === "number" ? day.moonPhase : null;
  const illumination = phase == null ? null : phase <= 0.5 ? phase * 2 : (1 - phase) * 2;
  const moonRise = formatTime(day.moonrise, timezone);
  const moonSet = formatTime(day.moonset, timezone);
  const clouds = typeof day.night.cloud === "number" ? day.night.cloud : 100;
  const transparency = day.night.transparency;

  if (illumination != null && illumination < 0.2 && clouds < 50 && typeof transparency === "number" && transparency < 0.18) {
    return `Млечный Путь обещает яркие полосы: Луна не мешает (восход ${moonRise}, заход ${moonSet}).`;
  }
  if (illumination != null && illumination < 0.4) {
    return `Шанс поймать Млечный Путь есть, но лёгкая лунная подсветка (восход ${moonRise}).`;
  }
  return `Лунный свет будет заметен — ищите силуэты, закаты и городской неон (Луна: восход ${moonRise}, заход ${moonSet}).`;
}

function pickStarHighlight(dateIso) {
  const month = toDate(dateIso).getUTCMonth();
  const highlights = [
    "Юпитер сияет над юго-востоком — берите телеобъектив для крупных дисков.",
    "Венера на рассвете даёт яркий маяк для таймлапсов.",
    "Охотьтесь за Серпом молодого месяца и отражениями в воде.",
    "Сатурн поднимается после полуночи — кольца видны в телескопы.",
    "Капли росы на макро-объективах превратят траву в сказку.",
    "Стартует сезон Млечного Пути — широкоугольник и штатив обязательны.",
    "Созвездие Лебедя в зените — ищите силуэты деревьев на фоне млечных облаков.",
    "Персеиды на пике — настройте длинные выдержки.",
    "Золотая осень разгорается — ловите контровый свет на листьях.",
    "Марс близок к оппозиции — попробуйте съёмку через телескоп.",
    "Фейерверк звёзд Ориона — раннее утро подарит яркие туманности.",
    "Метеорный поток Геминиды раскрасит декабрьское небо.",
  ];
  return highlights[month % highlights.length];
}

export async function generatePhotographyGuideSection(photographyData) {
  if (!photographyData || !photographyData.days?.length) {
    return null;
  }

  const timezone = photographyData.timezone || "Europe/Riga";
  const today = photographyData.days[0];
  const todayLabel = formatDateLabel(today.date, timezone, { weekday: "long", day: "numeric", month: "long" });

  const morningWindow = formatWindow(today.morning.window);
  const eveningWindow = formatWindow(today.evening.window);
  const hasMorningWindow = today.morning?.window?.start != null && today.morning?.window?.end != null;
  const hasEveningWindow = today.evening?.window?.start != null && today.evening?.window?.end != null;
  const hasNightCloud = typeof today.night?.cloud === "number";
  const hasTransparency = typeof today.night?.transparency === "number";
  const hasVisibility = typeof today.night?.visibility === "number";
  const hasMoonData = typeof today.moonPhase === "number" || today.moonrise != null || today.moonset != null;

  if (!hasMorningWindow && !hasEveningWindow && !hasNightCloud && !hasTransparency && !hasVisibility) {
    return null;
  }

  const morningCloud = typeof today.morning?.cloud === "number" ? describeCloud(today.morning.cloud) : null;
  const eveningCloud = typeof today.evening?.cloud === "number" ? describeCloud(today.evening.cloud) : null;
  const nightCloud = hasNightCloud ? describeCloud(today.night.cloud) : null;
  const transparencyText = hasTransparency ? describeTransparency(today.night.transparency) : null;
  const visibilityText = hasVisibility ? describeVisibility(today.night.visibility) : null;
  const moonPhaseText = hasMoonData ? describeMoonPhase(today.moonPhase) : null;
  const milkyWayText = (hasNightCloud || hasTransparency || hasMoonData || hasVisibility)
    ? milkyWayHint(today, timezone)
    : null;
  const starHighlight = pickStarHighlight(today.date);

  const goldenLines = [];
  if (hasMorningWindow) {
    const morningNote = morningCloud || "облачность уточняется";
    goldenLines.push(`• Утро ${morningWindow} — ${morningNote}.`);
  }
  if (hasEveningWindow) {
    const eveningNote = eveningCloud || "облачность уточняется";
    goldenLines.push(`• Вечер ${eveningWindow} — ${eveningNote}.`);
  }

  const nightLines = [];
  if (nightCloud) {
    nightLines.push(`• Облачность: ${nightCloud}.`);
  }
  if (transparencyText || visibilityText) {
    const pieces = [transparencyText, visibilityText].filter(Boolean).join(", ");
    nightLines.push(`• ${pieces}.`);
  }
  if (moonPhaseText) {
    nightLines.push(`• Луна: ${moonPhaseText}.`);
  }
  if (milkyWayText) {
    nightLines.push(`• ${milkyWayText}`);
  }

  const outlookLines = photographyData.days.slice(1).map((day) => {
    const hasWindow = day.evening?.window?.start != null && day.evening?.window?.end != null;
    if (!hasWindow) return null;
    const label = formatDateLabel(day.date, timezone, { weekday: "short", day: "numeric" });
    const evening = formatWindow(day.evening.window);
    const cloudValue = typeof day.evening.cloud === "number" ? describeCloud(day.evening.cloud) : "облачность уточняется";
    return `- ${label}: вечернее окно ${evening}, ${cloudValue}.`;
  }).filter(Boolean);

  const result = [
    "📸 Гид фотографа",
    `${todayLabel.charAt(0).toUpperCase()}${todayLabel.slice(1)}:`,
  ];

  if (goldenLines.length) {
    result.push("Золотые часы:");
    result.push(goldenLines.join("\n"));
  }

  if (nightLines.length) {
    result.push("Ночное небо:");
    result.push(nightLines.join("\n"));
  }

  result.push(`✨ Звезда дня: ${starHighlight}`);

  if (outlookLines.length) {
    result.push("Взгляд на следующие вечера:");
    result.push(outlookLines.join("\n"));
  }

  return result.filter(Boolean).join("\n\n");
}
