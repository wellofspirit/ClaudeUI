import { useCallback, useEffect, useRef } from 'react'
import { useSessionStore, useActiveSession } from '../../../stores/session-store'
import type { PlanComment } from '../../../../../shared/types'
import { PlanReviewBarView } from './View'
import { composePlanFeedback } from './utils'

interface Props {
  comments: PlanComment[]
}

export function PlanReviewBar({ comments }: Props): React.JSX.Element {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const dismissApproval = useSessionStore((s) => s.dismissApproval)
  const closePlanPanel = useSessionStore((s) => s.closePlanPanel)
  const planReview = useActiveSession((s) => s.planReview)
  const pendingApprovals = useActiveSession((s) => s.pendingApprovals)

  // An engine whose plan item carries NO approval (Codex native plan mode, F20)
  // has nothing that can expire, so the bar stays sendable — `null` is not an
  // approval that went away, it is the absence of one. The Claude path is
  // unchanged: the id must still be in `pendingApprovals`.
  const approvalStillPending = !planReview
    ? false
    : planReview.approvalRequestId === null
      ? true
      : pendingApprovals.some((a) => a.requestId === planReview.approvalRequestId)

  const handleSend = useCallback(async () => {
    if (!activeSessionId || !planReview || !comments.length || !approvalStillPending) return

    const feedback = composePlanFeedback(comments)

    if (planReview.approvalRequestId === null) {
      // No approval to deny — the comments ARE the next turn's prompt, which is
      // how "keep planning" works on an engine that never asked.
      await window.api.sendPrompt(activeSessionId, feedback)
    } else {
      await window.api.respondApproval(activeSessionId, planReview.approvalRequestId, 'deny', {
        feedback
      })
      dismissApproval(activeSessionId, planReview.approvalRequestId)
    }
    closePlanPanel(activeSessionId)
  }, [activeSessionId, planReview, comments, approvalStillPending, dismissApproval, closePlanPanel])

  const sendRef = useRef(handleSend)
  sendRef.current = handleSend

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
    <PlanReviewBarView
      commentCount={comments.length}
      approvalStillPending={approvalStillPending}
      onSend={handleSend}
    />
  )
}
