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
let testHome: string
beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), 'auth-vault-'))
  home.value = testHome
})
afterEach(() => rmSync(testHome, { recursive: true, force: true }))
describe('AuthVault', () => {
  it('writes a plaintext v2 0600 generic credential map', async () => {
    const vault = new AuthVault()
    await vault.saveCredential('custom', { type: 'api_key', key: 'test-key' })
    expect(JSON.parse(readFileSync(vaultPath(), 'utf8'))).toEqual({
      v: 2,
      credentials: { custom: { type: 'api_key', key: 'test-key' } }
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
    expect(JSON.parse(readFileSync(vaultPath(), 'utf8')).credentials.chatgpt.access).toBe('a')
  })
  it('never decrypts encrypted v1 and reports it for native recovery', async () => {
    mkdirSync(dirname(vaultPath()), { recursive: true })
    writeFileSync(vaultPath(), JSON.stringify({ v: 1, encrypted: true, data: 'opaque' }))
    const vault = new AuthVault()
    await expect(vault.load()).resolves.toBeNull()
    expect(vault.hasUnreadableLegacyVault()).toBe(true)
  })
  it('recovers an unreadable encrypted v1 from native snapshots into plaintext v2 without decrypting it', async () => {
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
    expect(JSON.parse(readFileSync(vaultPath(), 'utf8'))).toEqual({
      v: 2,
      credentials: { chatgpt: { type: 'oauth', access: 'oc', refresh: 'oc', expires: 20 } }
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
  function flow(overrides: Partial<import('../../../../core/auth/vault/codex-oauth').LoginFlow> = {}) {
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
})
