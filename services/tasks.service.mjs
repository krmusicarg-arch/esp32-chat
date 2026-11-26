import { getFamilyTaskIntegrations } from "./family.service.mjs";

export const GOOGLE_TASKS_TOOL_SLUGS = Object.freeze({
  LIST_TASK_LISTS: "GOOGLETASKS_LIST_TASK_LISTS",
  LIST_TASKS: "GOOGLETASKS_LIST_TASKS",
  INSERT_TASK: "GOOGLETASKS_INSERT_TASK",
  PATCH_TASK: "GOOGLETASKS_PATCH_TASK",
});

const COMPOSIO_EXECUTE_BASE = "https://backend.composio.dev/api/v3.1/tools/execute";
const GOOGLE_TASK_REF_PREFIX = "gtask_";

export class GoogleTasksApiError extends Error {
  constructor(code, details = null) {
    super(code);
    this.name = "GoogleTasksApiError";
    this.code = code;
    if (details) this.details = details;
  }
}

function parseJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function responseDetails(payload) {
  const error = payload?.error;
  const details = {
    ...(typeof payload?.request_id === "string" ? { request_id: payload.request_id } : {}),
    ...(typeof payload?.log_id === "string" ? { log_id: payload.log_id } : {}),
    ...(typeof error === "string" ? { error } : {}),
    ...(error && typeof error === "object" ? {
      ...(typeof error.code === "string" ? { error_code: error.code } : {}),
      ...(typeof error.message === "string" ? { error_message: error.message } : {}),
    } : {}),
    ...(typeof payload?.message === "string" ? { message: payload.message } : {}),
  };
  for (const [key, value] of Object.entries(details)) {
    if (typeof value === "string") {
      details[key] = value.replace(/\bak_[A-Za-z0-9_-]+\b/g, "[REDACTED_API_KEY]").slice(0, 400);
    }
  }
  return Object.keys(details).length ? details : null;
}

async function executeGoogleTasksTool({
  apiKey,
  integration,
  slug,
  arguments: toolArguments,
  fetchImpl = fetch,
}) {
  if (!apiKey) throw new GoogleTasksApiError("google_tasks_not_configured");
  if (!integration?.connected_account_id || !integration?.composio_user_id) {
    throw new GoogleTasksApiError("google_tasks_connection_incomplete");
  }

  let response;
  try {
    response = await fetchImpl(`${COMPOSIO_EXECUTE_BASE}/${slug}`, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        connected_account_id: integration.connected_account_id,
        user_id: integration.composio_user_id,
        version: "latest",
        arguments: toolArguments,
      }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    throw new GoogleTasksApiError("google_tasks_unavailable", {
      cause: error?.name || "NetworkError",
    });
  }

  const payload = parseJson(await response.json().catch(() => null));
  if (!response.ok || payload?.successful === false || payload?.error) {
    throw new GoogleTasksApiError("google_tasks_tool_failed", {
      http_status: response.status,
      ...(responseDetails(payload) || {}),
    });
  }
  return payload?.data ?? payload;
}

function recordsFrom(value, recordKeys, depth = 0) {
  value = parseJson(value);
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object" || depth > 5) return [];
  for (const key of recordKeys) {
    if (Array.isArray(value[key])) return value[key];
  }
  for (const key of ["data", "response_data", "result", "output"]) {
    if (value[key] !== undefined) {
      const found = recordsFrom(value[key], recordKeys, depth + 1);
      if (found.length) return found;
    }
  }
  return [];
}

function taskReference(memberId, taskListId, taskId) {
  const encoded = Buffer.from(JSON.stringify([memberId, taskListId, taskId])).toString("base64url");
  return `${GOOGLE_TASK_REF_PREFIX}${encoded}`;
}

function parseTaskReference(reference) {
  if (typeof reference !== "string" || !reference.startsWith(GOOGLE_TASK_REF_PREFIX)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(reference.slice(GOOGLE_TASK_REF_PREFIX.length), "base64url").toString());
    if (!Array.isArray(decoded) || decoded.length !== 3 || decoded.some((part) => typeof part !== "string" || !part)) {
      return null;
    }
    return { memberId: decoded[0], taskListId: decoded[1], taskId: decoded[2] };
  } catch {
    return null;
  }
}

function taskListsFrom(payload) {
  return recordsFrom(payload, ["items", "taskLists", "tasklists", "lists"])
    .filter((list) => typeof (list.id || list.tasklist_id || list.taskListId) === "string");
}

function tasksFrom(payload) {
  return recordsFrom(payload, ["items", "tasks"])
    .filter((task) => typeof task.id === "string");
}

function taskListIdOf(list) {
  return list.id || list.tasklist_id || list.taskListId;
}

function normalizeGoogleTask(task, integration, memberName, taskListId) {
  return {
    id: taskReference(integration.family_member_id, taskListId, task.id),
    description: typeof task.title === "string" && task.title.trim()
      ? task.title.trim()
      : "(tarea sin título)",
    notes: typeof task.notes === "string" ? task.notes : null,
    status: task.status === "completed" ? "completed" : "pending",
    created_by: integration.family_member_id,
    assigned_to: integration.family_member_id,
    assigned_to_name: memberName || null,
    due_at: typeof task.due === "string" ? task.due : null,
    updated_at: typeof task.updated === "string" ? task.updated : null,
    task_list_id: taskListId,
  };
}

