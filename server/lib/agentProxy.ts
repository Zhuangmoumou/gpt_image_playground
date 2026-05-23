import type { ApiProfile, AppSettings } from '../../src/types'
import { config } from '../config'
import { isIP } from 'node:net'

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

function buildResponsesUrl(baseUrl: string) {
  return `${baseUrl.replace(/\/+$/, '')}/responses`
}

export async function proxyAgentResponsesRequest(settings: AppSettings, body: unknown, signal?: AbortSignal) {
  const profile = getActiveApiProfile(settings)
  if (profile.provider !== 'openai' || profile.apiMode !== 'responses') {
    throw new Error('当前配置不支持 Agent Responses 请求')
  }
  if (!profile.apiKey.trim()) throw new Error('缺少 API Key')
  assertSafeApiBaseUrl(profile)

  return fetch(buildResponsesUrl(profile.baseUrl), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${profile.apiKey}`,
      'Content-Type': 'application/json',
    },
    cache: 'no-store',
    body: JSON.stringify(body),
    signal,
  })
}
