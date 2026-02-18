import { useState, useCallback, useRef, useEffect } from 'react'

import { useActiveSession, useSessionStore } from '../../stores/session-store'

export function GitCommitBox(): React.JSX.Element {
  const cwd = useActiveSession((s) => s.cwd)
  const gitCommitMessage = useActiveSession((s) => s.gitCommitMessage)
  const gitStatus = useActiveSession((s) => s.gitStatus)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const setGitCommitMessage = useSessionStore((s) => s.setGitCommitMessage)
  const setGitStatus = useSessionStore((s) => s.setGitStatus)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [toastExiting, setToastExiting] = useState(false)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout>>(null)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const stagedCount = gitStatus?.staged.length ?? 0
  const totalChanges = gitStatus?.files.length ?? 0
  const allStaged = totalChanges > 0 && stagedCount === totalChanges

  const showToast = useCallback((msg: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    setToast(msg)
    setToastExiting(false)
    toastTimerRef.current = setTimeout(() => {
      setToastExiting(true)
      setTimeout(() => {
        setToast(null)
        setToastExiting(false)
      }, 200) // match toast-out duration
    }, 2500)
  }, [])

  // Clean up toast timer on unmount
  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    }
  }, [])

  // Close dropdown on click outside
  useEffect(() => {
    if (!dropdownOpen) return
    const handler = (e: MouseEvent): void => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [dropdownOpen])

  const refreshStatus = useCallback(async () => {
    if (!cwd || !activeSessionId) return
    const status = await window.api.gitGetStatus(cwd)
    setGitStatus(activeSessionId, status)
  }, [cwd, activeSessionId, setGitStatus])

  const handleToggleStageAll = useCallback(async () => {
    if (!cwd || !activeSessionId || loading) return
    setLoading(true)
    setError(null)
    try {
      if (allStaged) {
        await window.api.gitUnstageAll(cwd)
      } else {
        await window.api.gitStageAll(cwd)
      }
      await refreshStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : allStaged ? 'Failed to unstage' : 'Failed to stage')
    } finally {
      setLoading(false)
    }
  }, [cwd, activeSessionId, loading, allStaged, refreshStatus])

  const handleCommit = useCallback(async () => {
    if (!cwd || !activeSessionId || !gitCommitMessage.trim() || loading) return
    if (stagedCount === 0) {
      setError('No staged changes to commit')
      return
    }
    setLoading(true)
    setError(null)
    setToast(null)
    try {
      const hash = await window.api.gitCommit(cwd, gitCommitMessage.trim())
      setGitCommitMessage(activeSessionId, '')
      showToast(`Committed: ${hash.slice(0, 7)}`)

      await refreshStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Commit failed')
    } finally {
      setLoading(false)
    }
  }, [cwd, activeSessionId, gitCommitMessage, stagedCount, loading, setGitCommitMessage, refreshStatus, showToast])

  const handleCommitAndPush = useCallback(async () => {
    if (!cwd || !activeSessionId || !gitCommitMessage.trim() || loading) return
    if (stagedCount === 0) {
      setError('No staged changes to commit')
      return
    }
    setLoading(true)
    setError(null)
    setToast(null)
    setDropdownOpen(false)
    try {
      const hash = await window.api.gitCommit(cwd, gitCommitMessage.trim())
      setGitCommitMessage(activeSessionId, '')
      await window.api.gitPush(cwd)
      showToast(`Committed & pushed: ${hash.slice(0, 7)}`)

      await refreshStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Commit & push failed')
    } finally {
      setLoading(false)
    }
  }, [cwd, activeSessionId, gitCommitMessage, stagedCount, loading, setGitCommitMessage, refreshStatus, showToast])

  const handlePush = useCallback(async () => {
    if (!cwd || loading) return
    setLoading(true)
    setError(null)
    setDropdownOpen(false)
    try {
      await window.api.gitPush(cwd)
      showToast('Pushed!')

    } catch (err) {
      setError(err instanceof Error ? err.message : 'Push failed')
    } finally {
      setLoading(false)
    }
  }, [cwd, loading, showToast])

  const commitDisabled = loading || !gitCommitMessage.trim() || stagedCount === 0

  return (
    <div className="shrink-0 border-t border-border p-2 space-y-2 relative">
      {/* Commit message */}
      <textarea
        value={gitCommitMessage}
        onChange={(e) => activeSessionId && setGitCommitMessage(activeSessionId, e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            handleCommit()
          }
        }}
        placeholder="Commit message..."
        rows={2}
        className="w-full bg-bg-tertiary text-text-primary text-[12px] px-2.5 py-2 rounded-md outline-none placeholder:text-text-muted resize-none font-mono"
      />

      {/* Error message */}
      {error && (
        <div className="text-[11px] text-red-400 px-1">{error}</div>
      )}

      {/* Floating toast — positioned above the commit box, centered */}
      {toast && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-3 z-50 pointer-events-none">
          <div className={`px-4 py-2 rounded-lg bg-bg-tertiary border border-border shadow-lg text-[12px] text-green-400 font-mono whitespace-nowrap ${toastExiting ? 'animate-toast-out' : 'animate-toast-in'}`}>
            {toast}
          </div>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-1.5">
        <button
          onClick={handleToggleStageAll}
          disabled={loading || totalChanges === 0}
          className="px-2.5 py-1.5 text-[11px] font-medium rounded-md border border-border text-text-secondary hover:bg-bg-hover transition-colors cursor-default disabled:opacity-50"
        >
          {allStaged ? 'Unstage All' : 'Stage All'}
        </button>

        {/* Commit split button */}
        <div className="flex-1 flex relative" ref={dropdownRef}>
          <button
            onClick={handleCommit}
            disabled={commitDisabled}
            className="flex-1 px-2.5 py-1.5 text-[11px] font-medium rounded-l-md bg-accent text-white hover:bg-accent-hover transition-colors cursor-default disabled:opacity-50"
            title="Ctrl+Enter to commit"
          >
            Commit{stagedCount > 0 ? ` (${stagedCount})` : ''}
          </button>
          <button
            onClick={() => setDropdownOpen(!dropdownOpen)}
            disabled={loading}
            className="px-1.5 py-1.5 rounded-r-md bg-accent text-white hover:bg-accent-hover transition-colors cursor-default disabled:opacity-50 border-l border-white/20"
          >
            <svg width="8" height="8" viewBox="0 0 12 12" fill="currentColor">
              <path d="M3 4.5l3 3 3-3" />
            </svg>
          </button>

          {/* Dropdown menu */}
          {dropdownOpen && (
            <div className="absolute bottom-full left-0 right-0 mb-1 bg-bg-primary border border-border rounded-md shadow-lg overflow-hidden z-50">
              <button
                onClick={handleCommitAndPush}
                disabled={commitDisabled}
                className="w-full text-left px-3 py-1.5 text-[11px] text-text-primary hover:bg-bg-hover transition-colors cursor-default disabled:opacity-50"
              >
                Commit & Push
              </button>
              <button
                onClick={handlePush}
                disabled={loading}
                className="w-full text-left px-3 py-1.5 text-[11px] text-text-primary hover:bg-bg-hover transition-colors cursor-default disabled:opacity-50 border-t border-border"
              >
                Push
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
