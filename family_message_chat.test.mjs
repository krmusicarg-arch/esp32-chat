import assert from "node:assert/strict";
import test from "node:test";
import { createChatHandler } from "./lib/assistant.mjs";
import { createMobileSessionToken } from "./lib/mobile_auth.mjs";

const SECRET = "t".repeat(64);
const IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
];

class ChatSupabase {
  messages = [];
  conversations = [];
  transcript = [];

  async select(table, query) {
    const params = new URLSearchParams(query);
    if (table === "family_settings") return [{ id: 1, family_name: "Los Ruiz", expected_members: 4, timezone: "America/Argentina/Cordoba" }];
    if (table === "family_members") return IDS.map((id, index) => ({ id, name: ["Ana", "Gustavo", "María", "Luis"][index], active: true, profile: {} }));
    if (table === "family_messages") {
      return this.messages.filter((message) => message.sender_id === params.get("sender_id")?.slice(3)
        && message.client_request_id === params.get("client_request_id")?.slice(3));
    }
    return [];
  }

  async upsertIgnore(_table, row) {
    const existing = this.messages.find((message) => message.sender_id === row.sender_id
      && message.client_request_id === row.client_request_id);
    if (existing) return [];
    const message = { ...row, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", created_at: new Date().toISOString() };
    this.messages.push(message);
    return [message];
  }

  async insert(table, rows) {
    if (table === "conversations") this.conversations.push(rows);
    if (table === "messages") this.transcript.push(...rows);
    return rows;
  }
}

async function sendCommand(handler, { question, requestId, claimedSpeaker = null }) {
  const token = createMobileSessionToken(SECRET, IDS[0]);
  const req = {
    method: "POST",
    url: "/api/chat",
    headers: { authorization: `Bearer ${token}` },
    body: { question, ...(claimedSpeaker ? { speaker_id: claimedSpeaker } : {}), request_id: requestId },
  };
  const res = {
    writeHead(status) { this.status = status; },
    end(value) { this.payload = JSON.parse(value); },
  };
  await handler(req, res);
  return res;
}

test("PWA voice/text message intent uses the session identity and does not call Gemini", async () => {
  const supabase = new ChatSupabase();
  const handler = createChatHandler({
    config: { deviceToken: "device-token-test-0123456789", mobileSessionSecret: SECRET },
    redis: {},
    supabase,
    fetchImpl: async () => { throw new Error("Gemini must not be called for a message command"); },
  });
  const requestId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const spoofed = await sendCommand(handler, {
    question: "Robert, avisale a Gustavo que no se olvide de comprar carne",
    requestId,
    claimedSpeaker: IDS[3],
  });
  assert.equal(spoofed.status, 403);
  assert.equal(supabase.messages.length, 0);
  const first = await sendCommand(handler, {
    question: "Robert, avisale a Gustavo que no se olvide de comprar carne",
    requestId,
  });
  const retry = await sendCommand(handler, {
    question: "Robert, avisale a Gustavo que no se olvide de comprar carne",
    requestId,
  });

  assert.equal(first.status, 200);
  assert.equal(first.payload.status, "message_sent");
  assert.match(first.payload.answer, /a Gustavo/);
  assert.equal(supabase.messages.length, 1);
  assert.equal(supabase.messages[0].sender_id, IDS[0]);
  assert.equal(supabase.messages[0].recipient_id, IDS[1]);
  assert.equal(retry.payload.status, "message_already_sent");
  assert.equal(supabase.transcript.length, 4);
  assert.ok(supabase.conversations.length);
});

test("voice transcript without the preposition still saves for surname-first Karina", async () => {
  const supabase = new ChatSupabase();
  const family = [
    { id: IDS[0], name: "Ruiz Gustavo", active: true },
    { id: IDS[1], name: "Ontivero Karina", active: true },
    { id: IDS[2], name: "Ruiz Luisina", active: true },
    { id: IDS[3], name: "Ruiz Valentin", active: true },
  ];
  const select = supabase.select.bind(supabase);
  supabase.select = async (table, query) => table === "family_members" ? family : select(table, query);
  const handler = createChatHandler({
    config: { deviceToken: "device-token-test-0123456789", mobileSessionSecret: SECRET },
    redis: {},
    supabase,
    fetchImpl: async () => { throw new Error("Gemini must not be called for a message command"); },
  });

  const response = await sendCommand(handler, {
    question: "robertito Avisale Karina que prepare la comida esta noche",
    requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  });

  assert.equal(response.status, 200);
  assert.equal(response.payload.status, "message_sent");
  assert.equal(supabase.messages.length, 1);
  assert.equal(supabase.messages[0].recipient_id, IDS[1]);
  assert.equal(supabase.messages[0].content, "prepare la comida esta noche");
});
