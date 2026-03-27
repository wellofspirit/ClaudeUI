import { useEffect, useCallback, useMemo, useRef, useState } from 'react'
import { useActiveSession, useSessionStore } from '../../stores/session-store'
import { DiffViewer, type DiffLine } from '../../lib/diff'
import { DiffCommentWidget } from './DiffCommentWidget'
import { DiffCommentBadge } from './DiffCommentBadge'
import { ReviewBar } from './ReviewBar'
import { useGutterDragSelection, type GutterSelection } from '../../hooks/useGutterDragSelection'
import type { DiffComment } from '../../../../shared/types'

/** Active inline input state from gutter drag */
interface ActiveCommentInput {
  lineNumber: number
  side: 'old' | 'new'
  startLine: number
  endLine: number
  lineContent: string
  /** Pre-filled text when editing an existing comment */
  editText?: string
}

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
  const diffViewSplit = useSessionStore((s) => s.settings.diffViewSplit)
  const updateSettings = useSessionStore((s) => s.updateSettings)

  // Active inline input from gutter drag
  const [activeInput, setActiveInput] = useState<ActiveCommentInput | null>(null)

  // Comments for the currently selected file only
  const fileComments = useMemo(
    () => gitReviewComments.filter((c) => c.filePath === gitSelectedFile),
    [gitReviewComments, gitSelectedFile]
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

  // Build highlighted lines set from comments + active input
  const highlightedLines = useMemo(() => {
    const set = new Set<string>()
    for (const c of fileComments) {
      for (let i = c.lineNumber; i <= c.endLineNumber; i++) {
        set.add(`${c.side}:${i}`)
      }
    }
    if (activeInput) {
      for (let i = activeInput.startLine; i <= activeInput.endLine; i++) {
        set.add(`${activeInput.side}:${i}`)
      }
    }
    return set.size > 0 ? set : undefined
  }, [fileComments, activeInput])

  const handleAddComment = useCallback((comment: DiffComment) => {
    if (activeSessionId) addDiffComment(activeSessionId, comment)
  }, [activeSessionId, addDiffComment])

  const handleRemoveComment = useCallback((commentId: string) => {
    if (activeSessionId) removeDiffComment(activeSessionId, commentId)
  }, [activeSessionId, removeDiffComment])

  const handleEditComment = useCallback((comment: DiffComment) => {
    // Remove the old comment and open the input pre-filled at the same location
    if (activeSessionId) removeDiffComment(activeSessionId, comment.id)
    setActiveInput({
      lineNumber: comment.endLineNumber,
      side: comment.side,
      startLine: comment.lineNumber,
      endLine: comment.endLineNumber,
      lineContent: comment.lineContent,
      editText: comment.comment,
    })
  }, [activeSessionId, removeDiffComment])

  // Render comment badges and active input widget after specific lines
  const renderAfterLine = useCallback((line: DiffLine) => {
    const lineNum = line.newLineNumber ?? line.oldLineNumber
    if (lineNum == null) return null

    // Check for saved comments on this line (keyed by endLineNumber)
    const lineSide = line.type === 'del' ? 'old' : 'new'
    const lineComments = fileComments.filter(
      (c) => c.endLineNumber === lineNum && c.side === lineSide
    )

    // Check for active input on this line
    const hasInput = activeInput && activeInput.lineNumber === lineNum && activeInput.side === lineSide

    if (lineComments.length === 0 && !hasInput) return null

    return (
      <>
        {lineComments.length > 0 && (
          <DiffCommentBadge comments={lineComments} onEdit={handleEditComment} onRemove={handleRemoveComment} />
        )}
        {hasInput && (
          <DiffCommentWidget
            lineNumber={activeInput.startLine}
            endLineNumber={activeInput.endLine}
            side={activeInput.side}
            filePath={gitSelectedFile!}
            lineContent={activeInput.lineContent}
            initialText={activeInput.editText}
            onClose={() => setActiveInput(null)}
            onSave={(comment) => {
              handleAddComment(comment)
              setActiveInput(null)
            }}
          />
        )}
      </>
    )
  }, [fileComments, activeInput, gitSelectedFile, handleAddComment, handleEditComment, handleRemoveComment])

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
          patch={gitFileDiff.patch}
          oldContent={gitFileDiff.oldContent}
          newContent={gitFileDiff.newContent}
          fileName={gitSelectedFile}
          className="flex-1 min-h-0"
          viewMode={diffViewSplit ? 'split' : 'unified'}
          wrapLines={diffWrapLines}
          highlightedLines={highlightedLines}
          renderAfterLine={renderAfterLine}
          virtualize
        />
      </div>

      {/* Review bar — visible when there are pending comments across any file */}
      <ReviewBar comments={gitReviewComments} />
    </div>
  )
}
