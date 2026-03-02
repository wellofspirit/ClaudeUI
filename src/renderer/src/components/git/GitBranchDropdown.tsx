import { useState, useEffect, useRef, useCallback } from 'react'
import { useActiveSession, useSessionStore } from '../../stores/session-store'
import type { GitBranchData } from '../../../../shared/types'

interface Props {
  onClose: () => void
  anchorRef: React.RefObject<HTMLButtonElement | null>
}

/** Cooldown (ms) between auto-fetches when dropdown opens */
const FETCH_COOLDOWN = 30_000

export function GitBranchDropdown({ onClose, anchorRef }: Props): React.JSX.Element {
  const cwd = useActiveSession((s) => s.cwd)
  const gitStatus = useActiveSession((s) => s.gitStatus)
  const syncOp = useActiveSession((s) => s.gitSyncOperation)
  const syncError = useActiveSession((s) => s.gitSyncError)
  const lastFetchTime = useActiveSession((s) => s.gitLastFetchTime)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const setGitStatus = useSessionStore((s) => s.setGitStatus)
  const setGitBranches = useSessionStore((s) => s.setGitBranches)
  const setSyncOp = useSessionStore((s) => s.setGitSyncOperation)
  const setSyncError = useSessionStore((s) => s.setGitSyncError)
  const setLastFetchTime = useSessionStore((s) => s.setGitLastFetchTime)
  const [branches, setBranches] = useState<GitBranchData | null>(null)
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const [newBranchName, setNewBranchName] = useState('')
  const [loading, setLoading] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)
  const [upstreamPrompt, setUpstreamPrompt] = useState<{ branch: string } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const isSyncing = syncOp !== 'idle'
  const hasTracking = !!gitStatus?.trackingBranch
  const ahead = gitStatus?.ahead ?? 0
  const behind = gitStatus?.behind ?? 0

  /** Refresh status + branches from backend */
  const refreshAll = useCallback(async () => {
    if (!cwd || !activeSessionId) return
    try {
      const [status, newBranches] = await Promise.all([
        window.api.gitGetStatus(cwd),
        window.api.gitGetBranches(cwd)
      ])
      setGitStatus(activeSessionId, status)
      setGitBranches(activeSessionId, newBranches)
      setBranches(newBranches)
    } catch { /* swallow — individual handlers report errors */ }
  }, [cwd, activeSessionId, setGitStatus, setGitBranches])

  // Load branches on open
  useEffect(() => {
    if (!cwd) return
    window.api.gitGetBranches(cwd).then((b) => {
      setBranches(b)
      if (activeSessionId) setGitBranches(activeSessionId, b)
    }).catch(() => {})
  }, [cwd, activeSessionId, setGitBranches])

  // Auto-fetch on open (with cooldown)
  useEffect(() => {
    if (!cwd || !activeSessionId || !hasTracking) return
    const now = Date.now()
    if (lastFetchTime && (now - lastFetchTime) < FETCH_COOLDOWN) return

    // Silent background fetch — don't show spinner for auto-fetch
    window.api.gitFetch(cwd).then(async () => {
      setLastFetchTime(activeSessionId, Date.now())
      await refreshAll()
    }).catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps — only on mount

  // Click-outside to close
  useEffect(() => {
    const handler = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node) &&
          anchorRef.current && !anchorRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose, anchorRef])

  // Focus search input on open
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Clear sync error on unmount
  useEffect(() => {
    return () => {
      if (activeSessionId) setSyncError(activeSessionId, null)
    }
  }, [activeSessionId, setSyncError])

  // Auto-dismiss success message
  useEffect(() => {
    if (!successMsg) return
    const timer = setTimeout(() => setSuccessMsg(null), 3000)
    return () => clearTimeout(timer)
  }, [successMsg])

  const handleFetch = useCallback(async () => {
    if (!cwd || !activeSessionId || isSyncing) return
    setSyncOp(activeSessionId, 'fetching')
    setSyncError(activeSessionId, null)
    setSuccessMsg(null)
    try {
      await window.api.gitFetch(cwd)
      setLastFetchTime(activeSessionId, Date.now())
      await refreshAll()
      setSuccessMsg('Fetched from remote')
    } catch (err) {
      setSyncError(activeSessionId, err instanceof Error ? err.message : 'Fetch failed')
    } finally {
      setSyncOp(activeSessionId, 'idle')
    }
  }, [cwd, activeSessionId, isSyncing, setSyncOp, setSyncError, setLastFetchTime, refreshAll])

  const handlePull = useCallback(async () => {
    if (!cwd || !activeSessionId || isSyncing) return
    setSyncOp(activeSessionId, 'pulling')
    setSyncError(activeSessionId, null)
    setSuccessMsg(null)
    try {
      const result = await window.api.gitPull(cwd)
      await refreshAll()
      setSuccessMsg(`Pulled: ${result.summary}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Pull failed'
      setSyncError(activeSessionId, msg)
    } finally {
      setSyncOp(activeSessionId, 'idle')
    }
  }, [cwd, activeSessionId, isSyncing, setSyncOp, setSyncError, refreshAll])

  const isNoUpstreamError = (err: unknown): boolean => {
    const msg = err instanceof Error ? err.message : String(err)
    return msg.includes('no upstream branch') || msg.includes('set-upstream') || msg.includes('has no upstream')
  }

  const handlePush = useCallback(async () => {
    if (!cwd || !activeSessionId || isSyncing) return
    setSyncOp(activeSessionId, 'pushing')
    setSyncError(activeSessionId, null)
    setSuccessMsg(null)
    setUpstreamPrompt(null)
    try {
      await window.api.gitPush(cwd)
      await refreshAll()
      setSuccessMsg('Pushed to remote')
    } catch (err) {
      if (isNoUpstreamError(err)) {
        const branch = gitStatus?.branch || 'HEAD'
        setUpstreamPrompt({ branch })
      } else {
        const msg = err instanceof Error ? err.message : 'Push failed'
        setSyncError(activeSessionId, msg)
      }
    } finally {
      setSyncOp(activeSessionId, 'idle')
    }
  }, [cwd, activeSessionId, isSyncing, gitStatus?.branch, setSyncOp, setSyncError, refreshAll])

  const handlePushWithUpstream = useCallback(async () => {
    if (!cwd || !activeSessionId || !upstreamPrompt) return
    setSyncOp(activeSessionId, 'pushing')
    setSyncError(activeSessionId, null)
    setUpstreamPrompt(null)
    try {
      await window.api.gitPushWithUpstream(cwd, upstreamPrompt.branch)
      await refreshAll()
      setSuccessMsg('Pushed to remote (upstream set)')
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Push failed'
      setSyncError(activeSessionId, msg)
    } finally {
      setSyncOp(activeSessionId, 'idle')
    }
  }, [cwd, activeSessionId, upstreamPrompt, setSyncOp, setSyncError, refreshAll])

  const handleCheckout = useCallback(async (branch: string) => {
    if (!cwd || loading) return
    setLoading(true)
    setLocalError(null)
    try {
      await window.api.gitCheckout(cwd, branch)
      await refreshAll()
      onClose()
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Failed to switch branch')
    } finally {
      setLoading(false)
    }
  }, [cwd, loading, onClose, refreshAll])

  const handleCreateBranch = useCallback(async () => {
    if (!cwd || !newBranchName.trim() || loading) return
    setLoading(true)
    setLocalError(null)
    try {
      await window.api.gitCreateBranch(cwd, newBranchName.trim())
      await refreshAll()
      onClose()
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Failed to create branch')
    } finally {
      setLoading(false)
    }
  }, [cwd, newBranchName, loading, onClose, refreshAll])

  const filter = search.toLowerCase()
  const localFiltered = branches?.local.filter((b) => b.toLowerCase().includes(filter)) || []
  const remoteFiltered = branches?.remote.filter((b) => b.toLowerCase().includes(filter)) || []
  const hasRemote = (branches?.remote.length ?? 0) > 0

  return (
    <div
      ref={ref}
      className="absolute top-full right-0 mt-1 w-72 max-h-96 bg-bg-primary border border-border rounded-lg shadow-lg overflow-hidden z-50 flex flex-col"
    >
      {/* Search */}
      <div className="p-2 border-b border-border">
        <input
          ref={inputRef}
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search branches..."
          className="w-full bg-bg-tertiary text-text-primary text-[12px] px-2.5 py-1.5 rounded-md outline-none placeholder:text-text-muted"
        />
      </div>

      {/* Sync section — only when remotes exist */}
      {hasRemote && (
        <div className="px-2 py-2 border-b border-border">
          <div className="text-[10px] text-text-muted uppercase tracking-wider font-medium px-1 mb-1.5">Sync</div>
          <div className="grid grid-cols-2 gap-1.5 mb-1.5">
            <SyncButton
              icon="↓"
              label="Pull"
              count={hasTracking ? behind : 0}
              disabled={isSyncing || !hasTracking || behind === 0}
              active={syncOp === 'pulling'}
              onClick={handlePull}
              title={!hasTracking ? 'No upstream branch' : behind === 0 ? 'Already up to date' : `Pull ${behind} commit${behind !== 1 ? 's' : ''}`}
            />
            <SyncButton
              icon="↑"
              label="Push"
              count={hasTracking ? ahead : 0}
              disabled={isSyncing || (hasTracking && ahead === 0)}
              active={syncOp === 'pushing'}
              onClick={handlePush}
              title={!hasTracking ? 'Push and set upstream' : ahead === 0 ? 'Nothing to push' : `Push ${ahead} commit${ahead !== 1 ? 's' : ''}`}
            />
          </div>
          <SyncButton
            icon="↻"
            label="Fetch"
            disabled={isSyncing}
            active={syncOp === 'fetching'}
            onClick={handleFetch}
            title="Fetch from all remotes"
            fullWidth
          />
        </div>
      )}

      {/* Upstream prompt */}
      {upstreamPrompt && (
        <div className="px-3 py-2 border-b border-border bg-bg-tertiary/50">
          <p className="text-[11px] text-text-primary mb-2">
            No upstream for <span className="font-mono text-accent">{upstreamPrompt.branch}</span>. Set up tracking?
          </p>
          <div className="flex items-center justify-end gap-1.5">
            <button
              onClick={() => setUpstreamPrompt(null)}
              className="px-2 py-1 text-[11px] rounded-md border border-border text-text-secondary hover:bg-bg-hover transition-colors cursor-default"
            >
              Cancel
            </button>
            <button
              onClick={handlePushWithUpstream}
              disabled={isSyncing}
              className="px-2 py-1 text-[11px] rounded-md bg-accent text-white hover:bg-accent-hover transition-colors cursor-default disabled:opacity-50"
            >
              Push with -u
            </button>
          </div>
        </div>
      )}

      {/* Success / error feedback */}
      {successMsg && (
        <div className="px-3 py-1.5 text-[11px] text-green-400 border-b border-border bg-green-500/10 flex items-center gap-1.5">
          <span>✓</span>
          <span className="truncate">{successMsg}</span>
        </div>
      )}
      {(syncError || localError) && (
        <div className="px-3 py-1.5 text-[11px] text-red-400 border-b border-border bg-red-500/10 flex items-center gap-1.5">
          <span>✗</span>
          <span className="truncate">{syncError || localError}</span>
        </div>
      )}

      {/* Branch list */}
      <div className="overflow-y-auto flex-1 min-h-0">
        {!branches ? (
          <div className="p-3 text-[12px] text-text-muted text-center">Loading...</div>
        ) : (
          <>
            {/* Local branches */}
            {localFiltered.length > 0 && (
              <div>
                <div className="px-3 py-1.5 text-[10px] text-text-muted uppercase tracking-wider font-medium">Local</div>
                {localFiltered.map((b) => (
                  <button
                    key={b}
                    onClick={() => handleCheckout(b)}
                    disabled={loading}
                    className="w-full text-left px-3 py-1.5 text-[12px] hover:bg-bg-hover transition-colors flex items-center justify-between cursor-default disabled:opacity-50"
                  >
                    <span className={`truncate ${b === branches.current ? 'text-accent font-medium' : 'text-text-primary'}`}>
                      {b}
                    </span>
                    {b === branches.current && (
                      <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0 ml-2" />
                    )}
                  </button>
                ))}
              </div>
            )}

            {/* Remote branches */}
            {remoteFiltered.length > 0 && (
              <div>
                <div className="px-3 py-1.5 text-[10px] text-text-muted uppercase tracking-wider font-medium border-t border-border">Remote</div>
                {remoteFiltered.map((b) => {
                  // Dim the remote prefix, highlight the branch name
                  const slashIdx = b.indexOf('/')
                  const prefix = slashIdx >= 0 ? b.slice(0, slashIdx + 1) : ''
                  const name = slashIdx >= 0 ? b.slice(slashIdx + 1) : b
                  return (
                    <button
                      key={b}
                      onClick={() => handleCheckout(name)}
                      disabled={loading}
                      className="w-full text-left px-3 py-1.5 text-[12px] hover:bg-bg-hover transition-colors truncate cursor-default disabled:opacity-50"
                    >
                      <span className="text-text-muted">{prefix}</span>
                      <span className="text-text-secondary">{name}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </>
        )}
      </div>

      {/* Create new branch */}
      <div className="border-t border-border">
        {creating ? (
          <div className="p-2 flex gap-1.5">
            <input
              type="text"
              value={newBranchName}
              onChange={(e) => setNewBranchName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateBranch()
                if (e.key === 'Escape') { setCreating(false); setNewBranchName('') }
              }}
              placeholder="Branch name"
              className="flex-1 bg-bg-tertiary text-text-primary text-[12px] px-2.5 py-1.5 rounded-md outline-none placeholder:text-text-muted"
              autoFocus
            />
            <button
              onClick={handleCreateBranch}
              disabled={!newBranchName.trim() || loading}
              className="px-2.5 py-1.5 text-[12px] bg-accent text-white rounded-md hover:bg-accent-hover transition-colors disabled:opacity-50 cursor-default"
            >
              Create
            </button>
          </div>
        ) : (
          <button
            onClick={() => setCreating(true)}
            className="w-full text-left px-3 py-2 text-[12px] text-accent hover:bg-bg-hover transition-colors cursor-default"
          >
            + Create new branch...
          </button>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// SyncButton — compact button for Pull / Push / Fetch
// ---------------------------------------------------------------------------

function SyncButton({
  icon,
  label,
  count,
  disabled,
  active,
  onClick,
  title,
  fullWidth
}: {
  icon: string
  label: string
  count?: number
  disabled: boolean
  active: boolean
  onClick: () => void
  title: string
  fullWidth?: boolean
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-medium transition-colors cursor-default
        ${fullWidth ? 'col-span-2' : ''}
        ${disabled
          ? 'bg-bg-tertiary/50 text-text-muted/50 cursor-default'
          : 'bg-bg-tertiary text-text-secondary hover:bg-bg-hover hover:text-text-primary'
        }`}
    >
      {active ? (
        <span className="animate-spin inline-block text-accent">⟳</span>
      ) : (
        <span>{icon}</span>
      )}
      <span>{label}</span>
      {!!count && count > 0 && (
        <span className="text-[10px] text-accent tabular-nums">({count})</span>
      )}
    </button>
  )
}
