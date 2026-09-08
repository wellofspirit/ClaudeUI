/**
 * Layer 2: the provider Manage SHEET (ADR-065 phase 6b, board
 * `board2-ProviderManage.png`).
 *
 * One row can front three different stores, so what matters here is not the
 * markup but WHERE EACH ACTION GOES: the same-looking toggle is a shared-vault
 * route for one provider, opencode's reversible `disabled_providers` veto for
 * the next, and an outright removal from pi for the third (owner ruling 1).
 * Every case below asserts the exact writer and the exact payload — by CHANNEL
 * over the real bridge wherever `bootTestApp` carries one, and by API method for
 * the three it hard-stubs (see `api` below). A sheet that quietly called the
 * wrong writer would look perfectly correct on screen.
 *
 * The sheet is driven through `ProviderList` on purpose: the re-read after a
 * write, and closing the sheet when the write made its provider VANISH, are
 * that pair's shared contract and cannot be seen from either half alone.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, act, within } from '@testing-library/react'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { chooseSelectMenuOption } from '@test/helpers/select-menu'
import { ProviderList } from '../ProviderList'
import type {
  ProviderEntry,
  ProviderRegistrySnapshot
} from '../../../../../shared/provider-registry'
import type { SharedProviderDefinition } from '../../../../../shared/shared-provider'

// ── Fixtures ─────────────────────────────────────────────────────────

const chatgpt: ProviderEntry = {
  id: 'chatgpt',
  name: 'ChatGPT',
  origin: 'shared',
  credential: 'connected',
  engines: { opencode: { enabled: true, native: true }, pi: { enabled: true, native: true } },
  detail: 'ChatGPT subscription · shared with pi and opencode'
}

const custom: ProviderEntry = {
  id: 'ollama-local',
  name: 'Ollama',
  origin: 'shared',
  credential: 'api-key',
  engines: { opencode: { enabled: false }, pi: { enabled: true } },
  detail: 'http://localhost:11434'
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

const groq: ProviderEntry = {
  id: 'pi:groq',
  name: 'groq',
  origin: 'pi-native',
  credential: 'api-key',
  engines: { pi: { enabled: true, native: true } },
  piKind: 'builtin'
}

const piCustom: ProviderEntry = {
  id: 'pi:my-endpoint',
  name: 'my-endpoint',
  origin: 'pi-native',
  credential: 'api-key',
  engines: { pi: { enabled: true, native: true } },
  detail: 'Custom pi provider',
  piKind: 'custom'
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

const customDefinition: SharedProviderDefinition = {
  id: 'ollama-local',
  name: 'Ollama',
  kind: 'custom',
  baseUrl: 'http://localhost:11434',
  models: [{ id: 'qwen3.8-27b' }],
  managed: true,
  routes: { pi: { enabled: true }, opencode: { enabled: false } }
}

// ── Harness ──────────────────────────────────────────────────────────

let app: TestApp
let snapshot: ProviderRegistrySnapshot
let definitions: SharedProviderDefinition[]
/** Every `channel → args` the sheet sent, in order. */
let calls: Array<{ channel: string; args: unknown[] }>
let registryReads: number
/** `shared-provider:models` — what a per-route DEFAULT may be set to. */
let sharedModels: Array<{ id: string; name?: string }>
/** `session:get-opencode-providers` — read on demand by "Model overrides ›". */
let opencodeCatalog: unknown[]

/** Record a channel and answer it. */
function stub(channel: string, answer: (...args: unknown[]) => unknown = () => undefined): void {
  app.bridge.ipcMain.handle(channel, async (_e: unknown, ...args: unknown[]) => {
    calls.push({ channel, args })
    return answer(...args)
  })
}

const sent = (channel: string): unknown[][] =>
  calls.filter((c) => c.channel === channel).map((c) => c.args)

/**
 * Three writers `bootTestApp` hard-stubs as no-op API methods, so they never
 * reach the bridge and cannot be asserted by channel here. They are spied at the
 * API-METHOD level instead; the method → channel mapping is preload's, and is
 * guarded by `main/ipc/__tests__/remote-channel-parity.test.ts`.
 */
