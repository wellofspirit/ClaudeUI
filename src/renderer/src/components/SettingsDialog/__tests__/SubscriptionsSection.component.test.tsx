/**
 * Layer 2: Models & providers › Subscriptions (ADR-074 §7, mockup `829a066c`).
 *
 * One card per sign-in subscription: header, account list, Engines row,
 * folded Options. What is pinned here is what a screenshot cannot check:
 *
 *  · the switch CONSEQUENCE — counted from the live sessions in the store, per
 *    provider's own rule (Claude: every live Claude session; ChatGPT: the Codex
 *    sessions that follow the active account, the routes that switch too, and
 *    the pinned sessions that do not);
 *  · every write lands on the channel the retired account panes used
 *    (`account:*`, `provider-account:*`), and only after its inline confirm;
 *  · the Anthropic card with Multiple accounts OFF still shows who you are, and
 *    "+ Add account" turns the option on instead of hiding;
 *  · Manage opens the ONE provider sheet on the subscription, which drops its
 *    Credential group there.
 *
 * Writes go over the real bridge (`bootTestApp`), asserted by channel.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, act, within } from '@testing-library/react'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import {
  SubscriptionsSection,
  chatgptSwitchConsequence,
  claudeSwitchConsequence,
  countLiveSessions,
  removeConsequence
} from '../SubscriptionsSection'
import { EMPTY_SESSION_STATE, useSessionStore } from '../../../stores/session-store'
import type { PerSessionState } from '../../../stores/session-store'
import type {
  ProviderAccounts,
  ProviderEntry,
  ProviderRegistrySnapshot
} from '../../../../../shared/provider-registry'
import type { AccountsState, EngineId } from '../../../../../shared/types'

// ── Fixtures ─────────────────────────────────────────────────────────

const anthropic: ProviderEntry = {
  id: 'anthropic',
  name: 'Anthropic',
  origin: 'anthropic',
  credential: 'signed-in',
  engines: { claude: { enabled: true } },
  subscription: true,
  identity: { label: 'dev@acme.com', plan: 'Claude Team' },
  detail: 'dev@acme.com · Claude Team'
}

const twoChatgpt: ProviderAccounts = {
  activeId: 'acc-1',
  perSession: false,
  list: [
    {
      id: 'acc-1',
      email: 'daniel@example.com',
      accountId: 'f99404d9-cb7e-4a1f-9e0b-2c55e1d7a3b0',
      planType: 'business'
    },
    {
      id: 'acc-2',
      email: 'work@example.com',
      accountId: '7d2ae51d-7a1c-4f0e-b3c2-81d6e0aa42f9',
      planType: 'pro'
    }
  ]
}

const chatgpt: ProviderEntry = {
  id: 'chatgpt',
  name: 'ChatGPT',
  origin: 'shared',
  credential: 'connected',
  subscription: true,
  engines: {
    opencode: { enabled: true, native: true, providerId: 'openai' },
    pi: { enabled: true, native: true, providerId: 'openai-codex' },
    codex: { enabled: true }
  },
  accounts: twoChatgpt,
  piBuiltinId: 'openai-codex'
}

/** An API provider: never a card here. */
const openrouter: ProviderEntry = {
  id: 'opencode:openrouter',
  name: 'OpenRouter',
  origin: 'opencode-native',
  credential: 'api-key',
  engines: { opencode: { enabled: true, native: true, providerId: 'openrouter' } }
}

const claudeAccounts = (over: Partial<AccountsState> = {}): AccountsState => ({
  enabled: true,
  activeId: 'a1',
  accounts: [
    {
      id: 'a1',
      email: 'dev@acme.com',
      subscriptionType: 'Claude Team',
      organization: null,
      createdAt: 0
    },
    {
      id: 'a2',
      email: 'me@home.com',
      subscriptionType: 'Claude Max',
      organization: null,
      createdAt: 0
    }
  ],
  ...over
})

/** A live (process-backed) session on `engine`, optionally pinned to a Codex account. */
function live(engine: EngineId, pinnedAccountId: string | null = null): PerSessionState {
  return {
    ...EMPTY_SESSION_STATE,
    sdkActive: true,
    selectedEngineId: engine,
    status: {
      ...EMPTY_SESSION_STATE.status,
      engineId: engine,
      ...(engine === 'codex'
        ? { codex: { pinnedAccountId } as NonNullable<PerSessionState['status']['codex']> }
        : {})
    }
  }
}

