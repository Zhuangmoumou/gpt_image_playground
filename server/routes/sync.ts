import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireAuth } from '../auth.js'
import { db, jsonColumn } from '../db.js'
import { getUserSettings, upsertUserSettings } from '../settings.js'
import { readStorageDataUrl, saveDataUrlIfMissing } from '../storage.js'

const storedImageSchema = z.object({
  id: z.string().min(1),
  dataUrl: z.string().startsWith('data:image/'),
  createdAt: z.number().optional(),
  source: z.enum(['upload', 'generated', 'mask']).optional(),
  width: z.number().optional(),
  height: z.number().optional(),
}).passthrough()

const thumbnailSchema = z.object({
  id: z.string().min(1),
  thumbnailDataUrl: z.string().startsWith('data:image/'),
  width: z.number().optional(),
  height: z.number().optional(),
  thumbnailVersion: z.number().optional(),
}).passthrough()

const syncPayloadSchema = z.object({
  settings: z.unknown().optional(),
  settingsUpdatedAt: z.number().optional(),
  tasks: z.array(z.record(z.string(), z.unknown())).optional(),
  images: z.array(storedImageSchema).optional(),
  thumbnails: z.array(thumbnailSchema).optional(),
  agentConversations: z.array(z.record(z.string(), z.unknown()).and(z.object({ id: z.string().min(1) }))).optional(),
})

const syncPullSchema = z.object({
  settings: z.boolean().optional(),
  tasks: z.array(z.string()).default([]),
  images: z.array(z.string()).default([]),
  thumbnails: z.array(z.string()).default([]),
  agentConversations: z.array(z.string()).default([]),
})

type SyncPayload = z.infer<typeof syncPayloadSchema>

interface SettingsRow {
  revision: number
  updated_at: number
}

interface TaskRow {
  task_json: string
  updated_at: number
}

interface ManifestTaskRow {
  id: string
  updated_at: number
}

interface ImageRow {
  id: string
  storage_path: string
  mime_type: string
  width: number | null
  height: number | null
  source: 'upload' | 'generated' | 'mask'
  created_at: number
}

interface ManifestImageRow {
  id: string
  updated_at: number
}

interface ThumbnailRow {
  image_id: string
  storage_path: string
  width: number | null
  height: number | null
  thumbnail_version: number
}

interface ManifestThumbnailRow {
  image_id: string
  updated_at: number
}

interface ConversationRow {
  conversation_json: string
}

interface ManifestConversationRow {
  id: string
  updated_at: number
}

