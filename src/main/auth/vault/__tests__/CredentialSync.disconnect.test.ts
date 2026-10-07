/**
 * @vitest-environment node
 *
 * ADR-082 §8 "As built (S7e)" (owner ruling 2026-10-01) — disconnecting ChatGPT
 * takes out only the pi/opencode sign-ins ClaudeUI put there; one made directly
 * in a harness stays, and ClaudeUI does not sign itself back in from it at the
 * next start until the user signs in through ClaudeUI again.
 *
 * SAFETY: `node:os`.homedir is mocked to a temp directory, so the REAL AuthVault
 * (and the marker it keeps) runs with real storage semantics and never touches
 * the real `~/.claude/ui`. pi's store is an in-memory map, never `~/.pi`;
 * opencode 2.x is the real credential store over an in-memory credential
 * table (ADR-093 §5: ClaudeUI's rows are known by id), never a real opencode; no refresh runs (an injected fake refuses) and
 * every login flow is a fake. Every token string is an obvious fake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = vi.hoisted(() => ({ value: '' }))
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, homedir: () => home.value, default: { ...actual, homedir: () => home.value } }
})

import { AuthVault, CHATGPT_PROVIDER_ID, vaultPath } from '../../../../core/auth/vault/AuthVault'
import {
  CredentialSync,
  OPENCODE_CODEX_VENDOR_ID,
  PI_CODEX_VENDOR_ID,
  type CodexEntrySnapshot,
  type CodexFeedTarget,
  type VaultLike
} from '../../../../core/auth/vault/CredentialSync'
import type {
  LoginFlow,
  TokenResponse,
  VaultCredential
} from '../../../../core/auth/vault/codex-oauth'
import {
  FED_TOKEN_HISTORY_CAP,
  fedTokenHistory,
  memoryFedTokenHistory
} from '../../../../core/auth/vault/fed-token-history'
import { storeBackedOpencode } from './fixtures/fake-opencode-target'

type Engine = 'pi' | 'opencode'

const DAY = 24 * 60 * 60 * 1000

let testHome: string
beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), 'credential-sync-disconnect-'))
  home.value = testHome
})
afterEach(() => rmSync(testHome, { recursive: true, force: true }))

function cred(refresh: string, ws?: string, expiresIn = 10 * DAY): VaultCredential {
  return {
    type: 'oauth',
    access: `fake-access-${refresh}`,
    refresh,
    expires: Date.now() + expiresIn,
    ...(ws ? { accountId: ws } : {})
  }
}

/** An engine entry; older than a vault credential by default, so a feed does not see it as a rotation. */
function entry(refresh: string, expiresIn = 5 * DAY): CodexEntrySnapshot {
  return { access: `fake-access-${refresh}`, refresh, expires: Date.now() + expiresIn }
}

/** One engine's auth store: an in-memory map, so a removal is gone for the next read. */
function engineStore(engine: Engine) {
  const store = new Map<string, CodexEntrySnapshot>()
  const vendorId = engine === 'pi' ? PI_CODEX_VENDOR_ID : OPENCODE_CODEX_VENDOR_ID
  const feed = vi.fn(async (id: string, input: CodexEntrySnapshot) => void store.set(id, input))
  const remove = vi.fn(async (id: string) => void store.delete(id))
  const removeDirect = vi.fn(async (id: string) => void store.delete(id))
  const target: CodexFeedTarget = {
    // A directory that never exists, so no fs.watch is armed.
    authFilePath: () => join(testHome, 'no-such-dir', `${engine}-auth.json`),
    feedOauthCredential: feed,
    readOauthEntry: async (id) => store.get(id) ?? null,
    removeVendorAuth: remove,
    ...(engine === 'opencode' ? { removeVendorAuthDirect: removeDirect } : {})
  }
  return {
    target,
    feed,
    remove,
    removeDirect,
    holds: (refresh: string | null): void => {
      if (refresh === null) store.delete(vendorId)
      else store.set(vendorId, entry(refresh))
    },
    held: (): string | undefined => store.get(vendorId)?.refresh
  }
}

