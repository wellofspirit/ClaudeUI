/**
 * Layer 2: the ChatGPT half of Models & providers › Accounts (F14, ADR-068 §2).
 *
 * Every provider's stored accounts live on ONE page now. The row-level cases
 * below moved verbatim from `ProviderSheet.component.test.tsx` — same
 * assertions, same channels, only the test ids and the render target changed —
 * and the new ones pin what the re-homing added: the switch-semantics sentence
 * (ADR-068 §2, deliberately NOT the same rule as Claude's), the "ChatGPT
 * workspace" wording, the empty state, and the honest unknown while the registry
 * has not answered.
 *
 * Every action is asserted by CHANNEL over the real bridge: a radio that
 * re-rendered without writing, or one that wrote to the wrong account id, would
 * look identical on screen.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act, within } from '@testing-library/react'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { ChatgptAccountsSetting } from '../ChatgptAccountsSetting'
import { SECTIONS } from '../settings-sections'
import { useSessionStore } from '../../../stores/session-store'
import type {
  ProviderAccounts,
  ProviderEntry,
  ProviderRegistrySnapshot
} from '../../../../../shared/provider-registry'

const twoAccounts: ProviderAccounts = {
  activeId: 'acc-1',
  perSession: false,
  list: [
    { id: 'acc-1', email: 'daniel@example.com', accountId: 'ws-11112222', planType: 'pro' },
    { id: 'acc-2', email: 'work@example.com', accountId: 'ws-33334444', planType: 'business' }
  ]
}

const chatgpt: ProviderEntry = {
  id: 'chatgpt',
  name: 'ChatGPT',
  origin: 'shared',
  credential: 'connected',
  engines: {
    opencode: { enabled: true, native: true },
    pi: { enabled: true, native: true },
    codex: { enabled: true }
  },
  detail: 'ChatGPT subscription · shared with pi and opencode'
}

const anthropic: ProviderEntry = {
  id: 'anthropic',
  name: 'Anthropic',
  origin: 'anthropic',
  credential: 'signed-in',
  engines: { claude: { enabled: true } }
}

let app: TestApp
let snapshot: ProviderRegistrySnapshot
/** Every `channel → args` the pane sent, in order. */
let calls: Array<{ channel: string; args: unknown[] }>

function stub(channel: string, answer: (...args: unknown[]) => unknown = () => undefined): void {
  app.bridge.ipcMain.handle(channel, async (_e: unknown, ...args: unknown[]) => {
    calls.push({ channel, args })
    return answer(...args)
  })
}

const sent = (channel: string): unknown[][] =>
  calls.filter((c) => c.channel === channel).map((c) => c.args)

/** Seed the store's registry snapshot, as `refreshProviderAuth` would. */
function withAccounts(accounts: ProviderAccounts | undefined): void {
  snapshot = {
    entries: [anthropic, accounts ? { ...chatgpt, accounts } : chatgpt],
    opencodeInstalled: true
  }
  useSessionStore.setState({ providerRegistry: snapshot })
}

beforeEach(async () => {
  app = await bootTestApp()
  calls = []
  // The store is a module singleton outliving `teardown()`: a case must not open
  // on the rows the previous one left behind.
  useSessionStore.setState({ providerRegistry: null, signInDialog: null })
  snapshot = { entries: [anthropic, chatgpt], opencodeInstalled: true }
  stub('provider-registry:list', () => snapshot)
  stub('provider-account:switch')
  stub('provider-account:remove')
  stub('provider-account:set-per-session')
})

afterEach(() => {
  cleanup()
  app.teardown()
})

const accountRow = (id: string): HTMLElement =>
  screen.getAllByTestId('ChatgptAccounts.account').find((el) => el.dataset.id === id)!

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(el)
  })
}

async function renderPane(): Promise<void> {
  await act(async () => {
    render(<ChatgptAccountsSetting />)
  })
}

// ── The rows (moved from ProviderSheet) ──────────────────────────────

