/**
 * The worktree manager through its REAL View (ADR-112, ADR-027 test ids): loading, the rows with
 * their badges, size, status and holder chips, disabled rows with the reason, the toolbar, the shared
 * confirm, the progress line and the per-row results. The container (scan order, selection rules,
 * the run) is covered by WorktreesModal.component.test.ts with this View mocked.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { WorktreesModalViewProps, WorktreeRowModel } from '../View'
import { WorktreesModalView } from '../View'
import type {
  WorktreeInspection,
  WorktreeInventoryEntry,
  WorktreeSize
} from '../../../../../shared/types'

const t = (id: string): HTMLElement => screen.getByTestId(`WorktreesModal.${id}`)
const q = (id: string): HTMLElement | null => screen.queryByTestId(`WorktreesModal.${id}`)

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

const insp = (over: Partial<WorktreeInspection> = {}): WorktreeInspection => ({
  uncommittedFiles: 0,
  uncommittedSample: [],
  ignoredEntries: 0,
  uniqueCommits: 0,
  uniqueCommitSample: [],
  ...over
})
const sz = (bytes: number, over: Partial<WorktreeSize> = {}): WorktreeSize => ({
  bytes,
  files: 1,
  links: 0,
  errors: 0,
  newestMtimeMs: 1,
  ...over
})

function row(e: WorktreeInventoryEntry, over: Partial<WorktreeRowModel> = {}): WorktreeRowModel {
  return {
    entry: e,
    inspection: insp(),
    size: sz(2048),
    selected: false,
    disabledReason: null,
    recentMinutes: null,
    result: null,
    gone: false,
    ...over
  }
}

function props(over: Partial<WorktreesModalViewProps> = {}): WorktreesModalViewProps {
  return {
    repoRoot: '/d/repo',
    loading: false,
    error: null,
    rows: [],
    total: { bytes: 0, atLeast: false },
    scan: null,
    staleError: null,
    selectedCount: 0,
    selectedSize: { bytes: 0, atLeast: false },
    phase: 'idle',
    progress: null,
    confirmItems: [],
    onToggle: vi.fn(),
    onSelectSafe: vi.fn(),
    onRemoveSelected: vi.fn(),
    onConfirm: vi.fn(async () => {}),
    onCancelConfirm: vi.fn(),
    onRefresh: vi.fn(),
    onClose: vi.fn(),
    ...over
  }
}

function view(over: Partial<WorktreesModalViewProps> = {}): WorktreesModalViewProps {
  const p = props(over)
  render(<WorktreesModalView {...p} />)
  return p
}

afterEach(cleanup)

describe('WorktreesModalView', () => {
  it('loading, error and empty are distinct states', () => {
    view({ loading: true })
    expect(t('loading')).toBeTruthy()
    expect(q('totalSize')).toBeNull()
    cleanup()
    view({ error: 'not a git repository' })
    expect(t('error').textContent).toContain('not a git repository')
    cleanup()
    view({ rows: [] })
    expect(t('empty')).toBeTruthy()
  })

  it('header: repo root, total size with a lower-bound sign while pending, Refresh, close', () => {
    const p = view({
      rows: [row(entry('a'))],
      total: { bytes: 3 * 1024 ** 3, atLeast: true }
    })
    expect(t('repoRoot').textContent).toBe('/d/repo')
    expect(t('totalSize').textContent).toBe('≥ 3.0 GB')
    fireEvent.click(t('refresh'))
    expect(p.onRefresh).toHaveBeenCalled()
    fireEvent.click(t('close'))
    expect(p.onClose).toHaveBeenCalled()
  })

  it('a row shows name, branch, size and status; the checkbox toggles by id', () => {
    const e = entry('alpha')
    const p = view({
      rows: [row(e, { inspection: insp({ uncommittedFiles: 2, uniqueCommits: 1 }) })]
    })
    const r = t('worktreeRow')
    expect(r.getAttribute('data-id')).toBe(e.id)
    expect(within(r).getByTestId('WorktreesModal.name').textContent).toBe('alpha')
    expect(within(r).getByTestId('WorktreesModal.branch').textContent).toBe('feat/alpha')
    expect(within(r).getByTestId('WorktreesModal.size').textContent).toBe('2 KB')
    expect(within(r).getByTestId('WorktreesModal.status').textContent).toBe(
      '2 uncommitted · 1 commit only here'
    )
    fireEvent.click(within(r).getByTestId('WorktreesModal.select'))
    expect(p.onToggle).toHaveBeenCalledWith(e.id)
  })

  it('pending size reads "…", a detached row says so, a missing row has no size', () => {
    view({
      rows: [
        row(entry('p'), { size: undefined, inspection: undefined }),
        row(entry('d', { branch: null })),
        row(entry('m', { kind: 'missing', branch: null }), {
          size: undefined,
          inspection: undefined
        }),
        row(entry('o', { kind: 'orphan', branch: null }))
      ]
    })
    const rows = screen.getAllByTestId('WorktreesModal.worktreeRow')
    expect(within(rows[0]).getByTestId('WorktreesModal.size').textContent).toBe('…')
    expect(within(rows[0]).getByTestId('WorktreesModal.status').textContent).toBe('checking…')
    expect(within(rows[1]).getByTestId('WorktreesModal.branch').textContent).toBe('detached')
    expect(within(rows[2]).getByTestId('WorktreesModal.size').textContent).toBe('—')
    // An orphan is not a worktree: no branch/"detached" label.
    expect(within(rows[3]).queryByTestId('WorktreesModal.branch')).toBeNull()
  })

  it('kind badges', () => {
    view({
      rows: [
        row(entry('o', { kind: 'orphan', branch: null })),
        row(entry('l', { locked: true, lockReason: 'usb' }), {
          disabledReason: 'locked: usb'
        }),
        row(entry('bad', { invalidReason: 'not verifiably a worktree of this repo' }), {
          disabledReason: 'not verifiably a worktree of this repo'
        })
      ]
    })
    const rows = screen.getAllByTestId('WorktreesModal.worktreeRow')
    const kinds = (r: HTMLElement): string[] =>
      within(r)
        .queryAllByTestId('WorktreesModal.kindBadge')
        .map((b) => b.getAttribute('data-kind')!)
    expect(kinds(rows[0])).toEqual(['orphan'])
    expect(kinds(rows[1])).toEqual(['locked'])
    expect(kinds(rows[2])).toEqual(['invalid'])
  })

  it('a live-held row: checkbox disabled, live chip in the warning colour, reason shown; a cold chip is muted', () => {
    const live = entry('held', {
      holders: [
        { kind: 'session', id: 's', label: 'Fix bug', live: true },
        { kind: 'session', id: 'c', label: 'Old chat', live: false }
      ]
    })
    view({ rows: [row(live, { disabledReason: 'in use by Fix bug' })] })
    expect((t('select') as HTMLInputElement).disabled).toBe(true)
    const chips = screen.getAllByTestId('WorktreesModal.holder')
    expect(chips.map((c) => [c.textContent, c.getAttribute('data-live')])).toEqual([
      ['live session: Fix bug', 'true'],
      ['session: Old chat', 'false']
    ])
    expect(chips[0].className).toContain('text-warning')
    expect(chips[1].className).not.toContain('text-warning')
    expect(t('disabledReason').textContent).toContain('in use by Fix bug')
  })

  it('the checkbox is described by its reason; a chip carries its full text as a tooltip (N9)', () => {
    const held = entry('held', {
      holders: [{ kind: 'session', id: 's', label: 'A very long chat title', live: true }]
    })
    view({ rows: [row(held, { disabledReason: 'in use by A very long chat title' })] })
    const box = t('select')
    const reason = t('disabledReason')
    expect(reason.id).not.toBe('')
    expect(box.getAttribute('aria-describedby')).toBe(reason.id)
    expect(screen.getByTestId('WorktreesModal.holder').getAttribute('title')).toBe(
      'live session: A very long chat title'
    )
  })

  it('a selectable row has no aria-describedby', () => {
    view({ rows: [row(entry('a'))] })
    expect(t('select').hasAttribute('aria-describedby')).toBe(false)
  })

  it('closing is inert while a run is in flight: Close disabled, backdrop click ignored (S1)', () => {
    const p = view({ rows: [row(entry('a'))], phase: 'removing' })
    expect((t('close') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(t('close'))
    fireEvent.click(t('close').closest('[data-testid="WorktreesModal"]')!.firstElementChild!)
    expect(p.onClose).not.toHaveBeenCalled()
  })

  it('the backdrop closes when idle', () => {
    const p = view({ rows: [row(entry('a'))] })
    fireEvent.click(t('close').closest('[data-testid="WorktreesModal"]')!.firstElementChild!)
    expect(p.onClose).toHaveBeenCalledTimes(1)
  })

  it('a failed re-read after a run says the list is the last known one (N4)', () => {
    view({ rows: [row(entry('a'))], staleError: 'git timed out' })
    expect(t('staleError').textContent).toContain('git timed out')
    expect(t('staleError').textContent).toContain('last known list')
    expect(q('error')).toBeNull()
  })

  it('an invalid row says why it cannot be removed', () => {
    view({
      rows: [
        row(entry('bad', { invalidReason: 'not verifiably a worktree of this repo' }), {
          disabledReason: 'not verifiably a worktree of this repo'
        })
      ]
    })
    expect((t('select') as HTMLInputElement).disabled).toBe(true)
    expect(t('disabledReason').textContent).toContain('not verifiably a worktree of this repo')
  })

  it('a recently modified row is flagged', () => {
    view({ rows: [row(entry('hot'), { recentMinutes: 3 })] })
    expect(t('recent').textContent).toContain('modified 3 min ago')
  })

  it('toolbar: Select safe, Remove N (size), scan status', () => {
    const p = view({
      rows: [row(entry('a'), { selected: true })],
      selectedCount: 1,
      selectedSize: { bytes: 2048, atLeast: true },
      scan: { done: 1, total: 4 }
    })
    expect(t('removeSelected').textContent).toBe('Remove 1 (≥ 2 KB)')
    expect(t('scan').textContent).toContain('1/4')
    fireEvent.click(t('selectSafe'))
    expect(p.onSelectSafe).toHaveBeenCalled()
    fireEvent.click(t('removeSelected'))
    expect(p.onRemoveSelected).toHaveBeenCalled()
  })

  it('Remove is disabled with nothing selected and while a run is in flight', () => {
    view({ rows: [row(entry('a'))], selectedCount: 0 })
    expect((t('removeSelected') as HTMLButtonElement).disabled).toBe(true)
    cleanup()
    view({
      rows: [row(entry('a'), { selected: true })],
      selectedCount: 1,
      phase: 'removing',
      progress: { done: 0, total: 1, phase: 'a: removing files' }
    })
    expect((t('removeSelected') as HTMLButtonElement).disabled).toBe(true)
    expect((t('selectSafe') as HTMLButtonElement).disabled).toBe(true)
    expect((t('select') as HTMLInputElement).disabled).toBe(true)
  })

  it('the confirm is the shared ConfirmModal and lists every selected row', () => {
    const p = view({
      rows: [row(entry('a'), { selected: true })],
      selectedCount: 1,
      phase: 'confirm',
      confirmItems: [
        {
          id: '/d/repo/.claude/worktrees/a',
          name: 'a',
          lines: [
            '2 uncommitted files will be lost (not recoverable).',
            '1 commit exists only on branch feat/a: the branch is kept.'
          ],
          samples: ['x.ts', 'abcdef0 wip'],
          clean: false
        },
        { id: '/d/repo/.claude/worktrees/b', name: 'b', lines: [], samples: [], clean: true }
      ]
    })
    const confirm = t('confirm')
    const items = within(confirm).getAllByTestId('WorktreesModal.confirm.item')
    expect(items).toHaveLength(2)
    expect(items[0].textContent).toContain('2 uncommitted files will be lost')
    expect(items[0].textContent).toContain('the branch is kept')
    expect(items[0].textContent).toContain('abcdef0 wip')
    expect(items[1].textContent).toContain('Nothing uncommitted')
    fireEvent.click(screen.getByTestId('WorktreesModal.confirm.cancel'))
    expect(p.onCancelConfirm).toHaveBeenCalled()
    expect(p.onConfirm).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('WorktreesModal.confirm.confirm'))
    expect(p.onConfirm).toHaveBeenCalled()
  })

  it('no confirm outside the confirm phase', () => {
    view({ rows: [row(entry('a'))] })
    expect(q('confirm')).toBeNull()
  })

  it('progress line while removing', () => {
    view({
      rows: [row(entry('a'))],
      phase: 'removing',
      progress: { done: 1, total: 3, phase: 'b: 120 entries removed' }
    })
    expect(t('progress').textContent).toBe('Removing 2 of 3 — b: 120 entries removed')
  })

  it.each([
    [
      'removed, branch kept',
      {
        id: 'x',
        outcome: 'removed' as const,
        branch: { name: 'feat/a', action: 'kept' as const, uniqueCommits: 2 }
      },
      'removed',
      'kept',
      'Removed. Branch feat/a kept (2 commits only there).'
    ],
    [
      'refused',
      { id: 'x', outcome: 'refused' as const, reason: 'in-use: Fix bug' },
      'refused',
      null,
      'Refused: in use by Fix bug.'
    ],
    [
      'partial',
      { id: 'x', outcome: 'partial' as const, failures: [{ path: 'C:/wt/a.bin', code: 'EBUSY' }] },
      'partial',
      null,
      '1 path could not be deleted. Close programs using it and retry.'
    ],
    [
      'files gone, still registered',
      {
        id: 'x',
        outcome: 'partial' as const,
        failures: [{ path: 'C:/wt', code: 'GIT_UNREGISTER' }]
      },
      'partial',
      null,
      'Files are gone but git still lists the worktree. Refresh and retry.'
    ]
  ])('result of a run: %s', (_name, result, outcome, branchAction, text) => {
    view({ rows: [row(entry('a'), { result })] })
    const el = t('result')
    expect(el.getAttribute('data-outcome')).toBe(outcome)
    expect(el.getAttribute('data-branch-action')).toBe(branchAction)
    expect(el.textContent).toContain(text)
  })

  it('a partial result lists the first paths; a removed row stays as a record without a checkbox', () => {
    view({
      rows: [
        row(entry('gone'), {
          gone: true,
          result: { id: 'x', outcome: 'removed' }
        }),
        row(entry('stuck'), {
          result: {
            id: 'y',
            outcome: 'partial',
            failures: [{ path: 'C:/wt/stuck/a.bin', code: 'EBUSY' }]
          }
        })
      ]
    })
    const rows = screen.getAllByTestId('WorktreesModal.worktreeRow')
    expect(rows[0].getAttribute('data-gone')).toBe('true')
    expect(within(rows[0]).queryByTestId('WorktreesModal.select')).toBeNull()
    expect(within(rows[1]).getByTestId('WorktreesModal.result').textContent).toContain(
      'C:/wt/stuck/a.bin (EBUSY)'
    )
  })

  it('is a full-width sheet on phones', () => {
    view({ rows: [row(entry('a'))] })
    const sheet = t('close').closest('.relative') as HTMLElement
    expect(sheet.className).toContain('max-md:w-full')
    expect(sheet.className).toContain('max-w-full')
    expect(t('worktreeRow').parentElement?.parentElement?.className).toContain('overflow-y-auto')
  })
})
