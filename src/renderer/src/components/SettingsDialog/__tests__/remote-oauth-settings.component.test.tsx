/**
 * The SETTINGS half of ADR-057 / S4-UI — the two provider/account panes that
 * can start an OAuth flow from a remote client.
 *
 * 1. Accounts › + Add account. `account:add` starts a login host-side, and the
 *    URL a remote user needs rides back on the RESPONSE (`pendingSignIn`) rather
 *    than on the host-local `auth:state` event. The pane folds it into the
 *    store's `authState` — the same field AuthBanner drives — so the Claude flow
 *    still has exactly one state.
 * 2. Models & providers › the two provider SHEETS (ADR-065 phase 6c): the Add
 *    sheet's catalog pick and the Manage sheet's re-authorise, whose OAuth
 *    button parks the shared paste-back flow on web and keeps its own local
 *    instructions UI on desktop.
 *
 * Both directions of each platform branch are pinned.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { SECTIONS } from '../settings-sections'
import { ProviderList } from '../ProviderList'
import { useSessionStore } from '../../../stores/session-store'
import type { OpencodeProviderCatalogEntry } from '../../../../../shared/types'
import type { ProviderEntry } from '../../../../../shared/provider-registry'

vi.mock('electron', async () => await import('../../../../../test/stubs/electron-shim'))

function renderSection(id: string): void {
  const section = SECTIONS.find((s) => s.id === id)!
  render(
    section.items[0].render(
      {} as never,
      () => {},
      {} as never,
      () => {},
      {} as never,
      () => {}
    )
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

/**
 * The pane's ROWS, after ADR-065 phase 3A. It was a stack of bordered cards with
 * 12px/10px text and an icon-only trash can; it is now `SettingRow`s — a radio
 * per account, the plan as the description, and a named destructive Button.
 *
 * `as="label"` rather than `as="button"` is load-bearing: the row carries a real
 * Remove BUTTON, and a button inside a button is invalid HTML.
 */
describe('Settings › Accounts — the rows', () => {
  const TWO = {
    enabled: true,
    activeId: 'a2',
    accounts: [
      {
        id: 'a1',
        email: 'one@example.com',
        subscriptionType: 'Claude Team',
        organization: null,
        createdAt: 0
      },
      {
        id: 'a2',
        email: 'two@example.com',
        subscriptionType: 'Claude Max',
        organization: null,
        createdAt: 0
      }
    ]
  }

  function installTwoAccounts(over: Record<string, unknown> = {}): void {
    installAccountsApi('darwin', {
      getAccounts: vi.fn(async () => TWO),
      switchAccount: vi.fn(async () => TWO),
      deleteAccount: vi.fn(async () => TWO),
      setMultiAccountEnabled: vi.fn(async () => TWO),
      ...over
    })
  }

  function row(id: string): HTMLElement {
    const found = screen
      .getAllByTestId('AccountsSetting.accountRow')
      .find((el) => el.getAttribute('data-id') === id)
    expect(found, `accountRow ${id}`).toBeTruthy()
    return found!
  }

  beforeEach(() => {
    useSessionStore.setState({ accountsState: null, authState: null })
  })

  it('renders one row per account, the active one selected', async () => {
    installTwoAccounts()
    await act(async () => renderSection('accounts'))

    expect(
      screen.getAllByTestId('AccountsSetting.accountRow').map((el) => el.getAttribute('data-id'))
    ).toEqual(['a1', 'a2'])
    expect(row('a2').textContent).toContain('two@example.com')
    expect(row('a2').textContent).toContain('Claude Max')

    // A real radio, so the group is keyboard- and screen-reader-navigable.
    const radios = screen.getAllByRole('radio') as HTMLInputElement[]
    expect(radios.map((r) => r.value)).toEqual(['a1', 'a2'])
    expect(radios.find((r) => r.value === 'a2')!.checked).toBe(true)
  })

  it('picking a row switches account; Remove deletes THAT account only', async () => {
    installTwoAccounts()
    await act(async () => renderSection('accounts'))

    const inactive = (screen.getAllByRole('radio') as HTMLInputElement[]).find(
      (r) => r.value === 'a1'
    )!
    await act(async () => {
      fireEvent.click(inactive)
    })
    expect(window.api.switchAccount).toHaveBeenCalledWith('a1')

    const remove = screen
      .getAllByTestId('AccountsSetting.removeAccount')
      .find((el) => el.getAttribute('data-id') === 'a1')!
    await act(async () => {
      fireEvent.click(remove)
    })
    expect(window.api.deleteAccount).toHaveBeenCalledWith('a1')
  })

  it('never nests a button inside a button (the Remove-in-a-row hazard)', async () => {
    installTwoAccounts()
    await act(async () => renderSection('accounts'))

    for (const button of Array.from(document.querySelectorAll('button'))) {
      expect(button.querySelector('button')).toBeNull()
    }
  })

  it('shows only the master toggle while multi-account is OFF', async () => {
    installAccountsApi('darwin', {
      getAccounts: vi.fn(async () => ({ ...TWO, enabled: false }))
    })
    await act(async () => renderSection('accounts'))

    expect(screen.getByTestId('AccountsSetting.multiAccount')).toBeTruthy()
    expect(screen.queryAllByTestId('AccountsSetting.accountRow')).toHaveLength(0)
    expect(screen.queryByTestId('AccountsSetting.addAccount')).toBeNull()
  })
})

