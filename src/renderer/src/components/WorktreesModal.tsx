import { useState, useEffect, useCallback } from 'react'
import type { WorktreeEntry, WorktreeStatus } from '../../../shared/types'

export function WorktreesModal({
  cwd,
  onClose
}: {
  cwd: string
  onClose: () => void
}): React.JSX.Element {
  const [entries, setEntries] = useState<WorktreeEntry[]>([])
  const [statuses, setStatuses] = useState<Record<string, WorktreeStatus>>({})
  const [loading, setLoading] = useState(true)
  const [removingSet, setRemovingSet] = useState<Set<string>>(new Set())

  const loadEntries = useCallback(async () => {
    setLoading(true)
    try {
      const list = await window.api.listWorktrees(cwd)
      setEntries(list)
      // Fire-and-forget status fetches
      for (const entry of list) {
        if (entry.exists) {
          window.api.getWorktreeStatus(entry.path, '')
            .then((s) => setStatuses((prev) => ({ ...prev, [entry.name]: s })))
            .catch(() => {})
        }
      }
    } catch {
      setEntries([])
    } finally {
      setLoading(false)
    }
  }, [cwd])

  useEffect(() => { loadEntries() }, [loadEntries])

  const handleRemove = async (entry: WorktreeEntry): Promise<void> => {
    setRemovingSet((prev) => new Set(prev).add(entry.name))
    try {
      // Find git root from cwd — worktree service uses it
      await window.api.removeWorktree(entry.path, entry.branch, cwd)
      setEntries((prev) => prev.filter((e) => e.name !== entry.name))
    } catch (err) {
      window.api.logError('WorktreesModal', `Failed to remove worktree ${entry.name}: ${err}`)
    } finally {
      setRemovingSet((prev) => {
        const next = new Set(prev)
        next.delete(entry.name)
        return next
      })
    }
  }

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-bg-primary border border-border rounded-xl shadow-2xl w-[480px] max-h-[500px] flex flex-col animate-fade-in">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h3 className="text-[15px] font-medium text-text-primary">Worktrees</h3>
          <button
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6L6 18" />
              <path d="M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="text-[12px] text-text-muted text-center py-4">Loading...</div>
          ) : entries.length === 0 ? (
            <div className="text-[12px] text-text-muted text-center py-4">
              No worktrees found in .claude/worktrees/
            </div>
          ) : (
            <div className="space-y-2">
              {entries.map((entry) => {
                const s = statuses[entry.name]
                const isRemoving = removingSet.has(entry.name)
                return (
                  <div key={entry.name} className="flex items-center justify-between px-3 py-2 rounded-lg bg-bg-tertiary border border-border">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] text-text-primary font-mono truncate">{entry.name}</span>
                        {!entry.exists && (
                          <span className="text-[10px] text-red-400 bg-red-400/10 px-1.5 py-0.5 rounded">missing</span>
                        )}
                      </div>
                      <div className="text-[11px] text-text-muted mt-0.5">
                        {entry.branch}
                        {s && (
                          <span className="ml-2">
                            {s.uncommittedFiles === 0 && s.commitsAhead === 0
                              ? 'clean'
                              : [
                                  s.uncommittedFiles > 0 ? `${s.uncommittedFiles} changed` : '',
                                  s.commitsAhead > 0 ? `${s.commitsAhead} commit${s.commitsAhead !== 1 ? 's' : ''}` : ''
                                ].filter(Boolean).join(' · ')}
                          </span>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={() => handleRemove(entry)}
                      disabled={isRemoving}
                      className="shrink-0 ml-3 px-2.5 py-1 rounded-md text-[11px] text-red-400 hover:text-red-300 hover:bg-red-400/10 disabled:opacity-50 transition-colors cursor-default"
                    >
                      {isRemoving ? 'Removing...' : 'Remove'}
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
