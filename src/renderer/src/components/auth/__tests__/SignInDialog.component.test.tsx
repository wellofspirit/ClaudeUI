/**
 * The ONE sign-in dialog (ADR-068 §3, mockup screen 5).
 *
 * What matters here is not the markup but WHICH DRIVER each stage calls: the
 * whole point of collapsing four surfaces into one is that the flows underneath
 * are the EXISTING ones, untouched. So every case asserts the exact store action
 * or `window.api` method, per provider and per host:
 *
 *  · Anthropic — `signIn()` / `addAccount()` / `submitOAuthCode` / `switchAccount`;
 *  · ChatGPT   — `vendor-auth:oauth-*` for pi's `openai-codex`, and
 *                `provider-account:switch`.
 *
 * The host variant is DERIVED (ADR-057): web gets the paste panel, desktop gets
 * "Waiting for the browser…". Both directions are pinned, because a dialog that
 * showed a paste field on the desktop would be asking for a code the host
 * already has.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useSessionStore, type SignInRequest } from '../../../stores/session-store'
import type { AuthRequiredState } from '../../../../../shared/remote-protocol'
import { UNKNOWN_PROVIDER_AUTH } from '../../../utils/sign-in-provider'
import { AUTH_ISSUE_NAME } from '../../../stores/auth-issues'
import { SignInDialog } from '../SignInDialog'

vi.mock('electron', async () => await import('../../../../../test/stubs/electron-shim'))

const CLAUDE_URL = 'https://claude.ai/oauth/authorize?state=abc'
const CHATGPT_URL = 'https://auth.openai.com/oauth/authorize?state=s'

const CLAUDE_ACCOUNTS = {
  enabled: true,
  activeId: 'a1',
  accounts: [
    {
      id: 'a1',
      email: 'one@example.com',
      subscriptionType: 'Claude Max',
      organization: null,
      createdAt: 0
    },
    {
      id: 'a2',
      email: 'two@example.com',
      subscriptionType: 'Claude Pro',
      organization: null,
      createdAt: 0
    }
  ]
}

const CHATGPT_ACCOUNTS = {
  activeId: 'v1',
  perSession: true,
  accounts: [
    { id: 'v1', email: 'one@example.com', planType: 'pro', expiresAt: 0, needsReauth: false },
    { id: 'v2', email: 'two@example.com', planType: 'plus', expiresAt: 0, needsReauth: false }
  ]
}

/** What `vendor-auth:device-code-start` answers (Slice 7) — display material only. */
const DEVICE_CODE = {
  verificationUrl: 'https://auth.openai.com/codex/device',
  userCode: 'ABCD-1234',
  expiresAt: 0
}

const CHATGPT_DEFINITION = {
  id: 'chatgpt',
  name: 'ChatGPT',
  kind: 'subscription',
  models: [],
  managed: true,
  routes: {
    pi: { enabled: true, providerId: 'openai-codex' },
    opencode: { enabled: false, providerId: 'openai' }
  }
}

function installApi(platform: string, over: Record<string, unknown> = {}): void {
  ;(globalThis as unknown as { window: Record<string, unknown> }).window.api = {
    platform,
    saveSessionConfig: vi.fn(),
    // Anthropic
    getAccounts: vi.fn(async () => CLAUDE_ACCOUNTS),
    addAccount: vi.fn(async () =>
      platform === 'web'
        ? {
            ...CLAUDE_ACCOUNTS,
            pendingSignIn: {
              status: 'authorizing',
              account: null,
              error: null,
              manualUrl: CLAUDE_URL
            }
          }
        : CLAUDE_ACCOUNTS
    ),
    switchAccount: vi.fn(async () => CLAUDE_ACCOUNTS),
    signIn: vi.fn(async () => ({
      status: 'authorizing',
      account: null,
      error: null,
      ...(platform === 'web' ? { manualUrl: CLAUDE_URL } : {})
    })),
    submitOAuthCode: vi.fn(async () => ({
      status: 'success',
      account: { email: 'one@example.com', subscriptionType: 'Claude Max' },
      error: null
    })),
    cancelSignIn: vi.fn(async () => {}),
    // ChatGPT
    listProviderAccounts: vi.fn(async () => CHATGPT_ACCOUNTS),
    switchProviderAccount: vi.fn(async () => {}),
    listSharedProviders: vi.fn(async () => [CHATGPT_DEFINITION]),
    vendorAuthListOptions: vi.fn(async () => ({
      'openai-codex': [{ type: 'oauth', label: 'Sign in with ChatGPT' }]
    })),
    vendorAuthOauthAuthorize: vi.fn(async () => ({
      url: CHATGPT_URL,
      method: 'auto',
      instructions: 'Finish in the browser.'
    })),
    vendorAuthOauthCallback: vi.fn(async () => true),
    vendorAuthOauthCancel: vi.fn(async () => {}),
    vendorAuthDeviceCodeStart: vi.fn(async () => DEVICE_CODE),
    vendorAuthDeviceCodeStatus: vi.fn(async () => ({ state: 'pending' })),
    listProviderRegistry: vi.fn(async () => ({ entries: [], opencodeInstalled: false })),
    // retrySend
    createSession: vi.fn(async () => {}),
    sendPrompt: vi.fn(async () => {}),
    ...over
  }
  ;(globalThis as unknown as { window: Record<string, unknown> }).window.open = vi.fn()
}

async function open(request: SignInRequest): Promise<void> {
  useSessionStore.setState({ signInDialog: null, authState: null, vendorOAuth: null })
  await act(async () => {
    render(<SignInDialog />)
  })
  await act(async () => {
    useSessionStore.getState().openSignIn(request)
  })
}

/**
 * Take the confirm screen's one primary (ADR-070 Ruling 1). Every path that
 * has nothing to choose between now stops here, so a test that wants the flow
 * has to ask for it — which is the whole point of the screen.
 */
async function confirmStart(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId('SignInDialog.confirmStart'))
  })
}

