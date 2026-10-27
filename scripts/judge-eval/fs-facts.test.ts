/**
 * Exit review Astra C1: the `--fs-facts` adapter must not invent measurements.
 *
 * A historical fact that records only `{"exists":true}` did not measure a size or
 * an mtime. The adapter used to fill in `size: 0` / `mtimeMs: 0`, which production
 * measurement turned into `empty:true` and `modifiedSinceSessionStart:false`; the
 * ILD NOT-list then cleared truncating a file nobody had established was empty.
 *
 * These tests drive the REAL `statFromFacts`/`fsFactsProbe` from
 * `scripts/judge-eval/fs-facts.ts` through production `captureRedirects`, without
 * importing the runner (which would start an eval).
 */
import { describe, expect, it } from 'vitest'
import { redirectTargetDetails } from '../../src/core/automode/ground-truth'
import { captureRedirects } from '../../src/core/automode/redirect-measure'
import {
  fsFactsProbe,
  outOfScopeTargets,
  statFromFacts,
  type FsFactsCase,
  type FsFactsTargets
} from './fs-facts'

const SESSION_START = 1_000_000

function probeFor(fact: FsFactsCase['paths'][string]) {
  const facts: FsFactsCase = {
    sessionStartMs: SESSION_START,
    paths: { '/outside/report.txt': fact }
  }
  return fsFactsProbe(facts)
}

const scope = { cwd: '/repo', tempDirs: [] as string[], shell: 'posix' as const }

const measure = (fact: FsFactsCase['paths'][string]) =>
  captureRedirects('echo x > /outside/report.txt', scope, {
    sessionStartMs: SESSION_START,
    platform: 'linux',
    probe: probeFor(fact)
  })

describe('judge-eval fs facts — never invent size/mtime (exit review Astra C1)', () => {
  it('statFromFacts omits size and mtimeMs the fact did not record', () => {
    const stat = statFromFacts({ exists: true })
    expect(stat.size).toBeUndefined()
    expect(stat.mtimeMs).toBeUndefined()
    expect('size' in stat).toBe(false)
    expect('mtimeMs' in stat).toBe(false)
  })

  it('an exists-only fact measures exists:true and NOT empty/modifiedSinceSessionStart', async () => {
    const result = await measure({ exists: true })
    // The reviewer's probe shape: `{"exists":true}` in, no fabricated `empty`.
    expect(result?.outOfScope).toEqual([{ path: '/outside/report.txt', exists: true }])
    expect(result?.outOfScope[0]).not.toHaveProperty('empty')
    expect(result?.outOfScope[0]).not.toHaveProperty('modifiedSinceSessionStart')
  })

  it('size 0 / mtime 0 is a real measurement: empty:true, not modified', async () => {
    const result = await measure({ exists: true, size: 0, mtimeMs: 0 })
    expect(result?.outOfScope).toEqual([
      {
        path: '/outside/report.txt',
        exists: true,
        empty: true,
        modifiedSinceSessionStart: false
      }
    ])
  })

  it('a recorded size alone still measures empty, and reports no mtime fact', async () => {
    const result = await measure({ exists: true, size: 12 })
    expect(result?.outOfScope).toEqual([
      { path: '/outside/report.txt', exists: true, empty: false }
    ])
  })

  it('fsFactsProbe keeps "no facts for this path" as NOT MEASURED, never exists:false', async () => {
    const probe = fsFactsProbe({ sessionStartMs: SESSION_START, paths: {} })
    const result = await captureRedirects('echo x > /outside/report.txt', scope, {
      sessionStartMs: SESSION_START,
      platform: 'linux',
      probe
    })
    expect(result?.outOfScope).toEqual([{ path: '/outside/report.txt' }])
  })
})

/**
 * The replay/production mismatch (judge-hardening): production withholds the clean
 * scope claim when a probe fails, and the fake probe used to fail for every path
 * it had no fact for — including the scope roots and the parent directories of a
 * plainly in-scope redirect. Production would have seen real directories there.
 */
