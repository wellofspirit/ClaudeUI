/**
 * @vitest-environment node
 *
 * The `linkedWorktreeOf` cache: a hit is revalidated on every use (a worktree removed behind our
 * back stops answering), its branch is read fresh, and a miss is trusted for a short while so a
 * listing refresh does not re-walk every plain repo. `linkedWorktreeOfUncached` never trusts
 * either (it gates what detection records).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  fabricateRepo,
  fabricateWorktree,
  makeScratchDir
} from '../../../test/helpers/fabricated-worktree'
import {
  forgetLinkedWorktrees,
  linkedWorktreeOf,
  linkedWorktreeOfUncached,
  setLinkedCacheMaxForTests
} from '../worktree-root'

describe('linkedWorktreeOf cache', () => {
  let base: string
  let repo: string
  let wt: string

  beforeEach(() => {
    forgetLinkedWorktrees()
    base = makeScratchDir('claudeui-wtcache-')
    repo = fabricateRepo(path.join(base, 'repo'))
    wt = fabricateWorktree(repo, path.join(base, 'wt'), 'w')
  })
  afterEach(() => {
    vi.useRealTimers()
    setLinkedCacheMaxForTests()
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 })
  })

  const adminDir = (): string => path.join(repo, '.git', 'worktrees', 'w')

  it('drops a hit whose worktree directory was deleted (no forget call)', () => {
    expect(linkedWorktreeOf(wt)).not.toBeNull()
    fs.rmSync(wt, { recursive: true, force: true })
    expect(linkedWorktreeOf(wt)).toBeNull()
  })

  it('drops a hit whose admin dir was pruned while the .git file is still there', () => {
    expect(linkedWorktreeOf(wt)).not.toBeNull()
    fs.rmSync(adminDir(), { recursive: true, force: true })
    expect(linkedWorktreeOf(wt)).toBeNull()
  })

  it('drops a hit whose .git became a directory (the path was re-initialised as a repo)', () => {
    expect(linkedWorktreeOf(wt)).not.toBeNull()
    fs.rmSync(path.join(wt, '.git'))
    fs.mkdirSync(path.join(wt, '.git'))
    expect(linkedWorktreeOf(wt)).toBeNull()
  })

  it('re-reads the branch from HEAD on a hit', () => {
    expect(linkedWorktreeOf(wt)?.branch).toBe('worktree-feat')
    fs.writeFileSync(path.join(adminDir(), 'HEAD'), 'ref: refs/heads/other\n')
    expect(linkedWorktreeOf(wt)?.branch).toBe('other')
    fs.writeFileSync(path.join(adminDir(), 'HEAD'), `${'a'.repeat(40)}\n`)
    expect(linkedWorktreeOf(wt)?.branch).toBe('')
  })

  it('trusts a miss for 30 s, then looks again; forgetting the path clears it at once', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const later = path.join(base, 'later')
    fs.mkdirSync(later)
    expect(linkedWorktreeOf(later)).toBeNull()

    fabricateWorktree(repo, later, 'later')
    expect(linkedWorktreeOf(later)).toBeNull() // the miss is remembered
    vi.setSystemTime(new Date('2026-01-01T00:00:29Z'))
    expect(linkedWorktreeOf(later)).toBeNull()
    vi.setSystemTime(new Date('2026-01-01T00:00:31Z'))
    expect(linkedWorktreeOf(later)?.worktreePath).toBe(later)

    const again = path.join(base, 'again')
    fs.mkdirSync(again)
    expect(linkedWorktreeOf(again)).toBeNull()
    fabricateWorktree(repo, again, 'again')
    forgetLinkedWorktrees([again])
    expect(linkedWorktreeOf(again)?.worktreePath).toBe(again)
  })

  it('bounds the hit cache: past its cap the cache starts over instead of growing', () => {
    // Every entry is a real walk of the disk, so the spec lowers the cap (2000 in the app) rather
    // than time 2000 of them: the bound is the same code, and the test no longer takes as long as
    // the machine's disk happens to.
    const CAP = 20
    setLinkedCacheMaxForTests(CAP)
    // Distinct spellings of one worktree: each cwd is its own cache key (they need not exist).
    const sub = (i: number): string => path.join(wt, `d${i}`)
    const first = linkedWorktreeOf(sub(0))
    expect(first).not.toBeNull()
    expect(linkedWorktreeOf(sub(0))).toBe(first) // a hit answers with the cached object

    for (let i = 1; i < CAP; i++) linkedWorktreeOf(sub(i)) // the cache now holds CAP entries
    expect(linkedWorktreeOf(sub(0))).toBe(first) // exactly full: nothing evicted yet
    linkedWorktreeOf(sub(CAP)) // one key past the cap clears the cache first

    const again = linkedWorktreeOf(sub(0))
    expect(again).toEqual(first)
    expect(again).not.toBe(first) // looked up afresh: the old entry was dropped
  })

  it('linkedWorktreeOfUncached ignores both caches', () => {
    const fresh = path.join(base, 'fresh')
    fs.mkdirSync(fresh)
    expect(linkedWorktreeOf(fresh)).toBeNull() // negative cached
    fabricateWorktree(repo, fresh, 'fresh')
    expect(linkedWorktreeOf(fresh)).toBeNull()
    expect(linkedWorktreeOfUncached(fresh)?.worktreePath).toBe(fresh)

    expect(linkedWorktreeOf(wt)).not.toBeNull() // positive cached
    fs.rmSync(path.join(wt, '.git'))
    expect(linkedWorktreeOfUncached(wt)).toBeNull()
  })
})
