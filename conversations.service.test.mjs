import assert from "node:assert/strict";
import test from "node:test";
import {
  getTelegramUpdateResponse,
  getConversationHistory,
  getLatestConversationId,
} from "./services/conversations.service.mjs";

const MEMBER_A = "a0b1c2d3-e4f5-4a67-8b90-123456789abc";
const MEMBER_B = "b1c2d3e4-f5a6-4789-8b01-23456789abcd";
const CONVERSATION_A = "c2d3e4f5-a6b7-4890-8c12-3456789abcde";
const CONVERSATION_B = "d3e4f5a6-b7c8-4901-8d23-456789abcdef";

test("Telegram update lookup returns the stored answer without replaying it", async () => {
  const queries = [];
  const db = {
    async select(table, query) {
      queries.push({ table, query: query.toString() });
      return query.get("role") === "eq.user"
        ? [{ conversation_id: CONVERSATION_A, content: "¿Qué tenemos mañana?" }]
        : [{ content: "Tenés un turno." }];
    },
  };
  const answer = await getTelegramUpdateResponse(db, {
    memberId: MEMBER_A,
    telegramUpdateId: "123456",
  });
  assert.equal(answer, "Tenés un turno.");
  assert.equal(queries.length, 2);
  assert.ok(queries.every(({ query }) => query.includes("metadata-%3E%3Etelegram_update_id=eq.123456")));
});

class ConversationStore {
  constructor(conversations, messages) {
    this.conversations = conversations;
    this.messages = messages;
  }

  async select(table, query) {
    let rows = table === "conversations" ? this.conversations : this.messages;
    rows = [...rows];
    for (const [key, filter] of query) {
      if (key === "select" || key === "order") continue;
      if (filter.startsWith("eq.")) {
        rows = rows.filter((row) => String(row[key]) === filter.slice(3));
      } else if (filter === "is.null") {
        rows = rows.filter((row) => row[key] == null);
      } else if (filter.startsWith("in.(")) {
        const values = filter.slice(4, -1).split(",");
        rows = rows.filter((row) => values.includes(String(row[key])));
      }
    }
    const order = query.get("order") || "";
    if (order.startsWith("started_at.desc")) {
      rows.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
    } else if (order.startsWith("created_at.desc")) {
      rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))
        || String(a.role).localeCompare(String(b.role)));
    }
    if (query.has("limit")) rows = rows.slice(0, Number(query.get("limit")));
    return rows;
  }
}

function makeMessages(conversationId, count, startAt) {
  return Array.from({ length: count }, (_, index) => {
    const turn = Math.floor(index / 2) + 1;
    const role = index % 2 === 0 ? "user" : "assistant";
    return {
      conversation_id: conversationId,
      role,
      content: role === "user" ? `pregunta-${turn}` : `respuesta-${turn}`,
      created_at: new Date(startAt + index * 1000).toISOString(),
    };
  });
}

test("history returns the latest eight complete turns from only the requested conversation", async () => {
  const store = new ConversationStore([
    { id: CONVERSATION_A, member_id: MEMBER_A, started_at: "2026-01-01T00:00:00Z", ended_at: null },
    { id: CONVERSATION_B, member_id: MEMBER_A, started_at: "2026-02-01T00:00:00Z", ended_at: null },
  ], [
    ...makeMessages(CONVERSATION_A, 20, Date.parse("2026-01-01T00:00:00Z")),
    ...makeMessages(CONVERSATION_B, 2, Date.parse("2026-02-01T00:00:00Z")),
  ]);

  const history = await getConversationHistory(store, {
    conversationId: CONVERSATION_A,
    memberId: MEMBER_A,
  });

  assert.equal(history.length, 8);
  assert.deepEqual(history[0], { question: "pregunta-3", answer: "respuesta-3" });
  assert.deepEqual(history.at(-1), { question: "pregunta-10", answer: "respuesta-10" });
  assert.deepEqual(history.map(({ question }) => question), [
    "pregunta-3", "pregunta-4", "pregunta-5", "pregunta-6",
    "pregunta-7", "pregunta-8", "pregunta-9", "pregunta-10",
  ]);
});

test("history refuses to expose another member's conversation", async () => {
  const store = new ConversationStore([
    { id: CONVERSATION_A, member_id: MEMBER_A, started_at: "2026-01-01T00:00:00Z", ended_at: null },
  ], makeMessages(CONVERSATION_A, 2, Date.parse("2026-01-01T00:00:00Z")));

  await assert.rejects(
    getConversationHistory(store, { conversationId: CONVERSATION_A, memberId: MEMBER_B }),
    (error) => error.code === "INVALID_CONVERSATION",
  );
});

test("a topic change does not prevent returning to an earlier point in the same chat", async () => {
  const turns = [
    { question: "¿Cuándo cumple Karina?", answer: "El 18 de marzo." },
    { question: "¿Qué música escuchaba Sofía?", answer: "Rock." },
    { question: "¿Y qué cumpleaños habíamos anotado?", answer: "El de Karina, el 18 de marzo." },
  ];
  const messages = turns.flatMap((turn, index) => {
    const timestamp = Date.parse("2026-11-23T00:00:00Z") + index * 2000;
    return [
      {
        conversation_id: CONVERSATION_A,
        role: "user",
        content: turn.question,
        created_at: new Date(timestamp).toISOString(),
      },
      {
        conversation_id: CONVERSATION_A,
        role: "assistant",
        content: turn.answer,
        created_at: new Date(timestamp + 1).toISOString(),
      },
    ];
  });
  const store = new ConversationStore([
    { id: CONVERSATION_A, member_id: MEMBER_A, started_at: "2026-11-23T00:00:00Z", ended_at: null },
  ], messages);

  assert.deepEqual(await getConversationHistory(store, {
    conversationId: CONVERSATION_A,
    memberId: MEMBER_A,
  }), turns);
});

test("client without an ID resumes the latest open conversation of its member", async () => {
  const store = new ConversationStore([
    { id: CONVERSATION_A, member_id: MEMBER_A, started_at: "2026-01-01T00:00:00Z", ended_at: null },
    { id: CONVERSATION_B, member_id: MEMBER_A, started_at: "2026-02-01T00:00:00Z", ended_at: null },
    { id: "e4f5a6b7-c8d9-4012-8e34-56789abcdef0", member_id: MEMBER_B, started_at: "2026-03-01T00:00:00Z", ended_at: null },
    { id: "f5a6b7c8-d9e0-4123-8f45-6789abcdef01", member_id: MEMBER_A, started_at: "2026-04-01T00:00:00Z", ended_at: "2026-04-02T00:00:00Z" },
  ], []);

  assert.equal(await getLatestConversationId(store, { memberId: MEMBER_A }), CONVERSATION_B);
});
