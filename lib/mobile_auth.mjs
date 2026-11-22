import { createHmac, timingSafeEqual } from "node:crypto";
import {
  getActiveFamilyMembers,
  getFamilySettings,
  resolveFamilyMember,
} from "../services/family.service.mjs";

export const MOBILE_SESSION_SECONDS = 7 * 24 * 60 * 60;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 4096;

export function mobilePasscodeMatches(expected, provided) {
  if (typeof expected !== "string" || typeof provided !== "string"
      || Buffer.byteLength(expected) < 24
      || Buffer.byteLength(provided) !== Buffer.byteLength(expected)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}

export function createMobileSessionToken(secret, speakerId, now = new Date()) {
  if (typeof secret !== "string" || Buffer.byteLength(secret) < 32
      || !UUID_PATTERN.test(speakerId)) {
    throw new Error("Mobile session credentials are invalid");
  }
  const issuedAt = Math.floor(now.getTime() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }))
    .toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: "family-assistant",
    aud: "mobile",
    sub: speakerId,
    iat: issuedAt,
    exp: issuedAt + MOBILE_SESSION_SECONDS,
  })).toString("base64url");
  const signingInput = `${header}.${payload}`;
  const signature = createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

export function verifyMobileSessionToken(secret, token, now = new Date()) {
  if (typeof secret !== "string" || Buffer.byteLength(secret) < 32
      || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expectedSignature = createHmac("sha256", secret).update(signingInput).digest();
  const providedSignature = Buffer.from(encodedSignature, "base64url");
  if (providedSignature.length !== expectedSignature.length
      || !timingSafeEqual(expectedSignature, providedSignature)) return null;

  let header;
  let claims;
  try {
    header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (header.alg !== "HS256" || header.typ !== "JWT"
      || claims.iss !== "family-assistant" || claims.aud !== "mobile"
      || !UUID_PATTERN.test(claims.sub || "")
      || !Number.isInteger(claims.iat) || !Number.isInteger(claims.exp)
      || claims.iat > nowSeconds + 60 || claims.exp <= nowSeconds
      || claims.exp <= claims.iat
      || claims.exp - claims.iat > MOBILE_SESSION_SECONDS) return null;
  return { speakerId: claims.sub, expiresAt: claims.exp };
}

function withMobileCors(req, res, config) {
  const origin = req.headers?.origin;
  const allowedOrigins = config.mobileOrigins || [];
  const corsHeaders = {
    vary: "Origin",
    ...(origin && allowedOrigins.includes(origin)
      ? {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "Authorization, Content-Type",
        "access-control-max-age": "600",
      }
      : {}),
  };
  return {
    writeHead(status, headers = {}) {
      res.writeHead(status, { ...corsHeaders, ...headers });
    },
    end(value) {
      res.end(value);
    },
  };
}

function respond(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  let body;
  if (req.body !== undefined) {
    body = typeof req.body === "string" || Buffer.isBuffer(req.body)
      ? JSON.parse(req.body.toString())
      : req.body;
    if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES) {
      const error = new Error("Request body too large");
      error.statusCode = 413;
      throw error;
    }
  } else {
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
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  return body;
}

export function createMobileSessionHandler({
  config,
  supabase,
  clock = () => new Date(),
}) {
  return async function handleMobileSession(req, res) {
    res = withMobileCors(req, res, config);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method !== "POST") {
      return respond(res, 405, { status: "method_not_allowed" });
    }
    if (typeof config.mobilePasscode !== "string"
        || Buffer.byteLength(config.mobilePasscode) < 24
        || typeof config.mobileSessionSecret !== "string"
        || Buffer.byteLength(config.mobileSessionSecret) < 32) {
      console.error("[Mobile] passcode or session signing secret is not configured");
      return respond(res, 503, { status: "mobile_auth_not_configured" });
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      console.warn("[Mobile] invalid session request:", error.statusCode || 400);
      return respond(res, error.statusCode || 400, { status: "invalid_request" });
    }
    if (!body || typeof body !== "object" || Array.isArray(body)
        || typeof body.passcode !== "string"
        || (body.speaker_id !== undefined
          && (typeof body.speaker_id !== "string" || !UUID_PATTERN.test(body.speaker_id)))) {
      return respond(res, 400, { status: "invalid_request" });
    }
    if (!mobilePasscodeMatches(config.mobilePasscode, body.passcode)) {
      return respond(res, 401, { status: "invalid_passcode" });
    }

    try {
      if (!supabase) throw new Error("Supabase is not configured");
      if (!body.speaker_id) {
        const settings = await getFamilySettings(supabase);
        const members = await getActiveFamilyMembers(supabase, settings);
        return respond(res, 200, {
          status: "member_selection_required",
          members: members.map(({ id, name }) => ({ id, name })),
        });
      }

      const member = await resolveFamilyMember(supabase, body.speaker_id, null);
      const token = createMobileSessionToken(
        config.mobileSessionSecret,
        member.id,
        clock(),
      );
      return respond(res, 200, {
        status: "ok",
        token,
        expires_in: MOBILE_SESSION_SECONDS,
        member: { id: member.id, name: member.name },
      });
    } catch (error) {
      if (error.code === "INVALID_SPEAKER") {
        return respond(res, 400, { status: "invalid_speaker" });
      }
      console.error("[Mobile] session creation failed:", error.name || "Error");
      return respond(res, 503, { status: "family_storage_error" });
    }
  };
}

export function mobileCorsResponse(req, res, config) {
  return withMobileCors(req, res, config);
}
