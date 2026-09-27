/**
 * @vitest-environment node
 *
 * buildEnv() under multi-account (ADR-015): the active account's host token,
 * on Claude Desktop 2.9939.2's env contract (sdk/args.ts `applyHostTokenEnv`).
 *
 * The active dir is module state (setSecurestorageEnv) and is authoritative
 * over anything inherited from the parent shell. A custom endpoint profile
 * brings its own credential and gets no host token. Single-account mode passes
 * the inherited env through untouched. And a spawn owed a host token that
 * cannot have one THROWS: it must never fall through to the machine's default
 * Claude login. Every token string below is invented.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { buildEnv, buildSpawnEnv } from '../args'
import { setSecurestorageEnv } from '../securestorage-env'
import { setEndpointEnv } from '../endpoint-env'
import {
  HostTokenUnavailableError,
  setHostTokenSource,
  type HostTokenCredential,
  type HostTokenSource
} from '../host-token'

const DIR = '/accounts/active-account'

function source(credential: HostTokenCredential | null): HostTokenSource & {
  read: ReturnType<typeof vi.fn>
} {
  return {
    read: vi.fn(() => credential),
    ensureFresh: vi.fn(async () => undefined),
    attach: vi.fn(() => () => undefined),
    answerRefresh: vi.fn(async () => ({ accessToken: null }))
  }
}

const CREDENTIAL: HostTokenCredential = {
  accessToken: 'fake-host-access',
  scopes: ['user:inference', 'user:profile'],
  subscriptionType: 'max',
  rateLimitTier: 'default_claude_max_20x'
}

/** What a parent shell might carry — each one a way to pick the wrong credential. */
const INHERITED = {
  ANTHROPIC_API_KEY: 'fake-inherited-key',
  ANTHROPIC_AUTH_TOKEN: 'fake-inherited-bearer',
  ANTHROPIC_CUSTOM_HEADERS: 'x-fake: 1',
  ANTHROPIC_BASE_URL: 'https://inherited-gateway.invalid',
  CLAUDE_CODE_OAUTH_TOKEN: 'fake-inherited-oauth',
  SKIP_SECURESTORAGE: '1',
  CLAUDE_SECURESTORAGE_CONFIG_DIR: '/inherited/shared/dir',
  CLAUDE_CODE_ENTRYPOINT: 'sdk-cli'
}

describe('buildEnv under multi-account', () => {
  beforeEach(() => {
    setSecurestorageEnv(null)
    setEndpointEnv(null)
    setHostTokenSource(null)
  })
  afterEach(() => {
    setSecurestorageEnv(null)
    setEndpointEnv(null)
    setHostTokenSource(null)
  })

  it('hands cli.js the active account token, exactly as Claude Desktop does', () => {
    const src = source(CREDENTIAL)
    setHostTokenSource(src)
    setSecurestorageEnv({ dir: DIR })

    const { env, hostToken } = buildSpawnEnv({ ...INHERITED, PATH: '/bin' })

    expect(src.read).toHaveBeenCalledWith(DIR)
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBe('claude-desktop')
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('fake-host-access')
    expect(env.CLAUDE_CODE_OAUTH_SCOPES).toBe('user:inference user:profile')
    expect(env.CLAUDE_CODE_SUBSCRIPTION_TYPE).toBe('max')
    expect(env.CLAUDE_CODE_RATE_LIMIT_TIER).toBe('default_claude_max_20x')
    expect(env.CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH).toBe('1')
    for (const removed of [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_CUSTOM_HEADERS',
      'ANTHROPIC_BASE_URL',
      'SKIP_SECURESTORAGE',
      'CLAUDE_SECURESTORAGE_CONFIG_DIR'
    ]) {
      expect(env[removed], removed).toBeUndefined()
    }
    expect(env.PATH).toBe('/bin')
    // What query() registers with the keeper.
    expect(hostToken).toEqual({ dir: DIR, token: 'fake-host-access' })
  })

  it('sends empty strings for a credential with no plan, tier or scopes', () => {
    setHostTokenSource(
      source({ ...CREDENTIAL, scopes: [], subscriptionType: null, rateLimitTier: null })
    )
    setSecurestorageEnv({ dir: DIR })

    const env = buildEnv({})

    expect(env.CLAUDE_CODE_OAUTH_SCOPES).toBe('')
    expect(env.CLAUDE_CODE_SUBSCRIPTION_TYPE).toBe('')
    expect(env.CLAUDE_CODE_RATE_LIMIT_TIER).toBe('')
  })

  it('gives an endpoint profile its own credential and no host token', () => {
    const src = source(CREDENTIAL)
    setHostTokenSource(src)
    setSecurestorageEnv({ dir: DIR })
    setEndpointEnv({
      ANTHROPIC_BASE_URL: 'https://gateway.invalid',
      ANTHROPIC_AUTH_TOKEN: 'fake-endpoint-bearer'
    })

    const { env, hostToken } = buildSpawnEnv({ ...INHERITED })

    expect(src.read).not.toHaveBeenCalled()
    expect(hostToken).toBeNull()
    expect(env.ANTHROPIC_BASE_URL).toBe('https://gateway.invalid')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('fake-endpoint-bearer')
    expect(env.CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH).toBeUndefined()
    // Still multi-account: nothing inherited may pick an account credential.
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(env.SKIP_SECURESTORAGE).toBeUndefined()
    expect(env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBeUndefined()
  })

  it('leaves single-account mode to the user’s own login, inherited env untouched', () => {
    const src = source(CREDENTIAL)
    setHostTokenSource(src)

    const { env, hostToken } = buildSpawnEnv({ ...INHERITED })

    expect(src.read).not.toHaveBeenCalled()
    expect(hostToken).toBeNull()
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('fake-inherited-oauth')
    expect(env.ANTHROPIC_API_KEY).toBe('fake-inherited-key')
    expect(env.SKIP_SECURESTORAGE).toBe('1')
    expect(env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe('/inherited/shared/dir')
    expect(env.CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH).toBeUndefined()
    expect(env.CLAUDE_CODE_OAUTH_SCOPES).toBeUndefined()
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBe('claude-desktop')
  })

  it('refuses a multi-account spawn whose account has no token', () => {
    setHostTokenSource(source(null))
    setSecurestorageEnv({ dir: DIR })

    expect(() => buildEnv({ ...INHERITED })).toThrow(HostTokenUnavailableError)
  })

  it('refuses a multi-account spawn when no token keeper is wired', () => {
    setSecurestorageEnv({ dir: DIR })

    let thrown: unknown
    try {
      buildEnv({})
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(HostTokenUnavailableError)
    expect((thrown as HostTokenUnavailableError).reason).toBe('signed-out')
  })
})
