import 'dotenv/config'
import path from 'node:path'

function readBoolean(name: string, fallback: boolean) {
  const value = process.env[name]
  if (value == null || value.trim() === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

function readNumber(name: string, fallback: number) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function readStringList(name: string): string[] {
  return (process.env[name] || '')
    .split(',')
    .map((item) => item.trim().replace(/\/+$/, ''))
    .filter(Boolean)
}

const DEFAULT_SESSION_SECRET = 'local-development-session-secret-change-me'
const dataDir = process.env.DATA_DIR || path.resolve(process.cwd(), 'data')
const sessionSecret = process.env.SESSION_SECRET || DEFAULT_SESSION_SECRET

if (process.env.NODE_ENV === 'production' && (sessionSecret === DEFAULT_SESSION_SECRET || sessionSecret.length < 32)) {
  throw new Error('生产环境必须设置长度至少 32 位的 SESSION_SECRET')
}

export const config = {
  host: process.env.HOST || '0.0.0.0',
  port: readNumber('SERVER_PORT', readNumber('PORT', 3000)),
  dataDir,
  dbPath: process.env.DB_PATH || path.join(dataDir, 'app.sqlite3'),
  imagesDir: process.env.IMAGES_DIR || path.join(dataDir, 'images'),
  sessionSecret,
  enableRegistration: readBoolean('ENABLE_REGISTRATION', true),
  maxUploadMb: readNumber('MAX_UPLOAD_MB', 100),
  sessionMaxAgeDays: readNumber('SESSION_MAX_AGE_DAYS', 30),
  exposeErrorDetail: readBoolean('EXPOSE_ERROR_DETAIL', process.env.NODE_ENV !== 'production'),
  appOrigin: (process.env.APP_ORIGIN || '').trim().replace(/\/+$/, ''),
  allowedOrigins: readStringList('ALLOWED_ORIGINS'),
  allowPrivateApiBaseUrls: readBoolean('ALLOW_PRIVATE_API_BASE_URLS', process.env.NODE_ENV !== 'production'),
  authRateLimitWindowMs: readNumber('AUTH_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000),
  authRateLimitMax: readNumber('AUTH_RATE_LIMIT_MAX', 20),
}

export const maxUploadBytes = config.maxUploadMb * 1024 * 1024
