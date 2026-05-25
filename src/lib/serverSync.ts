import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate'
import type { AgentConversation, AppSettings, ExportData, StoredImage, StoredImageThumbnail, TaskRecord } from '../types'
import { useStore } from '../store'
import { DEFAULT_SETTINGS, normalizeSettings } from './apiProfiles'
import {
  getAllAgentConversations,
  getImage,
  getStoredImageThumbnail,
  putImage,
  putImageThumbnail,
  putTask,
} from './db'
import { serverApi } from './serverApi'

const LOCAL_SETTINGS_UPDATED_AT_KEY = 'gpt-image-playground.settings-updated-at'

interface ServerManifestItem {
  id: string
  updatedAt: number
}

interface ServerManifest {
  settings: { revision: number; updatedAt: number } | null
  tasks: ServerManifestItem[]
  images: ServerManifestItem[]
  thumbnails: ServerManifestItem[]
  agentConversations: ServerManifestItem[]
  serverTime: number
}

interface ServerSnapshot {
  settings: AppSettings | null
  settingsRevision: number
  settingsUpdatedAt?: number
  tasks: TaskRecord[]
  images: StoredImage[]
  thumbnails: StoredImageThumbnail[]
  agentConversations: AgentConversation[]
  serverTime: number
}

interface SyncPayload {
  settings?: AppSettings
  settingsUpdatedAt?: number
  tasks?: TaskRecord[]
  images?: StoredImage[]
  thumbnails?: StoredImageThumbnail[]
  agentConversations?: AgentConversation[]
}

interface LocalSyncState {
  settings: AppSettings
  settingsUpdatedAt: number
  tasks: TaskRecord[]
  agentConversations: AgentConversation[]
  taskUpdatedAt: Map<string, number>
  conversationUpdatedAt: Map<string, number>
  imageIds: Set<string>
  thumbnailIds: Set<string>
}

function snapshotHasData(snapshot: ServerSnapshot) {
  return Boolean(
    snapshot.settings ||
    snapshot.tasks.length ||
    snapshot.images.length ||
    snapshot.thumbnails.length ||
    snapshot.agentConversations.length,
  )
}

function readLocalSettingsUpdatedAt() {
  if (typeof window === 'undefined') return 0
  const value = Number(window.localStorage.getItem(LOCAL_SETTINGS_UPDATED_AT_KEY) || 0)
  return Number.isFinite(value) ? value : 0
}

function writeLocalSettingsUpdatedAt(updatedAt: number) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(LOCAL_SETTINGS_UPDATED_AT_KEY, String(updatedAt))
}

function hasMeaningfulSettings(settings: AppSettings) {
  return Boolean(
    settings.apiKey.trim() ||
    settings.customProviders.length ||
    settings.profiles.some((profile) => profile.apiKey.trim() || profile.baseUrl !== DEFAULT_SETTINGS.baseUrl || profile.model !== DEFAULT_SETTINGS.model),
  )
}

function ensureLocalSettingsUpdatedAt(settings: AppSettings) {
  const saved = readLocalSettingsUpdatedAt()
  if (saved > 0) return saved
  if (!hasMeaningfulSettings(settings)) return 0
  const updatedAt = Date.now()
  writeLocalSettingsUpdatedAt(updatedAt)
  return updatedAt
}

function getTaskUpdatedAt(task: TaskRecord) {
  return task.updatedAt ?? task.finishedAt ?? task.createdAt
}

function getManifestMap(items: ServerManifestItem[]) {
  return new Map(items.map((item) => [item.id, item.updatedAt] as const))
}

function dataUrlToBytes(dataUrl: string): { ext: string; bytes: Uint8Array } {
  const match = dataUrl.match(/^data:([^;,]+);base64,(.*)$/)
  if (!match) throw new Error('图片数据格式不正确')
  const mime = match[1]
  const ext = mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1] || 'bin'
  const binary = atob(match[2])
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return { ext, bytes }
}

