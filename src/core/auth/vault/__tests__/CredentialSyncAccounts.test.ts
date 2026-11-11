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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = vi.hoisted(() => ({ value: '' }))
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, homedir: () => home.value, default: { ...actual, homedir: () => home.value } }
})

import { AuthVault, CHATGPT_PROVIDER_ID, vaultPath, type VaultAccount } from '../AuthVault'
import {
  CredentialSync,
  REFRESH_MARGIN_MS,
  type ChatgptCredentialInput,
  type ChatgptEntrySnapshot,
  type ChatgptFeedTarget
} from '../CredentialSync'
import type { VaultCredential } from '../chatgpt-oauth'
import { fakeOpencodeTarget } from './fixtures/fake-opencode-target'
import { fakeChatgptJwt } from './fixtures/fake-jwt'

let testHome: string
beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), 'credential-sync-accounts-'))
  home.value = testHome
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(testHome, { recursive: true, force: true })
})

/** Unexpired: opencode 2.x is never vended an expired token (ADR-097 §5). */
const FUTURE = Date.now() + 24 * 60 * 60 * 1000

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
function fakeTarget(holding: ChatgptEntrySnapshot | null = null): {
  target: ChatgptFeedTarget
  feed: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
} {
  const feed = vi.fn(async (_vendorId: string, _cred: ChatgptCredentialInput) => {})
  const remove = vi.fn(async (_vendorId: string) => {})
  return {
    target: {
      authFilePath: () => join(testHome, 'no-such-dir', 'auth.json'),
      feedOauthCredential: feed,
      readOauthEntry: vi.fn(async (): Promise<ChatgptEntrySnapshot | null> => holding),
      removeVendorAuth: remove
    },
    feed,
    remove
  }
}

/** A feed target whose store already holds `entry` (an engine-rotated token). */
function targetHolding(entry: ChatgptEntrySnapshot | null): ChatgptFeedTarget {
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
    const opencode = fakeOpencodeTarget()
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
    sync.configure({ pi: fakeTarget().target, opencode: fakeOpencodeTarget().target })

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
      cred({ ws: 'ws-b', access: 'fake-b', refresh: 'fake-rb', expires: FUTURE })
    )
    const pi = fakeTarget()
    const opencode = fakeOpencodeTarget()
    const sync = new CredentialSync({ vault })
    sync.configure({ pi: pi.target, opencode: opencode.target })

    await sync.removeAccount(active.id)

    await expect(vault.getActiveAccountId(CHATGPT_PROVIDER_ID)).resolves.toBe(newer.id)
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
    // Both engines hold the copy ClaudeUI vended (S7e: only that one goes).
    const pi = fakeTarget(cred())
    const opencode = fakeOpencodeTarget()
    const sync = new CredentialSync({ vault })
    sync.configure({ pi: pi.target, opencode: opencode.target })

    await sync.removeAccount(only.id)

    await expect(vault.listAccounts(CHATGPT_PROVIDER_ID)).resolves.toEqual([])
    expect(pi.remove).toHaveBeenCalledWith('openai-codex')
    expect(opencode.remove).toHaveBeenCalledWith('openai')
    expect(pi.feed).not.toHaveBeenCalled()
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
    const sync = new CredentialSync({ vault })
    sync.configure({ pi: pi.target, opencode: fakeOpencodeTarget().target })

    await sync.removeAccount(other.id)

    await expect(vault.getActiveAccountId(CHATGPT_PROVIDER_ID)).resolves.toBe(active.id)
    expect(pi.feed).not.toHaveBeenCalled()
    expect(pi.remove).not.toHaveBeenCalled()
    sync.stop()
  })
})

