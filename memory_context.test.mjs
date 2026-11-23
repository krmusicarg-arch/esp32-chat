import assert from "node:assert/strict";
import test from "node:test";
import { getMemories } from "./services/memory.service.mjs";
import { buildFamilyContext } from "./services/proactive.service.mjs";

const MEMBER_A = "a0b1c2d3-e4f5-4a67-8b90-123456789abc";
const MEMBER_B = "b1c2d3e4-f5a6-4789-8b01-23456789abcd";
const NOW = new Date("2026-11-23T12:00:00.000Z");

function memory(id, content, overrides = {}) {
  return {
    id,
    subject_member_id: MEMBER_B,
    category: "IMPORTANT_EVENTS",
    content,
    importance: 4,
    confidence: 1,
    active: true,
    valid_until: null,
    metadata: {},
    ...overrides,
  };
}

class MemoryStore {
  constructor(rows) {
    this.rows = rows;
    this.queries = [];
  }

  async select(table, query) {
    this.queries.push(query);
    let rows = [...(table === "memories" ? this.rows : [])];
    for (const [key, filter] of query) {
      if (key === "select" || key === "order" || key === "or" || key === "limit") continue;
      if (filter.startsWith("eq.")) rows = rows.filter((row) => String(row[key]) === filter.slice(3));
      if (filter.startsWith("ilike.")) {
        const pattern = filter.slice(6).replaceAll("*", "").toLocaleLowerCase("es-AR");
        rows = rows.filter((row) => String(row[key]).toLocaleLowerCase("es-AR").includes(pattern));
      }
    }
    if (query.has("limit")) rows = rows.slice(0, Number(query.get("limit")));
    return rows;
  }
}

test("birthday questions return active birthdays for all family members", async () => {
  const store = new MemoryStore([
    memory("birthday-a", "El cumpleaños de Ana es el 21 de julio.", {
      subject_member_id: MEMBER_A,
    }),
    memory("birthday-b", "El cumpleaños de Karina es el 18 de marzo."),
    memory("expired", "El cumpleaños de Wilancho es el 23 de noviembre.", {
      valid_until: "2026-11-22T00:00:00.000Z",
    }),
    memory("low-confidence", "El cumpleaños de Tomás es el 5 de mayo.", {
      confidence: 0.4,
    }),
    memory("not-event", "A Karina le gusta el rock.", { category: "LIKES" }),
  ]);

  const birthdays = await getMemories(store, {
    question: "¿Cuándo cumplen los integrantes de la familia?",
    now: NOW,
  });

  assert.deepEqual(birthdays.map(({ id }) => id), ["birthday-a", "birthday-b"]);
  assert.equal(store.queries.length, 2);
  assert.equal(store.queries[1].get("content"), "ilike.*cumple*");
  assert.equal(store.queries[1].get("or"), `(valid_until.is.null,valid_until.gt.${NOW.toISOString()})`);
});

test("memory retrieval uses exact-term relevance and recent follow-up context", async () => {
  const store = new MemoryStore([
    memory("relevant", "A Karina le gusta escuchar rock.", {
      category: "LIKES",
    }),
    memory("irrelevant", "Karina prefiere el helado.", {
      category: "LIKES",
    }),
  ]);
  const result = await getMemories(store, {
    question: "¿Y qué estilo?",
    history: [{ question: "¿Qué música escucha Karina?", answer: "Le gusta el rock." }],
    now: NOW,
  });

  assert.deepEqual(result.map(({ id }) => id), ["relevant"]);
});

test("expired and low-confidence memories are excluded", async () => {
  const store = new MemoryStore([
    memory("expired", "A Karina disfruta escuchar rock.", {
      category: "LIKES",
      valid_until: "2026-11-22T00:00:00.000Z",
    }),
    memory("uncertain", "A Karina disfruta escuchar rock.", {
      id: "uncertain",
      category: "LIKES",
      confidence: 0.2,
    }),
  ]);
  const result = await getMemories(store, {
    question: "¿Qué música le gusta a Karina?",
    now: NOW,
  });

  assert.deepEqual(result, []);
});

test("greetings do not inject tasks, reminders or unrelated preference data", () => {
  const context = buildFamilyContext({
    member: { id: MEMBER_A, name: "Ana" },
    members: [{ id: MEMBER_A, name: "Ana" }, { id: MEMBER_B, name: "Karina" }],
    memories: [],
    preferences: [{ category: "música", value: "rock" }],
    emotionalContext: [{ situation: "estrés", context: "mucho trabajo" }],
    projects: [{ name: "Huerta", next_step: "Comprar semillas" }],
    tasks: [{ description: "Llamar al dentista" }],
    reminders: [{ title: "Llevar paraguas", scheduled_at: "mañana" }],
    settings: { timezone: "America/Argentina/Cordoba" },
    question: "Hola, ¿cómo estás?",
    history: [],
  });

  assert.doesNotMatch(context, /Llamar al dentista|Llevar paraguas|Comprar semillas|mucho trabajo|\"rock\"/);
});

test("a planning follow-up includes the previous relevant tasks and reminders", () => {
  const context = buildFamilyContext({
    member: { id: MEMBER_A, name: "Ana" },
    members: [{ id: MEMBER_A, name: "Ana" }],
    memories: [],
    preferences: [],
    emotionalContext: [],
    projects: [{ name: "Huerta", next_step: "Comprar semillas" }],
    tasks: [{ description: "Llamar al dentista" }],
    reminders: [{ title: "Llevar paraguas", scheduled_at: "mañana" }],
    settings: { timezone: "America/Argentina/Cordoba" },
    question: "¿Y cuáles quedan?",
    history: [{ question: "¿Qué tareas y recordatorios tengo?", answer: "Tenés pendientes." }],
  });

  assert.match(context, /Llamar al dentista/);
  assert.match(context, /Llevar paraguas/);
  assert.match(context, /Comprar semillas/);
});