function bytesToDataUrl(bytes: Uint8Array, path: string): string {
  const ext = path.split('.').pop()?.toLowerCase()
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/png'
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return `data:${mime};base64,${btoa(binary)}`
}

function collectReferencedImageIds(tasks: TaskRecord[], agentConversations: AgentConversation[]) {
  const ids = new Set<string>()
  for (const task of tasks) {
    for (const id of task.inputImageIds ?? []) ids.add(id)
    for (const id of task.outputImages ?? []) ids.add(id)
    for (const id of task.streamPartialImageIds ?? []) ids.add(id)
    if (task.maskImageId) ids.add(task.maskImageId)
    if (task.maskTargetImageId) ids.add(task.maskTargetImageId)
  }
  for (const conversation of agentConversations) {
    for (const message of conversation.messages) {
      for (const id of message.inputImageIds ?? []) ids.add(id)
    }
    for (const round of conversation.rounds) {
      for (const id of round.inputImageIds ?? []) ids.add(id)
      for (const id of round.outputTaskIds ?? []) {
        const task = tasks.find((item) => item.id === id)
        for (const imageId of task?.outputImages ?? []) ids.add(imageId)
      }
      if (round.maskImageId) ids.add(round.maskImageId)
      if (round.maskTargetImageId) ids.add(round.maskTargetImageId)
    }
  }
  return ids
}

function mergeAgentConversationsForSync(current: AgentConversation[], stored: AgentConversation[]) {
  const byId = new Map<string, AgentConversation>()
  for (const conversation of stored) byId.set(conversation.id, conversation)
  for (const conversation of current) {
    const existing = byId.get(conversation.id)
    if (!existing || conversation.updatedAt >= existing.updatedAt) byId.set(conversation.id, conversation)
  }
  return [...byId.values()]
}

async function collectLocalSyncState(): Promise<LocalSyncState> {
  const state = useStore.getState()
  const tasks = state.tasks.map((task) => task.updatedAt ? task : { ...task, updatedAt: getTaskUpdatedAt(task) })
  const storedAgentConversations = await getAllAgentConversations()
  const agentConversations = mergeAgentConversationsForSync(state.agentConversations, storedAgentConversations)
  const imageIds = collectReferencedImageIds(tasks, agentConversations)
  const thumbnailIds = new Set<string>()

  for (const id of imageIds) {
    if (await getStoredImageThumbnail(id)) thumbnailIds.add(id)
  }

  return {
    settings: state.settings,
    settingsUpdatedAt: ensureLocalSettingsUpdatedAt(state.settings),
    tasks,
    agentConversations,
    taskUpdatedAt: new Map(tasks.map((task) => [task.id, getTaskUpdatedAt(task)] as const)),
    conversationUpdatedAt: new Map(agentConversations.map((conversation) => [conversation.id, conversation.updatedAt] as const)),
    imageIds,
    thumbnailIds,
  }
}

async function createLocalPayload(local: LocalSyncState, changes: {
  settings?: boolean
  taskIds?: string[]
  imageIds?: string[]
  thumbnailIds?: string[]
  agentConversationIds?: string[]
}): Promise<SyncPayload> {
  const payload: SyncPayload = {}
  if (changes.settings) {
    payload.settings = local.settings
    payload.settingsUpdatedAt = local.settingsUpdatedAt
  }
  if (changes.taskIds?.length) {
    const ids = new Set(changes.taskIds)
    payload.tasks = local.tasks.filter((task) => ids.has(task.id))
  }
  if (changes.agentConversationIds?.length) {
    const ids = new Set(changes.agentConversationIds)
    payload.agentConversations = local.agentConversations.filter((conversation) => ids.has(conversation.id))
  }
  if (changes.imageIds?.length) {
    const images: StoredImage[] = []
    for (const id of changes.imageIds) {
      const image = await getImage(id)
      if (image) images.push(image)
    }
    payload.images = images
  }
  if (changes.thumbnailIds?.length) {
    const thumbnails: StoredImageThumbnail[] = []
    for (const id of changes.thumbnailIds) {
      const thumbnail = await getStoredImageThumbnail(id)
      if (thumbnail) thumbnails.push(thumbnail)
    }
    payload.thumbnails = thumbnails
  }
  return payload
}