/** A login flow that completes with `credential`, by loopback or by paste. */
function fakeFlow(credential: VaultCredential): LoginFlow {
  return {
    start: async () => ({ authorizeUrl: 'https://auth.invalid/authorize', state: 's' }),
    waitForCallback: async () => credential,
    completeFromPastedInput: async () => credential,
    cancel: () => {}
  }
}

function setup(
  opts: {
    running?: Partial<Record<Engine, boolean>>
    login?: VaultCredential
    refreshAccessToken?: (refresh: string) => Promise<TokenResponse>
    watchDebounceMs?: number
  } = {}
) {
  const running = { pi: true, opencode: true, ...opts.running }
  /** Shared across boots, as the file is in production. */
  const history = memoryFedTokenHistory()
  const login = opts.login ?? cred('fake-login')
  const vault = new AuthVault({
    loginFlowFactory: () => fakeFlow(login),
    deviceCodeFlowFactory: () => ({
      start: async () => ({
        verificationUrl: 'https://auth.invalid/device',
        userCode: 'FAKE-CODE',
        expiresAt: Date.now() + 60_000
      }),
      waitForCompletion: async () => login,
      cancel: () => {}
    })
  })
  const pi = engineStore('pi')
  const opencode = storeBackedOpencode(() => running.opencode)
  /** A fresh CredentialSync over the same vault file and engine stores: an app restart. */
  const boot = (): CredentialSync => {
    const sync = new CredentialSync({
      vault,
      refreshAccessToken:
        opts.refreshAccessToken ??
        (async () => {
          throw new Error('no refresh in this test')
        }),
      harnessRuns: (engine) => running[engine],
      fedTokens: history,
      ...(opts.watchDebounceMs !== undefined ? { watchDebounceMs: opts.watchDebounceMs } : {})
    })
    sync.configure({ pi: pi.target, opencode: opencode.target })
    return sync
  }
  return { vault, pi, opencode, running, boot, history }
}

describe('a ChatGPT disconnect takes out only what ClaudeUI put in (S7e)', () => {
  it('pi holds ClaudeUI’s copy, opencode a direct sign-in: pi’s goes, opencode’s stays', async () => {
    const h = setup()
    await h.vault.upsertAccount(CHATGPT_PROVIDER_ID, cred('fake-ours', 'ws-a'))
    h.pi.holds('fake-ours')
    h.opencode.holdsOwn('fake-own-opencode-login')

    await h.boot().disconnectChatgpt()

    expect(h.pi.remove).toHaveBeenCalledWith(PI_CODEX_VENDOR_ID)
    expect(h.pi.held()).toBeUndefined()
    // opencode 2.x: nothing of ClaudeUI's was there; the user's row is untouched.
    expect(h.opencode.table.calls.filter((call) => call.includes('cred_user'))).toEqual([])
    expect(h.opencode.held()).toBe('fake-own-opencode-login')
    await expect(h.vault.listAccounts(CHATGPT_PROVIDER_ID)).resolves.toEqual([])
  })

  it('both hold ClaudeUI’s copy: both go', async () => {
    const h = setup()
    await h.vault.upsertAccount(CHATGPT_PROVIDER_ID, cred('fake-ours', 'ws-a'))
    h.pi.holds('fake-ours')
    await h.opencode.holdsOurs('fake-ours')

    await h.boot().disconnectChatgpt()

    expect(h.pi.held()).toBeUndefined()
    expect(h.opencode.held()).toBeUndefined()
    expect(h.opencode.ours()).toEqual([])
  })

  it('an engine holding a NON-active account’s token holds ClaudeUI’s copy too', async () => {
    const h = setup()
    const a = await h.vault.upsertAccount(CHATGPT_PROVIDER_ID, cred('fake-ra', 'ws-a'))
    await h.vault.upsertAccount(CHATGPT_PROVIDER_ID, cred('fake-rb', 'ws-b'))
    await expect(h.vault.getActiveAccountId(CHATGPT_PROVIDER_ID)).resolves.toBe(a.id)
    // pi was fed account B while it was active; opencode holds the active A.
    h.pi.holds('fake-rb')
    await h.opencode.holdsOurs('fake-ra')

    await h.boot().disconnectChatgpt()

    expect(h.pi.held()).toBeUndefined()
    expect(h.opencode.held()).toBeUndefined()
  })

  it('opencode not installed: ClaudeUI’s rows go once it can run (2.x has no file to edit); a direct sign-in stays', async () => {
    const h = setup({ running: { pi: true, opencode: false } })
    await h.vault.upsertAccount(CHATGPT_PROVIDER_ID, cred('fake-ours', 'ws-a'))
    await h.opencode.holdsOurs('fake-ours')
    await h.boot().disconnectChatgpt()
    // Recorded, waiting for opencode: no server could be started.
    expect(h.opencode.ours()).toEqual(['cred_claudeui_acct-test_v1'])
    h.running.opencode = true
    await h.opencode.store.flushPending()
    expect(h.opencode.ours()).toEqual([])
    expect(h.opencode.held()).toBeUndefined()

    const other = setup({ running: { pi: true, opencode: false } })
    await other.vault.upsertAccount(CHATGPT_PROVIDER_ID, cred('fake-ours', 'ws-a'))
    other.opencode.holdsOwn('fake-own-opencode-login')
    await other.boot().disconnectChatgpt()
    other.running.opencode = true
    await other.opencode.store.flushPending()
    expect(other.opencode.held()).toBe('fake-own-opencode-login')
  })
})

