/**
 * Tests for provider-actions.ts — the Disable/Remove availability matrix.
 *
 * Guards:
 * - Remove is offered ONLY for what ClaudeUI itself can delete: an auth.json
 *   credential and/or a declaration in the one global config file it writes.
 * - removeKind names exactly what would be destroyed ('both' when both exist).
 * - Remove is blocked, with an actionable reason, for every source ClaudeUI
 *   cannot delete from: the other global config file, env vars, credential-free
 *   bundled gateways, and providers declared in files we never read.
 * - Disable is never gated (asserted by the absence of any `canDisable` — the
 *   caller always renders it) and credential update is gated only on free.
 *
 * REGRESSION ANCHOR: the ChatGPT case. A subscription credential fed into
 * opencode's auth.json under id 'openai' must resolve to canRemove/'credential'
 * — never to "nothing to remove", which is what pushed the old UI into writing
 * disabled_providers and stranding the route at 0 models.
 */

// @vitest-environment node

import { describe, it, expect } from 'vitest'
import { resolveProviderActions, type ProviderActionInput } from '../provider-actions'

const base: ProviderActionInput = {
  isFree: false,
  hasCredential: false,
  declaredInOurFile: false,
  declaredElsewhereGlobal: false
}

const input = (over: Partial<ProviderActionInput> = {}): ProviderActionInput => ({ ...base, ...over })

describe('resolveProviderActions — removable classes', () => {
  it('offers credential removal for a provider whose only listing source is auth.json', () => {
    // The ChatGPT/openai case: plugin-auth path, openai's own loader is autoload:false.
    const actions = resolveProviderActions(input({ hasCredential: true, source: 'custom' }))
    expect(actions.canRemove).toBe(true)
    expect(actions.removeKind).toBe('credential')
    expect(actions.blockedReason).toBeUndefined()
  })

  it('offers credential removal for a plain API-key provider', () => {
    const actions = resolveProviderActions(input({ hasCredential: true, source: 'api' }))
    expect(actions.removeKind).toBe('credential')
  })

  it('offers declaration removal for a provider declared in the file we write', () => {
    const actions = resolveProviderActions(input({ declaredInOurFile: true, source: 'config' }))
    expect(actions.canRemove).toBe(true)
    expect(actions.removeKind).toBe('declaration')
  })

  it("reports 'both' when a declared provider also has a stored credential", () => {
    const actions = resolveProviderActions(
      input({ declaredInOurFile: true, hasCredential: true, source: 'config' })
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
