import assert from "node:assert/strict";
import test from "node:test";
import { configFromEnv, createChatHandler } from "./lib/assistant.mjs";
import { createMobileSessionToken } from "./lib/mobile_auth.mjs";

const DEVICE_TOKEN = "test-device-token-0123456789";
const BASE_CONFIG = {
  apiKey: "test-gemini-key",
  tavilyApiKey: "test-tavily-key",
  deviceToken: DEVICE_TOKEN,
  mobileSessionSecret: "a".repeat(64),
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
  onGroq,
  onSearch,
  usage = usagePayload(),
  tavilyError,
} = {}) {
  const calls = { gemini: [], groq: [], usage: 0, search: [] };
  const fetchImpl = async (url, options = {}) => {
    if (url === "https://api.groq.com/openai/v1/chat/completions") {
      const body = JSON.parse(options.body);
      calls.groq.push(body);
      return onGroq
        ? onGroq(body, calls, options)
        : response({ choices: [{ message: { role: "assistant", content: "Respuesta de prueba." } }] });
    }
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
    async post(body, token = DEVICE_TOKEN, origin) {
      const req = {
        method: "POST",
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(origin ? { origin } : {}),
        },
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
      return { status: res.statusCode, json: JSON.parse(res.body), headers: res.headers };
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
  assert.deepEqual(mock.calls.gemini[0].generationConfig, {
    maxOutputTokens: 1024,
    temperature: 0.75,
    topP: 0.9,
  });
});

test("Groq provider maps chat and web-search tools while preserving the response contract", async () => {
  const mock = createMockFetch({
    onGroq: (body, _calls, options) => {
      assert.equal(body.model, "openai/gpt-oss-120b");
      assert.equal(options.headers.authorization, "Bearer test-groq-key");
      assert.equal(body.messages[0].role, "system");
      assert.match(body.messages[0].content, /español argentino/);
      assert.equal(body.tools[0].function.name, "web_search");
      assert.equal(body.tools[0].function.parameters.type, "object");
      assert.equal(body.max_completion_tokens, 1024);
      return response({ choices: [{ message: { role: "assistant", content: "Buenas, ¿en qué te ayudo?" } }] });
    },
  });
  const app = createApp({
    config: {
      ...BASE_CONFIG,
      provider: "groq",
      groqApiKey: "test-groq-key",
      groqModel: "openai/gpt-oss-120b",
      fallbackProvider: "gemini",
    },
    fetchImpl: mock.fetchImpl,
  });
  const result = await app.post({ question: "Hola" });

  assert.equal(result.status, 200);
  assert.equal(result.json.answer, "Buenas, ¿en qué te ayudo?");
  assert.equal(mock.calls.groq.length, 1);
  assert.equal(mock.calls.gemini.length, 0);
});

test("Groq tool calls are returned with their results and synthesized into the final answer", async () => {
  const mock = createMockFetch({
    onGroq: (body) => {
      const toolResult = body.messages.find((message) => message.role === "tool");
      if (toolResult) {
        assert.equal(toolResult.tool_call_id, "call-groq-search");
        assert.match(toolResult.content, /Dato publicado por la fuente/);
        return response({ choices: [{ message: { role: "assistant", content: "La fuente confirma el dato." } }] });
      }
      return response({
        choices: [{
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call-groq-search",
              type: "function",
              function: {
                name: "web_search",
                arguments: JSON.stringify({ query: "consulta actual", topic: "general" }),
              },
            }],
          },
          finish_reason: "tool_calls",
        }],
      });
    },
  });
  const app = createApp({
    config: {
      ...BASE_CONFIG,
      provider: "groq",
      groqApiKey: "test-groq-key",
      fallbackProvider: "gemini",
    },
    fetchImpl: mock.fetchImpl,
  });
  const result = await app.post({ question: "¿Qué información actual hay?" });

  assert.equal(result.status, 200);
  assert.equal(result.json.answer, "La fuente confirma el dato.");
  assert.equal(result.json.searched_web, true);
  assert.equal(mock.calls.groq.length, 2);
  assert.equal(mock.calls.search.length, 1);
});

