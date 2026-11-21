export async function getOpenTasks(supabase, { limit = 10 }) {
  const query = new URLSearchParams({
    select: "id,description,status,created_by,assigned_to,due_at,metadata",
    status: "in.(pending,in_progress)",
    order: "updated_at.desc",
    limit: String(limit),
  });
  return supabase.select("tasks", query);
}

export async function getTaskCandidates(supabase, { limit = 25 }) {
  const query = new URLSearchParams({
    select: "id,description,status,created_by,assigned_to,due_at,metadata",
    status: "in.(pending,in_progress,completed,cancelled)",
    order: "updated_at.desc",
    limit: String(limit),
  });
  return supabase.select("tasks", query);
}

export async function getActiveProjects(supabase, { limit = 8 }) {
  const query = new URLSearchParams({
    select: "id,owner_member_id,name,description,status,next_step",
    status: "eq.active",
    order: "updated_at.desc",
    limit: String(limit),
  });
  return supabase.select("projects", query);
}

export async function saveTasks(supabase, { memberId, sourceMessageId, tasks }) {
  for (const task of tasks) {
    await supabase.rpc("create_family_task", {
      p_description: task.description,
      p_created_by: memberId,
      p_assigned_to: task.assignedTo || null,
      p_due_at: task.dueAt,
      p_source_message_id: sourceMessageId,
    });
  }
}

export async function transitionTasks(supabase, { memberId, taskIds, status, detail }) {
  for (const taskId of taskIds) {
    await supabase.rpc("transition_family_task", {
      p_task_id: taskId,
      p_member_id: memberId,
      p_new_status: status,
      p_detail: detail || null,
    });
  }
}

export async function saveProjects(supabase, { memberId, sourceMessageId, projects }) {
  for (const project of projects) {
    await supabase.rpc("save_family_project", {
      p_project_id: project.projectId || null,
      p_name: project.name,
      p_description: project.description || null,
      p_next_step: project.nextStep || null,
      p_owner_member_id: project.ownerMemberId || memberId,
      p_source_message_id: sourceMessageId,
    });
  }
}