describe('removing the last account is the same disconnect (S7e)', () => {
  it('takes out ClaudeUI’s copy only, and leaves the marker', async () => {
    const h = setup()
    const only = await h.vault.upsertAccount(CHATGPT_PROVIDER_ID, cred('fake-ours', 'ws-a'))
    h.pi.holds('fake-own-pi-login')
    await h.opencode.holdsOurs('fake-ours')

    await h.boot().removeAccount(only.id)

    expect(h.pi.remove).not.toHaveBeenCalled()
    expect(h.pi.held()).toBe('fake-own-pi-login')
    expect(h.opencode.held()).toBeUndefined()
    await expect(h.vault.isDisconnected(CHATGPT_PROVIDER_ID)).resolves.toBe(true)
  })

  it('a removal that leaves an account is no disconnect: the promoted one is fed, no marker', async () => {
    const h = setup()
    const a = await h.vault.upsertAccount(CHATGPT_PROVIDER_ID, cred('fake-ra', 'ws-a'))
    await h.vault.upsertAccount(CHATGPT_PROVIDER_ID, cred('fake-rb', 'ws-b'))
    h.pi.holds('fake-ra')

    await h.boot().removeAccount(a.id)

    expect(h.pi.held()).toBe('fake-rb')
    expect(h.pi.remove).not.toHaveBeenCalled()
    await expect(h.vault.isDisconnected(CHATGPT_PROVIDER_ID)).resolves.toBe(false)
  })

  it('a restart after it does not sign in from the sign-in pi kept', async () => {
    const h = setup()
    const only = await h.vault.upsertAccount(CHATGPT_PROVIDER_ID, cred('fake-ours', 'ws-a'))
    h.pi.holds('fake-own-pi-login')
    await h.boot().removeAccount(only.id)

    const restarted = h.boot()
    await restarted.start()

    await expect(h.vault.load()).resolves.toBeNull()
    expect(h.opencode.feed).not.toHaveBeenCalled()
    restarted.stop()
  })
})

