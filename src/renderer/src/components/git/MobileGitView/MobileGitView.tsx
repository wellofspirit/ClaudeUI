import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useActiveSession, useSessionStore } from '../../../stores/session-store'
import type { GitFileStatus } from '../../../../../shared/types'
import { FilterTabs } from '../GitPanel/FilterTabs'
import { GitFileTree } from '../GitFileTree'
import { GitFileDiffView } from '../GitFileDiffView'
import { GitCommitBox } from '../GitCommitBox'
import { filterAndSortFiles, isStaged } from '../GitFileTree/utils'

/**
 * Mobile full-screen takeover for the git panel (viewport ≤768px).
 *
 * Desktop shows GitPanel as a side panel with the file tree and the diff
 * visible at once; a phone has room for exactly one, so this is a two-screen
 * drill-down:
 *
 *   Changes screen (gitSelectedFile === null) → tap a file →
 *   Diff screen (gitSelectedFile !== null) → "Changes" back →
 *
 * There is deliberately NO local navigation state: the screen is derived from
 * `gitSelectedFile`, so GitFileTree's existing select action (and the store's
 * own selection changes, e.g. selectNextGitFile after a commit) drive
 * navigation for free and the two can never disagree.
 *
 * Unlike GitPanel this does NOT auto-select the first file on mount — that
 * would land the user on a diff they never asked for. It also clears any
 * selection desktop left behind, so mobile always opens on the list.
 */