const api = {
  vendorAuthSetKey: vi.fn(async (..._args: unknown[]) => {}),
  vendorAuthRemove: vi.fn(async (..._args: unknown[]) => {}),
  patchPiModels: vi.fn(async (..._args: unknown[]) => {})
}

const called = (method: keyof typeof api): unknown[][] => api[method].mock.calls

beforeEach(async () => {
  app = await bootTestApp()
  calls = []
  registryReads = 0
  definitions = [chatgptDefinition, customDefinition]
  sharedModels = [
    { id: 'qwen3.8-27b', name: 'Qwen3.8 27B' },
    { id: 'llama-4', name: 'Llama 4' }
  ]
  opencodeCatalog = [
    {
      id: 'openrouter',
      name: 'OpenRouter',
      authState: 'authenticated',
      authMethods: ['api'],
      modelCount: 300,
      disabled: false,
      actions: {
        canSetCredential: true,
        canEditDeclaration: false,
        canRemove: true,
        removeKind: 'credential'
      }
    }
  ]
  snapshot = { entries: [chatgpt, custom, openrouter, groq, piCustom], opencodeInstalled: true }
  app.bridge.ipcMain.handle('provider-registry:list', async () => {
    registryReads += 1
    return snapshot
  })
  app.bridge.ipcMain.handle('shared-provider:list', async () => definitions)
  app.bridge.ipcMain.handle('shared-provider:models', async () => sharedModels)
  app.bridge.ipcMain.handle('pi:binary-path', async () => '/opt/pi/bin/pi')
  app.bridge.ipcMain.handle('session:get-opencode-provider-models', async () => [])
  app.bridge.ipcMain.handle('config:load-opencode-settings', async () => ({}))
  app.bridge.ipcMain.handle('session:get-engine-models', async () => [])
  app.bridge.ipcMain.handle('config:load-engine-config', async () => ({}))
  stub('session:get-opencode-providers', () => opencodeCatalog)
  stub('shared-provider:save')
  stub('shared-provider:set-route')
  stub('shared-provider:set-default')
  stub('shared-provider:sync')
  stub('shared-provider:set-key')
  stub('shared-provider:disconnect')
  stub('shared-provider:remove')
  stub('session:set-opencode-provider-disabled')
  stub('session:remove-opencode-provider')
  stub('config:save-opencode-settings')
  api.vendorAuthSetKey.mockClear()
  api.vendorAuthRemove.mockClear()
  api.patchPiModels.mockClear()
  Object.assign(window.api, api)
})

afterEach(() => {
  cleanup()
  app.teardown()
})

/** Render the list and open one provider's sheet. */
async function openSheet(id: string): Promise<HTMLElement> {
  render(<ProviderList navigate={vi.fn()} />)
  await screen.findAllByTestId('ProviderList.row')
  await act(async () => {
    fireEvent.click(
      screen.getAllByTestId('ProviderList.manage').find((el) => el.dataset.id === id)!
    )
  })
  return screen.getByTestId('ProviderSheet')
}

const engineRow = (engine: string): HTMLElement =>
  screen.getAllByTestId('ProviderSheet.engine').find((el) => el.dataset.id === engine)!

const engineToggle = (engine: string): HTMLElement =>
  screen.getAllByTestId('ProviderSheet.engineToggle').find((el) => el.dataset.id === engine)!

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

// ── Enabled for ──────────────────────────────────────────────────────

