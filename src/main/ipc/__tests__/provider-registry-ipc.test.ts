/**
 * @vitest-environment node
 *
 * ADR-065 phase 6a — `provider-registry:list`.
 *
 * The channel is declared ONCE, in `core/ipc/auth-commands.ts`, and both
 * transports spread that declaration — `remote-channel-parity.test.ts` and
 * `remote-handlers.ipc.test.ts` pin the reachability half. What THIS file pins
 * is the registration itself: the capability/kind pair the two registrars
 * inherit, and that the handler answers the service verbatim rather than
 * reshaping it at the boundary (the read model's rules live in
 * `core/shared-providers/__tests__/provider-registry.test.ts`, and a second
 * projection here would be a second place for them to drift).
 *
 * The service is mocked, exactly as the trust-list perimeter test mocks
 * `ui-config` — nothing here should read a real provider store.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ProviderRegistrySnapshot } from '../../../shared/provider-registry'

const snapshot: ProviderRegistrySnapshot = {
  entries: [
    {
      id: 'anthropic',
      name: 'Anthropic',
      origin: 'anthropic',
      credential: 'signed-in',
      engines: { claude: { enabled: true } }
    }
  ],
  opencodeInstalled: false
}

const registryMocks = vi.hoisted(() => ({ listProviderRegistry: vi.fn() }))
vi.mock('../../../core/shared-providers/provider-registry', () => registryMocks)

// The auth family's other handlers close over this singleton; nothing in this
// file calls them, but importing the real module would pull the vault, the
// credential sync and both engine adapters into a node test that needs none.
vi.mock('../../../core/shared-providers', () => ({ sharedProviderService: {} }))
vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import { authCommands, type AuthCommandDeps } from '../../../core/ipc/auth-commands'

const commands = authCommands({
  requireEngineAuth: () => {
    throw new Error('not used')
  },
  setAccountEnabled: () => {
    throw new Error('not used')
  }
} as unknown as AuthCommandDeps)

function commandFor(channel: string): (typeof commands)[number] {
  const found = commands.find((c) => c.channel === channel)
  if (!found) throw new Error(`no registration for ${channel}`)
  return found
}

beforeEach(() => {
  registryMocks.listProviderRegistry.mockReset()
  registryMocks.listProviderRegistry.mockResolvedValue(snapshot)
})

describe('provider-registry:list', () => {
  it('is a `config` query', () => {
    expect(commandFor('provider-registry:list')).toMatchObject({
      capability: 'config',
      kind: 'query'
    })
  })

  it('answers the service verbatim, inside the safeHandler envelope', async () => {
    const handler = commandFor('provider-registry:list').handler as () => Promise<unknown>
    await expect(handler()).resolves.toEqual({ ok: true, data: snapshot })
    expect(registryMocks.listProviderRegistry).toHaveBeenCalledTimes(1)
  })

  it('carries a failure back as a refusal instead of an empty list', async () => {
    // The list composes three optional stores; a read that blows up must SAY so
    // — an empty provider page that looks like "you have no providers" is the
    // failure mode the envelope exists to prevent.
    registryMocks.listProviderRegistry.mockRejectedValueOnce(new Error('catalog unavailable'))
    const handler = commandFor('provider-registry:list').handler as () => Promise<unknown>
    await expect(handler()).resolves.toEqual({ ok: false, error: 'catalog unavailable' })
  })

  it('is declared exactly once in the shared family', () => {
    expect(commands.filter((c) => c.channel === 'provider-registry:list')).toHaveLength(1)
  })
})
