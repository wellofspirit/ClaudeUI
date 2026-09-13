/**
 * @vitest-environment node
 *
 * ADR-068 §2 — the `provider-account:*` family.
 *
 * Declared ONCE in `core/ipc/auth-commands.ts`, so both transports spread the
 * same four registrations (the remote half is pinned in
 * `remote-handlers.ipc.test.ts`). What this file pins is the registration
 * itself: capability/kind, which store each verb writes to, the refusal for a
 * provider that has no accounts, and — the guard that matters most — that not
 * one of them can carry token material back to a caller.
 *
 * The vault and the provider service are MOCKED, like `provider-registry-ipc`'s
 * own registry mock: nothing here may read the real `~/.claude/ui`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const syncMocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  switchActiveAccount: vi.fn(),
  removeAccount: vi.fn()
}))
const serviceMocks = vi.hoisted(() => ({
  listDefinitions: vi.fn(),
  setAccountsPerSession: vi.fn()
}))

vi.mock('../../../core/auth/vault/CredentialSync', () => ({
  credentialSync: syncMocks,
  CredentialSync: class {}
}))
vi.mock('../../../core/shared-providers', () => ({ sharedProviderService: serviceMocks }))
vi.mock('../../../core/shared-providers/provider-registry', () => ({
  listProviderRegistry: vi.fn()
}))
vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import { authCommands, type AuthCommandDeps } from '../../../core/ipc/auth-commands'
import type { SharedProviderDefinition } from '../../../shared/shared-provider'

const chatgpt: SharedProviderDefinition = {
  id: 'chatgpt',
  name: 'ChatGPT',
  kind: 'subscription',
  models: [],
  managed: true,
  routes: {
    pi: { enabled: true, providerId: 'openai-codex' },
    opencode: { enabled: true, providerId: 'openai' }
  },
  accounts: { perSession: true }
}

const custom: SharedProviderDefinition = {
  id: 'ollama-local',
  name: 'Ollama',
  kind: 'custom',
  protocol: 'openai-completions',
  baseUrl: 'http://localhost:11434',
  models: [],
  managed: true,
  routes: { pi: { enabled: true }, opencode: { enabled: false } }
}

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

const call = async (channel: string, ...args: unknown[]): Promise<unknown> =>
  (commandFor(channel).handler as (...a: unknown[]) => Promise<unknown>)(...args)

beforeEach(() => {
  for (const mock of [...Object.values(syncMocks), ...Object.values(serviceMocks)]) mock.mockReset()
  serviceMocks.listDefinitions.mockReturnValue([chatgpt, custom])
  syncMocks.getStatus.mockResolvedValue({
    connected: true,
    email: 'owner@example.test',
    accountId: 'ws-1',
    expiresAt: 4_242,
    needsReauth: false,
    activeId: 'acc-1',
    accounts: [
      {
        id: 'acc-1',
        email: 'owner@example.test',
        accountId: 'ws-1',
        planType: 'pro',
        expiresAt: 4_242,
        needsReauth: false
      },
      { id: 'acc-2', accountId: 'ws-2', expiresAt: 7_000, needsReauth: true }
    ]
  })
  syncMocks.switchActiveAccount.mockResolvedValue(undefined)
  syncMocks.removeAccount.mockResolvedValue(undefined)
  serviceMocks.setAccountsPerSession.mockResolvedValue(undefined)
})

describe('provider-account:* registrations', () => {
  it('are four `config` commands, declared exactly once each', () => {
    expect(commandFor('provider-account:list')).toMatchObject({
      capability: 'config',
      kind: 'query'
    })
    for (const channel of [
      'provider-account:switch',
      'provider-account:remove',
      'provider-account:set-per-session'
    ]) {
      expect(commandFor(channel)).toMatchObject({ capability: 'config', kind: 'command' })
      expect(commands.filter((c) => c.channel === channel)).toHaveLength(1)
    }
  })
})

describe('provider-account:list', () => {
  it('answers the vault status plus the definition’s per-session flag', async () => {
    await expect(call('provider-account:list', 'chatgpt')).resolves.toEqual({
      ok: true,
      data: {
        activeId: 'acc-1',
        perSession: true,
        accounts: [
          {
            id: 'acc-1',
            email: 'owner@example.test',
            accountId: 'ws-1',
            planType: 'pro',
            expiresAt: 4_242,
            needsReauth: false
          },
          { id: 'acc-2', accountId: 'ws-2', expiresAt: 7_000, needsReauth: true }
        ]
      }
    })
  })

  it('carries NO token material (the whole family is ids, emails and plans)', async () => {
    // Even if the status ever grew a token field, the handler must not pass it on.
    syncMocks.getStatus.mockResolvedValue({
      connected: true,
      needsReauth: false,
      activeId: 'acc-1',
      accounts: [
        {
          id: 'acc-1',
          email: 'owner@example.test',
          expiresAt: 1,
          needsReauth: false,
          access: 'secret-access',
          refresh: 'secret-refresh'
        }
      ]
    })
    const result = await call('provider-account:list', 'chatgpt')
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('secret-')
    expect(serialized).not.toContain('"access"')
    expect(serialized).not.toContain('"refresh"')
  })

  it('refuses a provider that has no accounts, rather than inventing an empty list', async () => {
    await expect(call('provider-account:list', 'ollama-local')).resolves.toMatchObject({
      ok: false
    })
    await expect(call('provider-account:list', 'nope')).resolves.toMatchObject({ ok: false })
  })
})

describe('provider-account mutations', () => {
  it('switch and remove route to the vault’s sync, by account id', async () => {
    await expect(call('provider-account:switch', 'chatgpt', 'acc-2')).resolves.toEqual({
      ok: true,
      data: undefined
    })
    expect(syncMocks.switchActiveAccount).toHaveBeenCalledWith('acc-2')

    await call('provider-account:remove', 'chatgpt', 'acc-2')
    expect(syncMocks.removeAccount).toHaveBeenCalledWith('acc-2')
  })

  it('set-per-session routes to the definition writer', async () => {
    await call('provider-account:set-per-session', 'chatgpt', true)
    expect(serviceMocks.setAccountsPerSession).toHaveBeenCalledWith('chatgpt', true)
  })

  it('refuses every mutation for a provider with no accounts', async () => {
    await expect(call('provider-account:switch', 'ollama-local', 'x')).resolves.toMatchObject({
      ok: false
    })
    await expect(call('provider-account:remove', 'ollama-local', 'x')).resolves.toMatchObject({
      ok: false
    })
    await expect(
      call('provider-account:set-per-session', 'ollama-local', true)
    ).resolves.toMatchObject({ ok: false })
    expect(syncMocks.switchActiveAccount).not.toHaveBeenCalled()
    expect(syncMocks.removeAccount).not.toHaveBeenCalled()
    expect(serviceMocks.setAccountsPerSession).not.toHaveBeenCalled()
  })

  it('carries a failure back as a refusal instead of a silent no-op', async () => {
    syncMocks.switchActiveAccount.mockRejectedValueOnce(new Error('Unknown vault account: gone'))
    await expect(call('provider-account:switch', 'chatgpt', 'gone')).resolves.toEqual({
      ok: false,
      error: 'Unknown vault account: gone'
    })
  })
})
