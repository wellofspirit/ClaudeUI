import { useState, useEffect } from 'react'
import { v4 as uuid } from 'uuid'
import { useSessionStore, buildTodosFromMessages } from '../stores/session-store'
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
  const setWatching = useSessionStore((s) => s.setWatching)

  const [expandedDir, setExpandedDir] = useState<string | null>(null)

  // Load directories on mount and auto-refresh when JSONL files change on disk
  useEffect(() => {
    const refresh = (): void => { window.api.listDirectories().then(setDirectories) }
    refresh()
    const cleanup = window.api.onDirectoriesChanged(refresh)
    return cleanup
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
      return
    }
    // Load from JSONL
    const { messages, taskNotifications } = await window.api.loadSessionHistory(info.sessionId, info.projectKey)
    loadHistoricalSession(routingId, messages, info.cwd, taskNotifications)
    // Rebuild todos from TaskCreate/TaskUpdate/TodoWrite tool calls
    const todos = buildTodosFromMessages(messages)
    if (todos) useSessionStore.getState().setTodos(routingId, todos)
    switchSession(routingId)
  }

  const handleDirClick = (projectKey: string): void => {
    setExpandedDir((prev) => (prev === projectKey ? null : projectKey))
  }

  const handleDirDoubleClick = (group: DirectoryGroup): void => {
    const routingId = uuid()
    createNewSession(routingId, group.cwd)
  }

  const handleToggleWatch = (info: SessionInfo): void => {
    const routingId = info.sessionId
    const session = sessions[routingId]
    if (session?.isWatching) {
      window.api.unwatchSession(routingId)
      setWatching(routingId, false)
    } else {
      // Need to load historical session first if not in memory
      if (!session) {
        window.api.loadSessionHistory(info.sessionId, info.projectKey).then(({ messages, taskNotifications }) => {
          loadHistoricalSession(routingId, messages, info.cwd, taskNotifications)
          window.api.watchSession(routingId, info.sessionId, info.projectKey)
          setWatching(routingId, true)
        })
      } else {
        window.api.watchSession(routingId, info.sessionId, info.projectKey)
        setWatching(routingId, true)
      }
    }
  }

  // Build recent sessions list from recentSessionIds + directories + in-memory sessions
  const recentSessions: SessionInfo[] = []
  for (const rid of recentSessionIds) {
    if (recentSessions.length >= 5) break
    // Check if it's in directories
    let found: SessionInfo | undefined
    for (const group of directories) {
      found = group.sessions.find((s) => s.sessionId === rid)
      if (found) break
    }
    if (found) {
      recentSessions.push(found)
      continue
    }
    // Synthesize from in-memory session state (new sessions without JSONL yet)
    const memSession = sessions[rid]
    if (memSession) {
      const firstUserMsg = memSession.messages.find((m) => m.role === 'user')
      const titleText = firstUserMsg?.content.find((b) => b.type === 'text')?.text
      recentSessions.push({
        sessionId: rid,
        cwd: memSession.cwd,
        projectKey: '',
        title: titleText ? titleText.slice(0, 80).replace(/\n/g, ' ').trim() : 'New session',
        timestamp: Date.now(),
        lastActivityAt: Date.now()
      })
    }
  }

  // Build augmented directories: inject in-memory sessions into matching project groups
  const dirSessionIds = new Set<string>()
  for (const group of directories) {
    for (const s of group.sessions) dirSessionIds.add(s.sessionId)
  }

  // Collect in-memory sessions not yet on disk
  const inMemoryByDir: Record<string, SessionInfo[]> = {}
  for (const [rid, memSession] of Object.entries(sessions)) {
    if (dirSessionIds.has(rid) || !memSession.cwd) continue
    const firstUserMsg = memSession.messages.find((m) => m.role === 'user')
    const titleText = firstUserMsg?.content.find((b) => b.type === 'text')?.text
    const info: SessionInfo = {
      sessionId: rid,
      cwd: memSession.cwd,
      projectKey: '',
      title: titleText ? titleText.slice(0, 80).replace(/\n/g, ' ').trim() : 'New session',
      timestamp: Date.now(),
      lastActivityAt: Date.now()
    }
    const key = memSession.cwd
    if (!inMemoryByDir[key]) inMemoryByDir[key] = []
    inMemoryByDir[key].push(info)
  }

  // Merge in-memory sessions into existing groups or create new groups
  const augmentedDirs: DirectoryGroup[] = directories.map((group) => {
    const extra = inMemoryByDir[group.cwd]
    if (!extra) return group
    delete inMemoryByDir[group.cwd]
    return { ...group, sessions: [...extra, ...group.sessions] }
  })
  // Create new groups for cwds not matching any existing directory
  for (const [cwd, extraSessions] of Object.entries(inMemoryByDir)) {
    const folderName = cwd.split(/[\\/]/).pop() || cwd
    augmentedDirs.unshift({
      cwd,
      projectKey: '',
      folderName,
      sessions: extraSessions
    })
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
                  isSdkActive={sessions[info.sessionId]?.sdkActive}
                  isWatching={sessions[info.sessionId]?.isWatching}
                  onClick={() => handleClickSession(info)}
                  onToggleWatch={info.projectKey ? () => handleToggleWatch(info) : undefined}
                />
              ))}
            </nav>
          </div>
        )}

        {/* Projects accordion */}
        {augmentedDirs.length > 0 && (
          <div style={{ margin: '20px 8px 0' }}>
            <div style={{ paddingLeft: 5, marginBottom: 3 }}>
              <span className="text-[10px] font-semibold text-text-muted uppercase tracking-[0.08em]">Projects</span>
            </div>
            <nav className="flex flex-col gap-px">
              {augmentedDirs.map((group) => (
                <DirectoryItem
                  key={group.projectKey || group.cwd}
                  group={group}
                  expanded={expandedDir === (group.projectKey || group.cwd)}
                  activeSessionId={activeSessionId}
                  sessions={sessions}
                  onClick={() => handleDirClick(group.projectKey || group.cwd)}
                  onDoubleClick={() => handleDirDoubleClick(group)}
                  onSessionClick={handleClickSession}
                  onToggleWatch={handleToggleWatch}
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
  onSessionClick,
  onToggleWatch
}: {
  group: DirectoryGroup
  expanded: boolean
  activeSessionId: string | null
  sessions: Record<string, { status?: { state: string }; sdkActive?: boolean; isWatching?: boolean }>
  onClick: () => void
  onDoubleClick: () => void
  onSessionClick: (info: SessionInfo) => void
  onToggleWatch: (info: SessionInfo) => void
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
              isSdkActive={sessions[info.sessionId]?.sdkActive}
              isWatching={sessions[info.sessionId]?.isWatching}
              onClick={() => onSessionClick(info)}
              onToggleWatch={() => onToggleWatch(info)}
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
  isSdkActive,
  isWatching,
  onClick,
  onToggleWatch
}: {
  info: SessionInfo
  active: boolean
  isRunning?: boolean
  isSdkActive?: boolean
  isWatching?: boolean
  onClick: () => void
  onToggleWatch?: () => void
}): React.JSX.Element {
  const dotColor = isRunning
    ? 'bg-green-400 animate-pulse'
    : isSdkActive
      ? 'bg-green-400'
      : isWatching
        ? 'bg-blue-400'
        : 'bg-text-muted/30'

  return (
    <div
      onClick={onClick}
      style={{ padding: '0 5px' }}
      className={`
        group flex items-center gap-2.5 h-8 rounded-md text-[13px] cursor-default transition-colors
        ${active ? 'text-text-primary bg-bg-tertiary' : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover'}
      `}
    >
      <span className="shrink-0">
        <span className={`inline-block w-[6px] h-[6px] rounded-full ${dotColor}`} />
      </span>
      <span className="truncate flex-1">{info.title}</span>
      {onToggleWatch && !isSdkActive && (
        <span
          onClick={(e) => { e.stopPropagation(); onToggleWatch() }}
          className={`shrink-0 transition-opacity cursor-pointer ${
            isWatching ? 'opacity-80 text-blue-400' : 'opacity-0 group-hover:opacity-50 text-text-muted hover:!opacity-80'
          }`}
          title={isWatching ? 'Stop watching' : 'Watch session'}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </span>
      )}
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
