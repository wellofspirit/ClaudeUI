import { useState, useEffect } from 'react'
import type { WorktreeInfo, WorktreeRemoveResult, WorktreeStatus } from '../../../../shared/types'
import { describeResult } from '../../lib/worktree-view'
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
  /** A refused or partial removal (or a failure to ask): the modal stays so the user can decide. */
  const [outcome, setOutcome] = useState<{
    tone: 'warn' | 'error'
    text: string
    paths: string[]
  } | null>(null)

  useEffect(() => {
    window.api
      .getWorktreeStatus(worktreeInfo.worktreePath, worktreeInfo.originalHeadCommit)
      .then(setStatus)
      .catch(() => setStatus(null))
  }, [worktreeInfo])

  const handleRemove = async (): Promise<void> => {
    setRemoving(true)
    setOutcome(null)
    let result: WorktreeRemoveResult
    try {
      result = await window.api.removeWorktree(
        worktreeInfo.worktreePath,
        worktreeInfo.worktreeBranch,
        worktreeInfo.gitRoot
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      window.api.logError('WorktreeCleanup', `Failed to remove worktree: ${message}`)
      setOutcome({ tone: 'error', text: `Could not remove the worktree: ${message}`, paths: [] })
      setRemoving(false)
      return
    }
    if (result.outcome === 'removed') {
      onRemove()
      return
    }
    const view = describeResult(result)
    setOutcome({
      tone: view.tone === 'error' ? 'error' : 'warn',
      text: view.text,
      paths: view.paths
    })
    setRemoving(false)
  }

  return (
    <WorktreeCleanupModalView
      worktreeInfo={worktreeInfo}
      status={status}
      removing={removing}
      outcome={outcome}
      onKeep={onKeep}
      onRemove={handleRemove}
      onCancel={onCancel}
    />
  )
}
