/**
 * @vitest-environment node
 *
 * ADR-068 §2 / slice 1 — the vault's ACCOUNTS half (v3).
 *
 * The storage rules only: N accounts per provider, one active id, and the
 * read-time migration from v2's single credential. The lifecycle half (per
 * account refresh timers, which account is fed to pi/opencode) lives in
 * `CredentialSyncAccounts.test.ts`; this file never constructs a CredentialSync.
 *
 * SAFETY: `node:os`.homedir is mocked to a fresh temp directory for every test,
 * exactly as `AuthVault.test.ts` does it — nothing here reads or writes the real
 * `~/.claude/ui/auth-vault.json`, and every token string is an obvious fake.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

const home = vi.hoisted(() => ({ value: '' }))
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, homedir: () => home.value, default: { ...actual, homedir: () => home.value } }
})

import { AuthVault, vaultPath, CHATGPT_PROVIDER_ID } from '../../../../core/auth/vault/AuthVault'
import type { VaultCredential } from '../../../../core/auth/vault/codex-oauth'

let testHome: string
beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), 'auth-vault-accounts-'))
  home.value = testHome
})
afterEach(() => rmSync(testHome, { recursive: true, force: true }))

/** An obviously fake OAuth record. `ws` is the ChatGPT workspace (JWT) id. */
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

function writeVault(value: unknown): void {
  mkdirSync(dirname(vaultPath()), { recursive: true })
  writeFileSync(vaultPath(), JSON.stringify(value))
}

const readVault = (): Record<string, unknown> =>
  JSON.parse(readFileSync(vaultPath(), 'utf8')) as Record<string, unknown>

// ---------------------------------------------------------------------------
// Guard 1 — v2 → v3 migration
// ---------------------------------------------------------------------------

describe('AuthVault v2 → v3 migration', () => {
  it('turns a v2 chatgpt OAuth credential into ONE active account, preserving email + workspace id', async () => {
    writeVault({
      v: 2,
      credentials: {
        chatgpt: {
          type: 'oauth',
          access: 'fake-access',
          refresh: 'fake-refresh',
          expires: 1_000,
          accountId: 'ws-legacy',
          email: 'legacy@example.test'
        }
      }
    })
    const vault = new AuthVault()
    const accounts = await vault.listAccounts(CHATGPT_PROVIDER_ID)
    expect(accounts).toHaveLength(1)
    expect(accounts[0]).toMatchObject({
      email: 'legacy@example.test',
      accountId: 'ws-legacy',
      credential: { type: 'oauth', access: 'fake-access' }
    })
    expect(accounts[0].id).toBeTruthy()
    await expect(vault.getActiveAccountId(CHATGPT_PROVIDER_ID)).resolves.toBe(accounts[0].id)
    // load() still answers the ACTIVE account's credential (pi/opencode feeds).
    await expect(vault.load()).resolves.toMatchObject({ access: 'fake-access' })
  })

  it('mints a STABLE id for the migrated account across repeated reads (a re-minted id would break switch/remove)', async () => {
    writeVault({
      v: 2,
      credentials: {
        chatgpt: { type: 'oauth', access: 'a', refresh: 'r', expires: 1, accountId: 'ws-legacy' }
      }
    })
    const vault = new AuthVault()
    const first = await vault.listAccounts(CHATGPT_PROVIDER_ID)
    const second = await vault.listAccounts(CHATGPT_PROVIDER_ID)
    expect(second[0].id).toBe(first[0].id)
  })

  it('leaves a v2 API-key custom provider under `credentials`, not under `accounts`', async () => {
    writeVault({
      v: 2,
      credentials: {
        chatgpt: { type: 'oauth', access: 'a', refresh: 'r', expires: 1 },
        'ollama-local': { type: 'api_key', key: 'fake-key' }
      }
    })
    const vault = new AuthVault()
    await expect(vault.loadCredential('ollama-local')).resolves.toEqual({
      type: 'api_key',
      key: 'fake-key'
    })
    await expect(vault.listAccounts('ollama-local')).resolves.toEqual([])
    // The migration is persisted on the next write, in the v3 shape.
    await vault.saveCredential('another', { type: 'api_key', key: 'fake-two' })
    const file = readVault()
    expect(file.v).toBe(3)
    expect(file.credentials).toEqual({
      'ollama-local': { type: 'api_key', key: 'fake-key' },
      another: { type: 'api_key', key: 'fake-two' }
    })
    expect(Object.keys(file.accounts as object)).toEqual(['chatgpt'])
  })

  it('migrates a plaintext v1 file through the v1 → v2 path into one account', async () => {
    writeVault({
      v: 1,
      encrypted: false,
      data: JSON.stringify({
        'openai-codex': { type: 'oauth', access: 'v1-access', refresh: 'v1-refresh', expires: 7 }
      })
    })
    const vault = new AuthVault()
    const accounts = await vault.listAccounts(CHATGPT_PROVIDER_ID)
    expect(accounts).toHaveLength(1)
    expect(accounts[0].credential.access).toBe('v1-access')
    await expect(vault.load()).resolves.toMatchObject({ access: 'v1-access' })
  })

  it('drops malformed account entries instead of failing the whole read', async () => {
    writeVault({
      v: 3,
      credentials: {},
      accounts: {
        chatgpt: {
          activeId: 'good',
          list: [
            null,
            { id: 'bad-credential', credential: { type: 'oauth' }, addedAt: 1 },
            {
              id: 'good',
              credential: { type: 'oauth', access: 'a', refresh: 'r', expires: 5 },
              addedAt: 2
            }
          ]
        },
        '../evil': { activeId: null, list: [] }
      }
    })
    const vault = new AuthVault()
    const accounts = await vault.listAccounts(CHATGPT_PROVIDER_ID)
    expect(accounts.map((a) => a.id)).toEqual(['good'])
    await expect(vault.getActiveAccountId(CHATGPT_PROVIDER_ID)).resolves.toBe('good')
  })
})

