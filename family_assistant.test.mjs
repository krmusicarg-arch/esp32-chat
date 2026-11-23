import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createChatHandler } from "./lib/assistant.mjs";
import { createFamilyApiHandler } from "./lib/family_api.mjs";
import { createMobileSessionToken } from "./lib/mobile_auth.mjs";
import { createSupabaseClient } from "./database/supabase.mjs";

const DEVICE_TOKEN = "test-device-token-0123456789";
const MEMBER_IDS = [
  "a0b1c2d3-e4f5-4a67-8b90-123456789abc",
  "b1c2d3e4-f5a6-4789-8b01-23456789abcd",
  "c2d3e4f5-a6b7-4890-8c12-3456789abcde",
  "d3e4f5a6-b7c8-4901-8d23-456789abcdef",
];
const TASK_ID = "e4f5a6b7-c8d9-4012-8e34-56789abcdef0";
const CLOSED_TASK_ID = "f5a6b7c8-d9e0-4123-8f45-6789abcdef01";
const REMINDER_ID = "a6b7c8d9-e0f1-4234-8a56-789abcdef012";
const CONFIG = {
  apiKey: "test-gemini-key",
  tavilyApiKey: "test-tavily-key",
  deviceToken: DEVICE_TOKEN,
  mobileSessionSecret: "a".repeat(64),
  familyMemberId: null,
  deviceId: null,
  model: "gemini-3.5-flash-lite",
  searchEnabled: true,
  searchDepth: "basic",
  maxResults: 5,
  monthlyCreditLimit: 900,
  maxDailyRequests: 20,
};

class MemoryRedis {
  values = new Map();

  async allowDailyRequest(key, limit) {
    const count = Number(this.values.get(key) || 0);
    if (count >= limit) return false;
    this.values.set(key, String(count + 1));
    return true;
  }

  async get(key) {
    return this.values.get(key) ?? null;
  }
}

class MemorySupabase {
  tables = {
    family_settings: [{
      id: 1,
      family_name: "Los Ruiz",
      expected_members: 4,
      timezone: "America/Argentina/Cordoba",
      quiet_hours_start: "22:30:00",
      quiet_hours_end: "08:00:00",
      max_proactive_messages_per_day: 2,
      proactive_enabled: true,
    }],
    family_members: MEMBER_IDS.map((id, index) => ({
      id,
      name: ["Ana", "Luis", "Sofía", "Tomás"][index],
      active: true,
      profile: {},
    })),
    devices: [],
    conversations: [],
    messages: [],
    memories: [{
      id: "b7c8d9e0-f1a2-4345-8b67-89abcdef0123",
      subject_member_id: null,
      category: "PREFERENCES",
      content: "La familia prefiere leche sin lactosa.",
      importance: 4,
      confidence: 0.9,
      active: true,
      metadata: { provided_by_member_id: MEMBER_IDS[1] },
    }],
    tasks: [
      { id: TASK_ID, description: "Llamar al dentista", status: "pending" },
      { id: CLOSED_TASK_ID, description: "Reservar turno", status: "completed" },
    ],
    reminders: [{
      id: REMINDER_ID,
      task_id: TASK_ID,
      title: "Llevar paraguas",
      description: "",
      scheduled_at: "2026-03-21T12:00:00.000Z",
      status: "pending",
      metadata: {},
    }],
    preferences: [],
    emotional_context: [],
    projects: [],
    proactive_followups: [],
    task_history: [],
    notification_deliveries: [],
  };
  rpcCalls = [];

  async select(table, query = new URLSearchParams()) {
    let rows = [...(this.tables[table] || [])];
    for (const [key, condition] of query.entries()) {
      if (key === "select" || key === "order" || key === "limit" || key === "or") continue;
      if (condition.startsWith("eq.")) {
        const value = condition.slice(3);
        rows = rows.filter((row) => String(row[key]) === value);
      } else if (condition.startsWith("in.(")) {
        const values = condition.slice(4, -1).split(",");
        rows = rows.filter((row) => values.includes(String(row[key])));
      } else if (condition.startsWith("lte.")) {
        const value = condition.slice(4);
        rows = rows.filter((row) => String(row[key]) <= value);
      }
    }
    if (query.has("limit")) rows = rows.slice(0, Number(query.get("limit")));
    return rows;
  }

  async insert(table, rows) {
    const inserted = Array.isArray(rows) ? rows : [rows];
    this.tables[table].push(...inserted);
    return inserted;
  }

