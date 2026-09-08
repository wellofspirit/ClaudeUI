/**
 * Layer 2: the ADD sheet (ADR-065 phase 6c, board `board2-ProviderAdd.png`).
 *
 * It replaced three add flows — the shared vault's custom-provider form,
 * opencode's catalog picker and pi's "Add API key" select — so what is pinned
 * here is that each of them still lands in the SAME store it always did:
 * `vendor-auth:set-key` per selected engine for a catalog pick,
 * `shared-provider:save` (+ `:set-key`) for a custom endpoint, and the ADR-057
 * OAuth pair for a subscription (that half lives in
 * `remote-oauth-settings.component.test.tsx`, which owns both platform
 * branches). Every write is asserted by CHANNEL over the real bridge where
 * `bootTestApp` carries one, and by API method for the vendor-auth family it
 * hard-stubs.
 *
 * The second thing pinned is the CANDIDATE rule: a row of this sheet is a
 * provider the user does NOT have. The registry snapshot the list renders is
 * the complement, so a configured opencode entry, a keyed pi vendor and an id
 * the shared vault owns must all be absent — offering them is how the old
 * picker ended up letting a user "add" something that was already there.
 *
 * Driven through `ProviderList`, like the Manage sheet's tests: opening from the
 * header's window event, re-reading the registry after a write and landing on
 * the new row's Manage sheet are that pair's shared contract.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, act, within } from '@testing-library/react'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { ProviderList } from '../ProviderList'
import type {
  ProviderEntry,
  ProviderRegistrySnapshot
} from '../../../../../shared/provider-registry'
import type { OpencodeProviderCatalogEntry, VendorAuthOption } from '../../../../../shared/types'
import type { SharedProviderDefinition } from '../../../../../shared/shared-provider'

// ── Fixtures ─────────────────────────────────────────────────────────

const catalogEntry = (
  over: Partial<OpencodeProviderCatalogEntry> & Pick<OpencodeProviderCatalogEntry, 'id' | 'name'>
): OpencodeProviderCatalogEntry => ({
  authState: 'unauthenticated',
  authMethods: ['api'],
  modelCount: 12,
  disabled: false,
  actions: {
    canSetCredential: true,
    canEditDeclaration: false,
    canRemove: false,
    removeKind: null
  },
  ...over
})

/** The vault's ChatGPT definition, disconnected — the sheet's Sign in row. */
const chatgptRow: ProviderEntry = {
  id: 'chatgpt',
  name: 'ChatGPT',
  origin: 'shared',
  credential: 'none',
  engines: { pi: { enabled: true }, opencode: { enabled: true } }
}

/** A pi vendor the user already keyed — never a candidate. */
const piXai: ProviderEntry = {
  id: 'pi:xai',
  name: 'xai',
  origin: 'pi-native',
  credential: 'api-key',
  engines: { pi: { enabled: true, native: true } },
  piKind: 'builtin'
}

const chatgptDefinition: SharedProviderDefinition = {
  id: 'chatgpt',
  name: 'ChatGPT',
  kind: 'subscription',
  models: [],
  managed: true,
  routes: {
    pi: { enabled: true, providerId: 'openai-codex' },
    opencode: { enabled: true, providerId: 'openai' }
  }
}

// ── Harness ──────────────────────────────────────────────────────────

let app: TestApp
let snapshot: ProviderRegistrySnapshot
let catalog: OpencodeProviderCatalogEntry[]
let definitions: SharedProviderDefinition[]
let piOptions: Record<string, VendorAuthOption[]>
let calls: Array<{ channel: string; args: unknown[] }>
let registryReads: number
let writeText: ReturnType<typeof vi.fn>

function stub(channel: string, answer: (...args: unknown[]) => unknown = () => undefined): void {
  app.bridge.ipcMain.handle(channel, async (_e: unknown, ...args: unknown[]) => {
    calls.push({ channel, args })
    return answer(...args)
  })
}

const sent = (channel: string): unknown[][] =>
  calls.filter((c) => c.channel === channel).map((c) => c.args)