// ---------------------------------------------------------------------------
// Guard 2 — upsertAccount
// ---------------------------------------------------------------------------

describe('AuthVault.upsertAccount', () => {
  it('makes the FIRST account active', async () => {
    const vault = new AuthVault()
    const account = await vault.upsertAccount(CHATGPT_PROVIDER_ID, cred({ ws: 'ws-a' }))
    await expect(vault.getActiveAccountId(CHATGPT_PROVIDER_ID)).resolves.toBe(account.id)
    if (process.platform !== 'win32') {
      expect(readVault().v).toBe(3)
    }
  })

  it('updates the SAME workspace in place, keeping its id and its active flag', async () => {
    const vault = new AuthVault()
    const first = await vault.upsertAccount(CHATGPT_PROVIDER_ID, cred({ ws: 'ws-a' }))
    const second = await vault.upsertAccount(
      CHATGPT_PROVIDER_ID,
      cred({ ws: 'ws-a', access: 'fake-access-2', refresh: 'fake-refresh-2', expires: 9_000 })
    )
    expect(second.id).toBe(first.id)
    const accounts = await vault.listAccounts(CHATGPT_PROVIDER_ID)
    expect(accounts).toHaveLength(1)
    expect(accounts[0].credential).toMatchObject({ access: 'fake-access-2', expires: 9_000 })
    await expect(vault.getActiveAccountId(CHATGPT_PROVIDER_ID)).resolves.toBe(first.id)
  })

  it('appends a NEW workspace without stealing active', async () => {
    const vault = new AuthVault()
    const first = await vault.upsertAccount(CHATGPT_PROVIDER_ID, cred({ ws: 'ws-a' }))
    const second = await vault.upsertAccount(
      CHATGPT_PROVIDER_ID,
      cred({ ws: 'ws-b', access: 'fake-b', refresh: 'fake-rb' })
    )
    expect(second.id).not.toBe(first.id)
    expect((await vault.listAccounts(CHATGPT_PROVIDER_ID)).map((a) => a.accountId)).toEqual([
      'ws-a',
      'ws-b'
    ])
    await expect(vault.getActiveAccountId(CHATGPT_PROVIDER_ID)).resolves.toBe(first.id)
    // load() is the ACTIVE account's credential, not the newest one.
    await expect(vault.load()).resolves.toMatchObject({ accountId: 'ws-a' })
  })

  it('carries email + planType from the credential onto the account', async () => {
    const vault = new AuthVault()
    const account = await vault.upsertAccount(
      CHATGPT_PROVIDER_ID,
      cred({ ws: 'ws-a', email: 'owner@example.test', planType: 'pro' })
    )
    expect(account).toMatchObject({
      email: 'owner@example.test',
      accountId: 'ws-a',
      planType: 'pro'
    })
  })

  it('routes save()/saveCredential() of an OAuth record through the upsert rather than the old single slot', async () => {
    const vault = new AuthVault()
    await vault.save(cred({ ws: 'ws-a' }))
    await vault.save(cred({ ws: 'ws-a', access: 'fake-refreshed' }))
    const file = readVault()
    expect(file.credentials).toEqual({})
    expect(await vault.listAccounts(CHATGPT_PROVIDER_ID)).toHaveLength(1)
    await expect(vault.load()).resolves.toMatchObject({ access: 'fake-refreshed' })
  })
})

// ---------------------------------------------------------------------------
// Guard 3 (storage half) — removeAccount
// ---------------------------------------------------------------------------

