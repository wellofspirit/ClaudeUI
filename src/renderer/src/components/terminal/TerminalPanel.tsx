import { useEffect } from 'react'
import { useSessionStore } from '../../stores/session-store'
import { XTermInstance } from './XTermInstance'

interface Props {
  style: React.CSSProperties
}

export function TerminalPanel({ style }: Props): React.JSX.Element {
  const tabs = useSessionStore((s) => s.terminalTabs)
  const activeId = useSessionStore((s) => s.activeTerminalId)
  const addTerminalTab = useSessionStore((s) => s.addTerminalTab)
  const closeTerminalTab = useSessionStore((s) => s.closeTerminalTab)
  const removeTerminalTab = useSessionStore((s) => s.removeTerminalTab)
  const setActiveTerminal = useSessionStore((s) => s.setActiveTerminal)
  const setTerminalPanelOpen = useSessionStore((s) => s.setTerminalPanelOpen)

  const cwd = useSessionStore((s) => {
    const id = s.activeSessionId
    return id ? s.sessions[id]?.cwd ?? '' : ''
  })

  const handleNewTab = async (): Promise<void> => {
    const terminalId = await window.api.createTerminal(cwd || '.')
    addTerminalTab({ id: terminalId, title: 'Terminal', cwd: cwd || '.' })
  }

  // Listen for PTY exit events
  useEffect(() => {
    const unsub = window.api.onTerminalExit(({ terminalId }) => {
      removeTerminalTab(terminalId)
    })
    return unsub
  }, [removeTerminalTab])

  return (
    <div style={style} className="flex flex-col bg-bg-primary border-t border-border overflow-hidden">
      {/* Tab bar */}
      <div className="flex items-center gap-0.5 px-2 py-1 bg-bg-secondary border-b border-border shrink-0">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            onClick={() => setActiveTerminal(tab.id)}
            className={`group flex items-center gap-1 px-2.5 h-6 rounded text-[11px] cursor-default transition-colors select-none ${
              tab.id === activeId
                ? 'bg-bg-primary text-text-primary'
                : 'text-text-muted hover:text-text-secondary hover:bg-bg-hover'
            }`}
          >
            <span className="truncate max-w-[120px]">{tab.title}</span>
            <button
              onClick={(e) => {
                e.stopPropagation()
                closeTerminalTab(tab.id)
              }}
              className="w-3.5 h-3.5 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 hover:bg-bg-tertiary text-[10px]"
            >
              &times;
            </button>
          </div>
        ))}
        {/* New tab */}
        <button
          onClick={handleNewTab}
          className="w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-secondary hover:bg-bg-hover text-sm"
          title="New terminal"
        >
          +
        </button>
        {/* Close panel */}
        <button
          onClick={() => setTerminalPanelOpen(false)}
          className="ml-auto w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-secondary hover:bg-bg-hover text-[10px]"
          title="Close terminal panel"
        >
          &times;
        </button>
      </div>

      {/* Terminal instances — all mounted, only active one visible */}
      <div className="flex-1 min-h-0 relative overflow-hidden">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className="absolute inset-0"
            style={{ display: tab.id === activeId ? 'block' : 'none' }}
          >
            <XTermInstance terminalId={tab.id} isActive={tab.id === activeId} />
          </div>
        ))}
        {tabs.length === 0 && (
          <div className="h-full flex items-center justify-center text-text-muted text-xs">
            Press <span className="font-mono mx-1 px-1 py-0.5 bg-bg-tertiary rounded text-text-secondary">+</span> to open a terminal
          </div>
        )}
      </div>
    </div>
  )
}
