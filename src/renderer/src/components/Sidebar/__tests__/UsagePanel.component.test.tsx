/**
 * Layer 2: Component test for UsagePanel's weekly per-model bars.
 *
 * The server-labeled weekly buckets (`rate_limits.limits[]`, kind
 * "weekly_scoped" — e.g. Fable) arrive as `AccountUsage.sevenDayModels`. Their
 * label is server-supplied, so the panel must render one bar per entry without
 * knowing any model name, and must not double-render a model the legacy
 * seven_day_opus / seven_day_sonnet windows already cover.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, within, fireEvent } from '@testing-library/react'
import type { AccountUsage } from '../../../../../shared/types'

// UsagePanel reads a handful of slices off the store; `chatgptLimits` and its
// loader are ADR-068 §2's per-account ChatGPT usage.
const { store } = vi.hoisted(() => ({
  store: {
    blockUsage: null as unknown,
    setActiveView: vi.fn(),
    chatgptLimits: null as unknown,
    loadChatgptLimits: vi.fn(async () => {})
  }
}))

vi.mock('../../../stores/session-store', () => ({
  useSessionStore: (selector: (s: typeof store) => unknown) => selector(store)
}))

import { UsagePanel } from '../UsagePanel'

function makeUsage(overrides: Partial<AccountUsage> = {}): AccountUsage {
  return {
    fiveHour: { usedPercent: 39, resetsAt: null },
    sevenDay: { usedPercent: 18, resetsAt: null },
    sevenDaySonnet: null,
    sevenDayOpus: null,
    sevenDayModels: null,
    extraUsage: null,
    planName: 'max',
    fetchedAt: Date.now(),
    error: null,
    accountLabel: null,
    ...overrides
  }
}

/** The bar labelled `label`, or null when the panel didn't render one. */
function bar(label: string): HTMLElement | null {
  return document.querySelector(`[data-testid="UsageProgressBar"][data-id="${label}"]`)
}

describe('UsagePanel — weekly per-model bars', () => {
  afterEach(cleanup)

  it('renders one bar per sevenDayModels entry, labelled from the server', () => {
    render(
      <UsagePanel
        usage={makeUsage({
          sevenDayModels: [
            { label: 'Fable', window: { usedPercent: 32, resetsAt: null } },
            { label: 'Quill', window: { usedPercent: 7, resetsAt: null } }
          ]
        })}
        onRefresh={vi.fn()}
      />
    )

    const fable = bar('7-Day Fable')
    expect(fable).not.toBeNull()
    expect(within(fable!).getByText('32%')).toBeInTheDocument()
    expect(within(bar('7-Day Quill')!).getByText('7%')).toBeInTheDocument()
  })

  it('renders no per-model bar when sevenDayModels is null', () => {
    render(<UsagePanel usage={makeUsage()} onRefresh={vi.fn()} />)

    expect(screen.getByTestId('UsagePanel')).toBeInTheDocument()
    expect(bar('7-Day Fable')).toBeNull()
    expect(screen.getAllByTestId('UsageProgressBar')).toHaveLength(2) // 5-hour + 7-day
  })

  it('skips a scoped entry the legacy per-model window already renders', () => {
    render(
      <UsagePanel
        usage={makeUsage({
          sevenDayOpus: { usedPercent: 11, resetsAt: null },
          sevenDayModels: [
            { label: 'opus', window: { usedPercent: 11, resetsAt: null } },
            { label: 'Fable', window: { usedPercent: 32, resetsAt: null } }
          ]
        })}
        onRefresh={vi.fn()}
      />
    )

    // "7-Day Opus" is the legacy bar; the scoped duplicate adds nothing.
    expect(screen.getAllByTestId('UsageProgressBar')).toHaveLength(4)
    expect(bar('7-Day opus')).toBeNull()
    expect(bar('7-Day Opus')).not.toBeNull()
    expect(bar('7-Day Fable')).not.toBeNull()
  })
})

/**
 * Slice 2b guard 7 (panel half) — ChatGPT usage, one block per vault account
 * (ADR-068 §2).
 *
 * Per ACCOUNT, not per subscription: the whole reason for several accounts is
 * seeing which one is near its limit, so a block that did not name its account
 * would be useless the moment there is more than one.
 */