describe('no silent sign-in after a disconnect (S7e)', () => {
  it('a restart leaves the vault empty although an engine kept its own sign-in', async () => {
    const h = setup()
    await h.vault.upsertAccount(CHATGPT_PROVIDER_ID, cred('fake-ours', 'ws-a'))
    h.pi.holds('fake-ours')
    h.opencode.holdsOwn('fake-own-opencode-login')
    await h.boot().disconnectChatgpt()
    await expect(h.vault.isDisconnected(CHATGPT_PROVIDER_ID)).resolves.toBe(true)

    const restarted = h.boot()
    await restarted.start()

    await expect(h.vault.load()).resolves.toBeNull()
    await expect(restarted.getStatus()).resolves.toMatchObject({ connected: false })
    // Nothing was vended from the kept sign-in either.
    expect(h.pi.feed).not.toHaveBeenCalled()
    expect(h.opencode.held()).toBe('fake-own-opencode-login')
    restarted.stop()
  })

  it('the watcher does not adopt a kept sign-in while disconnected', async () => {
    const h = setup()
    await h.vault.upsertAccount(CHATGPT_PROVIDER_ID, cred('fake-ours', 'ws-a'))
    const sync = h.boot()
    await sync.disconnectChatgpt()
    // pi signs in on its own, and its auth file changes.
    h.pi.holds('fake-own-pi-login')
    await (
      sync as unknown as { handleExternalChange(engine: Engine): Promise<void> }
    ).handleExternalChange('pi')

    await expect(h.vault.load()).resolves.toBeNull()
    expect(h.opencode.feed).not.toHaveBeenCalled()
    sync.stop()
  })

  it.each([
    ['the desktop loopback', (s: CredentialSync) => s.beginLogin().then(() => s.completeLogin())],
    [
      'the remote paste-back',
      (s: CredentialSync) => s.beginLogin().then(() => s.completeLogin('fake-pasted-code'))
    ],
    [
      'the device code',
      (s: CredentialSync) => s.beginDeviceCodeLogin().then(() => s.completeLogin())
    ]
  ])(
    'a sign-in through ClaudeUI by %s clears the marker and the feed resumes',
    async (_path, signIn) => {
      const h = setup({ login: cred('fake-new-login', 'ws-a') })
      await h.vault.upsertAccount(CHATGPT_PROVIDER_ID, cred('fake-ours', 'ws-a'))
      const sync = h.boot()
      await sync.disconnectChatgpt()
      await expect(h.vault.isDisconnected(CHATGPT_PROVIDER_ID)).resolves.toBe(true)

      await signIn(sync)

      await expect(h.vault.isDisconnected(CHATGPT_PROVIDER_ID)).resolves.toBe(false)
      expect(h.pi.held()).toBe('fake-new-login')
      expect(h.opencode.held()).toBe('fake-new-login')
      sync.stop()

      // …and with the marker gone, an emptied vault bootstraps again as before.
      await h.vault.removeCredential(CHATGPT_PROVIDER_ID)
      const restarted = h.boot()
      await restarted.start()
      await expect(h.vault.load()).resolves.toMatchObject({ refresh: 'fake-new-login' })
      restarted.stop()
    }
  )

  it('with no marker an empty vault still bootstraps from an engine sign-in (ADR-036)', async () => {
    const h = setup()
    h.pi.holds('fake-own-pi-login')
    const sync = h.boot()
    await sync.start()
    await expect(h.vault.load()).resolves.toMatchObject({ refresh: 'fake-own-pi-login' })
    sync.stop()
  })

  it('rotation adoption while the vault holds an account is unchanged, even beside a marker', async () => {
    const h = setup()
    await h.vault.upsertAccount(CHATGPT_PROVIDER_ID, cred('fake-ours', 'ws-a', DAY))
    // A marker left beside an account (say, a crash between the sign-in and its
    // clearing) is inert: the engine rotated ClaudeUI's own token.
    await h.vault.setDisconnected(CHATGPT_PROVIDER_ID, true)
    h.pi.holds('fake-rotated')

    const sync = h.boot()
    await sync.start()

    await expect(h.vault.load()).resolves.toMatchObject({ refresh: 'fake-rotated' })
    expect(h.opencode.held()).toBe('fake-rotated')
    sync.stop()
  })

  it('the marker also stops a legacy-vault recovery', async () => {
    const save = vi.fn(async () => {})
    const vault: VaultLike = {
      load: async () => null,
      save,
      removeCredential: async () => {},
      hasUnreadableLegacyVault: () => true,
      isDisconnected: async () => true,
      beginLogin: async () => ({ authorizeUrl: 'https://auth.invalid/authorize' }),
      completeLogin: async () => {
        throw new Error('not in this test')
      },
      cancelLogin: () => {}
    }
    const pi = engineStore('pi')
    pi.holds('fake-own-pi-login')
    const sync = new CredentialSync({ vault })
    sync.configure({ pi: pi.target, opencode: storeBackedOpencode().target })
    await sync.start()
    expect(save).not.toHaveBeenCalled()
    sync.stop()
  })
})

