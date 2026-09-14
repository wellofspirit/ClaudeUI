/**
 * @vitest-environment node
 *
 * Which provider a rejected opencode credential belongs to (ADR-068 §4).
 *
 * opencode knows its vendors by ITS ids (`openai`), and the shared ChatGPT
 * definition is what says that id is the vault's subscription on that engine.
 * The mapping therefore has to read the definition, and it has to read the
 * ROUTE: a disabled opencode route means the credential opencode holds is the
 * user's own, not the vault's, and offering the vault sign-in for it would
 * re-vend a credential that is not the one that failed.
 *
 * The pure half is tested here with hand-built definitions; nothing touches
 * `~/.claude/ui/providers`.
 */
import { describe, it, expect } from 'vitest'
import { authRequiredProviderId } from '../chatgpt-route'
import type { SharedProviderDefinition } from '../../../shared/shared-provider'

function chatgpt(opencodeEnabled: boolean): SharedProviderDefinition {
  return {
    id: 'chatgpt',
    name: 'ChatGPT',
    kind: 'subscription',
    models: [],
    managed: true,
    routes: {
      pi: { enabled: true, providerId: 'openai-codex' },
      opencode: { enabled: opencodeEnabled, providerId: 'openai' }
    }
  }
}

describe('authRequiredProviderId — opencode vendor → auth-required provider', () => {
  it('maps the shared route’s opencode id onto the vault provider', () => {
    expect(authRequiredProviderId('openai', chatgpt(true))).toBe('chatgpt')
  })

  it('does NOT claim the vendor while the opencode route is disabled', () => {
    expect(authRequiredProviderId('openai', chatgpt(false))).toBe('opencode:openai')
  })

  it('namespaces every other vendor under the engine that owns it', () => {
    expect(authRequiredProviderId('anthropic', chatgpt(true))).toBe('opencode:anthropic')
    expect(authRequiredProviderId('openai', undefined)).toBe('opencode:openai')
  })
})
