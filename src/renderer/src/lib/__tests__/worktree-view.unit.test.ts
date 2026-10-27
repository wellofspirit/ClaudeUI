import { describe, expect, it } from 'vitest'
import type {
  WorktreeHolder,
  WorktreeInspection,
  WorktreeInventoryEntry,
  WorktreeSize
} from '../../../../shared/types'
import {
  RECENT_MODIFICATION_MS,
  blockReason,
  confirmItem,
  describeResult,
  disabledReason,
  effectiveSelection,
  formatBytes,
  holderChip,
  isInspectable,
  isMeasurable,
  isSafe,
  recentMinutes,
  sizeText,
  statusText,
  totalSize
} from '../worktree-view'

const NOW = 1_800_000_000_000

function entry(over: Partial<WorktreeInventoryEntry> = {}): WorktreeInventoryEntry {
  const id = over.id ?? '/r/.claude/worktrees/a'
  return {
    id,
    name: id.split('/').pop()!,
    path: id,
    location: 'managed',
    kind: 'worktree',
    branch: 'feat/a',
    head: 'abc',
    locked: false,
    contains: [],
    holders: [],
    ...over
  }
}

function inspection(over: Partial<WorktreeInspection> = {}): WorktreeInspection {
  return {
    uncommittedFiles: 0,
    uncommittedSample: [],
    ignoredEntries: 0,
    uniqueCommits: 0,
    uniqueCommitSample: [],
    ...over
  }
}

function size(over: Partial<WorktreeSize> = {}): WorktreeSize {
  return { bytes: 1024, files: 3, links: 0, errors: 0, newestMtimeMs: NOW - 3_600_000, ...over }
}

const liveSession: WorktreeHolder = { kind: 'session', id: 's1', label: 'Fix bug', live: true }
const coldSession: WorktreeHolder = { kind: 'session', id: 's2', label: 'Old chat', live: false }

describe('formatBytes', () => {
  it('scales to GB', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(3.5 * 1024 * 1024 * 1024)).toBe('3.5 GB')
  })
})

describe('isInspectable / isMeasurable (N4)', () => {
  it('an invalid entry is neither; a missing one is inspected but not measured', () => {
    expect(isInspectable(entry())).toBe(true)
    expect(isMeasurable(entry())).toBe(true)
    expect(isInspectable(entry({ invalidReason: 'x' }))).toBe(false)
    expect(isMeasurable(entry({ invalidReason: 'x' }))).toBe(false)
    expect(isInspectable(entry({ kind: 'missing' }))).toBe(true)
    expect(isMeasurable(entry({ kind: 'missing' }))).toBe(false)
  })
})

describe('blockReason', () => {
  it('names each reason a row cannot be selected', () => {
    expect(blockReason(entry())).toBeNull()
    expect(blockReason(entry({ locked: true, lockReason: 'on a usb' }))).toBe('locked: on a usb')
    expect(blockReason(entry({ locked: true }))).toBe('locked')
    expect(blockReason(entry({ invalidReason: 'not verifiably a worktree of this repo' }))).toBe(
      'not verifiably a worktree of this repo'
    )
    expect(blockReason(entry({ holders: [liveSession] }))).toBe('in use by Fix bug')
  })

  it('does not block on a cold holder', () => {
    expect(blockReason(entry({ holders: [coldSession] }))).toBeNull()
  })
})

describe('nested entries', () => {
  const inner = entry({ id: '/r/.claude/worktrees/outer/inner' })
  const outer = entry({ id: '/r/.claude/worktrees/outer', contains: [inner.id] })
  const byId = new Map([outer, inner].map((e) => [e.id, e]))

  it('an outer row is disabled until its inner rows are selected', () => {
    expect(disabledReason(outer, byId, new Set())).toBe('contains inner: select it first')
    expect(disabledReason(outer, byId, new Set([inner.id]))).toBeNull()
  })

  it('an outer row whose inner entry is itself blocked says so (N1)', () => {
    const held = entry({
      id: '/r/.claude/worktrees/outer/held',
      name: 'held',
      holders: [liveSession]
    })
    const wrapper = entry({ id: '/r/.claude/worktrees/outer', contains: [held.id] })
    const map = new Map([wrapper, held].map((e) => [e.id, e]))
    expect(disabledReason(wrapper, map, new Set())).toBe(
      'contains held, which cannot be removed (in use by Fix bug)'
    )
    // selecting the inner row is impossible, so the reason stays
    expect(disabledReason(wrapper, map, effectiveSelection(new Set([held.id]), map))).toContain(
      'which cannot be removed'
    )
  })

  it('deselecting the inner row drops the outer one from the effective selection', () => {
    expect([...effectiveSelection(new Set([outer.id, inner.id]), byId)].sort()).toEqual(
      [inner.id, outer.id].sort()
    )
    expect([...effectiveSelection(new Set([outer.id]), byId)]).toEqual([])
  })

  it('a blocked row never survives in the selection', () => {
    const held = entry({ id: '/r/.claude/worktrees/held', holders: [liveSession] })
    expect(effectiveSelection(new Set([held.id]), new Map([[held.id, held]])).size).toBe(0)
  })
})

