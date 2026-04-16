import { useState, useCallback, useRef, useEffect, createContext, useContext } from 'react'
import { Sidebar } from './Sidebar'
import { ChatPanel } from './chat/ChatPanel'
import { TaskDetailPanel } from './TaskDetailPanel'
import { GitPanel } from './git/GitPanel'
import { PlanReviewPanel } from './plan/PlanReviewPanel'
import { UsageView } from './usage/UsageView'
import { AutomationView } from './automation/AutomationView'
import { PluginWebView } from './plugin/PluginWebView'
import { TerminalPanel } from './terminal/TerminalPanel'
import { useActiveSession, useSessionStore, applyTheme, normalizeCwd } from '../stores/session-store'
import { useGitWatcher } from '../hooks/useGitWatcher'
import { useAutomationEvents } from '../hooks/useAutomationEvents'
import { useTerminalColdCleanup } from '../hooks/useTerminalColdCleanup'
import { useIsMobile, useVisualViewportHeight } from '../hooks/useIsMobile'
import { QuitWorktreeModal } from './QuitWorktreeModal'


const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto'] as const

const SidebarContext = createContext<{ collapsed: boolean; toggle: () => void; isMobile: boolean }>({ collapsed: false, toggle: () => {}, isMobile: false })
export const useSidebarCollapsed = () => useContext(SidebarContext)

