/**
 * @vitest-environment node
 *
 * `EnterWorktree` detection against cli.js 2.1.308's real result strings (slice 3a), and the
 * C-B4 gate every DETECTED write passes. The repos are fabricated on disk (a `.git` directory plus
 * the files git keeps under `worktrees/<id>`), so `linkedWorktreeOf` runs for real and no git is
 * spawned.
 *
 * The result strings are verbatim from cli.js: curly quotes from `EU()`, the branch part absent
 * for a detached worktree, and a sentence appended after the branch for Reused/Resumed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  fabricateRepo,
  fabricateWorktree,
  makeScratchDir
} from '../../../test/helpers/fabricated-worktree'

const loadSessionConfig = vi.fn()
const saveSessionConfig = vi.fn()
const debug = vi.fn()

vi.mock('../../../core/services/ui-config', () => ({
  loadSessionConfig: () => loadSessionConfig(),
  saveSessionConfig: (config: unknown) => saveSessionConfig(config)
}))
vi.mock('../../../core/services/logger', () => ({
  logger: { debug: (...a: unknown[]) => debug(...a), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

const {
  detectEnteredWorktree,
  resolveEnteredWorktree,
  recordDetectedWorktree,
  applySessionMoved,
  forgetWorktreeEntries
} = await import('../../../core/services/worktree-detect')
const { forgetLinkedWorktrees, linkedWorktreeOf } =
  await import('../../../core/services/worktree-root')

const TAIL =
  ' The session is now working in the worktree. Use ExitWorktree to leave mid-session, or exit the session to be prompted.'
const REUSED =
  ' A worktree with this name already existed; its previous work was fully merged upstream, so it was reset to the current base.'
const RESUMED =
  ' A worktree with this name already existed and was resumed as-is \u2014 it may carry an earlier session\u2019s commits. Pass a different name if you wanted a fresh worktree.'

describe('detectEnteredWorktree: cli.js 2.1.308 results', () => {
  it.each([
    ['Created', ''],
    ['Entered', ''],
    ['Reused', REUSED],
    ['Resumed', RESUMED]
  ])('%s: curly quotes, branch, and the sentence cli.js appends', (verb, extra) => {
    const text = `${verb} worktree at \u201C/repo/.claude/worktrees/foo\u201D on branch \u201Cworktree-foo\u201D.${extra}${TAIL}`
    expect(detectEnteredWorktree(text)).toEqual({
      worktreePath: '/repo/.claude/worktrees/foo',
      worktreeBranch: 'worktree-foo',
      pathExact: true
    })
  })

  it('a Windows path with spaces keeps its backslashes', () => {
    const text = `Created worktree at \u201CD:\\My Repo\\.claude\\worktrees\\foo\u201D on branch \u201Cworktree-foo\u201D.${TAIL}`
    expect(detectEnteredWorktree(text)).toMatchObject({
      worktreePath: 'D:\\My Repo\\.claude\\worktrees\\foo',
      worktreeBranch: 'worktree-foo'
    })
  })

  it('a detached worktree has no branch part', () => {
    expect(detectEnteredWorktree(`Entered worktree at \u201C/wt/ab12/repo\u201D.${TAIL}`)).toEqual({
      worktreePath: '/wt/ab12/repo',
      worktreeBranch: '',
      pathExact: true
    })
  })

  it('straight quotes and no quotes are accepted too', () => {
    expect(
      detectEnteredWorktree(
        'Created worktree at "/r/.claude/worktrees/foo" on branch "worktree-foo".'
      )
    ).toMatchObject({ worktreePath: '/r/.claude/worktrees/foo', worktreeBranch: 'worktree-foo' })
    expect(
      detectEnteredWorktree('Created worktree at /r/.claude/worktrees/foo on branch worktree-foo.')
    ).toMatchObject({ worktreePath: '/r/.claude/worktrees/foo', worktreeBranch: 'worktree-foo' })
    expect(detectEnteredWorktree('Entered worktree at /wt/x. Now working there.')).toMatchObject({
      worktreePath: '/wt/x',
      worktreeBranch: ''
    })
  })

  it('flags a path cli.js says is not its exact spelling, and drops an inexact branch', () => {
    const inexactPath = `Created worktree at \u201C/repo/wt/fo?o\u201D (not its exact spelling) on branch \u201Cworktree-foo\u201D.${TAIL}`
    expect(detectEnteredWorktree(inexactPath)).toEqual({
      worktreePath: '/repo/wt/fo?o',
      worktreeBranch: 'worktree-foo',
      pathExact: false
    })
    const inexactBranch = `Created worktree at \u201C/repo/wt/foo\u201D on branch \u201Cworktree-f?o\u201D (not its exact spelling).${TAIL}`
    expect(detectEnteredWorktree(inexactBranch)).toEqual({
      worktreePath: '/repo/wt/foo',
      worktreeBranch: '',
      pathExact: true
    })
  })
})

describe('resolveEnteredWorktree + recordDetectedWorktree (C-B4)', () => {
  let base: string
  let repo: string
  let wt: string

  beforeEach(() => {
    forgetLinkedWorktrees()
    saveSessionConfig.mockReset()
    loadSessionConfig.mockReset()
    loadSessionConfig.mockReturnValue({})
    debug.mockReset()
    base = makeScratchDir('claudeui-detect-')
    repo = fabricateRepo(path.join(base, 'repo'))
    wt = fabricateWorktree(
      repo,
      path.join(repo, '.claude', 'worktrees', 'foo'),
      'foo',
      'ref: refs/heads/worktree-foo'
    )
  })
  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 })
  })

  const text = (p: string, branch = 'worktree-foo'): string =>
    `Created worktree at \u201C${p}\u201D on branch \u201C${branch}\u201D.${TAIL}`

  it('resolves the text path of a linked worktree of the session repo', () => {
    const got = resolveEnteredWorktree(text(wt), undefined, repo)
    expect(got).toEqual({
      worktreePath: wt,
      worktreeBranch: 'worktree-foo',
      worktreeName: 'foo',
      gitRoot: repo
    })
  })

  it('takes the branch from the worktree HEAD when the text names none', () => {
    const got = resolveEnteredWorktree(
      `Entered worktree at \u201C${wt}\u201D.${TAIL}`,
      undefined,
      repo
    )
    expect(got).toMatchObject({ worktreePath: wt, worktreeBranch: 'worktree-foo' })
  })

  it('a detached worktree resolves with an empty branch', () => {
    const detached = fabricateWorktree(
      repo,
      path.join(base, '.codex', 'worktrees', 'ab12', 'repo'),
      'det',
      'a'.repeat(40)
    )
    const got = resolveEnteredWorktree(
      `Entered worktree at \u201C${detached}\u201D.${TAIL}`,
      undefined,
      repo
    )
    expect(got).toMatchObject({
      worktreePath: detached,
      worktreeBranch: '',
      worktreeName: 'ab12/repo'
    })
  })

  it('falls back to the call input `name` when the spelling is inexact', () => {
    const inexact = `Created worktree at \u201C${wt}x\u201D (not its exact spelling) on branch \u201Cworktree-foo\u201D.${TAIL}`
    expect(resolveEnteredWorktree(inexact, { name: 'foo' }, repo)).toMatchObject({
      worktreePath: wt
    })
  })

  it('maps a slash in the input name to + (cli.js flattens it)', () => {
    const nested = fabricateWorktree(repo, path.join(repo, '.claude', 'worktrees', 'a+b'), 'ab')
    const inexact = `Created worktree at \u201C${nested}x\u201D (not its exact spelling).${TAIL}`
    expect(resolveEnteredWorktree(inexact, { name: 'a/b' }, repo)).toMatchObject({
      worktreePath: nested
    })
  })

  it('falls back to the call input `path` when the text path is not a directory', () => {
    const gone = text(path.join(base, 'nowhere'))
    expect(resolveEnteredWorktree(gone, { path: wt }, repo)).toMatchObject({ worktreePath: wt })
  })

  it('a relative `path` input resolves against the worktree already recorded, else the spawn cwd (N5)', () => {
    const bar = fabricateWorktree(repo, path.join(repo, '.claude', 'worktrees', 'bar'), 'bar')
    const gone = text(path.join(base, 'nowhere'))
    // `../bar` is a sibling of `foo` (the session is in foo), but not of the repo root's parent.
    expect(resolveEnteredWorktree(gone, { path: '../bar' }, repo, wt)).toMatchObject({
      worktreePath: bar
    })
    expect(typeof resolveEnteredWorktree(gone, { path: '../bar' }, repo)).toBe('string')
    // No recorded worktree: the spawn cwd is the base.
    expect(resolveEnteredWorktree(gone, { path: '.claude/worktrees/bar' }, repo)).toMatchObject({
      worktreePath: bar
    })
  })

  it('a directory the listing cached as "not a worktree" is vetted from the disk, not the cache (S1/N1)', () => {
    const fresh = path.join(repo, '.claude', 'worktrees', 'fresh')
    fs.mkdirSync(fresh, { recursive: true })
    expect(linkedWorktreeOf(fresh)).toBeNull()
    fabricateWorktree(repo, fresh, 'fresh')
    expect(resolveEnteredWorktree(text(fresh), undefined, repo)).toMatchObject({
      worktreePath: fresh
    })
  })

  it('a subdirectory of the worktree resolves to the worktree itself', () => {
    const sub = path.join(wt, 'src')
    fs.mkdirSync(sub)
    expect(resolveEnteredWorktree(text(sub), undefined, repo)).toMatchObject({ worktreePath: wt })
  })

  it("refuses another repository's worktree: it would widen the permission roots", () => {
    const other = fabricateRepo(path.join(base, 'other'))
    const foreign = fabricateWorktree(other, path.join(other, '.claude', 'worktrees', 'bar'), 'bar')
    const got = resolveEnteredWorktree(text(foreign), undefined, repo)
    expect(typeof got).toBe('string')
    expect(got).toContain("not to the session's repository")
  })

  it.each([
    ['a plain directory', (b: string) => b],
    ['a path that does not exist', (b: string) => path.join(b, 'nope')]
  ])('refuses %s', (_label, make) => {
    const dest = make(base)
    expect(typeof resolveEnteredWorktree(text(dest), undefined, repo)).toBe('string')
  })

  it('refuses when the session cwd is not in a repository', () => {
    const plain = path.join(base, 'plain')
    fs.mkdirSync(plain)
    const got = resolveEnteredWorktree(text(wt), undefined, plain)
    expect(got).toContain('not inside a git repository')
  })

  it('records with origin detected, the spawn cwd as originalCwd and an empty head commit', () => {
    const emit = vi.fn()
    const sub = path.join(repo, 'src')
    fs.mkdirSync(sub)
    const vetted = resolveEnteredWorktree(text(wt), undefined, sub)
    expect(recordDetectedWorktree('r1', vetted, sub, emit)).toBe(true)
    const saved = saveSessionConfig.mock.calls[0][0].worktreeInfoMap.r1
    expect(saved).toMatchObject({
      worktreePath: wt,
      worktreeBranch: 'worktree-foo',
      worktreeName: 'foo',
      originalCwd: sub,
      gitRoot: repo,
      originalHeadCommit: '',
      origin: 'detected'
    })
    expect(emit).toHaveBeenCalledWith('config:sessions-changed', expect.any(Array))
  })

  it('a miss records nothing and logs once at debug', () => {
    const emit = vi.fn()
    const vetted = resolveEnteredWorktree('no worktree here', undefined, repo)
    expect(recordDetectedWorktree('r1', vetted, repo, emit)).toBe(false)
    expect(saveSessionConfig).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
    expect(debug).toHaveBeenCalledTimes(1)
  })
})

describe('applySessionMoved (opencode session.moved)', () => {
  let base: string
  let repo: string
  let wt: string
  let store: Record<string, unknown>

  beforeEach(() => {
    forgetLinkedWorktrees()
    store = {}
    saveSessionConfig.mockReset()
    saveSessionConfig.mockImplementation((c: Record<string, unknown>) => {
      store = c
    })
    loadSessionConfig.mockReset()
    loadSessionConfig.mockImplementation(() => ({ ...store }))
    base = makeScratchDir('claudeui-moved-')
    repo = fabricateRepo(path.join(base, 'repo'))
    wt = fabricateWorktree(repo, path.join(base, 'share', 'worktree', 'abcdef', 'fox'), 'fox')
  })
  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 })
  })

  const entry = (): { worktreePath: string; originalCwd: string; origin: string } | undefined =>
    (store.worktreeInfoMap as Record<string, never> | undefined)?.['r1']

  it('into a linked worktree (outside the repo, opencode layout) records it; back to the spawn cwd forgets it', () => {
    const emit = vi.fn()
    expect(applySessionMoved('r1', wt, repo, emit)).toBe('recorded')
    expect(entry()).toMatchObject({ worktreePath: wt, originalCwd: repo, origin: 'detected' })

    expect(applySessionMoved('r1', repo, repo, emit)).toBe('forgot')
    expect(entry()).toBeUndefined()
  })

  it('into a plain directory forgets the entry; with none recorded it changes nothing', () => {
    const emit = vi.fn()
    const plain = path.join(base, 'plain')
    fs.mkdirSync(plain)
    expect(applySessionMoved('r1', plain, repo, emit)).toBe('unchanged')
    applySessionMoved('r1', wt, repo, emit)
    expect(applySessionMoved('r1', plain, repo, emit)).toBe('forgot')
    expect(entry()).toBeUndefined()
  })

  it("into another repository's worktree records nothing (C-B4) and drops the stale entry", () => {
    const emit = vi.fn()
    const other = fabricateRepo(path.join(base, 'other'))
    const foreign = fabricateWorktree(other, path.join(other, '.claude', 'worktrees', 'x'), 'x')
    applySessionMoved('r1', wt, repo, emit)
    expect(applySessionMoved('r1', foreign, repo, emit)).toBe('forgot')
    expect(entry()).toBeUndefined()
  })

  it('a second move to another worktree overwrites, keeping the first originalCwd', () => {
    const emit = vi.fn()
    const wt2 = fabricateWorktree(
      repo,
      path.join(base, 'share', 'worktree', 'abcdef', 'owl'),
      'owl'
    )
    applySessionMoved('r1', wt, repo, emit)
    applySessionMoved('r1', wt2, repo, emit)
    expect(entry()).toMatchObject({ worktreePath: wt2, originalCwd: repo })
  })

  describe('a created entry is never touched by detection (B1)', () => {
    const created = (): Record<string, unknown> => ({
      worktreePath: path.join(repo, '.claude', 'worktrees', 'mine'),
      worktreeBranch: 'worktree-mine',
      worktreeName: 'mine',
      originalCwd: repo,
      gitRoot: repo,
      originalHeadCommit: 'abc123',
      createdAt: 5,
      origin: 'created'
    })
    beforeEach(() => {
      store = { worktreeInfoMap: { r1: created() } }
      saveSessionConfig.mockClear()
    })

    it.each([
      ['a plain directory', (): string => path.join(base, 'plain')],
      ['the spawn cwd', (): string => repo],
      ['another worktree', (): string => wt]
    ])('session.moved to %s leaves it byte-equal', (_label, dest) => {
      fs.mkdirSync(path.join(base, 'plain'), { recursive: true })
      const emit = vi.fn()
      const before = JSON.stringify(store)
      expect(applySessionMoved('r1', dest(), repo, emit)).toBe('unchanged')
      expect(JSON.stringify(store)).toBe(before)
      expect(saveSessionConfig).not.toHaveBeenCalled()
      expect(emit).not.toHaveBeenCalled()
    })

    it('a legacy created entry (no origin, a recorded head commit) is protected too', () => {
      const legacy = { ...created() }
      delete legacy.origin
      store = { worktreeInfoMap: { r1: legacy } }
      expect(applySessionMoved('r1', wt, repo, vi.fn())).toBe('unchanged')
      expect(store.worktreeInfoMap).toEqual({ r1: legacy })
    })

    it('the removal path still drops it', () => {
      const dropped = forgetWorktreeEntries(
        [(created() as { worktreePath: string }).worktreePath],
        vi.fn()
      )
      expect(dropped).toEqual(['r1'])
      expect(store.worktreeInfoMap).toEqual({})
    })
  })
})