describe('isSafe (Select safe)', () => {
  const clean = inspection()
  const old = size()

  it('a clean, idle, old worktree is safe', () => {
    expect(isSafe(entry(), clean, old, NOW)).toBe(true)
  })

  it.each<[string, Partial<WorktreeInspection>]>([
    ['uncommitted files', { uncommittedFiles: 1 }],
    ['unique commits', { uniqueCommits: 2 }]
  ])('%s make it unsafe (R1)', (_n, over) => {
    expect(isSafe(entry(), inspection(over), old, NOW)).toBe(false)
  })

  it('a live holder, a lock or an invalid row is unsafe', () => {
    expect(isSafe(entry({ holders: [liveSession] }), clean, old, NOW)).toBe(false)
    expect(isSafe(entry({ locked: true }), clean, old, NOW)).toBe(false)
    expect(isSafe(entry({ invalidReason: 'x' }), clean, old, NOW)).toBe(false)
  })

  it('a cold holder still counts as safe (warn only, R3)', () => {
    expect(isSafe(entry({ holders: [coldSession] }), clean, old, NOW)).toBe(true)
  })

  it('modified within the last 10 minutes is unsafe, 10 minutes ago is safe (C-S9)', () => {
    expect(isSafe(entry(), clean, size({ newestMtimeMs: NOW - 60_000 }), NOW)).toBe(false)
    expect(
      isSafe(entry(), clean, size({ newestMtimeMs: NOW - RECENT_MODIFICATION_MS + 1 }), NOW)
    ).toBe(false)
    expect(isSafe(entry(), clean, size({ newestMtimeMs: NOW - RECENT_MODIFICATION_MS }), NOW)).toBe(
      true
    )
  })

  it('unknown data is not safe: still scanning or the query failed', () => {
    expect(isSafe(entry(), undefined, old, NOW)).toBe(false)
    expect(isSafe(entry(), clean, undefined, NOW)).toBe(false)
    expect(isSafe(entry(), null, old, NOW)).toBe(false)
    expect(isSafe(entry(), clean, null, NOW)).toBe(false)
  })

  it('an entry that contains others is not safe', () => {
    expect(isSafe(entry({ contains: ['/x'] }), clean, old, NOW)).toBe(false)
  })

  describe('a missing entry (R1: its branch or detached HEAD can hold commits)', () => {
    const gone = entry({ kind: 'missing' })

    it('is safe once inspected clean, with no size needed', () => {
      expect(isSafe(gone, clean, undefined, NOW)).toBe(true)
    })

    it('is not safe before its inspection lands, or when that failed', () => {
      expect(isSafe(gone, undefined, undefined, NOW)).toBe(false)
      expect(isSafe(gone, null, undefined, NOW)).toBe(false)
    })

    it('is not safe when commits exist only on its branch or detached HEAD', () => {
      expect(isSafe(gone, inspection({ uniqueCommits: 1 }), undefined, NOW)).toBe(false)
      expect(
        isSafe(
          entry({ kind: 'missing', branch: null }),
          inspection({ uniqueCommits: 3 }),
          undefined,
          NOW
        )
      ).toBe(false)
    })
  })

  it('an orphan holding real files is unsafe (R1), an empty shell is safe', () => {
    const orphan = entry({ kind: 'orphan', branch: null })
    expect(isSafe(orphan, inspection({ uncommittedFiles: 4 }), old, NOW)).toBe(false)
    expect(isSafe(orphan, clean, old, NOW)).toBe(true)
  })
})

