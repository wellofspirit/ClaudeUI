/**
 * The app's one auth indicator (ADR-070 §4).
 *
 * Two properties carry the ADR and get their own tests: it is APP-WIDE (a
 * credential that dies in a background session must be reported — every surface
 * it replaces read only the active session), and it is SILENT until something is
 * actually known to be wrong (an unprobed host is not a signed-out one, which is
 * what put a banner on every cold boot).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useSessionStore } from '../../../stores/session-store'
import { SidebarContext } from '../../SessionView'
import { AuthPill } from '../AuthPill'
import { AUTH_ISSUE_NAME, authIssueLabel } from '../../../stores/auth-issues'
import type { AuthRequiredState } from '../../../../../shared/remote-protocol'

vi.mock('electron', async () => await import('../../../../../test/stubs/electron-shim'))

const ACTIVE = 'r-pill-active'
const BACKGROUND = 'r-pill-background'

function installApi(over: Record<string, unknown> = {}): void {
  ;(globalThis as unknown as { window: Record<string, unknown> }).window.api = {
    platform: 'web',
    saveSessionConfig: vi.fn(),
    createSession: vi.fn(async () => ({ ok: true })),
    ...over
  }
}

/** Tests are exempt from the sealed-field lint rule; this is the fixture seam. */
function blame(routingId: string, authRequired: AuthRequiredState | null): void {
  useSessionStore.setState((s) => ({
    sessions: { ...s.sessions, [routingId]: { ...s.sessions[routingId], authRequired } }
  }))
}

function seedSessions(): void {
  useSessionStore.setState({
    activeSessionId: null,
    sessions: {},
    signInDialog: null,
    authState: null,
    vendorOAuth: null,
    providerAuth: { anthropic: 'unknown', chatgpt: 'unknown', chatgptRoutes: {} }
  })
  useSessionStore.getState().createNewSession(ACTIVE, '/tmp/a')
  useSessionStore.getState().createNewSession(BACKGROUND, '/tmp/b')
  useSessionStore.setState({ activeSessionId: ACTIVE })
}

function renderPill(isMobile = false): ReturnType<typeof render> {
  return render(
    <SidebarContext.Provider value={{ collapsed: false, toggle: () => {}, isMobile }}>
      <AuthPill />
    </SidebarContext.Provider>
  )
}

beforeEach(() => {
  installApi()
  seedSessions()
})
afterEach(cleanup)

describe('AuthPill — silence is a state', () => {
  it("renders nothing while providerAuth is 'unknown' — no pill on a cold boot", () => {
    const { container } = renderPill()
    expect(container.firstChild).toBeNull()
    expect(screen.queryByTestId('AuthPill')).toBeNull()
  })

  it('renders nothing when every provider is authenticated', () => {
    useSessionStore.setState({
      providerAuth: { anthropic: 'authenticated', chatgpt: 'authenticated', chatgptRoutes: {} }
    })
    expect(renderPill().container.firstChild).toBeNull()
  })
})

