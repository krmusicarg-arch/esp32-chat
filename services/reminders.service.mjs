export async function getUpcomingReminders(supabase, { now, hours = 24, limit = 5 }) {
  const cutoff = new Date(now.getTime() + hours * 60 * 60 * 1000).toISOString();
  const query = new URLSearchParams({
    select: "id,task_id,title,description,scheduled_at,status,metadata",
    status: "eq.pending",
    scheduled_at: `lte.${cutoff}`,
    order: "scheduled_at.asc",
    limit: String(limit),
  });
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
