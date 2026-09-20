/**
 * @vitest-environment node
 *
 * ADR-071 §3 — OpencodeAuthProvider.accountIdentity().
 *
 * Every fixture here is built in a temp XDG_DATA_HOME and every token is
 * fabricated in this file: a base64url JSON payload between an `alg: none`
 * header and a junk signature. No real auth.json is read and no real token
 * exists in this suite.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../../../core/opencode/OpencodeServerManager', () => ({
  opencodeServerManager: {
    acquire: vi.fn(),
    release: vi.fn(),
    recycleAll: vi.fn()
  }
}))
vi.mock('../../../core/opencode/OpencodeClient', () => ({ OpencodeClient: vi.fn() }))
vi.mock('../../../core/opencode/model-discovery', () => ({
  invalidateOpencodeModelCache: vi.fn()
}))
vi.mock('../../../core/services/persisted-sessions-dir', () => ({
  PERSISTED_SESSIONS_DIR: '/fake/persisted'
}))
vi.mock('../../../core/services/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

import { OpencodeAuthProvider } from '../../../core/auth/OpencodeAuthProvider'
import { AuthFileIdentityCache } from '../../../core/auth/account-identity'
import { logger } from '../../../core/services/logger'

// ---------------------------------------------------------------------------
// Fabricated credentials. Nothing here is, or resembles, a real secret.
// ---------------------------------------------------------------------------

const FAKE_API_KEY = 'sk-fake-0000-0000-beef'
const FAKE_SIGNATURE = 'not-a-real-signature'

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

/** No `chatgpt_account_id` claim either — nothing anywhere names a subscription. */
const EMAIL_ONLY_TOKEN = fakeJwt({ email: 'Someone@Example.test' })

let dataHome: string
let originalDataHome: string | undefined

beforeEach(() => {
  vi.clearAllMocks()
  originalDataHome = process.env.XDG_DATA_HOME
  dataHome = mkdtempSync(join(tmpdir(), 'opencode-identity-'))
  process.env.XDG_DATA_HOME = dataHome
})

afterEach(() => {
  if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = originalDataHome
  rmSync(dataHome, { recursive: true, force: true })
})

function authJsonPath(): string {
  return join(dataHome, 'opencode', 'auth.json')
}

/** Write opencode's auth.json, optionally pinning its mtime so the cache is testable. */
function writeAuthJson(contents: unknown, mtimeSeconds?: number): void {
  mkdirSync(join(dataHome, 'opencode'), { recursive: true })
  writeFileSync(authJsonPath(), JSON.stringify(contents), 'utf-8')
  if (mtimeSeconds !== undefined) utimesSync(authJsonPath(), mtimeSeconds, mtimeSeconds)
}

/**
 * Every string reachable by walking an object's OWN enumerable properties,
 * through plain objects, arrays, Maps and Sets. Used to prove a long-lived
 * cache is not quietly holding credential material.
 */
function reachableStrings(root: unknown, seen = new Set<unknown>()): string[] {
  if (typeof root === 'string') return [root]
  if (root === null || typeof root !== 'object' || seen.has(root)) return []
  seen.add(root)
  const children: unknown[] =
    root instanceof Map
      ? [...root.keys(), ...root.values()]
      : root instanceof Set || Array.isArray(root)
        ? [...(root as Iterable<unknown>)]
        : Object.values(root)
  return children.flatMap((child) => reachableStrings(child, seen))
}

/** Every string any logger method was called with, across all four levels. */
function loggedText(): string {
  const mocks = [logger.warn, logger.info, logger.error, logger.debug] as unknown as Array<{
    mock: { calls: unknown[][] }
  }>
  return mocks
    .flatMap((m) => m.mock.calls)
    .map((call) => JSON.stringify(call))
    .join('\n')
}