describe('ENABLED FOR', () => {
  it('always shows Claude, disabled and dimmed, saying why', async () => {
    await openSheet('chatgpt')
    expect(engineRow('claude')).toHaveTextContent('Claude only talks to Anthropic')
    expect(engineToggle('claude')).toBeDisabled()
    expect(engineToggle('claude')).toHaveAttribute('aria-pressed', 'false')
  })

  it('a shared route toggles through set-route, per harness, with no confirm', async () => {
    await openSheet('chatgpt')
    await click(engineToggle('pi'))
    expect(sent('shared-provider:set-route')).toEqual([['chatgpt', 'pi', false]])

    await click(engineToggle('opencode'))
    expect(sent('shared-provider:set-route')).toEqual([
      ['chatgpt', 'pi', false],
      ['chatgpt', 'opencode', false]
    ])
  })

  it('turning a shared route back ON sends enabled: true', async () => {
    await openSheet('ollama-local')
    await click(engineToggle('opencode'))
    expect(sent('shared-provider:set-route')).toEqual([['ollama-local', 'opencode', true]])
  })

  it('an opencode-native row toggles the REVERSIBLE veto, not a removal', async () => {
    await openSheet('opencode:openrouter')
    await click(engineToggle('opencode'))
    // The id opencode knows it by, and `disabled: true` — nothing destroyed.
    expect(sent('session:set-opencode-provider-disabled')).toEqual([['openrouter', true]])
    expect(sent('session:remove-opencode-provider')).toEqual([])
  })

  it('a BUILT-IN pi row asks before removing itself from pi (ruling 1)', async () => {
    await openSheet('pi:groq')
    await click(engineToggle('pi'))
    // First press only arms it: nothing has been written.
    expect(engineRow('pi')).toHaveTextContent('Remove from pi?')
    expect(called('vendorAuthRemove')).toEqual([])

    snapshot = { ...snapshot, entries: snapshot.entries.filter((e) => e.id !== 'pi:groq') }
    await click(engineToggle('pi'))
    expect(called('vendorAuthRemove')).toEqual([['pi', 'groq']])
  })

  it('a CUSTOM pi row is removed from models.json, not from pi’s auth store', async () => {
    await openSheet('pi:my-endpoint')
    await click(engineToggle('pi'))
    await click(engineToggle('pi'))
    expect(called('patchPiModels')).toEqual([[[{ path: ['providers', 'my-endpoint'] }]]])
    expect(called('vendorAuthRemove')).toEqual([])
  })

  it('offers a KEY where a native row has no pi credential to switch back on', async () => {
    await openSheet('opencode:openrouter')
    // No switch on that row at all: there is no credential to switch back on.
    expect(
      screen.queryAllByTestId('ProviderSheet.engineToggle').map((el) => el.dataset.id)
    ).toEqual(['claude', 'opencode'])
    expect(engineRow('pi')).toHaveTextContent('Add a key to use it in pi')
    await click(screen.getByTestId('ProviderSheet.piAddKey'))
    await typeInto('ProviderSheet.piKeyInput', 'sk-or-live')
    await click(screen.getByTestId('ProviderSheet.piSaveKey'))
    expect(called('vendorAuthSetKey')).toEqual([['pi', 'openrouter', 'sk-or-live']])
  })

  it('says opencode is not installed instead of offering a toggle', async () => {
    snapshot = { entries: [chatgpt], opencodeInstalled: false }
    await openSheet('chatgpt')
    expect(engineRow('opencode')).toHaveTextContent('opencode is not installed.')
    expect(
      screen.queryAllByTestId('ProviderSheet.engineToggle').map((el) => el.dataset.id)
    ).toEqual(['claude', 'pi'])
  })
})

// ── Credential ───────────────────────────────────────────────────────

describe('CREDENTIAL', () => {
  it('replaces a shared API key through the vault, never a per-engine store', async () => {
    await openSheet('ollama-local')
    await click(screen.getByTestId('ProviderSheet.replaceKey'))
    await typeInto('ProviderSheet.keyInput', 'sk-new')
    await click(screen.getByTestId('ProviderSheet.saveKey'))
    expect(sent('shared-provider:set-key')).toEqual([['ollama-local', 'sk-new']])
    expect(called('vendorAuthSetKey')).toEqual([])
  })

  it('replaces a native key in the ENGINE’s own auth store', async () => {
    await openSheet('opencode:openrouter')
    await click(screen.getByTestId('ProviderSheet.replaceKey'))
    await typeInto('ProviderSheet.keyInput', 'sk-or-new')
    await click(screen.getByTestId('ProviderSheet.saveKey'))
    expect(called('vendorAuthSetKey')).toEqual([['opencode', 'openrouter', 'sk-or-new']])
    expect(sent('shared-provider:set-key')).toEqual([])
  })

  it('does not sit on "Loading…" when the definition read fails', async () => {
    // A definition that is ABSENT, or a read that threw, is an ANSWER; only a
    // read still in flight is loading.
    app.bridge.ipcMain.handle('shared-provider:list', async () => {
      throw new Error('vault unreadable')
    })
    await openSheet('ollama-local')
    const credential = screen.getByTestId('ProviderSheet.credential')
    expect(credential).not.toHaveAttribute('data-id', 'loading')
    expect(credential).toHaveTextContent('API key')
  })

  it('disconnects a subscription only on the second press', async () => {
    const sheet = await openSheet('chatgpt')
    expect(sheet).toHaveTextContent('Connected as ChatGPT')
    await click(screen.getByTestId('ProviderSheet.disconnect'))
    expect(sent('shared-provider:disconnect')).toEqual([])
    await click(screen.getByTestId('ProviderSheet.disconnect'))
    expect(sent('shared-provider:disconnect')).toEqual([['chatgpt']])
  })
})

