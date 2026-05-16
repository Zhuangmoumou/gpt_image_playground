import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { config } from '../config'

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true })
fs.mkdirSync(config.imagesDir, { recursive: true })

export const db = new Database(config.dbPath)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

function hasColumn(tableName: string, columnName: string) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>
  return columns.some((column) => column.name === columnName)
}

function ensureColumn(tableName: string, columnName: string, definition: string) {
  if (hasColumn(tableName, columnName)) return
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`)
}

export function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      prompt TEXT NOT NULL,
      params_json TEXT NOT NULL,
      api_provider TEXT,
      api_profile_id TEXT,
      api_profile_name TEXT,
      api_model TEXT,
      server_side_request INTEGER NOT NULL DEFAULT 0,
      fal_request_id TEXT,
      fal_endpoint TEXT,
      fal_recoverable INTEGER NOT NULL DEFAULT 0,
      custom_task_id TEXT,
      custom_recoverable INTEGER NOT NULL DEFAULT 0,
      actual_params_json TEXT,
      actual_params_by_image_json TEXT,
      revised_prompt_by_image_json TEXT,
      raw_image_urls_json TEXT,
      raw_response_payload TEXT,
      status TEXT NOT NULL,
      error TEXT,
      created_at INTEGER NOT NULL,
      finished_at INTEGER,
      elapsed_ms INTEGER,
      is_favorite INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_user_created ON tasks(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS images (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sha256 TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      ext TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      storage_path TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(user_id, sha256)
    );

    CREATE TABLE IF NOT EXISTS task_images (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      image_id TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      position INTEGER NOT NULL,
      PRIMARY KEY(task_id, role, position)
    );

    CREATE INDEX IF NOT EXISTS idx_task_images_image ON task_images(image_id);

    CREATE TABLE IF NOT EXISTS user_settings (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      settings_json TEXT NOT NULL,
      params_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)

  ensureColumn('tasks', 'api_profile_id', 'TEXT')
  ensureColumn('tasks', 'server_side_request', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn('tasks', 'custom_task_id', 'TEXT')
  ensureColumn('tasks', 'custom_recoverable', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn('tasks', 'raw_image_urls_json', 'TEXT')
  ensureColumn('tasks', 'raw_response_payload', 'TEXT')
}

migrate()

export interface UserRow {
  id: string
  username: string
  password_hash: string
  created_at: number
  updated_at: number
}

export interface SessionRow {
  id: string
  user_id: string
  expires_at: number
  created_at: number
  last_seen_at: number
}

export interface TaskRow {
  id: string
  user_id: string
  prompt: string
  params_json: string
  api_provider: string | null
  api_profile_id: string | null
  api_profile_name: string | null
  api_model: string | null
  server_side_request: number
  fal_request_id: string | null
  fal_endpoint: string | null
  fal_recoverable: number
  custom_task_id: string | null
  custom_recoverable: number
  actual_params_json: string | null
  actual_params_by_image_json: string | null
  revised_prompt_by_image_json: string | null
  raw_image_urls_json: string | null
  raw_response_payload: string | null
  status: string
  error: string | null
  created_at: number
  finished_at: number | null
  elapsed_ms: number | null
  is_favorite: number
  updated_at: number
}

export interface ImageRow {
  id: string
  user_id: string
  sha256: string
  mime_type: string
  ext: string
  size_bytes: number
  storage_path: string
  source: string
  created_at: number
}

export interface UserSettingsRow {
  user_id: string
  settings_json: string
  params_json: string
  created_at: number
  updated_at: number
}
