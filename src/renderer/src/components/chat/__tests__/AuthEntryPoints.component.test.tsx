/**
 * The chat's three auth ENTRY POINTS after ADR-068 §3.
 *
 * None of them carries a flow any more — each one's only job is to open
 * `SignInDialog` with the right request — so what is pinned here is (a) the
 * absence of any flow UI, and (b) the exact request each entry produces:
 *
 *  · `AuthBanner`         — one line; Sign in → `{ anthropic, reauth }`;
 *  · `AuthErrorBlock`     — the transcript row for a rejected Claude turn;
 *                           Sign in captures the last user prompt as `retry`;
 *  · `AuthRequiredRow`    — engine-neutral, rendered from `session.authRequired`.
 *                           A provider ClaudeUI can drive opens the dialog; an
 *                           `opencode:<vendor>` one has no flow to offer, so it
 *                           opens Settings › Models & providers instead.
 *
 * The deleted surfaces are pinned by their testids: `VendorAuthRequiredCard` and
 * the banner's paste field must not come back through some other component.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useSessionStore } from '../../../stores/session-store'
import { AuthBanner } from '../AuthBanner'
import { AuthRequiredRow } from '../AuthRequiredRow'
import { MessageBubble } from '../MessageBubble'
import type { ChatMessage } from '../../../../../shared/types'

vi.mock('electron', async () => await import('../../../../../test/stubs/electron-shim'))

const ROUTING_ID = 'r-auth-entry'

function installApi(over: Record<string, unknown> = {}): void {
  ;(globalThis as unknown as { window: Record<string, unknown> }).window.api = {
    platform: 'web',
    saveSessionConfig: vi.fn(),
    signIn: vi.fn(async () => ({ status: 'authorizing', account: null, error: null })),
    submitOAuthCode: vi.fn(async () => ({ status: 'success', account: null, error: null })),
    cancelSignIn: vi.fn(async () => {}),
    ...over
  }
  ;(globalThis as unknown as { window: Record<string, unknown> }).window.open = vi.fn()
}

/** A session with one user prompt, so the retry capture has something to find. */
function seedSession(): void {
  useSessionStore.setState({ activeSessionId: null, sessions: {}, signInDialog: null })
  useSessionStore.getState().createNewSession(ROUTING_ID, '/tmp/proj')
  useSessionStore.setState({ activeSessionId: ROUTING_ID })
  patch({
    messages: [
      {
        id: 'm1',
        role: 'user',
        content: [{ type: 'text', text: 'do the thing' }],
        timestamp: 0
      } as ChatMessage
    ]
  })
}

/** Tests are exempt from the sealed-field lint rule; this is the fixture seam. */
function patch(fields: Record<string, unknown>): void {
  useSessionStore.setState((s) => ({
    sessions: { ...s.sessions, [ROUTING_ID]: { ...s.sessions[ROUTING_ID], ...fields } }
  }))
}

beforeEach(() => {
  installApi()
  useSessionStore.setState({
    signInDialog: null,
    authState: null,
    vendorAuth: { anthropic: { authState: 'unauthenticated', billingType: 'unknown' } }
  })
})
afterEach(cleanup)

describe('AuthBanner — one line, no flow', () => {
  it('Sign in opens the dialog and the banner never grows a paste field', async () => {
    render(<AuthBanner />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('AuthBanner.login'))
    })
    expect(useSessionStore.getState().signInDialog).toEqual({
      providerId: 'anthropic',
      mode: 'reauth'
    })
    expect(window.api.signIn).not.toHaveBeenCalled()
    expect(screen.queryByTestId('OAuthPasteBackFlow')).toBeNull()
    expect(screen.getByTestId('AuthBanner').querySelector('input')).toBeNull()
    expect(screen.getByTestId('AuthBanner').textContent).not.toContain('http')
  })

  it('reports a running flow and offers Cancel, still with no flow UI', async () => {
    act(() =>
      useSessionStore.getState().setAuthState({
        status: 'authorizing',
        account: null,
        error: null,
        manualUrl: 'https://claude.ai/oauth/authorize?state=abc'
      })
    )
    render(<AuthBanner />)
    expect(screen.getByTestId('AuthBanner')).toHaveTextContent('Signing in')
    expect(screen.getByTestId('AuthBanner.cancel')).toBeTruthy()
    expect(screen.queryByTestId('OAuthPasteBackFlow')).toBeNull()
    expect(screen.getByTestId('AuthBanner').textContent).not.toContain('claude.ai')
  })
})

describe('AuthErrorBlock — the transcript row', () => {
  it('Sign in opens the dialog carrying the last user prompt as retry', async () => {
    seedSession()
    const message: ChatMessage = {
      id: 'err-1',
      role: 'system',
      content: [{ type: 'api_error', errorType: 'authentication', errorMessage: 'API Error: 401' }],
      timestamp: 0
    } as ChatMessage
    render(<MessageBubble message={message} pendingApprovals={[]} isLastAssistant={false} />)
    expect(screen.getByTestId('AuthErrorBlock')).toHaveTextContent(
      'Turn stopped: Claude rejected the credential'
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('AuthErrorBlock.signIn'))
    })
    expect(useSessionStore.getState().signInDialog).toEqual({
      providerId: 'anthropic',
      mode: 'reauth',
      retry: { routingId: ROUTING_ID, prompt: 'do the thing' }
    })
    // The inline flow states are gone — no waiting card, no code box.
    expect(screen.queryByPlaceholderText('authorization code')).toBeNull()
  })
})

describe('AuthRequiredRow — the engine-neutral row', () => {
  it('opens the dialog for a provider ClaudeUI drives, with retry and account', async () => {
    seedSession()
    patch({ authRequired: { providerId: 'chatgpt', accountId: 'v2' } })
    render(<AuthRequiredRow />)
    expect(screen.getByTestId('AuthRequiredRow')).toHaveAttribute('data-id', 'chatgpt')
    await act(async () => {
      fireEvent.click(screen.getByTestId('AuthRequiredRow.signIn'))
    })
    expect(useSessionStore.getState().signInDialog).toEqual({
      providerId: 'chatgpt',
      mode: 'reauth',
      accountId: 'v2',
      retry: { routingId: ROUTING_ID, prompt: 'do the thing' }
    })
  })

  it('an opencode vendor has no flow, so it opens the provider settings instead', async () => {
    seedSession()
    patch({ authRequired: { providerId: 'opencode:openrouter' } })
    const deepLink = vi.fn()
    window.addEventListener('open-settings', deepLink)
    render(<AuthRequiredRow />)
    expect(screen.queryByTestId('AuthRequiredRow.signIn')).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByTestId('AuthRequiredRow.settings'))
    })
    window.removeEventListener('open-settings', deepLink)
    expect(deepLink).toHaveBeenCalledTimes(1)
    expect((deepLink.mock.calls[0][0] as CustomEvent).detail).toEqual({
      page: 'models',
      group: 'providers'
    })
    expect(useSessionStore.getState().signInDialog).toBeNull()
  })

  it('renders nothing without an owed sign-in, and never the deleted card', async () => {
    seedSession()
    render(<AuthRequiredRow />)
    expect(screen.queryByTestId('AuthRequiredRow')).toBeNull()
    expect(screen.queryByTestId('VendorAuthRequiredCard')).toBeNull()
  })

  it('Dismiss clears the owed sign-in for this client', async () => {
    seedSession()
    patch({ authRequired: { providerId: 'anthropic' } })
    render(<AuthRequiredRow />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('AuthRequiredRow.dismiss'))
    })
    expect(useSessionStore.getState().sessions[ROUTING_ID].authRequired).toBeNull()
  })
})
