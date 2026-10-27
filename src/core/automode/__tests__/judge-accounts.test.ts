/**
 * The synchronous snapshot of the vault's ChatGPT accounts the fallback judge's owners read: what a
 * refresh keeps (ids and plan types, nothing token-shaped), and that a failed refresh leaves the
 * last answer standing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getActiveAccountId, listAccounts } = vi.hoisted(() => ({
  getActiveAccountId: vi.fn(),
  listAccounts: vi.fn()
}))
vi.mock('../../auth/vault/AuthVault', () => ({
  CHATGPT_PROVIDER_ID: 'chatgpt',
  authVault: { getActiveAccountId, listAccounts }
}))

import {
  activeChatgptAccountId,
  chatgptAccountPlan,
  refreshChatgptAccounts,
  resetChatgptAccounts
} from '../judge-accounts'

beforeEach(() => {
  vi.clearAllMocks()
  resetChatgptAccounts()
})

describe('judge-accounts', () => {
  it('knows nothing before a refresh', () => {
    expect(activeChatgptAccountId()).toBeNull()
    expect(chatgptAccountPlan('acct-biz')).toBeUndefined()
  })

  it('reads the active account and each account plan from the vault, keeping no credential', async () => {
    getActiveAccountId.mockResolvedValue('acct-plus')
    listAccounts.mockResolvedValue([
      {
        id: 'acct-plus',
        email: 'someone@example.test',
        planType: 'plus',
        credential: { access: 'tok-a', refresh: 'tok-r', expires: 1 },
        addedAt: 1
      },
      { id: 'acct-biz', planType: 'business', credential: { access: 'tok-b' }, addedAt: 2 },
      { id: 'acct-none', credential: { access: 'tok-c' }, addedAt: 3 }
    ])
    await refreshChatgptAccounts()

    expect(getActiveAccountId).toHaveBeenCalledWith('chatgpt')
    expect(listAccounts).toHaveBeenCalledWith('chatgpt')
    expect(activeChatgptAccountId()).toBe('acct-plus')
    expect(chatgptAccountPlan('acct-biz')).toBe('business')
    expect(chatgptAccountPlan('acct-none')).toBeUndefined()
    expect(chatgptAccountPlan('removed')).toBeUndefined()
  })

  it('a failed refresh keeps the previous snapshot and never throws', async () => {
    await refreshChatgptAccounts(async () => ({
      activeId: 'acct-plus',
      accounts: [{ id: 'acct-biz', planType: 'business' }]
    }))
    await expect(
      refreshChatgptAccounts(async () => {
        throw new Error('vault unreadable')
      })
    ).resolves.toBeUndefined()
    expect(activeChatgptAccountId()).toBe('acct-plus')
    expect(chatgptAccountPlan('acct-biz')).toBe('business')
  })

  it('a later refresh replaces the snapshot (the active account moved, one was removed)', async () => {
    await refreshChatgptAccounts(async () => ({
      activeId: 'acct-plus',
      accounts: [{ id: 'acct-biz', planType: 'business' }]
    }))
    await refreshChatgptAccounts(async () => ({ activeId: 'acct-biz', accounts: [] }))
    expect(activeChatgptAccountId()).toBe('acct-biz')
    expect(chatgptAccountPlan('acct-biz')).toBeUndefined()
  })
})
