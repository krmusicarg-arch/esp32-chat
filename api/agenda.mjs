import { configFromEnv } from "../lib/assistant.mjs";
import { createReadApiHandler } from "../lib/read_api.mjs";
import { createSupabaseClient } from "../database/supabase.mjs";
import { createWeatherSummary } from "../services/weather_service.mjs";

let handler;
export default async function agenda(req, res) {
  if (!handler) {
    const config = configFromEnv();
    handler = createReadApiHandler({
      config,
      supabase: createSupabaseClient(config),
      weatherSummary: createWeatherSummary(),
    });
  }
  return handler(req, res);
}
