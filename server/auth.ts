import crypto from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { db, type SessionRow, type UserRow } from './db/client'
import { config } from './config'

const SESSION_COOKIE = 'gip_session'
const SESSION_MAX_AGE_MS = config.sessionMaxAgeDays * 24 * 60 * 60 * 1000

export interface AuthUser {
  id: string
  username: string
}

function normalizeUsername(username: string) {
  return username.trim().toLowerCase()
}

export function validateCredentialsInput(username: unknown, password: unknown) {
  if (typeof username !== 'string' || normalizeUsername(username).length < 3) {
    throw new Error('用户名至少需要 3 个字符')
  }
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('密码至少需要 8 个字符')
  }
  return { username: normalizeUsername(username), password }
}

export function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(password, salt, 64).toString('hex')
  return `scrypt:${salt}:${hash}`
}

export function verifyPassword(password: string, passwordHash: string) {
  const [algorithm, salt, expected] = passwordHash.split(':')
  if (algorithm !== 'scrypt' || !salt || !expected) return false
  const actual = crypto.scryptSync(password, salt, 64)
  const expectedBytes = Buffer.from(expected, 'hex')
  return expectedBytes.length === actual.length && crypto.timingSafeEqual(expectedBytes, actual)
}

export function countUsers() {
  return db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }
}

export function isRegistrationAllowed() {
  return config.enableRegistration || countUsers().count === 0
}

export function createUser(username: string, password: string): AuthUser {
  const now = Date.now()
  const user = {
    id: crypto.randomUUID(),
    username,
    password_hash: hashPassword(password),
    created_at: now,
    updated_at: now,
  }
  db.prepare(`
    INSERT INTO users (id, username, password_hash, created_at, updated_at)
    VALUES (@id, @username, @password_hash, @created_at, @updated_at)
  `).run(user)
  return { id: user.id, username: user.username }
}

export function findUserByUsername(username: string) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined
}

function shouldUseSecureSessionCookie(request: FastifyRequest) {
  const origin = request.headers.origin
  if (typeof origin === 'string') {
    try {
      return new URL(origin).protocol === 'https:'
    } catch {
      return process.env.NODE_ENV === 'production'
    }
  }

  const protoHeader = request.headers['x-forwarded-proto']
  const protocol = Array.isArray(protoHeader) ? protoHeader[0] : protoHeader
  if (protocol) return protocol.split(',')[0]?.trim() === 'https'

  return process.env.NODE_ENV === 'production'
}

export function createSession(request: FastifyRequest, reply: FastifyReply, userId: string) {
  const now = Date.now()
  const session = {
    id: crypto.randomBytes(32).toString('hex'),
    user_id: userId,
    expires_at: now + SESSION_MAX_AGE_MS,
    created_at: now,
    last_seen_at: now,
  }
  db.prepare(`
    INSERT INTO sessions (id, user_id, expires_at, created_at, last_seen_at)
    VALUES (@id, @user_id, @expires_at, @created_at, @last_seen_at)
  `).run(session)
  reply.setCookie(SESSION_COOKIE, session.id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: shouldUseSecureSessionCookie(request),
    path: '/',
    maxAge: Math.floor(SESSION_MAX_AGE_MS / 1000),
    signed: true,
  })
}

export function clearSession(request: FastifyRequest, reply: FastifyReply) {
  const sessionId = getSessionId(request)
  if (sessionId) db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId)
  reply.clearCookie(SESSION_COOKIE, { path: '/', secure: shouldUseSecureSessionCookie(request) })
}

function getSessionId(request: FastifyRequest) {
  const signed = request.unsignCookie(request.cookies[SESSION_COOKIE] ?? '')
  return signed.valid ? signed.value : null
}

export function getCurrentUser(request: FastifyRequest): AuthUser | null {
  const sessionId = getSessionId(request)
  if (!sessionId) return null

  const row = db.prepare(`
    SELECT sessions.*, users.username AS username
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.id = ?
  `).get(sessionId) as (SessionRow & { username: string }) | undefined

  if (!row) return null
  const now = Date.now()
  if (row.expires_at <= now) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId)
    return null
  }

  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(now, sessionId)
  return { id: row.user_id, username: row.username }
}

export async function requireUser(request: FastifyRequest, reply: FastifyReply) {
  const user = getCurrentUser(request)
  if (!user) {
    reply.code(401).send({ error: '请先登录' })
    return null
  }
  return user
}