describe('AuthPill — tones and labels', () => {
  it('amber `needed` for a provider with no usable credential', () => {
    useSessionStore.setState({
      providerAuth: { anthropic: 'unauthenticated', chatgpt: 'unknown', chatgptRoutes: {} }
    })
    renderPill()
    const pill = screen.getByTestId('AuthPill')
    expect(pill).toHaveAttribute('data-tone', 'needed')
    expect(pill).toHaveTextContent('Sign-in needed')
    expect(pill).not.toHaveAttribute('data-count')
  })

  /**
   * The pill's label and the pill's own hover must be the same words about the
   * same state — and so must the dialog's list row, which said "not signed in"
   * for the state this pill calls "Sign-in needed"
   * (`SignInDialog.component.test.tsx` pins that end). Read off
   * `AUTH_ISSUE_NAME` rather than typed out again here, so a reworded state
   * cannot leave one surface behind.
   */
  it('the label and the hover name the state identically (ADR-070 §4)', () => {
    useSessionStore.setState({
      providerAuth: { anthropic: 'unauthenticated', chatgpt: 'unknown', chatgptRoutes: {} }
    })
    renderPill()
    const pill = screen.getByTestId('AuthPill')
    expect(pill).toHaveTextContent(authIssueLabel('needed'))
    expect(pill.getAttribute('title') ?? '').toContain(`Claude — ${AUTH_ISSUE_NAME.needed}`)
  })

  it('red `expired` once a turn has actually died', () => {
    blame(ACTIVE, { providerId: 'chatgpt' })
    renderPill()
    const pill = screen.getByTestId('AuthPill')
    expect(pill).toHaveAttribute('data-tone', 'expired')
    expect(pill).toHaveTextContent('Sign-in expired')
  })

  it('counts providers, not sessions', () => {
    useSessionStore.setState({
      providerAuth: { anthropic: 'unauthenticated', chatgpt: 'unknown', chatgptRoutes: {} }
    })
    blame(ACTIVE, { providerId: 'chatgpt' })
    blame(BACKGROUND, { providerId: 'chatgpt' })
    renderPill()
    const pill = screen.getByTestId('AuthPill')
    expect(pill).toHaveAttribute('data-count', '2')
    expect(pill).toHaveTextContent('2 sign-ins needed')
  })

  it('accent `authorizing` while a flow is alive with the dialog closed', () => {
    useSessionStore.setState({
      providerAuth: { anthropic: 'unauthenticated', chatgpt: 'unknown', chatgptRoutes: {} },
      authState: { status: 'authorizing', account: null, error: null }
    })
    renderPill()
    const pill = screen.getByTestId('AuthPill')
    expect(pill).toHaveAttribute('data-tone', 'authorizing')
    expect(pill).toHaveTextContent('Signing in')
  })

  it('a failed vendor flow is not a running one', () => {
    useSessionStore.setState({
      vendorOAuth: { engineId: 'codex', vendorId: 'openai', stage: 'error', instructions: '' }
    })
    expect(renderPill().container.firstChild).toBeNull()
  })

  it('green `resolved` with the retry it owes', () => {
    blame(ACTIVE, { providerId: 'chatgpt', resolved: true, retryPrompt: 'refactor it' })
    renderPill()
    const pill = screen.getByTestId('AuthPill')
    expect(pill).toHaveAttribute('data-tone', 'resolved')
    expect(pill).toHaveTextContent('Signed in · Retry')
  })
})

describe('AuthPill — app-wide, not per-session', () => {
  it('reports a credential that died in a BACKGROUND session', () => {
    blame(BACKGROUND, { providerId: 'chatgpt', message: 'ChatGPT rejected the credential.' })
    renderPill()
    const pill = screen.getByTestId('AuthPill')
    expect(pill).toHaveAttribute('data-tone', 'expired')
    expect(pill.getAttribute('title')).toContain('1 prompt stopped')
  })

  it('names the provider, what it blocks and how many prompts stopped', () => {
    useSessionStore.setState({
      providerAuth: { anthropic: 'unknown', chatgpt: 'unknown', chatgptRoutes: { pi: true } }
    })
    blame(ACTIVE, { providerId: 'chatgpt' })
    blame(BACKGROUND, { providerId: 'chatgpt' })
    renderPill()
    const title = screen.getByTestId('AuthPill').getAttribute('title') ?? ''
    expect(title).toContain('ChatGPT — sign-in expired')
    expect(title).toContain('Blocks Codex, pi')
    expect(title).toContain('2 prompts stopped')
    expect(title).toContain('Click to sign in')
  })
})

