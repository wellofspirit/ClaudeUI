/**
 * @vitest-environment node
 *
 * Which provider a rejected engine credential belongs to (ADR-068 §4).
 *
 * Each engine knows its vendors by ITS OWN ids (opencode says `openai`, pi says
 * `openai-codex`), and the shared ChatGPT definition is what says that id is the
 * vault's subscription on that engine. The mapping therefore has to read the
 * definition, and it has to read the ROUTE: a disabled route means the
 * credential that engine holds is the user's own, not the vault's, and offering
 * the vault sign-in for it would re-vend a credential that is not the one that
 * failed.
 *
 * The pure half is tested here with hand-built definitions; nothing touches
 * `~/.claude/ui/providers`.
 */
import { describe, it, expect } from 'vitest'
import { authRequiredProviderId } from '../chatgpt-route'
import type { SharedProviderDefinition } from '../../../shared/shared-provider'

function chatgpt(routes: { pi?: boolean; opencode?: boolean } = {}): SharedProviderDefinition {
  return {
    id: 'chatgpt',
    name: 'ChatGPT',
    kind: 'subscription',
    models: [],
    managed: true,
    routes: {
      pi: { enabled: routes.pi ?? true, providerId: 'openai-codex' },
      opencode: { enabled: routes.opencode ?? true, providerId: 'openai' }
    }
  }
}

describe('authRequiredProviderId — opencode vendor → auth-required provider', () => {
  it('maps the shared route’s opencode id onto the vault provider', () => {
    expect(authRequiredProviderId('openai', chatgpt(), 'opencode')).toBe('chatgpt')
  })

  it('does NOT claim the vendor while the opencode route is disabled', () => {
    expect(authRequiredProviderId('openai', chatgpt({ opencode: false }), 'opencode')).toBe(
      'opencode:openai'
    )
  })

  it('namespaces every other vendor under the engine that owns it', () => {
    expect(authRequiredProviderId('anthropic', chatgpt(), 'opencode')).toBe('opencode:anthropic')
    expect(authRequiredProviderId('openai', undefined, 'opencode')).toBe('opencode:openai')
  })
})

describe('authRequiredProviderId — pi vendor → auth-required provider', () => {
  it('maps the shared route’s pi id (`openai-codex`) onto the vault provider', () => {
    expect(authRequiredProviderId('openai-codex', chatgpt(), 'pi')).toBe('chatgpt')
  })

  /**
   * The load-bearing half of this module: with the pi route OFF, the
   * `openai-codex` entry in `~/.pi/agent/auth.json` is one the user wrote with
   * `pi /login`, never one the vault fed. Offering the vault sign-in would
   * re-vend a credential that is not the one that failed — so it stays
   * namespaced and the row opens Settings › Models & providers instead.
   */
  it('does NOT claim the vendor while the pi route is disabled', () => {
    expect(authRequiredProviderId('openai-codex', chatgpt({ pi: false }), 'pi')).toBe(
      'pi:openai-codex'
    )
  })

  it('namespaces a pi vendor under `pi:`, never under `opencode:`', () => {
    expect(authRequiredProviderId('anthropic', chatgpt(), 'pi')).toBe('pi:anthropic')
    expect(authRequiredProviderId('github-copilot', undefined, 'pi')).toBe('pi:github-copilot')
  })

  /**
   * The two harnesses do not share a route: opencode's `openai` means nothing to
   * pi, and pi's `openai-codex` means nothing to opencode. Reading the wrong
   * route would hand one engine's rejection the other engine's answer.
   */
  it('never lets one harness’s vendor id claim the other harness’s route', () => {
    expect(authRequiredProviderId('openai', chatgpt(), 'pi')).toBe('pi:openai')
    expect(authRequiredProviderId('openai-codex', chatgpt(), 'opencode')).toBe(
      'opencode:openai-codex'
    )
  })
})
