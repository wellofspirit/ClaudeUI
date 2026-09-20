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
import { MessageBubble, TranscriptSessionProvider } from '../MessageBubble'
import type { ChatMessage } from '../../../../../shared/types'

vi.mock('electron', async () => await import('../../../../../test/stubs/electron-shim'))

const ROUTING_ID = 'r-auth-row'
/** A second, unrelated chat session — the one the ACTIVE pointer is parked on. */
const OTHER_ID = 'r-auth-row-other'

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
function authBlockMessage(
  errorMessage = 'API Error: 401 invalid authentication',
  providerId?: string
): ChatMessage {
  return {
    id: 'err-1',
    role: 'system',
    content: [
      {
        type: 'api_error',
        errorType: 'authentication',
        errorMessage,
        ...(providerId ? { providerId } : {})
      }
    ],
    timestamp: 0
  } as ChatMessage
}

/** The chat message list's host: the row is in THIS session's transcript. */
function renderRow(errorMessage?: string, providerId?: string): ReturnType<typeof render> {
  return render(
    <TranscriptSessionProvider value={ROUTING_ID}>
      <MessageBubble
        message={authBlockMessage(errorMessage, providerId)}
        pendingApprovals={[]}
        isLastAssistant={false}
      />
    </TranscriptSessionProvider>
  )
}

/**
 * Any OTHER host — automation run history is the real one. No provider, so the
 * context's `null` default is what the row sees.
 */
function renderInHistory(errorMessage?: string, providerId?: string): ReturnType<typeof render> {
  return render(
    <MessageBubble
      message={authBlockMessage(errorMessage, providerId)}
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

  /**
   * Permanent history has to be self-describing. `authRequired` is null here —
   * that is what settled MEANS — so a row that learned the provider only from
   * the session said "Turn stopped — the credential was rejected." about a
   * Claude failure, forever, while the broken and resolved rows above it named
   * the provider. The name now rides on the block (ADR-070 §4).
   */
  it('names the provider from the BLOCK, with no session fact left to read', () => {
    renderRow('API Error: 401 invalid authentication', 'anthropic')
    const row = screen.getByTestId('AuthTranscriptRow')
    expect(row).toHaveAttribute('data-lifetime', 'settled')
    expect(row).toHaveAttribute('data-id', 'anthropic')
    expect(row).toHaveTextContent('Turn stopped — Claude rejected the credential.')
    // Still no action: naming the provider is not offering to fix it.
    const clickable = [...row.querySelectorAll('button, a, [role="button"]')]
    expect(clickable.map((node) => node.getAttribute('data-testid'))).toEqual([
      'AuthTranscriptRow.disclose'
    ])
  })

  it('keeps the generic sentence for a block that names nobody', () => {
    renderRow()
    expect(screen.getByTestId('AuthTranscriptRow')).toHaveTextContent(
      'Turn stopped — the credential was rejected.'
    )
    expect(screen.getByTestId('AuthTranscriptRow')).not.toHaveAttribute('data-id')
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
      'API Error: 401 invalid authentication'
    )
    // No navigation, no dialog — pure in-place disclosure.
    expect(useSessionStore.getState().signInDialog).toBeNull()
  })

  it("falls back to the event's message for a block that carried no text", () => {
    renderRow('')
    fireEvent.click(screen.getByTestId('AuthTranscriptRow.disclose'))
    expect(screen.getByTestId('AuthTranscriptRow.message')).toHaveTextContent(
      'ChatGPT rejected the credential Codex runs under.'
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
      'API Error: 401 invalid authentication'
    )
  })
})

/**
 * WHICH session's transcript the row is in, rather than which session is
 * active. `MessageBubble` also renders automation-run history, so a replayed
 * run's auth block was reading the unrelated chat session's lifetime and its
 * Retry re-sent the stopped prompt into `activeSessionId` — a session the user
 * was not even looking at.
 */
