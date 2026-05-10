import type { ApiProfile, AppSettings, TaskParams } from '../../src/types'
import type { CallApiOptions, CallApiResult } from '../../src/lib/imageApiShared'
import { callFalAiImageApi } from '../../src/lib/falAiImageApi'
import { callOpenAICompatibleImageApi } from './openaiCompatibleImageApi'
import { isIP } from 'node:net'
import { config } from '../config'

function getActiveApiProfile(settings: AppSettings): ApiProfile {
  const profile = settings.profiles.find((item) => item.id === settings.activeProfileId) ?? settings.profiles[0]
  if (!profile) throw new Error('缺少 API 配置')
  return profile
}

function isPrivateIPv4(hostname: string) {
  const parts = hostname.split('.').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b] = parts
  return a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    a === 0
}

function isPrivateHostname(hostname: string) {
  const normalized = hostname.toLowerCase()
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true
  if (isIP(normalized) === 4) return isPrivateIPv4(normalized)
  if (isIP(normalized) === 6) {
    return normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe80:')
  }
  return false
}

function assertSafeApiBaseUrl(profile: ApiProfile) {
  if (profile.provider === 'fal') return
  let url: URL
  try {
    url = new URL(profile.baseUrl)
  } catch {
    throw new Error('API Base URL 无效')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('API Base URL 仅支持 HTTP/HTTPS')
  if (!config.allowPrivateApiBaseUrls && isPrivateHostname(url.hostname)) {
    throw new Error('生产环境已拒绝访问本机或内网 API Base URL')
  }
}

export async function callServerImageApi(opts: {
  settings: AppSettings
  prompt: string
  params: TaskParams
  inputImageDataUrls: string[]
  maskDataUrl?: string
  onFalRequestEnqueued?: CallApiOptions['onFalRequestEnqueued']
}): Promise<CallApiResult> {
  const profile = getActiveApiProfile(opts.settings)
  if (!profile.apiKey.trim()) throw new Error('缺少 API Key')
  assertSafeApiBaseUrl(profile)
  if (profile.provider === 'fal') return callFalAiImageApi(opts, profile)
  return callOpenAICompatibleImageApi(opts, profile)
}
