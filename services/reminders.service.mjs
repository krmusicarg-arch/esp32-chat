export async function getUpcomingReminders(supabase, {
  now,
  hours = 24,
  limit = 5,
  includeRecurring = false,
}) {
  const cutoff = new Date(now.getTime() + hours * 60 * 60 * 1000).toISOString();
  const query = new URLSearchParams({
    select: "id,task_id,title,description,scheduled_at,status,recurrence_rule,recurrence_timezone,metadata",
    status: "eq.pending",
    order: "scheduled_at.asc",
    limit: String(limit),
  });
  if (includeRecurring) {
    query.set("or", `(scheduled_at.lte.${cutoff},recurrence_rule.eq.weekly)`);
  } else {
    query.set("scheduled_at", `lte.${cutoff}`);
  }
  return supabase.select("reminders", query);
}

export async function saveReminders(supabase, { memberId, sourceMessageId, reminders }) {
  for (const [index, reminder] of reminders.entries()) {
    await supabase.rpc("create_family_reminder", {
      p_task_id: reminder.taskId || null,
      p_title: reminder.title,
      p_description: reminder.description || null,
      p_scheduled_at: reminder.scheduledAt,
      p_created_by: memberId,
      p_metadata: {
        origin: "assistant",
        source_message_id: sourceMessageId,
        reminder_index: index,
      },
      p_recurrence_rule: reminder.recurrenceRule || "none",
    });
  }
}

export async function cancelReminders(supabase, { memberId, reminderIds }) {
  for (const reminderId of reminderIds) {
    await supabase.rpc("cancel_family_reminder", {
      p_reminder_id: reminderId,
      p_member_id: memberId,
    });
  }
}
