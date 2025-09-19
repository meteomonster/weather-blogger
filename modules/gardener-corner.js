/**
 * gardener-corner.js
 * Формирует раздел "Уголок садовода" с рекомендациями и таблицей недели.
 */

function toDate(iso) {
  return new Date(`${iso}T12:00:00Z`);
}

function formatDateLabel(iso, timezone, options) {
  const date = toDate(iso);
  return new Intl.DateTimeFormat("ru-RU", { timeZone: timezone, ...options }).format(date);
}

function formatTempRange(min, max) {
  if (typeof min !== "number" && typeof max !== "number") return "—";
  const format = (value) => `${value >= 0 ? "+" : ""}${Math.round(value)}°C`;
  if (typeof min === "number" && typeof max === "number") {
    if (Math.abs(max - min) < 1) {
      return format((min + max) / 2);
    }
    return `${format(min)}…${format(max)}`;
  }
  const single = typeof min === "number" ? min : max;
  return format(single);
}

function formatMoistureRange(min, max) {
  if (typeof min !== "number" && typeof max !== "number") return "—";
  const toPercent = (value) => Math.round(value * 100);
  if (typeof min === "number" && typeof max === "number") {
    if (Math.abs(max - min) < 0.02) {
      return `${toPercent((min + max) / 2)}%`;
    }
    return `${toPercent(min)}…${toPercent(max)}%`;
  }
  const single = typeof min === "number" ? min : max;
  return `${toPercent(single)}%`;
}

function formatPercent(value) {
  if (typeof value !== "number") return "—";
  return `${Math.round(value * 100)}%`;
}

