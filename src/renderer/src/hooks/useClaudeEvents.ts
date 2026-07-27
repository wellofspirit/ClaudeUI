import { useEffect } from 'react'
import { useSessionStore, buildTodosFromMessages, resolveRoutingId } from '../stores/session-store'

/** Send a system notification if the session is not currently focused */
function notifyIfNeeded(routingId: string, title: string, body: string): void {
  const state = useSessionStore.getState()
  // Don't notify if this session is currently active and window is focused
  if (state.activeSessionId === routingId && document.hasFocus()) return
  // Don't notify if notifications not supported or denied
  if (!('Notification' in window) || Notification.permission !== 'granted') return

  const session = state.sessions[routingId]
  const folderName = session?.cwd.split(/[\\/]/).pop() || 'Session'
  new Notification(title, { body: `${folderName}: ${body}`, silent: false })
}

const TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TodoWrite'])

/**
 * Built-in tool names whose result text is trusted to declare an entered
 * worktree. Gating on an EXACT name (not a `/worktree/i` substring over every
 * tool) closes the injection funnel behind audit C2: a third-party MCP tool
 * named e.g. `mcp__evil__worktree_helper` can no longer plant a `worktreePath`
 * that later flows into `worktree:remove`. `EnterWorktree` is the only cli.js
 * built-in that emits "Created worktree at: <path> on branch: <branch>".
 */
export const WORKTREE_ENTER_TOOL_NAMES = new Set(['EnterWorktree'])

/**
 * Display name for an entered worktree: the path's last segment, falling back
 * to the branch with its `worktree-` prefix stripped.
 *
 * Splits on BOTH separators — a Windows worktree path (`D:\wt\feature-x`) has
 * no `/`, so a `/`-only split yielded the ENTIRE path as the display name
 * (RN11). Exported so the hook's behavior is tested directly rather than via a
 * copy of this expression in the test harness.
 */
export function deriveWorktreeName(wtPath: string, wtBranch: string): string {
  return wtPath.split(/[\\/]/).pop() || wtBranch.replace(/^worktree-/, '')
}

/** Rebuild todos from all messages when a task-related tool call is detected */
function rebuildTodos(routingId: string): void {
  const { sessions, setTodos } = useSessionStore.getState()
  const session = sessions[routingId]
  if (!session) return
  const todos = buildTodosFromMessages(session.messages)
  if (todos) setTodos(routingId, todos)
}

