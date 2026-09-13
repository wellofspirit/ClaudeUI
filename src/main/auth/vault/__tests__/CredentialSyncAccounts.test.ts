/**
 * @vitest-environment node
 *
 * ADR-068 §2 / slice 1 — CredentialSync with N accounts.
 *
 * The single-account lifecycle (retry chain, give-up backoff, reconcile-on-start,
 * disconnect generations) stays pinned in `CredentialSync.test.ts`. What is new
 * here is the plural: one refresh timer PER stored account, the ACTIVE account
 * as the only thing pi and opencode are ever fed, switching and removing, and a
 * status that says all of it without carrying a token.
 *
 * SAFETY: `node:os`.homedir is mocked to a temp directory so the REAL
 * `AuthVault` can be used with real storage semantics and no access to the real
 * `~/.claude/ui`. Every refresh goes through an injected fake — nothing here
 * reaches auth.openai.com — and every token string is an obvious fake.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = vi.hoisted(() => ({ value: '' }))
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, homedir: () => home.value, default: { ...actual, homedir: () => home.value } }
})

import { AuthVault, CHATGPT_PROVIDER_ID } from '../../../../core/auth/vault/AuthVault'
import {
  CredentialSync,
  REFRESH_MARGIN_MS,
  type CodexCredentialInput,
  type CodexEntrySnapshot,
  type CodexFeedTarget
} from '../../../../core/auth/vault/CredentialSync'
import type { VaultCredential } from '../../../../core/auth/vault/codex-oauth'

let testHome: string
beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), 'credential-sync-accounts-'))
  home.value = testHome
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(testHome, { recursive: true, force: true })
})

function cred(over: Partial<VaultCredential> & { ws?: string } = {}): VaultCredential {
  const { ws, ...rest } = over
  return {
    type: 'oauth',
    access: 'fake-access',
    refresh: 'fake-refresh',
    expires: 1_000,
    ...(ws ? { accountId: ws } : {}),
    ...rest
  }
}

/** A spy feed target whose auth file never exists, so no fs.watch is armed. */
function fakeTarget(): {
  target: CodexFeedTarget
  feed: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
} {
  const feed = vi.fn(async (_vendorId: string, _cred: CodexCredentialInput) => {})
  const remove = vi.fn(async (_vendorId: string) => {})
  return {
    target: {
      authFilePath: () => join(testHome, 'no-such-dir', 'auth.json'),
      feedOauthCredential: feed,
      readOauthEntry: vi.fn(async (): Promise<CodexEntrySnapshot | null> => null),
      removeVendorAuth: remove
    },
    feed,
    remove
  }
}

/** A feed target whose store already holds `entry` (an engine-rotated token). */
function targetHolding(entry: CodexEntrySnapshot | null): CodexFeedTarget {
  return {
    authFilePath: () => join(testHome, 'no-such-dir', 'auth.json'),
    feedOauthCredential: vi.fn(async () => {}),
    readOauthEntry: vi.fn(async () => entry),
    removeVendorAuth: vi.fn(async () => {})
  }
}

// ---------------------------------------------------------------------------
// Guard 4 — per-account refresh schedules, active-only feed, per-account reauth
// ---------------------------------------------------------------------------

