import assert from "node:assert/strict";
import test from "node:test";
import { createChatHandler } from "./lib/assistant.mjs";
import {
  COMPOSIO_EXECUTE_URL,
  CalendarApiError,
  isCalendarQuery,
  listCalendarEvents,
  parseCalendarRange,
} from "./services/calendar.service.mjs";

const TEST_DATE = new Date("2026-03-20T12:00:00.000Z");
const DEVICE_TOKEN = "test-device-token-0123456789";
const TIME_ZONE = "America/Argentina/Cordoba";

class MemoryStore {
  values = new Map();

  async get(key) {
    return this.values.get(key) ?? null;
  }

  async set(key, value) {
    this.values.set(key, String(value));
    return "OK";
  }

  async allowDailyRequest(key, limit) {
    const current = Number(this.values.get(key) || 0);
    if (current >= limit) return false;
    this.values.set(key, String(current + 1));
    return true;
  }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status });
}

function createApp({ config, fetchImpl }) {
  const handler = createChatHandler({
    config,
    redis: new MemoryStore(),
    fetchImpl,
    clock: () => new Date(TEST_DATE),
  });
  return async function post(body) {
    const req = {
      method: "POST",
      headers: { authorization: `Bearer ${DEVICE_TOKEN}` },
      body,
    };
    const res = {
      headers: {},
      writeHead(status, headers) {
        this.statusCode = status;
        Object.assign(this.headers, headers);
      },
      end(value) {
        this.body = value;
      },
    };
    await handler(req, res);
    return { status: res.statusCode, json: JSON.parse(res.body) };
  };
}

test("detects read-only calendar questions without hijacking reminders or writes", () => {
  assert.equal(isCalendarQuery("decime qué tengo agendado para el día de hoy"), true);
  assert.equal(isCalendarQuery("¿Qué eventos tengo mañana?"), true);
  assert.equal(isCalendarQuery("mostrame mi calendario de esta semana"), true);
  assert.equal(isCalendarQuery("Agenda de hoy"), true);
  assert.equal(isCalendarQuery("Agenda que todos los miércoles hay descuento en empanadas"), false);
  assert.equal(isCalendarQuery("creá un evento mañana a las 10"), false);
  assert.equal(isCalendarQuery("¿Qué es un amplificador clase D?"), false);
});

test("parses today, tomorrow, week and specific dates in the family timezone", () => {
  const today = parseCalendarRange("qué tengo agendado hoy", TEST_DATE, TIME_ZONE);
  assert.equal(today.startDay, "2026-03-20");
  assert.equal(today.endDay, "2026-03-21");
  assert.equal(today.timeMin, "2026-03-20T00:00:00-03:00");
  assert.equal(today.timeMax, "2026-03-21T00:00:00-03:00");

  const tomorrow = parseCalendarRange("mis reuniones de mañana", TEST_DATE, TIME_ZONE);
  assert.equal(tomorrow.startDay, "2026-03-21");
  assert.equal(tomorrow.endDay, "2026-03-22");

  const week = parseCalendarRange("qué hay esta semana", TEST_DATE, TIME_ZONE);
  assert.equal(week.startDay, "2026-03-20");
  assert.equal(week.endDay, "2026-03-27");

  const specific = parseCalendarRange("mis turnos del 25 de marzo", TEST_DATE, TIME_ZONE);
  assert.equal(specific.startDay, "2026-03-25");
  assert.equal(specific.endDay, "2026-03-26");
});

test("executes the Composio Google Calendar list tool with the expected payload", async () => {
  const calls = [];
  const range = parseCalendarRange("qué tengo hoy", TEST_DATE, TIME_ZONE);
  const result = await listCalendarEvents({
    apiKey: "composio-test-key",
    connectedAccountId: "ca_test_123",
    calendarId: "primary",
    range,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        successful: true,
        data: {
          items: [{
            summary: "Reunión de equipo",
            status: "confirmed",
            start: { dateTime: "2026-03-20T10:00:00-03:00" },
            end: { dateTime: "2026-03-20T11:00:00-03:00" },
            location: "Oficina",
            attendees: [{ email: "ana@example.com" }],
            htmlLink: "https://calendar.google.com/event?eid=1",
          }],
        },
      });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, COMPOSIO_EXECUTE_URL);
  assert.equal(calls[0].options.headers["x-api-key"], "composio-test-key");
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.connected_account_id, "ca_test_123");
  assert.equal(body.arguments.calendarId, "primary");
  assert.equal(body.arguments.timeMin, "2026-03-20T00:00:00-03:00");
  assert.equal(body.arguments.timeMax, "2026-03-21T00:00:00-03:00");
  assert.equal(body.arguments.singleEvents, true);
  assert.equal(body.arguments.orderBy, "startTime");

  assert.equal(result.count, 1);
  assert.equal(result.events[0].summary, "Reunión de equipo");
  assert.equal(result.events[0].allDay, false);
  assert.deepEqual(result.events[0].attendees, ["ana@example.com"]);
});

