function conciseList(items, format) {
  return items.length ? items.map(format).join("; ") : "ninguna";
}

function normalizeQuestion(value) {
  return String(value || "").toLocaleLowerCase("es-AR")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function hasPlanningCue(value) {
  return /\b(?:tareas?|pendientes?|proyectos?|recordatorios?|recordame|recorda|anota|anotar|agrega|agregar|crea|crear|agenda|agendar|vence|vencimiento|qu[eé] falta|que queda|que nos queda)\b/
    .test(normalizeQuestion(value));
}

function hasPreferenceCue(value) {
  return /\b(?:gusta|gustan|gustos|prefiero|preferis|preferencia|favorit[oa]s?|interesa|intereses)\b/
    .test(normalizeQuestion(value));
}

function hasEmotionalCue(value) {
  return /\b(?:siento|sentis|triste|ansios[oa]|preocupad[oa]|preocupa|estresad[oa]|emocionad[oa]|animo|animos|como me ves)\b/
    .test(normalizeQuestion(value));
}

export async function getPendingFollowups(supabase, { memberId, limit = 5 }) {
  const query = new URLSearchParams({
    select: "id,member_id,memory_id,question,scheduled_at,status",
    member_id: `eq.${memberId}`,
    status: "in.(pending,sent)",
    order: "scheduled_at.asc",
    limit: String(limit),
  });
  return supabase.select("proactive_followups", query);
}

export async function saveFollowups(supabase, { memberId, followups }) {
  for (const followup of followups) {
    await supabase.rpc("save_family_followup", {
      p_member_id: followup.memberId || memberId,
      p_memory_id: followup.memoryId || null,
      p_question: followup.question,
      p_scheduled_at: followup.scheduledAt,
    });
  }
}

export async function transitionFollowups(supabase, {
  memberId,
  followupIds,
  status,
}) {
  for (const followupId of followupIds) {
    await supabase.rpc("transition_family_followup", {
      p_followup_id: followupId,
      p_member_id: memberId,
      p_new_status: status,
    });
  }
}

export function buildFamilyContext({
  member,
  members,
  memories,
  preferences,
  emotionalContext,
  projects,
  tasks,
  reminders,
  settings,
  question = "",
  history = [],
}) {
  const memberName = member.name;
  const memberNames = new Map(members.map((item) => [item.id, item.name]));
  const previousContext = history.slice(-2).map((turn) => (
    `${turn.question || ""} ${turn.answer || ""}`
  )).join(" ");
  const currentQuestion = normalizeQuestion(question);
  const followUp = /^(?:[¿?]\s*)?(?:y\b|[eé]l\b|ella\b|eso\b|ese\b|esa\b|lo\b|la\b|los\b|las\b|cu[aá]l\b|qui[eé]n\b|d[oó]nde\b|cu[aá]ndo\b|cu[aá]nto\b)/i
    .test(String(question).trim());
  const usePlanningContext = hasPlanningCue(question)
    || (followUp && hasPlanningCue(previousContext));
  const usePreferenceContext = hasPreferenceCue(question)
    || (followUp && hasPreferenceCue(previousContext));
  const useEmotionalContext = hasEmotionalCue(question)
    || (followUp && hasEmotionalCue(previousContext));
  const memoryContext = memories.map((item) => ({
    category: item.category,
    subject_member_id: item.subject_member_id,
    subject_name: memberNames.get(item.subject_member_id) || "la familia",
    provided_by_name: memberNames.get(item.metadata?.provided_by_member_id) || "un integrante",
    content: item.content,
    confidence: item.confidence,
    importance: item.importance,
  }));
  return [
    `Estás hablando con ${memberName} (integrante ${member.id}).`,
    `Zona horaria familiar: ${settings.timezone}.`,
    ...(memoryContext.length ? [`Memorias familiares relevantes (visibles para todos los integrantes): ${conciseList(memoryContext, (item) => (
      `${item.category}, referido a ${item.subject_name}, compartido por ${item.provided_by_name}: ${item.content}`
    ))}.`] : []),
    ...(usePreferenceContext && preferences.length ? [`Preferencias de quien habla: ${conciseList(preferences, (item) => (
      `${item.category}: ${JSON.stringify(item.value)}`
    ))}.`] : []),
    ...(useEmotionalContext && emotionalContext.length ? [`Contexto emocional reciente de quien habla: ${conciseList(
      emotionalContext,
      (item) => `${item.situation}: ${item.context}`,
    )}.`] : []),
    ...(usePlanningContext && projects.length ? [`Proyectos activos: ${conciseList(projects, (item) => (
      `${item.name}${item.next_step ? `; próximo paso: ${item.next_step}` : ""}`
    ))}.`] : []),
    ...(usePlanningContext && tasks.length ? [`Tareas abiertas: ${conciseList(tasks, (item) => item.description)}.`] : []),
    ...(usePlanningContext && reminders.length ? [`Recordatorios próximos o vencidos: ${conciseList(
      reminders,
      (item) => `${item.title} (${item.scheduled_at})`,
    )}.`] : []),
    "Usa estos datos solo cuando sean pertinentes. No inventes detalles.",
    "Las memorias pueden referirse a cualquier integrante; distingue siempre a la persona mencionada y no atribuyas sus datos a quien habla.",
    "No afirmes que enviaste un aviso fuera de esta conversación.",
  ].join(" ");
}