/** Re-authorize → paste → success, the shortest route to the done state on web. */
async function signInOnWeb(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId('SignInDialog.reauth'))
  })
  fireEvent.change(screen.getByTestId('OAuthPasteBackFlow.input'), { target: { value: 'x' } })
  await act(async () => {
    fireEvent.click(screen.getByTestId('OAuthPasteBackFlow.submit'))
  })
}

/**
 * Seal a session's `authRequired` the way the reducer would. Tests are exempt
 * from the sealed-field lint rule; this is the fixture seam.
 */
function blame(routingId: string, authRequired: AuthRequiredState | null): void {
  useSessionStore.setState((s) => ({
    sessions: { ...s.sessions, [routingId]: { ...s.sessions[routingId], authRequired } }
  }))
}

beforeEach(() => {
  // `providerAuth` and `sessions` are the live inputs the retry latch and the
  // provider-list mode read (ADR-070 §3/§5), so they are reset per case.
  useSessionStore.setState({
    signInDialog: null,
    authState: null,
    vendorOAuth: null,
    sessions: {},
    activeSessionId: null,
    providerAuth: UNKNOWN_PROVIDER_AUTH
  })
  ;(globalThis as unknown as { window: { innerWidth: number } }).window.innerWidth = 1280
})
afterEach(cleanup)

describe('SignInDialog — Anthropic', () => {
  it('chooses an account first, and Re-authorize drives the EXISTING signIn()', async () => {
    installApi('darwin')
    await open({ providerId: 'anthropic', mode: 'reauth' })

    expect(
      screen.getAllByTestId('SignInDialog.account').map((el) => el.getAttribute('data-id'))
    ).toEqual(['a1', 'a2'])

    await act(async () => {
      fireEvent.click(screen.getByTestId('SignInDialog.reauth'))
    })
    expect(window.api.signIn).toHaveBeenCalledTimes(1)
    // Desktop: a wait, never a paste field.
    expect(screen.getByTestId('SignInDialog.waiting')).toBeTruthy()
    expect(screen.queryByTestId('OAuthPasteBackFlow')).toBeNull()
  })

  it('switching a stored account calls switchAccount and closes', async () => {
    installApi('darwin')
    await open({ providerId: 'anthropic', mode: 'switch' })
    await act(async () => {
      fireEvent.click(screen.getByTestId('SignInDialog.switch'))
    })
    expect(window.api.switchAccount).toHaveBeenCalledWith('a2')
    expect(useSessionStore.getState().signInDialog).toBeNull()
  })

  it('add mode skips the chooser, confirms, and only then calls addAccount()', async () => {
    installApi('darwin')
    await open({ providerId: 'anthropic', mode: 'add' })
    // Ruling 1 applies to `add` too: the entry-point button said what the
    // dialog is FOR, not that a browser was about to take the screen.
    expect(window.api.addAccount).not.toHaveBeenCalled()
    expect(screen.queryAllByTestId('SignInDialog.account')).toEqual([])
    // Nobody to name — that is what adding means.
    expect(screen.getByTestId('SignInDialog.confirm')).not.toHaveTextContent('one@example.com')
    await confirmStart()
    expect(window.api.addAccount).toHaveBeenCalledTimes(1)
  })

  it('on web: the code-variant paste panel carries manualUrl and submits verbatim', async () => {
    installApi('web')
    await open({ providerId: 'anthropic', mode: 'reauth' })
    await act(async () => {
      fireEvent.click(screen.getByTestId('SignInDialog.reauth'))
    })
    const flow = screen.getByTestId('OAuthPasteBackFlow')
    expect(flow).toHaveAttribute('data-variant', 'code')
    fireEvent.click(screen.getByTestId('OAuthPasteBackFlow.open'))
    expect(window.open).toHaveBeenCalledWith(CLAUDE_URL, '_blank', 'noopener,noreferrer')

    fireEvent.change(screen.getByTestId('OAuthPasteBackFlow.input'), {
      target: { value: ' code-from-claude-ai ' }
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('OAuthPasteBackFlow.submit'))
    })
    expect(window.api.submitOAuthCode).toHaveBeenCalledWith('code-from-claude-ai')
    // The success edge arrives on `authState` and is what advances the stage.
    expect(screen.getByTestId('SignInDialog.done')).toHaveTextContent('one@example.com')
  })

  it('Retry re-sends the captured prompt through retrySend, from the body', async () => {
    installApi('web')
    useSessionStore.setState({ sessions: {}, activeSessionId: null })
    useSessionStore.getState().createNewSession('r-retry', '/tmp/proj')
    await open({
      providerId: 'anthropic',
      mode: 'reauth',
      retry: { routingId: 'r-retry', prompt: 'do the thing' }
    })
    await signInOnWeb()
    // The ONE primary action on the screen, in the body, naming the prompt
    // (ADR-070 §5 rule 6) — no longer a tinted button in a deleted footer.
    expect(screen.getByTestId('SignInDialog.done')).toContainElement(
      screen.getByTestId('SignInDialog.retry')
    )
    expect(screen.getByTestId('SignInDialog.retryRow')).toHaveTextContent('do the thing')
    await act(async () => {
      fireEvent.click(screen.getByTestId('SignInDialog.retry'))
    })
    expect(window.api.sendPrompt).toHaveBeenCalledWith('r-retry', 'do the thing')
    expect(useSessionStore.getState().signInDialog).toBeNull()
  })
})