// ── The provider sheets ──────────────────────────────────────────────────

/**
 * SURFACE MOVED, CONTRACT KEPT. These four cases used to drive
 * `VendorOpencodeSection` — its catalog picker's inline OAuth panel, and the
 * same flow re-hosted in the provider configuration dialog. ADR-065 phase 6c
 * retired that pane: acquiring a provider is the ADD sheet's job and
 * re-authorising an existing one is the MANAGE sheet's, and both render the one
 * `VendorOAuthFlow`. The behaviours pinned here are unchanged — on web the
 * shared paste-back flow replaces the local instructions UI and the pasted
 * string reaches `vendor-auth:oauth-callback` verbatim; on desktop the local
 * code box survives and the host opens the browser.
 */

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

/** The Manage sheet's subject: the same provider, already signed in. */
const CONNECTED_ROW: ProviderEntry = {
  id: 'opencode:anthropic',
  name: 'Anthropic',
  origin: 'opencode-native',
  credential: 'connected',
  engines: { opencode: { enabled: true, native: true } }
}

function installOpencodeApi(
  platform: string,
  entries: ProviderEntry[] = [],
  over: Record<string, unknown> = {}
): void {
  ;(globalThis as unknown as { window: Record<string, unknown> }).window.api = {
    platform,
    engineIsInstalled: vi.fn(async () => true),
    listProviderRegistry: vi.fn(async () => ({ entries, opencodeInstalled: true })),
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
    vendorAuthSetKey: vi.fn(async () => {}),
    getOpencodeProviderModels: vi.fn(async () => []),
    listSharedProviders: vi.fn(async () => []),
    getPiBinaryPath: vi.fn(async () => null),
    // The row's credential-kind badge reads opencode's auth store.
    vendorAuthListKeys: vi.fn(async () => ({})),
    // Orphan-guard inputs (the sheet's model curation reads these).
    getEngineModels: vi.fn(async () => []),
    loadEngineConfig: vi.fn(async () => ({})),
    ...over
  }
  ;(globalThis as unknown as { window: Record<string, unknown> }).window.open = vi.fn()
}

/** Open the Add sheet the way the group header does, and pick the catalog row. */
async function openAddSheetOAuth(platform: string): Promise<void> {
  installOpencodeApi(platform)
  await act(async () => {
    render(<ProviderList />)
  })
  await act(async () => {
    window.dispatchEvent(new CustomEvent('settings:add-provider'))
  })
  await act(async () => {
    fireEvent.click(
      screen.getAllByTestId('ProviderAddSheet.catalog').find((el) => el.dataset.id === 'anthropic')!
    )
  })
  await act(async () => {
    fireEvent.click(screen.getByTestId('VendorOAuthFlow.start'))
  })
}

