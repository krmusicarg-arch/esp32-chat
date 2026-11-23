export function createSupabaseClient({
  supabaseUrl,
  serviceRoleKey,
  supabaseServiceRoleKey,
  supabaseSchema,
  schema = supabaseSchema || "family_assistant",
  fetchImpl = fetch,
}) {
  serviceRoleKey = serviceRoleKey || supabaseServiceRoleKey;
  if (!serviceRoleKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required");
  const baseUrl = new URL(supabaseUrl);
  if (baseUrl.protocol !== "https:") {
    throw new Error("SUPABASE_URL must use HTTPS");
  }
  if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) {
    throw new Error("Supabase schema name is invalid");
  }
  baseUrl.pathname = `${baseUrl.pathname.replace(/\/$/, "")}/rest/v1`;

  async function request(resource, { method = "GET", query, body, prefer } = {}) {
    const url = new URL(`${baseUrl.href.replace(/\/$/, "")}/${resource}`);
    if (query) url.search = query.toString();

    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          apikey: serviceRoleKey,
          authorization: `Bearer ${serviceRoleKey}`,
          ...(method === "GET"
            ? { "accept-profile": schema }
            : { "content-profile": schema }),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(prefer ? { prefer } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10000),
      });
    } catch (error) {
      const failure = new Error("Supabase connection failed");
      failure.cause = error;
      throw failure;
    }

    if (response.status === 204) return [];
    let payload;
    try {
      payload = await response.json();
    } catch {
      if (response.ok) return [];
      throw new Error(`Supabase request failed (${response.status})`);
    }
    if (!response.ok) {
      const message = typeof payload?.message === "string"
        ? payload.message.replace(/[\r\n]+/g, " ").slice(0, 240)
        : "No error message provided";
      const code = typeof payload?.code === "string" ? payload.code.slice(0, 40) : null;
      console.error("[Supabase] request rejected:", {
        resource,
        status: response.status,
        code,
        message,
      });
      const error = new Error(`Supabase request failed (${response.status})`);
      error.name = "SupabaseRequestError";
      error.status = response.status;
      error.resource = resource;
      if (code) error.code = code;
      throw error;
    }
    return payload;
  }

  return {
    select: (table, query) => request(table, { query }),
    insert: (table, rows, query) => request(table, {
      method: "POST",
      query,
      body: rows,
      prefer: "return=representation",
    }),
    upsertIgnore: (table, row, query) => request(table, {
      method: "POST",
      query,
      body: row,
      prefer: "resolution=ignore-duplicates,return=minimal",
    }),
    update: (table, query, values) => request(table, {
      method: "PATCH",
      query,
      body: values,
      prefer: "return=representation",
    }),
    rpc: (functionName, args = {}) => {
      if (!/^[a-z_][a-z0-9_]*$/i.test(functionName)) {
        throw new Error("Supabase function name is invalid");
      }
      return request(`rpc/${functionName}`, {
        method: "POST",
        body: args,
      });
    },
  };
}