describe('UsagePanel — the ChatGPT section', () => {
  beforeEach(() => {
    store.chatgptLimits = null
    store.loadChatgptLimits.mockClear()
  })
  afterEach(cleanup)

  const limits = {
    'acct-a': {
      email: 'a@example.test',
      planType: 'pro',
      primary: { usedPercent: 42, resetsAt: null },
      secondary: { usedPercent: 7, resetsAt: null },
      fetchedAt: 0
    },
    'acct-b': {
      email: 'b@example.test',
      planType: 'plus',
      primary: { usedPercent: 90, resetsAt: null },
      secondary: null,
      fetchedAt: 0
    }
  }

  it('reads the limits when the panel opens, and shows nothing until they arrive', () => {
    render(<UsagePanel usage={makeUsage()} onRefresh={vi.fn()} />)

    expect(store.loadChatgptLimits).toHaveBeenCalledWith(true)
    // No accounts read yet: no empty ChatGPT heading hanging off the panel.
    expect(screen.queryByTestId('UsagePanel.chatgpt')).toBeNull()
  })

  it('renders one block per account, with both windows', () => {
    store.chatgptLimits = limits
    render(<UsagePanel usage={makeUsage()} onRefresh={vi.fn()} />)

    const blocks = screen.getAllByTestId('UsagePanel.chatgptAccount')
    expect(blocks.map((block) => block.getAttribute('data-id'))).toEqual([
      'a@example.test',
      'b@example.test'
    ])
    expect(within(blocks[0]).getByText('42%')).toBeInTheDocument()
    expect(within(blocks[0]).getByText('7%')).toBeInTheDocument()
    expect(within(blocks[0]).getByText('pro')).toBeInTheDocument()
    // The second account reported no weekly window — one bar, not a 0% second.
    expect(within(blocks[1]).getAllByTestId('UsageProgressBar')).toHaveLength(1)
    expect(within(blocks[1]).getByText('90%')).toBeInTheDocument()
  })

  it('says a window is unavailable rather than drawing it at zero', () => {
    store.chatgptLimits = {
      'acct-c': { email: 'c@example.test', primary: null, secondary: null, fetchedAt: 0 }
    }
    render(<UsagePanel usage={makeUsage()} onRefresh={vi.fn()} />)

    const block = screen.getByTestId('UsagePanel.chatgptAccount')
    expect(within(block).queryAllByTestId('UsageProgressBar')).toHaveLength(0)
    expect(within(block).getByText('No usage data for this account')).toBeInTheDocument()
  })

  it('falls back to the account id when the JWT carried no email', () => {
    store.chatgptLimits = {
      'acct-d': { primary: { usedPercent: 5, resetsAt: null }, secondary: null, fetchedAt: 0 }
    }
    render(<UsagePanel usage={makeUsage()} onRefresh={vi.fn()} />)
    expect(screen.getByTestId('UsagePanel.chatgptAccount').getAttribute('data-id')).toBe('acct-d')
  })

  // Slice J: the heading read `limits.email ?? accountId`, so an EMPTY email
  // beat the id fallback and the block lost its name entirely — the one thing
  // a per-account panel cannot afford.
  it('falls back to the account id for an EMPTY email too, not a blank heading', () => {
    store.chatgptLimits = {
      'acct-e': {
        email: '  ',
        primary: { usedPercent: 5, resetsAt: null },
        secondary: null,
        fetchedAt: 0
      }
    }
    render(<UsagePanel usage={makeUsage()} onRefresh={vi.fn()} />)
    const block = screen.getByTestId('UsagePanel.chatgptAccount')
    expect(block.getAttribute('data-id')).toBe('acct-e')
    expect(block).toHaveTextContent('acct-e')
  })

  it('Refresh re-reads the ChatGPT accounts too, not just Claude', () => {
    store.chatgptLimits = limits
    const onRefresh = vi.fn()
    render(<UsagePanel usage={makeUsage()} onRefresh={onRefresh} />)
    store.loadChatgptLimits.mockClear()

    fireEvent.click(screen.getByTestId('UsagePanel.refresh'))

    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(store.loadChatgptLimits).toHaveBeenCalledWith(true)
  })
})

/**
 * Credits-based plans in the panel (owner's real business workspace, 2026-09-14).
 *
 * Three render states, and the point of separating them is that "this plan is
 * not metered in percentages" and "we could not read this account" are different
 * statements — the first one is useful, the second is an apology.
 */
