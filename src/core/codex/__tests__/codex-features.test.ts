import { describe, expect, it } from 'vitest'
import { CLAUDEUI_DISABLED_FEATURES } from '../codex-features'

/**
 * F17 guard 3 — the SHAPE of the override, not its effect.
 *
 * The list is snapshotted here on purpose: adding a tenth key is then a
 * deliberate edit in two places, and whoever makes it has to say which flag it
 * is and why ClaudeUI has no such surface. The key spelling matters just as
 * much — Codex's `[features]` table is keyed by the `FeatureSpec.key` string
 * (`codex-rs/features/src/lib.rs`), and an unknown or misspelled key is simply
 * ignored, so a typo would switch nothing off and nothing would say so.
 */
describe('CLAUDEUI_DISABLED_FEATURES', () => {
  it('is exactly the nine desktop-app flags, in the binary`s own key spelling', () => {
    expect(Object.keys(CLAUDEUI_DISABLED_FEATURES).sort()).toEqual([
      'browser_use',
      'browser_use_external',
      'browser_use_full_cdp_access',
      'computer_use',
      'in_app_browser',
      'in_app_chat',
      'in_app_dictation',
      'in_app_local_automation',
      'in_app_updates'
    ])
  })

  it('spells every key the way a TOML feature key is spelled', () => {
    for (const key of Object.keys(CLAUDEUI_DISABLED_FEATURES))
      expect(key).toMatch(/^[a-z][a-z0-9_]*$/)
  })

  it('switches every one of them OFF and nothing else', () => {
    expect(Object.values(CLAUDEUI_DISABLED_FEATURES)).toEqual(
      Object.keys(CLAUDEUI_DISABLED_FEATURES).map(() => false)
    )
  })

  it('cannot be mutated by a caller, so one thread cannot re-point another`s', () => {
    // It is handed to every `thread/start` / `thread/resume` / `thread/fork`
    // envelope by reference; a frozen object is what stops a serializer or a
    // future caller from editing the shared one.
    expect(Object.isFrozen(CLAUDEUI_DISABLED_FEATURES)).toBe(true)
  })
})
