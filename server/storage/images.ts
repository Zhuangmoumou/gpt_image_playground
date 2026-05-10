import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { db, type ImageRow } from '../db/client'
import { config, maxUploadBytes } from '../config'

type ImageSource = 'upload' | 'generated' | 'mask'

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

function parseDataUrl(dataUrl: string) {
  const match = dataUrl.match(/^data:([^;,]+);base64,(.*)$/s)
  if (!match) throw new Error('无效的图片数据')
  const mimeType = match[1]
  if (!MIME_EXT[mimeType]) throw new Error('仅支持 PNG、JPEG 和 WebP 图片')
  const base64 = match[2].replace(/\s/g, '')
  if (!base64 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw new Error('无效的图片编码')
  }
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.length > maxUploadBytes) throw new Error(`图片过大，最大支持 ${config.maxUploadMb} MB`)
  if (!matchesDeclaredImageType(mimeType, bytes)) throw new Error('图片内容与声明类型不一致')
  return { mimeType, bytes }
}

function matchesDeclaredImageType(mimeType: string, bytes: Buffer) {
  if (mimeType === 'image/png') {
    return bytes.length > 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
  }
  if (mimeType === 'image/jpeg') {
    return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  }
  if (mimeType === 'image/webp') {
    return bytes.length > 12 &&
      bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  }
  return false
}

function createStoragePath(userId: string, imageId: string, sha256: string, ext: string) {
  return path.join(config.imagesDir, userId, sha256.slice(0, 2), `${imageId}.${ext}`)
}

export function fileToDataUrl(row: ImageRow) {
  const bytes = fs.readFileSync(row.storage_path)
  return `data:${row.mime_type};base64,${bytes.toString('base64')}`
}

export function saveImageDataUrl(userId: string, dataUrl: string, source: ImageSource = 'upload') {
  const { mimeType, bytes } = parseDataUrl(dataUrl)
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
  const existing = db.prepare('SELECT * FROM images WHERE user_id = ? AND sha256 = ?').get(userId, sha256) as ImageRow | undefined
  if (existing) return existing

  const id = crypto.randomUUID()
  const ext = MIME_EXT[mimeType]
  const storagePath = createStoragePath(userId, id, sha256, ext)
  fs.mkdirSync(path.dirname(storagePath), { recursive: true })
  fs.writeFileSync(storagePath, bytes)

  const row = {
    id,
    user_id: userId,
    sha256,
    mime_type: mimeType,
    ext,
    size_bytes: bytes.length,
    storage_path: storagePath,
    source,
    created_at: Date.now(),
  }
  db.prepare(`
    INSERT INTO images (id, user_id, sha256, mime_type, ext, size_bytes, storage_path, source, created_at)
    VALUES (@id, @user_id, @sha256, @mime_type, @ext, @size_bytes, @storage_path, @source, @created_at)
  `).run(row)
  return row
}

export function getImageForUser(userId: string, imageId: string) {
  return db.prepare('SELECT * FROM images WHERE id = ? AND user_id = ?').get(imageId, userId) as ImageRow | undefined
}

export function deleteUnreferencedImages(userId: string, imageIds: string[]) {
  const uniqueIds = [...new Set(imageIds)]
  for (const imageId of uniqueIds) {
    const count = db.prepare(`
      SELECT COUNT(*) AS count
      FROM task_images
      JOIN tasks ON tasks.id = task_images.task_id
      WHERE task_images.image_id = ? AND tasks.user_id = ?
    `).get(imageId, userId) as { count: number }
    if (count.count > 0) continue

    const image = getImageForUser(userId, imageId)
    if (!image) continue
    db.prepare('DELETE FROM images WHERE id = ? AND user_id = ?').run(imageId, userId)
    try {
      fs.unlinkSync(image.storage_path)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }
}

export function imageUrl(imageId: string) {
  return `/api/images/${encodeURIComponent(imageId)}`
}