// ── Removal ──────────────────────────────────────────────────────────

describe('Remove provider', () => {
  it('refuses to remove a built-in shared definition, and says so', async () => {
    await openSheet('chatgpt')
    const remove = screen.getByTestId('ProviderSheet.remove')
    expect(remove).toBeDisabled()
    expect(remove).toHaveAttribute('title', expect.stringContaining('disconnect it instead'))
  })

  it('removes a user-declared shared provider after a confirm', async () => {
    await openSheet('ollama-local')
    await click(screen.getByTestId('ProviderSheet.remove'))
    expect(screen.getByTestId('ProviderSheet.remove')).toHaveTextContent('Remove provider?')
    expect(sent('shared-provider:remove')).toEqual([])
    await click(screen.getByTestId('ProviderSheet.remove'))
    expect(sent('shared-provider:remove')).toEqual([['ollama-local']])
  })

  it('passes opencode the entry’s OWN removeKind, never a widened one', async () => {
    await openSheet('opencode:openrouter')
    await click(screen.getByTestId('ProviderSheet.remove'))
    await click(screen.getByTestId('ProviderSheet.remove'))
    expect(sent('session:remove-opencode-provider')).toEqual([['openrouter', 'credential']])
  })

  it('routes a pi removal by piKind — auth store for built-in, models.json for custom', async () => {
    await openSheet('pi:groq')
    await click(screen.getByTestId('ProviderSheet.remove'))
    await click(screen.getByTestId('ProviderSheet.remove'))
    expect(called('vendorAuthRemove')).toEqual([['pi', 'groq']])

    cleanup()
    await openSheet('pi:my-endpoint')
    await click(screen.getByTestId('ProviderSheet.remove'))
    await click(screen.getByTestId('ProviderSheet.remove'))
    expect(called('patchPiModels')).toEqual([[[{ path: ['providers', 'my-endpoint'] }]]])
  })
})

// ── The write loop ───────────────────────────────────────────────────

describe('after a write', () => {
  it('re-reads the registry — it publishes no change event', async () => {
    await openSheet('chatgpt')
    const before = registryReads
    await click(engineToggle('pi'))
    expect(registryReads).toBe(before + 1)
  })

  it('closes the sheet when the write made the provider disappear', async () => {
    await openSheet('pi:groq')
    snapshot = { ...snapshot, entries: snapshot.entries.filter((e) => e.id !== 'pi:groq') }
    await click(engineToggle('pi'))
    await click(engineToggle('pi'))
    expect(screen.queryByTestId('ProviderSheet')).not.toBeInTheDocument()
    expect(screen.queryAllByTestId('ProviderList.row').map((el) => el.dataset.id)).not.toContain(
      'pi:groq'
    )
  })

  it('keeps the sheet open and reports a rejected write', async () => {
    app.bridge.ipcMain.handle('shared-provider:set-route', async () => {
      throw new Error('vault is read-only')
    })
    await openSheet('chatgpt')
    await click(engineToggle('pi'))
    expect(screen.getByTestId('ProviderSheet.error')).toHaveTextContent('vault is read-only')
    expect(screen.getByTestId('ProviderSheet')).toBeInTheDocument()
  })
})

// ── Closing ──────────────────────────────────────────────────────────

