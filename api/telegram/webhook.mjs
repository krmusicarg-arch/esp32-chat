import { waitUntil } from "@vercel/functions";
import { createChatHandler, configFromEnv } from "../../lib/assistant.mjs";
import { createMobileSessionToken } from "../../lib/mobile_auth.mjs";
import { createUpstashStore } from "../../lib/redis_store.mjs";
import { createSupabaseClient } from "../../database/supabase.mjs";
import { getTelegramUpdateResponse } from "../../services/conversations.service.mjs";
import {
  createTelegramWebhookHandler,
  telegramSettingsFromEnv,
} from "../../lib/telegram_webhook.mjs";
import { transcribeTelegramVoice } from "../../services/telegram_audio.service.mjs";
import {
  registerTelegramPrivateChat,
  retryMessagesAfterPrivateChatStarts,
  storeTelegramGroupMessage,
} from "../../services/telegram.service.mjs";

export const maxDuration = 60;

let handler;
let initializationError;

export default async function telegramWebhook(req, res) {
  if (!handler) {
    try {
      const config = configFromEnv();
      const settings = telegramSettingsFromEnv();
      const redis = createUpstashStore(config);
      const supabase = createSupabaseClient(config);
      const chat = createChatHandler({ config, redis, supabase, scheduleBackground: waitUntil });
      handler = createTelegramWebhookHandler({
        settings,
        redis,
        transcribeAudio: (voice) => transcribeTelegramVoice({
          voice,
          config,
          botToken: settings.botToken,
        }),
        processGroupMessage: async (incoming) => {
          if (!incoming.messageId) throw new Error("Telegram group message has no message ID");
          return storeTelegramGroupMessage(supabase, {
            senderId: incoming.memberId,
            content: incoming.question,
            chatId: incoming.chatId,
            messageId: incoming.messageId,
            updateId: incoming.updateId,
            messageDate: incoming.messageDate,
          });
        },
        isProcessed: async (incoming) => Boolean(await getTelegramUpdateResponse(supabase, {
          memberId: incoming.memberId,
          telegramUpdateId: String(incoming.updateId),
        })),
        shouldRespondToGroup: (question) => (
          /\?/u.test(question)
          && /\b(?:qu[eé] tenemos|qu[eé] hay|cu[aá]ndo es|qu[eé] dijo|qu[eé] hab[ií]amos|agenda|cumplea[nñ]os|recordame|recordatorio|calendario|clima|evento)\b/iu.test(question)
        ),
        processText: async (incoming) => {
          const { memberId, question } = incoming;
          if (incoming.isPrivate) {
            await registerTelegramPrivateChat(supabase, {
              memberId,
              telegramUserId: incoming.senderId,
              privateChatId: incoming.chatId,
            });
            if (config.telegramBotToken) {
              await retryMessagesAfterPrivateChatStarts({
                supabase,
                botToken: config.telegramBotToken,
                memberId,
              });
            }
          }
          const token = createMobileSessionToken(config.mobileSessionSecret, memberId);
          let status = 500;
          let responseBody = "";
          const response = {
            writeHead(code) { status = code; },
            end(value) { responseBody = value || ""; },
          };
          await chat({
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "x-assistant-channel": "telegram",
            },
            body: {
              speaker_id: memberId,
              question,
              telegram_update_id: String(incoming.updateId),
            },
          }, response);
          let payload;
          try { payload = JSON.parse(responseBody); } catch { payload = null; }
          if (status < 200 || status >= 300 || !payload || typeof payload.answer !== "string") {
            throw new Error("Assistant request failed");
          }
          return payload.answer;
        },
      });
    } catch (error) {
      initializationError = error;
    }
  }
  if (!handler) {
    console.error("[Telegram] webhook initialization failed:", initializationError?.message || "unknown error");
    res.writeHead(500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: false }));
    return;
  }
  return handler(req, res);
}
