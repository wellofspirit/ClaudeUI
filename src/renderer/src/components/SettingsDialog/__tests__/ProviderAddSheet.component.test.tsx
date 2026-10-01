/**
 * Layer 2: the ADD sheet (ADR-065 phase 6c, board `board2-ProviderAdd.png`).
 *
 * It replaced three add flows — the shared vault's custom-provider form,
 * opencode's catalog picker and pi's "Add API key" select — so what is pinned
 * here is that each of them still lands in the SAME store it always did:
 * one `catalog` definition plus ONE `shared-provider:set-key` for a catalog pick
 * (ADR-074 §6 — the key is stored once and delivered to each engine),
 * `shared-provider:save` (+ `:set-key`) for a custom endpoint, and the ADR-057
 * OAuth pair for a subscription (that half lives in
 * `remote-oauth-settings.component.test.tsx`, which owns both platform
 * branches). Every write is asserted by CHANNEL over the real bridge where
 * `bootTestApp` carries one, and by API method for the vendor-auth family it
 * hard-stubs.
 *
 * The second thing pinned is the CANDIDATE rule: a row of this sheet is a
 * provider ClaudeUI does not MANAGE yet (owner ruling 2026-10-01, S7f). An id
 * the shared vault owns is absent; a harness that holds its own key for the
 * vendor — an authenticated opencode entry, a keyed pi vendor — is still
 * offered, says so, and creating asks before that key is replaced.
 *
 * Driven through `ProviderList`, like the Manage sheet's tests: opening from the
 * header's window event, re-reading the registry after a write and landing on
 * the new row's Manage sheet are that pair's shared contract.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, act, within } from '@testing-library/react'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { harnessSnapshot } from '@test/helpers/harness-snapshot'
import { harnessStore } from '../harness-store'
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
/**
 * `shared-provider:own-key-holders` — who holds an own key for a vendor in the
 * harnesses' FILES right now (S7f round 3), by vendor id.
 */
let holders: Record<string, string[]>
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
    catalogEntry({ id: 'deepseek', name: 'DeepSeek' }),
    catalogEntry({ id: 'groq', name: 'Groq' }),
    // Already set up: a ROW of the list, never a candidate here.
    catalogEntry({ id: 'openrouter', name: 'OpenRouter', authState: 'authenticated' })
  ]
  piOptions = {
    openai: [{ type: 'api', label: 'OpenAI API key' }],
    deepseek: [{ type: 'api', label: 'DeepSeek API key' }],
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
  holders = {}
  stub('shared-provider:own-key-holders', (id) => holders[id as string] ?? [])
  app.bridge.ipcMain.handle('shared-provider:list', async () => definitions)
  app.bridge.ipcMain.handle('pi:binary-path', async () => '/opt/pi/bin/pi')
  app.bridge.ipcMain.handle('config:load-opencode-settings', async () => ({}))
  app.bridge.ipcMain.handle('session:get-opencode-provider-models', async () => [])
  app.bridge.ipcMain.handle('session:get-engine-models', async () => [])
  app.bridge.ipcMain.handle('config:load-engine-config', async () => ({}))
  stub('config:save-opencode-settings')
  stub('models:set-provider-allowlist')
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
  harnessStore.resetForTests()
})

/** The harness store says these do not run — read before the sheet opens, as in the app. */
async function harnessMissing(missing: Parameters<typeof harnessSnapshot>[0]): Promise<void> {
  app.bridge.ipcMain.handle('harness:state', async () => harnessSnapshot(missing))
  await act(async () => {
    await harnessStore.refresh()
  })
}

