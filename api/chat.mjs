import { waitUntil } from "@vercel/functions";
import { createChatHandler, configFromEnv } from "../lib/assistant.mjs";
import { createUpstashStore } from "../lib/redis_store.mjs";
import { createSupabaseClient } from "../database/supabase.mjs";

export const maxDuration = 60;

let handler;
let initializationError;

export default async function chat(req, res) {
  if (!handler) {
    try {
      const config = configFromEnv();
      handler = createChatHandler({
        config,
        redis: createUpstashStore(config),
        supabase: createSupabaseClient(config),
        scheduleBackground: waitUntil,
      });
    } catch (error) {
      initializationError = error;
    }
  }
  if (!handler) {
    console.error("[Config] backend initialization failed:",
      initializationError?.message || "unknown error");
    res.writeHead(500, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify({
      status: "configuration_error",
      answer: "Falta configurar el backend en Vercel.",
      searched_web: false,
      sources: [],
    }));
    return;
  }
  return handler(req, res);
}
