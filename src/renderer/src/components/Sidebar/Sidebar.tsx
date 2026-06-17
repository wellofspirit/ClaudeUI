import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { v4 as uuid } from 'uuid'
import { useSessionStore, buildTodosFromMessages } from '../../stores/session-store'
import type {
  ChatMessage,
  DirectoryGroup,
  SessionInfo,
  WorktreeInfo
} from '../../../../shared/types'
import { CODEX_CAPABILITIES } from '../../../../shared/types'
import { useAutomationStore } from '../../stores/automation-store'
import { useIsMobile } from '../../hooks/useIsMobile'
import { SidebarView, type DeleteTarget } from './View'

/** Lightweight projection of session data needed by the sidebar for structural/display decisions */
type SidebarSessionData = {
  cwd: string
  isWatching: boolean
  firstUserText?: string
}

/** Structural equality for the sidebar session projection — avoids re-renders from unrelated session changes */
function sidebarSessionsEqual(
  a: Record<string, SidebarSessionData>,
  b: Record<string, SidebarSessionData>
): boolean {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    const av = a[key],
      bv = b[key]
    if (!bv) return false
    if (
      av.cwd !== bv.cwd ||
      av.isWatching !== bv.isWatching ||
      av.firstUserText !== bv.firstUserText
    )
      return false
  }
  return true
}

