/**
 * The transcript's engine-neutral auth row and its three lifetimes (ADR-070 §4).
 *
 * The row is selected in `MessageBubble` off `api_error` /
 * `errorType: 'authentication'`, so every test here renders a real
 * `MessageBubble` — the selection point is part of what is being pinned.
 *
 * The load-bearing test is `settled renders no action at all`. The block is
 * transcript DATA: it comes back on every reload, forever. The old
 * `AuthErrorBlock` rendered Sign in and Dismiss unconditionally, so a reloaded
 * session kept offering a live sign-in for a credential fixed days ago, and
 * "Dismiss" — component-local state — could not survive the reload it needed to.
 * That is the bug ADR-070 §4 names, and the guard below fails against the
 * pre-rewrite component.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useSessionStore } from '../../../stores/session-store'
import { MessageBubble } from '../MessageBubble'
import type { ChatMessage } from '../../../../../shared/types'

vi.mock('electron', async () => await import('../../../../../test/stubs/electron-shim'))

const ROUTING_ID = 'r-auth-row'

function installApi(over: Record<string, unknown> = {}): void {
  ;(globalThis as unknown as { window: Record<string, unknown> }).window.api = {
    platform: 'web',
    saveSessionConfig: vi.fn(),
    createSession: vi.fn(async () => ({ ok: true })),
    sendPrompt: vi.fn(async () => {}),
    ...over
  }
}

/** Tests are exempt from the sealed-field lint rule; this is the fixture seam. */
function patch(fields: Record<string, unknown>): void {
  useSessionStore.setState((s) => ({
    sessions: { ...s.sessions, [ROUTING_ID]: { ...s.sessions[ROUTING_ID], ...fields } }
  }))
}

function seedSession(): void {
  useSessionStore.setState({ activeSessionId: null, sessions: {}, signInDialog: null })
  useSessionStore.getState().createNewSession(ROUTING_ID, '/tmp/proj')
  useSessionStore.setState({ activeSessionId: ROUTING_ID, providerAccounts: null })
}

/** The transcript block every engine now emits for a rejected credential. */
function authBlockMessage(errorMessage = 'API Error: 401 invalid authentication'): ChatMessage {
  return {
    id: 'err-1',
    role: 'system',
    content: [{ type: 'api_error', errorType: 'authentication', errorMessage }],
    timestamp: 0
  } as ChatMessage
}

function renderRow(errorMessage?: string): ReturnType<typeof render> {
  return render(
    <MessageBubble
      message={authBlockMessage(errorMessage)}
      pendingApprovals={[]}
      isLastAssistant={false}
    />
  )
}

beforeEach(() => {
  installApi()
  seedSession()
})
afterEach(cleanup)

describe('AuthTranscriptRow — settled (history)', () => {
  /**
   * THE guard. A row with no owed sign-in is a fact in the past, so the ONLY
   * interactive thing left on it is the in-place disclosure — which is not an
   * action, it reveals text that is already there. Asserted over every
   * interactive node in the render rather than by testid, so it cannot be
   * satisfied by renaming an action: the pre-rewrite `AuthErrorBlock` rendered
   * Sign in and Dismiss here unconditionally and fails this.
   */
  it('renders no action at all — the disclosure is the only thing clickable', () => {
    const { container } = renderRow()
    const clickable = [...container.querySelectorAll('button, a, [role="button"]')]
    expect(clickable.map((node) => node.getAttribute('data-testid'))).toEqual([
      'AuthTranscriptRow.disclose'
    ])
    expect(screen.queryByText('Sign in')).toBeNull()
    expect(screen.queryByText('Dismiss')).toBeNull()
    expect(screen.queryByText('Retry this prompt')).toBeNull()
  })

  it('still states the fact, and marks itself settled', () => {
    renderRow()
    const row = screen.getByTestId('AuthTranscriptRow')
    expect(row).toHaveAttribute('data-lifetime', 'settled')
    expect(row).toHaveTextContent('Turn stopped')
  })

  it('opens no dialog, because there is nothing there to open one', () => {
    renderRow()
    expect(useSessionStore.getState().signInDialog).toBeNull()
  })
})

