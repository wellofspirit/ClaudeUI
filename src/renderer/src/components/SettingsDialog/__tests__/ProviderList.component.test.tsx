/**
 * Layer 2: the unified provider LIST (ADR-065 phase 6b, board `board2-Main.png`).
 *
 * The list is a pure projection of `provider-registry:list` onto the row
 * vocabulary, so what is pinned here is the projection: which rows appear and in
 * what order, what the credential badge and the engine chips say, what happens
 * to the opencode chips when opencode is not installed, and which of the two
 * things Manage does (a sheet for every provider, a NAVIGATION for Anthropic —
 * accounts already have a home).
 *
 * The real container is booted so the read goes over the real channel: a list
 * whose contract with main drifted is exactly the failure this must catch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, act, within } from '@testing-library/react'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { ProviderList } from '../ProviderList'
import { useSessionStore } from '../../../stores/session-store'
import { UNKNOWN_PROVIDER_AUTH } from '../../../utils/sign-in-provider'
import type {
  ProviderEntry,
  ProviderRegistrySnapshot
} from '../../../../../shared/provider-registry'

const anthropic: ProviderEntry = {
  id: 'anthropic',
  name: 'Anthropic',
  origin: 'anthropic',
  credential: 'signed-in',
  engines: { claude: { enabled: true } },
  detail: 'Claude Max · dev@acme.com'
}

const chatgpt: ProviderEntry = {
  id: 'chatgpt',
  name: 'ChatGPT',
  origin: 'shared',
  credential: 'connected',
  engines: {
    pi: { enabled: true, modelCount: 4, native: true },
    opencode: { enabled: true, modelCount: 6, native: true },
    // The registry projects Codex onto the ChatGPT row since F14: it is fed by
    // vault injection and follows the ACTIVE account.
    codex: { enabled: true }
  },
  detail: 'ChatGPT subscription · shared with pi and opencode'
}

const openrouter: ProviderEntry = {
  id: 'opencode:openrouter',
  name: 'OpenRouter',
  origin: 'opencode-native',
  credential: 'api-key',
  engines: { opencode: { enabled: true, modelCount: 2, curated: true, native: true } },
  detail: '2 of 300 models shown in the picker',
  opencodeRemoveKind: 'credential'
}

const ollama: ProviderEntry = {
  id: 'pi:ollama',
  name: 'ollama',
  origin: 'pi-native',
  credential: 'api-key',
  engines: { pi: { enabled: true, native: true } },
  detail: 'Custom pi provider',
  piKind: 'custom'
}

let app: TestApp
let snapshot: ProviderRegistrySnapshot

const row = (id: string): HTMLElement =>
  screen.getAllByTestId('ProviderList.row').find((el) => el.dataset.id === id)!

beforeEach(async () => {
  app = await bootTestApp()
  // The snapshot lives in the store now (F12) and the store is a module
  // singleton that outlives `teardown()`: without this, a case would start on
  // the rows the previous one left behind.
  useSessionStore.setState({ providerRegistry: null })
  snapshot = { entries: [anthropic, chatgpt, openrouter, ollama], opencodeInstalled: true }
  app.bridge.ipcMain.handle('provider-registry:list', async () => snapshot)
  // The sheet's own reads, for the tests that open it.
  app.bridge.ipcMain.handle('shared-provider:list', async () => [])
  app.bridge.ipcMain.handle('session:get-opencode-provider-models', async () => [])
  app.bridge.ipcMain.handle('config:load-opencode-settings', async () => ({}))
  app.bridge.ipcMain.handle('session:get-engine-models', async () => [])
  app.bridge.ipcMain.handle('config:load-engine-config', async () => ({}))
})

afterEach(() => {
  cleanup()
  app.teardown()
})

async function renderList(navigate = vi.fn()): Promise<{ navigate: ReturnType<typeof vi.fn> }> {
  render(<ProviderList navigate={navigate} />)
  await screen.findAllByTestId('ProviderList.row')
  return { navigate }
}

describe('the rows', () => {
  it('shows one loading row until the registry answers', async () => {
    render(<ProviderList />)
    expect(screen.getByTestId('ProviderList.loading')).toBeInTheDocument()
    expect(screen.queryAllByTestId('ProviderList.row')).toHaveLength(0)
    await screen.findAllByTestId('ProviderList.row')
    expect(screen.queryByTestId('ProviderList.loading')).not.toBeInTheDocument()
  })

  it('renders one row per entry, in the registry’s order', async () => {
    await renderList()
    expect(screen.getAllByTestId('ProviderList.row').map((el) => el.dataset.id)).toEqual([
      'anthropic',
      'chatgpt',
      'opencode:openrouter',
      'pi:ollama'
    ])
    expect(row('anthropic')).toHaveTextContent('Anthropic')
    expect(row('anthropic')).toHaveTextContent('Claude Max · dev@acme.com')
  })

  it('badges the credential by KIND, so the badge id is the state', async () => {
    await renderList()
    const badge = (id: string): HTMLElement =>
      within(row(id)).getByTestId('ProviderList.credential')
    expect(badge('anthropic')).toHaveAttribute('data-id', 'signed-in')
    expect(badge('anthropic')).toHaveTextContent('Signed in')
    expect(badge('chatgpt')).toHaveAttribute('data-id', 'connected')
    expect(badge('opencode:openrouter')).toHaveTextContent('API key')
  })

  it('a multi-account subscription counts its accounts on the badge (ADR-068 §2)', async () => {
    snapshot = {
      ...snapshot,
      entries: snapshot.entries.map((e) =>
        e.id === 'chatgpt'
          ? {
              ...e,
              accounts: {
                activeId: 'acc-1',
                perSession: false,
                list: [{ id: 'acc-1', email: 'a@example.com' }, { id: 'acc-2' }]
              }
            }
          : e
      )
    }
    await renderList()
    const badge = within(row('chatgpt')).getByTestId('ProviderList.credential')
    expect(badge).toHaveTextContent('2 accounts')
    // Still the connected STATE — only the wording changes.
    expect(badge).toHaveAttribute('data-id', 'connected')
  })

  it('chips the engines the provider is configured for, claude → opencode → pi → codex', async () => {
    // Codex is fed by vault injection, not by a shared route (ADR-068 §1), so
    // the chip has to be LAST in the order and present on the ChatGPT row —
    // without it the row reads as "this subscription is not available to Codex".
    await renderList()
    const chips = (id: string): string[] =>
      within(row(id))
        .getAllByTestId('ProviderList.engine')
        .map((el) => el.dataset.id!)
    expect(chips('anthropic')).toEqual(['claude'])
    expect(chips('chatgpt')).toEqual(['opencode', 'pi', 'codex'])
    expect(chips('pi:ollama')).toEqual(['pi'])
  })

  it('dims the Codex chip when no ChatGPT account is active (F14)', async () => {
    snapshot = {
      entries: [
        {
          ...chatgpt,
          engines: {
            opencode: { enabled: true },
            pi: { enabled: true },
            codex: { enabled: false }
          }
        }
      ],
      opencodeInstalled: true
    }
    await renderList()
    const codex = within(row('chatgpt'))
      .getAllByTestId('ProviderList.engine')
      .find((el) => el.dataset.id === 'codex')!
    expect(codex).toHaveTextContent('Codex')
    expect(codex).toHaveAttribute('data-enabled', 'false')
    expect(codex.className).toContain('opacity-50')
  })

  it('dims the chip of an engine the provider does not currently reach', async () => {
    snapshot = {
      entries: [{ ...chatgpt, engines: { opencode: { enabled: false }, pi: { enabled: true } } }],
      opencodeInstalled: true
    }
    await renderList()
    const chip = (engine: string): HTMLElement =>
      within(row('chatgpt'))
        .getAllByTestId('ProviderList.engine')
        .find((el) => el.dataset.id === engine)!
    expect(chip('opencode')).toHaveAttribute('data-enabled', 'false')
    expect(chip('opencode').className).toContain('opacity-50')
    expect(chip('pi')).toHaveAttribute('data-enabled', 'true')
    expect(chip('pi').className).not.toContain('opacity-50')
  })

  it('appends the diagnosis to the row line, naming the cause and the fix', async () => {
    // A bare "0 models" is what made this class of failure opaque.
    snapshot = {
      entries: [{ ...chatgpt, diagnosis: 'provider-disabled' }],
      opencodeInstalled: true
    }
    await renderList()
    expect(row('chatgpt')).toHaveTextContent('ChatGPT subscription · shared with pi and opencode')
    expect(row('chatgpt')).toHaveTextContent('Disabled in the engine')
  })

  it('has a distinct sentence for each diagnosis the registry can report', async () => {
    // Carried from the retired shared-provider pane's own guard: each string
    // names the CAUSE first, so it stays legible truncated, and says where the
    // fix is. Two of the three had no coverage once that pane went.
    for (const [diagnosis, text] of [
      ['models-restricted', 'Every model is filtered out'],
      ['no-credential', 'pi reports no models for this provider'],
      ['no-models-discovered', 'The engine reported no models']
    ] as const) {
      snapshot = { entries: [{ ...chatgpt, diagnosis }], opencodeInstalled: true }
      await renderList()
      expect(row('chatgpt')).toHaveTextContent(text)
      cleanup()
    }
  })

  it('says opencode is not installed ONCE, and drops every opencode chip', async () => {
    // The one degraded case (owner ruling 2): a stopped server is not degraded.
    snapshot = { entries: [chatgpt, ollama], opencodeInstalled: false }
    await renderList()
    const notInstalled = screen.getByTestId('ProviderList.notInstalled')
    expect(notInstalled).toHaveTextContent('opencode is not installed.')
    expect(
      within(row('chatgpt'))
        .getAllByTestId('ProviderList.engine')
        .map((el) => el.dataset.id)
      // Codex does not go through opencode, so a missing opencode binary says
      // nothing about it.
    ).toEqual(['pi', 'codex'])
  })

  it('keeps the card readable when the registry read fails', async () => {
    app.bridge.ipcMain.handle('provider-registry:list', async () => {
      throw new Error('registry exploded')
    })
    render(<ProviderList />)
    expect(await screen.findByTestId('ProviderList.error')).toHaveTextContent('registry exploded')
  })

  it('keeps the rows it already has when a RE-read fails', async () => {
    // Blanking a list the user is looking at is worse than showing rows that
    // may be a moment old — and the failure is still said out loud.
    await renderList()
    app.bridge.ipcMain.handle('provider-registry:list', async () => {
      throw new Error('registry exploded')
    })
    await act(async () => {
      fireEvent.click(
        screen.getAllByTestId('ProviderList.manage').find((el) => el.dataset.id === 'chatgpt')!
      )
    })
    // A sheet write routes through the same re-read.
    app.bridge.ipcMain.handle('shared-provider:set-route', async () => undefined)
    await act(async () => {
      fireEvent.click(
        screen
          .getAllByTestId('ProviderSheet.engineToggle')
          .find((el) => el.closest('[data-id="pi"]'))!
      )
    })
    expect(await screen.findByTestId('ProviderList.error')).toHaveTextContent('registry exploded')
    expect(screen.getAllByTestId('ProviderList.row').map((el) => el.dataset.id)).toEqual([
      'anthropic',
      'chatgpt',
      'opencode:openrouter',
      'pi:ollama'
    ])
  })
})

describe('Manage', () => {
  const manage = (id: string): HTMLElement =>
    screen.getAllByTestId('ProviderList.manage').find((el) => el.dataset.id === id)!

  it('opens the sheet for the row it belongs to', async () => {
    await renderList()
    await act(async () => {
      fireEvent.click(manage('opencode:openrouter'))
    })
    const sheet = screen.getByTestId('ProviderSheet')
    expect(sheet).toHaveAttribute('data-id', 'opencode:openrouter')
    expect(sheet).toHaveTextContent('OpenRouter')
  })

  it('navigates to Accounts for Anthropic instead of opening a sheet', async () => {
    // Sign-in, switching and the endpoint override are already whole surfaces;
    // a sheet whose only content was a link would be a detour.
    const { navigate } = await renderList()
    await act(async () => {
      fireEvent.click(manage('anthropic'))
    })
    expect(navigate).toHaveBeenCalledWith({ page: 'models', group: 'accounts' })
    expect(screen.queryByTestId('ProviderSheet')).not.toBeInTheDocument()
  })
})

/**
 * The composer's hint and the model picker's Sign in item read the SAME
 * registry through the store (ADR-068 §3, Slice 6), and it publishes no change
 * event. Every sheet write lands on this component's re-read, so the store
 * refresh has to happen here or those surfaces go stale behind an open settings
 * dialog — with the picker still offering a sign-in the user just completed.
 */