test("Groq failures fall back to Gemini without changing the conversation response", async () => {
  const mock = createMockFetch({
    onGroq: () => response({ error: { message: "temporary capacity issue" } }, 503),
    onGemini: () => response({
      candidates: [{ content: { parts: [{ text: "Respondí con Gemini de respaldo." }] } }],
    }),
  });
  const app = createApp({
    config: {
      ...BASE_CONFIG,
      provider: "groq",
      groqApiKey: "test-groq-key",
      fallbackProvider: "gemini",
    },
    fetchImpl: mock.fetchImpl,
  });
  const result = await app.post({ question: "Hola" });

  assert.equal(result.status, 200);
  assert.equal(result.json.answer, "Respondí con Gemini de respaldo.");
  assert.equal(mock.calls.groq.length, 1);
  assert.equal(mock.calls.gemini.length, 1);
});

test("Gemini fallback can finish a Groq search tool call", async () => {
  let groqCalls = 0;
  const mock = createMockFetch({
    onGroq: (body) => {
      groqCalls += 1;
      if (groqCalls === 1) {
        return response({
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call-groq-search",
                type: "function",
                function: {
                  name: "web_search",
                  arguments: JSON.stringify({ query: "consulta actual", topic: "general" }),
                },
              }],
            },
            finish_reason: "tool_calls",
          }],
        });
      }
      assert.ok(body.messages.some((message) => message.role === "tool"));
      return response({ error: { message: "temporary capacity issue" } }, 503);
    },
    onGemini: (body) => {
      const contents = body.contents.flatMap((item) => item.parts || []);
      assert.ok(contents.some((part) => part.functionCall?.id === "call-groq-search"));
      assert.ok(contents.some((part) => part.functionResponse?.id === "call-groq-search"));
      return response({ candidates: [{ content: { parts: [{ text: "Búsqueda resumida desde Gemini." }] } }] });
    },
  });
  const app = createApp({
    config: {
      ...BASE_CONFIG,
      provider: "groq",
      groqApiKey: "test-groq-key",
      fallbackProvider: "gemini",
    },
    fetchImpl: mock.fetchImpl,
  });
  const result = await app.post({ question: "¿Qué información actual hay?" });

  assert.equal(result.status, 200);
  assert.equal(result.json.answer, "Búsqueda resumida desde Gemini.");
  assert.equal(result.json.searched_web, true);
});

test("greeting uses a conversational Argentine prompt without a fixed word ceiling", async () => {
  const mock = createMockFetch({
    onGemini: (body) => response({
      candidates: [{ content: { parts: [{ text: "¡Buenas! Todo tranqui por acá. ¿Cómo viene tu día?" }] } }],
    }),
  });
  const app = createApp({ fetchImpl: mock.fetchImpl });
  const result = await app.post({ question: "Hola, ¿cómo estás?" });
  const prompt = mock.calls.gemini[0].systemInstruction.parts[0].text;

  assert.equal(result.json.answer, "¡Buenas! Todo tranqui por acá. ¿Cómo viene tu día?");
  assert.match(prompt, /español argentino/);
  assert.match(prompt, /voseo natural/);
  assert.match(prompt, /turnos anteriores/);
  assert.doesNotMatch(prompt, /máximo de 80 palabras/);
});

test("chat accepts and forwards eight chronological turns", async () => {
  const mock = createMockFetch({
    onGemini: (body) => response({
      candidates: [{ content: { parts: [{ text: "Sí, retomo el tema anterior." }] } }],
    }),
  });
  const app = createApp({ fetchImpl: mock.fetchImpl });
  const history = Array.from({ length: 8 }, (_, index) => ({
    question: `pregunta ${index + 1}`,
    answer: `respuesta ${index + 1}`,
  }));
  const result = await app.post({ question: "¿Y qué pasó después?", history });
  const contents = mock.calls.gemini[0].contents;

  assert.equal(result.json.status, "ok");
  assert.equal(contents.length, 17);
  assert.equal(contents[0].parts[0].text, "pregunta 1");
  assert.equal(contents[15].parts[0].text, "respuesta 8");
  assert.equal(contents[16].parts[0].text, "¿Y qué pasó después?");
});

