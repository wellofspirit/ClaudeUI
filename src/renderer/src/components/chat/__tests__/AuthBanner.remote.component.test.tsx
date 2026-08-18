/**
 * AuthBanner's platform branch (ADR-057 / S4-UI).
 *
 * The banner is the chat-side entry to the Claude sign-in. On DESKTOP nothing
 * about it may change: the host opens its own browser and the banner shows
 * "Waiting for browser authorization…" with no paste field anywhere. On WEB the
 * host opens nothing, so `signIn()` comes back carrying `manualUrl` and the
 * banner expands into the shared paste-back flow, whose submit goes through the
 * store's EXISTING `submitOAuthCode` — one flow state, not two.
 *
 * These are the platform pins: delete the `platform === 'web'` branch and the
 * "not on desktop" tests still pass while the "on web" ones fail, and vice
 * versa, so both directions are actually held.
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
    // The banner only renders when the probe says we are signed out.
    vendorAuth: { anthropic: { authState: 'unauthenticated', billingType: 'unknown' } }
  })
})
afterEach(cleanup)

describe('AuthBanner on web — the paste-back flow', () => {
  it('expands into the code-variant flow after Log in, carrying manualUrl to step 1', async () => {
    installApi('web')
    render(<AuthBanner />)
    expect(screen.queryByTestId('OAuthPasteBackFlow')).toBeNull()

    await act(async () => {
      fireEvent.click(screen.getByTestId('AuthBanner.login'))
    })

    const flow = screen.getByTestId('OAuthPasteBackFlow')
    // Claude shows the code ON its page, so no failed-redirect language here.
    expect(flow).toHaveAttribute('data-variant', 'code')
    fireEvent.click(screen.getByTestId('OAuthPasteBackFlow.open'))
    expect(window.open).toHaveBeenCalledWith(MANUAL_URL, '_blank', 'noopener,noreferrer')
  })

  it('step 2 drives the store’s existing submitOAuthCode, verbatim', async () => {
    installApi('web')
    render(<AuthBanner />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('AuthBanner.login'))
    })
    fireEvent.change(screen.getByTestId('OAuthPasteBackFlow.input'), {
      target: { value: ' code-from-claude-ai ' }
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('OAuthPasteBackFlow.submit'))
    })
    expect(window.api.submitOAuthCode).toHaveBeenCalledTimes(1)
    expect(window.api.submitOAuthCode).toHaveBeenCalledWith('code-from-claude-ai')
  })

  it('a failed submit takes the paste field DOWN and shows the classified outcome', async () => {
    installApi('web', {
      submitOAuthCode: vi.fn(async () => ({
        status: 'error',
        account: null,
        error: 'Invalid state - potential CSRF attack'
      }))
    })
    render(<AuthBanner />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('AuthBanner.login'))
    })
    fireEvent.change(screen.getByTestId('OAuthPasteBackFlow.input'), { target: { value: 'x' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('OAuthPasteBackFlow.submit'))
    })
    // The host tore the flow down, so "start again from step 1" means the
    // Log in button — not a stale field over a dead flow.
    expect(screen.queryByTestId('OAuthPasteBackFlow')).toBeNull()
    expect(screen.getByTestId('OAuthOutcomeNotice')).toHaveAttribute('data-kind', 'state-mismatch')
    expect(screen.getByTestId('AuthBanner.login')).toBeTruthy()
  })

  it('a rejected sign-in invoke does not strand the banner on "authorizing"', async () => {
    installApi('web', {
      signIn: vi.fn(async () => {
        throw new Error('capability denied')
      })
    })
    render(<AuthBanner />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('AuthBanner.login'))
    })
    expect(useSessionStore.getState().authState?.status).toBe('error')
    expect(screen.getByTestId('OAuthOutcomeNotice')).toHaveTextContent('capability denied')
  })
})

describe('AuthBanner on desktop — unchanged (platform pin)', () => {
  it('shows the legacy waiting state and NEVER mounts the paste flow', async () => {
    installApi('darwin')
    render(<AuthBanner />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('AuthBanner.login'))
    })
    expect(screen.queryByTestId('OAuthPasteBackFlow')).toBeNull()
    expect(screen.getByTestId('AuthBanner')).toHaveTextContent('Waiting for browser authorization…')
    expect(screen.getByTestId('AuthBanner.cancel')).toBeTruthy()
  })

  it('renders no outcome row on desktop either — its copy is web-only', async () => {
    installApi('darwin')
    render(<AuthBanner />)
    act(() => {
      useSessionStore
        .getState()
        .setAuthState({ status: 'error', account: null, error: 'Invalid state' })
    })
    expect(screen.queryByTestId('OAuthOutcomeNotice')).toBeNull()
  })
})