describe('AuthTranscriptRow — the row belongs to ITS transcript', () => {
  beforeEach(() => {
    useSessionStore.getState().createNewSession(OTHER_ID, '/tmp/other')
    // The active pointer is parked somewhere else entirely, and that session
    // has an auth failure of its own to be tempting.
    useSessionStore.setState({ activeSessionId: OTHER_ID })
    useSessionStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        [OTHER_ID]: {
          ...s.sessions[OTHER_ID],
          authRequired: { providerId: 'anthropic', retryPrompt: 'the other prompt' }
        }
      }
    }))
  })

  it("reads the hosting session's fact, not the active session's", () => {
    patch({
      authRequired: {
        providerId: 'chatgpt',
        accountId: 'acct-1',
        retryPrompt: 'refactor the dispatcher'
      }
    })
    renderRow()
    const row = screen.getByTestId('AuthTranscriptRow')
    expect(row).toHaveAttribute('data-lifetime', 'broken')
    expect(row).toHaveAttribute('data-id', 'chatgpt')
  })

  it('retries on ITS session, never on the active one', async () => {
    const retrySend = vi.fn(async () => {})
    useSessionStore.setState({ retrySend })
    patch({
      authRequired: {
        providerId: 'chatgpt',
        retryPrompt: 'refactor the dispatcher',
        resolved: true
      }
    })
    renderRow()
    await act(async () => {
      fireEvent.click(screen.getByTestId('AuthTranscriptRow.retry'))
    })
    expect(retrySend).toHaveBeenCalledWith(ROUTING_ID, 'refactor the dispatcher')
    expect(useSessionStore.getState().sessions[ROUTING_ID].authRequired).toBeNull()
    // Untouched: the row never had anything to do with this session.
    expect(useSessionStore.getState().sessions[OTHER_ID].authRequired).not.toBeNull()
  })

  it("names the hosting session's retry on the Sign in request", async () => {
    patch({
      authRequired: { providerId: 'chatgpt', retryPrompt: 'refactor the dispatcher' }
    })
    renderRow()
    await act(async () => {
      fireEvent.click(screen.getByTestId('AuthTranscriptRow.signIn'))
    })
    expect(useSessionStore.getState().signInDialog).toEqual({
      providerId: 'chatgpt',
      mode: 'reauth',
      retry: { routingId: ROUTING_ID, prompt: 'refactor the dispatcher' }
    })
  })

  /**
   * Automation-run history replays a transcript that belongs to no open chat
   * session, so there is no lifetime to read and nothing the row could
   * correctly act on. Settled is the honest answer — and it is also the safe
   * one, since the only alternative was acting on `activeSessionId`.
   */
  it('a host with no routing id renders settled with no action', () => {
    patch({
      authRequired: { providerId: 'chatgpt', retryPrompt: 'refactor the dispatcher' }
    })
    const { container } = renderInHistory('API Error: 401', 'chatgpt')
    const row = screen.getByTestId('AuthTranscriptRow')
    expect(row).toHaveAttribute('data-lifetime', 'settled')
    // Still self-describing — the provider rides on the block.
    expect(row).toHaveAttribute('data-id', 'chatgpt')
    expect(
      [...container.querySelectorAll('button, a, [role="button"]')].map((node) =>
        node.getAttribute('data-testid')
      )
    ).toEqual(['AuthTranscriptRow.disclose'])
  })
})

/**
 * The row named one provider and acted on another: the sentence came from the
 * BLOCK, the action from the session's current `authRequired`. A session that
 * failed on Anthropic and later on ChatGPT rendered its Anthropic row saying
 * "Claude rejected the credential" above a Sign in that opened ChatGPT.
 */
describe('AuthTranscriptRow — a row acts only for the provider it names', () => {
  beforeEach(() => {
    // Failed on anthropic first, then on chatgpt — the session's fact is the
    // LATEST failure, and this row records the earlier one.
    patch({
      authRequired: {
        providerId: 'chatgpt',
        accountId: 'acct-1',
        message: 'ChatGPT rejected the credential Codex runs under.',
        retryPrompt: 'refactor the dispatcher'
      }
    })
  })

  it('the anthropic row is inert, and still names Claude', () => {
    const { container } = renderRow('API Error: 401 invalid authentication', 'anthropic')
    const row = screen.getByTestId('AuthTranscriptRow')
    expect(row).toHaveAttribute('data-lifetime', 'settled')
    expect(row).toHaveTextContent('Turn stopped — Claude rejected the credential.')
    expect(
      [...container.querySelectorAll('button, a, [role="button"]')].map((node) =>
        node.getAttribute('data-testid')
      )
    ).toEqual(['AuthTranscriptRow.disclose'])
  })

  it("discloses its OWN text, not the other provider's message", () => {
    renderRow('API Error: 401 invalid authentication', 'anthropic')
    fireEvent.click(screen.getByTestId('AuthTranscriptRow.disclose'))
    const disclosed = screen.getByTestId('AuthTranscriptRow.message')
    expect(disclosed).toHaveTextContent('API Error: 401 invalid authentication')
    expect(disclosed.textContent).not.toContain('Codex runs under')
  })

  it('the matching row keeps the live lifetime and the action', () => {
    renderRow('API Error: 401', 'chatgpt')
    const row = screen.getByTestId('AuthTranscriptRow')
    expect(row).toHaveAttribute('data-lifetime', 'broken')
    expect(screen.getByTestId('AuthTranscriptRow.signIn')).toBeTruthy()
  })

  /**
   * The block's own text is per-block correct; the event's message describes
   * the session's CURRENT failure. So the block wins where it has one, and the
   * message is the fallback for a block that carried none.
   */
  it("the block's own words win the disclosure, the event's are the fallback", () => {
    renderRow('API Error: 401 the block said this', 'chatgpt')
    fireEvent.click(screen.getByTestId('AuthTranscriptRow.disclose'))
    expect(screen.getByTestId('AuthTranscriptRow.message')).toHaveTextContent(
      'API Error: 401 the block said this'
    )

    cleanup()
    renderRow('', 'chatgpt')
    fireEvent.click(screen.getByTestId('AuthTranscriptRow.disclose'))
    expect(screen.getByTestId('AuthTranscriptRow.message')).toHaveTextContent(
      'ChatGPT rejected the credential Codex runs under.'
    )
  })
})