describe('the store’s provider-auth view', () => {
  beforeEach(() => {
    useSessionStore.setState({ providerAuth: UNKNOWN_PROVIDER_AUTH })
  })

  it('is refreshed from the same read the list makes', async () => {
    await renderList()
    expect(useSessionStore.getState().providerAuth.chatgpt).toBe('authenticated')
    expect(useSessionStore.getState().providerAuth.chatgptRoutes).toEqual({
      pi: true,
      opencode: true,
      // Not a route at all — but it is in `engines`, and the view projects
      // whatever the registry put there. Only pi/opencode are read back
      // (`signInProviderFor`), so the extra key gates nothing.
      codex: true
    })
  })

  it('follows a real sheet write, through the same re-read', async () => {
    app.bridge.ipcMain.handle('shared-provider:set-route', async () => undefined)
    await renderList()
    await act(async () => {
      fireEvent.click(
        screen.getAllByTestId('ProviderList.manage').find((el) => el.dataset.id === 'chatgpt')!
      )
    })
    // What the NEXT read will answer — the write itself is stubbed.
    snapshot = {
      entries: [anthropic, { ...chatgpt, credential: 'none' }, openrouter, ollama],
      opencodeInstalled: true
    }
    const piToggle = screen
      .getAllByTestId('ProviderSheet.engineToggle')
      .find((el) => el.closest('[data-id="pi"]'))!
    await act(async () => {
      fireEvent.click(piToggle)
    })
    await vi.waitFor(() =>
      expect(useSessionStore.getState().providerAuth.chatgpt).toBe('unauthenticated')
    )
  })
})

