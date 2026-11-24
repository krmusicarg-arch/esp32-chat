import assert from "node:assert/strict";
import test from "node:test";
import { createMobileSessionToken } from "./lib/mobile_auth.mjs";
import { createReadApiHandler } from "./lib/read_api.mjs";

const NOW = new Date("2026-11-22T12:00:00.000Z");
const SECRET = "s".repeat(64);
const DEVICE_TOKEN = "test-read-device-token-0123456789";
const SPEAKER_ID = "a0b1c2d3-e4f5-4a67-8b90-123456789abc";
const OTHER_ID = "b0b1c2d3-e4f5-4a67-8b90-123456789abc";
const THIRD_ID = "c0b1c2d3-e4f5-4a67-8b90-123456789abc";
const FOURTH_ID = "d0b1c2d3-e4f5-4a67-8b90-123456789abc";
const CONVERSATION_ID = "e0b1c2d3-e4f5-4a67-8b90-123456789abc";

const MEMBERS = [
  { id: SPEAKER_ID, name: "Ana", active: true },
  { id: OTHER_ID, name: "Bruno", active: true },
  { id: THIRD_ID, name: "Carla", active: true },
  { id: FOURTH_ID, name: "Diego", active: true },
];

const CONFIG = {
  deviceToken: DEVICE_TOKEN,
  mobileSessionSecret: SECRET,
  mobileOrigins: ["https://robert.example"],
  familyMemberId: null,
  deviceId: null,
};

function createMockSupabase(overrides = {}) {
  const data = {
    family_settings: [{
      id: 1,
      family_name: "Familia",
      expected_members: 4,
      timezone: "America/Argentina/Buenos_Aires",
      quiet_hours_start: null,
      quiet_hours_end: null,
      max_proactive_messages_per_day: 4,
      proactive_enabled: true,
    }],
    family_members: MEMBERS,
    conversations: [],
    messages: [],
    tasks: [],
    reminders: [],
    memories: [],
    ...overrides,
  };
  const calls = [];
  return {
    calls,
    async select(table, query) {
      calls.push({ table, query });
      return Array.isArray(data[table]) ? data[table].slice() : [];
    },
  };
}

function createResponse() {
  return {
    headers: {},
    writeHead(status, headers = {}) {
      this.statusCode = status;
      Object.assign(this.headers, headers);
    },
    end(value = "") {
      this.body = value;
    },
  };
}

function mobileToken(speakerId = SPEAKER_ID) {
  return createMobileSessionToken(SECRET, speakerId, NOW);
}

