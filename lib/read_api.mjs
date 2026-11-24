import { mobileCorsResponse, verifyMobileSessionToken } from "./mobile_auth.mjs";
import {
  assertActiveDevice,
  deviceTokenMatches,
  getActiveFamilyMembers,
  getFamilySettings,
} from "../services/family.service.mjs";
import {
  listConversations,
  listConversationMessages,
} from "../services/conversations.service.mjs";
import { getBoardTasks } from "../services/tasks.service.mjs";
import { getUpcomingReminders } from "../services/reminders.service.mjs";
import { getBirthdays } from "../services/memory.service.mjs";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPEN_TASK_STATUSES = ["pending", "in_progress"];
const ALL_TASK_STATUSES = ["pending", "in_progress", "completed", "cancelled"];

function respond(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function clampInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}

function parseCoordinate(value, minimum, maximum) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) return null;
  return parsed;
}

function requestedToken(req) {
  const authorization = req.headers?.authorization || "";
  return authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
}

function selectMember(members, requestedId, fallbackId) {
  const selectedId = requestedId || fallbackId;
  if (!selectedId) {
    const error = new Error("A speaker must be selected");
    error.code = "SPEAKER_REQUIRED";
    throw error;
  }
  if (!UUID_PATTERN.test(selectedId)) {
    const error = new Error("Speaker identifier is invalid");
    error.code = "INVALID_SPEAKER";
    throw error;
  }
  const member = members.find((candidate) => candidate.id === selectedId);
  if (!member) {
    const error = new Error("Speaker is not an active family member");
    error.code = "INVALID_SPEAKER";
    throw error;
  }
  return member;
}

function memberNames(members) {
  return new Map(members.map((item) => [item.id, item.name]));
}

function mapConversation(row) {
  return {
    id: row.id,
    channel: row.channel || null,
    startedAt: row.started_at || null,
    endedAt: row.ended_at || null,
    metadata: row.metadata || {},
  };
}

function mapTask(row, names) {
  return {
    id: row.id,
    description: row.description,
    status: row.status,
    createdBy: row.created_by || null,
    createdByName: names.get(row.created_by) || null,
    assignedTo: row.assigned_to || null,
    assignedToName: names.get(row.assigned_to) || null,
    dueAt: row.due_at || null,
    updatedAt: row.updated_at || null,
  };
}

function mapReminder(row) {
  return {
    id: row.id,
    taskId: row.task_id || null,
    title: row.title,
    description: row.description || null,
    scheduledAt: row.scheduled_at || null,
    status: row.status,
    metadata: row.metadata || {},
  };
}

function mapBirthday(row, names) {
  return {
    id: row.id,
    content: row.content,
    subjectMemberId: row.subject_member_id || null,
    subjectName: names.get(row.subject_member_id) || null,
    importance: Number.isFinite(Number(row.importance)) ? Number(row.importance) : null,
  };
}

