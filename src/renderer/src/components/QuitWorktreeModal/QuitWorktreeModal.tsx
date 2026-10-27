import { useState } from 'react'
import { useSessionStore } from '../../stores/session-store'
import { QuitWorktreeModalView } from './View'

export function QuitWorktreeModal(): React.JSX.Element | null {
  const quitWorktrees = useSessionStore((s) => s.quitWorktrees)
  const setQuitWorktrees = useSessionStore((s) => s.setQuitWorktrees)
  const [removing, setRemoving] = useState(false)

  if (!quitWorktrees || quitWorktrees.length === 0) return null

  const handleKeepAll = (): void => {
    setQuitWorktrees(null)
    window.api.confirmQuit()
  }

  const handleRemoveAll = (): void => {
    // Main removes the folders AFTER the sessions, terminals and engines are torn down (no cwd
    // locks), then exits; the modal stays up with a notice until the window closes. It forgets
    // the worktree entries itself. `removing` is cleared only if the confirmation itself fails
    // (below): once main has it the app exits, and no further before-quit reaches this window.
    setRemoving(true)
    const paths = [...new Set(quitWorktrees.map(({ worktreeInfo }) => worktreeInfo.worktreePath))]
    window.api.confirmQuit(paths).catch((err: unknown) => {
      window.api.logError('QuitWorktreeModal', `Quit confirmation failed: ${err}`)
      setRemoving(false)
    })
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
