import assert from "node:assert/strict";
import test from "node:test";
import { configFromEnv, createChatHandler } from "./lib/assistant.mjs";

const DEVICE_TOKEN = "test-device-token-0123456789";
const BASE_CONFIG = {
  apiKey: "test-gemini-key",
  tavilyApiKey: "test-tavily-key",
  deviceToken: DEVICE_TOKEN,
  model: "gemini-3.5-flash-lite",
  searchEnabled: true,
  searchDepth: "basic",
  maxResults: 5,
  monthlyCreditLimit: 900,
  maxDailyRequests: 20,
};
const TEST_DATE = new Date("2026-03-20T12:00:00.000Z");

class MemoryStore {
  values = new Map();
  writes = [];

  async get(key) {
    return this.values.get(key) ?? null;
  }

  async set(key, value, options = {}) {
    if (options.nx && this.values.has(key)) return null;
    this.values.set(key, String(value));
    this.writes.push({ key, ex: options.ex });
    return "OK";
  }

  async del(key) {
    return this.values.delete(key) ? 1 : 0;
  }

  async allowDailyRequest(key, limit) {
    const current = Number(this.values.get(key) || 0);
    if (current >= limit) return false;
    this.values.set(key, String(current + 1));
    return true;
  }

  async reserveCredits(key, observed, reserve, limit) {
    const current = Math.max(Number(this.values.get(key) || 0), observed);
    if (current + reserve > limit) {
      this.values.set(key, String(current));
      return { allowed: false, total: current };
    }
    this.values.set(key, String(current + reserve));
    return { allowed: true, total: current + reserve };
  }

  async adjustCredits(key, reserved, actual) {
    const next = Number(this.values.get(key) || 0) - reserved + actual;
    this.values.set(key, String(Math.max(0, next)));
    return Math.max(0, next);
  }

  async releaseLock(key, token) {
    if (this.values.get(key) !== token) return 0;
    this.values.delete(key);
    return 1;
  }
}

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status });
}

function usagePayload({ keyUsage = 0, planUsage = 0, paygoUsage = 0 } = {}) {
  return {
    key: { usage: keyUsage, limit: 1000 },
    account: {
      plan_usage: planUsage,
      plan_limit: 1000,
      paygo_usage: paygoUsage,
    },
  };
}

function webResults({ includeUsage = true, credits = 1 } = {}) {
  return {
    query: "consulta actual",
    results: [{
      title: "Fuente verificada",
      url: "https://example.com/current",
      content: "Dato publicado por la fuente.",
      score: 0.9,
    }],
    ...(includeUsage ? { usage: { credits } } : {}),
  };
}