describe('AuthVault keeps the disconnect marker (S7e)', () => {
  it('survives the provider’s accounts being emptied, and is cleared on request', async () => {
    const vault = new AuthVault()
    await vault.upsertAccount(CHATGPT_PROVIDER_ID, cred('fake-ours', 'ws-a'))
    await vault.setDisconnected(CHATGPT_PROVIDER_ID, true)
    await vault.removeCredential(CHATGPT_PROVIDER_ID)

    // The vault holds nothing else, and still keeps the file for the marker.
    expect(existsSync(vaultPath())).toBe(true)
    await expect(new AuthVault().isDisconnected(CHATGPT_PROVIDER_ID)).resolves.toBe(true)
    await expect(vault.load()).resolves.toBeNull()

    await vault.setDisconnected(CHATGPT_PROVIDER_ID, false)
    await expect(vault.isDisconnected(CHATGPT_PROVIDER_ID)).resolves.toBe(false)
    // Nothing left at all: the pre-v3 rule unlinks the file.
    expect(existsSync(vaultPath())).toBe(false)
  })

  it('is per provider, and leaves other records alone', async () => {
    const vault = new AuthVault()
    await vault.saveCredential('custom', { type: 'api_key', key: 'fake-key' })
    await vault.setDisconnected(CHATGPT_PROVIDER_ID, true)
    await expect(vault.isDisconnected('custom')).resolves.toBe(false)
    await expect(vault.loadCredential('custom')).resolves.toEqual({
      type: 'api_key',
      key: 'fake-key'
    })
    await vault.setDisconnected(CHATGPT_PROVIDER_ID, false)
    await expect(vault.loadCredential('custom')).resolves.toEqual({
      type: 'api_key',
      key: 'fake-key'
    })
  })
})