/** The vendor-auth family is hard-stubbed by `bootTestApp`; spy the methods. */
const api = {
  vendorAuthSetKey: vi.fn(async (..._args: unknown[]) => {}),
  vendorAuthListOptions: vi.fn(async (engineId: unknown) =>
    engineId === 'pi' ? piOptions : { openai: [{ type: 'oauth', label: 'Sign in with OpenAI' }] }
  )
}

const called = (method: keyof typeof api): unknown[][] => api[method].mock.calls

beforeEach(async () => {
  app = await bootTestApp()
  calls = []
  registryReads = 0
  definitions = [chatgptDefinition]
  snapshot = { entries: [chatgptRow, piXai], opencodeInstalled: true }
  catalog = [
    catalogEntry({ id: 'openai', name: 'OpenAI', authMethods: ['api', 'oauth'] }),
    catalogEntry({ id: 'groq', name: 'Groq' }),
    // Already set up: a ROW of the list, never a candidate here.
    catalogEntry({ id: 'openrouter', name: 'OpenRouter', authState: 'authenticated' })
  ]
  piOptions = {
    openai: [{ type: 'api', label: 'OpenAI API key' }],
    radius: [{ type: 'api', label: 'Radius API key' }],
    // Keyed already (a `pi:xai` row), and owned by the vault — both excluded.
    xai: [{ type: 'api', label: 'xAI API key' }],
    'openai-codex': [{ type: 'oauth', label: 'Sign in with ChatGPT' }]
  }

  app.bridge.ipcMain.handle('provider-registry:list', async () => {
    registryReads += 1
    return snapshot
  })
  app.bridge.ipcMain.handle('session:get-opencode-providers', async () => catalog)
  app.bridge.ipcMain.handle('shared-provider:list', async () => definitions)
  app.bridge.ipcMain.handle('pi:binary-path', async () => '/opt/pi/bin/pi')
  app.bridge.ipcMain.handle('config:load-opencode-settings', async () => ({}))
  app.bridge.ipcMain.handle('session:get-opencode-provider-models', async () => [])
  app.bridge.ipcMain.handle('session:get-engine-models', async () => [])
  app.bridge.ipcMain.handle('config:load-engine-config', async () => ({}))
  stub('config:save-opencode-settings')
  stub('shared-provider:save')
  stub('shared-provider:set-key')

  api.vendorAuthSetKey.mockClear()
  api.vendorAuthListOptions.mockClear()
  Object.assign(window.api, api)

  writeText = vi.fn(async () => {})
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText }
  })
})

afterEach(() => {
  cleanup()
  app.teardown()
})

/** Render the list and open the Add sheet the way the group header does. */
async function openAddSheet(): Promise<HTMLElement> {
  render(<ProviderList navigate={vi.fn()} />)
  await screen.findAllByTestId('ProviderList.row')
  await act(async () => {
    window.dispatchEvent(new CustomEvent('settings:add-provider'))
  })
  return screen.getByTestId('ProviderAddSheet')
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(el)
  })
}

async function typeInto(testid: string, value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(screen.getByTestId(testid), { target: { value } })
  })
}

const catalogIds = (): (string | undefined)[] =>
  screen.queryAllByTestId('ProviderAddSheet.catalog').map((el) => el.dataset.id)

const catalogRow = (id: string): HTMLElement =>
  screen.getAllByTestId('ProviderAddSheet.catalog').find((el) => el.dataset.id === id)!

// ── Opening ──────────────────────────────────────────────────────────

describe('opening', () => {
  it('opens on the header action’s window event', async () => {
    render(<ProviderList />)
    await screen.findAllByTestId('ProviderList.row')
    expect(screen.queryByTestId('ProviderAddSheet')).not.toBeInTheDocument()

    await act(async () => {
      window.dispatchEvent(new CustomEvent('settings:add-provider'))
    })
    expect(screen.getByTestId('ProviderAddSheet')).toBeInTheDocument()
  })

  it('stops listening once unmounted — the event is global', async () => {
    const view = render(<ProviderList />)
    await screen.findAllByTestId('ProviderList.row')
    view.unmount()
    await act(async () => {
      window.dispatchEvent(new CustomEvent('settings:add-provider'))
    })
    expect(screen.queryByTestId('ProviderAddSheet')).not.toBeInTheDocument()
  })

  it('Cancel closes it', async () => {
    await openAddSheet()
    await click(screen.getByTestId('ProviderAddSheet.cancel'))
    expect(screen.queryByTestId('ProviderAddSheet')).not.toBeInTheDocument()
  })

  it('Escape closes it — and stops there, so the settings dialog stays open', async () => {
    await openAddSheet()
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })
    expect(screen.queryByTestId('ProviderAddSheet')).not.toBeInTheDocument()
    expect(screen.getByTestId('ProviderList')).toBeInTheDocument()
  })
})

