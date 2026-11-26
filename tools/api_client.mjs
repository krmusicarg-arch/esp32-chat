#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import {
  DEFAULT_TIME_ZONE,
  listCalendarEvents,
  parseCalendarRange,
} from "../services/calendar.service.mjs";

function loadEnv() {
  if (typeof process.loadEnvFile === "function") {
    try {
      process.loadEnvFile();
    } catch {
      // .env no existe o el entorno ya tiene las variables
    }
  }
}

const HELP = `Uso: node tools/api_client.mjs <comando> [opciones]

Comandos:
  health                                   GET  /health
  chat <pregunta>                          POST /api/chat
  weather <pregunta>                       POST /api/weather
  members                                  GET  /api/members
  notifications --speaker <uuid>           GET  /api/notifications/pending
  ack --speaker <uuid> --delivery <uuid>   POST /api/notifications/ack
  conversations --speaker <uuid>           GET  /api/conversations
  messages --speaker <uuid> --conversation <uuid>
                                           GET  /api/conversations/messages
  tasks --speaker <uuid>                   GET  /api/tasks
  reminders --speaker <uuid>               GET  /api/reminders
  agenda --speaker <uuid>                  GET  /api/agenda
  calendar [texto]                         Consulta directa a Composio (diagnóstico)

Opciones comunes:
  --base <url>        URL base (def. API_BASE_URL o http://localhost:8787)
  --token <token>     Bearer (def. ASSISTANT_DEVICE_TOKEN)
  --speaker <uuid>    speaker_id del integrante
  --conversation <uuid>
  --history <json>    Historial para chat, ej. '[{"question":"","answer":""}]'
  --lat <n> --lon <n> Coordenadas para weather/agenda
  --limit <n> --hours <n> --status <open|all>
  --delivery <uuid> --success <true|false> --error <texto>
  --json              Imprime solo el JSON de respuesta (sin metadatos)

Calendario (diagnóstico directo a Composio):
  --account <ca_...>  Cuenta conectada (def. COMPOSIO_GOOGLE_CALENDAR_CONNECTED_ACCOUNT_ID)
  --composio-key <k>  API key (def. COMPOSIO_API_KEY)
  --calendar <id>     Calendario (def. COMPOSIO_GOOGLE_CALENDAR_ID o primary)
  --tz <iana>         Zona horaria (def. ASSISTANT_TIMEZONE o America/Argentina/Cordoba)
`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i++;
    }
  }
  return { positional, flags };
}