describe('CredentialSync — per-account refresh', () => {
  it('refreshes each account on its OWN schedule and feeds only the ACTIVE one', async () => {
    vi.useFakeTimers()
    const now = Date.now()
    const vault = new AuthVault()
    const active = await vault.upsertAccount(
      CHATGPT_PROVIDER_ID,
      cred({ ws: 'ws-a', refresh: 'fake-ra', expires: now + REFRESH_MARGIN_MS + 1_000 })
    )
    const other = await vault.upsertAccount(
      CHATGPT_PROVIDER_ID,
      cred({ ws: 'ws-b', refresh: 'fake-rb', expires: now + REFRESH_MARGIN_MS + 60_000 })
    )
    const refreshAccessToken = vi.fn(async (refresh: string) => ({
      access_token: `${refresh}-next-access`,
      refresh_token: `${refresh}-next`,
      expires_in: 3600
    }))
    const pi = fakeTarget()
    const opencode = fakeTarget()
    const sync = new CredentialSync({ vault, refreshAccessToken })
    sync.configure({ pi: pi.target, opencode: opencode.target })

    await sync.start()
    pi.feed.mockClear()
    opencode.feed.mockClear()

    await vi.advanceTimersByTimeAsync(1_001)
    expect(refreshAccessToken.mock.calls.map((c) => c[0])).toEqual(['fake-ra'])
    // The ACTIVE account's rotation reaches both engines.
    expect(pi.feed).toHaveBeenCalledWith(
      'openai-codex',
      expect.objectContaining({ refresh: 'fake-ra-next' })
    )
    pi.feed.mockClear()
    opencode.feed.mockClear()

    await vi.advanceTimersByTimeAsync(59_000)
    expect(refreshAccessToken.mock.calls.map((c) => c[0])).toEqual(['fake-ra', 'fake-rb'])
    // The BACKGROUND account's rotation does NOT: the engine stores are single-slot.
    expect(pi.feed).not.toHaveBeenCalled()
    expect(opencode.feed).not.toHaveBeenCalled()

    const accounts = await vault.listAccounts(CHATGPT_PROVIDER_ID)
    expect(accounts.find((a) => a.id === active.id)?.credential.refresh).toBe('fake-ra-next')
    expect(accounts.find((a) => a.id === other.id)?.credential.refresh).toBe('fake-rb-next')
    sync.stop()
  })

  it('a revoked refresh marks THAT account needsReauth and leaves the other alone', async () => {
    vi.useFakeTimers()
    const now = Date.now()
    const vault = new AuthVault()
    const active = await vault.upsertAccount(
      CHATGPT_PROVIDER_ID,
      cred({ ws: 'ws-a', refresh: 'fake-ra', expires: now + REFRESH_MARGIN_MS + 60_000 })
    )
    const other = await vault.upsertAccount(
      CHATGPT_PROVIDER_ID,
      cred({ ws: 'ws-b', refresh: 'fake-rb', expires: now + REFRESH_MARGIN_MS + 1_000 })
    )
    const refreshAccessToken = vi.fn(async (refresh: string) => {
      if (refresh === 'fake-rb') {
        throw new Error('Token refresh failed: 400 - {"error":"invalid_grant"}')
      }
      return { access_token: 'x', refresh_token: 'y', expires_in: 3600 }
    })
    const sync = new CredentialSync({ vault, refreshAccessToken })
    sync.configure({ pi: fakeTarget().target, opencode: fakeTarget().target })

    await sync.start()
    await vi.advanceTimersByTimeAsync(1_001)

    const status = await sync.getStatus()
    expect(status.accounts.find((a) => a.id === other.id)?.needsReauth).toBe(true)
    expect(status.accounts.find((a) => a.id === active.id)?.needsReauth).toBe(false)
    // The top-level flag is the ACTIVE account's — a dead background account
    // must not make the connected one look broken.
    expect(status.needsReauth).toBe(false)
    expect(sync.needsReauth).toBe(false)
    sync.stop()
  })
})

// ---------------------------------------------------------------------------
// Guard 3 (lifecycle half) — removeAccount / switchActiveAccount
// ---------------------------------------------------------------------------

