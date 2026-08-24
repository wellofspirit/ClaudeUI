import { useState, useCallback, useMemo, useRef } from 'react'
import { v4 as uuid } from 'uuid'
import { useSessionStore } from '../../stores/session-store'
import type {
  ChatMessage,
  DirectoryGroup,
  SessionInfo,
  WorktreeInfo
} from '../../../../shared/types'
import { useAutomationStore } from '../../stores/automation-store'
import { useIsMobile } from '../../hooks/useIsMobile'
import { SidebarView, type DeleteTarget } from './View'
import { cwdToProjectKey } from '../../../../shared/project-key'

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
  // Monotonic token guarding async session selection: clicking slow-loading A
  // then fast-loading B must land on B. Each click bumps the token; a load only
  // commits if it's still the latest (gpt#18 / xhigh#14).
  const selectionSeq = useRef(0)
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

  // NO refresh loop here any more. The three-query merge (Claude JSONL +
  // opencode + pi) and the 30 s poll moved to the MAIN process
  // (`services/sync-seed.ts`), and `session:directories-changed` now CARRIES the
  // merged listing, so `directories` reaches this component through the replica
  // fold like every other replicated slice. What that fixes: the merge used to
  // run per client and be written locally, while canonical held the Claude-only
  // subset — so every `sync-full` force-projected that subset over the merged
  // list and a reconnecting client lost its opencode/pi rows for up to 30 s.

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
    // Bump the selection token first, so any in-flight slower load for a prior
    // click sees a newer token after its awaits and bails before committing.
    const seq = ++selectionSeq.current
    // Already loaded and still resident (an evicted entry is re-hydrated from
    // disk below, exactly like a never-loaded session)?
    const inMemory = useSessionStore.getState().sessions[routingId]
    if (inMemory && !inMemory.evicted) {
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
      // Seed sessionEngines BEFORE loadHistoricalSession so it reads the right
      // engine. Preserve any persisted model (from the DB) — overwriting it would
      // wipe the session's remembered model so it'd reopen on the engine default.
      const storeState = useSessionStore.getState()
      const sessionEngines = {
        ...storeState.sessionEngines,
        [routingId]: { ...storeState.sessionEngines[routingId], engineId: 'opencode' as const }
      }
      useSessionStore.setState({ sessionEngines })
      window.api.saveSessionConfig({ sessionEngines })
      // Best-effort history load (returns [] if opencode is down) — paints the
      // transcript immediately rather than waiting for the first new prompt.
      const messages = await window.api.loadOpencodeHistory(info.sessionId).catch(() => [])
      // A newer click superseded this one while history loaded — discard.
      if (seq !== selectionSeq.current) return
      loadHistoricalSession(routingId, messages, info.cwd)
      if (info.title && info.title !== 'Untitled') setCustomTitle(routingId, info.title)
      addRecentSession(routingId)
      switchSession(routingId)
      if (isMobile && onToggleCollapse) onToggleCollapse()
      return
    }

    // pi sessions: same treatment as opencode above, but the "always resume by
    // id" nuance does NOT apply — pi is a claude-shaped (spawn-per-session,
    // no server) engine, so PiSession only resumes when session-store's own
    // isHistorical gate is true (i.e. this history load actually returned
    // messages), exactly like Claude. No extra sessionEngines/resumeSessionId
    // wiring is needed here beyond seeding engineId, same as the opencode branch.
    if (info.engineId === 'pi') {
      const storeState = useSessionStore.getState()
      const sessionEngines = {
        ...storeState.sessionEngines,
        [routingId]: { ...storeState.sessionEngines[routingId], engineId: 'pi' as const }
      }
      useSessionStore.setState({ sessionEngines })
      window.api.saveSessionConfig({ sessionEngines })
      const messages = await window.api.loadPiHistory(info.sessionId).catch(() => [])
      if (seq !== selectionSeq.current) return
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
    // A newer click superseded this one while history + subagents loaded — discard.
    if (seq !== selectionSeq.current) return
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
    // todos + the Files widget are derived from the transcript INSIDE the cold-
    // history seed now (SyncCore 4c): they are sealed, and deriving them here
    // would have been a client computing state the reducer already computes.
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
            window.api.watchSession(routingId, info.sessionId, info.projectKey, info.cwd)
            setWatching(routingId, true)
          })
      } else {
        window.api.watchSession(routingId, info.sessionId, info.projectKey, info.cwd)
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
    // No refresh call: main re-reads the merged listing as part of the delete
    // itself (`handlers-core.deleteSession` / `deleteProject`) and replicates it,
    // so the row disappears on EVERY client rather than only on the one that
    // clicked — and without the Claude-only refetch that used to drop every
    // opencode/pi row here until the next 30 s poll.
  }, [deleteTarget, deleteSessionAction, deleteProjectAction])

  const augmentedDirs = useMemo(() => {
    // Build set of session IDs already on disk
    const dirSessionIds = new Set<string>()
    for (const group of directories) {
      for (const s of group.sessions) dirSessionIds.add(s.sessionId)
    }

    // Collect in-memory sessions not yet on disk, grouped by canonical projectKey
    const inMemoryByPk: Record<string, SessionInfo[]> = {}
    for (const [rid, data] of Object.entries(sidebarSessions)) {
      if (dirSessionIds.has(rid) || !data.cwd) continue
      const sessionEngineId = (sessionEngines[rid]?.engineId ??
        'claude') as import('../../../../shared/types').EngineId
      const pk = cwdToProjectKey(data.cwd)
      const info: SessionInfo = {
        sessionId: rid,
        cwd: data.cwd,
        projectKey: pk,
        title: data.firstUserText || 'New session',
        timestamp: Date.now(),
        lastActivityAt: Date.now(),
        engineId: sessionEngineId
      }
      if (!inMemoryByPk[pk]) inMemoryByPk[pk] = []
      inMemoryByPk[pk].push(info)
    }

    // Apply custom titles to a session list
    const applyCustomTitles = (sessions: SessionInfo[]): SessionInfo[] =>
      sessions.map((s) =>
        customTitles[s.sessionId] ? { ...s, title: customTitles[s.sessionId] } : s
      )

    // Track which in-memory pkGroups were merged into an existing group
    const mergedPks = new Set<string>()

    // Merge in-memory sessions into existing groups (match by projectKey OR exact cwd)
    const result: DirectoryGroup[] = directories.map((group) => {
      const pk = group.projectKey || cwdToProjectKey(group.cwd)
      const extra = inMemoryByPk[pk]
      if (!extra) {
        // Also try matching in-memory sessions whose cwd exactly matches this group's cwd
        // (fallback for the case where canonicalization diverges)
        const cwdExtra = Object.entries(inMemoryByPk).find(
          ([, sessions]) => sessions.length > 0 && sessions[0].cwd === group.cwd
        )
        if (!cwdExtra) {
          return { ...group, sessions: applyCustomTitles(group.sessions) }
        }
        const [cwdPk, cwdSessions] = cwdExtra
        mergedPks.add(cwdPk)
        return { ...group, sessions: applyCustomTitles([...cwdSessions, ...group.sessions]) }
      }
      mergedPks.add(pk)
      return { ...group, sessions: applyCustomTitles([...extra, ...group.sessions]) }
    })

    // Create new groups for in-memory sessions that don't match any existing directory
    for (const [pk, extraSessions] of Object.entries(inMemoryByPk)) {
      if (mergedPks.has(pk)) continue
      const cwd = extraSessions[0].cwd
      const folderName = cwd.split(/[\\/]/).pop() || cwd
      result.unshift({
        cwd,
        projectKey: pk,
        folderName,
        sessions: applyCustomTitles(extraSessions)
      })
    }
    return result
  }, [directories, sidebarSessions, customTitles, sessionEngines])

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
