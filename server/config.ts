import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function loadEnvFile() {
  const filePath = resolve(process.cwd(), '.env')
  if (!existsSync(filePath)) return

  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const index = trimmed.indexOf('=')
    if (index <= 0) continue

    const key = trimmed.slice(0, index).trim()
    let value = trimmed.slice(index + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    process.env[key] ??= value
  }
}

function readBoolean(name: string, fallback: boolean) {
  const value = process.env[name]
  if (value == null || value === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
}

function readNumber(name: string, fallback: number) {
  const value = Number(process.env[name])
  return Number.isFinite(value) ? value : fallback
}

loadEnvFile()

const dataDir = resolve(process.cwd(), process.env.DATA_DIR || './data')
const sessionSecret = process.env.APP_SECRET || process.env.SESSION_SECRET || ''
const apiKeyEncryptionSecret = process.env.API_KEY_ENCRYPTION_SECRET || sessionSecret

if (sessionSecret.length < 32) {
  throw new Error('APP_SECRET 或 SESSION_SECRET 至少需要 32 个字符')
}

if (apiKeyEncryptionSecret.length < 32) {
  throw new Error('API_KEY_ENCRYPTION_SECRET 至少需要 32 个字符')
}

export const config = {
  host: process.env.HOST || '0.0.0.0',
  port: readNumber('PORT', 8000),
  dataDir,
  databasePath: resolve(process.cwd(), process.env.DATABASE_PATH || process.env.DB_PATH || `${dataDir}/app.sqlite3`),
  storageDir: resolve(process.cwd(), process.env.STORAGE_DIR || process.env.IMAGES_DIR || `${dataDir}/storage`),
  sessionSecret,
  apiKeyEncryptionSecret,
  allowRegistration: readBoolean('ALLOW_REGISTRATION', readBoolean('ENABLE_REGISTRATION', true)),
  sessionTtlDays: readNumber('SESSION_TTL_DAYS', readNumber('SESSION_MAX_AGE_DAYS', 7)),
  maxUploadMb: readNumber('MAX_UPLOAD_MB', 100),
  cookieSecure: readBoolean('COOKIE_SECURE', false),
  allowPrivateApiBaseUrls: readBoolean('ALLOW_PRIVATE_API_BASE_URLS', true),
  nodeEnv: process.env.NODE_ENV || 'development',
}
