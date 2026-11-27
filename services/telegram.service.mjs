import { createHash } from "node:crypto";
import { sendTelegramText } from "../lib/telegram_webhook.mjs";

export async function getActiveTelegramMembers(supabase) {
  const query = new URLSearchParams({
    select: "id,name,active,telegram_user_id,telegram_private_chat_id",
    active: "eq.true",
    order: "name.asc",
    limit: "5",
  });
  const members = await supabase.select("family_members", query);
  if (members.length !== 4) throw new Error("Expected four active family members");
  return members;
}

function deterministicUuid(value) {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function registerTelegramPrivateChat(supabase, {
  memberId,
  telegramUserId,
  privateChatId,
}) {
  const query = new URLSearchParams({
    select: "id,active,telegram_user_id,telegram_private_chat_id",
    id: `eq.${memberId}`,
    active: "eq.true",
    limit: "1",
  });
  const rows = await supabase.select("family_members", query);
  const member = rows[0];
  if (!member) throw new Error("Telegram mapping does not point to an active member");
  if ((member.telegram_user_id && String(member.telegram_user_id) !== String(telegramUserId))
      || (member.telegram_private_chat_id
        && String(member.telegram_private_chat_id) !== String(privateChatId))) {
    throw new Error("Telegram identity conflicts with its existing member link");
  }
  if (!member.telegram_user_id || !member.telegram_private_chat_id) {
    const updateQuery = new URLSearchParams({ id: `eq.${memberId}`, active: "eq.true" });
    const updated = await supabase.update("family_members", updateQuery, {
      telegram_user_id: String(telegramUserId),
      telegram_private_chat_id: String(privateChatId),
    });
    if (!updated.length) throw new Error("Telegram identity could not be linked");
  }
  return member;
}

export async function storeTelegramGroupMessage(supabase, {
  senderId,
  content,
  chatId,
  messageId,
  updateId,
  messageDate,
}) {
  const requestId = deterministicUuid(`telegram:${chatId}:${messageId}`);
  const conflictQuery = new URLSearchParams({
    on_conflict: "telegram_chat_id,telegram_message_id",
  });
  const inserted = await supabase.upsertIgnore("family_messages", {
    sender_id: senderId,
    recipient_id: null,
    content,
    client_request_id: requestId,
    source_channel: "telegram_group",
    telegram_chat_id: String(chatId),
    telegram_message_id: String(messageId),
    telegram_update_id: String(updateId),
    ...(messageDate ? { created_at: new Date(messageDate * 1000).toISOString() } : {}),
  }, conflictQuery);
  if (inserted[0]) return { message: inserted[0], duplicate: false };

  const existingQuery = new URLSearchParams({
    select: "id,sender_id,content,created_at",
    telegram_chat_id: `eq.${chatId}`,
    telegram_message_id: `eq.${messageId}`,
    limit: "1",
  });
  const existing = await supabase.select("family_messages", existingQuery);
  if (!existing[0]) throw new Error("Telegram group message insert returned no row");
  return { message: existing[0], duplicate: true };
}

export async function getTelegramGroupContext(supabase, {
  chatId,
  limit = 40,
}) {
  if (!chatId) return [];
  const query = new URLSearchParams({
    select: "sender_id,content,created_at",
    source_channel: "eq.telegram_group",
    telegram_chat_id: `eq.${chatId}`,
    order: "created_at.desc",
    limit: String(Math.min(Math.max(limit, 1), 60)),
  });
  const rows = (await supabase.select("family_messages", query)).reverse();
  if (!rows.length) return [];
  const memberIds = [...new Set(rows.map((row) => row.sender_id))];
  const membersQuery = new URLSearchParams({
    select: "id,name",
    id: `in.(${memberIds.join(",")})`,
    limit: String(memberIds.length),
  });
  const members = await supabase.select("family_members", membersQuery);
  const names = new Map(members.map((member) => [member.id, member.name]));
  return rows.map((row) => ({
    speaker: names.get(row.sender_id) || "Integrante",
    text: String(row.content || "").slice(0, 800),
    created_at: row.created_at,
  }));
}

function deliveryIdempotencyKey(messageId, memberId) {
  return `family-message:${messageId}:${memberId}:telegram`;
}

async function getOrCreateDelivery(supabase, { messageId, memberId }) {
  const key = deliveryIdempotencyKey(messageId, memberId);
  const query = new URLSearchParams({
    on_conflict: "family_message_id,member_id,channel",
  });
  const inserted = await supabase.upsertIgnore("notification_deliveries", {
    reminder_id: null,
    family_message_id: messageId,
    member_id: memberId,
    channel: "telegram",
    delivery_status: "pending",
    idempotency_key: key,
    attempts: 0,
  }, query);
  if (inserted[0]) return inserted[0];
  const existingQuery = new URLSearchParams({
    select: "id,delivery_status,attempts,external_message_id",
    family_message_id: `eq.${messageId}`,
    member_id: `eq.${memberId}`,
    channel: "eq.telegram",
    limit: "1",
  });
  const rows = await supabase.select("notification_deliveries", existingQuery);
  if (!rows[0]) throw new Error("Telegram delivery record could not be loaded");
  return rows[0];
}

async function setDelivery(supabase, deliveryId, patch) {
  const query = new URLSearchParams({ id: `eq.${deliveryId}` });
  await supabase.update("notification_deliveries", query, {
    ...patch,
    updated_at: new Date().toISOString(),
  });
}

export async function deliverFamilyMessageToTelegram({
  supabase,
  botToken,
  message,
  members,
  senderId,
  fetchImpl = fetch,
}) {
  const recipients = message.recipient_id
    ? members.filter((member) => member.id === message.recipient_id)
    : members.filter((member) => member.id !== senderId);
  const results = [];
  for (const recipient of recipients) {
    const delivery = await getOrCreateDelivery(supabase, {
      messageId: message.id,
      memberId: recipient.id,
    });
    if (delivery.delivery_status === "sent") {
      results.push({ memberId: recipient.id, status: "sent", duplicate: true });
      continue;
    }
    if (!recipient.telegram_private_chat_id) {
      await setDelivery(supabase, delivery.id, {
        delivery_status: "failed",
        last_error: "recipient_must_start_private_chat",
      });
      results.push({ memberId: recipient.id, status: "failed", reason: "must_start_private_chat" });
      continue;
    }

    const claimQuery = new URLSearchParams({
      id: `eq.${delivery.id}`,
      delivery_status: "eq.pending",
    });
    const claimed = await supabase.update("notification_deliveries", claimQuery, {
      delivery_status: "processing",
      attempts: Number(delivery.attempts || 0) + 1,
      last_error: null,
      updated_at: new Date().toISOString(),
    });
    if (!claimed.length) {
      results.push({ memberId: recipient.id, status: delivery.delivery_status, duplicate: true });
      continue;
    }

    try {
      let telegramMessageId;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          telegramMessageId = await sendTelegramText({
            botToken,
            chatId: recipient.telegram_private_chat_id,
            text: message.content,
            fetchImpl,
          });
          break;
        } catch (error) {
          if (error.code !== "telegram_rate_limited" || !error.retryAfter
              || error.retryAfter > 2 || attempt === 2) throw error;
          await new Promise((resolve) => setTimeout(resolve, error.retryAfter * 1000));
        }
      }
      await setDelivery(supabase, delivery.id, {
        delivery_status: "sent",
        external_message_id: telegramMessageId ? String(telegramMessageId) : null,
        sent_at: new Date().toISOString(),
        last_error: null,
      });
      results.push({ memberId: recipient.id, status: "sent" });
    } catch (error) {
      await setDelivery(supabase, delivery.id, {
        delivery_status: "failed",
        last_error: error.code || "telegram_send_failed",
      });
      results.push({ memberId: recipient.id, status: "failed", reason: "telegram_send_failed" });
    }
  }
  return results;
}