function request({ url, method = "GET", token, origin = "https://robert.example" }) {
  return {
    method,
    url,
    headers: {
      origin,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  };
}

function conversationQuery(supabase) {
  return supabase.calls.find((call) => call.table === "conversations");
}

test("rejects read requests without a device or mobile session token", async () => {
  const supabase = createMockSupabase();
  const handler = createReadApiHandler({ config: CONFIG, supabase, clock: () => NOW });
  const res = createResponse();
  await handler(request({ url: "/api/tasks" }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(JSON.parse(res.body).status, "unauthorized");
});

test("rejects non-GET methods on read endpoints", async () => {
  const handler = createReadApiHandler({
    config: CONFIG,
    supabase: createMockSupabase(),
    clock: () => NOW,
  });
  const res = createResponse();
  await handler(request({ url: "/api/tasks", method: "POST", token: DEVICE_TOKEN }), res);
  assert.equal(res.statusCode, 405);
});

test("lists conversations scoped to the mobile session member", async () => {
  const supabase = createMockSupabase({
    conversations: [{
      id: CONVERSATION_ID,
      member_id: SPEAKER_ID,
      channel: "pwa",
      started_at: "2026-11-22T10:00:00.000Z",
      ended_at: null,
      metadata: {},
    }],
  });
  const handler = createReadApiHandler({ config: CONFIG, supabase, clock: () => NOW });
  const res = createResponse();
  await handler(request({ url: "/api/conversations", token: mobileToken() }), res);

  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.conversations.length, 1);
  assert.equal(payload.conversations[0].id, CONVERSATION_ID);
  assert.equal(conversationQuery(supabase).query.get("member_id"), `eq.${SPEAKER_ID}`);
  assert.equal(res.headers["access-control-allow-methods"], "GET, OPTIONS");
});

test("prevents a mobile session from reading another member and enforces conversation ownership", async () => {
  const handler = createReadApiHandler({
    config: CONFIG,
    supabase: createMockSupabase(),
    clock: () => NOW,
  });

  const mismatch = createResponse();
  await handler(request({ url: `/api/tasks?speaker_id=${OTHER_ID}`, token: mobileToken() }), mismatch);
  assert.equal(mismatch.statusCode, 403);
  assert.equal(JSON.parse(mismatch.body).status, "speaker_mismatch");

  const notOwner = createResponse();
  await handler(request({ url: `/api/conversations/messages?conversation_id=${CONVERSATION_ID}`, token: mobileToken() }), notOwner);
  assert.equal(notOwner.statusCode, 403);
  assert.equal(JSON.parse(notOwner.body).status, "invalid_conversation");
});

test("returns conversation messages for an owned conversation", async () => {
  const supabase = createMockSupabase({
    conversations: [{ id: CONVERSATION_ID, member_id: SPEAKER_ID }],
    messages: [
      { role: "user", content: "¿Va a llover?", created_at: "2026-11-22T10:00:00.000Z" },
      { role: "assistant", content: "Sí, más tarde.", created_at: "2026-11-22T10:00:01.000Z" },
    ],
  });
  const handler = createReadApiHandler({ config: CONFIG, supabase, clock: () => NOW });
  const res = createResponse();
  await handler(request({
    url: `/api/conversations/messages?conversation_id=${CONVERSATION_ID}`,
    token: mobileToken(),
  }), res);

  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.messages.length, 2);
  assert.equal(payload.messages[1].content, "Sí, más tarde.");
});

test("requires a speaker for device-token reads and resolves member names", async () => {
  const supabase = createMockSupabase({
    tasks: [{
      id: "f0b1c2d3-e4f5-4a67-8b90-123456789abc",
      description: "Comprar leche",
      status: "pending",
      created_by: SPEAKER_ID,
      assigned_to: OTHER_ID,
      due_at: "2026-11-23T12:00:00.000Z",
      updated_at: "2026-11-22T09:00:00.000Z",
    }],
  });
  const handler = createReadApiHandler({ config: CONFIG, supabase, clock: () => NOW });

  const missingSpeaker = createResponse();
  await handler(request({ url: "/api/tasks", token: DEVICE_TOKEN }), missingSpeaker);
  assert.equal(missingSpeaker.statusCode, 400);
  assert.equal(JSON.parse(missingSpeaker.body).status, "speaker_required");

  const res = createResponse();
  await handler(request({ url: `/api/tasks?speaker_id=${SPEAKER_ID}`, token: DEVICE_TOKEN }), res);
  assert.equal(res.statusCode, 200);
  const task = JSON.parse(res.body).tasks[0];
  assert.equal(task.createdByName, "Ana");
  assert.equal(task.assignedToName, "Bruno");
});

test("returns upcoming reminders for the family", async () => {
  const supabase = createMockSupabase({
    reminders: [{
      id: "10b1c2d3-e4f5-4a67-8b90-123456789abc",
      task_id: null,
      title: "Llamar al médico",
      description: null,
      scheduled_at: "2026-11-22T15:00:00.000Z",
      status: "pending",
      metadata: { origin: "assistant" },
    }],
  });
  const handler = createReadApiHandler({ config: CONFIG, supabase, clock: () => NOW });
  const res = createResponse();
  await handler(request({ url: `/api/reminders?speaker_id=${SPEAKER_ID}`, token: DEVICE_TOKEN }), res);

  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.reminders[0].title, "Llamar al médico");
  assert.equal(payload.reminders[0].scheduledAt, "2026-11-22T15:00:00.000Z");
});

test("builds an agenda with tasks, reminders, birthdays and weather when coordinates are present", async () => {
  const supabase = createMockSupabase({
    tasks: [{ id: "20b1c2d3-e4f5-4a67-8b90-123456789abc", description: "Regar plantas", status: "pending", created_by: SPEAKER_ID }],
    reminders: [{ id: "30b1c2d3-e4f5-4a67-8b90-123456789abc", title: "Turno", scheduled_at: "2026-11-22T16:00:00.000Z", status: "pending" }],
    memories: [{ id: "40b1c2d3-e4f5-4a67-8b90-123456789abc", subject_member_id: OTHER_ID, category: "IMPORTANT_EVENTS", content: "Cumpleaños de Bruno el 5 de diciembre", importance: 5 }],
  });
  const weatherCalls = [];
  const handler = createReadApiHandler({
    config: CONFIG,
    supabase,
    clock: () => NOW,
    weatherSummary: async (latitude, longitude) => {
      weatherCalls.push({ latitude, longitude });
      return { source: "Open-Meteo.com", current: { temperature: 24 }, today: { temperatureMax: 27 } };
    },
  });
  const res = createResponse();
  await handler(request({
    url: `/api/agenda?speaker_id=${SPEAKER_ID}&latitude=-34.6&longitude=-58.4`,
    token: DEVICE_TOKEN,
  }), res);

  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.member.name, "Ana");
  assert.equal(payload.timezone, "America/Argentina/Buenos_Aires");
  assert.equal(payload.tasks.length, 1);
  assert.equal(payload.reminders.length, 1);
  assert.equal(payload.birthdays[0].subjectName, "Bruno");
  assert.equal(payload.weather.current.temperature, 24);
  assert.deepEqual(weatherCalls, [{ latitude: -34.6, longitude: -58.4 }]);
});

test("skips weather in the agenda when coordinates are missing or invalid", async () => {
  let called = false;
  const handler = createReadApiHandler({
    config: CONFIG,
    supabase: createMockSupabase(),
    clock: () => NOW,
    weatherSummary: async () => {
      called = true;
      return { current: {} };
    },
  });
  const res = createResponse();
  await handler(request({
    url: `/api/agenda?speaker_id=${SPEAKER_ID}&latitude=999&longitude=-58.4`,
    token: DEVICE_TOKEN,
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).weather, null);
  assert.equal(called, false);
});
