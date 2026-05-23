import { db, type TaskRow } from '../db/client'
import type { TaskRecord } from '../../src/types'

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export function taskFromRow(row: TaskRow): TaskRecord {
  const links = db.prepare('SELECT image_id, role FROM task_images WHERE task_id = ? ORDER BY position ASC').all(row.id) as Array<{ image_id: string; role: string }>
  return {
    id: row.id,
    prompt: row.prompt,
    params: parseJson(row.params_json, {} as TaskRecord['params']),
    apiProvider: row.api_provider ?? undefined,
    apiProfileId: row.api_profile_id ?? undefined,
    apiProfileName: row.api_profile_name ?? undefined,
    apiMode: row.api_mode === 'responses' ? 'responses' : row.api_mode === 'images' ? 'images' : undefined,
    apiModel: row.api_model ?? undefined,
    serverSideRequest: Boolean(row.server_side_request),
    falRequestId: row.fal_request_id ?? undefined,
    falEndpoint: row.fal_endpoint ?? undefined,
    falRecoverable: Boolean(row.fal_recoverable),
    customTaskId: row.custom_task_id ?? undefined,
    customRecoverable: Boolean(row.custom_recoverable),
    actualParams: parseJson(row.actual_params_json, undefined as TaskRecord['actualParams']),
    actualParamsByImage: parseJson(row.actual_params_by_image_json, undefined as TaskRecord['actualParamsByImage']),
    revisedPromptByImage: parseJson(row.revised_prompt_by_image_json, undefined as TaskRecord['revisedPromptByImage']),
    rawImageUrls: parseJson(row.raw_image_urls_json, undefined as TaskRecord['rawImageUrls']),
    rawResponsePayload: row.raw_response_payload ?? undefined,
    inputImageIds: links.filter((link) => link.role === 'input').map((link) => link.image_id),
    maskTargetImageId: links.find((link) => link.role === 'mask-target')?.image_id ?? null,
    maskImageId: links.find((link) => link.role === 'mask')?.image_id ?? null,
    outputImages: links.filter((link) => link.role === 'output').map((link) => link.image_id),
    streamPartialImageIds: links.filter((link) => link.role === 'stream-partial').map((link) => link.image_id),
    status: row.status === 'done' || row.status === 'error' ? row.status : 'running',
    error: row.error,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    elapsed: row.elapsed_ms,
    isFavorite: Boolean(row.is_favorite),
    sourceMode: row.source_mode === 'agent' ? 'agent' : row.source_mode === 'gallery' ? 'gallery' : undefined,
    agentConversationId: row.agent_conversation_id ?? undefined,
    agentRoundId: row.agent_round_id ?? undefined,
    agentMessageId: row.agent_message_id ?? undefined,
    agentToolCallId: row.agent_tool_call_id ?? undefined,
    agentBatchCallId: row.agent_batch_call_id ?? undefined,
    agentToolAction: row.agent_tool_action ?? undefined,
  }
}

export function getTaskForUser(userId: string, taskId: string) {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(taskId, userId) as TaskRow | undefined
  return row ? taskFromRow(row) : null
}

function json(value: unknown) {
  return value == null ? null : JSON.stringify(value)
}