describe('CredentialSync.switchActiveAccount', () => {
  it('re-vends both engine stores from the new active credential', async () => {
    const vault = new AuthVault()
    await vault.upsertAccount(CHATGPT_PROVIDER_ID, cred({ ws: 'ws-a' }))
    const target = await vault.upsertAccount(
      CHATGPT_PROVIDER_ID,
      cred({ ws: 'ws-b', access: 'fake-b', refresh: 'fake-rb', expires: FUTURE })
    )
    const pi = fakeTarget()
    const opencode = fakeOpencodeTarget()
    const sync = new CredentialSync({ vault })
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
    sync.stop()
  })

  it('refuses an unknown account id rather than leaving the engines pointed at nothing', async () => {
    const vault = new AuthVault()
    await vault.upsertAccount(CHATGPT_PROVIDER_ID, cred({ ws: 'ws-a' }))
    const pi = fakeTarget()
    const sync = new CredentialSync({ vault })
    sync.configure({ pi: pi.target, opencode: fakeOpencodeTarget().target })
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
      opencode: fakeOpencodeTarget().target
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
    sync.configure({ pi: fakeTarget().target, opencode: fakeOpencodeTarget().target })

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
    sync.configure({ pi: fakeTarget().target, opencode: fakeOpencodeTarget().target })
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
    sync.configure({ pi: fakeTarget().target, opencode: fakeOpencodeTarget().target })

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
    sync.configure({ pi: fakeTarget().target, opencode: fakeOpencodeTarget().target })

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
    // A refresh request is answered inside a short deadline, so the handler passes margin 0
    // and a token that is merely inside the 15-minute window is answered as is.
    const vault = new AuthVault()
    await vault.upsertAccount(
      CHATGPT_PROVIDER_ID,
      cred({ ws: 'ws-a', access: 'fake-inside-margin', expires: Date.now() + 60_000 })
    )
    const refreshAccessToken = vi.fn()
    const sync = new CredentialSync({ vault, refreshAccessToken })
    sync.configure({ pi: fakeTarget().target, opencode: fakeOpencodeTarget().target })

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
    sync.configure({ pi: fakeTarget().target, opencode: fakeOpencodeTarget().target })

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
    sync.configure({ pi: fakeTarget().target, opencode: fakeOpencodeTarget().target })
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
    sync.configure({ pi: fakeTarget().target, opencode: fakeOpencodeTarget().target })

    const token = await sync.injectionTokenFor(null)
    expect(token?.accessToken).toBe('secret-access-a')
    expect(JSON.stringify(await sync.getStatus())).not.toContain('secret-')
    sync.stop()
  })
})

// ---------------------------------------------------------------------------
// Timer overflow — a far-off expiry must not refresh immediately
// ---------------------------------------------------------------------------

describe('CredentialSync — a credential expiring beyond the setTimeout cap', () => {
  it('re-arms instead of refreshing at once, then refreshes when actually due', async () => {
    vi.useFakeTimers()
    const now = Date.now()
    const vault = new AuthVault()
    // 60 days out: the naive delay is > 2^31-1 ms, which Node clamps to 1 ms.
    const sixtyDays = 60 * 24 * 60 * 60 * 1000
    await vault.upsertAccount(
      CHATGPT_PROVIDER_ID,
      cred({ ws: 'ws-a', refresh: 'fake-ra', expires: now + sixtyDays })
    )
    const refreshAccessToken = vi.fn(async (refresh: string) => ({
      access_token: `${refresh}-next-access`,
      refresh_token: `${refresh}-next`,
      expires_in: 3600
    }))
    const sync = new CredentialSync({ vault, refreshAccessToken })
    sync.configure({ pi: fakeTarget().target, opencode: fakeOpencodeTarget().target })
    await sync.start()

    // Past the clamp point, and well past it: still nothing to refresh.
    await vi.advanceTimersByTimeAsync(2 ** 31)
    expect(refreshAccessToken).not.toHaveBeenCalled()
    // Right up to the margin: still nothing.
    await vi.advanceTimersByTimeAsync(sixtyDays - 2 ** 31 - REFRESH_MARGIN_MS - 1_000)
    expect(refreshAccessToken).not.toHaveBeenCalled()
    // Into the margin: exactly one refresh.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(refreshAccessToken).toHaveBeenCalledTimes(1)
    sync.stop()
  })
})

// ---------------------------------------------------------------------------
// Identity: an engine's entry belongs to the account its token names, and an
// account holding another workspace's (or a duplicated) credential is never
// refreshed, injected or adopted into. Tokens are JWT-shaped fakes whose
// workspace claim is what the code under test reads.
// ---------------------------------------------------------------------------

const tok = (ws: string, tag: string, user = `user-${ws.slice(3)}`): string =>
  fakeChatgptJwt({ ws, user, plan: 'pro', tag })

