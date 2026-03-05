import { useState, useEffect, useRef, useCallback } from 'react'
import { v4 as uuid } from 'uuid'
import { useSessionStore, buildTodosFromMessages } from '../stores/session-store'
import type { ChatMessage, DirectoryGroup, SessionInfo, AccountUsage, ExtraUsage, RateWindow, WorktreeInfo } from '../../../shared/types'
import { SettingsDialog, SettingsToggle } from './SettingsDialog'
import { PermissionsDialog } from './PermissionsDialog'
import { WorktreesModal } from './WorktreesModal'
import { WorktreeCleanupModal } from './WorktreeCleanupModal'
import { useAutomationStore } from '../stores/automation-store'

/** Convert mouse event coords to zoom-adjusted position for fixed-position menus */
function contextMenuPosition(e: React.MouseEvent): { x: number; y: number } {
  const zoom = useSessionStore.getState().settings.uiFontScale
  return { x: e.clientX / zoom, y: e.clientY / zoom }
}

export function Sidebar({ style, onToggleCollapse }: {
  style?: React.CSSProperties
  onToggleCollapse?: () => void
}): React.JSX.Element {
  const uiFontScale = useSessionStore((s) => s.settings.uiFontScale)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const directories = useSessionStore((s) => s.directories)
  const recentSessionIds = useSessionStore((s) => s.recentSessionIds)
  const pinnedSessionIds = useSessionStore((s) => s.pinnedSessionIds)
  const maxRecentSessions = useSessionStore((s) => s.settings.maxRecentSessions)
  const sessions = useSessionStore((s) => s.sessions)
  const setDirectories = useSessionStore((s) => s.setDirectories)
  const createNewSession = useSessionStore((s) => s.createNewSession)
  const switchSession = useSessionStore((s) => s.switchSession)
  const loadHistoricalSession = useSessionStore((s) => s.loadHistoricalSession)
  const setWatching = useSessionStore((s) => s.setWatching)
  const pinSession = useSessionStore((s) => s.pinSession)
  const unpinSession = useSessionStore((s) => s.unpinSession)
  const removeRecentSession = useSessionStore((s) => s.removeRecentSession)
  const setCustomTitle = useSessionStore((s) => s.setCustomTitle)
  const customTitles = useSessionStore((s) => s.customTitles)
  const reorderPinnedSessions = useSessionStore((s) => s.reorderPinnedSessions)
  const worktreeInfoMap = useSessionStore((s) => s.worktreeInfoMap)
  const clearWorktreeInfo = useSessionStore((s) => s.clearWorktreeInfo)

  const [expandedDir, setExpandedDir] = useState<string | null>(null)
  const [worktreesModalCwd, setWorktreesModalCwd] = useState<string | null>(null)
  const [cleanupWorktree, setCleanupWorktree] = useState<{ sessionId: string; worktreeInfo: WorktreeInfo } | null>(null)
  const [renamingKey, setRenamingKey] = useState<string | null>(null)

  // Find the projectKey for a session from directories
  const findProjectKey = useCallback((sessionId: string): string | undefined => {
    for (const group of directories) {
      if (group.sessions.some((s) => s.sessionId === sessionId)) return group.projectKey
    }
    return undefined
  }, [directories])

  // Set custom title in state and persist to JSONL
  const applyTitle = useCallback((sessionId: string, title: string) => {
    setCustomTitle(sessionId, title)
    const projectKey = findProjectKey(sessionId)
    if (projectKey && title) {
      window.api.writeCustomTitle(sessionId, projectKey, title)
    }
  }, [setCustomTitle, findProjectKey])

  const handleRename = useCallback(async (sessionId: string, newTitle: string) => {
    setRenamingKey(null)
    if (newTitle.trim()) {
      applyTitle(sessionId, newTitle.trim())
      return
    }
    // Auto-generate: collect text from session messages
    let session = sessions[sessionId]
    // If session not loaded in memory, try loading from disk
    if (!session) {
      const info = (() => {
        for (const group of directories) {
          const found = group.sessions.find((s) => s.sessionId === sessionId)
          if (found) return found
        }
        return undefined
      })()
      if (info?.projectKey) {
        const { messages, taskNotifications, statusLine } = await window.api.loadSessionHistory(sessionId, info.projectKey)
        loadHistoricalSession(sessionId, messages, info.cwd, taskNotifications, {}, statusLine)
        session = useSessionStore.getState().sessions[sessionId]
      }
    }
    if (!session) return
    const texts: string[] = []
    let totalLen = 0
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const msg = session.messages[i]
      if (msg.role !== 'user' && msg.role !== 'assistant') continue
      for (const block of msg.content) {
        if (block.type === 'text' && block.text) {
          texts.unshift(block.text)
          totalLen += block.text.length
        }
      }
      if (totalLen >= 1000) break
    }
    let conversationText = texts.join('\n')
    if (conversationText.length > 1000) {
      conversationText = conversationText.slice(-1000)
    }
    if (!conversationText) return
    // Show a temporary "generating..." title
    setCustomTitle(sessionId, 'generating...')
    try {
      const generated = await window.api.generateTitle(conversationText)
      if (generated) {
        applyTitle(sessionId, generated)
      } else {
        // Fallback: kebab slug from first user message
        const firstText = session.messages.find((m) => m.role === 'user')
          ?.content.find((b) => b.type === 'text')?.text
        if (firstText) {
          const slug = firstText.slice(0, 60).toLowerCase()
            .replace(/[^a-z0-9\s-]/g, '').trim()
            .replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 40)
          if (slug) applyTitle(sessionId, slug)
          else setCustomTitle(sessionId, '') // remove temp title
        } else {
          setCustomTitle(sessionId, '') // remove temp title
        }
      }
    } catch (err) {
      window.api.logError('Sidebar', `Auto-generate title failed for ${sessionId}: ${err}`)
      setCustomTitle(sessionId, '') // clear stuck "generating..." title
    }
  }, [sessions, directories, setCustomTitle, applyTitle, loadHistoricalSession])

  const handleAutoRename = useCallback((sessionId: string) => {
    handleRename(sessionId, '')
  }, [handleRename])

  // Load directories on mount and auto-refresh when JSONL files change on disk
  useEffect(() => {
    const refresh = (): void => { window.api.listDirectories().then(setDirectories) }
    refresh()
    const cleanup = window.api.onDirectoriesChanged(refresh)
    return cleanup
  }, [setDirectories])

  const showWelcome = useSessionStore((s) => s.showWelcome)
  const showAutomationView = useSessionStore((s) => s.showAutomationView)
  const setShowAutomationView = useSessionStore((s) => s.setShowAutomationView)
  const setShowUsageView = useSessionStore((s) => s.setShowUsageView)
  const automationBadge = useAutomationStore((s) => s.notificationBadge)

  const handleNewSession = (): void => {
    showWelcome()
  }

  const handleNewSessionDblClick = async (): Promise<void> => {
    const folder = await window.api.pickFolder()
    if (folder) {
      const routingId = uuid()
      createNewSession(routingId, folder)
    }
  }

  const addRecentSession = useSessionStore((s) => s.addRecentSession)

  const handleClickSession = async (info: SessionInfo): Promise<void> => {
    const routingId = info.sessionId
    // Already loaded?
    if (sessions[routingId]) {
      switchSession(routingId)
      return
    }
    // Load from JSONL
    const { messages, taskNotifications, customTitle, agentIdToToolUseId, statusLine, teamName, pendingTeammates, taskPrompts } = await window.api.loadSessionHistory(info.sessionId, info.projectKey)

    // For team agents, agent_ids (e.g. "historian@cny-v5") don't match JSONL filenames.
    // Build a mapping from toolUseId → hex filename by scanning subagent directory.
    let teamFileMap: Record<string, string> = {}
    if (teamName && Object.keys(taskPrompts).length > 0) {
      teamFileMap = await window.api.buildSubagentFileMap(info.sessionId, info.projectKey, taskPrompts)
    }

    // Load subagent histories in parallel
    const subagentMessages: Record<string, ChatMessage[]> = {}
    const entries = Object.entries(agentIdToToolUseId)
    if (entries.length > 0) {
      const results = await Promise.all(
        entries.map(async ([agentId, toolUseId]) => {
          // For team agents, use the hex ID from the file map; for regular agents, use agentId directly
          const fileId = teamFileMap[toolUseId] || agentId
          try {
            const msgs = await window.api.loadSubagentHistory(info.sessionId, info.projectKey, fileId)
            return { toolUseId, msgs }
          } catch {
            return { toolUseId, msgs: [] as ChatMessage[] }
          }
        })
      )
      for (const { toolUseId, msgs } of results) {
        if (msgs.length > 0) subagentMessages[toolUseId] = msgs
      }
    }
    loadHistoricalSession(routingId, messages, info.cwd, taskNotifications, subagentMessages, statusLine)
    if (customTitle) setCustomTitle(routingId, customTitle)

    // Reconstruct team info from JSONL data
    if (teamName) {
      const store = useSessionStore.getState()
      store.setTeamName(routingId, teamName)
      // Build TeammateInfo from pendingTeammates + agentIdToToolUseId
      const sanitize = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, '-')
      // Reverse map: toolUseId → agentId
      const toolUseIdToAgentId: Record<string, string> = {}
      for (const [agentId, toolUseId] of Object.entries(agentIdToToolUseId)) {
        toolUseIdToAgentId[toolUseId] = agentId
      }
      for (const [toolUseId, pending] of Object.entries(pendingTeammates)) {
        // Only include teammates belonging to the current (last) team
        if (pending.teamName !== teamName) continue
        const agentId = toolUseIdToAgentId[toolUseId]
        if (!agentId) continue
        // Determine status from task notifications
        const notif = taskNotifications.find((n) => n.toolUseId === toolUseId)
        const statusMap: Record<string, 'completed' | 'failed' | 'stopped'> = { completed: 'completed', failed: 'failed', stopped: 'stopped' }
        const status = notif ? (statusMap[notif.status] || 'completed') : 'completed'
        store.addTeammate(routingId, {
          toolUseId,
          name: pending.name,
          sanitizedName: sanitize(pending.name),
          teamName: pending.teamName,
          sanitizedTeamName: sanitize(pending.teamName),
          agentId,
          status
        })
      }
    }

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
        window.api.loadSessionHistory(info.sessionId, info.projectKey).then(({ messages, taskNotifications, customTitle: ct, statusLine: sl }) => {
          loadHistoricalSession(routingId, messages, info.cwd, taskNotifications, {}, sl)
          if (ct) setCustomTitle(routingId, ct)
          window.api.watchSession(routingId, info.sessionId, info.projectKey)
          setWatching(routingId, true)
        })
      } else {
        window.api.watchSession(routingId, info.sessionId, info.projectKey)
        setWatching(routingId, true)
      }
    }
  }

  // Helper to resolve a session ID to a SessionInfo
  const resolveSessionInfo = (rid: string): SessionInfo | undefined => {
    let info: SessionInfo | undefined
    for (const group of directories) {
      info = group.sessions.find((s) => s.sessionId === rid)
      if (info) break
    }
    if (!info) {
      const memSession = sessions[rid]
      if (memSession) {
        const firstUserMsg = memSession.messages.find((m) => m.role === 'user')
        const titleText = firstUserMsg?.content.find((b) => b.type === 'text')?.text
        info = {
          sessionId: rid,
          cwd: memSession.cwd,
          projectKey: '',
          title: titleText ? titleText.slice(0, 80).replace(/\n/g, ' ').trim() : 'New session',
          timestamp: Date.now(),
          lastActivityAt: Date.now()
        }
      }
    }
    // Apply custom title if set
    if (info && customTitles[rid]) {
      info = { ...info, title: customTitles[rid] }
    }
    return info
  }

  // Build pinned sessions list
  const pinnedSet = new Set(pinnedSessionIds)
  const pinnedSessions: SessionInfo[] = []
  for (const rid of pinnedSessionIds) {
    const info = resolveSessionInfo(rid)
    if (info) pinnedSessions.push(info)
  }

  // Build recent sessions list (exclude pinned, capped at 5)
  const recentSessions: SessionInfo[] = []
  for (const rid of recentSessionIds) {
    if (recentSessions.length >= maxRecentSessions) break
    if (pinnedSet.has(rid)) continue
    const info = resolveSessionInfo(rid)
    if (info) recentSessions.push(info)
  }

  // Build watching sessions list (exclude pinned and recent)
  const recentSet = new Set(recentSessionIds)
  const watchingSessions: SessionInfo[] = []
  for (const [rid, session] of Object.entries(sessions)) {
    if (!session.isWatching) continue
    if (pinnedSet.has(rid) || recentSet.has(rid)) continue
    const info = resolveSessionInfo(rid)
    if (info) watchingSessions.push(info)
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

  // Merge in-memory sessions into existing groups or create new groups,
  // and apply custom titles to all sessions
  const applyCustomTitles = (sessions: SessionInfo[]): SessionInfo[] =>
    sessions.map((s) => customTitles[s.sessionId] ? { ...s, title: customTitles[s.sessionId] } : s)

  const augmentedDirs: DirectoryGroup[] = directories.map((group) => {
    const extra = inMemoryByDir[group.cwd]
    if (!extra) {
      return { ...group, sessions: applyCustomTitles(group.sessions) }
    }
    delete inMemoryByDir[group.cwd]
    return { ...group, sessions: applyCustomTitles([...extra, ...group.sessions]) }
  })
  // Create new groups for cwds not matching any existing directory
  for (const [cwd, extraSessions] of Object.entries(inMemoryByDir)) {
    const folderName = cwd.split(/[\\/]/).pop() || cwd
    augmentedDirs.unshift({
      cwd,
      projectKey: '',
      folderName,
      sessions: applyCustomTitles(extraSessions)
    })
  }

  return (
    <div style={style} className={`shrink-0 flex flex-col select-none ${window.api.platform === 'darwin' ? 'bg-bg-secondary/60' : 'bg-bg-secondary/85'}`}>
      {/* Traffic light clearance + collapse toggle */}
      <div className="h-12 shrink-0 [-webkit-app-region:drag] relative">
        <button
          onClick={onToggleCollapse}
          style={{ position: 'absolute', left: window.api.platform === 'darwin' ? 82 / uiFontScale : 8, top: 22 / uiFontScale, transform: 'translateY(-50%)' }}
          className="[-webkit-app-region:no-drag] w-[26px] h-[26px] flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
          title="Collapse sidebar"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M9 3v18" />
            <path d="M16 15l-3-3 3-3" />
          </svg>
        </button>
      </div>

      {/* Top nav */}
      <nav style={{ margin: '0 8px' }} className="flex flex-col gap-px">
        <NavItem
          label="New session"
          onClick={handleNewSession}
          onDoubleClick={handleNewSessionDblClick}
          icon={
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
              <path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4z" />
            </svg>
          }
        />
        <NavItem
          label="Automations"
          active={showAutomationView}
          onClick={() => {
            const next = !showAutomationView
            setShowAutomationView(next)
            if (next) setShowUsageView(false)
          }}
          badge={automationBadge}
          icon={
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          }
        />
      </nav>

      {/* Scrollable sidebar content */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {/* Pinned sessions */}
        {pinnedSessions.length > 0 && (
          <div style={{ margin: '20px 8px 0' }}>
            <div style={{ paddingLeft: 5, marginBottom: 3 }}>
              <span className="text-[10px] font-semibold text-text-muted uppercase tracking-[0.08em]">Pinned</span>
            </div>
            <PinnedSessionList
              pinnedSessions={pinnedSessions}
              activeSessionId={activeSessionId}
              sessions={sessions}
              onClickSession={handleClickSession}
              onToggleWatch={handleToggleWatch}
              onUnpin={unpinSession}
              onReorder={reorderPinnedSessions}
              renamingKey={renamingKey}
              renamePrefix="pinned"
              onStartRename={(key) => setRenamingKey(key)}
              onFinishRename={handleRename}
              onAutoRename={handleAutoRename}
              onCancelRename={() => setRenamingKey(null)}
            />
          </div>
        )}

        {/* Watching sessions */}
        {watchingSessions.length > 0 && (
          <div style={{ margin: '20px 8px 0' }}>
            <div style={{ paddingLeft: 5, marginBottom: 3 }}>
              <span className="text-[10px] font-semibold text-text-muted uppercase tracking-[0.08em]">Watching</span>
            </div>
            <nav className="flex flex-col gap-px">
              {watchingSessions.map((info) => {
                const s = sessions[info.sessionId]
                return (
                  <SessionItem
                    key={info.sessionId}
                    info={info}
                    active={info.sessionId === activeSessionId}
                    isRunning={s?.status?.state === 'running'}
                    isSdkActive={s?.sdkActive}
                    isWatching={s?.isWatching}
                    needsAttention={s?.needsAttention}
                    onClick={() => handleClickSession(info)}
                    onToggleWatch={() => handleToggleWatch(info)}
                    isRenaming={renamingKey === `watching:${info.sessionId}`}
                    onStartRename={() => setRenamingKey(`watching:${info.sessionId}`)}
                    onFinishRename={(title) => handleRename(info.sessionId, title)}
                    onAutoRename={() => handleAutoRename(info.sessionId)}
                    onCancelRename={() => setRenamingKey(null)}
                  />
                )
              })}
            </nav>
          </div>
        )}

        {/* Recent sessions */}
        {recentSessions.length > 0 && (
          <div style={{ margin: '20px 8px 0' }}>
            <div style={{ paddingLeft: 5, marginBottom: 3 }}>
              <span className="text-[10px] font-semibold text-text-muted uppercase tracking-[0.08em]">Recent</span>
            </div>
            <nav className="flex flex-col gap-px">
              {recentSessions.map((info) => {
                const s = sessions[info.sessionId]
                return (
                  <SessionItem
                    key={info.sessionId}
                    info={info}
                    active={info.sessionId === activeSessionId}
                    isRunning={s?.status?.state === 'running'}
                    isSdkActive={s?.sdkActive}
                    isWatching={s?.isWatching}
                    needsAttention={s?.needsAttention}
                    onClick={() => handleClickSession(info)}
                    onToggleWatch={info.projectKey ? () => handleToggleWatch(info) : undefined}
                    onPin={() => pinSession(info.sessionId)}
                    onRemove={() => {
                      if (worktreeInfoMap[info.sessionId]) {
                        setCleanupWorktree({ sessionId: info.sessionId, worktreeInfo: worktreeInfoMap[info.sessionId] })
                      } else {
                        removeRecentSession(info.sessionId)
                      }
                    }}
                    isRenaming={renamingKey === `recent:${info.sessionId}`}
                    onStartRename={() => setRenamingKey(`recent:${info.sessionId}`)}
                    onFinishRename={(title) => handleRename(info.sessionId, title)}
                    onAutoRename={() => handleAutoRename(info.sessionId)}
                    onCancelRename={() => setRenamingKey(null)}
                  />
                )
              })}
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
                  onSessionDoubleClick={(info) => { if (!pinnedSessionIds.includes(info.sessionId)) addRecentSession(info.sessionId) }}
                  onToggleWatch={handleToggleWatch}
                  onViewWorktrees={() => setWorktreesModalCwd(group.cwd)}
                  renamingKey={renamingKey}
                  renamePrefix={`project:${group.projectKey || group.cwd}`}
                  onStartRename={(key) => setRenamingKey(key)}
                  onFinishRename={handleRename}
                  onAutoRename={handleAutoRename}
                  onCancelRename={() => setRenamingKey(null)}
                />
              ))}
            </nav>
          </div>
        )}
      </div>

      {/* Settings panel + Footer */}
      <SettingsPanel />

      {/* Worktrees management modal */}
      {worktreesModalCwd && (
        <WorktreesModal cwd={worktreesModalCwd} onClose={() => setWorktreesModalCwd(null)} />
      )}

      {/* Worktree cleanup modal (on session removal) */}
      {cleanupWorktree && (
        <WorktreeCleanupModal
          worktreeInfo={cleanupWorktree.worktreeInfo}
          onKeep={() => {
            removeRecentSession(cleanupWorktree.sessionId)
            setCleanupWorktree(null)
          }}
          onRemove={() => {
            clearWorktreeInfo(cleanupWorktree.sessionId)
            removeRecentSession(cleanupWorktree.sessionId)
            setCleanupWorktree(null)
          }}
          onCancel={() => setCleanupWorktree(null)}
        />
      )}
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
  onSessionDoubleClick,
  onToggleWatch,
  onViewWorktrees,
  renamingKey,
  renamePrefix,
  onStartRename,
  onFinishRename,
  onAutoRename,
  onCancelRename
}: {
  group: DirectoryGroup
  expanded: boolean
  activeSessionId: string | null
  sessions: Record<string, { status?: { state: string }; sdkActive?: boolean; isWatching?: boolean; needsAttention?: boolean }>
  onClick: () => void
  onDoubleClick: () => void
  onSessionClick: (info: SessionInfo) => void
  onSessionDoubleClick: (info: SessionInfo) => void
  onToggleWatch: (info: SessionInfo) => void
  onViewWorktrees?: () => void
  renamingKey: string | null
  renamePrefix: string
  onStartRename: (key: string) => void
  onFinishRename: (id: string, title: string) => void
  onAutoRename: (id: string) => void
  onCancelRename: () => void
}): React.JSX.Element {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)

  const handleContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    setContextMenu(contextMenuPosition(e))
  }

  useEffect(() => {
    if (!contextMenu) return
    const handler = (e: MouseEvent): void => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [contextMenu])

  return (
    <div>
      <div
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onContextMenu={handleContextMenu}
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
          {group.sessions.map((info) => {
            const s = sessions[info.sessionId]
            return (
              <SessionItem
                key={info.sessionId}
                info={info}
                active={info.sessionId === activeSessionId}
                isRunning={s?.status?.state === 'running'}
                isSdkActive={s?.sdkActive}
                isWatching={s?.isWatching}
                needsAttention={s?.needsAttention}
                onClick={() => onSessionClick(info)}
                onDoubleClick={() => onSessionDoubleClick(info)}
                onToggleWatch={() => onToggleWatch(info)}
                isRenaming={renamingKey === `${renamePrefix}:${info.sessionId}`}
                onStartRename={() => onStartRename(`${renamePrefix}:${info.sessionId}`)}
                onFinishRename={(title) => onFinishRename(info.sessionId, title)}
                onAutoRename={() => onAutoRename(info.sessionId)}
                onCancelRename={onCancelRename}
              />
            )
          })}
        </div>
      )}

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 min-w-[160px] py-1 rounded-lg bg-bg-tertiary border border-border shadow-lg"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {onViewWorktrees && (
            <button
              onClick={() => { setContextMenu(null); onViewWorktrees() }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors text-left cursor-default"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-text-muted">
                <circle cx="12" cy="18" r="3" />
                <circle cx="6" cy="6" r="3" />
                <circle cx="18" cy="6" r="3" />
                <path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" />
                <path d="M12 12v3" />
              </svg>
              View worktrees
            </button>
          )}
          <button
            onClick={() => {
              setContextMenu(null)
              onDoubleClick()
            }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors text-left cursor-default"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="shrink-0 text-text-muted">
              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
              <path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4z" />
            </svg>
            New session here
          </button>
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
  needsAttention,
  onClick,
  onDoubleClick,
  onToggleWatch,
  onPin,
  onUnpin,
  onRemove,
  isRenaming,
  onStartRename,
  onFinishRename,
  onCancelRename,
  onAutoRename,
  draggable,
  onDragStart,
  onDragOver,
  onDragEnd,
  onDrop
}: {
  info: SessionInfo
  active: boolean
  isRunning?: boolean
  isSdkActive?: boolean
  isWatching?: boolean
  needsAttention?: boolean
  onClick: () => void
  onDoubleClick?: () => void
  onToggleWatch?: () => void
  onPin?: () => void
  onUnpin?: () => void
  onRemove?: () => void
  isRenaming?: boolean
  onStartRename?: () => void
  onFinishRename?: (title: string) => void
  onCancelRename?: () => void
  onAutoRename?: () => void
  draggable?: boolean
  onDragStart?: (e: React.DragEvent) => void
  onDragOver?: (e: React.DragEvent) => void
  onDragEnd?: (e: React.DragEvent) => void
  onDrop?: (e: React.DragEvent) => void
}): React.JSX.Element {
  const isWorktree = useSessionStore((s) => !!s.worktreeInfoMap[info.sessionId])
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const renameRef = useRef<HTMLInputElement>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const renameCommittedRef = useRef(false)
  const [permissionsOpen, setPermissionsOpen] = useState(false)

  const dotColor = needsAttention && !active
    ? 'bg-warning animate-pulse'
    : isRunning
      ? 'bg-green-400 animate-pulse'
      : isSdkActive
        ? 'bg-green-400'
        : isWatching
          ? 'bg-blue-400'
          : 'bg-text-muted/30'

  const handleContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    setContextMenu(contextMenuPosition(e))
  }

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return
    const handler = (e: MouseEvent): void => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [contextMenu])

  // Focus rename input when entering rename mode
  useEffect(() => {
    if (isRenaming && renameRef.current) {
      renameCommittedRef.current = false
      setRenameValue('')
      renameRef.current.focus()
    }
  }, [isRenaming])

  const handleRenameKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      renameCommittedRef.current = true
      onFinishRename?.(renameValue)
    } else if (e.key === 'Escape') {
      renameCommittedRef.current = true
      onCancelRename?.()
    }
  }

  return (
    <>
      <div
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onContextMenu={handleContextMenu}
        draggable={draggable}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDrop={onDrop}
        style={{ padding: '0 5px' }}
        className={`
          group flex items-center gap-2.5 h-8 rounded-md text-[13px] cursor-default transition-colors
          ${active ? 'text-text-primary bg-bg-tertiary' : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover'}
        `}
      >
        <span className="shrink-0 w-[14px] h-[14px] flex items-center justify-center">
          <span className={`inline-block w-[6px] h-[6px] rounded-full ${dotColor} ${onRemove ? 'group-hover:hidden' : ''}`} />
          {onRemove && (
            <span
              onClick={(e) => { e.stopPropagation(); onRemove() }}
              className="hidden group-hover:flex items-center justify-center w-[14px] h-[14px] rounded text-text-muted hover:text-text-primary transition-colors cursor-pointer"
              title="Remove from recent"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M18 6L6 18" />
                <path d="M6 6l12 12" />
              </svg>
            </span>
          )}
        </span>
        {isRenaming ? (
          <input
            ref={renameRef}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={handleRenameKeyDown}
            onBlur={() => { setTimeout(() => { if (!renameCommittedRef.current) onCancelRename?.() }, 0) }}
            placeholder="Enter to auto-generate"
            className="flex-1 min-w-0 bg-transparent border-b border-accent text-[13px] text-text-primary outline-none placeholder:text-text-muted/50"
          />
        ) : (
          <span className="truncate flex-1">{info.title}</span>
        )}
      {/* Worktree indicator */}
      {isWorktree && (
        <span className="shrink-0 text-mode-edit opacity-60" title="Worktree session">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="18" r="3" />
            <circle cx="6" cy="6" r="3" />
            <circle cx="18" cy="6" r="3" />
            <path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" />
            <path d="M12 12v3" />
          </svg>
        </span>
      )}
      {/* Pin/Unpin button */}
      {onPin && (
        <span
          onClick={(e) => { e.stopPropagation(); onPin() }}
          className="shrink-0 opacity-0 group-hover:opacity-50 text-text-muted hover:!opacity-80 transition-opacity cursor-pointer"
          title="Pin session"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 17v5" />
            <path d="M5 17h14v-1.76a2 2 0 00-1.11-1.79l-1.78-.9A2 2 0 0115 10.76V6h1a2 2 0 000-4H8a2 2 0 000 4h1v4.76a2 2 0 01-1.11 1.79l-1.78.9A2 2 0 005 15.24z" />
          </svg>
        </span>
      )}
      {onUnpin && (
        <span
          onClick={(e) => { e.stopPropagation(); onUnpin() }}
          className="shrink-0 opacity-0 group-hover:opacity-50 text-text-muted hover:!opacity-80 transition-opacity cursor-pointer"
          title="Unpin session"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 17v5" />
            <path d="M5 17h14v-1.76a2 2 0 00-1.11-1.79l-1.78-.9A2 2 0 0115 10.76V6h1a2 2 0 000-4H8a2 2 0 000 4h1v4.76a2 2 0 01-1.11 1.79l-1.78.9A2 2 0 005 15.24z" />
          </svg>
        </span>
      )}
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
    {contextMenu && (
      <div
        ref={contextMenuRef}
        className="fixed z-[9999] py-1 rounded-lg bg-bg-tertiary border border-border shadow-lg grid"
        style={{ left: contextMenu.x, top: contextMenu.y }}
      >
        <button
          onClick={() => {
            setContextMenu(null)
            onStartRename?.()
          }}
          className="w-full text-left px-3 py-1.5 text-[13px] text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-default"
        >
          Rename session
        </button>
        <button
          onClick={() => {
            setContextMenu(null)
            onAutoRename?.()
          }}
          className="w-full text-left px-3 py-1.5 text-[13px] text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-default"
        >
          Auto rename
        </button>
        <button
          onClick={() => {
            setContextMenu(null)
            setPermissionsOpen(true)
          }}
          className="w-full text-left px-3 py-1.5 text-[13px] text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-default"
        >
          Edit permissions
        </button>
        {isSdkActive && (
          <button
            onClick={() => {
              setContextMenu(null)
              window.api.cancelSession(info.sessionId)
            }}
            className="w-full text-left px-3 py-1.5 text-[13px] text-red-400 hover:bg-bg-hover hover:text-red-300 transition-colors cursor-default"
          >
            Disconnect
          </button>
        )}
      </div>
    )}
    <PermissionsDialog
      open={permissionsOpen}
      onClose={() => setPermissionsOpen(false)}
      cwd={info.cwd}
    />
  </>
  )
}

