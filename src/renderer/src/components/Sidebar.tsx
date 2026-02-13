import { useState, useEffect } from 'react'
import { v4 as uuid } from 'uuid'
import { useSessionStore } from '../stores/session-store'
import type { DirectoryGroup, SessionInfo } from '../../../shared/types'

export function Sidebar(): React.JSX.Element {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const directories = useSessionStore((s) => s.directories)
  const recentSessionIds = useSessionStore((s) => s.recentSessionIds)
  const sessions = useSessionStore((s) => s.sessions)
  const setDirectories = useSessionStore((s) => s.setDirectories)
  const createNewSession = useSessionStore((s) => s.createNewSession)
  const switchSession = useSessionStore((s) => s.switchSession)
  const loadHistoricalSession = useSessionStore((s) => s.loadHistoricalSession)
  const addRecentSession = useSessionStore((s) => s.addRecentSession)

  const [expandedDir, setExpandedDir] = useState<string | null>(null)

  // Load directories on mount
  useEffect(() => {
    window.api.listDirectories().then(setDirectories)
  }, [setDirectories])

  const handleNewThread = async (): Promise<void> => {
    const folder = await window.api.pickFolder()
    if (folder) {
      const routingId = uuid()
      createNewSession(routingId, folder)
    }
  }

  const handleClickSession = async (info: SessionInfo): Promise<void> => {
    const routingId = info.sessionId
    // Already loaded?
    if (sessions[routingId]) {
      switchSession(routingId)
      addRecentSession(routingId)
      return
    }
    // Load from JSONL
    const { messages, taskNotifications } = await window.api.loadSessionHistory(info.sessionId, info.projectKey)
    loadHistoricalSession(routingId, messages, info.cwd, taskNotifications)
    switchSession(routingId)
    addRecentSession(routingId)
  }

  const handleDirClick = (projectKey: string): void => {
    setExpandedDir((prev) => (prev === projectKey ? null : projectKey))
  }

  const handleDirDoubleClick = (group: DirectoryGroup): void => {
    const routingId = uuid()
    createNewSession(routingId, group.cwd)
  }

  // Build recent sessions list from recentSessionIds + directories
  const recentSessions: SessionInfo[] = []
  for (const rid of recentSessionIds) {
    // Check if it's in directories
    for (const group of directories) {
      const found = group.sessions.find((s) => s.sessionId === rid)
      if (found) {
        recentSessions.push(found)
        break
      }
    }
    if (recentSessions.length >= 5) break
  }

  return (
    <div className={`w-60 shrink-0 flex flex-col select-none ${window.api.platform === 'darwin' ? 'bg-bg-secondary/80' : 'bg-bg-secondary/85'}`}>
      {/* Traffic light clearance */}
      <div className="h-12 shrink-0 [-webkit-app-region:drag]" />

      {/* Top nav */}
      <nav style={{ margin: '0 8px' }} className="flex flex-col gap-px">
        <NavItem
          label="New thread"
          onClick={handleNewThread}
          icon={
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
              <path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4z" />
            </svg>
          }
        />
      </nav>

      {/* Scrollable sidebar content */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {/* Recent sessions */}
        {recentSessions.length > 0 && (
          <div style={{ margin: '20px 8px 0' }}>
            <div style={{ paddingLeft: 5, marginBottom: 3 }}>
              <span className="text-[10px] font-semibold text-text-muted uppercase tracking-[0.08em]">Recent</span>
            </div>
            <nav className="flex flex-col gap-px">
              {recentSessions.map((info) => (
                <SessionItem
                  key={info.sessionId}
                  info={info}
                  active={info.sessionId === activeSessionId}
                  isRunning={sessions[info.sessionId]?.status?.state === 'running'}
                  onClick={() => handleClickSession(info)}
                />
              ))}
            </nav>
          </div>
        )}

        {/* Projects accordion */}
        {directories.length > 0 && (
          <div style={{ margin: '20px 8px 0' }}>
            <div style={{ paddingLeft: 5, marginBottom: 3 }}>
              <span className="text-[10px] font-semibold text-text-muted uppercase tracking-[0.08em]">Projects</span>
            </div>
            <nav className="flex flex-col gap-px">
              {directories.map((group) => (
                <DirectoryItem
                  key={group.projectKey}
                  group={group}
                  expanded={expandedDir === group.projectKey}
                  activeSessionId={activeSessionId}
                  sessions={sessions}
                  onClick={() => handleDirClick(group.projectKey)}
                  onDoubleClick={() => handleDirDoubleClick(group)}
                  onSessionClick={handleClickSession}
                />
              ))}
            </nav>
          </div>
        )}
      </div>

      {/* Footer */}
      <div style={{ padding: '12px 16px' }} className="border-t border-border/50 flex items-center gap-2 text-[11px] text-text-muted">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="text-text-muted">
          <path d="M12 2L2 7l10 5 10-5-10-5z" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M2 17l10 5 10-5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>ClaudeUI</span>
      </div>
    </div>
  )
}

function DirectoryItem({
  group,
  expanded,
  activeSessionId,
  sessions,
  onClick,
  onDoubleClick,
  onSessionClick
}: {
  group: DirectoryGroup
  expanded: boolean
  activeSessionId: string | null
  sessions: Record<string, { status?: { state: string } }>
  onClick: () => void
  onDoubleClick: () => void
  onSessionClick: (info: SessionInfo) => void
}): React.JSX.Element {
  return (
    <div>
      <div
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        style={{ padding: '0 5px' }}
        className="flex items-center gap-2.5 h-8 rounded-md text-[13px] cursor-default transition-colors text-text-secondary hover:text-text-primary hover:bg-bg-hover"
      >
        <span className="shrink-0 text-text-muted">
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="currentColor"
            className={`transition-transform ${expanded ? 'rotate-90' : ''}`}
          >
            <path d="M8 5l8 7-8 7z" />
          </svg>
        </span>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-text-muted">
          <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
        </svg>
        <span className="truncate flex-1">{group.folderName}</span>
        <span className="text-[10px] text-text-muted">{group.sessions.length}</span>
      </div>
      {expanded && (
        <div className="ml-3">
          {group.sessions.map((info) => (
            <SessionItem
              key={info.sessionId}
              info={info}
              active={info.sessionId === activeSessionId}
              isRunning={sessions[info.sessionId]?.status?.state === 'running'}
              onClick={() => onSessionClick(info)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function SessionItem({
  info,
  active,
  isRunning,
  onClick
}: {
  info: SessionInfo
  active: boolean
  isRunning?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <div
      onClick={onClick}
      style={{ padding: '0 5px' }}
      className={`
        flex items-center gap-2.5 h-8 rounded-md text-[13px] cursor-default transition-colors
        ${active ? 'text-text-primary bg-bg-tertiary' : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover'}
      `}
    >
      <span className="shrink-0">
        <span
          className={`inline-block w-[6px] h-[6px] rounded-full ${
            isRunning ? 'bg-green-400' : 'bg-text-muted/30'
          }`}
        />
      </span>
      <span className="truncate flex-1">{info.title}</span>
    </div>
  )
}

function NavItem({ label, icon, active, onClick }: {
  label: string
  icon: React.ReactNode
  active?: boolean
  onClick?: () => void
}): React.JSX.Element {
  return (
    <div
      style={{ padding: '0 5px' }}
      onClick={onClick}
      className={`
        flex items-center gap-2.5 h-8 rounded-md text-[13px] cursor-default transition-colors
        ${active ? 'text-text-primary bg-bg-tertiary' : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover'}
      `}
    >
      <span className="shrink-0 text-text-muted">{icon}</span>
      <span className="truncate flex-1">{label}</span>
    </div>
  )
}