function createMockFetch({
  onGemini,
  onSearch,
  usage = usagePayload(),
  tavilyError,
} = {}) {
  const calls = { gemini: [], usage: 0, search: [] };
  const fetchImpl = async (url, options = {}) => {
    if (url.includes("generativelanguage.googleapis.com")) {
      const body = JSON.parse(options.body);
      calls.gemini.push(body);
      return onGemini
        ? onGemini(body, calls)
        : response({ candidates: [{ content: { parts: [{ text: "Respuesta de prueba." }] } }] });
    }
    if (url === "https://api.tavily.com/usage") {
      calls.usage += 1;
      return response(usage);
    }
    if (url === "https://api.tavily.com/search") {
      calls.search.push(JSON.parse(options.body));
      if (tavilyError) throw tavilyError;
      return onSearch
        ? onSearch(calls.search[calls.search.length - 1], calls)
        : response(webResults());
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  return { calls, fetchImpl };
}

function createApp({ config = BASE_CONFIG, fetchImpl, redis = new MemoryStore() }) {
  const handler = createChatHandler({
    config,
    redis,
    fetchImpl,
    clock: () => new Date(TEST_DATE),
  });
  return {
    redis,
    async post(body, token = DEVICE_TOKEN) {
      const req = {
        method: "POST",
        headers: token ? { authorization: `Bearer ${token}` } : {},
        body,
      };
      const res = {
        headers: {},
        writeHead(status, headers) {
          this.statusCode = status;
          Object.assign(this.headers, headers);
        },
        end(value) {
          this.body = value;
        },
      };
      await handler(req, res);
      return { status: res.statusCode, json: JSON.parse(res.body) };
    },
  };
}

function modelToolCall(body, calls, { query, topic = "general" }) {
  const currentQuestion = body.contents[body.contents.length - 1].parts[0].text;
  if (body.tools && /amplificador|clase d/i.test(currentQuestion)) {
    return response({
      candidates: [{ content: { parts: [{ text: "Un amplificador clase D conmuta la señal." }] } }],
    });
  }
  if (body.tools) {
    return response({
      candidates: [{
        content: {
          role: "model",
          parts: [{
            functionCall: {
              name: "web_search",
              args: { query, topic },
            },
          }],
        },
      }],
    });
  }
  const toolResult = body.contents.flatMap((item) => item.parts || [])
    .find((part) => part.functionResponse);
  if (toolResult) calls.lastFunctionResponse = toolResult.functionResponse;
  return response({
    candidates: [{ content: { parts: [{ text: "Respuesta basada en los resultados consultados." }] } }],
  });
}

test("general question does not call Tavily", async () => {
  const mock = createMockFetch({
    onGemini: (body) => response({
      candidates: [{ content: { parts: [{ text: "Un amplificador clase D conmuta la señal." }] } }],
    }),
  });
  const app = createApp({ fetchImpl: mock.fetchImpl });
  const result = await app.post({ question: "¿Qué es un amplificador clase D?" });

  assert.equal(result.json.status, "ok");
  assert.equal(result.json.searched_web, false);
  assert.deepEqual(result.json.sources, []);
  assert.equal(mock.calls.search.length, 0);
  assert.equal(mock.calls.gemini.length, 1);
  assert.equal(mock.calls.gemini[0].toolConfig.functionCallingConfig.mode, "AUTO");
  assert.equal(mock.calls.gemini[0].tools[0].functionDeclarations[0].name, "web_search");
});

test("disabled search cannot return a claim that the assistant searched", async () => {
  const mock = createMockFetch({
    onGemini: () => response({
      candidates: [{
        content: { parts: [{ text: "Déjame buscar la información actualizada." }] },
      }],
    }),
  });
  const app = createApp({
    config: { ...BASE_CONFIG, searchEnabled: false },
    fetchImpl: mock.fetchImpl,
  });
  const result = await app.post({ question: "¿Quién es el presidente actual?" });

  assert.equal(result.json.status, "search_not_performed");
  assert.equal(result.json.searched_web, false);
  assert.match(result.json.answer, /No consulté Internet/);
  assert.equal(mock.calls.search.length, 0);
});

test("current-events question searches Tavily and returns HTTPS sources", async () => {
  const mock = createMockFetch({
    onGemini: (body, calls) => modelToolCall(body, calls, {
      query: "presidente actual de Argentina",
      topic: "news",
    }),
  });
  const app = createApp({ fetchImpl: mock.fetchImpl });
  const result = await app.post({ question: "¿Quién es el presidente actual de Argentina?" });

  assert.equal(result.json.status, "ok");
  assert.equal(result.json.searched_web, true);
  assert.deepEqual(result.json.sources, [{
    title: "Fuente verificada",
    url: "https://example.com/current",
  }]);
  assert.equal(mock.calls.search.length, 1);
  assert.equal(mock.calls.search[0].include_usage, true);
  assert.equal(mock.calls.search[0].max_results, 5);
  assert.equal(mock.calls.usage, 1);
  assert.ok(app.redis.writes.some(({ key, ex }) => key.startsWith("tavily:q:") && ex === 24 * 60 * 60));
});

test("future events preserve follow-up history and Argentina time context", async () => {
  const mock = createMockFetch({
    onGemini: (body, calls) => modelToolCall(body, calls, {
      query: "partidos Argentina este fin de semana 21 marzo 2026",
      topic: "news",
    }),
  });
  const app = createApp({ fetchImpl: mock.fetchImpl });
  await app.post({
    question: "¿Y cuáles juega Argentina este fin de semana?",
    history: [{
      question: "¿Qué partidos importantes hay?",
      answer: "Hay varios encuentros.",
    }],
  });

  const first = mock.calls.gemini[0];
  assert.match(first.systemInstruction.parts[0].text, /America\/Argentina\/Buenos_Aires/);
  assert.equal(first.contents[0].parts[0].text, "¿Qué partidos importantes hay?");
  assert.equal(first.contents[1].role, "model");
  assert.equal(first.contents[2].parts[0].text, "¿Y cuáles juega Argentina este fin de semana?");
  assert.equal(mock.calls.search[0].topic, "news");
  assert.match(mock.calls.search[0].query, /21 marzo 2026/);
  assert.ok(app.redis.writes.some(({ key, ex }) => key.startsWith("tavily:q:") && ex === 30 * 60));
});

test("Gemini receives Tavily results before composing its answer", async () => {
  const mock = createMockFetch({
    onGemini: (body, calls) => modelToolCall(body, calls, {
      query: "noticias actuales de tecnología",
      topic: "news",
    }),
  });
  const app = createApp({ fetchImpl: mock.fetchImpl });
  const result = await app.post({ question: "¿Qué novedades hay hoy sobre tecnología?" });
  const functionResponse = mock.calls.lastFunctionResponse;

  assert.equal(result.json.status, "ok");
  assert.equal(functionResponse.name, "web_search");
  assert.equal(mock.calls.gemini[1].contents.at(-1).role, "user");
  assert.equal(functionResponse.response.results[0].content, "Dato publicado por la fuente.");
  assert.match(mock.calls.gemini[1].systemInstruction.parts[0].text, /No agregues hechos actuales/);
  assert.ok(app.redis.writes.some(({ key, ex }) => key.startsWith("tavily:q:") && ex === 6 * 60 * 60));
});

test("repeated standalone question uses cached results without another Tavily call", async () => {
  const mock = createMockFetch({
    onGemini: (body, calls) => modelToolCall(body, calls, {
      query: "presidente actual de Argentina",
      topic: "news",
    }),
  });
  const app = createApp({ fetchImpl: mock.fetchImpl });
  const question = "¿Quién es el presidente actual de Argentina?";
  await app.post({ question });
  const repeated = await app.post({ question });

  assert.equal(repeated.json.searched_web, true);
  assert.equal(mock.calls.search.length, 1);
  assert.equal(mock.calls.usage, 1);
  assert.equal(mock.calls.gemini.length, 3);
});

test("parallel identical requests do not start duplicate Tavily searches", async () => {
  let markSearchStarted;
  const searchStarted = new Promise((resolve) => {
    markSearchStarted = resolve;
  });
  let finishSearch;
  const searchGate = new Promise((resolve) => {
    finishSearch = resolve;
  });
  const mock = createMockFetch({
    onGemini: (body, calls) => modelToolCall(body, calls, {
      query: "noticias actuales de Argentina",
      topic: "news",
    }),
    onSearch: async () => {
      markSearchStarted();
      await searchGate;
      return response(webResults());
    },
  });
  const app = createApp({ fetchImpl: mock.fetchImpl });
  const firstRequest = app.post({ question: "¿Qué noticias importantes ocurrieron hoy?" });
  await searchStarted;
  const second = await app.post({ question: "¿Qué noticias importantes ocurrieron hoy?" });
  finishSearch();
  const first = await firstRequest;

  assert.equal(first.json.searched_web, true);
  assert.equal(second.json.status, "busy");
  assert.equal(mock.calls.search.length, 1);
});

test("multiple Gemini tool calls are capped to one Tavily search", async () => {
  const mock = createMockFetch({
    onGemini: (body) => {
      if (body.tools) {
        return response({
          candidates: [{
            content: {
              role: "model",
              parts: [
                { functionCall: { name: "web_search", id: "call-1", args: { query: "consulta uno" } } },
                { functionCall: { name: "web_search", id: "call-2", args: { query: "consulta dos" } } },
              ],
            },
          }],
        });
      }
      return response({
        candidates: [{ content: { parts: [{ text: "Respuesta con una sola búsqueda." }] } }],
      });
    },
  });
  const app = createApp({ fetchImpl: mock.fetchImpl });
  const result = await app.post({ question: "¿Qué novedades hay hoy?" });
  const functionResponses = mock.calls.gemini[1].contents.at(-1).parts;

  assert.equal(result.json.status, "ok");
  assert.equal(mock.calls.search.length, 1);
  assert.equal(functionResponses.length, 2);
  assert.equal(functionResponses[1].functionResponse.response.error,
    "Solo se permite una búsqueda por turno.");
});

test("Tavily connection failure is returned without retries", async () => {
  const mock = createMockFetch({
    onGemini: (body, calls) => modelToolCall(body, calls, {
      query: "noticias actuales de Argentina",
      topic: "news",
    }),
    tavilyError: new Error("offline"),
  });
  const app = createApp({ fetchImpl: mock.fetchImpl });
  const result = await app.post({ question: "¿Qué noticias importantes ocurrieron hoy?" });

  assert.equal(result.status, 502);
  assert.equal(result.json.status, "internet_error");
  assert.equal(mock.calls.search.length, 1);
  assert.equal(mock.calls.gemini.length, 1);
});

test("monthly credit cap stops before calling Tavily search", async () => {
  const mock = createMockFetch({
    usage: usagePayload({ keyUsage: 900, planUsage: 900 }),
    onGemini: (body, calls) => modelToolCall(body, calls, {
      query: "noticias actuales de Argentina",
      topic: "news",
    }),
  });
  const app = createApp({ fetchImpl: mock.fetchImpl });
  const question = { question: "¿Qué noticias hay hoy?" };
  const result = await app.post(question);
  const repeated = await app.post(question);

  assert.equal(result.status, 429);
  assert.equal(result.json.status, "quota_exhausted");
  assert.equal(repeated.json.status, "quota_exhausted");
  assert.equal(mock.calls.search.length, 0);
  assert.equal(mock.calls.usage, 1);
});

test("Tavily 433 blocks later searches without retries or pay-as-you-go", async () => {
  const mock = createMockFetch({
    onGemini: (body, calls) => modelToolCall(body, calls, {
      query: "noticias actuales de Argentina",
      topic: "news",
    }),
    onSearch: () => response({ detail: { error: "plan limit reached" } }, 433),
  });
  const app = createApp({ fetchImpl: mock.fetchImpl });
  const question = { question: "¿Qué noticias importantes ocurrieron hoy?" };
  const first = await app.post(question);
  const second = await app.post(question);

  assert.equal(first.json.status, "quota_exhausted");
  assert.equal(second.json.status, "quota_exhausted");
  assert.equal(mock.calls.search.length, 1);
  assert.equal(mock.calls.usage, 1);
});

test("model that rejects Function Calling is reported as incompatible", async () => {
  const mock = createMockFetch({
    onGemini: () => response({
      error: { message: "Function calling is not supported on this model." },
    }, 400),
  });
  const app = createApp({ fetchImpl: mock.fetchImpl });
  const result = await app.post({ question: "¿Quién es el presidente actual?" });

  assert.equal(result.status, 502);
  assert.equal(result.json.status, "model_incompatible");
  assert.equal(mock.calls.search.length, 0);
});

test("missing Tavily credit metadata fails closed", async () => {
  const mock = createMockFetch({
    onGemini: (body, calls) => modelToolCall(body, calls, {
      query: "precio actual del dólar",
      topic: "finance",
    }),
    onSearch: () => response(webResults({ includeUsage: false })),
  });
  const app = createApp({ fetchImpl: mock.fetchImpl });
  const result = await app.post({ question: "¿Cuál es el precio actual del dólar?" });

  assert.equal(result.status, 503);
  assert.equal(result.json.status, "search_accounting_error");
  assert.equal(mock.calls.gemini.length, 1);
  assert.equal(mock.calls.search[0].max_age_hours, 0);
});

test("empty Tavily results are returned without fabricated sources", async () => {
  const mock = createMockFetch({
    onGemini: (body, calls) => modelToolCall(body, calls, {
      query: "hecho actual sin resultados",
      topic: "news",
    }),
    onSearch: () => response({
      query: "hecho actual sin resultados",
      results: [],
      usage: { credits: 1 },
    }),
  });
  const app = createApp({ fetchImpl: mock.fetchImpl });
  const result = await app.post({ question: "¿Qué ocurrió hoy sobre este tema?" });

  assert.equal(result.json.status, "ok");
  assert.equal(result.json.searched_web, true);
  assert.deepEqual(result.json.sources, []);
});

test("price search cache uses five-minute TTL and advanced depth reserves two credits", async () => {
  const mock = createMockFetch({
    onGemini: (body, calls) => modelToolCall(body, calls, {
      query: "precio actual del dólar en Argentina",
      topic: "finance",
    }),
  });
  const app = createApp({
    config: { ...BASE_CONFIG, searchDepth: "advanced" },
    fetchImpl: mock.fetchImpl,
  });
  await app.post({ question: "¿Cuál es el precio actual del dólar?" });
  const cacheWrite = app.redis.writes.find(({ key }) => key.startsWith("tavily:q:"));

  assert.equal(cacheWrite.ex, 5 * 60);
  assert.equal(app.redis.values.get("tavily:credits:2026-03"), "1");
});

test("configuration keeps Gemini model and bounds the free monthly cap", () => {
  const config = configFromEnv({
    GEMINI_API_KEY: "test-gemini-key",
    TAVILY_API_KEY: "test-tavily-key",
    ASSISTANT_DEVICE_TOKEN: DEVICE_TOKEN,
    UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
    UPSTASH_REDIS_REST_TOKEN: "test-redis-token",
  });
  assert.equal(config.model, "gemini-3.5-flash-lite");
  assert.equal(config.monthlyCreditLimit, 900);
  assert.equal(config.searchEnabled, true);
  assert.throws(() => configFromEnv({
    GEMINI_API_KEY: "test-gemini-key",
    TAVILY_API_KEY: "test-tavily-key",
    ASSISTANT_DEVICE_TOKEN: DEVICE_TOKEN,
    UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
    UPSTASH_REDIS_REST_TOKEN: "test-redis-token",
    TAVILY_MAX_MONTHLY_CREDITS: "1001",
  }), /between 1 and 1000/);
});

test("request validation and device authentication reject invalid callers", async () => {
  const mock = createMockFetch();
  const app = createApp({ fetchImpl: mock.fetchImpl });
  const unauthorized = await app.post({ question: "Hola" }, "");
  const invalid = await app.post({ question: "  " });

  assert.equal(unauthorized.status, 401);
  assert.equal(invalid.status, 400);
});