  async update(table, query, values) {
    const id = query.get("id")?.slice(3);
    const status = query.get("status");
    const rows = this.tables[table].filter((row) => (
      (!id || row.id === id)
      && (!query.get("member_id") || row.member_id === query.get("member_id").slice(3))
      && (!status || row.status === status.slice(3))
    ));
    for (const row of rows) Object.assign(row, values);
    return rows;
  }

  async rpc(name, args) {
    this.rpcCalls.push({ name, args });
    if (name === "save_family_preference") {
      const current = this.tables.preferences.find((item) => (
        item.member_id === args.p_member_id
        && item.category.toLowerCase() === args.p_category.toLowerCase()
        && item.active
      ));
      if (current && JSON.stringify(current.value) === JSON.stringify(args.p_value)) {
        Object.assign(current, {
          confidence: args.p_confidence,
          source_message_id: args.p_source_message_id,
        });
        return current.id;
      }
      if (current) current.active = false;
      const preference = {
        id: randomUUID(),
        member_id: args.p_member_id,
        category: args.p_category,
        value: args.p_value,
        confidence: args.p_confidence,
        source_message_id: args.p_source_message_id,
        active: true,
      };
      this.tables.preferences.push(preference);
      return preference.id;
    }
    if (name === "save_family_emotional_context") {
      const current = this.tables.emotional_context.find((item) => (
        item.member_id === args.p_member_id
        && item.situation.toLowerCase() === args.p_situation.toLowerCase()
        && item.status === "active"
      ));
      if (current) {
        Object.assign(current, {
          context: args.p_context,
          source_message_id: args.p_source_message_id,
        });
        return current.id;
      }
      const context = {
        id: randomUUID(),
        member_id: args.p_member_id,
        situation: args.p_situation,
        context: args.p_context,
        status: "active",
        source_message_id: args.p_source_message_id,
      };
      this.tables.emotional_context.push(context);
      return context.id;
    }
    if (name === "save_family_followup") {
      const existing = this.tables.proactive_followups.find((item) => (
        item.member_id === args.p_member_id
        && item.question.toLocaleLowerCase("es-AR")
          === args.p_question.toLocaleLowerCase("es-AR")
        && ["pending", "sent"].includes(item.status)
      ));
      if (existing) return existing.id;
      const followup = {
        id: randomUUID(),
        member_id: args.p_member_id,
        memory_id: args.p_memory_id,
        question: args.p_question,
        scheduled_at: args.p_scheduled_at,
        status: "pending",
      };
      this.tables.proactive_followups.push(followup);
      return followup.id;
    }
    if (name === "transition_family_followup") {
      const followup = this.tables.proactive_followups.find((item) => (
        item.id === args.p_followup_id && item.member_id === args.p_member_id
      ));
      if (!followup) return false;
      if (["pending", "sent"].includes(followup.status)) {
        followup.status = args.p_new_status;
      }
      return true;
    }
    if (name === "save_family_memory") {
      const memory = {
        id: args.p_memory_id || randomUUID(),
        subject_member_id: args.p_subject_member_id,
        category: args.p_category,
        content: args.p_content,
        importance: args.p_importance,
        confidence: args.p_confidence,
        source_message_id: args.p_source_message_id,
        active: true,
        metadata: { provided_by_member_id: args.p_changed_by },
      };
      this.tables.memories.push(memory);
      return memory.id;
    }
    if (name === "create_family_task") {
      const task = {
        id: randomUUID(),
        description: args.p_description,
        status: "pending",
        created_by: args.p_created_by,
        assigned_to: args.p_assigned_to,
        due_at: args.p_due_at,
      };
      this.tables.tasks.push(task);
      return task.id;
    }
    if (name === "save_family_project") {
      const project = this.tables.projects.find((item) => item.id === args.p_project_id);
      if (project) {
        Object.assign(project, {
          name: args.p_name,
          owner_member_id: args.p_owner_member_id,
          next_step: args.p_next_step,
        });
        return project.id;
      }
      const created = {
        id: randomUUID(),
        name: args.p_name,
        owner_member_id: args.p_owner_member_id,
        status: "active",
        next_step: args.p_next_step,
      };
      this.tables.projects.push(created);
      return created.id;
    }
    if (name === "transition_family_task") {
      const task = this.tables.tasks.find((item) => item.id === args.p_task_id);
      if (task) task.status = args.p_new_status;
      this.tables.task_history.push(args);
      return { changed: Boolean(task) };
    }
    if (name === "create_family_reminder") {
      const reminder = {
        id: randomUUID(),
        task_id: args.p_task_id,
        title: args.p_title,
        description: args.p_description,
        scheduled_at: args.p_scheduled_at,
        status: "pending",
        metadata: args.p_metadata,
      };
      this.tables.reminders.push(reminder);
      for (const member of this.tables.family_members) {
        this.tables.notification_deliveries.push({
          reminder_id: reminder.id,
          member_id: member.id,
          channel: "esp32",
          delivery_status: "pending",
        });
      }
      return reminder.id;
    }
    if (name === "cancel_family_reminder") {
      const reminder = this.tables.reminders.find((item) => item.id === args.p_reminder_id);
      if (reminder) reminder.status = "cancelled";
      return Boolean(reminder);
    }
    if (name === "claim_due_notifications") return [];
    if (name === "ack_notification_delivery") return true;
    throw new Error(`Unexpected RPC: ${name}`);
  }
}