describe('closing', () => {
  it('Done closes the sheet', async () => {
    await openSheet('chatgpt')
    await click(screen.getByTestId('ProviderSheet.done'))
    expect(screen.queryByTestId('ProviderSheet')).not.toBeInTheDocument()
  })

  it('Escape closes the sheet', async () => {
    await openSheet('chatgpt')
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })
    expect(screen.queryByTestId('ProviderSheet')).not.toBeInTheDocument()
  })
})

// ── Models in the picker ─────────────────────────────────────────────

describe('MODELS IN THE PICKER', () => {
  const models = [
    { id: 'kimi', name: 'Kimi K3' },
    { id: 'luna', name: 'GPT-5.6 Luna' },
    { id: 'sol', name: 'GPT-5.6 Sol' }
  ]

  beforeEach(() => {
    app.bridge.ipcMain.handle('session:get-opencode-provider-models', async () => models)
    app.bridge.ipcMain.handle('config:load-opencode-settings', async () => ({
      modelAllowlist: { openrouter: ['kimi', 'luna'] }
    }))
  })

  it('curates through the opencode allowlist, one chip at a time', async () => {
    await openSheet('opencode:openrouter')
    const chip = (id: string): HTMLElement =>
      screen.getAllByTestId('ProviderSheet.modelChips.chip').find((el) => el.dataset.id === id)!
    expect(chip('kimi')).toHaveAttribute('aria-pressed', 'true')
    expect(chip('sol')).toHaveAttribute('aria-pressed', 'false')

    await click(chip('sol'))
    expect(sent('config:save-opencode-settings')).toEqual([
      [{ modelAllowlist: { openrouter: ['kimi', 'luna', 'sol'] } }]
    ])
  })

  it('refuses a de-selection that would orphan a configured model', async () => {
    // No-silent-fallback (ADR-059): the reference would break far from here.
    app.bridge.ipcMain.handle('config:load-opencode-settings', async () => ({
      model: 'openrouter/kimi',
      modelAllowlist: { openrouter: ['kimi', 'luna'] }
    }))
    app.bridge.ipcMain.handle('session:get-engine-models', async () => [
      {
        engineId: 'opencode',
        vendorId: 'openrouter',
        vendorName: 'OpenRouter',
        models: [
          {
            value: 'openrouter/kimi',
            displayName: 'Kimi K3',
            description: '',
            engineId: 'opencode',
            vendorId: 'openrouter'
          }
        ]
      }
    ])
    await openSheet('opencode:openrouter')
    await click(
      screen.getAllByTestId('ProviderSheet.modelChips.chip').find((el) => el.dataset.id === 'kimi')!
    )
    expect(screen.getByTestId('ProviderSheet.modelsError')).toHaveTextContent(
      'the opencode default model'
    )
    expect(sent('config:save-opencode-settings')).toEqual([])
  })
})

// ── What 6c moved INTO the sheet ─────────────────────────────────────

/**
 * The flows the retired panes owned. Each one is asserted by the channel it
 * lands on, because "it still works" is not the claim — "it still writes the
 * same thing" is.
 */
