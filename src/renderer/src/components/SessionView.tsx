import { useState, useCallback, useEffect, createContext, useContext } from 'react'
import { Sidebar } from './Sidebar'
import { ChatPanel } from './chat/ChatPanel'
import { TaskDetailPanel } from './TaskDetailPanel'
import { MobileTaskView } from './MobileTaskView'
import { GitPanel } from './git/GitPanel'
import { MobileGitView } from './git/MobileGitView'
import { PlanReviewPanel } from './plan/PlanReviewPanel'
import { MockupPanel } from './MockupPanel'
import { UsageView } from './usage/UsageView'
import { AutomationView } from './automation/AutomationView'
import { PluginWebView } from './plugin/PluginWebView'
import { TerminalPanel } from './terminal/TerminalPanel'
import { toggleTerminalPanel, isTerminalToggleShortcut } from './terminal/toggle-terminal'
import { useActiveSession, useSessionStore, applyTheme } from '../stores/session-store'
import { useGitWatcher } from '../hooks/useGitWatcher'
import { useAutomationEvents } from '../hooks/useAutomationEvents'
import { useTerminalColdCleanup } from '../hooks/useTerminalColdCleanup'
import { useIsMobile, useVisualViewportHeight } from '../hooks/useIsMobile'
import { QuitWorktreeModal } from './QuitWorktreeModal'
import { RemoteServeBanner } from './RemoteServeBanner'
import { SettingsDialog } from './SettingsDialog'
import { SECTION_SCOPE_MAP, type SettingsScope } from './SettingsDialog/settings-sections'
import { nextPermissionMode, autoModeAvailableForEngine } from '../../../shared/permission-modes'

export const SidebarContext = createContext<{
  collapsed: boolean
  toggle: () => void
  isMobile: boolean
}>({ collapsed: false, toggle: () => {}, isMobile: false })
export const useSidebarCollapsed = () => useContext(SidebarContext)

function useResizablePanel(key: string, defaultW: number, min: number, max: number) {
  const [width, setWidth] = useState(() => {
    const saved = localStorage.getItem(key)
    return saved ? Math.min(max, Math.max(min, Number(saved))) : defaultW
  })

  const onPointerDown = useCallback(
    (dir: 1 | -1) => (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      const target = e.currentTarget
      const pointerId = e.pointerId
      const startX = e.clientX
      const startW = width

      // Pointer capture keeps events firing on `target` even when the cursor
      // crosses over iframes/webviews, so mouseup never goes missing.
      target.setPointerCapture(pointerId)

      const onPointerMove = (ev: PointerEvent): void => {
        const newW = Math.min(max, Math.max(min, startW + (ev.clientX - startX) * dir))
        setWidth(newW)
      }

      const onPointerUp = (ev: PointerEvent): void => {
        const finalW = Math.min(max, Math.max(min, startW + (ev.clientX - startX) * dir))
        localStorage.setItem(key, String(finalW))
        target.removeEventListener('pointermove', onPointerMove)
        target.removeEventListener('pointerup', onPointerUp)
        target.removeEventListener('pointercancel', onPointerUp)
        try {
          target.releasePointerCapture(pointerId)
        } catch {
          /* already released */
        }
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }

      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      target.addEventListener('pointermove', onPointerMove)
      target.addEventListener('pointerup', onPointerUp)
      target.addEventListener('pointercancel', onPointerUp)
    },
    [width, key, min, max]
  )

  return { width, onPointerDown }
}

function ResizeHandle({
  onPointerDown
}: {
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void
}) {
  return (
    <div
      onPointerDown={onPointerDown}
      className="w-0 shrink-0 cursor-col-resize relative z-10 touch-none"
    >
      <div className="absolute inset-y-0 -left-1.5 w-3" />
    </div>
  )
}

