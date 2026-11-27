import { getFamilyGmailIntegration } from "./family.service.mjs";

const COMPOSIO_EXECUTE_BASE = "https://backend.composio.dev/api/v3.1/tools/execute";

function shortId(value) {
  return typeof value === "string" && value.length > 8 ? `…${value.slice(-6)}` : (value || null);
}

function safeArgumentsSummary(slug, args) {
  if (slug === GMAIL_TOOL_SLUGS.SEARCH) {
    const query = typeof args?.query === "string" ? args.query.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[email]").slice(0, 180) : "";
    return { query, max_results: args?.max_results };
  }
  if (slug === GMAIL_TOOL_SLUGS.READ) return { message_id_present: Boolean(args?.message_id || args?.messageId) };
  if (slug === GMAIL_TOOL_SLUGS.MODIFY_MESSAGES || slug === GMAIL_TOOL_SLUGS.TRASH_MESSAGE) {
    return { message_count: Array.isArray(args?.message_ids) ? args.message_ids.length : undefined };
  }
  return { argument_keys: Object.keys(args || {}) };
}

export const GMAIL_TOOL_SLUGS = Object.freeze({
  SEARCH: "GMAIL_FETCH_EMAILS",
  READ: "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
  LIST_LABELS: "GMAIL_LIST_LABELS",
  CREATE_LABEL: "GMAIL_CREATE_LABEL",
  MODIFY_MESSAGES: "GMAIL_BATCH_MODIFY_MESSAGES",
  TRASH_MESSAGE: "GMAIL_MOVE_TO_TRASH",
  CREATE_DRAFT: "GMAIL_CREATE_EMAIL_DRAFT",
  SEND_EMAIL: "GMAIL_SEND_EMAIL",
});

export class GmailApiError extends Error {
  constructor(code, details = null) {
    super(code);
    this.name = "GmailApiError";
    this.code = code;
    if (details) this.details = details;
  }
}

function parseJson(value) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

function safeErrorDetails(payload) {
  const error = payload?.error;
  const values = {
    ...(typeof payload?.request_id === "string" ? { request_id: payload.request_id } : {}),
    ...(typeof payload?.log_id === "string" ? { log_id: payload.log_id } : {}),
    ...(typeof error === "string" ? { error } : {}),
    ...(error && typeof error === "object" ? {
      ...(typeof error.code === "string" ? { error_code: error.code } : {}),
      ...(typeof error.message === "string" ? { error_message: error.message } : {}),
    } : {}),
    ...(typeof payload?.message === "string" ? { message: payload.message } : {}),
  };
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "string") {
      values[key] = value.replace(/\bak_[A-Za-z0-9_-]+\b/g, "[REDACTED_API_KEY]").slice(0, 500);
    }
  }
  return Object.keys(values).length ? values : null;
}

function unwrap(value, depth = 0) {
  value = parseJson(value);
  if (Array.isArray(value)) {
    if (!value.length) return null;
    if (value.length === 1) return unwrap(value[0]?.response || value[0]?.data || value[0], depth + 1);
    return value;
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 5) return value;
  for (const key of ["response_data", "data", "result", "output", "data_preview"]) {
    if (value[key] !== undefined) {
      const parsed = unwrap(value[key], depth + 1);
      if (parsed !== undefined && parsed !== null) return parsed;
    }
  }
  return value;
}

function arrayAt(value, keys, depth = 0) {
  value = parseJson(value);
  if (Array.isArray(value)) {
    if (value.some((item) => item && typeof item === "object"
        && (item.messageId || item.message_id || item.id || item.labelId || item.name))) return value;
    for (const item of value) {
      const found = arrayAt(item?.response || item?.data || item, keys, depth + 1);
      if (found.length) return found;
    }
    return [];
  }
  if (!value || typeof value !== "object" || depth > 6) return [];
  for (const key of keys) {
    if (Array.isArray(value[key])) return value[key];
  }
  for (const key of ["response_data", "data", "result", "output", "data_preview"]) {
    if (value[key] !== undefined) {
      const found = arrayAt(value[key], keys, depth + 1);
      if (found.length) return found;
    }
  }
  if (Array.isArray(value.results)) {
    for (const item of value.results) {
      const found = arrayAt(item?.response || item?.data || item, keys, depth + 1);
      if (found.length) return found;
    }
  }
  return [];
}

function text(value, max = 5000) {
  if (typeof value !== "string") return "";
  return value.replace(/\0/g, "").slice(0, max);
}