describe('row text', () => {
  it('status', () => {
    expect(statusText(entry(), undefined)).toBe('checking…')
    expect(statusText(entry(), null)).toBe('could not check')
    expect(statusText(entry(), inspection())).toBe('clean')
    expect(statusText(entry(), inspection({ uncommittedFiles: 3, uniqueCommits: 1 }))).toBe(
      '3 uncommitted · 1 commit only here'
    )
    expect(statusText(entry({ kind: 'missing' }), undefined)).toBe('not found at its path')
    expect(statusText(entry({ kind: 'missing' }), inspection())).toBe('not found at its path')
    expect(statusText(entry({ kind: 'missing' }), inspection({ uniqueCommits: 2 }))).toBe(
      'not found at its path · 2 commits only here'
    )
    // N4: an invalid entry is not scanned, so it never reads "checking…" forever
    expect(statusText(entry({ invalidReason: 'x' }), undefined)).toBe('not checked')
    expect(statusText(entry({ kind: 'orphan' }), inspection())).toBe('empty shell')
    expect(statusText(entry({ kind: 'orphan' }), inspection({ uncommittedFiles: 2 }))).toBe(
      '2 files left inside'
    )
  })

  it('size shows … while measuring and — for a missing directory', () => {
    expect(sizeText(entry(), undefined)).toBe('…')
    expect(sizeText(entry(), null)).toBe('?')
    expect(sizeText(entry(), size({ bytes: 2048 }))).toBe('2 KB')
    expect(sizeText(entry({ kind: 'missing' }), undefined)).toBe('—')
    // N4: an invalid entry is never measured, so it never reads "…" forever
    expect(sizeText(entry({ invalidReason: 'x' }), undefined)).toBe('—')
  })

  it('holder chips', () => {
    expect(holderChip(liveSession)).toEqual({ text: 'live session: Fix bug', live: true })
    expect(holderChip(coldSession)).toEqual({ text: 'session: Old chat', live: false })
    expect(holderChip({ kind: 'terminal', id: 't', label: 'terminal', live: true })).toEqual({
      text: 'terminal',
      live: true
    })
    expect(holderChip({ kind: 'x-agent', id: 'x', label: 'X-Agent probe', live: false })).toEqual({
      text: 'X-Agent probe (parked)',
      live: false
    })
  })

  it('recentMinutes is null for old, empty or unmeasured trees', () => {
    expect(recentMinutes(size({ newestMtimeMs: NOW - 4 * 60_000 }), NOW)).toBe(4)
    expect(recentMinutes(size({ newestMtimeMs: 0 }), NOW)).toBeNull()
    expect(recentMinutes(undefined, NOW)).toBeNull()
  })
})

describe('totalSize', () => {
  const a = entry({ id: '/a' })
  const b = entry({ id: '/b' })
  const gone = entry({ id: '/c', kind: 'missing' })

  it('is a lower bound while any row is pending or failed', () => {
    expect(totalSize([a, b], { '/a': size({ bytes: 10 }) })).toEqual({ bytes: 10, atLeast: true })
    expect(totalSize([a, b], { '/a': size({ bytes: 10 }), '/b': null })).toEqual({
      bytes: 10,
      atLeast: true
    })
  })

  it('is exact once every scannable row is measured; a missing entry has no size', () => {
    expect(
      totalSize([a, b, gone], { '/a': size({ bytes: 10 }), '/b': size({ bytes: 5 }) })
    ).toEqual({ bytes: 15, atLeast: false })
  })
})

