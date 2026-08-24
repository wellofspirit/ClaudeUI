import { useRef, useEffect } from 'react'
import { MarkdownRenderer } from '../MarkdownRenderer'

export interface ExitPlanModeCardViewProps {
  planContent: string | null
  hasApproval: boolean
  activeSessionId: string | null

  // UI-only state
  expanded: boolean
  showFeedback: boolean
  feedback: string
  onToggleExpanded: () => void
  onToggleFeedback: () => void
  onFeedbackChange: (value: string) => void

  // IPC-driven handlers
  onOpenPlanPanel: () => void
  onStartFresh: () => void
  onContinueAutoEdit: () => void
  onContinueManual: () => void
  onKeepPlanning: () => void
}

export function ExitPlanModeCardView({
  planContent,
  hasApproval,
  activeSessionId,
  expanded,
  showFeedback,
  feedback,
  onToggleExpanded,
  onToggleFeedback,
  onFeedbackChange,
  onOpenPlanPanel,
  onStartFresh,
  onContinueAutoEdit,
  onContinueManual,
  onKeepPlanning
}: ExitPlanModeCardViewProps): React.JSX.Element {
  const feedbackRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (showFeedback) feedbackRef.current?.focus()
  }, [showFeedback])

  return (
    <div
      data-testid="ExitPlanModeCard"
      className="rounded-lg border border-accent/40 bg-bg-secondary overflow-hidden animate-fade-in"
    >
      {/* Header — clickable to toggle */}
      <div
        onClick={onToggleExpanded}
        className="w-full flex items-center gap-2 px-3 h-9 text-[13px] hover:bg-bg-hover transition-colors cursor-pointer"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="text-accent shrink-0"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
        </svg>
        <span className="font-mono font-medium text-accent">Plan</span>
        <span className="flex-1" />
        {hasApproval && planContent && (
          <button
            data-testid="ExitPlanModeCard.review"
            onClick={(e) => {
              e.stopPropagation()
              if (activeSessionId) {
                onOpenPlanPanel()
              }
            }}
            className="text-[11px] px-2 py-0.5 rounded bg-accent/10 text-accent hover:bg-accent/20 transition-colors cursor-pointer shrink-0 flex items-center gap-1"
          >
            Review
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </button>
        )}
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className={`text-text-secondary transition-transform shrink-0 ${expanded ? 'rotate-180' : ''}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </div>

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
      {hasApproval && (
        <div className="px-3 pb-2">
          <div className="flex flex-col gap-1">
            <button
              data-testid="ExitPlanModeCard.startFresh"
              onClick={onStartFresh}
              className="w-full flex items-center gap-2.5 px-2.5 h-8 rounded-md text-[12px] text-text-primary bg-accent/10 hover:bg-accent/20 transition-colors cursor-pointer text-left"
            >
              <span className="text-accent font-medium w-4 shrink-0">1</span>
              <span>Start fresh, auto-accept edits</span>
            </button>

            <button
              data-testid="ExitPlanModeCard.continueAutoEdit"
              onClick={onContinueAutoEdit}
              className="w-full flex items-center gap-2.5 px-2.5 h-8 rounded-md text-[12px] text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer text-left"
            >
              <span className="text-text-muted font-medium w-4 shrink-0">2</span>
              <span>Continue, auto-accept edits</span>
            </button>

            <button
              data-testid="ExitPlanModeCard.continueManual"
              onClick={onContinueManual}
              className="w-full flex items-center gap-2.5 px-2.5 h-8 rounded-md text-[12px] text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer text-left"
            >
              <span className="text-text-muted font-medium w-4 shrink-0">3</span>
              <span>Continue, approve manually</span>
            </button>

            <button
              data-testid="ExitPlanModeCard.keepPlanning"
              onClick={onToggleFeedback}
              className="w-full flex items-center gap-2.5 px-2.5 h-8 rounded-md text-[12px] text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer text-left"
            >
              <span className="text-text-muted font-medium w-4 shrink-0">4</span>
              <span>Keep planning</span>
            </button>
          </div>

          {showFeedback && (
            <div className="mt-2 flex flex-col gap-1.5">
              <textarea
                data-testid="ExitPlanModeCard.feedback"
                ref={feedbackRef}
                value={feedback}
                onChange={(e) => onFeedbackChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    onKeepPlanning()
                  }
                  if (e.key === 'Escape') {
                    onToggleFeedback()
                    onFeedbackChange('')
                  }
                }}
                placeholder="What should change?"
                rows={2}
                className="w-full bg-bg-primary text-[12px] text-text-primary placeholder:text-text-muted rounded-md border border-border p-2 resize-none outline-none focus:border-border-bright"
              />
              <div className="flex justify-end">
                <button
                  data-testid="ExitPlanModeCard.sendFeedback"
                  onClick={onKeepPlanning}
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
