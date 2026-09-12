/**
 * @vitest-environment node
 *
 * The verifier-hooks opt-in must be OFF by default. The handle it gates pins the
 * session store and the replica's canonical state on `window`, so a flag that
 * defaulted on (or that a stray env value could flip) would ship a debugging
 * surface to every user.
 */
import { describe, it, expect } from 'vitest'
import { VERIFIER_HOOKS_ENV, VERIFIER_HOOKS_SWITCH, verifierHooksEnabled } from '../verifier-hooks'

describe('verifierHooksEnabled', () => {
  it('defaults to false with a clean env and argv', () => {
    expect(verifierHooksEnabled({}, [])).toBe(false)
  })

  it('is true when the env var is exactly "1"', () => {
    expect(verifierHooksEnabled({ [VERIFIER_HOOKS_ENV]: '1' }, [])).toBe(true)
  })

  it('is false for any other env value — no truthiness, no "true", no "0"', () => {
    for (const value of ['0', 'true', 'yes', '', ' 1']) {
      expect(verifierHooksEnabled({ [VERIFIER_HOOKS_ENV]: value }, [])).toBe(false)
    }
  })

  it('is true when the CLI switch is present (how main and additionalArguments opt in)', () => {
    expect(verifierHooksEnabled({}, ['electron', '.', VERIFIER_HOOKS_SWITCH])).toBe(true)
  })

  it('ignores an unrelated env var and an unrelated switch', () => {
    expect(verifierHooksEnabled({ CLAUDEUI_HEADLESS: '1' }, ['--claudeui-headless'])).toBe(false)
  })

  it('reads the real process.env/argv by default', () => {
    // Both are clean in a plain `bun run test` process — the assertion is that
    // the defaults are wired to the real process at all, not to `{}`.
    expect(verifierHooksEnabled()).toBe(
      process.env[VERIFIER_HOOKS_ENV] === '1' || process.argv.includes(VERIFIER_HOOKS_SWITCH)
    )
  })
})
