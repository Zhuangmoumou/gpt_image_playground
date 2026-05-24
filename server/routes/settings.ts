import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireAdmin, requireAuth } from '../auth.js'
import { getAllowRegistration, getUserSettings, setAllowRegistration, upsertUserSettings } from '../settings.js'

export async function registerSettingsRoutes(app: FastifyInstance) {
  app.get('/api/system/registration', async () => ({ allowRegistration: getAllowRegistration() }))

  app.put('/api/admin/registration', async (request, reply) => {
    await requireAdmin(request, reply)
    const body = z.object({ allowRegistration: z.boolean() }).parse(request.body)
    setAllowRegistration(body.allowRegistration)
    return { allowRegistration: body.allowRegistration }
  })

  app.get('/api/settings', async (request, reply) => {
    const auth = await requireAuth(request, reply)
    return getUserSettings(auth.user.id) ?? { settings: null, revision: 0, updatedAt: null }
  })

  app.put('/api/settings', async (request, reply) => {
    const auth = await requireAuth(request, reply)
    const body = z.object({ settings: z.unknown() }).parse(request.body)
    return upsertUserSettings(auth.user.id, body.settings)
  })
}