describe('OpencodeAuthProvider.accountIdentity — ChatGPT', () => {
  it('names the subscription and the stable user claim', () => {
    writeAuthJson({
      openai: {
        type: 'oauth',
        access: CHATGPT_TOKEN,
        refresh: 'fake-refresh',
        expires: 9999999999,
        accountId: 'acct_workspace_1'
      }
    })
    expect(new OpencodeAuthProvider().accountIdentity('openai')).toEqual({
      accountKey: 'chatgpt:acct_workspace_1:user_stable_1',
      accountLabel: 'Someone@Example.test (pro)'
    })
  })

  it('falls back to the lowercased email when the token carries no user claim', () => {
    writeAuthJson({
      openai: {
        type: 'oauth',
        access: EMAIL_ONLY_TOKEN,
        refresh: 'fake-refresh',
        expires: 9999999999,
        accountId: 'acct_workspace_1'
      }
    })
    expect(new OpencodeAuthProvider().accountIdentity('openai')).toEqual({
      accountKey: 'chatgpt:acct_workspace_1:someone@example.test',
      accountLabel: 'Someone@Example.test'
    })
  })

  it('reads the subscription off the token when the entry carries no account id', () => {
    writeAuthJson({
      openai: { type: 'oauth', access: CHATGPT_TOKEN, refresh: 'fake-refresh', expires: 1 }
    })
    expect(new OpencodeAuthProvider().accountIdentity('openai').accountKey).toBe(
      'chatgpt:acct_workspace_1:user_stable_1'
    )
  })

  it('falls through to the native key when neither the entry nor the token names one', () => {
    writeAuthJson({
      openai: { type: 'oauth', access: EMAIL_ONLY_TOKEN, refresh: 'fake-refresh', expires: 1 }
    })
    expect(new OpencodeAuthProvider().accountIdentity('openai')).toEqual({
      accountKey: 'opencode:openai:native',
      accountLabel: 'openai'
    })
  })
})

describe('OpencodeAuthProvider.accountIdentity — other shapes', () => {
  it('digests an api entry and labels it by its last four characters', () => {
    writeAuthJson({ openrouter: { type: 'api', key: FAKE_API_KEY } })
    const identity = new OpencodeAuthProvider().accountIdentity('openrouter')
    expect(identity.accountKey).toMatch(/^openrouter:key:[0-9a-f]{16}$/)
    expect(identity.accountLabel).toBe('openrouter key …beef')
  })

  it('gives an Anthropic oauth entry the native key — it carries no account id', () => {
    writeAuthJson({
      anthropic: { type: 'oauth', access: 'fake-access', refresh: 'fake-refresh', expires: 1 }
    })
    expect(new OpencodeAuthProvider().accountIdentity('anthropic')).toEqual({
      accountKey: 'opencode:anthropic:native',
      accountLabel: 'anthropic'
    })
  })

  it('gives a vendor with no entry the native key', () => {
    writeAuthJson({ openrouter: { type: 'api', key: FAKE_API_KEY } })
    expect(new OpencodeAuthProvider().accountIdentity('groq').accountKey).toBe(
      'opencode:groq:native'
    )
  })

  it('gives the native key when there is no auth.json at all', () => {
    expect(new OpencodeAuthProvider().accountIdentity('openai')).toEqual({
      accountKey: 'opencode:openai:native',
      accountLabel: 'openai'
    })
  })

  it('gives the native key for an unreadable file, and says nothing about it', () => {
    mkdirSync(join(dataHome, 'opencode'), { recursive: true })
    writeFileSync(authJsonPath(), '{ this is not json', 'utf-8')
    expect(new OpencodeAuthProvider().accountIdentity('openai').accountKey).toBe(
      'opencode:openai:native'
    )
    expect(loggedText()).toBe('')
  })
})

