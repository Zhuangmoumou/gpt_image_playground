import type { FastifyInstance } from 'fastify'
import { clearSession, createSession, createUser, findUserByUsername, getCurrentUser, isRegistrationAllowed, validateCredentialsInput, verifyPassword } from '../auth'
import { checkAuthRateLimit } from '../security'

export async function authRoutes(app: FastifyInstance) {
  app.get('/api/me', async (request, reply) => ({ user: getCurrentUser(request, reply) }))

  app.post('/api/auth/register', async (request, reply) => {
    if (!isRegistrationAllowed()) return reply.code(403).send({ error: '注册已关闭' })
    try {
      const body = request.body as { username?: unknown; password?: unknown }
      const { username, password } = validateCredentialsInput(body?.username, body?.password)
      const limited = checkAuthRateLimit(request, username)
      if (limited) {
        reply.header('Retry-After', String(limited.retryAfterSeconds))
        return reply.code(429).send({ error: limited.message })
      }
      const user = createUser(username, password)
      createSession(request, reply, user.id)
      return { user }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const code = /UNIQUE/i.test(message) ? 409 : 400
      return reply.code(code).send({ error: code === 409 ? '用户名已存在' : message })
    }
  })

  app.post('/api/auth/login', async (request, reply) => {
    try {
      const body = request.body as { username?: unknown; password?: unknown }
      const { username, password } = validateCredentialsInput(body?.username, body?.password)
      const limited = checkAuthRateLimit(request, username)
      if (limited) {
        reply.header('Retry-After', String(limited.retryAfterSeconds))
        return reply.code(429).send({ error: limited.message })
      }
      const row = findUserByUsername(username)
      if (!row || !verifyPassword(password, row.password_hash)) {
        return reply.code(401).send({ error: '用户名或密码错误' })
      }
      const user = { id: row.id, username: row.username }
      createSession(request, reply, user.id)
      return { user }
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/auth/logout', async (request, reply) => {
    clearSession(request, reply)
    return { ok: true }
  })
}
