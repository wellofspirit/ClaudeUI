import { useEffect, useCallback, useMemo, useRef, useState } from 'react'
import { useActiveSession, useSessionStore } from '../../stores/session-store'
import { DiffViewer, type ActiveCommentInput, type ExtendLineData } from '../chat/DiffViewer'
import { DiffCommentWidget } from './DiffCommentWidget'
import { DiffCommentBadge } from './DiffCommentBadge'
import { ReviewBar } from './ReviewBar'
import { useGutterDragSelection, type GutterSelection } from '../../hooks/useGutterDragSelection'
import type { DiffComment } from '../../../../shared/types'
import type { DiffFile } from '@git-diff-view/core'
import { SplitSide } from '@git-diff-view/react'

export function GitFileDiffView(): React.JSX.Element {
  const cwd = useActiveSession((s) => s.cwd)
  const gitSelectedFile = useActiveSession((s) => s.gitSelectedFile)
  const gitFileDiff = useActiveSession((s) => s.gitFileDiff)
  const gitStatus = useActiveSession((s) => s.gitStatus)
  const gitReviewComments = useActiveSession((s) => s.gitReviewComments)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const setGitFileDiff = useSessionStore((s) => s.setGitFileDiff)
  const addDiffComment = useSessionStore((s) => s.addDiffComment)
  const removeDiffComment = useSessionStore((s) => s.removeDiffComment)
  const diffIgnoreWhitespace = useSessionStore((s) => s.settings.diffIgnoreWhitespace)
  const diffWrapLines = useSessionStore((s) => s.settings.diffWrapLines)
  const updateSettings = useSessionStore((s) => s.updateSettings)

  // Active inline input from gutter drag — rendered via extendData at the end line
  const [activeInput, setActiveInput] = useState<ActiveCommentInput | null>(null)

  // Comments for the currently selected file only
  const fileComments = useMemo(
    () => gitReviewComments.filter((c) => c.filePath === gitSelectedFile),
    [gitReviewComments, gitSelectedFile]
  )

  // Key to force DiffView remount when extendData changes. The library's internal
  // reactivity store doesn't pick up extendData prop changes, so we derive a key
  // from both saved comment IDs and active input state.
  const extendDataKey = useMemo(
    () => fileComments.map((c) => c.id).join(',') + (activeInput ? `|${activeInput.lineNumber}` : ''),
    [fileComments, activeInput]
  )

  // Gutter drag selection → open inline input at the end line
  const handleGutterSelect = useCallback((selection: GutterSelection) => {
    setActiveInput({
      lineNumber: selection.endLine,
      side: selection.side,
      startLine: selection.startLine,
      endLine: selection.endLine,
      lineContent: selection.lineContent
    })
  }, [])

  const { containerRef: gutterRef } = useGutterDragSelection(handleGutterSelect)

  // Combined ref: feeds the gutter drag hook AND stores the DOM node locally
  const containerNodeRef = useRef<HTMLDivElement | null>(null)
  const containerRef = useCallback((node: HTMLDivElement | null) => {
    containerNodeRef.current = node
    gutterRef(node)
  }, [gutterRef])

  // Clear active input when switching files
  useEffect(() => {
    setActiveInput(null)
  }, [gitSelectedFile])

  // Fetch patch when selected file or ignore-whitespace toggle changes
  useEffect(() => {
    if (!cwd || !gitSelectedFile || !activeSessionId || !gitStatus) {
      if (activeSessionId) setGitFileDiff(activeSessionId, null)
      return
    }

    const fileStatus = gitStatus.files.find((f) => f.path === gitSelectedFile)
    if (!fileStatus) return

    const staged = fileStatus.index !== ' ' && fileStatus.index !== '?'

    window.api.gitGetFilePatch(cwd, gitSelectedFile, staged, diffIgnoreWhitespace).then((diff) => {
      setGitFileDiff(activeSessionId, diff)
    }).catch(() => {
      setGitFileDiff(activeSessionId, null)
    })
  }, [cwd, gitSelectedFile, activeSessionId, setGitFileDiff, gitStatus, diffIgnoreWhitespace])

  // Background-fetch full file content for hunk expansion after patch loads
  useEffect(() => {
    if (!cwd || !gitSelectedFile || !activeSessionId || !gitStatus || !gitFileDiff?.patch) return
    if (gitFileDiff.oldContent != null || gitFileDiff.newContent != null) return

    const fileStatus = gitStatus.files.find((f) => f.path === gitSelectedFile)
    if (!fileStatus) return

    const staged = fileStatus.index !== ' ' && fileStatus.index !== '?'

    window.api.gitGetFileContents(cwd, gitSelectedFile, staged).then(({ oldContent, newContent }) => {
      const current = useSessionStore.getState().sessions[activeSessionId]?.gitFileDiff
      if (current?.patch) {
        setGitFileDiff(activeSessionId, { ...current, oldContent, newContent })
      }
    }).catch(() => {})
  }, [cwd, gitSelectedFile, activeSessionId, gitStatus, gitFileDiff?.patch])

  // Highlight rows that have comments or an active input selection.
  // Runs after DiffViewer (re)mounts (keyed by extendDataKey), with a short
  // delay so the library has time to render the table rows.
  useEffect(() => {
    const container = containerNodeRef.current
    if (!container) return

    const timer = setTimeout(() => {
      // Clear previous highlights
      container.querySelectorAll('.diff-comment-highlight').forEach((el) => {
        el.classList.remove('diff-comment-highlight')
      })

      // Collect all line ranges to highlight
      const ranges: Array<{ start: number; end: number; side: 'old' | 'new' }> = []
      for (const c of fileComments) {
        ranges.push({ start: c.lineNumber, end: c.endLineNumber, side: c.side })
      }
      if (activeInput) {
        ranges.push({ start: activeInput.startLine, end: activeInput.endLine, side: activeInput.side })
      }

      for (const range of ranges) {
        const selectors = range.side === 'old'
          ? ['[data-line-old-num]', 'td.diff-line-old-num [data-line-num]']
          : ['[data-line-new-num]', 'td.diff-line-new-num [data-line-num]']

        for (const selector of selectors) {
          container.querySelectorAll(selector).forEach((span) => {
            const attr = (span as HTMLElement).dataset.lineOldNum
              ?? (span as HTMLElement).dataset.lineNewNum
              ?? (span as HTMLElement).dataset.lineNum
            if (!attr) return
            const num = parseInt(attr, 10)
            if (num >= range.start && num <= range.end) {
              const row = span.closest('tr')
              if (row) row.classList.add('diff-comment-highlight')
            }
          })
        }
      }
    }, 50)

    return () => clearTimeout(timer)
  }, [extendDataKey, fileComments, activeInput])

  const handleAddComment = useCallback((comment: DiffComment) => {
    if (activeSessionId) addDiffComment(activeSessionId, comment)
  }, [activeSessionId, addDiffComment])

  const handleRemoveComment = useCallback((commentId: string) => {
    if (activeSessionId) removeDiffComment(activeSessionId, commentId)
  }, [activeSessionId, removeDiffComment])

  // Library's "+" button widget — single line only
  const renderCommentWidget = useCallback(({ lineNumber, side, diffFile, onClose }: {
    lineNumber: number
    side: SplitSide
    diffFile: DiffFile
    onClose: () => void
  }) => (
    <DiffCommentWidget
      lineNumber={lineNumber}
      side={side}
      diffFile={diffFile}
      filePath={gitSelectedFile!}
      onClose={onClose}
      onSave={handleAddComment}
    />
  ), [gitSelectedFile, handleAddComment])

  // Renders both saved comment badges AND the active input form via extendData
  const renderExtendContent = useCallback(({ data, diffFile }: {
    data: ExtendLineData
    lineNumber: number
    side: SplitSide
    diffFile: DiffFile
  }) => {
    const { comments: lineComments, activeInput: input } = data
    return (
      <>
        {lineComments.length > 0 && (
          <DiffCommentBadge comments={lineComments} onRemove={handleRemoveComment} />
        )}
        {input && (
          <DiffCommentWidget
            lineNumber={input.startLine}
            endLineNumber={input.endLine}
            side={input.side === 'old' ? SplitSide.old : SplitSide.new}
            diffFile={diffFile}
            filePath={gitSelectedFile!}
            lineContent={input.lineContent}
            onClose={() => setActiveInput(null)}
            onSave={(comment) => {
              handleAddComment(comment)
              setActiveInput(null)
            }}
          />
        )}
      </>
    )
  }, [gitSelectedFile, handleAddComment, handleRemoveComment])

  if (!gitSelectedFile) {
    const hasFiles = (gitStatus?.files.length ?? 0) > 0
    return (
      <div className="flex-1 flex items-center justify-center text-[12px] text-text-muted">
        {hasFiles ? 'Select a file to view diff' : '\u2728 All clean \u2014 nothing to diff!'}
      </div>
    )
  }

  if (!gitFileDiff) {
    return (
      <div className="flex-1 flex items-center justify-center text-[12px] text-text-muted">
        Loading diff...
      </div>
    )
  }

  if (!gitFileDiff.patch) {
    return (
      <div className="flex-1 flex items-center justify-center text-[12px] text-text-muted">
        No changes in this view
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 p-2">
      {/* Fixed header — file name + toggle buttons */}
      <div className="shrink-0 flex items-center justify-between mb-2 px-1">
        <div className="text-[11px] text-text-muted font-mono truncate" title={gitSelectedFile}>
          {gitSelectedFile}
        </div>
        <div className="flex items-center gap-1 shrink-0 ml-2">
          <button
            className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
              diffWrapLines
                ? 'bg-accent/20 border-accent/40 text-accent'
                : 'border-border text-text-muted hover:text-text-secondary hover:border-border-hover'
            }`}
            onClick={() => updateSettings({ diffWrapLines: !diffWrapLines })}
            title="Wrap long lines"
          >
            Wrap
          </button>
          <button
            className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
              diffIgnoreWhitespace
                ? 'bg-accent/20 border-accent/40 text-accent'
                : 'border-border text-text-muted hover:text-text-secondary hover:border-border-hover'
            }`}
            onClick={() => updateSettings({ diffIgnoreWhitespace: !diffIgnoreWhitespace })}
            title="Ignore whitespace changes"
          >
            Ignore Whitespace
          </button>
        </div>
      </div>

      {/* Diff container — wraps the DiffViewer so gutter drag hook can attach */}
      <div ref={containerRef} className="flex-1 min-h-0 flex flex-col">
        <DiffViewer
          key={extendDataKey}
          patch={gitFileDiff.patch}
          oldContent={gitFileDiff.oldContent}
          newContent={gitFileDiff.newContent}
          fileName={gitSelectedFile}
          className="flex-1 min-h-0"
          enableComments={true}
          comments={fileComments}
          activeInput={activeInput ?? undefined}
          renderCommentWidget={renderCommentWidget}
          renderExtendContent={renderExtendContent}
        />
      </div>

      {/* Review bar — visible when there are pending comments across any file */}
      <ReviewBar comments={gitReviewComments} />
    </div>
  )
}