describe('AuthTranscriptRow — broken', () => {
  beforeEach(() => {
    patch({
      authRequired: {
        providerId: 'chatgpt',
        accountId: 'acct-1',
        message: 'ChatGPT rejected the credential Codex runs under.',
        retryPrompt: 'refactor the dispatcher'
      }
    })
  })

  it('names the provider and marks itself broken', () => {
    renderRow()
    const row = screen.getByTestId('AuthTranscriptRow')
    expect(row).toHaveAttribute('data-lifetime', 'broken')
    expect(row).toHaveAttribute('data-id', 'chatgpt')
    expect(row).toHaveTextContent('Turn stopped — ChatGPT rejected the credential.')
  })

  it('has exactly two hit areas and no whole-row target', () => {
    const { container } = renderRow()
    const clickable = [...container.querySelectorAll('button, a, [role="button"]')]
    expect(clickable.map((node) => node.getAttribute('data-testid'))).toEqual([
      'AuthTranscriptRow.signIn',
      'AuthTranscriptRow.disclose'
    ])

    // The row itself is inert: clicking the sentence must not open anything.
    fireEvent.click(screen.getByText('Turn stopped — ChatGPT rejected the credential.'))
    expect(useSessionStore.getState().signInDialog).toBeNull()
  })

  it('Sign in opens the dialog with the account and the reducer-captured retry', async () => {
    renderRow()
    await act(async () => {
      fireEvent.click(screen.getByTestId('AuthTranscriptRow.signIn'))
    })
    expect(useSessionStore.getState().signInDialog).toEqual({
      providerId: 'chatgpt',
      mode: 'reauth',
      accountId: 'acct-1',
      retry: { routingId: ROUTING_ID, prompt: 'refactor the dispatcher' }
    })
  })

  it("the disclosure shows the engine's own words verbatim, in place", () => {
    renderRow()
    expect(screen.queryByTestId('AuthTranscriptRow.message')).toBeNull()
    fireEvent.click(screen.getByTestId('AuthTranscriptRow.disclose'))
    expect(screen.getByTestId('AuthTranscriptRow.message')).toHaveTextContent(
      'ChatGPT rejected the credential Codex runs under.'
    )
    // No navigation, no dialog — pure in-place disclosure.
    expect(useSessionStore.getState().signInDialog).toBeNull()
  })

  it("falls back to the block's own text when the event carried no message", () => {
    patch({ authRequired: { providerId: 'anthropic' } })
    renderRow('API Error: 401 invalid authentication')
    fireEvent.click(screen.getByTestId('AuthTranscriptRow.disclose'))
    expect(screen.getByTestId('AuthTranscriptRow.message')).toHaveTextContent(
      'API Error: 401 invalid authentication'
    )
  })

  it('offers provider settings, never a dialog, for an engine-native credential', async () => {
    patch({ authRequired: { providerId: 'pi:anthropic' } })
    const deepLink = vi.fn()
    window.addEventListener('open-settings', deepLink)
    renderRow()
    expect(screen.queryByTestId('AuthTranscriptRow.signIn')).toBeNull()
    // The namespace is stripped — the row must not say "pi:anthropic".
    expect(screen.getByTestId('AuthTranscriptRow').textContent).not.toContain('pi:anthropic')
    await act(async () => {
      fireEvent.click(screen.getByTestId('AuthTranscriptRow.settings'))
    })
    window.removeEventListener('open-settings', deepLink)
    expect((deepLink.mock.calls[0][0] as CustomEvent).detail).toEqual({
      page: 'models',
      group: 'providers'
    })
    expect(useSessionStore.getState().signInDialog).toBeNull()
  })
})

describe('AuthTranscriptRow — resolved, retry owed', () => {
  beforeEach(() => {
    patch({
      authRequired: {
        providerId: 'chatgpt',
        accountId: 'acct-1',
        message: 'ChatGPT rejected the credential Codex runs under.',
        retryPrompt: 'refactor the dispatcher',
        resolved: true
      }
    })
  })

  it('rewrites itself in place: no Sign in, a Retry instead', () => {
    renderRow()
    expect(screen.getByTestId('AuthTranscriptRow')).toHaveAttribute('data-lifetime', 'resolved')
    expect(screen.queryByTestId('AuthTranscriptRow.signIn')).toBeNull()
    expect(screen.getByTestId('AuthTranscriptRow.signedIn')).toHaveTextContent('signed in')
    expect(screen.getByTestId('AuthTranscriptRow.retry')).toHaveTextContent('Retry this prompt')
  })

  it('names the account when the vault list knows it', () => {
    useSessionStore.setState({
      providerAccounts: {
        activeId: 'acct-1',
        perSession: false,
        accounts: [{ id: 'acct-1', email: 'user@example.com', expiresAt: 0, needsReauth: false }]
      }
    })
    renderRow()
    expect(screen.getByTestId('AuthTranscriptRow.signedIn')).toHaveTextContent(
      '✓ signed in as user@example.com'
    )
  })

  it('Retry re-sends the captured prompt and settles the row', async () => {
    const retrySend = vi.fn(async () => {})
    useSessionStore.setState({ retrySend })
    renderRow()
    await act(async () => {
      fireEvent.click(screen.getByTestId('AuthTranscriptRow.retry'))
    })
    expect(retrySend).toHaveBeenCalledWith(ROUTING_ID, 'refactor the dispatcher')
    expect(useSessionStore.getState().sessions[ROUTING_ID].authRequired).toBeNull()
  })

  it('keeps the disclosure, so the words survive the fix', () => {
    renderRow()
    fireEvent.click(screen.getByTestId('AuthTranscriptRow.disclose'))
    expect(screen.getByTestId('AuthTranscriptRow.message')).toHaveTextContent(
      'ChatGPT rejected the credential Codex runs under.'
    )
  })
})
