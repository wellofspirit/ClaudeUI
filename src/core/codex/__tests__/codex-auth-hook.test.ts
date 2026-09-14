// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { codexAuthHook, type CodexAuthSource } from '../codex-auth-hook'

/**
 * Slice 2a guard 2 — answering `account/chatgptAuthTokens/refresh`.
 *
 * The app-server sends the WORKSPACE id it was using as `previousAccountId`, not
 * our vault account id, and gives the host ten seconds. Everything here runs
 * against a fake source: no vault, no network, and every token string obviously
 * synthetic.
 */
function source(
  accounts: Array<{ id: string; workspace: string; token: string | null; plan?: string }>
): { source: CodexAuthSource; calls: Array<[string | null, number | undefined]> } {
  const calls: Array<[string | null, number | undefined]> = []
  return {
    calls,
    source: {
      injectionTokenFor: vi.fn(async (accountId: string | null, refreshMarginMs?: number) => {
        calls.push([accountId, refreshMarginMs])
        const account =
          accountId === null ? accounts[0] : accounts.find((entry) => entry.id === accountId)
        if (!account?.token) return null
        return {
          accessToken: account.token,
          chatgptAccountId: account.workspace,
          chatgptPlanType: account.plan ?? null,
          vaultAccountId: account.id
        }
      }),
      getStatus: vi.fn(async () => ({
        accounts: accounts.map((entry) => ({ id: entry.id, accountId: entry.workspace }))
      }))
    }
  }
}

const refresh = (previousAccountId: string | null): unknown => ({
  reason: 'unauthorized',
  previousAccountId
})

describe('the Codex auth hook', () => {
  it('injects the account it was asked for and remembers it', async () => {
    const fake = source([
      { id: 'acct-a', workspace: 'ws-a', token: 'fake-a', plan: 'pro' },
      { id: 'acct-b', workspace: 'ws-b', token: 'fake-b' }
    ])
    const hook = codexAuthHook({ accountId: 'acct-b', source: fake.source })
    expect(hook.injectedAccountId).toBeNull()

    await expect(hook.inject()).resolves.toMatchObject({
      accessToken: 'fake-b',
      chatgptAccountId: 'ws-b',
      chatgptPlanType: null,
      vaultAccountId: 'acct-b'
    })
    expect(hook.injectedAccountId).toBe('acct-b')
    // The INJECT half uses the default margin; only the refresh half narrows it.
    expect(fake.calls).toEqual([['acct-b', undefined]])
  })

  it('answers previousAccountId by WORKSPACE, from cache', async () => {
    const fake = source([
      { id: 'acct-a', workspace: 'ws-a', token: 'fake-a' },
      { id: 'acct-b', workspace: 'ws-b', token: 'fake-b', plan: 'plus' }
    ])
    const hook = codexAuthHook({ source: fake.source })
    await hook.inject()

    await expect(hook.onRefreshRequest(refresh('ws-b'))).resolves.toEqual({
      accessToken: 'fake-b',
      chatgptAccountId: 'ws-b',
      chatgptPlanType: 'plus'
    })
    // Margin 0: Codex waits 10 s, so only a genuinely expired token is worth a
    // network round trip.
    expect(fake.calls.at(-1)).toEqual(['acct-b', 0])
    expect(hook.injectedAccountId).toBe('acct-b')
  })

  it('falls back to the injected account when the workspace hint is unknown', async () => {
    const fake = source([
      { id: 'acct-a', workspace: 'ws-a', token: 'fake-a' },
      { id: 'acct-b', workspace: 'ws-b', token: 'fake-b' }
    ])
    const hook = codexAuthHook({ accountId: 'acct-b', source: fake.source })
    await hook.inject()

    await expect(hook.onRefreshRequest(refresh('ws-gone'))).resolves.toMatchObject({
      chatgptAccountId: 'ws-b'
    })
    await expect(hook.onRefreshRequest(refresh(null))).resolves.toMatchObject({
      chatgptAccountId: 'ws-b'
    })
  })

  it('falls through to the ACTIVE account when the injected one is gone', async () => {
    const fake = source([
      { id: 'acct-a', workspace: 'ws-a', token: 'fake-a' },
      { id: 'acct-b', workspace: 'ws-b', token: null }
    ])
    const hook = codexAuthHook({ accountId: 'acct-b', source: fake.source })
    // Nothing to inject for acct-b, so the process ran on the native store…
    await expect(hook.inject()).resolves.toBeNull()
    // …and a refresh request still gets the honest current answer.
    await expect(hook.onRefreshRequest(refresh('ws-b'))).resolves.toMatchObject({
      chatgptAccountId: 'ws-a'
    })
  })

  it('a revoked account answers an error and rings onAuthRequired once', async () => {
    const fake = source([{ id: 'acct-a', workspace: 'ws-a', token: 'fake-a' }])
    const authRequired = vi.fn()
    const hook = codexAuthHook({ source: fake.source, onAuthRequired: authRequired })
    await hook.inject()
    fake.source.injectionTokenFor = vi.fn(async () => null)

    await expect(hook.onRefreshRequest(refresh('ws-a'))).rejects.toThrow(
      'No ChatGPT account can answer the Codex token refresh'
    )
    expect(authRequired).toHaveBeenCalledExactlyOnceWith('acct-a')
  })

  it('a failing status read is a lost hint, not a refusal', async () => {
    const fake = source([{ id: 'acct-a', workspace: 'ws-a', token: 'fake-a' }])
    fake.source.getStatus = vi.fn(async () => {
      throw new Error('vault unreadable')
    })
    const hook = codexAuthHook({ source: fake.source })
    await hook.inject()
    await expect(hook.onRefreshRequest(refresh('ws-a'))).resolves.toMatchObject({
      chatgptAccountId: 'ws-a'
    })
  })
})