/** A (active, expires an hour after B) and B, both healthy and unexpired. */
async function twoAccounts(): Promise<{
  vault: AuthVault
  a: VaultAccount
  b: VaultAccount
}> {
  const vault = new AuthVault()
  const a = await vault.upsertAccount(
    CHATGPT_PROVIDER_ID,
    cred({
      ws: 'ws-a',
      access: tok('ws-a', 'a1'),
      refresh: 'r-a',
      expires: FUTURE + 3_600_000,
      email: 'a@example.test',
      planType: 'pro',
      userId: 'user-a'
    })
  )
  const b = await vault.upsertAccount(
    CHATGPT_PROVIDER_ID,
    cred({
      ws: 'ws-b',
      access: tok('ws-b', 'b1'),
      refresh: 'r-b',
      expires: FUTURE,
      email: 'b@example.test'
    })
  )
  return { vault, a, b }
}

const accountOf = async (vault: AuthVault, id: string): Promise<VaultAccount> =>
  (await vault.listAccounts(CHATGPT_PROVIDER_ID)).find((account) => account.id === id)!

const refreshesOf = async (vault: AuthVault): Promise<string[]> =>
  (await vault.listAccounts(CHATGPT_PROVIDER_ID)).map((account) => account.credential.refresh)

/** Rewrite the plaintext vault file in place: how a corrupted vault is forged. */
function tamper(edit: (accounts: VaultAccount[]) => void): void {
  const file = JSON.parse(readFileSync(vaultPath(), 'utf8')) as {
    accounts: Record<string, { list: VaultAccount[] }>
  }
  edit(file.accounts[CHATGPT_PROVIDER_ID].list)
  writeFileSync(vaultPath(), JSON.stringify(file))
}

type Internals = {
  runtimes: Map<string, { refreshTimer?: unknown }>
  watchers: Map<string, unknown>
  handleExternalChange(engine: 'pi'): Promise<void>
}
const internals = (sync: CredentialSync): Internals => sync as unknown as Internals

/** Every refresh token a feed spy was called with. */
const fedRefreshes = (feed: ReturnType<typeof vi.fn>): string[] =>
  feed.mock.calls.map((call) => (call[1] as ChatgptCredentialInput).refresh)