describe('OpencodeAuthProvider.accountIdentity — the mtime cache', () => {
  it('re-reads only when the file changes', () => {
    const provider = new OpencodeAuthProvider()
    writeAuthJson({ openrouter: { type: 'api', key: FAKE_API_KEY } }, 1_700_000_000)
    const first = provider.accountIdentity('openrouter')

    // Same mtime, different content: the cached answer stands.
    writeAuthJson({ openrouter: { type: 'api', key: 'sk-fake-other-key-cafe' } }, 1_700_000_000)
    expect(provider.accountIdentity('openrouter')).toEqual(first)

    // A newer mtime invalidates it, and the new credential is a new account.
    writeAuthJson({ openrouter: { type: 'api', key: 'sk-fake-other-key-cafe' } }, 1_700_000_060)
    const second = provider.accountIdentity('openrouter')
    expect(second.accountKey).not.toBe(first.accountKey)
    expect(second.accountLabel).toBe('openrouter key …cafe')
  })

  it('re-reads when the size changes under an unchanged mtime', () => {
    const provider = new OpencodeAuthProvider()
    writeAuthJson({ openrouter: { type: 'api', key: FAKE_API_KEY } }, 1_700_000_000)
    const first = provider.accountIdentity('openrouter')

    // A same-millisecond rewrite of a different length. mtime alone would
    // serve the stale identity forever; the size in the key catches it.
    writeAuthJson(
      { openrouter: { type: 'api', key: 'sk-fake-considerably-longer-key-9999' } },
      1_700_000_000
    )
    expect(provider.accountIdentity('openrouter').accountKey).not.toBe(first.accountKey)
  })

  it('re-reads when the path itself changes, even to a file of the same age and size', () => {
    // XDG_DATA_HOME can move under a running process. Two files with the SAME
    // mtime and size but different contents would collide on the stamp alone,
    // so the path is part of the key too.
    const other = mkdtempSync(join(tmpdir(), 'opencode-identity-alt-'))
    try {
      const writeAt = (dir: string, key: string): string => {
        mkdirSync(join(dir, 'opencode'), { recursive: true })
        const file = join(dir, 'opencode', 'auth.json')
        writeFileSync(file, JSON.stringify({ openrouter: { type: 'api', key } }), 'utf-8')
        utimesSync(file, 1_700_000_000, 1_700_000_000)
        return file
      }
      // Same length, so the size half of the stamp matches as well.
      writeAt(dataHome, 'sk-fake-0000-0000-beef')
      writeAt(other, 'sk-fake-1111-1111-cafe')

      let dir = dataHome
      const cache = new AuthFileIdentityCache(
        'opencode',
        () => join(dir, 'opencode', 'auth.json'),
        'openai'
      )
      expect(cache.identity('openrouter').accountLabel).toBe('openrouter key …beef')

      dir = other
      expect(cache.identity('openrouter').accountLabel).toBe('openrouter key …cafe')
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('picks up a sign-in that happens after a missing-file read', () => {
    const provider = new OpencodeAuthProvider()
    expect(provider.accountIdentity('openai').accountKey).toBe('opencode:openai:native')

    writeAuthJson({
      openai: {
        type: 'oauth',
        access: CHATGPT_TOKEN,
        refresh: 'fake-refresh',
        expires: 9999999999,
        accountId: 'acct_workspace_1'
      }
    })
    expect(provider.accountIdentity('openai').accountKey).toBe(
      'chatgpt:acct_workspace_1:user_stable_1'
    )
  })
})

describe('OpencodeAuthProvider.accountIdentity — credential boundary', () => {
  it('returns and logs nothing derived from the token or the key beyond the digest and the last four', () => {
    writeAuthJson({
      openai: {
        type: 'oauth',
        access: CHATGPT_TOKEN,
        refresh: 'fake-refresh-token',
        expires: 9999999999,
        accountId: 'acct_workspace_1'
      },
      openrouter: { type: 'api', key: FAKE_API_KEY }
    })
    const provider = new OpencodeAuthProvider()
    const chatgpt = provider.accountIdentity('openai')
    const apiKey = provider.accountIdentity('openrouter')

    // Only the two documented fields come back.
    expect(Object.keys(chatgpt).sort()).toEqual(['accountKey', 'accountLabel'])
    expect(Object.keys(apiKey).sort()).toEqual(['accountKey', 'accountLabel'])

    const returned = JSON.stringify([chatgpt, apiKey])
    for (const secret of [CHATGPT_TOKEN, FAKE_SIGNATURE, 'fake-refresh-token', FAKE_API_KEY]) {
      expect(returned).not.toContain(secret)
    }
    // The API key's last four are the ONE fragment of key material allowed out.
    expect(apiKey.accountLabel).toContain('beef')

    // And nothing at all reached the log.
    const logged = loggedText()
    expect(logged).toBe('')
    for (const secret of [CHATGPT_TOKEN, FAKE_SIGNATURE, 'fake-refresh-token', FAKE_API_KEY]) {
      expect(logged).not.toContain(secret)
    }
  })

  it('keeps no credential material in the cache once the file has been read', () => {
    writeAuthJson({
      openai: {
        type: 'oauth',
        access: CHATGPT_TOKEN,
        refresh: 'fake-refresh-token',
        expires: 9999999999,
        accountId: 'acct_workspace_1'
      },
      openrouter: { type: 'api', key: FAKE_API_KEY }
    })
    const provider = new OpencodeAuthProvider()
    provider.accountIdentity('openai')

    // One read resolves EVERY vendor, so the second vendor's key must not be
    // sitting in the cache either — the parsed file is dropped, identities stay.
    const held = reachableStrings(provider).join('|')
    for (const secret of [CHATGPT_TOKEN, FAKE_SIGNATURE, 'fake-refresh-token', FAKE_API_KEY]) {
      expect(held).not.toContain(secret)
    }
    // The identities themselves ARE held — otherwise this proves nothing.
    expect(held).toContain('chatgpt:acct_workspace_1:user_stable_1')
    expect(held).toContain('openrouter:key:')
  })
})
