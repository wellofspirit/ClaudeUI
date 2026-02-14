import { useState, useCallback, useRef, useEffect, createContext, useContext } from 'react'
import { Sidebar } from './Sidebar'
import { ChatPanel } from './chat/ChatPanel'
import { TaskDetailPanel } from './TaskDetailPanel'
import { useActiveSession, useSessionStore } from '../stores/session-store'

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

export function SessionView(): React.JSX.Element {
  const taskPanelOpen = useActiveSession((s) => s.taskPanelOpen)
  const sidebar = useResizablePanel('sidebarWidth', 240, 180, 480)
  const taskPanel = useResizablePanel('taskPanelWidth', 400, 280, 700)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('sidebarCollapsed') === 'true')

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => {
      localStorage.setItem('sidebarCollapsed', String(!prev))
      return !prev
    })
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

  return (
    <SidebarContext.Provider value={{ collapsed: sidebarCollapsed, toggle: toggleSidebar }}>
      <div className="h-screen flex">
        {!sidebarCollapsed && (
          <>
            <Sidebar style={{ width: sidebar.width }} onToggleCollapse={toggleSidebar} />
            <ResizeHandle onMouseDown={sidebar.onMouseDown(1)} />
          </>
        )}
        <div className={`flex-1 min-w-0 flex ${window.api.platform === 'darwin' ? 'bg-bg-secondary/80' : 'bg-bg-secondary/80'}`}>
          <div className={`flex-1 min-w-0 h-full flex flex-col bg-bg-primary overflow-hidden ${sidebarCollapsed ? '' : 'rounded-l-2xl shadow-[-1px_0_4px_rgba(0,0,0,0.15),-3px_0_12px_rgba(0,0,0,0.1)]'}`}>
            <ChatPanel />
          </div>
          {taskPanelOpen && (
            <>
              <ResizeHandle onMouseDown={taskPanel.onMouseDown(-1)} />
              <TaskDetailPanel style={{ width: taskPanel.width }} />
            </>
          )}
        </div>
      </div>
    </SidebarContext.Provider>
  )
}