function requireValue(flags, name) {
  const value = flags[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Falta --${name}`);
  }
  return value.trim();
}

function toNumber(value) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function checkComposioCredentials(apiKey, connectedAccountId, userId) {
  if (apiKey.startsWith("ck_")) {
    throw new Error(
      "COMPOSIO_API_KEY es una consumer key (ck_..., header x-consumer-api-key, solo MCP). "
      + "Usá la Project API key 'ak_...' de Platform → Settings → Project Settings → API Keys (header x-api-key).",
    );
  }
  if (apiKey.startsWith("uak_")) {
    throw new Error(
      "COMPOSIO_API_KEY es una user API key (uak_...). "
      + "Usá la Project API key 'ak_...' de Platform → Settings → Project Settings → API Keys.",
    );
  }
  if (!connectedAccountId && !userId) {
    throw new Error(
      "Falta COMPOSIO_GOOGLE_CALENDAR_CONNECTED_ACCOUNT_ID (ca_...). "
      + "Conectá Google Calendar en el proyecto de Platform y copiá el ID de la cuenta.",
    );
  }
  if (connectedAccountId && !connectedAccountId.startsWith("ca_")) {
    throw new Error(
      `COMPOSIO_GOOGLE_CALENDAR_CONNECTED_ACCOUNT_ID inválido ("${connectedAccountId}"). `
      + "Debe ser el ID 'ca_...' de una cuenta conectada del proyecto de Platform.",
    );
  }
}

function buildBase(flags) {
  const base = flags.base || process.env.API_BASE_URL || "http://localhost:8787";
  return String(base).replace(/\/+$/, "");
}

function buildToken(flags) {
  const token = flags.token || process.env.ASSISTANT_DEVICE_TOKEN;
  if (!token) throw new Error("Falta el token: usa --token o ASSISTANT_DEVICE_TOKEN");
  return token;
}

function buildCommand(command, positional, flags) {
  const base = buildBase(flags);
  const speaker = typeof flags.speaker === "string" ? flags.speaker : undefined;

  const withQuery = (path, params) => {
    const url = new URL(`${base}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url;
  };

  switch (command) {
    case "health":
      return { method: "GET", url: `${base}/health` };

    case "chat": {
      const question = positional.slice(1).join(" ").trim() || (typeof flags.question === "string" ? flags.question : "");
      if (!question) throw new Error("Falta la pregunta para chat");
      const body = { question };
      if (speaker) body.speaker_id = speaker;
      if (typeof flags.conversation === "string") body.conversation_id = flags.conversation;
      if (typeof flags.history === "string") body.history = JSON.parse(flags.history);
      return { method: "POST", url: `${base}/api/chat`, token: buildToken(flags), body };
    }

    case "weather": {
      const question = positional.slice(1).join(" ").trim() || (typeof flags.question === "string" ? flags.question : "");
      if (!question) throw new Error("Falta la pregunta para weather");
      const body = { question };
      const latitude = toNumber(flags.lat);
      const longitude = toNumber(flags.lon);
      if (latitude !== undefined && longitude !== undefined) {
        body.current_location = { latitude, longitude };
      }
      return { method: "POST", url: `${base}/api/weather`, token: buildToken(flags), body };
    }

    case "members":
      return { method: "GET", url: `${base}/api/members`, token: buildToken(flags) };

    case "notifications": {
      if (!speaker) throw new Error("Falta --speaker");
      return {
        method: "GET",
        url: withQuery("/api/notifications/pending", { speaker_id: speaker }).href,
        token: buildToken(flags),
      };
    }

    case "ack": {
      if (!speaker) throw new Error("Falta --speaker");
      const delivery = requireValue(flags, "delivery");
      const success = flags.success === undefined ? true : flags.success !== "false";
      const body = { speaker_id: speaker, delivery_id: delivery, success };
      if (typeof flags.error === "string") body.error = flags.error;
      return { method: "POST", url: `${base}/api/notifications/ack`, token: buildToken(flags), body };
    }

    case "conversations": {
      if (!speaker) throw new Error("Falta --speaker");
      return {
        method: "GET",
        url: withQuery("/api/conversations", { speaker_id: speaker, limit: toNumber(flags.limit) }).href,
        token: buildToken(flags),
      };
    }

    case "messages": {
      if (!speaker) throw new Error("Falta --speaker");
      const conversation = requireValue(flags, "conversation");
      return {
        method: "GET",
        url: withQuery("/api/conversations/messages", {
          speaker_id: speaker,
          conversation_id: conversation,
          limit: toNumber(flags.limit),
        }).href,
        token: buildToken(flags),
      };
    }

    case "tasks": {
      if (!speaker) throw new Error("Falta --speaker");
      return {
        method: "GET",
        url: withQuery("/api/tasks", {
          speaker_id: speaker,
          status: flags.status,
          limit: toNumber(flags.limit),
        }).href,
        token: buildToken(flags),
      };
    }

    case "reminders": {
      if (!speaker) throw new Error("Falta --speaker");
      return {
        method: "GET",
        url: withQuery("/api/reminders", {
          speaker_id: speaker,
          hours: toNumber(flags.hours),
          limit: toNumber(flags.limit),
        }).href,
        token: buildToken(flags),
      };
    }

    case "agenda": {
      if (!speaker) throw new Error("Falta --speaker");
      return {
        method: "GET",
        url: withQuery("/api/agenda", {
          speaker_id: speaker,
          latitude: toNumber(flags.lat),
          longitude: toNumber(flags.lon),
        }).href,
        token: buildToken(flags),
      };
    }

    case "session": {
      const passcode = flags.passcode || process.env.ASSISTANT_MOBILE_PASSCODE;
      if (!passcode) throw new Error("Falta --passcode o ASSISTANT_MOBILE_PASSCODE");
      const body = { passcode };
      if (speaker) body.speaker_id = speaker;
      return { method: "POST", url: `${base}/api/mobile/session`, body };
    }

    default:
      throw new Error(`Comando desconocido: ${command}`);
  }
}

async function main() {
  loadEnv();
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0];

  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(HELP);
    return 0;
  }

  if (command === "calendar") {
    const text = positional.slice(1).join(" ").trim() || "hoy";
    const apiKey = flags["composio-key"] || process.env.COMPOSIO_API_KEY;
    const connectedAccountId = flags.account
      || process.env.COMPOSIO_GOOGLE_CALENDAR_CONNECTED_ACCOUNT_ID;
    const userId = process.env.COMPOSIO_USER_ID;
    if (!apiKey || (!connectedAccountId && !userId)) {
      throw new Error("Faltan COMPOSIO_API_KEY y COMPOSIO_GOOGLE_CALENDAR_CONNECTED_ACCOUNT_ID");
    }
    const timeZone = flags.tz || process.env.ASSISTANT_TIMEZONE || DEFAULT_TIME_ZONE;
    const range = parseCalendarRange(text, new Date(), timeZone);
    const result = await listCalendarEvents({
      apiKey,
      connectedAccountId,
      userId,
      calendarId: flags.calendar || process.env.COMPOSIO_GOOGLE_CALENDAR_ID || "primary",
      range,
    });
    console.log(JSON.stringify({ range, result }, null, 2));
    return 0;
  }

  const requestId = randomUUID();
  const spec = buildCommand(command, positional, flags);
  const startedAt = Date.now();

  const response = await fetch(spec.url, {
    method: spec.method,
    headers: {
      accept: "application/json",
      ...(spec.token ? { authorization: `Bearer ${spec.token}` } : {}),
      ...(spec.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
  });

  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }

  if (!flags.json) {
    console.log(`> ${spec.method} ${spec.url}`);
    console.log(`< ${response.status} ${response.statusText} (${Date.now() - startedAt} ms) [request_id=${requestId}]`);
  }
  console.log(typeof payload === "string" ? payload : JSON.stringify(payload, null, 2));

  return response.ok ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exit(2);
  });
