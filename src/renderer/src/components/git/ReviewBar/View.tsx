import type { DiffComment } from '../../../../../shared/types'

export interface ReviewBarViewProps {
  comments: DiffComment[]
  fileCount: number
  onSend: () => void
}

export function ReviewBarView({
  comments,
  fileCount,
  onSend
}: ReviewBarViewProps): React.JSX.Element | null {
  if (!comments.length) return null

  return (
    <div
      data-testid="ReviewBar"
      className="shrink-0 flex items-center justify-between px-3 py-2 border-t border-border bg-bg-secondary/80"
    >
      <span className="text-[11px] text-text-muted">
        {comments.length} comment{comments.length !== 1 ? 's' : ''}
        {' \u00b7 '}
        {fileCount} file{fileCount !== 1 ? 's' : ''}
      </span>
      <button
        data-testid="ReviewBar.send"
        onClick={onSend}
        className="text-[11px] px-3 py-1 rounded bg-accent text-white hover:bg-accent/90 transition-colors cursor-default"
      >
        Send to Chat
        <span className="ml-1.5 text-[10px] opacity-60">{'\u2318\u21e7\u23ce'}</span>
      </button>
    </div>
  )
}