describe('CredentialSync adoption follows the entry owner', () => {
  it('a switch while pi still holds the outgoing account leaves both vault entries alone', async () => {
    const { vault, a, b } = await twoAccounts()
    const before = await vault.listAccounts(CHATGPT_PROVIDER_ID)
    // pi holds A's token (what was fed while A was active); it outlives B's.
    const pi = fakeTarget({
      access: a.credential.access,
      refresh: a.credential.refresh,
      expires: a.credential.expires
    })
    const sync = new CredentialSync({ vault, refreshAccessToken: vi.fn() })
    sync.configure({ pi: pi.target, opencode: fakeOpencodeTarget().target })

    await sync.switchActiveAccount(b.id)

    expect(await vault.listAccounts(CHATGPT_PROVIDER_ID)).toEqual(before)
    expect(fedRefreshes(pi.feed)).toEqual(['r-b'])
    sync.stop()
  })

  it("a switch adopts the outgoing account's newer rotation into IT, and never feeds it", async () => {
    const { vault, a, b } = await twoAccounts()
    const bBefore = await accountOf(vault, b.id)
    const pi = fakeTarget({
      access: tok('ws-a', 'a2', 'user-a2'),
      refresh: 'r-a2',
      expires: a.credential.expires + 60_000
    })
    const opencode = fakeOpencodeTarget()
    const sync = new CredentialSync({ vault, refreshAccessToken: vi.fn() })
    sync.configure({ pi: pi.target, opencode: opencode.target })

    await sync.switchActiveAccount(b.id)

    expect((await accountOf(vault, a.id)).credential).toMatchObject({
      refresh: 'r-a2',
      accountId: 'ws-a'
    })
    expect(await accountOf(vault, b.id)).toEqual(bBefore)
    expect(fedRefreshes(pi.feed)).toEqual(['r-b'])
    expect(fedRefreshes(opencode.feed)).toEqual(['r-b'])
    // Its refresh timer now runs off the adopted credential.
    expect(internals(sync).runtimes.get(a.id)?.refreshTimer).toBeDefined()
    sync.stop()
  })

  it("the watcher adopts a background account's rotation into it and re-vends the active one", async () => {
    const { vault, a, b } = await twoAccounts()
    await vault.setActiveAccount(CHATGPT_PROVIDER_ID, b.id)
    const bBefore = await accountOf(vault, b.id)
    const pi = fakeTarget({
      access: tok('ws-a', 'a2'),
      refresh: 'r-a2',
      expires: a.credential.expires + 60_000
    })
    const sync = new CredentialSync({ vault, refreshAccessToken: vi.fn() })
    sync.configure({ pi: pi.target, opencode: fakeOpencodeTarget().target })

    await internals(sync).handleExternalChange('pi')

    expect((await accountOf(vault, a.id)).credential.refresh).toBe('r-a2')
    expect(await accountOf(vault, b.id)).toEqual(bBefore)
    expect(fedRefreshes(pi.feed)).toEqual(['r-b'])
    sync.stop()
  })

  it('the watcher adopts nothing when no account, or several, own the entry', async () => {
    const { vault, a } = await twoAccounts()
    const newer = a.credential.expires + 60_000
    const unowned = fakeTarget({ access: tok('ws-x', 'x1'), refresh: 'r-x', expires: newer })
    const sync = new CredentialSync({ vault, refreshAccessToken: vi.fn() })
    sync.configure({ pi: unowned.target, opencode: fakeOpencodeTarget().target })

    await internals(sync).handleExternalChange('pi') // a workspace nobody holds
    expect(await refreshesOf(vault)).toEqual(['r-a', 'r-b'])

    // Two accounts store the same workspace: ambiguous, so nobody's.
    tamper((list) => {
      // B now stores A's workspace too (the account's id follows its credential).
      list[1].credential.accountId = 'ws-a'
    })
    const ambiguous = fakeTarget({ access: tok('ws-a', 'a3'), refresh: 'r-a3', expires: newer })
    sync.configure({ pi: ambiguous.target })
    await internals(sync).handleExternalChange('pi')

    expect(await refreshesOf(vault)).toEqual(['r-a', 'r-b'])
    expect(unowned.feed).not.toHaveBeenCalled()
    expect(ambiguous.feed).not.toHaveBeenCalled()
    sync.stop()
  })

  it('reconcile on start adopts into the owner, keeps the active credential and feeds it', async () => {
    vi.useFakeTimers()
    const { vault, a, b } = await twoAccounts()
    await vault.setActiveAccount(CHATGPT_PROVIDER_ID, b.id)
    const bBefore = await accountOf(vault, b.id)
    const pi = fakeTarget({
      access: tok('ws-a', 'a2'),
      refresh: 'r-a2',
      expires: a.credential.expires + 60_000
    })
    const sync = new CredentialSync({ vault, refreshAccessToken: vi.fn() })
    sync.configure({ pi: pi.target, opencode: fakeOpencodeTarget().target })

    await sync.start()

    expect((await accountOf(vault, a.id)).credential.refresh).toBe('r-a2')
    expect(await accountOf(vault, b.id)).toEqual(bBefore)
    expect(fedRefreshes(pi.feed)).toEqual(['r-b'])
    expect(internals(sync).runtimes.get(a.id)?.refreshTimer).toBeDefined()
    expect(internals(sync).runtimes.get(b.id)?.refreshTimer).toBeDefined()
    sync.stop()
  })

  it('reconcile on start with a foreign entry that is not newer just re-vends the active account', async () => {
    const { vault, a, b } = await twoAccounts()
    await vault.setActiveAccount(CHATGPT_PROVIDER_ID, b.id)
    const before = await vault.listAccounts(CHATGPT_PROVIDER_ID)
    const pi = fakeTarget({
      access: a.credential.access,
      refresh: 'r-a',
      expires: a.credential.expires
    })
    const sync = new CredentialSync({ vault, refreshAccessToken: vi.fn() })
    sync.configure({ pi: pi.target, opencode: fakeOpencodeTarget().target })

    await sync.start()

    expect(await vault.listAccounts(CHATGPT_PROVIDER_ID)).toEqual(before)
    expect(fedRefreshes(pi.feed)).toEqual(['r-b'])
    sync.stop()
  })

  it("stores identity off the adopted token, falling back to the owner's stored fields", async () => {
    const { vault, a } = await twoAccounts()
    const sync = new CredentialSync({ vault, refreshAccessToken: vi.fn() })
    const newer = a.credential.expires + 60_000
    const rich = fakeTarget({
      access: fakeChatgptJwt({ ws: 'ws-a', plan: 'team', user: 'user-a2', tag: 'a2' }),
      refresh: 'r-a2',
      expires: newer
    })
    sync.configure({ pi: rich.target, opencode: fakeOpencodeTarget().target })
    await internals(sync).handleExternalChange('pi')
    expect((await accountOf(vault, a.id)).credential).toMatchObject({
      refresh: 'r-a2',
      accountId: 'ws-a',
      planType: 'team',
      userId: 'user-a2',
      email: 'a@example.test'
    })

    // A claim-less entry (the legacy single slot) keeps every stored field.
    const bare = fakeTarget({ access: 'fake-bare', refresh: 'r-a3', expires: newer + 60_000 })
    sync.configure({ pi: bare.target })
    await internals(sync).handleExternalChange('pi')
    expect((await accountOf(vault, a.id)).credential).toMatchObject({
      access: 'fake-bare',
      refresh: 'r-a3',
      accountId: 'ws-a',
      planType: 'team',
      userId: 'user-a2',
      email: 'a@example.test'
    })
    sync.stop()
  })

  it('an account with no stored workspace id owns the entry whose token names it', async () => {
    const { vault, b } = await twoAccounts()
    await vault.setActiveAccount(CHATGPT_PROVIDER_ID, b.id)
    const bootstrapped = await vault.upsertAccount(
      CHATGPT_PROVIDER_ID,
      cred({ access: tok('ws-x', 'x1'), refresh: 'r-x', expires: FUTURE })
    )
    expect(bootstrapped.accountId).toBeUndefined()
    const pi = fakeTarget({ access: tok('ws-x', 'x2'), refresh: 'r-x2', expires: FUTURE + 60_000 })
    const sync = new CredentialSync({ vault, refreshAccessToken: vi.fn() })
    sync.configure({ pi: pi.target, opencode: fakeOpencodeTarget().target })

    await internals(sync).handleExternalChange('pi')

    expect(await accountOf(vault, bootstrapped.id)).toMatchObject({
      accountId: 'ws-x',
      credential: { refresh: 'r-x2', accountId: 'ws-x' }
    })
    sync.stop()
  })
})

