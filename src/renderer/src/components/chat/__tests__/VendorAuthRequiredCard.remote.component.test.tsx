/**
 * VendorAuthRequiredCard's platform branch (ADR-057 / S4-UI).
 *
 * The mid-conversation 401 card is the second chat entry point. Its trigger and
 * its post-success Retry are unchanged; what is new is that on WEB the shared
 * `authorizeVendorOAuth` parks the flow at `stage: 'paste'` and the card expands
 * into the two-step form instead of claiming a host browser is open. When the
 * backend refuses the method outright — opencode's `auto` cannot complete off
 * the host — the card renders the desktop-only outcome.
 *
 * The desktop tests are the pin in the other direction: the card must still show
 * "Waiting for browser authorization…" with no paste field.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useSessionStore } from '../../../stores/session-store'
import { VendorAuthRequiredCard } from '../VendorAuthRequiredCard'

vi.mock('electron', async () => await import('../../../../../test/stubs/electron-shim'))

const ROUTING_ID = 'vendor-auth-remote-1'
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize?state=s'

function installApi(platform: string, over: Record<string, unknown> = {}): void {
  ;(globalThis as unknown as { window: Record<string, unknown> }).window.api = {
    platform,
    saveSessionConfig: vi.fn(),
    vendorAuthListOptions: vi.fn(async () => ({ openai: [{ type: 'oauth', label: 'Sign in' }] })),
    vendorAuthOauthAuthorize: vi.fn(async () => ({
      url: AUTHORIZE_URL,
      method: 'auto',
      instructions: 'Complete sign-in in the browser window that just opened.'
    })),
    vendorAuthOauthCallback: vi.fn(async () => true),
    vendorAuthOauthCancel: vi.fn(async () => {}),
    ...over
  }
  ;(globalThis as unknown as { window: Record<string, unknown> }).window.open = vi.fn()
}

function mountCard(): void {
  useSessionStore.setState({ activeSessionId: null, sessions: {}, vendorOAuth: null })
  useSessionStore.getState().createNewSession(ROUTING_ID, '/test/cwd')
  useSessionStore.setState({ activeSessionId: ROUTING_ID })
  useSessionStore
    .getState()
    .setVendorAuthRequired(ROUTING_ID, { vendorId: 'openai', message: 'Token expired' })
}

afterEach(cleanup)

describe('VendorAuthRequiredCard on web — the paste-back flow', () => {
  beforeEach(() => installApi('web'))

  it('Re-authenticate expands the url-variant flow instead of claiming a browser opened', async () => {
    mountCard()
    render(<VendorAuthRequiredCard />)
    expect(screen.queryByTestId('OAuthPasteBackFlow')).toBeNull()

    await act(async () => {
      fireEvent.click(screen.getByText('Re-authenticate'))
    })

    const flow = screen.getByTestId('OAuthPasteBackFlow')
    expect(flow).toHaveAttribute('data-variant', 'url')
    expect(flow).toHaveAttribute('data-id', 'openai')
    expect(screen.queryByText('Waiting for browser authorization…')).toBeNull()
    fireEvent.click(screen.getByTestId('OAuthPasteBackFlow.open'))
    expect(window.open).toHaveBeenCalledWith(AUTHORIZE_URL, '_blank', 'noopener,noreferrer')
  })

  it('the paste goes to vendor-auth:oauth-callback verbatim and success offers Retry', async () => {
    mountCard()
    // Give the session a user prompt so the post-success Retry has something.
    render(<VendorAuthRequiredCard />)
    await act(async () => {
      fireEvent.click(screen.getByText('Re-authenticate'))
    })
    const pasted = 'http://localhost:1455/auth/callback?code=abc&state=s'
    fireEvent.change(screen.getByTestId('OAuthPasteBackFlow.input'), { target: { value: pasted } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('OAuthPasteBackFlow.submit'))
    })
    expect(window.api.vendorAuthOauthCallback).toHaveBeenCalledWith('claude', 'openai', 0, pasted)
    expect(screen.getByText('Re-authenticated.')).toBeTruthy()
  })

  it("renders the desktop-only outcome when the backend refuses opencode's auto method", async () => {
    const refusal =
      "opencode's automatic browser sign-in only completes on the host machine. " +
      "Choose the 'paste a code' method, or sign in from the desktop app."
    installApi('web', {
      vendorAuthOauthAuthorize: vi.fn(async () => {
        throw new Error(refusal)
      })
    })
    mountCard()
    render(<VendorAuthRequiredCard />)
    await act(async () => {
      fireEvent.click(screen.getByText('Re-authenticate'))
    })
    expect(screen.queryByTestId('OAuthPasteBackFlow')).toBeNull()
    expect(screen.getByTestId('OAuthOutcomeNotice')).toHaveAttribute('data-kind', 'desktop-only')
  })
})

describe('VendorAuthRequiredCard on desktop — unchanged (platform pin)', () => {
  it('drives the host browser and never mounts the paste flow', async () => {
    // Hold the loopback open so the card stays in its waiting state.
    let release: (v: boolean) => void = () => {}
    installApi('darwin', {
      vendorAuthOauthCallback: vi.fn(
        () => new Promise<boolean>((resolve) => (release = resolve))
      )
    })
    mountCard()
    render(<VendorAuthRequiredCard />)
    await act(async () => {
      fireEvent.click(screen.getByText('Re-authenticate'))
    })
    expect(window.open).toHaveBeenCalledWith(AUTHORIZE_URL, '_blank')
    expect(screen.queryByTestId('OAuthPasteBackFlow')).toBeNull()
    expect(screen.getByText('Waiting for browser authorization…')).toBeTruthy()
    await act(async () => {
      release(true)
    })
  })
})