function PinnedSessionList({
  pinnedSessions,
  activeSessionId,
  sessions,
  onClickSession,
  onToggleWatch,
  onUnpin,
  onReorder,
  renamingKey,
  renamePrefix,
  onStartRename,
  onFinishRename,
  onAutoRename,
  onCancelRename
}: {
  pinnedSessions: SessionInfo[]
  activeSessionId: string | null
  sessions: Record<string, { status?: { state: string }; sdkActive?: boolean; isWatching?: boolean; needsAttention?: boolean }>
  onClickSession: (info: SessionInfo) => void
  onToggleWatch: (info: SessionInfo) => void
  onUnpin: (routingId: string) => void
  onReorder: (ids: string[]) => void
  renamingKey: string | null
  renamePrefix: string
  onStartRename: (key: string) => void
  onFinishRename: (id: string, title: string) => void
  onAutoRename: (id: string) => void
  onCancelRename: () => void
}): React.JSX.Element {
  const dragItemRef = useRef<number | null>(null)
  const dragOverRef = useRef<number | null>(null)

  const handleDragStart = useCallback((idx: number) => (e: React.DragEvent) => {
    dragItemRef.current = idx
    e.dataTransfer.effectAllowed = 'move'
    ;(e.currentTarget as HTMLElement).style.opacity = '0.5'
  }, [])

  const handleDragOver = useCallback((idx: number) => (e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    dragOverRef.current = idx
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const from = dragItemRef.current
    const to = dragOverRef.current
    if (from == null || to == null || from === to) return
    const ids = pinnedSessions.map((s) => s.sessionId)
    const [moved] = ids.splice(from, 1)
    ids.splice(to, 0, moved)
    onReorder(ids)
    dragItemRef.current = null
    dragOverRef.current = null
  }, [pinnedSessions, onReorder])

  const handleDragEnd = useCallback((e: React.DragEvent) => {
    ;(e.currentTarget as HTMLElement).style.opacity = '1'
    dragItemRef.current = null
    dragOverRef.current = null
  }, [])

  return (
    <nav className="flex flex-col gap-px">
      {pinnedSessions.map((info, idx) => {
        const s = sessions[info.sessionId]
        return (
          <SessionItem
            key={info.sessionId}
            info={info}
            active={info.sessionId === activeSessionId}
            isRunning={s?.status?.state === 'running'}
            isSdkActive={s?.sdkActive}
            isWatching={s?.isWatching}
            needsAttention={s?.needsAttention}
            onClick={() => onClickSession(info)}
            onToggleWatch={info.projectKey ? () => onToggleWatch(info) : undefined}
            onUnpin={() => onUnpin(info.sessionId)}
            isRenaming={renamingKey === `${renamePrefix}:${info.sessionId}`}
            onStartRename={() => onStartRename(`${renamePrefix}:${info.sessionId}`)}
            onFinishRename={(title) => onFinishRename(info.sessionId, title)}
            onAutoRename={() => onAutoRename(info.sessionId)}
            onCancelRename={onCancelRename}
            draggable
            onDragStart={handleDragStart(idx)}
            onDragOver={handleDragOver(idx)}
            onDrop={handleDrop}
            onDragEnd={handleDragEnd}
          />
        )
      })}
    </nav>
  )
}