// ── The list step ────────────────────────────────────────────────────

describe('the list', () => {
  it('offers the UNCONFIGURED union, with a chip per engine that offers it', async () => {
    await openAddSheet()
    // openai: both engines. groq: opencode only. radius: pi only (it is in pi's
    // option catalog and in no opencode one).
    expect(catalogIds()).toEqual(['groq', 'openai', 'radius'])

    const chips = (id: string): (string | undefined)[] =>
      within(catalogRow(id))
        .getAllByTestId('ProviderAddSheet.engineChip')
        .map((el) => el.dataset.id)
    expect(chips('openai')).toEqual(['opencode', 'pi'])
    expect(chips('groq')).toEqual(['opencode'])
    expect(chips('radius')).toEqual(['pi'])
  })

  it('never offers something the user already has', async () => {
    await openAddSheet()
    // openrouter is authenticated in opencode; xai has a pi key (and a row);
    // openai-codex is the id ChatGPT's pi route owns.
    expect(catalogIds()).not.toContain('openrouter')
    expect(catalogIds()).not.toContain('xai')
    expect(catalogIds()).not.toContain('openai-codex')
  })

  it('filters on the search box, across both sections', async () => {
    await openAddSheet()
    await typeInto('ProviderAddSheet.search', 'gro')
    expect(catalogIds()).toEqual(['groq'])
    expect(screen.queryAllByTestId('ProviderAddSheet.subscription')).toHaveLength(0)
    // …and the section itself goes, rather than leaving an empty card.
    expect(
      screen.queryAllByTestId('ProviderAddSheet.group').map((el) => el.dataset.id)
    ).not.toContain('subscriptions')

    await typeInto('ProviderAddSheet.search', 'chatgpt')
    expect(catalogIds()).toEqual([])
    expect(
      screen.getAllByTestId('ProviderAddSheet.subscription').map((el) => el.dataset.id)
    ).toEqual(['chatgpt'])
  })

  it('hides the catalog entirely when nothing offers one', async () => {
    // No opencode binary and no pi auth options: there is no catalog to show,
    // and an empty section would suggest the user had exhausted it.
    snapshot = { ...snapshot, opencodeInstalled: false }
    piOptions = {}
    await openAddSheet()
    expect(screen.queryAllByTestId('ProviderAddSheet.catalog')).toHaveLength(0)
    expect(
      screen.queryAllByTestId('ProviderAddSheet.group').map((el) => el.dataset.id)
    ).not.toContain('catalog')
    // The custom endpoint is always available — it needs no catalog.
    expect(screen.getByTestId('ProviderAddSheet.custom')).toBeInTheDocument()
  })

  it('says the catalog could not be READ, rather than that nothing is left to add', async () => {
    // Three states, never one: a rejected read used to be indistinguishable
    // from an exhausted catalog (`VendorOpencodeSection`'s own lesson).
    app.bridge.ipcMain.handle('session:get-opencode-providers', async () => {
      throw new Error('server did not answer')
    })
    piOptions = {}
    await openAddSheet()
    expect(screen.getByTestId('ProviderAddSheet.catalogEmpty')).toHaveAttribute(
      'data-id',
      'failed'
    )
    expect(screen.getByTestId('ProviderAddSheet.catalogEmpty')).toHaveTextContent(
      'could not be read'
    )
  })

  it('copies pi’s login command rather than pretending to run it', async () => {
    await openAddSheet()
    await click(screen.getByTestId('ProviderAddSheet.copyCommand'))
    expect(writeText).toHaveBeenCalledWith('"/opt/pi/bin/pi"')
  })

  it('shows ChatGPT as Connected, with no sign-in, once it is', async () => {
    snapshot = {
      ...snapshot,
      entries: [{ ...chatgptRow, credential: 'connected' }, piXai]
    }
    await openAddSheet()
    const row = screen
      .getAllByTestId('ProviderAddSheet.subscription')
      .find((el) => el.dataset.id === 'chatgpt')!
    expect(within(row).getByTestId('ProviderAddSheet.credential')).toHaveAttribute(
      'data-id',
      'connected'
    )
    expect(screen.queryByTestId('VendorOAuthFlow')).not.toBeInTheDocument()
  })
})

