import { useState, useEffect, useCallback } from 'react'
import type { WorktreeEntry, WorktreeStatus } from '../../../../shared/types'
import { WorktreesModalView } from './View'

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
      for (const entry of list) {
        if (entry.exists) {
          window.api
            .getWorktreeStatus(entry.path, '')
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

  useEffect(() => {
    loadEntries()
  }, [loadEntries])

  const handleRemove = useCallback(
    async (entry: WorktreeEntry): Promise<void> => {
      setRemovingSet((prev) => new Set(prev).add(entry.name))
      try {
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
    },
    [cwd]
  )

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <WorktreesModalView
      entries={entries}
      statuses={statuses}
      loading={loading}
      removingSet={removingSet}
      onRemove={handleRemove}
      onClose={onClose}
    />
  )
}