function createFetch(update = {}, { onExtraction } = {}) {
  const calls = { gemini: [], extraction: [] };
  const familyUpdate = {
    memories: [{
      memoryId: null,
      subjectMemberId: MEMBER_IDS[1],
      category: "LIKES",
      content: "Luis prefiere leche sin lactosa.",
      importance: 4,
      confidence: 0.9,
      reason: "Lo compartió claramente.",
    }],
    preferences: [{
      category: "alimentación",
      value: "sin lactosa",
      confidence: 0.9,
    }],
    emotionalContext: [],
    projects: [{
      projectId: null,
      name: "Huerta familiar",
      description: "Preparar el terreno",
      status: "active",
      nextStep: "Comprar semillas",
      ownerMemberId: MEMBER_IDS[2],
    }],
    tasks: [{
      description: "Comprar leche sin lactosa",
      assignedTo: MEMBER_IDS[3],
      dueAt: null,
    }],
    reminders: [{
      title: "Comprar leche",
      description: "Leche sin lactosa",
      taskId: null,
      scheduledAt: "2026-03-21T12:00:00.000Z",
    }],
    completedTaskIds: [TASK_ID],
    reopenedTaskIds: [CLOSED_TASK_ID],
    completedReminderIds: [REMINDER_ID],
    followups: [],
    completedFollowupIds: [],
    cancelledFollowupIds: [],
    subjectMemberId: MEMBER_IDS[1],
    clarificationQuestion: "",
    ...update,
  };
  const fetchImpl = async (url, options) => {
    assert.match(String(url), /generativelanguage\.googleapis\.com/);
    const body = JSON.parse(options.body);
    if (body.generationConfig.responseMimeType === "application/json") {
      calls.extraction.push(body);
      if (onExtraction) return onExtraction(body, calls);
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify(familyUpdate) }] } }],
      }));
    }
    calls.gemini.push(body);
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: "De acuerdo, lo anoto." }] } }],
    }));
  };
  return { calls, fetchImpl };
}

