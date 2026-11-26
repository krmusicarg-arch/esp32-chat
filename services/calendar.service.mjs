export const CALENDAR_TOOL_SLUG = "GOOGLECALENDAR_EVENTS_LIST";
export const CALENDAR_CREATE_TOOL_SLUG = "GOOGLECALENDAR_CREATE_EVENT";
const COMPOSIO_EXECUTE_BASE = "https://backend.composio.dev/api/v3.1/tools/execute";
export const COMPOSIO_EXECUTE_URL = `${COMPOSIO_EXECUTE_BASE}/${CALENDAR_TOOL_SLUG}`;
export const DEFAULT_TIME_ZONE = "America/Argentina/Cordoba";

const MONTHS = new Map([
  ["enero", 1], ["febrero", 2], ["marzo", 3], ["abril", 4],
  ["mayo", 5], ["junio", 6], ["julio", 7], ["agosto", 8],
  ["septiembre", 9], ["setiembre", 9], ["octubre", 10],
  ["noviembre", 11], ["diciembre", 12],
]);

const WEEKDAYS = new Map([
  ["domingo", 0], ["lunes", 1], ["martes", 2], ["miercoles", 3],
  ["jueves", 4], ["viernes", 5], ["sabado", 6],
]);

const CALENDAR_NOUNS = /\b(calendario|eventos?|reuniones?|turnos?|citas?|compromisos?|agendad[oa]s?)\b/;
const READ_CUES = /\b(que tengo|que hay|decime|dime|mostrame|mostrar|ver|consultar|listar|lista|cuales|cual|cuando|a que hora|horario|horarios)\b/;
const OWN_NOUNS = /\bmi(s)? (calendario|agenda|eventos?|reuniones?|turnos?|citas?|compromisos?)\b/;
const WRITE_VERBS = /\b(crea|crear|creo|agrega|agregar|anade|anota|anotar|programa|programar|mueve|mover|borra|borrar|elimina|eliminar|cancela|cancelar|modifica|modificar|edita|editar|reprograma|reprogramar)\b/;

export class CalendarApiError extends Error {
  constructor(code = "calendar_unavailable", cause = null, details = null) {
    super(code);
    this.name = "CalendarApiError";
    this.code = code;
    if (cause) this.cause = cause;
    if (details) this.details = details;
  }
}

function composioErrorDetails(payload) {
  if (!payload || typeof payload !== "object") return null;
  const safeText = (value) => typeof value === "string"
    ? value.replace(/\bak_[A-Za-z0-9_-]+\b/g, "[REDACTED_API_KEY]").slice(0, 500)
    : null;
  const error = payload.error;
  const data = payload.data;
  const details = {
    ...(safeText(payload.request_id) ? { request_id: safeText(payload.request_id) } : {}),
    ...(safeText(payload.status) ? { status: safeText(payload.status) } : {}),
    ...(safeText(error) ? { error: safeText(error) } : {}),
    ...(error && typeof error === "object" ? {
      ...(safeText(error.code) ? { error_code: safeText(error.code) } : {}),
      ...(safeText(error.message) ? { error_message: safeText(error.message) } : {}),
    } : {}),
    ...(safeText(payload.message) ? { message: safeText(payload.message) } : {}),
    ...(data && typeof data === "object" && safeText(data.message)
      ? { data_message: safeText(data.message) }
      : {}),
  };
  return Object.keys(details).length ? details : null;
}

export function normalizeCalendarText(text) {
  return typeof text === "string"
    ? text.toLocaleLowerCase("es-AR")
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .replace(/\s+/g, " ")
      .trim()
    : "";
}