describe('CredentialSync.removeAccount', () => {
  it('promotes the newest remaining account and FEEDS it when the active one is removed', async () => {
    const vault = new AuthVault()
    const active = await vault.upsertAccount(CHATGPT_PROVIDER_ID, cred({ ws: 'ws-a' }))
    const newer = await vault.upsertAccount(
      CHATGPT_PROVIDER_ID,
      cred({ ws: 'ws-b', access: 'fake-b', refresh: 'fake-rb' })
    )
    const pi = fakeTarget()
    const opencode = fakeTarget()
    const onActiveAccountChanged = vi.fn()
    const sync = new CredentialSync({ vault, onActiveAccountChanged })
    sync.configure({ pi: pi.target, opencode: opencode.target })

    await sync.removeAccount(active.id)

    await expect(vault.getActiveAccountId(CHATGPT_PROVIDER_ID)).resolves.toBe(newer.id)
    // The engines were re-pointed, so opencode must drop the in-process
    // credential it is still holding for the removed account (ADR-047).
    expect(onActiveAccountChanged).toHaveBeenCalledTimes(1)
    expect(pi.feed).toHaveBeenCalledWith(
      'openai-codex',
      expect.objectContaining({ refresh: 'fake-rb' })
    )
    expect(opencode.feed).toHaveBeenCalledWith(
      'openai',
      expect.objectContaining({ refresh: 'fake-rb' })
    )
    expect(pi.remove).not.toHaveBeenCalled()
    sync.stop()
  })

  it('removing the LAST account removes both engine copies', async () => {
    const vault = new AuthVault()
    const only = await vault.upsertAccount(CHATGPT_PROVIDER_ID, cred({ ws: 'ws-a' }))
    const pi = fakeTarget()
    const opencode = fakeTarget()
    const onActiveAccountChanged = vi.fn()
    const sync = new CredentialSync({ vault, onActiveAccountChanged })
    sync.configure({ pi: pi.target, opencode: opencode.target })

    await sync.removeAccount(only.id)

    await expect(vault.listAccounts(CHATGPT_PROVIDER_ID)).resolves.toEqual([])
    expect(pi.remove).toHaveBeenCalledWith('openai-codex')
    expect(opencode.remove).toHaveBeenCalledWith('openai')
    expect(pi.feed).not.toHaveBeenCalled()
    // Nothing left to vend: opencode must drop the credential it holds, so the
    // hook fires on this path too.
    expect(onActiveAccountChanged).toHaveBeenCalledTimes(1)
    sync.stop()
  })

  it('removing a NON-active account changes neither the active id nor the engine stores', async () => {
    const vault = new AuthVault()
    const active = await vault.upsertAccount(CHATGPT_PROVIDER_ID, cred({ ws: 'ws-a' }))
    const other = await vault.upsertAccount(
      CHATGPT_PROVIDER_ID,
      cred({ ws: 'ws-b', refresh: 'fake-rb' })
    )
    const pi = fakeTarget()
    const onActiveAccountChanged = vi.fn()
    const sync = new CredentialSync({ vault, onActiveAccountChanged })
    sync.configure({ pi: pi.target, opencode: fakeTarget().target })

    await sync.removeAccount(other.id)

    await expect(vault.getActiveAccountId(CHATGPT_PROVIDER_ID)).resolves.toBe(active.id)
    expect(pi.feed).not.toHaveBeenCalled()
    expect(pi.remove).not.toHaveBeenCalled()
    // Nothing the engines hold changed, so recycling opencode would be churn.
    expect(onActiveAccountChanged).not.toHaveBeenCalled()
    sync.stop()
  })
})

describe('CredentialSync.switchActiveAccount', () => {
  it('re-vends both engine stores from the new active credential and rings the hook', async () => {
    const vault = new AuthVault()
    await vault.upsertAccount(CHATGPT_PROVIDER_ID, cred({ ws: 'ws-a' }))
    const target = await vault.upsertAccount(
      CHATGPT_PROVIDER_ID,
      cred({ ws: 'ws-b', access: 'fake-b', refresh: 'fake-rb' })
    )
    const onActiveAccountChanged = vi.fn()
    const pi = fakeTarget()
    const opencode = fakeTarget()
    const sync = new CredentialSync({ vault, onActiveAccountChanged })
    sync.configure({ pi: pi.target, opencode: opencode.target })

    await sync.switchActiveAccount(target.id)

    await expect(vault.getActiveAccountId(CHATGPT_PROVIDER_ID)).resolves.toBe(target.id)
    expect(pi.feed).toHaveBeenCalledWith(
      'openai-codex',
      expect.objectContaining({ refresh: 'fake-rb' })
    )
    expect(opencode.feed).toHaveBeenCalledWith(
      'openai',
      expect.objectContaining({ refresh: 'fake-rb' })
    )
    expect(onActiveAccountChanged).toHaveBeenCalledTimes(1)
    sync.stop()
  })

  it('refuses an unknown account id rather than leaving the engines pointed at nothing', async () => {
    const vault = new AuthVault()
    await vault.upsertAccount(CHATGPT_PROVIDER_ID, cred({ ws: 'ws-a' }))
    const pi = fakeTarget()
    const sync = new CredentialSync({ vault })
    sync.configure({ pi: pi.target, opencode: fakeTarget().target })
    await expect(sync.switchActiveAccount('nope')).rejects.toThrow(/account/i)
    expect(pi.feed).not.toHaveBeenCalled()
    sync.stop()
  })
})

// ---------------------------------------------------------------------------
// Guard 5 — fs-watch / reconcile adoption touches the ACTIVE account only
// ---------------------------------------------------------------------------

