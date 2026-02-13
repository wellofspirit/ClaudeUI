import { useState, useRef, useEffect, useCallback } from 'react'
import { useSessionStore } from '../../stores/session-store'
import { v4 as uuid } from 'uuid'
import type { PendingApproval, ChatMessage, ContentBlock } from '../../../../shared/types'

/**
 * Walk backwards through messages collecting assistant text blocks
 * until we hit a user message or an EnterPlanMode tool_use.
 * This extracts the plan text that was generated during plan mode.
 */
function extractPlanText(messages: ChatMessage[]): string {
  const textParts: string[] = []

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === 'user') break

    for (const block of msg.content) {
      if (block.type === 'tool_use' && block.toolName === 'EnterPlanMode') break
      if (block.type === 'text' && block.text) {
        textParts.unshift(block.text)
      }
    }

    // Check if any block was EnterPlanMode — if so, stop walking
    if (msg.content.some((b: ContentBlock) => b.type === 'tool_use' && b.toolName === 'EnterPlanMode')) {
      break
    }
  }

  return textParts.join('\n\n').trim()
}

/**
 * Wait for the SDK's permission mode status message to arrive.
 * Resolves when the store's permissionMode changes from its current value,
 * or after a timeout fallback.
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
    // Timeout fallback in case SDK doesn't send a mode change
    setTimeout(() => {
      unsub()
      resolve()
    }, 2000)
  })
}

export function ExitPlanModeCard({ approval }: { approval: PendingApproval }): React.JSX.Element {
  const removePendingApproval = useSessionStore((s) => s.removePendingApproval)
  const clearConversation = useSessionStore((s) => s.clearConversation)
  const setPermissionMode = useSessionStore((s) => s.setPermissionMode)
  const addUserMessage = useSessionStore((s) => s.addUserMessage)
  const messages = useSessionStore((s) => s.messages)
  const cwd = useSessionStore((s) => s.cwd)

  const [showFeedback, setShowFeedback] = useState(false)
  const [feedback, setFeedback] = useState('')
  const feedbackRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (showFeedback) feedbackRef.current?.focus()
  }, [showFeedback])

  // Option 1: Start fresh, auto-accept edits
  const handleStartFresh = useCallback(async () => {
    const planText = extractPlanText(messages)

    // Deny the ExitPlanMode tool call and wait for SDK to process it
    await window.api.respondApproval(approval.requestId, 'deny')
    removePendingApproval(approval.requestId)

    // Cancel + tear down the session
    await window.api.cancelSession()
    // Clear UI state
    clearConversation()

    if (!cwd) return

    // Create fresh session and set mode
    await window.api.createSession(cwd)
    setPermissionMode('acceptEdits')
    await window.api.setPermissionMode('acceptEdits')

    // Send the plan as a new prompt
    const prompt = `Implement the following plan:\n\n${planText}`
    addUserMessage(uuid(), prompt)
    await window.api.sendPrompt(prompt)
  }, [messages, approval.requestId, cwd, removePendingApproval, clearConversation, setPermissionMode, addUserMessage])

  // Option 2: Continue, auto-accept edits
  const handleContinueAutoEdit = useCallback(async () => {
    // Allow the tool and wait for SDK's ExitPlanMode status to settle
    await window.api.respondApproval(approval.requestId, 'allow')
    removePendingApproval(approval.requestId)
    await waitForModeChange()

    // Now override with our desired mode
    setPermissionMode('acceptEdits')
    await window.api.setPermissionMode('acceptEdits')
  }, [approval.requestId, removePendingApproval, setPermissionMode])

  // Option 3: Continue, approve manually
  const handleContinueManual = useCallback(async () => {
    // Allow the tool and wait for SDK's ExitPlanMode status to settle
    await window.api.respondApproval(approval.requestId, 'allow')
    removePendingApproval(approval.requestId)
    await waitForModeChange()

    // Ensure mode is default
    setPermissionMode('default')
    await window.api.setPermissionMode('default')
  }, [approval.requestId, removePendingApproval, setPermissionMode])

  // Option 4: Keep planning — submit feedback
  const handleKeepPlanning = useCallback(async () => {
    const text = feedback.trim()
    if (!text) return
    await window.api.respondApproval(approval.requestId, 'deny', { feedback: text })
    removePendingApproval(approval.requestId)
    setShowFeedback(false)
    setFeedback('')
  }, [feedback, approval.requestId, removePendingApproval])

  return (
    <div className="rounded-lg border border-accent/40 bg-bg-secondary overflow-hidden animate-fade-in">
      <div className="px-3 py-2">
        <div className="flex items-center gap-2 mb-2.5">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-accent shrink-0">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
          </svg>
          <span className="text-[12px] font-semibold text-accent">Ready to code?</span>
        </div>

        <div className="flex flex-col gap-1">
          {/* Option 1 */}
          <button
            onClick={handleStartFresh}
            className="w-full flex items-center gap-2.5 px-2.5 h-8 rounded-md text-[12px] text-text-primary bg-accent/10 hover:bg-accent/20 transition-colors cursor-pointer text-left"
          >
            <span className="text-accent font-medium w-4 shrink-0">1</span>
            <span>Start fresh, auto-accept edits</span>
          </button>

          {/* Option 2 */}
          <button
            onClick={handleContinueAutoEdit}
            className="w-full flex items-center gap-2.5 px-2.5 h-8 rounded-md text-[12px] text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer text-left"
          >
            <span className="text-text-muted font-medium w-4 shrink-0">2</span>
            <span>Continue, auto-accept edits</span>
          </button>

          {/* Option 3 */}
          <button
            onClick={handleContinueManual}
            className="w-full flex items-center gap-2.5 px-2.5 h-8 rounded-md text-[12px] text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer text-left"
          >
            <span className="text-text-muted font-medium w-4 shrink-0">3</span>
            <span>Continue, approve manually</span>
          </button>

          {/* Option 4 */}
          <button
            onClick={() => setShowFeedback(!showFeedback)}
            className="w-full flex items-center gap-2.5 px-2.5 h-8 rounded-md text-[12px] text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer text-left"
          >
            <span className="text-text-muted font-medium w-4 shrink-0">4</span>
            <span>Keep planning</span>
          </button>
        </div>

        {/* Feedback textarea for option 4 */}
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
    </div>
  )
}
