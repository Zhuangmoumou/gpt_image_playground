import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { config } from './config.js'

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

export interface StoredDataUrlFile {
  sha256: string
  mimeType: string
  storagePath: string
  byteLength: number
}

export function parseDataUrl(dataUrl: string) {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl)
  if (!match) throw Object.assign(new Error('图片数据格式不正确'), { statusCode: 400 })

  const mimeType = match[1].toLowerCase()
  if (!mimeType.startsWith('image/')) throw Object.assign(new Error('仅允许图片 Data URL'), { statusCode: 400 })

  const buffer = Buffer.from(match[2], 'base64')
  const maxBytes = config.maxUploadMb * 1024 * 1024
  if (buffer.length > maxBytes) throw Object.assign(new Error('图片超过上传大小限制'), { statusCode: 413 })

  return { mimeType, buffer }
}

export function saveDataUrl(dataUrl: string, kind = 'images'): StoredDataUrlFile {
  const { mimeType, buffer } = parseDataUrl(dataUrl)
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  const ext = MIME_EXT[mimeType] ?? 'bin'
  const relativePath = join(kind, sha256.slice(0, 2), `${sha256}.${ext}`)
  const absolutePath = join(config.storageDir, relativePath)

  mkdirSync(dirname(absolutePath), { recursive: true })
  writeFileSync(absolutePath, buffer, { flag: 'wx' })

  return { sha256, mimeType, storagePath: relativePath, byteLength: buffer.length }
}

export function saveDataUrlIfMissing(dataUrl: string, kind = 'images'): StoredDataUrlFile {
  const { mimeType, buffer } = parseDataUrl(dataUrl)
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  const ext = MIME_EXT[mimeType] ?? 'bin'
  const relativePath = join(kind, sha256.slice(0, 2), `${sha256}.${ext}`)
  const absolutePath = join(config.storageDir, relativePath)

  mkdirSync(dirname(absolutePath), { recursive: true })
  try {
    writeFileSync(absolutePath, buffer, { flag: 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }

  return { sha256, mimeType, storagePath: relativePath, byteLength: buffer.length }
}

export function readStorageDataUrl(storagePath: string, mimeType: string) {
  const buffer = readFileSync(join(config.storageDir, storagePath))
  return `data:${mimeType};base64,${buffer.toString('base64')}`
}

export function readStorageBuffer(storagePath: string) {
  return readFileSync(join(config.storageDir, storagePath))
}
