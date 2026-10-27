/**
 * Tests for provider-actions.ts — the Disable/Remove availability matrix.
 *
 * Guards:
 * - Remove is offered for what an explicit Remove deletes: ANY credential row
 *   opencode's credential table holds for the id (the user's own included —
 *   `hasStoredCredential`) and/or a declaration in the one global config file
 *   ClaudeUI writes.
 * - removeKind names exactly what would be destroyed ('both' when both exist).
 * - Remove is blocked, with an actionable reason, for every source ClaudeUI
 *   cannot delete from: the other global config file, env vars, credential-free
 *   bundled gateways, and providers declared in files we never read.
 * - Disable is never gated (asserted by the absence of any `canDisable` — the
 *   caller always renders it) and credential update is gated only on free.
 *
 * REGRESSION ANCHOR: the ChatGPT case. A subscription credential fed into
 * opencode's credential table under id 'openai' must resolve to canRemove/'credential'
 * — never to "nothing to remove", which is what pushed the old UI into writing
 * disabled_providers and stranding the route at 0 models.
 */

// @vitest-environment node

import { describe, it, expect } from 'vitest'
import { resolveProviderActions, type ProviderActionInput } from '../provider-actions'

const base: ProviderActionInput = {
  isFree: false,
  hasStoredCredential: false,
  declaredInOurFile: false,
  declaredElsewhereGlobal: false
}

const input = (over: Partial<ProviderActionInput> = {}): ProviderActionInput => ({
  ...base,
  ...over
})

describe('resolveProviderActions — removable classes', () => {
  it('offers credential removal for a provider whose only listing source is a stored credential row', () => {
    // The ChatGPT/openai case: plugin-auth path, openai's own loader is autoload:false.
    const actions = resolveProviderActions(input({ hasStoredCredential: true, source: 'custom' }))
    expect(actions.canRemove).toBe(true)
    expect(actions.removeKind).toBe('credential')
    expect(actions.blockedReason).toBeUndefined()
  })

  it('offers credential removal for a plain API-key provider', () => {
    const actions = resolveProviderActions(input({ hasStoredCredential: true, source: 'api' }))
    expect(actions.removeKind).toBe('credential')
  })

  it('a stored row of anyone’s is enough — whatever else keeps the provider listed does not block it', () => {
    // Remove deletes the rows; an env var, a free gateway or a vetoed provider
    // with a key behind it is still removable (and `settings` never wins over it).
    expect(
      resolveProviderActions(
        input({ hasStoredCredential: true, source: 'env', envVarNames: ['OPENROUTER_API_KEY'] })
      ).removeKind
    ).toBe('credential')
    expect(
      resolveProviderActions(input({ hasStoredCredential: true, isFree: true })).removeKind
    ).toBe('credential')
    expect(
      resolveProviderActions(input({ hasStoredCredential: true, disabled: true })).removeKind
    ).toBe('credential')
    // No row, only the veto: the stale-entry clean-up, as before.
    expect(resolveProviderActions(input({ disabled: true })).removeKind).toBe('settings')
  })

  it('offers declaration removal for a provider declared in the file we write', () => {
    const actions = resolveProviderActions(input({ declaredInOurFile: true, source: 'config' }))
    expect(actions.canRemove).toBe(true)
    expect(actions.removeKind).toBe('declaration')
  })

  it("reports 'both' when a declared provider also has a stored credential", () => {
    const actions = resolveProviderActions(
      input({ declaredInOurFile: true, hasStoredCredential: true, source: 'config' })
    )
    expect(actions.removeKind).toBe('both')
  })

  it('offers declaration removal even for a free provider declared in our file', () => {
    // Free-ness blocks credential actions, not declaration ownership.
    const actions = resolveProviderActions(input({ isFree: true, declaredInOurFile: true }))
    expect(actions.canRemove).toBe(true)
    expect(actions.removeKind).toBe('declaration')
  })
})

