import type { FastifyInstance } from 'fastify'
import type { AppSettings, TaskParams } from '../../src/types'
import { requireUser } from '../auth'
import { getUserSettings, upsertUserSettings } from '../lib/userSettings'

export async function settingsRoutes(app: FastifyInstance) {
  app.get('/api/settings', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (!user) return
    return getUserSettings(user.id)
  })

  app.put('/api/settings', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (!user) return

    const body = request.body as { settings?: AppSettings; params?: TaskParams }
    if (!body?.settings || !body.params) return reply.code(400).send({ error: '缺少设置数据' })

    return upsertUserSettings(user.id, body.settings, body.params)
  })
}
