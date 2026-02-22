import { useEffect } from 'react'
import { useSessionStore, buildTodosFromMessages } from '../stores/session-store'

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
  const setStatus = useSessionStore((s) => s.setStatus)
  const addError = useSessionStore((s) => s.addError)
  const appendToolResult = useSessionStore((s) => s.appendToolResult)
  const updateTaskProgress = useSessionStore((s) => s.updateTaskProgress)
  const addTaskNotification = useSessionStore((s) => s.addTaskNotification)
  const addSubagentMessage = useSessionStore((s) => s.addSubagentMessage)
  const appendSubagentMessageBatch = useSessionStore((s) => s.appendSubagentMessageBatch)
  const appendSubagentStreamingText = useSessionStore((s) => s.appendSubagentStreamingText)
  const appendSubagentStreamingThinking = useSessionStore((s) => s.appendSubagentStreamingThinking)
  const appendSubagentToolResult = useSessionStore((s) => s.appendSubagentToolResult)
  const setBackgroundOutput = useSessionStore((s) => s.setBackgroundOutput)
  const setStatusLine = useSessionStore((s) => s.setStatusLine)
  const setPermissionMode = useSessionStore((s) => s.setPermissionMode)
  const setSlashCommands = useSessionStore((s) => s.setSlashCommands)

  // Request notification permission on mount
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission()
    }
  }, [])

  useEffect(() => {
    const cleanups = [
      window.api.onMessage(({ routingId, data: msg }) => {
        addMessage(routingId, msg)

        // Rebuild todos when task-related tool calls arrive
        const hasTaskTool = msg.content.some(
          (b) => b.type === 'tool_use' && b.toolName && TASK_TOOLS.has(b.toolName)
        )
        if (hasTaskTool) rebuildTodos(routingId)
      }),
      window.api.onStreamEvent(({ routingId, data }) => {
        if (data.type === 'thinking') {
          appendStreamingThinking(routingId, data.text)
        } else {
          appendStreamingText(routingId, data.text)
        }
      }),
      window.api.onApprovalRequest(({ routingId, data: approval }) => {
        addPendingApproval(routingId, approval)
        const state = useSessionStore.getState()
        if (state.activeSessionId !== routingId || !document.hasFocus()) {
          state.setNeedsAttention(routingId, true)
        }
        notifyIfNeeded(routingId, 'Permission required', `${approval.toolName || 'Tool'} needs approval`)
      }),
      window.api.onStatus(({ routingId, data: status }) => {
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

        if (status.state === 'disconnected') {
          useSessionStore.getState().markSdkInactive(effectiveRoutingId)
          setStatus(effectiveRoutingId, { ...status, state: 'idle' })
          clearPendingApprovals(effectiveRoutingId)
          return
        }
        setStatus(effectiveRoutingId, status)
        if (status.state === 'idle') {
          clearPendingApprovals(effectiveRoutingId)
        }
        // Clear attention when a new turn starts
        if (status.state === 'running') {
          useSessionStore.getState().setNeedsAttention(effectiveRoutingId, false)
        }
      }),
      window.api.onResult(({ routingId }) => {
        // Dismiss completed task list when turn ends
        const state = useSessionStore.getState()
        const session = state.sessions[routingId]
        if (session && session.todos.length > 0) {
          const allDone = session.todos.every((t) => t.status === 'completed')
          if (allDone) state.setTodos(routingId, [])
        }
        // Mark attention + notify when Claude's turn ends (user's turn)
        if (session?.sdkActive) {
          if (state.activeSessionId !== routingId || !document.hasFocus()) {
            state.setNeedsAttention(routingId, true)
          }
          notifyIfNeeded(routingId, 'Ready for input', 'Claude has finished — your turn')
        }
      }),
      window.api.onError(({ routingId, data: error }) => {
        addError(routingId, error)
        window.api.logError('session', `[routingId=${routingId}] ${error}`)
      }),
      window.api.onToolResult(({ routingId, data: { toolUseId, result, isError } }) => {
        appendToolResult(routingId, toolUseId, result, isError)
        // Rebuild todos when a task tool result arrives (e.g. TaskCreate gets its ID)
        if (!isError) rebuildTodos(routingId)
      }),
      window.api.onTaskProgress(({ routingId, data }) => {
        updateTaskProgress(routingId, data)
      }),
      window.api.onTaskNotification(({ routingId, data }) => {
        addTaskNotification(routingId, data)
        // Update teammate status when a known teammate completes
        if (data.toolUseId) {
          const store = useSessionStore.getState()
          const session = store.sessions[routingId]
          if (session?.teammates[data.toolUseId]) {
            const statusMap: Record<string, 'completed' | 'failed' | 'stopped'> = {
              completed: 'completed', failed: 'failed', stopped: 'stopped'
            }
            store.updateTeammateStatus(routingId, data.toolUseId, statusMap[data.status] || 'completed')
          }
        }
      }),
      window.api.onTeamCreated(({ routingId, data }) => {
        useSessionStore.getState().setTeamName(routingId, data.teamName)
      }),
      window.api.onTeamDeleted(({ routingId }) => {
        useSessionStore.getState().clearTeam(routingId)
      }),
      window.api.onTeammateDetected(({ routingId, data }) => {
        useSessionStore.getState().addTeammate(routingId, { ...data, status: 'running' })
      }),
      window.api.onSubagentStream(({ routingId, data }) => {
        if (data.type === 'thinking') {
          appendSubagentStreamingThinking(routingId, data.toolUseId, data.text)
        } else {
          appendSubagentStreamingText(routingId, data.toolUseId, data.text)
        }
      }),
      window.api.onSubagentMessage(({ routingId, data }) => {
        addSubagentMessage(routingId, data.toolUseId, data.message)
      }),
      window.api.onSubagentMessageBatch(({ routingId, data }) => {
        appendSubagentMessageBatch(routingId, data.toolUseId, data.messages)
      }),
      window.api.onSubagentToolResult(({ routingId, data }) => {
        appendSubagentToolResult(routingId, data.toolUseId, data.toolResultToolUseId, data.result, data.isError)
      }),
      window.api.onBackgroundOutput(({ routingId, data }) => {
        setBackgroundOutput(routingId, data.toolUseId, data.tail, data.totalSize)
      }),
      window.api.onStatusLine(({ routingId, data }) => {
        setStatusLine(routingId, data)
      }),
      window.api.onPermissionMode(({ routingId, data: mode }) => {
        setPermissionMode(mode, routingId)
      }),
      window.api.onSlashCommands(({ data: commands }) => {
        setSlashCommands(commands)
        window.api.saveSlashCommands(commands)
      }),
      window.api.onWatchUpdate(({ routingId, messages, taskNotifications, statusLine }) => {
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
      })
    ]

    // Trigger initial usage fetch
    window.api.fetchAccountUsage().then((data) => {
      useSessionStore.getState().setAccountUsage(data)
    }).catch((err) => { window.api.logError('useClaudeEvents', `Initial usage fetch failed: ${err}`) })

    // Trigger initial block usage fetch
    window.api.fetchBlockUsage().then((data) => {
      useSessionStore.getState().setBlockUsage(data)
    }).catch((err) => { window.api.logError('useClaudeEvents', `Initial block usage fetch failed: ${err}`) })

    return () => cleanups.forEach((fn) => fn())
  }, [addMessage, appendStreamingText, appendStreamingThinking, addPendingApproval, clearPendingApprovals, setStatus, addError, appendToolResult, updateTaskProgress, addTaskNotification, addSubagentMessage, appendSubagentMessageBatch, appendSubagentStreamingText, appendSubagentStreamingThinking, appendSubagentToolResult, setBackgroundOutput, setStatusLine, setPermissionMode, setSlashCommands])
}
