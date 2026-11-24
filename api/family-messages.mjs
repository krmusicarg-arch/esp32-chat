import { configFromEnv } from "../lib/assistant.mjs";
import { createFamilyMessagesApiHandler } from "../lib/family_messages_api.mjs";
import { createSupabaseClient } from "../database/supabase.mjs";

let handler;
let initializationError;

export default async function familyMessages(req, res) {
  if (!handler) {
    try {
      const config = configFromEnv();
      handler = createFamilyMessagesApiHandler({ config, supabase: createSupabaseClient(config) });
    } catch (error) {
      initializationError = error;
    }
  }
  if (!handler) {
    console.error("[Config] family messages initialization failed:", initializationError?.message || "unknown error");
    res.writeHead(500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ status: "configuration_error" }));
    return;
  }
  return handler(req, res);
}
