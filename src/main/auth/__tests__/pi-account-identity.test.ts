/**
 * @vitest-environment node
 *
 * ADR-071 §3 — PiAuthProvider.accountIdentity().
 *
 * `os.homedir()` is redirected to a temp dir (the same trick PiAuthProvider's
 * own suite uses), so `~/.pi/agent/auth.json` resolves inside a fixture tree.
 * The real home is never read. Every key here is invented.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const homedirHolder = vi.hoisted(() => ({ current: '' }))
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    homedir: () => homedirHolder.current,
    default: { ...actual, homedir: () => homedirHolder.current }
  }
})

vi.mock('../../../core/pi/model-discovery', () => ({ invalidatePiModelCache: vi.fn() }))
vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
vi.mock('../../../core/auth/vault/CredentialSync', () => ({
  credentialSync: {
    beginLogin: vi.fn(),
    completeLogin: vi.fn(),
    cancelLogin: vi.fn(),
    beginDeviceCodeLogin: vi.fn()
  },
  PI_CODEX_VENDOR_ID: 'openai-codex'
}))

import { PiAuthProvider } from '../../../core/auth/PiAuthProvider'
import { accountIdentityFromAuthEntry } from '../../../core/auth/account-identity'
import { logger } from '../../../core/services/logger'

const FAKE_API_KEY = 'pi-fake-key-0000-d00d'
const FAKE_SIGNATURE = 'not-a-real-signature'

/** header.payload.signature with a base64url JSON payload and a junk signature. */
function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf-8').toString('base64url')
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.${FAKE_SIGNATURE}`
}

const CHATGPT_TOKEN = fakeJwt({
  'https://api.openai.com/auth': {
    chatgpt_account_id: 'acct_workspace_9',
    user_id: 'user_fallback_9',
    chatgpt_plan_type: 'plus'
  },
  email: 'Nobody@Example.test'
})

let testHome: string

beforeEach(() => {
  vi.clearAllMocks()
  testHome = mkdtempSync(join(tmpdir(), 'pi-identity-'))
  homedirHolder.current = testHome
})

afterEach(() => {
  rmSync(testHome, { recursive: true, force: true })
})

function authJsonPath(): string {
  return join(testHome, '.pi', 'agent', 'auth.json')
}

function writeAuthJson(contents: unknown, mtimeSeconds?: number): void {
  mkdirSync(join(testHome, '.pi', 'agent'), { recursive: true })
  writeFileSync(authJsonPath(), JSON.stringify(contents), 'utf-8')
  if (mtimeSeconds !== undefined) utimesSync(authJsonPath(), mtimeSeconds, mtimeSeconds)
}

function loggedText(): string {
  const mocks = [logger.warn, logger.info, logger.error, logger.debug] as unknown as Array<{
    mock: { calls: unknown[][] }
  }>
  return mocks
    .flatMap((m) => m.mock.calls)
    .map((call) => JSON.stringify(call))
    .join('\n')
}

describe('PiAuthProvider.accountIdentity', () => {
  it('digests an api_key entry — pi spells the type differently, the rule is the same', () => {
    writeAuthJson({ openrouter: { type: 'api_key', key: FAKE_API_KEY } })
    const identity = new PiAuthProvider().accountIdentity('openrouter')
    expect(identity.accountKey).toMatch(/^openrouter:key:[0-9a-f]{16}$/)
    expect(identity.accountLabel).toBe('openrouter key …d00d')
  })

  it('reads the subscription off the token when pi stores no account id', () => {
    // What pi actually persists today: an oauth entry with no `accountId`.
    // The access token still carries `chatgpt_account_id`, so the row is
    // attributable anyway (ADR-071 §3).
    writeAuthJson({
      'openai-codex': {
        type: 'oauth',
        access: CHATGPT_TOKEN,
        refresh: 'fake-refresh',
        expires: 9999999999
      }
    })
    expect(new PiAuthProvider().accountIdentity('openai-codex')).toEqual({
      accountKey: 'chatgpt:acct_workspace_9:user_fallback_9',
      accountLabel: 'Nobody@Example.test (plus)'
    })
  })

  it('prefers a stored account id when there is one', () => {
    writeAuthJson({
      'openai-codex': {
        type: 'oauth',
        access: CHATGPT_TOKEN,
        refresh: 'fake-refresh',
        expires: 9999999999,
        accountId: 'acct_workspace_9'
      }
    })
    expect(new PiAuthProvider().accountIdentity('openai-codex').accountKey).toBe(
      'chatgpt:acct_workspace_9:user_fallback_9'
    )
  })

  it('falls back to the native key when neither the entry nor the token names one', () => {
    writeAuthJson({
      'openai-codex': {
        type: 'oauth',
        access: fakeJwt({ email: 'Nobody@Example.test' }),
        refresh: 'fake-refresh',
        expires: 9999999999
      }
    })
    expect(new PiAuthProvider().accountIdentity('openai-codex')).toEqual({
      accountKey: 'pi:openai-codex:native',
      accountLabel: 'openai-codex'
    })
  })

  it('gives every other oauth vendor the native key', () => {
    writeAuthJson({ anthropic: { type: 'oauth', access: 'fake', refresh: 'fake', expires: 1 } })
    expect(new PiAuthProvider().accountIdentity('anthropic').accountKey).toBe('pi:anthropic:native')
  })

  it('gives the native key when there is no auth.json, and says nothing about it', () => {
    expect(new PiAuthProvider().accountIdentity('openrouter')).toEqual({
      accountKey: 'pi:openrouter:native',
      accountLabel: 'openrouter'
    })
    expect(loggedText()).toBe('')
  })

  it('re-reads only when the file changes', () => {
    const provider = new PiAuthProvider()
    writeAuthJson({ openrouter: { type: 'api_key', key: FAKE_API_KEY } }, 1_700_000_000)
    const first = provider.accountIdentity('openrouter')

    writeAuthJson({ openrouter: { type: 'api_key', key: 'pi-fake-key-1111-f00d' } }, 1_700_000_000)
    expect(provider.accountIdentity('openrouter')).toEqual(first)

    writeAuthJson({ openrouter: { type: 'api_key', key: 'pi-fake-key-1111-f00d' } }, 1_700_000_060)
    expect(provider.accountIdentity('openrouter').accountLabel).toBe('openrouter key …f00d')
  })

  it('returns and logs no token or key material', () => {
    writeAuthJson({
      'openai-codex': {
        type: 'oauth',
        access: CHATGPT_TOKEN,
        refresh: 'fake-refresh-token',
        expires: 9999999999,
        accountId: 'acct_workspace_9'
      },
      openrouter: { type: 'api_key', key: FAKE_API_KEY }
    })
    const provider = new PiAuthProvider()
    const chatgpt = provider.accountIdentity('openai-codex')
    const apiKey = provider.accountIdentity('openrouter')

    expect(Object.keys(chatgpt).sort()).toEqual(['accountKey', 'accountLabel'])
    const returned = JSON.stringify([chatgpt, apiKey])
    const logged = loggedText()
    for (const secret of [CHATGPT_TOKEN, FAKE_SIGNATURE, 'fake-refresh-token', FAKE_API_KEY]) {
      expect(returned).not.toContain(secret)
      expect(logged).not.toContain(secret)
    }
    expect(logged).toBe('')
  })
})

describe('one subscription, one account key across engines', () => {
  it('gives pi’s id-less entry the same key as opencode’s entry for the same token', () => {
    // opencode persists `accountId`; pi does not. Same subscription, so the
    // key must be identical or the hub would see two accounts (ADR-071 §3).
    const opencodeShaped = accountIdentityFromAuthEntry({
      engineId: 'opencode',
      vendorId: 'openai',
      isChatgptVendor: true,
      entry: {
        type: 'oauth',
        access: CHATGPT_TOKEN,
        refresh: 'fake-refresh',
        accountId: 'acct_workspace_9'
      }
    })
    const piShaped = accountIdentityFromAuthEntry({
      engineId: 'pi',
      vendorId: 'openai-codex',
      isChatgptVendor: true,
      entry: { type: 'oauth', access: CHATGPT_TOKEN, refresh: 'fake-refresh' }
    })

    expect(piShaped).toEqual(opencodeShaped)
    expect(piShaped.accountKey).toBe('chatgpt:acct_workspace_9:user_fallback_9')
  })
})