describe('CredentialSync refuses to store another workspace', () => {
  it('a refresh the vault refuses leaves the account needing sign-in, with no feed or reschedule', async () => {
    vi.useFakeTimers()
    const now = Date.now()
    const vault = new AuthVault()
    const a = await vault.upsertAccount(
      CHATGPT_PROVIDER_ID,
      cred({
        ws: 'ws-a',
        access: tok('ws-a', 'a1'),
        refresh: 'r-a',
        expires: now + REFRESH_MARGIN_MS + 1_000
      })
    )
    // The token endpoint answers with ANOTHER workspace's token.
    const refreshAccessToken = vi.fn(async () => ({
      access_token: tok('ws-b', 'b9'),
      refresh_token: 'r-b9',
      expires_in: 3600
    }))
    const pi = fakeTarget()
    const opencode = fakeOpencodeTarget()
    const sync = new CredentialSync({ vault, refreshAccessToken })
    sync.configure({ pi: pi.target, opencode: opencode.target })
    await sync.start()
    pi.feed.mockClear()
    opencode.feed.mockClear()

    await vi.advanceTimersByTimeAsync(1_001)
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)

    expect(refreshAccessToken).toHaveBeenCalledTimes(1)
    expect((await accountOf(vault, a.id)).credential.refresh).toBe('r-a')
    expect(pi.feed).not.toHaveBeenCalled()
    expect(opencode.feed).not.toHaveBeenCalled()
    expect((await sync.getStatus()).accounts[0].needsReauth).toBe(true)
    sync.stop()
  })

  it('start keeps the vault credential when adopting the engine entry is refused', async () => {
    class RefusingVault extends AuthVault {
      override async saveAccountCredential(): Promise<void> {
        throw new Error(
          "Refusing to store another ChatGPT workspace's credential on vault account x"
        )
      }
    }
    const vault = new RefusingVault()
    const a = await vault.upsertAccount(
      CHATGPT_PROVIDER_ID,
      cred({ ws: 'ws-a', access: tok('ws-a', 'a1'), refresh: 'r-a', expires: FUTURE })
    )
    const piDir = join(testHome, 'pi')
    mkdirSync(piDir)
    const pi = fakeTarget({ access: tok('ws-a', 'a2'), refresh: 'r-a2', expires: FUTURE + 60_000 })
    pi.target.authFilePath = () => join(piDir, 'auth.json')
    const opencode = fakeOpencodeTarget()
    const sync = new CredentialSync({ vault, refreshAccessToken: vi.fn() })
    sync.configure({ pi: pi.target, opencode: opencode.target })

    await sync.start()

    // Not behaving as disconnected: opencode vended, timer and watcher armed.
    expect(fedRefreshes(opencode.feed)).toEqual(['r-a'])
    expect(internals(sync).runtimes.get(a.id)?.refreshTimer).toBeDefined()
    expect(internals(sync).watchers.has('pi')).toBe(true)
    sync.stop()
  })
})