function useResizableBottomPanel(_key: string, min: number, max: number) {
  const store = useSessionStore
  const [height, setHeight] = useState(() => store.getState().terminalPanelHeight)

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      const target = e.currentTarget
      const pointerId = e.pointerId
      const startY = e.clientY
      const startH = height

      target.setPointerCapture(pointerId)

      const onPointerMove = (ev: PointerEvent): void => {
        const newH = Math.min(max, Math.max(min, startH - (ev.clientY - startY)))
        setHeight(newH)
      }

      const onPointerUp = (): void => {
        target.removeEventListener('pointermove', onPointerMove)
        target.removeEventListener('pointerup', onPointerUp)
        target.removeEventListener('pointercancel', onPointerUp)
        try {
          target.releasePointerCapture(pointerId)
        } catch {
          /* already released */
        }
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }

      document.body.style.cursor = 'row-resize'
      document.body.style.userSelect = 'none'
      target.addEventListener('pointermove', onPointerMove)
      target.addEventListener('pointerup', onPointerUp)
      target.addEventListener('pointercancel', onPointerUp)
    },
    [height, min, max]
  )

  // Persist height changes (debounced via RAF to avoid thrashing)
  useEffect(() => {
    store.getState().setTerminalPanelHeight(height)
  }, [height, store])

  return { height, onPointerDown }
}

