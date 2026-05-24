import { config } from './config.js'
import { db, jsonColumn } from './db.js'

const REGISTRATION_KEY = 'allowRegistration'
const SAVED_API_KEY_PLACEHOLDER = '__SERVER_SAVED_API_KEY__'

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

export function getRawUserSettings(userId: string) {
  const row = db.prepare('SELECT settings_json, revision, updated_at FROM user_settings WHERE user_id = ?').get(userId) as {
    settings_json: string
    revision: number
    updated_at: number
  } | undefined
  return row ? { settings: jsonColumn<Record<string, unknown>>(row.settings_json, {}), revision: row.revision, updatedAt: row.updated_at } : null
}

export function getUserSettings(userId: string) {
  const row = getRawUserSettings(userId)
  return row ? { ...row, settings: redactApiKeys(row.settings) } : null
}

export function upsertUserSettings(userId: string, settings: unknown) {
  const now = Date.now()
  const existing = getRawUserSettings(userId)
  const mergedSettings = preserveExistingApiKeys(settings, existing?.settings ?? null)
  const revision = (existing?.revision ?? 0) + 1
  db.prepare(`
    INSERT INTO user_settings (user_id, settings_json, revision, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      settings_json = excluded.settings_json,
      revision = excluded.revision,
      updated_at = excluded.updated_at
  `).run(userId, JSON.stringify(mergedSettings), revision, now)
  return { settings: redactApiKeys(mergedSettings as Record<string, unknown>), revision, updatedAt: now }
}