// ── Harness ──────────────────────────────────────────────────────────

let app: TestApp
let snapshot: ProviderRegistrySnapshot
let accounts: AccountsState
let calls: Array<{ channel: string; args: unknown[] }>

function stub(channel: string, answer: (...args: unknown[]) => unknown = () => undefined): void {
  app.bridge.ipcMain.handle(channel, async (_e: unknown, ...args: unknown[]) => {
    calls.push({ channel, args })
    return answer(...args)
  })
}

const sent = (channel: string): unknown[][] =>
  calls.filter((c) => c.channel === channel).map((c) => c.args)

beforeEach(async () => {
  app = await bootTestApp()
  calls = []
  snapshot = { entries: [anthropic, chatgpt, openrouter], opencodeInstalled: true }
  accounts = claudeAccounts()
  useSessionStore.setState({
    providerRegistry: snapshot,
    accountsState: null,
    signInDialog: null,
    sessions: {}
  })
  stub('provider-registry:list', () => snapshot)
  stub('account:get', () => accounts)
  stub('account:switch', () => accounts)
  stub('account:delete', () => accounts)
  stub('account:set-enabled', (enabled) => {
    accounts = { ...accounts, enabled: enabled as boolean }
    return accounts
  })
  stub('provider-account:switch')
  stub('provider-account:remove')
  stub('provider-account:set-per-session')
  // The Engines row's counts come from the curation reads; the sheet's too.
  app.bridge.ipcMain.handle('session:get-opencode-provider-models', async () => [
    { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
    { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
    { id: 'gpt-6-sol', name: 'GPT-6 Sol' }
  ])
  app.bridge.ipcMain.handle('config:load-opencode-settings', async () => ({
    modelAllowlist: { openai: ['gpt-5.6-luna'] }
  }))
  app.bridge.ipcMain.handle('session:get-pi-model-catalog', async () => [
    {
      engineId: 'pi',
      vendorId: 'openai-codex',
      vendorName: 'openai-codex',
      models: ['gpt-5.6-luna', 'gpt-5.6-sol'].map((id) => ({
        value: `openai-codex/${id}`,
        displayName: id,
        description: '',
        engineId: 'pi'
      }))
    }
  ])
  app.bridge.ipcMain.handle('config:load-engine-config', async () => ({}))
  app.bridge.ipcMain.handle('session:get-engine-models', async () => [])
  app.bridge.ipcMain.handle('shared-provider:list', async () => [
    {
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
  ])
})

afterEach(() => {
  cleanup()
  app.teardown()
})

async function renderSection(): Promise<void> {
  await act(async () => {
    render(<SubscriptionsSection />)
  })
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(el)
  })
}

const card = (id: string): HTMLElement =>
  screen.getAllByTestId('SubscriptionsSection.card').find((el) => el.dataset.id === id)!
const account = (id: string): HTMLElement =>
  screen.getAllByTestId('SubscriptionsSection.account').find((el) => el.dataset.id === id)!
const byId = (scope: HTMLElement, testid: string, id: string): HTMLElement =>
  within(scope)
    .getAllByTestId(testid)
    .find((el) => el.dataset.id === id)!
const menuItem = (scope: HTMLElement, id: string): HTMLElement =>
  byId(scope, 'SubscriptionsSection.menuItem', id)

function withChatgpt(over: Partial<ProviderEntry>): void {
  snapshot = {
    ...snapshot,
    entries: snapshot.entries.map((e) => (e.id === 'chatgpt' ? { ...e, ...over } : e))
  }
  useSessionStore.setState({ providerRegistry: snapshot })
}

// ── The section ──────────────────────────────────────────────────────

describe('the section', () => {
  it('one card per SUBSCRIPTION, in registry order — never an API provider', async () => {
    await renderSection()
    expect(screen.getAllByTestId('SubscriptionsSection.card').map((el) => el.dataset.id)).toEqual([
      'anthropic',
      'chatgpt'
    ])
  })

  it('says it is loading, not "Not signed in", before the registry answers', async () => {
    useSessionStore.setState({ providerRegistry: null })
    app.bridge.ipcMain.handle('provider-registry:list', () => new Promise(() => {}))
    await renderSection()
    const root = screen.getByTestId('SubscriptionsSection')
    expect(within(root).getByTestId('SubscriptionsSection.loading')).toBeInTheDocument()
    expect(screen.queryByText('Not signed in')).not.toBeInTheDocument()
  })

  it('never nests a button inside a button', async () => {
    await renderSection()
    for (const button of Array.from(document.querySelectorAll('button'))) {
      expect(button.querySelector('button')).toBeNull()
    }
  })

  it('the logos are decorative — the provider name is right beside them', async () => {
    await renderSection()
    for (const logo of screen.getAllByTestId('SubscriptionsSection.logo')) {
      expect(logo.querySelector('img')).toHaveAttribute('alt', '')
    }
  })
})

// ── Anthropic ────────────────────────────────────────────────────────

describe('Anthropic', () => {
  it('header: name, account count, subtitle and a Signed in pill', async () => {
    await renderSection()
    const anth = card('anthropic')
    expect(byId(anth, 'SubscriptionsSection.logo', 'claude')).toBeInTheDocument()
    expect(within(anth).getByTestId('SubscriptionsSection.accountCount')).toHaveTextContent(
      '· 2 accounts'
    )
    expect(anth).toHaveTextContent('Claude subscription')
    expect(within(anth).getByTestId('SubscriptionsSection.cardStatus')).toHaveAttribute(
      'data-id',
      'signed-in'
    )
  })

  it('Set active confirms in place, COUNTING the live Claude sessions it disconnects', async () => {
    useSessionStore.setState({
      sessions: {
        s1: live('claude'),
        s2: live('claude'),
        s3: live('codex'),
        // Not live: no process, nothing to disconnect.
        s4: { ...EMPTY_SESSION_STATE, selectedEngineId: 'claude' }
      }
    })
    await renderSection()
    expect(within(account('a1')).getByTestId('SubscriptionsSection.status')).toHaveTextContent(
      'Active'
    )

    await click(byId(account('a2'), 'SubscriptionsSection.setActive', 'a2'))
    const confirm = within(account('a2')).getByTestId('SubscriptionsSection.confirm')
    expect(confirm).toHaveTextContent('Set me@home.com as the active account?')
    expect(confirm).toHaveTextContent(
      '2 running Claude sessions disconnect and resume on their next message.'
    )
    // The confirm takes focus, on its primary button.
    expect(within(confirm).getByTestId('SubscriptionsSection.confirmActivate')).toHaveFocus()
    // Nothing is written until the confirm.
    expect(sent('account:switch')).toEqual([])

    await click(within(confirm).getByTestId('SubscriptionsSection.confirmActivate'))
    expect(sent('account:switch')).toEqual([['a2']])
  })

  it('Cancel closes the confirm, writes nothing, and gives focus back', async () => {
    await renderSection()
    const setActive = byId(account('a2'), 'SubscriptionsSection.setActive', 'a2')
    setActive.focus()
    await click(setActive)
    await click(within(account('a2')).getByTestId('SubscriptionsSection.cancel'))
    expect(
      within(account('a2')).queryByTestId('SubscriptionsSection.confirm')
    ).not.toBeInTheDocument()
    expect(sent('account:switch')).toEqual([])
    expect(byId(account('a2'), 'SubscriptionsSection.setActive', 'a2')).toHaveFocus()
  })

  it('removing the ACTIVE account is a switch: it names who takes over, and counts', async () => {
    useSessionStore.setState({ sessions: { s1: live('claude') } })
    await renderSection()
    await click(byId(account('a1'), 'SubscriptionsSection.more', 'a1'))
    await click(menuItem(account('a1'), 'remove'))
    const confirm = within(account('a1')).getByTestId('SubscriptionsSection.confirm')
    expect(confirm).toHaveTextContent('Remove dev@acme.com?')
    // Claude promotes the FIRST remaining account.
    expect(confirm).toHaveTextContent('me@home.com becomes the active account.')
    expect(confirm).toHaveTextContent(
      '1 running Claude session disconnects and resumes on its next message.'
    )
    await click(within(confirm).getByTestId('SubscriptionsSection.confirmRemove'))
    expect(sent('account:delete')).toEqual([['a1']])
  })

  it('removing the LAST account says Claude falls back to its own sign-in', async () => {
    accounts = claudeAccounts({ accounts: [claudeAccounts().accounts[0]] })
    await renderSection()
    await click(byId(account('a1'), 'SubscriptionsSection.more', 'a1'))
    await click(menuItem(account('a1'), 'remove'))
    const confirm = within(account('a1')).getByTestId('SubscriptionsSection.confirm')
    expect(confirm).toHaveTextContent('Claude goes back to')
    expect(confirm).not.toHaveTextContent('becomes the active account')
    expect(confirm).not.toHaveTextContent('Another account')
  })

  it('"Sign in again" is on the active row only, and blames no account', async () => {
    await renderSection()
    await click(byId(account('a2'), 'SubscriptionsSection.more', 'a2'))
    expect(
      within(account('a2'))
        .getAllByTestId('SubscriptionsSection.menuItem')
        .map((el) => el.dataset.id)
    ).toEqual(['activate', 'remove'])

    await click(byId(account('a1'), 'SubscriptionsSection.more', 'a1'))
    // One menu open at a time.
    expect(screen.getAllByTestId('SubscriptionsSection.menu')).toHaveLength(1)
    await click(menuItem(account('a1'), 'reauth'))
    expect(useSessionStore.getState().signInDialog).toEqual({
      providerId: 'anthropic',
      mode: 'reauth'
    })
  })

  it('Multiple accounts OFF: one row for who you are, with Sign in again and nothing to switch', async () => {
    accounts = claudeAccounts({ enabled: false })
    await renderSection()
    const anth = card('anthropic')
    const rows = within(anth).getAllByTestId('SubscriptionsSection.account')
    expect(rows.map((el) => el.dataset.id)).toEqual(['signed-in'])
    expect(rows[0]).toHaveTextContent('dev@acme.com')
    expect(rows[0]).toHaveTextContent('Claude Team')
    expect(within(anth).queryByTestId('SubscriptionsSection.setActive')).not.toBeInTheDocument()
    expect(within(anth).queryByTestId('SubscriptionsSection.more')).not.toBeInTheDocument()
    await click(within(rows[0]).getByTestId('SubscriptionsSection.reauth'))
    expect(useSessionStore.getState().signInDialog).toEqual({
      providerId: 'anthropic',
      mode: 'reauth'
    })
  })

  it('"+ Add account" with Multiple accounts OFF confirms BEFORE it writes anything', async () => {
    accounts = claudeAccounts({ enabled: false })
    useSessionStore.setState({ sessions: { s1: live('claude'), s2: live('claude') } })
    await renderSection()
    const anth = card('anthropic')
    expect(anth).toHaveTextContent('turns on Multiple accounts')
    await click(within(anth).getByTestId('SubscriptionsSection.addAccount'))

    // Turning it on moves Claude's credential: nothing happens until confirmed.
    expect(sent('account:set-enabled')).toEqual([])
    const confirm = within(anth).getByTestId('SubscriptionsSection.confirm')
    expect(confirm).toHaveAttribute('data-id', 'multi-on')
    expect(confirm).toHaveTextContent(
      '2 running Claude sessions disconnect and resume on their next message.'
    )
    expect(confirm).toHaveTextContent('You’ll sign in again for this account.')
    expect(within(confirm).getByTestId('SubscriptionsSection.plaintextNotice')).toBeInTheDocument()

    await click(within(confirm).getByTestId('SubscriptionsSection.confirmMulti'))
    expect(sent('account:set-enabled')).toEqual([[true]])
    // Then the (empty, active) account is signed in — `reauth`, not `add`.
    expect(useSessionStore.getState().signInDialog).toEqual({
      providerId: 'anthropic',
      mode: 'reauth'
    })
  })

  it('Cancel on that confirm leaves Multiple accounts off', async () => {
    accounts = claudeAccounts({ enabled: false })
    await renderSection()
    const anth = card('anthropic')
    await click(within(anth).getByTestId('SubscriptionsSection.addAccount'))
    await click(within(anth).getByTestId('SubscriptionsSection.cancel'))
    expect(sent('account:set-enabled')).toEqual([])
    expect(useSessionStore.getState().signInDialog).toBeNull()
  })

  it('the Options switch confirms too, in both directions', async () => {
    await renderSection()
    const anth = card('anthropic')
    const options = within(anth).getByTestId('SubscriptionsSection.options')
    expect(options).not.toHaveAttribute('open')
    expect(within(anth).getByTestId('SubscriptionsSection.optionsSummary')).toHaveTextContent(
      'Multiple accounts on'
    )
    // The notice only while the option is on.
    expect(within(options).getByTestId('SubscriptionsSection.plaintextNotice')).toBeInTheDocument()

    // OFF: says where the credential comes from instead, and what it disconnects.
    const toggle = within(anth).getByTestId('SubscriptionsSection.multiAccountToggle')
    expect(toggle).toHaveAccessibleName('Multiple accounts')
    await click(toggle)
    expect(sent('account:set-enabled')).toEqual([])
    const confirm = within(options).getByTestId('SubscriptionsSection.confirm')
    expect(confirm).toHaveAttribute('data-id', 'multi-off')
    expect(confirm).toHaveTextContent('Claude goes back to')
    expect(confirm).toHaveTextContent('the stored accounts stay, unused')
    await click(within(confirm).getByTestId('SubscriptionsSection.confirmMulti'))
    expect(sent('account:set-enabled')).toEqual([[false]])
    // Turning it OFF starts no sign-in.
    expect(useSessionStore.getState().signInDialog).toBeNull()
    expect(
      within(anth).queryByTestId('SubscriptionsSection.plaintextNotice')
    ).not.toBeInTheDocument()
  })

  it('signed out with Multiple accounts off: one "Sign in to Claude"', async () => {
    accounts = claudeAccounts({ enabled: false })
    snapshot = {
      ...snapshot,
      entries: snapshot.entries.map((e) =>
        e.id === 'anthropic'
          ? { ...anthropic, credential: 'none' as const, identity: undefined }
          : e
      )
    }
    useSessionStore.setState({ providerRegistry: snapshot })
    await renderSection()
    const anth = card('anthropic')
    expect(within(anth).getByTestId('SubscriptionsSection.cardStatus')).toHaveTextContent(
      'Not signed in'
    )
    await click(within(anth).getByTestId('SubscriptionsSection.signIn'))
    expect(useSessionStore.getState().signInDialog).toEqual({
      providerId: 'anthropic',
      mode: 'reauth'
    })
  })

  it('an unchecked sign-in says so — neither "Signed in" nor "Not signed in"', async () => {
    accounts = claudeAccounts({ enabled: false })
    snapshot = {
      ...snapshot,
      entries: snapshot.entries.map((e) =>
        e.id === 'anthropic'
          ? {
              ...anthropic,
              credential: 'none' as const,
              identity: undefined,
              signInUnknown: true as const
            }
          : e
      )
    }
    useSessionStore.setState({ providerRegistry: snapshot })
    await renderSection()
    const anth = card('anthropic')
    expect(within(anth).getByTestId('SubscriptionsSection.cardStatus')).toHaveAttribute(
      'data-id',
      'unknown'
    )
    expect(within(anth).getByTestId('SubscriptionsSection.unknown')).toHaveTextContent(
      'Sign-in status is checked when the first Claude session starts.'
    )
    expect(within(anth).queryByTestId('SubscriptionsSection.signIn')).not.toBeInTheDocument()
  })

  it('the Engines row is Claude, always on, with no Manage', async () => {
    await renderSection()
    const engines = within(card('anthropic')).getByTestId('SubscriptionsSection.engines')
    expect(
      within(engines)
        .getAllByTestId('SubscriptionsSection.enginePill')
        .map((el) => el.dataset.id)
    ).toEqual(['claude'])
    expect(engines).toHaveTextContent('Always on')
    expect(within(engines).queryByTestId('SubscriptionsSection.manage')).not.toBeInTheDocument()
  })
})

// ── The ⋯ menu ───────────────────────────────────────────────────────

describe('the ⋯ menu', () => {
  it('takes focus, moves with the arrows, and Escape returns focus to its trigger', async () => {
    await renderSection()
    const trigger = byId(account('a1'), 'SubscriptionsSection.more', 'a1')
    await click(trigger)
    const items = within(account('a1')).getAllByTestId('SubscriptionsSection.menuItem')
    expect(items[0]).toHaveFocus()
    await act(async () => {
      fireEvent.keyDown(items[0], { key: 'ArrowDown' })
    })
    expect(items[1]).toHaveFocus()
    await act(async () => {
      fireEvent.keyDown(items[1], { key: 'ArrowUp' })
    })
    expect(items[0]).toHaveFocus()
    await act(async () => {
      fireEvent.keyDown(items[0], { key: 'Escape' })
    })
    expect(screen.queryByTestId('SubscriptionsSection.menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('an outside click closes it', async () => {
    await renderSection()
    await click(byId(account('a1'), 'SubscriptionsSection.more', 'a1'))
    expect(screen.getByTestId('SubscriptionsSection.menu')).toBeInTheDocument()
    await act(async () => {
      fireEvent.mouseDown(document.body)
    })
    expect(screen.queryByTestId('SubscriptionsSection.menu')).not.toBeInTheDocument()
  })
})

// ── ChatGPT ──────────────────────────────────────────────────────────

describe('ChatGPT', () => {
  it('header and rows: Connected, plan, and a copyable workspace', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    await renderSection()
    const gpt = card('chatgpt')
    expect(byId(gpt, 'SubscriptionsSection.logo', 'codex')).toBeInTheDocument()
    expect(within(gpt).getByTestId('SubscriptionsSection.cardStatus')).toHaveTextContent(
      'Connected'
    )
    const workspace = within(account('acc-1')).getByTestId('SubscriptionsSection.workspace')
    expect(workspace).toHaveTextContent(/^workspace\s*f99404d9…/)
    expect(within(workspace).getByTitle(/not a directory/)).toBeInTheDocument()
    await click(within(workspace).getByTestId('SubscriptionsSection.copyWorkspace'))
    expect(writeText).toHaveBeenCalledWith('f99404d9-cb7e-4a1f-9e0b-2c55e1d7a3b0')
  })

  it('Set active counts the Codex FOLLOWERS and the pinned sessions that stay', async () => {
    useSessionStore.setState({
      sessions: { s1: live('codex'), s2: live('codex'), s3: live('codex', 'acc-1') }
    })
    await renderSection()
    await click(byId(account('acc-2'), 'SubscriptionsSection.setActive', 'acc-2'))
    const consequence = within(account('acc-2')).getByTestId('SubscriptionsSection.consequence')
    // A pin belongs to the session: counted even with per-session pinning off.
    expect(consequence).toHaveTextContent(
      '2 running Codex sessions that follow the active account disconnect and resume on their next message. New opencode and pi sessions use it too. 1 pinned Codex session keeps its account.'
    )
    await click(within(account('acc-2')).getByTestId('SubscriptionsSection.confirmActivate'))
    expect(sent('provider-account:switch')).toEqual([['chatgpt', 'acc-2']])
  })

  it('a disabled route is not named', async () => {
    withChatgpt({ engines: { ...chatgpt.engines, pi: { enabled: false } } })
    await renderSection()
    await click(byId(account('acc-2'), 'SubscriptionsSection.setActive', 'acc-2'))
    expect(
      within(account('acc-2')).getByTestId('SubscriptionsSection.consequence')
    ).toHaveTextContent('New opencode sessions use it too.')
  })

  it('removing a non-active account says nothing about succession', async () => {
    await renderSection()
    await click(byId(account('acc-2'), 'SubscriptionsSection.more', 'acc-2'))
    await click(menuItem(account('acc-2'), 'remove'))
    const confirm = within(account('acc-2')).getByTestId('SubscriptionsSection.confirm')
    expect(confirm).not.toHaveTextContent('becomes the active account')
    await click(within(confirm).getByTestId('SubscriptionsSection.confirmRemove'))
    expect(sent('provider-account:remove')).toEqual([['chatgpt', 'acc-2']])
  })

  it('removing the active account names the NEWEST remaining one as its successor', async () => {
    withChatgpt({
      accounts: {
        ...twoChatgpt,
        list: [
          ...twoChatgpt.list,
          { id: 'acc-3', email: 'newest@example.com', accountId: 'ws-3', planType: 'plus' }
        ]
      }
    })
    await renderSection()
    await click(byId(account('acc-1'), 'SubscriptionsSection.more', 'acc-1'))
    await click(menuItem(account('acc-1'), 'remove'))
    expect(within(account('acc-1')).getByTestId('SubscriptionsSection.confirm')).toHaveTextContent(
      'newest@example.com becomes the active account.'
    )
  })

  it('removing the LAST account says ChatGPT is disconnected from every engine', async () => {
    withChatgpt({ accounts: { ...twoChatgpt, list: [twoChatgpt.list[0]] } })
    await renderSection()
    await click(byId(account('acc-1'), 'SubscriptionsSection.more', 'acc-1'))
    await click(menuItem(account('acc-1'), 'remove'))
    const confirm = within(account('acc-1')).getByTestId('SubscriptionsSection.confirm')
    expect(confirm).toHaveTextContent('ChatGPT is then disconnected from every engine.')
    expect(confirm).not.toHaveTextContent('Another account')
  })

  it('a signed-out ACTIVE account: amber header, row and engines, and Sign in again blaming it', async () => {
    withChatgpt({
      accounts: {
        ...twoChatgpt,
        list: twoChatgpt.list.map((a) => (a.id === 'acc-1' ? { ...a, needsReauth: true } : a))
      }
    })
    await renderSection()
    const gpt = card('chatgpt')
    expect(within(gpt).getByTestId('SubscriptionsSection.cardStatus')).toHaveTextContent(
      'Active account signed out'
    )
    expect(within(account('acc-1')).getByTestId('SubscriptionsSection.status')).toHaveTextContent(
      'Signed out'
    )
    expect(within(gpt).getByTestId('SubscriptionsSection.enginesWaiting')).toBeInTheDocument()
    await click(byId(account('acc-1'), 'SubscriptionsSection.reauth', 'acc-1'))
    expect(useSessionStore.getState().signInDialog).toEqual({
      providerId: 'chatgpt',
      mode: 'reauth',
      accountId: 'acc-1'
    })
  })

  it('"Sign in again" on a HEALTHY active row blames no account; a healthy other row has none', async () => {
    await renderSection()
    await click(byId(account('acc-2'), 'SubscriptionsSection.more', 'acc-2'))
    expect(
      within(account('acc-2'))
        .getAllByTestId('SubscriptionsSection.menuItem')
        .map((el) => el.dataset.id)
    ).toEqual(['activate', 'copy', 'remove'])

    await click(byId(account('acc-1'), 'SubscriptionsSection.more', 'acc-1'))
    await click(menuItem(account('acc-1'), 'reauth'))
    expect(useSessionStore.getState().signInDialog).toEqual({
      providerId: 'chatgpt',
      mode: 'reauth'
    })
  })

  it('the Engines row: Codex, then each route with its curation count, dim "off" when off', async () => {
    withChatgpt({ engines: { ...chatgpt.engines, pi: { enabled: false } } })
    await renderSection()
    const engines = within(card('chatgpt')).getByTestId('SubscriptionsSection.engines')
    const pill = (id: string): HTMLElement => byId(engines, 'SubscriptionsSection.enginePill', id)
    expect(
      within(engines)
        .getAllByTestId('SubscriptionsSection.enginePill')
        .map((el) => el.dataset.id)
    ).toEqual(['codex', 'opencode', 'pi'])
    await vi.waitFor(() => expect(pill('opencode')).toHaveTextContent('opencode1 of 3'))
    expect(pill('pi')).toHaveAttribute('data-on', 'false')
    expect(pill('pi')).toHaveTextContent('off')
  })

  it('the pill counts re-read on a model reload', async () => {
    await renderSection()
    const engines = within(card('chatgpt')).getByTestId('SubscriptionsSection.engines')
    const pill = (): HTMLElement => byId(engines, 'SubscriptionsSection.enginePill', 'opencode')
    await vi.waitFor(() => expect(pill()).toHaveTextContent('1 of 3'))

    app.bridge.ipcMain.handle('config:load-opencode-settings', async () => ({
      modelAllowlist: { openai: ['gpt-5.6-luna', 'gpt-5.6-sol'] }
    }))
    await act(async () => {
      useSessionStore.getState().reloadModels()
    })
    await vi.waitFor(() => expect(pill()).toHaveTextContent('2 of 3'))
  })

  it('Manage opens the provider sheet on the subscription, without its Credential group', async () => {
    await renderSection()
    await click(within(card('chatgpt')).getByTestId('SubscriptionsSection.manage'))
    const sheet = await screen.findByTestId('ProviderSheet')
    expect(sheet).toHaveAttribute('data-id', 'chatgpt')
    expect(sheet).toHaveTextContent('ChatGPT · engines & models')
    expect(
      within(sheet)
        .getAllByTestId('ProviderSheet.group')
        .map((el) => el.dataset.id)
    ).not.toContain('credential')
  })

  it('per-session pinning is an Option, written through the vault — once there are two accounts', async () => {
    await renderSection()
    const gpt = card('chatgpt')
    expect(within(gpt).getByTestId('SubscriptionsSection.optionsSummary')).toHaveTextContent(
      'All engines follow the active account'
    )
    const toggle = within(gpt).getByTestId('SubscriptionsSection.perSessionToggle')
    expect(toggle).toHaveAccessibleName('Pin an account per Codex session')
    await click(toggle)
    expect(sent('provider-account:set-per-session')).toEqual([['chatgpt', true]])
    cleanup()

    withChatgpt({ accounts: { ...twoChatgpt, list: [twoChatgpt.list[0]] } })
    await renderSection()
    expect(
      within(card('chatgpt')).queryByTestId('SubscriptionsSection.perSessionToggle')
    ).not.toBeInTheDocument()
  })

  it('not signed in: the card body is one "Sign in with ChatGPT"', async () => {
    withChatgpt({ credential: 'none', accounts: undefined })
    await renderSection()
    const gpt = card('chatgpt')
    expect(within(gpt).getByTestId('SubscriptionsSection.cardStatus')).toHaveTextContent(
      'Not signed in'
    )
    expect(within(gpt).queryByTestId('SubscriptionsSection.engines')).not.toBeInTheDocument()
    await click(within(gpt).getByTestId('SubscriptionsSection.signIn'))
    expect(useSessionStore.getState().signInDialog).toEqual({
      providerId: 'chatgpt',
      mode: 'reauth'
    })
  })

  it('a sign-in completed in the dialog reaches the card when the dialog closes', async () => {
    // The dialog is not a write here, so only its close re-reads the registry.
    withChatgpt({ accounts: { ...twoChatgpt, list: [twoChatgpt.list[0]] } })
    await renderSection()
    expect(within(card('chatgpt')).getAllByTestId('SubscriptionsSection.account')).toHaveLength(1)
    await click(within(card('chatgpt')).getByTestId('SubscriptionsSection.addAccount'))
    expect(useSessionStore.getState().signInDialog).toEqual({ providerId: 'chatgpt', mode: 'add' })

    snapshot = { ...snapshot, entries: [anthropic, chatgpt, openrouter] }
    await act(async () => {
      useSessionStore.getState().closeSignIn()
    })
    await vi.waitFor(() =>
      expect(within(card('chatgpt')).getAllByTestId('SubscriptionsSection.account')).toHaveLength(2)
    )
  })
})

// ── The wording, on its own ──────────────────────────────────────────

describe('consequences', () => {
  it('counts only live sessions, and splits Codex by pin', () => {
    expect(
      countLiveSessions({
        a: live('claude'),
        b: live('codex'),
        c: live('codex', 'acc-9'),
        d: { ...EMPTY_SESSION_STATE, selectedEngineId: 'codex' },
        e: live('opencode')
      })
    ).toEqual({ claude: 1, codexFollowing: 1, codexPinned: 1 })
  })

  it('switching reads naturally at 0, 1 and many', () => {
    expect(claudeSwitchConsequence(0)).toBe('No running Claude session is affected.')
    expect(claudeSwitchConsequence(1)).toBe(
      '1 running Claude session disconnects and resumes on its next message.'
    )
    expect(chatgptSwitchConsequence({ codexFollowing: 0, codexPinned: 0 }, [])).toBe(
      'No running Codex session that follows the active account is affected.'
    )
    expect(
      chatgptSwitchConsequence({ codexFollowing: 0, codexPinned: 2 }, ['opencode', 'pi'])
    ).toBe(
      'No running Codex session that follows the active account is affected. New opencode and pi sessions use it too. 2 pinned Codex sessions keep their account.'
    )
  })

  it('removal: non-active, active with a successor, and the last account', () => {
    expect(removeConsequence({ active: false, successor: 'b@x', sessions: 'S.' })).toBe(
      'Its stored sign-in is deleted. You can add it back by signing in.'
    )
    expect(
      removeConsequence({ active: true, successor: 'b@x', lastAccount: 'L.', sessions: 'S.' })
    ).toBe(
      'Its stored sign-in is deleted. b@x becomes the active account. S. You can add it back by signing in.'
    )
    expect(removeConsequence({ active: true, lastAccount: 'L.', sessions: 'S.' })).toBe(
      'Its stored sign-in is deleted. L. S. You can add it back by signing in.'
    )
  })
})
