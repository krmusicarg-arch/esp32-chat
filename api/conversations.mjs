import { configFromEnv } from "../lib/assistant.mjs";
import { createReadApiHandler } from "../lib/read_api.mjs";
import { createSupabaseClient } from "../database/supabase.mjs";

let handler;
export default async function conversations(req, res) {
  if (!handler) {
    const config = configFromEnv();
    handler = createReadApiHandler({
      config,
      supabase: createSupabaseClient(config),
    });
  }
  return handler(req, res);
}
