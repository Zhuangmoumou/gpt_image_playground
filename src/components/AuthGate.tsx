import { useEffect, useState, type ReactNode } from 'react'
import { getMe, getServerConfig, login, register } from '../lib/serverApi'
import { initStore, useStore } from '../store'

function getErrorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}

export default function AuthGate({ children }: { children: ReactNode }) {
  const authUser = useStore((state) => state.authUser)
  const setAuthUser = useStore((state) => state.setAuthUser)
  const [enableRegistration, setEnableRegistration] = useState(false)
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [accountLoading, setAccountLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    let cancelled = false

    Promise.all([getServerConfig(), getMe()])
      .then(async ([config, me]) => {
        if (cancelled) return
        setEnableRegistration(config.enableRegistration)
        if (me.user) {
          setAccountLoading(true)
          setAuthUser(me.user)
          try {
            await initStore()
          } catch (err) {
            if (!cancelled) useStore.getState().showToast(`加载账号数据失败：${getErrorMessage(err)}`, 'error')
          } finally {
            if (!cancelled) setAccountLoading(false)
          }
        } else {
          setAuthUser(null)
        }
      })
      .catch((err) => {
        if (!cancelled) setError(getErrorMessage(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [setAuthUser])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      const result = mode === 'register'
        ? await register(username, password)
        : await login(username, password)
      setAccountLoading(true)
      useStore.setState({ authUser: result.user })
      await initStore()
      setAuthUser(result.user)
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setAccountLoading(false)
      setSubmitting(false)
    }
  }

  if (loading || accountLoading) {
    return <div className="min-h-screen bg-gray-50 dark:bg-gray-950" />
  }

  if (authUser) return <>{children}</>

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-indigo-50 px-4 py-12 dark:from-gray-950 dark:via-gray-900 dark:to-slate-950">
      <div className="mx-auto flex min-h-[70vh] max-w-md items-center">
        <form onSubmit={handleSubmit} className="w-full rounded-3xl border border-white/70 bg-white/90 p-6 shadow-xl backdrop-blur glass-panel dark:border-white/[0.08] dark:bg-gray-900/90">
          <div className="mb-6 text-center">
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">GPT Image Playground</h1>
            <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
              {mode === 'register' ? '创建本地账号以保护生成历史' : '登录后访问你的工作区'}
            </p>
          </div>

          <label className="mb-4 block">
            <span className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">用户名</span>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              className="w-full rounded-2xl border border-gray-200 bg-white px-4 py-3 text-gray-900 outline-none transition focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 dark:border-white/[0.08] dark:bg-gray-950 dark:text-gray-100"
            />
          </label>

          <label className="mb-4 block">
            <span className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">密码</span>
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              className="w-full rounded-2xl border border-gray-200 bg-white px-4 py-3 text-gray-900 outline-none transition focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 dark:border-white/[0.08] dark:bg-gray-950 dark:text-gray-100"
            />
          </label>

          {error && <div className="mb-4 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-600 dark:bg-red-500/10 dark:text-red-300">{error}</div>}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-2xl bg-blue-600 px-4 py-3 font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? '处理中…' : mode === 'register' ? '注册并登录' : '登录'}
          </button>

          {enableRegistration && (
            <button
              type="button"
              onClick={() => {
                setMode(mode === 'login' ? 'register' : 'login')
                setError('')
              }}
              className="mt-4 w-full text-sm text-blue-600 hover:text-blue-700 dark:text-blue-300"
            >
              {mode === 'login' ? '没有账号？注册' : '已有账号？返回登录'}
            </button>
          )}
        </form>
      </div>
    </div>
  )
}
