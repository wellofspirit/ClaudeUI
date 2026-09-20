/**
 * @vitest-environment node
 *
 * ADR-071 §3 — `CredentialSync.accountIdentity()`.
 *
 * The vault holds the ChatGPT identity Codex runs under (ADR-068 §1), so the
 * account key for a Codex turn has to come from here — and it has to be the
 * SAME key opencode and pi derive from their own `auth.json` for the same
 * subscription, or one person's spend lands in three buckets.
 *
 * SAFETY: `node:os`.homedir is mocked to a temp directory so the REAL
 * `AuthVault` is exercised with no access to the real `~/.claude/ui`. Every
 * token here is fabricated in this file — a base64url JSON payload between an
 * `alg: none` header and a junk signature. No real credential is reachable.
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
vi.mock('../../../../core/services/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

import { AuthVault, CHATGPT_PROVIDER_ID } from '../../../../core/auth/vault/AuthVault'
import { CredentialSync } from '../../../../core/auth/vault/CredentialSync'
import { buildVaultCredential, type VaultCredential } from '../../../../core/auth/vault/codex-oauth'
import { accountIdentityFromAuthEntry } from '../../../../core/auth/account-identity'

const FAKE_SIGNATURE = 'not-a-real-signature'
const FAKE_REFRESH = 'fake-refresh-token'

/** header.payload.signature with a base64url JSON payload and a junk signature. */
function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf-8').toString('base64url')
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.${FAKE_SIGNATURE}`
}

const CHATGPT_TOKEN = fakeJwt({
  'https://api.openai.com/auth': {
    chatgpt_account_id: 'acct_workspace_1',
    chatgpt_user_id: 'user_stable_1',
    chatgpt_plan_type: 'pro'
  },
  email: 'Someone@Example.test'
})

/** A token that names the workspace and the person, but carries no user claim. */
const NO_USER_CLAIM_TOKEN = fakeJwt({
  'https://api.openai.com/auth': { chatgpt_account_id: 'acct_workspace_1' },
  email: 'Someone@Example.test'
})

let testHome: string
beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), 'chatgpt-identity-'))
  home.value = testHome
})
afterEach(() => {
  rmSync(testHome, { recursive: true, force: true })
})

function sync(vault: AuthVault): CredentialSync {
  return new CredentialSync({ vault, refreshAccessToken: vi.fn() })
}

describe('CredentialSync.accountIdentity', () => {
  it('names the subscription and the person from a stored account', async () => {
    const vault = new AuthVault()
    // The login path: buildVaultCredential is what persists the user claim.
    const cred = buildVaultCredential(
      { access_token: CHATGPT_TOKEN, refresh_token: FAKE_REFRESH, expires_in: 3600 },
      () => Date.now()
    )
    expect(cred.userId).toBe('user_stable_1')
    const account = await vault.upsertAccount(CHATGPT_PROVIDER_ID, cred)

    const identity = await sync(vault).accountIdentity(account.id)

    expect(identity).toEqual({
      accountKey: 'chatgpt:acct_workspace_1:user_stable_1',
      accountLabel: 'Someone@Example.test (pro)'
    })
  })

  it('derives the user claim for an account stored before it was persisted', async () => {
    const vault = new AuthVault()
    // Hand-built to look like a pre-S2a2 record: the profile fields the vault
    // already kept, and no `userId`.
    const legacy: VaultCredential = {
      type: 'oauth',
      access: CHATGPT_TOKEN,
      refresh: FAKE_REFRESH,
      expires: Date.now() + 3_600_000,
      accountId: 'acct_workspace_1',
      email: 'Someone@Example.test',
      planType: 'pro'
    }
    const account = await vault.upsertAccount(CHATGPT_PROVIDER_ID, legacy)

    const identity = await sync(vault).accountIdentity(account.id)

    expect(identity.accountKey).toBe('chatgpt:acct_workspace_1:user_stable_1')
  })

  it('falls back to the lowercased email when no token names the user', async () => {
    const vault = new AuthVault()
    const cred = buildVaultCredential(
      { access_token: NO_USER_CLAIM_TOKEN, refresh_token: FAKE_REFRESH, expires_in: 3600 },
      () => Date.now()
    )
    expect(cred.userId).toBeUndefined()
    const account = await vault.upsertAccount(CHATGPT_PROVIDER_ID, cred)

    const identity = await sync(vault).accountIdentity(account.id)

    expect(identity.accountKey).toBe('chatgpt:acct_workspace_1:someone@example.test')
  })

  it('resolves null to the ACTIVE account', async () => {
    const vault = new AuthVault()
    await vault.upsertAccount(
      CHATGPT_PROVIDER_ID,
      buildVaultCredential(
        { access_token: CHATGPT_TOKEN, refresh_token: FAKE_REFRESH, expires_in: 3600 },
        () => Date.now()
      )
    )

    expect((await sync(vault).accountIdentity(null)).accountKey).toBe(
      'chatgpt:acct_workspace_1:user_stable_1'
    )
  })

  it('is native when no vault account backs the session', async () => {
    // Codex signed in on its own: there is nothing here to name it with.
    const identity = await sync(new AuthVault()).accountIdentity(null)
    expect(identity).toEqual({ accountKey: 'codex:openai:native', accountLabel: 'openai' })
  })

  it('is native when the stored credential never learned a workspace id', async () => {
    const vault = new AuthVault()
    const account = await vault.upsertAccount(CHATGPT_PROVIDER_ID, {
      type: 'oauth',
      access: fakeJwt({ email: 'Someone@Example.test' }),
      refresh: FAKE_REFRESH,
      expires: Date.now() + 3_600_000
    })

    // Half a key is worse than none — the row would claim a subscription we
    // cannot name.
    expect((await sync(vault).accountIdentity(account.id)).accountKey).toBe('codex:openai:native')
  })

  it('agrees with the key an engine auth.json gives for the SAME token', async () => {
    const vault = new AuthVault()
    const account = await vault.upsertAccount(
      CHATGPT_PROVIDER_ID,
      buildVaultCredential(
        { access_token: CHATGPT_TOKEN, refresh_token: FAKE_REFRESH, expires_in: 3600 },
        () => Date.now()
      )
    )

    const fromVault = await sync(vault).accountIdentity(account.id)
    const fromAuthJson = accountIdentityFromAuthEntry({
      engineId: 'opencode',
      vendorId: 'openai',
      isChatgptVendor: true,
      entry: { type: 'oauth', access: CHATGPT_TOKEN, accountId: 'acct_workspace_1' }
    })

    // One subscription, one key, whichever engine ran the turn.
    expect(fromVault).toEqual(fromAuthJson)
  })

  it('returns no token material', async () => {
    const vault = new AuthVault()
    const account = await vault.upsertAccount(
      CHATGPT_PROVIDER_ID,
      buildVaultCredential(
        { access_token: CHATGPT_TOKEN, refresh_token: FAKE_REFRESH, expires_in: 3600 },
        () => Date.now()
      )
    )

    const serialized = JSON.stringify(await sync(vault).accountIdentity(account.id))
    expect(serialized).not.toContain(CHATGPT_TOKEN)
    expect(serialized).not.toContain(FAKE_REFRESH)
    expect(serialized).not.toContain(FAKE_SIGNATURE)
    expect(Object.keys(JSON.parse(serialized) as object).sort()).toEqual([
      'accountKey',
      'accountLabel'
    ])
  })
})