function hasPayloadData(payload: SyncPayload) {
  return Boolean(
    payload.settings ||
    payload.tasks?.length ||
    payload.images?.length ||
    payload.thumbnails?.length ||
    payload.agentConversations?.length,
  )
}

function getSyncChanges(local: LocalSyncState, manifest: ServerManifest) {
  const serverTasks = getManifestMap(manifest.tasks)
  const serverImages = getManifestMap(manifest.images)
  const serverThumbnails = getManifestMap(manifest.thumbnails)
  const serverConversations = getManifestMap(manifest.agentConversations)

  const pushTaskIds = local.tasks
    .filter((task) => (local.taskUpdatedAt.get(task.id) ?? 0) > (serverTasks.get(task.id) ?? 0))
    .map((task) => task.id)
  const pushImageIds = [...local.imageIds].filter((id) => !serverImages.has(id))
  const pushThumbnailIds = [...local.thumbnailIds].filter((id) => !serverThumbnails.has(id))
  const pushAgentConversationIds = local.agentConversations
    .filter((conversation) => (local.conversationUpdatedAt.get(conversation.id) ?? 0) > (serverConversations.get(conversation.id) ?? 0))
    .map((conversation) => conversation.id)

  const pullTaskIds = manifest.tasks
    .filter((task) => task.updatedAt > (local.taskUpdatedAt.get(task.id) ?? 0))
    .map((task) => task.id)
  const pullImageIds = manifest.images
    .filter((image) => !local.imageIds.has(image.id))
    .map((image) => image.id)
  const pullThumbnailIds = manifest.thumbnails
    .filter((thumbnail) => !local.thumbnailIds.has(thumbnail.id))
    .map((thumbnail) => thumbnail.id)
  const pullAgentConversationIds = manifest.agentConversations
    .filter((conversation) => conversation.updatedAt > (local.conversationUpdatedAt.get(conversation.id) ?? 0))
    .map((conversation) => conversation.id)

  const serverSettingsUpdatedAt = manifest.settings?.updatedAt ?? 0
  const pushSettings = local.settingsUpdatedAt > serverSettingsUpdatedAt
  const pullSettings = serverSettingsUpdatedAt > local.settingsUpdatedAt

  return {
    push: {
      settings: pushSettings,
      taskIds: pushTaskIds,
      imageIds: pushImageIds,
      thumbnailIds: pushThumbnailIds,
      agentConversationIds: pushAgentConversationIds,
    },
    pull: {
      settings: pullSettings,
      tasks: pullTaskIds,
      images: pullImageIds,
      thumbnails: pullThumbnailIds,
      agentConversations: pullAgentConversationIds,
    },
  }
}

async function applyPartialSnapshot(snapshot: ServerSnapshot) {
  const state = useStore.getState()

  for (const task of snapshot.tasks) await putTask(task)
  for (const image of snapshot.images) await putImage(image)
  for (const thumbnail of snapshot.thumbnails) await putImageThumbnail(thumbnail)

  if (snapshot.settings) {
    state.setSettings(normalizeSettings(snapshot.settings))
    if (snapshot.settingsUpdatedAt) writeLocalSettingsUpdatedAt(snapshot.settingsUpdatedAt)
  }

  if (snapshot.tasks.length) {
    const byId = new Map(state.tasks.map((task) => [task.id, task] as const))
    for (const task of snapshot.tasks) {
      const existing = byId.get(task.id)
      if (!existing || getTaskUpdatedAt(task) >= getTaskUpdatedAt(existing)) byId.set(task.id, task)
    }
    state.setTasks([...byId.values()].sort((a, b) => b.createdAt - a.createdAt))
  }

  if (snapshot.agentConversations.length) {
    const current = useStore.getState().agentConversations
    const byId = new Map(current.map((conversation) => [conversation.id, conversation] as const))
    for (const conversation of snapshot.agentConversations) {
      const existing = byId.get(conversation.id)
      if (!existing || conversation.updatedAt >= existing.updatedAt) byId.set(conversation.id, conversation)
    }
    const agentConversations = [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt)
    useStore.setState((latest) => ({
      agentConversations,
      activeAgentConversationId: latest.activeAgentConversationId && agentConversations.some((conversation) => conversation.id === latest.activeAgentConversationId)
        ? latest.activeAgentConversationId
        : agentConversations[0]?.id ?? null,
      agentConversationsLoaded: true,
    }))
  }
}

