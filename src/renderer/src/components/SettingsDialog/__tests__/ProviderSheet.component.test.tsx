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
import { useSessionStore } from '../../../stores/session-store'
import type {
  ProviderEntry,
  ProviderRegistrySnapshot
} from '../../../../../shared/provider-registry'
import type { SharedProviderDefinition } from '../../../../../shared/shared-provider'
import type { SettingsTarget } from '../settings-target'

// ── Fixtures ─────────────────────────────────────────────────────────

const chatgpt: ProviderEntry = {
  id: 'chatgpt',
  name: 'ChatGPT',
  origin: 'shared',
  credential: 'connected',
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

/** The render context's navigator — the Accounts link row's destination. */
let navigate: ReturnType<typeof vi.fn<(target: SettingsTarget) => void>>

beforeEach(async () => {
  app = await bootTestApp()
  navigate = vi.fn()
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

/** Render the list and open one provider's sheet. */
async function openSheet(id: string): Promise<HTMLElement> {
  render(<ProviderList navigate={navigate} />)
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

  it('carries a read-only Codex row saying the account is not chosen per engine', async () => {
    // Codex is injection, not a route (ADR-068 §1): there is nothing to toggle,
    // and a row that offered one would promise a switch the vault does not have.
    await openSheet('chatgpt')
    expect(engineRow('codex')).toHaveTextContent('Codex always uses the active ChatGPT account.')
    expect(engineRow('codex')).toHaveTextContent('Pin a different one per session')
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

  it('disconnects a subscription only on the second press', async () => {
    const sheet = await openSheet('chatgpt')
    expect(sheet).toHaveTextContent('Connected as ChatGPT')
    await click(screen.getByTestId('ProviderSheet.disconnect'))
    expect(sent('shared-provider:disconnect')).toEqual([])
    await click(screen.getByTestId('ProviderSheet.disconnect'))
    expect(sent('shared-provider:disconnect')).toEqual([['chatgpt']])
  })
})

// ── Accounts (ADR-068 §2, re-homed by F14) ───────────────────────────

/**
 * Accounts are no longer MANAGED here. Every provider's stored accounts live on
 * Models & providers › Accounts (F14), so the sheet keeps exactly two things:
 * one link row that says how many accounts there are and where they are, and
 * the provider-wide "Disconnect all accounts" in the footer. The row-level
 * cases moved verbatim to `ChatgptAccountsSetting.component.test.tsx`.
 */
describe('ACCOUNTS', () => {
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

  it('replaces the account rows with ONE link row naming the count', async () => {
    withAccounts(twoAccounts)
    const sheet = await openSheet('chatgpt')
    const link = screen.getByTestId('ProviderSheet.accountsLink')
    expect(link).toHaveTextContent('2 accounts')
    expect(link).toHaveTextContent('managed on Accounts')
    // Two homes for one list is exactly what F14 removed.
    expect(screen.queryAllByTestId('ProviderSheet.account')).toEqual([])
    expect(screen.queryByTestId('ProviderSheet.accountRemove')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ProviderSheet.perSession')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ProviderSheet.addAccount')).not.toBeInTheDocument()
    expect(sheet).toHaveTextContent('Accounts')
  })

  it('the link navigates to Models & providers › Accounts', async () => {
    withAccounts(twoAccounts)
    await openSheet('chatgpt')
    await click(screen.getByTestId('ProviderSheet.manageAccounts'))
    expect(navigate).toHaveBeenCalledWith({ page: 'models', group: 'accounts' })
    // The sheet closes with the jump: a page that changed BEHIND an open sheet
    // is what the live drive showed, and it reads as a link that did nothing.
    expect(screen.queryByTestId('ProviderSheet.accountsLink')).not.toBeInTheDocument()
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

  it('falls back to the single-credential row when the registry reports no accounts', async () => {
    // A row from a build (or a boot) with no account list must not render an
    // empty Accounts card that looks like "you have no subscription".
    await openSheet('chatgpt')
    expect(screen.queryByTestId('ProviderSheet.accountsLink')).not.toBeInTheDocument()
    expect(screen.getByTestId('ProviderSheet.credential')).toHaveTextContent('Connected')
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
    await openSheet('opencode:openrouter')
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
    await openSheet('opencode:openrouter')
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
    await openSheet('opencode:openrouter')
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

  it('the header chip and the engine row say what the block says, not the registry', async () => {
    // The registry fixture claims 2 curated models; one of the stored ids is gone
    // from the catalog, so the block counts 1 — and so must everything else.
    app.bridge.ipcMain.handle('config:load-opencode-settings', async () => ({
      modelAllowlist: { openrouter: ['moonshotai/kimi-k3', 'openai/gone'] }
    }))
    await openSheet('opencode:openrouter')
    const chip = await screen.findByText('opencode · 1 of 3')
    expect(chip).toHaveAttribute('data-testid', 'ProviderSheet.modelsEngine')
    expect(engineRow('opencode')).toHaveTextContent('1 of 3 models reach the picker.')

    await click(mode('all'))
    expect(screen.getByTestId('ProviderSheet.modelsEngine')).toHaveTextContent('opencode · all 3')
    expect(engineRow('opencode')).toHaveTextContent('3 models reach the picker.')
  })

  it('choosing All models with a selection deletes the key', async () => {
    await openSheet('opencode:openrouter')
    expect(mode('pick')).toHaveTextContent('Only the ones I pick · 2')
    await click(mode('all'))
    expect(sent('models:set-provider-allowlist')).toEqual([['opencode', 'openrouter', null]])
    expect(screen.getByTestId('ProviderSheet.curationModeRow')).toHaveTextContent(
      'Every model OpenRouter offers is shown, including ones added later.'
    )
  })

  it('Select all acts on what the search narrowed to', async () => {
    await openSheet('opencode:openrouter')
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
    await openSheet('opencode:openrouter')
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
    await openSheet('opencode:openrouter')
    expect(screen.queryAllByTestId('ProviderSheet.models.lock')).toEqual([])
    await click(row('moonshotai/kimi-k3'))
    expect(sent('models:set-provider-allowlist')).toEqual([
      ['opencode', 'openrouter', ['openai/gpt-5-6-luna']]
    ])
  })

  it('“Curate models ›” focuses the list’s search box', async () => {
    await openSheet('opencode:openrouter')
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
    await openSheet('chatgpt')
    expect(tabs()).toEqual(['opencode', 'pi'])
    await screen.findByText('1 of 2')
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

  it('a single-engine provider gets no tabs, and pi curation writes pi', async () => {
    app.bridge.ipcMain.handle('session:get-pi-model-catalog', async () => [
      piGroup('groq', ['llama-4', 'kimi'])
    ])
    await openSheet('pi:groq')
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
    await openSheet('ollama-local')
    const models = await screen.findByTestId('ProviderSheet.models')
    expect(models).toHaveAttribute('data-id', 'empty')
    expect(models).toHaveTextContent('pi reports no models for this provider')
  })

  it('“Curate models ›” on the pi row opens the pi tab', async () => {
    app.bridge.ipcMain.handle('session:get-opencode-provider-models', async () => [
      { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' }
    ])
    app.bridge.ipcMain.handle('session:get-pi-model-catalog', async () => [
      piGroup('openai-codex', ['gpt-5.6-luna'])
    ])
    await openSheet('chatgpt')
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

  it('a disconnected subscription opens the sign-in dialog, not the Add sheet', async () => {
    // One sign-in surface, and since ADR-068 §3 it is the dialog.
    snapshot = {
      ...snapshot,
      entries: snapshot.entries.map((e) =>
        e.id === 'chatgpt' ? { ...e, credential: 'none' as const } : e
      )
    }
    await openSheet('chatgpt')
    await click(screen.getByTestId('ProviderSheet.signIn'))

    expect(useSessionStore.getState().signInDialog).toEqual({
      providerId: 'chatgpt',
      mode: 'reauth'
    })
    expect(screen.queryByTestId('ProviderAddSheet')).not.toBeInTheDocument()
    expect(screen.queryByTestId('VendorOAuthFlow')).not.toBeInTheDocument()
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