function HorizontalResizeHandle({
  onPointerDown
}: {
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void
}) {
  return (
    <div
      onPointerDown={onPointerDown}
      className="h-0 shrink-0 cursor-row-resize relative z-10 touch-none"
    >
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
  const mockupPanel = useResizablePanel('mockupPanelWidth', 500, 350, 9999)
  const terminalPanelOpen = useSessionStore((s) => s.terminalPanelOpen)
  const bottomPanel = useResizableBottomPanel('terminalPanelHeight', 120, 600)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    isMobile ? true : localStorage.getItem('sidebarCollapsed') === 'true'
  )
  /**
   * Mobile-only settings host. On a phone the sidebar drawer is UNMOUNTED when
   * it closes, and Settings is opened from inside it — so `SettingsPanel` (which
   * hosts the dialog on desktop) cannot both close the drawer and keep the
   * dialog alive. Hosting it here, outside the drawer, is what lets opening
   * Settings dismiss the drawer. Desktop is untouched: `SettingsPanel` still
   * owns the dialog there, and this branch never renders.
   */
  const [mobileSettings, setMobileSettings] = useState<{
    scope?: SettingsScope
    section?: string
  } | null>(null)

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

  // `open-settings` is the app-wide deep-link channel (the composer's sandbox
  // pill, RemoteAccessModal, SettingsPanel's own button). On mobile it lands
  // here and closes the drawer with it; on desktop SettingsPanel keeps it.
  //
  // Crossing back over the breakpoint (rotating an iPad, resizing an Electron
  // window) must DROP this host's state, not park it: a stale `mobileSettings`
  // would make Settings reappear unbidden the next time the viewport narrows,
  // long after the user dismissed it. The two hosts hand ownership over, so
  // exactly one of them can be showing a dialog at any width.
  useEffect(() => {
    if (!isMobile) {
      setMobileSettings(null)
      return
    }
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<{ scope?: SettingsScope; section?: string }>).detail
      setMobileSettings({
        scope: detail?.scope ?? (detail?.section ? SECTION_SCOPE_MAP.get(detail.section) : undefined),
        section: detail?.section
      })
      setSidebarCollapsed(true)
    }
    window.addEventListener('open-settings', handler)
    return () => window.removeEventListener('open-settings', handler)
  }, [isMobile])

  // Global Shift+Tab to cycle permission mode
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault()
        const state = useSessionStore.getState()
        const { activeSessionId, sessions } = state
        if (!activeSessionId) return
        const session = sessions[activeSessionId]
        const permissionMode = session?.permissionMode ?? 'default'
        // Engine capability gate: skip modes the engine can't offer (e.g. 'plan'
        // when !capabilities.plan). Claude has plan=true, so the full cycle stands.
        const canPlan = session?.status.capabilities.plan ?? true
        // Auto mode is default-available (subscription accounts get it out of the
        // box); the only negative gate is Claude's launch-time model info reporting
        // that no available model supports it. Non-Claude engines' 'auto' is a local
        // full-autonomy mode with no account gate, so it's always available there.
        const autoAvailable = autoModeAvailableForEngine(session?.selectedEngineId, state.availableModels)
        const next = nextPermissionMode(permissionMode, { canPlan, autoAvailable })
        state.changePermissionMode(activeSessionId, next)
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

  // Ctrl/Cmd+` or Alt+` to toggle terminal panel (predicate owns both bindings)
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (isTerminalToggleShortcut(e)) {
        e.preventDefault()
        toggleTerminalPanel()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  return (
    <SidebarContext.Provider
      value={{ collapsed: sidebarCollapsed, toggle: toggleSidebar, isMobile }}
    >
      <div
        data-testid="SessionView"
        style={{
          height: visualHeight
            ? `${visualHeight / uiFontScale}px`
            : uiFontScale !== 1
              ? `calc(100dvh / ${uiFontScale})`
              : undefined,
          ...(uiFontScale !== 1 ? { zoom: uiFontScale, width: `calc(100vw / ${uiFontScale})` } : {})
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
            <ResizeHandle onPointerDown={sidebar.onPointerDown(1)} />
          </>
        )}
        <div
          className={`flex-1 min-w-0 flex flex-col ${window.api.platform === 'darwin' ? 'bg-bg-secondary/60' : 'bg-bg-secondary/80'}`}
        >
          {/* Main content row: chat + optional right panels */}
          <div className="flex-1 min-w-0 min-h-0 flex">
            <div
              className={`flex-1 min-w-0 h-full flex flex-col bg-bg-primary overflow-hidden ${sidebarCollapsed || isMobile ? '' : 'rounded-l-2xl shadow-[-1px_0_4px_rgba(0,0,0,0.15),-3px_0_12px_rgba(0,0,0,0.1)]'}`}
            >
              {isMobile && rightPanel === 'task' ? (
                <MobileTaskView />
              ) : isMobile && rightPanel === 'git' ? (
                <MobileGitView />
              ) : activeView.type === 'usage' ? (
                <UsageView onClose={() => setActiveView({ type: 'chat' })} />
              ) : activeView.type === 'automations' ? (
                <AutomationView onClose={() => setActiveView({ type: 'chat' })} />
              ) : activeView.type === 'plugin' ? (
                <PluginWebView
                  pluginId={activeView.pluginId}
                  onClose={() => setActiveView({ type: 'chat' })}
                />
              ) : (
                <ChatPanel />
              )}
            </div>
            {!isMobile && rightPanel === 'task' && (
              <>
                <ResizeHandle onPointerDown={taskPanel.onPointerDown(-1)} />
                <TaskDetailPanel style={{ width: taskPanel.width }} />
              </>
            )}
            {!isMobile && rightPanel === 'git' && (
              <>
                <ResizeHandle onPointerDown={gitPanel.onPointerDown(-1)} />
                <GitPanel style={{ width: gitPanel.width }} />
              </>
            )}
            {!isMobile && rightPanel === 'plan' && (
              <>
                <ResizeHandle onPointerDown={planPanel.onPointerDown(-1)} />
                <PlanReviewPanel style={{ width: planPanel.width }} />
              </>
            )}
            {!isMobile && rightPanel === 'mockup' && (
              <>
                <ResizeHandle onPointerDown={mockupPanel.onPointerDown(-1)} />
                <MockupPanel style={{ width: mockupPanel.width }} />
              </>
            )}
          </div>
          {/* Bottom terminal panel — always mounted to preserve xterm scrollback.
              Desktop only: a phone gets the fullscreen takeover below, because a
              200px strip under the chat is unusable at 360px wide. */}
          {!isMobile && (
            <div style={{ display: terminalPanelOpen ? 'contents' : 'none' }}>
              <HorizontalResizeHandle onPointerDown={bottomPanel.onPointerDown} />
              <TerminalPanel style={{ height: bottomPanel.height }} />
            </div>
          )}
        </div>
      </div>
      <QuitWorktreeModal />
      {/* Mobile terminal — a fullscreen takeover, hosted here (outside the
          zoomed app root, like every other mobile takeover) so `position: fixed`
          and the visual-viewport height it sets are measured in real pixels.
          Mounted only while open, unlike the desktop panel: the phone's reason
          for keeping a hidden xterm alive is gone — the host replays the
          scrollback ring on re-attach — and a permanently-mounted terminal on a
          memory-constrained device buys nothing. Rendered BEFORE the settings
          dialog so an open Settings sits above it at equal z. */}
      {isMobile && terminalPanelOpen && <TerminalPanel />}
      {isMobile && mobileSettings && (
        <SettingsDialog
          onClose={() => setMobileSettings(null)}
          initialScope={mobileSettings.scope}
          initialSection={mobileSettings.section}
        />
      )}
      {/* App-level (not per-session) notice: `tailscale serve` failed while TLS
          mode is on, so the remote bookmark is dead. Fixed overlay, desktop-only
          — renders null on web and while serve is healthy. */}
      <RemoteServeBanner />
    </SidebarContext.Provider>
  )
}
