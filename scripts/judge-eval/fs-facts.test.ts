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
import { captureRedirects } from '../../src/core/automode/redirect-measure'
import { fsFactsProbe, statFromFacts, type FsFactsCase } from './fs-facts'

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
