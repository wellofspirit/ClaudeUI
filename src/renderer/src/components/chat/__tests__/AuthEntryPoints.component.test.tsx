/**
 * The chat's auth entry points after ADR-070 §4 — and, just as importantly, the
 * ones that must never come back.
 *
 * ADR-068 §3 left SIX surfaces able to report one rejected credential, and a
 * single Codex token-refresh failure lit four of them at once. Two remain in the
 * chat, and neither carries a flow:
 *
 *  · `AuthPill`           — app-wide, in the top bar's left group. One indicator
 *                           for every provider and every session;
 *  · `AuthTranscriptRow`  — engine-neutral, anchored where the turn died, with
 *                           three lifetimes and no action once settled.
 *
 * Both open the SAME `openSignIn()` request for the same failure, which is what
 * stops the pill and the row from drifting — pinned here by comparing the two
 * requests rather than by asserting each one separately.
 *
 * The deleted surfaces are pinned by TESTID ABSENCE, the way ADR-068 §3 pinned
 * `VendorAuthRequiredCard`, so they cannot return through another component:
 * `AuthBanner` (the boot-time yellow line), `AuthRequiredRow` (the floating
 * card), `InputBox.signInHint` (the composer hint) and `AuthErrorBlock` (the
 * pre-rewrite transcript row, with its stale Sign in and its component-local
 * Dismiss).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useSessionStore } from '../../../stores/session-store'
import { AuthPill } from '../AuthPill'
import { MessageBubble } from '../MessageBubble'
import { SidebarContext } from '../../SessionView'
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
    createSession: vi.fn(async () => ({ ok: true })),
    ...over
  }
  ;(globalThis as unknown as { window: Record<string, unknown> }).window.open = vi.fn()
}

/** A session with one user prompt, so the reducer's retry capture has a subject. */
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

/** The auth fact, as the reducer writes it for a ChatGPT rejection. */
const CHATGPT_REJECTED = {
  providerId: 'chatgpt',
  accountId: 'v2',
  message: 'ChatGPT rejected the credential Codex runs under.',
  retryPrompt: 'do the thing'
}

function renderPill(): ReturnType<typeof render> {
  return render(
    <SidebarContext.Provider value={{ collapsed: false, toggle: () => {}, isMobile: false }}>
      <AuthPill />
    </SidebarContext.Provider>
  )
}

function renderRow(): ReturnType<typeof render> {
  const message: ChatMessage = {
    id: 'err-1',
    role: 'system',
    content: [{ type: 'api_error', errorType: 'authentication', errorMessage: 'API Error: 401' }],
    timestamp: 0
  } as ChatMessage
  return render(<MessageBubble message={message} pendingApprovals={[]} isLastAssistant={false} />)
}

/** Both surviving surfaces at once, for the host-parity case below. */
function renderBoth(): ReturnType<typeof render> {
  const message: ChatMessage = {
    id: 'err-1',
    role: 'system',
    content: [{ type: 'api_error', errorType: 'authentication', errorMessage: 'API Error: 401' }],
    timestamp: 0
  } as ChatMessage
  return render(
    <SidebarContext.Provider value={{ collapsed: false, toggle: () => {}, isMobile: false }}>
      <AuthPill />
      <MessageBubble message={message} pendingApprovals={[]} isLastAssistant={false} />
    </SidebarContext.Provider>
  )
}

/** Anthropic's remote paste-back carrier (ADR-014 `manualUrl`). */
const MANUAL_URL = 'https://claude.ai/oauth/authorize?state=abc'
/** The vault's remote paste-back carrier (ADR-057 `vendorOAuth.url`). */
const VENDOR_URL = 'https://auth.openai.com/authorize?code_challenge=xyz'

beforeEach(() => {
  installApi()
  useSessionStore.setState({
    signInDialog: null,
    authState: null,
    vendorOAuth: null,
    providerAuth: { anthropic: 'unknown', chatgpt: 'unknown', chatgptRoutes: {} },
    vendorAuth: { anthropic: { authState: 'unauthenticated', billingType: 'unknown' } }
  })
})
afterEach(cleanup)

describe('the two surviving entry points agree', () => {
  it('the pill and the row produce the identical openSignIn request', async () => {
    seedSession()
    patch({ authRequired: CHATGPT_REJECTED })

    const pill = renderPill()
    await act(async () => {
      fireEvent.click(screen.getByTestId('AuthPill'))
    })
    const fromPill = useSessionStore.getState().signInDialog
    pill.unmount()
    useSessionStore.setState({ signInDialog: null })

    renderRow()
    await act(async () => {
      fireEvent.click(screen.getByTestId('AuthTranscriptRow.signIn'))
    })
    const fromRow = useSessionStore.getState().signInDialog

    expect(fromPill).toEqual({
      providerId: 'chatgpt',
      mode: 'reauth',
      accountId: 'v2',
      retry: { routingId: ROUTING_ID, prompt: 'do the thing' }
    })
    expect(fromRow).toEqual(fromPill)
  })

  it('both route an engine-native credential to Settings, and neither opens a dialog', async () => {
    seedSession()
    patch({ authRequired: { providerId: 'opencode:openrouter' } })
    const deepLink = vi.fn()
    window.addEventListener('open-settings', deepLink)

    const pill = renderPill()
    await act(async () => {
      fireEvent.click(screen.getByTestId('AuthPill'))
    })
    pill.unmount()

    renderRow()
    await act(async () => {
      fireEvent.click(screen.getByTestId('AuthTranscriptRow.settings'))
    })
    window.removeEventListener('open-settings', deepLink)

    expect(deepLink).toHaveBeenCalledTimes(2)
    for (const call of deepLink.mock.calls)
      expect((call[0] as CustomEvent).detail).toEqual({ page: 'models', group: 'providers' })
    expect(useSessionStore.getState().signInDialog).toBeNull()
  })
})