function createResponse() {
  return {
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
}

test("selected speaker is validated and persisted with author, subject and source", async () => {
  const supabase = new MemorySupabase();
  const { calls, fetchImpl } = createFetch();
  const handler = createChatHandler({
    config: CONFIG,
    redis: new MemoryRedis(),
    supabase,
    fetchImpl,
    clock: () => new Date("2026-03-20T12:00:00.000Z"),
  });
  const res = createResponse();

  await handler({
    method: "POST",
    headers: { authorization: `Bearer ${DEVICE_TOKEN}` },
    body: {
      question: "Anota que Luis prefiere leche sin lactosa, agregá la tarea de comprar leche y actualiza el proyecto Huerta.",
      history: [],
      speaker_id: MEMBER_IDS[0],
    },
  }, res);

  const payload = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(payload.status, "ok");
  assert.equal(payload.answer, "De acuerdo, lo anoto.");
  assert.match(payload.conversation_id, /^[0-9a-f-]{36}$/i);
  assert.equal(supabase.tables.conversations[0].member_id, MEMBER_IDS[0]);
  const userMessage = supabase.tables.messages.find((message) => message.role === "user");
  assert.equal(userMessage.sender_member_id, MEMBER_IDS[0]);
  assert.equal(userMessage.subject_member_id, MEMBER_IDS[1]);
  assert.equal(
    supabase.tables.memories.at(-1).metadata.provided_by_member_id,
    MEMBER_IDS[0],
  );
  assert.equal(
    supabase.tables.memories.at(-1).source_message_id,
    userMessage.id,
  );
  assert.equal(supabase.rpcCalls.find((call) => call.name === "save_family_project")
    .args.p_owner_member_id, MEMBER_IDS[2]);
  assert.equal(supabase.rpcCalls.find((call) => call.name === "create_family_task")
    .args.p_assigned_to, MEMBER_IDS[3]);
  assert.ok(supabase.rpcCalls.some((call) => (
    call.name === "transition_family_task"
      && call.args.p_new_status === "completed"
      && call.args.p_member_id === MEMBER_IDS[0]
  )));
  assert.ok(supabase.rpcCalls.some((call) => (
    call.name === "transition_family_task"
      && call.args.p_new_status === "pending"
      && call.args.p_member_id === MEMBER_IDS[0]
  )));
  assert.equal(calls.extraction.length, 1);
  assert.equal(calls.extraction[0].generationConfig.temperature, 0);
  assert.equal(calls.extraction[0].generationConfig.maxOutputTokens, 1024);
  assert.match(calls.gemini[0].systemInstruction.parts[0].text, /America\/Argentina\/Cordoba/);
});

test("a family member can retrieve a relevant memory whose subject is another member", async () => {
  const supabase = new MemorySupabase();
  supabase.tables.memories.push({
    id: randomUUID(),
    subject_member_id: MEMBER_IDS[2],
    category: "LIKES",
    content: "A Sofía le gusta escuchar rock.",
    importance: 4,
    confidence: 0.95,
    active: true,
    valid_until: null,
    metadata: { provided_by_member_id: MEMBER_IDS[1] },
  });
  const { fetchImpl, calls } = createFetch({
    memories: [], preferences: [], emotionalContext: [], projects: [], tasks: [], reminders: [],
    completedTaskIds: [], reopenedTaskIds: [], completedReminderIds: [], followups: [],
    completedFollowupIds: [], cancelledFollowupIds: [], subjectMemberId: null,
  });
  const handler = createChatHandler({
    config: CONFIG,
    redis: new MemoryRedis(),
    supabase,
    fetchImpl,
  });
  const res = createResponse();
  await handler({
    method: "POST",
    headers: { authorization: `Bearer ${DEVICE_TOKEN}` },
    body: { question: "¿Qué música le gusta a Sofía?", speaker_id: MEMBER_IDS[0] },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.match(calls.gemini[0].systemInstruction.parts[0].text, /A Sofía le gusta escuchar rock/);
  assert.match(calls.gemini[0].systemInstruction.parts[0].text, /visibles para todos los integrantes/);
});

test("a clear correction updates the matching memory instead of adding a new fact", async () => {
  const supabase = new MemorySupabase();
  const memoryId = randomUUID();
  supabase.tables.memories.push({
    id: memoryId,
    subject_member_id: MEMBER_IDS[2],
    category: "LIKES",
    content: "A Sofía le gusta escuchar pop.",
    importance: 4,
    confidence: 0.95,
    active: true,
    valid_until: null,
    metadata: {},
  });
  const { fetchImpl } = createFetch({
    memories: [{
      memoryId,
      subjectMemberId: MEMBER_IDS[2],
      category: "LIKES",
      content: "A Sofía le gusta escuchar rock.",
      importance: 4,
      confidence: 1,
      reason: "Sofía corrigió el dato.",
    }],
    preferences: [], emotionalContext: [], projects: [], tasks: [], reminders: [],
    completedTaskIds: [], reopenedTaskIds: [], completedReminderIds: [], followups: [],
    completedFollowupIds: [], cancelledFollowupIds: [], subjectMemberId: MEMBER_IDS[2],
  });
  const handler = createChatHandler({
    config: CONFIG,
    redis: new MemoryRedis(),
    supabase,
    fetchImpl,
  });
  const res = createResponse();
  await handler({
    method: "POST",
    headers: { authorization: `Bearer ${DEVICE_TOKEN}` },
    body: {
      question: "Corrijo el dato de Sofía: ahora le gusta escuchar rock, no pop.",
      speaker_id: MEMBER_IDS[0],
    },
  }, res);

  const savedMemory = supabase.rpcCalls.find((call) => call.name === "save_family_memory");
  assert.equal(res.statusCode, 200);
  assert.equal(savedMemory.args.p_memory_id, memoryId);
  assert.equal(savedMemory.args.p_content, "A Sofía le gusta escuchar rock.");
});

test("exact duplicate memories are not saved again", async () => {
  const supabase = new MemorySupabase();
  supabase.tables.memories.push({
    id: randomUUID(),
    subject_member_id: MEMBER_IDS[2],
    category: "LIKES",
    content: "A Sofía le gusta escuchar rock.",
    importance: 4,
    confidence: 0.95,
    active: true,
    valid_until: null,
    metadata: {},
  });
  const { fetchImpl } = createFetch({
    memories: [{
      memoryId: null,
      subjectMemberId: MEMBER_IDS[2],
      category: "LIKES",
      content: "A Sofía le gusta escuchar rock.",
      importance: 4,
      confidence: 0.95,
    }],
    preferences: [], emotionalContext: [], projects: [], tasks: [], reminders: [],
    completedTaskIds: [], reopenedTaskIds: [], completedReminderIds: [], followups: [],
    completedFollowupIds: [], cancelledFollowupIds: [], subjectMemberId: null,
  });
  const handler = createChatHandler({ config: CONFIG, redis: new MemoryRedis(), supabase, fetchImpl });
  const res = createResponse();
  await handler({
    method: "POST",
    headers: { authorization: `Bearer ${DEVICE_TOKEN}` },
    body: { question: "A Sofía le gusta escuchar rock.", speaker_id: MEMBER_IDS[0] },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(supabase.rpcCalls.filter((call) => call.name === "save_family_memory").length, 0);
});

test("casual reports do not create tasks or reminders", async () => {
  const supabase = new MemorySupabase();
  const { fetchImpl } = createFetch();
  const handler = createChatHandler({ config: CONFIG, redis: new MemoryRedis(), supabase, fetchImpl });
  const res = createResponse();
  await handler({
    method: "POST",
    headers: { authorization: `Bearer ${DEVICE_TOKEN}` },
    body: { question: "Hoy fui al supermercado y me crucé con una vecina.", speaker_id: MEMBER_IDS[0] },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(supabase.rpcCalls.some((call) => call.name === "create_family_task"), false);
  assert.equal(supabase.rpcCalls.some((call) => call.name === "create_family_reminder"), false);
});

test("chat returns after conversation persistence while Vercel schedules knowledge extraction", async () => {
  const supabase = new MemorySupabase();
  let markExtractionStarted;
  const extractionStarted = new Promise((resolve) => { markExtractionStarted = resolve; });
  let finishExtraction;
  const extractionGate = new Promise((resolve) => { finishExtraction = resolve; });
  const { fetchImpl } = createFetch({}, {
    onExtraction: async () => {
      markExtractionStarted();
      await extractionGate;
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify({
          memories: [], preferences: [], emotionalContext: [], projects: [], tasks: [], reminders: [],
          completedTaskIds: [], reopenedTaskIds: [], completedReminderIds: [], followups: [],
          completedFollowupIds: [], cancelledFollowupIds: [], subjectMemberId: null,
          clarificationQuestion: "",
        }) }] } }],
      }));
    },
  });
  const scheduled = [];
  const handler = createChatHandler({
    config: CONFIG,
    redis: new MemoryRedis(),
    supabase,
    fetchImpl,
    scheduleBackground: (promise) => scheduled.push(promise),
  });
  const res = createResponse();
  await handler({
    method: "POST",
    headers: { authorization: `Bearer ${DEVICE_TOKEN}` },
    body: { question: "Hola", speaker_id: MEMBER_IDS[0] },
  }, res);
  await extractionStarted;

  const payload = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(payload.answer, "De acuerdo, lo anoto.");
  assert.equal(supabase.tables.messages.length, 2);
  assert.equal(scheduled.length, 1);

  finishExtraction();
  await scheduled[0];
});

