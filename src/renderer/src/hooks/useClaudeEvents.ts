import { useEffect } from 'react'
import { useSessionStore } from '../stores/session-store'

export function useClaudeEvents(): void {
  const addMessage = useSessionStore((s) => s.addMessage)
  const appendStreamingText = useSessionStore((s) => s.appendStreamingText)
  const appendStreamingThinking = useSessionStore((s) => s.appendStreamingThinking)
  const addPendingApproval = useSessionStore((s) => s.addPendingApproval)
  const clearPendingApprovals = useSessionStore((s) => s.clearPendingApprovals)
  const setStatus = useSessionStore((s) => s.setStatus)
  const setError = useSessionStore((s) => s.setError)
  const appendToolResult = useSessionStore((s) => s.appendToolResult)

  useEffect(() => {
    const cleanups = [
      window.api.onMessage((msg) => {
        addMessage(msg)
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
      })
    ]

    return () => cleanups.forEach((fn) => fn())
  }, [addMessage, appendStreamingText, appendStreamingThinking, addPendingApproval, clearPendingApprovals, setStatus, setError, appendToolResult])
}