describe('confirmItem', () => {
  it('lists uncommitted files with a sample and the remainder', () => {
    const item = confirmItem(
      entry(),
      inspection({
        uncommittedFiles: 8,
        uncommittedSample: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts']
      }),
      size(),
      NOW
    )
    expect(item.lines).toContain('8 uncommitted files will be lost (not recoverable).')
    expect(item.samples).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', '…and 3 more'])
    expect(item.clean).toBe(false)
  })

  it('unique commits on a branch: the branch is kept; on a detached HEAD they are lost (R2)', () => {
    const sample = [{ sha: 'abcdef0123', subject: 'wip' }]
    const onBranch = confirmItem(
      entry(),
      inspection({ uniqueCommits: 2, uniqueCommitSample: sample }),
      size(),
      NOW
    )
    expect(onBranch.lines).toContain('2 commits exist only on branch feat/a: the branch is kept.')
    expect(onBranch.samples).toEqual(['abcdef0 wip'])
    const single = confirmItem(entry(), inspection({ uniqueCommits: 1 }), size(), NOW)
    expect(single.lines).toContain('1 commit exists only on branch feat/a: the branch is kept.')
    const detached = confirmItem(
      entry({ branch: null }),
      inspection({ uniqueCommits: 1, uniqueCommitSample: sample }),
      size(),
      NOW
    )
    expect(detached.lines).toContain('1 commit on a detached HEAD will be lost.')
  })

  it('a branch without unique commits says it is deleted', () => {
    expect(confirmItem(entry(), inspection(), size(), NOW).lines).toEqual([
      'Branch feat/a is deleted: every commit on it exists elsewhere.'
    ])
  })

  it('shows the collapsed ignored count', () => {
    const item = confirmItem(entry(), inspection({ ignoredEntries: 12 }), size(), NOW)
    expect(item.lines.join('\n')).toContain('12 ignored entries')
  })

  it('warns about recent modification (C-S9) and cold holders (R3)', () => {
    const item = confirmItem(
      entry({
        holders: [coldSession, { kind: 'x-agent', id: 'x', label: 'X-Agent probe', live: false }]
      }),
      inspection(),
      size({ newestMtimeMs: NOW - 2 * 60_000 }),
      NOW
    )
    const text = item.lines.join('\n')
    expect(text).toContain('Modified 2 minutes ago')
    expect(text).toContain('Session "Old chat" is closed')
    expect(text).toContain('X-Agent probe is parked')
  })

  it('says so when the inspection is missing instead of claiming the row is clean', () => {
    expect(confirmItem(entry(), undefined, size(), NOW).lines[0]).toMatch(/Not checked yet/)
    expect(confirmItem(entry(), null, size(), NOW).lines[0]).toMatch(/Could not check/)
    expect(confirmItem(entry(), undefined, size(), NOW).clean).toBe(false)
  })

  describe('a missing entry (R1)', () => {
    const gone = entry({ kind: 'missing' })

    it('with no unique commits its registration goes and its branch is deleted', () => {
      expect(confirmItem(gone, inspection(), undefined, NOW).lines).toEqual([
        'Not found at its path (an unplugged drive or offline share looks the same); removing it only unregisters it, no files are touched.',
        'Branch feat/a is deleted: every commit on it exists elsewhere.'
      ])
    })

    it('commits only on its branch: the branch is kept', () => {
      const item = confirmItem(
        gone,
        inspection({
          uniqueCommits: 2,
          uniqueCommitSample: [{ sha: 'abcdef0123', subject: 'wip' }]
        }),
        undefined,
        NOW
      )
      expect(item.lines).toContain('2 commits exist only on branch feat/a: the branch is kept.')
      expect(item.samples).toEqual(['abcdef0 wip'])
    })

    it('a detached missing worktree with commits made there: they will be lost', () => {
      const item = confirmItem(
        entry({ kind: 'missing', branch: null }),
        inspection({ uniqueCommits: 1 }),
        undefined,
        NOW
      )
      expect(item.lines).toContain('1 commit on a detached HEAD will be lost.')
      expect(item.clean).toBe(false)
    })

    it('says the commits are unknown when the inspection is pending or failed', () => {
      expect(confirmItem(gone, undefined, undefined, NOW).lines[1]).toMatch(/Not checked yet/)
      expect(confirmItem(gone, null, undefined, NOW).lines[1]).toMatch(/Could not check/)
    })

    it('needs no size, so no "not measured" line', () => {
      expect(confirmItem(gone, inspection(), undefined, NOW).lines.join(' ')).not.toMatch(/measure/)
    })
  })

  it('an orphan sample says how many more files there are (N3)', () => {
    const item = confirmItem(
      entry({ kind: 'orphan', branch: null }),
      inspection({ uncommittedFiles: 9, uncommittedSample: ['a', 'b', 'c', 'd', 'e', 'f'] }),
      size(),
      NOW
    )
    expect(item.samples).toEqual(['a', 'b', 'c', 'd', 'e', '…and 4 more'])
  })

  it('says recent changes are unknown while the size is pending or failed (N5)', () => {
    expect(confirmItem(entry(), inspection(), undefined, NOW).lines).toContainEqual(
      expect.stringMatching(/Not measured yet/)
    )
    expect(confirmItem(entry(), inspection(), null, NOW).lines).toContainEqual(
      expect.stringMatching(/Could not measure/)
    )
    expect(confirmItem(entry(), inspection(), size(), NOW).lines.join(' ')).not.toMatch(/measure/)
  })
})

