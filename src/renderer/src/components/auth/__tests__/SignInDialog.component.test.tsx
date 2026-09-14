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

beforeEach(() => {
  useSessionStore.setState({ signInDialog: null, authState: null, vendorOAuth: null })
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

  it('add mode skips the chooser and calls addAccount()', async () => {
    installApi('darwin')
    await open({ providerId: 'anthropic', mode: 'add' })
    expect(window.api.addAccount).toHaveBeenCalledTimes(1)
    expect(screen.queryAllByTestId('SignInDialog.account')).toEqual([])
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

  it('Retry last prompt re-sends the captured prompt through retrySend', async () => {
    installApi('web')
    useSessionStore.setState({ sessions: {}, activeSessionId: null })
    useSessionStore.getState().createNewSession('r-retry', '/tmp/proj')
    await open({
      providerId: 'anthropic',
      mode: 'reauth',
      retry: { routingId: 'r-retry', prompt: 'do the thing' }
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('SignInDialog.reauth'))
    })
    fireEvent.change(screen.getByTestId('OAuthPasteBackFlow.input'), { target: { value: 'x' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('OAuthPasteBackFlow.submit'))
    })
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
    expect(done).toHaveTextContent('Signed in as one@example.com')
    // One line per ENABLED route, plus Codex — which is fed by injection, not by
    // a route, and only on its next request.
    expect(
      screen.getAllByTestId('SignInDialog.fanOut').map((el) => el.getAttribute('data-id'))
    ).toEqual(['pi', 'codex'])
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
    expect(screen.getByTestId('DeviceCodeFlow.waiting')).toHaveTextContent(
      'Waiting for you to enter the code'
    )
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

  it('"Paste the callback URL instead" cancels the device flow and starts the PKCE one', async () => {
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
    // No rows, so the device flow starts on its own — unchanged.
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
    // Nothing to choose between, so the flow still starts without the chooser.
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
