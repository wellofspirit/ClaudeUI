import type { DiffComment } from '../../../../shared/types'

interface Props {
  comments: DiffComment[]
  onRemove: (commentId: string) => void
}

export function DiffCommentBadge({ comments, onRemove }: Props): React.JSX.Element {
  return (
    <div className="diff-comment-badges mx-2 my-1 flex flex-col gap-1">
      {comments.map((c) => (
        <div
          key={c.id}
          className="diff-comment-badge flex items-start gap-2 rounded-md border-l-2 border-accent/60 px-3 py-1.5 group"
        >
          <div className="flex-1 min-w-0">
            {c.endLineNumber > c.lineNumber && (
              <span className="text-[10px] text-text-muted mr-1.5">
                L{c.lineNumber}&ndash;{c.endLineNumber}
              </span>
            )}
            <span className="text-[12px] text-text-secondary whitespace-pre-wrap break-words">
              {c.comment}
            </span>
          </div>
          <button
            onClick={() => onRemove(c.id)}
            className="shrink-0 mt-0.5 w-4 h-4 flex items-center justify-center rounded text-text-muted opacity-0 group-hover:opacity-100 hover:text-text-primary hover:bg-bg-hover transition-all cursor-default"
            title="Remove comment"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  )
}
