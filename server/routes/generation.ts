import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireAuth } from '../auth.js'
import { config } from '../config.js'
import { db, jsonColumn } from '../db.js'
import { getRawUserSettings } from '../settings.js'

const requestSchema = z.object({
  settings: z.record(z.string(), z.unknown()),
  prompt: z.string().min(1),
  params: z.record(z.string(), z.unknown()),
  inputImageDataUrls: z.array(z.string()).default([]),
  maskDataUrl: z.string().optional(),
})

const responsesProxySchema = z.object({
  body: z.record(z.string(), z.unknown()),
})

const generationJobSchema = z.object({
  kind: z.enum(['images', 'responses']),
  body: z.unknown(),
  taskId: z.string().optional(),
  conversationId: z.string().optional(),
  roundId: z.string().optional(),
})

const PRIVATE_HOST_RE = /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[0-1])\.|192\.168\.|0\.|::1$)/i

type GenerationJobStatus = 'queued' | 'running' | 'done' | 'error' | 'canceled'

interface GenerationJobRow {
  id: string
  user_id: string
  kind: 'images' | 'responses'
  status: GenerationJobStatus
  result_json: string | null
  error_text: string | null
  created_at: number
  updated_at: number
  started_at: number | null
  finished_at: number | null
}

function getActiveProfile(settings: Record<string, unknown>) {
  const profiles = Array.isArray(settings.profiles) ? settings.profiles as Array<Record<string, unknown>> : []
  const activeProfileId = typeof settings.activeProfileId === 'string' ? settings.activeProfileId : ''
  return profiles.find((profile) => profile.id === activeProfileId) ?? profiles[0] ?? settings
}

function buildProviderUrl(baseUrl: string, path: string) {
  const url = new URL(baseUrl || 'https://api.openai.com/v1')
  if (!config.allowPrivateApiBaseUrls && PRIVATE_HOST_RE.test(url.hostname)) throw Object.assign(new Error('不允许请求内网或本机地址'), { statusCode: 400 })
  const basePath = url.pathname.replace(/\/+$/, '')
  const normalizedPath = path.replace(/^\/+/, '')
  const pathname = basePath.endsWith('/v1') ? `${basePath}/${normalizedPath}` : `${basePath}/v1/${normalizedPath}`
  return `${url.origin}${pathname}`
}

function dataUrlToBlob(dataUrl: string, fallbackType = 'image/png') {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl)
  if (!match) throw new Error('图片数据格式不正确')
  return new Blob([Buffer.from(match[2], 'base64')], { type: match[1] || fallbackType })
}

async function imageUrlToDataUrl(url: string, fallbackMime: string) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`下载结果图片失败：${response.status}`)
  const mime = response.headers.get('Content-Type') || fallbackMime
  const bytes = Buffer.from(await response.arrayBuffer())
  return `data:${mime};base64,${bytes.toString('base64')}`
}

function normalizeBase64Image(value: string, fallbackMime: string) {
  return value.startsWith('data:') ? value : `data:${fallbackMime};base64,${value}`
}

function getStringValue(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value ? value : undefined
}

function pickActualParams(source: unknown) {
  if (!source || typeof source !== 'object') return {}
  const record = source as Record<string, unknown>
  const actualParams: Record<string, unknown> = {}
  if (typeof record.size === 'string') actualParams.size = record.size
  if (['auto', 'low', 'medium', 'high'].includes(String(record.quality))) actualParams.quality = record.quality
  if (['png', 'jpeg', 'webp'].includes(String(record.output_format))) actualParams.output_format = record.output_format
  if (typeof record.output_compression === 'number') actualParams.output_compression = record.output_compression
  if (record.moderation === 'auto' || record.moderation === 'low') actualParams.moderation = record.moderation
  if (typeof record.n === 'number') actualParams.n = record.n
  return actualParams
}