export function MobileGitView(): React.JSX.Element {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const cwd = useActiveSession((s) => s.cwd)
  const gitStatus = useActiveSession((s) => s.gitStatus)
  const gitFileFilter = useActiveSession((s) => s.gitFileFilter)
  const gitSelectedFile = useActiveSession((s) => s.gitSelectedFile)
  const closeGitPanel = useSessionStore((s) => s.closeGitPanel)
  const setGitStatus = useSessionStore((s) => s.setGitStatus)
  const setGitSelectedFile = useSessionStore((s) => s.setGitSelectedFile)

  const [confirmingDiscard, setConfirmingDiscard] = useState(false)
  const confirmTimer = useRef<ReturnType<typeof setTimeout>>(null)

  // Land on the list screen and refresh status. Selection is reset FIRST so a
  // stale desktop selection can't flash the diff screen before the fetch lands.
  useEffect(() => {
    if (!cwd || !activeSessionId) return
    setGitSelectedFile(activeSessionId, null)
    window.api
      .gitGetStatus(cwd)
      .then((status) => setGitStatus(activeSessionId, status))
      .catch(() => {})
  }, [cwd, activeSessionId, setGitStatus, setGitSelectedFile])

  useEffect(() => {
    return () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current)
    }
  }, [])

  const stagedCount = gitStatus?.staged.length ?? 0
  const unstagedCount = (gitStatus?.unstaged.length ?? 0) + (gitStatus?.untracked.length ?? 0)

  // The prev/next walk order must match what the list screen shows, so it is
  // the same filter+sort GitFileTree renders from.
  const orderedFiles = useMemo(
    () => filterAndSortFiles(gitStatus?.files ?? [], gitFileFilter),
    [gitStatus, gitFileFilter]
  )
  const selectedIndex = gitSelectedFile
    ? orderedFiles.findIndex((f) => f.path === gitSelectedFile)
    : -1
  const selectedFile: GitFileStatus | undefined = gitSelectedFile
    ? gitStatus?.files.find((f) => f.path === gitSelectedFile)
    : undefined

  const refreshStatus = useCallback(async () => {
    if (!cwd || !activeSessionId) return
    try {
      const status = await window.api.gitGetStatus(cwd)
      setGitStatus(activeSessionId, status)
    } catch {
      // Silently ignore — the poller will catch up
    }
  }, [cwd, activeSessionId, setGitStatus])

  const handleBack = useCallback(() => {
    if (activeSessionId) closeGitPanel(activeSessionId)
  }, [activeSessionId, closeGitPanel])

  const handleDiffBack = useCallback(() => {
    if (activeSessionId) setGitSelectedFile(activeSessionId, null)
  }, [activeSessionId, setGitSelectedFile])

  const goToFile = useCallback(
    (index: number) => {
      const file = orderedFiles[index]
      if (!file || !activeSessionId) return
      setGitSelectedFile(activeSessionId, file.path)
    },
    [orderedFiles, activeSessionId, setGitSelectedFile]
  )

  const handleToggleStage = useCallback(async () => {
    if (!cwd || !selectedFile) return
    try {
      if (isStaged(selectedFile)) {
        await window.api.gitUnstageFile(cwd, selectedFile.path)
      } else {
        await window.api.gitStageFile(cwd, selectedFile.path)
      }
    } catch {
      return
    }
    await refreshStatus()
  }, [cwd, selectedFile, refreshStatus])

  const clearConfirm = useCallback(() => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current)
    confirmTimer.current = null
    setConfirmingDiscard(false)
  }, [])

  const handleDiscard = useCallback(async () => {
    if (!cwd || !activeSessionId || !selectedFile) return
    if (!confirmingDiscard) {
      setConfirmingDiscard(true)
      if (confirmTimer.current) clearTimeout(confirmTimer.current)
      confirmTimer.current = setTimeout(() => setConfirmingDiscard(false), 3000)
      return
    }
    clearConfirm()
    try {
      await window.api.gitDiscardFile(cwd, selectedFile.path)
    } catch {
      return
    }
    await refreshStatus()
    setGitSelectedFile(activeSessionId, null)
  }, [
    cwd,
    activeSessionId,
    selectedFile,
    confirmingDiscard,
    clearConfirm,
    refreshStatus,
    setGitSelectedFile
  ])

  // A discard confirm must never survive a change of subject.
  useEffect(() => {
    clearConfirm()
  }, [gitSelectedFile, clearConfirm])

  const chevron = (dir: 'left' | 'right'): React.JSX.Element => (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {dir === 'left' ? (
        <polyline points="15 18 9 12 15 6" />
      ) : (
        <polyline points="9 18 15 12 9 6" />
      )}
    </svg>
  )

  if (gitSelectedFile) {
    const basename = gitSelectedFile.split('/').pop() || gitSelectedFile
    const known = selectedIndex >= 0
    return (
      <div
        data-testid="MobileGitView"
        className="h-full flex flex-col bg-bg-primary overflow-hidden"
      >
        <div data-testid="MobileGitView.diffScreen" className="flex-1 min-h-0 flex flex-col">
          <div
            className="shrink-0 flex items-center gap-2 px-3 h-12 border-b border-border"
            style={{ paddingTop: 'env(safe-area-inset-top)' }}
          >
            <button
              data-testid="MobileGitView.diffBack"
              onClick={handleDiffBack}
              className="flex items-center gap-1 shrink-0 -ml-1 px-1 py-1 text-text-secondary hover:text-text-primary transition-colors"
            >
              {chevron('left')}
              <span className="text-[13px] font-medium">Changes</span>
            </button>
            <span
              className="flex-1 min-w-0 text-[13px] text-text-secondary font-mono truncate"
              title={gitSelectedFile}
            >
              {basename}
            </span>
            <span
              data-testid="MobileGitView.position"
              className="shrink-0 text-[11px] text-text-muted font-mono tabular-nums"
            >
              {known ? `${selectedIndex + 1}/${orderedFiles.length}` : '–'}
            </span>
            <button
              data-testid="MobileGitView.prevFile"
              onClick={() => goToFile(selectedIndex - 1)}
              disabled={!known || selectedIndex === 0}
              className="shrink-0 w-8 h-8 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover disabled:opacity-30 transition-colors"
              title="Previous file"
            >
              {chevron('left')}
            </button>
            <button
              data-testid="MobileGitView.nextFile"
              onClick={() => goToFile(selectedIndex + 1)}
              disabled={!known || selectedIndex === orderedFiles.length - 1}
              className="shrink-0 w-8 h-8 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover disabled:opacity-30 transition-colors"
              title="Next file"
            >
              {chevron('right')}
            </button>
          </div>

          <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-border">
            <button
              data-testid="MobileGitView.toggleStage"
              onClick={handleToggleStage}
              disabled={!selectedFile}
              className="px-2.5 py-1.5 rounded-md border border-border text-[12px] text-text-secondary hover:text-text-primary hover:bg-bg-hover disabled:opacity-30 transition-colors"
            >
              {selectedFile && isStaged(selectedFile) ? 'Unstage' : 'Stage'}
            </button>
            <span className="flex-1" />
            <button
              data-testid="MobileGitView.discard"
              onClick={handleDiscard}
              onBlur={clearConfirm}
              disabled={!selectedFile}
              className={`px-2.5 py-1.5 rounded-md border text-[12px] disabled:opacity-30 transition-colors ${
                confirmingDiscard
                  ? 'border-danger bg-danger/10 text-danger font-medium'
                  : 'border-border text-text-muted hover:text-danger'
              }`}
            >
              {confirmingDiscard ? 'Confirm discard?' : 'Discard'}
            </button>
          </div>

          <div className="flex-1 min-h-0 flex flex-col">
            <GitFileDiffView />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div data-testid="MobileGitView" className="h-full flex flex-col bg-bg-primary overflow-hidden">
      <div data-testid="MobileGitView.listScreen" className="flex-1 min-h-0 flex flex-col">
        <div
          className="shrink-0 flex items-center gap-2 px-3 h-12 border-b border-border"
          style={{ paddingTop: 'env(safe-area-inset-top)' }}
        >
          <button
            data-testid="MobileGitView.back"
            onClick={handleBack}
            className="flex items-center gap-1 shrink-0 -ml-1 px-1 py-1 text-text-secondary hover:text-text-primary transition-colors"
          >
            {chevron('left')}
            <span className="text-[13px] font-medium">Back</span>
          </button>
          <span className="flex-1 min-w-0 text-[13px] text-text-secondary truncate">
            Git Changes
            {gitStatus?.branch ? (
              <span className="text-text-muted"> · {gitStatus.branch}</span>
            ) : null}
          </span>
        </div>
        <FilterTabs stagedCount={stagedCount} unstagedCount={unstagedCount} />
        <div className="flex-1 overflow-y-auto min-h-0">
          <GitFileTree />
        </div>
        {/* autoSelectNext would yank the list screen into a leftover file's
            diff after a partial commit — selection IS navigation here. */}
        <GitCommitBox autoSelectNext={false} />
      </div>
    </div>
  )
}
