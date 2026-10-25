/**
 * Layer 2: Component tests for the WorktreesModal container (ADR-112).
 *
 * The View is mocked: these pin what the container asks of `window.api`, in what order and with how
 * much concurrency, and what it hands the View. The real View is covered by View.component.test.tsx.
 *
 * Tested flows:
 *   1. inventory first (cwd of the project group), then inspect -> measure per row, 2 rows at a time
 *   2. Select safe: no live holder, not locked, nothing uncommitted / unique, not touched recently
 *   3. a row held by a live session / locked / invalid / nesting others cannot be selected
 *   4. confirm lists the loss; the run sends IDS (not names) and shows per-row results, then re-inventories
 *   5. totals: "≥" while rows are pending; a stale scan never lands after a refresh
 *   6. Escape closes
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, act } from '@testing-library/react'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import type { WorktreesModalViewProps } from '../View'
import type {
  WorktreeInspection,
  WorktreeInventory,
  WorktreeInventoryEntry,
  WorktreeRemoveResult,
  WorktreeSize
} from '../../../../../shared/types'
import type { InvokeProgress } from '../../../../../shared/remote-protocol'

let viewProps: WorktreesModalViewProps
vi.mock('../View', () => ({
  WorktreesModalView: (props: WorktreesModalViewProps) => {
    viewProps = props
    return null
  }
}))

const CWD = '/d/repo'
const OLD = Date.now() - 24 * 3600_000

function entry(name: string, over: Partial<WorktreeInventoryEntry> = {}): WorktreeInventoryEntry {
  const id = `/d/repo/.claude/worktrees/${name}`
  return {
    id,
    name,
    path: id,
    location: 'managed',
    kind: 'worktree',
    branch: `feat/${name}`,
    head: 'abc',
    locked: false,
    contains: [],
    holders: [],
    ...over
  }
}

const idOf = (name: string): string => `/d/repo/.claude/worktrees/${name}`

const clean: WorktreeInspection = {
  uncommittedFiles: 0,
  uncommittedSample: [],
  ignoredEntries: 0,
  uniqueCommits: 0,
  uniqueCommitSample: []
}
const oldSize = (bytes: number): WorktreeSize => ({
  bytes,
  files: 1,
  links: 0,
  errors: 0,
  newestMtimeMs: OLD
})

const settle = (): Promise<void> =>
  act(async () => void (await new Promise((r) => setTimeout(r, 0))))

describe('WorktreesModal FC', () => {
  let app: TestApp
  let onClose: ReturnType<typeof vi.fn>
  let inventory: WorktreeInventory
  let inspect: ReturnType<typeof vi.fn>
  let measure: ReturnType<typeof vi.fn>
  let inventoryCall: ReturnType<typeof vi.fn>
  let removeMany: ReturnType<typeof vi.fn>
  let inspections: Record<string, WorktreeInspection>
  let sizes: Record<string, WorktreeSize>

  beforeEach(async () => {
    app = await bootTestApp()
    onClose = vi.fn()
    inventory = {
      repoRoot: CWD,
      managedRoot: `${CWD}/.claude/worktrees`,
      entries: [entry('alpha'), entry('beta'), entry('gamma')]
    }
    inspections = {}
    sizes = {}
    inventoryCall = vi.fn(async () => inventory)
    inspect = vi.fn(async (_cwd: string, id: string) => inspections[id] ?? clean)
    measure = vi.fn(async (_cwd: string, id: string) => sizes[id] ?? oldSize(1024))
    removeMany = vi.fn(async (_cwd: string, ids: string[]) =>
      ids.map((id): WorktreeRemoveResult => ({ id, outcome: 'removed' }))
    )
    Object.assign(window.api, {
      inventoryWorktrees: inventoryCall,
      inspectWorktree: inspect,
      measureWorktree: measure,
      removeWorktrees: removeMany
    })
  })

  afterEach(() => {
    app.teardown()
  })

  async function renderFC(): Promise<void> {
    const { WorktreesModal } = await import('../WorktreesModal')
    await act(async () => {
      render(React.createElement(WorktreesModal, { cwd: CWD, onClose: onClose as () => void }))
    })
    await settle()
  }

  const row = (name: string): WorktreesModalViewProps['rows'][number] =>
    viewProps.rows.find((r) => r.entry.name === name)!

  it('reads the inventory with the project cwd, then inspects and measures every row', async () => {
    await renderFC()
    await settle()

    expect(inventoryCall).toHaveBeenCalledWith(CWD)
    expect(viewProps.loading).toBe(false)
    expect(viewProps.rows.map((r) => r.entry.name)).toEqual(['alpha', 'beta', 'gamma'])
    expect(inspect.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      [CWD, idOf('alpha')],
      [CWD, idOf('beta')],
      [CWD, idOf('gamma')]
    ])
    expect(measure).toHaveBeenCalledTimes(3)
    expect(viewProps.scan).toBeNull()
    expect(viewProps.total).toEqual({ bytes: 3072, atLeast: false })
  })

  it('scans two rows at a time and measures a row only after it was inspected', async () => {
    const events: string[] = []
    const gates: Array<() => void> = []
    inspect.mockImplementation(async (_c: string, id: string) => {
      events.push(`inspect:${id.split('/').pop()}`)
      await new Promise<void>((r) => gates.push(r))
      return clean
    })
    measure.mockImplementation(async (_c: string, id: string) => {
      events.push(`measure:${id.split('/').pop()}`)
      return oldSize(10)
    })
    await renderFC()
    await settle()

    // two workers: alpha and beta started, gamma waits
    expect(events).toEqual(['inspect:alpha', 'inspect:beta'])
    expect(viewProps.scan).toEqual({ done: 0, total: 3 })
    expect(viewProps.total.atLeast).toBe(true)

    await act(async () => gates[0]())
    await settle()
    // alpha measured before the worker takes gamma
    expect(events.slice(0, 4)).toEqual([
      'inspect:alpha',
      'inspect:beta',
      'measure:alpha',
      'inspect:gamma'
    ])

    for (let i = 1; i < gates.length; i++) await act(async () => gates[i]())
    await settle()
    expect(viewProps.scan).toBeNull()
  })

  it('shows "…" for a row that is still pending and "?" for a failed query', async () => {
    measure.mockImplementation(async (_c: string, id: string) => {
      if (id === idOf('beta')) throw new Error('boom')
      return oldSize(5)
    })
    await renderFC()
    await settle()
    expect(row('beta').size).toBeNull()
    expect(row('alpha').size?.bytes).toBe(5)
    expect(viewProps.total.atLeast).toBe(true)
  })

  it('Select safe picks clean, idle, old rows only', async () => {
    inventory.entries = [
      entry('clean'),
      entry('dirty'),
      entry('unique'),
      entry('live', {
        holders: [{ kind: 'session', id: 's', label: 'Chat', live: true }]
      }),
      entry('cold', {
        holders: [{ kind: 'session', id: 'c', label: 'Old', live: false }]
      }),
      entry('locked', { locked: true }),
      entry('fresh'),
      entry('shell', { kind: 'orphan', branch: null }),
      entry('gone', { kind: 'missing', branch: null })
    ]
    inspections[idOf('dirty')] = { ...clean, uncommittedFiles: 2 }
    inspections[idOf('unique')] = { ...clean, uniqueCommits: 1 }
    sizes[idOf('fresh')] = { ...oldSize(1), newestMtimeMs: Date.now() - 60_000 }
    await renderFC()
    await settle()

    act(() => viewProps.onSelectSafe())

    expect(viewProps.rows.filter((r) => r.selected).map((r) => r.entry.name)).toEqual([
      'clean',
      'cold',
      'shell',
      'gone'
    ])
    expect(viewProps.selectedCount).toBe(4)
  })

  it('Select safe ignores rows whose scan has not finished', async () => {
    inspect.mockImplementation(() => new Promise(() => {}))
    await renderFC()
    await settle()
    act(() => viewProps.onSelectSafe())
    expect(viewProps.selectedCount).toBe(0)
  })

  it('cannot select a row held by a live session, a locked row or an invalid one', async () => {
    inventory.entries = [
      entry('live', { holders: [{ kind: 'terminal', id: 't', label: 'terminal', live: true }] }),
      entry('locked', { locked: true, lockReason: 'usb' }),
      entry('bad', { invalidReason: 'not verifiably a worktree of this repo' }),
      entry('ok')
    ]
    await renderFC()
    await settle()

    expect(row('live').disabledReason).toBe('in use by terminal')
    expect(row('locked').disabledReason).toBe('locked: usb')
    expect(row('bad').disabledReason).toBe('not verifiably a worktree of this repo')
    expect(row('ok').disabledReason).toBeNull()

    act(() => {
      viewProps.onToggle(idOf('live'))
      viewProps.onToggle(idOf('locked'))
      viewProps.onToggle(idOf('bad'))
      viewProps.onToggle(idOf('ok'))
    })
    expect(viewProps.rows.filter((r) => r.selected).map((r) => r.entry.name)).toEqual(['ok'])
  })

  it('an entry that contains another needs the inner one selected with it', async () => {
    inventory.entries = [
      entry('outer', { contains: [idOf('outer/inner')] }),
      entry('outer/inner', { name: 'inner' })
    ]
    await renderFC()
    await settle()

    expect(row('outer').disabledReason).toContain('contains inner')
    act(() => viewProps.onToggle(idOf('outer/inner')))
    expect(row('outer').disabledReason).toBeNull()
    act(() => viewProps.onToggle(idOf('outer')))
    expect(viewProps.selectedCount).toBe(2)
    // deselecting the inner row takes the outer one with it
    act(() => viewProps.onToggle(idOf('outer/inner')))
    expect(viewProps.selectedCount).toBe(0)
  })

  it('the confirm lists the loss of each selected row, with the ignored count', async () => {
    inspections[idOf('alpha')] = {
      ...clean,
      uncommittedFiles: 2,
      uncommittedSample: ['a.ts', 'b.ts'],
      uniqueCommits: 1,
      uniqueCommitSample: [{ sha: 'abcdef0123', subject: 'wip' }],
      ignoredEntries: 40
    }
    await renderFC()
    await settle()

    act(() => viewProps.onToggle(idOf('alpha')))
    act(() => viewProps.onRemoveSelected())

    expect(viewProps.phase).toBe('confirm')
    expect(viewProps.confirmItems).toHaveLength(1)
    const lines = viewProps.confirmItems[0].lines.join('\n')
    expect(lines).toContain('2 uncommitted files')
    expect(lines).toContain('branch feat/alpha: the branch is kept')
    expect(lines).toContain('40 ignored entries')

    act(() => viewProps.onCancelConfirm())
    expect(viewProps.phase).toBe('idle')
    expect(removeMany).not.toHaveBeenCalled()
  })

  it('removes by ID with progress, shows each row result, then re-inventories', async () => {
    let progressCb: ((p: InvokeProgress) => void) | undefined
    let finish!: (r: WorktreeRemoveResult[]) => void
    removeMany.mockImplementation(
      (_c: string, _ids: string[], cb?: (p: InvokeProgress) => void) => {
        progressCb = cb
        return new Promise<WorktreeRemoveResult[]>((r) => (finish = r))
      }
    )
    await renderFC()
    await settle()

    act(() => {
      viewProps.onToggle(idOf('alpha'))
      viewProps.onToggle(idOf('beta'))
    })
    act(() => viewProps.onRemoveSelected())
    await act(async () => {
      await viewProps.onConfirm()
    })

    expect(removeMany).toHaveBeenCalledTimes(1)
    expect(removeMany.mock.calls[0][0]).toBe(CWD)
    expect(removeMany.mock.calls[0][1]).toEqual([idOf('alpha'), idOf('beta')])
    expect(viewProps.phase).toBe('removing')

    act(() => progressCb!({ done: 1, total: 2, phase: 'beta: removing files' }))
    expect(viewProps.progress).toEqual({ done: 1, total: 2, phase: 'beta: removing files' })

    // the second inventory no longer lists alpha; beta stayed (partial)
    inventory = { ...inventory, entries: [entry('beta'), entry('gamma')] }
    await act(async () => {
      finish([
        {
          id: idOf('alpha'),
          outcome: 'removed',
          branch: { name: 'feat/alpha', action: 'kept', uniqueCommits: 2 }
        },
        {
          id: idOf('beta'),
          outcome: 'partial',
          failures: [{ path: 'C:/x', code: 'EBUSY' }]
        }
      ])
    })
    await settle()

    expect(inventoryCall).toHaveBeenCalledTimes(2)
    expect(viewProps.phase).toBe('idle')
    expect(viewProps.progress).toBeNull()
    const alpha = row('alpha')
    expect(alpha.gone).toBe(true)
    expect(alpha.result?.branch?.action).toBe('kept')
    expect(row('beta').gone).toBe(false)
    expect(row('beta').result?.outcome).toBe('partial')
    expect(row('gamma').result).toBeNull()
    expect(viewProps.selectedCount).toBe(0)
  })

  it('a rejected run marks every row failed and keeps the rows', async () => {
    removeMany.mockRejectedValue(new Error('git exploded'))
    await renderFC()
    await settle()
    act(() => viewProps.onToggle(idOf('alpha')))
    act(() => viewProps.onRemoveSelected())
    await act(async () => {
      await viewProps.onConfirm()
    })
    await settle()

    expect(row('alpha').result).toMatchObject({ outcome: 'failed', reason: 'git exploded' })
    expect(viewProps.phase).toBe('idle')
  })

  it('Refresh re-reads the inventory and clears the last results', async () => {
    await renderFC()
    await settle()
    act(() => viewProps.onToggle(idOf('alpha')))
    act(() => viewProps.onRemoveSelected())
    await act(async () => {
      await viewProps.onConfirm()
    })
    await settle()
    expect(row('alpha').result).not.toBeNull()

    await act(async () => viewProps.onRefresh())
    await settle()
    expect(row('alpha').result).toBeNull()
    expect(inventoryCall).toHaveBeenCalledTimes(3)
  })

  it('an inventory failure is shown, not an empty list', async () => {
    inventoryCall.mockRejectedValue(new Error('not a git repository'))
    await renderFC()
    expect(viewProps.error).toBe('not a git repository')
    expect(viewProps.loading).toBe(false)
    expect(viewProps.rows).toEqual([])
  })

  it('answers of a scan that a refresh superseded are dropped', async () => {
    const stale: Array<() => void> = []
    inspect.mockImplementationOnce(async () => {
      await new Promise<void>((r) => stale.push(r))
      return { ...clean, uncommittedFiles: 99 }
    })
    await renderFC()
    await settle()

    await act(async () => viewProps.onRefresh())
    await settle()
    await act(async () => stale[0]())
    await settle()

    expect(row('alpha').inspection?.uncommittedFiles).toBe(0)
  })

  it('a missing entry is inspected (its branch can hold commits) but never measured (R1)', async () => {
    inventory.entries = [entry('gone', { kind: 'missing', branch: null, head: 'deadbeef' })]
    await renderFC()
    await settle()

    expect(inspect).toHaveBeenCalledWith(CWD, idOf('gone'))
    expect(measure).not.toHaveBeenCalled()
    expect(row('gone').inspection).toEqual(clean)
    // the scan counts it and finishes without a size
    expect(viewProps.scan).toBeNull()
    expect(viewProps.total).toEqual({ bytes: 0, atLeast: false })
  })

  it('Select safe skips a missing entry that holds commits, and one not yet inspected (R1)', async () => {
    inventory.entries = [
      entry('gone-clean', { kind: 'missing' }),
      entry('gone-commits', { kind: 'missing', branch: null }),
      entry('gone-unchecked', { kind: 'missing' })
    ]
    inspections[idOf('gone-commits')] = { ...clean, uniqueCommits: 2 }
    inspect.mockImplementation((_c: string, id: string) =>
      id === idOf('gone-unchecked')
        ? new Promise(() => {})
        : Promise.resolve(inspections[id] ?? clean)
    )
    await renderFC()
    await settle()

    act(() => viewProps.onSelectSafe())
    expect(viewProps.rows.filter((r) => r.selected).map((r) => r.entry.name)).toEqual([
      'gone-clean'
    ])
  })

  it('the confirm for a missing detached entry says its commits will be lost (R1)', async () => {
    inventory.entries = [entry('gone', { kind: 'missing', branch: null })]
    inspections[idOf('gone')] = {
      ...clean,
      uniqueCommits: 3,
      uniqueCommitSample: [{ sha: 'abcdef0123', subject: 'wip' }]
    }
    await renderFC()
    await settle()
    act(() => viewProps.onToggle(idOf('gone')))
    act(() => viewProps.onRemoveSelected())
    expect(viewProps.confirmItems[0].lines.join(' ')).toContain(
      '3 commits on a detached HEAD will be lost'
    )
  })

  it('Escape does nothing while a run is in flight, and works again after it (S1)', async () => {
    let finish!: (r: WorktreeRemoveResult[]) => void
    removeMany.mockImplementation(() => new Promise<WorktreeRemoveResult[]>((r) => (finish = r)))
    await renderFC()
    await settle()
    act(() => viewProps.onToggle(idOf('alpha')))
    act(() => viewProps.onRemoveSelected())
    await act(async () => {
      await viewProps.onConfirm()
    })
    expect(viewProps.phase).toBe('removing')

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(onClose).not.toHaveBeenCalled()

    await act(async () => finish([{ id: idOf('alpha'), outcome: 'removed' }]))
    await settle()
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('the lazy scan stops when a run starts: no new inspection, no late answer (S2)', async () => {
    const gates: Array<() => void> = []
    inspect.mockImplementation(async () => {
      await new Promise<void>((r) => gates.push(r))
      return { ...clean, uncommittedFiles: 7 }
    })
    let finish!: (r: WorktreeRemoveResult[]) => void
    removeMany.mockImplementation(() => new Promise<WorktreeRemoveResult[]>((r) => (finish = r)))
    await renderFC()
    await settle()
    // two workers hold alpha and beta; gamma has not started
    expect(inspect).toHaveBeenCalledTimes(2)

    act(() => viewProps.onToggle(idOf('gamma')))
    act(() => viewProps.onRemoveSelected())
    await act(async () => {
      await viewProps.onConfirm()
    })
    expect(viewProps.scan).toBeNull()

    await act(async () => gates.forEach((g) => g()))
    await settle()
    expect(inspect).toHaveBeenCalledTimes(2)
    expect(row('alpha').inspection).toBeUndefined()

    await act(async () => finish([{ id: idOf('gamma'), outcome: 'removed' }]))
    await settle()
  })

  it('stays busy until the re-inventory lands (N4)', async () => {
    await renderFC()
    await settle()
    act(() => viewProps.onToggle(idOf('alpha')))
    act(() => viewProps.onRemoveSelected())

    let release!: (inv: WorktreeInventory) => void
    inventoryCall.mockImplementationOnce(() => new Promise<WorktreeInventory>((r) => (release = r)))
    await act(async () => {
      await viewProps.onConfirm()
    })
    await settle()

    // the run is done, the fresh list is not: still busy, results shown
    expect(viewProps.phase).toBe('removing')
    expect(viewProps.progress?.phase).toBe('refreshing')
    expect(row('alpha').result?.outcome).toBe('removed')

    await act(async () => release({ ...inventory, entries: [entry('beta'), entry('gamma')] }))
    await settle()
    expect(viewProps.phase).toBe('idle')
    expect(viewProps.progress).toBeNull()
    expect(row('alpha').gone).toBe(true)
  })

  it('a failed re-inventory keeps the results and the last list, minus what was removed (N4)', async () => {
    await renderFC()
    await settle()
    act(() => viewProps.onToggle(idOf('alpha')))
    act(() => viewProps.onToggle(idOf('beta')))
    act(() => viewProps.onRemoveSelected())
    removeMany.mockImplementation(async (_c: string, ids: string[]) =>
      ids.map((id): WorktreeRemoveResult =>
        id === idOf('alpha')
          ? { id, outcome: 'removed' }
          : { id, outcome: 'partial', failures: [{ path: 'C:/x', code: 'EBUSY' }] }
      )
    )
    inventoryCall.mockRejectedValueOnce(new Error('git timed out'))
    await act(async () => {
      await viewProps.onConfirm()
    })
    await settle()

    expect(viewProps.error).toBeNull()
    expect(viewProps.staleError).toBe('git timed out')
    expect(viewProps.phase).toBe('idle')
    expect(row('alpha')).toMatchObject({ gone: true, result: { outcome: 'removed' } })
    expect(row('beta')).toMatchObject({ gone: false, result: { outcome: 'partial' } })
    expect(row('gamma').gone).toBe(false)
    // the surviving rows are scanned again
    expect(row('gamma').inspection).toEqual(clean)
  })

  it('the "modified N min ago" label ages while the manager stays open (N5)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    try {
      inventory.entries = [entry('alpha')]
      sizes[idOf('alpha')] = { ...oldSize(1), newestMtimeMs: Date.now() - 60_000 }
      await renderFC()
      await settle()
      expect(row('alpha').recentMinutes).toBe(1)

      await act(async () => {
        vi.advanceTimersByTime(11 * 60_000)
      })
      expect(row('alpha').recentMinutes).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('Escape closes the modal', async () => {
    await renderFC()
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(onClose).toHaveBeenCalled()
  })
})
