import type { AgentConversation, ResponsesOutputItem } from '../types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function getPersistableResponseOutputItem(item: ResponsesOutputItem): ResponsesOutputItem {
  if (item.type !== 'image_generation_call' || item.result == null) return item

  if (typeof item.result === 'string') {
    const { result: _result, ...rest } = item
    return rest
  }

  if (!isRecord(item.result)) return item
  const { b64_json: _b64Json, base64: _base64, image: _image, data: _data, ...restResult } = item.result
  if (Object.keys(restResult).length === 0) {
    const { result: _result, ...rest } = item
    return rest
  }

  return { ...item, result: restResult as ResponsesOutputItem['result'] }
}

export function getPersistableRawResponsePayload(rawResponsePayload?: unknown) {
  if (typeof rawResponsePayload !== 'string' || !rawResponsePayload) return rawResponsePayload
  try {
    const payload = JSON.parse(rawResponsePayload) as { output?: unknown }
    if (!Array.isArray(payload.output)) return rawResponsePayload
    const output = payload.output.map((item) =>
      isRecord(item) ? getPersistableResponseOutputItem(item as ResponsesOutputItem) : item,
    )
    return JSON.stringify({ ...payload, output }, null, 2)
  } catch {
    return rawResponsePayload
  }
}

export function getPersistableTask<T extends { rawResponsePayload?: unknown }>(task: T): T {
  const rawResponsePayload = getPersistableRawResponsePayload(task.rawResponsePayload)
  return rawResponsePayload === task.rawResponsePayload ? task : { ...task, rawResponsePayload }
}

export function getPersistableAgentConversation<T extends Pick<AgentConversation, 'rounds'>>(conversation: T): T {
  const sourceRounds = Array.isArray(conversation.rounds) ? conversation.rounds : []
  const rounds = sourceRounds.map((round) => round.responseOutput?.length
    ? {
        ...round,
        responseOutput: round.responseOutput.map(getPersistableResponseOutputItem),
      }
    : round,
  )
  const changed = !Array.isArray(conversation.rounds) || rounds.some((round, index) => round !== sourceRounds[index])
  return changed ? { ...conversation, rounds } : conversation
}

export function getPersistableAgentConversations<T extends Pick<AgentConversation, 'rounds'>>(conversations: T[]): T[] {
  return conversations.map(getPersistableAgentConversation)
}
