export const WEATHER_INTENTS = Object.freeze({
  CURRENT: "WEATHER_CURRENT",
  TODAY: "WEATHER_TODAY",
  TOMORROW: "WEATHER_TOMORROW",
  WEEK: "WEATHER_WEEK",
  WEEKEND: "WEATHER_WEEKEND",
  SPECIFIC_DATE: "WEATHER_SPECIFIC_DATE",
  HOURLY: "WEATHER_HOURLY",
  OTHER_LOCATION: "WEATHER_OTHER_LOCATION",
  SEVEN_DAYS: "WEATHER_SEVEN_DAYS",
});

const MONTHS = new Map([
  ["enero", 1], ["febrero", 2], ["marzo", 3], ["abril", 4],
  ["mayo", 5], ["junio", 6], ["julio", 7], ["agosto", 8],
  ["septiembre", 9], ["setiembre", 9], ["octubre", 10],
  ["noviembre", 11], ["diciembre", 12],
]);

export function normalizeWeatherText(text) {
  return typeof text === "string"
    ? text.toLocaleLowerCase("es-AR").normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/\s+/g, " ").trim()
    : "";
}

function extractSpecificDate(text, now) {
  let match = text.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (match) return { date: makeDate(Number(match[1]), Number(match[2]), Number(match[3])), explicitYear: true };

  match = text.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](20\d{2}))?\b/);
  if (match) return {
    date: makeDate(Number(match[3] || now.getUTCFullYear()), Number(match[2]), Number(match[1])),
    explicitYear: Boolean(match[3]),
  };

  match = text.match(/\b(?:el\s+)?(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)(?:\s+de\s+(20\d{2}))?\b/);
  if (match) return {
    date: makeDate(Number(match[3] || now.getUTCFullYear()), MONTHS.get(match[2]), Number(match[1])),
    explicitYear: Boolean(match[3]),
  };
  return null;
}

function makeDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function extractLocation(text) {
  const cues = [...text.matchAll(/\b(?:en|para|de)\s+(?:(?:la|el|los|las)\s+)?/gi)];
  for (const cue of cues.reverse()) {
    let value = text.slice(cue.index + cue[0].length)
      .replace(/[?¿!¡.,;:]+$/g, "")
      .replace(/\b(?:hoy|manana|pasado manana|esta semana|esta tarde|esta noche|el fin de semana|este fin de semana|los proximos? siete dias|los proximos? 7 dias|a las? \d{1,2}(?::\d{2})?\s*(?:hs?|horas?)?)\b.*$/i, "")
      .trim();
    if (!value || /^(?:donde estoy|donde me encuentro|mi ubicacion|mi ciudad|aqui|aca|all[ií]|ahora|hoy|manana|pasado manana|esta tarde|esta noche|esta semana|el fin de semana|este fin de semana)$/i.test(value)) continue;
    if (MONTHS.has(value.toLocaleLowerCase("es-AR"))) continue;
    if (/^(?:clima|tiempo|temperatura|lluvia|viento|humedad|pronostico)\b/i.test(value)) continue;
    return value;
  }
  return "";
}

export function detectWeatherIntent(question, now = new Date()) {
  const normalized = normalizeWeatherText(question);
  const weatherCue = /\b(clima|climatico|meteorolog|pronostico|temperatura|grados|llover|lluvia|llueve|llovizna|nevar|nieve|humedad|viento)\b/.test(normalized)
    || /\bcomo va a estar\b/.test(normalized)
    || /\bque tiempo\b/.test(normalized)
    || /\bcomo (?:esta|va a estar|estara)(?: el)? tiempo\b/.test(normalized)
    || /\bhace (?:el )?tiempo\b/.test(normalized);
  if (!normalized || !weatherCue) return null;

  const specificDate = extractSpecificDate(normalized, now);
  const date = specificDate?.date || null;
  const mentionsHourly = /\b(a las? \d{1,2}(?::\d{2})?\s*(?:hs?|horas?)|por hora|horario|esta manana|esta tarde|esta noche|a la manana|a la tarde|a la noche)\b/.test(normalized);
  const sameDayMorning = /\b(?:esta manana|a la manana|por la manana)\b/.test(normalized);
  const tomorrowMorning = /\bmanana a la manana\b/.test(normalized);
  const offset = /\bpasado manana\b/.test(normalized) ? 2
    : /\bmanana\b/.test(normalized) && (!sameDayMorning || tomorrowMorning) ? 1 : 0;
  let intent;
  if (mentionsHourly) intent = WEATHER_INTENTS.HOURLY;
  else if (date) intent = WEATHER_INTENTS.SPECIFIC_DATE;
  else if (/\b(?:proximos? 7 dias|proximos? siete dias|siguiente semana|proxima semana|toda la semana)\b/.test(normalized)) intent = WEATHER_INTENTS.SEVEN_DAYS;
  else if (/\b(?:fin de semana|finde)\b/.test(normalized)) intent = WEATHER_INTENTS.WEEKEND;
  else if (/\b(?:esta semana|durante la semana|semana)\b/.test(normalized)) intent = WEATHER_INTENTS.WEEK;
  else if (offset === 2) intent = WEATHER_INTENTS.SPECIFIC_DATE;
  else if (offset === 1) intent = WEATHER_INTENTS.TOMORROW;
  else if (/\b(?:actual|actualmente|ahora|en este momento)\b/.test(normalized)) intent = WEATHER_INTENTS.CURRENT;
  else if (/\bhoy\b/.test(normalized)) intent = WEATHER_INTENTS.TODAY;
  else intent = WEATHER_INTENTS.CURRENT;

  const period = intent;
  const location = extractLocation(normalized);
  if (location) intent = WEATHER_INTENTS.OTHER_LOCATION;
  const hourMatch = normalized.match(/\ba las? (\d{1,2})(?::(\d{2}))?\s*(?:hs?|horas?)\b/);
  const timeFrame = /\b(?:esta manana|por la manana|a la manana)\b/.test(normalized) ? "morning"
    : /\b(?:tarde|atardecer)\b/.test(normalized) ? "afternoon"
      : /\b(?:noche|nochecita)\b/.test(normalized) ? "night"
        : null;

  return {
    intent,
    period,
    location,
    date: date || null,
    dateHasExplicitYear: specificDate?.explicitYear || false,
    dayOffset: date ? null : offset,
    hour: hourMatch ? Number(hourMatch[1]) : null,
    minute: hourMatch?.[2] ? Number(hourMatch[2]) : null,
    timeFrame,
  };
}