describe('CredentialSync corrupted accounts', () => {
  /**
   * The shape the bug left behind: A holds B's exact token pair (B's workspace)
   * beside its own stored ws-a. A is cross-wired; B is genuine, healthy and due.
   */
  async function crossWired(): Promise<{ vault: AuthVault; a: VaultAccount; b: VaultAccount }> {
    const now = Date.now()
    const { vault, a, b } = await twoAccounts()
    await vault.setActiveAccount(CHATGPT_PROVIDER_ID, b.id)
    tamper((list) => {
      list[0].credential.access = list[1].credential.access
      list[0].credential.refresh = list[1].credential.refresh
      list[0].credential.expires = now + REFRESH_MARGIN_MS + 1_000
      list[1].credential.expires = now + REFRESH_MARGIN_MS + 1_000
    })
    return { vault, a, b }
  }

  it('flags a cross-wired account at start and never spends its refresh token', async () => {
    vi.useFakeTimers()
    const { vault, a, b } = await crossWired()
    const refreshAccessToken = vi.fn(async (refresh: string) => ({
      access_token: tok('ws-b', `${refresh}-next`),
      refresh_token: `${refresh}-next`,
      expires_in: 3600
    }))
    const sync = new CredentialSync({ vault, refreshAccessToken })
    sync.configure({ pi: fakeTarget().target, opencode: fakeOpencodeTarget().target })

    await sync.start()
    const status = await sync.getStatus()
    expect(status.accounts.find((x) => x.id === a.id)?.needsReauth).toBe(true)
    expect(status.accounts.find((x) => x.id === b.id)?.needsReauth).toBe(false)

    await vi.advanceTimersByTimeAsync(10_000) // time passes: only B is due
    await sync.switchActiveAccount(a.id) // a switch to it arms a timer ...
    await vi.advanceTimersByTimeAsync(10_000) // ... that must not refresh
    await sync.refreshNow()
    const token = await sync.injectionTokenFor(a.id, 24 * 60 * 60 * 1000)

    expect(token).toBeNull()
    // Only B's tokens were ever spent (refreshNow forces B a second time).
    expect(refreshAccessToken.mock.calls.map((call) => call[0])).toEqual(['r-b', 'r-b-next'])
    expect((await sync.getStatus()).accounts.find((x) => x.id === a.id)?.needsReauth).toBe(true)
    // The healthy account injects as before.
    expect((await sync.injectionTokenFor(b.id))?.chatgptAccountId).toBe('ws-b')
    sync.stop()
  })

  it('flags both accounts of a duplicate workspace, or of a shared refresh token', async () => {
    vi.useFakeTimers()
    const refreshAccessToken = vi.fn()
    const forgeries: Array<(list: VaultAccount[]) => void> = [
      (list) => {
        // B now stores and holds A's workspace.
        list[1].accountId = 'ws-a'
        list[1].credential.accountId = 'ws-a'
        list[1].credential.access = tok('ws-a', 'dup')
      },
      (list) => {
        list[1].credential.refresh = list[0].credential.refresh
      }
    ]
    for (const forge of forgeries) {
      const { vault, a, b } = await twoAccounts()
      tamper((list) => {
        forge(list)
        for (const account of list) {
          account.credential.expires = Date.now() + REFRESH_MARGIN_MS + 1_000
        }
      })
      const pi = fakeTarget({ access: tok('ws-a', 'a2'), refresh: 'r-new', expires: FUTURE + 1 })
      const sync = new CredentialSync({ vault, refreshAccessToken })
      sync.configure({ pi: pi.target, opencode: fakeOpencodeTarget().target })
      const before = await vault.listAccounts(CHATGPT_PROVIDER_ID)

      await sync.start()
      await vi.advanceTimersByTimeAsync(10_000)
      await sync.refreshNow()

      const status = await sync.getStatus()
      expect(status.accounts.map((x) => x.needsReauth)).toEqual([true, true])
      expect(await sync.injectionTokenFor(a.id)).toBeNull()
      expect(await sync.injectionTokenFor(b.id)).toBeNull()
      expect(refreshAccessToken).not.toHaveBeenCalled()
      expect(await vault.listAccounts(CHATGPT_PROVIDER_ID)).toEqual(before) // nothing adopted
      sync.stop()
      rmSync(vaultPath())
    }
  })

  it('re-signing in the cross-wired account clears the flag and injects it again', async () => {
    const { vault, a } = await crossWired()
    const sync = new CredentialSync({ vault, refreshAccessToken: vi.fn() })
    sync.configure({ pi: fakeTarget().target, opencode: fakeOpencodeTarget().target })
    await sync.start()
    expect((await sync.getStatus()).accounts.find((x) => x.id === a.id)?.needsReauth).toBe(true)

    vi.spyOn(vault, 'completeLogin').mockImplementation(
      async () =>
        (
          await vault.upsertAccount(
            CHATGPT_PROVIDER_ID,
            cred({
              ws: 'ws-a',
              access: tok('ws-a', 'a2'),
              refresh: 'r-a2',
              expires: FUTURE + 120_000
            })
          )
        ).credential
    )
    await sync.completeLogin()

    expect((await sync.getStatus()).accounts.find((x) => x.id === a.id)?.needsReauth).toBe(false)
    expect((await sync.injectionTokenFor(a.id))?.chatgptAccountId).toBe('ws-a')
    sync.stop()
  })

  it('a sign-in on one row of a duplicated workspace keeps it flagged until the twin is removed', async () => {
    const { vault, a, b } = await twoAccounts()
    // The second shape: A refreshed with B's token before the upgrade, so it now stores ws-b too.
    tamper((list) => {
      list[0].accountId = 'ws-b'
      list[0].credential.accountId = 'ws-b'
      list[0].credential.access = tok('ws-b', 'dup')
    })
    const sync = new CredentialSync({ vault, refreshAccessToken: vi.fn() })
    sync.configure({ pi: fakeTarget().target, opencode: fakeOpencodeTarget().target })
    await sync.start()
    const login = vi.spyOn(vault, 'completeLogin')
    const signInB = async (tag: string, refresh: string): Promise<void> => {
      login.mockImplementationOnce(
        async () =>
          (
            await vault.upsertAccount(
              CHATGPT_PROVIDER_ID,
              cred({ ws: 'ws-b', access: tok('ws-b', tag), refresh, expires: FUTURE + 120_000 })
            )
          ).credential
      )
      await sync.completeLogin()
    }

    await signInB('b2', 'r-b2')

    // The sign-in landed on one row; its twin still shares the workspace.
    expect((await sync.getStatus()).accounts.map((x) => x.needsReauth)).toEqual([true, true])
    expect(await sync.injectionTokenFor(a.id)).toBeNull()
    expect(await sync.injectionTokenFor(b.id)).toBeNull()

    // The remedy: remove the twin, then sign in again.
    const twin = (await vault.listAccounts(CHATGPT_PROVIDER_ID)).find(
      (x) => x.credential.refresh !== 'r-b2'
    )
    await sync.removeAccount(twin!.id)
    await signInB('b3', 'r-b3')

    const after = await sync.getStatus()
    expect(after.accounts).toHaveLength(1)
    expect(after.accounts[0].needsReauth).toBe(false)
    expect((await sync.injectionTokenFor(after.accounts[0].id))?.chatgptAccountId).toBe('ws-b')
    sync.stop()
  })
})
