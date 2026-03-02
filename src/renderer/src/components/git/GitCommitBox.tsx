import { useState, useCallback, useRef, useEffect } from 'react'

import { useActiveSession, useSessionStore } from '../../stores/session-store'

export function GitCommitBox(): React.JSX.Element {
  const cwd = useActiveSession((s) => s.cwd)
  const gitCommitMessage = useActiveSession((s) => s.gitCommitMessage)
  const gitStatus = useActiveSession((s) => s.gitStatus)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const setGitCommitMessage = useSessionStore((s) => s.setGitCommitMessage)
  const setGitStatus = useSessionStore((s) => s.setGitStatus)
  const selectNextGitFile = useSessionStore((s) => s.selectNextGitFile)
  const gitCommitMode = useSessionStore((s) => s.settings.gitCommitMode)
  const [loading, setLoading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null)
  const [toastExiting, setToastExiting] = useState(false)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout>>(null)
  const [upstreamPrompt, setUpstreamPrompt] = useState<{ branch: string; afterCommitHash?: string } | null>(null)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [commitBoxHeight, setCommitBoxHeight] = useState(120)
  const dragRef = useRef<{ startY: number; startH: number } | null>(null)

  const stagedCount = gitStatus?.staged.length ?? 0
  const totalChanges = gitStatus?.files.length ?? 0
  const allStaged = totalChanges > 0 && stagedCount === totalChanges

  const showToast = useCallback((msg: string, type: 'success' | 'error' = 'success') => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    setToast({ message: msg, type })
    setToastExiting(false)
    toastTimerRef.current = setTimeout(() => {
      setToastExiting(true)
      setTimeout(() => {
        setToast(null)
        setToastExiting(false)
      }, 200) // match toast-out duration
    }, type === 'error' ? 5000 : 2500)
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

  // Auto-expand commit box to fit content (e.g. after AI generation)
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    // Measure the scroll height the textarea needs
    const saved = el.style.height
    el.style.height = 'auto'
    const scrollH = el.scrollHeight
    el.style.height = saved
    // Add space for padding + buttons (~48px)
    const needed = scrollH + 48
    if (needed > commitBoxHeight) {
      setCommitBoxHeight(Math.min(600, needed))
    }
  }, [gitCommitMessage]) // eslint-disable-line react-hooks/exhaustive-deps

  // Drag-to-resize commit box
  const onResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragRef.current = { startY: e.clientY, startH: commitBoxHeight }
    const onMove = (ev: MouseEvent): void => {
      if (!dragRef.current) return
      const delta = dragRef.current.startY - ev.clientY
      setCommitBoxHeight(Math.max(80, Math.min(600, dragRef.current.startH + delta)))
    }
    const onUp = (): void => {
      dragRef.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [commitBoxHeight])

  const isNoUpstreamError = (err: unknown): boolean => {
    const msg = err instanceof Error ? err.message : String(err)
    return msg.includes('no upstream branch') || msg.includes('set-upstream') || msg.includes('has no upstream')
  }

  const refreshStatus = useCallback(async () => {
    if (!cwd || !activeSessionId) return
    const status = await window.api.gitGetStatus(cwd)
    setGitStatus(activeSessionId, status)
  }, [cwd, activeSessionId, setGitStatus])

  const handlePushWithUpstreamPrompt = useCallback(async (branch: string, afterCommitHash?: string) => {
    if (!cwd) return
    setLoading(true)
    try {
      await window.api.gitPushWithUpstream(cwd, branch)
      showToast(afterCommitHash ? `Committed & pushed: ${afterCommitHash}` : 'Pushed!', 'success')
      await refreshStatus()
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Push failed', 'error')
    } finally {
      setLoading(false)
      setUpstreamPrompt(null)
    }
  }, [cwd, showToast, refreshStatus])

  const handleToggleStageAll = useCallback(async () => {
    if (!cwd || !activeSessionId || loading) return
    setLoading(true)
    try {
      if (allStaged) {
        await window.api.gitUnstageAll(cwd)
      } else {
        await window.api.gitStageAll(cwd)
      }
      await refreshStatus()
    } catch (err) {
      showToast(err instanceof Error ? err.message : allStaged ? 'Failed to unstage' : 'Failed to stage', 'error')
    } finally {
      setLoading(false)
    }
  }, [cwd, activeSessionId, loading, allStaged, refreshStatus, showToast])

  const handleCommit = useCallback(async () => {
    if (!cwd || !activeSessionId || !gitCommitMessage.trim() || loading) return
    if (stagedCount === 0) {
      showToast('No staged changes to commit', 'error')
      return
    }
    setLoading(true)
    try {
      const hash = await window.api.gitCommit(cwd, gitCommitMessage.trim())
      setGitCommitMessage(activeSessionId, '')
      showToast(`Committed: ${hash.slice(0, 7)}`)

      await refreshStatus()
      selectNextGitFile(activeSessionId)
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Commit failed', 'error')
    } finally {
      setLoading(false)
    }
  }, [cwd, activeSessionId, gitCommitMessage, stagedCount, loading, setGitCommitMessage, refreshStatus, showToast, selectNextGitFile])

  const handleCommitAndPush = useCallback(async () => {
    if (!cwd || !activeSessionId || !gitCommitMessage.trim() || loading) return
    if (stagedCount === 0) {
      showToast('No staged changes to commit', 'error')
      return
    }
    setLoading(true)
    setDropdownOpen(false)
    try {
      const hash = await window.api.gitCommit(cwd, gitCommitMessage.trim())
      setGitCommitMessage(activeSessionId, '')
      try {
        await window.api.gitPush(cwd)
        showToast(`Committed & pushed: ${hash.slice(0, 7)}`)
      } catch (pushErr) {
        if (isNoUpstreamError(pushErr)) {
          const branch = gitStatus?.branch || 'HEAD'
          setUpstreamPrompt({ branch, afterCommitHash: hash.slice(0, 7) })
          showToast(`Committed: ${hash.slice(0, 7)} — no upstream branch configured`, 'error')
        } else {
          showToast(pushErr instanceof Error ? pushErr.message : 'Push failed', 'error')
        }
      }

      await refreshStatus()
      selectNextGitFile(activeSessionId)
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Commit failed', 'error')
    } finally {
      setLoading(false)
    }
  }, [cwd, activeSessionId, gitCommitMessage, stagedCount, loading, gitStatus?.branch, setGitCommitMessage, refreshStatus, showToast, selectNextGitFile])

  const handlePush = useCallback(async () => {
    if (!cwd || loading) return
    setLoading(true)
    setDropdownOpen(false)
    try {
      await window.api.gitPush(cwd)
      showToast('Pushed!')
    } catch (err) {
      if (isNoUpstreamError(err)) {
        const branch = gitStatus?.branch || 'HEAD'
        setUpstreamPrompt({ branch })
      } else {
        showToast(err instanceof Error ? err.message : 'Push failed', 'error')
      }
    } finally {
      setLoading(false)
    }
  }, [cwd, loading, gitStatus?.branch, showToast])

  const handleGenerateMessage = useCallback(async () => {
    if (!cwd || !activeSessionId || generating) return
    const files = gitStatus?.staged ?? []
    if (files.length === 0) {
      showToast('Stage changes first to generate a message', 'error')
      return
    }
    setGenerating(true)
    try {
      // Gather diffs for staged files (limit total to ~8000 chars to stay fast)
      let diff = ''
      for (const f of files) {
        if (diff.length > 8000) break
        const { patch } = await window.api.gitGetFilePatch(cwd, f, true, false)
        if (patch) diff += patch + '\n'
      }
      if (!diff.trim()) {
        showToast('No diff content found', 'error')
        return
      }
      const msg = await window.api.generateCommitMessage(diff)
      if (msg) {
        setGitCommitMessage(activeSessionId, msg)
      } else {
        showToast('Failed to generate message', 'error')
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Generation failed', 'error')
    } finally {
      setGenerating(false)
    }
  }, [cwd, activeSessionId, generating, gitStatus?.staged, setGitCommitMessage, showToast])

  const commitDisabled = loading || !gitCommitMessage.trim() || stagedCount === 0
  const isPushMode = gitCommitMode === 'commit-push'
  const handlePrimaryCommit = isPushMode ? handleCommitAndPush : handleCommit

  return (
    <div className="shrink-0 border-t border-border relative flex flex-col" style={{ height: commitBoxHeight, maxHeight: '50%' }}>
      {/* Resize handle */}
      <div
        onMouseDown={onResizeMouseDown}
        className="absolute top-0 left-0 right-0 h-1.5 cursor-ns-resize z-10 hover:bg-accent/30 transition-colors"
      />
      {/* Commit message */}
      <div className="relative flex-1 min-h-0 p-2 pb-0">
        <textarea
          ref={textareaRef}
          value={gitCommitMessage}
          onChange={(e) => activeSessionId && setGitCommitMessage(activeSessionId, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              handlePrimaryCommit()
            }
          }}
          placeholder="Commit message..."
          className="w-full h-full bg-bg-tertiary text-text-primary text-[12px] px-2.5 py-2 pr-8 rounded-md outline-none placeholder:text-text-muted resize-none font-mono"
        />
        <button
          onClick={handleGenerateMessage}
          disabled={generating || stagedCount === 0}
          className="absolute top-3.5 right-3.5 w-6 h-6 flex items-center justify-center rounded text-text-muted/50 hover:text-accent hover:bg-bg-hover transition-colors cursor-default disabled:opacity-30 disabled:hover:text-text-muted/50 disabled:hover:bg-transparent"
          title="Auto-generate commit message"
        >
          {generating ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="animate-spin-slow text-accent">
              <circle cx="12" cy="12" r="10" strokeDasharray="31.4 31.4" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9.5 2l1.2 3.6L14.3 7l-3.6 1.2L9.5 12l-1.2-3.6L4.7 7l3.6-1.2z" />
              <path d="M18 12l.9 2.7 2.7.9-2.7.9-.9 2.7-.9-2.7L14.4 15.6l2.7-.9z" />
              <path d="M9 17l.6 1.8 1.8.6-1.8.6-.6 1.8-.6-1.8L6.6 19.4l1.8-.6z" />
            </svg>
          )}
        </button>
      </div>

      {/* Bottom section: buttons */}
      <div className="shrink-0 px-2 pb-2 pt-1.5 space-y-1.5">
        {/* Floating toast — positioned above the commit box, centered */}
        {toast && (
          <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-3 z-50 pointer-events-none">
            <div className={`px-4 py-2 rounded-lg shadow-lg text-[12px] font-mono whitespace-nowrap ${toast.type === 'error' ? 'bg-red-950 border border-red-800 text-red-300' : 'bg-bg-tertiary border border-border text-green-400'} ${toastExiting ? 'animate-toast-out' : 'animate-toast-in'}`}>
              {toast.message}
            </div>
          </div>
        )}

        {/* Upstream prompt — asks user to set up remote tracking */}
        {upstreamPrompt && (
          <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-3 z-50 w-72">
            <div className="px-4 py-3 rounded-lg bg-bg-primary border border-border shadow-lg text-[12px] animate-toast-in">
              <p className="text-text-primary mb-2">
                No upstream branch for <span className="font-mono text-accent">{upstreamPrompt.branch}</span>.
                Set up tracking on remote?
              </p>
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={() => setUpstreamPrompt(null)}
                  className="px-2.5 py-1 text-[11px] rounded-md border border-border text-text-secondary hover:bg-bg-hover transition-colors cursor-default"
                >
                  Cancel
                </button>
                <button
                  onClick={() => handlePushWithUpstreamPrompt(upstreamPrompt.branch, upstreamPrompt.afterCommitHash)}
                  disabled={loading}
                  className="px-2.5 py-1 text-[11px] rounded-md bg-accent text-white hover:bg-accent-hover transition-colors cursor-default disabled:opacity-50"
                >
                  Push with -u
                </button>
              </div>
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
            onClick={handlePrimaryCommit}
            disabled={commitDisabled}
            className="flex-1 px-2.5 py-1.5 text-[11px] font-medium rounded-l-md bg-accent text-white hover:bg-accent-hover transition-colors cursor-default disabled:opacity-50"
            title={`Ctrl+Enter to ${isPushMode ? 'commit & push' : 'commit'}`}
          >
            {isPushMode ? 'Commit & Push' : 'Commit'}{stagedCount > 0 ? ` (${stagedCount})` : ''}
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
                onClick={isPushMode ? handleCommit : handleCommitAndPush}
                disabled={commitDisabled}
                className="w-full text-left px-3 py-1.5 text-[11px] text-text-primary hover:bg-bg-hover transition-colors cursor-default disabled:opacity-50"
              >
                {isPushMode ? 'Commit' : 'Commit & Push'}
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
    </div>
  )
}
