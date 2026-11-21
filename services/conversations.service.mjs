import { randomUUID } from "node:crypto";

export async function getRecentConversations(supabase, { memberId, limit = 3 }) {
  const query = new URLSearchParams({
    select: "conversation_id,content,created_at",
    sender_member_id: `eq.${memberId}`,
    role: "eq.user",
    order: "created_at.desc",
    limit: String(limit),
  });
  const userMessages = await supabase.select("messages", query);
  const turns = [];
  for (const userMessage of userMessages) {
    const conversationQuery = new URLSearchParams({
      select: "role,content",
      conversation_id: `eq.${userMessage.conversation_id}`,
      order: "created_at.asc",
      limit: "10",
    });
    const messages = await supabase.select("messages", conversationQuery);
    const user = messages.find((message) => message.role === "user");
    const answer = messages.find((message) => message.role === "assistant");
    if (user && answer) turns.push({ question: user.content, answer: answer.content });
  }
  return turns.reverse();
}

export async function saveConversation(supabase, {
  memberId,
  conversationId,
  question,
  answer,
  searchedWeb,
  subjectMemberId = null,
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
      channel: "esp32",
      metadata: {},
    });
  }

  const userMessageId = randomUUID();
  const assistantMessageId = randomUUID();
  await supabase.insert("messages", [
    {
      id: userMessageId,
      conversation_id: id,
      role: "user",
      content: question,
      sender_member_id: memberId,
      subject_member_id: subjectMemberId,
      metadata: { searched_web: searchedWeb },
    },
    {
      id: assistantMessageId,
      conversation_id: id,
      role: "assistant",
      content: answer,
      sender_member_id: null,
      subject_member_id: memberId,
      metadata: { searched_web: searchedWeb },
    },
  ]);
  return { conversationId: id, userMessageId, assistantMessageId };
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