function normalizeMessage(message) {
  const headers = Array.isArray(message?.payload?.headers)
    ? Object.fromEntries(message.payload.headers
      .filter((header) => typeof header?.name === "string")
      .map((header) => [header.name.toLowerCase(), header.value]))
    : {};
  return {
    message_id: message?.messageId || message?.message_id || message?.id || null,
    thread_id: message?.threadId || message?.thread_id || null,
    from: text(message?.from || message?.sender || message?.sender_email || headers.from, 300),
    to: text(message?.to || message?.recipient || headers.to, 300),
    subject: text(message?.subject || headers.subject || "(sin asunto)", 300),
    date: text(message?.date || message?.messageTimestamp || message?.internalDate || headers.date, 100),
    snippet: text(message?.snippet || message?.preview || message?.messageText || message?.message_text || message?.body_text || message?.body || "", 1800),
    labels: Array.isArray(message?.labelIds || message?.labels)
      ? (message.labelIds || message.labels).slice(0, 30).map((label) => (
        typeof label === "string" ? label : label?.name
      )).filter(Boolean)
      : [],
  };
}

async function execute({ apiKey, integration, slug, arguments: args = {}, fetchImpl = fetch }) {
  if (!apiKey) throw new GmailApiError("gmail_not_configured");
  if (!integration?.connected_account_id || !integration?.composio_user_id) {
    throw new GmailApiError("gmail_connection_incomplete");
  }
  let response;
  const logContext = {
    tool: slug,
    connected_account_id: shortId(integration.connected_account_id),
    composio_user_id: shortId(integration.composio_user_id),
    arguments: safeArgumentsSummary(slug, args),
  };
  console.info("[Gmail] Composio request:", JSON.stringify(logContext));
  try {
    response = await fetchImpl(`${COMPOSIO_EXECUTE_BASE}/${slug}`, {
      method: "POST",
      headers: { "x-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        connected_account_id: integration.connected_account_id,
        user_id: integration.composio_user_id,
        version: "latest",
        arguments: args,
      }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    console.error("[Gmail] Composio network error:", JSON.stringify({ ...logContext, error: error?.name || "NetworkError" }));
    throw new GmailApiError("gmail_unavailable", { cause: error?.name || "NetworkError" });
  }
  const payload = parseJson(await response.json().catch(() => null));
  if (!response.ok || payload?.successful === false || payload?.error) {
    console.error("[Gmail] Composio response error:", JSON.stringify({
      ...logContext,
      http_status: response.status,
      ...safeErrorDetails(payload),
    }));
    throw new GmailApiError(response.status === 401 || response.status === 403
      ? "gmail_unauthorized" : "gmail_tool_failed", {
      http_status: response.status,
      ...(safeErrorDetails(payload) || {}),
    });
  }
  const data = payload?.data ?? payload;
  console.info("[Gmail] Composio response:", JSON.stringify({
    ...logContext,
    http_status: response.status,
    successful: payload?.successful !== false,
    result_keys: data && typeof data === "object" && !Array.isArray(data) ? Object.keys(data).slice(0, 12) : undefined,
  }));
  return data;
}

export async function getGmailIntegration(supabase, memberId) {
  return getFamilyGmailIntegration(supabase, memberId);
}

export async function searchGmailMessages({ apiKey, integration, query, maxResults = 8, fetchImpl = fetch }) {
  const boundedQuery = text(query, 300).trim();
  if (!boundedQuery) throw new GmailApiError("gmail_query_required");
  const payload = await execute({
    apiKey, integration, slug: GMAIL_TOOL_SLUGS.SEARCH, fetchImpl,
    arguments: {
      user_id: "me",
      query: boundedQuery,
      max_results: Math.min(10, Math.max(1, Number(maxResults) || 8)),
      include_payload: false,
      verbose: false,
    },
  });
  const messages = arrayAt(payload, ["messages", "emails", "items"])
    .map(normalizeMessage)
    .filter((message) => typeof message.message_id === "string")
    .sort((left, right) => {
      const timestamp = (value) => /^\d{10,}$/.test(value) ? Number(value) : Date.parse(value || "");
      const a = timestamp(left.date);
      const b = timestamp(right.date);
      return (Number.isFinite(b) ? b : 0) - (Number.isFinite(a) ? a : 0);
    });
  return { query: boundedQuery, messages };
}

export async function readGmailMessage({ apiKey, integration, messageId, fetchImpl = fetch }) {
  if (typeof messageId !== "string" || !/^[A-Za-z0-9_-]{8,200}$/.test(messageId)) {
    throw new GmailApiError("gmail_message_id_invalid");
  }
  const payload = await execute({
    apiKey, integration, slug: GMAIL_TOOL_SLUGS.READ, fetchImpl,
    arguments: { user_id: "me", message_id: messageId },
  });
  const message = unwrap(payload);
  return {
    message_id: message?.messageId || message?.id || messageId,
    thread_id: message?.threadId || null,
    from: text(message?.from || message?.sender, 300),
    to: text(message?.to, 300),
    subject: text(message?.subject || "(sin asunto)", 300),
    date: text(message?.date || message?.messageTimestamp || message?.internalDate, 100),
    body: text(message?.messageText || message?.message_text || message?.bodyText || message?.body_text || message?.textBody || message?.body || message?.text || message?.snippet || "", 9000),
    labels: Array.isArray(message?.labelIds) ? message.labelIds.slice(0, 30) : [],
  };
}

export async function listGmailLabels({ apiKey, integration, fetchImpl = fetch }) {
  const payload = await execute({
    apiKey, integration, slug: GMAIL_TOOL_SLUGS.LIST_LABELS,
    arguments: { user_id: "me" }, fetchImpl,
  });
  return arrayAt(payload, ["labels", "items"]).map((label) => ({
    id: text(label?.id, 200),
    name: text(label?.name, 200),
    type: text(label?.type, 40),
  })).filter((label) => label.id && label.name).slice(0, 100);
}

async function resolveLabel({ apiKey, integration, labelName, fetchImpl }) {
  const name = text(labelName, 200).trim();
  if (!name) throw new GmailApiError("gmail_label_required");
  const labels = await listGmailLabels({ apiKey, integration, fetchImpl });
  const existing = labels.find((label) => label.name.toLocaleLowerCase("es-AR") === name.toLocaleLowerCase("es-AR"));
  if (existing) return existing;
  const payload = await execute({
    apiKey, integration, slug: GMAIL_TOOL_SLUGS.CREATE_LABEL,
    arguments: { user_id: "me", label_name: name }, fetchImpl,
  });
  const created = unwrap(payload);
  const label = {
    id: text(created?.id, 200),
    name: text(created?.name || name, 200),
    type: text(created?.type || "user", 40),
  };
  if (!label.id) throw new GmailApiError("gmail_label_creation_failed");
  return label;
}

function messageIds(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 10
      || values.some((id) => typeof id !== "string" || !/^[A-Za-z0-9_-]{8,200}$/.test(id))) {
    throw new GmailApiError("gmail_message_ids_invalid");
  }
  return [...new Set(values)];
}

export async function labelGmailMessages({ apiKey, integration, ids, labelName, fetchImpl = fetch }) {
  const validIds = messageIds(ids);
  const label = await resolveLabel({ apiKey, integration, labelName, fetchImpl });
  const result = await execute({
    apiKey, integration, slug: GMAIL_TOOL_SLUGS.MODIFY_MESSAGES, fetchImpl,
    arguments: { user_id: "me", message_ids: validIds, add_label_ids: [label.id] },
  });
  return { success: true, count: validIds.length, label: label.name, result: unwrap(result) };
}

export async function archiveGmailMessages({ apiKey, integration, ids, fetchImpl = fetch }) {
  const validIds = messageIds(ids);
  const result = await execute({
    apiKey, integration, slug: GMAIL_TOOL_SLUGS.MODIFY_MESSAGES, fetchImpl,
    arguments: { user_id: "me", message_ids: validIds, remove_label_ids: ["INBOX"] },
  });
  return { success: true, count: validIds.length, result: unwrap(result) };
}

export async function trashGmailMessages({ apiKey, integration, ids, fetchImpl = fetch }) {
  const validIds = messageIds(ids);
  const results = [];
  for (const messageId of validIds) {
    results.push(await execute({
      apiKey, integration, slug: GMAIL_TOOL_SLUGS.TRASH_MESSAGE, fetchImpl,
      arguments: { user_id: "me", message_id: messageId },
    }));
  }
  return { success: true, count: validIds.length };
}

export async function createGmailDraft({ apiKey, integration, recipientEmail, subject, body, fetchImpl = fetch }) {
  const recipient = text(recipientEmail, 320).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) throw new GmailApiError("gmail_recipient_invalid");
  const cleanSubject = text(subject, 250).trim();
  const cleanBody = text(body, 8000).trim();
  if (!cleanSubject || !cleanBody) throw new GmailApiError("gmail_draft_content_required");
  const payload = await execute({
    apiKey, integration, slug: GMAIL_TOOL_SLUGS.CREATE_DRAFT, fetchImpl,
    arguments: { user_id: "me", recipient_email: recipient, subject: cleanSubject, body: cleanBody },
  });
  return { success: true, draft: unwrap(payload) };
}

export async function sendGmailEmail({ apiKey, integration, recipientEmail, subject, body, fetchImpl = fetch }) {
  const recipient = text(recipientEmail, 320).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) throw new GmailApiError("gmail_recipient_invalid");
  const cleanSubject = text(subject, 250).trim();
  const cleanBody = text(body, 8000).trim();
  if (!cleanSubject || !cleanBody) throw new GmailApiError("gmail_message_content_required");
  const payload = await execute({
    apiKey, integration, slug: GMAIL_TOOL_SLUGS.SEND_EMAIL, fetchImpl,
    arguments: { user_id: "me", recipient_email: recipient, subject: cleanSubject, body: cleanBody },
  });
  const result = unwrap(payload);
  console.info("[Gmail] email sent:", JSON.stringify({
    family_member_id: integration.family_member_id,
    connected_account_id: integration.connected_account_id,
    message_id: result?.id || result?.messageId || null,
  }));
  return { success: true, message_id: result?.id || result?.messageId || null };
}