/** Render the list and open the Add sheet the way the group header does. */
async function openAddSheet(): Promise<HTMLElement> {
  render(<ProviderList />)
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
  it('offers everything ClaudeUI does not manage, with a chip per engine that offers it', async () => {
    await openAddSheet()
    // deepseek: both engines. groq: opencode only. radius: pi only (it is in pi's
    // option catalog and in no opencode one). openai: pi only — ChatGPT's
    // ENABLED opencode route already delivers to opencode's `openai`. openrouter
    // (opencode holds its own key) and xai (pi does) are offered too (S7f).
    expect(catalogIds()).toEqual(['deepseek', 'groq', 'openai', 'openrouter', 'radius', 'xai'])

    const chips = (id: string): (string | undefined)[] =>
      within(catalogRow(id))
        .getAllByTestId('ProviderAddSheet.engineChip')
        .map((el) => el.dataset.id)
    expect(chips('deepseek')).toEqual(['opencode', 'pi'])
    expect(chips('openai')).toEqual(['pi'])
    expect(chips('groq')).toEqual(['opencode'])
    expect(chips('radius')).toEqual(['pi'])
  })

  it('never offers an id ClaudeUI already manages', async () => {
    await openAddSheet()
    // openai-codex is the id ChatGPT's pi route owns.
    expect(catalogIds()).not.toContain('openai-codex')
  })

  it('offers a harness that holds its own key, and says so — by name, never raw id', async () => {
    await openAddSheet()
    expect(catalogRow('openrouter')).toHaveTextContent('opencode has its own key for OpenRouter')
    // pi ships no display names: title-cased, not `xai`.
    expect(catalogRow('xai')).toHaveTextContent('Xai')
    expect(catalogRow('xai')).toHaveTextContent('pi has its own key for Xai')
    expect(catalogRow('deepseek')).not.toHaveTextContent('own key')
  })

  it('filters on the search box, across both sections', async () => {
    await openAddSheet()
    await typeInto('ProviderAddSheet.search', 'gro')
    expect(catalogIds()).toEqual(['groq'])
    expect(screen.queryAllByTestId('ProviderAddSheet.engineSignIn')).toHaveLength(0)
    // …and the section itself goes, rather than leaving an empty card.
    expect(
      screen.queryAllByTestId('ProviderAddSheet.group').map((el) => el.dataset.id)
    ).not.toContain('engine-sign-ins')

    await typeInto('ProviderAddSheet.search', 'claude')
    expect(catalogIds()).toEqual([])
    expect(
      screen.getAllByTestId('ProviderAddSheet.engineSignIn').map((el) => el.dataset.id)
    ).toEqual(['claude-pi'])
  })

  // ADR-074 §7: a sign-in subscription has its own card, with its accounts; the
  // Add sheet is for API providers and engine-owned sign-ins only.
  it('offers no sign-in subscription — ChatGPT is added from its card', async () => {
    await openAddSheet()
    await typeInto('ProviderAddSheet.search', 'chatgpt')
    expect(
      screen.queryAllByTestId('ProviderAddSheet.group').map((el) => el.dataset.id)
    ).not.toContain('subscriptions')
    expect(screen.queryByTestId('ProviderAddSheet.chatgptSignIn')).not.toBeInTheDocument()
    expect(screen.getByTestId('ProviderAddSheet')).not.toHaveTextContent('ChatGPT · Codex')
  })

  it('hides the catalog entirely when nothing offers one', async () => {
    // opencode not installed and no pi auth options: there is no catalog to
    // show, and an empty section would suggest the user had exhausted it.
    await harnessMissing(['opencode'])
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
    expect(screen.getByTestId('ProviderAddSheet.catalogEmpty')).toHaveAttribute('data-id', 'failed')
    expect(screen.getByTestId('ProviderAddSheet.catalogEmpty')).toHaveTextContent(
      'could not be read'
    )
  })

  it('reads no catalog from a harness that does not run (ADR-082 §8)', async () => {
    await harnessMissing(['pi'])
    await openAddSheet()
    // groq, deepseek and openrouter come from opencode; the pi-only ones
    // (openai, radius, xai) and pi's chip on deepseek are gone, and so is pi's
    // own sign-in row.
    expect(catalogIds()).toEqual(['deepseek', 'groq', 'openrouter'])
    expect(
      within(catalogRow('deepseek'))
        .getAllByTestId('ProviderAddSheet.engineChip')
        .map((el) => el.dataset.id)
    ).toEqual(['opencode'])
    expect(screen.queryByTestId('ProviderAddSheet.copyCommand')).toBeNull()
    expect(screen.getByTestId('ProviderAddSheet').textContent).not.toMatch(/not installed/)
  })

  it('copies pi’s login command rather than pretending to run it', async () => {
    await openAddSheet()
    await click(screen.getByTestId('ProviderAddSheet.copyCommand'))
    expect(writeText).toHaveBeenCalledWith('"/opt/pi/bin/pi"')
  })
})