describe('SignInDialog — ChatGPT', () => {
  it('lists the vault accounts and marks which one is active', async () => {
    installApi('darwin')
    await open({ providerId: 'chatgpt', mode: 'reauth' })
    expect(
      screen.getAllByTestId('SignInDialog.account').map((el) => el.getAttribute('data-id'))
    ).toEqual(['v1', 'v2'])
    // The active account is the one offered a re-authorize; the other, a switch.
    expect(screen.getByTestId('SignInDialog.reauth')).toHaveAttribute('data-id', 'v1')
    expect(screen.getByTestId('SignInDialog.switch')).toHaveAttribute('data-id', 'v2')
  })

  it('switch calls provider-account:switch and closes', async () => {
    installApi('darwin')
    await open({ providerId: 'chatgpt', mode: 'switch' })
    await act(async () => {
      fireEvent.click(screen.getByTestId('SignInDialog.switch'))
    })
    expect(window.api.switchProviderAccount).toHaveBeenCalledWith('chatgpt', 'v2')
    expect(useSessionStore.getState().signInDialog).toBeNull()
  })

  it('reauth and add both drive the vault PKCE flow on pi’s openai-codex', async () => {
    installApi('darwin')
    await open({ providerId: 'chatgpt', mode: 'reauth' })
    await act(async () => {
      fireEvent.click(screen.getByTestId('SignInDialog.reauth'))
    })
    expect(window.api.vendorAuthOauthAuthorize).toHaveBeenCalledWith('pi', 'openai-codex', 0)

    await act(async () => {
      useSessionStore.getState().closeSignIn()
    })
    await act(async () => {
      useSessionStore.getState().openSignIn({ providerId: 'chatgpt', mode: 'add' })
    })
    // `add` confirms first (Ruling 1), then runs the same PKCE authorize.
    expect(window.api.vendorAuthOauthAuthorize).toHaveBeenCalledTimes(1)
    await confirmStart()
    expect(window.api.vendorAuthOauthAuthorize).toHaveBeenCalledTimes(2)
  })

  it('on web: the url-variant paste goes to submitVendorOAuthCode and the done state lists the routes', async () => {
    installApi('web')
    await open({ providerId: 'chatgpt', mode: 'reauth' })
    await act(async () => {
      fireEvent.click(screen.getByTestId('SignInDialog.reauth'))
    })
    // Slice 7 made device code the web DEFAULT; the paste panel is now reached
    // through its escape hatch, and this is still the flow it lands on.
    await act(async () => {
      fireEvent.click(screen.getByTestId('DeviceCodeFlow.pasteInstead'))
    })
    const flow = screen.getByTestId('OAuthPasteBackFlow')
    expect(flow).toHaveAttribute('data-variant', 'url')

    const pasted = 'http://localhost:1455/auth/callback?code=abc&state=s'
    fireEvent.change(screen.getByTestId('OAuthPasteBackFlow.input'), { target: { value: pasted } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('OAuthPasteBackFlow.submit'))
    })
    expect(window.api.vendorAuthOauthCallback).toHaveBeenCalledWith('pi', 'openai-codex', 0, pasted)

    const done = screen.getByTestId('SignInDialog.done')
    // ADR-070 §5: "Signed in as …" is a check and the address.
    expect(screen.getByTestId('SignInDialog.signedIn')).toHaveTextContent('one@example.com')
    expect(done).not.toHaveTextContent('Signed in as')
    // One CHIP per enabled route, plus Codex — which is fed by injection, not by
    // a route, and only on its next request. Three sentences became one row
    // (ADR-070 §5 rule 5); the per-engine testids did not move.
    expect(
      screen.getAllByTestId('SignInDialog.fanOut').map((el) => el.getAttribute('data-id'))
    ).toEqual(['pi', 'codex'])
    expect(done).not.toHaveTextContent('picks it up on its next server start')
    expect(done).toHaveTextContent('next request')
  })

  it('the header names the engines the credential feeds, derived from the routes', async () => {
    installApi('darwin')
    await open({ providerId: 'chatgpt', mode: 'reauth' })
    // The SAME derivation the done state's fan-out uses: pi's route is on,
    // opencode's is off, and Codex is unconditional (ADR-068 §1).
    expect(
      screen.getAllByTestId('SignInDialog.engineChip').map((el) => el.getAttribute('data-id'))
    ).toEqual(['pi', 'codex'])
    // The blurb it replaces is gone — a caption nobody re-reads on the fourth
    // sign-in (ADR-070 §5 rule 1).
    const dialog = screen.getByTestId('SignInDialog')
    expect(dialog).not.toHaveTextContent('shared with pi, opencode and Codex')
    expect(dialog).not.toHaveTextContent('Sign in to ChatGPT')
  })
})

