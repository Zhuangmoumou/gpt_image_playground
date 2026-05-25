export interface ServerApiOptions extends RequestInit {
  skipAuthRedirect?: boolean
}

function readCookie(name: string) {
  if (typeof document === 'undefined') return undefined
  const prefix = `${name}=`
  return document.cookie
    .split(';')
    .map((item) => item.trim())
    .find((item) => item.startsWith(prefix))
    ?.slice(prefix.length)
}

async function fetchServerApi(path: string, options: ServerApiOptions) {
  const headers = new Headers(options.headers)
  const hasBody = options.body != null
  if (hasBody && !headers.has('Content-Type') && typeof options.body === 'string') {
    headers.set('Content-Type', 'application/json')
  }

  const method = (options.method ?? 'GET').toUpperCase()
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const csrfToken = readCookie('gip_csrf')
    if (csrfToken) headers.set('x-csrf-token', decodeURIComponent(csrfToken))
  }

  return fetch(path, {
    ...options,
    headers,
    credentials: 'same-origin',
  })
}

export async function serverApi<T>(path: string, options: ServerApiOptions = {}): Promise<T> {
  let response = await fetchServerApi(path, options)

  const method = (options.method ?? 'GET').toUpperCase()
  if (response.status === 403 && !options.skipAuthRedirect && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    await fetchServerApi('/api/auth/me', { skipAuthRedirect: true })
    response = await fetchServerApi(path, options)
  }

  const contentType = response.headers.get('Content-Type') ?? ''
  const payload = contentType.includes('application/json') ? await response.json().catch(() => null) : await response.text()

  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload
      ? String((payload as { error: unknown }).error)
      : `请求失败：${response.status}`
    const error = Object.assign(new Error(message), { status: response.status, payload })
    if (payload && typeof payload === 'object' && 'rawResponsePayload' in payload) {
      ;(error as Error & { rawResponsePayload?: string }).rawResponsePayload = String((payload as { rawResponsePayload: unknown }).rawResponsePayload ?? '')
    }
    throw error
  }

  return payload as T
}
