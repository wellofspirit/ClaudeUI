import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import type {
  WorktreeInspection,
  WorktreeInventory,
  WorktreeInventoryEntry,
  WorktreeRemoveResult,
  WorktreeSize
} from '../../../../shared/types'
import type { InvokeProgress } from '../../../../shared/remote-protocol'
import {
  confirmItem,
  disabledReason,
  effectiveSelection,
  isInspectable,
  isMeasurable,
  isSafe,
  recentMinutes,
  totalSize,
  type Loaded
} from '../../lib/worktree-view'
import { WorktreesModalView, type WorktreeRowModel } from './View'

/** How often the "modified N min ago" labels re-evaluate. */
const NOW_TICK_MS = 30_000

/** Inspect + measure run for this many rows at a time: the walks are disk-bound. */
const SCAN_CONCURRENCY = 2

type Phase = 'idle' | 'confirm' | 'removing'

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function WorktreesModal({
  cwd,
  onClose
}: {
  cwd: string
  onClose: () => void
}): React.JSX.Element {
  const [inventory, setInventory] = useState<WorktreeInventory | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [inspections, setInspections] = useState<Record<string, Loaded<WorktreeInspection>>>({})
  const [sizes, setSizes] = useState<Record<string, Loaded<WorktreeSize>>>({})
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [phase, setPhase] = useState<Phase>('idle')
  const [progress, setProgress] = useState<InvokeProgress | null>(null)
  const [results, setResults] = useState<Record<string, WorktreeRemoveResult>>({})
  /** Entries of the last run that the fresh inventory no longer lists: shown with their result. */
  const [ghosts, setGhosts] = useState<WorktreeInventoryEntry[]>([])
  /** The re-inventory after a run failed: the list is the last known one, not a fresh read. */
  const [staleError, setStaleError] = useState<string | null>(null)
  // The recency labels age while the manager stays open.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), NOW_TICK_MS)
    return () => clearInterval(t)
  }, [])

  // A load/scan generation: a refresh (or unmount) makes the older scan's answers stale.
  const generation = useRef(0)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const scan = useCallback(
    (entries: WorktreeInventoryEntry[], gen: number): void => {
      // Every valid entry is inspected (a missing one's branch can hold commits); only a present one
      // has a size. An invalid entry is never walked (N4): the server refuses it anyway.
      const queue = entries.filter(isInspectable).map((e) => e.id)
      const measurable = new Set(entries.filter(isMeasurable).map((e) => e.id))
      let next = 0
      const live = (): boolean => mounted.current && generation.current === gen
      const worker = async (): Promise<void> => {
        for (;;) {
          const id = queue[next++]
          if (id === undefined || !live()) return
          try {
            const inspection = await window.api.inspectWorktree(cwd, id)
            if (!live()) return
            setInspections((prev) => ({ ...prev, [id]: inspection }))
          } catch {
            if (!live()) return
            setInspections((prev) => ({ ...prev, [id]: null }))
          }
          if (!measurable.has(id)) continue
          try {
            const size = await window.api.measureWorktree(cwd, id)
            if (!live()) return
            setSizes((prev) => ({ ...prev, [id]: size }))
          } catch {
            if (!live()) return
            setSizes((prev) => ({ ...prev, [id]: null }))
          }
        }
      }
      for (let i = 0; i < SCAN_CONCURRENCY; i++) void worker()
    },
    [cwd]
  )

  /**
   * Read the inventory and start the lazy scan. `keepResults`: the re-inventory after a run, which
   * keeps the list and the results on screen; if it fails, `fallback` (the last known list minus
   * what the run removed) stays instead of an error page that would hide the results.
   */
  const load = useCallback(
    async (keepResults: boolean, fallback?: WorktreeInventory | null): Promise<void> => {
      const gen = ++generation.current
      if (!keepResults) setLoading(true)
      setError(null)
      setStaleError(null)
      setInspections({})
      setSizes({})
      setSelected(new Set())
      if (!keepResults) {
        setResults({})
        setGhosts([])
      }
      try {
        const inv = await window.api.inventoryWorktrees(cwd)
        if (!mounted.current || generation.current !== gen) return
        setInventory(inv)
        setLoading(false)
        scan(inv.entries, gen)
      } catch (err) {
        if (!mounted.current || generation.current !== gen) return
        if (keepResults && fallback) {
          setInventory(fallback)
          setStaleError(messageOf(err))
          setLoading(false)
          scan(fallback.entries, gen)
          return
        }
        setInventory(null)
        setError(messageOf(err))
        setLoading(false)
      }
    },
    [cwd, scan]
  )

  useEffect(() => {
    void load(false)
  }, [load])

  const byId = useMemo(
    () => new Map((inventory?.entries ?? []).map((e) => [e.id, e] as const)),
    [inventory]
  )
  const selection = useMemo(() => effectiveSelection(selected, byId), [selected, byId])

  const rows = useMemo<WorktreeRowModel[]>(() => {
    const listed = (inventory?.entries ?? []).map((entry) => ({
      entry,
      inspection: inspections[entry.id] as Loaded<WorktreeInspection>,
      size: sizes[entry.id] as Loaded<WorktreeSize>,
      selected: selection.has(entry.id),
      disabledReason: disabledReason(entry, byId, selection),
      recentMinutes: recentMinutes(sizes[entry.id], now),
      result: results[entry.id] ?? null,
      gone: false
    }))
    const gone = ghosts
      .filter((g) => !byId.has(g.id))
      .map((entry) => ({
        entry,
        inspection: undefined,
        size: undefined,
        selected: false,
        disabledReason: null,
        recentMinutes: null,
        result: results[entry.id] ?? null,
        gone: true
      }))
    return [...gone, ...listed]
  }, [inventory, inspections, sizes, selection, byId, results, ghosts, now])

  const entries = useMemo(() => inventory?.entries ?? [], [inventory])
  const total = useMemo(() => totalSize(entries, sizes), [entries, sizes])
  const selectedEntries = useMemo(
    () => entries.filter((e) => selection.has(e.id)),
    [entries, selection]
  )
  const selectedSize = useMemo(() => totalSize(selectedEntries, sizes), [selectedEntries, sizes])
  const scannable = entries.filter(isInspectable)
  const scanTotal = scannable.length
  const scanDone = scannable.filter(
    (e) => inspections[e.id] !== undefined && (!isMeasurable(e) || sizes[e.id] !== undefined)
  ).length

  const handleToggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const handleSelectSafe = useCallback(() => {
    const at = Date.now()
    setSelected(
      new Set(entries.filter((e) => isSafe(e, inspections[e.id], sizes[e.id], at)).map((e) => e.id))
    )
  }, [entries, inspections, sizes])

  const confirmItems = useMemo(() => {
    if (phase !== 'confirm') return []
    const at = Date.now()
    return selectedEntries.map((e) => confirmItem(e, inspections[e.id], sizes[e.id], at))
  }, [phase, selectedEntries, inspections, sizes])

  const run = useCallback(async (): Promise<void> => {
    const chosen = selectedEntries
    const ids = chosen.map((e) => e.id)
    if (ids.length === 0) {
      setPhase('idle')
      return
    }
    // The lazy scan stops: a `git status` inside a folder being deleted fails (EBUSY) and spoils it.
    generation.current++
    setPhase('removing')
    setProgress({ done: 0, total: ids.length, phase: '' })
    let list: WorktreeRemoveResult[]
    try {
      list = await window.api.removeWorktrees(cwd, ids, (p) => {
        if (mounted.current) setProgress(p)
      })
    } catch (err) {
      window.api.logError('WorktreesModal', `Failed to remove worktrees: ${messageOf(err)}`)
      list = ids.map((id) => ({ id, outcome: 'failed' as const, reason: messageOf(err) }))
    }
    if (!mounted.current) return
    setResults(Object.fromEntries(list.map((r) => [r.id, r])))
    setGhosts(chosen)
    // Stay busy until the fresh inventory lands: the list on screen is the pre-run one.
    setProgress({ done: ids.length, total: ids.length, phase: 'refreshing' })
    const removed = new Set(list.filter((r) => r.outcome === 'removed').map((r) => r.id))
    await load(
      true,
      inventory
        ? { ...inventory, entries: inventory.entries.filter((e) => !removed.has(e.id)) }
        : null
    )
    if (!mounted.current) return
    setProgress(null)
    setPhase('idle')
  }, [cwd, selectedEntries, load, inventory])

  const handleConfirm = useCallback(async (): Promise<void> => {
    // The confirm closes as the run starts; progress and results live in the manager itself.
    void run()
  }, [run])

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      // Closing mid-removal would orphan the progress and the results of a run that goes on.
      if (e.key === 'Escape' && phase !== 'removing') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose, phase])

  return (
    <WorktreesModalView
      repoRoot={inventory ? inventory.repoRoot : null}
      loading={loading}
      error={error}
      rows={rows}
      total={total}
      scan={
        phase !== 'removing' && scanDone < scanTotal ? { done: scanDone, total: scanTotal } : null
      }
      staleError={staleError}
      selectedCount={selection.size}
      selectedSize={selectedSize}
      phase={phase}
      progress={progress}
      confirmItems={confirmItems}
      onToggle={handleToggle}
      onSelectSafe={handleSelectSafe}
      onRemoveSelected={() => setPhase('confirm')}
      onConfirm={handleConfirm}
      onCancelConfirm={() => setPhase('idle')}
      onRefresh={() => void load(false)}
      onClose={onClose}
    />
  )
}
