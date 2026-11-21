import { configFromEnv } from "../../lib/assistant.mjs";
import { createFamilyApiHandler } from "../../lib/family_api.mjs";
import { createSupabaseClient } from "../../database/supabase.mjs";

let handler;
export default async function pendingNotifications(req, res) {
  if (!handler) {
    const config = configFromEnv();
    handler = createFamilyApiHandler({
      config,
      supabase: createSupabaseClient(config),
    });
  }
  return handler(req, res);
}
