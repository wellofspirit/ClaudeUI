import { useState, useRef, useCallback, useMemo } from 'react'
import { useSessionStore, useActiveSession } from '../../stores/session-store'
import { useTextSelectionComment, type TextSelection } from '../../hooks/useTextSelectionComment'
import { MarkdownRenderer } from '../chat/MarkdownRenderer'
import { PlanCommentWidget } from './PlanCommentWidget'
import { PlanCommentBadge } from './PlanCommentBadge'
import { PlanReviewBar } from './PlanReviewBar'
import type { PlanComment } from '../../../../shared/types'

interface Props {
  style?: React.CSSProperties
}

/**
 * Split plan content into sections at double-newline boundaries.
 * Each section is rendered separately so comment badges can be
 * interleaved between them.
 */
function splitIntoSections(content: string): string[] {
  // Split on double newlines (preserving markdown block structure)
  return content.split(/\n{2,}/).filter((s) => s.trim())
}

export function PlanReviewPanel({ style }: Props): React.JSX.Element {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const closePlanPanel = useSessionStore((s) => s.closePlanPanel)
  const addPlanComment = useSessionStore((s) => s.addPlanComment)
  const updatePlanComment = useSessionStore((s) => s.updatePlanComment)
  const removePlanComment = useSessionStore((s) => s.removePlanComment)
  const planReview = useActiveSession((s) => s.planReview)
  const uiFontScale = useSessionStore((s) => s.settings.uiFontScale)

  const contentRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const planContent = planReview?.planContent ?? ''
  const comments = planReview?.comments ?? []

  const { selection, clearSelection } = useTextSelectionComment(contentRef, planContent)
  const [commentingSelection, setCommentingSelection] = useState<TextSelection | null>(null)

  const sections = useMemo(() => splitIntoSections(planContent), [planContent])

  // Group comments by section index (stored on each comment, detected from DOM)
  const commentsBySection = useMemo(() => {
    const map: Record<number, PlanComment[]> = {}
    for (const c of comments) {
      const idx = c.sectionIndex
      if (!map[idx]) map[idx] = []
      map[idx].push(c)
    }
    return map
  }, [comments])

  const handleStartComment = useCallback(() => {
    if (!selection) return
    setCommentingSelection(selection)
    clearSelection()
    // Clear the browser selection so it doesn't look stuck
    window.getSelection()?.removeAllRanges()
  }, [selection, clearSelection])

  const handleSaveComment = useCallback((comment: PlanComment) => {
    if (!activeSessionId) return
    addPlanComment(activeSessionId, comment)
    setCommentingSelection(null)
  }, [activeSessionId, addPlanComment])

  const handleUpdateComment = useCallback((commentId: string, text: string) => {
    if (!activeSessionId) return
    updatePlanComment(activeSessionId, commentId, text)
  }, [activeSessionId, updatePlanComment])

  const handleRemoveComment = useCallback((commentId: string) => {
    if (!activeSessionId) return
    removePlanComment(activeSessionId, commentId)
  }, [activeSessionId, removePlanComment])

  const handleClose = useCallback(() => {
    if (activeSessionId) closePlanPanel(activeSessionId)
  }, [activeSessionId, closePlanPanel])

  // Calculate floating tooltip position relative to the panel.
  // getBoundingClientRect() returns screen-space coords (already scaled by CSS zoom),
  // but position:absolute top/left are in the panel's local coordinate space (pre-zoom).
  // Divide by zoom to compensate.
  const tooltipStyle = useMemo(() => {
    if (!selection || !panelRef.current) return undefined
    const panelRect = panelRef.current.getBoundingClientRect()
    const zoom = uiFontScale || 1
    return {
      position: 'absolute' as const,
      top: (selection.rect.bottom - panelRect.top) / zoom + 4,
      left: Math.max(8, (selection.rect.left - panelRect.left) / zoom),
      zIndex: 50
    }
  }, [selection, uiFontScale])

  if (!planReview) return <div />

  return (
    <div ref={panelRef} style={style} className="h-full flex flex-col bg-bg-primary border-l border-border relative">
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-4 h-12 border-b border-border">
        <span className="text-[13px] font-medium text-text-primary">Plan Review</span>
        <button
          onClick={handleClose}
          className="w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
          title="Close"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Content area */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div ref={contentRef} className="px-4 py-3">
          {sections.map((section, i) => (
            <div key={i}>
              {/* Rendered markdown section */}
              <div className="text-[12px] leading-[1.6] plan-section" data-section-index={i}>
                <MarkdownRenderer content={section} />
              </div>

              {/* Comment badges for this section */}
              {commentsBySection[i] && (
                <PlanCommentBadge
                  comments={commentsBySection[i]}
                  onUpdate={handleUpdateComment}
                  onRemove={handleRemoveComment}
                />
              )}

              {/* Comment widget if user is commenting on a selection in this section */}
              {commentingSelection && commentingSelection.sectionIndex === i && (
                <PlanCommentWidget
                  selectedText={commentingSelection.text}
                  lineNumber={commentingSelection.lineNumber}
                  endLineNumber={commentingSelection.endLineNumber}
                  sectionIndex={commentingSelection.sectionIndex}
                  onSave={handleSaveComment}
                  onClose={() => setCommentingSelection(null)}
                />
              )}

              {/* Spacer between sections */}
              {i < sections.length - 1 && <div className="h-2" />}
            </div>
          ))}
        </div>
      </div>

      {/* Floating "Comment" tooltip when text is selected */}
      {selection && !commentingSelection && tooltipStyle && (
        <div style={tooltipStyle}>
          <button
            onClick={handleStartComment}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-accent text-white text-[11px] font-medium shadow-lg hover:bg-accent/90 transition-colors cursor-default"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            Comment
          </button>
        </div>
      )}

      {/* Bottom bar */}
      <PlanReviewBar comments={comments} />
    </div>
  )
}
