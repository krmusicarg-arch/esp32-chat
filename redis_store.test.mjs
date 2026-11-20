import assert from "node:assert/strict";
import test from "node:test";
import { createUpstashStore } from "./lib/redis_store.mjs";

test("monthly credit reservations use one atomic Redis EVAL command", async () => {
  let request;
  const store = createUpstashStore({
    redisUrl: "https://redis.example",
    redisToken: "test-redis-token",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ result: [1, 8] }), { status: 200 });
    },
  });
  const result = await store.reserveCredits("tavily:credits:2026-03", 7, 1, 900, 3600);
  const command = JSON.parse(request.options.body);

  assert.equal(result.allowed, true);
  assert.equal(result.total, 8);
  assert.equal(command[0], "EVAL");
  assert.match(command[1], /current \+ reserve > limit/);
  assert.equal(command[2], 1);
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers.authorization, "Bearer test-redis-token");
});

test("Upstash REST errors are surfaced without returning provider details", async () => {
  const store = createUpstashStore({
    redisUrl: "https://redis.example",
    redisToken: "test-redis-token",
    fetchImpl: async () => new Response(JSON.stringify({
      error: "WRONGPASS private provider detail",
    }), { status: 401 }),
  });

  await assert.rejects(store.get("key"), /Upstash command failed \(401\)/);
});