describe('the re-homed vault flows', () => {
  it('sets a per-route default model through the vault, per harness', async () => {
    await openSheet('ollama-local')
    // Only the ENABLED route gets a row: a default on a route that delivers
    // nothing configures nothing.
    expect(screen.getAllByTestId('ProviderSheet.defaultModel').map((el) => el.dataset.id)).toEqual([
      'pi'
    ])

    chooseSelectMenuOption(screen.getByTestId('ProviderSheet.defaultModelSelect'), 'llama-4')
    await act(async () => {})
    expect(sent('shared-provider:set-default')).toEqual([['ollama-local', 'pi', 'llama-4']])
  })

  it('clears a default with undefined, not with an empty string', async () => {
    definitions = [
      chatgptDefinition,
      {
        ...customDefinition,
        routes: { ...customDefinition.routes, pi: { enabled: true, defaultModel: 'llama-4' } }
      }
    ]
    await openSheet('ollama-local')
    chooseSelectMenuOption(screen.getByTestId('ProviderSheet.defaultModelSelect'), '')
    await act(async () => {})
    expect(sent('shared-provider:set-default')).toEqual([['ollama-local', 'pi', undefined]])
  })

  it('re-delivers the definition on Sync now, and only for a shared row', async () => {
    await openSheet('ollama-local')
    await click(screen.getByTestId('ProviderSheet.sync'))
    expect(sent('shared-provider:sync')).toEqual([['ollama-local']])

    cleanup()
    await openSheet('opencode:openrouter')
    expect(screen.queryByTestId('ProviderSheet.sync')).not.toBeInTheDocument()
  })

  it('edits a custom endpoint’s definition — the one thing only the vault’s pane could do', async () => {
    await openSheet('ollama-local')
    await click(screen.getByTestId('ProviderSheet.editEndpoint'))

    // Seeded from the definition, and the id is LOCKED: `providers.<id>` is the
    // key both adapters project under, so a re-typed id would declare a second
    // provider rather than rename this one.
    const form = screen.getByTestId('ProviderForm')
    expect(within(form).getByTestId('ProviderForm.baseUrl')).toHaveValue('http://localhost:11434')
    expect(within(form).getByTestId('ProviderForm.id')).toBeDisabled()

    await typeInto('ProviderForm.baseUrl', 'http://10.0.0.5:11434')
    await click(screen.getByTestId('ProviderSheet.saveEndpoint'))

    expect(sent('shared-provider:save')).toEqual([
      [
        {
          ...customDefinition,
          baseUrl: 'http://10.0.0.5:11434',
          models: [{ id: 'qwen3.8-27b', name: undefined }]
        }
      ]
    ])
    // No key typed, so no credential write at all.
    expect(sent('shared-provider:set-key')).toEqual([])
    expect(screen.queryByTestId('ProviderSheet.endpointSheet')).not.toBeInTheDocument()
  })

  it('offers no endpoint editor for a subscription — ClaudeUI owns that definition', async () => {
    await openSheet('chatgpt')
    expect(screen.queryByTestId('ProviderSheet.editEndpoint')).not.toBeInTheDocument()
  })

  it('hands a disconnected subscription to the ADD sheet rather than signing in here', async () => {
    // One sign-in surface, and it is the one that ACQUIRES providers.
    snapshot = {
      ...snapshot,
      entries: snapshot.entries.map((e) =>
        e.id === 'chatgpt' ? { ...e, credential: 'none' as const } : e
      )
    }
    await openSheet('chatgpt')
    await click(screen.getByTestId('ProviderSheet.signIn'))

    expect(screen.queryByTestId('ProviderSheet')).not.toBeInTheDocument()
    const add = screen.getByTestId('ProviderAddSheet')
    expect(add).toBeInTheDocument()
    // Opened ON that row: the search is seeded with the provider handed over.
    expect(screen.getByTestId('ProviderAddSheet.search')).toHaveValue('chatgpt')
  })
})

/**
 * The two per-model editors. The sheet does not re-implement either — it opens
 * the engine's own, on the provider it is showing.
 */
describe('model setup', () => {
  it('opens opencode’s config dialog on this provider, with its catalog entry', async () => {
    await openSheet('opencode:openrouter')
    await click(screen.getByTestId('ProviderSheet.opencodeModels'))
    const dialog = await screen.findByTestId('OpencodeProviderConfigModal')
    expect(dialog).toHaveAttribute('data-id', 'openrouter')
    // The entry is READ, not assumed: its resolved `actions` are what gate the
    // dialog's declaration form and credential block.
    expect(sent('session:get-opencode-providers').length).toBeGreaterThan(0)
  })

  it('opens pi’s models.json editor on this provider', async () => {
    await openSheet('pi:my-endpoint')
    await click(screen.getByTestId('ProviderSheet.piModels'))
    expect(await screen.findByTestId('PiProviderDialog')).toHaveAttribute('data-id', 'my-endpoint')
  })

  it('offers neither on a shared row — it owns no engine-native declaration', async () => {
    await openSheet('chatgpt')
    expect(screen.queryByTestId('ProviderSheet.opencodeModels')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ProviderSheet.piModels')).not.toBeInTheDocument()
  })
})
