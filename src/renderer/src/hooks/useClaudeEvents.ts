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
  const appendSubagentStreamingText = useSessionStore((s) => s.appendSubagentStreamingText)
  const appendSubagentStreamingThinking = useSessionStore((s) => s.appendSubagentStreamingThinking)
  const appendSubagentToolResult = useSessionStore((s) => s.appendSubagentToolResult)
  const setBackgroundOutput = useSessionStore((s) => s.setBackgroundOutput)
  const setPermissionMode = useSessionStore((s) => s.setPermissionMode)

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
        if (status.state === 'disconnected') {
          useSessionStore.getState().markSdkInactive(routingId)
          setStatus(routingId, { ...status, state: 'idle' })
          clearPendingApprovals(routingId)
          return
        }
        setStatus(routingId, status)
        if (status.state === 'idle') {
          clearPendingApprovals(routingId)
        }
        // Clear attention when a new turn starts
        if (status.state === 'running') {
          useSessionStore.getState().setNeedsAttention(routingId, false)
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
      window.api.onSubagentToolResult(({ routingId, data }) => {
        appendSubagentToolResult(routingId, data.toolUseId, data.toolResultToolUseId, data.result, data.isError)
      }),
      window.api.onBackgroundOutput(({ routingId, data }) => {
        setBackgroundOutput(routingId, data.toolUseId, data.tail, data.totalSize)
      }),
      window.api.onPermissionMode(({ routingId, data: mode }) => {
        setPermissionMode(mode, routingId)
      }),
      window.api.onWatchUpdate(({ routingId, messages, taskNotifications }) => {
        useSessionStore.getState().updateWatchedSession(routingId, messages, taskNotifications)
        rebuildTodos(routingId)
        // Dismiss completed task list for watched sessions (no result event)
        const session = useSessionStore.getState().sessions[routingId]
        if (session && session.todos.length > 0) {
          const allDone = session.todos.every((t) => t.status === 'completed')
          if (allDone) useSessionStore.getState().setTodos(routingId, [])
        }
      })
    ]

    return () => cleanups.forEach((fn) => fn())
  }, [addMessage, appendStreamingText, appendStreamingThinking, addPendingApproval, clearPendingApprovals, setStatus, addError, appendToolResult, updateTaskProgress, addTaskNotification, addSubagentMessage, appendSubagentStreamingText, appendSubagentStreamingThinking, appendSubagentToolResult, setBackgroundOutput, setPermissionMode])
}
