// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { parseCodexSettings, savedCodexOverrides } from '../settings'

/**
 * Slice 2b guard 1 — the per-session ChatGPT PIN rides in the same overrides
 * blob model and effort do (ADR-068 §2), so `codex_session_overrides` needs no
 * schema migration.
 *
 * `accountId` is the one key whose `null` is meaningful: a string pins a vault
 * account, an explicit null clears the pin ("follow the active account"), and
 * absence leaves whatever is stored alone. Nothing else in `CodexSettings`
 * accepts null, which is why the validator cannot simply widen `isSettableValue`.
 */
describe('parseCodexSettings and the account pin', () => {
  it('accepts an accountId string and an explicit null', () => {
    expect(parseCodexSettings({ accountId: 'acct-a' })).toEqual({ accountId: 'acct-a' })
    expect(parseCodexSettings({ accountId: null })).toEqual({ accountId: null })
    expect(parseCodexSettings({ model: 'native', accountId: 'acct-a' })).toEqual({
      model: 'native',
      accountId: 'acct-a'
    })
  })

  it('rejects every other accountId shape', () => {
    for (const value of [1, true, {}, [], '', '   ', 'x'.repeat(257)])
      expect(() => parseCodexSettings({ accountId: value })).toThrow(
        'Unsupported Codex setting or value'
      )
  })

  it('still rejects a null in the keys that have no null meaning', () => {
    expect(() => parseCodexSettings({ model: null })).toThrow('Unsupported Codex setting or value')
    expect(() => parseCodexSettings({ effort: null })).toThrow('Unsupported Codex setting or value')
  })

  it('restores a stored pin and drops a cleared or malformed one', () => {
    expect(savedCodexOverrides({ model: 'native', accountId: 'acct-a' })).toEqual({
      model: 'native',
      accountId: 'acct-a'
    })
    // A cleared pin reads back as "no pin": null and absent mean the same thing
    // to `start()`, so only a string survives the read.
    expect(savedCodexOverrides({ accountId: null })).toEqual({})
    expect(savedCodexOverrides({ accountId: 42 })).toEqual({})
  })
})