function getTaskUpdatedAt(task: Record<string, unknown>, fallback = Date.now()) {
  for (const key of ['updatedAt', 'finishedAt', 'createdAt']) {
    const value = task[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return fallback
}

function ids(values: string[] | undefined) {
  return Array.from(new Set((values ?? []).filter(Boolean)))
}

function placeholders(values: string[]) {
  return values.map(() => '?').join(', ')
}

function upsertTask(userId: string, task: Record<string, unknown>) {
  const id = String(task.id || '')
  if (!id) return
  const now = Date.now()
  const updatedAt = getTaskUpdatedAt(task, now)
  const createdAt = typeof task.createdAt === 'number' ? task.createdAt : updatedAt
  const status = typeof task.status === 'string' ? task.status : 'done'
  const existing = db.prepare('SELECT revision, updated_at FROM tasks WHERE user_id = ? AND id = ?').get(userId, id) as { revision: number; updated_at: number } | undefined
  if (existing && existing.updated_at > updatedAt) return

  db.prepare(`
    INSERT INTO tasks (id, user_id, task_json, status, revision, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, id) DO UPDATE SET
      task_json = excluded.task_json,
      status = excluded.status,
      revision = excluded.revision,
      updated_at = excluded.updated_at,
      deleted_at = NULL
  `).run(id, userId, JSON.stringify({ ...task, updatedAt }), status, (existing?.revision ?? 0) + 1, createdAt, updatedAt)
}

function upsertImage(userId: string, image: z.infer<typeof storedImageSchema>) {
  const now = Date.now()
  const updatedAt = image.createdAt ?? now
  const existing = db.prepare('SELECT updated_at FROM images WHERE user_id = ? AND id = ?').get(userId, image.id) as { updated_at: number } | undefined
  if (existing && existing.updated_at > updatedAt) return

  const saved = saveDataUrlIfMissing(image.dataUrl, 'images')
  const createdAt = image.createdAt ?? now
  db.prepare(`
    INSERT INTO images (id, user_id, sha256, storage_path, mime_type, width, height, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, id) DO UPDATE SET
      sha256 = excluded.sha256,
      storage_path = excluded.storage_path,
      mime_type = excluded.mime_type,
      width = excluded.width,
      height = excluded.height,
      source = excluded.source,
      updated_at = excluded.updated_at,
      deleted_at = NULL
  `).run(image.id, userId, saved.sha256, saved.storagePath, saved.mimeType, image.width ?? null, image.height ?? null, image.source ?? 'upload', createdAt, updatedAt)
}

function upsertThumbnail(userId: string, thumbnail: z.infer<typeof thumbnailSchema>) {
  const imageExists = db.prepare('SELECT id FROM images WHERE user_id = ? AND id = ?').get(userId, thumbnail.id)
  if (!imageExists) return

  const now = Date.now()
  const existing = db.prepare('SELECT updated_at FROM thumbnails WHERE user_id = ? AND image_id = ?').get(userId, thumbnail.id) as { updated_at: number } | undefined
  const updatedAt = existing?.updated_at ?? now
  if (existing && existing.updated_at > updatedAt) return

  const saved = saveDataUrlIfMissing(thumbnail.thumbnailDataUrl, 'thumbnails')
  db.prepare(`
    INSERT INTO thumbnails (image_id, user_id, storage_path, width, height, thumbnail_version, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, image_id) DO UPDATE SET
      storage_path = excluded.storage_path,
      width = excluded.width,
      height = excluded.height,
      thumbnail_version = excluded.thumbnail_version,
      updated_at = excluded.updated_at
  `).run(thumbnail.id, userId, saved.storagePath, thumbnail.width ?? null, thumbnail.height ?? null, thumbnail.thumbnailVersion ?? 1, updatedAt)
}

function upsertConversation(userId: string, conversation: Record<string, unknown> & { id: string }) {
  const now = Date.now()
  const createdAt = typeof conversation.createdAt === 'number' ? conversation.createdAt : now
  const updatedAt = typeof conversation.updatedAt === 'number' ? conversation.updatedAt : now
  const existing = db.prepare('SELECT revision, updated_at FROM agent_conversations WHERE user_id = ? AND id = ?').get(userId, conversation.id) as { revision: number; updated_at: number } | undefined
  if (existing && existing.updated_at > updatedAt) return

  db.prepare(`
    INSERT INTO agent_conversations (id, user_id, conversation_json, revision, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, id) DO UPDATE SET
      conversation_json = excluded.conversation_json,
      revision = excluded.revision,
      updated_at = excluded.updated_at,
      deleted_at = NULL
  `).run(conversation.id, userId, JSON.stringify(conversation), (existing?.revision ?? 0) + 1, createdAt, updatedAt)
}

function applySyncPayload(userId: string, payload: SyncPayload) {
  db.transaction(() => {
    if (payload.settings !== undefined) {
      const existing = db.prepare('SELECT updated_at FROM user_settings WHERE user_id = ?').get(userId) as { updated_at: number } | undefined
      const updatedAt = payload.settingsUpdatedAt ?? Date.now()
      if (!existing || existing.updated_at <= updatedAt) upsertUserSettings(userId, payload.settings)
    }
    for (const image of payload.images ?? []) upsertImage(userId, image)
    for (const thumbnail of payload.thumbnails ?? []) upsertThumbnail(userId, thumbnail)
    for (const task of payload.tasks ?? []) upsertTask(userId, task)
    for (const conversation of payload.agentConversations ?? []) upsertConversation(userId, conversation)
  })()
}

function getSyncManifest(userId: string) {
  const settings = db.prepare('SELECT revision, updated_at FROM user_settings WHERE user_id = ?').get(userId) as SettingsRow | undefined
  const tasks = (db.prepare('SELECT id, updated_at FROM tasks WHERE user_id = ? AND deleted_at IS NULL').all(userId) as ManifestTaskRow[])
    .map((row) => ({ id: row.id, updatedAt: row.updated_at }))
  const images = (db.prepare('SELECT id, updated_at FROM images WHERE user_id = ? AND deleted_at IS NULL').all(userId) as ManifestImageRow[])
    .map((row) => ({ id: row.id, updatedAt: row.updated_at }))
  const thumbnails = (db.prepare('SELECT image_id, updated_at FROM thumbnails WHERE user_id = ?').all(userId) as ManifestThumbnailRow[])
    .map((row) => ({ id: row.image_id, updatedAt: row.updated_at }))
  const agentConversations = (db.prepare('SELECT id, updated_at FROM agent_conversations WHERE user_id = ? AND deleted_at IS NULL').all(userId) as ManifestConversationRow[])
    .map((row) => ({ id: row.id, updatedAt: row.updated_at }))

  return {
    settings: settings ? { revision: settings.revision, updatedAt: settings.updated_at } : null,
    tasks,
    images,
    thumbnails,
    agentConversations,
    serverTime: Date.now(),
  }
}

function getTasks(userId: string, taskIds?: string[]) {
  const selectedIds = ids(taskIds)
  if (taskIds && selectedIds.length === 0) return []
  const query = selectedIds.length
    ? `SELECT task_json, updated_at FROM tasks WHERE user_id = ? AND deleted_at IS NULL AND id IN (${placeholders(selectedIds)}) ORDER BY created_at DESC`
    : 'SELECT task_json, updated_at FROM tasks WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC'
  return (db.prepare(query).all(userId, ...selectedIds) as TaskRow[])
    .map((row) => {
      const task = jsonColumn<Record<string, unknown>>(row.task_json, {})
      return typeof task.updatedAt === 'number' ? task : { ...task, updatedAt: row.updated_at }
    })
}

function getImages(userId: string, imageIds?: string[]) {
  const selectedIds = ids(imageIds)
  if (imageIds && selectedIds.length === 0) return []
  const query = selectedIds.length
    ? `SELECT id, storage_path, mime_type, width, height, source, created_at FROM images WHERE user_id = ? AND deleted_at IS NULL AND id IN (${placeholders(selectedIds)}) ORDER BY created_at DESC`
    : 'SELECT id, storage_path, mime_type, width, height, source, created_at FROM images WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC'
  return (db.prepare(query).all(userId, ...selectedIds) as ImageRow[])
    .map((row) => ({
      id: row.id,
      dataUrl: readStorageDataUrl(row.storage_path, row.mime_type),
      createdAt: row.created_at,
      source: row.source,
      width: row.width ?? undefined,
      height: row.height ?? undefined,
    }))
}

function getThumbnails(userId: string, thumbnailIds?: string[]) {
  const selectedIds = ids(thumbnailIds)
  if (thumbnailIds && selectedIds.length === 0) return []
  const query = selectedIds.length
    ? `SELECT image_id, storage_path, width, height, thumbnail_version FROM thumbnails WHERE user_id = ? AND image_id IN (${placeholders(selectedIds)})`
    : 'SELECT image_id, storage_path, width, height, thumbnail_version FROM thumbnails WHERE user_id = ?'
  return (db.prepare(query).all(userId, ...selectedIds) as ThumbnailRow[])
    .map((row) => ({
      id: row.image_id,
      thumbnailDataUrl: readStorageDataUrl(row.storage_path, 'image/webp'),
      width: row.width ?? undefined,
      height: row.height ?? undefined,
      thumbnailVersion: row.thumbnail_version,
    }))
}

function getAgentConversations(userId: string, conversationIds?: string[]) {
  const selectedIds = ids(conversationIds)
  if (conversationIds && selectedIds.length === 0) return []
  const query = selectedIds.length
    ? `SELECT conversation_json FROM agent_conversations WHERE user_id = ? AND deleted_at IS NULL AND id IN (${placeholders(selectedIds)}) ORDER BY updated_at DESC`
    : 'SELECT conversation_json FROM agent_conversations WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC'
  return (db.prepare(query).all(userId, ...selectedIds) as ConversationRow[])
    .map((row) => jsonColumn<Record<string, unknown>>(row.conversation_json, {}))
}

function getSnapshot(userId: string) {
  const settings = getUserSettings(userId)
  return {
    settings: settings?.settings ?? null,
    settingsRevision: settings?.revision ?? 0,
    settingsUpdatedAt: settings?.updatedAt ?? 0,
    tasks: getTasks(userId),
    images: getImages(userId),
    thumbnails: getThumbnails(userId),
    agentConversations: getAgentConversations(userId),
    serverTime: Date.now(),
  }
}

function getPartialSnapshot(userId: string, pull: z.infer<typeof syncPullSchema>) {
  const settings = pull.settings ? getUserSettings(userId) : null
  return {
    settings: settings?.settings ?? null,
    settingsRevision: settings?.revision ?? 0,
    settingsUpdatedAt: settings?.updatedAt ?? 0,
    tasks: getTasks(userId, pull.tasks),
    images: getImages(userId, pull.images),
    thumbnails: getThumbnails(userId, pull.thumbnails),
    agentConversations: getAgentConversations(userId, pull.agentConversations),
    serverTime: Date.now(),
  }
}

export async function registerSyncRoutes(app: FastifyInstance) {
  app.get('/api/sync/manifest', async (request, reply) => {
    const auth = await requireAuth(request, reply)
    return getSyncManifest(auth.user.id)
  })

  app.get('/api/sync/snapshot', async (request, reply) => {
    const auth = await requireAuth(request, reply)
    return getSnapshot(auth.user.id)
  })

  app.post('/api/sync/pull', async (request, reply) => {
    const auth = await requireAuth(request, reply)
    const pull = syncPullSchema.parse(request.body)
    return getPartialSnapshot(auth.user.id, pull)
  })

  app.post('/api/sync/import-local', async (request, reply) => {
    const auth = await requireAuth(request, reply)
    const payload = syncPayloadSchema.parse(request.body)
    applySyncPayload(auth.user.id, payload)
    return getSyncManifest(auth.user.id)
  })

  app.post('/api/sync/push', async (request, reply) => {
    const auth = await requireAuth(request, reply)
    const payload = syncPayloadSchema.parse(request.body)
    applySyncPayload(auth.user.id, payload)
    return getSyncManifest(auth.user.id)
  })
}