export function upsertTask(userId: string, task: TaskRecord) {
  const now = Date.now()
  const payload = {
    id: task.id,
    user_id: userId,
    prompt: task.prompt,
    params_json: JSON.stringify(task.params),
    api_provider: task.apiProvider ?? null,
    api_profile_id: task.apiProfileId ?? null,
    api_profile_name: task.apiProfileName ?? null,
    api_model: task.apiModel ?? null,
    api_mode: task.apiMode ?? null,
    server_side_request: task.serverSideRequest ? 1 : 0,
    fal_request_id: task.falRequestId ?? null,
    fal_endpoint: task.falEndpoint ?? null,
    fal_recoverable: task.falRecoverable ? 1 : 0,
    custom_task_id: task.customTaskId ?? null,
    custom_recoverable: task.customRecoverable ? 1 : 0,
    actual_params_json: json(task.actualParams),
    actual_params_by_image_json: json(task.actualParamsByImage),
    revised_prompt_by_image_json: json(task.revisedPromptByImage),
    raw_image_urls_json: json(task.rawImageUrls),
    raw_response_payload: task.rawResponsePayload ?? null,
    source_mode: task.sourceMode ?? null,
    agent_conversation_id: task.agentConversationId ?? null,
    agent_round_id: task.agentRoundId ?? null,
    agent_message_id: task.agentMessageId ?? null,
    agent_tool_call_id: task.agentToolCallId ?? null,
    agent_batch_call_id: task.agentBatchCallId ?? null,
    agent_tool_action: typeof task.agentToolAction === 'string' ? task.agentToolAction : null,
    status: task.status,
    error: task.error,
    created_at: task.createdAt,
    finished_at: task.finishedAt,
    elapsed_ms: task.elapsed,
    is_favorite: task.isFavorite ? 1 : 0,
    updated_at: now,
  }

  db.prepare(`
    INSERT INTO tasks (
      id, user_id, prompt, params_json, api_provider, api_profile_id, api_profile_name, api_model, api_mode,
      server_side_request, fal_request_id, fal_endpoint, fal_recoverable, custom_task_id, custom_recoverable,
      actual_params_json, actual_params_by_image_json, revised_prompt_by_image_json,
      raw_image_urls_json, raw_response_payload, source_mode, agent_conversation_id, agent_round_id,
      agent_message_id, agent_tool_call_id, agent_batch_call_id, agent_tool_action, status, error,
      created_at, finished_at, elapsed_ms, is_favorite, updated_at
    ) VALUES (
      @id, @user_id, @prompt, @params_json, @api_provider, @api_profile_id, @api_profile_name, @api_model, @api_mode,
      @server_side_request, @fal_request_id, @fal_endpoint, @fal_recoverable, @custom_task_id, @custom_recoverable,
      @actual_params_json, @actual_params_by_image_json, @revised_prompt_by_image_json,
      @raw_image_urls_json, @raw_response_payload, @source_mode, @agent_conversation_id, @agent_round_id,
      @agent_message_id, @agent_tool_call_id, @agent_batch_call_id, @agent_tool_action, @status, @error,
      @created_at, @finished_at, @elapsed_ms, @is_favorite, @updated_at
    )
    ON CONFLICT(id) DO UPDATE SET
      prompt = excluded.prompt,
      params_json = excluded.params_json,
      api_provider = excluded.api_provider,
      api_profile_id = excluded.api_profile_id,
      api_profile_name = excluded.api_profile_name,
      api_model = excluded.api_model,
      api_mode = excluded.api_mode,
      server_side_request = excluded.server_side_request,
      fal_request_id = excluded.fal_request_id,
      fal_endpoint = excluded.fal_endpoint,
      fal_recoverable = excluded.fal_recoverable,
      custom_task_id = excluded.custom_task_id,
      custom_recoverable = excluded.custom_recoverable,
      actual_params_json = excluded.actual_params_json,
      actual_params_by_image_json = excluded.actual_params_by_image_json,
      revised_prompt_by_image_json = excluded.revised_prompt_by_image_json,
      raw_image_urls_json = excluded.raw_image_urls_json,
      raw_response_payload = excluded.raw_response_payload,
      source_mode = excluded.source_mode,
      agent_conversation_id = excluded.agent_conversation_id,
      agent_round_id = excluded.agent_round_id,
      agent_message_id = excluded.agent_message_id,
      agent_tool_call_id = excluded.agent_tool_call_id,
      agent_batch_call_id = excluded.agent_batch_call_id,
      agent_tool_action = excluded.agent_tool_action,
      status = excluded.status,
      error = excluded.error,
      finished_at = excluded.finished_at,
      elapsed_ms = excluded.elapsed_ms,
      is_favorite = excluded.is_favorite,
      updated_at = excluded.updated_at
  `).run(payload)

  replaceTaskLinks(task)
  return getTaskForUser(userId, task.id)
}

function replaceTaskLinks(task: TaskRecord) {
  db.prepare('DELETE FROM task_images WHERE task_id = ?').run(task.id)
  const insert = db.prepare('INSERT INTO task_images (task_id, image_id, role, position) VALUES (?, ?, ?, ?)')
  task.inputImageIds.forEach((imageId, index) => insert.run(task.id, imageId, 'input', index))
  if (task.maskTargetImageId) insert.run(task.id, task.maskTargetImageId, 'mask-target', 0)
  if (task.maskImageId) insert.run(task.id, task.maskImageId, 'mask', 0)
  task.outputImages.forEach((imageId, index) => insert.run(task.id, imageId, 'output', index))
  task.streamPartialImageIds?.forEach((imageId, index) => insert.run(task.id, imageId, 'stream-partial', index))
}

export function listTasks(userId: string) {
  const rows = db.prepare('SELECT * FROM tasks WHERE user_id = ? ORDER BY created_at DESC').all(userId) as TaskRow[]
  return rows.map(taskFromRow)
}
