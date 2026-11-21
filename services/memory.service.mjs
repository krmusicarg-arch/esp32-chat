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

function terms(value) {
  return new Set(String(value).toLocaleLowerCase("es-AR")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .match(/[\p{L}\p{N}]{3,}/gu)
    ?.filter((term) => !STOP_WORDS.has(term)) || []);
}

export async function getMemories(supabase, { memberId, question, limit = 30 }) {
  const query = new URLSearchParams({
    select: "id,subject_member_id,category,content,importance,confidence,source_message_id,valid_from,valid_until,metadata",
    active: "eq.true",
    or: `(subject_member_id.is.null,subject_member_id.eq.${memberId})`,
    order: "importance.desc,confidence.desc,valid_from.desc",
    limit: String(limit),
  });
  const rows = await supabase.select("memories", query);
  const queryTerms = terms(question);
  return rows.map((row) => {
    const contentTerms = terms(row.content);
    const overlap = [...queryTerms].filter((term) => contentTerms.has(term)).length;
    const score = overlap * 4 + Number(row.importance || 3)
      + Number(row.confidence || 0) * 2;
    return { ...row, relevance: score };
  }).sort((a, b) => b.relevance - a.relevance)
    .slice(0, Math.min(8, limit));
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
