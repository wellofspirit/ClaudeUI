import { useState, useEffect, useRef, useCallback } from 'react'
import { useActiveSession, useSessionStore } from '../../../stores/session-store'
import type { GitBranchData } from '../../../../../shared/types'
import { GitBranchDropdownView } from './View'

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

    window.api.gitFetch(cwd).then(async () => {
      setLastFetchTime(activeSessionId, Date.now())
      await refreshAll()
    }).catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps -- only on mount

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
    <GitBranchDropdownView
      dropdownRef={ref}
      inputRef={inputRef}
      search={search}
      onSearchChange={setSearch}
      branches={branches}
      localFiltered={localFiltered}
      remoteFiltered={remoteFiltered}
      hasRemote={hasRemote}
      hasTracking={hasTracking}
      ahead={ahead}
      behind={behind}
      isSyncing={isSyncing}
      syncOp={syncOp}
      syncError={syncError}
      localError={localError}
      successMsg={successMsg}
      upstreamPrompt={upstreamPrompt}
      creating={creating}
      newBranchName={newBranchName}
      loading={loading}
      onNewBranchNameChange={setNewBranchName}
      onStartCreating={() => setCreating(true)}
      onCancelCreating={() => { setCreating(false); setNewBranchName('') }}
      onCreateBranch={handleCreateBranch}
      onCheckout={handleCheckout}
      onFetch={handleFetch}
      onPull={handlePull}
      onPush={handlePush}
      onPushWithUpstream={handlePushWithUpstream}
      onDismissUpstream={() => setUpstreamPrompt(null)}
    />
  )
}
