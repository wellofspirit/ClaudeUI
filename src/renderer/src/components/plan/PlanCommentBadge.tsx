import { useState, useRef, useEffect, useCallback } from 'react'
import type { PlanComment } from '../../../../shared/types'

interface Props {
  comments: PlanComment[]
  onUpdate: (commentId: string, text: string) => void
  onRemove: (commentId: string) => void
}

function EditableComment({ comment, onUpdate, onRemove }: {
  comment: PlanComment
  onUpdate: (commentId: string, text: string) => void
  onRemove: (commentId: string) => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(comment.comment)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (editing) textareaRef.current?.focus()
  }, [editing])

  const handleSave = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed) return
    onUpdate(comment.id, trimmed)
    setEditing(false)
  }, [text, comment.id, onUpdate])

  const handleCancel = useCallback(() => {
    setText(comment.comment)
    setEditing(false)
  }, [comment.comment])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      handleCancel()
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSave()
    }
  }, [handleCancel, handleSave])

  return (
    <div className="flex flex-col rounded-md border-l-2 border-accent/60 bg-accent/5 px-3 py-1.5 group">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          {/* Quoted selection (truncated) */}
          <div className="text-[10px] text-text-muted/70 leading-[1.4] mb-0.5 line-clamp-2">
            &ldquo;{comment.selectedText}&rdquo;
          </div>
          {/* Line range label */}
          {comment.endLineNumber > comment.lineNumber && (
            <span className="text-[10px] text-text-muted mr-1.5">
              L{comment.lineNumber}&ndash;{comment.endLineNumber}
            </span>
          )}
          {/* Comment text or edit textarea */}
          {editing ? (
            <div className="mt-1">
              <textarea
                ref={textareaRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={handleKeyDown}
                rows={2}
                className="w-full bg-bg-primary text-[12px] text-text-primary rounded border border-border p-1.5 resize-none outline-none focus:border-border-bright"
              />
              <div className="flex items-center justify-end gap-1.5 mt-1">
                <span className="text-[10px] text-text-muted mr-auto">{'\u2318'}Enter to save</span>
                <button
                  onClick={handleCancel}
                  className="text-[10px] px-2 py-0.5 rounded border border-border text-text-muted hover:text-text-secondary transition-colors cursor-default"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  disabled={!text.trim()}
                  className="text-[10px] px-2 py-0.5 rounded bg-accent text-white hover:bg-accent/90 disabled:opacity-40 transition-colors cursor-default"
                >
                  Save
                </button>
              </div>
            </div>
          ) : (
            <span className="text-[12px] text-text-secondary whitespace-pre-wrap break-words">
              {comment.comment}
            </span>
          )}
        </div>
        {/* Action buttons — only visible on hover, hidden during editing */}
        {!editing && (
          <div className="shrink-0 flex items-center gap-0.5 mt-0.5 opacity-0 group-hover:opacity-100 transition-all">
            <button
              onClick={() => setEditing(true)}
              className="w-4 h-4 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-bg-hover cursor-default"
              title="Edit comment"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
            </button>
            <button
              onClick={() => onRemove(comment.id)}
              className="w-4 h-4 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-bg-hover cursor-default"
              title="Remove comment"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export function PlanCommentBadge({ comments, onUpdate, onRemove }: Props): React.JSX.Element {
  return (
    <div className="plan-comment-badges mx-2 my-1.5 flex flex-col gap-1" data-plan-comment>
      {comments.map((c) => (
        <EditableComment
          key={c.id}
          comment={c}
          onUpdate={onUpdate}
          onRemove={onRemove}
        />
      ))}
    </div>
  )
}
