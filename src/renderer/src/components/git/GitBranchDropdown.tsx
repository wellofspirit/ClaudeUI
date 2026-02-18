import { useState, useEffect, useRef, useCallback } from 'react'
import { useActiveSession, useSessionStore } from '../../stores/session-store'
import type { GitBranchData } from '../../../../shared/types'

interface Props {
  onClose: () => void
  anchorRef: React.RefObject<HTMLButtonElement | null>
}

export function GitBranchDropdown({ onClose, anchorRef }: Props): React.JSX.Element {
  const cwd = useActiveSession((s) => s.cwd)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const setGitStatus = useSessionStore((s) => s.setGitStatus)
  const setGitBranches = useSessionStore((s) => s.setGitBranches)
  const [branches, setBranches] = useState<GitBranchData | null>(null)
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const [newBranchName, setNewBranchName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Load branches on open
  useEffect(() => {
    if (!cwd) return
    window.api.gitGetBranches(cwd).then((b) => {
      setBranches(b)
      if (activeSessionId) setGitBranches(activeSessionId, b)
    }).catch(() => {})
  }, [cwd, activeSessionId, setGitBranches])

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

  const handleCheckout = useCallback(async (branch: string) => {
    if (!cwd || loading) return
    setLoading(true)
    setError(null)
    try {
      await window.api.gitCheckout(cwd, branch)
      // Refresh status
      const status = await window.api.gitGetStatus(cwd)
      if (activeSessionId) setGitStatus(activeSessionId, status)
      const newBranches = await window.api.gitGetBranches(cwd)
      if (activeSessionId) setGitBranches(activeSessionId, newBranches)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to switch branch')
    } finally {
      setLoading(false)
    }
  }, [cwd, activeSessionId, loading, onClose, setGitStatus, setGitBranches])

  const handleCreateBranch = useCallback(async () => {
    if (!cwd || !newBranchName.trim() || loading) return
    setLoading(true)
    setError(null)
    try {
      await window.api.gitCreateBranch(cwd, newBranchName.trim())
      const status = await window.api.gitGetStatus(cwd)
      if (activeSessionId) setGitStatus(activeSessionId, status)
      const newBranches = await window.api.gitGetBranches(cwd)
      if (activeSessionId) setGitBranches(activeSessionId, newBranches)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create branch')
    } finally {
      setLoading(false)
    }
  }, [cwd, newBranchName, activeSessionId, loading, onClose, setGitStatus, setGitBranches])

  const filter = search.toLowerCase()
  const localFiltered = branches?.local.filter((b) => b.toLowerCase().includes(filter)) || []
  const remoteFiltered = branches?.remote.filter((b) => b.toLowerCase().includes(filter)) || []

  return (
    <div
      ref={ref}
      className="absolute top-full right-0 mt-1 w-72 max-h-80 bg-bg-primary border border-border rounded-lg shadow-lg overflow-hidden z-50 flex flex-col"
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
                {remoteFiltered.map((b) => (
                  <button
                    key={b}
                    onClick={() => {
                      // Extract branch name after origin/
                      const localName = b.replace(/^[^/]+\//, '')
                      handleCheckout(localName)
                    }}
                    disabled={loading}
                    className="w-full text-left px-3 py-1.5 text-[12px] text-text-secondary hover:bg-bg-hover transition-colors truncate cursor-default disabled:opacity-50"
                  >
                    {b}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Error display */}
      {error && (
        <div className="px-3 py-2 text-[11px] text-red-400 border-t border-border bg-red-500/10">
          {error}
        </div>
      )}

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
