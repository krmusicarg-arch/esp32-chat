export const MEMORY_CATEGORIES = new Set([
  "IDENTITY",
  "LIKES",
  "PREFERENCES",
  "FAMILY",
  "EXPERIENCES",
  "GOALS",
  "ROUTINES",
  "IMPORTANT_EVENTS",
  "EMOTIONAL_CONTEXT",
]);

const STOP_WORDS = new Set([
  "a", "al", "de", "del", "el", "en", "es", "la", "las", "los", "mi", "mis",
  "por", "que", "se", "su", "un", "una", "y",
]);
const MIN_MEMORY_CONFIDENCE = 0.65;
const MIN_MEMORY_RELEVANCE = 12;

function terms(value) {
  return new Set(String(value).toLocaleLowerCase("es-AR")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .match(/[\p{L}\p{N}]{3,}/gu)
    ?.filter((term) => !STOP_WORDS.has(term)) || []);
}

export async function getMemories(supabase, {
  question,
  history = [],
  limit = 30,
  now = new Date(),
}) {
  const select = "id,subject_member_id,category,content,importance,confidence,source_message_id,valid_from,valid_until,metadata";
  const followUp = /^(?:[¿?]\s*)?(?:y\b|[eé]l\b|ella\b|eso\b|ese\b|esa\b|lo\b|la\b|los\b|las\b|cu[aá]l\b|qui[eé]n\b|d[oó]nde\b|cu[aá]ndo\b|cu[aá]nto\b)/i
    .test(String(question || "").trim());
  const previousContext = followUp
    ? history.slice(-2).map((turn) => `${turn.question} ${turn.answer}`).join(" ")
    : "";
  const relevanceText = `${question || ""} ${previousContext}`;
  const normalizedRelevance = relevanceText.toLocaleLowerCase("es-AR")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const asksAboutBirthdays = /\bcumple(?:n|anos)?\b/.test(normalizedRelevance);
  const asksForMemory = /\b(?:recorda|recordas|recuerdo|recuerdos|sabes|gustos|datos de mi|que sabes de|que recordas)\b/.test(normalizedRelevance);
  const notExpiredFilter = `(valid_until.is.null,valid_until.gt.${now.toISOString()})`;
  const query = new URLSearchParams({
    select,
    active: "eq.true",
    or: notExpiredFilter,
    order: "importance.desc,confidence.desc,valid_from.desc",
    limit: String(limit),
  });
  const [rows, birthdayRows] = await Promise.all([
    supabase.select("memories", query),
    asksAboutBirthdays
      ? supabase.select("memories", new URLSearchParams({
        select,
        active: "eq.true",
        or: notExpiredFilter,
        category: "in.(IMPORTANT_EVENTS,FAMILY)",
        content: "ilike.*cumple*",
        order: "valid_from.desc",
        limit: "1000",
      }))
      : Promise.resolve([]),
  ]);
  const uniqueRows = new Map([...rows, ...birthdayRows].map((row) => [row.id, row]));
  const queryTerms = terms(relevanceText);
  const nowTime = now.getTime();
  const scoredRows = [...uniqueRows.values()].filter((row) => (
    row.active !== false
    && Number(row.confidence ?? 1) >= MIN_MEMORY_CONFIDENCE
    && (!row.valid_until || new Date(row.valid_until).getTime() > nowTime)
  )).map((row) => {
    const contentTerms = terms(row.content);
    const overlap = [...queryTerms].filter((term) => contentTerms.has(term)).length;
    const score = overlap * 4 + Number(row.importance || 3)
      + Number(row.confidence || 0) * 2;
    return { ...row, relevance: score, overlap };
  }).sort((a, b) => b.relevance - a.relevance);
  if (!asksAboutBirthdays) {
    return scoredRows.filter((row) => asksForMemory
      ? row.relevance >= MIN_MEMORY_CONFIDENCE * 10
      : row.overlap > 0 && row.relevance >= MIN_MEMORY_RELEVANCE)
      .slice(0, Math.min(8, limit));
  }

  const birthdays = scoredRows.filter((row) => (
    /\bcumple(?:n|anos)?\b/.test(String(row.content || "").toLocaleLowerCase("es-AR")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, ""))
  ));
  return birthdays;
}

export async function getBirthdays(supabase, { limit = 20 } = {}) {
  const query = new URLSearchParams({
    select: "id,subject_member_id,category,content,importance,confidence",
    active: "eq.true",
    category: "in.(IMPORTANT_EVENTS,FAMILY)",
    content: "ilike.*cumple*",
    order: "valid_from.desc",
    limit: String(limit),
  });
  return supabase.select("memories", query);
}

export async function getPreferences(supabase, { memberId, limit = 8 }) {
  const query = new URLSearchParams({
    select: "category,value,confidence,source_message_id",
    member_id: `eq.${memberId}`,
    active: "eq.true",
    order: "confidence.desc,updated_at.desc",
    limit: String(limit),
  });
  return supabase.select("preferences", query);
}

export async function getEmotionalContext(supabase, { memberId, limit = 3 }) {
  const query = new URLSearchParams({
    select: "situation,context,status,last_update",
    member_id: `eq.${memberId}`,
    status: "eq.active",
    order: "last_update.desc",
    limit: String(limit),
  });
  return supabase.select("emotional_context", query);
}

export async function saveMemories(supabase, {
  memberId,
  sourceMessageId,
  memories,
}) {
  for (const memory of memories) {
    await supabase.rpc("save_family_memory", {
      p_memory_id: memory.memoryId || null,
      p_subject_member_id: memory.subjectMemberId || null,
      p_category: memory.category,
      p_content: memory.content,
      p_importance: memory.importance,
      p_confidence: memory.confidence,
      p_source_message_id: sourceMessageId,
      p_changed_by: memberId,
      p_reason: memory.reason || "Dato nuevo compartido en conversación",
    });
  }
}

export async function savePreferences(supabase, {
  memberId,
  sourceMessageId,
  preferences,
}) {
  for (const preference of preferences) {
    await supabase.rpc("save_family_preference", {
      p_member_id: memberId,
      p_category: preference.category,
      p_value: preference.value,
      p_confidence: preference.confidence,
      p_source_message_id: sourceMessageId,
    });
  }
}

export async function saveEmotionalContext(supabase, {
  memberId,
  sourceMessageId,
  entries,
}) {
  for (const entry of entries) {
    await supabase.rpc("save_family_emotional_context", {
      p_member_id: memberId,
      p_situation: entry.situation,
      p_context: entry.context,
      p_source_message_id: sourceMessageId,
    });
  }
}
