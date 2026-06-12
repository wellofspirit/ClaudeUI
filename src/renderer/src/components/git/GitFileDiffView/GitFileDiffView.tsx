import { useEffect, useCallback, useMemo, useRef, useState } from 'react'
import { useActiveSession, useSessionStore } from '../../../stores/session-store'
import { useGutterDragSelection, type GutterSelection } from '../../../hooks/useGutterDragSelection'
import type { DiffComment } from '../../../../../shared/types'
import { GitFileDiffViewView } from './View'

/** Active inline input state from gutter drag */
interface ActiveCommentInput {
  lineNumber: number
  side: 'old' | 'new'
  startLine: number
  endLine: number
  lineContent: string
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

  const [activeInput, setActiveInput] = useState<ActiveCommentInput | null>(null)

  const fileComments = useMemo(
    () => gitReviewComments.filter((c) => c.filePath === gitSelectedFile),
    [gitReviewComments, gitSelectedFile]
  )

  // Gutter drag selection
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

  const containerNodeRef = useRef<HTMLDivElement | null>(null)
  const containerRef = useCallback(
    (node: HTMLDivElement | null) => {
      containerNodeRef.current = node
      gutterRef(node)
    },
    [gutterRef]
  )

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

    window.api
      .gitGetFilePatch(cwd, gitSelectedFile, staged, diffIgnoreWhitespace)
      .then((diff) => {
        setGitFileDiff(activeSessionId, diff)
      })
      .catch(() => {
        setGitFileDiff(activeSessionId, null)
      })
  }, [cwd, gitSelectedFile, activeSessionId, setGitFileDiff, gitStatus, diffIgnoreWhitespace])

  // Background-fetch full file content for hunk expansion
  useEffect(() => {
    if (!cwd || !gitSelectedFile || !activeSessionId || !gitStatus || !gitFileDiff?.patch) return
    if (gitFileDiff.isBinary) return
    if (gitFileDiff.oldContent != null || gitFileDiff.newContent != null) return

    const fileStatus = gitStatus.files.find((f) => f.path === gitSelectedFile)
    if (!fileStatus) return

    const staged = fileStatus.index !== ' ' && fileStatus.index !== '?'

    window.api
      .gitGetFileContents(cwd, gitSelectedFile, staged)
      .then(({ oldContent, newContent }) => {
        const current = useSessionStore.getState().sessions[activeSessionId]?.gitFileDiff
        if (current?.patch) {
          setGitFileDiff(activeSessionId, { ...current, oldContent, newContent })
        }
      })
      .catch(() => {})
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

  const handleAddComment = useCallback(
    (comment: DiffComment) => {
      if (activeSessionId) addDiffComment(activeSessionId, comment)
    },
    [activeSessionId, addDiffComment]
  )

  const handleRemoveComment = useCallback(
    (commentId: string) => {
      if (activeSessionId) removeDiffComment(activeSessionId, commentId)
    },
    [activeSessionId, removeDiffComment]
  )

  const handleEditComment = useCallback(
    (comment: DiffComment) => {
      if (activeSessionId) removeDiffComment(activeSessionId, comment.id)
      setActiveInput({
        lineNumber: comment.endLineNumber,
        side: comment.side,
        startLine: comment.lineNumber,
        endLine: comment.endLineNumber,
        lineContent: comment.lineContent,
        editText: comment.comment
      })
    },
    [activeSessionId, removeDiffComment]
  )

  return (
    <GitFileDiffViewView
      gitSelectedFile={gitSelectedFile}
      gitFileDiff={gitFileDiff}
      gitStatus={gitStatus}
      gitReviewComments={gitReviewComments}
      fileComments={fileComments}
      highlightedLines={highlightedLines}
      activeInput={activeInput}
      diffWrapLines={diffWrapLines}
      diffIgnoreWhitespace={diffIgnoreWhitespace}
      diffViewSplit={diffViewSplit}
      containerRef={containerRef}
      onToggleWrapLines={() => updateSettings({ diffWrapLines: !diffWrapLines })}
      onToggleIgnoreWhitespace={() =>
        updateSettings({ diffIgnoreWhitespace: !diffIgnoreWhitespace })
      }
      onAddComment={handleAddComment}
      onEditComment={handleEditComment}
      onRemoveComment={handleRemoveComment}
      onSetActiveInput={setActiveInput}
    />
  )
}
