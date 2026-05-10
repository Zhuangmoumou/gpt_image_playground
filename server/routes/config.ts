import type { FastifyInstance } from 'fastify'
import { isRegistrationAllowed } from '../auth'

export async function configRoutes(app: FastifyInstance) {
  app.get('/api/config', async () => ({ enableRegistration: isRegistrationAllowed() }))
}
