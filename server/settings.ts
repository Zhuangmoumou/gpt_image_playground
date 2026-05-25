import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { config } from './config.js'
import { db, jsonColumn } from './db.js'

const REGISTRATION_KEY = 'allowRegistration'
const SAVED_API_KEY_PLACEHOLDER = '__SERVER_SAVED_API_KEY__'
const ENCRYPTED_API_KEY_PREFIX = 'gipenc:v1:'
const API_KEY_ENCRYPTION_KEY = Buffer.from(hkdfSync(
  'sha256',
  Buffer.from(config.apiKeyEncryptionSecret),
  Buffer.from('gpt-image-playground'),
  Buffer.from('api-key-encryption'),
  32,
))

export function getAllowRegistration() {
  const row = db.prepare('SELECT value_json FROM system_settings WHERE key = ?').get(REGISTRATION_KEY) as { value_json: string } | undefined
  if (!row) return config.allowRegistration
  return Boolean(jsonColumn(row.value_json, config.allowRegistration))
}

export function setAllowRegistration(value: boolean) {
  db.prepare(`
    INSERT INTO system_settings (key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `).run(REGISTRATION_KEY, JSON.stringify(value), Date.now())
}

function encryptApiKey(apiKey: string) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', API_KEY_ENCRYPTION_KEY, iv)
  const ciphertext = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${ENCRYPTED_API_KEY_PREFIX}${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`
}

function decryptApiKey(apiKey: string) {
  if (!apiKey.startsWith(ENCRYPTED_API_KEY_PREFIX)) return apiKey

  const payload = apiKey.slice(ENCRYPTED_API_KEY_PREFIX.length)
  const [iv, tag, ciphertext] = payload.split('.')
  if (!iv || !tag || !ciphertext) return ''

  try {
    const decipher = createDecipheriv('aes-256-gcm', API_KEY_ENCRYPTION_KEY, Buffer.from(iv, 'base64url'))
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    return ''
  }
}

function encryptApiKeyValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? encryptApiKey(value) : value
}

function decryptApiKeyValue(value: unknown) {
  if (typeof value !== 'string') return { value, wasPlaintext: false }
  if (!value.trim()) return { value, wasPlaintext: false }
  if (value.startsWith(ENCRYPTED_API_KEY_PREFIX)) return { value: decryptApiKey(value), wasPlaintext: false }
  return { value, wasPlaintext: true }
}

function encryptApiKeys(settings: Record<string, unknown>) {
  const next = { ...settings }
  next.apiKey = encryptApiKeyValue(next.apiKey)
  next.profiles = Array.isArray(next.profiles)
    ? next.profiles.map((profile) => {
        if (!profile || typeof profile !== 'object') return profile
        const record = { ...(profile as Record<string, unknown>) }
        record.apiKey = encryptApiKeyValue(record.apiKey)
        return record
      })
    : next.profiles
  return next
}

function decryptApiKeys(settings: Record<string, unknown>) {
  let hasPlaintext = false
  const next = { ...settings }
  const topLevelApiKey = decryptApiKeyValue(next.apiKey)
  next.apiKey = topLevelApiKey.value
  hasPlaintext ||= topLevelApiKey.wasPlaintext
  next.profiles = Array.isArray(next.profiles)
    ? next.profiles.map((profile) => {
        if (!profile || typeof profile !== 'object') return profile
        const record = { ...(profile as Record<string, unknown>) }
        const apiKey = decryptApiKeyValue(record.apiKey)
        record.apiKey = apiKey.value
        hasPlaintext ||= apiKey.wasPlaintext
        return record
      })
    : next.profiles
  return { settings: next, hasPlaintext }
}

function redactApiKeys(settings: Record<string, unknown>) {
  const profiles = Array.isArray(settings.profiles)
    ? settings.profiles.map((profile) => {
        if (!profile || typeof profile !== 'object') return profile
        const record = profile as Record<string, unknown>
        return { ...record, apiKey: record.apiKey ? SAVED_API_KEY_PLACEHOLDER : '' }
      })
    : settings.profiles
  return { ...settings, apiKey: settings.apiKey ? SAVED_API_KEY_PLACEHOLDER : '', profiles }
}

function preserveExistingApiKeys(next: unknown, previous: Record<string, unknown> | null) {
  if (!next || typeof next !== 'object') return next
  if (!previous) return next

  const nextRecord = next as Record<string, unknown>
  const previousProfiles = Array.isArray(previous.profiles) ? previous.profiles as Array<Record<string, unknown>> : []
  const previousById = new Map(previousProfiles.map((profile) => [String(profile.id), profile]))
  const profiles = Array.isArray(nextRecord.profiles)
    ? nextRecord.profiles.map((profile) => {
        if (!profile || typeof profile !== 'object') return profile
        const record = profile as Record<string, unknown>
        if (typeof record.apiKey === 'string' && record.apiKey.trim() && record.apiKey !== SAVED_API_KEY_PLACEHOLDER) return record
        const previousProfile = previousById.get(String(record.id))
        return previousProfile?.apiKey ? { ...record, apiKey: previousProfile.apiKey } : { ...record, apiKey: '' }
      })
    : nextRecord.profiles

  const apiKey = typeof nextRecord.apiKey === 'string' && nextRecord.apiKey.trim() && nextRecord.apiKey !== SAVED_API_KEY_PLACEHOLDER
    ? nextRecord.apiKey
    : previous.apiKey
  return { ...nextRecord, apiKey, profiles }
}

export function migrateUserSettingsApiKeys() {
  const rows = db.prepare('SELECT user_id, settings_json FROM user_settings').all() as Array<{ user_id: string; settings_json: string }>
  const update = db.prepare('UPDATE user_settings SET settings_json = ? WHERE user_id = ?')
  db.transaction(() => {
    for (const row of rows) {
      const parsed = jsonColumn<Record<string, unknown>>(row.settings_json, {})
      const { settings, hasPlaintext } = decryptApiKeys(parsed)
      if (hasPlaintext) update.run(JSON.stringify(encryptApiKeys(settings)), row.user_id)
    }
  })()
}

export function getRawUserSettings(userId: string) {
  const row = db.prepare('SELECT settings_json, revision, updated_at FROM user_settings WHERE user_id = ?').get(userId) as {
    settings_json: string
    revision: number
    updated_at: number
  } | undefined
  if (!row) return null

  const parsed = jsonColumn<Record<string, unknown>>(row.settings_json, {})
  const { settings, hasPlaintext } = decryptApiKeys(parsed)
  if (hasPlaintext) {
    db.prepare('UPDATE user_settings SET settings_json = ? WHERE user_id = ?').run(JSON.stringify(encryptApiKeys(settings)), userId)
  }
  return { settings, revision: row.revision, updatedAt: row.updated_at }
}

export function getUserSettings(userId: string) {
  const row = getRawUserSettings(userId)
  return row ? { ...row, settings: redactApiKeys(row.settings) } : null
}

export function upsertUserSettings(userId: string, settings: unknown) {
  const now = Date.now()
  const existing = getRawUserSettings(userId)
  const mergedSettings = preserveExistingApiKeys(settings, existing?.settings ?? null)
  const encryptedSettings = encryptApiKeys(mergedSettings as Record<string, unknown>)
  const revision = (existing?.revision ?? 0) + 1
  db.prepare(`
    INSERT INTO user_settings (user_id, settings_json, revision, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      settings_json = excluded.settings_json,
      revision = excluded.revision,
      updated_at = excluded.updated_at
  `).run(userId, JSON.stringify(encryptedSettings), revision, now)
  return { settings: redactApiKeys(mergedSettings as Record<string, unknown>), revision, updatedAt: now }
}
