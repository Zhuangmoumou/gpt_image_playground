import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useStore } from '../store'
import { serverApi } from '../lib/serverApi'

export interface AuthUser {
  id: string
  username: string
  role: 'admin' | 'user'
}

export interface AuthSession {
  id: string
  expiresAt: number
}

interface AuthState {
  user: AuthUser | null
  session: AuthSession | null
  allowRegistration: boolean
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  login: (username: string, password: string) => Promise<void>
  register: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
}

interface AuthResponse {
  user: AuthUser
  session: AuthSession
  allowRegistration: boolean
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [session, setSession] = useState<AuthSession | null>(null)
  const [allowRegistration, setAllowRegistration] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const applyAuth = useCallback((payload: AuthResponse) => {
    setUser(payload.user)
    setSession(payload.session)
    setAllowRegistration(payload.allowRegistration)
    setError(null)
  }, [])

  const clearAuth = useCallback(() => {
    setUser(null)
    setSession(null)
    useStore.setState({
      tasks: [],
      agentConversations: [],
      activeAgentConversationId: null,
      prompt: '',
      inputImages: [],
      maskDraft: null,
      galleryInputDraft: null,
      agentInputDrafts: {},
      agentConversationsLoaded: false,
    })
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const payload = await serverApi<AuthResponse>('/api/auth/me', { skipAuthRedirect: true })
      applyAuth(payload)
    } catch (err) {
      clearAuth()
      try {
        const payload = await serverApi<{ allowRegistration: boolean }>('/api/system/registration', { skipAuthRedirect: true })
        setAllowRegistration(payload.allowRegistration)
      } catch {
        setAllowRegistration(true)
      }
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [applyAuth, clearAuth])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const login = useCallback(async (username: string, password: string) => {
    const payload = await serverApi<AuthResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    })
    applyAuth(payload)
  }, [applyAuth])

  const register = useCallback(async (username: string, password: string) => {
    const payload = await serverApi<AuthResponse>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    })
    applyAuth(payload)
  }, [applyAuth])

  const logout = useCallback(async () => {
    try {
      await serverApi('/api/auth/logout', { method: 'POST' })
    } finally {
      clearAuth()
      await refresh()
    }
  }, [clearAuth, refresh])

  const value = useMemo<AuthState>(() => ({
    user,
    session,
    allowRegistration,
    loading,
    error,
    refresh,
    login,
    register,
    logout,
  }), [allowRegistration, error, loading, login, logout, refresh, register, session, user])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth 必须在 AuthProvider 内使用')
  return context
}
