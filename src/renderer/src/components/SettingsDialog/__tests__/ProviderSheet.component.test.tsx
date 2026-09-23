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
import { SubscriptionsSection } from '../SubscriptionsSection'
import { useSessionStore } from '../../../stores/session-store'
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
  subscription: true,
  engines: {
    opencode: { enabled: true, native: true, providerId: 'openai' },
    pi: { enabled: true, native: true, providerId: 'openai-codex' },
    // Fed by vault injection, not by a route (ADR-068 §1) — F14 projects it.
    codex: { enabled: true }
  },
  detail: 'ChatGPT subscription · shared with pi and opencode',
  // Its ENABLED pi route lands on a vendor pi ships, so the row can override it.
  piBuiltinId: 'openai-codex'
}

const custom: ProviderEntry = {
  id: 'ollama-local',
  name: 'Ollama',
  origin: 'shared',
  credential: 'api-key',
  engines: { opencode: { enabled: false }, pi: { enabled: true, providerId: 'ollama-local' } },
  detail: 'http://localhost:11434'
}

const openrouter: ProviderEntry = {
  id: 'opencode:openrouter',
  name: 'OpenRouter',
  origin: 'opencode-native',
  credential: 'api-key',
  engines: {
    opencode: {
      enabled: true,
      modelCount: 2,
      curated: true,
      native: true,
      providerId: 'openrouter'
    }
  },
  detail: '2 of 300 models shown in the picker',
  opencodeRemoveKind: 'credential'
}

const groq: ProviderEntry = {
  id: 'pi:groq',
  name: 'groq',
  origin: 'pi-native',
  credential: 'api-key',
  engines: { pi: { enabled: true, native: true, providerId: 'groq' } },
  piKind: 'builtin',
  piBuiltinId: 'groq'
}

const piCustom: ProviderEntry = {
  id: 'pi:my-endpoint',
  name: 'my-endpoint',
  origin: 'pi-native',
  credential: 'api-key',
  engines: { pi: { enabled: true, native: true, providerId: 'my-endpoint' } },
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
  // The registry snapshot lives in the store (F12), which is a module singleton
  // outliving `teardown()` — a case must not open on the previous case's rows.
  useSessionStore.setState({ providerRegistry: null })
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
  app.bridge.ipcMain.handle('session:get-pi-model-catalog', async () => [])
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
  stub('provider-account:switch')
  stub('provider-account:remove')
  stub('provider-account:set-per-session')
  stub('shared-provider:remove')
  stub('session:set-opencode-provider-disabled')
  stub('session:remove-opencode-provider')
  stub('config:save-opencode-settings')
  stub('models:set-provider-allowlist')
  api.vendorAuthSetKey.mockClear()
  api.vendorAuthRemove.mockClear()
  api.patchPiModels.mockClear()
  Object.assign(window.api, api)
})

afterEach(() => {
  cleanup()
  app.teardown()
})

/**
 * Render the page's two provider surfaces and open one provider's sheet — from
 * its API-provider row, or, for a subscription (ADR-074 §7), from its card's
 * Engines row, which is the only place its sheet opens from now.
 */
async function openSheet(id: string): Promise<HTMLElement> {
  render(
    <>
      <SubscriptionsSection />
      <ProviderList />
    </>
  )
  const subscription = snapshot.entries.find((e) => e.id === id)?.subscription === true
  const manage = subscription
    ? await screen.findByTestId('SubscriptionsSection.manage')
    : (await screen.findAllByTestId('ProviderList.manage')).find((el) => el.dataset.id === id)!
  await act(async () => {
    fireEvent.click(manage)
  })
  return screen.getByTestId('ProviderSheet')
}

/**
 * Open the sheet, then its stacked "models in the picker" sheet (ADR-074 §7,
 * mockup D): curation is a place the summary row leads to, not a section.
 */
