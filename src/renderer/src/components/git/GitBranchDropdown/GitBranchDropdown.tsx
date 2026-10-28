import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useActiveSession, useSessionStore } from '../../../stores/session-store'
import { useEscapeLayer } from '../../shared/use-escape-layer'
import type { GitBranchData } from '../../../../../shared/types'
import { GitBranchDropdownView, type PullPrompt, type StashPrompt } from './View'
import {
  CREATE_KEY,
  autostashFor,
  buildBranchList,
  formatFetched,
  pullChoice
} from './branch-model'

interface Props {
  onClose: () => void
  anchorRef: React.RefObject<HTMLButtonElement | null>
}

/** Cooldown (ms) between auto-fetches when dropdown opens */
const FETCH_COOLDOWN = 30_000

const errorMessage = (err: unknown, fallback: string): string =>
  err instanceof Error && err.message ? err.message : fallback

/** Last path segment, whichever separator the host uses. */
const baseName = (p: string): string =>
  p
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() || p

export function GitBranchDropdown({ onClose, anchorRef }: Props): React.JSX.Element {
  const cwd = useActiveSession((s) => s.cwd)
  const gitStatus = useActiveSession((s) => s.gitStatus)
  const worktreeInfo = useActiveSession((s) => s.worktreeInfo)
  const syncOp = useActiveSession((s) => s.gitSyncOperation)
  const uiFontScale = useSessionStore((s) => s.settings.uiFontScale)
  const lastFetchTime = useActiveSession((s) => s.gitLastFetchTime)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const setGitStatus = useSessionStore((s) => s.setGitStatus)
  const setGitBranches = useSessionStore((s) => s.setGitBranches)
  const setSyncOp = useSessionStore((s) => s.setGitSyncOperation)
  const setSyncError = useSessionStore((s) => s.setGitSyncError)
  const setLastFetchTime = useSessionStore((s) => s.setGitLastFetchTime)
  const [branches, setBranches] = useState<GitBranchData | null>(null)
  const [search, setSearch] = useState('')
  /** Index into the list's keyboard order; -1 = nothing highlighted yet. */
  const [hiIndex, setHiIndex] = useState(-1)
  const [remoteOpen, setRemoteOpen] = useState(false)
  /** The base picked for "Create <text>"; null = the current branch. */
  const [base, setBase] = useState<string | null>(null)
  const [baseMenuOpen, setBaseMenuOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<{ title: string; message: string } | null>(null)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)
  const [pullPrompt, setPullPrompt] = useState<PullPrompt | null>(null)
  const [stashPrompt, setStashPrompt] = useState<StashPrompt | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  /** Read by the click-outside handler: a popup lives outside `ref`, in a portal. */
  const popupOpenRef = useRef(false)
  popupOpenRef.current = !!pullPrompt || !!stashPrompt

  const isSyncing = syncOp !== 'idle'
  const trackingBranch = gitStatus?.trackingBranch || null
  const ahead = gitStatus?.ahead ?? 0
  const behind = gitStatus?.behind ?? 0
  const detached = !gitStatus?.branch || gitStatus.branch === 'HEAD'
  const current = branches?.current || gitStatus?.branch || ''

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
    } catch {
      /* swallow — individual handlers report errors */
    }
  }, [cwd, activeSessionId, setGitStatus, setGitBranches])

  // Load branches on open
  useEffect(() => {
    if (!cwd) return
    window.api
      .gitGetBranches(cwd)
      .then((b) => {
        setBranches(b)
        if (activeSessionId) setGitBranches(activeSessionId, b)
      })
      .catch(() => {})
  }, [cwd, activeSessionId, setGitBranches])

  // Auto-fetch on open (with cooldown)
  useEffect(() => {
    if (!cwd || !activeSessionId || !trackingBranch) return
    const now = Date.now()
    if (lastFetchTime && now - lastFetchTime < FETCH_COOLDOWN) return

    window.api
      .gitFetch(cwd)
      .then(async () => {
        setLastFetchTime(activeSessionId, Date.now())
        await refreshAll()
      })
      .catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps -- only on mount

  // Escape, through the app's one stack (use-escape-layer). One press peels one
  // step: the base list, then the typed text, then the dropdown. (A popup is its
  // own, higher layer.)
  useEscapeLayer(() => {
    if (baseMenuOpen) return setBaseMenuOpen(false)
    if (search) return setSearch('')
    onClose()
  })

  // Click-outside to close — not while a popup is up: it is portalled out of `ref`.
  useEffect(() => {
    const handler = (e: MouseEvent): void => {
      if (popupOpenRef.current) return
      if (
        ref.current &&
        !ref.current.contains(e.target as Node) &&
        anchorRef.current &&
        !anchorRef.current.contains(e.target as Node)
      ) {
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

  /** Show a failure inside the dropdown: git's whole message, under a title. */
  const fail = useCallback(
    (title: string, err: unknown, fallback: string, syncVerb = false) => {
      const message = errorMessage(err, fallback)
      setError({ title, message })
      if (syncVerb && activeSessionId) setSyncError(activeSessionId, message)
    },
    [activeSessionId, setSyncError]
  )

  /** Run one sync verb with the shared op state, error and success handling. */
  const runSync = useCallback(
    async (
      op: 'fetching' | 'pulling' | 'pushing',
      failTitle: string,
      action: () => Promise<string | void>
    ) => {
      if (!cwd || !activeSessionId || isSyncing) return
      setSyncOp(activeSessionId, op)
      setSyncError(activeSessionId, null)
      setError(null)
      setSuccessMsg(null)
      try {
        const msg = await action()
        await refreshAll()
        if (msg) setSuccessMsg(msg)
      } catch (err) {
        fail(failTitle, err, failTitle, true)
      } finally {
        setSyncOp(activeSessionId, 'idle')
      }
    },
    [cwd, activeSessionId, isSyncing, setSyncOp, setSyncError, refreshAll, fail]
  )

  const handleFetch = useCallback(
    () =>
      runSync('fetching', "Couldn't fetch", async () => {
        await window.api.gitFetch(cwd!)
        if (activeSessionId) setLastFetchTime(activeSessionId, Date.now())
        return 'Fetched from remote'
      }),
    [runSync, cwd, activeSessionId, setLastFetchTime]
  )

  const doPull = useCallback(
    (mode?: 'merge' | 'rebase') =>
      runSync('pulling', "Couldn't pull", async () => {
        const result = await window.api.gitPull(cwd!, mode)
        return `Pulled: ${result.summary}`
      }),
    [runSync, cwd]
  )

  /** A diverged branch asks first; a fast-forward just runs. */
  const handlePull = useCallback(async () => {
    if (ahead > 0 && behind > 0) {
      setPullPrompt({
        ahead,
        behind,
        choice: pullChoice(branches?.pullConfig ?? { rebase: null, ff: null })
      })
      return
    }
    await doPull()
  }, [ahead, behind, branches?.pullConfig, doPull])

  const handlePullConfirm = useCallback(
    async (mode: 'merge' | 'rebase') => {
      setPullPrompt(null)
      await doPull(mode)
    },
    [doPull]
  )

  const handlePush = useCallback(
    () =>
      runSync('pushing', "Couldn't push", async () => {
        await window.api.gitPush(cwd!)
        return 'Pushed to remote'
      }),
    [runSync, cwd]
  )

  const handlePublish = useCallback(
    () =>
      runSync('pushing', "Couldn't publish", async () => {
        await window.api.gitPushWithUpstream(cwd!, gitStatus?.branch || 'HEAD')
        return 'Published to remote (upstream set)'
      }),
    [runSync, cwd, gitStatus?.branch]
  )

  /** `stash`: stash the working tree (untracked included) before switching. */
  const doCheckout = useCallback(
    async (branch: string, stash: boolean) => {
      if (!cwd) return
      setLoading(true)
      setError(null)
      let stashed = false
      try {
        if (stash) {
          await window.api.gitStashPush(cwd)
          stashed = true
        }
        await window.api.gitCheckout(cwd, branch)
        await refreshAll()
        onClose()
      } catch (err) {
        fail(
          stashed ? `Stashed, but couldn't switch to ${branch}` : `Couldn't switch to ${branch}`,
          err,
          'Failed to switch branch'
        )
        if (stashed) await refreshAll() // the Restore row
      } finally {
        setLoading(false)
      }
    },
    [cwd, refreshAll, onClose, fail]
  )

  const handleCheckout = useCallback(
    async (branch: string) => {
      if (!cwd || loading) return
      if (branch === current) return onClose()
      const files = gitStatus?.files.length ?? 0
      if (files > 0) {
        setStashPrompt({ branch, files })
        return
      }
      await doCheckout(branch, false)
    },
    [cwd, loading, current, gitStatus?.files.length, onClose, doCheckout]
  )

  const list = useMemo(
    () =>
      branches
        ? buildBranchList(branches, search, remoteOpen)
        : { local: [], remoteOnly: [], remoteExpanded: false, createName: null, navKeys: [] },
    [branches, search, remoteOpen]
  )
  const createBase = base ?? current

  const handleCreate = useCallback(async () => {
    const name = list.createName
    if (!cwd || !name || loading) return
    setLoading(true)
    setError(null)
    try {
      await window.api.gitCreateBranch(cwd, name, base && base !== current ? base : null)
      await refreshAll()
      onClose()
    } catch (err) {
      fail(`Couldn't create ${name}`, err, 'Failed to create branch')
    } finally {
      setLoading(false)
    }
  }, [cwd, list.createName, loading, base, current, refreshAll, onClose, fail])

  const handleRestore = useCallback(async () => {
    const stash = autostashFor(branches, current)
    if (!cwd || !stash || loading) return
    setLoading(true)
    setError(null)
    setSuccessMsg(null)
    try {
      await window.api.gitStashRestore(cwd, stash.latest.sha)
      await refreshAll()
      setSuccessMsg('Restored your stashed changes')
    } catch (err) {
      fail("Couldn't restore the stash", err, 'Failed to restore the stash')
    } finally {
      setLoading(false)
    }
  }, [cwd, branches, current, loading, refreshAll, fail])

  const handleCopyWorktreePath = useCallback(async () => {
    if (!worktreeInfo) return
    try {
      await navigator.clipboard.writeText(worktreeInfo.worktreePath)
      setSuccessMsg('Path copied')
    } catch {
      /* clipboard unavailable */
    }
  }, [worktreeInfo])

  const highlightKey = list.navKeys[hiIndex] ?? null

  const activate = (key: string | null): void => {
    if (key === CREATE_KEY) return void handleCreate()
    const row = [...list.local, ...list.remoteOnly].find((r) => r.key === key)
    if (row) void handleCheckout(row.name)
  }

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    const n = list.navKeys.length
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (n === 0) return
      setHiIndex((i) => (e.key === 'ArrowDown' ? (i + 1) % n : i <= 0 ? n - 1 : (i - 1) % n))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      // Shift+Enter always creates what was typed; Enter takes the highlighted row.
      activate(e.shiftKey && list.createName ? CREATE_KEY : highlightKey)
    }
  }

  const detail = branches?.details.find((d) => d.kind === 'local' && d.current)

  return (
    <GitBranchDropdownView
      dropdownRef={ref}
      inputRef={inputRef}
      current={current}
      detached={detached}
      upstream={trackingBranch}
      upstreamGone={!!detail?.gone}
      hasRemote={branches ? branches.remote.length > 0 : !!trackingBranch}
      ahead={ahead}
      behind={behind}
      unpublished={branches?.unpublished ?? 0}
      fetchedLabel={lastFetchTime ? formatFetched(lastFetchTime, Date.now()) : null}
      worktree={
        worktreeInfo
          ? {
              name: worktreeInfo.worktreeName,
              parentRepo: baseName(worktreeInfo.gitRoot || worktreeInfo.originalCwd),
              path: worktreeInfo.worktreePath
            }
          : null
      }
      autostashCount={branches?.autostashes.filter((s) => s.branch === current).length ?? 0}
      isSyncing={isSyncing}
      syncOp={syncOp}
      search={search}
      onSearchChange={(value) => {
        setSearch(value)
        setHiIndex(value.trim() ? 0 : -1)
      }}
      onSearchKeyDown={handleSearchKeyDown}
      loaded={branches !== null}
      list={list}
      highlightKey={highlightKey}
      now={Date.now()}
      uiFontScale={uiFontScale}
      onToggleRemote={() => setRemoteOpen((o) => !o)}
      createBase={createBase}
      baseOptions={branches?.local ?? []}
      baseMenuOpen={baseMenuOpen}
      onToggleBaseMenu={() => setBaseMenuOpen((o) => !o)}
      onPickBase={(name) => {
        setBase(name)
        setBaseMenuOpen(false)
      }}
      loading={loading}
      error={error}
      successMsg={successMsg}
      onDismissError={() => setError(null)}
      pullPrompt={pullPrompt}
      stashPrompt={stashPrompt}
      onCheckout={handleCheckout}
      onCreate={handleCreate}
      onNewBranch={() => inputRef.current?.focus()}
      onFetch={handleFetch}
      onPull={handlePull}
      onPush={handlePush}
      onPublish={handlePublish}
      onRestore={handleRestore}
      onCopyWorktreePath={handleCopyWorktreePath}
      onPullConfirm={handlePullConfirm}
      onPullCancel={() => setPullPrompt(null)}
      onStashAndSwitch={async () => {
        const target = stashPrompt?.branch
        setStashPrompt(null)
        if (target) await doCheckout(target, true)
      }}
      onSwitchAnyway={async () => {
        const target = stashPrompt?.branch
        setStashPrompt(null)
        if (target) await doCheckout(target, false)
      }}
      onStashCancel={() => setStashPrompt(null)}
    />
  )
}
