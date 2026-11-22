import assert from "node:assert/strict";
import test from "node:test";
import {
  createMobileSessionHandler,
  createMobileSessionToken,
  mobilePasscodeMatches,
  MOBILE_SESSION_SECONDS,
  verifyMobileSessionToken,
} from "./lib/mobile_auth.mjs";

const SECRET = "a".repeat(64);
const PASSCODE = "familia-codigo-secreto-1234";
const SPEAKER_ID = "a0b1c2d3-e4f5-4a67-8b90-123456789abc";
const OTHER_SPEAKER_ID = "b0b1c2d3-e4f5-4a67-8b90-123456789abc";
const NOW = new Date("2026-03-20T12:00:00.000Z");
const MEMBERS = [
  { id: SPEAKER_ID, name: "Ana", active: true },
  { id: OTHER_SPEAKER_ID, name: "Bruno", active: true },
  { id: "c0b1c2d3-e4f5-4a67-8b90-123456789abc", name: "Carla", active: true },
  { id: "d0b1c2d3-e4f5-4a67-8b90-123456789abc", name: "Diego", active: true },
];

function createSupabase() {
  return {
    async select(table) {
      if (table === "family_settings") {
        return [{
          id: 1,
          family_name: "Familia",
          expected_members: 4,
        }];
      }
      if (table === "family_members") return MEMBERS;
      throw new Error(`Unexpected table: ${table}`);
    },
  };
}

function createResponse() {
  return {
    headers: {},
    writeHead(status, headers = {}) {
      this.statusCode = status;
      Object.assign(this.headers, headers);
    },
    end(value) {
      this.body = value;
    },
  };
}

test("mobile sessions are signed, expire, and are bound to a speaker", () => {
  const token = createMobileSessionToken(SECRET, SPEAKER_ID, NOW);
  const session = verifyMobileSessionToken(SECRET, token, NOW);

  assert.equal(session.speakerId, SPEAKER_ID);
  assert.equal(session.expiresAt, Math.floor(NOW.getTime() / 1000) + MOBILE_SESSION_SECONDS);
  assert.equal(verifyMobileSessionToken("b".repeat(64), token, NOW), null);
  assert.equal(
    verifyMobileSessionToken(SECRET, token, new Date(NOW.getTime() + MOBILE_SESSION_SECONDS * 1000)),
    null,
  );
});

test("mobile passcodes require a configured high-entropy value and compare exactly", () => {
  assert.equal(mobilePasscodeMatches(PASSCODE, PASSCODE), true);
  assert.equal(mobilePasscodeMatches(PASSCODE, `${PASSCODE}x`), false);
  assert.equal(mobilePasscodeMatches("short-passcode", "short-passcode"), false);
});

test("mobile session endpoint returns active members and issues a speaker-bound session", async () => {
  const handler = createMobileSessionHandler({
    config: {
      mobilePasscode: PASSCODE,
      mobileSessionSecret: SECRET,
      mobileOrigins: ["https://app.example"],
    },
    supabase: createSupabase(),
    clock: () => NOW,
  });
  const listResponse = createResponse();
  await handler({
    method: "POST",
    headers: { origin: "https://app.example" },
    body: { passcode: PASSCODE },
  }, listResponse);

  assert.equal(listResponse.statusCode, 200);
  assert.equal(listResponse.headers["access-control-allow-origin"], "https://app.example");
  assert.deepEqual(JSON.parse(listResponse.body).members.map(({ id }) => id), MEMBERS.map(({ id }) => id));

  const loginResponse = createResponse();
  await handler({
    method: "POST",
    headers: {},
    body: { passcode: PASSCODE, speaker_id: SPEAKER_ID },
  }, loginResponse);
  const session = JSON.parse(loginResponse.body);

  assert.equal(loginResponse.statusCode, 200);
  assert.equal(verifyMobileSessionToken(SECRET, session.token, NOW).speakerId, SPEAKER_ID);
});

test("mobile session endpoint answers allowed CORS preflight requests", async () => {
  const handler = createMobileSessionHandler({
    config: {
      mobilePasscode: PASSCODE,
      mobileSessionSecret: SECRET,
      mobileOrigins: ["https://app.example"],
    },
    supabase: createSupabase(),
  });
  const res = createResponse();
  await handler({
    method: "OPTIONS",
    headers: { origin: "https://app.example" },
  }, res);

  assert.equal(res.statusCode, 204);
  assert.equal(res.headers["access-control-allow-methods"], "POST, OPTIONS");
  assert.equal(res.headers["access-control-allow-headers"], "Authorization, Content-Type");
});

test("mobile session endpoint rejects an incorrect passcode", async () => {
  const handler = createMobileSessionHandler({
    config: { mobilePasscode: PASSCODE, mobileSessionSecret: SECRET },
    supabase: createSupabase(),
  });
  const res = createResponse();
  await handler({
    method: "POST",
    headers: {},
    body: { passcode: "wrong-family-passcode" },
  }, res);

  assert.equal(res.statusCode, 401);
  assert.equal(JSON.parse(res.body).status, "invalid_passcode");
});
