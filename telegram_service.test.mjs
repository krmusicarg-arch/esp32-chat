import test from "node:test";
import assert from "node:assert/strict";
import {
  deliverFamilyMessageToTelegram,
  registerTelegramPrivateChat,
  storeTelegramGroupMessage,
} from "./services/telegram.service.mjs";

const senderId = "11111111-1111-4111-8111-111111111111";
const recipientId = "22222222-2222-4222-8222-222222222222";

test("registers a private chat only when it matches the configured active member", async () => {
  const updates = [];
  const db = {
    async select() { return [{ id: recipientId, active: true, telegram_user_id: null, telegram_private_chat_id: null }]; },
    async update(table, query, values) { updates.push({ table, values }); return [{ id: recipientId }]; },
  };
  await registerTelegramPrivateChat(db, {
    memberId: recipientId, telegramUserId: "123456789", privateChatId: "123456789",
  });
  assert.deepEqual(updates[0], {
    table: "family_members",
    values: { telegram_user_id: "123456789", telegram_private_chat_id: "123456789" },
  });
});

test("stores group messages idempotently in the existing family message table", async () => {
  let inserted;
  const db = {
    async upsertIgnore(table, row, query) {
      inserted = { table, row, query: query.toString() };
      return [{ id: "message-id", ...row }];
    },
  };
  const result = await storeTelegramGroupMessage(db, {
    senderId,
    content: "¿Qué tenemos mañana?",
    chatId: "-1001234567890",
    messageId: 21,
    updateId: 34,
    messageDate: 1795000000,
  });
  assert.equal(result.duplicate, false);
  assert.equal(inserted.table, "family_messages");
  assert.equal(inserted.row.source_channel, "telegram_group");
  assert.equal(inserted.row.sender_id, senderId);
  assert.equal(inserted.row.telegram_message_id, "21");
  assert.match(inserted.query, /telegram_chat_id%2Ctelegram_message_id/);
});

test("records Telegram message delivery and the Bot API message ID", async () => {
  const updates = [];
  const db = {
    async upsertIgnore(table, row) {
      assert.equal(table, "notification_deliveries");
      assert.equal(row.channel, "telegram");
      return [{ id: "delivery-id", delivery_status: "pending", attempts: 0 }];
    },
    async update(table, query, values) {
      updates.push(values);
      return [{ id: "delivery-id" }];
    },
  };
  const results = await deliverFamilyMessageToTelegram({
    supabase: db,
    botToken: "test-token",
    message: { id: "message-id", recipient_id: recipientId, content: "Llego a las ocho." },
    senderId,
    members: [{ id: recipientId, name: "Karina", telegram_private_chat_id: "123456789" }],
    fetchImpl: async (url, options) => {
      assert.match(String(url), /sendMessage$/);
      assert.equal(JSON.parse(options.body).chat_id, "123456789");
      return Response.json({ ok: true, result: { message_id: 987 } });
    },
  });
  assert.deepEqual(results, [{ memberId: recipientId, status: "sent" }]);
  assert.ok(updates.some((values) => values.delivery_status === "processing"));
  assert.ok(updates.some((values) => values.delivery_status === "sent" && values.external_message_id === "987"));
});

test("reports the private-chat initiation requirement and leaves the message in Supabase", async () => {
  const updates = [];
  const db = {
    async upsertIgnore() { return [{ id: "delivery-id", delivery_status: "pending", attempts: 0 }]; },
    async update(table, query, values) { updates.push(values); return [{ id: "delivery-id" }]; },
  };
  const results = await deliverFamilyMessageToTelegram({
    supabase: db,
    botToken: "test-token",
    message: { id: "message-id", recipient_id: recipientId, content: "Hola." },
    senderId,
    members: [{ id: recipientId, name: "Karina", telegram_private_chat_id: null }],
    fetchImpl: async () => { throw new Error("must not send without a private chat"); },
  });
  assert.deepEqual(results, [{ memberId: recipientId, status: "failed", reason: "must_start_private_chat" }]);
  assert.ok(updates.some((values) => values.last_error === "recipient_must_start_private_chat"));
});
