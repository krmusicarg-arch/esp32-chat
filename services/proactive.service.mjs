function conciseList(items, format) {
  return items.length ? items.map(format).join("; ") : "ninguna";
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
}) {
  const memberName = member.name;
  const memberNames = new Map(members.map((item) => [item.id, item.name]));
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
    `Memorias relevantes: ${conciseList(memoryContext, (item) => (
      `${item.category}, referido a ${item.subject_name}, compartido por ${item.provided_by_name}: ${item.content}`
    ))}.`,
    `Preferencias conocidas: ${conciseList(preferences, (item) => (
      `${item.category}: ${JSON.stringify(item.value)}`
    ))}.`,
    `Contexto emocional reciente (breve): ${conciseList(
      emotionalContext,
      (item) => `${item.situation}: ${item.context}`,
    )}.`,
    `Proyectos activos: ${conciseList(projects, (item) => (
      `${item.name}${item.next_step ? `; próximo paso: ${item.next_step}` : ""}`
    ))}.`,
    `Tareas abiertas: ${conciseList(tasks, (item) => item.description)}.`,
    `Recordatorios próximos o vencidos: ${conciseList(
      reminders,
      (item) => `${item.title} (${item.scheduled_at})`,
    )}.`,
    "Usa estos datos solo cuando sean pertinentes. No inventes detalles.",
    "No afirmes que enviaste un aviso fuera de esta conversación.",
  ].join(" ");
}
