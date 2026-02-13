import { useEffect } from 'react'
import { useSessionStore } from '../stores/session-store'
import type { TodoItem } from '../../../shared/types'

/**
 * When a TodoWrite tool completes, extract the todos from its input
 * and update the store. TodoWrite replaces the entire list atomically.
 */
function processTodoWriteResult(routingId: string, toolUseId: string, isError: boolean): void {
  if (isError) return

  const { sessions, setTodos } = useSessionStore.getState()
  const session = sessions[routingId]
  if (!session) return

  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i]
    if (msg.role !== 'assistant') continue
    for (const b of msg.content) {
      if (b.type === 'tool_use' && b.toolUseId === toolUseId && b.toolName === 'TodoWrite') {
        const input = b.toolInput
        if (input && Array.isArray(input.todos)) {
          const todos: TodoItem[] = input.todos.map((t: Record<string, unknown>) => ({
            content: String(t.content || ''),
            status: (t.status as TodoItem['status']) || 'pending',
            activeForm: String(t.activeForm || '')
          }))
          setTodos(routingId, todos)
        }
        return
      }
    }
  }
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

  useEffect(() => {
    const cleanups = [
      window.api.onMessage(({ routingId, data: msg }) => {
        addMessage(routingId, msg)

        // Intercept TodoWrite from assistant messages directly.
        for (const b of msg.content) {
          if (b.type === 'tool_use' && b.toolName === 'TodoWrite' && b.toolInput) {
            const input = b.toolInput
            if (Array.isArray(input.todos)) {
              const todos: TodoItem[] = input.todos.map((t: Record<string, unknown>) => ({
                content: String(t.content || ''),
                status: (t.status as TodoItem['status']) || 'pending',
                activeForm: String(t.activeForm || '')
              }))
              useSessionStore.getState().setTodos(routingId, todos)
            }
          }
        }
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
      }),
      window.api.onStatus(({ routingId, data: status }) => {
        setStatus(routingId, status)
        if (status.state === 'idle') clearPendingApprovals(routingId)
      }),
      window.api.onResult(() => {
        // Cost/duration handled via status
      }),
      window.api.onError(({ routingId, data: error }) => {
        addError(routingId, error)
      }),
      window.api.onToolResult(({ routingId, data: { toolUseId, result, isError } }) => {
        appendToolResult(routingId, toolUseId, result, isError)
        processTodoWriteResult(routingId, toolUseId, isError)
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
      window.api.onPermissionMode(({ data: mode }) => {
        setPermissionMode(mode)
      })
    ]

    return () => cleanups.forEach((fn) => fn())
  }, [addMessage, appendStreamingText, appendStreamingThinking, addPendingApproval, clearPendingApprovals, setStatus, addError, appendToolResult, updateTaskProgress, addTaskNotification, addSubagentMessage, appendSubagentStreamingText, appendSubagentStreamingThinking, appendSubagentToolResult, setBackgroundOutput, setPermissionMode])
}