// ── Device code, the web ChatGPT default (ADR-068 §3, Slice 7) ──────────────
describe('SignInDialog — ChatGPT device code', () => {
  it('on web the ChatGPT flow DEFAULTS to device code, showing the URL, the code and the wait', async () => {
    installApi('web')
    await open({ providerId: 'chatgpt', mode: 'reauth' })
    await act(async () => {
      fireEvent.click(screen.getByTestId('SignInDialog.reauth'))
    })
    expect(window.api.vendorAuthDeviceCodeStart).toHaveBeenCalledWith('pi', 'openai-codex')
    // The PKCE authorize is NOT started — one flow holds the vault's login slot.
    expect(window.api.vendorAuthOauthAuthorize).not.toHaveBeenCalled()
    expect(screen.queryByTestId('OAuthPasteBackFlow')).toBeNull()

    expect(screen.getByTestId('DeviceCodeFlow.url')).toHaveAttribute(
      'href',
      DEVICE_CODE.verificationUrl
    )
    expect(screen.getByTestId('DeviceCodeFlow.code')).toHaveTextContent('ABCD-1234')
    expect(screen.getByTestId('DeviceCodeFlow.copy')).toBeTruthy()
    expect(screen.getByTestId('DeviceCodeFlow.cancel')).toBeTruthy()
    expect(screen.getByTestId('DeviceCodeFlow.waiting')).toHaveTextContent('Waiting')
    // The WAIT is the host-owned status poll, never a long `oauth-callback`
    // invoke — that one dies at 30 s on the web (Slice 7 review).
    expect(window.api.vendorAuthOauthCallback).not.toHaveBeenCalled()
  })

  it('Copy puts the user code on the clipboard', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText },
      configurable: true
    })
    installApi('web')
    await open({ providerId: 'chatgpt', mode: 'reauth' })
    await act(async () => {
      fireEvent.click(screen.getByTestId('SignInDialog.reauth'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('DeviceCodeFlow.copy'))
    })
    expect(writeText).toHaveBeenCalledWith('ABCD-1234')
  })

  it('"Paste a URL instead" cancels the device flow and starts the PKCE one', async () => {
    installApi('web')
    await open({ providerId: 'chatgpt', mode: 'reauth' })
    await act(async () => {
      fireEvent.click(screen.getByTestId('SignInDialog.reauth'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('DeviceCodeFlow.pasteInstead'))
    })
    // Host-side release first: the device flow holds the vault's ONE login slot,
    // so a PKCE start before the cancel would be refused as "already in progress".
    expect(window.api.vendorAuthOauthCancel).toHaveBeenCalledWith('pi')
    expect(window.api.vendorAuthOauthAuthorize).toHaveBeenCalledWith('pi', 'openai-codex', 0)
    expect(screen.getByTestId('OAuthPasteBackFlow')).toHaveAttribute('data-variant', 'url')
    expect(screen.queryByTestId('DeviceCodeFlow')).toBeNull()
  })

  it('the DESKTOP never sees the device panel — it keeps the loopback wait', async () => {
    installApi('darwin')
    await open({ providerId: 'chatgpt', mode: 'reauth' })
    await act(async () => {
      fireEvent.click(screen.getByTestId('SignInDialog.reauth'))
    })
    expect(window.api.vendorAuthDeviceCodeStart).not.toHaveBeenCalled()
    expect(screen.queryByTestId('DeviceCodeFlow')).toBeNull()
  })

  it('Anthropic on web is untouched — cli.js owns that flow', async () => {
    installApi('web')
    await open({ providerId: 'anthropic', mode: 'reauth' })
    await act(async () => {
      fireEvent.click(screen.getByTestId('SignInDialog.reauth'))
    })
    expect(window.api.vendorAuthDeviceCodeStart).not.toHaveBeenCalled()
    expect(screen.getByTestId('OAuthPasteBackFlow')).toHaveAttribute('data-variant', 'code')
  })

  it('a device-code failure renders through the outcome notice', async () => {
    installApi('web', {
      vendorAuthDeviceCodeStart: vi.fn(async () => {
        throw new Error('device code login is not enabled for this Codex server.')
      })
    })
    await open({ providerId: 'chatgpt', mode: 'reauth' })
    await act(async () => {
      fireEvent.click(screen.getByTestId('SignInDialog.reauth'))
    })
    expect(screen.getByTestId('OAuthOutcomeNotice')).toHaveTextContent('not enabled for this Codex')
  })
})

describe('SignInDialog — on a phone (390px)', () => {
  it('is usable: the account rows, the flow and the actions are all reachable', async () => {
    ;(globalThis as unknown as { window: { innerWidth: number } }).window.innerWidth = 390
    installApi('web')
    await open({ providerId: 'chatgpt', mode: 'reauth' })

    // Full-screen rather than a 460px card that would overflow the viewport.
    const panel = screen.getByTestId('SignInDialog').querySelector('div.relative')!
    expect(panel.className).toContain('w-full')
    expect(panel.className).not.toContain('w-[460px]')

    expect(screen.getAllByTestId('SignInDialog.account')).toHaveLength(2)
    await act(async () => {
      fireEvent.click(screen.getByTestId('SignInDialog.reauth'))
    })
    // The phone gets device code by default (Slice 7) — the paste field is one
    // tap away and still reachable at 390px.
    expect(screen.getByTestId('DeviceCodeFlow.code')).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByTestId('DeviceCodeFlow.pasteInstead'))
    })
    expect(screen.getByTestId('OAuthPasteBackFlow.input')).toBeTruthy()
    expect(screen.getByTestId('OAuthPasteBackFlow.submit')).toBeTruthy()
    expect(screen.getByTestId('SignInDialog.close')).toBeTruthy()
  })
})

