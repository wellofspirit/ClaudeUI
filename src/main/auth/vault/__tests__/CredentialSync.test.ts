/**
 * @vitest-environment node
 *
 * Unit tests for CredentialSync (M6b) — feed-forward, sole-refresher
 * scheduler, and fs-watch resync.
 *
 * SAFETY: every refresh in this file goes through an INJECTED
 * `refreshAccessToken` fake (`CredentialSyncDeps.refreshAccessToken`) — none
 * of these tests construct the real codex-oauth.ts `refreshAccessToken` or
 * reach auth.openai.com. The vault itself is a plain in-memory `VaultLike`
 * fake (see `makeFakeVault`) — no real AuthVault, no real `~/.claude/ui`.
 *
 * The scheduler tests use `vi.useFakeTimers()` (pure setTimeout logic, no
 * filesystem events to coordinate with). The fs-watch tests use REAL
 * `fs.watch` against REAL temp files with REAL (short) timers — same
 * approach as session-watcher.test.ts ("use real fs.watch against real temp
 * files so the debounce→reload path actually fires; do not mock fs or
 * fs.watch"). Every temp file lives under `os.tmpdir()`, never `~/.pi` or a
 * real opencode data dir.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

import {
  CredentialSync,
  isRefreshRevoked,
  REFRESH_MARGIN_MS,
  RETRY_BASE_MS,
  MAX_TRANSIENT_RETRIES,
  type VaultLike,
  type CodexFeedTarget,
  type CodexCredentialInput,
  type CodexEntrySnapshot
} from '../CredentialSync'
import type { VaultCredential } from '../codex-oauth'

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** A plain in-memory VaultLike — save()/load() round-trip through a variable, not a file. */
function makeFakeVault(initial: VaultCredential | null): {
  vault: VaultLike
  save: ReturnType<typeof vi.fn>
  state: { current: VaultCredential | null }
} {
  const state = { current: initial }
  const save = vi.fn(async (cred: VaultCredential) => {
    state.current = cred
  })
  const vault: VaultLike = {
    load: async () => state.current,
    save,
    removeCredential: vi.fn(async () => {
      state.current = null
    }),
    hasUnreadableLegacyVault: () => false,
    beginLogin: vi.fn(async () => ({
      authorizeUrl: 'https://auth.openai.com/oauth/authorize?x=1'
    })),
    completeLogin: vi.fn(async () => {
      throw new Error('makeFakeVault: completeLogin not configured for this test')
    }),
    cancelLogin: vi.fn()
  }
  return { vault, save, state }
}

/** A pure-spy CodexFeedTarget — no real files. Used for scheduler/feedAll orchestration tests. */
function fakeFeedTarget(): {
  target: CodexFeedTarget
  feed: ReturnType<typeof vi.fn>
  read: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
} {
  const feed = vi.fn(async (_vendorId: string, _cred: CodexCredentialInput) => {})
  const read = vi.fn(async (_vendorId: string) => null)
  const remove = vi.fn(async (_vendorId: string) => {})
  const target: CodexFeedTarget = {
    // Deliberately a non-existent path — startWatcher() no-ops when the
    // parent dir doesn't exist, so these orchestration-only tests never spin
    // up a real fs.watch.
    authFilePath: () => join(tmpdir(), 'credential-sync-fake-target-does-not-exist', 'auth.json'),
    feedOauthCredential: feed,
    readOauthEntry: read,
    removeVendorAuth: remove
  }
  return { target, feed, read, remove }
}

/** A real, file-backed CodexFeedTarget — used for the fs-watch resync tests. */
function makeRealFeedTarget(filePath: string): {
  target: CodexFeedTarget
  feed: ReturnType<typeof vi.fn>
} {
  const feed = vi.fn(async (vendorId: string, cred: CodexCredentialInput) => {
    let file: Record<string, unknown> = {}
    try {
      file = JSON.parse(readFileSync(filePath, 'utf-8'))
    } catch {
      // absent/corrupt — start fresh
    }
    file[vendorId] = { type: 'oauth', ...cred }
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, JSON.stringify(file))
  })
  const target: CodexFeedTarget = {
    authFilePath: () => filePath,
    feedOauthCredential: feed,
    removeVendorAuth: vi.fn(async () => {}),
    readOauthEntry: async (vendorId: string) => {
      try {
        const file = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<
          string,
          Record<string, unknown>
        >
        const entry = file[vendorId]
        if (!entry || entry.type !== 'oauth') return null
        return {
          access: entry.access as string,
          refresh: entry.refresh as string,
          expires: entry.expires as number,
          accountId: entry.accountId as string | undefined
        }
      } catch {
        return null
      }
    }
  }
  return { target, feed }
}

