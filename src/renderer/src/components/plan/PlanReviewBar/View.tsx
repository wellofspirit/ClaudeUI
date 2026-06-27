export interface PlanReviewBarViewProps {
  commentCount: number
  approvalStillPending: boolean
  onSend: () => void
}

export function PlanReviewBarView({
  commentCount,
  approvalStillPending,
  onSend
}: PlanReviewBarViewProps): React.JSX.Element {
  return (
    <div data-testid="PlanReviewBar" className="shrink-0 flex items-center justify-between px-3 py-2 border-t border-border bg-bg-secondary/80">
      <span className="text-[11px] text-text-muted">
        {commentCount
          ? `${commentCount} comment${commentCount !== 1 ? 's' : ''}`
          : 'Select text to add comments'}
      </span>
      {approvalStillPending ? (
        <button
          data-testid="PlanReviewBar.send"
          onClick={onSend}
          disabled={commentCount === 0}
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
