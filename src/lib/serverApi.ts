import type { AgentConversation, AppSettings, TaskParams, TaskRecord } from '../types'

export interface AuthUser {
  id: string
  username: string
}

async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  let response: Response
  try {
    response = await fetch(url, {
      ...init,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const error = new Error(`网络请求失败：${message}`) as Error & { networkError?: boolean }
    error.networkError = true
    throw error
  }

  if (!response.ok) {
    let bodyText = ''
    try {
      bodyText = await response.text()
    } catch {
      bodyText = '(响应体读取失败)'
    }

    let message = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`
    try {
      const payload = JSON.parse(bodyText)
      const errorText = typeof payload.error === 'string' ? payload.error : null
      const detailText = typeof payload.detail === 'string' ? payload.detail : null
      message = [message, errorText, detailText && detailText !== errorText ? detailText : null]
        .filter(Boolean)
        .join('\n')
    } catch {
      // Ignore parse failures and fall back to status line.
    }

    const error = new Error(message) as Error & { status?: number }
    error.status = response.status
    throw error
  }

  return response.json() as Promise<T>
}

export function getServerConfig() {
  return requestJson<{ enableRegistration: boolean }>('/api/config')
}

export function getMe() {
  return requestJson<{ user: AuthUser | null }>('/api/me')
}

export function login(username: string, password: string) {
  return requestJson<{ user: AuthUser }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
}

export function register(username: string, password: string) {
  return requestJson<{ user: AuthUser }>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
}

export function logout() {
  return requestJson<{ ok: true }>('/api/auth/logout', { method: 'POST' })
}

export function getUserSettings() {
  return requestJson<{ settings: AppSettings; params: TaskParams }>('/api/settings')
}

export function saveUserSettings(settings: AppSettings, params: TaskParams) {
  return requestJson<{ settings: AppSettings; params: TaskParams }>('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ settings, params }),
  })
}

export function listServerTasks() {
  return requestJson<{ tasks: TaskRecord[] }>('/api/tasks')
}

export function getServerTask(id: string, options: { poll?: boolean } = {}) {
  const suffix = options.poll ? '?poll=1' : ''
  return requestJson<{ task: TaskRecord }>(`/api/tasks/${encodeURIComponent(id)}${suffix}`)
}

export function saveServerTask(task: TaskRecord) {
  return requestJson<{ task: TaskRecord }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify(task),
  })
}

export function patchServerTask(id: string, patch: Partial<TaskRecord>) {
  return requestJson<{ task: TaskRecord }>(`/api/tasks/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export function deleteServerTask(id: string) {
  return requestJson<{ ok: true }>(`/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function deleteServerTasks(ids: string[]) {
  return requestJson<{ ok: true }>('/api/tasks/delete', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  })
}

export function clearServerTasks() {
  return requestJson<{ ok: true }>('/api/tasks', { method: 'DELETE' })
}

export function uploadServerImage(dataUrl: string, source: 'upload' | 'generated' | 'mask' = 'upload') {
  return requestJson<{ image: { id: string; url: string; createdAt: number; source: string } }>('/api/images', {
    method: 'POST',
    body: JSON.stringify({ dataUrl, source }),
  })
}

export function generateServerTask(taskId: string, settings: AppSettings) {
  return requestJson<{ task: TaskRecord }>('/api/generate', {
    method: 'POST',
    body: JSON.stringify({ taskId, settings }),
  })
}

export function listServerAgentConversations() {
  return requestJson<{ conversations: AgentConversation[] }>('/api/agent/conversations')
}

export function replaceServerAgentConversations(conversations: AgentConversation[]) {
  return requestJson<{ conversations: AgentConversation[] }>('/api/agent/conversations', {
    method: 'PUT',
    body: JSON.stringify({ conversations }),
  })
}

export function getImageUrl(id: string) {
  return `/api/images/${encodeURIComponent(id)}`
}