function extractText(payload: { output?: Array<Record<string, unknown>> }) {
  const chunks: string[] = []
  for (const item of payload.output ?? []) {
    if (item.type !== 'message') continue
    const content = Array.isArray(item.content) ? item.content as Array<Record<string, unknown>> : []
    for (const part of content) {
      if ((part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string') chunks.push(part.text)
    }
  }
  return chunks.join('\n').trim()
}

function extractAgentImages(payload: { output?: Array<Record<string, unknown>> }, fallbackMime: string) {
  const images: Array<{ toolCallId?: string; action?: string; dataUrl: string; actualParams?: Record<string, unknown>; revisedPrompt?: string }> = []
  for (const item of payload.output ?? []) {
    if (item.type !== 'image_generation_call') continue
    const result = item.result
    const b64 = typeof result === 'string'
      ? result
      : result && typeof result === 'object'
      ? getStringValue(result as Record<string, unknown>, 'b64_json') ??
        getStringValue(result as Record<string, unknown>, 'base64') ??
        getStringValue(result as Record<string, unknown>, 'image') ??
        getStringValue(result as Record<string, unknown>, 'data') ?? ''
      : ''
    if (!b64.trim()) continue
    images.push({
      toolCallId: typeof item.id === 'string' ? item.id : undefined,
      action: typeof item.action === 'string' ? item.action : undefined,
      dataUrl: normalizeBase64Image(b64, fallbackMime),
      actualParams: pickActualParams(item),
      revisedPrompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined,
    })
  }
  return images
}

async function performResponsesRequest(userId: string, body: z.infer<typeof responsesProxySchema>) {
  const rawSettings = getRawUserSettings(userId)?.settings ?? {}
  const profile = getActiveProfile(rawSettings)
  const apiKey = typeof profile.apiKey === 'string' ? profile.apiKey.trim() : ''
  if (!apiKey) throw Object.assign(new Error('请先配置 API Key'), { statusCode: 400 })

  const response = await fetch(buildProviderUrl(typeof profile.baseUrl === 'string' ? profile.baseUrl : '', 'responses'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body.body),
  })

  return response
}

async function performImagesRequest(userId: string, body: z.infer<typeof requestSchema>) {
  const rawSettings = getRawUserSettings(userId)?.settings ?? body.settings
  const profile = getActiveProfile(rawSettings)
  const provider = typeof profile.provider === 'string' ? profile.provider : 'openai'
  if (provider !== 'openai' && !provider.startsWith('custom-')) {
    throw Object.assign(new Error('服务端发出请求暂时仅支持 OpenAI 兼容接口'), { statusCode: 400 })
  }

  const apiKey = typeof profile.apiKey === 'string' ? profile.apiKey.trim() : ''
  if (!apiKey) throw Object.assign(new Error('请先配置 API Key'), { statusCode: 400 })

  const outputFormat = typeof body.params.output_format === 'string' ? body.params.output_format : 'png'
  const fallbackMime = outputFormat === 'jpeg' ? 'image/jpeg' : outputFormat === 'webp' ? 'image/webp' : 'image/png'
  const isEdit = body.inputImageDataUrls.length > 0
  const endpoint = buildProviderUrl(typeof profile.baseUrl === 'string' ? profile.baseUrl : '', isEdit ? 'images/edits' : 'images/generations')

  let response: Response
  if (isEdit) {
    const form = new FormData()
    form.set('model', typeof profile.model === 'string' ? profile.model : 'gpt-image-2')
    form.set('prompt', body.prompt)
    for (const key of ['size', 'quality', 'output_format', 'moderation', 'n'] as const) {
      const value = body.params[key]
      if (value != null) form.set(key, String(value))
    }
    if (body.params.output_compression != null) form.set('output_compression', String(body.params.output_compression))
    body.inputImageDataUrls.forEach((dataUrl, index) => form.append('image[]', dataUrlToBlob(dataUrl), `image-${index}.png`))
    if (body.maskDataUrl) form.set('mask', dataUrlToBlob(body.maskDataUrl), 'mask.png')

    response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    })
  } else {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: typeof profile.model === 'string' ? profile.model : 'gpt-image-2',
        prompt: body.prompt,
        ...body.params,
      }),
    })
  }

  const responseText = await response.text()
  let payload: { data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }> } | null = null
  try {
    payload = responseText ? JSON.parse(responseText) : null
  } catch {
    payload = null
  }

  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload
      ? JSON.stringify((payload as { error: unknown }).error)
      : `服务端请求失败：${response.status}`
    throw Object.assign(new Error(message), { statusCode: response.status, rawResponsePayload: responseText || null })
  }

  const items = Array.isArray(payload?.data) ? payload.data : []
  const images: string[] = []
  const rawImageUrls: string[] = []
  const revisedPrompts: Array<string | undefined> = []
  for (const item of items) {
    if (item.b64_json) images.push(normalizeBase64Image(item.b64_json, fallbackMime))
    else if (item.url) {
      rawImageUrls.push(item.url)
      images.push(await imageUrlToDataUrl(item.url, fallbackMime))
    }
    revisedPrompts.push(item.revised_prompt)
  }

  if (!images.length) {
    throw Object.assign(new Error('接口未返回图片数据'), { statusCode: 502, rawResponsePayload: responseText || JSON.stringify(payload, null, 2) })
  }

  return { images, rawImageUrls, revisedPrompts }
}

