import { useActiveSession, useSessionStore } from '../../stores/session-store'
import type { TeammateInfo } from '../../../../shared/types'

export function AgentTabBar(): React.JSX.Element | null {
  const teamName = useActiveSession((s) => s.teamName)
  const teammates = useActiveSession((s) => s.teammates)
  const focusedAgentId = useActiveSession((s) => s.focusedAgentId)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const setFocusedAgent = useSessionStore((s) => s.setFocusedAgent)

  if (!teamName || !activeSessionId) return null

  const teammateList = Object.values(teammates) as TeammateInfo[]

  const handleTabClick = (toolUseId: string | null): void => {
    setFocusedAgent(activeSessionId, toolUseId)
  }

  const handleStopTask = (e: React.MouseEvent, toolUseId: string): void => {
    e.stopPropagation()
    window.api.stopTask(activeSessionId, toolUseId)
  }

  const handleOpenMonitor = (): void => {
    window.api.openTeamsViewWindow(activeSessionId)
  }

  return (
    <div className="shrink-0 flex items-center gap-0.5 px-3 py-1 border-b border-border bg-bg-secondary/50 overflow-x-auto">
      {/* Main tab */}
      <TabButton
        label="Main"
        isActive={focusedAgentId === null}
        status="running"
        onClick={() => handleTabClick(null)}
      />

      {/* Teammate tabs */}
      {teammateList.map((t) => (
        <TabButton
          key={t.toolUseId}
          label={t.name}
          isActive={focusedAgentId === t.toolUseId}
          status={t.status}
          onClick={() => handleTabClick(t.toolUseId)}
          onClose={(e) => handleStopTask(e, t.toolUseId)}
          showClose={t.status === 'running'}
        />
      ))}

      {/* Monitor button */}
      <button
        onClick={handleOpenMonitor}
        className="ml-auto shrink-0 h-6 px-2 flex items-center gap-1 rounded text-[10px] text-text-muted hover:text-text-secondary hover:bg-bg-hover transition-colors cursor-default"
        title="Open Agent Monitor"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
          <line x1="8" y1="21" x2="16" y2="21" />
          <line x1="12" y1="17" x2="12" y2="21" />
        </svg>
        Monitor
      </button>
    </div>
  )
}

function StatusDot({ status }: { status: TeammateInfo['status'] }): React.JSX.Element {
  const color = status === 'running' ? 'bg-green-400' : 'bg-text-muted/50'
  return <span className={`w-1.5 h-1.5 rounded-full ${color} shrink-0`} />
}

function TabButton({
  label,
  isActive,
  status,
  onClick,
  onClose,
  showClose
}: {
  label: string
  isActive: boolean
  status: TeammateInfo['status']
  onClick: () => void
  onClose?: (e: React.MouseEvent) => void
  showClose?: boolean
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`group shrink-0 h-7 px-2.5 flex items-center gap-1.5 rounded-md text-[11px] transition-colors cursor-default ${
        isActive
          ? 'bg-bg-hover text-text-primary border-b-2 border-accent'
          : 'text-text-muted hover:text-text-secondary hover:bg-bg-hover/50'
      }`}
    >
      <StatusDot status={status} />
      <span className="truncate max-w-[100px]">{label}</span>
      {showClose && onClose && (
        <span
          onClick={onClose}
          className="w-4 h-4 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 hover:bg-bg-tertiary transition-opacity"
          title="Stop agent"
        >
          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </span>
      )}
    </button>
  )
}
