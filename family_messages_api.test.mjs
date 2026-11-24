import assert from "node:assert/strict";
import test from "node:test";
import { createFamilyMessagesApiHandler } from "./lib/family_messages_api.mjs";
import { createMobileSessionToken } from "./lib/mobile_auth.mjs";

const SECRET = "s".repeat(64);
const members = [
  { id: "11111111-1111-4111-8111-111111111111", name: "Ana", active: true },
  { id: "22222222-2222-4222-8222-222222222222", name: "Gustavo", active: true },
  { id: "33333333-3333-4333-8333-333333333333", name: "María", active: true },
  { id: "44444444-4444-4444-8444-444444444444", name: "Luis", active: true },
];

class FakeSupabase {
  messages = [];
  reads = [];
  nextId = 1;

  async select(table, query) {
    const params = query instanceof URLSearchParams ? query : new URLSearchParams(query);
    if (table === "family_settings") return [{ id: 1, expected_members: 4 }];
    if (table === "family_members") return members;
    if (table === "family_messages") {
      let rows = [...this.messages];
      const id = params.get("id");
      const sender = params.get("sender_id");
      const recipient = params.get("recipient_id");
      const requestId = params.get("client_request_id");
      if (id?.startsWith("eq.")) rows = rows.filter((row) => row.id === id.slice(3));
      if (id?.startsWith("in.")) rows = rows.filter((row) => id.slice(4, -1).split(",").includes(row.id));
      if (sender?.startsWith("eq.")) rows = rows.filter((row) => row.sender_id === sender.slice(3));
      if (recipient?.startsWith("eq.")) rows = rows.filter((row) => row.recipient_id === recipient.slice(3));
      if (requestId?.startsWith("eq.")) rows = rows.filter((row) => row.client_request_id === requestId.slice(3));
      rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
      const offset = Number(params.get("offset") || 0);
      const limit = Number(params.get("limit") || 100);
      return rows.slice(offset, offset + limit);
    }
    if (table === "family_message_reads") {
      let rows = [...this.reads];
      const messageId = params.get("message_id");
      const memberId = params.get("member_id");
      if (messageId?.startsWith("eq.")) rows = rows.filter((row) => row.message_id === messageId.slice(3));
      if (messageId?.startsWith("in.")) rows = rows.filter((row) => messageId.slice(4, -1).split(",").includes(row.message_id));
      if (memberId?.startsWith("eq.")) rows = rows.filter((row) => row.member_id === memberId.slice(3));
      if (params.get("read_at") === "is.null") rows = rows.filter((row) => !row.read_at);
      return rows;
    }
    return [];
  }

  async upsertIgnore(_table, row) {
    const found = this.messages.find((item) => item.sender_id === row.sender_id && item.client_request_id === row.client_request_id);
    if (found) return [];
    const message = { ...row, id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(this.nextId++).padStart(12, "0")}`, created_at: new Date().toISOString() };
    this.messages.push(message);
    for (const member of members.filter((item) => item.id !== row.sender_id)) {
      this.reads.push({ message_id: message.id, member_id: member.id, read_at: null });
    }
    return [message];
  }

  async update(_table, query, values) {
    const params = new URLSearchParams(query);
    const target = this.reads.find((row) => row.message_id === params.get("message_id")?.slice(3)
      && row.member_id === params.get("member_id")?.slice(3) && !row.read_at);
    if (!target) return [];
    Object.assign(target, values);
    return [target];
  }
}

function request(handler, { method = "GET", url = "/api/family-messages", speakerId = members[0].id, body } = {}) {
  const token = createMobileSessionToken(SECRET, speakerId);
  const req = { method, url, headers: { authorization: `Bearer ${token}` }, body };
  const res = {
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(value) { this.payload = JSON.parse(value); },
  };
  return handler(req, res).then(() => res);
}

test("directed messages create one row and individual receipts for every other member", async () => {
  const supabase = new FakeSupabase();
  const handler = createFamilyMessagesApiHandler({ config: { mobileSessionSecret: SECRET }, supabase });
  const response = await request(handler, {
    method: "POST",
    body: {
      content: "No te olvides de comprar carne",
      recipient_id: members[1].id,
      request_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    },
  });
  assert.equal(response.status, 201);
  assert.equal(supabase.messages.length, 1);
  assert.deepEqual(supabase.reads.map((read) => read.member_id).sort(), members.slice(1).map((member) => member.id).sort());
});

test("same request id is idempotent and the session identity controls read receipts", async () => {
  const supabase = new FakeSupabase();
  const handler = createFamilyMessagesApiHandler({ config: { mobileSessionSecret: SECRET }, supabase });
  const body = { content: "Cena a las nueve", recipient_id: members[1].id, request_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };
  const first = await request(handler, { method: "POST", body });
  const retry = await request(handler, { method: "POST", body });
  assert.equal(first.status, 201);
  assert.equal(retry.status, 200);
  assert.equal(retry.payload.duplicate, true);
  assert.equal(supabase.messages.length, 1);

  const messageId = first.payload.message.id;
  const reader = members[1];
  const marked = await request(handler, {
    method: "POST",
    speakerId: reader.id,
    body: { action: "read", message_id: messageId, member_id: members[2].id },
  });
  assert.equal(marked.status, 200);
  assert.ok(supabase.reads.find((read) => read.member_id === reader.id).read_at);
  assert.equal(supabase.reads.find((read) => read.member_id === members[2].id).read_at, null);

  const readerInbox = await request(handler, { speakerId: reader.id });
  assert.equal(readerInbox.payload.unreadCount, 0);
  const otherInbox = await request(handler, { speakerId: members[2].id });
  assert.equal(otherInbox.payload.unreadCount, 1);
  assert.equal(otherInbox.payload.messages[0].isPriorityForMe, false);
  const recipientInbox = await request(handler, { speakerId: members[1].id });
  assert.equal(recipientInbox.payload.messages[0].isPriorityForMe, true);
});

test("conflicting content cannot reuse an idempotency key", async () => {
  const supabase = new FakeSupabase();
  const handler = createFamilyMessagesApiHandler({ config: { mobileSessionSecret: SECRET }, supabase });
  const requestId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  await request(handler, { method: "POST", body: { content: "Primer texto", request_id: requestId } });
  const conflict = await request(handler, { method: "POST", body: { content: "Otro texto", request_id: requestId } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.payload.status, "idempotency_conflict");
  assert.equal(supabase.messages.length, 1);
});

test("rejects an unauthenticated request", async () => {
  const handler = createFamilyMessagesApiHandler({ config: { mobileSessionSecret: SECRET }, supabase: new FakeSupabase() });
  const res = { writeHead(status) { this.status = status; }, end(value) { this.payload = JSON.parse(value); } };
  await handler({ method: "GET", url: "/api/family-messages", headers: {} }, res);
  assert.equal(res.status, 401);
});
