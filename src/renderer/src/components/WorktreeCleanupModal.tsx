import { useState, useEffect } from 'react'
import type { WorktreeInfo, WorktreeStatus } from '../../../shared/types'

export function WorktreeCleanupModal({
  worktreeInfo,
  onKeep,
  onRemove,
  onCancel
}: {
  worktreeInfo: WorktreeInfo
  onKeep: () => void
  onRemove: () => void
  onCancel: () => void
}): React.JSX.Element {
  const [status, setStatus] = useState<WorktreeStatus | null>(null)
  const [removing, setRemoving] = useState(false)

  useEffect(() => {
    window.api.getWorktreeStatus(worktreeInfo.worktreePath, worktreeInfo.originalHeadCommit)
      .then(setStatus)
      .catch(() => setStatus(null))
  }, [worktreeInfo])

  const handleRemove = async (): Promise<void> => {
    setRemoving(true)
    try {
      await window.api.removeWorktree(worktreeInfo.worktreePath, worktreeInfo.worktreeBranch, worktreeInfo.gitRoot)
      onRemove()
    } catch (err) {
      window.api.logError('WorktreeCleanup', `Failed to remove worktree: ${err}`)
      onRemove() // proceed anyway
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative bg-bg-primary border border-border rounded-xl shadow-2xl w-[400px] p-5 animate-fade-in">
        <h3 className="text-[15px] font-medium text-text-primary mb-3">Worktree cleanup</h3>

        <p className="text-[13px] text-text-secondary mb-3">
          This session has an active worktree <span className="font-mono text-mode-edit">{worktreeInfo.worktreeName}</span>.
          Would you like to remove it from disk?
        </p>

        {status && (
          <div className="px-3 py-2 rounded-lg bg-bg-tertiary border border-border mb-4 text-[12px] text-text-muted space-y-1">
            <div>{status.uncommittedFiles} uncommitted file{status.uncommittedFiles !== 1 ? 's' : ''}</div>
            <div>{status.commitsAhead} commit{status.commitsAhead !== 1 ? 's' : ''} ahead</div>
          </div>
        )}

        {(status?.uncommittedFiles ?? 0) > 0 || (status?.commitsAhead ?? 0) > 0 ? (
          <p className="text-[11px] text-warning mb-3">
            Warning: removing will permanently delete uncommitted changes and unmerged commits.
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 rounded-md text-[12px] text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
          >
            Cancel
          </button>
          <button
            onClick={onKeep}
            className="px-3 py-1.5 rounded-md text-[12px] text-text-secondary bg-bg-tertiary hover:bg-bg-hover border border-border transition-colors cursor-default"
          >
            Keep worktree
          </button>
          <button
            onClick={handleRemove}
            disabled={removing}
            className="px-3 py-1.5 rounded-md text-[12px] text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 transition-colors cursor-default"
          >
            {removing ? 'Removing...' : 'Remove worktree'}
          </button>
        </div>
      </div>
    </div>
  )
}