export async function loadServerSnapshot() {
  const snapshot = await serverApi<ServerSnapshot>('/api/sync/snapshot')
  await applyPartialSnapshot(snapshot)
  return snapshotHasData(snapshot)
}

export async function syncLocalDataToServer() {
  const manifest = await serverApi<ServerManifest>('/api/sync/manifest')
  const local = await collectLocalSyncState()
  const changes = getSyncChanges(local, manifest)
  const payload = await createLocalPayload(local, changes.push)

  if (hasPayloadData(payload)) {
    const pushedManifest = await serverApi<ServerManifest>('/api/sync/push', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    if (payload.settings && pushedManifest.settings?.updatedAt) writeLocalSettingsUpdatedAt(pushedManifest.settings.updatedAt)
  }

  const hasPull = changes.pull.settings || changes.pull.tasks.length || changes.pull.images.length || changes.pull.thumbnails.length || changes.pull.agentConversations.length
  if (hasPull) {
    const snapshot = await serverApi<ServerSnapshot>('/api/sync/pull', {
      method: 'POST',
      body: JSON.stringify(changes.pull),
    })
    await applyPartialSnapshot(snapshot)
  }

  return { pushed: payload, pulled: changes.pull }
}

export async function saveServerSettings(settings: AppSettings) {
  const settingsUpdatedAt = Date.now()
  writeLocalSettingsUpdatedAt(settingsUpdatedAt)
  const result = await serverApi<{ updatedAt?: number }>('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ settings }),
  })
  if (typeof result.updatedAt === 'number') writeLocalSettingsUpdatedAt(result.updatedAt)
}

export async function bootstrapServerData() {
  const manifest = await serverApi<ServerManifest>('/api/sync/manifest')
  const local = await collectLocalSyncState()
  const changes = getSyncChanges(local, manifest)
  const hasPull = changes.pull.settings || changes.pull.tasks.length || changes.pull.images.length || changes.pull.thumbnails.length || changes.pull.agentConversations.length
  if (!hasPull) return snapshotHasData({
    settings: manifest.settings ? local.settings : null,
    settingsRevision: manifest.settings?.revision ?? 0,
    tasks: manifest.tasks.length ? local.tasks : [],
    images: [],
    thumbnails: [],
    agentConversations: manifest.agentConversations.length ? local.agentConversations : [],
    serverTime: manifest.serverTime,
  }) ? 'pulled' as const : 'empty' as const

  const snapshot = await serverApi<ServerSnapshot>('/api/sync/pull', {
    method: 'POST',
    body: JSON.stringify(changes.pull),
  })
  await applyPartialSnapshot(snapshot)
  return snapshotHasData(snapshot) ? 'pulled' as const : 'empty' as const
}

