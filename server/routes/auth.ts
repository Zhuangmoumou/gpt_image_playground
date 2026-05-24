import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { CSRF_COOKIE, createSession, getCsrfCookieOptions, getRequestAuth, hashPassword, requireAuth, revokeSession, revokeSessionById, verifyPassword } from '../auth.js'
import { db } from '../db.js'
import { logAuth, logWarn } from '../logger.js'
import { getAllowRegistration } from '../settings.js'

const credentialsSchema = z.object({
  username: z.string().trim().min(2).max(64).regex(/^[a-zA-Z0-9_.@-]+$/),
  password: z.string().min(8).max(256),
})

function publicUser(user: { id: string; username: string; role: string }) {
  return { id: user.id, username: user.username, role: user.role }
}

function getUserCount() {
  return (db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count
}

export async function registerAuthRoutes(app: FastifyInstance) {
  app.get('/api/auth/me', async (request, reply) => {
    const auth = await requireAuth(request, reply)
    const csrfToken = request.cookies[CSRF_COOKIE]
    if (csrfToken) reply.setCookie(CSRF_COOKIE, csrfToken, getCsrfCookieOptions(auth.session.expiresAt))
    return {
      user: publicUser(auth.user),
      session: { id: auth.session.id, expiresAt: auth.session.expiresAt },
      allowRegistration: getAllowRegistration(),
    }
  })

  app.post('/api/auth/register', async (request, reply) => {
    const parsed = credentialsSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: '用户名或密码格式不正确' })

    const userCount = getUserCount()
    if (userCount > 0 && !getAllowRegistration()) {
      return reply.code(403).send({ error: '当前已关闭注册' })
    }

    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(parsed.data.username)
    if (existing) return reply.code(409).send({ error: '用户名已存在' })

    const now = Date.now()
    const id = randomUUID()
    const role = userCount === 0 ? 'admin' : 'user'
    const passwordHash = await hashPassword(parsed.data.password)

    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?)
    `).run(id, parsed.data.username, passwordHash, role, now, now)

    const session = createSession(id, request, reply)
    logAuth(`用户注册并登录：${parsed.data.username}`, { role, ip: request.ip })
    return {
      user: { id, username: parsed.data.username, role },
      session: { id: session.id, expiresAt: session.expiresAt },
      allowRegistration: getAllowRegistration(),
    }
  })

  app.post('/api/auth/login', async (request, reply) => {
    const parsed = credentialsSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: '用户名或密码格式不正确' })

    const user = db.prepare('SELECT id, username, password_hash, role, status FROM users WHERE username = ?').get(parsed.data.username) as {
      id: string
      username: string
      password_hash: string
      role: 'admin' | 'user'
      status: 'active' | 'disabled'
    } | undefined

    if (!user || user.status !== 'active' || !(await verifyPassword(parsed.data.password, user.password_hash))) {
      logWarn(`登录失败：${parsed.data.username}`, { ip: request.ip })
      return reply.code(401).send({ error: '用户名或密码错误' })
    }

    db.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?').run(Date.now(), Date.now(), user.id)
    const session = createSession(user.id, request, reply)
    logAuth(`用户登录：${user.username}`, { role: user.role, ip: request.ip })
    return {
      user: publicUser(user),
      session: { id: session.id, expiresAt: session.expiresAt },
      allowRegistration: getAllowRegistration(),
    }
  })

  app.post('/api/auth/logout', async (request, reply) => {
    const auth = getRequestAuth(request)
    revokeSession(request, reply)
    if (auth) logAuth(`用户退出登录：${auth.user.username}`, { ip: request.ip })
    return { ok: true }
  })

  app.get('/api/auth/sessions', async (request, reply) => {
    const auth = await requireAuth(request, reply)
    const rows = db.prepare(`
      SELECT id, expires_at, last_seen_at, user_agent, ip, created_at
      FROM sessions
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
      ORDER BY last_seen_at DESC
    `).all(auth.user.id, Date.now())
    return { sessions: rows, currentSessionId: auth.session.id }
  })

  app.delete('/api/auth/sessions/:id', async (request, reply) => {
    const auth = await requireAuth(request, reply)
    const params = z.object({ id: z.string().min(1) }).parse(request.params)
    revokeSessionById(auth.user.id, params.id)
    return { ok: true }
  })
}
