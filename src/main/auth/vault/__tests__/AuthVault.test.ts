/**
 * @vitest-environment node
 *
 * Unit tests for AuthVault — tmp-dir fixtures, `os.homedir()` redirected via a
 * hoisted mock (same trick as PiAuthProvider.test.ts / account-manager.test.ts)
 * so `vaultPath()` resolves inside the fixture tree. `electron` is mocked so
 * importing AuthVault.ts (which references `safeStorage` for the singleton
 * default) never touches real Electron; every test that exercises encryption
 * passes its OWN fake `SafeStorageLike` through the ctor instead.
 *
 * SAFETY: beginLogin()/completeLogin() are driven entirely by a fake
 * `loginFlowFactory` in every test below — nothing here constructs a real
 * CodexLoginFlow or reaches auth.openai.com.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

const homedirHolder = vi.hoisted(() => ({ current: '' }))
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return {
    ...actual,
    homedir: () => homedirHolder.current,
    default: { ...actual, homedir: () => homedirHolder.current }
  }
})
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString('utf-8')
  }
}))

import { AuthVault, vaultPath, type SafeStorageLike } from '../AuthVault'
import type { LoginFlow, VaultCredential } from '../codex-oauth'

let testHome: string

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), 'claudeui-authvault-test-'))
  homedirHolder.current = testHome
})

afterEach(() => {
  rmSync(testHome, { recursive: true, force: true })
})

/** A fake safeStorage whose "encryption" is a visible, assertable transform (not real crypto). */
function makeFakeSafeStorage(available: boolean): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s: string) => Buffer.from(`ENC[${s}]`, 'utf-8'),
    decryptString: (buf: Buffer) => {
      const str = buf.toString('utf-8')
      const match = /^ENC\[([\s\S]*)\]$/.exec(str)
      if (!match) throw new Error('fake decryptString: not a recognized envelope')
      return match[1]
    }
  }
}

function readVaultFileRaw(): { v: number; encrypted: boolean; data: string } {
  return JSON.parse(readFileSync(vaultPath(), 'utf-8'))
}

