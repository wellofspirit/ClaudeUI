import { useState } from 'react'
import { useSessionStore } from '../stores/session-store'

export function QuitWorktreeModal(): React.JSX.Element | null {
  const quitWorktrees = useSessionStore((s) => s.quitWorktrees)
  const setQuitWorktrees = useSessionStore((s) => s.setQuitWorktrees)
  const clearWorktreeInfo = useSessionStore((s) => s.clearWorktreeInfo)
  const [removing, setRemoving] = useState(false)

  if (!quitWorktrees || quitWorktrees.length === 0) return null

  const handleKeepAll = (): void => {
    setQuitWorktrees(null)
    window.api.confirmQuit()
  }

  const handleRemoveAll = async (): Promise<void> => {
    setRemoving(true)
    for (const { routingId, worktreeInfo } of quitWorktrees) {
      try {
        await window.api.removeWorktree(worktreeInfo.worktreePath, worktreeInfo.worktreeBranch, worktreeInfo.gitRoot)
        clearWorktreeInfo(routingId)
      } catch (err) {
        window.api.logError('QuitWorktreeModal', `Failed to remove worktree ${worktreeInfo.worktreeName}: ${err}`)
      }
    }
    setQuitWorktrees(null)
    window.api.confirmQuit()
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div className="relative bg-bg-primary border border-border rounded-xl shadow-2xl w-[420px] p-5 animate-fade-in">
        <h3 className="text-[15px] font-medium text-text-primary mb-3">Active worktrees</h3>

        <p className="text-[13px] text-text-secondary mb-3">
          You have {quitWorktrees.length} active worktree{quitWorktrees.length !== 1 ? 's' : ''}.
          Would you like to remove them before quitting?
        </p>

        <div className="mb-4 space-y-1.5">
          {quitWorktrees.map(({ worktreeInfo }) => (
            <div key={worktreeInfo.worktreeName} className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-bg-tertiary border border-border">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-mode-edit">
                <circle cx="12" cy="18" r="3" />
                <circle cx="6" cy="6" r="3" />
                <circle cx="18" cy="6" r="3" />
                <path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" />
                <path d="M12 12v3" />
              </svg>
              <span className="text-[12px] text-text-primary font-mono truncate">{worktreeInfo.worktreeName}</span>
            </div>
          ))}
        </div>

        <div className="flex justify-end gap-2">
          <button
            onClick={() => setQuitWorktrees(null)}
            className="px-3 py-1.5 rounded-md text-[12px] text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
          >
            Cancel
          </button>
          <button
            onClick={handleKeepAll}
            className="px-3 py-1.5 rounded-md text-[12px] text-text-secondary bg-bg-tertiary hover:bg-bg-hover border border-border transition-colors cursor-default"
          >
            Keep all & quit
          </button>
          <button
            onClick={handleRemoveAll}
            disabled={removing}
            className="px-3 py-1.5 rounded-md text-[12px] text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 transition-colors cursor-default"
          >
            {removing ? 'Removing...' : 'Remove all & quit'}
          </button>
        </div>
      </div>
    </div>
  )
}