describe('judge-eval fs facts — unrecorded paths are an ordinary, link-free tree', () => {
  const treeScope = { cwd: '/repo', tempDirs: ['/tmp'], shell: 'posix' as const }
  const empty: FsFactsCase = { sessionStartMs: SESSION_START, paths: {} }

  /** The targets exactly as `run.ts` derives them for the probe. */
  function targetsOf(command: string): FsFactsTargets {
    return { outOfScope: outOfScopeTargets(redirectTargetDetails(command, treeScope, 'linux')) }
  }

  const measureTree = (command: string, facts: FsFactsCase, withTargets: boolean) =>
    captureRedirects(command, treeScope, {
      sessionStartMs: SESSION_START,
      platform: 'linux',
      probe: fsFactsProbe(facts, withTargets ? targetsOf(command) : undefined)
    })

  it('answers each call kind: leaf not measured, everything else an ordinary non-link', async () => {
    const probe = fsFactsProbe(empty, { outOfScope: ['/outside/report.txt'] })
    // A scope root / ancestor directory: not a link; no kind, size or mtime claimed.
    const dir = await probe.lstat('/repo/sub')
    expect(dir.isSymbolicLink()).toBe(false)
    expect(dir.size).toBeUndefined()
    expect(dir.mtimeMs).toBeUndefined()
    // An in-scope leaf with no fact is the same ordinary entry.
    expect((await probe.lstat('/repo/sub/out.log')).isSymbolicLink()).toBe(false)
    // realpath is the identity: no links on the original machine unless recorded.
    expect(await probe.realpath('/repo')).toBe('/repo')
    expect(await probe.realpath('/repo/sub')).toBe('/repo/sub')
    // The out-of-scope leaf stays "not measured": a non-ENOENT error, never exists:false.
    const error = await probe.lstat('/outside/report.txt').catch((e: NodeJS.ErrnoException) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as NodeJS.ErrnoException).code).not.toBe('ENOENT')
    await expect(probe.realpath('/outside/report.txt')).rejects.toThrow(/not measured/)
  })

  it('without targets every unrecorded path stays "not measured" (the conservative default)', async () => {
    const probe = fsFactsProbe(empty)
    await expect(probe.lstat('/repo')).rejects.toThrow(/not measured/)
    await expect(probe.realpath('/repo')).rejects.toThrow(/not measured/)
  })

  it('keeps plainly in-scope redirects clean instead of flipping them to unmeasured', async () => {
    const command = 'echo a > /tmp/a.log; echo b > /repo/sub/b.log'
    const withTargets = await measureTree(command, empty, true)
    expect(withTargets?.allInScope).toBe(true)
    expect(withTargets).not.toHaveProperty('unmeasured')
    // The mismatch this fixes: the old probe made production withhold the claim.
    const old = await measureTree(command, empty, false)
    expect(old?.allInScope).toBe(false)
    expect(old?.unmeasured).toEqual(['/tmp/a.log', '/repo/sub/b.log'])
  })

  it('still invents no exists/empty fact for an out-of-scope target nobody recorded', async () => {
    const result = await measureTree('echo x > /outside/report.txt', empty, true)
    expect(result?.allInScope).toBe(false)
    expect(result?.outOfScope).toEqual([{ path: '/outside/report.txt' }])
    // `outOfScope` already names it; a missing exists/empty there means not measured.
    expect(result).not.toHaveProperty('unmeasured')
  })

  it('a recorded fact for the out-of-scope target still wins', async () => {
    const result = await measureTree(
      'echo x > /outside/report.txt',
      { sessionStartMs: SESSION_START, paths: { '/outside/report.txt': { exists: false } } },
      true
    )
    expect(result?.outOfScope).toEqual([{ path: '/outside/report.txt', exists: false }])
    expect(result).not.toHaveProperty('unmeasured')
  })

  it('a recorded link in an ancestor directory still wins over the no-links assumption', async () => {
    const result = await measureTree(
      'echo x > /repo/link/x.log',
      {
        sessionStartMs: SESSION_START,
        paths: { '/repo/link': { exists: true, symlink: true, realpath: '/outside' } }
      },
      true
    )
    expect(result?.allInScope).toBe(false)
    expect(result?.symlinked).toEqual(['/repo/link/x.log'])
  })

  it('a recorded missing ancestor makes production climb to the nearest ordinary one', async () => {
    const result = await measureTree(
      'echo x > /repo/new/deep/x.log',
      {
        sessionStartMs: SESSION_START,
        paths: { '/repo/new': { exists: false }, '/repo/new/deep': { exists: false } }
      },
      true
    )
    expect(result?.allInScope).toBe(true)
  })
})

describe('outOfScopeTargets', () => {
  it('keeps only resolved targets outside every root', () => {
    expect(
      outOfScopeTargets([
        { path: '/repo/in.log', root: '/repo' },
        { path: '/outside/out.log' },
        {},
        { root: '/repo' }
      ])
    ).toEqual(['/outside/out.log'])
    expect(outOfScopeTargets(null)).toEqual([])
    expect(outOfScopeTargets(undefined)).toEqual([])
  })
})
