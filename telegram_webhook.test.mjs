import test from "node:test";
import assert from "node:assert/strict";
import {
  createTelegramWebhookHandler,
  telegramSettingsFromEnv,
} from "./lib/telegram_webhook.mjs";

const memberIds = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
];
const settings = telegramSettingsFromEnv({
  TELEGRAM_BOT_TOKEN: "test-token",
  TELEGRAM_WEBHOOK_SECRET: "a".repeat(40),
  TELEGRAM_MEMBER_MAP: JSON.stringify({
    "123456789": memberIds[0],
    "234567890": memberIds[1],
    "345678901": memberIds[2],
    "456789012": memberIds[3],
  }),
  TELEGRAM_GROUP_CHAT_ID: "-1001234567890",
});

function harness() {
  const keys = new Map();
  const calls = [];
  const redis = {
    async set(key, value, { nx } = {}) {
      if (nx && keys.has(key)) return null;
      keys.set(key, value);
      return "OK";
    },
    async del(key) { keys.delete(key); },
  };
  const handler = createTelegramWebhookHandler({
    settings,
    redis,
    async processText(message) { calls.push(message); return `Robert: ${message.question}`; },
    async sendMessage(chatId, text) { calls.push({ chatId, text }); },
  });
  async function request(update, secret = settings.webhookSecret) {
    let status;
    let body;
    const res = { writeHead(code) { status = code; }, end(value) { body = value; } };
    await handler({
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": secret },
      body: update,
    }, res);
    return { status, body: JSON.parse(body) };
  }
  return { request, calls };
}

test("private Telegram text is routed to the mapped existing member", async () => {
  const { request, calls } = harness();
  const result = await request({
    update_id: 7,
    message: { text: "¿Qué tenemos mañana?", from: { id: 123456789 }, chat: { id: 123456789, type: "private" } },
  });
  assert.equal(result.status, 200);
  assert.equal(calls[0].memberId, memberIds[0]);
  assert.equal(calls[0].question, "¿Qué tenemos mañana?");
  assert.equal(calls[0].chatId, "123456789");
  assert.equal(calls[0].isPrivate, true);
  assert.equal(calls[1].text, "Robert: ¿Qué tenemos mañana?");
});

test("group messages are answered only when addressed to Robert", async () => {
  const { request, calls } = harness();
  const group = { id: -1001234567890, type: "supergroup" };
  await request({ update_id: 8, message: { text: "Llegamos a las ocho", from: { id: 123456789 }, chat: group } });
  assert.equal(calls.length, 0);
  await request({ update_id: 9, message: { text: "@RobertFamiliaBot ¿qué tenemos mañana?", from: { id: 123456789 }, chat: group } });
  assert.equal(calls[0].question, "¿qué tenemos mañana?");
  assert.equal(calls[1].chatId, "-1001234567890");
});

test("invalid webhook secrets and unmapped senders cannot reach family context", async () => {
  const { request, calls } = harness();
  assert.equal((await request({ update_id: 10 }, "wrong-secret")).status, 401);
  await request({ update_id: 11, message: { text: "hola", from: { id: 999999999 }, chat: { id: 999999999, type: "private" } } });
  assert.equal(calls.filter((call) => call.memberId).length, 0);
  assert.match(calls[0].text, /No pude vincular/);
});

test("ordinary group text is saved to shared history without an automatic reply", async () => {
  const stored = [];
  const answered = [];
  const redis = new Map();
  const handler = createTelegramWebhookHandler({
    settings,
    redis: {
      async set(key, value, { nx } = {}) {
        if (nx && redis.has(key)) return null;
        redis.set(key, value);
        return "OK";
      },
      async del(key) { redis.delete(key); },
    },
    async processGroupMessage(message) { stored.push(message); return { duplicate: false }; },
    async processText(message) { answered.push(message); return "Robert"; },
    async sendMessage() {},
  });
  const res = { writeHead(status) { this.status = status; }, end() {} };
  await handler({
    method: "POST",
    headers: { "x-telegram-bot-api-secret-token": settings.webhookSecret },
    body: { update_id: 12, message: { message_id: 31, date: 1_795_000_000, text: "Llegamos a las ocho", from: { id: 123456789 }, chat: { id: -1001234567890, type: "supergroup" } } },
  }, res);
  assert.equal(res.status, 200);
  assert.equal(stored.length, 1);
  assert.equal(answered.length, 0);
});

test("a durable private update is not transcribed or answered twice", async () => {
  let transcriptions = 0;
  let answers = 0;
  const redis = new Map();
  const handler = createTelegramWebhookHandler({
    settings,
    redis: {
      async set(key, value, { nx } = {}) {
        if (nx && redis.has(key)) return null;
        redis.set(key, value);
        return "OK";
      },
      async del(key) { redis.delete(key); },
    },
    async isProcessed() { return true; },
    async transcribeAudio() { transcriptions += 1; return "hola"; },
    async processText() { answers += 1; return "Robert"; },
    async sendMessage() {},
  });
  const res = { writeHead(status) { this.status = status; }, end() {} };
  await handler({ method: "POST", headers: { "x-telegram-bot-api-secret-token": settings.webhookSecret }, body: {
    update_id: 13,
    message: { from: { id: 123456789 }, chat: { id: 123456789, type: "private" }, voice: { file_id: "voice-file" } },
  } }, res);
  assert.equal(transcriptions, 0);
  assert.equal(answers, 0);
  assert.equal(res.status, 200);
});

test("Telegram mapping accepts between one and four unique existing member UUIDs", () => {
  const baseEnv = {
    TELEGRAM_BOT_TOKEN: "token",
    TELEGRAM_WEBHOOK_SECRET: "a".repeat(40),
  };
  for (let count = 1; count <= 4; count += 1) {
    const map = Object.fromEntries(memberIds.slice(0, count).map((memberId, index) => [String(index + 1), memberId]));
    assert.equal(Object.keys(telegramSettingsFromEnv({
      ...baseEnv,
      TELEGRAM_MEMBER_MAP: JSON.stringify(map),
    }).memberMap).length, count);
  }
  assert.throws(() => telegramSettingsFromEnv({
    ...baseEnv,
    TELEGRAM_MEMBER_MAP: JSON.stringify({}),
  }), /one to four/);
  assert.throws(() => telegramSettingsFromEnv({
    ...baseEnv,
    TELEGRAM_MEMBER_MAP: JSON.stringify(Object.fromEntries(
      [...memberIds, "55555555-5555-4555-8555-555555555555"].map((memberId, index) => [String(index + 1), memberId]),
    )),
  }), /one to four/);
  assert.throws(() => telegramSettingsFromEnv({
    ...baseEnv,
    TELEGRAM_MEMBER_MAP: JSON.stringify({ "1": memberIds[0], "2": memberIds[0] }),
  }), /one to four/);
});
