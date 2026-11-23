import { mobileCorsResponse, verifyMobileSessionToken } from "./mobile_auth.mjs";
import { deviceTokenMatches } from "../services/family.service.mjs";
import { createWeatherAssistant } from "../services/weather_assistant.mjs";

const MAX_BODY_BYTES = 4096;

function respond(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify({ searched_web: false, sources: [], ...payload }));
}

async function readBody(req) {
  if (req.body !== undefined) {
    const body = typeof req.body === "string" || Buffer.isBuffer(req.body)
      ? JSON.parse(req.body.toString()) : req.body;
    if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES) {
      const error = new Error("Request body too large");
      error.statusCode = 413;
      throw error;
    }
    return body;
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      const error = new Error("Request body too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function validateBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)
      || typeof body.question !== "string") return null;
  const question = body.question.trim();
  if (!question || question.length > 400) return null;
  let currentLocation = null;
  if (body.current_location !== undefined && body.current_location !== null) {
    const location = body.current_location;
    if (!location || typeof location !== "object" || Array.isArray(location)
        || !Number.isFinite(location.latitude) || location.latitude < -90 || location.latitude > 90
        || !Number.isFinite(location.longitude) || location.longitude < -180 || location.longitude > 180) return null;
    currentLocation = { latitude: location.latitude, longitude: location.longitude };
  }
  return { question, currentLocation };
}

export function createWeatherHandler({ config, fetchImpl = fetch, clock = () => new Date() }) {
  const answerWeatherQuestion = createWeatherAssistant({
    fetchImpl,
    clock,
    defaultLocation: config.weatherDefaultLocation || "Buenos Aires, Argentina",
    geonamesUsername: config.weatherGeoNamesUsername || "",
  });

  return async function handleWeather(req, res) {
    res = mobileCorsResponse(req, res, config);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method !== "POST") {
      return respond(res, 405, { status: "method_not_allowed", answer: "Método no permitido." });
    }

    const authorization = req.headers?.authorization || "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    const mobileSession = verifyMobileSessionToken(config.mobileSessionSecret, token, clock());
    const deviceAuthorized = token.length >= 24 && token.length <= 512
      && deviceTokenMatches(config.deviceToken, token);
    if (!mobileSession && !deviceAuthorized) {
      return respond(res, 401, { status: "unauthorized", answer: "Dispositivo no autorizado." });
    }

    let body;
    try {
      body = validateBody(await readBody(req));
    } catch (error) {
      return respond(res, error.statusCode || 400, { status: "invalid_request", answer: "La solicitud no es válida." });
    }
    if (!body) return respond(res, 400, { status: "invalid_request", answer: "La consulta meteorológica no es válida." });

    const result = await answerWeatherQuestion(body);
    if (!result) return respond(res, 400, { status: "not_weather_query", answer: "No reconocí una consulta meteorológica." });
    return respond(res, 200, result);
  };
}

