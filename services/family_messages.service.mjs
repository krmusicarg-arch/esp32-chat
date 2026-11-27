const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function uuidList(ids) {
  return `in.(${ids.filter((id) => UUID_PATTERN.test(id)).join(",")})`;
}

export async function createFamilyMessage(supabase, {
  senderId,
  recipientId = null,
  content,
  requestId,
  members,
  sourceChannel = "pwa",
  telegramUpdateId = null,
}) {
  if (!members.some((member) => member.id === senderId)) {
    const error = new Error("Sender is not an active family member");
    error.code = "INVALID_SPEAKER";
    throw error;
  }
  if (recipientId !== null && !members.some((member) => member.id === recipientId)) {
    const error = new Error("Recipient is not an active family member");
    error.code = "INVALID_RECIPIENT";
    throw error;
  }
  if (recipientId === senderId) {
    const error = new Error("A member cannot message themselves");
    error.code = "INVALID_RECIPIENT";
    throw error;
  }
  const text = typeof content === "string" ? content.trim() : "";
  if (!text || text.length > 1000 || !UUID_PATTERN.test(requestId || "")) {
    const error = new Error("Message content or request identifier is invalid");
    error.code = "INVALID_MESSAGE";
    throw error;
  }

  const conflictQuery = new URLSearchParams({ on_conflict: "sender_id,client_request_id" });
  const messageRow = {
    sender_id: senderId,
    recipient_id: recipientId,
    content: text,
    client_request_id: requestId,
    ...(sourceChannel !== "pwa" ? { source_channel: sourceChannel } : {}),
    ...(telegramUpdateId ? { telegram_update_id: String(telegramUpdateId) } : {}),
  };
  const inserted = await supabase.upsertIgnore("family_messages", messageRow, conflictQuery);
  if (inserted[0]) return { message: inserted[0], duplicate: false };

  const existingQuery = new URLSearchParams({
    select: "id,sender_id,recipient_id,content,created_at,client_request_id",
    sender_id: `eq.${senderId}`,
    client_request_id: `eq.${requestId}`,
    limit: "1",
  });
  const existing = await supabase.select("family_messages", existingQuery);
  if (!existing[0]) throw new Error("Message insert returned no row");
  if (existing[0].content !== text || (existing[0].recipient_id || null) !== recipientId) {
    const error = new Error("Idempotency key was reused for different message content");
    error.code = "IDEMPOTENCY_CONFLICT";
    throw error;
  }
  return { message: existing[0], duplicate: true };
}

export async function listFamilyMessages(supabase, { limit = 50, offset = 0 }) {
  const query = new URLSearchParams({
    select: "id,sender_id,recipient_id,content,created_at,client_request_id,source_channel",
    order: "created_at.desc",
    limit: String(limit),
    offset: String(offset),
  });
  return supabase.select("family_messages", query);
}

export async function getUnreadFamilyMessages(supabase, { memberId, limit = 50 }) {
  const readsQuery = new URLSearchParams({
    select: "message_id,read_at",
    member_id: `eq.${memberId}`,
    read_at: "is.null",
  });
  const unreadReads = await supabase.select("family_message_reads", readsQuery);
  const messageIds = [...new Set(unreadReads.map((read) => read.message_id))];
  if (messageIds.length === 0) return { count: 0, messages: [] };
  const messagesQuery = new URLSearchParams({
    select: "id,sender_id,recipient_id,content,created_at,client_request_id,source_channel",
    id: uuidList(messageIds),
    order: "created_at.desc",
    limit: String(limit),
  });
  const messages = await supabase.select("family_messages", messagesQuery);
  return { count: messageIds.length, messages };
}

export async function getFamilyMessageReadStates(supabase, { messageIds }) {
  const ids = [...new Set(messageIds)].filter((id) => UUID_PATTERN.test(id));
  if (ids.length === 0) return [];
  const query = new URLSearchParams({ select: "message_id,member_id,read_at", message_id: uuidList(ids) });
  return supabase.select("family_message_reads", query);
}

export async function getMessageReadStatus(supabase, { messageId }) {
  const query = new URLSearchParams({
    select: "id,sender_id,recipient_id,content,created_at",
    id: `eq.${messageId}`,
    limit: "1",
  });
  const rows = await supabase.select("family_messages", query);
  return rows[0] || null;
}

export async function markFamilyMessageRead(supabase, { messageId, memberId }) {
  const query = new URLSearchParams({
    message_id: `eq.${messageId}`,
    member_id: `eq.${memberId}`,
    read_at: "is.null",
  });
  return supabase.update("family_message_reads", query, { read_at: new Date().toISOString() });
}

export async function getLatestSentMessage(supabase, { senderId, recipientId = null }) {
  const query = new URLSearchParams({
    select: "id,sender_id,recipient_id,content,created_at",
    sender_id: `eq.${senderId}`,
    order: "created_at.desc",
    limit: "1",
  });
  if (recipientId) query.set("recipient_id", `eq.${recipientId}`);
  const rows = await supabase.select("family_messages", query);
  return rows[0] || null;
}