// ── The setup step ───────────────────────────────────────────────────

describe('the setup step', () => {
  /** The catalog definition the sheet saves for a pick, routes per chosen engine. */
  const catalogDefinition = (
    id: string,
    name: string,
    routes: { pi: boolean; opencode: boolean }
  ): SharedProviderDefinition => ({
    id,
    name,
    kind: 'catalog',
    models: [],
    managed: true,
    routes: { pi: { enabled: routes.pi }, opencode: { enabled: routes.opencode } }
  })

  it('stores the key ONCE: a catalog definition with a route per engine, then one set-key', async () => {
    await openAddSheet()
    expect(screen.getByTestId('ProviderAddSheet.steps')).toHaveAttribute('data-id', '1')
    await click(catalogRow('deepseek'))
    expect(screen.getByTestId('ProviderAddSheet.setup')).toHaveAttribute('data-id', 'deepseek')
    expect(screen.getByTestId('ProviderAddSheet.steps')).toHaveAttribute('data-id', '2')
    expect(screen.getByTestId('ProviderAddSheet.key')).toHaveTextContent(
      'Entered once. ClaudeUI stores it and delivers it to each harness you pick.'
    )

    await typeInto('ProviderAddSheet.keyInput', 'sk-live')
    await click(screen.getByTestId('ProviderAddSheet.save'))
    expect(sent('shared-provider:save')).toEqual([
      [catalogDefinition('deepseek', 'DeepSeek', { pi: true, opencode: true })]
    ])
    expect(sent('shared-provider:set-key')).toEqual([['deepseek', 'sk-live']])
    // No per-engine loop: the vault delivers the one key.
    expect(called('vendorAuthSetKey')).toEqual([])
  })

  it('routes only where the chips say, when one engine is de-selected', async () => {
    await openAddSheet()
    await click(catalogRow('deepseek'))
    await click(
      screen.getAllByTestId('ProviderAddSheet.engines.chip').find((el) => el.dataset.id === 'pi')!
    )
    await typeInto('ProviderAddSheet.keyInput', 'sk-live')
    await click(screen.getByTestId('ProviderAddSheet.save'))
    expect(sent('shared-provider:save')).toEqual([
      [catalogDefinition('deepseek', 'DeepSeek', { pi: false, opencode: true })]
    ])
    expect(sent('shared-provider:set-key')).toEqual([['deepseek', 'sk-live']])
  })

  it('an id the vault cannot name keeps a copy per engine, as before', async () => {
    catalog = [...catalog, catalogEntry({ id: 'io.net', name: 'io.net' })]
    await openAddSheet()
    await click(catalogRow('io.net'))
    await typeInto('ProviderAddSheet.keyInput', 'sk-io')
    await click(screen.getByTestId('ProviderAddSheet.save'))
    expect(sent('shared-provider:save')).toEqual([])
    expect(called('vendorAuthSetKey')).toEqual([['opencode', 'io.net', 'sk-io']])
  })

  /** A catalog of `n` models, for the anti-flood threshold (ADR-074 §2: over 50). */
  const catalogOf = (n: number): Array<{ id: string; name: string }> =>
    Array.from({ length: n }, (_, i) => ({ id: `m-${i}`, name: `Model ${i}` }))

  it('seeds an EMPTY opencode allowlist for a catalog over 50, so it cannot flood the picker', async () => {
    app.bridge.ipcMain.handle('session:get-opencode-provider-models', async () => catalogOf(300))
    await openAddSheet()
    await click(catalogRow('groq'))
    await typeInto('ProviderAddSheet.keyInput', 'sk-groq')
    await click(screen.getByTestId('ProviderAddSheet.save'))
    expect(sent('models:set-provider-allowlist')).toEqual([['opencode', 'groq', []]])
    expect(sent('config:save-opencode-settings')).toEqual([])
  })

  it('leaves a catalog of 50 or fewer on All models — no key at all', async () => {
    app.bridge.ipcMain.handle('session:get-opencode-provider-models', async () => catalogOf(50))
    await openAddSheet()
    await click(catalogRow('groq'))
    await typeInto('ProviderAddSheet.keyInput', 'sk-groq')
    await click(screen.getByTestId('ProviderAddSheet.save'))
    expect(sent('models:set-provider-allowlist')).toEqual([])
  })

  it('seeds each engine by ITS OWN catalog size', async () => {
    app.bridge.ipcMain.handle('session:get-opencode-provider-models', async () => catalogOf(3))
    app.bridge.ipcMain.handle('session:get-pi-model-catalog', async () => [
      {
        engineId: 'pi',
        vendorId: 'openai',
        vendorName: 'openai',
        models: catalogOf(60).map((m) => ({
          value: `openai/${m.id}`,
          displayName: m.name,
          description: '',
          engineId: 'pi'
        }))
      }
    ])
    await openAddSheet()
    await click(catalogRow('openai'))
    await typeInto('ProviderAddSheet.keyInput', 'sk-live')
    await click(screen.getByTestId('ProviderAddSheet.save'))
    expect(sent('models:set-provider-allowlist')).toEqual([['pi', 'openai', []]])
  })

  it('leaves an existing allowlist alone (re-keying must not wipe curation)', async () => {
    app.bridge.ipcMain.handle('session:get-opencode-provider-models', async () => catalogOf(300))
    app.bridge.ipcMain.handle('config:load-opencode-settings', async () => ({
      modelAllowlist: { groq: ['llama-4'] }
    }))
    await openAddSheet()
    await click(catalogRow('groq'))
    await typeInto('ProviderAddSheet.keyInput', 'sk-groq')
    await click(screen.getByTestId('ProviderAddSheet.save'))
    expect(sent('models:set-provider-allowlist')).toEqual([])
  })

  it('routes a pi-only provider to pi alone', async () => {
    await openAddSheet()
    await click(catalogRow('radius'))
    await typeInto('ProviderAddSheet.keyInput', 'sk-radius')
    await click(screen.getByTestId('ProviderAddSheet.save'))
    expect(sent('shared-provider:save')).toEqual([
      [catalogDefinition('radius', 'Radius', { pi: true, opencode: false })]
    ])
    expect(sent('shared-provider:set-key')).toEqual([['radius', 'sk-radius']])
    expect(called('vendorAuthSetKey')).toEqual([])
    expect(sent('models:set-provider-allowlist')).toEqual([])
    expect(sent('config:save-opencode-settings')).toEqual([])
  })

  it('never offers an id a shared definition already owns — not even with its routes off', async () => {
    definitions = [
      chatgptDefinition,
      catalogDefinition('groq', 'Groq', { pi: false, opencode: false })
    ]
    await openAddSheet()
    expect(catalogIds()).not.toContain('groq')
    expect(catalogIds()).toContain('openai')
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

  it('offers no chip for a harness that does not run, and saves no route for it', async () => {
    await harnessMissing(['pi'])
    await fillCustom()
    expect(screen.getAllByTestId('ProviderForm.engines.chip').map((el) => el.dataset.id)).toEqual([
      'opencode'
    ])
    await click(screen.getByTestId('ProviderAddSheet.customSave'))
    expect((sent('shared-provider:save')[0][0] as SharedProviderDefinition).routes).toEqual({
      pi: { enabled: false },
      opencode: { enabled: true }
    })
  })

  it('offers no custom endpoint while neither opencode nor pi runs', async () => {
    await harnessMissing(['opencode', 'pi'])
    await openAddSheet()
    expect(screen.queryByTestId('ProviderAddSheet.custom')).toBeNull()
    expect(
      screen.queryAllByTestId('ProviderAddSheet.group').map((el) => el.dataset.id)
    ).not.toContain('custom')
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

  it('Detect’s limits and their baseline reach the saved definition (ADR-086)', async () => {
    stub('shared-provider:probe', () => ({
      status: 'detected',
      server: 'vllm',
      models: [{ id: 'qwen3-27b', contextWindow: 32768 }]
    }))
    await fillCustom()
    await typeInto('ProviderForm.key', 'sk-gateway')
    await click(screen.getByTestId('ProviderForm.detect'))
    await screen.findByTestId('ProviderForm.detectResult')
    // The typed key is what Detect uses on a provider that has none stored yet.
    expect(sent('shared-provider:probe')).toEqual([
      [{ baseUrl: 'https://llm.example/v1', protocol: 'openai-completions', apiKey: 'sk-gateway' }]
    ])
    await click(screen.getByTestId('ProviderAddSheet.customSave'))

    const [model] = (sent('shared-provider:save')[0][0] as SharedProviderDefinition).models
    expect(model).toMatchObject({
      id: 'qwen3-27b',
      contextWindow: 32768,
      maxTokens: 8192,
      detected: { server: 'vllm', contextWindow: 32768, maxTokens: 8192 }
    })
    expect(typeof model.detected?.at).toBe('string')
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
    // The pick became a shared catalog definition, so its row is `groq` itself.
    const added: ProviderEntry = {
      id: 'groq',
      name: 'Groq',
      origin: 'shared',
      credential: 'api-key',
      engines: {
        opencode: { enabled: true, modelCount: 0, curated: true, native: true },
        pi: { enabled: false }
      }
    }

    await click(catalogRow('groq'))
    await typeInto('ProviderAddSheet.keyInput', 'sk-groq')
    snapshot = { ...snapshot, entries: [...snapshot.entries, added] }
    await click(screen.getByTestId('ProviderAddSheet.save'))

    expect(registryReads).toBe(before + 1)
    expect(screen.queryByTestId('ProviderAddSheet')).not.toBeInTheDocument()
    expect(screen.getAllByTestId('ProviderList.row').map((el) => el.dataset.id)).toContain('groq')
    // Curation is the next thing on screen — the row was added with an empty
    // allowlist, so a list that just said "0 models" would be a dead end.
    expect(screen.getByTestId('ProviderSheet')).toHaveAttribute('data-id', 'groq')
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

// ── A harness's own key (owner ruling 2026-10-01, S7f) ───────────────

describe('a harness that holds its own key for the vendor', () => {
  /** pi's own OpenRouter key: a native row of the list. */
  const piOpenrouter: ProviderEntry = {
    id: 'pi:openrouter',
    name: 'OpenRouter',
    origin: 'pi-native',
    credential: 'api-key',
    engines: { pi: { enabled: true, native: true } },
    piKind: 'builtin',
    ownedBy: 'pi'
  }
  const openrouter = (routes: { pi: boolean; opencode: boolean }): SharedProviderDefinition => ({
    id: 'openrouter',
    name: 'OpenRouter',
    kind: 'catalog',
    models: [],
    managed: true,
    routes: { pi: { enabled: routes.pi }, opencode: { enabled: routes.opencode } }
  })

  beforeEach(() => {
    snapshot = { entries: [chatgptRow, piXai, piOpenrouter], opencodeInstalled: true }
    // opencode holds nothing for it here; pi holds its own key.
    catalog = catalog.map((entry) =>
      entry.id === 'openrouter' ? { ...entry, authState: 'unauthenticated' as const } : entry
    )
    piOptions = { ...piOptions, openrouter: [{ type: 'api', label: 'OpenRouter API key' }] }
    holders = { openrouter: ['pi'] }
  })

  async function pickOpenrouterAndSave(): Promise<void> {
    await openAddSheet()
    await click(catalogRow('openrouter'))
    await typeInto('ProviderAddSheet.keyInput', 'sk-or-new')
    await click(screen.getByTestId('ProviderAddSheet.save'))
  }

  it('offers pi as a target for OpenRouter, with a note that pi has its own key', async () => {
    await openAddSheet()
    expect(
      within(catalogRow('openrouter'))
        .getAllByTestId('ProviderAddSheet.engineChip')
        .map((el) => el.dataset.id)
    ).toEqual(['opencode', 'pi'])
    expect(catalogRow('openrouter')).toHaveTextContent('pi has its own key for OpenRouter')

    await click(catalogRow('openrouter'))
    expect(
      screen.getAllByTestId('ProviderAddSheet.engines.chip').map((el) => el.dataset.id)
    ).toEqual(['opencode', 'pi'])
    expect(screen.getAllByTestId('ProviderAddSheet.ownKeyNote').map((el) => el.dataset.id)).toEqual(
      ['pi']
    )
  })

  it('asks before replacing pi’s own key, and writes nothing until answered', async () => {
    await pickOpenrouterAndSave()
    const confirm = screen.getByTestId('ProviderAddSheet.ownKeyConfirm')
    expect(confirm).toHaveAttribute('data-id', 'pi')
    expect(confirm).toHaveTextContent(
      'pi already has its own OpenRouter key. Overwrite it and manage the key from ClaudeUI?'
    )
    expect(screen.getByTestId('ProviderAddSheet.ownKeyOverwrite')).toHaveTextContent(
      'Overwrite and manage from ClaudeUI'
    )
    expect(screen.getByTestId('ProviderAddSheet.ownKeyKeep')).toHaveTextContent('Keep pi’s own key')
    expect(sent('shared-provider:save')).toEqual([])
    expect(sent('shared-provider:set-key')).toEqual([])
  })

  it('Overwrite creates it for both, and tells the vault to replace pi’s own key', async () => {
    await pickOpenrouterAndSave()
    await click(screen.getByTestId('ProviderAddSheet.ownKeyOverwrite'))
    expect(sent('shared-provider:save')).toEqual([[openrouter({ pi: true, opencode: true })]])
    // Per harness: only the one the question named.
    expect(sent('shared-provider:set-key')).toEqual([['openrouter', 'sk-or-new', ['pi']]])
  })

  it('Keep pi’s own key creates it with pi’s route off, and replaces nothing', async () => {
    await pickOpenrouterAndSave()
    await click(screen.getByTestId('ProviderAddSheet.ownKeyKeep'))
    expect(sent('shared-provider:save')).toEqual([[openrouter({ pi: false, opencode: true })]])
    expect(sent('shared-provider:set-key')).toEqual([['openrouter', 'sk-or-new']])
    expect(called('vendorAuthSetKey')).toEqual([])
  })

  it('Save asks the host who holds an own key: one written since the sheet opened is named', async () => {
    await openAddSheet()
    await click(catalogRow('openrouter'))
    // A key written into opencode's auth file outside ClaudeUI after the sheet
    // opened: the registry (opencode's cached catalog) does not show it, the
    // files do.
    holders = { openrouter: ['pi', 'opencode'] }
    await typeInto('ProviderAddSheet.keyInput', 'sk-or-new')
    await click(screen.getByTestId('ProviderAddSheet.save'))
    const confirm = screen.getByTestId('ProviderAddSheet.ownKeyConfirm')
    expect(confirm).toHaveAttribute('data-id', 'opencode,pi')
    expect(confirm).toHaveTextContent(
      'opencode and pi already have their own OpenRouter keys. Overwrite them and manage the key from ClaudeUI?'
    )
    expect(screen.getAllByTestId('ProviderAddSheet.ownKeyNote').map((el) => el.dataset.id)).toEqual(
      ['opencode', 'pi']
    )
    expect(sent('shared-provider:own-key-holders')).toEqual([['openrouter']])
    await click(screen.getByTestId('ProviderAddSheet.ownKeyOverwrite'))
    expect(sent('shared-provider:set-key')).toEqual([
      ['openrouter', 'sk-or-new', ['opencode', 'pi']]
    ])
  })

  it('Keep, with both named, creates both routes off and replaces nothing', async () => {
    await openAddSheet()
    await click(catalogRow('openrouter'))
    holders = { openrouter: ['pi', 'opencode'] }
    await typeInto('ProviderAddSheet.keyInput', 'sk-or-new')
    await click(screen.getByTestId('ProviderAddSheet.save'))
    await click(screen.getByTestId('ProviderAddSheet.ownKeyKeep'))
    expect(sent('shared-provider:save')).toEqual([[openrouter({ pi: false, opencode: false })]])
    expect(sent('shared-provider:set-key')).toEqual([['openrouter', 'sk-or-new']])
  })

  it('a key gone since the sheet opened is not asked about', async () => {
    await openAddSheet()
    await click(catalogRow('openrouter'))
    holders = {}
    await typeInto('ProviderAddSheet.keyInput', 'sk-or-new')
    await click(screen.getByTestId('ProviderAddSheet.save'))
    expect(screen.queryByTestId('ProviderAddSheet.ownKeyConfirm')).toBeNull()
    expect(sent('shared-provider:set-key')).toEqual([['openrouter', 'sk-or-new']])
  })

  it('leaving while asked writes nothing', async () => {
    await pickOpenrouterAndSave()
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })
    expect(screen.queryByTestId('ProviderAddSheet')).not.toBeInTheDocument()
    expect(sent('shared-provider:save')).toEqual([])
    expect(sent('shared-provider:set-key')).toEqual([])
  })

  it('asks nothing when pi is not picked', async () => {
    await openAddSheet()
    await click(catalogRow('openrouter'))
    await click(
      screen.getAllByTestId('ProviderAddSheet.engines.chip').find((el) => el.dataset.id === 'pi')!
    )
    await typeInto('ProviderAddSheet.keyInput', 'sk-or-new')
    await click(screen.getByTestId('ProviderAddSheet.save'))
    expect(screen.queryByTestId('ProviderAddSheet.ownKeyConfirm')).toBeNull()
    expect(sent('shared-provider:save')).toEqual([[openrouter({ pi: false, opencode: true })]])
    expect(sent('shared-provider:set-key')).toEqual([['openrouter', 'sk-or-new']])
  })

  it('an id the vault cannot name: Keep writes only the other harness’s copy', async () => {
    catalog = [...catalog, catalogEntry({ id: 'io.net', name: 'io.net' })]
    piOptions = { ...piOptions, 'io.net': [{ type: 'api', label: 'io.net API key' }] }
    snapshot = {
      ...snapshot,
      entries: [
        ...snapshot.entries,
        { ...piOpenrouter, id: 'pi:io.net', name: 'io.net' } satisfies ProviderEntry
      ]
    }
    holders = { 'io.net': ['pi'] }
    await openAddSheet()
    await click(catalogRow('io.net'))
    await typeInto('ProviderAddSheet.keyInput', 'sk-io')
    await click(screen.getByTestId('ProviderAddSheet.save'))
    await click(screen.getByTestId('ProviderAddSheet.ownKeyKeep'))
    expect(called('vendorAuthSetKey')).toEqual([['opencode', 'io.net', 'sk-io']])
  })
})
