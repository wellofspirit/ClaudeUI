/**
 * @vitest-environment node
 *
 * Argument handling for `scripts/codex-render-stress.mjs`.
 *
 * The script itself can only be proven by launching a real Electron app against
 * a real Codex binary, which no test suite does. What IS cheap to guard is the
 * gate in front of that: a typo must stop the run BEFORE it spawns an app and a
 * provider (an hour-long twenty-iteration loop that silently ran with the
 * default iteration count is worse than a refusal), and `--dry-run` must answer
 * without launching anything at all.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const script = resolve(__dirname, '../../../../scripts/codex-render-stress.mjs')
const mod: {
  parseOptions: (argv: string[]) => { options: Record<string, unknown>; errors: string[] }
} = await import(script)

/** The build check is about THIS checkout, not about the arguments under test. */
const argErrors = (argv: string[]): string[] =>
  mod.parseOptions(argv).errors.filter((error) => !error.includes('out/main/index.js'))

describe('codex-render-stress arguments', () => {
  it('defaults to twenty iterations, no load, headless', () => {
    const { options } = mod.parseOptions([])
    expect(argErrors([])).toEqual([])
    expect(options.iterations).toBe(20)
    expect(options.iterationTimeout).toBe(120000)
    expect(options.load).toBe(false)
    expect(options.headed).toBe(false)
    expect(options.dryRun).toBe(false)
  })

  it('refuses a non-positive or non-numeric iteration count', () => {
    expect(argErrors(['--iterations', '0'])).toEqual([
      '--iterations must be an integer >= 1 (got "0")'
    ])
    expect(argErrors(['--iterations', '2.5'])).toEqual([
      '--iterations must be an integer >= 1 (got "2.5")'
    ])
    expect(argErrors(['--iteration-timeout', '10'])).toEqual([
      '--iteration-timeout must be an integer >= 5000 (got "10")'
    ])
  })

  it('refuses an unknown flag rather than ignoring it', () => {
    expect(argErrors(['--iteratons', '5'])[0]).toContain('unknown flag --iteratons')
  })

  it('refuses a flag whose value was swallowed by the next flag', () => {
    expect(argErrors(['--prompt', '--load'])).toEqual(['--prompt needs a value'])
  })

  it('refuses to run against the real user profile', () => {
    const real = process.env.USERPROFILE ?? process.env.HOME ?? ''
    expect(real).toBeTruthy()
    expect(argErrors(['--home', real])).toEqual(['--home must not be the real user profile'])
  })

  it('takes the load flags', () => {
    const { options } = mod.parseOptions(['--load', '--load-workers', '3'])
    expect(options.load).toBe(true)
    expect(options.loadWorkers).toBe(3)
    expect(argErrors(['--load', '--load-workers', '3'])).toEqual([])
  })

  it('--keep implies --headed, so a kept window is findable', () => {
    expect(mod.parseOptions(['--keep']).options.headed).toBe(true)
  })

  it('answers --dry-run from the CLI without launching anything', () => {
    // No app, no provider, no Playwright import: a launch would take tens of
    // seconds and leave processes behind, so the sub-second run IS the assertion.
    const out = execFileSync(process.execPath, [script, '--dry-run', '--iterations', '3'], {
      encoding: 'utf8',
      timeout: 20000
    })
    const parsed = JSON.parse(out)
    expect(parsed.ok).toBe(true)
    expect(parsed.plan.iterations).toBe(3)
    expect(parsed.plan.dryRun).toBe(true)
  })

  it('exits 2 on a bad argument', () => {
    let status = 0
    let stderr = ''
    try {
      execFileSync(process.execPath, [script, '--dry-run', '--iterations', 'many'], {
        encoding: 'utf8',
        timeout: 20000,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (err) {
      status = (err as { status: number }).status
      stderr = String((err as { stderr: string }).stderr)
    }
    expect(status).toBe(2)
    expect(stderr).toContain('--iterations must be an integer >= 1')
  })
})
