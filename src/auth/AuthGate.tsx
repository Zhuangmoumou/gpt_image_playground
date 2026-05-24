import { useEffect, type ReactNode } from 'react'
import { useAuth } from './AuthProvider'
import AuthScreen from '../components/AuthScreen'

function getAuthPathMode(pathname = window.location.pathname): 'login' | 'signup' | null {
  if (pathname === '/login') return 'login'
  if (pathname === '/signup') return 'signup'
  return null
}

export default function AuthGate({ children }: { children: ReactNode }) {
  const { loading, user } = useAuth()
  const authMode = getAuthPathMode()

  useEffect(() => {
    if (loading) return
    if (!user && !authMode) {
      window.history.replaceState(null, '', '/login')
      return
    }
    if (user && authMode) {
      window.history.replaceState(null, '', '/')
    }
  }, [authMode, loading, user])

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-gray-50 text-gray-500 dark:bg-zinc-950 dark:text-gray-400">
        <div className="rounded-3xl border border-gray-200 bg-white/80 px-6 py-5 text-sm font-medium shadow-xl backdrop-blur-xl dark:border-white/10 dark:bg-white/[0.04]">
          正在检查登录状态...
        </div>
      </main>
    )
  }

  if (!user) return <AuthScreen mode={authMode ?? 'login'} />
  if (authMode) return null

  return <>{children}</>
}
