/**
 * AuthBanner's platform behaviour after ADR-068 §3.
 *
 * This file used to pin the banner's OWN paste-back branch (ADR-057 / S4-UI):
 * on web the banner expanded into the two-step form, on desktop it showed the
 * loopback wait. Slice 3 moved every flow into `SignInDialog`, so the property
 * worth pinning inverted — the banner must now look the SAME on both hosts and
 * must never mount flow UI at all. The paste-back behaviour those cases guarded
 * did not disappear; it moved, and `auth/__tests__/SignInDialog.component.test.tsx`
 * pins it there, per host, for both providers.
 *
 * Keeping the file (rather than deleting it with the branch) is deliberate: the
 * hazard it was written for — a sign-in growing a second home — is exactly what
 * a future edit to this component would look like.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useSessionStore } from '../../../stores/session-store'
import { AuthBanner } from '../AuthBanner'

vi.mock('electron', async () => await import('../../../../../test/stubs/electron-shim'))

const MANUAL_URL = 'https://claude.ai/oauth/authorize?state=abc'

function installApi(platform: string, over: Record<string, unknown> = {}): void {
  ;(globalThis as unknown as { window: Record<string, unknown> }).window.api = {
    platform,
    signIn: vi.fn(async () => ({
      status: 'authorizing',
      account: null,
      error: null,
      ...(platform === 'web' ? { manualUrl: MANUAL_URL } : {})
    })),
    submitOAuthCode: vi.fn(async () => ({ status: 'success', account: null, error: null })),
    cancelSignIn: vi.fn(async () => {}),
    ...over
  }
  ;(globalThis as unknown as { window: Record<string, unknown> }).window.open = vi.fn()
}

beforeEach(() => {
  useSessionStore.setState({
    authState: null,
    signInDialog: null,
    // The banner only renders when the probe says we are signed out.
    vendorAuth: { anthropic: { authState: 'unauthenticated', billingType: 'unknown' } }
  })
})
afterEach(cleanup)

describe.each(['web', 'darwin'])('AuthBanner on %s — one line, no flow', (platform) => {
  it('Sign in only opens the dialog; it never starts or renders a flow', async () => {
    installApi(platform)
    render(<AuthBanner />)

    await act(async () => {
      fireEvent.click(screen.getByTestId('AuthBanner.login'))
    })

    expect(useSessionStore.getState().signInDialog).toEqual({
      providerId: 'anthropic',
      mode: 'reauth'
    })
    // The DRIVER is the dialog's to call, not the banner's.
    expect(window.api.signIn).not.toHaveBeenCalled()
    expect(screen.queryByTestId('OAuthPasteBackFlow')).toBeNull()
    expect(screen.getByTestId('AuthBanner').querySelector('input')).toBeNull()
  })

  it('a flow someone dismissed the dialog on stays visible here, with Cancel only', async () => {
    installApi(platform)
    render(<AuthBanner />)
    act(() =>
      useSessionStore
        .getState()
        .setAuthState({ status: 'authorizing', account: null, error: null, manualUrl: MANUAL_URL })
    )

    expect(screen.getByTestId('AuthBanner')).toHaveTextContent('Signing in')
    expect(screen.getByTestId('AuthBanner.cancel')).toBeTruthy()
    expect(screen.queryByTestId('OAuthPasteBackFlow')).toBeNull()
    // Neither the URL nor an outcome row: the dialog owns both.
    expect(screen.getByTestId('AuthBanner').textContent).not.toContain('claude.ai')

    await act(async () => {
      fireEvent.click(screen.getByTestId('AuthBanner.cancel'))
    })
    expect(window.api.cancelSignIn).toHaveBeenCalledTimes(1)
  })

  it('renders no outcome row for a failed sign-in either', async () => {
    installApi(platform)
    render(<AuthBanner />)
    act(() =>
      useSessionStore
        .getState()
        .setAuthState({ status: 'error', account: null, error: 'Invalid state' })
    )
    expect(screen.queryByTestId('OAuthOutcomeNotice')).toBeNull()
    expect(screen.getByTestId('AuthBanner.login')).toBeTruthy()
  })
})
