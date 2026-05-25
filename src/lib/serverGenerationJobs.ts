import type { AgentApiResult } from './agentApi'
import type { CallApiResult } from './imageApiShared'
import { serverApi } from './serverApi'

export type GenerationJobKind = 'images' | 'responses'
export type GenerationJobStatus = 'queued' | 'running' | 'done' | 'error' | 'canceled'

export interface GenerationJob<T = unknown> {
  id: string
  kind: GenerationJobKind
  status: GenerationJobStatus
  result: T | null
  error: string | null
  createdAt: number
  updatedAt: number
  startedAt: number | null
  finishedAt: number | null
}

export type ImageGenerationJobResult = CallApiResult
export type AgentGenerationJobResult = AgentApiResult

export async function submitGenerationJob(kind: GenerationJobKind, body: unknown, refs: { taskId?: string; conversationId?: string; roundId?: string } = {}) {
  return serverApi<{ jobId: string }>('/api/generation/jobs', {
    method: 'POST',
    body: JSON.stringify({ kind, body, ...refs }),
  })
}

export function getGenerationJob<T>(jobId: string) {
  return serverApi<GenerationJob<T>>(`/api/generation/jobs/${encodeURIComponent(jobId)}`)
}