export async function retryMessagesAfterPrivateChatStarts({
  supabase,
  botToken,
  memberId,
  fetchImpl = fetch,
}) {
  const query = new URLSearchParams({
    select: "id,family_message_id",
    member_id: `eq.${memberId}`,
    channel: "eq.telegram",
    delivery_status: "eq.failed",
    last_error: "eq.recipient_must_start_private_chat",
    order: "created_at.asc",
    limit: "10",
  });
  const pending = await supabase.select("notification_deliveries", query);
  if (!pending.length) return;
  const members = await getActiveTelegramMembers(supabase);
  const member = members.find((item) => item.id === memberId);
  if (!member?.telegram_private_chat_id) return;
  for (const item of pending) {
    const resetQuery = new URLSearchParams({
      id: `eq.${item.id}`,
      delivery_status: "eq.failed",
      last_error: "eq.recipient_must_start_private_chat",
    });
    const reset = await supabase.update("notification_deliveries", resetQuery, {
      delivery_status: "pending",
      last_error: null,
      updated_at: new Date().toISOString(),
    });
    if (!reset.length) continue;
    const messageQuery = new URLSearchParams({
      select: "id,sender_id,recipient_id,content",
      id: `eq.${item.family_message_id}`,
      limit: "1",
    });
    const message = (await supabase.select("family_messages", messageQuery))[0];
    if (message) {
      await deliverFamilyMessageToTelegram({
        supabase,
        botToken,
        message,
        senderId: message.sender_id,
        members,
        fetchImpl,
      });
    }
  }
}