export function createReadApiHandler({
  config,
  supabase,
  clock = () => new Date(),
  weatherSummary = null,
}) {
  return async function handleReadApi(req, res) {
    res = mobileCorsResponse(req, res, config, "GET, OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method !== "GET") {
      return respond(res, 405, { status: "method_not_allowed" });
    }

    const token = requestedToken(req);
    const mobileSession = verifyMobileSessionToken(config.mobileSessionSecret, token, clock());
    const deviceAuthorized = token.length >= 24 && token.length <= 512
      && deviceTokenMatches(config.deviceToken, token);
    if (!mobileSession && !deviceAuthorized) {
      return respond(res, 401, { status: "unauthorized" });
    }
    if (!supabase) {
      return respond(res, 503, { status: "family_storage_error" });
    }

    const url = new URL(req.url || "/", "http://localhost");
    const requestedSpeaker = url.searchParams.get("speaker_id") || "";
    if (mobileSession && requestedSpeaker && requestedSpeaker !== mobileSession.speakerId) {
      return respond(res, 403, { status: "speaker_mismatch" });
    }
    const speakerId = mobileSession ? mobileSession.speakerId : requestedSpeaker;

    try {
      if (!mobileSession) await assertActiveDevice(supabase, config.deviceId);
      const settings = await getFamilySettings(supabase);
      const members = await getActiveFamilyMembers(supabase, settings);
      const member = selectMember(members, speakerId, config.familyMemberId);
      const names = memberNames(members);
      const pathname = url.pathname.replace(/^\/api(?=\/)/, "");

      if (pathname === "/conversations") {
        const limit = clampInteger(url.searchParams.get("limit"), 20, 1, 50);
        const conversations = await listConversations(supabase, {
          memberId: member.id,
          limit,
        });
        return respond(res, 200, {
          status: "ok",
          conversations: conversations.map(mapConversation),
        });
      }

      if (pathname === "/conversations/messages") {
        const conversationId = url.searchParams.get("conversation_id") || "";
        if (!UUID_PATTERN.test(conversationId)) {
          return respond(res, 400, { status: "invalid_request" });
        }
        const limit = clampInteger(url.searchParams.get("limit"), 50, 1, 200);
        const messages = await listConversationMessages(supabase, {
          conversationId,
          memberId: member.id,
          limit,
        });
        return respond(res, 200, {
          status: "ok",
          conversationId,
          messages: messages.map((row) => ({
            role: row.role,
            content: row.content,
            createdAt: row.created_at || null,
          })),
        });
      }

      if (pathname === "/tasks") {
        const scope = url.searchParams.get("status") === "all" ? "all" : "open";
        const statuses = scope === "all" ? ALL_TASK_STATUSES : OPEN_TASK_STATUSES;
        const limit = clampInteger(url.searchParams.get("limit"), 20, 1, 100);
        const tasks = await getBoardTasks(supabase, { statuses, limit });
        return respond(res, 200, {
          status: "ok",
          tasks: tasks.map((row) => mapTask(row, names)),
        });
      }

      if (pathname === "/reminders") {
        const hours = clampInteger(url.searchParams.get("hours"), 24, 1, 720);
        const limit = clampInteger(url.searchParams.get("limit"), 10, 1, 50);
        const reminders = await getUpcomingReminders(supabase, {
          now: clock(),
          hours,
          limit,
        });
        return respond(res, 200, {
          status: "ok",
          reminders: reminders.map(mapReminder),
        });
      }

      if (pathname === "/agenda") {
        const latitude = parseCoordinate(url.searchParams.get("latitude"), -90, 90);
        const longitude = parseCoordinate(url.searchParams.get("longitude"), -180, 180);
        const [tasks, reminders, birthdays] = await Promise.all([
          getBoardTasks(supabase, { statuses: OPEN_TASK_STATUSES, limit: 10 }),
          getUpcomingReminders(supabase, { now: clock(), hours: 24, limit: 10 }),
          getBirthdays(supabase, { limit: 20 }),
        ]);
        let weather = null;
        if (weatherSummary && latitude !== null && longitude !== null) {
          try {
            weather = await weatherSummary(latitude, longitude);
          } catch (error) {
            console.error("[Read API] weather summary failed:", error.name || "Error");
            weather = null;
          }
        }
        return respond(res, 200, {
          status: "ok",
          generatedAt: clock().toISOString(),
          member: { id: member.id, name: member.name },
          timezone: settings.timezone,
          tasks: tasks.map((row) => mapTask(row, names)),
          reminders: reminders.map(mapReminder),
          birthdays: birthdays.map((row) => mapBirthday(row, names)),
          weather,
        });
      }

      return respond(res, 404, { status: "not_found" });
    } catch (error) {
      if (error.code === "INVALID_CONVERSATION") {
        return respond(res, 403, { status: "invalid_conversation" });
      }
      if (error.code === "SPEAKER_REQUIRED") {
        return respond(res, 400, { status: "speaker_required" });
      }
      if (error.code === "INVALID_SPEAKER") {
        return respond(res, 400, { status: "invalid_speaker" });
      }
      console.error("[Read API] request failed:", error.name || "Error");
      return respond(res, 503, { status: "family_storage_error" });
    }
  };
}