// ── Ruling 1: no browser opens without a click that asked for it ───────────
//
// ADR-070's second residual, ruled 2026-09-19. `readAccounts` reports
// `autoStart` for Anthropic whenever multi-account is OFF — the default, and
// the owner's own machine — so opening the dialog used to call `signIn()` and
// with it `shell.openExternal`, with no screen in between. ChatGPT had the
// same shape with no stored account, and its web device-code start makes a
// live request to the vendor. Every one of those paths now stops on a confirm.
//
// These assert the DRIVER, not the markup: "no `window.api` call happened" is
// the only form of this that a rendering change cannot quietly satisfy.
describe('SignInDialog — the confirm before the browser', () => {
  const NO_CHATGPT_ACCOUNTS = { activeId: null, perSession: true, accounts: [] }
  const ONE_CLAUDE_ACCOUNT = {
    ...CLAUDE_ACCOUNTS,
    enabled: false,
    accounts: [CLAUDE_ACCOUNTS.accounts[0]]
  }

  it('Anthropic with multi-account OFF: opening calls no signIn, the click calls exactly one', async () => {
    installApi('darwin', { getAccounts: vi.fn(async () => ONE_CLAUDE_ACCOUNT) })
    await open({ providerId: 'anthropic', mode: 'reauth' })

    expect(screen.getByTestId('SignInDialog.confirm')).toBeTruthy()
    expect(window.api.signIn).not.toHaveBeenCalled()
    expect(window.api.addAccount).not.toHaveBeenCalled()
    // And nothing is pretending the flow is already running.
    expect(screen.queryByTestId('SignInDialog.waiting')).toBeNull()
    expect(screen.queryByTestId('OAuthPasteBackFlow')).toBeNull()

    await confirmStart()
    expect(window.api.signIn).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('SignInDialog.waiting')).toBeTruthy()
  })

  it('names the credential it will use, when readAccounts knows one', async () => {
    installApi('darwin', { getAccounts: vi.fn(async () => ONE_CLAUDE_ACCOUNT) })
    await open({ providerId: 'anthropic', mode: 'reauth' })
    // The half of ADR-068 §3 that was right: with one credential there is
    // nothing to choose. The half that was wrong: the user still has to be
    // told WHICH one, and asked.
    const row = screen.getByTestId('SignInDialog.confirm')
    expect(row).toHaveTextContent('one@example.com')
    expect(row).toHaveAttribute('data-id', 'a1')
    expect(screen.getByTestId('SignInDialog.plan')).toHaveTextContent('Claude Max')
  })

  it('ChatGPT with an empty account list: no vendor call until the click', async () => {
    installApi('darwin', { listProviderAccounts: vi.fn(async () => NO_CHATGPT_ACCOUNTS) })
    await open({ providerId: 'chatgpt', mode: 'reauth' })

    expect(screen.getByTestId('SignInDialog.confirm')).toBeTruthy()
    expect(window.api.vendorAuthOauthAuthorize).not.toHaveBeenCalled()
    await confirmStart()
    expect(window.api.vendorAuthOauthAuthorize).toHaveBeenCalledTimes(1)
  })

  it('on web the device-code start is a live vendor request, so it waits too', async () => {
    installApi('web', { listProviderAccounts: vi.fn(async () => NO_CHATGPT_ACCOUNTS) })
    await open({ providerId: 'chatgpt', mode: 'reauth' })

    expect(window.api.vendorAuthDeviceCodeStart).not.toHaveBeenCalled()
    await confirmStart()
    expect(window.api.vendorAuthDeviceCodeStart).toHaveBeenCalledTimes(1)
  })

  it('does not promise a browser the host will not open (ADR-057)', async () => {
    // Desktop opens one; a remote host never `openExternal`s for a remote
    // caller, so the web labels name what actually arrives instead.
    installApi('darwin', { getAccounts: vi.fn(async () => ONE_CLAUDE_ACCOUNT) })
    await open({ providerId: 'anthropic', mode: 'reauth' })
    expect(screen.getByTestId('SignInDialog.confirmStart')).toHaveTextContent('Open browser')
    cleanup()

    installApi('web', { getAccounts: vi.fn(async () => ONE_CLAUDE_ACCOUNT) })
    await open({ providerId: 'anthropic', mode: 'reauth' })
    const claude = screen.getByTestId('SignInDialog.confirmStart')
    expect(claude).toHaveTextContent('Get a sign-in link')
    expect(claude).not.toHaveTextContent('browser')
    cleanup()

    installApi('web', { listProviderAccounts: vi.fn(async () => NO_CHATGPT_ACCOUNTS) })
    await open({ providerId: 'chatgpt', mode: 'reauth' })
    const chatgpt = screen.getByTestId('SignInDialog.confirmStart')
    expect(chatgpt).toHaveTextContent('Get a code')
    expect(chatgpt).not.toHaveTextContent('browser')
  })

  it('the chooser does NOT grow a second confirmation — the list already is one', async () => {
    installApi('darwin')
    await open({ providerId: 'anthropic', mode: 'reauth' })
    // Two stored accounts: there IS something to choose between, so the list
    // renders and Re-authorize still drives the flow on its own click.
    expect(screen.getAllByTestId('SignInDialog.account')).toHaveLength(2)
    expect(screen.queryByTestId('SignInDialog.confirm')).toBeNull()
    expect(window.api.signIn).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.click(screen.getByTestId('SignInDialog.reauth'))
    })
    expect(screen.queryByTestId('SignInDialog.confirm')).toBeNull()
    expect(window.api.signIn).toHaveBeenCalledTimes(1)
  })

  it('the same holds for the ChatGPT chooser', async () => {
    installApi('darwin')
    await open({ providerId: 'chatgpt', mode: 'reauth' })
    expect(screen.getAllByTestId('SignInDialog.account')).toHaveLength(2)
    expect(screen.queryByTestId('SignInDialog.confirm')).toBeNull()
    expect(window.api.vendorAuthOauthAuthorize).not.toHaveBeenCalled()
  })

  it('Cancel from a confirmed flow lands on a chooser that can act, not a dead end', async () => {
    installApi('darwin', { getAccounts: vi.fn(async () => ONE_CLAUDE_ACCOUNT) })
    await open({ providerId: 'anthropic', mode: 'reauth' })
    await confirmStart()
    await act(async () => {
      fireEvent.click(screen.getByTestId('SignInDialog.cancel'))
    })
    // F3's ruling, unchanged by the new stage: the chooser, naming the one
    // credential, with a live Re-authorize on it.
    expect(screen.queryByTestId('SignInDialog.confirm')).toBeNull()
    expect(screen.getByTestId('SignInDialog.reauth')).toHaveAttribute('data-id', 'a1')
    await act(async () => {
      fireEvent.click(screen.getByTestId('SignInDialog.reauth'))
    })
    expect(window.api.signIn).toHaveBeenCalledTimes(2)
  })
})