test("disabled search cannot return a claim that the assistant searched", async () => {
  const mock = createMockFetch({
    onGemini: () => response({
      candidates: [{
        content: { parts: [{ text: "La noticia ocurrió esta mañana. Déjame buscar la fuente oficial." }] },
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
  assert.match(result.json.answer, /La noticia ocurrió esta mañana/);
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
  assert.match(first.systemInstruction.parts[0].text, /America\/Argentina\/Cordoba/);
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
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test-supabase-key",
    ASSISTANT_FAMILY_MEMBER_ID: "a0b1c2d3-e4f5-4a67-8b90-123456789abc",
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
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test-supabase-key",
    ASSISTANT_FAMILY_MEMBER_ID: "a0b1c2d3-e4f5-4a67-8b90-123456789abc",
    TAVILY_MAX_MONTHLY_CREDITS: "1001",
  }), /between 1 and 1000/);
});

test("configuration selects Groq or Gemini and enables the other configured provider as fallback", () => {
  const baseEnv = {
    TAVILY_API_KEY: "test-tavily-key",
    ASSISTANT_DEVICE_TOKEN: DEVICE_TOKEN,
    UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
    UPSTASH_REDIS_REST_TOKEN: "test-redis-token",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test-supabase-key",
    ASSISTANT_FAMILY_MEMBER_ID: "a0b1c2d3-e4f5-4a67-8b90-123456789abc",
  };
  const groq = configFromEnv({
    ...baseEnv,
    AI_PROVIDER: "groq",
    GROQ_API_KEY: "test-groq-key",
    GEMINI_API_KEY: "test-gemini-key",
  });
  assert.equal(groq.provider, "groq");
  assert.equal(groq.groqModel, "openai/gpt-oss-120b");
  assert.equal(groq.fallbackProvider, "gemini");

  const gemini = configFromEnv({
    ...baseEnv,
    AI_PROVIDER: "gemini",
    GROQ_API_KEY: "test-groq-key",
    GEMINI_API_KEY: "test-gemini-key",
  });
  assert.equal(gemini.provider, "gemini");
  assert.equal(gemini.fallbackProvider, "groq");

  const groqOnly = configFromEnv({ ...baseEnv, GROQ_API_KEY: "test-groq-key" });
  assert.equal(groqOnly.provider, "groq");
  assert.equal(groqOnly.fallbackProvider, "none");
});

test("request validation and device authentication reject invalid callers", async () => {
  const mock = createMockFetch();
  const app = createApp({ fetchImpl: mock.fetchImpl });
  const unauthorized = await app.post({ question: "Hola" }, "");
  const invalid = await app.post({ question: "  " });

  assert.equal(unauthorized.status, 401);
  assert.equal(invalid.status, 400);
});

test("mobile chat sessions authenticate and cannot switch speakers", async () => {
  const mock = createMockFetch();
  const app = createApp({
    config: { ...BASE_CONFIG, mobileOrigins: ["https://app.example"] },
    fetchImpl: mock.fetchImpl,
  });
  const speakerId = "a0b1c2d3-e4f5-4a67-8b90-123456789abc";
  const token = createMobileSessionToken(
    BASE_CONFIG.mobileSessionSecret,
    speakerId,
    TEST_DATE,
  );
  const accepted = await app.post({ question: "Hola" }, token, "https://app.example");
  const rejected = await app.post({
    question: "Hola",
    speaker_id: "b0b1c2d3-e4f5-4a67-8b90-123456789abc",
  }, token);

  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers["access-control-allow-origin"], "https://app.example");
  assert.equal(rejected.status, 403);
  assert.equal(rejected.json.status, "speaker_mismatch");
});
