const SEARCH_URL = "https://api.tavily.com/search";
const USAGE_URL = "https://api.tavily.com/usage";

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function getTavilyUsage({ apiKey, fetchImpl = fetch }) {
  let response;
  try {
    response = await fetchImpl(USAGE_URL, {
      method: "GET",
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    return { ok: false, kind: "connection", cause: error };
  }

  const payload = await readJson(response);
  if (!response.ok || !payload || typeof payload !== "object") {
    return { ok: false, kind: "usage_unavailable", status: response.status };
  }

  const keyUsed = payload.key?.usage;
  const planUsed = payload.account?.plan_usage;
  if (!Number.isSafeInteger(keyUsed) || keyUsed < 0
      || !Number.isSafeInteger(planUsed) || planUsed < 0) {
    return { ok: false, kind: "usage_missing", status: response.status };
  }

  const limits = [payload.key?.limit, payload.account?.plan_limit]
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  const paygoUsed = payload.account?.paygo_usage;
  return {
    ok: true,
    used: Math.max(keyUsed, planUsed),
    limit: limits.length ? Math.min(...limits) : null,
    paygoUsed: Number.isSafeInteger(paygoUsed) && paygoUsed >= 0 ? paygoUsed : null,
  };
}

function safeSources(results, maxResults) {
  if (!Array.isArray(results)) return [];
  const seen = new Set();
  const safe = [];
  for (const result of results) {
    if (typeof result?.url !== "string" || result.url.length > 500) continue;
    let url;
    try {
      url = new URL(result.url);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" || seen.has(url.href)) continue;
    seen.add(url.href);
    safe.push({
      title: (typeof result.title === "string" && result.title.trim()
        ? result.title.trim()
        : url.hostname).slice(0, 120),
      url: url.href,
      content: typeof result.content === "string" ? result.content.slice(0, 1200) : "",
      score: typeof result.score === "number" && Number.isFinite(result.score)
        ? result.score
        : undefined,
    });
    if (safe.length >= maxResults) break;
  }
  return safe;
}

export async function searchTavily({
  apiKey,
  query,
  topic,
  searchDepth = "basic",
  maxResults = 5,
  forceLive = false,
  fetchImpl = fetch,
}) {
  const request = {
    query,
    topic,
    search_depth: searchDepth,
    max_results: maxResults,
    auto_parameters: false,
    language: "es",
    include_answer: false,
    include_raw_content: false,
    include_usage: true,
  };
  if (topic === "general") request.country = "argentina";
  if (forceLive) request.max_age_hours = 0;

  let response;
  try {
    response = await fetchImpl(SEARCH_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    return { ok: false, kind: "connection", cause: error };
  }

  const payload = await readJson(response);
  if (!response.ok) {
    return {
      ok: false,
      kind: "provider_error",
      status: response.status,
      code: payload?.detail?.code ?? payload?.code ?? null,
    };
  }
  if (!payload || !Array.isArray(payload.results)) {
    return { ok: false, kind: "invalid_response", status: response.status };
  }

  const credits = payload.usage?.credits;
  if (!Number.isSafeInteger(credits) || credits < 0) {
    return { ok: false, kind: "usage_missing", status: response.status };
  }

  return {
    ok: true,
    query: typeof payload.query === "string" ? payload.query : query,
    credits,
    results: safeSources(payload.results, maxResults),
  };
}
