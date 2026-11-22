import { configFromEnv } from "../lib/assistant.mjs";
import { createWeatherHandler } from "../lib/weather_controller.mjs";

let handler;
let initializationError;

export default async function weather(req, res) {
  if (!handler) {
    try {
      handler = createWeatherHandler({ config: configFromEnv() });
    } catch (error) {
      initializationError = error;
    }
  }
  if (!handler) {
    console.error("[Config] weather endpoint initialization failed:", initializationError?.message || "unknown error");
    res.writeHead(500, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify({
      status: "configuration_error",
      answer: "Falta configurar el backend para consultar el clima.",
      searched_web: false,
      sources: [],
    }));
    return;
  }
  return handler(req, res);
}
