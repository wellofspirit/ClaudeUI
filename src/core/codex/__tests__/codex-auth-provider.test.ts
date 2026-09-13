import { describe, expect, it, vi } from 'vitest'
import { CodexAuthProvider } from '../../auth/CodexAuthProvider'
import type { CodexService } from '../CodexService'
import type { credentialSync } from '../../auth/vault/CredentialSync'

vi.mock('../codex-locate', () => ({ codexBinaryAvailable: () => true }))

/**
 * A token-free `getStatus()` stand-in. NEVER the real `credentialSync`: that
 * one reads the developer's own `~/.claude/ui/auth-vault.json`.
 */
const vaultWith = (
  accounts: Array<{ id: string; email?: string; planType?: string; needsReauth?: boolean }>,
  activeId: string | null = accounts[0]?.id ?? null
): Pick<typeof credentialSync, 'getStatus'> =>
  ({
    getStatus: vi.fn(async () => ({
      connected: accounts.length > 0,
      needsReauth: false,
      activeId,
      accounts: accounts.map((account) => ({
        id: account.id,
        ...(account.email ? { email: account.email } : {}),
        ...(account.planType ? { planType: account.planType } : {}),
        expiresAt: 0,
        needsReauth: account.needsReauth === true
      }))
    }))
  }) as unknown as Pick<typeof credentialSync, 'getStatus'>

describe('native auth provider', () => {
  it('only exposes safe account metadata; status does not start login', async () => {
    const service = {
      accountStatus: vi.fn(async () => ({
        available: true,
        authenticated: true,
        authKind: 'chatgpt',
        token: 'synthetic-do-not-forward'
      })),
      modelOptions: vi.fn(async () => ({ catalog: [] })),
      startLogin: vi.fn()
    }
    const provider = new CodexAuthProvider(service as unknown as CodexService, vaultWith([]))
    expect(await provider.status()).toEqual({
      available: true,
      authenticated: true,
      authKind: 'chatgpt',
      modelCount: 0
    })
    expect(await provider.probe()).toMatchObject({
      openai: { authState: 'authenticated', billingType: 'subscription' }
    })
    expect(service.startLogin).not.toHaveBeenCalled()
  })

  it('reports the vault account, not the native store, once one exists', async () => {
    // The identity every Codex process is injected with IS the vault's active
    // account (ADR-068 §1), so the native read must not be what the UI shows —
    // and must not even be reached.
    const service = { accountStatus: vi.fn(), modelOptions: vi.fn(), startLogin: vi.fn() }
    const provider = new CodexAuthProvider(
      service as unknown as CodexService,
      vaultWith([
        { id: 'acct-one', email: 'first@example.com', planType: 'pro' },
        { id: 'acct-two', email: 'second@example.com' }
      ])
    )
    expect(await provider.probe()).toEqual({
      openai: {
        authState: 'authenticated',
        billingType: 'subscription',
        requiresLogin: false,
        label: 'first@example.com'
      }
    })
    expect(service.accountStatus).not.toHaveBeenCalled()
  })

  it('a revoked active account asks for a sign-in rather than claiming health', async () => {
    const provider = new CodexAuthProvider(
      { accountStatus: vi.fn() } as unknown as CodexService,
      vaultWith([{ id: 'acct-one', email: 'first@example.com', needsReauth: true }])
    )
    expect(await provider.probe()).toMatchObject({
      openai: { authState: 'unauthenticated', requiresLogin: true }
    })
  })

  it('has no product login surface left', () => {
    const provider = new CodexAuthProvider(
      { accountStatus: vi.fn() } as unknown as CodexService,
      vaultWith([])
    )
    // ADR-068 §1: the device-code flow survives only inside `CodexService` as
    // tested code. Nothing on the provider (and so nothing on any channel) can
    // start, poll or cancel a native login any more.
    for (const name of ['loginStart', 'loginStatus', 'loginCancel']) {
      expect(name in provider, `${name} is still reachable`).toBe(false)
    }
  })
})
