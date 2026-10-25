import type { WorktreeInfo } from '../../../../shared/types'

export interface QuitWorktreeEntry {
  routingId: string
  worktreeInfo: WorktreeInfo
}

export interface QuitWorktreeModalViewProps {
  quitWorktrees: QuitWorktreeEntry[]
  removing: boolean
  onCancel: () => void
  onKeepAll: () => void
  onRemoveAll: () => void
}

export function QuitWorktreeModalView({
  quitWorktrees,
  removing,
  onCancel,
  onKeepAll,
  onRemoveAll
}: QuitWorktreeModalViewProps): React.JSX.Element {
  // Two sessions can share one worktree: it is listed (and counted) once.
  const worktrees = [
    ...new Map(
      quitWorktrees.map(({ worktreeInfo }) => [worktreeInfo.worktreePath, worktreeInfo])
    ).values()
  ]
  return (
    <div
      data-testid="QuitWorktreeModal"
      className="fixed inset-0 z-[200] flex items-center justify-center"
    >
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div className="relative bg-bg-primary border border-border rounded-xl shadow-2xl w-[420px] max-w-[calc(100%-2rem)] p-5 animate-fade-in">
        <h3 className="text-[15px] font-medium text-text-primary mb-3">Active worktrees</h3>

        <p className="text-[13px] text-text-secondary mb-3">
          You have {worktrees.length} active worktree{worktrees.length !== 1 ? 's' : ''}. Would you
          like to remove them before quitting?
        </p>

        <p data-testid="QuitWorktreeModal.note" className="text-[11px] text-text-muted mb-3">
          {removing
            ? 'Closing your sessions, then removing the worktrees. ClaudeUI quits when this is done.'
            : 'Removal happens after your sessions close, so quitting may take a moment. Branches with commits found nowhere else are kept.'}
        </p>

        <div className="mb-4 space-y-1.5">
          {worktrees.map((worktreeInfo) => (
            <div
              key={worktreeInfo.worktreePath}
              data-testid="QuitWorktreeModal.worktreeRow"
              data-id={worktreeInfo.worktreeName}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-bg-tertiary border border-border"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="shrink-0 text-mode-edit"
              >
                <circle cx="12" cy="18" r="3" />
                <circle cx="6" cy="6" r="3" />
                <circle cx="18" cy="6" r="3" />
                <path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" />
                <path d="M12 12v3" />
              </svg>
              <span className="text-[12px] text-text-primary font-mono truncate">
                {worktreeInfo.worktreeName}
              </span>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap justify-end gap-2">
          <button
            data-testid="QuitWorktreeModal.cancel"
            onClick={onCancel}
            disabled={removing}
            className="px-3 py-1.5 rounded-md text-[12px] text-text-muted hover:text-text-primary hover:bg-bg-hover disabled:opacity-50 transition-colors cursor-default"
          >
            Cancel
          </button>
          <button
            data-testid="QuitWorktreeModal.keepAll"
            onClick={onKeepAll}
            disabled={removing}
            className="px-3 py-1.5 rounded-md text-[12px] text-text-secondary bg-bg-tertiary hover:bg-bg-hover border border-border disabled:opacity-50 transition-colors cursor-default"
          >
            Keep all & quit
          </button>
          <button
            data-testid="QuitWorktreeModal.removeAll"
            onClick={onRemoveAll}
            disabled={removing}
            className="px-3 py-1.5 rounded-md text-[12px] text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 transition-colors cursor-default"
          >
            {removing ? 'Quitting...' : 'Remove all & quit'}
          </button>
        </div>
      </div>
    </div>
  )
}
