import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate'
import type { AgentConversation, AppSettings, ExportData, StoredImage, StoredImageThumbnail, TaskRecord } from '../types'
import { useStore } from '../store'
import { DEFAULT_SETTINGS, normalizeSettings } from './apiProfiles'
import {
  deleteAgentConversation,
  deleteImage,
  deleteTask,
  getAllImageThumbnails,
  getAllAgentConversations,
  getImage,
  getStoredImageThumbnail,
  putImage,
  putImageThumbnail,
  putAgentConversation,
  putTask,
} from './db'
import { serverApi } from './serverApi'

const LOCAL_SETTINGS_UPDATED_AT_KEY = 'gpt-image-playground.settings-updated-at'
const SAVED_API_KEY_PLACEHOLDER = '__SERVER_SAVED_API_KEY__'
const AUTO_SYNC_DELAY_MS = 1500
const THUMBNAIL_PULL_BATCH_SIZE = 24

let autoSyncTimer: number | null = null
let autoSyncRunning: Promise<void> | null = null
let autoSyncQueued = false
let remoteApplyDepth = 0

interface ServerManifestItem {
  id: string
  updatedAt: number
  deletedAt?: number
  thumbnailVersion?: number
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
  images: StoredImage[]
  thumbnails: StoredImageThumbnail[]
  taskUpdatedAt: Map<string, number>
  conversationUpdatedAt: Map<string, number>
  imageUpdatedAt: Map<string, number>
  imageDeletedAt: Map<string, number>
  thumbnailUpdatedAt: Map<string, number>
  thumbnailVersion: Map<string, number>
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

export function writeLocalSettingsUpdatedAt(updatedAt: number) {
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

function getImageUpdatedAt(image: StoredImage) {
  return image.updatedAt ?? image.createdAt ?? 0
}

function getThumbnailUpdatedAt(thumbnail: StoredImageThumbnail) {
  return thumbnail.updatedAt ?? 0
}

function getManifestMap(items: ServerManifestItem[]) {
  return new Map(items.map((item) => [item.id, item] as const))
}

function getEntityVersion(updatedAt: number, deletedAt?: number | null) {
  return Math.max(updatedAt, deletedAt ?? 0)
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

function bytesToDataUrlWithMime(bytes: Uint8Array, mimeType: string): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return `data:${mimeType};base64,${btoa(binary)}`
}

function parseNumberHeader(value: string | null) {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

async function fetchThumbnailBinary(id: string): Promise<StoredImageThumbnail> {
  const response = await fetch(`/api/sync/thumbnails/${encodeURIComponent(id)}`, {
    credentials: 'same-origin',
    cache: 'no-store',
  })

  if (!response.ok) {
    let message = `请求失败：${response.status}`
    const contentType = response.headers.get('Content-Type') ?? ''
    if (contentType.includes('application/json')) {
      const payload = await response.json().catch(() => null) as { error?: unknown } | null
      if (payload?.error) message = String(payload.error)
    }
    throw new Error(message)
  }

  const mimeType = response.headers.get('Content-Type') || 'image/webp'
  const bytes = new Uint8Array(await response.arrayBuffer())
  return {
    id,
    thumbnailDataUrl: bytesToDataUrlWithMime(bytes, mimeType),
    width: parseNumberHeader(response.headers.get('X-Thumbnail-Width')),
    height: parseNumberHeader(response.headers.get('X-Thumbnail-Height')),
    thumbnailVersion: parseNumberHeader(response.headers.get('X-Thumbnail-Version')),
    updatedAt: parseNumberHeader(response.headers.get('X-Thumbnail-Updated-At')),
    deletedAt: null,
    syncState: 'synced',
  }
}

function beginRemoteApply() {
  remoteApplyDepth += 1
}

function endRemoteApply() {
  remoteApplyDepth = Math.max(0, remoteApplyDepth - 1)
}

function isRemoteApplyActive() {
  return remoteApplyDepth > 0
}

function setRecordSyncStatusText(text: string | null) {
  useStore.getState().setRecordSyncStatusText(text)
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

function preserveLocalApiKeys(local: AppSettings, incoming: AppSettings) {
  const localProfiles = new Map(local.profiles.map((profile) => [profile.id, profile]))
  return normalizeSettings({
    ...incoming,
    apiKey: incoming.apiKey === SAVED_API_KEY_PLACEHOLDER ? local.apiKey : incoming.apiKey,
    profiles: incoming.profiles.map((profile) => {
      const localProfile = localProfiles.get(profile.id)
      return {
        ...profile,
        apiKey: profile.apiKey === SAVED_API_KEY_PLACEHOLDER ? (localProfile?.apiKey ?? '') : profile.apiKey,
      }
    }),
  })
}

function getRecordOnlyPull(changes: ReturnType<typeof getSyncChanges>) {
  return {
    settings: changes.pull.settings,
    tasks: changes.pull.tasks,
    images: [] as string[],
    thumbnails: [] as string[],
    agentConversations: changes.pull.agentConversations,
  }
}

function getThumbnailOnlyPull(changes: ReturnType<typeof getSyncChanges>) {
  return {
    settings: false,
    tasks: [] as string[],
    images: [] as string[],
    thumbnails: changes.pull.thumbnails,
    agentConversations: [] as string[],
  }
}

async function collectLocalSyncState(): Promise<LocalSyncState> {
  const state = useStore.getState()
  const tasks = state.tasks.map((task) => ({ ...task, updatedAt: getTaskUpdatedAt(task) }))
  const storedAgentConversations = await getAllAgentConversations()
  const agentConversations = mergeAgentConversationsForSync(state.agentConversations, storedAgentConversations)
  const imageIds = collectReferencedImageIds(tasks.filter((task) => !task.deletedAt), agentConversations.filter((conversation) => !conversation.deletedAt))
  const allStoredThumbnails = (await getAllImageThumbnails()).map((thumbnail) => ({ ...thumbnail, updatedAt: getThumbnailUpdatedAt(thumbnail) }))
  const thumbnailIds = new Set<string>(allStoredThumbnails.map((thumbnail) => thumbnail.id))
  const images: StoredImage[] = []
  const thumbnails: StoredImageThumbnail[] = [...allStoredThumbnails]

  for (const id of imageIds) {
    const image = await getImage(id)
    if (image) images.push({ ...image, updatedAt: getImageUpdatedAt(image) })
    if (thumbnailIds.has(id)) continue
    const thumbnail = await getStoredImageThumbnail(id)
    if (!thumbnail) continue
    const nextThumbnail = { ...thumbnail, updatedAt: getThumbnailUpdatedAt(thumbnail) }
    thumbnailIds.add(id)
    thumbnails.push(nextThumbnail)
  }

  return {
    settings: state.settings,
    settingsUpdatedAt: ensureLocalSettingsUpdatedAt(state.settings),
    tasks,
    agentConversations,
    images,
    thumbnails,
    taskUpdatedAt: new Map(tasks.map((task) => [task.id, getTaskUpdatedAt(task)] as const)),
    conversationUpdatedAt: new Map(agentConversations.map((conversation) => [conversation.id, conversation.updatedAt] as const)),
    imageUpdatedAt: new Map(images.map((image) => [image.id, getImageUpdatedAt(image)] as const)),
    imageDeletedAt: new Map(images.filter((image) => typeof image.deletedAt === 'number').map((image) => [image.id, image.deletedAt!] as const)),
    thumbnailUpdatedAt: new Map(thumbnails.map((thumbnail) => [thumbnail.id, getThumbnailUpdatedAt(thumbnail)] as const)),
    thumbnailVersion: new Map(thumbnails.map((thumbnail) => [thumbnail.id, thumbnail.thumbnailVersion ?? 0] as const)),
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
    const ids = new Set(changes.imageIds)
    payload.images = local.images.filter((image) => ids.has(image.id))
  }
  if (changes.thumbnailIds?.length) {
    const ids = new Set(changes.thumbnailIds)
    payload.thumbnails = local.thumbnails.filter((thumbnail) => ids.has(thumbnail.id))
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
    .filter((task) => task.syncState !== 'pending_delete_confirm')
    .filter((task) => getEntityVersion(local.taskUpdatedAt.get(task.id) ?? 0, task.deletedAt) > getEntityVersion(serverTasks.get(task.id)?.updatedAt ?? 0, serverTasks.get(task.id)?.deletedAt))
    .map((task) => task.id)
  const pushImageIds = local.images
    .filter((image) => image.syncState !== 'pending_delete_confirm')
    .filter((image) => getEntityVersion(local.imageUpdatedAt.get(image.id) ?? 0, image.deletedAt) > getEntityVersion(serverImages.get(image.id)?.updatedAt ?? 0, serverImages.get(image.id)?.deletedAt))
    .map((image) => image.id)
  const pushThumbnailIds = local.thumbnails
    .filter((thumbnail) => getEntityVersion(local.thumbnailUpdatedAt.get(thumbnail.id) ?? 0, thumbnail.deletedAt) > getEntityVersion(serverThumbnails.get(thumbnail.id)?.updatedAt ?? 0, serverThumbnails.get(thumbnail.id)?.deletedAt))
    .filter((thumbnail) => (thumbnail.thumbnailVersion ?? 0) >= (serverThumbnails.get(thumbnail.id)?.thumbnailVersion ?? 0))
    .map((thumbnail) => thumbnail.id)
  const pushAgentConversationIds = local.agentConversations
    .filter((conversation) => conversation.syncState !== 'pending_delete_confirm')
    .filter((conversation) => getEntityVersion(local.conversationUpdatedAt.get(conversation.id) ?? 0, conversation.deletedAt) > getEntityVersion(serverConversations.get(conversation.id)?.updatedAt ?? 0, serverConversations.get(conversation.id)?.deletedAt))
    .map((conversation) => conversation.id)

  const pullTaskIds = manifest.tasks
    .filter((task) => !task.deletedAt)
    .filter((task) => getEntityVersion(task.updatedAt, task.deletedAt) > getEntityVersion(local.taskUpdatedAt.get(task.id) ?? 0, local.tasks.find((item) => item.id === task.id)?.deletedAt))
    .map((task) => task.id)
  const pullImageIds: string[] = []
  const pullThumbnailIds = manifest.thumbnails
    .filter((thumbnail) => {
      const localVersion = getEntityVersion(local.thumbnailUpdatedAt.get(thumbnail.id) ?? 0)
      const serverVersion = getEntityVersion(thumbnail.updatedAt, thumbnail.deletedAt)
      if (serverVersion > localVersion) return true
      return (thumbnail.thumbnailVersion ?? 0) > (local.thumbnailVersion.get(thumbnail.id) ?? 0)
    })
    .map((thumbnail) => thumbnail.id)
  const pullAgentConversationIds = manifest.agentConversations
    .filter((conversation) => !conversation.deletedAt)
    .filter((conversation) => getEntityVersion(conversation.updatedAt, conversation.deletedAt) > getEntityVersion(local.conversationUpdatedAt.get(conversation.id) ?? 0, local.agentConversations.find((item) => item.id === conversation.id)?.deletedAt))
    .map((conversation) => conversation.id)

  const deleteTaskIds = manifest.tasks
    .filter((task) => task.deletedAt && getEntityVersion(task.updatedAt, task.deletedAt) > getEntityVersion(local.taskUpdatedAt.get(task.id) ?? 0, local.tasks.find((item) => item.id === task.id)?.deletedAt))
    .map((task) => task.id)
  const deleteImageIds = manifest.images
    .filter((image) => image.deletedAt && getEntityVersion(image.updatedAt, image.deletedAt) > getEntityVersion(local.imageUpdatedAt.get(image.id) ?? 0, local.imageDeletedAt.get(image.id)))
    .map((image) => image.id)
  const deleteAgentConversationIds = manifest.agentConversations
    .filter((conversation) => conversation.deletedAt && getEntityVersion(conversation.updatedAt, conversation.deletedAt) > getEntityVersion(local.conversationUpdatedAt.get(conversation.id) ?? 0, local.agentConversations.find((item) => item.id === conversation.id)?.deletedAt))
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
    deletions: {
      tasks: deleteTaskIds,
      images: deleteImageIds,
      agentConversations: deleteAgentConversationIds,
    },
  }
}

async function applyManifestDeletions(changes: ReturnType<typeof getSyncChanges>) {
  const deletionTasks = new Set(changes.deletions.tasks)
  const deletionImages = new Set(changes.deletions.images)
  const deletionConversations = new Set(changes.deletions.agentConversations)
  if (!deletionTasks.size && !deletionImages.size && !deletionConversations.size) return

  beginRemoteApply()
  try {
    for (const id of deletionTasks) await deleteTask(id)
    for (const id of deletionImages) await deleteImage(id)
    for (const id of deletionConversations) await deleteAgentConversation(id)

    useStore.setState((state) => ({
      tasks: state.tasks.filter((task) => !deletionTasks.has(task.id)),
      agentConversations: state.agentConversations.filter((conversation) => !deletionConversations.has(conversation.id)),
      activeAgentConversationId: state.activeAgentConversationId && deletionConversations.has(state.activeAgentConversationId)
        ? null
        : state.activeAgentConversationId,
    }))
  } finally {
    endRemoteApply()
  }
}

async function applyPartialSnapshot(snapshot: ServerSnapshot) {
  const state = useStore.getState()

  beginRemoteApply()
  try {
    for (const task of snapshot.tasks) await putTask({ ...task, deletedAt: null, syncState: 'synced' })
    for (const image of snapshot.images) await putImage({ ...image, deletedAt: null, syncState: 'synced' })
    for (const thumbnail of snapshot.thumbnails) await putImageThumbnail({ ...thumbnail, deletedAt: null, syncState: 'synced' })

    if (snapshot.settings) {
      state.setSettings(preserveLocalApiKeys(useStore.getState().settings, normalizeSettings(snapshot.settings)))
      if (snapshot.settingsUpdatedAt) writeLocalSettingsUpdatedAt(snapshot.settingsUpdatedAt)
    }

  if (snapshot.tasks.length) {
    const byId = new Map(state.tasks.map((task) => [task.id, task] as const))
    for (const task of snapshot.tasks) {
      const nextTask = { ...task, deletedAt: null, syncState: 'synced' as const }
      const existing = byId.get(task.id)
      if (!existing || getTaskUpdatedAt(nextTask) >= getTaskUpdatedAt(existing)) byId.set(task.id, nextTask)
    }
    state.setTasks([...byId.values()].sort((a, b) => b.createdAt - a.createdAt))
  }

    if (snapshot.agentConversations.length) {
      const current = useStore.getState().agentConversations
      const byId = new Map(current.map((conversation) => [conversation.id, conversation] as const))
      for (const conversation of snapshot.agentConversations) {
        const nextConversation = { ...conversation, deletedAt: null, syncState: 'synced' as const }
        const existing = byId.get(conversation.id)
        if (!existing || nextConversation.updatedAt >= existing.updatedAt) byId.set(conversation.id, nextConversation)
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
  } finally {
    endRemoteApply()
  }
}

export async function loadServerSnapshot() {
  const snapshot = await serverApi<ServerSnapshot>('/api/sync/snapshot')
  await applyPartialSnapshot(snapshot)
  return snapshotHasData(snapshot)
}

export async function pushLocalDataToServer() {
  const manifest = await serverApi<ServerManifest>('/api/sync/manifest')
  const local = await collectLocalSyncState()
  const changes = getSyncChanges(local, manifest)
  const payload = await createLocalPayload(local, changes.push)

  if (!hasPayloadData(payload)) {
    return { pushed: payload, changes: changes.push }
  }

  const pushedManifest = await serverApi<ServerManifest>('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  if (payload.settings && pushedManifest.settings?.updatedAt) writeLocalSettingsUpdatedAt(pushedManifest.settings.updatedAt)

  if (payload.tasks?.length) {
    const deletedTaskIds = new Set(payload.tasks.filter((task) => task.deletedAt).map((task) => task.id))
    const syncedTasks = new Map(payload.tasks.filter((task) => !task.deletedAt).map((task) => [task.id, { ...task, syncState: 'synced' as const }]))
    useStore.getState().setTasks(useStore.getState().tasks
      .filter((task) => !deletedTaskIds.has(task.id))
      .map((task) => syncedTasks.get(task.id) ?? task))
    await Promise.all([
      ...[...syncedTasks.values()].map((task) => putTask(task)),
      ...[...deletedTaskIds].map((id) => deleteTask(id)),
    ])
  }
  if (payload.agentConversations?.length) {
    const deletedConversationIds = new Set(payload.agentConversations.filter((conversation) => conversation.deletedAt).map((conversation) => conversation.id))
    const syncedConversations = new Map(payload.agentConversations.filter((conversation) => !conversation.deletedAt).map((conversation) => [conversation.id, { ...conversation, syncState: 'synced' as const }]))
    useStore.setState((state) => ({
      agentConversations: state.agentConversations
        .filter((conversation) => !deletedConversationIds.has(conversation.id))
        .map((conversation) => syncedConversations.get(conversation.id) ?? conversation),
      activeAgentConversationId: state.activeAgentConversationId && deletedConversationIds.has(state.activeAgentConversationId)
        ? null
        : state.activeAgentConversationId,
    }))
    await Promise.all([
      ...[...syncedConversations.values()].map((conversation) => putAgentConversation(conversation)),
      ...[...deletedConversationIds].map((id) => deleteAgentConversation(id)),
    ])
  }
  if (payload.images?.length) {
    await Promise.all(payload.images.map((image) => image.deletedAt ? deleteImage(image.id) : putImage({ ...image, syncState: 'synced' })))
  }
  if (payload.thumbnails?.length) {
    await Promise.all(payload.thumbnails.map((thumbnail) => thumbnail.deletedAt ? Promise.resolve(undefined) : putImageThumbnail({ ...thumbnail, syncState: 'synced' })))
  }

  return { pushed: payload, changes: changes.push }
}

export async function pullServerDataToLocal() {
  setRecordSyncStatusText('同步记录中…')
  try {
    const manifest = await serverApi<ServerManifest>('/api/sync/manifest')
    const local = await collectLocalSyncState()
    const changes = getSyncChanges(local, manifest)
    await applyManifestDeletions(changes)
    const recordPull = getRecordOnlyPull(changes)
    const totalRecords = recordPull.tasks.length + recordPull.agentConversations.length + Number(recordPull.settings)
    const hasRecordPull = recordPull.settings || recordPull.tasks.length || recordPull.agentConversations.length
    if (hasRecordPull) {
      setRecordSyncStatusText(totalRecords > 0 ? `同步记录中（${totalRecords} 项）…` : '同步记录中…')
      const snapshot = await serverApi<ServerSnapshot>('/api/sync/pull', {
        method: 'POST',
        body: JSON.stringify(recordPull),
      })
      await applyPartialSnapshot(snapshot)
    }

    const thumbnailPull = getThumbnailOnlyPull(changes)
    if (thumbnailPull.thumbnails.length > 0) {
      void pullSpecificThumbnailsToLocal(thumbnailPull.thumbnails)
    }
    return { pulled: changes.pull, deletions: changes.deletions }
  } finally {
    setRecordSyncStatusText(null)
  }
}

export async function syncLocalDataToServer() {
  const pushResult = await pushLocalDataToServer()
  const pullResult = await pullServerDataToLocal()
  return { pushed: pushResult.pushed, pulled: pullResult.pulled, deletions: pullResult.deletions }
}

export function scheduleAutoSync(_reason = 'change') {
  if (typeof window === 'undefined' || isRemoteApplyActive()) return
  if (autoSyncTimer != null) window.clearTimeout(autoSyncTimer)
  autoSyncTimer = window.setTimeout(() => {
    autoSyncTimer = null
    void flushAutoSync()
  }, AUTO_SYNC_DELAY_MS)
}

export async function flushAutoSync() {
  if (typeof window === 'undefined' || isRemoteApplyActive()) return
  if (autoSyncRunning) {
    autoSyncQueued = true
    return autoSyncRunning
  }
  autoSyncRunning = (async () => {
    try {
      await pushLocalDataToServer()
    } catch (err) {
      useStore.getState().showToast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      autoSyncRunning = null
      if (autoSyncQueued) {
        autoSyncQueued = false
        scheduleAutoSync('queued')
      }
    }
  })()
  return autoSyncRunning
}

export async function pullSpecificThumbnailsToLocal(imageIds: string[]) {
  const ids = Array.from(new Set(imageIds.filter(Boolean)))
  if (ids.length === 0) return
  for (let index = 0; index < ids.length; index += THUMBNAIL_PULL_BATCH_SIZE) {
    const batch = ids.slice(index, index + THUMBNAIL_PULL_BATCH_SIZE)
    const thumbnails = await Promise.all(batch.map((id) => fetchThumbnailBinary(id)))
    for (const thumbnail of thumbnails) await putImageThumbnail(thumbnail)
  }
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
  setRecordSyncStatusText('同步记录中…')
  try {
    const manifest = await serverApi<ServerManifest>('/api/sync/manifest')
    const local = await collectLocalSyncState()
    const changes = getSyncChanges(local, manifest)
    await applyManifestDeletions(changes)
    const recordPull = getRecordOnlyPull(changes)
    const hasRecordPull = recordPull.settings || recordPull.tasks.length || recordPull.agentConversations.length
    if (!hasRecordPull) {
      const thumbnailPull = getThumbnailOnlyPull(changes)
      if (thumbnailPull.thumbnails.length > 0) void pullSpecificThumbnailsToLocal(thumbnailPull.thumbnails)
      return snapshotHasData({
        settings: manifest.settings ? local.settings : null,
        settingsRevision: manifest.settings?.revision ?? 0,
        tasks: manifest.tasks.some((task) => !task.deletedAt) ? local.tasks : [],
        images: [],
        thumbnails: manifest.thumbnails.length ? local.thumbnails : [],
        agentConversations: manifest.agentConversations.some((conversation) => !conversation.deletedAt) ? local.agentConversations : [],
        serverTime: manifest.serverTime,
      }) ? 'pulled' as const : 'empty' as const
    }

    const totalRecords = recordPull.tasks.length + recordPull.agentConversations.length + Number(recordPull.settings)
    setRecordSyncStatusText(totalRecords > 0 ? `同步记录中（${totalRecords} 项）…` : '同步记录中…')
    const snapshot = await serverApi<ServerSnapshot>('/api/sync/pull', {
      method: 'POST',
      body: JSON.stringify(recordPull),
    })
    await applyPartialSnapshot(snapshot)

    const thumbnailPull = getThumbnailOnlyPull(changes)
    if (thumbnailPull.thumbnails.length > 0) void pullSpecificThumbnailsToLocal(thumbnailPull.thumbnails)
    return snapshotHasData(snapshot) ? 'pulled' as const : 'empty' as const
  } finally {
    setRecordSyncStatusText(null)
  }
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
