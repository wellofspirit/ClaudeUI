import { useEffect } from 'react'
import { useSessionStore } from '../stores/session-store'

export function useClaudeEvents(): void {
  const addMessage = useSessionStore((s) => s.addMessage)
  const appendStreamingText = useSessionStore((s) => s.appendStreamingText)
  const setPendingApproval = useSessionStore((s) => s.setPendingApproval)
  const setStatus = useSessionStore((s) => s.setStatus)
  const setError = useSessionStore((s) => s.setError)
  const appendToolResult = useSessionStore((s) => s.appendToolResult)

  useEffect(() => {
    const cleanups = [
      window.api.onMessage((msg) => {
        addMessage(msg)
      }),
      window.api.onStreamEvent((text) => {
        appendStreamingText(text)
      }),
      window.api.onApprovalRequest((approval) => {
        setPendingApproval(approval)
      }),
      window.api.onStatus((status) => {
        setStatus(status)
        if (status.state !== 'error') setError(null)
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
  }, [addMessage, appendStreamingText, setPendingApproval, setStatus, setError, appendToolResult])
}
