import { Readable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import type { AgentConversation, AppSettings } from '../../src/types'
import { requireUser } from '../auth'
import { listAgentConversations, replaceAgentConversations } from '../lib/agentConversations'
import { proxyAgentResponsesRequest } from '../lib/agentProxy'

function isConversationArray(value: unknown): value is AgentConversation[] {
  return Array.isArray(value)
}

export async function agentRoutes(app: FastifyInstance) {
  app.get('/api/agent/conversations', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (!user) return
    return { conversations: listAgentConversations(user.id) }
  })

  app.put('/api/agent/conversations', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (!user) return

    const body = request.body as { conversations?: unknown }
    if (!isConversationArray(body?.conversations)) {
      return reply.code(400).send({ error: '无效的 Agent 对话数据' })
    }

    return { conversations: replaceAgentConversations(user.id, body.conversations) }
  })

  app.post('/api/agent/responses', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (!user) return

    const body = request.body as { settings?: AppSettings; body?: unknown }
    if (!body?.settings || body.body == null) {
      return reply.code(400).send({ error: '缺少 Agent 请求参数' })
    }

    const controller = new AbortController()
    request.raw.on('close', () => controller.abort())

    let upstream: Response
    try {
      upstream = await proxyAgentResponsesRequest(body.settings, body.body, controller.signal)
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
    }

    const contentType = upstream.headers.get('content-type') ?? 'application/json'
    const cacheControl = upstream.headers.get('cache-control') ?? 'no-store'
    reply.code(upstream.status)
    reply.header('Content-Type', contentType)
    reply.header('Cache-Control', cacheControl)

    if (!upstream.body) {
      return reply.send(await upstream.text())
    }

    return reply.send(Readable.fromWeb(upstream.body as never))
  })
}