test("conversation response survives a background knowledge extraction failure", async () => {
  const supabase = new MemorySupabase();
  const { fetchImpl } = createFetch({}, {
    onExtraction: async () => { throw new Error("mock extraction failure"); },
  });
  const scheduled = [];
  const handler = createChatHandler({
    config: CONFIG,
    redis: new MemoryRedis(),
    supabase,
    fetchImpl,
    scheduleBackground: (promise) => scheduled.push(promise),
  });
  const res = createResponse();
  await handler({
    method: "POST",
    headers: { authorization: `Bearer ${DEVICE_TOKEN}` },
    body: { question: "Hola", speaker_id: MEMBER_IDS[0] },
  }, res);
  await scheduled[0];

  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).answer, "De acuerdo, lo anoto.");
  assert.equal(supabase.tables.messages.length, 2);
});

test("mobile chat uses the selected family member without requiring an active ESP32", async () => {
  const supabase = new MemorySupabase();
  const { fetchImpl } = createFetch({
    memories: [],
    preferences: [],
    projects: [],
    tasks: [],
    completedTaskIds: [],
    reopenedTaskIds: [],
    completedReminderIds: [],
    subjectMemberId: null,
  });
  const deviceId = "e0f1a2b3-c4d5-4678-8a90-123456789abc";
  const config = { ...CONFIG, deviceId };
  const handler = createChatHandler({
    config,
    redis: new MemoryRedis(),
    supabase,
    fetchImpl,
    clock: () => new Date("2026-03-20T12:00:00.000Z"),
  });
  const res = createResponse();
  const token = createMobileSessionToken(
    config.mobileSessionSecret,
    MEMBER_IDS[0],
    new Date("2026-03-20T12:00:00.000Z"),
  );

  await handler({
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: { question: "Hola" },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(supabase.tables.devices.length, 0);
  assert.equal(supabase.tables.conversations[0].member_id, MEMBER_IDS[0]);
});

test("existing projects are updated and proactive follow-ups are persisted without duplication", async () => {
  const supabase = new MemorySupabase();
  const projectId = randomUUID();
  supabase.tables.projects.push({
    id: projectId,
    name: "Huerta familiar",
    status: "active",
    owner_member_id: MEMBER_IDS[2],
    next_step: "Comprar semillas",
  });
  const { fetchImpl } = createFetch({
    projects: [{
      projectId: null,
      name: "Huerta familiar",
      description: "Preparar el terreno",
      nextStep: "Regar las plantas",
      ownerMemberId: MEMBER_IDS[2],
    }],
    followups: [{
      memberId: MEMBER_IDS[0],
      memoryId: null,
      question: "¿Cómo sigue la huerta?",
      scheduledAt: "2026-03-22T12:00:00.000Z",
    }],
    completedFollowupIds: [],
    cancelledFollowupIds: [],
  });
  const handler = createChatHandler({
    config: CONFIG,
    redis: new MemoryRedis(),
    supabase,
    fetchImpl,
    clock: () => new Date("2026-03-20T12:00:00.000Z"),
  });
  const res = createResponse();
  await handler({
    method: "POST",
    headers: { authorization: `Bearer ${DEVICE_TOKEN}` },
    body: {
      question: "La huerta va bien, después preguntame cómo sigue.",
      speaker_id: MEMBER_IDS[0],
    },
  }, res);

  assert.equal(res.statusCode, 200);
  const projectCall = supabase.rpcCalls.find((call) => call.name === "save_family_project");
  assert.equal(projectCall.args.p_project_id, projectId);
  assert.equal(supabase.tables.projects.length, 1);
  assert.equal(supabase.tables.projects[0].next_step, "Regar las plantas");
  assert.equal(supabase.tables.proactive_followups.length, 1);
  supabase.tables.proactive_followups[0].status = "sent";

  const { fetchImpl: duplicateFetch } = createFetch({
    memories: [],
    projects: [],
    tasks: [],
    reminders: [],
    completedTaskIds: [],
    reopenedTaskIds: [],
    completedReminderIds: [],
    followups: [{
      memberId: MEMBER_IDS[0],
      memoryId: null,
      question: "¿Cómo sigue la huerta?",
      scheduledAt: "2026-03-23T12:00:00.000Z",
    }],
  });
  const duplicateHandler = createChatHandler({
    config: CONFIG,
    redis: new MemoryRedis(),
    supabase,
    fetchImpl: duplicateFetch,
    clock: () => new Date("2026-03-20T12:00:00.000Z"),
  });
  const duplicateResponse = createResponse();
  await duplicateHandler({
    method: "POST",
    headers: { authorization: `Bearer ${DEVICE_TOKEN}` },
    body: { question: "Sigamos con la huerta", speaker_id: MEMBER_IDS[0] },
  }, duplicateResponse);
  assert.equal(supabase.tables.proactive_followups.length, 1);
});

test("active follow-ups can be completed or cancelled by an explicit report", async () => {
  const supabase = new MemorySupabase();
  const completedId = randomUUID();
  const cancelledId = randomUUID();
  supabase.tables.proactive_followups.push(
    {
      id: completedId,
      member_id: MEMBER_IDS[0],
      memory_id: null,
      question: "¿Terminaste el curso?",
      scheduled_at: "2026-03-19T12:00:00.000Z",
      status: "pending",
    },
    {
      id: cancelledId,
      member_id: MEMBER_IDS[0],
      memory_id: null,
      question: "¿Cómo sigue el curso?",
      scheduled_at: "2026-03-19T12:00:00.000Z",
      status: "sent",
    },
  );
  const { fetchImpl } = createFetch({
    memories: [],
    preferences: [],
    emotionalContext: [],
    projects: [],
    tasks: [],
    reminders: [],
    completedTaskIds: [],
    reopenedTaskIds: [],
    completedReminderIds: [],
    followups: [],
    completedFollowupIds: [completedId],
    cancelledFollowupIds: [cancelledId],
  });
  const handler = createChatHandler({
    config: CONFIG,
    redis: new MemoryRedis(),
    supabase,
    fetchImpl,
    clock: () => new Date("2026-03-20T12:00:00.000Z"),
  });
  const res = createResponse();
  await handler({
    method: "POST",
    headers: { authorization: `Bearer ${DEVICE_TOKEN}` },
    body: {
      question: "Ya terminé el curso; no me preguntes más por cómo sigue.",
      speaker_id: MEMBER_IDS[0],
    },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(supabase.tables.proactive_followups[0].status, "completed");
  assert.equal(supabase.tables.proactive_followups[1].status, "cancelled");
  assert.equal(supabase.rpcCalls.filter((call) => (
    call.name === "transition_family_followup"
  )).length, 2);
});

test("task completion and reopening are attributed to the selected speaker", async () => {
  const supabase = new MemorySupabase();
  const { fetchImpl } = createFetch({
    memories: [],
    preferences: [],
    emotionalContext: [],
    projects: [],
    tasks: [],
    reminders: [],
    completedTaskIds: [TASK_ID],
    reopenedTaskIds: [CLOSED_TASK_ID],
    completedReminderIds: [],
    followups: [],
    completedFollowupIds: [],
    cancelledFollowupIds: [],
  });
  const handler = createChatHandler({
    config: CONFIG,
    redis: new MemoryRedis(),
    supabase,
    fetchImpl,
    clock: () => new Date("2026-03-20T12:00:00.000Z"),
  });
  const res = createResponse();
  await handler({
    method: "POST",
    headers: { authorization: `Bearer ${DEVICE_TOKEN}` },
    body: {
      question: "Terminé llamar al dentista y hay que reabrir el turno.",
      speaker_id: MEMBER_IDS[0],
    },
  }, res);

  assert.equal(res.statusCode, 200);
  const transitions = supabase.rpcCalls.filter((call) => (
    call.name === "transition_family_task"
  ));
  assert.deepEqual(transitions.map(({ args }) => ({
    taskId: args.p_task_id,
    memberId: args.p_member_id,
    status: args.p_new_status,
  })), [
    { taskId: TASK_ID, memberId: MEMBER_IDS[0], status: "completed" },
    { taskId: CLOSED_TASK_ID, memberId: MEMBER_IDS[0], status: "pending" },
  ]);
});

test("repeated preference and emotional updates do not create duplicate active entries", async () => {
  const supabase = new MemorySupabase();
  const update = {
    memories: [],
    preferences: [{
      category: "alimentación",
      value: "sin lactosa",
      confidence: 0.9,
    }],
    emotionalContext: [{
      situation: "cambio de trabajo",
      context: "Está ansiosa, pero esperanzada.",
    }],
    projects: [],
    tasks: [],
    reminders: [],
    completedTaskIds: [],
    reopenedTaskIds: [],
    completedReminderIds: [],
    followups: [],
    completedFollowupIds: [],
    cancelledFollowupIds: [],
  };
  const handler = createChatHandler({
    config: CONFIG,
    redis: new MemoryRedis(),
    supabase,
    fetchImpl: createFetch(update).fetchImpl,
    clock: () => new Date("2026-03-20T12:00:00.000Z"),
  });
  for (let index = 0; index < 2; index++) {
    const res = createResponse();
    await handler({
      method: "POST",
      headers: { authorization: `Bearer ${DEVICE_TOKEN}` },
      body: { question: "Me acuerdo del cambio de trabajo.", speaker_id: MEMBER_IDS[0] },
    }, res);
    assert.equal(res.statusCode, 200);
  }
  assert.equal(supabase.tables.preferences.filter((item) => item.active).length, 1);
  assert.equal(supabase.tables.emotional_context.filter((item) => (
    item.status === "active"
  )).length, 1);
});

test("inactive or unknown speakers are rejected before calling Gemini", async () => {
  const supabase = new MemorySupabase();
  const inactiveMemberId = "b7c8d9e0-f1a2-4345-8b67-89abcdef0124";
  supabase.tables.family_members.push({
    id: inactiveMemberId,
    name: "Integrante inactivo",
    active: false,
    profile: {},
  });
  const { fetchImpl, calls } = createFetch();
  const handler = createChatHandler({
    config: CONFIG,
    redis: new MemoryRedis(),
    supabase,
    fetchImpl,
  });
  const res = createResponse();
  await handler({
    method: "POST",
    headers: { authorization: `Bearer ${DEVICE_TOKEN}` },
    body: { question: "Hola", speaker_id: inactiveMemberId },
  }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(calls.gemini.length, 0);
});

test("legacy request remains supported only with an active configured fallback", async () => {
  const supabase = new MemorySupabase();
  const { fetchImpl } = createFetch({ memories: [], projects: [], tasks: [], reminders: [] });
  const handler = createChatHandler({
    config: { ...CONFIG, familyMemberId: MEMBER_IDS[0] },
    redis: new MemoryRedis(),
    supabase,
    fetchImpl,
  });
  const res = createResponse();
  await handler({
    method: "POST",
    headers: { authorization: `Bearer ${DEVICE_TOKEN}` },
    body: { question: "Hola", history: [] },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(supabase.tables.conversations[0].member_id, MEMBER_IDS[0]);
});

test("family API returns only four active members and validates notification recipient", async () => {
  const supabase = new MemorySupabase();
  const handler = createFamilyApiHandler({ config: CONFIG, supabase });
  const membersResponse = createResponse();
  await handler({
    method: "GET",
    url: "/members",
    headers: { authorization: `Bearer ${DEVICE_TOKEN}` },
  }, membersResponse);
  const membersPayload = JSON.parse(membersResponse.body);
  assert.equal(membersResponse.statusCode, 200);
  assert.equal(membersPayload.members.length, 4);

  const invalidSpeaker = createResponse();
  await handler({
    method: "GET",
    url: "/notifications/pending?speaker_id=ffffffff-ffff-4fff-8fff-ffffffffffff",
    headers: { authorization: `Bearer ${DEVICE_TOKEN}` },
  }, invalidSpeaker);
  assert.equal(invalidSpeaker.statusCode, 400);
});

test("notification polling and ACK are scoped to the selected active member", async () => {
  const supabase = new MemorySupabase();
  const handler = createFamilyApiHandler({ config: CONFIG, supabase });
  const pendingResponse = createResponse();
  await handler({
    method: "GET",
    url: `/api/notifications/pending?speaker_id=${MEMBER_IDS[2]}`,
    headers: { authorization: `Bearer ${DEVICE_TOKEN}` },
  }, pendingResponse);
  assert.equal(pendingResponse.statusCode, 200);
  assert.deepEqual(supabase.rpcCalls.find((call) => (
    call.name === "claim_due_notifications"
  )).args, {
    p_member_id: MEMBER_IDS[2],
    p_limit: 5,
  });

  const ackResponse = createResponse();
  await handler({
    method: "POST",
    url: "/api/notifications/ack",
    headers: { authorization: `Bearer ${DEVICE_TOKEN}` },
    body: {
      speaker_id: MEMBER_IDS[2],
      delivery_id: REMINDER_ID,
      success: true,
    },
  }, ackResponse);
  assert.equal(ackResponse.statusCode, 200);
  assert.deepEqual(supabase.rpcCalls.find((call) => (
    call.name === "ack_notification_delivery"
  )).args, {
    p_delivery_id: REMINDER_ID,
    p_member_id: MEMBER_IDS[2],
    p_success: true,
    p_error: null,
  });
});

test("Supabase REST requests explicitly select family_assistant", async () => {
  const requests = [];
  const supabase = createSupabaseClient({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "test-service-key",
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return new Response(JSON.stringify([{ id: MEMBER_IDS[0] }]));
    },
  });
  await supabase.select("family_members", new URLSearchParams({ select: "id" }));
  await supabase.rpc("claim_due_notifications", {
    p_member_id: MEMBER_IDS[0],
    p_limit: 5,
  });
  assert.equal(requests[0].options.headers["accept-profile"], "family_assistant");
  assert.equal(requests[0].url, "https://example.supabase.co/rest/v1/family_members?select=id");
  assert.equal(requests[1].options.headers["content-profile"], "family_assistant");
  assert.match(requests[1].url, /\/rest\/v1\/rpc\/claim_due_notifications$/);
  assert.equal(requests[0].options.headers.apikey, "test-service-key");
});

test("secrets are redacted before transcript persistence", async () => {
  const supabase = new MemorySupabase();
  const { fetchImpl } = createFetch({ memories: [], projects: [], tasks: [], reminders: [] });
  const handler = createChatHandler({
    config: CONFIG,
    redis: new MemoryRedis(),
    supabase,
    fetchImpl,
  });
  const res = createResponse();
  await handler({
    method: "POST",
    headers: { authorization: `Bearer ${DEVICE_TOKEN}` },
    body: {
      question: "Mi contraseña es clave-privada. Mi api_key=sk-abcdefghijklmnopqrstuvwxyz123456.",
      speaker_id: MEMBER_IDS[0],
    },
  }, res);
  const persisted = supabase.tables.messages.find((message) => message.role === "user");
  assert.doesNotMatch(persisted.content, /sk-abcdefghijklmnopqrstuvwxyz123456/);
  assert.doesNotMatch(persisted.content, /clave-privada/);
  assert.match(persisted.content, /\[redactado\]/);
});