function hasTimeCue(text) {
  return /\b(hoy|manana|pasado manana|esta semana|semana|fin de semana|proximos? \d+ dias?|lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/.test(text)
    || /\b\d{1,2}[/-]\d{1,2}(?:[/-]20\d{2})?\b/.test(text)
    || /\b\d{1,2}\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\b/.test(text);
}

export function isCalendarQuery(question) {
  const text = normalizeCalendarText(question);
  if (!text) return false;
  if (WRITE_VERBS.test(text)) return false;
  if (/^agenda\b/.test(text)
      && !/^agenda\s+(de|del|para|hoy|manana|pasado|esta|este|mis|el|la|los|las)\b/.test(text)) {
    return false;
  }
  const agendaRead = /^agenda\s+(?:de\s+|del\s+|para\s+)?(?:hoy|manana|pasado manana|esta semana|este fin de semana)\b/.test(text);
  const hasNoun = CALENDAR_NOUNS.test(text) || /\bagenda\b/.test(text);
  const hasRead = READ_CUES.test(text) || OWN_NOUNS.test(text) || agendaRead;
  const hasTime = hasTimeCue(text);
  const looksLikeQuestion = question.includes("?")
    || /^(que|cual|cuales|cuando|donde|como|cuanto|decime|dime|mostrame|lista|listar|ver|consultar)\b/.test(text);
  if (hasNoun && (hasRead || (hasTime && looksLikeQuestion))) return true;
  if (/\bque tengo\b/.test(text) && hasTime) return true;
  return false;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function zonedDateParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return { year: Number(get("year")), month: Number(get("month")), day: Number(get("day")) };
}

function dateToString({ year, month, day }) {
  return `${year}-${pad(month)}-${pad(day)}`;
}

function addDays(dateString, offset) {
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function weekday(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function timeZoneOffset(dateString, timeZone) {
  const guess = new Date(`${dateString}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  }).formatToParts(guess);
  const name = parts.find((part) => part.type === "timeZoneName")?.value || "";
  if (/^GMT[+-]\d{2}:\d{2}$/.test(name)) return name.slice(3);
  if (name === "GMT") return "+00:00";

  const fields = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(guess).map((part) => [part.type, part.value]),
  );
  const asUtc = Date.UTC(
    Number(fields.year),
    Number(fields.month) - 1,
    Number(fields.day),
    Number(fields.hour) === 24 ? 0 : Number(fields.hour),
    Number(fields.minute),
    Number(fields.second),
  );
  const offsetMinutes = Math.round((asUtc - guess.getTime()) / 60000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  return `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

function startOfDay(dateString, timeZone) {
  return `${dateString}T00:00:00${timeZoneOffset(dateString, timeZone)}`;
}

function makeDateString(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return `${year}-${pad(month)}-${pad(day)}`;
}

function extractSpecificDate(text, now, timeZone) {
  const localYear = zonedDateParts(now, timeZone).year;
  let match = text.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (match) return makeDateString(Number(match[1]), Number(match[2]), Number(match[3]));

  match = text.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](20\d{2}))?\b/);
  if (match) return makeDateString(Number(match[3] || localYear), Number(match[2]), Number(match[1]));

  match = text.match(/\b(?:el\s+)?(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)(?:\s+de\s+(20\d{2}))?\b/);
  if (match) return makeDateString(Number(match[3] || localYear), MONTHS.get(match[2]), Number(match[1]));
  return null;
}

export function parseCalendarRange(question, now = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const text = normalizeCalendarText(question);
  const today = dateToString(zonedDateParts(now, timeZone));
  let start = today;
  let end = addDays(today, 1);
  let label = "hoy";

  const weekdays = text.match(/\b(domingo|lunes|martes|miercoles|jueves|viernes|sabado)\b/);
  const specific = extractSpecificDate(text, now, timeZone);

  if (/\bpasado manana\b/.test(text)) {
    start = addDays(today, 2);
    end = addDays(start, 1);
    label = "pasado mañana";
  } else if (/\besta manana\b/.test(text)) {
    label = "hoy";
  } else if (/\bfin de semana\b/.test(text)) {
    const day = weekday(today);
    const untilSaturday = (6 - day + 7) % 7;
    start = addDays(today, untilSaturday);
    end = addDays(start, 2);
    label = "este fin de semana";
  } else if (/\b(?:esta\s+)?semana\b/.test(text)) {
    start = today;
    end = addDays(today, 7);
    label = "esta semana";
  } else if (/\bproximos?\s+(\d+)\s+dias?\b/.test(text)) {
    const days = Math.min(31, Math.max(1, Number(text.match(/\bproximos?\s+(\d+)\s+dias?\b/)[1])));
    start = today;
    end = addDays(today, days);
    label = `próximos ${days} días`;
  } else if (/\bmanana\b/.test(text)) {
    start = addDays(today, 1);
    end = addDays(start, 1);
    label = "mañana";
  } else if (specific) {
    start = specific;
    end = addDays(specific, 1);
    label = specific;
  } else if (weekdays) {
    const target = WEEKDAYS.get(weekdays[1]);
    const current = weekday(today);
    let delta = (target - current + 7) % 7;
    if (delta === 0 && /\b(proximo|que viene)\b/.test(text)) delta = 7;
    start = addDays(today, delta);
    end = addDays(start, 1);
    label = weekdays[1];
  }

  return {
    startDay: start,
    endDay: end,
    label,
    timeZone,
    timeMin: startOfDay(start, timeZone),
    timeMax: startOfDay(end, timeZone),
  };
}

function findEvents(data) {
  if (typeof data === "string") {
    try {
      return findEvents(JSON.parse(data));
    } catch {
      return [];
    }
  }
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  if (Array.isArray(data.items)) return data.items;
  if (Array.isArray(data.events)) return data.events;
  if (data.response_data) return findEvents(data.response_data);
  if (data.data) return findEvents(data.data);
  return [];
}

function truncate(value, maximum) {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) return null;
  return trimmed.length > maximum ? `${trimmed.slice(0, maximum - 1)}…` : trimmed;
}

function summarizeEvent(event) {
  const start = event?.start?.dateTime || event?.start?.date || null;
  const end = event?.end?.dateTime || event?.end?.date || null;
  return {
    summary: truncate(event?.summary, 200) || "(sin título)",
    start,
    end,
    allDay: Boolean(event?.start?.date),
    location: truncate(event?.location, 160),
    description: truncate(event?.description, 280),
    status: typeof event?.status === "string" ? event.status : null,
    attendees: Array.isArray(event?.attendees)
      ? event.attendees.map((attendee) => attendee?.email).filter(Boolean).slice(0, 10)
      : [],
    link: typeof event?.htmlLink === "string" ? event.htmlLink : null,
  };
}

export async function listCalendarEvents({
  apiKey,
  connectedAccountId = null,
  userId = null,
  calendarId = "primary",
  range,
  fetchImpl = fetch,
}) {
  if (!apiKey || (!connectedAccountId && !userId)) {
    throw new CalendarApiError("calendar_not_configured");
  }
  if (connectedAccountId && !userId) {
    throw new CalendarApiError("calendar_user_id_required");
  }

  const body = {
    ...(connectedAccountId ? { connected_account_id: connectedAccountId } : {}),
    ...(userId ? { user_id: userId } : {}),
    arguments: {
      calendarId: calendarId || "primary",
      timeMin: range.timeMin,
      timeMax: range.timeMax,
      timeZone: range.timeZone,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 50,
      fields: "items(id,status,summary,description,location,start,end,attendees,hangoutLink,htmlLink,eventType,transparency),nextPageToken",
    },
  };

  let response;
  try {
    response = await fetchImpl(COMPOSIO_EXECUTE_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    throw new CalendarApiError("calendar_unavailable", error);
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const code = response.status === 401 || response.status === 403
      ? "calendar_unauthorized"
      : "calendar_unavailable";
    throw new CalendarApiError(code, null, {
      http_status: response.status,
      ...(composioErrorDetails(payload) || {}),
    });
  }
  if (payload?.successful === false || payload?.error) {
    throw new CalendarApiError("calendar_error", null, composioErrorDetails(payload));
  }

  const events = findEvents(payload?.data)
    .filter((event) => event?.status !== "cancelled")
    .slice(0, 50)
    .map(summarizeEvent);

  return {
    label: range.label,
    timeZone: range.timeZone,
    timeMin: range.timeMin,
    timeMax: range.timeMax,
    count: events.length,
    events,
  };
}

export async function createGoogleCalendarEvent({
  apiKey,
  integration,
  event,
  timeZone = DEFAULT_TIME_ZONE,
  fetchImpl = fetch,
}) {
  if (!apiKey) throw new CalendarApiError("calendar_not_configured");
  if (!integration?.connected_account_id || !integration?.composio_user_id) {
    throw new CalendarApiError("calendar_connection_incomplete");
  }
  if (!event?.summary || !event?.startAt || !Number.isInteger(event?.durationMinutes)
      || event.durationMinutes < 1 || event.durationMinutes > 24 * 60) {
    throw new CalendarApiError("calendar_event_invalid");
  }
  const hours = Math.floor(event.durationMinutes / 60);
  const minutes = event.durationMinutes % 60;
  const body = {
    connected_account_id: integration.connected_account_id,
    user_id: integration.composio_user_id,
    version: "latest",
    arguments: {
      calendar_id: integration.calendar_id || "primary",
      summary: event.summary.slice(0, 200),
      ...(event.description ? { description: event.description.slice(0, 500) } : {}),
      start_datetime: event.startAt,
      timezone: timeZone,
      event_duration_hour: hours,
      event_duration_minutes: minutes,
      send_updates: "none",
    },
  };
  let response;
  try {
    response = await fetchImpl(`${COMPOSIO_EXECUTE_BASE}/${CALENDAR_CREATE_TOOL_SLUG}`, {
      method: "POST",
      headers: { "x-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    throw new CalendarApiError("calendar_unavailable", error);
  }
  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok || payload?.successful === false || payload?.error) {
    const code = response.status === 401 || response.status === 403
      ? "calendar_unauthorized" : "calendar_unavailable";
    throw new CalendarApiError(code, null, {
      http_status: response.status,
      ...(composioErrorDetails(payload) || {}),
    });
  }
  const data = payload?.data && typeof payload.data === "object" ? payload.data : payload;
  const eventData = data?.response_data && typeof data.response_data === "object"
    ? data.response_data : data;
  console.info("[Google Calendar] event persisted:", JSON.stringify({
    family_member_id: integration.family_member_id,
    connected_account_id: integration.connected_account_id,
    calendar_id: integration.calendar_id || "primary",
    summary: event.summary.slice(0, 200),
    start_at: event.startAt,
    duration_minutes: event.durationMinutes,
    event_id: typeof eventData?.id === "string" ? eventData.id : null,
    html_link: typeof eventData?.htmlLink === "string" ? eventData.htmlLink : null,
  }));
  return eventData;
}
