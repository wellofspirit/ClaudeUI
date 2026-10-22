/**
 * Ruling 11 — a REAL case's redirects are measured with the scope production
 * would have built. Ruling 18: a temp variable is a HINT, never a scope claim,
 * so `$env:TEMP\x.txt` and `$TEMP/x.log` stay unresolvable (as HEAD reported
 * them) with a `tempVarTargets` hint, while `/tmp/x.log` and a relative target
 * under `workdir` still measure IN SCOPE. These exercise the same function
 * `run.ts` calls (`replayRedirectScope` + the production `redirectScopeFor`);
 * `run.ts` itself cannot be imported without starting an eval.
 */
import { describe, expect, it } from 'vitest'
import { redirectScopeFor } from '../../src/core/automode/action-meta'
import { analyzeRedirects, type RedirectAnalysis } from '../../src/core/automode/ground-truth'
import {
  replayHonoursWorkdir,
  replayRedirectScope,
  replayTempEnv,
  type ReplayScopeFacts
} from './replay-scope'

const WIN_CWD = 'C:\\Users\\dev\\work\\vnc-probe'
const WIN_TEMP = 'C:\\Users\\dev\\AppData\\Local\\Temp'

/** A win32 REAL case, as extraction stores it (`real.tempDirs` + route). */
function win32Case(overrides: Partial<ReplayScopeFacts> = {}): ReplayScopeFacts {
  return {
    cwd: WIN_CWD,
    input: {},
    route: 'pi-root',
    engine: 'pi',
    tempDirs: [WIN_TEMP],
    platform: 'win32',
    shell: 'posix',
    ...overrides
  }
}

/** The scope `run.ts` builds, then the pure analysis it (or captureRedirects) reads. */
function analyze(facts: ReplayScopeFacts, command: string): RedirectAnalysis {
  const scope = replayRedirectScope(facts, redirectScopeFor)
  const result = analyzeRedirects(command, scope, facts.platform as NodeJS.Platform)
  if (result === null) throw new Error(`no redirect analysis for ${command}`)
  return result
}

describe('replay scope — the captured temp dirs are scope roots', () => {
  it('reconstructs TEMP/TMP from the captured temp dir (no TMPDIR on win32)', () => {
    expect(replayTempEnv(win32Case())).toEqual({ TEMP: WIN_TEMP, TMP: WIN_TEMP })
    expect(replayTempEnv({ tempDirs: ['/var/folders/x1/T'], platform: 'darwin' })).toEqual({
      TEMP: '/var/folders/x1/T',
      TMP: '/var/folders/x1/T',
      TMPDIR: '/var/folders/x1/T'
    })
  })

  it('unions the captured roots with tempDirRoots, so win32 also scopes /tmp', () => {
    const scope = replayRedirectScope(win32Case(), redirectScopeFor)
    expect(scope.tempDirs).toEqual(expect.arrayContaining([WIN_TEMP, '/tmp']))
  })

  it('$env:TEMP\\x.txt on a powershell route is unresolvable with the temp hint (ruling 18)', () => {
    const facts = win32Case({ route: 'opencode-root', engine: 'opencode', shell: 'powershell' })
    expect(analyze(facts, 'echo hi > "$env:TEMP\\x.txt"')).toEqual({
      targets: ['$env:TEMP\\x.txt'],
      allInScope: false,
      outOfScope: [],
      unresolvable: ['$env:TEMP\\x.txt'],
      protectedHits: [],
      tempVarTargets: [
        { target: '$env:TEMP\\x.txt', path: 'c:/Users/dev/AppData/Local/Temp/x.txt' }
      ]
    })
  })

  it('an UNQUOTED $env:TEMP\\x.txt is unresolvable with the temp hint (ruling 12/18)', () => {
    const facts = win32Case({ route: 'opencode-root', engine: 'opencode', shell: 'powershell' })
    // PowerShell reads a backslash as a path separator only, so the one reading
    // is `$env:TEMP` + `/x.txt` — the hint names it inside the captured temp dir.
    expect(analyze(facts, 'echo hi > $env:TEMP\\x.txt')).toEqual({
      targets: ['$env:TEMP\\x.txt'],
      allInScope: false,
      outOfScope: [],
      unresolvable: ['$env:TEMP\\x.txt'],
      protectedHits: [],
      tempVarTargets: [
        { target: '$env:TEMP\\x.txt', path: 'c:/Users/dev/AppData/Local/Temp/x.txt' }
      ]
    })
  })

  it('$TEMP/x.log on a pi route (win32) is unresolvable with the temp hint (ruling 18)', () => {
    expect(analyze(win32Case(), 'echo hi > $TEMP/x.log')).toEqual({
      targets: ['$TEMP/x.log'],
      allInScope: false,
      outOfScope: [],
      unresolvable: ['$TEMP/x.log'],
      protectedHits: [],
      tempVarTargets: [{ target: '$TEMP/x.log', path: 'c:/Users/dev/AppData/Local/Temp/x.log' }]
    })
  })

  it('/tmp/x.log on a pi route (win32) measures in scope', () => {
    expect(analyze(win32Case(), 'echo hi > /tmp/x.log')).toEqual({
      targets: ['/tmp/x.log'],
      allInScope: true,
      outOfScope: [],
      unresolvable: [],
      protectedHits: []
    })
  })
})

describe('replay scope — workdir follows the route', () => {
  it('an opencode call resolves a relative target against its workdir', () => {
    const facts = win32Case({
      route: 'opencode-root',
      engine: 'opencode',
      shell: 'powershell',
      input: { workdir: 'sub' }
    })
    expect(replayHonoursWorkdir(facts)).toBe(true)
    expect(replayRedirectScope(facts, redirectScopeFor).shellCwd).toBe(
      'c:/Users/dev/work/vnc-probe/sub'
    )
    expect(analyze(facts, 'echo hi > out.log')).toEqual({
      targets: ['out.log'],
      allInScope: true,
      outOfScope: [],
      unresolvable: [],
      protectedHits: []
    })
    // The resolution really is the workdir, not the session cwd.
    expect(analyze({ ...facts, input: { workdir: '..' } }, 'echo hi > out.log')).toEqual({
      targets: ['out.log'],
      allInScope: false,
      outOfScope: [{ path: 'c:/Users/dev/work/out.log' }],
      unresolvable: [],
      protectedHits: []
    })
  })

  it('a dispatch TO opencode honours workdir; pi does not', () => {
    expect(replayHonoursWorkdir(win32Case({ route: 'dispatch-opencode' }))).toBe(true)
    const pi = win32Case({ route: 'pi-root', input: { workdir: 'sub' } })
    expect(replayHonoursWorkdir(pi)).toBe(false)
    expect(replayRedirectScope(pi, redirectScopeFor).shellCwd).toBe(WIN_CWD)
  })
})