describe('AuthPill — what a click does', () => {
  it('one drivable issue opens the dialog with its account and retry', async () => {
    blame(ACTIVE, { providerId: 'chatgpt', accountId: 'acct-1', retryPrompt: 'refactor it' })
    renderPill()
    await act(async () => {
      fireEvent.click(screen.getByTestId('AuthPill'))
    })
    expect(useSessionStore.getState().signInDialog).toEqual({
      providerId: 'chatgpt',
      mode: 'reauth',
      accountId: 'acct-1',
      retry: { routingId: ACTIVE, prompt: 'refactor it' }
    })
  })

  it('a non-drivable provider opens provider settings, never a dialog', async () => {
    blame(ACTIVE, { providerId: 'opencode:openrouter' })
    const deepLink = vi.fn()
    window.addEventListener('open-settings', deepLink)
    renderPill()
    await act(async () => {
      fireEvent.click(screen.getByTestId('AuthPill'))
    })
    window.removeEventListener('open-settings', deepLink)
    expect(deepLink).toHaveBeenCalledTimes(1)
    expect((deepLink.mock.calls[0][0] as CustomEvent).detail).toEqual({
      page: 'models',
      group: 'providers'
    })
    expect(useSessionStore.getState().signInDialog).toBeNull()
  })

  it('several issues open the dialog in provider-LIST mode — the pill has no single flow', async () => {
    blame(ACTIVE, { providerId: 'opencode:openrouter' })
    blame(BACKGROUND, { providerId: 'chatgpt' })
    renderPill()
    await act(async () => {
      fireEvent.click(screen.getByTestId('AuthPill'))
    })
    // No provider on the request: the dialog reads the same `useAuthSummary`
    // and renders a row per issue (ADR-070 §5).
    expect(useSessionStore.getState().signInDialog).toEqual({ kind: 'list' })
  })

  it('a running flow reopens its dialog rather than starting another', async () => {
    useSessionStore.setState({
      authState: { status: 'authorizing', account: null, error: null }
    })
    renderPill()
    await act(async () => {
      fireEvent.click(screen.getByTestId('AuthPill'))
    })
    expect(useSessionStore.getState().signInDialog).toEqual({
      providerId: 'anthropic',
      mode: 'reauth'
    })
  })

  it('the resolved pill re-sends the stopped prompt and settles the session', async () => {
    const retrySend = vi.fn(async () => {})
    useSessionStore.setState({ retrySend })
    blame(BACKGROUND, { providerId: 'chatgpt', resolved: true, retryPrompt: 'refactor it' })
    renderPill()
    await act(async () => {
      fireEvent.click(screen.getByTestId('AuthPill'))
    })
    expect(retrySend).toHaveBeenCalledWith(BACKGROUND, 'refactor it')
    expect(useSessionStore.getState().sessions[BACKGROUND].authRequired).toBeNull()
  })

  /**
   * The pill is app-wide, so the retry it owes routinely belongs to a session
   * the user is not looking at — and `retrySend` RESPAWNS that session. One
   * click therefore restarted a backend somewhere off-screen with nothing on
   * screen to show for it. Switching first makes the click's effect the thing
   * the user is now looking at.
   */
  it('shows the user what the click did: the owed session becomes the active one', async () => {
    const retrySend = vi.fn(async () => {})
    useSessionStore.setState({ retrySend })
    blame(BACKGROUND, { providerId: 'chatgpt', resolved: true, retryPrompt: 'refactor it' })
    renderPill()
    expect(useSessionStore.getState().activeSessionId).toBe(ACTIVE)

    await act(async () => {
      fireEvent.click(screen.getByTestId('AuthPill'))
    })
    expect(useSessionStore.getState().activeSessionId).toBe(BACKGROUND)
    expect(retrySend).toHaveBeenCalledWith(BACKGROUND, 'refactor it')
  })
})

describe('AuthPill — the resolved pill is transient, unless it owes a retry', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('retires itself when nothing is owed', () => {
    blame(ACTIVE, { providerId: 'chatgpt', resolved: true })
    const { unmount } = renderPill()
    expect(screen.getByTestId('AuthPill')).toHaveAttribute('data-tone', 'resolved')
    act(() => void vi.advanceTimersByTime(15_000))
    expect(screen.queryByTestId('AuthPill')).toBeNull()
    unmount()
  })

  it('persists while a retry is owed — it is waiting for the user', () => {
    blame(ACTIVE, { providerId: 'chatgpt', resolved: true, retryPrompt: 'refactor it' })
    const { unmount } = renderPill()
    act(() => void vi.advanceTimersByTime(60_000))
    expect(screen.getByTestId('AuthPill')).toHaveTextContent('Signed in · Retry')
    unmount()
  })
})

describe('AuthPill — mobile', () => {
  it('collapses to a bare dot with the count, no label', () => {
    blame(ACTIVE, { providerId: 'chatgpt' })
    renderPill(true)
    const pill = screen.getByTestId('AuthPill')
    expect(pill).toHaveAttribute('data-tone', 'expired')
    expect(pill.textContent).toBe('1')
    expect(pill.textContent).not.toContain('Sign-in')
  })
})
