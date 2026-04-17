import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { v4 as uuid } from 'uuid'
import { useSessionStore, buildTodosFromMessages } from '../../stores/session-store'
import type { ChatMessage, DirectoryGroup, SessionInfo, WorktreeInfo } from '../../../../shared/types'

/** Lightweight projection of session data needed by the sidebar for structural/display decisions */
type SidebarSessionData = {
  cwd: string
  isWatching: boolean
  firstUserText?: string
}
import { WorktreesModal } from '../WorktreesModal'
import { WorktreeCleanupModal } from '../WorktreeCleanupModal'
import { useAutomationStore } from '../../stores/automation-store'
import { useIsMobile } from '../../hooks/useIsMobile'
import { NavItem, SafeSvgIcon } from './NavItem'
import { DirectoryItem } from './DirectoryItem'
import { SessionItem } from './SessionItem'
import { PinnedSessionList } from './PinnedSessionList'
import { SettingsPanel } from './SettingsPanel'
import { DeleteConfirmModal } from './DeleteConfirmModal'

/** Structural equality for the sidebar session projection — avoids re-renders from unrelated session changes */
function sidebarSessionsEqual(a: Record<string, SidebarSessionData>, b: Record<string, SidebarSessionData>): boolean {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    const av = a[key], bv = b[key]
    if (!bv) return false
    if (av.cwd !== bv.cwd || av.isWatching !== bv.isWatching || av.firstUserText !== bv.firstUserText) return false
  }
  return true
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
  // Narrow projection: only extract fields the sidebar needs for structure/display.
  // Uses ref-based caching to prevent re-renders from streaming text, message updates, etc.
  const sidebarSessionsRef = useRef<Record<string, SidebarSessionData>>({})
  const sidebarSessions = useSessionStore((s) => {
    const result: Record<string, SidebarSessionData> = {}
    for (const [id, sess] of Object.entries(s.sessions)) {
      const firstUser = sess.messages.find((m) => m.role === 'user')
      result[id] = {
        cwd: sess.cwd,
        isWatching: !!sess.isWatching,
        firstUserText: firstUser?.content.find((b) => b.type === 'text')?.text?.slice(0, 80)?.replace(/\n/g, ' ')?.trim()
      }
    }
    // Return cached ref if structurally equal — prevents unnecessary re-renders
    if (sidebarSessionsEqual(sidebarSessionsRef.current, result)) {
      return sidebarSessionsRef.current
    }
    sidebarSessionsRef.current = result
    return result
  })
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
  const hiddenSessionIds = useSessionStore((s) => s.hiddenSessionIds)
  const hiddenProjectKeys = useSessionStore((s) => s.hiddenProjectKeys)
  const hideSession = useSessionStore((s) => s.hideSession)
  const unhideSession = useSessionStore((s) => s.unhideSession)
  const hideProject = useSessionStore((s) => s.hideProject)
  const unhideProject = useSessionStore((s) => s.unhideProject)
  const deleteSessionAction = useSessionStore((s) => s.deleteSession)
  const deleteProjectAction = useSessionStore((s) => s.deleteProject)

  const isMobile = useIsMobile()
  const [expandedDir, setExpandedDir] = useState<string | null>(null)
  const [worktreesModalCwd, setWorktreesModalCwd] = useState<string | null>(null)
  const [cleanupWorktree, setCleanupWorktree] = useState<{ sessionId: string; worktreeInfo: WorktreeInfo } | null>(null)
  const [renamingKey, setRenamingKey] = useState<string | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<
    | { kind: 'session'; sessionId: string; projectKey: string; title: string }
    | { kind: 'project'; projectKey: string; folderName: string; sessionCount: number }
    | null
  >(null)

  const hiddenSessionSet = useMemo(() => new Set(hiddenSessionIds), [hiddenSessionIds])
  const hiddenProjectSet = useMemo(() => new Set(hiddenProjectKeys), [hiddenProjectKeys])
  const hasAnyHidden = hiddenSessionIds.length > 0 || hiddenProjectKeys.length > 0

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
    let session = useSessionStore.getState().sessions[sessionId]
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
  }, [directories, setCustomTitle, applyTitle, loadHistoricalSession])

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
  const activeView = useSessionStore((s) => s.activeView)
  const setActiveView = useSessionStore((s) => s.setActiveView)
  const pluginViews = useSessionStore((s) => s.pluginViews)
  const automationBadge = useAutomationStore((s) => s.notificationBadge)

  const handleNewSession = (): void => {
    showWelcome()
    if (isMobile && onToggleCollapse) onToggleCollapse()
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
    if (useSessionStore.getState().sessions[routingId]) {
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
    // Close drawer on mobile after selecting a session
    if (isMobile && onToggleCollapse) onToggleCollapse()
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
    const session = useSessionStore.getState().sessions[routingId]
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
  const resolveSessionInfo = useCallback((rid: string): SessionInfo | undefined => {
    let info: SessionInfo | undefined
    for (const group of directories) {
      info = group.sessions.find((s) => s.sessionId === rid)
      if (info) break
    }
    if (!info) {
      const data = sidebarSessions[rid]
      if (data) {
        info = {
          sessionId: rid,
          cwd: data.cwd,
          projectKey: '',
          title: data.firstUserText || 'New session',
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
  }, [directories, sidebarSessions, customTitles])

  // Memoize derived lists — only recompute when their inputs change
  const pinnedSet = useMemo(() => new Set(pinnedSessionIds), [pinnedSessionIds])

  const pinnedSessions = useMemo(() => {
    const result: SessionInfo[] = []
    for (const rid of pinnedSessionIds) {
      if (!showHidden && hiddenSessionSet.has(rid)) continue
      const info = resolveSessionInfo(rid)
      if (info) result.push(info)
    }
    return result
  }, [pinnedSessionIds, resolveSessionInfo, hiddenSessionSet, showHidden])

  const recentSessions = useMemo(() => {
    const result: SessionInfo[] = []
    for (const rid of recentSessionIds) {
      if (result.length >= maxRecentSessions) break
      if (pinnedSet.has(rid)) continue
      if (!showHidden && hiddenSessionSet.has(rid)) continue
      const info = resolveSessionInfo(rid)
      if (info) result.push(info)
    }
    return result
  }, [recentSessionIds, maxRecentSessions, pinnedSet, resolveSessionInfo, hiddenSessionSet, showHidden])

  const watchingSessions = useMemo(() => {
    const recentSet = new Set(recentSessionIds)
    const result: SessionInfo[] = []
    for (const [rid, data] of Object.entries(sidebarSessions)) {
      if (!data.isWatching) continue
      if (pinnedSet.has(rid) || recentSet.has(rid)) continue
      if (!showHidden && hiddenSessionSet.has(rid)) continue
      const info = resolveSessionInfo(rid)
      if (info) result.push(info)
    }
    return result
  }, [sidebarSessions, recentSessionIds, pinnedSet, resolveSessionInfo, hiddenSessionSet, showHidden])

  const handleHideSession = useCallback((info: SessionInfo) => {
    hideSession(info.sessionId)
  }, [hideSession])

  const handleUnhideSession = useCallback((info: SessionInfo) => {
    unhideSession(info.sessionId)
  }, [unhideSession])

  const handleDeleteSessionRequest = useCallback((info: SessionInfo) => {
    if (!info.projectKey) return
    setDeleteTarget({
      kind: 'session',
      sessionId: info.sessionId,
      projectKey: info.projectKey,
      title: info.title
    })
  }, [])

  const handleDeleteProjectRequest = useCallback((group: DirectoryGroup) => {
    if (!group.projectKey) return
    setDeleteTarget({
      kind: 'project',
      projectKey: group.projectKey,
      folderName: group.folderName,
      sessionCount: group.sessions.length
    })
  }, [])

  const confirmDelete = useCallback(async (): Promise<void> => {
    if (!deleteTarget) return
    if (deleteTarget.kind === 'session') {
      await deleteSessionAction(deleteTarget.sessionId, deleteTarget.projectKey)
    } else {
      await deleteProjectAction(deleteTarget.projectKey)
    }
    setDeleteTarget(null)
    // Refresh sidebar from disk so the deleted entries disappear immediately
    window.api.listDirectories().then(setDirectories)
  }, [deleteTarget, deleteSessionAction, deleteProjectAction, setDirectories])

  const augmentedDirs = useMemo(() => {
    // Build set of session IDs already on disk
    const dirSessionIds = new Set<string>()
    for (const group of directories) {
      for (const s of group.sessions) dirSessionIds.add(s.sessionId)
    }

    // Collect in-memory sessions not yet on disk
    const inMemoryByDir: Record<string, SessionInfo[]> = {}
    for (const [rid, data] of Object.entries(sidebarSessions)) {
      if (dirSessionIds.has(rid) || !data.cwd) continue
      const info: SessionInfo = {
        sessionId: rid,
        cwd: data.cwd,
        projectKey: '',
        title: data.firstUserText || 'New session',
        timestamp: Date.now(),
        lastActivityAt: Date.now()
      }
      const key = data.cwd
      if (!inMemoryByDir[key]) inMemoryByDir[key] = []
      inMemoryByDir[key].push(info)
    }

    // Apply custom titles to a session list
    const applyCustomTitles = (sessions: SessionInfo[]): SessionInfo[] =>
      sessions.map((s) => customTitles[s.sessionId] ? { ...s, title: customTitles[s.sessionId] } : s)

    // Merge in-memory sessions into existing groups or create new groups
    const result: DirectoryGroup[] = directories.map((group) => {
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
      result.unshift({
        cwd,
        projectKey: '',
        folderName,
        sessions: applyCustomTitles(extraSessions)
      })
    }
    return result
  }, [directories, sidebarSessions, customTitles])

  return (
    <div style={style} className={`shrink-0 h-full flex flex-col select-none ${window.api.platform === 'darwin' ? 'bg-bg-secondary/60' : 'bg-bg-secondary/85'}`}>
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
          active={activeView.type === 'automations'}
          onClick={() => {
            setActiveView(activeView.type === 'automations' ? { type: 'chat' } : { type: 'automations' })
          }}
          badge={automationBadge}
          icon={
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          }
        />
        {pluginViews.map((view) => (
          <NavItem
            key={`plugin:${view.pluginId}:${view.id}`}
            label={view.label}
            active={activeView.type === 'plugin' && activeView.pluginId === view.pluginId}
            onClick={() => {
              if (activeView.type === 'plugin' && activeView.pluginId === view.pluginId) {
                setActiveView({ type: 'chat' })
              } else {
                setActiveView({ type: 'plugin', pluginId: view.pluginId })
              }
            }}
            icon={
              view.icon ? (
                <SafeSvgIcon svg={view.icon} />
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2L2 7l10 5 10-5-10-5z" />
                  <path d="M2 17l10 5 10-5" />
                  <path d="M2 12l10 5 10-5" />
                </svg>
              )
            }
          />
        ))}
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
              hiddenSessionIds={hiddenSessionSet}
              onHideSession={handleHideSession}
              onUnhideSession={handleUnhideSession}
              onDeleteSession={handleDeleteSessionRequest}
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
                const sessionHidden = hiddenSessionSet.has(info.sessionId)
                return (
                  <SessionItem
                    key={info.sessionId}
                    info={info}
                    active={info.sessionId === activeSessionId}
                    onClick={() => handleClickSession(info)}
                    onToggleWatch={() => handleToggleWatch(info)}
                    isRenaming={renamingKey === `watching:${info.sessionId}`}
                    onStartRename={() => setRenamingKey(`watching:${info.sessionId}`)}
                    onFinishRename={(title) => handleRename(info.sessionId, title)}
                    onAutoRename={() => handleAutoRename(info.sessionId)}
                    onCancelRename={() => setRenamingKey(null)}
                    hidden={sessionHidden}
                    onHide={!sessionHidden ? () => handleHideSession(info) : undefined}
                    onUnhide={sessionHidden ? () => handleUnhideSession(info) : undefined}
                    onDelete={info.projectKey ? () => handleDeleteSessionRequest(info) : undefined}
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
                const sessionHidden = hiddenSessionSet.has(info.sessionId)
                return (
                  <SessionItem
                    key={info.sessionId}
                    info={info}
                    active={info.sessionId === activeSessionId}
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
                    hidden={sessionHidden}
                    onHide={!sessionHidden ? () => handleHideSession(info) : undefined}
                    onUnhide={sessionHidden ? () => handleUnhideSession(info) : undefined}
                    onDelete={info.projectKey ? () => handleDeleteSessionRequest(info) : undefined}
                  />
                )
              })}
            </nav>
          </div>
        )}

        {/* Projects accordion */}
        {augmentedDirs.length > 0 && (
          <div style={{ margin: '20px 8px 0' }}>
            <div style={{ paddingLeft: 5, marginBottom: 3 }} className="flex items-center justify-between pr-1">
              <span className="text-[10px] font-semibold text-text-muted uppercase tracking-[0.08em]">Projects</span>
              {hasAnyHidden && (
                <button
                  onClick={() => setShowHidden((v) => !v)}
                  className="text-[10px] text-text-muted hover:text-text-primary transition-colors cursor-default"
                  title={showHidden ? 'Hide dimmed items' : 'Show hidden items'}
                >
                  {showHidden ? 'Hide hidden' : 'Show hidden'}
                </button>
              )}
            </div>
            <nav className="flex flex-col gap-px">
              {augmentedDirs
                .filter((group) => showHidden || !hiddenProjectSet.has(group.projectKey))
                .map((group) => {
                  const projectHidden = !!group.projectKey && hiddenProjectSet.has(group.projectKey)
                  return (
                    <DirectoryItem
                      key={group.projectKey || group.cwd}
                      group={group}
                      expanded={expandedDir === (group.projectKey || group.cwd)}
                      activeSessionId={activeSessionId}
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
                      hidden={projectHidden}
                      onHide={group.projectKey && !projectHidden ? () => hideProject(group.projectKey) : undefined}
                      onUnhide={group.projectKey && projectHidden ? () => unhideProject(group.projectKey) : undefined}
                      onDelete={group.projectKey ? () => handleDeleteProjectRequest(group) : undefined}
                      hiddenSessionIds={hiddenSessionSet}
                      showHidden={showHidden}
                      onHideSession={handleHideSession}
                      onUnhideSession={handleUnhideSession}
                      onDeleteSession={handleDeleteSessionRequest}
                    />
                  )
                })}
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

      {/* Delete confirmation modal (session or project) */}
      {deleteTarget && (
        <DeleteConfirmModal
          kind={deleteTarget.kind}
          name={deleteTarget.kind === 'session' ? deleteTarget.title : deleteTarget.folderName}
          path={deleteTarget.kind === 'session'
            ? `~/.claude/projects/${deleteTarget.projectKey}/${deleteTarget.sessionId}.jsonl`
            : `~/.claude/projects/${deleteTarget.projectKey}/`
          }
          sessionCount={deleteTarget.kind === 'project' ? deleteTarget.sessionCount : undefined}
          onConfirm={confirmDelete}
          onCancel={() => setDeleteTarget(null)}
        />
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
