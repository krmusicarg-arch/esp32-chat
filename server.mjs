import { createServer } from "node:http";
import { configFromEnv, createChatHandler } from "./lib/assistant.mjs";
import { createUpstashStore } from "./lib/redis_store.mjs";
import { createSupabaseClient } from "./database/supabase.mjs";
import { createFamilyApiHandler } from "./lib/family_api.mjs";
import { createMobileSessionHandler } from "./lib/mobile_auth.mjs";
import { createWeatherHandler } from "./lib/weather_controller.mjs";
import { createReadApiHandler } from "./lib/read_api.mjs";
import { createWeatherSummary } from "./services/weather_service.mjs";

const config = configFromEnv();
const supabase = createSupabaseClient(config);
const handler = createChatHandler({
  config,
  redis: createUpstashStore(config),
  supabase,
});
const familyApiHandler = createFamilyApiHandler({
  config,
  supabase,
});
const mobileSessionHandler = createMobileSessionHandler({ config, supabase });
const weatherHandler = createWeatherHandler({ config });
const readApiHandler = createReadApiHandler({
  config,
  supabase,
  weatherSummary: createWeatherSummary(),
});
const READ_API_PATHS = [
  "/conversations",
  "/conversations/messages",
  "/tasks",
  "/reminders",
  "/agenda",
];

const server = createServer((req, res) => {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  const familyPath = pathname.startsWith("/api/") ? pathname.slice(4) : pathname;
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (familyPath === "/mobile/session") {
    mobileSessionHandler(req, res);
    return;
  }
  if (familyPath === "/weather") {
    weatherHandler(req, res);
    return;
  }
  if (READ_API_PATHS.includes(familyPath)) {
    readApiHandler(req, res);
    return;
  }
  if (["/members", "/notifications/pending", "/notifications/ack"].includes(familyPath)) {
    familyApiHandler(req, res);
    return;
  }
  if (familyPath !== "/chat") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "not_found", answer: "Ruta no encontrada." }));
    return;
  }
  handler(req, res);
});

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "0.0.0.0";
server.listen(port, host, () => {
  console.log(`[Backend] listening on http://${host}:${port}`);
});
