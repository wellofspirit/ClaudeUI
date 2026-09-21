/**
 * `UsageView` — the dashboard SHELL (ADR-071 §8, slice S4b-1).
 *
 * What was here before S4b-1 tested the widgets the shell used to inline: the
 * Claude tab group, its panels and their empty states. Those moved verbatim into
 * `ClaudeBlocksDrillIn` behind an Anthropic account row, so their assertions
 * moved to `AccountsPanel.component.test.tsx` rather than being dropped. The
 * opencode and Delegated sections the shell carried until S4b-2 are gone with
 * it: the ledger covers every engine now, and delegated work is an inline
 * marker on whichever `BreakdownTable` row it ran under.
 *
 * What is left here is the shell's own job — the reads, the guard, the controls
 * — plus one assertion per widget that it is mounted and given what it needs.
 * Each widget's own behaviour is tested beside it. S4c split the widgets across
 * two tabs and dropped `ResetTimeline`, so "which widgets are up" is now a
 * question about the tab, and the tab strip has its own section at the bottom.
 *
 * The rule this file exists to guard is the refresh grant (ADR-071 §6): NOTHING
 * automatic may send `fetchAccountLimits(true)`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { UsageView } from '../UsageView'
import { useSessionStore } from '../../../stores/session-store'
import type { BlockUsageData } from '../../../../../shared/types'
import { makeDashboard, makeLimits, makeTotals, makeWindow } from './dashboard-fixtures'

// The shell's two push subscriptions, captured so a test can fire them. The
// real registry defers a listener when no transport client exists, which would
// swallow the emit.
const syncHandlers = new Map<string, (...args: unknown[]) => void>()
vi.mock('../../../../../core/shared/sync/client-registry', () => ({
  onSyncEvent: (channel: string, cb: (...args: unknown[]) => void) => {
    syncHandlers.set(channel, cb)
    return () => syncHandlers.delete(channel)
  }
}))

// The summary's variant fork is the only thing in the shell that reads the
// viewport, and jsdom has no layout.
const mockIsMobile = vi.fn(() => false)
vi.mock('../../../hooks/useIsMobile', () => ({
  useIsMobile: () => mockIsMobile(),
  MOBILE_BREAKPOINT: 768
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBlockUsage(overrides: Partial<BlockUsageData> = {}): BlockUsageData {
  return {
    currentBlock: null,
    recentBlocks: [],
    todaySnapshots: [],
    dailyHistory: [],
    accounts: [],
    accountFilter: null,
    perEngine: undefined,
    ...overrides
  } as unknown as BlockUsageData
}

let mockFetchDashboard: ReturnType<typeof vi.fn>
let mockFetchLimits: ReturnType<typeof vi.fn>
let mockFetchWindows: ReturnType<typeof vi.fn>
let mockRefreshPrices: ReturnType<typeof vi.fn>

beforeEach(() => {
  syncHandlers.clear()
  mockIsMobile.mockReturnValue(false)
  window.localStorage.clear()
  mockFetchDashboard = vi.fn().mockResolvedValue(makeDashboard())
  mockFetchLimits = vi.fn().mockResolvedValue([makeLimits()])
  // `WindowValue` does its own read; without it the widget throws on mount.
  mockFetchWindows = vi.fn().mockResolvedValue([])
  mockRefreshPrices = vi.fn().mockResolvedValue({ count: 412, refreshedAt: Date.now() })

  // Assign api directly on the existing window object — do NOT replace window
  // itself, as that breaks waitFor's container check (it loses the document ref).
  ;(window as any).api = {
    setUsageAccountFilter: vi.fn().mockResolvedValue(undefined),
    fetchUsageDashboard: mockFetchDashboard,
    fetchAccountLimits: mockFetchLimits,
    fetchUsageWindows: mockFetchWindows,
    refreshPrices: mockRefreshPrices
  }

  useSessionStore.setState({ blockUsage: null, accountUsage: null } as any)
})

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

describe('UsageView — load', () => {
  it('shows the loading card until the dashboard query answers, then the widgets', async () => {
    let resolve!: (d: unknown) => void
    mockFetchDashboard.mockReturnValue(new Promise((r) => (resolve = r)))
    render(<UsageView onClose={vi.fn()} />)

    expect(screen.getByTestId('UsageView.loading')).toBeInTheDocument()
    expect(screen.queryByTestId('Summary')).not.toBeInTheDocument()

    resolve(makeDashboard({ totals: makeTotals({ displayCostUsd: 12.5 }) }))
    await waitFor(() => expect(screen.getByTestId('Summary')).toBeInTheDocument())
    expect(screen.queryByTestId('UsageView.loading')).not.toBeInTheDocument()
    expect(screen.getByTestId('Summary.hero')).toHaveTextContent('$12.50')
    expect(screen.getByTestId('AccountsPanel')).toBeInTheDocument()
  })

  it('asks for today and the stored limits on mount', async () => {
    render(<UsageView onClose={vi.fn()} />)
    await waitFor(() => expect(mockFetchDashboard).toHaveBeenCalledWith('today'))
    expect(mockFetchLimits).toHaveBeenCalledWith(false)
  })

  it('reports a failed dashboard query instead of spinning forever', async () => {
    mockFetchDashboard.mockRejectedValue(new Error('database is locked'))
    render(<UsageView onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('UsageView.error')).toBeInTheDocument())
    expect(screen.getByTestId('UsageView.error')).toHaveTextContent('database is locked')
    expect(screen.queryByTestId('UsageView.loading')).not.toBeInTheDocument()
  })

  it('renders the summary strip below the mobile breakpoint', async () => {
    mockIsMobile.mockReturnValue(true)
    render(<UsageView onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('Summary.strip')).toBeInTheDocument())
    expect(screen.queryByTestId('Summary.coverageBar')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Range
// ---------------------------------------------------------------------------

describe('UsageView — range control', () => {
  it('refetches with the new range and remembers it for next time', async () => {
    render(<UsageView onClose={vi.fn()} />)
    await waitFor(() => expect(mockFetchDashboard).toHaveBeenCalledWith('today'))

    fireEvent.click(screen.getByTestId('UsageView.range.7d'))
    await waitFor(() => expect(mockFetchDashboard).toHaveBeenCalledWith('7d'))
    expect(window.localStorage.getItem('claudeui.usage.range')).toBe('7d')
  })

  it('opens on the stored range', async () => {
    window.localStorage.setItem('claudeui.usage.range', '90d')
    render(<UsageView onClose={vi.fn()} />)
    await waitFor(() => expect(mockFetchDashboard).toHaveBeenCalledWith('90d'))
    expect(screen.getByTestId('UsageView.range.90d')).toHaveAttribute('data-active', 'true')
  })

  it('ignores a stored value that is not a range', async () => {
    window.localStorage.setItem('claudeui.usage.range', 'all-time')
    render(<UsageView onClose={vi.fn()} />)
    await waitFor(() => expect(mockFetchDashboard).toHaveBeenCalledWith('today'))
  })

  it('leaves a stored range alone — the default only applies to a fresh viewer', async () => {
    window.localStorage.setItem('claudeui.usage.range', '30d')
    render(<UsageView onClose={vi.fn()} />)
    await waitFor(() => expect(mockFetchDashboard).toHaveBeenCalledWith('30d'))
    expect(screen.getByTestId('UsageView.range.30d')).toHaveAttribute('data-active', 'true')
  })

  it('offers Today as the first pill, spelled as a word', async () => {
    render(<UsageView onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('UsageView.range')).toBeInTheDocument())
    const pills = screen.getByTestId('UsageView.range').querySelectorAll('button')
    expect(pills[0]).toHaveAttribute('data-testid', 'UsageView.range.today')
    expect(pills[0]).toHaveTextContent('Today')
    expect(pills[0]).toHaveAttribute('data-active', 'true')
  })

  it('carries the group-by for the breakdown S4b-2 mounts', async () => {
    render(<UsageView onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('UsageView.groupBy')).toBeInTheDocument())
    expect(screen.getByTestId('UsageView.groupBy')).toHaveAttribute('data-value', 'provider')
    fireEvent.click(screen.getByTestId('UsageView.groupBy.model'))
    expect(screen.getByTestId('UsageView.groupBy')).toHaveAttribute('data-value', 'model')
  })
})

// ---------------------------------------------------------------------------
// Push channels
// ---------------------------------------------------------------------------

describe('UsageView — live nudges', () => {
  it('rereads the ledger a debounce after a turn lands, once for a burst', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      render(<UsageView onClose={vi.fn()} />)
      await waitFor(() => expect(mockFetchDashboard).toHaveBeenCalledTimes(1))

      const onBlockData = syncHandlers.get('usage:block-data')
      expect(onBlockData).toBeDefined()
      onBlockData!({})
      onBlockData!({})
      // Still the mount read: a nudge is not a query.
      expect(mockFetchDashboard).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(2_000)
      await waitFor(() => expect(mockFetchDashboard).toHaveBeenCalledTimes(2))
      // The ledger moved, not the limits.
      expect(mockFetchLimits).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rereads BOTH after a limits reading moves, and still never with refresh: true', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      render(<UsageView onClose={vi.fn()} />)
      await waitFor(() => expect(mockFetchLimits).toHaveBeenCalledTimes(1))

      syncHandlers.get('usage:limits-changed')!()
      await vi.advanceTimersByTimeAsync(2_000)
      await waitFor(() => expect(mockFetchLimits).toHaveBeenCalledTimes(2))
      expect(mockFetchDashboard).toHaveBeenCalledTimes(2)
      expect(mockFetchLimits.mock.calls.every(([refresh]) => refresh === false)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// The refresh grant (ADR-071 §6)
// ---------------------------------------------------------------------------

describe('UsageView — limits refresh', () => {
  it('never sends refresh: true on its own', async () => {
    render(<UsageView onClose={vi.fn()} />)
    await waitFor(() => expect(mockFetchLimits).toHaveBeenCalled())
    fireEvent.click(screen.getByTestId('UsageView.range.7d'))
    await waitFor(() => expect(mockFetchDashboard).toHaveBeenCalledWith('7d'))
    expect(mockFetchLimits.mock.calls.every(([refresh]) => refresh === false)).toBe(true)
  })

  it('sends refresh: true exactly once per press and shows a spinner while it runs', async () => {
    let resolve!: (rows: unknown) => void
    render(<UsageView onClose={vi.fn()} />)
    await waitFor(() => expect(mockFetchLimits).toHaveBeenCalledWith(false))

    mockFetchLimits.mockReturnValue(new Promise((r) => (resolve = r)))
    const btn = screen.getByTestId('UsageView.refreshLimits')
    fireEvent.click(btn)
    await waitFor(() =>
      expect(screen.getByTestId('UsageView.refreshLimits.spinner')).toBeInTheDocument()
    )
    // A second press while the first is in flight must not spend a second grant.
    fireEvent.click(btn)
    expect(mockFetchLimits.mock.calls.filter(([refresh]) => refresh === true)).toHaveLength(1)

    resolve([makeLimits({ windows: [makeWindow({ usedPercent: 95 })] })])
    await waitFor(() =>
      expect(screen.queryByTestId('UsageView.refreshLimits.spinner')).not.toBeInTheDocument()
    )
    // The panel now draws the reading the press fetched, not the mounted one.
    expect(screen.getByTestId('AccountsPanel.meter')).toHaveAttribute('data-severity', 'crit')
  })

  it('keeps the readings already on screen when a refresh fails', async () => {
    render(<UsageView onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('AccountsPanel.meter')).toBeInTheDocument())

    mockFetchLimits.mockRejectedValueOnce(new Error('offline'))
    fireEvent.click(screen.getByTestId('UsageView.refreshLimits'))
    await waitFor(() => expect(screen.getByTestId('UsageView.refreshLimits')).not.toBeDisabled())
    expect(screen.getByTestId('AccountsPanel.meter')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Prices (S2f change 4)
// ---------------------------------------------------------------------------

describe('UsageView — refresh prices', () => {
  it('fetches once per press, spins while it runs, and re-reads the ledger', async () => {
    let resolve!: (r: unknown) => void
    mockRefreshPrices.mockReturnValue(new Promise((r) => (resolve = r)))
    render(<UsageView onClose={vi.fn()} />)
    await waitFor(() => expect(mockFetchDashboard).toHaveBeenCalledTimes(1))

    const btn = screen.getByTestId('UsageView.refreshPrices')
    fireEvent.click(btn)
    await waitFor(() =>
      expect(screen.getByTestId('UsageView.refreshPrices.spinner')).toBeInTheDocument()
    )
    // A second press while the first is in flight is one intent, not two.
    fireEvent.click(btn)
    expect(mockRefreshPrices).toHaveBeenCalledTimes(1)

    resolve({ count: 412, refreshedAt: Date.now() })
    await waitFor(() =>
      expect(screen.queryByTestId('UsageView.refreshPrices.spinner')).not.toBeInTheDocument()
    )
    // A model the catalog has just learned about can price a turn that had
    // none, so the ledger read goes again.
    await waitFor(() => expect(mockFetchDashboard).toHaveBeenCalledTimes(2))
  })

  it('names the catalog it fetched in the tooltip, and only after a run', async () => {
    render(<UsageView onClose={vi.fn()} />)
    await waitFor(() => expect(mockFetchDashboard).toHaveBeenCalled())

    const btn = screen.getByTestId('UsageView.refreshPrices')
    expect(btn.getAttribute('title')).toBe('Fetch the latest model prices from models.dev')

    fireEvent.click(btn)
    await waitFor(() =>
      expect(btn.getAttribute('title')).toBe(
        'Fetch the latest model prices from models.dev (412 models · refreshed 0s ago)'
      )
    )
  })

  it('keeps the dashboard when the catalog cannot be fetched', async () => {
    mockRefreshPrices.mockRejectedValueOnce(new Error('offline'))
    render(<UsageView onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('Summary')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('UsageView.refreshPrices'))
    await waitFor(() => expect(screen.getByTestId('UsageView.refreshPrices')).not.toBeDisabled())
    expect(screen.getByTestId('Summary')).toBeInTheDocument()
    expect(mockFetchDashboard).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// The widgets the shell composes
// ---------------------------------------------------------------------------

describe('UsageView — the composed widgets', () => {
  it('mounts none of them while the query is still in flight', async () => {
    let resolve!: (d: unknown) => void
    mockFetchDashboard.mockReturnValue(new Promise((r) => (resolve = r)))
    render(<UsageView onClose={vi.fn()} />)

    // Every widget takes the dashboard data as a required prop, so the guard is
    // the contract, not a nicety: one of them rendered against `null` would
    // throw rather than show a placeholder.
    expect(screen.getByTestId('UsageView.loading')).toBeInTheDocument()
    for (const id of ['Summary', 'AccountsPanel', 'SpendChart', 'BreakdownTable']) {
      expect(screen.queryByTestId(id)).not.toBeInTheDocument()
    }

    resolve(makeDashboard())
    await waitFor(() => expect(screen.getByTestId('SpendChart')).toBeInTheDocument())
  })

  it('hands the group-by down to the two widgets that read it', async () => {
    render(<UsageView onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('BreakdownTable')).toBeInTheDocument())
    expect(screen.getByTestId('BreakdownTable')).toHaveAttribute('data-group-by', 'provider')
    // The chart cannot split a day by anything but the provider, so it only
    // says so; at `provider` it has nothing to say.
    expect(screen.queryByTestId('SpendChart.subtitle')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('UsageView.groupBy.model'))
    expect(screen.getByTestId('BreakdownTable')).toHaveAttribute('data-group-by', 'model')
    expect(screen.getByTestId('SpendChart.subtitle')).toHaveTextContent('Stacked by provider')
  })

  it('guards the window value too: it waits for the query on the plans tab', async () => {
    window.localStorage.setItem('claudeui.usage.tab', 'plans')
    let resolve!: (d: unknown) => void
    mockFetchDashboard.mockReturnValue(new Promise((r) => (resolve = r)))
    render(<UsageView onClose={vi.fn()} />)

    expect(screen.getByTestId('UsageView.loading')).toBeInTheDocument()
    expect(screen.queryByTestId('WindowValue')).not.toBeInTheDocument()

    resolve(makeDashboard())
    await waitFor(() => expect(screen.getByTestId('WindowValue')).toBeInTheDocument())
  })

  it('lets the window-value widget do its own read, from the shell range', async () => {
    render(<UsageView onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('Summary')).toBeInTheDocument())
    // It is the plans tab's only widget, and it reads when it mounts.
    expect(mockFetchWindows).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('UsageView.tab.plans'))
    await waitFor(() => expect(mockFetchWindows).toHaveBeenCalled())
    expect(mockFetchWindows).toHaveBeenCalledWith({ sinceTs: makeDashboard().fromTs })
  })
})

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

describe('UsageView — chrome', () => {
  it('closes through the header button', async () => {
    const onClose = vi.fn()
    render(<UsageView onClose={onClose} />)
    fireEvent.click(screen.getByTestId('UsageView.close'))
    expect(onClose).toHaveBeenCalledOnce()
    await waitFor(() => expect(mockFetchDashboard).toHaveBeenCalled())
  })

  it('offers the account filter only when more than one Claude account exists', async () => {
    useSessionStore.setState({
      blockUsage: makeBlockUsage({ accounts: ['a@example.test', 'b@example.test'] }),
      accountUsage: null
    } as any)
    render(<UsageView onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('UsageView.accountFilter')).toBeInTheDocument())
  })
})

// ---------------------------------------------------------------------------
// Tabs (S4c)
// ---------------------------------------------------------------------------

describe('UsageView — tabs', () => {
  const SPEND_WIDGETS = ['Summary', 'AccountsPanel', 'SpendChart', 'BreakdownTable']

  it('opens on Spend: the ledger widgets, and no plan analysis', async () => {
    render(<UsageView onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('Summary')).toBeInTheDocument())

    expect(screen.getByTestId('UsageView.panel')).toHaveAttribute('data-tab', 'spend')
    expect(screen.getByTestId('UsageView.tab')).toHaveAttribute('data-value', 'spend')
    for (const id of SPEND_WIDGETS) expect(screen.getByTestId(id)).toBeInTheDocument()
    expect(screen.queryByTestId('WindowValue')).not.toBeInTheDocument()
  })

  it('shows the window value alone on Plan value', async () => {
    render(<UsageView onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('Summary')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('UsageView.tab.plans'))

    await waitFor(() => expect(screen.getByTestId('WindowValue')).toBeInTheDocument())
    expect(screen.getByTestId('UsageView.panel')).toHaveAttribute('data-tab', 'plans')
    for (const id of SPEND_WIDGETS) expect(screen.queryByTestId(id)).not.toBeInTheDocument()
  })

  it('keeps the range and the refresh button on both tabs, the group-by on Spend only', async () => {
    render(<UsageView onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('UsageView.groupBy')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('UsageView.tab.plans'))

    // Nothing on the plans tab reads the group-by, so it goes; the range and the
    // refresh grant still belong to the whole screen.
    expect(screen.queryByTestId('UsageView.groupBy')).not.toBeInTheDocument()
    expect(screen.getByTestId('UsageView.range')).toBeInTheDocument()
    expect(screen.getByTestId('UsageView.refreshLimits')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('UsageView.tab.spend'))
    expect(screen.getByTestId('UsageView.groupBy')).toBeInTheDocument()
  })

  it('never refetches on a tab switch: the shell holds both reads', async () => {
    render(<UsageView onClose={vi.fn()} />)
    await waitFor(() => expect(mockFetchDashboard).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByTestId('UsageView.tab.plans'))
    await waitFor(() => expect(screen.getByTestId('WindowValue')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('UsageView.tab.spend'))
    await waitFor(() => expect(screen.getByTestId('Summary')).toBeInTheDocument())

    expect(mockFetchDashboard).toHaveBeenCalledTimes(1)
    expect(mockFetchLimits).toHaveBeenCalledTimes(1)
  })

  it('remembers the tab for next time', async () => {
    render(<UsageView onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('Summary')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('UsageView.tab.plans'))
    expect(window.localStorage.getItem('claudeui.usage.tab')).toBe('plans')
  })

  it('opens on the stored tab', async () => {
    window.localStorage.setItem('claudeui.usage.tab', 'plans')
    render(<UsageView onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('WindowValue')).toBeInTheDocument())
    expect(screen.getByTestId('UsageView.tab.plans')).toHaveAttribute('data-active', 'true')
  })

  it('ignores a stored value that is not a tab', async () => {
    window.localStorage.setItem('claudeui.usage.tab', 'resets')
    render(<UsageView onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('Summary')).toBeInTheDocument())
    expect(screen.getByTestId('UsageView.panel')).toHaveAttribute('data-tab', 'spend')
  })

  it('still refetches when the range changes on the Plan value tab', async () => {
    render(<UsageView onClose={vi.fn()} />)
    await waitFor(() => expect(mockFetchDashboard).toHaveBeenCalledWith('today'))

    fireEvent.click(screen.getByTestId('UsageView.tab.plans'))
    fireEvent.click(screen.getByTestId('UsageView.range.7d'))

    await waitFor(() => expect(mockFetchDashboard).toHaveBeenCalledWith('7d'))
    expect(screen.getByTestId('UsageView.panel')).toHaveAttribute('data-tab', 'plans')
  })

  it('switches from the keyboard: the tabs are real buttons', async () => {
    // jsdom does not implement a button's default keyboard activation, so what
    // is assertable here is the element type that gives it for free.
    render(<UsageView onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('UsageView.tab')).toBeInTheDocument())
    for (const id of ['UsageView.tab.spend', 'UsageView.tab.plans']) {
      expect(screen.getByTestId(id).tagName).toBe('BUTTON')
    }
  })
})
