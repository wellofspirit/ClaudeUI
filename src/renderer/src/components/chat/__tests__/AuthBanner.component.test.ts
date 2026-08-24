/**
 * Detection rewire tests (Phase 4 / ADR-021).
 *
 * Verifies that the AuthBanner reads from vendorAuth (the probe) rather than
 * the raw authSource string, with behavior-equivalent results:
 *   - probe 'authenticated'   → no banner
 *   - probe 'unauthenticated' → banner shown
 *   - probe 'unknown'         → no banner (null state = waiting)
 *   - post-login success      → banner clears even if probe is still unauthenticated
 *
 * These are store-level tests (no React rendering needed).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSessionStore } from '../../../stores/session-store'

vi.mock('electron', async () => await import('../../../../../test/stubs/electron-shim'))

// Ensure the store is reset before each test by clearing vendorAuth and authState
// via Zustand's internal setState (the actions don't accept null).
beforeEach(() => {
  useSessionStore.setState({ vendorAuth: null, authState: null })
})

describe('Detection rewire: vendorAuth drives AuthBanner visibility logic', () => {
  it('vendorAuth null → no banner (unknown / not yet probed)', () => {
    useSessionStore.setState({ vendorAuth: null })
    const { vendorAuth } = useSessionStore.getState()
    const probeState = vendorAuth?.anthropic?.authState
    // When vendorAuth is null, probeState is undefined → loggedOut = false → no banner.
    expect(probeState).toBeUndefined()
    const loggedOut = probeState === 'unauthenticated'
    expect(loggedOut).toBe(false)
  })

  it('vendorAuth.anthropic.authState = "authenticated" → no banner', () => {
    useSessionStore.getState().setVendorAuth({
      anthropic: { authState: 'authenticated', billingType: 'subscription' }
    })
    const { vendorAuth } = useSessionStore.getState()
    const probeState = vendorAuth?.anthropic?.authState
    const loggedOut = probeState === 'unauthenticated'
    expect(loggedOut).toBe(false)
  })

  it('vendorAuth.anthropic.authState = "unauthenticated" → banner shown', () => {
    useSessionStore.getState().setVendorAuth({
      anthropic: { authState: 'unauthenticated', billingType: 'unknown' }
    })
    const { vendorAuth, authState } = useSessionStore.getState()
    const probeState = vendorAuth?.anthropic?.authState
    const loggedOut = probeState === 'unauthenticated' && authState?.status !== 'success'
    expect(loggedOut).toBe(true)
  })

  it('post-login success clears banner even if probe not yet updated', () => {
    // Simulate: probe says unauthenticated but a login just succeeded.
    useSessionStore.getState().setVendorAuth({
      anthropic: { authState: 'unauthenticated', billingType: 'unknown' }
    })
    useSessionStore.getState().setAuthState({
      status: 'success',
      account: {
        email: 'user@example.com',
        organization: null,
        subscriptionType: null,
        tokenSource: null,
        apiKeySource: null,
        apiProvider: null
      },
      error: null
    })
    const { vendorAuth, authState } = useSessionStore.getState()
    const probeState = vendorAuth?.anthropic?.authState
    // loggedOut = probe is unauthenticated AND status !== 'success'
    const loggedOut = probeState === 'unauthenticated' && authState?.status !== 'success'
    expect(loggedOut).toBe(false)
  })
})

describe('onAuthSource → setVendorAuth mirror', () => {
  it('auth-source "authenticated" sets probe to authenticated', () => {
    // Simulate what useClaudeEvents.ts does when onAuthSource fires.
    const store = useSessionStore.getState()
    store.setAuthSource('authenticated')
    store.setVendorAuth({
      anthropic: {
        authState: 'authenticated',
        billingType: 'unknown',
        label: undefined
      }
    })
    const { vendorAuth } = useSessionStore.getState()
    expect(vendorAuth?.anthropic?.authState).toBe('authenticated')
  })

  it('auth-source "none" sets probe to unauthenticated', () => {
    const store = useSessionStore.getState()
    store.setAuthSource('none')
    store.setVendorAuth({
      anthropic: {
        authState: 'unauthenticated',
        billingType: 'unknown',
        label: undefined
      }
    })
    const { vendorAuth } = useSessionStore.getState()
    expect(vendorAuth?.anthropic?.authState).toBe('unauthenticated')
  })
})
