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

interface ServerSnapshot {
  settings: AppSettings | null
  settingsRevision: number
  tasks: TaskRecord[]
  images: StoredImage[]
  thumbnails: StoredImageThumbnail[]
  agentConversations: AgentConversation[]
  serverTime: number
}

interface SyncPayload {
  settings: AppSettings
  tasks: TaskRecord[]
  images: StoredImage[]
  thumbnails: StoredImageThumbnail[]
  agentConversations: AgentConversation[]
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
  return [...ids]
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

async function createLocalPayload(): Promise<SyncPayload> {
  const state = useStore.getState()
  const tasks = state.tasks
  const storedAgentConversations = await getAllAgentConversations()
  const agentConversations = mergeAgentConversationsForSync(state.agentConversations, storedAgentConversations)
  const imageIds = collectReferencedImageIds(tasks, agentConversations)
  const images: StoredImage[] = []
  const thumbnails: StoredImageThumbnail[] = []

  for (const id of imageIds) {
    const image = await getImage(id)
    if (image) images.push(image)
    const thumbnail = await getStoredImageThumbnail(id)
    if (thumbnail) thumbnails.push(thumbnail)
  }

  return {
    settings: state.settings,
    tasks,
    images,
    thumbnails,
    agentConversations,
  }
}

async function applySnapshot(snapshot: ServerSnapshot) {
  const state = useStore.getState()

  for (const task of snapshot.tasks) await putTask(task)
  for (const image of snapshot.images) await putImage(image)
  for (const thumbnail of snapshot.thumbnails) await putImageThumbnail(thumbnail)

  state.setSettings(snapshot.settings ? normalizeSettings(snapshot.settings) : normalizeSettings(DEFAULT_SETTINGS))
  state.setTasks(snapshot.tasks)
  useStore.setState({
    agentConversations: snapshot.agentConversations,
    activeAgentConversationId: snapshot.agentConversations[0]?.id ?? null,
    agentConversationsLoaded: true,
    prompt: '',
    inputImages: [],
    maskDraft: null,
    galleryInputDraft: null,
    agentInputDrafts: {},
  })
}

export async function loadServerSnapshot() {
  const snapshot = await serverApi<ServerSnapshot>('/api/sync/snapshot')
  await applySnapshot(snapshot)
  return snapshotHasData(snapshot)
}

export async function syncLocalDataToServer() {
  const payload = await createLocalPayload()
  const snapshot = await serverApi<ServerSnapshot>('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  await applySnapshot(snapshot)
  return snapshot
}

export async function saveServerSettings(settings: AppSettings) {
  await serverApi('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ settings }),
  })
}

export async function bootstrapServerData() {
  const snapshot = await serverApi<ServerSnapshot>('/api/sync/snapshot')
  await applySnapshot(snapshot)
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

  const payload: Partial<SyncPayload> = {}
  if (options.importConfig && data.settings) payload.settings = data.settings
  if (options.importTasks) {
    payload.tasks = data.tasks ?? []
    payload.images = images
    payload.thumbnails = thumbnails
    payload.agentConversations = data.agentConversations ?? []
  }

  const snapshot = await serverApi<ServerSnapshot>('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  await applySnapshot(snapshot)
  return snapshot
}
