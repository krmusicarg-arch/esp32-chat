import { mobileCorsResponse, verifyMobileSessionToken } from "./mobile_auth.mjs";
import { getActiveFamilyMembers, getFamilySettings } from "../services/family.service.mjs";
import {
  createFamilyMessage,
  getFamilyMessageReadStates,
  getMessageReadStatus,
  getUnreadFamilyMessages,
  listFamilyMessages,
  markFamilyMessageRead,
} from "../services/family_messages.service.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 4096;

function respond(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  let body;
  if (req.body !== undefined) {
    body = typeof req.body === "string" || Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString()) : req.body;
  } else {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) throw Object.assign(new Error("Request too large"), { statusCode: 413 });
      chunks.push(chunk);
    }
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES) throw Object.assign(new Error("Request too large"), { statusCode: 413 });
  return body;
}

function mapMessages(messages, reads, members, currentMemberId) {
  const names = new Map(members.map((member) => [member.id, member.name]));
  const readsByMessage = new Map();
  for (const read of reads) {
    if (!readsByMessage.has(read.message_id)) readsByMessage.set(read.message_id, new Map());
    readsByMessage.get(read.message_id).set(read.member_id, read.read_at || null);
  }
  return messages.map((message) => {
    const messageReads = readsByMessage.get(message.id) || new Map();
    const readers = members.filter((member) => member.id !== message.sender_id).map((member) => ({
      memberId: member.id,
      name: member.name,
      readAt: messageReads.get(member.id) || null,
    }));
    return {
      id: message.id,
      senderId: message.sender_id,
      senderName: names.get(message.sender_id) || "Integrante",
      recipientId: message.recipient_id || null,
      recipientName: names.get(message.recipient_id) || null,
      content: message.content,
      createdAt: message.created_at,
      isPriorityForMe: Boolean(message.recipient_id && message.recipient_id === currentMemberId),
      readBy: readers,
      readCount: readers.filter((reader) => reader.readAt).length,
      unreadCount: readers.filter((reader) => !reader.readAt).length,
    };
  });
}

export function createFamilyMessagesApiHandler({ config, supabase, clock = () => new Date() }) {
  return async function handleFamilyMessages(req, res) {
    res = mobileCorsResponse(req, res, config, "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (!supabase) return respond(res, 503, { status: "family_storage_error" });
    const authorization = req.headers?.authorization || "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    const session = verifyMobileSessionToken(config.mobileSessionSecret, token, clock());
    if (!session) return respond(res, 401, { status: "unauthorized" });

    try {
      const settings = await getFamilySettings(supabase);
      const members = await getActiveFamilyMembers(supabase, settings);
      const member = members.find((item) => item.id === session.speakerId);
      if (!member) return respond(res, 401, { status: "invalid_speaker" });
      const url = new URL(req.url || "/", "http://localhost");

      if (req.method === "GET") {
        const messageId = url.searchParams.get("message_id") || "";
        if (messageId) {
          if (!UUID_PATTERN.test(messageId)) return respond(res, 400, { status: "invalid_request" });
          const message = await getMessageReadStatus(supabase, { messageId });
          if (!message) return respond(res, 404, { status: "message_not_found" });
          const reads = await getFamilyMessageReadStates(supabase, { messageIds: [messageId] });
          return respond(res, 200, {
            status: "ok",
            message: mapMessages([message], reads, members, member.id)[0],
          });
        }
        const limitValue = Number(url.searchParams.get("limit") || 50);
        const offsetValue = Number(url.searchParams.get("offset") || 0);
        if (!Number.isInteger(limitValue) || limitValue < 1 || limitValue > 100
            || !Number.isInteger(offsetValue) || offsetValue < 0 || offsetValue > 100000) {
          return respond(res, 400, { status: "invalid_request" });
        }
        const unread = await getUnreadFamilyMessages(supabase, { memberId: member.id, limit: 100 });
        const messages = url.searchParams.get("unread_only") === "true"
          ? unread.messages.slice(0, limitValue)
          : await listFamilyMessages(supabase, { limit: limitValue, offset: offsetValue });
        const reads = await getFamilyMessageReadStates(supabase, { messageIds: messages.map((item) => item.id) });
        return respond(res, 200, {
          status: "ok",
          unreadCount: unread.count,
          members: members.map(({ id, name }) => ({ id, name })),
          hasMore: messages.length === limitValue,
          messages: mapMessages(messages, reads, members, member.id),
        });
      }

      if (req.method === "POST") {
        const body = await readBody(req);
        if (!body || typeof body !== "object" || Array.isArray(body)) return respond(res, 400, { status: "invalid_request" });
        if (body.action === "read") {
          if (!UUID_PATTERN.test(body.message_id || "")) return respond(res, 400, { status: "invalid_request" });
          const message = await getMessageReadStatus(supabase, { messageId: body.message_id });
          if (!message) return respond(res, 404, { status: "message_not_found" });
          if (message.sender_id === member.id) return respond(res, 200, { status: "ok", isSender: true, alreadyRead: true });
          const existingQuery = new URLSearchParams({
            select: "read_at",
            message_id: `eq.${body.message_id}`,
            member_id: `eq.${member.id}`,
            limit: "1",
          });
          const existing = await supabase.select("family_message_reads", existingQuery);
          if (!existing[0]) return respond(res, 409, { status: "read_receipt_not_found" });
          const updated = existing[0].read_at
            ? []
            : await markFamilyMessageRead(supabase, { messageId: body.message_id, memberId: member.id });
          return respond(res, 200, {
            status: "ok",
            alreadyRead: Boolean(existing[0].read_at) || updated.length === 0,
          });
        }

        const recipientId = body.recipient_id === undefined || body.recipient_id === null ? null : body.recipient_id;
        if ((recipientId !== null && (typeof recipientId !== "string" || !UUID_PATTERN.test(recipientId)))
            || typeof body.content !== "string" || typeof body.request_id !== "string" || !UUID_PATTERN.test(body.request_id)) {
          return respond(res, 400, { status: "invalid_request" });
        }
        const result = await createFamilyMessage(supabase, {
          senderId: member.id,
          recipientId,
          content: body.content,
          requestId: body.request_id,
          members,
        });
        return respond(res, result.duplicate ? 200 : 201, {
          status: "ok",
          duplicate: result.duplicate,
          message: mapMessages([result.message], [], members, member.id)[0],
        });
      }
      return respond(res, 405, { status: "method_not_allowed" });
    } catch (error) {
      if (error.statusCode === 413 || error instanceof SyntaxError) return respond(res, error.statusCode || 400, { status: "invalid_request" });
      if (error.code === "INVALID_RECIPIENT") return respond(res, 400, { status: "invalid_recipient" });
      if (error.code === "INVALID_MESSAGE") return respond(res, 400, { status: "invalid_message" });
      if (error.code === "IDEMPOTENCY_CONFLICT") return respond(res, 409, { status: "idempotency_conflict" });
      console.error("[Family messages API] request failed:", error.name || "Error");
      return respond(res, 503, { status: "family_storage_error" });
    }
  };
}