/** Simulate an engine writing its OWN auth.json directly (bypassing the feed spy) — models an engine-initiated rotation. */
function writeRaw(
  filePath: string,
  vendorId: string,
  entry: { access: string; refresh: string; expires: number }
): void {
  mkdirSync(dirname(filePath), { recursive: true })
  let file: Record<string, unknown> = {}
  try {
    file = JSON.parse(readFileSync(filePath, 'utf-8'))
  } catch {
    // fresh file
  }
  file[vendorId] = { type: 'oauth', ...entry }
  writeFileSync(filePath, JSON.stringify(file))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// 0. isRefreshRevoked classification (Finding B)
//
// RED-FIRST NOTE: against the ORIGINAL `/\b401\b/ || /invalid_grant/`-only
// logic, the 400-invalid_grant, bare-400, and 403 cases below all returned
// FALSE (misclassified as transient → retried forever, needsReauth never
// set). They pass only with the 4xx-client-error classification.
// ---------------------------------------------------------------------------

describe('isRefreshRevoked', () => {
  it('classifies an invalid_grant body (HTTP 400, RFC 6749 §5.2) as REVOKED', () => {
    expect(
      isRefreshRevoked(new Error('Token refresh failed: 400 - {"error":"invalid_grant"}'))
    ).toBe(true)
  })

  it('classifies a bare 400 client error as REVOKED', () => {
    expect(isRefreshRevoked(new Error('Token refresh failed: 400'))).toBe(true)
  })

  it('classifies 401 and 403 as REVOKED', () => {
    expect(isRefreshRevoked(new Error('Token refresh failed: 401'))).toBe(true)
    expect(isRefreshRevoked(new Error('Token refresh failed: 403'))).toBe(true)
  })

  it('classifies a 500 server error as TRANSIENT', () => {
    expect(isRefreshRevoked(new Error('Token refresh failed: 500'))).toBe(false)
  })

  it('classifies a 429 rate-limit as TRANSIENT (a retryable 4xx, deliberately not revoked)', () => {
    expect(isRefreshRevoked(new Error('Token refresh failed: 429'))).toBe(false)
  })

  it('classifies a network/transport error (no HTTP status) as TRANSIENT', () => {
    expect(isRefreshRevoked(new TypeError('fetch failed'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 1. feedAll
// ---------------------------------------------------------------------------

describe('CredentialSync.feedAll', () => {
  it('writes the identical {access,refresh,expires,accountId} shape to both engine targets', async () => {
    const pi = fakeFeedTarget()
    const opencode = fakeFeedTarget()
    const sync = new CredentialSync({ vault: makeFakeVault(null).vault })
    sync.configure({ pi: pi.target, opencode: opencode.target })

    const cred: VaultCredential = {
      type: 'oauth',
      access: 'acc',
      refresh: 'ref',
      expires: 12345,
      accountId: 'acct-1'
    }
    const result = await sync.feedAll(cred)

    expect(result).toEqual({ pi: true, opencode: true })
    expect(pi.feed).toHaveBeenCalledWith('openai-codex', {
      access: 'acc',
      refresh: 'ref',
      expires: 12345,
      accountId: 'acct-1'
    })
    expect(opencode.feed).toHaveBeenCalledWith('openai', {
      access: 'acc',
      refresh: 'ref',
      expires: 12345,
      accountId: 'acct-1'
    })
  })

  it('a failure writing ONE store still writes the other and reports the per-store outcome', async () => {
    const pi = fakeFeedTarget()
    pi.feed.mockRejectedValueOnce(new Error('disk full'))
    const opencode = fakeFeedTarget()
    const sync = new CredentialSync({ vault: makeFakeVault(null).vault })
    sync.configure({ pi: pi.target, opencode: opencode.target })

    const result = await sync.feedAll({ type: 'oauth', access: 'a', refresh: 'r', expires: 1 })

    expect(result).toEqual({ pi: false, opencode: true })
    expect(opencode.feed).toHaveBeenCalledTimes(1)
  })

  it('degrades to {pi:false, opencode:false} when neither target is configured', async () => {
    const sync = new CredentialSync({ vault: makeFakeVault(null).vault })
    const result = await sync.feedAll({ type: 'oauth', access: 'a', refresh: 'r', expires: 1 })
    expect(result).toEqual({ pi: false, opencode: false })
  })
})

describe('CredentialSync route policy', () => {
  const piOnly = () => ({ pi: true, opencode: false })

  it('feeds only enabled pi on login, refresh, and adoption', async () => {
    vi.useFakeTimers()
    try {
      const now = Date.now()
      const { vault, state } = makeFakeVault({
        type: 'oauth',
        access: 'old',
        refresh: 'old',
        expires: now + 1
      })
      const pi = fakeFeedTarget()
      const opencode = fakeFeedTarget()
      const refresh = vi.fn(async () => ({
        access_token: 'new',
        refresh_token: 'new',
        expires_in: 3600
      }))
      vault.completeLogin = vi.fn(async () => state.current!)
      const sync = new CredentialSync({
        vault,
        getEnabledRoutes: piOnly,
        refreshAccessToken: refresh
      })
      sync.configure({ pi: pi.target, opencode: opencode.target })
      await sync.completeLogin()
      await sync.refreshNow()
      opencode.read.mockResolvedValue({ access: 'adopt', refresh: 'adopt', expires: now + 999_999 })
      state.current = null
      await sync.start()
      expect(pi.feed).toHaveBeenCalled()
      expect(opencode.feed).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails closed when a configured route policy throws', async () => {
    const pi = fakeFeedTarget()
    const opencode = fakeFeedTarget()
    const sync = new CredentialSync({
      vault: makeFakeVault(null).vault,
      getEnabledRoutes: () => {
        throw new Error('repository unavailable')
      }
    })
    sync.configure({ pi: pi.target, opencode: opencode.target })
    await expect(sync.feedAll({ type: 'oauth', access: 'a', refresh: 'r', expires: 1 })).resolves.toEqual({
      pi: false,
      opencode: false
    })
    expect(pi.feed).not.toHaveBeenCalled()
    expect(opencode.feed).not.toHaveBeenCalled()
  })

  it('never re-vends a disabled route during subsequent sync', async () => {
    const pi = fakeFeedTarget()
    const opencode = fakeFeedTarget()
    const sync = new CredentialSync({ vault: makeFakeVault(null).vault, getEnabledRoutes: piOnly })
    sync.configure({ pi: pi.target, opencode: opencode.target })
    await sync.feedAll({ type: 'oauth', access: 'a', refresh: 'r', expires: 1 })
    await sync.feedAll({ type: 'oauth', access: 'b', refresh: 's', expires: 2 })
    expect(pi.feed).toHaveBeenCalledTimes(2)
    expect(opencode.feed).not.toHaveBeenCalled()
  })

  it('removes a disabled route copy ONLY when it is the managed vault credential; never with an empty vault (M-AT3)', async () => {
    // Connected vault (refresh 'r') and the disabled opencode store holds the
    // SAME credential ClaudeUI vended → ours to clean up.
    const readable = makeFakeVault({ type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() + 999_999 })
    const readablePi = fakeFeedTarget()
    const readableOpencode = fakeFeedTarget()
    readableOpencode.read.mockResolvedValue({ access: 'a', refresh: 'r', expires: Date.now() + 999_999 })
    const readableSync = new CredentialSync({ vault: readable.vault, getEnabledRoutes: piOnly })
    readableSync.configure({ pi: readablePi.target, opencode: readableOpencode.target })
    await readableSync.start()
    expect(readableOpencode.remove).toHaveBeenCalledWith('openai')
    readableSync.stop()

    // Empty vault → ClaudeUI managed nothing → a disabled store's credential is
    // the user's own; never remove it (this is the M-AT3 data-loss fix).
    const emptyPi = fakeFeedTarget()
    const emptyOpencode = fakeFeedTarget()
    emptyOpencode.read.mockResolvedValue({ access: 'u', refresh: 'user-own', expires: Date.now() + 999_999 })
    const emptySync = new CredentialSync({ vault: makeFakeVault(null).vault, getEnabledRoutes: piOnly })
    emptySync.configure({ pi: emptyPi.target, opencode: emptyOpencode.target })
    await emptySync.start()
    expect(emptyOpencode.remove).not.toHaveBeenCalled()
  })

  it('preserves a user-created disabled-route Codex credential when the vault is empty (M-AT3 guard)', async () => {
    // User ran `pi /login` themselves; ClaudeUI never connected ChatGPT.
    const pi = fakeFeedTarget()
    pi.read.mockResolvedValue({ access: 'ua', refresh: 'user-refresh', expires: Date.now() + 999_999 })
    const opencode = fakeFeedTarget()
    const sync = new CredentialSync({
      vault: makeFakeVault(null).vault,
      getEnabledRoutes: () => ({ pi: false, opencode: true })
    })
    sync.configure({ pi: pi.target, opencode: opencode.target })
    await sync.start()
    // Pre-fix start() unconditionally removed the disabled route's codex entry.
    expect(pi.remove).not.toHaveBeenCalled()
    sync.stop()
  })

  it('preserves an unmanaged disabled-route copy whose token does not match the vault (M-AT3)', async () => {
    // Connected vault ('r'), but the disabled opencode store holds a DIFFERENT
    // (user-owned) credential → not ClaudeUI-vended → must be left intact.
    const { vault } = makeFakeVault({ type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() + 999_999 })
    const pi = fakeFeedTarget()
    const opencode = fakeFeedTarget()
    opencode.read.mockResolvedValue({ access: 'u', refresh: 'user-own', expires: Date.now() + 999_999 })
    const sync = new CredentialSync({ vault, getEnabledRoutes: piOnly })
    sync.configure({ pi: pi.target, opencode: opencode.target })
    await sync.start()
    expect(opencode.remove).not.toHaveBeenCalled()
    sync.stop()
  })

  it('starts a newly enabled target watcher after a successful feed', async () => {
    let enabled = false
    const pi = fakeFeedTarget()
    const opencode = fakeFeedTarget()
    const opencodeAuthFilePath = vi.fn(opencode.target.authFilePath)
    opencode.target.authFilePath = opencodeAuthFilePath
    const sync = new CredentialSync({
      vault: makeFakeVault(null).vault,
      getEnabledRoutes: () => ({ pi: true, opencode: enabled })
    })
    sync.configure({ pi: pi.target, opencode: opencode.target })
    await sync.feedAll({ type: 'oauth', access: 'a', refresh: 'r', expires: 1 })
    expect(opencode.feed).not.toHaveBeenCalled()
    enabled = true
    await sync.feedAll({ type: 'oauth', access: 'a', refresh: 'r', expires: 1 })
    expect(opencode.feed).toHaveBeenCalledTimes(1)
    expect(opencodeAuthFilePath).toHaveBeenCalled()
    sync.stop()
  })

  it('continues scheduling an enabled credential when stale disabled-copy cleanup fails', async () => {
    vi.useFakeTimers()
    try {
      const pi = fakeFeedTarget()
      const opencode = fakeFeedTarget()
      // Disabled store holds the managed credential (matches the vault), so the
      // provenance-checked cleanup proceeds to removeVendorAuth — which fails.
      opencode.read.mockResolvedValue({ access: 'a', refresh: 'r', expires: Date.now() + 60 * 60 * 1000 })
      opencode.remove.mockRejectedValueOnce(new Error('auth file is locked'))
      const sync = new CredentialSync({
        vault: makeFakeVault({
          type: 'oauth',
          access: 'a',
          refresh: 'r',
          expires: Date.now() + 60 * 60 * 1000
        }).vault,
        getEnabledRoutes: piOnly
      })
      sync.configure({ pi: pi.target, opencode: opencode.target })

      await expect(sync.start()).resolves.toBeUndefined()
      expect(opencode.remove).toHaveBeenCalledWith('openai')
      expect(vi.getTimerCount()).toBeGreaterThan(0)
      sync.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not start a watcher for a disabled route', async () => {
    const pi = fakeFeedTarget()
    const opencode = fakeFeedTarget()
    const opencodeAuthFilePath = vi.fn(opencode.target.authFilePath)
    opencode.target.authFilePath = opencodeAuthFilePath
    const sync = new CredentialSync({
      vault: makeFakeVault({
        type: 'oauth',
        access: 'a',
        refresh: 'r',
        expires: Date.now() + 999_999
      }).vault,
      getEnabledRoutes: piOnly
    })
    sync.configure({ pi: pi.target, opencode: opencode.target })
    await sync.start()
    // (opencode.read may now be consulted for disabled-copy provenance; the
    // watcher — authFilePath — must still never be armed for a disabled route.)
    expect(opencodeAuthFilePath).not.toHaveBeenCalled()
    sync.stop()
  })

  it('does not adopt a newer disabled-route copy when the vault is readable', async () => {
    const now = Date.now()
    const { vault, save } = makeFakeVault({
      type: 'oauth',
      access: 'a',
      refresh: 'r',
      expires: now + 10
    })
    const pi = fakeFeedTarget()
    const opencode = fakeFeedTarget()
    opencode.read.mockResolvedValue({ access: 'new', refresh: 'new', expires: now + 999_999 })
    const sync = new CredentialSync({ vault, getEnabledRoutes: piOnly })
    sync.configure({ pi: pi.target, opencode: opencode.target })
    await sync.start()
    // A disabled route is never adopted from (no save), and its mismatched
    // (user-owned) credential is preserved (not removed).
    expect(save).not.toHaveBeenCalled()
    expect(opencode.remove).not.toHaveBeenCalled()
    sync.stop()
  })

  it('recovers an unreadable legacy vault from both native routes, then removes disabled copies', async () => {
    const now = Date.now()
    const { vault, save } = makeFakeVault(null)
    vault.hasUnreadableLegacyVault = () => true
    const pi = fakeFeedTarget()
    const opencode = fakeFeedTarget()
    opencode.read.mockResolvedValue({ access: 'new', refresh: 'new', expires: now + 999_999 })
    const sync = new CredentialSync({ vault, getEnabledRoutes: piOnly })
    sync.configure({ pi: pi.target, opencode: opencode.target })
    await sync.start()
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ refresh: 'new' }))
    expect(pi.feed).toHaveBeenCalledWith(
      'openai-codex',
      expect.objectContaining({ refresh: 'new' })
    )
    expect(opencode.feed).not.toHaveBeenCalled()
    expect(opencode.remove).toHaveBeenCalledWith('openai')
    sync.stop()
  })
})

describe('CredentialSync.disconnectChatgpt', () => {
  it('prevents a completing login callback from restoring credentials after disconnect', async () => {
    const { vault, state } = makeFakeVault(null)
    let resolveLogin: ((credential: VaultCredential) => void) | undefined
    vault.completeLogin = vi.fn(
      () =>
        new Promise<VaultCredential>((resolve) => {
          resolveLogin = (credential) => {
            state.current = credential
            resolve(credential)
          }
        })
    )
    const pi = fakeFeedTarget()
    const opencode = fakeFeedTarget()
    const sync = new CredentialSync({ vault })
    sync.configure({ pi: pi.target, opencode: opencode.target })

    const login = sync.completeLogin()
    await sync.disconnectChatgpt()
    resolveLogin!({ type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() + 60_000 })

    await expect(login).rejects.toThrow('cancelled')
    expect(state.current).toBeNull()
    expect(pi.feed).not.toHaveBeenCalled()
    expect(opencode.feed).not.toHaveBeenCalled()
  })

  it('prevents an in-flight refresh from restoring credentials after disconnect', async () => {
    vi.useFakeTimers()
    try {
      const { vault, save, state } = makeFakeVault({ type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() + 999_999 })
      let resolveRefresh: ((tokens: { access_token: string; refresh_token: string; expires_in: number }) => void) | undefined
      const refreshAccessToken = vi.fn(() => new Promise<{ access_token: string; refresh_token: string; expires_in: number }>((resolve) => { resolveRefresh = resolve }))
      const pi = fakeFeedTarget()
      const opencode = fakeFeedTarget()
      const sync = new CredentialSync({ vault, refreshAccessToken })
      sync.configure({ pi: pi.target, opencode: opencode.target })
      const refresh = sync.refreshNow()
      await Promise.resolve()
      expect(refreshAccessToken).toHaveBeenCalledWith('r')
      await sync.disconnectChatgpt()
      resolveRefresh!({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 })
      await refresh
      expect(save).not.toHaveBeenCalled()
      expect(state.current).toBeNull()
      expect(pi.feed).not.toHaveBeenCalled()
      expect(opencode.feed).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
      expect(refreshAccessToken).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('prevents an in-flight external read from adopting after disconnect', async () => {
    const { vault, save, state } = makeFakeVault({ type: 'oauth', access: 'a', refresh: 'r', expires: 1 })
    let resolveRead: ((snapshot: CodexEntrySnapshot) => void) | undefined
    const pi = fakeFeedTarget()
    pi.read.mockImplementationOnce(() => new Promise<CodexEntrySnapshot>((resolve) => { resolveRead = resolve }))
    const opencode = fakeFeedTarget()
    const sync = new CredentialSync({ vault })
    sync.configure({ pi: pi.target, opencode: opencode.target })
    const reconcile = (sync as unknown as { handleExternalChange(engine: 'pi'): Promise<void> }).handleExternalChange('pi')
    await Promise.resolve()
    await sync.disconnectChatgpt()
    resolveRead!({ access: 'new', refresh: 'new', expires: 999_999 })
    await reconcile
    expect(save).not.toHaveBeenCalled()
    expect(state.current).toBeNull()
    expect(pi.feed).not.toHaveBeenCalled()
    expect(opencode.feed).not.toHaveBeenCalled()
  })

  it('preserves non-ChatGPT vault credentials, removes both native copies, and is idempotent', async () => {
    let current: VaultCredential | null = {
      type: 'oauth',
      access: 'a',
      refresh: 'r',
      expires: Date.now() + 1
    }
    const removeCredential = vi.fn(async (id: string) => {
      expect(id).toBe('chatgpt')
      current = null
    })
    const vault: VaultLike = {
      load: async () => current,
      save: vi.fn(),
      removeCredential,
      beginLogin: vi.fn(async () => ({ authorizeUrl: 'https://example.test' })),
      completeLogin: vi.fn(),
      cancelLogin: vi.fn()
    }
    const pi = fakeFeedTarget()
    const opencode = fakeFeedTarget()
    const sync = new CredentialSync({
      vault,
      getEnabledRoutes: () => ({ pi: false, opencode: false })
    })
    sync.configure({ pi: pi.target, opencode: opencode.target })
    await sync.disconnectChatgpt()
    await sync.disconnectChatgpt()
    expect(removeCredential).toHaveBeenCalledTimes(2)
    expect(pi.remove).toHaveBeenCalledWith('openai-codex')
    expect(opencode.remove).toHaveBeenCalledWith('openai')
    expect(sync.needsReauth).toBe(false)
    await expect(sync.getStatus()).resolves.toEqual({ connected: false, needsReauth: false })
  })
})

// ---------------------------------------------------------------------------
// 1b. getStatus() — M6c's read-only UI snapshot (PiVendors.tsx's Connect ChatGPT)
// ---------------------------------------------------------------------------

describe('CredentialSync.getStatus', () => {
  it('not connected when the vault is empty', async () => {
    const sync = new CredentialSync({ vault: makeFakeVault(null).vault })
    const status = await sync.getStatus()
    expect(status).toEqual({ connected: false, needsReauth: false })
  })

  it('connected, with email/accountId/expiresAt from the vault credential', async () => {
    const cred: VaultCredential = {
      type: 'oauth',
      access: 'acc',
      refresh: 'ref',
      expires: 999_999,
      accountId: 'acct-1',
      email: 'user@example.com'
    }
    const sync = new CredentialSync({ vault: makeFakeVault(cred).vault })
    const status = await sync.getStatus()
    expect(status).toEqual({
      connected: true,
      email: 'user@example.com',
      accountId: 'acct-1',
      expiresAt: 999_999,
      needsReauth: false
    })
  })

  it('connected but missing email/accountId omits those keys rather than reporting them as undefined values', async () => {
    const cred: VaultCredential = { type: 'oauth', access: 'acc', refresh: 'ref', expires: 42 }
    const sync = new CredentialSync({ vault: makeFakeVault(cred).vault })
    const status = await sync.getStatus()
    expect(status).toEqual({ connected: true, expiresAt: 42, needsReauth: false })
    expect('email' in status).toBe(false)
    expect('accountId' in status).toBe(false)
  })

  it('never returns access/refresh token material', async () => {
    const cred: VaultCredential = {
      type: 'oauth',
      access: 'secret-access',
      refresh: 'secret-refresh',
      expires: 1
    }
    const sync = new CredentialSync({ vault: makeFakeVault(cred).vault })
    const status = await sync.getStatus()
    expect(status).not.toHaveProperty('access')
    expect(status).not.toHaveProperty('refresh')
    expect(JSON.stringify(status)).not.toContain('secret-')
  })

  it('reflects needsReauth after a revoked refresh, even though the credential is still in the vault', async () => {
    const cred: VaultCredential = {
      type: 'oauth',
      access: 'a',
      refresh: 'r',
      expires: Date.now() + 1000
    }
    const { vault } = makeFakeVault(cred)
    const refreshAccessToken = vi.fn(async () => {
      throw new Error('Token refresh failed: 400 - {"error":"invalid_grant"}')
    })
    const sync = new CredentialSync({ vault, refreshAccessToken })
    await sync.refreshNow()
    expect(sync.needsReauth).toBe(true)

    const status = await sync.getStatus()
    expect(status.connected).toBe(true) // credential is untouched in the vault
    expect(status.needsReauth).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2. Sole-refresher scheduler
// ---------------------------------------------------------------------------

describe('CredentialSync — refresh scheduler', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('schedules the refresh at expires - REFRESH_MARGIN_MS', async () => {
    vi.useFakeTimers()
    const now = Date.now()
    const { vault } = makeFakeVault({
      type: 'oauth',
      access: 'a1',
      refresh: 'r1',
      expires: now + REFRESH_MARGIN_MS + 1000
    })
    const refreshAccessToken = vi.fn(async () => ({
      access_token: 'a2',
      refresh_token: 'r2',
      expires_in: 3600
    }))
    const sync = new CredentialSync({ vault, refreshAccessToken })
    sync.configure({ pi: fakeFeedTarget().target, opencode: fakeFeedTarget().target })

    await sync.start()
    await vi.advanceTimersByTimeAsync(999)
    expect(refreshAccessToken).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2)
    expect(refreshAccessToken).toHaveBeenCalledTimes(1)
    expect(refreshAccessToken).toHaveBeenCalledWith('r1')
  })

  it('refreshes ~immediately when the margin has already passed', async () => {
    vi.useFakeTimers()
    const now = Date.now()
    const { vault } = makeFakeVault({
      type: 'oauth',
      access: 'a1',
      refresh: 'r1',
      expires: now + 1000
    })
    const refreshAccessToken = vi.fn(async () => ({
      access_token: 'a2',
      refresh_token: 'r2',
      expires_in: 3600
    }))
    const sync = new CredentialSync({ vault, refreshAccessToken })
    sync.configure({ pi: fakeFeedTarget().target, opencode: fakeFeedTarget().target })

    await sync.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(refreshAccessToken).toHaveBeenCalledTimes(1)
  })

  it('on fire: refreshes, saves the ROTATED (returned) token, feeds both stores, and reschedules from the new expiry', async () => {
    vi.useFakeTimers()
    const now = Date.now()
    const { vault, save } = makeFakeVault({
      type: 'oauth',
      access: 'a1',
      refresh: 'r1',
      expires: now + 1000,
      accountId: 'acct-orig'
    })
    const refreshAccessToken = vi.fn(async () => ({
      access_token: 'a2',
      refresh_token: 'r2',
      expires_in: 3600
    }))
    const pi = fakeFeedTarget()
    const opencode = fakeFeedTarget()
    const sync = new CredentialSync({ vault, refreshAccessToken })
    sync.configure({ pi: pi.target, opencode: opencode.target })

    await sync.start()
    await vi.advanceTimersByTimeAsync(0)

    // Rotated token stored — never the one passed in (r1).
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ refresh: 'r2', access: 'a2', accountId: 'acct-orig' })
    )
    expect(pi.feed).toHaveBeenCalledWith('openai-codex', expect.objectContaining({ refresh: 'r2' }))
    expect(opencode.feed).toHaveBeenCalledWith('openai', expect.objectContaining({ refresh: 'r2' }))

    refreshAccessToken.mockClear()
    // Rescheduled from the NEW expiry (now + 3_600_000), not the old one.
    await vi.advanceTimersByTimeAsync(3_600_000 - REFRESH_MARGIN_MS - 1)
    expect(refreshAccessToken).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2)
    expect(refreshAccessToken).toHaveBeenCalledTimes(1)
    expect(refreshAccessToken).toHaveBeenCalledWith('r2')
  })

  it('SINGLE-FLIGHT: concurrent refresh attempts are deduped into one HTTP call', async () => {
    const now = Date.now()
    const { vault } = makeFakeVault({
      type: 'oauth',
      access: 'a1',
      refresh: 'r1',
      expires: now + 999_999
    })
    let resolveFetch:
      | ((v: { access_token: string; refresh_token: string; expires_in: number }) => void)
      | undefined
    const refreshAccessToken = vi.fn(
      () =>
        new Promise<{ access_token: string; refresh_token: string; expires_in: number }>(
          (resolve) => {
            resolveFetch = resolve
          }
        )
    )
    const sync = new CredentialSync({ vault, refreshAccessToken })
    sync.configure({ pi: fakeFeedTarget().target, opencode: fakeFeedTarget().target })

    const p1 = sync.refreshNow()
    const p2 = sync.refreshNow()
    // Both refreshNow() calls resolve `vault.load()` (a microtask) before
    // reaching the refreshAccessToken call — flush the microtask queue.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(refreshAccessToken).toHaveBeenCalledTimes(1)

    resolveFetch!({ access_token: 'a2', refresh_token: 'r2', expires_in: 3600 })
    await Promise.all([p1, p2])
    expect(refreshAccessToken).toHaveBeenCalledTimes(1)
  })

  it('a revoked refresh token (HTTP 400 invalid_grant) STOPS the scheduler and sets needsReauth — no retry', async () => {
    vi.useFakeTimers()
    const now = Date.now()
    const { vault } = makeFakeVault({
      type: 'oauth',
      access: 'a1',
      refresh: 'r1',
      expires: now + 1000
    })
    const refreshAccessToken = vi.fn(async () => {
      // The real RFC 6749 §5.2 revocation shape codex-oauth.ts now surfaces.
      throw new Error('Token refresh failed: 400 - {"error":"invalid_grant"}')
    })
    const sync = new CredentialSync({ vault, refreshAccessToken })
    sync.configure({ pi: fakeFeedTarget().target, opencode: fakeFeedTarget().target })

    await sync.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(sync.needsReauth).toBe(true)
    refreshAccessToken.mockClear()
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
    expect(refreshAccessToken).not.toHaveBeenCalled()
  })

  it('a transient network error retries with linear backoff (RETRY_BASE_MS * attempt), then succeeds and reschedules', async () => {
    vi.useFakeTimers()
    const now = Date.now()
    const { vault, save } = makeFakeVault({
      type: 'oauth',
      access: 'a1',
      refresh: 'r1',
      expires: now + 1000
    })
    const refreshAccessToken = vi
      .fn<() => Promise<{ access_token: string; refresh_token: string; expires_in: number }>>()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce({ access_token: 'a2', refresh_token: 'r2', expires_in: 3600 })
    const sync = new CredentialSync({ vault, refreshAccessToken })
    sync.configure({ pi: fakeFeedTarget().target, opencode: fakeFeedTarget().target })

    await sync.start()
    await vi.advanceTimersByTimeAsync(0) // attempt 1 fails
    expect(refreshAccessToken).toHaveBeenCalledTimes(1)
    expect(sync.needsReauth).toBe(false) // transient, not revoked

    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS - 1)
    expect(refreshAccessToken).toHaveBeenCalledTimes(1) // not yet — backoff hasn't elapsed
    await vi.advanceTimersByTimeAsync(2)
    expect(refreshAccessToken).toHaveBeenCalledTimes(2) // retry fires, succeeds
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ refresh: 'r2' }))
  })

  it('gives up after MAX_TRANSIENT_RETRIES consecutive transient failures but keeps trying (does NOT set needsReauth, unlike a 401)', async () => {
    vi.useFakeTimers()
    const now = Date.now()
    const { vault } = makeFakeVault({
      type: 'oauth',
      access: 'a1',
      refresh: 'r1',
      expires: now + 1000
    })
    const refreshAccessToken = vi.fn(async () => {
      throw new Error('fetch failed')
    })
    const sync = new CredentialSync({ vault, refreshAccessToken })
    sync.configure({ pi: fakeFeedTarget().target, opencode: fakeFeedTarget().target })

    await sync.start()
    // 10 minutes of virtual time comfortably exceeds the 30s+60s+90s backoff
    // chain (180s) for one full give-up cycle, so this proves it neither
    // gets stuck nor stops entirely.
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)

    expect(refreshAccessToken.mock.calls.length).toBeGreaterThanOrEqual(MAX_TRANSIENT_RETRIES + 1)
    expect(sync.needsReauth).toBe(false)
  })

  it('stop() clears pending timers — no further refresh attempt fires', async () => {
    vi.useFakeTimers()
    const now = Date.now()
    const { vault } = makeFakeVault({
      type: 'oauth',
      access: 'a1',
      refresh: 'r1',
      expires: now + 5000
    })
    const refreshAccessToken = vi.fn(async () => ({
      access_token: 'a2',
      refresh_token: 'r2',
      expires_in: 3600
    }))
    const sync = new CredentialSync({ vault, refreshAccessToken })
    sync.configure({ pi: fakeFeedTarget().target, opencode: fakeFeedTarget().target })

    await sync.start()
    sync.stop()
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
    expect(refreshAccessToken).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 2a. Refresh identity guard (M-AT2) — a late refresh of the OLD credential
// must not clobber state after a watch-adoption landed a newer one.
//
// RED-FIRST NOTE: pre-fix, doRefresh's catch was `if (isCurrent(generation))
// handleRefreshError(...)`. Adoption does NOT bump the generation, so the stale
// invalid_grant still ran handleRefreshError → set needsReauth AND cleared the
// freshly-armed timer. Both post-fix assertions (needsReauth false, timer alive)
// FAIL against that code.
// ---------------------------------------------------------------------------

describe('CredentialSync — refresh identity guard (M-AT2)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a superseded refresh (adoption landed a newer credential mid-flight) does NOT set needsReauth or clear the adopted timer', async () => {
    vi.useFakeTimers()
    const now = Date.now()
    const { vault, state } = makeFakeVault({
      type: 'oauth',
      access: 'a1',
      refresh: 'r1',
      expires: now + 1000
    })
    let rejectRefresh: ((err: unknown) => void) | undefined
    const refreshAccessToken = vi.fn(
      () =>
        new Promise<{ access_token: string; refresh_token: string; expires_in: number }>(
          (_resolve, reject) => {
            rejectRefresh = reject
          }
        )
    )
    const pi = fakeFeedTarget()
    // pi's store holds a newer, externally-rotated credential to be adopted.
    pi.read.mockResolvedValue({ access: 'a2', refresh: 'r2', expires: now + 5_000_000 })
    const opencode = fakeFeedTarget()
    const sync = new CredentialSync({ vault, refreshAccessToken })
    sync.configure({ pi: pi.target, opencode: opencode.target })

    // Kick a refresh of C1 — loads C1, calls refreshAccessToken('r1') (pending).
    const refreshP = sync.refreshNow()
    await Promise.resolve()
    expect(refreshAccessToken).toHaveBeenCalledWith('r1')

    // A watch-adoption of the newer C2 lands while refresh(C1) is in flight.
    await (
      sync as unknown as { handleExternalChange(engine: 'pi'): Promise<void> }
    ).handleExternalChange('pi')
    expect(state.current?.refresh).toBe('r2')
    expect(vi.getTimerCount()).toBeGreaterThan(0) // adoption armed a refresh timer

    // The stale refresh(C1) now settles with invalid_grant (r1 was rotated out).
    rejectRefresh!(new Error('Token refresh failed: 400 - {"error":"invalid_grant"}'))
    await refreshP

    // Identity guard: the superseded failure must be ignored entirely.
    expect(sync.needsReauth).toBe(false)
    expect(vi.getTimerCount()).toBeGreaterThan(0) // adopted timer survived
    expect(state.current?.refresh).toBe('r2') // vault still holds the adopted credential
    sync.stop()
  })
})

// ---------------------------------------------------------------------------
// 2b. Reconcile-on-start (Finding A) — the app was closed across expiry; an
// engine refreshed standalone and rotated the token out from under the vault.
// ---------------------------------------------------------------------------

describe('CredentialSync.start — reconcile across vault + engine stores', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /** A fakeFeedTarget whose readOauthEntry returns a preset snapshot (or null). */
  function readableTarget(snapshot: CodexEntrySnapshot | null): {
    target: CodexFeedTarget
    feed: ReturnType<typeof vi.fn>
  } {
    const { target, feed, read } = fakeFeedTarget()
    read.mockResolvedValue(snapshot)
    return { target, feed }
  }

  it('ENGINE-NEWER-ADOPTS: adopts the engine store credential when it has a different token AND a strictly-newer expiry, saving + feeding both, scheduling off the new expiry', async () => {
    vi.useFakeTimers()
    const now = Date.now()
    const { vault, save, state } = makeFakeVault({
      type: 'oauth',
      access: 'a-old',
      refresh: 'r-old',
      expires: now + 1000
    })
    const pi = readableTarget({
      access: 'a-new',
      refresh: 'r-new',
      expires: now + REFRESH_MARGIN_MS + 5000,
      accountId: 'acct-eng'
    })
    const opencode = readableTarget(null)
    const refreshAccessToken = vi.fn(async () => ({
      access_token: 'a3',
      refresh_token: 'r3',
      expires_in: 3600
    }))
    const sync = new CredentialSync({ vault, refreshAccessToken })
    sync.configure({ pi: pi.target, opencode: opencode.target })

    await sync.start()

    // Adopted the engine credential into the vault + fed the OTHER store.
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        refresh: 'r-new',
        expires: now + REFRESH_MARGIN_MS + 5000,
        accountId: 'acct-eng'
      })
    )
    expect(opencode.feed).toHaveBeenCalledWith(
      'openai',
      expect.objectContaining({ refresh: 'r-new' })
    )
    expect(state.current?.refresh).toBe('r-new')

    // Scheduled off the ADOPTED expiry — not the stale vault one (which would fire immediately).
    await vi.advanceTimersByTimeAsync(4999)
    expect(refreshAccessToken).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2)
    expect(refreshAccessToken).toHaveBeenCalledWith('r-new')
  })

  it('VAULT-NEWEST-KEEPS: keeps the vault credential (no save) when it is newer than the engine stores', async () => {
    vi.useFakeTimers()
    const now = Date.now()
    const { vault, save } = makeFakeVault({
      type: 'oauth',
      access: 'a-vault',
      refresh: 'r-vault',
      expires: now + REFRESH_MARGIN_MS + 5000
    })
    const pi = readableTarget({ access: 'a-eng', refresh: 'r-eng', expires: now + 1000 }) // older
    const opencode = readableTarget(null)
    const refreshAccessToken = vi.fn(async () => ({
      access_token: 'x',
      refresh_token: 'y',
      expires_in: 3600
    }))
    const sync = new CredentialSync({ vault, refreshAccessToken })
    sync.configure({ pi: pi.target, opencode: opencode.target })

    await sync.start()

    expect(save).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(4999)
    expect(refreshAccessToken).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2)
    expect(refreshAccessToken).toHaveBeenCalledWith('r-vault')
  })

  it('does NOT adopt an engine credential whose expiry equals the vault (strictly-newer only) even with a different token', async () => {
    const now = Date.now()
    const { vault, save } = makeFakeVault({
      type: 'oauth',
      access: 'a-vault',
      refresh: 'r-vault',
      expires: now + 100_000
    })
    const pi = readableTarget({ access: 'a-eng', refresh: 'r-eng', expires: now + 100_000 }) // equal expiry, different token
    const opencode = readableTarget(null)
    const sync = new CredentialSync({ vault })
    sync.configure({ pi: pi.target, opencode: opencode.target })

    await sync.start()
    expect(save).not.toHaveBeenCalled()
    sync.stop()
  })

  it('VAULT-EMPTY-ADOPTS-ENGINE: bootstraps the vault from an existing engine credential when the vault is empty', async () => {
    const now = Date.now()
    const { vault, save, state } = makeFakeVault(null)
    const pi = readableTarget(null)
    const opencode = readableTarget({
      access: 'a-oc',
      refresh: 'r-oc',
      expires: now + 200_000,
      accountId: 'acct-oc'
    })
    const sync = new CredentialSync({ vault })
    sync.configure({ pi: pi.target, opencode: opencode.target })

    await sync.start()

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ refresh: 'r-oc', accountId: 'acct-oc' })
    )
    expect(state.current?.refresh).toBe('r-oc')
    // Re-fed both stores (incl. pi, which had nothing) to converge them.
    expect(pi.feed).toHaveBeenCalledWith(
      'openai-codex',
      expect.objectContaining({ refresh: 'r-oc' })
    )
    sync.stop()
  })

  it('picks the NEWEST across both engine stores when the vault is empty', async () => {
    const now = Date.now()
    const { vault, save } = makeFakeVault(null)
    const pi = readableTarget({ access: 'a-pi', refresh: 'r-pi', expires: now + 100_000 })
    const opencode = readableTarget({ access: 'a-oc', refresh: 'r-oc', expires: now + 300_000 }) // newer
    const sync = new CredentialSync({ vault })
    sync.configure({ pi: pi.target, opencode: opencode.target })

    await sync.start()
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ refresh: 'r-oc' }))
    sync.stop()
  })

  it('EMPTY+EMPTY NO-OP: empty vault and no engine credentials → no save, no schedule', async () => {
    vi.useFakeTimers()
    const { vault, save } = makeFakeVault(null)
    const pi = readableTarget(null)
    const opencode = readableTarget(null)
    const refreshAccessToken = vi.fn(async () => ({
      access_token: 'x',
      refresh_token: 'y',
      expires_in: 3600
    }))
    const sync = new CredentialSync({ vault, refreshAccessToken })
    sync.configure({ pi: pi.target, opencode: opencode.target })

    await sync.start()

    expect(save).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
    expect(refreshAccessToken).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 3. fs-watch resync — REAL fs.watch, REAL temp files, REAL (short) timers.
// ---------------------------------------------------------------------------

describe('CredentialSync — fs-watch resync', () => {
  let tmpDir: string
  let piFile: string
  let opencodeFile: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'credential-sync-watch-'))
    mkdirSync(join(tmpDir, 'pi'), { recursive: true })
    mkdirSync(join(tmpDir, 'opencode'), { recursive: true })
    piFile = join(tmpDir, 'pi', 'auth.json')
    opencodeFile = join(tmpDir, 'opencode', 'auth.json')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('adopts an externally-rotated credential with a NEWER expiry, re-feeds the other store, and does not re-adopt its own re-feed (loop guard)', async () => {
    const now = Date.now()
    const initial: VaultCredential = {
      type: 'oauth',
      access: 'a1',
      refresh: 'r1',
      expires: now + 999_999
    }
    const { vault, save } = makeFakeVault(initial)
    const pi = makeRealFeedTarget(piFile)
    const opencode = makeRealFeedTarget(opencodeFile)
    writeRaw(piFile, 'openai-codex', { access: 'a1', refresh: 'r1', expires: initial.expires })

    const sync = new CredentialSync({ vault, watchDebounceMs: 100 })
    sync.configure({ pi: pi.target, opencode: opencode.target })
    await sync.start()

    try {
      writeRaw(piFile, 'openai-codex', { access: 'a2', refresh: 'r2', expires: now + 1_999_999 })
      await sleep(350)

      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({ refresh: 'r2', expires: now + 1_999_999 })
      )
      expect(opencode.feed).toHaveBeenCalledWith(
        'openai',
        expect.objectContaining({ refresh: 'r2' })
      )

      // feedAll's own re-write of pi's file (re-syncing the source engine
      // too) fires the SAME watcher again — the loop guard (refresh token
      // now matches the vault's) must prevent a second adopt.
      await sleep(350)
      expect(save).toHaveBeenCalledTimes(1)
    } finally {
      sync.stop()
    }
  })

  it("the vault's OWN feedAll write does not trigger an adopt (loop guard)", async () => {
    const now = Date.now()
    const initial: VaultCredential = {
      type: 'oauth',
      access: 'a1',
      refresh: 'r1',
      expires: now + 999_999
    }
    const { vault, save } = makeFakeVault(initial)
    const pi = makeRealFeedTarget(piFile)
    const opencode = makeRealFeedTarget(opencodeFile)

    const sync = new CredentialSync({ vault, watchDebounceMs: 100 })
    sync.configure({ pi: pi.target, opencode: opencode.target })
    await sync.start()

    try {
      await sync.feedAll(initial) // writes refresh='r1' — identical to the vault's current credential
      await sleep(350)
      expect(save).not.toHaveBeenCalled()
    } finally {
      sync.stop()
    }
  })

  it('ignores an externally-written credential that is OLDER (earlier expires) than the vault current one', async () => {
    const now = Date.now()
    const initial: VaultCredential = {
      type: 'oauth',
      access: 'a1',
      refresh: 'r1',
      expires: now + 999_999
    }
    const { vault, save } = makeFakeVault(initial)
    const pi = makeRealFeedTarget(piFile)
    const opencode = makeRealFeedTarget(opencodeFile)
    writeRaw(piFile, 'openai-codex', { access: 'a1', refresh: 'r1', expires: initial.expires })

    const sync = new CredentialSync({ vault, watchDebounceMs: 100 })
    sync.configure({ pi: pi.target, opencode: opencode.target })
    await sync.start()

    try {
      writeRaw(piFile, 'openai-codex', { access: 'a0', refresh: 'r0', expires: now + 1000 }) // different + OLDER
      await sleep(350)
      expect(save).not.toHaveBeenCalled()
    } finally {
      sync.stop()
    }
  })

  it('debounces rapid successive external writes into a single reconciliation using the LAST value', async () => {
    const now = Date.now()
    const initial: VaultCredential = {
      type: 'oauth',
      access: 'a1',
      refresh: 'r1',
      expires: now + 999_999
    }
    const { vault, save } = makeFakeVault(initial)
    const pi = makeRealFeedTarget(piFile)
    const opencode = makeRealFeedTarget(opencodeFile)
    writeRaw(piFile, 'openai-codex', { access: 'a1', refresh: 'r1', expires: initial.expires })

    const sync = new CredentialSync({ vault, watchDebounceMs: 150 })
    sync.configure({ pi: pi.target, opencode: opencode.target })
    await sync.start()

    try {
      for (let i = 0; i < 5; i++) {
        writeRaw(piFile, 'openai-codex', {
          access: `a${i}`,
          refresh: `r${i}`,
          expires: now + 2_000_000 + i
        })
        await sleep(20) // well within the 150ms debounce window
      }
      await sleep(450) // past the debounce window
      expect(save).toHaveBeenCalledTimes(1)
      expect(save).toHaveBeenCalledWith(expect.objectContaining({ refresh: 'r4' }))
    } finally {
      sync.stop()
    }
  })
})