// ── Cancel when there was nothing to choose between (F3) ────────────────────
//
// The dialog skips the chooser whenever the list has nothing to offer — no
// stored account at all, or Anthropic with multi-account off — and that used to
// leave Cancel with nowhere to go: the stage stayed on `flow`, so a cancelled
// sign-in kept rendering a panel that was asking the user to wait for a code
// nobody was requesting. Cancel now always lands on the chooser, and the chooser
// answers for an empty list.
describe('SignInDialog — Cancel with nothing to choose between', () => {
  const NO_CHATGPT_ACCOUNTS = { activeId: null, perSession: true, accounts: [] }

  it('web ChatGPT with no account: Cancel returns to a chooser that says so', async () => {
    installApi('web', { listProviderAccounts: vi.fn(async () => NO_CHATGPT_ACCOUNTS) })
    await open({ providerId: 'chatgpt', mode: 'reauth' })
    // No rows, so there is nothing to choose — but the flow waits for the
    // confirm's primary (Ruling 1) before it asks the vendor for anything.
    expect(window.api.vendorAuthDeviceCodeStart).not.toHaveBeenCalled()
    await confirmStart()
    expect(window.api.vendorAuthDeviceCodeStart).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('DeviceCodeFlow.code')).toHaveTextContent('ABCD-1234')

    await act(async () => {
      fireEvent.click(screen.getByTestId('DeviceCodeFlow.cancel'))
    })
    expect(window.api.vendorAuthOauthCancel).toHaveBeenCalledWith('pi')
    // The cancelled panel is gone, pre-code look and all.
    expect(screen.queryByTestId('DeviceCodeFlow')).toBeNull()
    expect(screen.queryByText('Requesting a code…')).toBeNull()
    expect(screen.getByTestId('SignInDialog.empty')).toHaveTextContent(
      'No ChatGPT account is signed in on this host.'
    )
    expect(screen.getByTestId('SignInDialog.addAccount')).toHaveTextContent('Sign in')
  })

  it('web ChatGPT with no account: the empty chooser’s Sign in starts the flow again', async () => {
    installApi('web', { listProviderAccounts: vi.fn(async () => NO_CHATGPT_ACCOUNTS) })
    await open({ providerId: 'chatgpt', mode: 'reauth' })
    await confirmStart()
    await act(async () => {
      fireEvent.click(screen.getByTestId('DeviceCodeFlow.cancel'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('SignInDialog.addAccount'))
    })
    expect(window.api.vendorAuthDeviceCodeStart).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('DeviceCodeFlow.code')).toHaveTextContent('ABCD-1234')
    expect(screen.queryByTestId('SignInDialog.empty')).toBeNull()
  })

  it('Anthropic with multi-account off: Cancel shows the one account, not an empty list', async () => {
    installApi('darwin', {
      getAccounts: vi.fn(async () => ({
        ...CLAUDE_ACCOUNTS,
        enabled: false,
        accounts: [CLAUDE_ACCOUNTS.accounts[0]]
      }))
    })
    await open({ providerId: 'anthropic', mode: 'reauth' })
    // Nothing to choose between, so the chooser is still skipped — but the
    // confirm screen holds the flow until the user asks for it (Ruling 1).
    expect(window.api.signIn).not.toHaveBeenCalled()
    await confirmStart()
    expect(window.api.signIn).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('SignInDialog.waiting')).toBeTruthy()

    await act(async () => {
      fireEvent.click(screen.getByTestId('SignInDialog.cancel'))
    })
    expect(window.api.cancelSignIn).toHaveBeenCalledTimes(1)
    // One credential IS signed in — the chooser must name it rather than claim
    // the host has none.
    expect(screen.queryByTestId('SignInDialog.empty')).toBeNull()
    const rows = screen.getAllByTestId('SignInDialog.account')
    expect(rows.map((el) => el.getAttribute('data-id'))).toEqual(['a1'])
    expect(rows[0]).toHaveTextContent('one@example.com')
    expect(screen.getByTestId('SignInDialog.reauth')).toHaveAttribute('data-id', 'a1')
    // No add row: `addAccount()` would flip the host to multi-account, which
    // is a Settings decision, not a side effect of cancelling a sign-in.
    expect(screen.queryByTestId('SignInDialog.addRow')).toBeNull()
  })

  it('Anthropic with multi-account off and no listed account: Cancel offers Sign in without claiming no account exists', async () => {
    installApi('darwin', {
      getAccounts: vi.fn(async () => ({ ...CLAUDE_ACCOUNTS, enabled: false, accounts: [] }))
    })
    await open({ providerId: 'anthropic', mode: 'reauth' })
    await confirmStart()
    expect(window.api.signIn).toHaveBeenCalledTimes(1)
    await act(async () => {
      fireEvent.click(screen.getByTestId('SignInDialog.cancel'))
    })
    // The keychain credential is invisible to this list, so the dialog must
    // not say "no account is signed in"; it just offers to sign in again.
    expect(screen.queryByTestId('SignInDialog.empty')).toBeNull()
    expect(screen.queryByTestId('SignInDialog.account')).toBeNull()
    expect(screen.getByTestId('SignInDialog.addAccount')).toHaveTextContent('Sign in')
    await act(async () => {
      fireEvent.click(screen.getByTestId('SignInDialog.addAccount'))
    })
    // The reauth path (signIn), never addAccount.
    expect(window.api.signIn).toHaveBeenCalledTimes(2)
    expect(window.api.addAccount).not.toHaveBeenCalled()
  })
})

// ── The trim (ADR-070 §5, mockup 4ed195a3) ──────────────────────────────────
//
// Word budgets are deliberately NOT asserted — a count is brittle and would
// fail on a rewording that reads better. What is asserted is the six specific
// deletions, and that nothing which carried information went with them.
describe('SignInDialog — what ADR-070 deleted', () => {
  it('has no footer at all: no Close/Done row, and `×` is still the close', async () => {
    installApi('darwin')
    await open({ providerId: 'chatgpt', mode: 'reauth' })
    expect(screen.queryByTestId('SignInDialog.close2')).toBeNull()
    expect(screen.getByTestId('SignInDialog')).not.toHaveTextContent('Done')
    await act(async () => {
      fireEvent.click(screen.getByTestId('SignInDialog.close'))
    })
    expect(useSessionStore.getState().signInDialog).toBeNull()
  })

  it('the add row is the button and nothing else — all three descriptions are gone', async () => {
    installApi('darwin')
    await open({ providerId: 'chatgpt', mode: 'reauth' })
    const addRow = screen.getByTestId('SignInDialog.addRow')
    expect(addRow).toHaveTextContent('+ Add account')
    expect(addRow).not.toHaveTextContent('adds it to the list')
    expect(addRow).not.toHaveTextContent('Signs in to')
  })

  it('the active account is a dot and two chips, not a tinted band and a sentence', async () => {
    installApi('darwin', {
      listProviderAccounts: vi.fn(async () => ({
        ...CHATGPT_ACCOUNTS,
        accounts: [{ ...CHATGPT_ACCOUNTS.accounts[0], planType: 'Plus', needsReauth: true }]
      }))
    })
    await open({ providerId: 'chatgpt', mode: 'reauth' })
    const row = screen.getByTestId('SignInDialog.account')
    expect(row.className).not.toContain('bg-accent/5')
    expect(screen.getByTestId('SignInDialog.activeDot')).toHaveAttribute('data-active', 'true')
    // Both facts survive the split: the plan is neutral, the dead credential is
    // danger, and neither is a joined `Plus · sign-in expired` string.
    expect(screen.getByTestId('SignInDialog.plan')).toHaveTextContent('Plus')
    expect(screen.getByTestId('SignInDialog.expired')).toHaveTextContent('expired')
    expect(row).not.toHaveTextContent('Plus · sign-in expired')
  })

  it('the desktop wait is one line: the spinner label, no paragraph under it', async () => {
    installApi('darwin')
    await open({ providerId: 'anthropic', mode: 'reauth' })
    await act(async () => {
      fireEvent.click(screen.getByTestId('SignInDialog.reauth'))
    })
    const panel = screen.getByTestId('SignInDialog.waiting')
    expect(panel).toHaveTextContent('Waiting for the browser…')
    expect(panel).not.toHaveTextContent('It completes on its own')
    expect(panel).not.toHaveTextContent('browser window we opened')
    // The manual link is still gated on there BEING a url (desktop has none).
    expect(screen.queryByTestId('SignInDialog.manualLink')).toBeNull()
    expect(screen.getByTestId('SignInDialog.cancel')).toBeTruthy()
  })
})

