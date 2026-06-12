import { useCallback } from 'react'
import { useSessionStore, useActiveSession } from '../../../stores/session-store'
import type { PlanComment } from '../../../../../shared/types'
import { PlanReviewPanelView } from './View'

interface Props {
  style?: React.CSSProperties
}

export function PlanReviewPanel({ style }: Props): React.JSX.Element {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const closePlanPanel = useSessionStore((s) => s.closePlanPanel)
  const addPlanComment = useSessionStore((s) => s.addPlanComment)
  const updatePlanComment = useSessionStore((s) => s.updatePlanComment)
  const removePlanComment = useSessionStore((s) => s.removePlanComment)
  const planReview = useActiveSession((s) => s.planReview)
  const uiFontScale = useSessionStore((s) => s.settings.uiFontScale)

  const handleSaveComment = useCallback(
    (comment: PlanComment) => {
      if (activeSessionId) addPlanComment(activeSessionId, comment)
    },
    [activeSessionId, addPlanComment]
  )

  const handleUpdateComment = useCallback(
    (commentId: string, text: string) => {
      if (activeSessionId) updatePlanComment(activeSessionId, commentId, text)
    },
    [activeSessionId, updatePlanComment]
  )

  const handleRemoveComment = useCallback(
    (commentId: string) => {
      if (activeSessionId) removePlanComment(activeSessionId, commentId)
    },
    [activeSessionId, removePlanComment]
  )

  const handleClose = useCallback(() => {
    if (activeSessionId) closePlanPanel(activeSessionId)
  }, [activeSessionId, closePlanPanel])

  if (!planReview) return <div />

  return (
    <PlanReviewPanelView
      style={style}
      planReview={planReview}
      uiFontScale={uiFontScale}
      onClose={handleClose}
      onSaveComment={handleSaveComment}
      onUpdateComment={handleUpdateComment}
      onRemoveComment={handleRemoveComment}
    />
  )
}
