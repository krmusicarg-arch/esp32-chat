import { randomUUID } from "node:crypto";

export async function getLatestConversationId(supabase, { memberId }) {
  const query = new URLSearchParams({
    select: "id",
    member_id: `eq.${memberId}`,
    ended_at: "is.null",
    order: "started_at.desc",
    limit: "1",
  });
  const rows = await supabase.select("conversations", query);
  return rows[0]?.id || null;
}

export async function listConversations(supabase, { memberId, limit = 20 }) {
  const query = new URLSearchParams({
    select: "id,member_id,channel,started_at,ended_at,metadata",
    member_id: `eq.${memberId}`,
    order: "started_at.desc",
    limit: String(limit),
  });
  return supabase.select("conversations", query);
}

export async function listConversationMessages(supabase, {
  conversationId,
  memberId,
  limit = 50,
}) {
  const ownerQuery = new URLSearchParams({
    select: "id",
    id: `eq.${conversationId}`,
    member_id: `eq.${memberId}`,
    limit: "1",
  });
  if (!(await supabase.select("conversations", ownerQuery)).length) {
    const error = new Error("Conversation does not belong to the selected member");
    error.code = "INVALID_CONVERSATION";
    throw error;
  }
  const messagesQuery = new URLSearchParams({
    select: "role,content,created_at",
    conversation_id: `eq.${conversationId}`,
    role: "in.(user,assistant)",
    order: "created_at.asc",
    limit: String(limit),
  });
  return supabase.select("messages", messagesQuery);
}

export async function getConversationHistory(supabase, {
  conversationId,
  memberId,
  limit = 8,
}) {
  const ownerQuery = new URLSearchParams({
    select: "id",
    id: `eq.${conversationId}`,
    member_id: `eq.${memberId}`,
    limit: "1",
  });
  if (!(await supabase.select("conversations", ownerQuery)).length) {
    const error = new Error("Conversation does not belong to the selected member");
    error.code = "INVALID_CONVERSATION";
    throw error;
  }

  const messagesQuery = new URLSearchParams({
    select: "role,content,created_at",
    conversation_id: `eq.${conversationId}`,
    role: "in.(user,assistant)",
    order: "created_at.desc,role.asc",
    limit: String(limit * 2),
  });
  const messages = (await supabase.select("messages", messagesQuery)).reverse();
  const turns = [];
  let pendingQuestion = null;
  for (const message of messages) {
    if (message.role === "user") {
      pendingQuestion = message.content;
    } else if (message.role === "assistant" && pendingQuestion !== null) {
      turns.push({ question: pendingQuestion, answer: message.content });
      pendingQuestion = null;
    }
  }
  return turns.slice(-limit);
}

export async function saveConversation(supabase, {
  memberId,
  conversationId,
  question,
  answer,
  searchedWeb,
  channel = "esp32",
  subjectMemberId = null,
  telegramUpdateId = null,
}) {
  let id = conversationId;
  if (id) {
    const query = new URLSearchParams({
      select: "id",
      id: `eq.${id}`,
      member_id: `eq.${memberId}`,
      limit: "1",
    });
    if (!(await supabase.select("conversations", query)).length) {
      const error = new Error("Conversation does not belong to the selected member");
      error.code = "INVALID_CONVERSATION";
      throw error;
    }
  } else {
    id = randomUUID();
    await supabase.insert("conversations", {
      id,
      member_id: memberId,
      channel,
      metadata: {},
    });
  }

  const userMessageId = randomUUID();
  const assistantMessageId = randomUUID();
  const turnTime = new Date();
  const userCreatedAt = turnTime.toISOString();
  const assistantCreatedAt = new Date(turnTime.getTime() + 1).toISOString();
  await supabase.insert("messages", [
    {
      id: userMessageId,
      conversation_id: id,
      role: "user",
      content: question,
      sender_member_id: memberId,
      subject_member_id: subjectMemberId,
      created_at: userCreatedAt,
      metadata: {
        searched_web: searchedWeb,
        ...(telegramUpdateId ? { telegram_update_id: String(telegramUpdateId) } : {}),
      },
    },
    {
      id: assistantMessageId,
      conversation_id: id,
      role: "assistant",
      content: answer,
      sender_member_id: null,
      subject_member_id: memberId,
      created_at: assistantCreatedAt,
      metadata: {
        searched_web: searchedWeb,
        ...(telegramUpdateId ? { telegram_update_id: String(telegramUpdateId) } : {}),
      },
    },
  ]);
  return { conversationId: id, userMessageId, assistantMessageId };
}

export async function getTelegramUpdateResponse(supabase, { memberId, telegramUpdateId }) {
  if (!telegramUpdateId) return null;
  const userQuery = new URLSearchParams({
    select: "conversation_id,content",
    sender_member_id: `eq.${memberId}`,
    role: "eq.user",
    "metadata->>telegram_update_id": `eq.${telegramUpdateId}`,
    limit: "1",
  });
  const userMessage = (await supabase.select("messages", userQuery))[0];
  if (!userMessage) return null;
  const assistantQuery = new URLSearchParams({
    select: "content",
    conversation_id: `eq.${userMessage.conversation_id}`,
    role: "eq.assistant",
    "metadata->>telegram_update_id": `eq.${telegramUpdateId}`,
    limit: "1",
  });
  const assistantMessage = (await supabase.select("messages", assistantQuery))[0];
  return assistantMessage?.content || null;
}

export async function setMessageSubject(supabase, messageId, subjectMemberId) {
  if (!messageId) return;
  const query = new URLSearchParams({ id: `eq.${messageId}` });
  await supabase.update("messages", query, { subject_member_id: subjectMemberId });
}

export async function updateMessageContent(supabase, messageId, content) {
  const query = new URLSearchParams({ id: `eq.${messageId}` });
  await supabase.update("messages", query, { content });
}