describe('a stale copy ClaudeUI put in is still ClaudeUI’s (S7e, fed-token history)', () => {
  it('the vault rotated while pi did not run: pi’s older copy goes on disconnect', async () => {
    const h = setup({
      login: cred('fake-ours', 'ws-a'),
      refreshAccessToken: async () => ({
        access_token: 'fake-access-rotated',
        refresh_token: 'fake-ours-rotated',
        expires_in: 20 * 24 * 60 * 60 // newer than the login's, as a real rotation is
      })
    })
    const sync = h.boot()
    await sync.beginLogin()
    await sync.completeLogin() // pi and opencode are fed 'fake-ours'
    expect(h.pi.held()).toBe('fake-ours')

    h.running.pi = false
    await sync.refreshNow() // the vault rotates; pi, not running, is not fed
    await expect(h.vault.load()).resolves.toMatchObject({ refresh: 'fake-ours-rotated' })
    expect(h.pi.held()).toBe('fake-ours')
    // opencode was vended the rotated access token (2.x keeps no refresh token).
    expect(h.opencode.store.vendedChatgpt()?.access).toBe('fake-access-rotated')

    await sync.disconnectChatgpt()

    expect(h.pi.held()).toBeUndefined()
    expect(h.opencode.held()).toBeUndefined()
    // Nothing of ClaudeUI's is left in either: their histories are forgotten.
    expect(h.history.holds('pi', 'fake-ours')).toBe(false)
    expect(h.history.holds('opencode', 'fake-ours-rotated')).toBe(false)
  })

  it('a sign-in never fed nor adopted stays, although the engine has a history', async () => {
    const h = setup({ login: cred('fake-ours', 'ws-a') })
    const sync = h.boot()
    await sync.beginLogin()
    await sync.completeLogin()
    expect(h.history.holds('pi', 'fake-ours')).toBe(true)
    // pi signs in on its own (no watcher here, so nothing adopts it).
    h.pi.holds('fake-own-pi-login')

    await sync.disconnectChatgpt()

    expect(h.pi.remove).not.toHaveBeenCalled()
    expect(h.pi.held()).toBe('fake-own-pi-login')
  })

  it('the last account’s removal takes out a stale copy too', async () => {
    const h = setup({ running: { pi: false } })
    const only = await h.vault.upsertAccount(CHATGPT_PROVIDER_ID, cred('fake-ours', 'ws-a'))
    h.history.record('pi', 'fake-older-ours')
    h.pi.holds('fake-older-ours')

    await h.boot().removeAccount(only.id)

    expect(h.pi.held()).toBeUndefined()
  })

  it('an engine that rotated ClaudeUI’s token just before a disconnect: its copy goes', async () => {
    const h = setup({ watchDebounceMs: 60_000 })
    await h.vault.upsertAccount(CHATGPT_PROVIDER_ID, cred('fake-ours', 'ws-a', DAY))
    const sync = h.boot()
    // pi rotated ClaudeUI's token; the watcher saw it and waits out its debounce.
    h.pi.holds('fake-pi-rotated')
    ;(sync as unknown as { debounceWatch(engine: Engine): void }).debounceWatch('pi')

    await sync.disconnectChatgpt()

    expect(h.pi.held()).toBeUndefined()
    await expect(h.vault.load()).resolves.toBeNull()
  })

  it('a rotation adopted from an engine joins that engine’s history', async () => {
    const h = setup()
    await h.vault.upsertAccount(CHATGPT_PROVIDER_ID, cred('fake-ours', 'ws-a', DAY))
    h.pi.holds('fake-pi-rotated')
    const sync = h.boot()
    await sync.start()
    expect(h.history.holds('pi', 'fake-pi-rotated')).toBe(true)
    sync.stop()
  })
})

describe('the fed-token history store (S7e)', () => {
  it('is bounded per engine: the oldest fingerprints go first', () => {
    const history = memoryFedTokenHistory()
    for (let i = 0; i < FED_TOKEN_HISTORY_CAP + 8; i++) history.record('pi', `fake-r${i}`)
    expect(history.holds('pi', 'fake-r0')).toBe(false)
    expect(history.holds('pi', 'fake-r7')).toBe(false)
    expect(history.holds('pi', 'fake-r8')).toBe(true)
    expect(history.holds('pi', `fake-r${FED_TOKEN_HISTORY_CAP + 7}`)).toBe(true)
    expect(history.holds('opencode', 'fake-r8')).toBe(false)
  })

  it('the file keeps fingerprints only, bounded, across instances, and forgets per engine', () => {
    const file = join(testHome, 'ui', 'chatgpt-fed-token-fingerprints.json')
    const history = fedTokenHistory(file)
    expect(history.holds('pi', 'fake-r0')).toBe(false) // no history: an older install
    expect(existsSync(file)).toBe(false)
    for (let i = 0; i < FED_TOKEN_HISTORY_CAP + 3; i++) history.record('pi', `fake-r${i}`)
    history.record('opencode', 'fake-oc')

    const raw = readFileSync(file, 'utf8')
    expect(raw).not.toContain('fake-r')
    expect(raw).not.toContain('fake-oc')
    const parsed = JSON.parse(raw) as Record<string, string[]>
    expect(parsed.pi).toHaveLength(FED_TOKEN_HISTORY_CAP)
    const again = fedTokenHistory(file)
    expect(again.holds('pi', 'fake-r2')).toBe(false)
    expect(again.holds('pi', 'fake-r3')).toBe(true)
    expect(again.holds('opencode', 'fake-oc')).toBe(true)

    again.forget('pi')
    expect(fedTokenHistory(file).holds('pi', 'fake-r3')).toBe(false)
    expect(fedTokenHistory(file).holds('opencode', 'fake-oc')).toBe(true)
  })
})