describe('CredentialSync adoption with several accounts', () => {
  it('adopts an engine-rotated credential into the ACTIVE account, never into another', async () => {
    const vault = new AuthVault()
    const active = await vault.upsertAccount(
      CHATGPT_PROVIDER_ID,
      cred({ ws: 'ws-a', refresh: 'fake-ra', expires: 10_000 })
    )
    const other = await vault.upsertAccount(
      CHATGPT_PROVIDER_ID,
      cred({ ws: 'ws-b', refresh: 'fake-rb', expires: 10_000 })
    )
    const sync = new CredentialSync({ vault })
    sync.configure({
      // pi's store holds a strictly-newer, different credential — the engine
      // rotated it while ClaudeUI was closed.
      pi: targetHolding({ access: 'fake-rotated', refresh: 'fake-rotated-r', expires: 99_000 }),
      opencode: targetHolding(null)
    })

    await sync.start()

    const accounts = await vault.listAccounts(CHATGPT_PROVIDER_ID)
    expect(accounts.find((a) => a.id === active.id)?.credential).toMatchObject({
      refresh: 'fake-rotated-r',
      expires: 99_000
    })
    expect(accounts.find((a) => a.id === other.id)?.credential).toMatchObject({
      refresh: 'fake-rb',
      expires: 10_000
    })
    await expect(vault.getActiveAccountId(CHATGPT_PROVIDER_ID)).resolves.toBe(active.id)
    sync.stop()
  })
})

// ---------------------------------------------------------------------------
// Guard 6 (status half) — no token material
// ---------------------------------------------------------------------------

describe('CredentialSync.getStatus with accounts', () => {
  it('reports every account plus the active id, and no access/refresh anywhere', async () => {
    const vault = new AuthVault()
    const a = await vault.upsertAccount(
      CHATGPT_PROVIDER_ID,
      cred({
        ws: 'ws-a',
        access: 'secret-access-a',
        refresh: 'secret-refresh-a',
        email: 'owner@example.test',
        planType: 'pro',
        expires: 4_242
      })
    )
    const b = await vault.upsertAccount(
      CHATGPT_PROVIDER_ID,
      cred({ ws: 'ws-b', access: 'secret-access-b', refresh: 'secret-refresh-b', expires: 7_000 })
    )
    const sync = new CredentialSync({ vault })
    sync.configure({ pi: fakeTarget().target, opencode: fakeTarget().target })

    const status = await sync.getStatus()

    expect(status.activeId).toBe(a.id)
    expect(status.connected).toBe(true)
    expect(status.email).toBe('owner@example.test')
    expect(status.accounts).toEqual([
      {
        id: a.id,
        email: 'owner@example.test',
        accountId: 'ws-a',
        planType: 'pro',
        expiresAt: 4_242,
        needsReauth: false
      },
      { id: b.id, accountId: 'ws-b', expiresAt: 7_000, needsReauth: false }
    ])
    expect(JSON.stringify(status)).not.toContain('secret-')
    sync.stop()
  })

  it('an empty vault reports no accounts and no active id', async () => {
    const sync = new CredentialSync({ vault: new AuthVault() })
    sync.configure({ pi: fakeTarget().target, opencode: fakeTarget().target })
    await expect(sync.getStatus()).resolves.toEqual({
      connected: false,
      needsReauth: false,
      accounts: [],
      activeId: null
    })
    sync.stop()
  })
})

// ---------------------------------------------------------------------------
// Slice 2a guards 3 and 4 — the ONE token-bearing method, and the silence of
// everything around it.
// ---------------------------------------------------------------------------

