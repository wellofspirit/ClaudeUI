/**
 * The SETTINGS half of ADR-057 / S4-UI — the two provider/account panes that
 * can start an OAuth flow from a remote client.
 *
 * 1. Accounts › + Add account. `account:add` starts a login host-side, and the
 *    URL a remote user needs rides back on the RESPONSE (`pendingSignIn`) rather
 *    than on the host-local `auth:state` event. The pane folds it into the
 *    store's `authState` — the same field AuthBanner drives — so the Claude flow
 *    still has exactly one state.
 * 2. Providers › the opencode catalog rows, whose OAuth button now parks the
 *    shared paste-back flow on web and keeps its own local instructions UI on
 *    desktop.
 *
 * Both directions of each platform branch are pinned.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SECTIONS } from '../settings-sections'
import { useSessionStore } from '../../../stores/session-store'
import type { OpencodeProviderCatalogEntry } from '../../../../../shared/types'

vi.mock('electron', async () => await import('../../../../../test/stubs/electron-shim'))

function renderSection(id: string): void {
  const section = SECTIONS.find((s) => s.id === id)!
  render(
    section.items[0].render({} as never, () => {}, {} as never, () => {}, {} as never, () => {})
  )
}

const MANUAL_URL = 'https://claude.ai/oauth/authorize?state=acct'

afterEach(cleanup)

// ── Accounts pane ────────────────────────────────────────────────────────

const ACCOUNTS = {
  enabled: true,
  activeId: 'a1',
  accounts: [{ id: 'a1', email: null, subscriptionType: null, organization: null, createdAt: 0 }]
}

function installAccountsApi(platform: string, over: Record<string, unknown> = {}): void {
  ;(globalThis as unknown as { window: Record<string, unknown> }).window.api = {
    platform,
    getAccounts: vi.fn(async () => ACCOUNTS),
    addAccount: vi.fn(async () =>
      platform === 'web'
        ? {
            ...ACCOUNTS,
            pendingSignIn: {
              status: 'authorizing',
              account: null,
              error: null,
              manualUrl: MANUAL_URL
            }
          }
        : ACCOUNTS
    ),
    submitOAuthCode: vi.fn(async () => ({ status: 'success', account: null, error: null })),
    cancelSignIn: vi.fn(async () => {}),
    ...over
  }
  ;(globalThis as unknown as { window: Record<string, unknown> }).window.open = vi.fn()
}

describe('Settings › Accounts — add-account sign-in', () => {
  beforeEach(() => {
    useSessionStore.setState({ accountsState: null, authState: null })
  })

  it('on web: folds the response’s pendingSignIn into authState and shows the flow', async () => {
    installAccountsApi('web')
    await act(async () => renderSection('accounts'))
    expect(screen.queryByTestId('AccountsSetting.signInFlow')).toBeNull()

    await act(async () => {
      fireEvent.click(screen.getByTestId('AccountsSetting.addAccount'))
    })

    // ONE Claude-flow state, shared with AuthBanner.
    expect(useSessionStore.getState().authState?.manualUrl).toBe(MANUAL_URL)
    expect(screen.getByTestId('AccountsSetting.signInFlow')).toBeTruthy()
    const flow = screen.getByTestId('OAuthPasteBackFlow')
    expect(flow).toHaveAttribute('data-variant', 'code')
    fireEvent.click(screen.getByTestId('OAuthPasteBackFlow.open'))
    expect(window.open).toHaveBeenCalledWith(MANUAL_URL, '_blank', 'noopener,noreferrer')
  })

  it('on web: the pasted code goes to auth:submit-code', async () => {
    installAccountsApi('web')
    await act(async () => renderSection('accounts'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('AccountsSetting.addAccount'))
    })
    fireEvent.change(screen.getByTestId('OAuthPasteBackFlow.input'), { target: { value: 'zz1' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('OAuthPasteBackFlow.submit'))
    })
    expect(window.api.submitOAuthCode).toHaveBeenCalledWith('zz1')
  })

  it('on desktop: no pendingSignIn, no flow (platform pin)', async () => {
    installAccountsApi('darwin')
    await act(async () => renderSection('accounts'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('AccountsSetting.addAccount'))
    })
    expect(screen.queryByTestId('AccountsSetting.signInFlow')).toBeNull()
    expect(screen.queryByTestId('OAuthPasteBackFlow')).toBeNull()
    expect(useSessionStore.getState().authState).toBeNull()
  })

  it('on desktop: even an in-flight authState never mounts the flow (platform pin)', async () => {
    // The backend pin (account-manager.test.ts) already says a desktop
    // `account:add` sends no `pendingSignIn`. This is the UI half of the same
    // guarantee: the pane's own branch, with the store forced into the state a
    // remote flow would produce.
    installAccountsApi('darwin')
    await act(async () => renderSection('accounts'))
    act(() =>
      useSessionStore.getState().setAuthState({
        status: 'authorizing',
        account: null,
        error: null,
        manualUrl: MANUAL_URL
      })
    )
    expect(screen.queryByTestId('AccountsSetting.signInFlow')).toBeNull()
    expect(screen.queryByTestId('OAuthPasteBackFlow')).toBeNull()
  })
})

// ── opencode providers pane ──────────────────────────────────────────────

const OAUTH_PROVIDER: OpencodeProviderCatalogEntry = {
  id: 'anthropic',
  name: 'Anthropic',
  authState: 'unauthenticated',
  authMethods: ['oauth'],
  modelCount: 0,
  disabled: false,
  actions: {
    canSetCredential: true,
    canEditDeclaration: false,
    canRemove: false,
    removeKind: null
  }
}
const AUTHORIZE_URL = 'https://console.anthropic.com/oauth?state=s'

function installOpencodeApi(platform: string, over: Record<string, unknown> = {}): void {
  ;(globalThis as unknown as { window: Record<string, unknown> }).window.api = {
    platform,
    engineIsInstalled: vi.fn(async () => true),
    getOpencodeProviders: vi.fn(async () => [OAUTH_PROVIDER]),
    loadOpencodeSettings: vi.fn(async () => ({})),
    saveOpencodeSettings: vi.fn(async () => {}),
    vendorAuthListOptions: vi.fn(async () => ({
      anthropic: [{ type: 'oauth', label: 'Sign in with Claude Pro/Max' }]
    })),
    vendorAuthOauthAuthorize: vi.fn(async () => ({
      url: AUTHORIZE_URL,
      method: 'code',
      instructions: 'Paste the code from the browser.'
    })),
    vendorAuthOauthCallback: vi.fn(async () => true),
    vendorAuthOauthCancel: vi.fn(async () => {}),
    getOpencodeProviderModels: vi.fn(async () => []),
    listSharedProviders: vi.fn(async () => []),
    ...over
  }
  ;(globalThis as unknown as { window: Record<string, unknown> }).window.open = vi.fn()
}

/** Expand the row's "Add" panel, which is where its OAuth button lives. */
async function openProviderOAuth(): Promise<void> {
  await act(async () => renderSection('vendor-opencode'))
  await act(async () => {
    fireEvent.click(screen.getByTestId('VendorOpencodeSection.addProvider'))
  })
  await act(async () => {
    fireEvent.click(screen.getByText('Anthropic'))
  })
  await act(async () => {
    fireEvent.click(screen.getByText('Sign in with Claude Pro/Max'))
  })
}