function NavItem({ label, icon, active, onClick, onDoubleClick, badge }: {
  label: string
  icon: React.ReactNode
  active?: boolean
  onClick?: () => void
  onDoubleClick?: () => void
  badge?: number
}): React.JSX.Element {
  return (
    <div
      style={{ padding: '0 5px' }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className={`
        flex items-center gap-2.5 h-8 rounded-md text-[13px] cursor-default transition-colors
        ${active ? 'text-text-primary bg-bg-tertiary' : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover'}
      `}
    >
      <span className="shrink-0 text-text-muted">{icon}</span>
      <span className="truncate flex-1">{label}</span>
      {badge != null && badge > 0 && (
        <span className="shrink-0 min-w-[16px] h-4 px-1 flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-semibold leading-none">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </div>
  )
}

function SettingsPanel(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const settings = useSessionStore((s) => s.settings)
  const updateSettings = useSessionStore((s) => s.updateSettings)
  const panelRef = useRef<HTMLDivElement>(null)

  // Listen for 'open-settings' custom events (e.g. from sandbox pill in InputBox)
  useEffect(() => {
    const handler = (): void => setDialogOpen(true)
    window.addEventListener('open-settings', handler)
    return () => window.removeEventListener('open-settings', handler)
  }, [])

  // Close popup on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent): void => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div ref={panelRef}>
      {open && (
        <div className="border-t border-border/50 px-2 py-1 bg-white/5 rounded-t-lg">
          {/* Theme selector */}
          <div className="px-3 pt-2 pb-1">
            <div className="text-[11px] text-text-muted uppercase tracking-wider mb-1">Theme</div>
            <div className="flex items-center gap-1 mb-1 bg-bg-primary/50 rounded-md p-0.5">
              {(['dark', 'light', 'monokai'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => updateSettings({ theme: t })}
                  className={`flex-1 text-[11px] py-1 rounded transition-colors capitalize ${settings.theme === t ? 'bg-accent/20 text-accent' : 'text-text-muted hover:text-text-secondary hover:bg-white/5'}`}
                >
                  {t === 'monokai' ? 'Monokai' : t.charAt(0).toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
          </div>
          {/* Tool output toggles */}
          <SettingsToggle
            label="Expand tool calls"
            checked={settings.expandToolCalls}
            onChange={(v) => updateSettings({ expandToolCalls: v })}
          />
          {settings.expandToolCalls && (
            <div className="pl-4">
              <SettingsToggle
                label="Include read results"
                checked={settings.expandReadResults}
                onChange={(v) => updateSettings({ expandReadResults: v })}
              />
            </div>
          )}
          <SettingsToggle
            label="Hide tool input"
            checked={settings.hideToolInput}
            onChange={(v) => updateSettings({ hideToolInput: v })}
          />
          <SettingsToggle
            label="Expand thinking"
            checked={settings.expandThinking}
            onChange={(v) => updateSettings({ expandThinking: v })}
          />
          {/* All Settings button */}
          <button
            onClick={() => {
              setOpen(false)
              setDialogOpen(true)
            }}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 mt-1 mb-0.5 text-[12px] text-text-muted hover:text-accent transition-colors cursor-default border-t border-border/30 pt-2"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
            </svg>
            All Settings…
          </button>
        </div>
      )}
      <div style={{ padding: '8px 16px' }} className="border-t border-border/50 flex items-center gap-2.5 text-[11px] text-text-muted">
        <UsageRing />
        <button
          onClick={() => setOpen(!open)}
          className="flex items-center justify-center w-6 h-6 rounded-md hover:bg-bg-hover transition-colors cursor-default ml-auto"
          title="Settings"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-text-muted">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
          </svg>
        </button>
      </div>
      {dialogOpen && <SettingsDialog onClose={() => setDialogOpen(false)} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Usage Ring + Panel
// ---------------------------------------------------------------------------

function getUsageColor(pct: number): string {
  if (pct >= 80) return '#ef4444' // red
  if (pct >= 50) return '#eab308' // yellow
  return '#22c55e' // green
}

function formatResetTime(resetsAt: string | null): string {
  if (!resetsAt) return ''
  const reset = new Date(resetsAt)
  const now = Date.now()
  const diffMs = reset.getTime() - now
  if (diffMs <= 0) return 'resetting...'
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 60) return `resets in ${mins}m`
  const hrs = Math.floor(mins / 60)
  const remMins = mins % 60
  return remMins > 0 ? `resets in ${hrs}h ${remMins}m` : `resets in ${hrs}h`
}

function formatPlanName(tier: string | null): string {
  if (!tier) return ''
  // e.g. "default_claude_max_5x" → "Max 5x"
  const m = tier.match(/claude[_ ]?(pro|max)(?:[_ ]?(\d+x))?/i)
  if (m) {
    const plan = m[1].charAt(0).toUpperCase() + m[1].slice(1)
    return m[2] ? `${plan} ${m[2]}` : plan
  }
  return tier
}

function UsageProgressBar({ label, window: w }: { label: string; window: RateWindow }): React.JSX.Element {
  const pct = Math.round(w.usedPercent)
  const color = getUsageColor(pct)
  const resetStr = formatResetTime(w.resetsAt)

  return (
    <div className="mb-2 last:mb-0">
      <div className="flex items-center justify-between mb-0.5">
        <span className="text-[10px] text-text-secondary font-medium">{label}</span>
        <span className="text-[10px] text-text-muted font-mono">{pct}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${Math.min(100, pct)}%`, backgroundColor: color }}
        />
      </div>
      {resetStr && (
        <div className="text-[9px] text-text-muted mt-0.5">{resetStr}</div>
      )}
    </div>
  )
}

function ExtraUsageBar({ extra }: { extra: ExtraUsage }): React.JSX.Element | null {
  if (!extra.isEnabled) return null

  const pct = Math.round(extra.utilization)
  const color = getUsageColor(pct)
  const usedDollars = (extra.usedCredits / 100).toFixed(2)

  // unlimited vs capped
  const limitStr = extra.monthlyLimit !== null
    ? `$${usedDollars} / $${(extra.monthlyLimit / 100).toFixed(2)}`
    : `$${usedDollars} used`

  return (
    <div className="mb-2 last:mb-0">
      <div className="flex items-center justify-between mb-0.5">
        <span className="text-[10px] text-text-secondary font-medium">Extra Usage</span>
        <span className="text-[10px] text-text-muted font-mono">{limitStr}</span>
      </div>
      {extra.monthlyLimit !== null && (
        <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{ width: `${Math.min(100, pct)}%`, backgroundColor: color }}
          />
        </div>
      )}
    </div>
  )
}

function UsagePanel({ usage, onRefresh }: { usage: AccountUsage; onRefresh: () => void }): React.JSX.Element {
  const plan = formatPlanName(usage.planName)
  const ago = Math.round((Date.now() - usage.fetchedAt) / 1000)
  const agoStr = ago < 60 ? `${ago}s ago` : `${Math.floor(ago / 60)}m ago`
  const blockUsage = useSessionStore((s) => s.blockUsage)
  const setShowUsageView = useSessionStore((s) => s.setShowUsageView)

  const currentBlock = blockUsage?.currentBlock

  // Format block summary
  let blockSummary: string | null = null
  if (currentBlock) {
    const total = currentBlock.tokens.inputTokens + currentBlock.tokens.outputTokens +
      currentBlock.tokens.cacheCreationTokens + currentBlock.tokens.cacheReadTokens
    const tokStr = total >= 1_000_000 ? `${(total / 1_000_000).toFixed(1)}M` : total >= 1_000 ? `${(total / 1_000).toFixed(1)}K` : String(total)
    const costStr = currentBlock.costUsd >= 0.01 ? `$${currentBlock.costUsd.toFixed(2)}` : '$0.00'
    const burnStr = currentBlock.burnRate ? `${currentBlock.burnRate.tokensPerMin} tok/min` : ''
    blockSummary = `${tokStr} tok · ${costStr}${burnStr ? ` · ${burnStr}` : ''}`
  }

  return (
    <div className="absolute bottom-full left-0 mb-1 w-[220px] bg-bg-secondary border border-border rounded-lg shadow-lg p-3 z-50">
      {usage.error ? (
        <div className="text-[10px] text-red-400">{usage.error}</div>
      ) : (
        <>
          <UsageProgressBar label="5-Hour Session" window={usage.fiveHour} />
          {usage.sevenDay && <UsageProgressBar label="7-Day (all models)" window={usage.sevenDay} />}
          {usage.sevenDayOpus && <UsageProgressBar label="7-Day Opus" window={usage.sevenDayOpus} />}
          {usage.sevenDaySonnet && <UsageProgressBar label="7-Day Sonnet" window={usage.sevenDaySonnet} />}
          {usage.extraUsage && <ExtraUsageBar extra={usage.extraUsage} />}
        </>
      )}
      {/* Block usage summary */}
      {blockSummary && (
        <div className="mt-2 pt-1.5 border-t border-border/30">
          <div className="text-[9px] text-text-muted mb-0.5">Current block</div>
          <div className="text-[10px] text-text-secondary font-mono">{blockSummary}</div>
        </div>
      )}
      <div className="flex items-center justify-between mt-2 pt-1.5 border-t border-border/30">
        <div className="flex items-center gap-1.5">
          {plan && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-accent/15 text-accent font-medium">{plan}</span>
          )}
          <span className="text-[9px] text-text-muted">{agoStr}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={(e) => { e.stopPropagation(); setShowUsageView(true) }}
            className="text-[9px] text-accent hover:text-accent/80 cursor-default"
            title="View usage analytics"
          >
            Details →
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onRefresh() }}
            className="flex items-center justify-center w-5 h-5 rounded hover:bg-bg-hover transition-colors cursor-default"
            title="Refresh usage"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-text-muted">
              <path d="M23 4v6h-6" />
              <path d="M1 20v-6h6" />
              <path d="M3.51 9a9 9 0 0114.85-3.36L23 10" />
              <path d="M20.49 15a9 9 0 01-14.85 3.36L1 14" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}

function UsageRing(): React.JSX.Element {
  const usage = useSessionStore((s) => s.accountUsage)
  const [showPanel, setShowPanel] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const ringRef = useRef<HTMLDivElement>(null)

  // Close panel on outside click
  useEffect(() => {
    if (!showPanel) return
    const handler = (e: MouseEvent): void => {
      if (ringRef.current && !ringRef.current.contains(e.target as Node)) {
        setShowPanel(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showPanel])

  const handleRefresh = (): void => {
    setIsRefreshing(true)
    window.api.fetchAccountUsage().then((data) => {
      useSessionStore.getState().setAccountUsage(data)
    }).catch(() => {}).finally(() => {
      setIsRefreshing(false)
    })
  }

  // SVG ring params
  const size = 24
  const strokeWidth = 2.5
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const pct = usage?.error ? 0 : (usage?.fiveHour.usedPercent ?? 0)
  const dashOffset = circumference - (circumference * Math.min(100, pct)) / 100
  const color = usage && !usage.error ? getUsageColor(pct) : '#6b7280' // grey when no data
  const displayText = usage && !usage.error ? `${Math.round(pct)}` : (usage?.error ? '!' : '—')

  return (
    <div ref={ringRef} className="relative flex items-center gap-2">
      <button
        onClick={() => setShowPanel(!showPanel)}
        className="relative flex items-center justify-center cursor-default hover:opacity-80 transition-opacity"
        title={usage?.error || `5hr usage: ${Math.round(pct)}%`}
      >
        <svg width={size} height={size} className={isRefreshing ? 'animate-spin' : ''}>
          {/* Background track */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth={strokeWidth}
            className="text-white/10"
          />
          {/* Progress arc */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
            className="transition-all duration-500"
          />
        </svg>
        <span
          className="absolute inset-0 flex items-center justify-center font-mono font-semibold select-none"
          style={{ fontSize: displayText.length > 2 ? '7px' : '8px', color }}
        >
          {displayText}
        </span>
      </button>
      <span className="text-[10px] text-text-muted select-none">
        {usage && !usage.error
          ? formatResetTime(usage.fiveHour.resetsAt)
          : 'Usage'}
      </span>
      {showPanel && usage && <UsagePanel usage={usage} onRefresh={handleRefresh} />}
    </div>
  )
}
