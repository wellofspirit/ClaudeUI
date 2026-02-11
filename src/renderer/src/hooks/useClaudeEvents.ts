import { useEffect } from 'react'
import { useSessionStore } from '../stores/session-store'
import type { TodoItem } from '../../../shared/types'

/**
 * When a TodoWrite tool completes, extract the todos from its input
 * and update the store. TodoWrite replaces the entire list atomically.
 */
function processTodoWriteResult(toolUseId: string, isError: boolean): void {
  if (isError) return

  const { messages, setTodos } = useSessionStore.getState()

  // Find the TodoWrite tool_use block
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
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
          setTodos(todos)
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
  const setError = useSessionStore((s) => s.setError)
  const appendToolResult = useSessionStore((s) => s.appendToolResult)
  const updateTaskProgress = useSessionStore((s) => s.updateTaskProgress)
  const addTaskNotification = useSessionStore((s) => s.addTaskNotification)
  const markBackgroundTask = useSessionStore((s) => s.markBackgroundTask)
  const updateBackgroundOutput = useSessionStore((s) => s.updateBackgroundOutput)
  const resolveBackgroundTask = useSessionStore((s) => s.resolveBackgroundTask)

  useEffect(() => {
    const cleanups = [
      window.api.onMessage((msg) => {
        addMessage(msg)

        // Intercept TodoWrite from assistant messages directly.
        // The SDK sends partial messages with tool_use blocks — when we see
        // a TodoWrite tool_use, we can extract the todos from its input
        // immediately (we don't need to wait for the tool_result).
        for (const b of msg.content) {
          if (b.type === 'tool_use' && b.toolName === 'TodoWrite' && b.toolInput) {
            const input = b.toolInput
            if (Array.isArray(input.todos)) {
              const todos: TodoItem[] = input.todos.map((t: Record<string, unknown>) => ({
                content: String(t.content || ''),
                status: (t.status as TodoItem['status']) || 'pending',
                activeForm: String(t.activeForm || '')
              }))
              useSessionStore.getState().setTodos(todos)
            }
          }
        }
      }),
      window.api.onStreamEvent((data) => {
        if (data.type === 'thinking') {
          appendStreamingThinking(data.text)
        } else {
          appendStreamingText(data.text)
        }
      }),
      window.api.onApprovalRequest((approval) => {
        addPendingApproval(approval)
      }),
      window.api.onStatus((status) => {
        setStatus(status)
        if (status.state !== 'error') setError(null)
        if (status.state === 'idle') clearPendingApprovals()
      }),
      window.api.onResult(() => {
        // Cost/duration handled via status
      }),
      window.api.onError((error) => {
        setError(error)
      }),
      window.api.onToolResult(({ toolUseId, result, isError }) => {
        appendToolResult(toolUseId, result, isError)
        // Also update todos on tool_result in case the input wasn't captured earlier
        processTodoWriteResult(toolUseId, isError)
      }),
      window.api.onTaskProgress((data) => {
        updateTaskProgress(data)
      }),
      window.api.onTaskNotification((data) => {
        // If this notification has a toolUseId, resolve the background task
        if (data.toolUseId) {
          resolveBackgroundTask(data.toolUseId, data)
        } else {
          addTaskNotification(data)
        }
      }),
      window.api.onBackgroundTaskStarted((data) => {
        markBackgroundTask(data.toolUseId)
      }),
      window.api.onBackgroundOutput((data) => {
        updateBackgroundOutput(data.toolUseId, data.messages)
      })
    ]

    return () => cleanups.forEach((fn) => fn())
  }, [addMessage, appendStreamingText, appendStreamingThinking, addPendingApproval, clearPendingApprovals, setStatus, setError, appendToolResult, updateTaskProgress, addTaskNotification, markBackgroundTask, updateBackgroundOutput, resolveBackgroundTask])
}
