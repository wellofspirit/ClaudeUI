import { useState } from 'react'
import { useSessionStore } from '../../stores/session-store'
import { QuitWorktreeModalView } from './View'

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
        await window.api.removeWorktree(
          worktreeInfo.worktreePath,
          worktreeInfo.worktreeBranch,
          worktreeInfo.gitRoot
        )
        clearWorktreeInfo(routingId)
      } catch (err) {
        window.api.logError(
          'QuitWorktreeModal',
          `Failed to remove worktree ${worktreeInfo.worktreeName}: ${err}`
        )
      }
    }
    setQuitWorktrees(null)
    window.api.confirmQuit()
  }

  const handleCancel = (): void => {
    // Tell main to abort the pending quit (clear the fallback timer; services
    // were never torn down) BEFORE clearing local state. Without this, the 5s
    // fallback in the main process would force-quit even though the user cancelled.
    window.api.cancelQuit()
    setQuitWorktrees(null)
  }

  return (
    <QuitWorktreeModalView
      quitWorktrees={quitWorktrees}
      removing={removing}
      onCancel={handleCancel}
      onKeepAll={handleKeepAll}
      onRemoveAll={handleRemoveAll}
    />
  )
}