// ── The error the footer used to hold (ADR-070 §5 rule 6) ───────────────────
describe('SignInDialog — an error can never be silently dropped', () => {
  it('a failed switch renders in the BODY, where the footer span used to be', async () => {
    installApi('darwin', {
      switchProviderAccount: vi.fn(async () => {
        throw new Error('the vault refused to switch account')
      })
    })
    await open({ providerId: 'chatgpt', mode: 'reauth' })
    await act(async () => {
      fireEvent.click(screen.getByTestId('SignInDialog.switch'))
    })
    expect(screen.getByTestId('SignInDialog.error')).toHaveTextContent(
      'the vault refused to switch account'
    )
    // Still on the chooser, so the user can try the other account.
    expect(screen.getAllByTestId('SignInDialog.account')).toHaveLength(2)
  })

  it('a failed account read renders in the body too', async () => {
    installApi('darwin', {
      listProviderAccounts: vi.fn(async () => {
        throw new Error('provider-account:list failed')
      })
    })
    await open({ providerId: 'chatgpt', mode: 'reauth' })
    expect(screen.getByTestId('SignInDialog.error')).toHaveTextContent(
      'provider-account:list failed'
    )
  })

  it('does not print the same failure twice when the flow already shows it', async () => {
    installApi('web', {
      vendorAuthDeviceCodeStart: vi.fn(async () => {
        throw new Error('device code login is not enabled for this Codex server.')
      })
    })
    await open({ providerId: 'chatgpt', mode: 'reauth' })
    await act(async () => {
      fireEvent.click(screen.getByTestId('SignInDialog.reauth'))
    })
    // `authorizeVendorDeviceCode` parks the message on `vendorOAuth` AND returns
    // it, so the outcome notice owns it and the body error row stands down.
    expect(screen.getByTestId('OAuthOutcomeNotice')).toHaveTextContent('not enabled for this Codex')
    expect(screen.queryByTestId('SignInDialog.error')).toBeNull()
  })

  it('suppression needs the notice ON SCREEN, not merely the same words in the store', async () => {
    const SAME = 'the vault refused to switch account'
    installApi('darwin', {
      switchProviderAccount: vi.fn(async () => {
        throw new Error(SAME)
      })
    })
    await open({ providerId: 'chatgpt', mode: 'reauth' })
    await act(async () => {
      fireEvent.click(screen.getByTestId('SignInDialog.switch'))
    })
    // A stale flow error with the SAME text: `vendorOAuth` survives a stage
    // change, but the outcome notice that renders it only exists in the `flow`
    // stage — and we are on the chooser.
    await act(async () => {
      useSessionStore.setState({
        vendorOAuth: {
          engineId: 'pi',
          vendorId: 'openai-codex',
          stage: 'error',
          instructions: '',
          error: SAME
        }
      })
    })
    expect(screen.queryByTestId('OAuthOutcomeNotice')).toBeNull()
    expect(screen.getByTestId('SignInDialog.error')).toHaveTextContent(SAME)
  })
})

// ── The retry belongs to the SESSION (ADR-070 §3) ───────────────────────────
describe('SignInDialog — the retry outlives the dialog', () => {
  const SESSION = 'r-session-retry'

  function seedBlamedSession(): void {
    useSessionStore.getState().createNewSession(SESSION, '/tmp/proj')
    blame(SESSION, { providerId: 'anthropic', retryPrompt: 'fix the flaky test' })
  }

  it('offers the session’s stopped prompt even when the entry point knew none', async () => {
    installApi('web')
    seedBlamedSession()
    // No `retry` on the request — the Settings / picker entry point, which is
    // exactly the case that used to offer no retry at all.
    await open({ providerId: 'anthropic', mode: 'reauth' })
    await signInOnWeb()
    expect(screen.getByTestId('SignInDialog.retryRow')).toHaveTextContent('fix the flaky test')
    await act(async () => {
      fireEvent.click(screen.getByTestId('SignInDialog.retry'))
    })
    expect(window.api.sendPrompt).toHaveBeenCalledWith(SESSION, 'fix the flaky test')
    // Performing the retry settles the lifetime, like the pill and the row.
    expect(useSessionStore.getState().sessions[SESSION].authRequired).toBeNull()
  })

  it('closing the dialog does not destroy it — that is why `Done` could go', async () => {
    installApi('web')
    seedBlamedSession()
    await open({ providerId: 'anthropic', mode: 'reauth' })
    await signInOnWeb()
    expect(screen.getByTestId('SignInDialog.retry')).toBeTruthy()

    await act(async () => {
      useSessionStore.getState().closeSignIn()
    })
    expect(screen.queryByTestId('SignInDialog')).toBeNull()

    await act(async () => {
      useSessionStore.getState().openSignIn({ providerId: 'anthropic', mode: 'reauth' })
    })
    await signInOnWeb()
    expect(screen.getByTestId('SignInDialog.retryRow')).toHaveTextContent('fix the flaky test')
  })

  it('survives the resolution that drops the issue out of the live summary', async () => {
    installApi('web')
    seedBlamedSession()
    await open({ providerId: 'anthropic', mode: 'reauth' })
    // Lifetime 2 (ADR-070 §2): the credential is good, the prompt is still
    // un-sent — and `summarizeAuthIssues` no longer reports an ISSUE for it.
    await act(async () => {
      blame(SESSION, {
        providerId: 'anthropic',
        retryPrompt: 'fix the flaky test',
        resolved: true
      })
    })
    await signInOnWeb()
    expect(screen.getByTestId('SignInDialog.retryRow')).toHaveTextContent('fix the flaky test')
  })
})

