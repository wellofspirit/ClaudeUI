/** @vitest-environment node */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
const home = vi.hoisted(() => ({ value: '' }))
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, homedir: () => home.value, default: { ...actual, homedir: () => home.value } }
})
import { AuthVault, vaultPath } from '../../../../core/auth/vault/AuthVault'
import { CredentialSync, type CodexFeedTarget } from '../../../../core/auth/vault/CredentialSync'
import type { VaultCredential } from '../../../../core/auth/vault/codex-oauth'
import {
  CodexDeviceCodeFlow,
  DeviceCodeCancelledError
} from '../../../../core/auth/vault/codex-device-code'
let testHome: string
beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), 'auth-vault-'))
  home.value = testHome
})
afterEach(() => rmSync(testHome, { recursive: true, force: true }))
describe('AuthVault', () => {
  it('writes a plaintext v3 0600 generic credential map', async () => {
    const vault = new AuthVault()
    await vault.saveCredential('custom', { type: 'api_key', key: 'test-key' })
    // v3 (ADR-068 §2): `credentials` holds API keys only; OAuth subscriptions
    // live under `accounts`, which an API-key-only vault leaves empty.
    expect(JSON.parse(readFileSync(vaultPath(), 'utf8'))).toEqual({
      v: 3,
      credentials: { custom: { type: 'api_key', key: 'test-key' } },
      accounts: {}
    })
    if (process.platform !== 'win32') expect(statSync(vaultPath()).mode & 0o777).toBe(0o600)
  })
  it('keeps legacy load/save compatibility under chatgpt', async () => {
    const vault = new AuthVault()
    const credential: VaultCredential = {
      type: 'oauth',
      access: 'access',
      refresh: 'refresh',
      expires: 1
    }
    await vault.save(credential)
    await expect(vault.load()).resolves.toEqual(credential)
  })
  it('migrates plaintext v1 Codex data on the next write', async () => {
    mkdirSync(dirname(vaultPath()), { recursive: true })
    writeFileSync(
      vaultPath(),
      JSON.stringify({
        v: 1,
        encrypted: false,
        data: JSON.stringify({
          'openai-codex': { type: 'oauth', access: 'a', refresh: 'r', expires: 1 }
        })
      })
    )
    const vault = new AuthVault()
    await expect(vault.load()).resolves.toEqual({
      type: 'oauth',
      access: 'a',
      refresh: 'r',
      expires: 1
    })
    await vault.saveCredential('custom', { type: 'api_key', key: 'k' })
    // The v1 credential is now ChatGPT's one (active) ACCOUNT, not a single slot.
    const file = JSON.parse(readFileSync(vaultPath(), 'utf8'))
    expect(file.v).toBe(3)
    expect(file.accounts.chatgpt.list[0].credential.access).toBe('a')
    expect(file.accounts.chatgpt.activeId).toBe(file.accounts.chatgpt.list[0].id)
  })
  it('never decrypts encrypted v1 and reports it for native recovery', async () => {
    mkdirSync(dirname(vaultPath()), { recursive: true })
    writeFileSync(vaultPath(), JSON.stringify({ v: 1, encrypted: true, data: 'opaque' }))
    const vault = new AuthVault()
    await expect(vault.load()).resolves.toBeNull()
    expect(vault.hasUnreadableLegacyVault()).toBe(true)
  })
  it('recovers an unreadable encrypted v1 from native snapshots into plaintext v3 without decrypting it', async () => {
    mkdirSync(dirname(vaultPath()), { recursive: true })
    writeFileSync(vaultPath(), JSON.stringify({ v: 1, encrypted: true, data: 'opaque' }))
    const native = (
      snapshot: { access: string; refresh: string; expires: number } | null
    ): CodexFeedTarget => ({
      authFilePath: () => join(testHome, 'native-auth.json'),
      feedOauthCredential: vi.fn(async () => {}),
      readOauthEntry: vi.fn(async () => snapshot),
      removeVendorAuth: vi.fn(async () => {})
    })
    const pi = native({ access: 'pi', refresh: 'pi', expires: 10 })
    const opencode = native({ access: 'oc', refresh: 'oc', expires: 20 })
    const sync = new CredentialSync({ vault: new AuthVault() })
    sync.configure({ pi, opencode })
    await sync.start()
    expect(JSON.parse(readFileSync(vaultPath(), 'utf8'))).toMatchObject({
      v: 3,
      credentials: {},
      accounts: {
        chatgpt: {
          list: [{ credential: { type: 'oauth', access: 'oc', refresh: 'oc', expires: 20 } }]
        }
      }
    })
    sync.stop()
  })
  it('disconnectChatgpt preserves custom vault credentials while removing both native copies', async () => {
    const vault = new AuthVault()
    await vault.saveCredential('custom', { type: 'api_key', key: 'keep' })
    await vault.save({ type: 'oauth', access: 'a', refresh: 'r', expires: 1 })
    const native = (): CodexFeedTarget => ({
      authFilePath: () => join(testHome, 'native-auth.json'),
      feedOauthCredential: vi.fn(async () => {}),
      readOauthEntry: vi.fn(async () => null),
      removeVendorAuth: vi.fn(async () => {})
    })
    const pi = native()
    const opencode = native()
    const sync = new CredentialSync({ vault })
    sync.configure({ pi, opencode })
    await sync.disconnectChatgpt()
    await expect(vault.load()).resolves.toBeNull()
    await expect(vault.loadCredential('custom')).resolves.toEqual({ type: 'api_key', key: 'keep' })
    expect(pi.removeVendorAuth).toHaveBeenCalledWith('openai-codex')
    expect(opencode.removeVendorAuth).toHaveBeenCalledWith('openai')
  })
  it('clears an unreadable encrypted v1 with no native recovery source so future boots do not retry it', async () => {
    mkdirSync(dirname(vaultPath()), { recursive: true })
    writeFileSync(vaultPath(), JSON.stringify({ v: 1, encrypted: true, data: 'opaque' }))
    const target = (): CodexFeedTarget => ({
      authFilePath: () => join(testHome, 'native-auth.json'),
      feedOauthCredential: vi.fn(async () => {}),
      readOauthEntry: vi.fn(async () => null),
      removeVendorAuth: vi.fn(async () => {})
    })
    const vault = new AuthVault()
    const sync = new CredentialSync({ vault })
    sync.configure({ pi: target(), opencode: target() })
    await sync.start()
    expect(vault.hasUnreadableLegacyVault()).toBe(false)
    await expect(vault.load()).resolves.toBeNull()
  })
})