async function openModels(id: string): Promise<HTMLElement> {
  const sheet = await openSheet(id)
  await act(async () => {
    fireEvent.click(screen.getByTestId('ProviderSheet.editModels'))
  })
  return sheet
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

  it('carries a read-only Codex row saying the account is not chosen per engine', async () => {
    // Codex is injection, not a route (ADR-068 §1): there is nothing to toggle,
    // and a row that offered one would promise a switch the vault does not have.
    await openSheet('chatgpt')
    expect(engineRow('codex')).toHaveTextContent('Codex always uses the active ChatGPT account')
    // The Accounts page is gone: pinning lives on the ChatGPT card (ADR-074 §7).
    expect(engineRow('codex')).toHaveTextContent(
      'per-session pinning is in the ChatGPT card’s Options'
    )
    expect(
      screen.queryAllByTestId('ProviderSheet.engineToggle').map((el) => el.dataset.id)
    ).not.toContain('codex')
  })

  it('shows no Codex row on a provider the vault does not inject into Codex', async () => {
    await openSheet('ollama-local')
    expect(screen.getAllByTestId('ProviderSheet.engine').map((el) => el.dataset.id)).not.toContain(
      'codex'
    )
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

  it('reads a keyless custom endpoint as "No key needed" with an optional key', async () => {
    // ADR-074 §4: no stored key is a working state for a custom endpoint.
    snapshot = {
      ...snapshot,
      entries: snapshot.entries.map((e) =>
        e.id === 'ollama-local' ? { ...e, credential: 'keyless' } : e
      )
    }
    await openSheet('ollama-local')
    const chip = screen.getByTestId('ProviderSheet.credentialChip')
    expect(chip).toHaveAttribute('data-id', 'keyless')
    expect(chip).toHaveTextContent('No key needed')
    const credential = screen.getByTestId('ProviderSheet.credential')
    expect(credential).toHaveAttribute('data-id', 'key')
    expect(credential).toHaveTextContent('Optional — this endpoint is used without a key.')
    expect(credential).not.toHaveTextContent('Not set')
    await click(screen.getByTestId('ProviderSheet.replaceKey'))
    await typeInto('ProviderSheet.keyInput', 'sk-first')
    await click(screen.getByTestId('ProviderSheet.saveKey'))
    expect(sent('shared-provider:set-key')).toEqual([['ollama-local', 'sk-first']])
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

  it('disconnects a subscription from the footer, only on the second press', async () => {
    await openSheet('chatgpt')
    expect(screen.getByTestId('ProviderSheet.disconnect')).toHaveTextContent('Disconnect ChatGPT')
    await click(screen.getByTestId('ProviderSheet.disconnect'))
    expect(sent('shared-provider:disconnect')).toEqual([])
    await click(screen.getByTestId('ProviderSheet.disconnect'))
    expect(sent('shared-provider:disconnect')).toEqual([['chatgpt']])
  })
})

// ── A subscription's sheet (ADR-074 §7) ──────────────────────────────

/**
 * A subscription's credential is its ACCOUNTS, and they live on its
 * Subscriptions card, so its Manage sheet is engines and models only. What the
 * sheet keeps is the provider-wide Disconnect in the footer.
 */
describe('a subscription’s sheet', () => {
  const twoAccounts = {
    activeId: 'acc-1',
    perSession: false,
    list: [
      { id: 'acc-1', email: 'daniel@example.com', accountId: 'ws-11112222', planType: 'pro' },
      { id: 'acc-2', email: 'work@example.com', accountId: 'ws-33334444', planType: 'business' }
    ]
  }

  /** Put `accounts` on the ChatGPT row before the sheet is opened. */
  function withAccounts(accounts: ProviderEntry['accounts']): void {
    snapshot = {
      ...snapshot,
      entries: snapshot.entries.map((e) => (e.id === 'chatgpt' ? { ...e, accounts } : e))
    }
  }

  it('has no Credential group, and is titled for what it holds', async () => {
    withAccounts(twoAccounts)
    const sheet = await openSheet('chatgpt')
    const groups = within(sheet)
      .getAllByTestId('ProviderSheet.group')
      .map((el) => el.dataset.id)
    expect(groups).not.toContain('credential')
    expect(groups).not.toContain('accounts')
    expect(within(sheet).queryByTestId('ProviderSheet.credential')).not.toBeInTheDocument()
    expect(within(sheet).queryByTestId('ProviderSheet.accountsLink')).not.toBeInTheDocument()
    expect(sheet).toHaveTextContent('ChatGPT · engines & models')
    // ENABLED FOR keeps its rows.
    expect(groups).toContain('enabled')
  })

  it('disconnects EVERY account from the footer, on the second press', async () => {
    withAccounts(twoAccounts)
    await openSheet('chatgpt')
    const disconnect = screen.getByTestId('ProviderSheet.disconnect')
    expect(disconnect).toHaveTextContent('Disconnect all accounts')
    await click(disconnect)
    expect(sent('shared-provider:disconnect')).toEqual([])
    await click(screen.getByTestId('ProviderSheet.disconnect'))
    expect(sent('shared-provider:disconnect')).toEqual([['chatgpt']])
  })

  it('an API provider still has its Credential group', async () => {
    const sheet = await openSheet('ollama-local')
    expect(
      within(sheet)
        .getAllByTestId('ProviderSheet.group')
        .map((el) => el.dataset.id)
    ).toContain('credential')
    expect(within(sheet).queryByTestId('ProviderSheet.disconnect')).not.toBeInTheDocument()
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

  it('Escape closes a dialog opened FROM the sheet, and only then the sheet', async () => {
    // Owner ruling 2026-09-08: Escape goes one level up. The sheet's frame and
    // the dialog it opens are both `useEscapeLayer` layers, so the first press
    // must not take the sheet — and the dialog — with it.
    await openSheet('pi:groq')
    await click(screen.getByTestId('ProviderSheet.piOverrides'))
    expect(await screen.findByTestId('PiProviderDialog')).toBeInTheDocument()

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })
    expect(screen.queryByTestId('PiProviderDialog')).not.toBeInTheDocument()
    expect(screen.getByTestId('ProviderSheet')).toBeInTheDocument()

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })
    expect(screen.queryByTestId('ProviderSheet')).not.toBeInTheDocument()
  })
})

// ── Models in the picker ─────────────────────────────────────────────

describe('MODELS IN THE PICKER', () => {
  /**
   * A gateway catalog: prefixed ids, so the list groups by vendor. The picker
   * VALUE of a catalog model is `${providerId}/${model.id}` — for OpenRouter
   * that is the double-segment `openrouter/moonshotai/kimi-k3`, which is what
   * the orphan guard has to match against.
   */
  const models = [
    { id: 'moonshotai/kimi-k3', name: 'Kimi K3' },
    { id: 'openai/gpt-5-6-luna', name: 'GPT-5.6 Luna' },
    { id: 'openai/gpt-5-6-sol', name: 'GPT-5.6 Sol' }
  ]

  const row = (id: string): HTMLElement =>
    screen.getAllByTestId('ProviderSheet.models.row').find((el) => el.dataset.id === id)!
  const groupToggle = (prefix: string): HTMLElement =>
    screen
      .getAllByTestId('ProviderSheet.models.groupToggle')
      .find((el) => el.dataset.id === prefix)!
  const mode = (id: 'all' | 'pick'): HTMLElement =>
    screen.getAllByTestId('ProviderSheet.curationMode.option').find((el) => el.dataset.id === id)!

  beforeEach(() => {
    app.bridge.ipcMain.handle('session:get-opencode-provider-models', async () => models)
    app.bridge.ipcMain.handle('config:load-opencode-settings', async () => ({
      modelAllowlist: { openrouter: ['moonshotai/kimi-k3', 'openai/gpt-5-6-luna'] }
    }))
  })

  it('curates through the ONE allowlist writer, one row at a time', async () => {
    await openModels('opencode:openrouter')
    expect(row('moonshotai/kimi-k3')).toHaveAttribute('aria-checked', 'true')
    expect(row('openai/gpt-5-6-sol')).toHaveAttribute('aria-checked', 'false')

    await click(row('openai/gpt-5-6-sol'))
    expect(sent('models:set-provider-allowlist')).toEqual([
      [
        'opencode',
        'openrouter',
        ['moonshotai/kimi-k3', 'openai/gpt-5-6-luna', 'openai/gpt-5-6-sol']
      ]
    ])
    // The whole-settings save is not how curation writes any more.
    expect(sent('config:save-opencode-settings')).toEqual([])
  })

  it('groups by vendor prefix, and a vendor checkbox writes the whole group', async () => {
    await openModels('opencode:openrouter')
    // Both vendors hold a selection, so both are open; the tie in selected
    // count breaks alphabetically by label (Moonshot, OpenAI).
    expect(screen.getAllByTestId('ProviderSheet.models.group').map((el) => el.dataset.id)).toEqual([
      'moonshotai',
      'openai'
    ])
    expect(groupToggle('openai')).toHaveAttribute('data-state', 'mixed')

    await click(groupToggle('openai'))
    expect(sent('models:set-provider-allowlist')).toEqual([
      [
        'opencode',
        'openrouter',
        ['moonshotai/kimi-k3', 'openai/gpt-5-6-luna', 'openai/gpt-5-6-sol']
      ]
    ])
  })

  it('an ABSENT allowlist is All models; unticking one switches to Only, with Undo', async () => {
    app.bridge.ipcMain.handle('config:load-opencode-settings', async () => ({}))
    await openModels('opencode:openrouter')
    expect(mode('all')).toHaveAttribute('aria-pressed', 'true')
    for (const model of models) expect(row(model.id)).toHaveAttribute('aria-checked', 'true')

    await click(row('moonshotai/kimi-k3'))
    expect(sent('models:set-provider-allowlist')).toEqual([
      ['opencode', 'openrouter', ['openai/gpt-5-6-luna', 'openai/gpt-5-6-sol']]
    ])
    expect(mode('pick')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('ProviderSheet.curationToast')).toHaveTextContent(
      'Switched to Only the ones I pick — everything but this model is picked.'
    )

    await click(screen.getByTestId('ProviderSheet.curationUndo'))
    // Undo restores ALL — the key is deleted, not rewritten as today's catalog.
    expect(sent('models:set-provider-allowlist').at(-1)).toEqual(['opencode', 'openrouter', null])
    expect(mode('all')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByTestId('ProviderSheet.curationToast')).not.toBeInTheDocument()
  })

  it('the summary row and the engine row say what the block says, not the registry', async () => {
    // The registry fixture claims 2 curated models; one of the stored ids is gone
    // from the catalog, so the block counts 1 — and so must everything else.
    app.bridge.ipcMain.handle('config:load-opencode-settings', async () => ({
      modelAllowlist: { openrouter: ['moonshotai/kimi-k3', 'openai/gone'] }
    }))
    await openModels('opencode:openrouter')
    expect(screen.getByTestId('ProviderSheet.modelsSummary')).toHaveTextContent('1 picked')
    expect(engineRow('opencode')).toHaveTextContent('1 of 3 models reach the picker.')

    await click(mode('all'))
    expect(screen.getByTestId('ProviderSheet.modelsSummary')).toHaveTextContent('All models')
    expect(engineRow('opencode')).toHaveTextContent('3 models reach the picker.')
  })

  it('choosing All models with a selection deletes the key', async () => {
    await openModels('opencode:openrouter')
    expect(mode('pick')).toHaveTextContent('Only the ones I pick · 2')
    await click(mode('all'))
    expect(sent('models:set-provider-allowlist')).toEqual([['opencode', 'openrouter', null]])
    expect(screen.getByTestId('ProviderSheet.curationModeRow')).toHaveTextContent(
      'Every model OpenRouter offers is shown, including ones added later.'
    )
  })

  it('Select all acts on what the search narrowed to', async () => {
    await openModels('opencode:openrouter')
    await typeInto('ProviderSheet.modelFilter', 'openai/')
    expect(screen.getByTestId('ProviderSheet.models.selectAll')).toHaveTextContent('Select all 2')

    await click(screen.getByTestId('ProviderSheet.models.selectAll'))
    // The model outside the search keeps its place in the list.
    expect(sent('models:set-provider-allowlist')).toEqual([
      [
        'opencode',
        'openrouter',
        ['moonshotai/kimi-k3', 'openai/gpt-5-6-luna', 'openai/gpt-5-6-sol']
      ]
    ])
  })

  /** opencode reports Kimi K3 as discovered — the set a setting can name. */
  const discoveredKimi = (): void => {
    app.bridge.ipcMain.handle('session:get-engine-models', async () => [
      {
        engineId: 'opencode',
        vendorId: 'openrouter',
        vendorName: 'OpenRouter',
        models: [
          {
            value: 'openrouter/moonshotai/kimi-k3',
            displayName: 'Kimi K3',
            description: '',
            engineId: 'opencode',
            vendorId: 'openrouter'
          }
        ]
      }
    ])
  }

  it('locks a model a setting uses, says where, and refuses to untick it', async () => {
    // No-silent-fallback (ADR-059): the reference would break far from here.
    app.bridge.ipcMain.handle('config:load-opencode-settings', async () => ({
      model: 'openrouter/moonshotai/kimi-k3',
      modelAllowlist: { openrouter: ['moonshotai/kimi-k3', 'openai/gpt-5-6-luna'] }
    }))
    discoveredKimi()
    await openModels('opencode:openrouter')
    const lock = screen
      .getAllByTestId('ProviderSheet.models.lock')
      .find((el) => el.dataset.id === 'moonshotai/kimi-k3')!
    expect(lock).toHaveAttribute(
      'title',
      'Default model for opencode — Models & providers › Default models › opencode. Change that setting first.'
    )
    await click(row('moonshotai/kimi-k3'))
    expect(row('moonshotai/kimi-k3')).toHaveAttribute('aria-checked', 'true')
    // Clear takes every other picked model, and never the locked one.
    await click(screen.getByTestId('ProviderSheet.models.clearShown'))
    expect(sent('models:set-provider-allowlist')).toEqual([
      ['opencode', 'openrouter', ['moonshotai/kimi-k3']]
    ])
  })

  it('a pi default spelled the same does not lock an opencode model (scoped guard)', async () => {
    // opencode and pi picker values share a namespace.
    app.bridge.ipcMain.handle('config:load-engine-config', async (_e: unknown, id: unknown) =>
      id === 'pi' ? { piConfig: { defaultModel: 'openrouter/moonshotai/kimi-k3' } } : {}
    )
    discoveredKimi()
    await openModels('opencode:openrouter')
    expect(screen.queryAllByTestId('ProviderSheet.models.lock')).toEqual([])
    await click(row('moonshotai/kimi-k3'))
    expect(sent('models:set-provider-allowlist')).toEqual([
      ['opencode', 'openrouter', ['openai/gpt-5-6-luna']]
    ])
  })

  it('“Curate models ›” focuses the list’s search box', async () => {
    await openModels('opencode:openrouter')
    await click(screen.getByTestId('ProviderSheet.curate'))
    expect(screen.getByTestId('ProviderSheet.modelFilter')).toHaveFocus()
  })
})

// ── Curation for every engine (ADR-074 §2) ───────────────────────────

describe('MODELS IN THE PICKER — any engine', () => {
  const piGroup = (vendorId: string, ids: string[]) => ({
    engineId: 'pi',
    vendorId,
    vendorName: vendorId,
    models: ids.map((id) => ({
      value: `${vendorId}/${id}`,
      displayName: id,
      description: '',
      engineId: 'pi'
    }))
  })
  const tabs = (): string[] =>
    screen.queryAllByTestId('ProviderSheet.curationTab').map((el) => el.dataset.id!)
  const tab = (engine: string): HTMLElement =>
    screen.getAllByTestId('ProviderSheet.curationTab').find((el) => el.dataset.id === engine)!

  it('a provider on both engines gets one tab each, keyed by each engine’s own id', async () => {
    app.bridge.ipcMain.handle('session:get-opencode-provider-models', async () => [
      { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
      { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' }
    ])
    app.bridge.ipcMain.handle('session:get-pi-model-catalog', async () => [
      piGroup('openai-codex', ['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-6-sol'])
    ])
    app.bridge.ipcMain.handle('config:load-opencode-settings', async () => ({
      modelAllowlist: { openai: ['gpt-5.6-luna'] }
    }))
    await openModels('chatgpt')
    expect(tabs()).toEqual(['opencode', 'pi'])
    // Scoped: the subscription card's opencode pill says the same count.
    await within(screen.getByTestId('ProviderSheet.modelsSheet')).findByText('1 of 2')
    expect(
      screen
        .getAllByTestId('ProviderSheet.curationTabCount')
        .map((el) => [el.dataset.id, el.textContent])
    ).toEqual([
      ['opencode', '1 of 2'],
      ['pi', 'all 3']
    ])

    await click(tab('pi'))
    await click(
      screen.getAllByTestId('ProviderSheet.models.row').find((el) => el.dataset.id === 'gpt-6-sol')!
    )
    // pi's id for ChatGPT is `openai-codex`, never the definition id.
    expect(sent('models:set-provider-allowlist')).toEqual([
      ['pi', 'openai-codex', ['gpt-5.6-luna', 'gpt-5.6-sol']]
    ])
  })

  it('a list split in the stacked editor reopens split, and stays split on the next edit', async () => {
    // The sheet re-reads the definition after every write; the editor seeds
    // from it on each open. Read once, a split list reopened as ONE list.
    stub('shared-provider:set-curation', (id, curation) => {
      definitions = definitions.map((d) =>
        d.id === id ? { ...d, curation: curation as SharedProviderDefinition['curation'] } : d
      )
    })
    app.bridge.ipcMain.handle('session:get-opencode-provider-models', async () => [
      { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' }
    ])
    app.bridge.ipcMain.handle('session:get-pi-model-catalog', async () => [
      piGroup('openai-codex', ['gpt-5.6-luna'])
    ])
    const card = (id: string): HTMLElement =>
      screen.getAllByTestId('ProviderSheet.curationLink.option').find((el) => el.dataset.id === id)!

    await openModels('chatgpt')
    expect(card('one')).toHaveAttribute('aria-checked', 'true')
    await click(card('separate'))
    expect(sent('shared-provider:set-curation')).toEqual([['chatgpt', { linked: false }]])

    await click(screen.getByTestId('ProviderSheet.modelsDone'))
    expect(screen.getByTestId('ProviderSheet.modelsSummary')).toHaveTextContent(
      'Separate per engine'
    )
    await click(screen.getByTestId('ProviderSheet.editModels'))
    expect(card('separate')).toHaveAttribute('aria-checked', 'true')

    // The next edit is a per-engine one: nothing re-links the list.
    await click(
      screen
        .getAllByTestId('ProviderSheet.models.row')
        .find((el) => el.dataset.id === 'gpt-5.6-luna')!
    )
    expect(sent('models:set-provider-allowlist')).toHaveLength(1)
    expect(sent('shared-provider:set-curation')).toEqual([['chatgpt', { linked: false }]])
  })

  it('a single-engine provider gets no tabs, and pi curation writes pi', async () => {
    app.bridge.ipcMain.handle('session:get-pi-model-catalog', async () => [
      piGroup('groq', ['llama-4', 'kimi'])
    ])
    await openModels('pi:groq')
    expect(tabs()).toEqual([])
    await click(
      screen
        .getAllByTestId('ProviderSheet.curationMode.option')
        .find((el) => el.dataset.id === 'pick')!
    )
    // A small catalog starts Only with everything picked.
    expect(sent('models:set-provider-allowlist')).toEqual([['pi', 'groq', ['llama-4', 'kimi']]])
  })

  it('an empty pi catalog says why instead of listing nothing', async () => {
    // pi reports OTHER providers, so this one has no usable credential.
    app.bridge.ipcMain.handle('session:get-pi-model-catalog', async () => [
      piGroup('groq', ['llama-4'])
    ])
    await openModels('ollama-local')
    const models = await screen.findByTestId('ProviderSheet.models')
    expect(models).toHaveAttribute('data-id', 'empty')
    expect(models).toHaveTextContent('pi reports no models for this provider')
  })

  it('a shared provider both engines curate shows ONE list, marked per engine (ADR-074 §3)', async () => {
    app.bridge.ipcMain.handle('session:get-opencode-provider-models', async () => [
      { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' }
    ])
    app.bridge.ipcMain.handle('session:get-pi-model-catalog', async () => [
      piGroup('openai-codex', ['gpt-5.6-luna', 'gpt-5.6-sol'])
    ])
    await openModels('chatgpt')
    await screen.findAllByTestId('ProviderSheet.curationLink.option')
    expect(screen.queryByTestId('ProviderSheet.curationTabs')).toBeNull()
    const sol = screen
      .getAllByTestId('ProviderSheet.models.row')
      .find((el) => el.dataset.id === 'gpt-5.6-sol')!
    expect(
      within(sol)
        .getAllByTestId('ProviderSheet.modelMark')
        .map((el) => [el.dataset.id, el.dataset.available])
    ).toEqual([
      ['opencode', 'false'],
      ['pi', 'true']
    ])
  })

  it('“Curate models ›” on the pi row opens the pi tab', async () => {
    // Tabs exist only when the lists are split (ADR-074 §3); linked, there is
    // one shared list and no tab to open.
    definitions = [{ ...chatgptDefinition, curation: { linked: false } }, customDefinition]
    app.bridge.ipcMain.handle('session:get-opencode-provider-models', async () => [
      { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' }
    ])
    app.bridge.ipcMain.handle('session:get-pi-model-catalog', async () => [
      piGroup('openai-codex', ['gpt-5.6-luna'])
    ])
    await openModels('chatgpt')
    await screen.findAllByTestId('ProviderSheet.curationTab')
    await click(screen.getAllByTestId('ProviderSheet.curate').find((el) => el.dataset.id === 'pi')!)
    expect(tab('pi')).toHaveAttribute('aria-selected', 'true')
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

  it('opens pi’s models.json editor on a DECLARED pi provider', async () => {
    await openSheet('pi:my-endpoint')
    // A declared entry is edited, not overridden: one row, and it is this one.
    expect(screen.queryByTestId('ProviderSheet.piOverrides')).not.toBeInTheDocument()
    await click(screen.getByTestId('ProviderSheet.piModels'))
    expect(await screen.findByTestId('PiProviderDialog')).toHaveAttribute('data-id', 'my-endpoint')
  })

  it('opens the BUILT-IN override dialog on a built-in pi row, not the custom form', async () => {
    // `providers.groq` overrides a provider pi ships; the custom form's models[]
    // and API-protocol rows are the wrong shape for one, so it is a different row.
    await openSheet('pi:groq')
    expect(screen.queryByTestId('ProviderSheet.piModels')).not.toBeInTheDocument()
    await click(screen.getByTestId('ProviderSheet.piOverrides'))
    const dialog = await screen.findByTestId('PiProviderDialog')
    expect(dialog).toHaveAttribute('data-id', 'groq')
    expect(dialog.closest('[data-variant]')).toHaveAttribute('data-variant', 'builtin')
  })

  it('opens it on a shared row’s pi ROUTE id, never on the definition id', async () => {
    // `providers.chatgpt` is not the entry pi reads ChatGPT's models from.
    await openSheet('chatgpt')
    await click(screen.getByTestId('ProviderSheet.piOverrides'))
    expect(await screen.findByTestId('PiProviderDialog')).toHaveAttribute('data-id', 'openai-codex')
  })

  it('offers no model DECLARATION editor on a shared row — it declares nothing natively', async () => {
    await openSheet('chatgpt')
    expect(screen.queryByTestId('ProviderSheet.opencodeModels')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ProviderSheet.piModels')).not.toBeInTheDocument()
  })

  it('offers neither row when the shared row has no pi route into a built-in', async () => {
    await openSheet('ollama-local')
    expect(screen.queryByTestId('ProviderSheet.piModels')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ProviderSheet.piOverrides')).not.toBeInTheDocument()
  })
})

// ── API providers (ADR-074 §6–7, mockup D) ───────────────────────────

describe('API providers — one key, delivered to each engine', () => {
  const catalogEntry: ProviderEntry = {
    id: 'openrouter',
    name: 'OpenRouter',
    origin: 'shared',
    credential: 'api-key',
    kindLabel: 'Catalog',
    engines: {
      opencode: {
        enabled: true,
        native: true,
        providerId: 'openrouter',
        modelCount: 4,
        curated: true,
        catalogCount: 382
      },
      pi: { enabled: false }
    }
  }
  const catalogDefinition: SharedProviderDefinition = {
    id: 'openrouter',
    name: 'OpenRouter',
    kind: 'catalog',
    models: [],
    managed: true,
    routes: { pi: { enabled: false }, opencode: { enabled: true } }
  }

  beforeEach(() => {
    snapshot = { entries: [catalogEntry], opencodeInstalled: true }
    definitions = [chatgptDefinition, catalogDefinition]
    stub('shared-provider:adopt-native')
  })

  it('the Key section replaces the ONE key through the vault', async () => {
    await openSheet('openrouter')
    const key = screen
      .getAllByTestId('ProviderSheet.credential')
      .find((el) => el.dataset.id === 'key')!
    expect(key).toHaveTextContent("Stored once in ClaudeUI's vault")
    await click(screen.getByTestId('ProviderSheet.replaceKey'))
    await typeInto('ProviderSheet.keyInput', 'sk-new')
    await click(screen.getByTestId('ProviderSheet.saveKey'))
    expect(sent('shared-provider:set-key')).toEqual([['openrouter', 'sk-new']])
    expect(called('vendorAuthSetKey')).toEqual([])
  })

  it('one delivery row per engine: where the key went, and what Off means', async () => {
    await openSheet('openrouter')
    // No Claude row on an API provider: its rows are deliveries.
    expect(screen.getAllByTestId('ProviderSheet.engine').map((el) => el.dataset.id)).toEqual([
      'opencode',
      'pi'
    ])
    expect(engineRow('opencode')).toHaveTextContent(
      'Key delivered to opencode’s auth.json as openrouter · 4 of 382 models'
    )
    expect(engineRow('pi')).toHaveTextContent(
      'Off. Turning it on delivers the stored key; nothing to re-enter.'
    )
    await click(engineToggle('pi'))
    expect(sent('shared-provider:set-route')).toEqual([['openrouter', 'pi', true]])
  })

  it('a failed delivery is shown on its engine row, with Retry', async () => {
    snapshot = {
      entries: [
        {
          ...catalogEntry,
          engines: {
            ...catalogEntry.engines,
            pi: { enabled: true, providerId: 'openrouter', error: 'permission denied' }
          }
        }
      ],
      opencodeInstalled: true
    }
    await openSheet('openrouter')
    expect(engineRow('pi')).toHaveTextContent('permission denied')
    await click(within(engineRow('pi')).getByTestId('ProviderSheet.retry'))
    expect(sent('shared-provider:sync')).toEqual([['openrouter']])
  })

  it('Remove is allowed for a catalog provider, and says what it deletes', async () => {
    await openSheet('openrouter')
    expect(screen.getByTestId('ProviderSheet.removeNote')).toHaveTextContent(
      'Removing deletes the key from ClaudeUI and from each engine it’s delivered to.'
    )
    await click(screen.getByTestId('ProviderSheet.remove'))
    expect(sent('shared-provider:remove')).toEqual([])
    await click(screen.getByTestId('ProviderSheet.remove'))
    expect(sent('shared-provider:remove')).toEqual([['openrouter']])
  })

  it('models are a summary row; Edit models › opens the editor in a stacked sheet', async () => {
    await openSheet('openrouter')
    expect(screen.getByTestId('ProviderSheet.modelsSummary')).toHaveTextContent('All models')
    expect(screen.queryByTestId('ProviderSheet.modelsSheet')).toBeNull()
    await click(screen.getByTestId('ProviderSheet.editModels'))
    expect(screen.getByTestId('ProviderSheet.modelsSheet')).toHaveTextContent(
      'OpenRouter · models in the picker'
    )
  })

  it('“Curate ›” on an engine row opens the same stacked sheet', async () => {
    await openSheet('openrouter')
    await click(within(engineRow('opencode')).getByTestId('ProviderSheet.curate'))
    expect(screen.getByTestId('ProviderSheet.modelsSheet')).toBeInTheDocument()
  })

  it('turning a route on over the engine’s OWN key for the vendor asks first', async () => {
    snapshot = {
      entries: [
        {
          ...catalogEntry,
          engines: { ...catalogEntry.engines, pi: { enabled: false, ownCredential: true } }
        }
      ],
      opencodeInstalled: true
    }
    await openSheet('openrouter')
    await click(engineToggle('pi'))
    expect(sent('shared-provider:set-route')).toEqual([])
    expect(engineRow('pi')).toHaveTextContent(
      'pi’s own key for OpenRouter will be replaced by the stored one.'
    )
    await click(within(engineRow('pi')).getByTestId('ProviderSheet.enableConfirm'))
    expect(sent('shared-provider:set-route')).toEqual([['openrouter', 'pi', true]])
  })

  it('an enabled route that is not actually delivered says so, with Retry', async () => {
    snapshot = {
      entries: [
        {
          ...catalogEntry,
          engines: {
            ...catalogEntry.engines,
            opencode: { ...catalogEntry.engines.opencode!, delivered: false }
          }
        }
      ],
      opencodeInstalled: true
    }
    await openSheet('openrouter')
    expect(engineRow('opencode')).toHaveTextContent('Not in opencode’s auth.json.')
    expect(engineRow('opencode')).not.toHaveTextContent('Key delivered')
    await click(within(engineRow('opencode')).getByTestId('ProviderSheet.retry'))
    expect(sent('shared-provider:sync')).toEqual([['openrouter']])
  })

  it('a removal that makes the row vanish closes the sheet — it never follows', async () => {
    stub('shared-provider:remove', () => {
      // A native row of the same bare id is left behind; the sheet must not jump to it.
      snapshot = {
        entries: [{ ...openrouter, id: 'opencode:openrouter' }],
        opencodeInstalled: true
      }
    })
    await openSheet('openrouter')
    await click(screen.getByTestId('ProviderSheet.remove'))
    await click(screen.getByTestId('ProviderSheet.remove'))
    expect(screen.queryByTestId('ProviderSheet')).toBeNull()
  })

  it('a keyless custom endpoint keeps the optional-key copy, and pi’s placeholder row', async () => {
    snapshot = {
      entries: [
        {
          ...custom,
          credential: 'keyless',
          engines: {
            opencode: { enabled: false },
            pi: { enabled: true, providerId: 'ollama-local' }
          }
        }
      ],
      opencodeInstalled: true
    }
    await openSheet('ollama-local')
    expect(
      screen.getAllByTestId('ProviderSheet.credential').find((el) => el.dataset.id === 'key')!
    ).toHaveTextContent('Optional — this endpoint is used without a key.')
    expect(engineRow('pi')).toHaveTextContent('Placeholder key in models.json · as ollama-local')
  })
})

describe('native keys — conflict and adoption (ADR-074 §6)', () => {
  const conflicted: ProviderEntry = {
    ...openrouter,
    keyConflict: { opencode: '…a41f', pi: '…09c2' }
  }

  beforeEach(() => {
    stub('shared-provider:adopt-native')
  })

  it('asks which key to keep, and adopts ONLY after the in-place confirm', async () => {
    snapshot = { entries: [conflicted], opencodeInstalled: true }
    await openSheet('opencode:openrouter')
    const panel = screen.getByTestId('ProviderSheet.keyConflict')
    expect(panel).toHaveTextContent('opencode and pi hold different OpenRouter keys.')
    const option = (id: string): HTMLElement =>
      within(panel)
        .getAllByTestId('ProviderSheet.keepKey')
        .find((el) => el.dataset.id === id)!
    expect(option('opencode')).toHaveTextContent('Keep opencode’s key (…a41f)')
    expect(option('pi')).toHaveTextContent('Keep pi’s key (…09c2)')

    await click(within(option('pi')).getByRole('radio'))
    await click(screen.getByTestId('ProviderSheet.adoptKeep'))
    // Nothing yet — the other engine's key is about to be replaced.
    expect(sent('shared-provider:adopt-native')).toEqual([])
    expect(screen.getByTestId('ProviderSheet.adoptConfirmRow')).toHaveTextContent(
      'opencode’s key (…a41f) is deleted, and pi’s key (…09c2) is delivered to both engines.'
    )
    // The confirm takes focus; the panel is a labelled group.
    expect(document.activeElement).toBe(screen.getByTestId('ProviderSheet.adoptConfirm'))
    expect(panel).toHaveAttribute('role', 'group')
    expect(document.getElementById(panel.getAttribute('aria-labelledby')!)).toHaveTextContent(
      'opencode and pi hold different OpenRouter keys.'
    )
    await click(screen.getByTestId('ProviderSheet.adoptConfirm'))
    expect(sent('shared-provider:adopt-native')).toEqual([['openrouter', 'pi']])
  })

  it('Cancel backs out of the confirm without writing', async () => {
    snapshot = { entries: [conflicted], opencodeInstalled: true }
    await openSheet('opencode:openrouter')
    await click(screen.getByTestId('ProviderSheet.adoptKeep'))
    await click(screen.getByTestId('ProviderSheet.adoptCancel'))
    // Focus goes back to the button that opened the confirm.
    expect(document.activeElement).toBe(screen.getByTestId('ProviderSheet.adoptKeep'))
    expect(sent('shared-provider:adopt-native')).toEqual([])
  })

  it('Keep them separate dismisses the panel for this session', async () => {
    snapshot = { entries: [{ ...conflicted, id: 'opencode:groq-x' }], opencodeInstalled: true }
    await openSheet('opencode:groq-x')
    await click(screen.getByTestId('ProviderSheet.keepSeparate'))
    expect(screen.queryByTestId('ProviderSheet.keyConflict')).toBeNull()
    expect(sent('shared-provider:adopt-native')).toEqual([])
    cleanup()
    await openSheet('opencode:groq-x')
    expect(screen.queryByTestId('ProviderSheet.keyConflict')).toBeNull()
  })

  it('names short keys by engine alone, so the options stay distinguishable', async () => {
    snapshot = {
      entries: [{ ...openrouter, keyConflict: { opencode: '…', pi: '…' } }],
      opencodeInstalled: true
    }
    await openSheet('opencode:openrouter')
    expect(screen.getAllByTestId('ProviderSheet.keepKey').map((el) => el.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('Keep opencode’s key')])
    )
    for (const el of screen.getAllByTestId('ProviderSheet.keepKey'))
      expect(el.textContent).not.toContain('(…)')
  })

  it('keeping them separate also hides the list’s “2 different keys” chip', async () => {
    snapshot = {
      entries: [
        { ...openrouter, id: 'opencode:mistral', keyConflict: { opencode: '…1111', pi: '…2222' } }
      ],
      opencodeInstalled: true
    }
    await openSheet('opencode:mistral')
    const row = screen
      .getAllByTestId('ProviderList.row')
      .find((el) => el.dataset.id === 'opencode:mistral')!
    expect(within(row).getByTestId('ProviderList.keyConflict')).toBeInTheDocument()
    await click(screen.getByTestId('ProviderSheet.keepSeparate'))
    expect(within(row).queryByTestId('ProviderList.keyConflict')).toBeNull()
  })

  it('offers a key only one engine holds to both engines', async () => {
    snapshot = { entries: [{ ...openrouter, adoptable: 'opencode' }], opencodeInstalled: true }
    await openSheet('opencode:openrouter')
    expect(screen.getByTestId('ProviderSheet.adoptable')).toHaveTextContent(
      'This key is only in opencode.'
    )
    await click(screen.getByTestId('ProviderSheet.adopt'))
    expect(sent('shared-provider:adopt-native')).toEqual([['openrouter', 'opencode']])
  })
})
