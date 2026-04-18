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
  const removePendingApproval = useSessionStore((s) => s.removePendingApproval)
  const closePlanPanel = useSessionStore((s) => s.closePlanPanel)
  const planReview = useActiveSession((s) => s.planReview)
  const pendingApprovals = useActiveSession((s) => s.pendingApprovals)

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
