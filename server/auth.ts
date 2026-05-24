import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import bcrypt from 'bcryptjs'
import { config } from './config.js'
import { db } from './db.js'

const SESSION_COOKIE = 'gip_session'
export const CSRF_COOKIE = 'gip_csrf'
const CSRF_HEADER = 'x-csrf-token'
const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000

export interface AuthUser {
  id: string
  username: string
  role: 'admin' | 'user'
  status: 'active' | 'disabled'
}

export interface AuthSession {
  id: string
  userId: string
  csrfToken: string
  expiresAt: number
}

interface SessionRow {
  session_id: string
  user_id: string
  username: string
  role: 'admin' | 'user'
  status: 'active' | 'disabled'
  csrf_token_hash: string
  expires_at: number
  last_seen_at: number
  revoked_at: number | null
}

function sha256(value: string) {
  return createHash('sha256').update(`${config.sessionSecret}:${value}`).digest('hex')
}

function safeEqualHex(a: string, b: string) {
  const left = Buffer.from(a, 'hex')
  const right = Buffer.from(b, 'hex')
  return left.length === right.length && timingSafeEqual(left, right)
}

function createToken() {
  return randomBytes(32).toString('base64url')
}

function sessionTtlMs() {
  return config.sessionTtlDays * 24 * 60 * 60 * 1000
}

export function hashPassword(password: string) {
  return bcrypt.hash(password, 12)
}

export function verifyPassword(password: string, hash: string) {
  return bcrypt.compare(password, hash)
}

export function getSessionCookieOptions(expiresAt: number) {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: config.cookieSecure,
    expires: new Date(expiresAt),
  }
}

export function getCsrfCookieOptions(expiresAt: number) {
  return {
    path: '/',
    httpOnly: false,
    sameSite: 'lax' as const,
    secure: config.cookieSecure,
    expires: new Date(expiresAt),
  }
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE, { path: '/' })
  reply.clearCookie(CSRF_COOKIE, { path: '/' })
}

export function createSession(userId: string, request: FastifyRequest, reply: FastifyReply): AuthSession {
  const now = Date.now()
  const token = createToken()
  const csrfToken = createToken()
  const expiresAt = now + sessionTtlMs()
  const sessionId = randomUUID()

  db.prepare(`
    INSERT INTO sessions (id, user_id, token_hash, csrf_token_hash, expires_at, last_seen_at, user_agent, ip, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    userId,
    sha256(token),
    sha256(csrfToken),
    expiresAt,
    now,
    request.headers['user-agent'] ?? null,
    request.ip,
    now,
  )

  reply.setCookie(SESSION_COOKIE, token, getSessionCookieOptions(expiresAt))
  reply.setCookie(CSRF_COOKIE, csrfToken, getCsrfCookieOptions(expiresAt))
  return { id: sessionId, userId, csrfToken, expiresAt }
}

export function revokeSession(request: FastifyRequest, reply: FastifyReply) {
  const token = request.cookies[SESSION_COOKIE]
  if (token) {
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL').run(Date.now(), sha256(token))
  }
  clearSessionCookie(reply)
}

export function revokeSessionById(userId: string, sessionId: string) {
  return db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id = ? AND revoked_at IS NULL').run(Date.now(), userId, sessionId)
}

export function getRequestAuth(request: FastifyRequest): { user: AuthUser; session: AuthSession } | null {
  const token = request.cookies[SESSION_COOKIE]
  if (!token) return null

  const row = db.prepare(`
    SELECT
      sessions.id AS session_id,
      sessions.user_id,
      sessions.csrf_token_hash,
      sessions.expires_at,
      sessions.last_seen_at,
      sessions.revoked_at,
      users.username,
      users.role,
      users.status
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ?
  `).get(sha256(token)) as SessionRow | undefined

  const now = Date.now()
  if (!row || row.revoked_at || row.expires_at <= now || row.status !== 'active') return null

  const user = {
    id: row.user_id,
    username: row.username,
    role: row.role,
    status: row.status,
  }
  const session = {
    id: row.session_id,
    userId: row.user_id,
    csrfToken: row.csrf_token_hash,
    expiresAt: row.expires_at,
  }
  return { user, session }
}

export function touchSession(sessionId: string) {
  const now = Date.now()
  const expiresAt = now + sessionTtlMs()
  db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?').run(now, expiresAt, sessionId)
  return expiresAt
}

export function getCsrfHeader(request: FastifyRequest) {
  const value = request.headers[CSRF_HEADER]
  return Array.isArray(value) ? value[0] : value
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<{ user: AuthUser; session: AuthSession }> {
  const auth = getRequestAuth(request)
  if (!auth) {
    clearSessionCookie(reply)
    throw Object.assign(new Error('未登录或登录已过期'), { statusCode: 401 })
  }

  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    const csrfToken = getCsrfHeader(request)
    if (!csrfToken || !safeEqualHex(sha256(csrfToken), auth.session.csrfToken)) {
      throw Object.assign(new Error('CSRF 校验失败'), { statusCode: 403 })
    }
  }

  const row = db.prepare('SELECT last_seen_at FROM sessions WHERE id = ?').get(auth.session.id) as { last_seen_at: number } | undefined
  if (row && Date.now() - row.last_seen_at > SESSION_TOUCH_INTERVAL_MS) {
    auth.session.expiresAt = touchSession(auth.session.id)
    reply.setCookie(SESSION_COOKIE, request.cookies[SESSION_COOKIE]!, getSessionCookieOptions(auth.session.expiresAt))
  }

  return auth
}

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  const auth = await requireAuth(request, reply)
  if (auth.user.role !== 'admin') {
    throw Object.assign(new Error('需要管理员权限'), { statusCode: 403 })
  }
  return auth
}