describe('CredentialSync.injectionTokenFor', () => {
  it('hands back the ACTIVE account with no refresh when the credential is fresh', async () => {
    const vault = new AuthVault()
    const active = await vault.upsertAccount(
      CHATGPT_PROVIDER_ID,
      cred({
        ws: 'ws-a',
        access: 'fake-access-a',
        expires: Date.now() + REFRESH_MARGIN_MS + 60_000,
        planType: 'pro'
      })
    )
    const refreshAccessToken = vi.fn()
    const sync = new CredentialSync({ vault, refreshAccessToken })
    sync.configure({ pi: fakeTarget().target, opencode: fakeTarget().target })

    await expect(sync.injectionTokenFor(null)).resolves.toEqual({
      accessToken: 'fake-access-a',
      chatgptAccountId: 'ws-a',
      chatgptPlanType: 'pro',
      vaultAccountId: active.id
    })
    expect(refreshAccessToken).not.toHaveBeenCalled()
    sync.stop()
  })

  it('refreshes ONCE inside the margin even when two processes start together', async () => {
    const vault = new AuthVault()
    const active = await vault.upsertAccount(
      CHATGPT_PROVIDER_ID,
      cred({ ws: 'ws-a', access: 'fake-stale', refresh: 'fake-r', expires: Date.now() + 60_000 })
    )
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const refreshAccessToken = vi.fn(async () => {
      await gate
      return { access_token: 'fake-rotated', refresh_token: 'fake-r2', expires_in: 3600 }
    })
    const sync = new CredentialSync({ vault, refreshAccessToken })
    sync.configure({ pi: fakeTarget().target, opencode: fakeTarget().target })

    const both = Promise.all([sync.injectionTokenFor(null), sync.injectionTokenFor(null)])
    await Promise.resolve()
    release()
    const [first, second] = await both

    // One network refresh for two callers: the per-account single-flight the
    // scheduled path already uses is what this goes through.
    expect(refreshAccessToken).toHaveBeenCalledTimes(1)
    expect(first?.accessToken).toBe('fake-rotated')
    expect(second?.accessToken).toBe('fake-rotated')
    expect(first?.vaultAccountId).toBe(active.id)
    sync.stop()
  })

  it('answers a REFRESH request from cache: margin 0 refreshes only what expired', async () => {
    // Codex abandons the turn after 10 s, so the refresh handler passes margin 0
    // and a token that is merely inside the 15-minute window is answered as is.
    const vault = new AuthVault()
    await vault.upsertAccount(
      CHATGPT_PROVIDER_ID,
      cred({ ws: 'ws-a', access: 'fake-inside-margin', expires: Date.now() + 60_000 })
    )
    const refreshAccessToken = vi.fn()
    const sync = new CredentialSync({ vault, refreshAccessToken })
    sync.configure({ pi: fakeTarget().target, opencode: fakeTarget().target })

    const token = await sync.injectionTokenFor(null, 0)

    expect(token?.accessToken).toBe('fake-inside-margin')
    expect(refreshAccessToken).not.toHaveBeenCalled()
    sync.stop()
  })

  it('picks a NAMED account, and refuses one with no workspace id', async () => {
    const vault = new AuthVault()
    const first = await vault.upsertAccount(
      CHATGPT_PROVIDER_ID,
      cred({ ws: 'ws-a', access: 'fake-access-a', expires: Date.now() + REFRESH_MARGIN_MS + 1_000 })
    )
    const second = await vault.upsertAccount(
      CHATGPT_PROVIDER_ID,
      cred({
        ws: 'ws-b',
        access: 'fake-access-b',
        refresh: 'fake-rb',
        expires: Date.now() + REFRESH_MARGIN_MS + 1_000
      })
    )
    const sync = new CredentialSync({ vault, refreshAccessToken: vi.fn() })
    sync.configure({ pi: fakeTarget().target, opencode: fakeTarget().target })

    expect((await sync.injectionTokenFor(second.id))?.chatgptAccountId).toBe('ws-b')
    expect((await sync.injectionTokenFor(first.id))?.chatgptAccountId).toBe('ws-a')
    expect(await sync.injectionTokenFor('no-such-account')).toBeNull()

    // `account/login/start {type:'chatgptAuthTokens'}` REQUIRES a workspace id,
    // so a credential without one is not injectable at all.
    await vault.saveAccountCredential(
      CHATGPT_PROVIDER_ID,
      second.id,
      cred({ access: 'fake-access-b', refresh: 'fake-rb', expires: Date.now() + 3_600_000 })
    )
    expect(await sync.injectionTokenFor(second.id)).toBeNull()
    sync.stop()
  })

  it('an empty vault injects nothing', async () => {
    const sync = new CredentialSync({ vault: new AuthVault(), refreshAccessToken: vi.fn() })
    sync.configure({ pi: fakeTarget().target, opencode: fakeTarget().target })
    await expect(sync.injectionTokenFor(null)).resolves.toBeNull()
    sync.stop()
  })

  it('leaves getStatus token-free now that a token-bearing method exists', async () => {
    const vault = new AuthVault()
    await vault.upsertAccount(
      CHATGPT_PROVIDER_ID,
      cred({
        ws: 'ws-a',
        access: 'secret-access-a',
        refresh: 'secret-refresh-a',
        expires: Date.now() + REFRESH_MARGIN_MS + 1_000
      })
    )
    const sync = new CredentialSync({ vault, refreshAccessToken: vi.fn() })
    sync.configure({ pi: fakeTarget().target, opencode: fakeTarget().target })

    const token = await sync.injectionTokenFor(null)
    expect(token?.accessToken).toBe('secret-access-a')
    expect(JSON.stringify(await sync.getStatus())).not.toContain('secret-')
    sync.stop()
  })
})
