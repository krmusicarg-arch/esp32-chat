import { timingSafeEqual } from "node:crypto";

const MEMBER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function deviceTokenMatches(expected, provided) {
  if (typeof expected !== "string" || typeof provided !== "string"
      || !expected || !provided) return false;
  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  return expectedBytes.length === providedBytes.length
    && timingSafeEqual(expectedBytes, providedBytes);
}

export async function assertActiveDevice(supabase, deviceId) {
  if (!deviceId) return;
  const query = new URLSearchParams({
    select: "id,active",
    id: `eq.${deviceId}`,
    active: "eq.true",
    limit: "1",
  });
  const rows = await supabase.select("devices", query);
  if (!rows.length) throw new Error("Configured device is not active");
}

export async function touchDevice(supabase, deviceId, now = new Date()) {
  if (!deviceId) return;
  const query = new URLSearchParams({ id: `eq.${deviceId}`, active: "eq.true" });
  await supabase.update("devices", query, { last_seen_at: now.toISOString() });
}

export async function getFamilySettings(supabase) {
  const query = new URLSearchParams({
    select: "id,family_name,expected_members,timezone,quiet_hours_start,quiet_hours_end,max_proactive_messages_per_day,proactive_enabled",
    id: "eq.1",
    limit: "1",
  });
  const rows = await supabase.select("family_settings", query);
  if (!rows[0]) throw new Error("Family settings were not found");
  return rows[0];
}

export async function getActiveFamilyMembers(supabase, settings) {
  const query = new URLSearchParams({
    select: "id,name,phone,profile,active",
    active: "eq.true",
    order: "name.asc",
    limit: "5",
  });
  const members = await supabase.select("family_members", query);
  if (members.length !== settings.expected_members || members.length !== 4) {
    throw new Error("Active family member count does not match family settings");
  }
  return members;
}

export async function resolveFamilyMember(supabase, requestedId, fallbackId) {
  const settings = await getFamilySettings(supabase);
  const members = await getActiveFamilyMembers(supabase, settings);
  const selectedId = requestedId || fallbackId;
  if (!selectedId) {
    const error = new Error("A speaker must be selected");
    error.code = "SPEAKER_REQUIRED";
    throw error;
  }
  if (!MEMBER_ID_PATTERN.test(selectedId)) {
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
  return { ...member, family_name: settings.family_name, settings };
}
