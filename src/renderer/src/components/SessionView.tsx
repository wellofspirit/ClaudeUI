import { useState, useCallback, useRef, useEffect, createContext, useContext } from 'react'
import { Sidebar } from './Sidebar'
import { ChatPanel } from './chat/ChatPanel'
import { TaskDetailPanel } from './TaskDetailPanel'
import { GitPanel } from './git/GitPanel'
import { UsageView } from './usage/UsageView'
import { AutomationView } from './automation/AutomationView'
import { TerminalPanel } from './terminal/TerminalPanel'
import { useActiveSession, useSessionStore, applyTheme } from '../stores/session-store'
import { useGitWatcher } from '../hooks/useGitWatcher'
import { useAutomationEvents } from '../hooks/useAutomationEvents'


const PERMISSION_MODES = ['default', 'acceptEdits', 'plan'] as const

const SidebarContext = createContext<{ collapsed: boolean; toggle: () => void }>({ collapsed: false, toggle: () => {} })
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
  const uiFontScale = useSessionStore((s) => s.settings.uiFontScale)
  const showUsageView = useSessionStore((s) => s.showUsageView)
  const setShowUsageView = useSessionStore((s) => s.setShowUsageView)
  const showAutomationView = useSessionStore((s) => s.showAutomationView)
  const setShowAutomationView = useSessionStore((s) => s.setShowAutomationView)
  const rightPanel = useActiveSession((s) => s.rightPanel)
  const sidebar = useResizablePanel('sidebarWidth', 240, 180, 480)
  const taskPanel = useResizablePanel('taskPanelWidth', 400, 280, 700)
  const gitPanel = useResizablePanel('gitPanelWidth', 450, 320, 9999)
  const terminalPanelOpen = useSessionStore((s) => s.terminalPanelOpen)
  const bottomPanel = useResizableBottomPanel('terminalPanelHeight', 120, 600)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('sidebarCollapsed') === 'true')

  // Git repo detection and polling
  useGitWatcher()

  // Automation IPC event listeners
  useAutomationEvents()

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
        const permissionMode = sessions[activeSessionId]?.permissionMode ?? 'default'
        const next = PERMISSION_MODES[(PERMISSION_MODES.indexOf(permissionMode) + 1) % PERMISSION_MODES.length]
        setPermissionMode(next, activeSessionId)
        window.api.setPermissionMode(activeSessionId, next)
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

        // Auto-create first terminal if opening and no tabs exist
        if (willOpen && state.terminalTabs.length === 0) {
          const cwd = state.activeSessionId
            ? state.sessions[state.activeSessionId]?.cwd ?? '.'
            : '.'
          window.api.createTerminal(cwd || '.').then((terminalId) => {
            state.addTerminalTab({ id: terminalId, title: 'Terminal', cwd: cwd || '.' })
          })
        }
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  return (
    <SidebarContext.Provider value={{ collapsed: sidebarCollapsed, toggle: toggleSidebar }}>
      <div style={uiFontScale !== 1 ? { zoom: uiFontScale, height: `calc(100vh / ${uiFontScale})`, width: `calc(100vw / ${uiFontScale})` } : undefined} className={`h-screen flex ${import.meta.env.DEV ? 'border-2 border-orange-400 rounded-2xl overflow-hidden' : ''}`}>
        {!sidebarCollapsed && (
          <>
            <Sidebar style={{ width: sidebar.width }} onToggleCollapse={toggleSidebar} />
            <ResizeHandle onMouseDown={sidebar.onMouseDown(1)} />
          </>
        )}
        <div className={`flex-1 min-w-0 flex flex-col ${window.api.platform === 'darwin' ? 'bg-bg-secondary/60' : 'bg-bg-secondary/80'}`}>
          {/* Main content row: chat + optional right panels */}
          <div className="flex-1 min-w-0 min-h-0 flex">
            <div className={`flex-1 min-w-0 h-full flex flex-col bg-bg-primary overflow-hidden ${sidebarCollapsed ? '' : 'rounded-l-2xl shadow-[-1px_0_4px_rgba(0,0,0,0.15),-3px_0_12px_rgba(0,0,0,0.1)]'}`}>
              {showUsageView ? (
                <UsageView onClose={() => setShowUsageView(false)} />
              ) : showAutomationView ? (
                <AutomationView onClose={() => setShowAutomationView(false)} />
              ) : (
                <ChatPanel />
              )}
            </div>
            {rightPanel === 'task' && (
              <>
                <ResizeHandle onMouseDown={taskPanel.onMouseDown(-1)} />
                <TaskDetailPanel style={{ width: taskPanel.width }} />
              </>
            )}
            {rightPanel === 'git' && (
              <>
                <ResizeHandle onMouseDown={gitPanel.onMouseDown(-1)} />
                <GitPanel style={{ width: gitPanel.width }} />
              </>
            )}
          </div>
          {/* Bottom terminal panel */}
          {terminalPanelOpen && (
            <>
              <HorizontalResizeHandle onMouseDown={bottomPanel.onMouseDown} />
              <TerminalPanel style={{ height: bottomPanel.height }} />
            </>
          )}
        </div>
      </div>
    </SidebarContext.Provider>
  )
}