describe('the deleted surfaces stay deleted', () => {
  it('nothing renders AuthBanner, AuthRequiredRow, the composer hint or AuthErrorBlock', () => {
    seedSession()
    patch({ authRequired: CHATGPT_REJECTED })
    // A boot-time state the old banner fired on: the probe says signed-out.
    useSessionStore.setState({
      providerAuth: { anthropic: 'unauthenticated', chatgpt: 'unknown', chatgptRoutes: {} }
    })
    renderPill()
    renderRow()

    for (const testId of [
      'AuthBanner',
      'AuthBanner.login',
      'AuthBanner.dismiss',
      'AuthRequiredRow',
      'AuthRequiredRow.card',
      'AuthRequiredRow.signIn',
      'AuthRequiredRow.dismiss',
      'InputBox.signInHint',
      'InputBox.signInHint.action',
      'AuthErrorBlock',
      'AuthErrorBlock.signIn',
      'AuthErrorBlock.dismiss',
      'VendorAuthRequiredCard'
    ])
      expect(screen.queryByTestId(testId)).toBeNull()

    // And the one pill that replaced them is there, once.
    expect(screen.getAllByTestId('AuthPill')).toHaveLength(1)
  })

  it('no surviving surface can be dismissed — nothing hides a real blocker', () => {
    seedSession()
    patch({ authRequired: CHATGPT_REJECTED })
    renderPill()
    renderRow()
    // `AuthBanner`'s "Later" and `AuthErrorBlock`'s "Dismiss" both let a live
    // blocker be hidden, and the transcript row's dismiss could not survive the
    // reload it needed to (ADR-070 §4). Neither exists now.
    expect(screen.queryByText('Later')).toBeNull()
    expect(screen.queryByText('Dismiss')).toBeNull()
  })
})

describe('host parity — no surface grows a second home for the flow', () => {
  /**
   * INHERITED HAZARD. This case replaces
   * `chat/__tests__/AuthBanner.remote.component.test.tsx`, deleted with
   * `AuthBanner` in this slice. That file's own header explains why it outlived
   * the web-vs-desktop branch it was originally written for: *"the hazard it was
   * written for — a sign-in growing a second home — is exactly what a future
   * edit to this component would look like."*
   *
   * The hazard did not go away, it TRANSFERRED: `AuthPill` and
   * `AuthTranscriptRow` are the two chat surfaces a paste field or a manual URL
   * would now grow on, and on web there is a real reason to reach for one
   * (ADR-057's paste-back is the remote default). So both are rendered on both
   * hosts, with both URL carriers a flow would have to read populated —
   * Anthropic's `authState.manualUrl` and the vault's `vendorOAuth.url`, the
   * latter parked at the `paste` stage that only ever exists remotely.
   *
   * Two properties: the two hosts render the SAME markup, and neither host
   * mounts flow UI or leaks an authorize URL. The flows themselves live in
   * `SignInDialog`, per host, per provider, and
   * `auth/__tests__/SignInDialog.component.test.tsx` pins them there.
   */
  it('renders identically on desktop and web, and neither host mounts flow UI', () => {
    const markup: Record<string, string> = {}

    for (const platform of ['darwin', 'web'] as const) {
      installApi({ platform })
      seedSession()
      patch({ authRequired: CHATGPT_REJECTED })
      useSessionStore.setState({
        authState: { status: 'authorizing', account: null, error: null, manualUrl: MANUAL_URL },
        vendorOAuth: {
          engineId: 'codex',
          vendorId: 'openai',
          stage: 'paste',
          instructions: 'That page fails to load — expected. Copy its address.',
          url: VENDOR_URL,
          method: 0
        }
      })

      const { container } = renderBoth()
      // Both surfaces are actually up, so the assertions below are about their
      // content rather than about an empty tree.
      expect(screen.getByTestId('AuthPill')).toBeTruthy()
      expect(screen.getByTestId('AuthTranscriptRow')).toBeTruthy()

      // No field to type a code or a pasted address into.
      expect(container.querySelector('input')).toBeNull()
      expect(container.querySelector('textarea')).toBeNull()
      expect(screen.queryByTestId('OAuthPasteBackFlow')).toBeNull()
      expect(screen.queryByTestId('OAuthOutcomeNotice')).toBeNull()
      // And no authorize URL, in text or in an attribute (a `title` or an href
      // would leak it just as effectively as a visible link).
      expect(container.textContent ?? '').not.toContain('http')
      expect(container.innerHTML).not.toContain(MANUAL_URL)
      expect(container.innerHTML).not.toContain(VENDOR_URL)
      expect(container.innerHTML).not.toContain('claude.ai')

      markup[platform] = container.innerHTML
      cleanup()
    }

    expect(markup.web).toBe(markup.darwin)
  })
})
