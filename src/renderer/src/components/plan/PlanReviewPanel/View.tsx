import { useState, useRef, useCallback, useMemo } from 'react'
import type { PlanComment, PlanReviewData } from '../../../../../shared/types'
import { useTextSelectionComment, type TextSelection } from '../../../hooks/useTextSelectionComment'
import { MarkdownRenderer } from '../../chat/MarkdownRenderer'
import { PlanCommentWidget } from '../PlanCommentWidget'
import { PlanCommentBadge } from '../PlanCommentBadge'
import { PlanReviewBar } from '../PlanReviewBar'

export interface PlanReviewPanelViewProps {
  style?: React.CSSProperties
  planReview: PlanReviewData
  uiFontScale: number
  onClose: () => void
  onSaveComment: (comment: PlanComment) => void
  onUpdateComment: (commentId: string, text: string) => void
  onRemoveComment: (commentId: string) => void
}

function splitIntoSections(content: string): string[] {
  return content.split(/\n{2,}/).filter((s) => s.trim())
}

export function PlanReviewPanelView({
  style,
  planReview,
  uiFontScale,
  onClose,
  onSaveComment,
  onUpdateComment,
  onRemoveComment
}: PlanReviewPanelViewProps): React.JSX.Element {
  const contentRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const planContent = planReview.planContent ?? ''
  const comments = planReview.comments ?? []

  const { selection, clearSelection } = useTextSelectionComment(contentRef, planContent)
  const [commentingSelection, setCommentingSelection] = useState<TextSelection | null>(null)

  const sections = useMemo(() => splitIntoSections(planContent), [planContent])

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
    window.getSelection()?.removeAllRanges()
  }, [selection, clearSelection])

  const handleSaveComment = useCallback(
    (comment: PlanComment) => {
      onSaveComment(comment)
      setCommentingSelection(null)
    },
    [onSaveComment]
  )

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

  return (
    <div
      ref={panelRef}
      style={style}
      className="h-full flex flex-col bg-bg-primary border-l border-border relative"
    >
      <div className="shrink-0 flex items-center justify-between px-4 h-12 border-b border-border">
        <span className="text-[13px] font-medium text-text-primary">Plan Review</span>
        <button
          onClick={onClose}
          className="w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
          title="Close"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div ref={contentRef} className="px-4 py-3">
          {sections.map((section, i) => (
            <div key={i}>
              <div className="text-[12px] leading-[1.6] plan-section" data-section-index={i}>
                <MarkdownRenderer content={section} />
              </div>

              {commentsBySection[i] && (
                <PlanCommentBadge
                  comments={commentsBySection[i]}
                  onUpdate={onUpdateComment}
                  onRemove={onRemoveComment}
                />
              )}

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

              {i < sections.length - 1 && <div className="h-2" />}
            </div>
          ))}
        </div>
      </div>

      {selection && !commentingSelection && tooltipStyle && (
        <div style={tooltipStyle}>
          <button
            onClick={handleStartComment}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-accent text-white text-[11px] font-medium shadow-lg hover:bg-accent/90 transition-colors cursor-default"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            Comment
          </button>
        </div>
      )}

      <PlanReviewBar comments={comments} />
    </div>
  )
}
