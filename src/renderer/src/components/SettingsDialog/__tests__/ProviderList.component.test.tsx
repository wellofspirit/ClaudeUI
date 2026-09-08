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
    opencode: { enabled: true, modelCount: 6, native: true }
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

  it('chips the engines the provider is configured for, claude → opencode → pi', async () => {
    await renderList()
    const chips = (id: string): string[] =>
      within(row(id))
        .getAllByTestId('ProviderList.engine')
        .map((el) => el.dataset.id!)
    expect(chips('anthropic')).toEqual(['claude'])
    expect(chips('chatgpt')).toEqual(['opencode', 'pi'])
    expect(chips('pi:ollama')).toEqual(['pi'])
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
    ).toEqual(['pi'])
  })

  it('keeps the card readable when the registry read fails', async () => {
    app.bridge.ipcMain.handle('provider-registry:list', async () => {
      throw new Error('registry exploded')
    })
    render(<ProviderList />)
    expect(await screen.findByTestId('ProviderList.error')).toHaveTextContent('registry exploded')
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