export async function exportServerData(options: { exportConfig?: boolean; exportTasks?: boolean }) {
  const snapshot = await serverApi<ServerSnapshot>('/api/sync/snapshot')
  const exportedAt = Date.now()
  const imageFiles: ExportData['imageFiles'] = {}
  const thumbnailFiles: NonNullable<ExportData['thumbnailFiles']> = {}
  const zipFiles: Record<string, Uint8Array | [Uint8Array, { mtime: Date }]> = {}

  if (options.exportTasks) {
    for (const image of snapshot.images) {
      const { ext, bytes } = dataUrlToBytes(image.dataUrl)
      const path = `images/${image.id}.${ext}`
      imageFiles[image.id] = {
        path,
        createdAt: image.createdAt,
        source: image.source,
        width: image.width,
        height: image.height,
      }
      zipFiles[path] = [bytes, { mtime: new Date(image.createdAt ?? exportedAt) }]
    }

    for (const thumbnail of snapshot.thumbnails) {
      const { ext, bytes } = dataUrlToBytes(thumbnail.thumbnailDataUrl)
      const path = `thumbnails/${thumbnail.id}.${ext}`
      thumbnailFiles[thumbnail.id] = {
        path,
        width: thumbnail.width,
        height: thumbnail.height,
        thumbnailVersion: thumbnail.thumbnailVersion,
      }
      zipFiles[path] = [bytes, { mtime: new Date(exportedAt) }]
    }
  }

  const manifest: ExportData = {
    version: 3,
    exportedAt: new Date(exportedAt).toISOString(),
  }
  if (options.exportConfig && snapshot.settings) manifest.settings = snapshot.settings
  if (options.exportTasks) {
    manifest.tasks = snapshot.tasks
    manifest.agentConversations = snapshot.agentConversations
    manifest.imageFiles = imageFiles
    manifest.thumbnailFiles = thumbnailFiles
  }

  zipFiles['manifest.json'] = [strToU8(JSON.stringify(manifest, null, 2)), { mtime: new Date(exportedAt) }]
  const zipped = zipSync(zipFiles, { level: 6 })
  const blob = new Blob([zipped.buffer as ArrayBuffer], { type: 'application/zip' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `gpt-image-playground-server-backup_${new Date(exportedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19)}.zip`
  link.click()
  URL.revokeObjectURL(url)
}

export async function importServerData(file: File, options: { importConfig?: boolean; importTasks?: boolean }) {
  const buffer = await file.arrayBuffer()
  const unzipped = unzipSync(new Uint8Array(buffer))
  const manifestBytes = unzipped['manifest.json']
  if (!manifestBytes) throw new Error('ZIP 中缺少 manifest.json')

  const data = JSON.parse(strFromU8(manifestBytes)) as ExportData
  const images: StoredImage[] = []
  const thumbnails: StoredImageThumbnail[] = []

  if (options.importTasks) {
    for (const [id, info] of Object.entries(data.imageFiles ?? {})) {
      const bytes = unzipped[info.path]
      if (!bytes) continue
      images.push({
        id,
        dataUrl: bytesToDataUrl(bytes, info.path),
        createdAt: info.createdAt,
        source: info.source,
        width: info.width,
        height: info.height,
      })
    }

    for (const [id, info] of Object.entries(data.thumbnailFiles ?? {})) {
      const bytes = unzipped[info.path]
      if (!bytes) continue
      thumbnails.push({
        id,
        thumbnailDataUrl: bytesToDataUrl(bytes, info.path),
        width: info.width,
        height: info.height,
        thumbnailVersion: info.thumbnailVersion,
      })
    }
  }

  const payload: SyncPayload = {}
  const snapshot: ServerSnapshot = {
    settings: null,
    settingsRevision: 0,
    settingsUpdatedAt: 0,
    tasks: [],
    images: [],
    thumbnails: [],
    agentConversations: [],
    serverTime: Date.now(),
  }
  if (options.importConfig && data.settings) {
    const settingsUpdatedAt = Date.now()
    payload.settings = data.settings
    payload.settingsUpdatedAt = settingsUpdatedAt
    snapshot.settings = data.settings
    snapshot.settingsUpdatedAt = settingsUpdatedAt
  }
  if (options.importTasks) {
    payload.tasks = data.tasks ?? []
    payload.images = images
    payload.thumbnails = thumbnails
    payload.agentConversations = data.agentConversations ?? []
    snapshot.tasks = payload.tasks
    snapshot.images = images
    snapshot.thumbnails = thumbnails
    snapshot.agentConversations = payload.agentConversations
  }

  await serverApi<ServerManifest>('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  await applyPartialSnapshot(snapshot)
  return snapshot
}
