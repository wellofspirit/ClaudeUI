/**
 * Pure rules behind the branch dropdown's list: which rows show, what the Create
 * row offers, the keyboard order, the age column, and how a diverged pull is
 * decided from git's config.
 */
import { describe, it, expect } from 'vitest'
import type { GitBranchData, GitBranchDetail } from '../../../../../../shared/types'
import {
  CREATE_KEY,
  autostashFor,
  buildBranchList,
  formatAge,
  formatFetched,
  pullChoice
} from '../branch-model'

function d(name: string, o: Partial<GitBranchDetail> = {}): GitBranchDetail {
  return {
    name,
    kind: 'local',
    commitTime: 0,
    ahead: 0,
    behind: 0,
    gone: false,
    current: false,
    ...o
  }
}

function data(details: GitBranchDetail[]): GitBranchData {
  return {
    current: details.find((x) => x.current)?.name ?? '',
    local: details.filter((x) => x.kind === 'local').map((x) => x.name),
    remote: details.filter((x) => x.kind === 'remote').map((x) => x.name),
    tracking: {},
    details,
    autostashes: [],
    pullConfig: { rebase: null, ff: null },
    unpublished: 0
  }
}

const BRANCHES = data([
  d('feat', { current: true, upstream: 'origin/feat' }),
  d('main', { upstream: 'origin/main' }),
  d('busy', { worktree: { path: '/wt/busy', main: false } }),
  d('tracks-other', { upstream: 'origin/renamed' }),
  d('origin/feat', { kind: 'remote' }),
  d('origin/main', { kind: 'remote' }),
  d('origin/renamed', { kind: 'remote' }),
  d('origin/docs/rewrite', { kind: 'remote' }),
  d('upstream/main', { kind: 'remote' })
])

describe('buildBranchList', () => {
  it('lists remote branches only when no local branch is their twin or tracks them', () => {
    const m = buildBranchList(BRANCHES, '', false)
    expect(m.local.map((r) => r.detail.name)).toEqual(['feat', 'main', 'busy', 'tracks-other'])
    // origin/feat + origin/main have a local twin; origin/renamed is tracked by `tracks-other`;
    // `upstream/main` shares only the short name `main` with a local branch, so it is hidden too.
    expect(m.remoteOnly.map((r) => r.detail.name)).toEqual(['origin/docs/rewrite'])
    expect(m.remoteOnly[0]).toMatchObject({ prefix: 'origin/', name: 'docs/rewrite' })
  })

  it('keeps the remote-only group collapsed until opened or searched', () => {
    expect(buildBranchList(BRANCHES, '', false).remoteExpanded).toBe(false)
    expect(buildBranchList(BRANCHES, '', true).remoteExpanded).toBe(true)
    const searched = buildBranchList(BRANCHES, 'rewrite', false)
    expect(searched.remoteExpanded).toBe(true)
    expect(searched.remoteOnly).toHaveLength(1)
  })

  it('leaves a branch held by another worktree out of the keyboard order', () => {
    const m = buildBranchList(BRANCHES, '', false)
    expect(m.local.find((r) => r.detail.name === 'busy')?.activatable).toBe(false)
    expect(m.navKeys).toEqual(['local:feat', 'local:main', 'local:tracks-other'])
  })

  it('offers Create first for text that names no branch, then the matches', () => {
    const m = buildBranchList(BRANCHES, 'ma', true)
    expect(m.createName).toBe('ma')
    expect(m.navKeys[0]).toBe(CREATE_KEY)
    expect(m.navKeys).toContain('local:main')
  })

  it.each([
    ['an exact local name', 'main'],
    ['the short name of a remote-only branch', 'docs/rewrite'],
    ['a remote branch typed in full', 'origin/docs/rewrite'],
    ['whitespace inside', 'two words'],
    ['a leading dash', '-x'],
    ['nothing', '   ']
  ])('offers no Create for %s', (_label, text) => {
    expect(buildBranchList(BRANCHES, text, false).createName).toBeNull()
  })

  it('marks a branch without an upstream as local only', () => {
    const m = buildBranchList(BRANCHES, '', false)
    expect(m.local.find((r) => r.detail.name === 'busy')?.localOnly).toBe(true)
    expect(m.local.find((r) => r.detail.name === 'main')?.localOnly).toBe(false)
  })
})

describe('formatAge / formatFetched', () => {
  const now = 1_000_000_000_000
  const ago = (sec: number): number => now / 1000 - sec
  it.each([
    [30, 'now'],
    [4 * 60, '4m'],
    [3 * 3600, '3h'],
    [2 * 86400, '2d'],
    [3 * 7 * 86400, '3w'],
    [5 * 30 * 86400, '5mo'],
    [800 * 86400, '2y']
  ])('%d seconds ago is %s', (sec, label) => {
    expect(formatAge(ago(sec), now)).toBe(label)
  })

  it('words the last fetch', () => {
    expect(formatFetched(now - 20_000, now)).toBe('Fetched just now')
    expect(formatFetched(now - 2 * 60_000, now)).toBe('Fetched 2 min ago')
    expect(formatFetched(now - 3 * 3600_000, now)).toBe('Fetched 3 h ago')
  })
})

describe('pullChoice', () => {
  it.each([
    [{ rebase: 'rebase', ff: null }, 'rebase'],
    [{ rebase: 'merge', ff: null }, 'merge'],
    [{ rebase: 'rebase', ff: 'only' }, 'rebase'], // an explicit rebase wins over ff=only
    [{ rebase: null, ff: 'only' }, 'ff-only'],
    [{ rebase: null, ff: 'false' }, 'merge'],
    [{ rebase: null, ff: 'true' }, 'ask'],
    [{ rebase: null, ff: null }, 'ask']
  ] as const)('%j -> %s', (config, expected) => {
    expect(pullChoice({ rebase: config.rebase, ff: config.ff })).toBe(expected)
  })
})

describe('autostashFor', () => {
  it('finds the newest autostash of a branch and counts them', () => {
    const b = {
      ...data([]),
      autostashes: [
        { sha: '1', branch: 'a', time: 't3' },
        { sha: '2', branch: 'b', time: 't2' },
        { sha: '3', branch: 'a', time: 't1' }
      ]
    }
    expect(autostashFor(b, 'a')).toEqual({ latest: b.autostashes[0], count: 2 })
    expect(autostashFor(b, 'zzz')).toBeNull()
    expect(autostashFor(null, 'a')).toBeNull()
  })
})
