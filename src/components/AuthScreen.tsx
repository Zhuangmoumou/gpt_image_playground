import { useState, type FormEvent } from 'react'
import { useAuth } from '../auth/AuthProvider'

export default function AuthScreen({ mode }: { mode: 'login' | 'signup' }) {
  const { allowRegistration, error: authError, login, register } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isSignup = mode === 'signup'
  const title = isSignup ? '注册' : '登录'

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      if (isSignup) await register(username.trim(), password)
      else await login(username.trim(), password)
      window.history.replaceState(null, '', '/')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 px-4 text-gray-900 dark:bg-zinc-950 dark:text-gray-50">
      <section className="w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-6 shadow-xl dark:border-white/10 dark:bg-zinc-900">
        <div className="mb-6">
          <h1 className="text-xl font-bold">GPT Image Playground</h1>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">请先{title}账号。</p>
        </div>

        <form className="space-y-4" onSubmit={submit}>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">用户名</span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-blue-400 dark:border-white/10 dark:bg-white/[0.04]"
            />
          </label>

          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">密码</span>
            <input
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              autoComplete={isSignup ? 'new-password' : 'current-password'}
              className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-blue-400 dark:border-white/10 dark:bg-white/[0.04]"
            />
          </label>

          {(error || (authError && !username && !password)) && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300">
              {error || authError}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting || (isSignup && !allowRegistration)}
            className="w-full rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? '请稍候...' : title}
          </button>
        </form>

        <div className="mt-5 text-center text-sm text-gray-500 dark:text-gray-400">
          {isSignup ? (
            <a href="/login" className="font-medium text-blue-600 hover:text-blue-500">返回登录</a>
          ) : allowRegistration ? (
            <a href="/signup" className="font-medium text-blue-600 hover:text-blue-500">注册账号</a>
          ) : (
            <span>注册已关闭</span>
          )}
        </div>
      </section>
    </main>
  )
}