describe('UsagePanel — ChatGPT credits', () => {
  beforeEach(() => {
    store.chatgptLimits = null
    store.loadChatgptLimits.mockClear()
  })
  afterEach(cleanup)

  const account = (over: Record<string, unknown>): Record<string, unknown> => ({
    'acct-biz': {
      email: 'biz@example.test',
      primary: null,
      secondary: null,
      fetchedAt: 0,
      ...over
    }
  })
  const block = (): HTMLElement => screen.getByTestId('UsagePanel.chatgptAccount')

  it('shows the balance instead of the no-data line when only credits exist', () => {
    store.chatgptLimits = account({ credits: { unlimited: false, balance: '42.50' } })
    render(<UsagePanel usage={makeUsage()} onRefresh={vi.fn()} />)

    expect(within(block()).getByTestId('UsagePanel.chatgptCredits').textContent).toBe(
      'Credits: 42.50'
    )
    expect(within(block()).queryByText('No usage data for this account')).toBeNull()
    expect(within(block()).queryAllByTestId('UsageProgressBar')).toHaveLength(0)
  })

  it('says unlimited rather than printing an empty balance', () => {
    store.chatgptLimits = account({ credits: { unlimited: true, balance: null } })
    render(<UsagePanel usage={makeUsage()} onRefresh={vi.fn()} />)
    expect(within(block()).getByTestId('UsagePanel.chatgptCredits').textContent).toBe(
      'Unlimited credits'
    )
  })

  it('adds the credits line UNDER the bars when an account has both', () => {
    store.chatgptLimits = account({
      primary: { usedPercent: 42, resetsAt: null },
      credits: { unlimited: false, balance: '9.00' }
    })
    render(<UsagePanel usage={makeUsage()} onRefresh={vi.fn()} />)

    expect(within(block()).getAllByTestId('UsageProgressBar')).toHaveLength(1)
    expect(within(block()).getByTestId('UsagePanel.chatgptCredits').textContent).toBe(
      'Credits: 9.00'
    )
  })

  it('keeps the no-data line only when there is neither a window nor a credit', () => {
    store.chatgptLimits = account({})
    render(<UsagePanel usage={makeUsage()} onRefresh={vi.fn()} />)

    expect(within(block()).queryByTestId('UsagePanel.chatgptCredits')).toBeNull()
    expect(within(block()).getByText('No usage data for this account')).toBeInTheDocument()
  })
})

/**
 * S2f change 1 — the Claude meters name their account.
 *
 * The ChatGPT section has named its accounts since ADR-068 §2, while the Claude
 * bars above it named nothing: on a machine with two Anthropic subscriptions
 * the popup showed a set of percentages with no way to tell whose they were.
 * The label is `AccountUsage.accountLabel`, filled by the fetcher from the
 * account it just resolved, and it is ABSENT rather than blank when no account
 * is resolved — an unnamed heading would be worse than none.
 */
describe('UsagePanel — the Claude account heading', () => {
  beforeEach(() => {
    store.chatgptLimits = null
    store.loadChatgptLimits.mockClear()
  })
  afterEach(cleanup)

  it('names the account above the Claude meters', () => {
    render(
      <UsagePanel
        usage={makeUsage({ accountLabel: 'alice@example.test (Company)' })}
        onRefresh={vi.fn()}
      />
    )

    const heading = screen.getByTestId('UsagePanel.claudeAccount')
    expect(heading.getAttribute('data-id')).toBe('alice@example.test (Company)')
    expect(heading).toHaveTextContent('alice@example.test (Company)')
  })

  it('omits the heading when no account is resolved', () => {
    render(<UsagePanel usage={makeUsage({ accountLabel: null })} onRefresh={vi.fn()} />)

    expect(screen.queryByTestId('UsagePanel.claudeAccount')).toBeNull()
    expect(screen.getAllByTestId('UsageProgressBar')).toHaveLength(2)
  })

  it('renders a cache written before the field existed', () => {
    // `loadCache()` hands back whatever the old file held, so the panel has to
    // survive a payload with no `accountLabel` key at all.
    const legacy = makeUsage()
    delete (legacy as Partial<AccountUsage>).accountLabel
    render(<UsagePanel usage={legacy} onRefresh={vi.fn()} />)

    expect(screen.queryByTestId('UsagePanel.claudeAccount')).toBeNull()
    expect(screen.getAllByTestId('UsageProgressBar')).toHaveLength(2)
  })
})