async function performResponsesJob(userId: string, requestBody: unknown) {
  const body = responsesProxySchema.parse(requestBody)
  const response = await performResponsesRequest(userId, body)
  const responseText = await response.text()
  let payload: { id?: string; output?: Array<Record<string, unknown>> } | null = null
  try {
    payload = responseText ? JSON.parse(responseText) : null
  } catch {
    payload = null
  }
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload
      ? JSON.stringify((payload as { error: unknown }).error)
      : responseText || `服务端请求失败：${response.status}`
    throw Object.assign(new Error(message), { statusCode: response.status })
  }
  if (!payload) throw Object.assign(new Error('Agent 接口未返回 JSON 响应'), { statusCode: 502 })

  const outputFormat = typeof body.body.output_format === 'string' ? body.body.output_format : ''
  const fallbackMime = outputFormat === 'jpeg' ? 'image/jpeg' : outputFormat === 'webp' ? 'image/webp' : 'image/png'
  return {
    responseId: payload.id,
    text: extractText(payload),
    images: extractAgentImages(payload, fallbackMime),
    outputItems: payload.output ?? [],
    rawResponsePayload: JSON.stringify(payload, null, 2),
  }
}

function getJob(jobId: string, userId: string) {
  return db.prepare('SELECT id, user_id, kind, status, result_json, error_text, created_at, updated_at, started_at, finished_at FROM generation_jobs WHERE id = ? AND user_id = ?')
    .get(jobId, userId) as GenerationJobRow | undefined
}

function serializeJob(row: GenerationJobRow) {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    result: jsonColumn<Record<string, unknown> | null>(row.result_json, null),
    error: row.error_text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }
}

async function runGenerationJob(jobId: string, userId: string) {
  const startedAt = Date.now()
  db.prepare('UPDATE generation_jobs SET status = ?, updated_at = ?, started_at = ? WHERE id = ? AND user_id = ? AND status = ?')
    .run('running', startedAt, startedAt, jobId, userId, 'queued')

  const row = db.prepare('SELECT kind, request_json FROM generation_jobs WHERE id = ? AND user_id = ?').get(jobId, userId) as { kind: 'images' | 'responses'; request_json: string } | undefined
  if (!row) return

  try {
    const requestBody = jsonColumn<unknown>(row.request_json, null)
    const result = row.kind === 'images'
      ? await performImagesRequest(userId, requestSchema.parse(requestBody))
      : await performResponsesJob(userId, requestBody)
    const finishedAt = Date.now()
    db.prepare('UPDATE generation_jobs SET status = ?, result_json = ?, error_text = NULL, updated_at = ?, finished_at = ? WHERE id = ? AND user_id = ?')
      .run('done', JSON.stringify(result), finishedAt, finishedAt, jobId, userId)
  } catch (err) {
    const finishedAt = Date.now()
    db.prepare('UPDATE generation_jobs SET status = ?, error_text = ?, updated_at = ?, finished_at = ? WHERE id = ? AND user_id = ?')
      .run('error', err instanceof Error ? err.message : String(err), finishedAt, finishedAt, jobId, userId)
  }
}

export async function registerGenerationRoutes(app: FastifyInstance) {
  app.post('/api/generation/jobs', async (request, reply) => {
    const auth = await requireAuth(request, reply)
    const body = generationJobSchema.parse(request.body)
    const now = Date.now()
    const jobId = randomUUID()
    db.prepare(`
      INSERT INTO generation_jobs (id, user_id, kind, status, task_id, conversation_id, round_id, request_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(jobId, auth.user.id, body.kind, 'queued', body.taskId ?? null, body.conversationId ?? null, body.roundId ?? null, JSON.stringify(body.body), now, now)

    void runGenerationJob(jobId, auth.user.id)
    return { jobId }
  })

  app.get('/api/generation/jobs/:id', async (request, reply) => {
    const auth = await requireAuth(request, reply)
    const params = z.object({ id: z.string().min(1) }).parse(request.params)
    const job = getJob(params.id, auth.user.id)
    if (!job) return reply.code(404).send({ error: '任务不存在' })
    return serializeJob(job)
  })

  app.post('/api/generation/responses', async (request, reply) => {
    const auth = await requireAuth(request, reply)
    const body = responsesProxySchema.parse(request.body)
    const response = await performResponsesRequest(auth.user.id, body)

    reply.code(response.status)
    const contentType = response.headers.get('Content-Type')
    if (contentType) reply.header('Content-Type', contentType)

    if (!response.body) return reply.send(await response.text())
    return reply.send(Readable.fromWeb(response.body as never))
  })

  app.post('/api/generation/images', async (request, reply) => {
    const auth = await requireAuth(request, reply)
    const body = requestSchema.parse(request.body)
    try {
      return await performImagesRequest(auth.user.id, body)
    } catch (err) {
      const statusCode = typeof (err as { statusCode?: unknown }).statusCode === 'number' ? (err as { statusCode: number }).statusCode : 500
      if ('rawResponsePayload' in (err as object)) {
        return reply.code(statusCode).send({
          error: err instanceof Error ? err.message : String(err),
          rawResponsePayload: String((err as { rawResponsePayload?: unknown }).rawResponsePayload ?? ''),
        })
      }
      throw err
    }
  })
}