describe('resolveProviderActions — blocked classes', () => {
  it('blocks removal for a declaration in the other global config file, naming it', () => {
    const actions = resolveProviderActions(
      input({
        declaredElsewhereGlobal: true,
        source: 'config',
        elsewhereConfigPath: '/home/u/.config/opencode/opencode.json'
      })
    )
    expect(actions.canRemove).toBe(false)
    expect(actions.removeKind).toBeNull()
    expect(actions.blockedReason).toContain('opencode.json')
    expect(actions.blockedReason).toMatch(/disable/i)
  })

  it('blocks removal for an env-derived provider and names the variable', () => {
    const actions = resolveProviderActions(
      input({ source: 'env', envVarNames: ['OPENAI_API_KEY', 'OPENAI_KEY'] })
    )
    expect(actions.canRemove).toBe(false)
    expect(actions.blockedReason).toContain('OPENAI_API_KEY')
    expect(actions.blockedReason).toMatch(/disable/i)
  })

  it('blocks removal for a credential-free bundled gateway', () => {
    const actions = resolveProviderActions(input({ isFree: true }))
    expect(actions.canRemove).toBe(false)
    expect(actions.blockedReason).toMatch(/needs no credentials/i)
  })

  it('blocks removal for a config-declared provider in a file we never read', () => {
    // e.g. a project-level opencode.json, an .opencode dir, or an MDM profile.
    const actions = resolveProviderActions(input({ source: 'config' }))
    expect(actions.canRemove).toBe(false)
    expect(actions.blockedReason).toMatch(/project config|managed|does not write/i)
  })

  it('blocks removal for ambient-autoload providers with no stored credential', () => {
    // bedrock via an AWS profile, vertex via a resolvable GCP project.
    const actions = resolveProviderActions(input({ source: 'custom' }))
    expect(actions.canRemove).toBe(false)
    expect(actions.blockedReason).toMatch(/no stored credential/i)
  })

  it('an external credential source is a stored row like any other: removable, and not special-cased once nothing is stored', () => {
    // A row that only references a CLI login (Azure) is deleted by Remove.
    const stored = resolveProviderActions(input({ hasStoredCredential: true, source: 'external' }))
    expect(stored.removeKind).toBe('credential')
    expect(stored.blockedReason).toBeUndefined()
    // `source` is wording only: with no row left, the generic reason applies.
    const none = resolveProviderActions(input({ source: 'external' }))
    expect(none.canRemove).toBe(false)
    expect(none.blockedReason).toMatch(/no stored credential/i)
    expect(none.blockedReason).not.toMatch(/external credential source/i)
  })

  describe('a credential stored under another integration id (wording only)', () => {
    const SHARED_REASON =
      'Its credential is stored under opencode’s “google-vertex” integration, which this provider shares, so it can’t be removed from here. Disable it to hide it.'
    const shared = (over: Partial<ProviderActionInput> = {}) =>
      resolveProviderActions(input({ credentialIntegrationId: 'google-vertex', ...over }))

    it('says where the credential lives, instead of claiming there is none', () => {
      const actions = shared({ source: 'api' })
      expect(actions).toMatchObject({ canRemove: false, removeKind: null })
      expect(actions.blockedReason).toBe(SHARED_REASON)
      // ... and it beats the config-declared and the generic reasons.
      expect(shared({ source: 'config' }).blockedReason).toBe(SHARED_REASON)
      expect(shared({ source: 'custom' }).blockedReason).not.toMatch(/no stored credential/i)
    })

    it('never changes the decision: removeKind and canRemove are those of the same input without it', () => {
      const cases: Partial<ProviderActionInput>[] = [
        {},
        { source: 'api' },
        { hasStoredCredential: true },
        { declaredInOurFile: true },
        { hasStoredCredential: true, declaredInOurFile: true },
        { disabled: true },
        { disabled: true, declaredElsewhereGlobal: true },
        { declaredElsewhereGlobal: true },
        { isFree: true },
        { source: 'env', envVarNames: ['FOO_KEY'] }
      ]
      for (const over of cases) {
        const without = resolveProviderActions(input(over))
        const with_ = shared(over)
        expect(with_.canRemove, JSON.stringify(over)).toBe(without.canRemove)
        expect(with_.removeKind, JSON.stringify(over)).toBe(without.removeKind)
        expect(with_.canSetCredential, JSON.stringify(over)).toBe(without.canSetCredential)
        expect(with_.canEditDeclaration, JSON.stringify(over)).toBe(without.canEditDeclaration)
        // A removable row never carries a reason.
        if (with_.canRemove) expect(with_.blockedReason).toBeUndefined()
      }
    })

    it('yields to the more specific reasons: another config file, an env var, a free gateway', () => {
      expect(
        shared({ declaredElsewhereGlobal: true, elsewhereConfigPath: '/x/opencode.json' })
          .blockedReason
      ).toContain('/x/opencode.json')
      expect(shared({ source: 'env', envVarNames: ['FOO_KEY'] }).blockedReason).toContain('FOO_KEY')
      expect(shared({ isFree: true }).blockedReason).toMatch(/needs no credentials/i)
    })
  })

  it('prefers the env explanation over the generic one when both could apply', () => {
    const actions = resolveProviderActions(input({ source: 'env', envVarNames: ['FOO_KEY'] }))
    expect(actions.blockedReason).toContain('FOO_KEY')
  })
})

describe('resolveProviderActions — credential and declaration editing', () => {
  it('offers credential update for every non-free provider, even with no loader', () => {
    // The generic /auth path accepts a key regardless of the auth-option catalog.
    expect(resolveProviderActions(input()).canSetCredential).toBe(true)
    expect(resolveProviderActions(input({ source: 'config' })).canSetCredential).toBe(true)
  })

  it('withholds credential update from free providers', () => {
    expect(resolveProviderActions(input({ isFree: true })).canSetCredential).toBe(false)
  })

  it('offers declaration editing only for declarations in the file we write', () => {
    expect(resolveProviderActions(input({ declaredInOurFile: true })).canEditDeclaration).toBe(true)
    expect(
      resolveProviderActions(input({ declaredElsewhereGlobal: true })).canEditDeclaration
    ).toBe(false)
    expect(resolveProviderActions(input({ source: 'api' })).canEditDeclaration).toBe(false)
  })
})