/**
 * F12 — the sheet's "+ Add account" hands over to the ONE sign-in dialog
 * (ADR-068 §3), which is not a sheet write and so never reached this list's own
 * re-read. The dialog's close is the one moment every outcome passes through,
 * and the store already refreshes there; what was missing is that the refresh
 * had nowhere the LIST could read it from. The sheet is still open while all of
 * this happens, so a stale entry is a stale row the user is looking at.
 */
describe('a sign-in completed from the sheet', () => {
  const oneAccount = {
    activeId: 'acc-1',
    perSession: false,
    list: [{ id: 'acc-1', email: 'daniel@example.com' }]
  }
  const twoAccounts = {
    ...oneAccount,
    list: [...oneAccount.list, { id: 'acc-2', email: 'work@example.com' }]
  }
  const withAccounts = (accounts: ProviderEntry['accounts']): ProviderRegistrySnapshot => ({
    entries: [anthropic, { ...chatgpt, accounts }, openrouter, ollama],
    opencodeInstalled: true
  })

  beforeEach(() => {
    // The sheet only renders account rows for a SUBSCRIPTION definition; the
    // file's default stub answers no definitions at all.
    app.bridge.ipcMain.handle('shared-provider:list', async () => [
      {
        id: 'chatgpt',
        name: 'ChatGPT',
        kind: 'subscription',
        models: [],
        managed: true,
        routes: { pi: { enabled: true }, opencode: { enabled: true } }
      }
    ])
  })

  it('reaches the open sheet when the dialog closes', async () => {
    snapshot = withAccounts(oneAccount)
    await renderList()
    await act(async () => {
      fireEvent.click(
        screen.getAllByTestId('ProviderList.manage').find((el) => el.dataset.id === 'chatgpt')!
      )
    })
    // Since F14 the sheet's Accounts card is one link row, and its COUNT is
    // what goes stale — the rows themselves moved to the Accounts page.
    expect(screen.getByTestId('ProviderSheet.accountsLink')).toHaveTextContent('1 account')

    // The dialog is opened from the Accounts page now; no sheet write happens.
    await act(async () => {
      useSessionStore.getState().openSignIn({ providerId: 'chatgpt', mode: 'add' })
    })
    expect(useSessionStore.getState().signInDialog).toEqual({
      providerId: 'chatgpt',
      mode: 'add'
    })

    // The sign-in lands: the vault now holds two accounts.
    snapshot = withAccounts(twoAccounts)
    await act(async () => {
      useSessionStore.getState().closeSignIn()
    })
    await vi.waitFor(() =>
      expect(screen.getByTestId('ProviderSheet.accountsLink')).toHaveTextContent('2 accounts')
    )
  })
})