describe('AuthVault.removeAccount', () => {
  it('promotes the most recently added remaining account when the ACTIVE one is removed', async () => {
    const vault = new AuthVault()
    const a = await vault.upsertAccount(CHATGPT_PROVIDER_ID, cred({ ws: 'ws-a' }))
    await vault.upsertAccount(CHATGPT_PROVIDER_ID, cred({ ws: 'ws-b', refresh: 'fake-rb' }))
    const c = await vault.upsertAccount(
      CHATGPT_PROVIDER_ID,
      cred({ ws: 'ws-c', refresh: 'fake-rc' })
    )
    await vault.removeAccount(CHATGPT_PROVIDER_ID, a.id)
    await expect(vault.getActiveAccountId(CHATGPT_PROVIDER_ID)).resolves.toBe(c.id)
    await expect(vault.load()).resolves.toMatchObject({ accountId: 'ws-c' })
  })

  it('leaves the active id alone when a NON-active account is removed', async () => {
    const vault = new AuthVault()
    const a = await vault.upsertAccount(CHATGPT_PROVIDER_ID, cred({ ws: 'ws-a' }))
    const b = await vault.upsertAccount(
      CHATGPT_PROVIDER_ID,
      cred({ ws: 'ws-b', refresh: 'fake-rb' })
    )
    await vault.removeAccount(CHATGPT_PROVIDER_ID, b.id)
    await expect(vault.getActiveAccountId(CHATGPT_PROVIDER_ID)).resolves.toBe(a.id)
  })

  it('leaves activeId null (and load() empty) when the LAST account is removed', async () => {
    const vault = new AuthVault()
    const a = await vault.upsertAccount(CHATGPT_PROVIDER_ID, cred({ ws: 'ws-a' }))
    await vault.removeAccount(CHATGPT_PROVIDER_ID, a.id)
    await expect(vault.getActiveAccountId(CHATGPT_PROVIDER_ID)).resolves.toBeNull()
    await expect(vault.listAccounts(CHATGPT_PROVIDER_ID)).resolves.toEqual([])
    await expect(vault.load()).resolves.toBeNull()
  })

  it('removing an unknown account id is a no-op', async () => {
    const vault = new AuthVault()
    const a = await vault.upsertAccount(CHATGPT_PROVIDER_ID, cred({ ws: 'ws-a' }))
    await vault.removeAccount(CHATGPT_PROVIDER_ID, 'not-a-real-id')
    await expect(vault.getActiveAccountId(CHATGPT_PROVIDER_ID)).resolves.toBe(a.id)
  })
})

describe('AuthVault.setActiveAccount / saveAccountCredential', () => {
  it('switches the active account, which is what load() answers', async () => {
    const vault = new AuthVault()
    await vault.upsertAccount(CHATGPT_PROVIDER_ID, cred({ ws: 'ws-a' }))
    const b = await vault.upsertAccount(
      CHATGPT_PROVIDER_ID,
      cred({ ws: 'ws-b', refresh: 'fake-rb', access: 'fake-b' })
    )
    await vault.setActiveAccount(CHATGPT_PROVIDER_ID, b.id)
    await expect(vault.load()).resolves.toMatchObject({ access: 'fake-b' })
  })

  it('refuses an unknown active id rather than pointing the vault at nothing', async () => {
    const vault = new AuthVault()
    await vault.upsertAccount(CHATGPT_PROVIDER_ID, cred({ ws: 'ws-a' }))
    await expect(vault.setActiveAccount(CHATGPT_PROVIDER_ID, 'nope')).rejects.toThrow(/account/i)
  })

  it('saveAccountCredential rewrites ONE account without touching the others or the active id', async () => {
    const vault = new AuthVault()
    const a = await vault.upsertAccount(CHATGPT_PROVIDER_ID, cred({ ws: 'ws-a' }))
    const b = await vault.upsertAccount(
      CHATGPT_PROVIDER_ID,
      cred({ ws: 'ws-b', refresh: 'fake-rb' })
    )
    await vault.saveAccountCredential(
      CHATGPT_PROVIDER_ID,
      b.id,
      cred({ ws: 'ws-b', access: 'fake-rotated', refresh: 'fake-rotated-refresh', expires: 5_000 })
    )
    const accounts = await vault.listAccounts(CHATGPT_PROVIDER_ID)
    expect(accounts.find((x) => x.id === b.id)?.credential).toMatchObject({
      access: 'fake-rotated',
      expires: 5_000
    })
    expect(accounts.find((x) => x.id === a.id)?.credential.access).toBe('fake-access')
    await expect(vault.getActiveAccountId(CHATGPT_PROVIDER_ID)).resolves.toBe(a.id)
  })
})

describe('AuthVault.removeCredential with accounts', () => {
  it('drops every ChatGPT account while preserving other providers', async () => {
    const vault = new AuthVault()
    await vault.saveCredential('ollama-local', { type: 'api_key', key: 'fake-keep' })
    await vault.upsertAccount(CHATGPT_PROVIDER_ID, cred({ ws: 'ws-a' }))
    await vault.upsertAccount(CHATGPT_PROVIDER_ID, cred({ ws: 'ws-b', refresh: 'fake-rb' }))
    await vault.removeCredential(CHATGPT_PROVIDER_ID)
    await expect(vault.listAccounts(CHATGPT_PROVIDER_ID)).resolves.toEqual([])
    await expect(vault.load()).resolves.toBeNull()
    await expect(vault.loadCredential('ollama-local')).resolves.toEqual({
      type: 'api_key',
      key: 'fake-keep'
    })
  })
})