export function useClaudeEvents(): void {
  const addMessage = useSessionStore((s) => s.addMessage)
  const appendStreamingText = useSessionStore((s) => s.appendStreamingText)
  const appendStreamingThinking = useSessionStore((s) => s.appendStreamingThinking)
  const addPendingApproval = useSessionStore((s) => s.addPendingApproval)
  const clearPendingApprovals = useSessionStore((s) => s.clearPendingApprovals)
  const removePendingApproval = useSessionStore((s) => s.removePendingApproval)
  const removePendingApprovalByToolUse = useSessionStore((s) => s.removePendingApprovalByToolUse)
  const setStatus = useSessionStore((s) => s.setStatus)
  const addError = useSessionStore((s) => s.addError)
  const addWarning = useSessionStore((s) => s.addWarning)
  const retractMessages = useSessionStore((s) => s.retractMessages)
  const appendToolResult = useSessionStore((s) => s.appendToolResult)
  const updateTaskProgress = useSessionStore((s) => s.updateTaskProgress)
  const addTaskNotification = useSessionStore((s) => s.addTaskNotification)
  const addSubagentMessage = useSessionStore((s) => s.addSubagentMessage)
  const appendSubagentMessageBatch = useSessionStore((s) => s.appendSubagentMessageBatch)
  const appendSubagentStreamingText = useSessionStore((s) => s.appendSubagentStreamingText)
  const appendSubagentStreamingThinking = useSessionStore((s) => s.appendSubagentStreamingThinking)
  const appendSubagentToolResult = useSessionStore((s) => s.appendSubagentToolResult)
  const setBashOutput = useSessionStore((s) => s.setBashOutput)
  const setBackgroundOutput = useSessionStore((s) => s.setBackgroundOutput)
  const setStatusLine = useSessionStore((s) => s.setStatusLine)
  const setPermissionMode = useSessionStore((s) => s.setPermissionMode)
  const setSlashCommands = useSessionStore((s) => s.setSlashCommands)
  const setCustomCommands = useSessionStore((s) => s.setCustomCommands)
  const setSdkSkillNames = useSessionStore((s) => s.setSdkSkillNames)
  const addSandboxViolation = useSessionStore((s) => s.addSandboxViolation)
  const setVoiceState = useSessionStore((s) => s.setVoiceState)
  const appendVoiceTranscript = useSessionStore((s) => s.appendVoiceTranscript)

  // Request notification permission on mount
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission()
    }
  }, [])

  useEffect(() => {
    if (!window.api) {
      console.error('IPC API not available')
      return
    }

    const cleanups = [
      // Session lifecycle: another client (local or remote) created a session
      window.api.onSessionCreated((routingId, data) => {
        const store = useSessionStore.getState()
        // Only act if this session doesn't already exist in our store
        // (the initiating client already called createNewSession locally)
        if (!store.sessions[routingId]) {
          const follow = store.settings.remoteFollowActions
          store.createNewSession(routingId, data.cwd, follow)
          if (!follow) {
            // Mark the session as needing attention so the sidebar shows activity
            store.setNeedsAttention(routingId, true)
          }
          // If resuming an existing session, load its history from disk
          if (data.resumeSessionId) {
            const projectKey = store.directories.find((g) =>
              g.sessions.some((s) => s.sessionId === data.resumeSessionId)
            )?.projectKey
            if (projectKey) {
              window.api
                .loadSessionHistory(data.resumeSessionId, projectKey)
                .then(({ messages, taskNotifications, customTitle, statusLine, warnings }) => {
                  const s = useSessionStore.getState()
                  // Only populate if the session still exists and is still empty
                  if (s.sessions[routingId] && s.sessions[routingId].messages.length === 0) {
                    s.loadHistoricalSession(
                      routingId,
                      messages,
                      data.cwd,
                      taskNotifications,
                      {},
                      statusLine,
                      warnings
                    )
                    if (customTitle) s.setCustomTitle(routingId, customTitle)
                    // Re-mark active since loadHistoricalSession sets isHistorical
                    s.markSdkActive(routingId)
                  }
                })
            }
          }
        }
        // An SDK session was created — mark it active
        store.markSdkActive(routingId)
      }),
      // User message relayed by the server (the single source of truth for user messages).
      // When queued (sent while session is running), store as queuedText instead of adding
      // to the chat stream — the message will appear in chat when actually consumed by cli.js.
      window.api.onUserMessage((routingId, data) => {
        // Resolve a possibly-stale (pre-rekey) id to the canonical session id at
        // the event boundary so every handler targets the same session across a
        // rekey (xhigh#9). No-op when no rekey mapping applies.
        routingId = resolveRoutingId(routingId)
        const store = useSessionStore.getState()
        if (!store.sessions[routingId]) return
        if (data.queued) {
          store.setQueuedText(routingId, data.prompt)
        } else {
          store.addUserMessage(
            routingId,
            // crypto.randomUUID (not Date.now) so two user messages within the
            // same ms can't collide into a duplicate React key (Low).
            `msg-${crypto.randomUUID()}`,
            data.prompt,
            undefined,
            data.attachments
          )
        }
      }),
      window.api.onMessage((routingId, msg) => {
        routingId = resolveRoutingId(routingId)
        addMessage(routingId, msg)

        // Rebuild todos when task-related tool calls arrive
        const hasTaskTool = msg.content.some(
          (b) => b.type === 'tool_use' && TASK_TOOLS.has(b.toolName)
        )
        if (hasTaskTool) rebuildTodos(routingId)
      }),
      window.api.onStreamEvent((routingId, data) => {
        routingId = resolveRoutingId(routingId)
        if (data.type === 'thinking') {
          appendStreamingThinking(routingId, data.text)
        } else {
          appendStreamingText(routingId, data.text)
        }
      }),
      window.api.onApprovalRequest((routingId, approval) => {
        routingId = resolveRoutingId(routingId)
        addPendingApproval(routingId, approval)
        const state = useSessionStore.getState()
        if (state.activeSessionId !== routingId || !document.hasFocus()) {
          state.setNeedsAttention(routingId, true)
        }
        notifyIfNeeded(
          routingId,
          'Permission required',
          `${approval.toolName || 'Tool'} needs approval`
        )
      }),
      // Externally-resolved approval (e.g. opencode's deny-cascade on a
      // dispatch target, ADR-033) — remove the stale card.
      window.api.onApprovalDismiss((routingId, { requestId }) => {
        removePendingApproval(resolveRoutingId(routingId), requestId)
      }),
      window.api.onStatus((routingId, status) => {
        // Re-key session when SDK provides its stable session ID
        let effectiveRoutingId = routingId
        if (status.sessionId && status.sessionId !== routingId) {
          const store = useSessionStore.getState()
          if (store.sessions[routingId]) {
            store.rekeySession(routingId, status.sessionId)
            window.api.rekeySession(routingId, status.sessionId)
            effectiveRoutingId = status.sessionId
          }
        }

        const priorState = useSessionStore.getState().sessions[effectiveRoutingId]?.status.state

        if (status.state === 'disconnected') {
          useSessionStore.getState().markSdkInactive(effectiveRoutingId)
          setStatus(effectiveRoutingId, { ...status, state: 'idle' })
          clearPendingApprovals(effectiveRoutingId)
          if (priorState === 'running') {
            useSessionStore.getState().consumeQueuedText(effectiveRoutingId)
          }
          return
        }
        setStatus(effectiveRoutingId, status)
        if (status.state === 'idle') {
          clearPendingApprovals(effectiveRoutingId)
          if (priorState === 'running') {
            useSessionStore.getState().consumeQueuedText(effectiveRoutingId)
          }
        }
        // Clear attention when a new turn starts
        if (status.state === 'running') {
          useSessionStore.getState().setNeedsAttention(effectiveRoutingId, false)
        }
        // Detect worktree exit: CWD changed back to originalCwd
        if (status.cwd) {
          const store = useSessionStore.getState()
          const session = store.sessions[effectiveRoutingId]
          if (session?.worktreeInfo && status.cwd === session.worktreeInfo.originalCwd) {
            store.clearWorktreeInfo(effectiveRoutingId)
          }
        }
      }),
      window.api.onResult((routingId) => {
        routingId = resolveRoutingId(routingId)
        // Dismiss completed task list when turn ends
        const state = useSessionStore.getState()
        const session = state.sessions[routingId]
        if (session && session.todos.length > 0) {
          const allDone = session.todos.every((t) => t.status === 'completed')
          if (allDone) state.setTodos(routingId, [])
        }
        // Clear any pending vendor auth required card when a turn succeeds
        useSessionStore.getState().clearVendorAuthRequired(routingId)
        // Mark attention + notify when Claude's turn ends (user's turn)
        if (session?.sdkActive) {
          if (state.activeSessionId !== routingId || !document.hasFocus()) {
            state.setNeedsAttention(routingId, true)
          }
          notifyIfNeeded(routingId, 'Ready for input', 'Claude has finished — your turn')
        }
      }),
      window.api.onVendorAuthRequired((routingId, data) => {
        useSessionStore.getState().setVendorAuthRequired(resolveRoutingId(routingId), data)
      }),
      window.api.onError((routingId, error) => {
        routingId = resolveRoutingId(routingId)
        addError(routingId, error)
        window.api.logError('session', `[routingId=${routingId}] ${error}`)
      }),
      window.api.onWarning((routingId, warning) => {
        addWarning(resolveRoutingId(routingId), warning)
      }),
      window.api.onMessagesRetracted((routingId, { messageIds }) => {
        retractMessages(resolveRoutingId(routingId), messageIds)
      }),
      window.api.onToolResult((routingId, { toolUseId, result, isError, fileDiffs }) => {
        routingId = resolveRoutingId(routingId)
        appendToolResult(routingId, toolUseId, result, isError, fileDiffs)
        // Belt-and-suspenders: when cli.js has produced a result for this
        // tool_use, any approval still sitting in the store for it is
        // necessarily stale (resolver already ran). Clear it so late
        // cleanup races can't re-decorate a finished card.
        if (toolUseId) removePendingApprovalByToolUse(routingId, toolUseId)
        // Rebuild todos when a task tool result arrives (e.g. TaskCreate gets its ID)
        if (!isError) rebuildTodos(routingId)

        // Detect worktree enter from EnterWorktree tool result
        if (!isError && result) {
          const store = useSessionStore.getState()
          const session = store.sessions[routingId]
          if (session && !session.worktreeInfo) {
            // Find the matching tool_use block by toolUseId
            for (const msg of session.messages) {
              const toolBlock = msg.content.find(
                (b) => b.type === 'tool_use' && b.toolUseId === toolUseId
              )
              if (
                toolBlock &&
                toolBlock.type === 'tool_use' &&
                WORKTREE_ENTER_TOOL_NAMES.has(toolBlock.toolName)
              ) {
                // SDK result format: "Created worktree at <path> on branch <branch>. ..."
                const naturalMatch = result.match(/worktree at (.+?) on branch ([\w-]+)/)
                // Also try structured formats: worktreePath: <path> or JSON "worktreePath": "<path>"
                const pathMatch =
                  naturalMatch?.[1] ||
                  result.match(/worktreePath:\s*(.+?)(?:\n|$)/i)?.[1] ||
                  result.match(/"worktreePath"\s*:\s*"([^"]+)"/i)?.[1]
                const branchMatch =
                  naturalMatch?.[2] ||
                  result.match(/worktreeBranch:\s*(.+?)(?:\n|$)/i)?.[1] ||
                  result.match(/"worktreeBranch"\s*:\s*"([^"]+)"/i)?.[1]
                if (pathMatch && branchMatch) {
                  const wtPath = pathMatch.trim()
                  const wtBranch = branchMatch.trim()
                  // Derive name from path (last segment) or branch (strip worktree- prefix)
                  const wtName = deriveWorktreeName(wtPath, wtBranch)
                  store.setWorktreeInfo(routingId, {
                    worktreePath: wtPath,
                    worktreeBranch: wtBranch,
                    worktreeName: wtName,
                    originalCwd: session.cwd,
                    gitRoot: session.cwd,
                    originalHeadCommit: '',
                    createdAt: Date.now()
                  })
                }
                break
              }
            }
          }
        }
      }),
      window.api.onTaskProgress((routingId, data) => {
        updateTaskProgress(resolveRoutingId(routingId), data)
      }),
      window.api.onTaskNotification((routingId, data) => {
        addTaskNotification(resolveRoutingId(routingId), data)
      }),
      window.api.onSubagentStream((routingId, data) => {
        routingId = resolveRoutingId(routingId)
        if (data.type === 'thinking') {
          appendSubagentStreamingThinking(routingId, data.toolUseId, data.text)
        } else {
          appendSubagentStreamingText(routingId, data.toolUseId, data.text)
        }
      }),
      window.api.onSubagentMessage((routingId, data) => {
        addSubagentMessage(resolveRoutingId(routingId), data.toolUseId, data.message)
      }),
      window.api.onSubagentMessageBatch((routingId, data) => {
        appendSubagentMessageBatch(resolveRoutingId(routingId), data.toolUseId, data.messages)
      }),
      window.api.onSubagentToolResult((routingId, data) => {
        appendSubagentToolResult(
          resolveRoutingId(routingId),
          data.toolUseId,
          data.toolResultToolUseId,
          data.result,
          data.isError,
          data.fileDiffs
        )
      }),
      window.api.onBashOutput((routingId, data) => {
        setBashOutput(
          resolveRoutingId(routingId),
          data.toolUseId,
          data.output,
          data.totalLines,
          data.totalBytes
        )
      }),
      window.api.onBackgroundOutput((routingId, data) => {
        setBackgroundOutput(resolveRoutingId(routingId), data.toolUseId, data.tail, data.totalSize)
      }),
      window.api.onStatusLine((routingId, data) => {
        setStatusLine(resolveRoutingId(routingId), data)
      }),
      window.api.onMetering((routingId, data) => {
        useSessionStore.getState().setMetering(resolveRoutingId(routingId), data)
      }),
      window.api.onPlanSteps((routingId, todos) => {
        useSessionStore.getState().setTodos(resolveRoutingId(routingId), todos)
      }),
      window.api.onPermissionMode((routingId, mode) => {
        setPermissionMode(mode, resolveRoutingId(routingId))
      }),
      window.api.onSlashCommands((_routingId, commands) => {
        setSlashCommands(commands)
        setCustomCommands([]) // SDK list is authoritative — clear filesystem-scanned commands
        window.api.saveSlashCommands(commands)
      }),
      window.api.onSkills((_routingId, names) => {
        setSdkSkillNames(names)
      }),
      window.api.onSandboxViolation((routingId, message) => {
        addSandboxViolation(resolveRoutingId(routingId), message)
      }),
      window.api.onSteerConsumed((routingId) => {
        useSessionStore.getState().consumeQueuedText(resolveRoutingId(routingId))
      }),
      window.api.onWatchUpdate(({ routingId, messages, taskNotifications, statusLine }) => {
        routingId = resolveRoutingId(routingId)
        useSessionStore.getState().updateWatchedSession(routingId, messages, taskNotifications)
        if (statusLine) setStatusLine(routingId, statusLine)
        rebuildTodos(routingId)
        // Dismiss completed task list for watched sessions (no result event)
        const session = useSessionStore.getState().sessions[routingId]
        if (session && session.todos.length > 0) {
          const allDone = session.todos.every((t) => t.status === 'completed')
          if (allDone) useSessionStore.getState().setTodos(routingId, [])
        }
      }),
      // Git status updates from polling
      window.api.onGitStatusUpdate(({ cwd, status }) => {
        const store = useSessionStore.getState()
        // Find all sessions with this cwd and update them
        for (const [routingId, session] of Object.entries(store.sessions)) {
          if (session.cwd === cwd) {
            store.setGitStatus(routingId, status)
          }
        }
      }),
      // Cross-instance config sync
      window.api.onSettingsChanged((settings) => {
        useSessionStore.getState().applyExternalSettings(settings)
      }),
      window.api.onSessionConfigChanged((config) => {
        useSessionStore.getState().applyExternalSessionConfig(config)
      }),
      // Account usage (5hr / 7-day rate limits)
      window.api.onAccountUsage((data) => {
        useSessionStore.getState().setAccountUsage(data)
      }),
      // Block usage analytics
      window.api.onBlockUsage((data) => {
        useSessionStore.getState().setBlockUsage(data)
      }),
      // Native OAuth login-flow transitions (ADR-014)
      window.api.onAuthState((state) => {
        const store = useSessionStore.getState()
        store.setAuthState(state)
        // The running cli.js process cached the stale credential; mark the active
        // session inactive so the next normal send respawns with fresh creds
        // (Retry does its own respawn). See ADR-014.
        if (state.status === 'success' && store.activeSessionId) {
          store.markSdkInactive(store.activeSessionId)
        }
      }),
      // Auth source from session init ('none' = logged out) — drives the banner
      // Also updates the vendorAuth probe so AuthBanner reads from the probe.
      window.api.onAuthSource((_routingId, source) => {
        const store = useSessionStore.getState()
        store.setAuthSource(source)
        // Mirror the auth-source into vendorAuth so AuthBanner can consume the probe
        // (AuthState tri-state) instead of the raw string — behavior-equivalent.
        store.setVendorAuth({
          anthropic: {
            authState: source === 'authenticated' ? 'authenticated' : 'unauthenticated',
            billingType: 'unknown',
            label: undefined
          }
        })
      }),
      // Multi-account state changes (ADR-015)
      window.api.onAccountsChanged((state) => {
        useSessionStore.getState().setAccountsState(state)
      }),
      // Active account changed — respawn chat sessions against the new account
      window.api.onAccountRespawnSessions(() => {
        useSessionStore.getState().respawnAllSessions()
      }),
      // Before-quit: check for active worktrees
      window.api.onBeforeQuit(() => {
        const store = useSessionStore.getState()
        const activeWorktrees = Object.entries(store.worktreeInfoMap).map(
          ([routingId, worktreeInfo]) => ({ routingId, worktreeInfo })
        )
        if (activeWorktrees.length === 0) {
          window.api.confirmQuit()
        } else {
          store.setQuitWorktrees(activeWorktrees)
        }
      }),
      // Voice input events
      window.api.onVoiceTranscript((routingId, data) => {
        appendVoiceTranscript(resolveRoutingId(routingId), data.text, data.isFinal)
      }),
      window.api.onVoiceState((routingId, state) => {
        setVoiceState(resolveRoutingId(routingId), state)
      }),
      window.api.onVoiceError((routingId, error) => {
        addError(resolveRoutingId(routingId), error)
      }),
      // Plugin views
      window.api.onPluginViewsChanged((views) => {
        useSessionStore.getState().setPluginViews(views)
      })
    ]

    // Trigger initial plugin views fetch
    window.api
      .getPluginViews()
      .then((views) => {
        useSessionStore.getState().setPluginViews(views)
      })
      .catch(() => {
        /* plugins may not be loaded yet */
      })

    // Trigger initial usage fetch
    window.api
      .fetchAccountUsage()
      .then((data) => {
        useSessionStore.getState().setAccountUsage(data)
      })
      .catch((err) => {
        window.api.logError('useClaudeEvents', `Initial usage fetch failed: ${err}`)
      })

    // Trigger initial block usage fetch
    window.api
      .fetchBlockUsage()
      .then((data) => {
        useSessionStore.getState().setBlockUsage(data)
      })
      .catch((err) => {
        window.api.logError('useClaudeEvents', `Initial block usage fetch failed: ${err}`)
      })

    return () => cleanups.forEach((fn) => fn())
  }, [
    addMessage,
    appendStreamingText,
    appendStreamingThinking,
    addPendingApproval,
    clearPendingApprovals,
    removePendingApproval,
    removePendingApprovalByToolUse,
    setStatus,
    addError,
    addWarning,
    retractMessages,
    appendToolResult,
    updateTaskProgress,
    addTaskNotification,
    addSubagentMessage,
    appendSubagentMessageBatch,
    appendSubagentStreamingText,
    appendSubagentStreamingThinking,
    appendSubagentToolResult,
    setBashOutput,
    setBackgroundOutput,
    setStatusLine,
    setPermissionMode,
    setSlashCommands,
    setCustomCommands,
    setSdkSkillNames,
    addSandboxViolation,
    setVoiceState,
    appendVoiceTranscript
  ])
}