// ── The setup step ───────────────────────────────────────────────────

describe('the setup step', () => {
  it('writes the key into EVERY selected engine’s own auth store', async () => {
    await openAddSheet()
    await click(catalogRow('openai'))
    expect(screen.getByTestId('ProviderAddSheet.setup')).toHaveAttribute('data-id', 'openai')

    await typeInto('ProviderAddSheet.keyInput', 'sk-live')
    await click(screen.getByTestId('ProviderAddSheet.save'))
    expect(called('vendorAuthSetKey')).toEqual([
      ['opencode', 'openai', 'sk-live'],
      ['pi', 'openai', 'sk-live']
    ])
  })

  it('writes only where the chips say, when one engine is de-selected', async () => {
    await openAddSheet()
    await click(catalogRow('openai'))
    await click(
      screen.getAllByTestId('ProviderAddSheet.engines.chip').find((el) => el.dataset.id === 'pi')!
    )
    await typeInto('ProviderAddSheet.keyInput', 'sk-live')
    await click(screen.getByTestId('ProviderAddSheet.save'))
    expect(called('vendorAuthSetKey')).toEqual([['opencode', 'openai', 'sk-live']])
  })

  it('seeds an EMPTY opencode allowlist so a 300-model provider cannot flood the picker', async () => {
    await openAddSheet()
    await click(catalogRow('groq'))
    await typeInto('ProviderAddSheet.keyInput', 'sk-groq')
    await click(screen.getByTestId('ProviderAddSheet.save'))
    expect(sent('config:save-opencode-settings')).toEqual([[{ modelAllowlist: { groq: [] } }]])
  })

  it('leaves an existing allowlist alone (re-keying must not wipe curation)', async () => {
    app.bridge.ipcMain.handle('config:load-opencode-settings', async () => ({
      modelAllowlist: { groq: ['llama-4'] }
    }))
    await openAddSheet()
    await click(catalogRow('groq'))
    await typeInto('ProviderAddSheet.keyInput', 'sk-groq')
    await click(screen.getByTestId('ProviderAddSheet.save'))
    expect(sent('config:save-opencode-settings')).toEqual([])
  })

  it('writes nothing for a pi-only provider beyond pi’s own store', async () => {
    await openAddSheet()
    await click(catalogRow('radius'))
    await typeInto('ProviderAddSheet.keyInput', 'sk-radius')
    await click(screen.getByTestId('ProviderAddSheet.save'))
    expect(called('vendorAuthSetKey')).toEqual([['pi', 'radius', 'sk-radius']])
    expect(sent('config:save-opencode-settings')).toEqual([])
  })

  it('Back returns to the list without writing anything', async () => {
    await openAddSheet()
    await click(catalogRow('groq'))
    await click(screen.getByTestId('ProviderAddSheet.back'))
    expect(screen.queryByTestId('ProviderAddSheet.setup')).not.toBeInTheDocument()
    expect(catalogIds()).toContain('groq')
    expect(called('vendorAuthSetKey')).toEqual([])
  })
})

// ── The custom endpoint ──────────────────────────────────────────────

