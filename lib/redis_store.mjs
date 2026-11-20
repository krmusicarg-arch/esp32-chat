const DAILY_LIMIT_SCRIPT = `
local current = tonumber(redis.call("GET", KEYS[1]) or "0")
local limit = tonumber(ARGV[1])
if current >= limit then return 0 end
if current == 0 then
  redis.call("SET", KEYS[1], 1, "EX", ARGV[2])
else
  redis.call("INCR", KEYS[1])
end
return 1
`;

const RESERVE_CREDITS_SCRIPT = `
local current = tonumber(redis.call("GET", KEYS[1]) or "0")
local observed = tonumber(ARGV[1])
local reserve = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
if observed > current then current = observed end
if current + reserve > limit then
  redis.call("SET", KEYS[1], current, "EX", ARGV[4])
  return {0, current}
end
current = current + reserve
redis.call("SET", KEYS[1], current, "EX", ARGV[4])
return {1, current}
`;

const ADJUST_CREDITS_SCRIPT = `
local current = tonumber(redis.call("GET", KEYS[1]) or "0")
local next = current - tonumber(ARGV[1]) + tonumber(ARGV[2])
if next < 0 then next = 0 end
redis.call("SET", KEYS[1], next, "EX", ARGV[3])
return next
`;

const RELEASE_LOCK_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

export function createUpstashStore({
  redisUrl,
  redisToken,
  fetchImpl = fetch,
}) {
  async function command(...args) {
    let response;
    try {
      response = await fetchImpl(redisUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${redisToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(7000),
      });
    } catch (error) {
      console.error("[Upstash] connection failed:", error.name || "Error");
      const failure = new Error("Upstash connection failed");
      failure.cause = error;
      throw failure;
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      console.error("[Upstash] invalid JSON response:", response.status);
      throw new Error(`Upstash returned invalid JSON (${response.status})`);
    }
    if (!response.ok || payload.error) {
      console.error("[Upstash] command rejected:", response.status);
      throw new Error(`Upstash command failed (${response.status})`);
    }
    return payload.result;
  }

  return {
    get: (key) => command("GET", key),
    set: (key, value, { ex, nx } = {}) => {
      const args = ["SET", key, value];
      if (ex) args.push("EX", ex);
      if (nx) args.push("NX");
      return command(...args);
    },
    del: (key) => command("DEL", key),
    allowDailyRequest: async (key, limit, ttl) => (
      Number(await command("EVAL", DAILY_LIMIT_SCRIPT, 1, key, limit, ttl)) === 1
    ),
    reserveCredits: async (key, observed, reserve, limit, ttl) => {
      const result = await command(
        "EVAL", RESERVE_CREDITS_SCRIPT, 1, key, observed, reserve, limit, ttl,
      );
      if (!Array.isArray(result) || result.length !== 2) {
        throw new Error("Upstash returned an invalid reservation result");
      }
      return { allowed: Number(result[0]) === 1, total: Number(result[1]) };
    },
    adjustCredits: (key, reserved, actual, ttl) => command(
      "EVAL", ADJUST_CREDITS_SCRIPT, 1, key, reserved, actual, ttl,
    ),
    releaseLock: (key, token) => command("EVAL", RELEASE_LOCK_SCRIPT, 1, key, token),
  };
}