async function listMemberTasks({
  apiKey,
  integration,
  memberName,
  includeCompleted,
  fetchImpl,
}) {
  const rawLists = await executeGoogleTasksTool({
    apiKey,
    integration,
    slug: GOOGLE_TASKS_TOOL_SLUGS.LIST_TASK_LISTS,
    arguments: { maxResults: 100 },
    fetchImpl,
  });
  const taskLists = taskListsFrom(rawLists);
  const taskPages = await Promise.all(taskLists.map(async (taskList) => {
    const taskListId = taskListIdOf(taskList);
    const payload = await executeGoogleTasksTool({
      apiKey,
      integration,
      slug: GOOGLE_TASKS_TOOL_SLUGS.LIST_TASKS,
      arguments: {
        tasklist_id: taskListId,
        maxResults: 100,
        showCompleted: includeCompleted,
        showDeleted: false,
        showHidden: false,
      },
      fetchImpl,
    });
    return tasksFrom(payload)
      .filter((task) => task.deleted !== true && task.hidden !== true)
      .map((task) => normalizeGoogleTask(task, integration, memberName, taskListId));
  }));
  return taskPages.flat();
}

export async function getGoogleTasksForFamily({
  apiKey,
  supabase,
  members,
  requiredMemberId = null,
  includeCompleted = true,
  limit = 100,
  fetchImpl = fetch,
}) {
  if (!apiKey) throw new GoogleTasksApiError("google_tasks_not_configured");
  const memberIds = (members || []).map((member) => member.id);
  const integrations = await getFamilyTaskIntegrations(supabase, memberIds);
  if (requiredMemberId && !integrations.some((row) => row.family_member_id === requiredMemberId)) {
    throw new GoogleTasksApiError("google_tasks_member_not_connected");
  }
  const names = new Map((members || []).map((member) => [member.id, member.name]));
  const results = await Promise.all(integrations.map((integration) => listMemberTasks({
    apiKey,
    integration,
    memberName: names.get(integration.family_member_id),
    includeCompleted,
    fetchImpl,
  })));
  return results.flat()
    .filter((task) => includeCompleted || task.status !== "completed")
    .sort((left, right) => String(right.updated_at || "").localeCompare(String(left.updated_at || "")))
    .slice(0, limit);
}

async function getMemberTaskIntegration(supabase, memberId) {
  const rows = await getFamilyTaskIntegrations(supabase, [memberId]);
  return rows.find((row) => row.family_member_id === memberId) || null;
}

async function getDefaultTaskList({ apiKey, integration, fetchImpl }) {
  const payload = await executeGoogleTasksTool({
    apiKey,
    integration,
    slug: GOOGLE_TASKS_TOOL_SLUGS.LIST_TASK_LISTS,
    arguments: { maxResults: 100 },
    fetchImpl,
  });
  const lists = taskListsFrom(payload);
  const preferred = lists.find((list) => String(list.title || "").toLocaleLowerCase() === "my tasks");
  const list = preferred || lists[0];
  const id = list ? taskListIdOf(list) : null;
  if (!id) throw new GoogleTasksApiError("google_tasks_task_list_missing");
  return {
    id,
    title: typeof list.title === "string" && list.title.trim() ? list.title.trim() : "(lista sin nombre)",
  };
}

export async function saveGoogleTasks({
  apiKey,
  supabase,
  memberId,
  members,
  tasks,
  fetchImpl = fetch,
}) {
  const memberNames = new Map((members || []).map((member) => [member.id, member.name]));
  for (const task of tasks || []) {
    const ownerMemberId = task.assignedTo || memberId;
    const integration = await getMemberTaskIntegration(supabase, ownerMemberId);
    if (!integration) {
      const error = new GoogleTasksApiError("google_tasks_member_not_connected");
      error.memberId = ownerMemberId;
      error.memberName = memberNames.get(ownerMemberId) || null;
      throw error;
    }
    const taskList = await getDefaultTaskList({ apiKey, integration, fetchImpl });
    await executeGoogleTasksTool({
      apiKey,
      integration,
      slug: GOOGLE_TASKS_TOOL_SLUGS.INSERT_TASK,
      arguments: {
        tasklist_id: taskList.id,
        title: task.description,
        ...(task.dueAt ? { due: task.dueAt } : {}),
      },
      fetchImpl,
    });
    console.info("[Google Tasks] task persisted:", JSON.stringify({
      family_member_id: ownerMemberId,
      family_member_name: memberNames.get(ownerMemberId) || null,
      connected_account_id: integration.connected_account_id,
      task_list_title: taskList.title,
      task_list_id: taskList.id,
    }));
  }
}

export async function transitionGoogleTasks({
  apiKey,
  supabase,
  taskIds,
  status,
  fetchImpl = fetch,
}) {
  const references = [...new Set(taskIds || [])]
    .map(parseTaskReference)
    .filter(Boolean);
  if (!references.length) return;
  const memberIds = [...new Set(references.map((reference) => reference.memberId))];
  const integrations = await getFamilyTaskIntegrations(supabase, memberIds);
  const integrationsByMember = new Map(integrations.map((row) => [row.family_member_id, row]));
  const composioStatus = status === "completed" ? "completed" : "needsAction";
  await Promise.all(references.map(async (reference) => {
    const integration = integrationsByMember.get(reference.memberId);
    if (!integration) throw new GoogleTasksApiError("google_tasks_member_not_connected");
    await executeGoogleTasksTool({
      apiKey,
      integration,
      slug: GOOGLE_TASKS_TOOL_SLUGS.PATCH_TASK,
      arguments: {
        tasklist_id: reference.taskListId,
        task_id: reference.taskId,
        status: composioStatus,
      },
      fetchImpl,
    });
  }));
}

export async function getBoardTasks({
  apiKey,
  supabase,
  members,
  statuses = ["pending"],
  limit = 20,
  fetchImpl = fetch,
}) {
  const includeCompleted = statuses.includes("completed");
  const tasks = await getGoogleTasksForFamily({
    apiKey,
    supabase,
    members,
    includeCompleted,
    limit,
    fetchImpl,
  });
  return tasks.filter((task) => statuses.includes(task.status));
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