test("reports an unauthorized connected account", async () => {
  await assert.rejects(
    listCalendarEvents({
      apiKey: "composio-test-key",
      connectedAccountId: "ca_test_123",
      range: parseCalendarRange("hoy", TEST_DATE, TIME_ZONE),
      fetchImpl: async () => jsonResponse({ error: { message: "unauthorized" } }, 401),
    }),
    (error) => error instanceof CalendarApiError && error.code === "calendar_unauthorized",
  );
});

test("injects calendar events into the model prompt for /api/chat", async () => {
  const calls = { composio: [], gemini: [] };
  const config = {
    apiKey: "test-gemini-key",
    deviceToken: DEVICE_TOKEN,
    mobileSessionSecret: "a".repeat(64),
    model: "gemini-3.5-flash-lite",
    searchEnabled: false,
    searchDepth: "basic",
    maxResults: 5,
    monthlyCreditLimit: 900,
    maxDailyRequests: 20,
    composioApiKey: "composio-test-key",
    composioCalendarConnectedAccountId: "ca_test_123",
    composioCalendarId: "primary",
    composioCalendarEnabled: true,
  };
  const post = createApp({
    config,
    fetchImpl: async (url, options) => {
      if (url === COMPOSIO_EXECUTE_URL) {
        calls.composio.push(JSON.parse(options.body));
        return jsonResponse({
          successful: true,
          data: {
            items: [{
              summary: "Reunión de equipo",
              status: "confirmed",
              start: { dateTime: "2026-03-20T10:00:00-03:00" },
              end: { dateTime: "2026-03-20T11:00:00-03:00" },
            }],
          },
        });
      }
      if (url.includes("generativelanguage.googleapis.com")) {
        calls.gemini.push(JSON.parse(options.body));
        return jsonResponse({
          candidates: [{ content: { parts: [{ text: "Hoy tenés una reunión de equipo a las 10." }] } }],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  const result = await post({ question: "decime qué tengo agendado para el día de hoy" });

  assert.equal(result.status, 200);
  assert.equal(result.json.status, "ok");
  assert.equal(calls.composio.length, 1);
  assert.equal(calls.composio[0].arguments.timeMin, "2026-03-20T00:00:00-03:00");
  const prompt = calls.gemini[0].systemInstruction.parts[0].text;
  assert.match(prompt, /Calendario JSON/);
  assert.match(prompt, /Reunión de equipo/);
});

test("does not call Composio when the calendar is not configured", async () => {
  const calls = { gemini: [] };
  const config = {
    apiKey: "test-gemini-key",
    deviceToken: DEVICE_TOKEN,
    mobileSessionSecret: "a".repeat(64),
    model: "gemini-3.5-flash-lite",
    searchEnabled: false,
    searchDepth: "basic",
    maxResults: 5,
    monthlyCreditLimit: 900,
    maxDailyRequests: 20,
    composioCalendarEnabled: false,
  };
  const post = createApp({
    config,
    fetchImpl: async (url, options) => {
      if (url.includes("generativelanguage.googleapis.com")) {
        calls.gemini.push(JSON.parse(options.body));
        return jsonResponse({
          candidates: [{ content: { parts: [{ text: "No puedo acceder al calendario todavía." }] } }],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  const result = await post({ question: "qué tengo agendado hoy" });

  assert.equal(result.status, 200);
  const prompt = calls.gemini[0].systemInstruction.parts[0].text;
  assert.match(prompt, /no está configurada/);
});