function formatList(list) {
  if (!list.length) return "—";
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(", ")} и ${list[list.length - 1]}`;
}

function evaluatePlanting(day) {
  const temp = day.soilTempAvg;
  const moisture = day.soilMoistAvg;
  const precip = day.precipSum ?? 0;
  const precipProb = day.precipProbability ?? 0;

  if (typeof temp !== "number") return { status: "unknown", reason: "нужно проверить термометр" };
  if (temp < 8) return { status: "too_cold", reason: "почва ледяная" };
  if (temp < 10) return { status: "cold", reason: "земля ещё стынет" };
  if (temp > 27) return { status: "too_hot", reason: "почва перегревается" };
  if (typeof moisture === "number" && moisture < 0.16) return { status: "too_dry", reason: "земля пересохла" };
  if (typeof moisture === "number" && moisture > 0.42) return { status: "too_wet", reason: "грядки раскисли" };
  if (precipProb > 70 && precip > 4) return { status: "rainy", reason: "идут проливные дожди" };
  if (precip > 8) return { status: "rainy", reason: "почва размокнет" };
  if (temp >= 12 && temp <= 23 && (!moisture || (moisture >= 0.18 && moisture <= 0.34)) && precip <= 4) {
    return { status: "ideal", reason: "земля тёплая и упругая" };
  }
  if (temp >= 10 && temp <= 25) {
    return { status: "ok", reason: "можно высаживать днём" };
  }
  return { status: "watch", reason: "условия переменчивые" };
}

function evaluateWatering(day) {
  const moisture = day.soilMoistAvg;
  const precip = day.precipSum ?? 0;
  if (typeof moisture !== "number") return { status: "unknown" };
  if (moisture < 0.18 && precip < 2) return { status: "needs", note: "почва просит хорошего полива" };
  if (moisture < 0.24 && precip < 4) return { status: "light", note: "лёгкий вечерний полив" };
  if (moisture > 0.35 || precip > 5) return { status: "skip", note: "влага в норме" };
  return { status: "monitor", note: "наблюдаем" };
}

function buildAction(day, planting, watering, coverAlert) {
  const actions = [];
  if (planting.status === "ideal") actions.push("посадка (земля тёплая)");
  if (planting.status === "ok") actions.push("высадка днём с укрытием на ночь");
  if (planting.status === "cold") actions.push("пока закаляйте рассаду");
  if (planting.status === "too_cold") actions.push("рано высаживать");
  if (planting.status === "too_hot") actions.push("сажайте на рассвете");
  if (planting.status === "too_wet") actions.push("дайте грядкам просохнуть");
  if (planting.status === "too_dry") actions.push("пролейте землю перед посадкой");
  if (planting.status === "rainy") actions.push("перерыв: дожди размягчат землю");

  if (watering.status === "needs") actions.push("полив вечером");
  if (watering.status === "light") actions.push("лёгкий полив из лейки");
  if (watering.status === "skip") actions.push("полив не нужен");

  if (!actions.length) actions.push("наблюдение и прополка");
  if (coverAlert) actions.push("укройте нежные культуры ночью");
  return [...new Set(actions)].join(", ");
}

function collectFolkNotes(day, planting, watering, coverAlert, notesSet) {
  if (typeof day.soilTempAvg === "number" && day.soilTempAvg < 10) {
    notesSet.add("Если почва ниже +10 °C — не сей огурцы, иначе загниют.");
  }
  if (typeof day.soilMoistAvg === "number" && day.soilMoistAvg < 0.15) {
    notesSet.add("Сухая земля шершавит ладони — пора пролить грядки под вечер.");
  }
  if (typeof day.soilMoistAvg === "number" && day.soilMoistAvg > 0.4) {
    notesSet.add("Когда земля липнет к лопате, дай ей просохнуть и прикрой посадки мульчой.");
  }
  if ((day.precipSum ?? 0) > 6) {
    notesSet.add("После проливного дождя почву лучше не тревожить — дай ей день на отдых.");
  }
  if (coverAlert) {
    notesSet.add("Пока ночи холодны, укрывай рассаду лутрасилом — убережёшь от утреннего прихвата.");
  }
  if (typeof day.soilTempAvg === "number" && day.soilTempAvg > 24) {
    notesSet.add("Жаркая почва требует утреннего полива и лёгкой притенки, чтобы корни не сварились.");
  }
}

export async function generateGardenerCornerSection(gardeningData) {
  if (!gardeningData || !gardeningData.days?.length) {
    return "🌿 Уголок садовода: данные о почве временно недоступны.";
  }

  const timezone = gardeningData.timezone || "Europe/Riga";
  const notesSet = new Set();

  const enhanced = gardeningData.days.map((day) => {
    const planting = evaluatePlanting(day);
    const watering = evaluateWatering(day);
    const coverAlert =
      (typeof day.airTempMin === "number" && day.airTempMin < 3) ||
      (typeof day.soilTempMin === "number" && day.soilTempMin < 5);

    collectFolkNotes(day, planting, watering, coverAlert, notesSet);

    return {
      ...day,
      planting,
      watering,
      coverAlert,
      labelShort: formatDateLabel(day.date, timezone, { weekday: "short", day: "numeric", month: "short" }),
      labelLong: formatDateLabel(day.date, timezone, { weekday: "long", day: "numeric", month: "long" }),
      action: buildAction(day, planting, watering, coverAlert),
    };
  });

  const bestPlanting = enhanced.filter((day) => day.planting.status === "ideal").map((day) => day.labelShort);
  const okPlanting = enhanced.filter((day) => day.planting.status === "ok").map((day) => day.labelShort);
  const wateringDays = enhanced
    .filter((day) => day.watering.status === "needs" || day.watering.status === "light")
    .map((day) => day.labelShort);
  const coverDays = enhanced.filter((day) => day.coverAlert).map((day) => day.labelShort);

  const today = enhanced[0];
  const warmest = enhanced.reduce((acc, day) => {
    if (typeof day.soilTempAvg !== "number") return acc;
    if (!acc || (typeof acc.soilTempAvg !== "number" && typeof day.soilTempAvg === "number")) return day;
    if (typeof acc.soilTempAvg !== "number") return day;
    return day.soilTempAvg > acc.soilTempAvg ? day : acc;
  }, null);
  const wettest = enhanced.reduce((acc, day) => {
    if (typeof day.precipSum !== "number") return acc;
    if (!acc || typeof acc.precipSum !== "number") return day;
    return day.precipSum > acc.precipSum ? day : acc;
  }, null);

  const introParts = [];
  if (typeof today.soilTempAvg === "number") {
    introParts.push(
      `Сегодня почва держит ${formatTempRange(today.soilTempMin, today.soilTempMax)} (среднее ${formatTempRange(today.soilTempAvg, today.soilTempAvg)}), влажность около ${formatPercent(today.soilMoistAvg)}.`
    );
  }
  if (warmest && warmest.date !== today.date && typeof warmest.soilTempAvg === "number") {
    introParts.push(`К ${warmest.labelShort} грунт прогреется до ${formatTempRange(warmest.soilTempAvg, warmest.soilTempAvg)} — можно планировать массовые высадки.`);
  }
  if (wettest && wettest.precipSum > 0) {
    introParts.push(`${wettest.labelShort} принесёт ${wettest.precipSum.toFixed(1)} мм осадков, учтите паузу в работах.`);
  }

  const tableHeader = `| День | Почва | Влага | Лучшие действия |\n| --- | --- | --- | --- |`;
  const tableRows = enhanced
    .map((day) => {
      const soilRange = formatTempRange(day.soilTempMin, day.soilTempMax);
      const moistureRange = formatMoistureRange(day.soilMoistMin, day.soilMoistMax);
      return `| ${day.labelShort} | ${soilRange} | ${moistureRange} | ${day.action} |`;
    })
    .join("\n");
  const table = `${tableHeader}\n${tableRows}`;

  const summaryLines = [];
  if (bestPlanting.length) {
    summaryLines.push(`• Лучшие дни для посадок: ${formatList(bestPlanting)}.`);
  } else if (okPlanting.length) {
    summaryLines.push(`• Аккуратные посадки под укрытие возможны: ${formatList(okPlanting)}.`);
  } else {
    summaryLines.push("• С посадками лучше повременить — следим за почвенным теплом.");
  }
  if (wateringDays.length) {
    summaryLines.push(`• Полив стоит запланировать на ${formatList(wateringDays)}.`);
  } else {
    summaryLines.push("• Полив пока не критичен — влага держится в норме.");
  }
  if (coverDays.length) {
    summaryLines.push(`• Укрытие обязательно в ночи ${formatList(coverDays)}.`);
  }

  const folkNotes = Array.from(notesSet);
  const folkBlock = folkNotes.length
    ? `Народные подсказки:\n${folkNotes.map((note) => `- ${note}`).join("\n")}`
    : "";

  const intro = introParts.join(" ") || "На неделе следим за прогревом и влагой почвы, чтобы не упустить комфортное окно.";

  return [`🌿 Уголок садовода`, intro, table, "Главные советы недели:", ...summaryLines, folkBlock].filter(Boolean).join("\n\n");
}