// ── Provider-list mode (ADR-070 §5) ────────────────────────────────────────
//
// The pill aggregates, so with several providers down it has no single flow to
// open. The list reads the SAME `useAuthSummary` the pill does, which is what
// keeps the two from disagreeing about which credentials are broken.
describe('SignInDialog — provider-list mode', () => {
  const DRIVABLE = 'r-list-chatgpt'
  const NATIVE = 'r-list-opencode'

  function seedTwoIssues(): void {
    useSessionStore.getState().createNewSession(DRIVABLE, '/tmp/a')
    useSessionStore.getState().createNewSession(NATIVE, '/tmp/b')
    blame(DRIVABLE, {
      providerId: 'chatgpt',
      accountId: 'v1',
      retryPrompt: 'refactor the dispatcher'
    })
    blame(NATIVE, { providerId: 'opencode:openrouter' })
  }

  it('lists one row per issue, drivable first, with what each blocks', async () => {
    installApi('darwin')
    seedTwoIssues()
    await open({ kind: 'list' })
    expect(screen.getByTestId('SignInDialog')).toHaveTextContent('Sign-ins')
    // No provider mark in this mode — there is no single provider.
    expect(screen.queryByTestId('SignInDialog.mark')).toBeNull()
    expect(
      screen.getAllByTestId('SignInDialog.issue').map((el) => el.getAttribute('data-id'))
    ).toEqual(['chatgpt', 'opencode:openrouter'])
    expect(screen.getAllByTestId('SignInDialog.issueState')[0]).toHaveTextContent(
      AUTH_ISSUE_NAME.expired
    )
    // `blocks` is route-dependent (ADR-030) — with no route enabled the ChatGPT
    // credential only blocks Codex.
    expect(screen.getAllByTestId('SignInDialog.issueBlocks').map((el) => el.textContent)).toEqual([
      'Codex',
      'opencode'
    ])
  })

  /**
   * The state's ONE name (ADR-070 §4). This row read "not signed in" for the
   * very state the pill beside it was calling "Sign-in needed" — one
   * credential, two phrasings, on two surfaces visible at the same time. Read
   * off `AUTH_ISSUE_NAME` so a reworded state cannot leave this surface behind.
   */
  it('names a `needed` state the way every other surface names it', async () => {
    installApi('darwin')
    useSessionStore.setState({
      providerAuth: { ...UNKNOWN_PROVIDER_AUTH, anthropic: 'unauthenticated' }
    })
    await open({ kind: 'list' })
    const states = screen.getAllByTestId('SignInDialog.issueState')
    expect(states).toHaveLength(1)
    expect(states[0]).toHaveTextContent(AUTH_ISSUE_NAME.needed)
  })

  it('a drivable row switches this dialog into that provider’s normal flow', async () => {
    installApi('darwin')
    seedTwoIssues()
    await open({ kind: 'list' })
    await act(async () => {
      fireEvent.click(screen.getAllByTestId('SignInDialog.issueSignIn')[0])
    })
    // The same request shape every other entry point builds, retry included.
    expect(useSessionStore.getState().signInDialog).toEqual({
      providerId: 'chatgpt',
      mode: 'reauth',
      accountId: 'v1',
      retry: { routingId: DRIVABLE, prompt: 'refactor the dispatcher' }
    })
    // And it remounted into that flow rather than staying on the list.
    expect(screen.getAllByTestId('SignInDialog.account')).toHaveLength(2)
  })

  it('a non-drivable row opens provider settings, never a dialog with nothing to run', async () => {
    installApi('darwin')
    seedTwoIssues()
    await open({ kind: 'list' })
    const deepLink = vi.fn()
    window.addEventListener('open-settings', deepLink)
    await act(async () => {
      fireEvent.click(screen.getAllByTestId('SignInDialog.issueSignIn')[1])
    })
    window.removeEventListener('open-settings', deepLink)
    expect(deepLink).toHaveBeenCalledTimes(1)
    expect((deepLink.mock.calls[0][0] as CustomEvent).detail).toEqual({
      page: 'models',
      group: 'providers'
    })
    expect(useSessionStore.getState().signInDialog).toEqual({ kind: 'list' })
  })

  it('names the stopped prompts, and arms the retry only once one is takeable', async () => {
    installApi('darwin')
    seedTwoIssues()
    await open({ kind: 'list' })
    expect(screen.getByTestId('SignInDialog.retryRow')).toHaveTextContent('refactor the dispatcher')
    expect(screen.getByTestId('SignInDialog.retry')).toBeDisabled()
    expect(screen.getByTestId('SignInDialog.retry')).toHaveTextContent('Retry after sign-in')

    // A resolution for that provider is what makes the prompt sendable.
    await act(async () => {
      blame(DRIVABLE, {
        providerId: 'chatgpt',
        retryPrompt: 'refactor the dispatcher',
        resolved: true
      })
    })
    expect(screen.getByTestId('SignInDialog.retry')).not.toBeDisabled()
    await act(async () => {
      fireEvent.click(screen.getByTestId('SignInDialog.retry'))
    })
    expect(window.api.sendPrompt).toHaveBeenCalledWith(DRIVABLE, 'refactor the dispatcher')
    expect(useSessionStore.getState().sessions[DRIVABLE].authRequired).toBeNull()
  })

  it('a settled list says so and offers nothing, rather than an empty box', async () => {
    installApi('darwin')
    await open({ kind: 'list' })
    expect(screen.getByTestId('SignInDialog.settled')).toHaveTextContent('Nothing needs a sign-in.')
    expect(screen.queryByTestId('SignInDialog.issue')).toBeNull()
    expect(screen.queryByTestId('SignInDialog.retryRow')).toBeNull()
  })
})
