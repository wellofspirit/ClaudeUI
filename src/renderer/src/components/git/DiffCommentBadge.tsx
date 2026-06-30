import type { DiffComment } from '../../../../shared/types'

interface Props {
  comments: DiffComment[]
  onEdit: (comment: DiffComment) => void
  onRemove: (commentId: string) => void
}

const btnClass =
  'shrink-0 mt-0.5 w-4 h-4 flex items-center justify-center rounded text-text-muted opacity-0 group-hover:opacity-100 hover:text-text-primary hover:bg-bg-hover transition-all cursor-default'

export function DiffCommentBadge({ comments, onEdit, onRemove }: Props): React.JSX.Element {
  return (
    <div data-testid="DiffCommentBadge" className="diff-comment-badges mx-2 my-1 flex flex-col gap-1">
      {comments.map((c) => (
        <div
          key={c.id}
          data-testid="DiffCommentBadge.item"
          data-id={c.id}
          className="diff-comment-badge flex items-start gap-2 rounded-md border border-border-bright border-l-2 border-l-accent/60 px-3 py-1.5 group"
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
          <div className="flex items-center gap-0.5">
            <button data-testid="DiffCommentBadge.edit" onClick={() => onEdit(c)} className={btnClass} title="Edit comment">
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
                <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
              </svg>
            </button>
            <button data-testid="DiffCommentBadge.remove" onClick={() => onRemove(c.id)} className={btnClass} title="Remove comment">
              <svg
                width="10"
                height="10"
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
        </div>
      ))}
    </div>
  )
}
