import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { v4 as uuid } from 'uuid'
import { useSessionStore, buildTodosFromMessages } from '../../stores/session-store'
import type {
  ChatMessage,
  DirectoryGroup,
  SessionInfo,
  WorktreeInfo
} from '../../../../shared/types'
import { useAutomationStore } from '../../stores/automation-store'
import { useIsMobile } from '../../hooks/useIsMobile'
import { SidebarView, type DeleteTarget } from './View'

/**
 * Merge opencode SessionInfo[] into an existing DirectoryGroup[] (Claude sessions).
 * opencode sessions are grouped by cwd: if a group for that cwd already exists
 * (from Claude), the opencode sessions are appended (avoiding duplicates by sessionId).
 * If no group exists for that cwd, a new group is created.
 *
 * Called on each poll; produces a new array without mutating the input.
 */
function mergeOpencodeIntoDirectories(
  current: DirectoryGroup[],
  opencodeInfos: SessionInfo[]
): DirectoryGroup[] {
  // Build a mutable copy indexed by cwd (forward-slash normalized for comparison).
  const byProjectKey = new Map<string, DirectoryGroup>()
  const order: string[] = []
  for (const g of current) {
    byProjectKey.set(g.projectKey, { ...g, sessions: [...g.sessions] })
    order.push(g.projectKey)
  }

  // Remove all existing opencode sessions first (so we replace on every poll
  // rather than accumulating stale entries). They're identified by engineId.
  for (const [key, group] of byProjectKey) {
    const filtered = group.sessions.filter((s) => s.engineId !== 'opencode')
    byProjectKey.set(key, { ...group, sessions: filtered })
  }

  // Insert opencode sessions grouped by cwd
  for (const info of opencodeInfos) {
    const projectKey = info.projectKey
    let group = byProjectKey.get(projectKey)
    if (!group) {
      const folderName = info.cwd.split(/[\\/]/).pop() || info.cwd
      group = { cwd: info.cwd, projectKey, folderName, sessions: [] }
      byProjectKey.set(projectKey, group)
      order.push(projectKey)
    }
    group.sessions.push(info)
  }

  // Re-sort each group's sessions newest-first
  for (const group of byProjectKey.values()) {
    group.sessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  }

  // Re-assemble in original order, skip groups that ended up empty
  const result: DirectoryGroup[] = []
  const seen = new Set<string>()
  for (const key of order) {
    if (seen.has(key)) continue
    seen.add(key)
    const group = byProjectKey.get(key)
    if (group && group.sessions.length > 0) result.push(group)
  }

  // Sort groups by most recent activity (mirror listDirectories sort)
  result.sort((a, b) => {
    const aMax = a.sessions[0]?.lastActivityAt ?? 0
    const bMax = b.sessions[0]?.lastActivityAt ?? 0
    return bMax - aMax
  })

  return result
}

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
  const sessionEngines = useSessionStore((s) => s.sessionEngines)
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

  // Build the session list from BOTH engines in one shot so they never clobber
  // each other: fetch Claude directories (JSONL) + the global opencode session
  // list, merge, and set once. Runs on mount, whenever Claude JSONL files change,
  // and on a 30s poll (so new opencode sessions made elsewhere show up). The
  // opencode side is best-effort — any error (not installed / server down) just
  // yields the Claude-only list. Doing this as ONE effect avoids the race where a
  // Claude refresh would wipe the merged opencode sessions until the next poll.
  useEffect(() => {
    let cancelled = false
    const refresh = async (): Promise<void> => {
      const claude = await window.api.listDirectories()
      if (cancelled) return
      let merged = claude
      try {
        const opencodeInfos = await window.api.listOpencodeSessionsGlobal()
        if (!cancelled && opencodeInfos.length > 0) {
          merged = mergeOpencodeIntoDirectories(claude, opencodeInfos)
        }
      } catch {
        // Best-effort — opencode not installed or server down → Claude-only list.
      }
      if (!cancelled) setDirectories(merged)
    }
    void refresh()
    const cleanup = window.api.onDirectoriesChanged(() => void refresh())
    const interval = setInterval(() => void refresh(), 30_000)
    return () => {
      cancelled = true
      cleanup?.()
      clearInterval(interval)
    }
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
      if (isMobile && onToggleCollapse) onToggleCollapse()
      return
    }

    // opencode sessions: load the prior transcript from opencode's own store
    // (read-only, via the global session id) so the chat view paints immediately
    // on click — parity with Claude's JSONL load. The OpencodeSession is created
    // only when the user sends a prompt; it then resumes the same session id (and
    // re-replays the same messages, idempotent by id). We seed sessionEngines with
    // engineId:'opencode' so loadHistoricalSession sets selectedEngineId, which
    // InputBox uses to pass routingId as resumeSessionId on the first createSession.
    if (info.engineId === 'opencode') {
      // Seed sessionEngines BEFORE loadHistoricalSession so it reads the right engine.
      const storeState = useSessionStore.getState()
      const sessionEngines = {
        ...storeState.sessionEngines,
        [routingId]: { engineId: 'opencode' as const }
      }
      useSessionStore.setState({ sessionEngines })
      window.api.saveSessionConfig({ sessionEngines })
      // Best-effort history load (returns [] if opencode is down) — paints the
      // transcript immediately rather than waiting for the first new prompt.
      const messages = await window.api.loadOpencodeHistory(info.sessionId).catch(() => [])
      loadHistoricalSession(routingId, messages, info.cwd)
      if (info.title && info.title !== 'Untitled') setCustomTitle(routingId, info.title)
      addRecentSession(routingId)
      switchSession(routingId)
      if (isMobile && onToggleCollapse) onToggleCollapse()
      return
    }

    // Claude sessions: load from JSONL transcript
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
      // Load JSONL history if not already in memory, then watch the .jsonl file
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
      title: info.title,
      engineId: info.engineId
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
      await deleteSessionAction(
        deleteTarget.sessionId,
        deleteTarget.projectKey,
        deleteTarget.engineId
      )
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
      const sessionEngineId = (sessionEngines[rid]?.engineId ?? 'claude') as import('../../../../shared/types').EngineId
      const info: SessionInfo = {
        sessionId: rid,
        cwd: data.cwd,
        projectKey: '',
        title: data.firstUserText || 'New session',
        timestamp: Date.now(),
        lastActivityAt: Date.now(),
        engineId: sessionEngineId
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
