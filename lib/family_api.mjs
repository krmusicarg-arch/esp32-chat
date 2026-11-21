import {
  assertActiveDevice,
  deviceTokenMatches,
  getActiveFamilyMembers,
  getFamilySettings,
  resolveFamilyMember,
} from "../services/family.service.mjs";
import {
  acknowledgeNotification,
  claimPendingNotifications,
} from "../services/notifications.service.mjs";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 4096;

function respond(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  if (req.body !== undefined) {
    const body = typeof req.body === "string" || Buffer.isBuffer(req.body)
      ? JSON.parse(req.body.toString())
      : req.body;
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

export function createFamilyApiHandler({ config, supabase }) {
  return async function handleFamilyApi(req, res) {
    const token = req.headers?.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice("Bearer ".length)
      : "";
    if (!deviceTokenMatches(config.deviceToken, token)) {
      return respond(res, 401, { status: "unauthorized" });
    }
    try {
      await assertActiveDevice(supabase, config.deviceId);
      const url = new URL(req.url || "/", "http://localhost");
      if (req.method === "GET" && url.pathname.endsWith("/members")) {
        const settings = await getFamilySettings(supabase);
        const members = await getActiveFamilyMembers(supabase, settings);
        return respond(res, 200, {
          status: "ok",
          members: members.map(({ id, name }) => ({ id, name })),
        });
      }

      if (req.method === "GET" && url.pathname.endsWith("/notifications/pending")) {
        const memberId = url.searchParams.get("speaker_id") || "";
        const member = await resolveFamilyMember(supabase, memberId, null);
        const notifications = await claimPendingNotifications(supabase, {
          memberId: member.id,
        });
        return respond(res, 200, { status: "ok", notifications });
      }

      if (req.method === "POST" && url.pathname.endsWith("/notifications/ack")) {
        const body = await readJsonBody(req);
        if (!body || typeof body !== "object"
            || !UUID_PATTERN.test(body.speaker_id || "")
            || !UUID_PATTERN.test(body.delivery_id || "")
            || typeof body.success !== "boolean"
            || (body.error !== undefined && typeof body.error !== "string")) {
          return respond(res, 400, { status: "invalid_request" });
        }
        if (body.error && body.error.length > 500) {
          return respond(res, 400, { status: "invalid_request" });
        }
        const member = await resolveFamilyMember(supabase, body.speaker_id, null);
        const acknowledged = await acknowledgeNotification(supabase, {
          deliveryId: body.delivery_id,
          memberId: member.id,
          success: body.success,
          error: body.error,
        });
        if (!acknowledged) {
          return respond(res, 409, { status: "delivery_not_claimed" });
        }
        return respond(res, 200, { status: "ok" });
      }

      return respond(res, 404, { status: "not_found" });
    } catch (error) {
      if (error.statusCode === 413 || error instanceof SyntaxError) {
        return respond(res, error.statusCode || 400, { status: "invalid_request" });
      }
      if (["SPEAKER_REQUIRED", "INVALID_SPEAKER"].includes(error.code)) {
        return respond(res, 400, { status: error.code.toLowerCase() });
      }
      console.error("[Family API] request failed:", error.name || "Error");
      return respond(res, 503, { status: "family_storage_error" });
    }
  };
}
