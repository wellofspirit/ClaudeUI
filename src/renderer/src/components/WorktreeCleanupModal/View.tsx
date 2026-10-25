import type { WorktreeInfo, WorktreeStatus } from '../../../../shared/types'

export interface WorktreeCleanupModalViewProps {
  worktreeInfo: WorktreeInfo
  status: WorktreeStatus | null
  removing: boolean
  /** A refused / partial / failed removal; the modal stays open. */
  outcome: { tone: 'warn' | 'error'; text: string; paths: string[] } | null
  onKeep: () => void
  onRemove: () => void
  onCancel: () => void
}

export function WorktreeCleanupModalView({
  worktreeInfo,
  status,
  removing,
  outcome,
  onKeep,
  onRemove,
  onCancel
}: WorktreeCleanupModalViewProps): React.JSX.Element {
  return (
    <div
      data-testid="WorktreeCleanupModal"
      className="fixed inset-0 z-[100] flex items-center justify-center"
    >
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative bg-bg-primary border border-border rounded-xl shadow-2xl w-[400px] max-w-[calc(100%-2rem)] p-5 animate-fade-in">
        <h3 className="text-[15px] font-medium text-text-primary mb-3">Worktree cleanup</h3>

        <p className="text-[13px] text-text-secondary mb-3">
          This session has an active worktree{' '}
          <span className="font-mono text-mode-edit">{worktreeInfo.worktreeName}</span>. Would you
          like to remove it from disk?
        </p>

        {status && (
          <div
            data-testid="WorktreeCleanupModal.status"
            className="px-3 py-2 rounded-lg bg-bg-tertiary border border-border mb-4 text-[12px] text-text-muted space-y-1"
          >
            <div data-testid="WorktreeCleanupModal.uncommitted">
              {status.uncommittedFiles} uncommitted file{status.uncommittedFiles !== 1 ? 's' : ''}
            </div>
            <div data-testid="WorktreeCleanupModal.commits">
              {status.branch
                ? `commits only on this branch: ${status.uniqueCommits}${
                    status.uniqueCommits > 0 ? ' — the branch is kept' : ''
                  }`
                : `commits only on this detached HEAD: ${status.uniqueCommits}`}
            </div>
          </div>
        )}

        {status && status.uncommittedFiles > 0 ? (
          <p data-testid="WorktreeCleanupModal.warning" className="text-[11px] text-warning mb-3">
            Warning: removing permanently deletes the uncommitted changes.
          </p>
        ) : null}
        {status && !status.branch && status.uniqueCommits > 0 ? (
          <p
            data-testid="WorktreeCleanupModal.detachedWarning"
            className="text-[11px] text-warning mb-3"
          >
            Warning: the commits on the detached HEAD are not on any branch and will be lost.
          </p>
        ) : null}

        {outcome && (
          <div
            data-testid="WorktreeCleanupModal.outcome"
            data-tone={outcome.tone}
            className={`px-3 py-2 rounded-lg border mb-3 text-[12px] break-words ${
              outcome.tone === 'error'
                ? 'border-red-500/30 bg-red-500/10 text-red-400'
                : 'border-warning/30 bg-warning/10 text-warning'
            }`}
          >
            {outcome.text}
            {outcome.paths.length > 0 && (
              <ul className="mt-1 font-mono text-[10px] text-text-muted break-all">
                {outcome.paths.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          <button
            data-testid="WorktreeCleanupModal.cancel"
            onClick={onCancel}
            className="px-3 py-1.5 rounded-md text-[12px] text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
          >
            Cancel
          </button>
          <button
            data-testid="WorktreeCleanupModal.keep"
            onClick={onKeep}
            className="px-3 py-1.5 rounded-md text-[12px] text-text-secondary bg-bg-tertiary hover:bg-bg-hover border border-border transition-colors cursor-default"
          >
            Keep worktree
          </button>
          <button
            data-testid="WorktreeCleanupModal.remove"
            onClick={onRemove}
            disabled={removing}
            className="px-3 py-1.5 rounded-md text-[12px] text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 transition-colors cursor-default"
          >
            {removing ? 'Removing...' : outcome ? 'Retry' : 'Remove worktree'}
          </button>
        </div>
      </div>
    </div>
  )
}
