import { timingSafeEqual } from "node:crypto";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_UPDATE_BYTES = 1024 * 1024;
const DEDUP_SECONDS = 48 * 60 * 60;

export function telegramSettingsFromEnv(env = process.env) {
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
  const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (!botToken) throw new Error("TELEGRAM_BOT_TOKEN is required");
  if (!webhookSecret || !/^[A-Za-z0-9_-]{32,256}$/.test(webhookSecret)) {
    throw new Error("TELEGRAM_WEBHOOK_SECRET must be 32-256 URL-safe characters");
  }

  let memberMap;
  try {
    memberMap = JSON.parse(env.TELEGRAM_MEMBER_MAP || "");
  } catch {
    throw new Error("TELEGRAM_MEMBER_MAP must be a JSON object of Telegram IDs to member UUIDs");
  }
  if (!memberMap || Array.isArray(memberMap) || typeof memberMap !== "object") {
    throw new Error("TELEGRAM_MEMBER_MAP must be a JSON object");
  }
  const entries = Object.entries(memberMap);
  if (entries.length < 1 || entries.length > 4
      || entries.some(([userId, memberId]) => !/^\d{1,20}$/.test(userId)
        || typeof memberId !== "string" || !UUID_PATTERN.test(memberId))
      || new Set(entries.map(([, memberId]) => memberId.toLowerCase())).size !== entries.length) {
    throw new Error("TELEGRAM_MEMBER_MAP must map one to four distinct Telegram IDs to existing member UUIDs");
  }

  const groupChatId = (env.TELEGRAM_GROUP_CHAT_ID || "").trim();
  if (groupChatId && !/^-?\d{1,20}$/.test(groupChatId)) {
    throw new Error("TELEGRAM_GROUP_CHAT_ID must be a numeric Telegram chat ID");
  }
  return { botToken, webhookSecret, memberMap, groupChatId };
}

function safeEqual(expected, provided) {
  if (typeof expected !== "string" || typeof provided !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

function respond(res, status, payload = { ok: true }) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

async function readUpdate(req) {
  if (req.body !== undefined) {
    const body = typeof req.body === "string" || Buffer.isBuffer(req.body)
      ? JSON.parse(req.body.toString()) : req.body;
    if (Buffer.byteLength(JSON.stringify(body)) > MAX_UPDATE_BYTES) {
      throw Object.assign(new Error("Update too large"), { statusCode: 413 });
    }
    return body;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_UPDATE_BYTES) throw Object.assign(new Error("Update too large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function getHeader(req, name) {
  const headers = req.headers || {};
  return headers[name.toLowerCase()] ?? headers[name] ?? "";
}

function messageForUpdate(update, settings) {
  const message = update?.message;
  const text = message?.text || message?.caption || "";
  const senderId = message?.from?.id;
  const chatId = message?.chat?.id;
  const voice = message?.voice;
  if (!message || (typeof text !== "string" || !text.trim()) && !voice
      || !Number.isSafeInteger(senderId) || !Number.isSafeInteger(chatId)) return null;

  const privateChat = message.chat.type === "private" && String(chatId) === String(senderId);
  const groupChat = ["group", "supergroup"].includes(message.chat.type)
    && settings.groupChatId && String(chatId) === settings.groupChatId;
  if (!privateChat && !groupChat) return null;

  const memberId = settings.memberMap[String(senderId)];
  if (!memberId) {
    return privateChat
      ? { unknownPrivate: true, chatId: String(chatId) }
      : null;
  }
  let question = text.trim();
  let addressed = privateChat;
  if (groupChat) {
    addressed = /@RobertFamiliaBot\b/i.test(question)
      || message.reply_to_message?.from?.username?.toLowerCase() === "robertfamiliabot";
    question = question.replace(/@RobertFamiliaBot\b/ig, "").trim();
  }
  if (!question && !voice) return null;
  if (question.length > 400) return null;
  return {
    memberId,
    question,
    chatId: String(chatId),
    senderId: String(senderId),
    isPrivate: privateChat,
    isGroup: Boolean(groupChat),
    addressed,
    messageId: Number.isSafeInteger(message.message_id) ? message.message_id : null,
    updateId: update.update_id,
    messageDate: Number.isSafeInteger(message.date) ? message.date : null,
    voice: voice ? {
      fileId: voice.file_id,
      fileSize: Number.isSafeInteger(voice.file_size) ? voice.file_size : null,
      mimeType: voice.mime_type || "audio/ogg",
    } : null,
  };
}

export async function sendTelegramText({ botToken, chatId, text, fetchImpl = fetch }) {
  const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4096) }),
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.ok) {
    const error = new Error("Telegram sendMessage failed");
    error.code = response.status === 403 ? "telegram_private_chat_not_started"
      : response.status === 429 ? "telegram_rate_limited" : "telegram_send_failed";
    if (response.status === 429) error.retryAfter = Number(result?.parameters?.retry_after) || 0;
    error.retryable = response.status === 429 || response.status >= 500;
    throw error;
  }
  return result.result?.message_id ?? null;
}

