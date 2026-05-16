import { DEFAULT_PARAMS } from '../../src/types'
import type { AppSettings, TaskParams } from '../../src/types'
import { normalizeSettings } from '../../src/lib/apiProfiles'
import { db, type UserSettingsRow } from '../db/client'

const DEFAULT_SETTINGS: AppSettings = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-image-2',
  timeout: 600,
  apiMode: 'images',
  codexCli: false,
  apiProxy: false,
  customProviders: [],
  providerOrder: undefined,
  clearInputAfterSubmit: false,
  enableSwipeSelection: true,
  persistInputOnRestart: true,
  reuseTaskApiProfileTemporarily: false,
  alwaysShowRetryButton: false,
  enableGlassEffects: true,
  enterSubmit: false,
  activeProfileId: 'default-openai',
  profiles: [{
    id: 'default-openai',
    name: '默认',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-image-2',
    timeout: 600,
    apiMode: 'images',
    codexCli: false,
    apiProxy: false,
    useServerSideRequests: true,
  }],
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function normalizeUserSettings(settings: unknown): AppSettings {
  return normalizeSettings({
    ...DEFAULT_SETTINGS,
    ...(settings && typeof settings === 'object' ? settings : {}),
  })
}

export function getUserSettings(userId: string): { settings: AppSettings; params: TaskParams } {
  const row = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId) as UserSettingsRow | undefined
  if (!row) return { settings: normalizeUserSettings(DEFAULT_SETTINGS), params: { ...DEFAULT_PARAMS } }

  return {
    settings: normalizeUserSettings(parseJson(row.settings_json, DEFAULT_SETTINGS)),
    params: { ...DEFAULT_PARAMS, ...parseJson(row.params_json, DEFAULT_PARAMS) },
  }
}

export function upsertUserSettings(userId: string, settings: AppSettings, params: TaskParams) {
  const now = Date.now()
  const normalizedSettings = normalizeUserSettings(settings)
  const payload = {
    user_id: userId,
    settings_json: JSON.stringify(normalizedSettings),
    params_json: JSON.stringify({ ...DEFAULT_PARAMS, ...params }),
    created_at: now,
    updated_at: now,
  }

  db.prepare(`
    INSERT INTO user_settings (user_id, settings_json, params_json, created_at, updated_at)
    VALUES (@user_id, @settings_json, @params_json, @created_at, @updated_at)
    ON CONFLICT(user_id) DO UPDATE SET
      settings_json = excluded.settings_json,
      params_json = excluded.params_json,
      updated_at = excluded.updated_at
  `).run(payload)

  return getUserSettings(userId)
}