describe('describeResult', () => {
  it('removed, with each branch fate', () => {
    expect(describeResult({ id: 'x', outcome: 'removed' }).text).toBe('Removed.')
    expect(
      describeResult({
        id: 'x',
        outcome: 'removed',
        branch: { name: 'b', action: 'deleted', uniqueCommits: 0 }
      }).text
    ).toBe('Removed. Branch b deleted.')
    expect(
      describeResult({
        id: 'x',
        outcome: 'removed',
        branch: { name: 'b', action: 'kept', uniqueCommits: 2 }
      }).text
    ).toBe('Removed. Branch b kept (2 commits only there).')
    expect(
      describeResult({
        id: 'x',
        outcome: 'removed',
        branch: { name: 'main', action: 'protected', uniqueCommits: 0, reason: 'main branch' }
      }).text
    ).toBe('Removed. Branch main not deleted (main branch).')
    expect(
      describeResult({
        id: 'x',
        outcome: 'removed',
        branch: { name: 'b', action: 'kept', uniqueCommits: 0, reason: 'checked out elsewhere' }
      }).text
    ).toBe('Removed. Branch b kept (checked out elsewhere).')
  })

  it('refused names the reason', () => {
    expect(
      describeResult({ id: 'x', outcome: 'refused', reason: 'in-use: Fix bug, terminal' })
    ).toMatchObject({
      tone: 'warn',
      text: 'Refused: in use by Fix bug, terminal.'
    })
    expect(describeResult({ id: 'x', outcome: 'refused', reason: 'locked' }).text).toMatch(/locked/)
    expect(describeResult({ id: 'x', outcome: 'refused', reason: 'not-found' }).text).toMatch(
      /no longer exists/
    )
    expect(
      describeResult({ id: 'x', outcome: 'refused', reason: 'invalid: reappeared' }).text
    ).toBe('Refused: a folder reappeared at this path since the check. Refresh and retry.')
    expect(
      describeResult({ id: 'x', outcome: 'refused', reason: 'invalid: refusing to remove /x' }).text
    ).toBe('Refused: refusing to remove /x.')
  })

  it('partial counts the paths and tells the user to close programs and retry', () => {
    const r = describeResult({
      id: 'x',
      outcome: 'partial',
      failures: [
        { path: 'C:/wt/a.bin', code: 'EBUSY' },
        { path: 'C:/wt/b.bin', code: 'EPERM' }
      ]
    })
    expect(r.text).toBe('2 paths could not be deleted. Close programs using it and retry.')
    expect(r.paths).toEqual(['C:/wt/a.bin (EBUSY)', 'C:/wt/b.bin (EPERM)'])
  })

  it('GIT_UNREGISTER reads as "files gone, still registered"; REAPPEARED has its own text', () => {
    expect(
      describeResult({
        id: 'x',
        outcome: 'partial',
        failures: [{ path: 'C:/wt', code: 'GIT_UNREGISTER' }]
      }).text
    ).toMatch(/Files are gone but git still lists/)
    expect(
      describeResult({
        id: 'x',
        outcome: 'partial',
        failures: [{ path: 'C:/wt', code: 'REAPPEARED' }]
      }).text
    ).toMatch(/reappeared/)
  })

  it('ECHANGED has its own text and does not blame a program holding files (N2)', () => {
    const r = describeResult({
      id: 'x',
      outcome: 'partial',
      failures: [{ path: 'C:/wt/sub', code: 'ECHANGED' }]
    })
    expect(r.text).toBe(
      'The folder changed while removing, so the rest was left alone. Refresh and retry.'
    )
    expect(r.paths).toEqual(['C:/wt/sub'])
    // mixed with a real failure the generic text (with codes) is kept
    expect(
      describeResult({
        id: 'x',
        outcome: 'partial',
        failures: [
          { path: 'C:/wt/sub', code: 'ECHANGED' },
          { path: 'C:/wt/b', code: 'EBUSY' }
        ]
      }).text
    ).toMatch(/2 paths could not be deleted/)
  })

  it('failed carries the error', () => {
    expect(describeResult({ id: 'x', outcome: 'failed', reason: 'boom' })).toMatchObject({
      tone: 'error',
      text: 'Failed: boom'
    })
  })
})