describe('AuthVault — storage', () => {
  it('save() then load() round-trips through a fake "encrypted" safeStorage, tagging encrypted:true', async () => {
    const safeStorage = makeFakeSafeStorage(true)
    const vault = new AuthVault({ safeStorage })
    const cred: VaultCredential = { type: 'oauth', access: 'acc', refresh: 'ref', expires: 6000 }

    await vault.save(cred)

    const onDisk = readVaultFileRaw()
    expect(onDisk.v).toBe(1)
    expect(onDisk.encrypted).toBe(true)
    const decoded = Buffer.from(onDisk.data, 'base64').toString('utf-8')
    expect(decoded).toBe('ENC[{"openai-codex":{"type":"oauth","access":"acc","refresh":"ref","expires":6000}}]')

    expect(await vault.load()).toEqual(cred)
  })

  it('falls back to plaintext with encrypted:false when isEncryptionAvailable() is false', async () => {
    const safeStorage = makeFakeSafeStorage(false)
    const vault = new AuthVault({ safeStorage })
    const cred: VaultCredential = { type: 'oauth', access: 'acc2', refresh: 'ref2', expires: 999 }

    await vault.save(cred)

    const onDisk = readVaultFileRaw()
    expect(onDisk.encrypted).toBe(false)
    expect(JSON.parse(onDisk.data)).toEqual({ 'openai-codex': cred })
    expect(await vault.load()).toEqual(cred)
  })

  it('writes the file 0600 (POSIX only)', async () => {
    if (process.platform === 'win32') return
    const vault = new AuthVault({ safeStorage: makeFakeSafeStorage(true) })
    await vault.save({ type: 'oauth', access: 'a', refresh: 'r', expires: 1 })
    const mode = statSync(vaultPath()).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('load() returns null when the file is absent', async () => {
    const vault = new AuthVault({ safeStorage: makeFakeSafeStorage(true) })
    expect(await vault.load()).toBeNull()
  })

  it('load() returns null for a corrupt file — never throws', async () => {
    mkdirSync(dirname(vaultPath()), { recursive: true })
    writeFileSync(vaultPath(), 'this is not json', 'utf-8')
    const vault = new AuthVault({ safeStorage: makeFakeSafeStorage(true) })
    await expect(vault.load()).resolves.toBeNull()
  })

  it('load() returns null when the stored blob is undecryptable — never throws', async () => {
    mkdirSync(dirname(vaultPath()), { recursive: true })
    writeFileSync(vaultPath(), JSON.stringify({ v: 1, encrypted: true, data: 'not-a-valid-envelope' }), 'utf-8')
    const vault = new AuthVault({ safeStorage: makeFakeSafeStorage(true) })
    await expect(vault.load()).resolves.toBeNull()
  })

  it('clear() removes the file and is a no-op when already absent', async () => {
    const vault = new AuthVault({ safeStorage: makeFakeSafeStorage(true) })
    await vault.save({ type: 'oauth', access: 'a', refresh: 'r', expires: 1 })
    expect(existsSync(vaultPath())).toBe(true)

    await vault.clear()
    expect(existsSync(vaultPath())).toBe(false)

    await expect(vault.clear()).resolves.toBeUndefined()
  })
})

describe('AuthVault — login flow entry points', () => {
  function fakeLoginFlow(overrides: Partial<LoginFlow> = {}): LoginFlow {
    return {
      start: vi.fn(async () => ({ authorizeUrl: 'https://auth.openai.com/oauth/authorize?x=1', state: 's' })),
      waitForCallback: vi.fn(async () => {
        throw new Error('fakeLoginFlow: waitForCallback not configured for this test')
      }),
      cancel: vi.fn(),
      ...overrides
    }
  }

  it('beginLogin() returns the authorize URL; completeLogin() persists the canned credential', async () => {
    const canned: VaultCredential = { type: 'oauth', access: 'aa', refresh: 'rr', expires: 12345, accountId: 'acct-x' }
    const flow = fakeLoginFlow({ waitForCallback: vi.fn(async () => canned) })
    const vault = new AuthVault({ safeStorage: makeFakeSafeStorage(true), loginFlowFactory: () => flow })

    const { authorizeUrl } = await vault.beginLogin()
    expect(authorizeUrl).toBe('https://auth.openai.com/oauth/authorize?x=1')

    const cred = await vault.completeLogin()
    expect(cred).toEqual(canned)
    expect(await vault.load()).toEqual(canned)
  })

  it('completeLogin() without a prior beginLogin() rejects', async () => {
    const vault = new AuthVault({ safeStorage: makeFakeSafeStorage(true) })
    await expect(vault.completeLogin()).rejects.toThrow(/no login in progress/)
  })

  it('SINGLE-FLIGHT: a second beginLogin() while one is pending rejects, leaving the first flow untouched', async () => {
    let resolveStart: ((v: { authorizeUrl: string; state: string }) => void) | undefined
    const flow = fakeLoginFlow({
      start: vi.fn(
        () =>
          new Promise<{ authorizeUrl: string; state: string }>((resolve) => {
            resolveStart = resolve
          })
      )
    })
    const vault = new AuthVault({ safeStorage: makeFakeSafeStorage(true), loginFlowFactory: () => flow })

    const firstPromise = vault.beginLogin() // start() is pending — first call has NOT resolved yet
    await expect(vault.beginLogin()).rejects.toThrow(/already in progress/)

    resolveStart!({ authorizeUrl: 'https://auth.openai.com/oauth/authorize?x=1', state: 's' })
    await expect(firstPromise).resolves.toEqual({ authorizeUrl: 'https://auth.openai.com/oauth/authorize?x=1' })
    expect(flow.cancel).not.toHaveBeenCalled()
  })

  it('a failed start() clears the single-flight guard so a retry is allowed', async () => {
    const failingFlow = fakeLoginFlow({ start: vi.fn(async () => Promise.reject(new Error('port in use'))) })
    const vault = new AuthVault({ safeStorage: makeFakeSafeStorage(true), loginFlowFactory: () => failingFlow })

    await expect(vault.beginLogin()).rejects.toThrow('port in use')
    // guard cleared — a second attempt is allowed, not rejected as "already in progress"
    const okFlow = fakeLoginFlow()
    const vault2 = new AuthVault({ safeStorage: makeFakeSafeStorage(true), loginFlowFactory: () => okFlow })
    await expect(vault2.beginLogin()).resolves.toEqual({ authorizeUrl: 'https://auth.openai.com/oauth/authorize?x=1' })
  })

  it('cancelLogin() cancels the active flow and clears the guard for a subsequent beginLogin()', async () => {
    const flow = fakeLoginFlow({ waitForCallback: vi.fn(() => new Promise<VaultCredential>(() => {})) })
    const vault = new AuthVault({ safeStorage: makeFakeSafeStorage(true), loginFlowFactory: () => flow })

    await vault.beginLogin()
    vault.cancelLogin()

    expect(flow.cancel).toHaveBeenCalledTimes(1)
    await expect(vault.beginLogin()).resolves.toEqual({ authorizeUrl: 'https://auth.openai.com/oauth/authorize?x=1' })
  })

  it('cancelLogin() with no active flow is a no-op', () => {
    const vault = new AuthVault({ safeStorage: makeFakeSafeStorage(true) })
    expect(() => vault.cancelLogin()).not.toThrow()
  })
})
