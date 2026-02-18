import { useEffect } from 'react'
import { useActiveSession, useSessionStore } from '../../stores/session-store'
import { DiffViewer } from '../chat/DiffViewer'

export function GitFileDiffView(): React.JSX.Element {
  const cwd = useActiveSession((s) => s.cwd)
  const gitSelectedFile = useActiveSession((s) => s.gitSelectedFile)
  const gitFileDiff = useActiveSession((s) => s.gitFileDiff)
  const gitStatus = useActiveSession((s) => s.gitStatus)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const setGitFileDiff = useSessionStore((s) => s.setGitFileDiff)
  const diffIgnoreWhitespace = useSessionStore((s) => s.settings.diffIgnoreWhitespace)
  const diffWrapLines = useSessionStore((s) => s.settings.diffWrapLines)
  const updateSettings = useSessionStore((s) => s.updateSettings)

  // Fetch patch when selected file or ignore-whitespace toggle changes
  useEffect(() => {
    if (!cwd || !gitSelectedFile || !activeSessionId || !gitStatus) {
      if (activeSessionId) setGitFileDiff(activeSessionId, null)
      return
    }

    // Determine if the file is staged
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
    // Already have content — skip
    if (gitFileDiff.oldContent != null || gitFileDiff.newContent != null) return

    const fileStatus = gitStatus.files.find((f) => f.path === gitSelectedFile)
    if (!fileStatus) return

    const staged = fileStatus.index !== ' ' && fileStatus.index !== '?'

    window.api.gitGetFileContents(cwd, gitSelectedFile, staged).then(({ oldContent, newContent }) => {
      // Merge content into existing diff (don't overwrite patch)
      const current = useSessionStore.getState().sessions[activeSessionId]?.gitFileDiff
      if (current?.patch) {
        setGitFileDiff(activeSessionId, { ...current, oldContent, newContent })
      }
    }).catch(() => {
      // Silently ignore — hunk expansion just won't be available
    })
  }, [cwd, gitSelectedFile, activeSessionId, gitStatus, gitFileDiff?.patch])

  if (!gitSelectedFile) {
    const hasFiles = (gitStatus?.files.length ?? 0) > 0
    return (
      <div className="flex-1 flex items-center justify-center text-[12px] text-text-muted">
        {hasFiles ? 'Select a file to view diff' : '✨ All clean — nothing to diff!'}
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
      {/* Diff fills remaining space and scrolls internally */}
      <DiffViewer
        patch={gitFileDiff.patch}
        oldContent={gitFileDiff.oldContent}
        newContent={gitFileDiff.newContent}
        fileName={gitSelectedFile}
        className="flex-1 min-h-0"
      />
    </div>
  )
}