describe('Settings › opencode providers — OAuth', () => {
  beforeEach(() => {
    useSessionStore.setState({ vendorOAuth: null })
  })

  it('on web: the shared paste-back flow replaces the local instructions UI', async () => {
    installOpencodeApi('web')
    await openProviderOAuth()
    const flow = screen.getByTestId('OAuthPasteBackFlow')
    expect(flow).toHaveAttribute('data-variant', 'url')
    expect(flow).toHaveAttribute('data-id', 'anthropic')
    // The desktop-only local UI is NOT also on screen.
    expect(screen.queryByPlaceholderText('Paste code here')).toBeNull()

    fireEvent.change(screen.getByTestId('OAuthPasteBackFlow.input'), { target: { value: 'k9' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('OAuthPasteBackFlow.submit'))
    })
    expect(window.api.vendorAuthOauthCallback).toHaveBeenCalledWith('opencode', 'anthropic', 0, 'k9')
  })

  it('on desktop: the legacy instructions + code box, no shared flow (platform pin)', async () => {
    installOpencodeApi('darwin')
    await openProviderOAuth()
    expect(screen.queryByTestId('OAuthPasteBackFlow')).toBeNull()
    expect(screen.getByPlaceholderText('Paste code here')).toBeTruthy()
    expect(window.open).toHaveBeenCalledWith(AUTHORIZE_URL, '_blank')
  })
})
