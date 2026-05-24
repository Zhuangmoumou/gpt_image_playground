import { Readable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireAuth } from '../auth.js'
import { config } from '../config.js'
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

const PRIVATE_HOST_RE = /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[0-1])\.|192\.168\.|0\.|::1$)/i

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

export async function registerGenerationRoutes(app: FastifyInstance) {
  app.post('/api/generation/responses', async (request, reply) => {
    const auth = await requireAuth(request, reply)
    const body = responsesProxySchema.parse(request.body)
    const rawSettings = getRawUserSettings(auth.user.id)?.settings ?? {}
    const profile = getActiveProfile(rawSettings)
    const apiKey = typeof profile.apiKey === 'string' ? profile.apiKey.trim() : ''
    if (!apiKey) return reply.code(400).send({ error: '请先配置 API Key' })

    const response = await fetch(buildProviderUrl(typeof profile.baseUrl === 'string' ? profile.baseUrl : '', 'responses'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body.body),
    })

    reply.code(response.status)
    const contentType = response.headers.get('Content-Type')
    if (contentType) reply.header('Content-Type', contentType)

    if (!response.body) return reply.send(await response.text())
    return reply.send(Readable.fromWeb(response.body as never))
  })

  app.post('/api/generation/images', async (request, reply) => {
    const auth = await requireAuth(request, reply)
    const body = requestSchema.parse(request.body)
    const rawSettings = getRawUserSettings(auth.user.id)?.settings ?? body.settings
    const profile = getActiveProfile(rawSettings)
    const provider = typeof profile.provider === 'string' ? profile.provider : 'openai'
    if (provider !== 'openai' && !provider.startsWith('custom-')) {
      return reply.code(400).send({ error: '服务端发出请求暂时仅支持 OpenAI 兼容接口' })
    }

    const apiKey = typeof profile.apiKey === 'string' ? profile.apiKey.trim() : ''
    if (!apiKey) return reply.code(400).send({ error: '请先配置 API Key' })

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
      return reply.code(response.status).send({
        error: message,
        rawResponsePayload: responseText || null,
      })
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

    if (!images.length) return reply.code(502).send({
      error: '接口未返回图片数据',
      rawResponsePayload: responseText || JSON.stringify(payload, null, 2),
    })
    return { images, rawImageUrls, revisedPrompts }
  })
}