describe('AuthVault validation', () => {
  it('rejects malformed v1/v2 entries and unsafe provider ids', async () => {
    mkdirSync(dirname(vaultPath()), { recursive: true })
    writeFileSync(
      vaultPath(),
      JSON.stringify({ v: 1, encrypted: false, data: JSON.stringify({ 'openai-codex': null }) })
    )
    const vault = new AuthVault()
    await expect(vault.load()).resolves.toBeNull()

    writeFileSync(
      vaultPath(),
      JSON.stringify({ v: 2, credentials: { chatgpt: null, valid: { type: 'api_key', key: 'k' } } })
    )
    await expect(vault.loadCredential('chatgpt')).resolves.toBeNull()
    await expect(vault.loadCredential('valid')).resolves.toEqual({ type: 'api_key', key: 'k' })
    await expect(vault.saveCredential('__proto__', { type: 'api_key', key: 'k' })).rejects.toThrow(
      /Invalid/
    )
    await expect(vault.saveCredential('empty', { type: 'api_key', key: '' })).rejects.toThrow(
      /Invalid vault credential/
    )
    await expect(vault.loadCredential('../x')).rejects.toThrow(/Invalid/)
  })
})

describe('AuthVault lifecycle compatibility', () => {
  function flow(
    overrides: Partial<import('../../../../core/auth/vault/codex-oauth').LoginFlow> = {}
  ) {
    return {
      start: vi.fn(async () => ({ authorizeUrl: 'https://example.test/auth', state: 's' })),
      waitForCallback: vi.fn(async () => ({
        type: 'oauth' as const,
        access: 'a',
        refresh: 'r',
        expires: 1
      })),
      cancel: vi.fn(),
      ...overrides
    }
  }
  it('preserves other records, clears idempotently, and enforces 0600 on replacement', async () => {
    const vault = new AuthVault()
    await vault.saveCredential('custom', { type: 'api_key', key: 'k' })
    await vault.save({ type: 'oauth', access: 'a', refresh: 'r', expires: 1 })
    await expect(vault.loadCredential('custom')).resolves.toEqual({ type: 'api_key', key: 'k' })
    if (process.platform !== 'win32') expect(statSync(vaultPath()).mode & 0o777).toBe(0o600)
    await vault.clear()
    await vault.clear()
    await expect(vault.load()).resolves.toBeNull()
  })
  it('handles corrupt data and login single-flight, failure cleanup, and cancellation', async () => {
    mkdirSync(dirname(vaultPath()), { recursive: true })
    writeFileSync(vaultPath(), 'bad')
    const good = flow()
    const vault = new AuthVault({ loginFlowFactory: () => good })
    await expect(vault.load()).resolves.toBeNull()
    await vault.beginLogin()
    await expect(vault.beginLogin()).rejects.toThrow(/already in progress/)
    await vault.completeLogin()
    await expect(vault.load()).resolves.toMatchObject({ access: 'a' })
    const failing = flow({
      waitForCallback: vi.fn(async () => {
        throw new Error('callback failed')
      })
    })
    const failedVault = new AuthVault({ loginFlowFactory: () => failing })
    await failedVault.beginLogin()
    await expect(failedVault.completeLogin()).rejects.toThrow('callback failed')
    await expect(failedVault.completeLogin()).rejects.toThrow(/no login/)
    const cancelled = flow()
    const cancelledVault = new AuthVault({ loginFlowFactory: () => cancelled })
    await cancelledVault.beginLogin()
    cancelledVault.cancelLogin()
    expect(cancelled.cancel).toHaveBeenCalled()
  })

  it('completeLoginFromPastedInput drives the flow paste path, saves, and clears the flow (ADR-057)', async () => {
    const pasteFlow = flow({
      completeFromPastedInput: vi.fn(async () => ({
        type: 'oauth' as const,
        access: 'pasted-acc',
        refresh: 'pasted-ref',
        expires: 42
      }))
    })
    const vault = new AuthVault({ loginFlowFactory: () => pasteFlow })
    await vault.beginLogin()
    const cred = await vault.completeLoginFromPastedInput(
      'http://localhost:1455/auth/callback?code=c&state=s'
    )
    expect(pasteFlow.completeFromPastedInput).toHaveBeenCalledWith(
      'http://localhost:1455/auth/callback?code=c&state=s'
    )
    expect(cred.access).toBe('pasted-acc')
    // Saved to the vault and the active flow cleared (a second completion fails).
    await expect(vault.load()).resolves.toMatchObject({ access: 'pasted-acc' })
    await expect(vault.completeLoginFromPastedInput('x')).rejects.toThrow(/no login/)
  })

  it('completeLoginFromPastedInput rejects a flow that has no paste support', async () => {
    // A flow WITHOUT completeFromPastedInput (the interface method is optional).
    const loopbackOnly = flow()
    const vault = new AuthVault({ loginFlowFactory: () => loopbackOnly })
    await vault.beginLogin()
    await expect(vault.completeLoginFromPastedInput('x')).rejects.toThrow(
      /does not support pasted completion/
    )
  })

  it('supersedes a SETTLED (abandoned) flow so re-login is not blocked', async () => {
    // First flow reaches a terminal outcome (its 5-min timeout / error) but
    // completeLogin() is never called, so activeFlow is never cleared. isSettled()
    // reports true → the next beginLogin() must supersede it, not throw.
    const settled = flow({ isSettled: () => true })
    const fresh = flow()
    let n = 0
    const vault = new AuthVault({ loginFlowFactory: () => (n++ === 0 ? settled : fresh) })
    await vault.beginLogin()
    const res = await vault.beginLogin()
    expect(res.authorizeUrl).toBe('https://example.test/auth')
    expect(fresh.start).toHaveBeenCalled()
  })

  it('still blocks a concurrent LIVE flow (single-flight guard preserved)', async () => {
    const live = flow({ isSettled: () => false })
    const vault = new AuthVault({ loginFlowFactory: () => live })
    await vault.beginLogin()
    await expect(vault.beginLogin()).rejects.toThrow(/already in progress/)
  })

  // ── Device code (ADR-068 §3, Slice 7) ─────────────────────────────────────
  function deviceFlow(
    overrides: Partial<
      import('../../../../core/auth/vault/codex-device-code').DeviceCodeFlowLike
    > = {}
  ) {
    return {
      start: vi.fn(async () => ({
        verificationUrl: 'https://issuer.test/codex/device',
        userCode: 'ABCD-1234',
        expiresAt: 900_000
      })),
      waitForCompletion: vi.fn(async () => ({
        type: 'oauth' as const,
        access: 'device-acc',
        refresh: 'device-ref',
        expires: 7
      })),
      cancel: vi.fn(),
      ...overrides
    }
  }

  it('beginDeviceCodeLogin starts the DEVICE flow and completeLogin awaits THAT flow', async () => {
    const device = deviceFlow()
    const loopback = flow()
    const vault = new AuthVault({
      loginFlowFactory: () => loopback,
      deviceCodeFlowFactory: () => device
    })

    const started = await vault.beginDeviceCodeLogin()
    expect(started).toEqual({
      verificationUrl: 'https://issuer.test/codex/device',
      userCode: 'ABCD-1234',
      expiresAt: 900_000
    })
    expect(loopback.start).not.toHaveBeenCalled()

    const cred = await vault.completeLogin()
    expect(device.waitForCompletion).toHaveBeenCalled()
    expect(loopback.waitForCallback).not.toHaveBeenCalled()
    // Persisted through the SAME save the loopback path uses.
    await expect(vault.load()).resolves.toMatchObject({ access: 'device-acc' })
    expect(cred.access).toBe('device-acc')
    // The slot is released, so a second completion has nothing to await.
    await expect(vault.completeLogin()).rejects.toThrow(/no login/)
  })

  it('cancelLogin cancels a live device flow', async () => {
    const device = deviceFlow({ isSettled: () => false })
    const vault = new AuthVault({ deviceCodeFlowFactory: () => device })
    await vault.beginDeviceCodeLogin()
    vault.cancelLogin()
    expect(device.cancel).toHaveBeenCalled()
  })

  it('a second device-code start CANCELS the live first one and takes the slot', async () => {
    // A device flow holds the slot for fifteen minutes; refusing here is how a
    // page reload or a second tab strands the user for a quarter of an hour
    // (ADR-068 §3, Slice 7 design point 6).
    const first = new CodexDeviceCodeFlow({
      deps: {
        issuer: 'https://issuer.test',
        fetch: (async (url: string) =>
          String(url).endsWith('/usercode')
            ? {
                ok: true,
                status: 200,
                json: async () => ({ device_auth_id: 'dev-1', user_code: 'AB-12' })
              }
            : // "not yet" — so the flow parks in the sleep below and only the
              // cancel can ever settle it.
              { ok: false, status: 403 }) as unknown as typeof fetch
      },
      // Never resolves on its own, so only the cancel can settle it.
      sleep: () => new Promise<void>(() => {})
    })
    const second = deviceFlow()
    let n = 0
    const vault = new AuthVault({
      deviceCodeFlowFactory: () => (n++ === 0 ? first : second)
    })

    await vault.beginDeviceCodeLogin()
    const abandoned = first.waitForCompletion()
    void abandoned.catch(() => {})

    await expect(vault.beginDeviceCodeLogin()).resolves.toMatchObject({ userCode: 'ABCD-1234' })
    await expect(abandoned).rejects.toBeInstanceOf(DeviceCodeCancelledError)
    expect(second.start).toHaveBeenCalled()
  })

  it('a loopback start after a LIVE device flow cancels it and proceeds', async () => {
    const device = deviceFlow({ isSettled: () => false })
    const loopback = flow()
    const vault = new AuthVault({
      loginFlowFactory: () => loopback,
      deviceCodeFlowFactory: () => device
    })
    await vault.beginDeviceCodeLogin()
    await expect(vault.beginLogin()).resolves.toMatchObject({
      authorizeUrl: 'https://example.test/auth'
    })
    expect(device.cancel).toHaveBeenCalled()
  })

  it('a LIVE LOOPBACK flow still refuses both kinds of start', async () => {
    const vault = new AuthVault({
      loginFlowFactory: () => flow({ isSettled: () => false }),
      deviceCodeFlowFactory: () => deviceFlow()
    })
    await vault.beginLogin()
    await expect(vault.beginLogin()).rejects.toThrow(/already in progress/)
    await expect(vault.beginDeviceCodeLogin()).rejects.toThrow(/already in progress/)
  })

  it('a device flow refuses pasted completion — it has no verifier of its own', async () => {
    const vault = new AuthVault({ deviceCodeFlowFactory: () => deviceFlow() })
    await vault.beginDeviceCodeLogin()
    await expect(vault.completeLoginFromPastedInput('x')).rejects.toThrow(
      /does not support pasted completion/
    )
  })

  it('a failed device start releases the slot instead of wedging the vault', async () => {
    const boom = deviceFlow({
      start: vi.fn(async () => {
        throw new Error('device code request failed with status 500')
      })
    })
    const second = deviceFlow()
    let n = 0
    const vault = new AuthVault({ deviceCodeFlowFactory: () => (n++ === 0 ? boom : second) })
    await expect(vault.beginDeviceCodeLogin()).rejects.toThrow(/status 500/)
    await expect(vault.beginDeviceCodeLogin()).resolves.toMatchObject({ userCode: 'ABCD-1234' })
  })
})
