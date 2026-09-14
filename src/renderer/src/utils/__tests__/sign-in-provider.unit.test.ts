/**
 * Layer 1: the pure half of Slice 6's sign-in entry points (ADR-068 §3).
 *
 * Two rules are worth guarding on their own, away from any component:
 *
 *  1. WHICH provider backs a `(engineId, vendorId)` pair. Getting this wrong in
 *     either direction is a real failure: a missing entry point strands a user
 *     with no credential, and a spurious one offers a ChatGPT sign-in for a
 *     provider holding an API key ClaudeUI cannot touch (ADR-030).
 *  2. That `'unknown'` is never collapsed into `'unauthenticated'`. An unprobed
 *     host is not a signed-out host, and the whole entry point hangs off that
 *     distinction.
 */
import { describe, it, expect } from 'vitest'
import {
  anthropicAuthState,
  chatgptAuthFromRegistry,
  signInProviderFor,
  UNKNOWN_PROVIDER_AUTH,
  type ProviderAuthView
} from '../sign-in-provider'
import type { ProviderEntry, ProviderRegistrySnapshot } from '../../../../shared/provider-registry'

const auth = (patch: Partial<ProviderAuthView> = {}): ProviderAuthView => ({
  ...UNKNOWN_PROVIDER_AUTH,
  ...patch
})

/** Every provider signed out, both ChatGPT routes live — the "offer it" case. */
const signedOut = auth({
  anthropic: 'unauthenticated',
  chatgpt: 'unauthenticated',
  chatgptRoutes: { pi: true, opencode: true }
})

const chatgptEntry = (patch: Partial<ProviderEntry> = {}): ProviderEntry => ({
  id: 'chatgpt',
  name: 'ChatGPT',
  origin: 'shared',
  credential: 'connected',
  engines: { pi: { enabled: true }, opencode: { enabled: true } },
  ...patch
})

const snapshot = (...entries: ProviderEntry[]): ProviderRegistrySnapshot => ({
  entries,
  opencodeInstalled: true
})

describe('signInProviderFor', () => {
  it.each([
    ['claude', 'anthropic', 'anthropic'],
    ['codex', 'openai', 'chatgpt'],
    ['pi', 'openai-codex', 'chatgpt'],
    ['opencode', 'openai', 'chatgpt']
  ] as const)('%s / %s resolves to %s', (engineId, vendorId, providerId) => {
    expect(signInProviderFor(engineId, vendorId, signedOut)).toEqual({
      providerId,
      state: 'unauthenticated'
    })
  })

  it('leaves a pi/opencode ChatGPT vendor alone while its route is off', () => {
    const routesOff = auth({ chatgpt: 'unauthenticated', chatgptRoutes: {} })
    expect(signInProviderFor('pi', 'openai-codex', routesOff)).toBeNull()
    expect(signInProviderFor('opencode', 'openai', routesOff)).toBeNull()
  })

  it('does NOT gate Codex on the shared routes — it has none', () => {
    // ChatGPT's `engines` facts describe its pi/opencode routes; Codex reads the
    // vault directly (ADR-068 §1), so an empty `chatgptRoutes` must not silence
    // the one engine that cannot run without a ChatGPT sign-in.
    expect(signInProviderFor('codex', 'openai', auth({ chatgpt: 'unauthenticated' }))).toEqual({
      providerId: 'chatgpt',
      state: 'unauthenticated'
    })
  })

  it.each([
    ['pi', 'anthropic'],
    ['opencode', 'zen'],
    ['opencode', 'groq'],
    ['claude', 'openai']
  ] as const)('%s / %s has no ClaudeUI-drivable sign-in', (engineId, vendorId) => {
    expect(signInProviderFor(engineId, vendorId, signedOut)).toBeNull()
  })

  it('falls back to the engine default vendor when the model carries none', () => {
    expect(signInProviderFor('claude', undefined, signedOut)).toEqual({
      providerId: 'anthropic',
      state: 'unauthenticated'
    })
    expect(signInProviderFor('pi', undefined, signedOut)).toEqual({
      providerId: 'chatgpt',
      state: 'unauthenticated'
    })
  })

  it('reports the state verbatim — authenticated and unknown are not "signed out"', () => {
    expect(signInProviderFor('claude', 'anthropic', auth({ anthropic: 'authenticated' }))).toEqual({
      providerId: 'anthropic',
      state: 'authenticated'
    })
    expect(signInProviderFor('claude', 'anthropic', UNKNOWN_PROVIDER_AUTH)).toEqual({
      providerId: 'anthropic',
      state: 'unknown'
    })
  })
})

describe('anthropicAuthState', () => {
  it('is unknown until the probe reports, then mirrors it', () => {
    expect(anthropicAuthState(null)).toBe('unknown')
    expect(anthropicAuthState({})).toBe('unknown')
    expect(
      anthropicAuthState({ anthropic: { authState: 'unauthenticated', billingType: 'unknown' } })
    ).toBe('unauthenticated')
    expect(
      anthropicAuthState({ anthropic: { authState: 'authenticated', billingType: 'subscription' } })
    ).toBe('authenticated')
  })
})

describe('chatgptAuthFromRegistry', () => {
  it('connected with a healthy active account is authenticated', () => {
    expect(
      chatgptAuthFromRegistry(
        snapshot(
          chatgptEntry({
            accounts: { activeId: 'a1', perSession: false, list: [{ id: 'a1', email: 'x@y.z' }] }
          })
        )
      )
    ).toEqual({ chatgpt: 'authenticated', chatgptRoutes: { pi: true, opencode: true } })
  })

  it('credential none is unauthenticated', () => {
    expect(chatgptAuthFromRegistry(snapshot(chatgptEntry({ credential: 'none' }))).chatgpt).toBe(
      'unauthenticated'
    )
  })

  it('an ACTIVE account needing re-auth is unauthenticated even though the row says connected', () => {
    // `sharedCredential` counts a stored account AS the credential, so a revoked
    // refresh token still reads `connected`; without needsReauth the picker
    // would keep claiming the user is signed in.
    expect(
      chatgptAuthFromRegistry(
        snapshot(
          chatgptEntry({
            accounts: {
              activeId: 'dead',
              perSession: false,
              list: [{ id: 'fine' }, { id: 'dead', needsReauth: true }]
            }
          })
        )
      ).chatgpt
    ).toBe('unauthenticated')
  })

  it('an INACTIVE account needing re-auth changes nothing', () => {
    expect(
      chatgptAuthFromRegistry(
        snapshot(
          chatgptEntry({
            accounts: {
              activeId: 'fine',
              perSession: false,
              list: [{ id: 'fine' }, { id: 'dead', needsReauth: true }]
            }
          })
        )
      ).chatgpt
    ).toBe('authenticated')
  })

  it('a failed read and a missing row are unknown, never signed out', () => {
    expect(chatgptAuthFromRegistry(null)).toEqual({ chatgpt: 'unknown', chatgptRoutes: {} })
    expect(chatgptAuthFromRegistry(snapshot())).toEqual({ chatgpt: 'unknown', chatgptRoutes: {} })
  })

  it('projects each engine route, defaulting a factless engine to off', () => {
    expect(
      chatgptAuthFromRegistry(
        snapshot(chatgptEntry({ engines: { pi: { enabled: false }, opencode: { enabled: true } } }))
      ).chatgptRoutes
    ).toEqual({ pi: false, opencode: true })
  })
})