describe('the account rows', () => {
  it('renders one row per account, with the active one selected', async () => {
    withAccounts(twoAccounts)
    await renderPane()
    expect(screen.getAllByTestId('ChatgptAccounts.account').map((el) => el.dataset.id)).toEqual([
      'acc-1',
      'acc-2'
    ])
    expect(accountRow('acc-1')).toHaveTextContent('daniel@example.com')
    // The plan and a shortened workspace id, so two rows of the same person's
    // accounts are still tellable apart.
    expect(accountRow('acc-2')).toHaveTextContent('business')
    expect(within(accountRow('acc-1')).getByRole('radio')).toBeChecked()
    expect(within(accountRow('acc-2')).getByRole('radio')).not.toBeChecked()
    expect(screen.getByTestId('ChatgptAccounts')).toHaveTextContent('ChatGPT')
  })

  it('the radio switches the ACTIVE account through provider-account:switch', async () => {
    withAccounts(twoAccounts)
    await renderPane()
    await act(async () => {
      fireEvent.click(within(accountRow('acc-2')).getByRole('radio'))
    })
    expect(sent('provider-account:switch')).toEqual([['chatgpt', 'acc-2']])
    // Re-read after the write: the rows are the only thing that know it changed.
    expect(sent('provider-registry:list').length).toBeGreaterThan(0)
  })

  it('does not re-switch to the account that is already active', async () => {
    withAccounts(twoAccounts)
    await renderPane()
    await act(async () => {
      fireEvent.click(within(accountRow('acc-1')).getByRole('radio'))
    })
    expect(sent('provider-account:switch')).toEqual([])
  })

  it('Remove destroys one account, and only after a confirm', async () => {
    withAccounts(twoAccounts)
    await renderPane()
    const remove = (): HTMLElement =>
      screen
        .getAllByTestId('ChatgptAccounts.accountRemove')
        .find((el) => el.dataset.id === 'acc-2')!
    await click(remove())
    expect(sent('provider-account:remove')).toEqual([])
    expect(remove()).toHaveTextContent('Remove?')
    await click(remove())
    expect(sent('provider-account:remove')).toEqual([['chatgpt', 'acc-2']])
  })

  it('the per-session toggle writes set-per-session, and is hidden with ONE account', async () => {
    withAccounts(twoAccounts)
    await renderPane()
    await click(screen.getByTestId('ChatgptAccounts.perSessionToggle'))
    expect(sent('provider-account:set-per-session')).toEqual([['chatgpt', true]])

    cleanup()
    withAccounts({ ...twoAccounts, list: [twoAccounts.list[0]] })
    await renderPane()
    // Nothing to pin between: the toggle would configure a choice of one.
    expect(screen.queryByTestId('ChatgptAccounts.perSession')).not.toBeInTheDocument()
  })

  it('Add account opens the ONE sign-in dialog, and no flow renders here', async () => {
    // ADR-068 §3: there is one sign-in surface; this row only asks for it.
    withAccounts(twoAccounts)
    await renderPane()
    await click(screen.getByTestId('ChatgptAccounts.addAccount'))
    expect(useSessionStore.getState().signInDialog).toEqual({
      providerId: 'chatgpt',
      mode: 'add'
    })
    expect(screen.queryByTestId('VendorOAuthFlow')).not.toBeInTheDocument()
  })

  it('reads at 390px — every account row keeps its radio and its Remove', async () => {
    withAccounts(twoAccounts)
    window.innerWidth = 390
    window.dispatchEvent(new Event('resize'))
    await renderPane()
    for (const id of ['acc-1', 'acc-2']) {
      expect(within(accountRow(id)).getByRole('radio')).toBeInTheDocument()
    }
    expect(screen.getAllByTestId('ChatgptAccounts.accountRemove')).toHaveLength(2)
    window.innerWidth = 1280
    window.dispatchEvent(new Event('resize'))
  })
})

// ── What the re-homing added ─────────────────────────────────────────