describe('the custom endpoint', () => {
  async function fillCustom(): Promise<void> {
    await openAddSheet()
    await click(screen.getByTestId('ProviderAddSheet.custom'))
    await typeInto('ProviderForm.id', 'internal-gateway')
    await typeInto('ProviderForm.name', 'Internal gateway')
    await typeInto('ProviderForm.baseUrl', 'https://llm.example/v1')
    await typeInto('ProviderForm.modelId', 'qwen3-27b')
  }

  it('saves the definition the two adapters read, and the key separately', async () => {
    await fillCustom()
    await typeInto('ProviderForm.key', 'sk-gateway')
    await click(screen.getByTestId('ProviderAddSheet.customSave'))

    expect(sent('shared-provider:save')).toEqual([
      [
        {
          id: 'internal-gateway',
          name: 'Internal gateway',
          kind: 'custom',
          protocol: 'openai-completions',
          baseUrl: 'https://llm.example/v1',
          models: [{ id: 'qwen3-27b', name: undefined }],
          routes: { pi: { enabled: true }, opencode: { enabled: true } },
          managed: true
        }
      ]
    ])
    // The key never travels inside the definition (ADR-037's plaintext vault
    // holds it; the definition is config).
    expect(sent('shared-provider:set-key')).toEqual([['internal-gateway', 'sk-gateway']])
  })

  it('turns a route off before saving, so the definition reaches one engine only', async () => {
    await fillCustom()
    await click(
      screen.getAllByTestId('ProviderForm.engines.chip').find((el) => el.dataset.id === 'opencode')!
    )
    await click(screen.getByTestId('ProviderAddSheet.customSave'))
    expect((sent('shared-provider:save')[0][0] as SharedProviderDefinition).routes).toEqual({
      pi: { enabled: true },
      opencode: { enabled: false }
    })
  })

  it('refuses a definition with no id, name or model id — and writes nothing', async () => {
    await openAddSheet()
    await click(screen.getByTestId('ProviderAddSheet.custom'))
    await click(screen.getByTestId('ProviderAddSheet.customSave'))
    expect(screen.getByTestId('ProviderForm.error')).toHaveTextContent(
      'Provider id, name, and model id are required'
    )
    expect(sent('shared-provider:save')).toEqual([])
  })

  it('saves with no key at all — a local server needs none', async () => {
    await fillCustom()
    await click(screen.getByTestId('ProviderAddSheet.customSave'))
    expect(sent('shared-provider:save')).toHaveLength(1)
    expect(sent('shared-provider:set-key')).toEqual([])
  })
})

// ── After a write ────────────────────────────────────────────────────

describe('after a write', () => {
  it('re-reads the registry, closes, and lands on the new row’s Manage sheet', async () => {
    await openAddSheet()
    const before = registryReads
    const added: ProviderEntry = {
      id: 'opencode:groq',
      name: 'Groq',
      origin: 'opencode-native',
      credential: 'api-key',
      engines: { opencode: { enabled: true, modelCount: 0, curated: true, native: true } }
    }

    await click(catalogRow('groq'))
    await typeInto('ProviderAddSheet.keyInput', 'sk-groq')
    snapshot = { ...snapshot, entries: [...snapshot.entries, added] }
    await click(screen.getByTestId('ProviderAddSheet.save'))

    expect(registryReads).toBe(before + 1)
    expect(screen.queryByTestId('ProviderAddSheet')).not.toBeInTheDocument()
    expect(screen.getAllByTestId('ProviderList.row').map((el) => el.dataset.id)).toContain(
      'opencode:groq'
    )
    // Curation is the next thing on screen — the row was added with an empty
    // allowlist, so a list that just said "0 models" would be a dead end.
    expect(screen.getByTestId('ProviderSheet')).toHaveAttribute('data-id', 'opencode:groq')
  })

  it('keeps the sheet open and reports a rejected write', async () => {
    app.bridge.ipcMain.handle('shared-provider:save', async () => {
      throw new Error('vault is read-only')
    })
    await openAddSheet()
    await click(screen.getByTestId('ProviderAddSheet.custom'))
    await typeInto('ProviderForm.id', 'gw')
    await typeInto('ProviderForm.name', 'GW')
    await typeInto('ProviderForm.modelId', 'm1')
    await click(screen.getByTestId('ProviderAddSheet.customSave'))

    expect(screen.getByTestId('ProviderAddSheet.error')).toHaveTextContent('vault is read-only')
    expect(screen.getByTestId('ProviderAddSheet')).toBeInTheDocument()
  })
})
