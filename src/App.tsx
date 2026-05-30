import { useEffect, useRef } from 'react'
import { initStore } from './store'
import { useStore } from './store'
import { buildSettingsFromUrlParams, clearUrlSettingParams, hasUrlSettingParams } from './lib/urlSettings'
import { bootstrapServerData, flushAutoSync, pullServerDataToLocal, scheduleAutoSync } from './lib/serverSync'
import { useDockerApiUrlMigrationNotice } from './hooks/useDockerApiUrlMigrationNotice'
import Header from './components/Header'
import SearchBar from './components/SearchBar'
import TaskGrid from './components/TaskGrid'
import AgentWorkspace from './components/AgentWorkspace'
import InputBar from './components/InputBar'
import DetailModal from './components/DetailModal'
import Lightbox from './components/Lightbox'
import SettingsModal from './components/SettingsModal'
import ConfirmDialog from './components/ConfirmDialog'
import Toast from './components/Toast'
import MaskEditorModal from './components/MaskEditorModal'
import ImageContextMenu from './components/ImageContextMenu'
import SupportPromptModal from './components/SupportPromptModal'
import { useGlobalClickSuppression } from './lib/clickSuppression'

export default function App() {
  const setSettings = useStore((s) => s.setSettings)
  const appMode = useStore((s) => s.appMode)
  const enableGlassEffect = useStore((s) => s.settings.enableGlassEffect)
  const lowPerformanceMode = useStore((s) => s.settings.lowPerformanceMode)
  const recordSyncStatusText = useStore((s) => s.recordSyncStatusText)
  const initializedRef = useRef(false)
  useDockerApiUrlMigrationNotice()
  useGlobalClickSuppression()

  useEffect(() => {
    if (initializedRef.current) return
    initializedRef.current = true

    const searchParams = new URLSearchParams(window.location.search)
    const nextSettings = buildSettingsFromUrlParams(useStore.getState().settings, searchParams)

    setSettings(nextSettings)

    if (hasUrlSettingParams(searchParams)) {
      clearUrlSettingParams(searchParams)

      const nextSearch = searchParams.toString()
      const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`
      window.history.replaceState(null, '', nextUrl)
    }

    void (async () => {
      await initStore()
      try {
        await bootstrapServerData()
      } catch (err) {
        useStore.getState().showToast(err instanceof Error ? err.message : String(err), 'error')
      }
    })()
  }, [setSettings])

  useEffect(() => {
    const unsubscribe = useStore.subscribe((state, previous) => {
      if (state.settings !== previous.settings || state.tasks !== previous.tasks || state.agentConversations !== previous.agentConversations) {
        scheduleAutoSync('store-change')
      }
    })

    const handleVisible = () => {
      if (document.visibilityState !== 'visible') return
      void pullServerDataToLocal().finally(() => void flushAutoSync())
    }

    document.addEventListener('visibilitychange', handleVisible)
    window.addEventListener('focus', handleVisible)
    return () => {
      unsubscribe()
      document.removeEventListener('visibilitychange', handleVisible)
      window.removeEventListener('focus', handleVisible)
    }
  }, [])

  useEffect(() => {
    const preventPageImageDrag = (e: DragEvent) => {
      if ((e.target as HTMLElement | null)?.closest('img')) {
        e.preventDefault()
      }
    }

    document.addEventListener('dragstart', preventPageImageDrag)
    return () => document.removeEventListener('dragstart', preventPageImageDrag)
  }, [])

  return (
    <div data-glass-effect={enableGlassEffect ? 'on' : 'off'} data-low-performance={lowPerformanceMode ? 'on' : 'off'}>
      <Header />
      {recordSyncStatusText && (
        <div className="fixed right-4 top-20 z-50 rounded-full bg-blue-600/90 px-3 py-1.5 text-xs font-medium text-white shadow-lg backdrop-blur sm:right-6">
          {recordSyncStatusText}
        </div>
      )}
      {appMode === 'agent' ? (
        <AgentWorkspace />
      ) : (
        <main data-home-main data-drag-select-surface className="pb-48">
          <div className="safe-area-x max-w-7xl mx-auto">
            <SearchBar />
            <TaskGrid />
          </div>
        </main>
      )}
      <InputBar />
      <DetailModal />
      <Lightbox />
      <SettingsModal />
      <ConfirmDialog />
      <SupportPromptModal />
      <Toast />
      <MaskEditorModal />
      <ImageContextMenu />
    </div>
  )
}