export function Sidebar({
  style,
  onToggleCollapse
}: {
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
        firstUserText: firstUser?.content
          .find((b) => b.type === 'text')
          ?.text?.slice(0, 80)
          ?.replace(/\n/g, ' ')
          ?.trim()
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
  const showWelcome = useSessionStore((s) => s.showWelcome)
  const activeView = useSessionStore((s) => s.activeView)
  const setActiveView = useSessionStore((s) => s.setActiveView)
  const pluginViews = useSessionStore((s) => s.pluginViews)
  const addRecentSession = useSessionStore((s) => s.addRecentSession)
  const sessionProviders = useSessionStore((s) => s.sessionProviders)
  const automationBadge = useAutomationStore((s) => s.notificationBadge)

  const isMobile = useIsMobile()
  const [expandedDir, setExpandedDir] = useState<string | null>(null)
  const [worktreesModalCwd, setWorktreesModalCwd] = useState<string | null>(null)
  const [cleanupWorktree, setCleanupWorktree] = useState<{
    sessionId: string
    worktreeInfo: WorktreeInfo
  } | null>(null)
  const [renamingKey, setRenamingKey] = useState<string | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)

  const hiddenSessionSet = useMemo(() => new Set(hiddenSessionIds), [hiddenSessionIds])
  const hiddenProjectSet = useMemo(() => new Set(hiddenProjectKeys), [hiddenProjectKeys])
  const hasAnyHidden = hiddenSessionIds.length > 0 || hiddenProjectKeys.length > 0

  // Find the projectKey for a session from directories
  const findProjectKey = useCallback(
    (sessionId: string): string | undefined => {
      for (const group of directories) {
        if (group.sessions.some((s) => s.sessionId === sessionId)) return group.projectKey
      }
      return undefined
    },
    [directories]
  )

  // Set custom title in state and persist to JSONL
  const applyTitle = useCallback(
    (sessionId: string, title: string) => {
      setCustomTitle(sessionId, title)
      const projectKey = findProjectKey(sessionId)
      if (projectKey && title) {
        window.api.writeCustomTitle(sessionId, projectKey, title)
      }
    },
    [setCustomTitle, findProjectKey]
  )

  const handleRename = useCallback(
    async (sessionId: string, newTitle: string) => {
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
          const { messages, taskNotifications, statusLine, warnings } =
            await window.api.loadSessionHistory(sessionId, info.projectKey)
          loadHistoricalSession(
            sessionId,
            messages,
            info.cwd,
            taskNotifications,
            {},
            statusLine,
            warnings
          )
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
          const firstText = session.messages
            .find((m) => m.role === 'user')
            ?.content.find((b) => b.type === 'text')?.text
          if (firstText) {
            const slug = firstText
              .slice(0, 60)
              .toLowerCase()
              .replace(/[^a-z0-9\s-]/g, '')
              .trim()
              .replace(/\s+/g, '-')
              .replace(/-+/g, '-')
              .slice(0, 40)
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
    },
    [directories, setCustomTitle, applyTitle, loadHistoricalSession]
  )

  const handleAutoRename = useCallback(
    (sessionId: string) => {
      handleRename(sessionId, '')
    },
    [handleRename]
  )

  // Load directories on mount and auto-refresh when JSONL files change on disk
  useEffect(() => {
    const refresh = (): void => {
      window.api.listDirectories().then(setDirectories)
    }
    refresh()
    const cleanup = window.api.onDirectoriesChanged(refresh)
    return cleanup
  }, [setDirectories])

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

  const handleClickSession = async (info: SessionInfo): Promise<void> => {
    const routingId = info.sessionId
    // Already loaded?
    if (useSessionStore.getState().sessions[routingId]) {
      switchSession(routingId)
      return
    }

    // Route history loading by provider. Prefer `info.provider` (authoritative from
    // the directory scan) over the persisted sessionProviders map (which may be absent
    // for sessions loaded from disk that were never opened in this run).
    const provider = info.provider ?? sessionProviders[info.sessionId] ?? 'claude'

    if (provider === 'codex') {
      // Codex: load via thread/read. threadId === sessionId for Codex sessions.
      const { messages } = await window.api.loadCodexHistory(info.sessionId, info.cwd)
      loadHistoricalSession(routingId, messages, info.cwd, [], {}, null, [])
      // Patch selectedProvider + status.provider/capabilities so the session
      // spawns as Codex on next send and capability gating is correct immediately
      // on history load (before the first spawn's session:status arrives).
      useSessionStore.setState((state) => {
        const existing = state.sessions[routingId]
        if (!existing) return state
        return {
          sessions: {
            ...state.sessions,
            [routingId]: {
              ...existing,
              selectedProvider: 'codex' as const,
              status: {
                ...existing.status,
                provider: 'codex' as const,
                capabilities: CODEX_CAPABILITIES
              }
            }
          }
        }
      })
      switchSession(routingId)
      if (isMobile && onToggleCollapse) onToggleCollapse()
      return
    }

    // Claude: Load from JSONL
    const { messages, taskNotifications, customTitle, agentIdToToolUseId, statusLine, warnings } =
      await window.api.loadSessionHistory(info.sessionId, info.projectKey)

    // Load subagent histories in parallel
    const subagentMessages: Record<string, ChatMessage[]> = {}
    const entries = Object.entries(agentIdToToolUseId)
    if (entries.length > 0) {
      const results = await Promise.all(
        entries.map(async ([agentId, toolUseId]) => {
          try {
            const msgs = await window.api.loadSubagentHistory(
              info.sessionId,
              info.projectKey,
              agentId
            )
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
    loadHistoricalSession(
      routingId,
      messages,
      info.cwd,
      taskNotifications,
      subagentMessages,
      statusLine,
      warnings
    )
    if (customTitle) setCustomTitle(routingId, customTitle)

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
        window.api
          .loadSessionHistory(info.sessionId, info.projectKey)
          .then(({ messages, taskNotifications, customTitle: ct, statusLine: sl, warnings }) => {
            loadHistoricalSession(
              routingId,
              messages,
              info.cwd,
              taskNotifications,
              {},
              sl,
              warnings
            )
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

  const handleRemoveRecent = useCallback(
    (info: SessionInfo) => {
      if (worktreeInfoMap[info.sessionId]) {
        setCleanupWorktree({
          sessionId: info.sessionId,
          worktreeInfo: worktreeInfoMap[info.sessionId]
        })
      } else {
        removeRecentSession(info.sessionId)
      }
    },
    [worktreeInfoMap, removeRecentSession]
  )

  // Helper to resolve a session ID to a SessionInfo
  const resolveSessionInfo = useCallback(
    (rid: string): SessionInfo | undefined => {
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
    },
    [directories, sidebarSessions, customTitles]
  )

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
  }, [
    recentSessionIds,
    maxRecentSessions,
    pinnedSet,
    resolveSessionInfo,
    hiddenSessionSet,
    showHidden
  ])

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
  }, [
    sidebarSessions,
    recentSessionIds,
    pinnedSet,
    resolveSessionInfo,
    hiddenSessionSet,
    showHidden
  ])

  const handleHideSession = useCallback(
    (info: SessionInfo) => {
      hideSession(info.sessionId)
    },
    [hideSession]
  )

  const handleUnhideSession = useCallback(
    (info: SessionInfo) => {
      unhideSession(info.sessionId)
    },
    [unhideSession]
  )

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
      const sessionProvider = sessionProviders[rid] ?? 'claude'
      const info: SessionInfo = {
        sessionId: rid,
        cwd: data.cwd,
        projectKey: '',
        title: data.firstUserText || 'New session',
        timestamp: Date.now(),
        lastActivityAt: Date.now(),
        provider: sessionProvider
      }
      const key = data.cwd
      if (!inMemoryByDir[key]) inMemoryByDir[key] = []
      inMemoryByDir[key].push(info)
    }

    // Apply custom titles to a session list
    const applyCustomTitles = (sessions: SessionInfo[]): SessionInfo[] =>
      sessions.map((s) =>
        customTitles[s.sessionId] ? { ...s, title: customTitles[s.sessionId] } : s
      )

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
    <SidebarView
      style={style}
      platform={window.api.platform}
      uiFontScale={uiFontScale}
      activeSessionId={activeSessionId}
      activeView={activeView}
      pluginViews={pluginViews}
      automationBadge={automationBadge}
      pinnedSessionIds={pinnedSessionIds}
      pinnedSessions={pinnedSessions}
      watchingSessions={watchingSessions}
      recentSessions={recentSessions}
      augmentedDirs={augmentedDirs}
      hiddenSessionSet={hiddenSessionSet}
      hiddenProjectSet={hiddenProjectSet}
      hasAnyHidden={hasAnyHidden}
      showHidden={showHidden}
      expandedDir={expandedDir}
      renamingKey={renamingKey}
      worktreesModalCwd={worktreesModalCwd}
      deleteTarget={deleteTarget}
      cleanupWorktree={cleanupWorktree}
      onToggleCollapse={onToggleCollapse}
      onNewSession={handleNewSession}
      onNewSessionDblClick={handleNewSessionDblClick}
      onSetActiveView={setActiveView}
      onShowHiddenToggle={() => setShowHidden((v) => !v)}
      onSetRenamingKey={setRenamingKey}
      onClickSession={handleClickSession}
      onToggleWatch={handleToggleWatch}
      onPin={pinSession}
      onUnpin={unpinSession}
      onReorderPinned={reorderPinnedSessions}
      onFinishRename={handleRename}
      onAutoRename={handleAutoRename}
      onRemoveRecent={handleRemoveRecent}
      onDirClick={handleDirClick}
      onDirDoubleClick={handleDirDoubleClick}
      onSessionDoubleClick={(info) => addRecentSession(info.sessionId)}
      onViewWorktrees={(cwd) => setWorktreesModalCwd(cwd)}
      onCloseWorktreesModal={() => setWorktreesModalCwd(null)}
      onHideSession={handleHideSession}
      onUnhideSession={handleUnhideSession}
      onDeleteSession={handleDeleteSessionRequest}
      onHideProject={hideProject}
      onUnhideProject={unhideProject}
      onDeleteProject={handleDeleteProjectRequest}
      onConfirmDelete={confirmDelete}
      onCancelDelete={() => setDeleteTarget(null)}
      onWorktreeCleanupKeep={() => {
        if (cleanupWorktree) {
          removeRecentSession(cleanupWorktree.sessionId)
          setCleanupWorktree(null)
        }
      }}
      onWorktreeCleanupRemove={() => {
        if (cleanupWorktree) {
          clearWorktreeInfo(cleanupWorktree.sessionId)
          removeRecentSession(cleanupWorktree.sessionId)
          setCleanupWorktree(null)
        }
      }}
      onWorktreeCleanupCancel={() => setCleanupWorktree(null)}
    />
  )
}