function useResizablePanel(key: string, defaultW: number, min: number, max: number) {
  const [width, setWidth] = useState(() => {
    const saved = localStorage.getItem(key)
    return saved ? Math.min(max, Math.max(min, Number(saved))) : defaultW
  })
  const dragging = useRef(false)

  const onMouseDown = useCallback((dir: 1 | -1) => (e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    const startX = e.clientX
    const startW = width

    const onMouseMove = (ev: MouseEvent): void => {
      const newW = Math.min(max, Math.max(min, startW + (ev.clientX - startX) * dir))
      setWidth(newW)
    }

    const onMouseUp = (ev: MouseEvent): void => {
      dragging.current = false
      const finalW = Math.min(max, Math.max(min, startW + (ev.clientX - startX) * dir))
      localStorage.setItem(key, String(finalW))
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [width, key, min, max])

  return { width, onMouseDown }
}

function ResizeHandle({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  return (
    <div
      onMouseDown={onMouseDown}
      className="w-0 shrink-0 cursor-col-resize relative z-10"
    >
      <div className="absolute inset-y-0 -left-1.5 w-3" />
    </div>
  )
}

function useResizableBottomPanel(_key: string, min: number, max: number) {
  const store = useSessionStore
  const [height, setHeight] = useState(() => store.getState().terminalPanelHeight)
  const dragging = useRef(false)

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      dragging.current = true
      const startY = e.clientY
      const startH = height

      const onMouseMove = (ev: MouseEvent): void => {
        const newH = Math.min(max, Math.max(min, startH - (ev.clientY - startY)))
        setHeight(newH)
      }

      const onMouseUp = (): void => {
        dragging.current = false
        document.removeEventListener('mousemove', onMouseMove)
        document.removeEventListener('mouseup', onMouseUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }

      document.body.style.cursor = 'row-resize'
      document.body.style.userSelect = 'none'
      document.addEventListener('mousemove', onMouseMove)
      document.addEventListener('mouseup', onMouseUp)
    },
    [height, min, max]
  )

  // Persist height changes (debounced via RAF to avoid thrashing)
  useEffect(() => {
    store.getState().setTerminalPanelHeight(height)
  }, [height, store])

  return { height, onMouseDown }
}

function HorizontalResizeHandle({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  return (
    <div onMouseDown={onMouseDown} className="h-0 shrink-0 cursor-row-resize relative z-10">
      <div className="absolute inset-x-0 -top-1.5 h-3" />
    </div>
  )
}

export function SessionView(): React.JSX.Element {
  const isMobile = useIsMobile()
  const visualHeight = useVisualViewportHeight(isMobile)
  const uiFontScale = useSessionStore((s) => s.settings.uiFontScale)
  const activeView = useSessionStore((s) => s.activeView)
  const setActiveView = useSessionStore((s) => s.setActiveView)
  const rightPanel = useActiveSession((s) => s.rightPanel)
  const sidebar = useResizablePanel('sidebarWidth', 240, 180, 480)
  const taskPanel = useResizablePanel('taskPanelWidth', 400, 280, 700)
  const gitPanel = useResizablePanel('gitPanelWidth', 450, 320, 9999)
  const planPanel = useResizablePanel('planPanelWidth', 500, 350, 900)
  const terminalPanelOpen = useSessionStore((s) => s.terminalPanelOpen)
  const bottomPanel = useResizableBottomPanel('terminalPanelHeight', 120, 600)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => isMobile ? true : localStorage.getItem('sidebarCollapsed') === 'true')

  // Git repo detection and polling
  useGitWatcher()

  // Automation IPC event listeners
  useAutomationEvents()

  // Kill orphaned terminal groups after 10min cold
  useTerminalColdCleanup()

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => {
      localStorage.setItem('sidebarCollapsed', String(!prev))
      return !prev
    })
  }, [])

  // Apply saved theme on mount
  useEffect(() => {
    applyTheme(useSessionStore.getState().settings.theme)
  }, [])

  // Global Shift+Tab to cycle permission mode
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault()
        const state = useSessionStore.getState()
        const { activeSessionId, sessions, setPermissionMode } = state
        if (!activeSessionId) return
        const session = sessions[activeSessionId]
        const permissionMode = session?.permissionMode ?? 'default'
        // localAuto is not in the cycle — treat it as 'auto' for cycling purposes
        const cycleMode = permissionMode === 'localAuto' ? 'auto' : permissionMode as typeof PERMISSION_MODES[number]
        let next = PERMISSION_MODES[(PERMISSION_MODES.indexOf(cycleMode) + 1) % PERMISSION_MODES.length]
        // Auto mode requires an active SDK session — skip to next mode if session not started
        if (next === 'auto' && !session?.sdkActive) {
          next = PERMISSION_MODES[(PERMISSION_MODES.indexOf('auto') + 1) % PERMISSION_MODES.length]
        }
        // Don't optimistically update for 'auto' — main process may redirect to 'localAuto'
        if (next !== 'auto') setPermissionMode(next, activeSessionId)
        window.api.setPermissionMode(activeSessionId, next).catch(() => {
          // SDK rejected the mode change — revert to previous mode
          // (the main process already sent the reverted mode via session:permission-mode)
          setPermissionMode(permissionMode, activeSessionId)
        })
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  // Ctrl/Cmd+Shift+G to toggle git panel
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'G' && e.shiftKey && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        const state = useSessionStore.getState()
        const { activeSessionId, sessions } = state
        if (!activeSessionId) return
        const session = sessions[activeSessionId]
        if (!session?.isGitRepo) return
        if (session.rightPanel === 'git') {
          state.closeGitPanel(activeSessionId)
        } else {
          state.openGitPanel(activeSessionId)
        }
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  // Ctrl+` to toggle terminal panel
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === '`' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        const state = useSessionStore.getState()
        const willOpen = !state.terminalPanelOpen
        state.setTerminalPanelOpen(willOpen)

        // Auto-create first terminal if opening and no tabs for this cwd
        if (willOpen) {
          const cwd = state.activeSessionId
            ? state.sessions[state.activeSessionId]?.cwd ?? '.'
            : '.'
          const key = normalizeCwd(cwd || '.')
          const group = state.terminalGroups[key]
          if (!group || group.tabs.length === 0) {
            window.api.createTerminal(cwd || '.').then((terminalId) => {
              state.addTerminalTab({ id: terminalId, title: 'Terminal', cwd: cwd || '.' })
            })
          }
        }
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  return (
    <SidebarContext.Provider value={{ collapsed: sidebarCollapsed, toggle: toggleSidebar, isMobile }}>
      <div
        style={{
          height: visualHeight ? `${visualHeight / uiFontScale}px` : (uiFontScale !== 1 ? `calc(100dvh / ${uiFontScale})` : undefined),
          ...(uiFontScale !== 1 ? { zoom: uiFontScale, width: `calc(100vw / ${uiFontScale})` } : {}),
        }}
        className={`${visualHeight ? '' : 'h-screen'} flex ${import.meta.env.DEV ? 'border-2 border-orange-400 rounded-2xl overflow-hidden' : ''}`}
      >
        {/* Mobile sidebar drawer */}
        {isMobile && !sidebarCollapsed && (
          <>
            <div className="fixed inset-0 bg-black/40 z-40" onClick={toggleSidebar} />
            <div className="fixed inset-y-0 left-0 z-50 w-[280px] animate-slide-in-left overflow-y-auto">
              <Sidebar style={{ width: 280, height: '100%' }} onToggleCollapse={toggleSidebar} />
            </div>
          </>
        )}
        {/* Desktop sidebar */}
        {!isMobile && !sidebarCollapsed && (
          <>
            <Sidebar style={{ width: sidebar.width }} onToggleCollapse={toggleSidebar} />
            <ResizeHandle onMouseDown={sidebar.onMouseDown(1)} />
          </>
        )}
        <div className={`flex-1 min-w-0 flex flex-col ${window.api.platform === 'darwin' ? 'bg-bg-secondary/60' : 'bg-bg-secondary/80'}`}>
          {/* Main content row: chat + optional right panels */}
          <div className="flex-1 min-w-0 min-h-0 flex">
            <div className={`flex-1 min-w-0 h-full flex flex-col bg-bg-primary overflow-hidden ${sidebarCollapsed || isMobile ? '' : 'rounded-l-2xl shadow-[-1px_0_4px_rgba(0,0,0,0.15),-3px_0_12px_rgba(0,0,0,0.1)]'}`}>
              {activeView.type === 'usage' ? (
                <UsageView onClose={() => setActiveView({ type: 'chat' })} />
              ) : activeView.type === 'automations' ? (
                <AutomationView onClose={() => setActiveView({ type: 'chat' })} />
              ) : activeView.type === 'plugin' ? (
                <PluginWebView pluginId={activeView.pluginId} onClose={() => setActiveView({ type: 'chat' })} />
              ) : (
                <ChatPanel />
              )}
            </div>
            {!isMobile && rightPanel === 'task' && (
              <>
                <ResizeHandle onMouseDown={taskPanel.onMouseDown(-1)} />
                <TaskDetailPanel style={{ width: taskPanel.width }} />
              </>
            )}
            {!isMobile && rightPanel === 'git' && (
              <>
                <ResizeHandle onMouseDown={gitPanel.onMouseDown(-1)} />
                <GitPanel style={{ width: gitPanel.width }} />
              </>
            )}
            {!isMobile && rightPanel === 'plan' && (
              <>
                <ResizeHandle onMouseDown={planPanel.onMouseDown(-1)} />
                <PlanReviewPanel style={{ width: planPanel.width }} />
              </>
            )}
          </div>
          {/* Bottom terminal panel — always mounted to preserve xterm scrollback */}
          {!isMobile && (
            <div style={{ display: terminalPanelOpen ? 'contents' : 'none' }}>
              <HorizontalResizeHandle onMouseDown={bottomPanel.onMouseDown} />
              <TerminalPanel style={{ height: bottomPanel.height }} />
            </div>
          )}
        </div>
      </div>
      <QuitWorktreeModal />
    </SidebarContext.Provider>
  )
}