/**
 * The SECOND host of the same flow: an already-connected provider re-authing
 * from its Manage sheet. That affordance used to be an inline panel on the
 * pane's row, then a block in the configuration dialog; it is the sheet's
 * credential group now, and the flow machinery is one component shared with the
 * Add sheet — so this pins that the move did not fork it.
 */
async function reauthFromSheet(platform: string): Promise<void> {
  installOpencodeApi(platform, [CONNECTED_ROW])
  await act(async () => {
    render(<ProviderList />)
  })
  await act(async () => {
    fireEvent.click(await screen.findByTestId('ProviderList.manage'))
  })
  await act(async () => {
    fireEvent.click(await screen.findByTestId('VendorOAuthFlow.start'))
  })
}

describe('Settings › the provider sheets — opencode OAuth', () => {
  beforeEach(() => {
    useSessionStore.setState({ vendorOAuth: null })
  })

  it('on web: the shared paste-back flow replaces the local instructions UI', async () => {
    await openAddSheetOAuth('web')
    const flow = screen.getByTestId('OAuthPasteBackFlow')
    expect(flow).toHaveAttribute('data-variant', 'url')
    expect(flow).toHaveAttribute('data-id', 'anthropic')
    // The desktop-only local UI is NOT also on screen.
    expect(screen.queryByPlaceholderText('Paste code here')).toBeNull()

    fireEvent.change(screen.getByTestId('OAuthPasteBackFlow.input'), { target: { value: 'k9' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('OAuthPasteBackFlow.submit'))
    })
    expect(window.api.vendorAuthOauthCallback).toHaveBeenCalledWith(
      'opencode',
      'anthropic',
      0,
      'k9'
    )
  })

  it('on desktop: the legacy instructions + code box, no shared flow (platform pin)', async () => {
    await openAddSheetOAuth('darwin')
    expect(screen.queryByTestId('OAuthPasteBackFlow')).toBeNull()
    expect(screen.getByPlaceholderText('Paste code here')).toBeTruthy()
    expect(window.open).toHaveBeenCalledWith(AUTHORIZE_URL, '_blank')

    fireEvent.change(screen.getByTestId('VendorOAuthFlow.code'), { target: { value: 'k9' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('VendorOAuthFlow.submit'))
    })
    expect(window.api.vendorAuthOauthCallback).toHaveBeenCalledWith(
      'opencode',
      'anthropic',
      0,
      'k9'
    )
  })

  it('on web: re-authing from the Manage sheet parks the same paste-back flow', async () => {
    await reauthFromSheet('web')
    // Inside the sheet, not on the list behind it.
    const sheet = screen.getByTestId('ProviderSheet')
    const flow = within(sheet).getByTestId('OAuthPasteBackFlow')
    expect(flow).toHaveAttribute('data-variant', 'url')
    expect(flow).toHaveAttribute('data-id', 'anthropic')

    fireEvent.change(within(sheet).getByTestId('OAuthPasteBackFlow.input'), {
      target: { value: 'k9' }
    })
    await act(async () => {
      fireEvent.click(within(sheet).getByTestId('OAuthPasteBackFlow.submit'))
    })
    expect(window.api.vendorAuthOauthCallback).toHaveBeenCalledWith(
      'opencode',
      'anthropic',
      0,
      'k9'
    )
  })

  it('on desktop: re-authing from the Manage sheet keeps the local code box', async () => {
    await reauthFromSheet('darwin')
    const sheet = screen.getByTestId('ProviderSheet')
    expect(within(sheet).queryByTestId('OAuthPasteBackFlow')).toBeNull()
    expect(within(sheet).getByPlaceholderText('Paste code here')).toBeTruthy()
  })
})