export function createTelegramWebhookHandler({
  settings,
  redis,
  processText,
  processGroupMessage = async () => {},
  isProcessed = async () => false,
  transcribeAudio = null,
  shouldRespondToGroup = () => false,
  fetchImpl = fetch,
  sendMessage = (chatId, text) => sendTelegramText({
    botToken: settings.botToken, chatId, text, fetchImpl,
  }),
}) {
  return async function telegramWebhook(req, res) {
    if (req.method !== "POST") return respond(res, 405, { ok: false });
    if (!safeEqual(settings.webhookSecret, getHeader(req, "x-telegram-bot-api-secret-token"))) {
      return respond(res, 401, { ok: false });
    }
    let update;
    try {
      update = await readUpdate(req);
    } catch (error) {
      return respond(res, error.statusCode || 400, { ok: false });
    }
    if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) {
      return respond(res, 400, { ok: false });
    }
    const key = `telegram:update:${update.update_id}`;
    try {
      const reserved = await redis.set(key, "processing", { ex: 120, nx: true });
      if (reserved !== "OK") {
        let state = null;
        try { state = await redis.get(key); } catch { /* Redis retry below is safe. */ }
        return state === "processing"
          ? respond(res, 503, { ok: false })
          : respond(res, 200);
      }
    } catch (error) {
      console.error("[Telegram] update reservation failed:", error.name || "Error");
      return respond(res, 503, { ok: false });
    }

    let completed = false;
    let groupCooldownKey = null;
    try {
      const incoming = messageForUpdate(update, settings);
      if (!incoming) {
        await redis.set(key, "processed", { ex: DEDUP_SECONDS });
        completed = true;
        return respond(res, 200);
      }
      if (incoming.unknownPrivate) {
        await redis.set(key, "answered", { ex: DEDUP_SECONDS });
        completed = true;
        await sendMessage(incoming.chatId,
          "No pude vincular esta cuenta familiar. Pedile al administrador que asocie tu Telegram a tu integrante de Robert.");
        return respond(res, 200);
      }
      if ((incoming.isPrivate || incoming.isGroup) && await isProcessed(incoming)) {
        completed = true;
        return respond(res, 200);
      }
      if (incoming.voice) {
        if (!transcribeAudio) throw new Error("Telegram audio transcription is not configured");
        try {
          incoming.question = await transcribeAudio(incoming.voice);
        } catch (error) {
          if (!["telegram_audio_too_large", "unsupported_telegram_audio_type",
            "invalid_telegram_file_path", "empty_telegram_audio",
            "telegram_audio_not_configured", "telegram_audio_transcription_failed"].includes(error.code)) throw error;
          await redis.set(key, "answered", { ex: DEDUP_SECONDS });
          completed = true;
          const answer = error.code === "telegram_audio_not_configured"
            ? "La transcripción de audio todavía no está configurada. Mandame el mensaje en texto."
            : "No pude procesar ese audio. Probá con un audio OGG, MP3 o M4A de menos de 14 MB.";
          await sendMessage(incoming.chatId, answer);
          return respond(res, 200);
        }
        if (!incoming.question || incoming.question.length > 400) {
          await redis.set(key, "answered", { ex: DEDUP_SECONDS });
          completed = true;
          await sendMessage(incoming.chatId, "No pude transcribir ese audio. Probá con un mensaje más corto o en texto.");
          return respond(res, 200);
        }
      }
      if (incoming.isGroup) {
        await processGroupMessage(incoming);
        if (!incoming.addressed && !shouldRespondToGroup(incoming.question)) {
          await redis.set(key, "processed", { ex: DEDUP_SECONDS });
          completed = true;
          return respond(res, 200);
        }
        if (!incoming.addressed) {
          groupCooldownKey = `telegram:group-reply:${incoming.chatId}`;
          const cooldown = await redis.set(
            groupCooldownKey,
            String(update.update_id),
            { ex: 180, nx: true },
          );
          if (cooldown !== "OK") {
            await redis.set(key, "processed", { ex: DEDUP_SECONDS });
            completed = true;
            return respond(res, 200);
          }
        }
      }
      const answer = await processText(incoming);
      if (!answer || typeof answer !== "string") throw new Error("Assistant returned no answer");
      await redis.set(key, "answered", { ex: DEDUP_SECONDS });
      completed = true;
      await sendMessage(incoming.chatId, answer);
      return respond(res, 200);
    } catch (error) {
      console.error("[Telegram] update processing failed:", error.name || "Error");
      if (!completed) {
        try { await redis.del(key); } catch { /* Redis TTL permits later retry. */ }
        if (groupCooldownKey) {
          try { await redis.del(groupCooldownKey); } catch { /* Cooldown TTL is a fallback. */ }
        }
      }
      return respond(res, 500, { ok: false });
    }
  };
}
