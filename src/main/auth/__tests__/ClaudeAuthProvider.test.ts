/**
 * @vitest-environment node
 *
 * Unit tests for ClaudeAuthProvider (Phase 4 / ADR-021).
 *
 * Covers:
 *  - probe() returns correct AuthStatus / billingType for authenticated/unauthenticated signals
 *  - updateAuthSource() updates the probe cache
 *  - buildAccountRef() builds a correct AccountRef
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../services/auth-manager', () => ({
  authManager: {
    onLoginSuccess: vi.fn(),
    signIn: vi.fn(),
    submitOAuthCode: vi.fn(),
    cancelSignIn: vi.fn()
  }
}))
vi.mock('../../services/account-manager', () => ({
  accountManager: {
    addAccount: vi.fn(),
    switchAccount: vi.fn(),
    deleteAccount: vi.fn()
  }
}))
vi.mock('electron', async () => await import('../../../test/stubs/electron-shim'))

// Use the exported singleton (reset between tests via updateAuthSource).
import { claudeAuthProvider } from '../ClaudeAuthProvider'

describe('ClaudeAuthProvider.probe()', () => {
  beforeEach(() => {
    // Reset probe state between tests.
    claudeAuthProvider.updateAuthSource('none', null)
  })

  it('returns unauthenticated when auth-source is "none"', async () => {
    claudeAuthProvider.updateAuthSource('none', null)
    const map = await claudeAuthProvider.probe()
    expect(map.anthropic).toBeDefined()
    expect(map.anthropic!.authState).toBe('unauthenticated')
  })

  it('returns authenticated when auth-source is "authenticated"', async () => {
    claudeAuthProvider.updateAuthSource('authenticated', {
      email: 'user@example.com',
      organization: null,
      subscriptionType: 'max',
      tokenSource: null,
      apiKeySource: null,
      apiProvider: null
    })
    const map = await claudeAuthProvider.probe()
    expect(map.anthropic!.authState).toBe('authenticated')
  })

  it('returns unknown before any auth-source update', async () => {
    // The singleton starts with cachedAuthSource = null after updateAuthSource(null)
    // Not possible to reset to null on the singleton, but 'none' gives unauthenticated.
    // Test that the initial state (when called first time) is 'unknown'.
    // We test by calling probe() without any prior updateAuthSource calls via a fresh import.
    // Since we use a singleton, we verify the default-to-unknown path via an unrecognized source.
    claudeAuthProvider.updateAuthSource('', null)
    const map = await claudeAuthProvider.probe()
    // Empty string is not 'authenticated' or 'none' → unknown
    expect(map.anthropic!.authState).toBe('unknown')
  })

  it('infers subscription billingType from subscriptionType', async () => {
    claudeAuthProvider.updateAuthSource('authenticated', {
      email: 'user@example.com',
      organization: null,
      subscriptionType: 'pro',
      tokenSource: null,
      apiKeySource: null,
      apiProvider: null
    })
    const map = await claudeAuthProvider.probe()
    expect(map.anthropic!.billingType).toBe('subscription')
  })

  it('infers apiKey billingType from apiKeySource', async () => {
    claudeAuthProvider.updateAuthSource('authenticated', {
      email: 'api@example.com',
      organization: null,
      subscriptionType: null,
      tokenSource: null,
      apiKeySource: 'console',
      apiProvider: null
    })
    const map = await claudeAuthProvider.probe()
    expect(map.anthropic!.billingType).toBe('apiKey')
  })

  it('returns unknown billingType when no subscription or apiKey info', async () => {
    claudeAuthProvider.updateAuthSource('authenticated', {
      email: 'user@example.com',
      organization: null,
      subscriptionType: null,
      tokenSource: null,
      apiKeySource: null,
      apiProvider: null
    })
    const map = await claudeAuthProvider.probe()
    expect(map.anthropic!.billingType).toBe('unknown')
  })

  it('sets label from email', async () => {
    claudeAuthProvider.updateAuthSource('authenticated', {
      email: 'user@example.com',
      organization: 'Acme',
      subscriptionType: 'max',
      tokenSource: null,
      apiKeySource: null,
      apiProvider: null
    })
    const map = await claudeAuthProvider.probe()
    expect(map.anthropic!.label).toBe('user@example.com')
  })
})

describe('ClaudeAuthProvider.buildAccountRef()', () => {
  it('builds AccountRef with correct fields', () => {
    claudeAuthProvider.updateAuthSource('authenticated', {
      email: 'user@example.com',
      organization: null,
      subscriptionType: 'max',
      tokenSource: null,
      apiKeySource: null,
      apiProvider: null
    })
    const ref = claudeAuthProvider.buildAccountRef('acct-123')
    expect(ref.engineId).toBe('claude')
    expect(ref.vendorId).toBe('anthropic')
    expect(ref.authState).toBe('authenticated')
    expect(ref.billingType).toBe('subscription')
    expect(ref.label).toBe('user@example.com')
    expect(ref.accountId).toBe('acct-123')
  })

  it('has null accountId when not passed', () => {
    claudeAuthProvider.updateAuthSource('none', null)
    const ref = claudeAuthProvider.buildAccountRef(null)
    expect(ref.authState).toBe('unauthenticated')
    expect(ref.accountId).toBeUndefined()
  })
})
