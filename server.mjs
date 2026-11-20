import { createServer } from "node:http";
import { configFromEnv, createChatHandler } from "./lib/assistant.mjs";
import { createUpstashStore } from "./lib/redis_store.mjs";

const config = configFromEnv();
const handler = createChatHandler({
  config,
  redis: createUpstashStore(config),
});

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (req.url !== "/chat" && req.url !== "/api/chat") {
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
