import { useState, useEffect } from 'react'
import type { WorktreeInfo, WorktreeStatus } from '../../../../shared/types'
import { WorktreeCleanupModalView } from './View'

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
      onRemove()
    }
  }

  return (
    <WorktreeCleanupModalView
      worktreeInfo={worktreeInfo}
      status={status}
      removing={removing}
      onKeep={onKeep}
      onRemove={handleRemove}
      onCancel={onCancel}
    />
  )
}