describe('the page section', () => {
  it('follows the store snapshot, so a sign-in elsewhere lands here', async () => {
    withAccounts(undefined)
    await renderPane()
    expect(screen.queryAllByTestId('ChatgptAccounts.account')).toEqual([])
    act(() => withAccounts(twoAccounts))
    expect(screen.getAllByTestId('ChatgptAccounts.account')).toHaveLength(2)
  })

  it('states the SWITCH RULE as built: followers disconnect and resume, pins stay (ADR-069 §4)', async () => {
    withAccounts(twoAccounts)
    await renderPane()
    const rule = screen.getByTestId('ChatgptAccounts.switchRule')
    expect(rule).toHaveTextContent(
      'Switching disconnects every running Codex session that follows the active account; each resumes with the new account on its next message. A session pinned to an account keeps it. pi and opencode follow the active account.'
    )
  })

  it('says what a ChatGPT workspace IS — it is not a directory', async () => {
    withAccounts(twoAccounts)
    await renderPane()
    expect(screen.getByTestId('ChatgptAccounts.workspaceNote')).toHaveTextContent(
      'A ChatGPT workspace is the ChatGPT organisation an account belongs to, not a directory.'
    )
  })

  it('names the workspace on the account line, never a bare "Workspace"', async () => {
    withAccounts(twoAccounts)
    await renderPane()
    expect(accountRow('acc-1')).toHaveTextContent('pro · ChatGPT workspace ws-11112222')
    expect(accountRow('acc-1').textContent).not.toMatch(/(^|[^T])Workspace ws-/)
  })

  it('shortens a long workspace id rather than letting it push the row', async () => {
    withAccounts({
      ...twoAccounts,
      list: [{ ...twoAccounts.list[0], accountId: 'ws-0123456789abcdef0123' }]
    })
    await renderPane()
    expect(accountRow('acc-1')).toHaveTextContent('ChatGPT workspace ws-0123456789a…')
  })

  it('with no stored account, offers the sign-in instead of an empty card', async () => {
    withAccounts(undefined)
    await renderPane()
    expect(screen.queryAllByTestId('ChatgptAccounts.account')).toEqual([])
    await click(screen.getByTestId('ChatgptAccounts.signIn'))
    expect(useSessionStore.getState().signInDialog).toEqual({
      providerId: 'chatgpt',
      mode: 'reauth'
    })
  })

  it('renders NOTHING until the registry has answered — the honest unknown', async () => {
    // A read that never lands: the pane must not guess "no account" meanwhile,
    // and it asks ONCE on mount so a page opened before boot's read (or after
    // one that failed) is a moment of nothing, not a permanent blank.
    useSessionStore.setState({ providerRegistry: null })
    const before = sent('provider-registry:list').length
    stub('provider-registry:list', () => new Promise<never>(() => {}))
    await renderPane()
    expect(screen.queryByTestId('ChatgptAccounts')).not.toBeInTheDocument()
    expect(sent('provider-registry:list').length).toBe(before + 1)
  })

  it('reads the registry on mount when the store has none, and then renders', async () => {
    useSessionStore.setState({ providerRegistry: null })
    await renderPane()
    expect(await screen.findByTestId('ChatgptAccounts')).toBeInTheDocument()
    expect(screen.getByTestId('ChatgptAccounts.heading')).toHaveTextContent('ChatGPT')
    expect(useSessionStore.getState().providerRegistry).not.toBeNull()
  })
})

// ── The page wiring ──────────────────────────────────────────────────

describe('the Accounts section', () => {
  it('carries both providers, in rail order, and is searchable by either', () => {
    // One page for every provider's accounts (F14): a group rendered by nobody
    // is the failure this catches, and the mobile host walks the same items.
    const section = SECTIONS.find((candidate) => candidate.id === 'accounts')!
    expect(section.items.map((item) => item.key)).toEqual(['multiAccount', 'chatgptAccounts'])
    const keywords = section.items.map((item) => item.keywords ?? '').join(' ')
    expect(keywords).toContain('anthropic')
    expect(keywords).toContain('chatgpt')
  })
})
