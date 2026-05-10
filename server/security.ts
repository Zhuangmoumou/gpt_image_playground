import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { config } from './config'

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

function normalizeOrigin(value: string) {
  try {
    const url = new URL(value)
    return `${url.protocol}//${url.host}`.replace(/\/+$/, '')
  } catch {
    return ''
  }
}

function getRequestOrigin(request: FastifyRequest) {
  const host = request.headers.host
  if (!host) return ''
  const protoHeader = request.headers['x-forwarded-proto']
  const protocol = Array.isArray(protoHeader) ? protoHeader[0] : protoHeader
  return `${protocol || 'http'}://${host}`.replace(/\/+$/, '')
}

function isLocalDevelopmentOrigin(origin: string) {
  if (process.env.NODE_ENV === 'production') return false
  try {
    const url = new URL(origin)
    return LOCAL_HOSTS.has(url.hostname)
  } catch {
    return false
  }
}

function isAllowedOrigin(request: FastifyRequest, origin: string) {
  const normalized = normalizeOrigin(origin)
  if (!normalized) return false
  if (normalized === getRequestOrigin(request)) return true
  if (config.appOrigin && normalized === config.appOrigin) return true
  if (config.allowedOrigins.includes(normalized)) return true
  return isLocalDevelopmentOrigin(normalized)
}

function setSecurityHeaders(reply: FastifyReply) {
  const connectSrc = [
    "'self'",
    'https:',
    'wss:',
    'ws:',
  ].join(' ')

  reply.header('X-Content-Type-Options', 'nosniff')
  reply.header('X-Frame-Options', 'DENY')
  reply.header('Referrer-Policy', 'same-origin')
  reply.header('Cross-Origin-Opener-Policy', 'same-origin')
  reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()')
  reply.header('Content-Security-Policy', [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fontsapi.zeoseven.com https://cdn.jsdelivr.net",
    "font-src 'self' data: https://fontsapi.zeoseven.com https://cdn.jsdelivr.net",
    "img-src 'self' data: blob:",
    `connect-src ${connectSrc}`,
    "manifest-src 'self'",
  ].join('; '))
}

export async function registerSecurityHooks(app: FastifyInstance) {
  app.addHook('onRequest', async (request, reply) => {
    setSecurityHeaders(reply)

    if (!MUTATING_METHODS.has(request.method)) return
    const origin = request.headers.origin
    if (!origin) return
    if (isAllowedOrigin(request, origin)) return

    reply.code(403).send({ error: '跨站请求已被拒绝' })
  })
}

interface RateLimitEntry {
  count: number
  resetAt: number
}

const rateLimitBuckets = new Map<string, RateLimitEntry>()

export function checkAuthRateLimit(request: FastifyRequest, username?: string) {
  const now = Date.now()
  const rawIp = request.ip || request.headers['x-forwarded-for'] || 'unknown'
  const ip = Array.isArray(rawIp) ? rawIp[0] : String(rawIp).split(',')[0]?.trim() || 'unknown'
  const normalizedUser = username?.trim().toLowerCase() || '-'
  const key = `${ip}:${normalizedUser}`
  const current = rateLimitBuckets.get(key)

  if (!current || current.resetAt <= now) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + config.authRateLimitWindowMs })
    return null
  }

  current.count += 1
  if (current.count <= config.authRateLimitMax) return null

  const retryAfterSeconds = Math.max(1, Math.ceil((current.resetAt - now) / 1000))
  return {
    retryAfterSeconds,
    message: `登录尝试过于频繁，请 ${retryAfterSeconds} 秒后再试`,
  }
}
