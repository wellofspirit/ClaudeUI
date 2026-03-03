import { useState, useRef, useEffect, useCallback } from 'react'
import { v4 as uuid } from 'uuid'
import type { PlanComment } from '../../../../shared/types'

interface Props {
  selectedText: string
  lineNumber: number
  endLineNumber: number
  sectionIndex: number
  onSave: (comment: PlanComment) => void
  onClose: () => void
}

export function PlanCommentWidget({ selectedText, lineNumber, endLineNumber, sectionIndex, onSave, onClose }: Props): React.JSX.Element {
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const isRange = lineNumber !== endLineNumber

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  const handleSave = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed) return

    const comment: PlanComment = {
      id: uuid(),
      selectedText,
      lineNumber,
      endLineNumber,
      sectionIndex,
      comment: trimmed,
      createdAt: Date.now()
    }

    onSave(comment)
    onClose()
  }, [text, selectedText, lineNumber, endLineNumber, sectionIndex, onSave, onClose])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSave()
    }
  }, [onClose, handleSave])

  // Truncate long selections for display
  const displayText = selectedText.length > 200
    ? selectedText.slice(0, 200) + '…'
    : selectedText

  return (
    <div className="plan-comment-widget mx-2 my-1.5 rounded-md border border-accent/40 shadow-lg overflow-hidden bg-bg-secondary" data-plan-comment>
      {/* Quoted selection */}
      <div className="px-3 py-2 border-b border-border/50">
        <div className="text-[11px] text-text-muted leading-[1.5] whitespace-pre-wrap break-words">
          {displayText.split('\n').map((line, i) => (
            <div key={i}>
              <span className="text-text-muted/60 select-none">&gt; </span>
              {line}
            </div>
          ))}
        </div>
      </div>

      {/* Comment textarea */}
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Add a comment…"
        rows={3}
        className="w-full bg-transparent text-[12px] text-text-primary px-3 py-2 resize-none outline-none placeholder:text-text-muted/50"
      />

      {/* Footer */}
      <div className="flex items-center justify-between px-3 py-1.5 border-t border-border/30">
        <span className="text-[10px] text-text-muted">
          {isRange ? `Lines ${lineNumber}\u2013${endLineNumber}` : `Line ${lineNumber}`}
          {' \u00b7 '}
          {'\u2318'}Enter to save
        </span>
        <div className="flex items-center gap-1.5">
          <button
            onClick={onClose}
            className="text-[11px] px-2.5 py-1 rounded border border-border text-text-muted hover:text-text-secondary hover:border-border-hover transition-colors cursor-default"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!text.trim()}
            className="text-[11px] px-2.5 py-1 rounded bg-accent text-white hover:bg-accent/90 disabled:opacity-40 disabled:cursor-default transition-colors cursor-default"
          >
            Add
          </button>
        </div>
      </div>
    </div>
  )
}
