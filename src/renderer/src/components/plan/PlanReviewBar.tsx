import { useCallback, useEffect, useRef } from 'react'
import { useSessionStore, useActiveSession } from '../../stores/session-store'
import type { PlanComment } from '../../../../shared/types'

function composePlanFeedback(comments: PlanComment[]): string {
  const sorted = [...comments].sort((a, b) => a.lineNumber - b.lineNumber)
  const parts: string[] = ['Please revise the plan based on these comments:\n']

  for (const c of sorted) {
    const lineLabel = c.endLineNumber > c.lineNumber
      ? `lines ${c.lineNumber}\u2013${c.endLineNumber}`
      : `line ${c.lineNumber}`

    parts.push(`**${lineLabel}:**`)

    // Quote the selected text
    const quoted = c.selectedText.split('\n').map((l) => `> ${l}`).join('\n')
    parts.push(quoted)
    parts.push(`Comment: "${c.comment}"\n`)
  }

  return parts.join('\n')
}

interface Props {
  comments: PlanComment[]
}

export function PlanReviewBar({ comments }: Props): React.JSX.Element {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const removePendingApproval = useSessionStore((s) => s.removePendingApproval)
  const closePlanPanel = useSessionStore((s) => s.closePlanPanel)
  const planReview = useActiveSession((s) => s.planReview)
  const pendingApprovals = useActiveSession((s) => s.pendingApprovals)

  // Check if the approval is still pending
  const approvalStillPending = planReview
    ? pendingApprovals.some((a) => a.requestId === planReview.approvalRequestId)
    : false

  const handleSend = useCallback(async () => {
    if (!activeSessionId || !planReview || !comments.length || !approvalStillPending) return

    const feedback = composePlanFeedback(comments)

    await window.api.respondApproval(activeSessionId, planReview.approvalRequestId, 'deny', { feedback })
    removePendingApproval(activeSessionId, planReview.approvalRequestId)
    closePlanPanel(activeSessionId)
  }, [activeSessionId, planReview, comments, approvalStillPending, removePendingApproval, closePlanPanel])

  // Stable ref so the keydown handler always sees the latest handleSend
  const sendRef = useRef(handleSend)
  sendRef.current = handleSend

  // ⌘⇧Enter / Ctrl+Shift+Enter to send all comments
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Enter' && e.shiftKey && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        sendRef.current()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  return (
    <div className="shrink-0 flex items-center justify-between px-3 py-2 border-t border-border bg-bg-secondary/80">
      <span className="text-[11px] text-text-muted">
        {comments.length
          ? `${comments.length} comment${comments.length !== 1 ? 's' : ''}`
          : 'Select text to add comments'}
      </span>
      {approvalStillPending ? (
        <button
          onClick={handleSend}
          disabled={!comments.length}
          className="text-[11px] px-3 py-1 rounded bg-accent text-white hover:bg-accent/90 disabled:opacity-40 disabled:cursor-default transition-colors cursor-default"
        >
          Send Comments
          <span className="ml-1.5 text-[10px] opacity-60">{'\u2318\u21e7\u23ce'}</span>
        </button>
      ) : (
        <span className="text-[11px] text-text-muted italic">Feedback already sent</span>
      )}
    </div>
  )
}
