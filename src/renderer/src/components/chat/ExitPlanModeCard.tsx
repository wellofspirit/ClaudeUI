import { useState, useRef, useEffect, useCallback } from 'react'
import { useSessionStore, useActiveSession } from '../../stores/session-store'
import { v4 as uuid } from 'uuid'
import type { PendingApproval, ContentBlock } from '../../../../shared/types'
import { MarkdownRenderer } from './MarkdownRenderer'

/**
 * Wait for the SDK's permission mode status message to arrive.
 * When ExitPlanMode is allowed, the SDK sends a status change back to 'default'.
 * We must wait for that before setting our desired mode, otherwise the SDK's
 * status change will overwrite ours.
 */
function waitForModeChange(): Promise<void> {
  return new Promise((resolve) => {
    const currentMode = useSessionStore.getState().permissionMode
    const unsub = useSessionStore.subscribe((state) => {
      if (state.permissionMode !== currentMode) {
        unsub()
        resolve()
      }
    })
    setTimeout(() => {
      unsub()
      resolve()
    }, 2000)
  })
}

interface ExitPlanModeCardProps {
  block: ContentBlock
  approval?: PendingApproval
}

export function ExitPlanModeCard({ block, approval }: ExitPlanModeCardProps): React.JSX.Element {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const removePendingApproval = useSessionStore((s) => s.removePendingApproval)
  const clearConversation = useSessionStore((s) => s.clearConversation)
  const setPermissionMode = useSessionStore((s) => s.setPermissionMode)
  const addUserMessage = useSessionStore((s) => s.addUserMessage)
  const markSdkActive = useSessionStore((s) => s.markSdkActive)
  const cwd = useActiveSession((s) => s.cwd)

  const [expanded, setExpanded] = useState(true)
  const [showFeedback, setShowFeedback] = useState(false)
  const [feedback, setFeedback] = useState('')
  const feedbackRef = useRef<HTMLTextAreaElement>(null)

  // Plan content comes from the ExitPlanMode tool input
  const planContent = (block.toolInput?.plan as string) || null

  useEffect(() => {
    if (showFeedback) feedbackRef.current?.focus()
  }, [showFeedback])

  // Option 1: Start fresh, auto-accept edits
  const handleStartFresh = useCallback(async () => {
    if (!planContent || !cwd || !approval || !activeSessionId) return

    // Get the session log path before cancelling (for transcript reference)
    const sessionLogPath = await window.api.getSessionLogPath(activeSessionId)

    await window.api.respondApproval(activeSessionId, approval.requestId, 'deny')
    removePendingApproval(activeSessionId, approval.requestId)

    await window.api.cancelSession(activeSessionId)
    clearConversation(activeSessionId)

    // Create a fresh SDK session for the same routingId
    const { effort } = useSessionStore.getState()
    await window.api.createSession(activeSessionId, cwd, effort)
    markSdkActive(activeSessionId)
    setPermissionMode('acceptEdits')
    await window.api.setPermissionMode(activeSessionId, 'acceptEdits')

    // Build prompt matching CLI format, including transcript reference
    let prompt = `Implement the following plan:\n\n${planContent}`
    if (sessionLogPath) {
      prompt += `\n\nIf you need specific details from before exiting plan mode (like exact code snippets, error messages, or content you generated), read the full transcript at: ${sessionLogPath}`
    }
    addUserMessage(activeSessionId, uuid(), prompt, planContent)
    await window.api.sendPrompt(activeSessionId, prompt)
  }, [planContent, approval, cwd, activeSessionId, removePendingApproval, clearConversation, setPermissionMode, addUserMessage, markSdkActive])

  // Option 2: Continue, auto-accept edits
  const handleContinueAutoEdit = useCallback(async () => {
    if (!approval || !activeSessionId) return
    await window.api.respondApproval(activeSessionId, approval.requestId, 'allow')
    removePendingApproval(activeSessionId, approval.requestId)
    await waitForModeChange()

    setPermissionMode('acceptEdits')
    await window.api.setPermissionMode(activeSessionId, 'acceptEdits')
  }, [approval, activeSessionId, removePendingApproval, setPermissionMode])

  // Option 3: Continue, approve manually
  const handleContinueManual = useCallback(async () => {
    if (!approval || !activeSessionId) return
    await window.api.respondApproval(activeSessionId, approval.requestId, 'allow')
    removePendingApproval(activeSessionId, approval.requestId)
    await waitForModeChange()

    setPermissionMode('default')
    await window.api.setPermissionMode(activeSessionId, 'default')
  }, [approval, activeSessionId, removePendingApproval, setPermissionMode])

  // Option 4: Keep planning — submit feedback
  const handleKeepPlanning = useCallback(async () => {
    if (!approval || !activeSessionId) return
    const text = feedback.trim()
    if (!text) return
    await window.api.respondApproval(activeSessionId, approval.requestId, 'deny', { feedback: text })
    removePendingApproval(activeSessionId, approval.requestId)
    setShowFeedback(false)
    setFeedback('')
  }, [feedback, approval, activeSessionId, removePendingApproval])

  return (
    <div className="rounded-lg border border-accent/40 bg-bg-secondary overflow-hidden animate-fade-in">
      {/* Header — clickable to toggle */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 h-9 text-[13px] hover:bg-bg-hover transition-colors cursor-pointer"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-accent shrink-0">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
        </svg>
        <span className="font-mono font-medium text-accent">Plan</span>
        <span className="flex-1" />
        <svg
          width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          className={`text-text-secondary transition-transform shrink-0 ${expanded ? 'rotate-180' : ''}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {/* Plan content — collapsible */}
      {expanded && (
        <div className="border-t border-border px-3 py-2.5">
          {planContent ? (
            <div className="text-[12px] leading-[1.6]">
              <MarkdownRenderer content={planContent} />
            </div>
          ) : (
            <div className="text-[12px] text-text-muted py-2">Could not load plan content.</div>
          )}
        </div>
      )}

      {/* Action buttons — only shown when approval is pending */}
      {approval && (
        <div className="px-3 pb-2">
          <div className="flex flex-col gap-1">
            <button
              onClick={handleStartFresh}
              className="w-full flex items-center gap-2.5 px-2.5 h-8 rounded-md text-[12px] text-text-primary bg-accent/10 hover:bg-accent/20 transition-colors cursor-pointer text-left"
            >
              <span className="text-accent font-medium w-4 shrink-0">1</span>
              <span>Start fresh, auto-accept edits</span>
            </button>

            <button
              onClick={handleContinueAutoEdit}
              className="w-full flex items-center gap-2.5 px-2.5 h-8 rounded-md text-[12px] text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer text-left"
            >
              <span className="text-text-muted font-medium w-4 shrink-0">2</span>
              <span>Continue, auto-accept edits</span>
            </button>

            <button
              onClick={handleContinueManual}
              className="w-full flex items-center gap-2.5 px-2.5 h-8 rounded-md text-[12px] text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer text-left"
            >
              <span className="text-text-muted font-medium w-4 shrink-0">3</span>
              <span>Continue, approve manually</span>
            </button>

            <button
              onClick={() => setShowFeedback(!showFeedback)}
              className="w-full flex items-center gap-2.5 px-2.5 h-8 rounded-md text-[12px] text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer text-left"
            >
              <span className="text-text-muted font-medium w-4 shrink-0">4</span>
              <span>Keep planning</span>
            </button>
          </div>

          {showFeedback && (
            <div className="mt-2 flex flex-col gap-1.5">
              <textarea
                ref={feedbackRef}
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    handleKeepPlanning()
                  }
                  if (e.key === 'Escape') {
                    setShowFeedback(false)
                    setFeedback('')
                  }
                }}
                placeholder="What should change?"
                rows={2}
                className="w-full bg-bg-primary text-[12px] text-text-primary placeholder:text-text-muted rounded-md border border-border p-2 resize-none outline-none focus:border-border-bright"
              />
              <div className="flex justify-end">
                <button
                  onClick={handleKeepPlanning}
                  disabled={!feedback.trim()}
                  className="h-6 px-3 text-[11px] font-medium text-accent bg-accent/10 rounded-md hover:bg-accent/20 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-default"
                >
                  Send feedback
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
