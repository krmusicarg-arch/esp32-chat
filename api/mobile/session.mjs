import { configFromEnv } from "../../lib/assistant.mjs";
import { createMobileSessionHandler } from "../../lib/mobile_auth.mjs";
import { createSupabaseClient } from "../../database/supabase.mjs";

let handler;
let initializationError;

export default async function mobileSession(req, res) {
  if (!handler) {
    try {
      const config = configFromEnv();
      handler = createMobileSessionHandler({
        config,
        supabase: createSupabaseClient(config),
      });
    } catch (error) {
      initializationError = error;
    }
  }
  if (!handler) {
    console.error("[Config] mobile session initialization failed:",
      initializationError?.message || "unknown error");
    res.writeHead(500, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify({ status: "configuration_error" }));
    return;
  }
  return handler(req, res);
}
