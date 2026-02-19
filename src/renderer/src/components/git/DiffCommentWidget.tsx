import { useState, useRef, useEffect, useCallback } from 'react'
import { v4 as uuid } from 'uuid'
import { SplitSide } from '@git-diff-view/react'
import type { DiffFile } from '@git-diff-view/core'
import type { DiffComment } from '../../../../shared/types'

interface Props {
  lineNumber: number
  /** End line for range selection. Defaults to lineNumber (single line). */
  endLineNumber?: number
  side: SplitSide
  diffFile: DiffFile
  filePath: string
  /** Pre-captured line content (from gutter drag). Overrides DiffFile extraction. */
  lineContent?: string
  onClose: () => void
  onSave: (comment: DiffComment) => void
}

function getLineContent(diffFile: DiffFile, startLine: number, endLine: number, side: SplitSide): string {
  const getter = side === SplitSide.old
    ? diffFile.getOldPlainLine.bind(diffFile)
    : diffFile.getNewPlainLine.bind(diffFile)

  const lines: string[] = []
  for (let i = startLine; i <= endLine; i++) {
    try {
      const line = getter(i)
      if (line?.value != null) lines.push(line.value)
    } catch {
      // Line might not exist — skip
    }
  }
  return lines.join('\n')
}

export function DiffCommentWidget({ lineNumber, endLineNumber, side, diffFile, filePath, lineContent: preCapturedContent, onClose, onSave }: Props): React.JSX.Element {
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const startLine = Math.min(lineNumber, endLineNumber ?? lineNumber)
  const endLine = Math.max(lineNumber, endLineNumber ?? lineNumber)
  const isRange = startLine !== endLine

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  const handleSave = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed) return

    const comment: DiffComment = {
      id: uuid(),
      filePath,
      lineNumber: startLine,
      endLineNumber: endLine,
      side: side === SplitSide.old ? 'old' : 'new',
      lineContent: preCapturedContent ?? getLineContent(diffFile, startLine, endLine, side),
      comment: trimmed,
      createdAt: Date.now()
    }

    onSave(comment)
    onClose()
  }, [text, filePath, startLine, endLine, side, diffFile, onSave, onClose])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSave()
    }
  }, [onClose, handleSave])

  return (
    <div className="diff-comment-widget mx-2 my-1 rounded-md border border-accent/40 shadow-lg overflow-hidden">
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Add a review comment..."
        rows={3}
        className="w-full bg-transparent text-[12px] text-text-primary px-3 py-2 resize-none outline-none placeholder:text-text-muted/50"
      />
      <div className="diff-comment-widget-footer flex items-center justify-between px-3 py-1.5">
        <span className="text-[10px] text-text-muted">
          {isRange ? `Lines ${startLine}\u2013${endLine}` : `Line ${startLine}`}
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
