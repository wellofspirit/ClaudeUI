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
 *
 * S5c added the scope, which is the shell's third owned control and the only one
 * that can be absent: it exists only while a hub is enabled. Its own section is
 * at the bottom. Every OTHER case in this file now asserts the `local` scope
 * explicitly, which is the pin that the pre-hub reading of this screen has not
 * moved.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { UsageView } from '../UsageView'
import { useSessionStore } from '../../../stores/session-store'
import type {
  BlockUsageData,
  UsageDashboardData,
  UsageHubStatus
} from '../../../../../shared/types'
import {
  makeAccount,
  makeDashboard,
  makeLimits,
  makeMachine,
  makeProvider,
  makeTotals,
  makeWindow
} from './dashboard-fixtures'

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
let mockHubStatus: ReturnType<typeof vi.fn>
let mockSyncHub: ReturnType<typeof vi.fn>

/** A hub status. `enabled` is what decides whether the scope exists at all. */
function makeHubStatus(overrides: Partial<UsageHubStatus> = {}): UsageHubStatus {
  return {
    enabled: true,
    url: 'https://hub.example.test',
    deviceId: 'dev-self',
    deviceName: 'desk',
    clientId: 'abc.access',
    hasSecret: true,
    state: 'idle',
    lastPushAt: Date.now(),
    lastPullAt: Date.now(),
    lastError: null,
    pendingEvents: 0,
    ...overrides,
    remote: overrides.remote ?? { devices: [], epoch: 4 }
  }
}

beforeEach(() => {
  syncHandlers.clear()
  mockIsMobile.mockReturnValue(false)
  window.localStorage.clear()
  mockFetchDashboard = vi.fn().mockResolvedValue(makeDashboard())
  mockFetchLimits = vi.fn().mockResolvedValue([makeLimits()])
  // `WindowValue` does its own read; without it the widget throws on mount.
  mockFetchWindows = vi.fn().mockResolvedValue([])
  mockRefreshPrices = vi.fn().mockResolvedValue({ count: 412, refreshedAt: Date.now() })
  // No hub by default: every case that is not about the scope reads the screen
  // as a machine that has never configured one.
  mockHubStatus = vi.fn().mockResolvedValue(makeHubStatus({ enabled: false, deviceId: null }))
  mockSyncHub = vi.fn().mockResolvedValue(makeHubStatus())

  // Assign api directly on the existing window object — do NOT replace window
  // itself, as that breaks waitFor's container check (it loses the document ref).
  ;(window as any).api = {
    setUsageAccountFilter: vi.fn().mockResolvedValue(undefined),
    fetchUsageDashboard: mockFetchDashboard,
    fetchAccountLimits: mockFetchLimits,
    fetchUsageWindows: mockFetchWindows,
    refreshPrices: mockRefreshPrices,
    usageHubStatus: mockHubStatus,
    syncUsageHubNow: mockSyncHub
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
    await waitFor(() => expect(mockFetchDashboard).toHaveBeenCalledWith('today', 'local'))
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
    await waitFor(() => expect(mockFetchDashboard).toHaveBeenCalledWith('today', 'local'))

    fireEvent.click(screen.getByTestId('UsageView.range.7d'))
    await waitFor(() => expect(mockFetchDashboard).toHaveBeenCalledWith('7d', 'local'))
    expect(window.localStorage.getItem('claudeui.usage.range')).toBe('7d')
  })

  it('opens on the stored range', async () => {
    window.localStorage.setItem('claudeui.usage.range', '90d')
    render(<UsageView onClose={vi.fn()} />)
    await waitFor(() => expect(mockFetchDashboard).toHaveBeenCalledWith('90d', 'local'))
    expect(screen.getByTestId('UsageView.range.90d')).toHaveAttribute('data-active', 'true')
  })

  it('ignores a stored value that is not a range', async () => {
    window.localStorage.setItem('claudeui.usage.range', 'all-time')
    render(<UsageView onClose={vi.fn()} />)
    await waitFor(() => expect(mockFetchDashboard).toHaveBeenCalledWith('today', 'local'))
  })

  it('leaves a stored range alone — the default only applies to a fresh viewer', async () => {
    window.localStorage.setItem('claudeui.usage.range', '30d')
    render(<UsageView onClose={vi.fn()} />)
    await waitFor(() => expect(mockFetchDashboard).toHaveBeenCalledWith('30d', 'local'))
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
    await waitFor(() => expect(mockFetchDashboard).toHaveBeenCalledWith('7d', 'local'))
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
    await waitFor(() => expect(mockFetchDashboard).toHaveBeenCalledWith('today', 'local'))

    fireEvent.click(screen.getByTestId('UsageView.tab.plans'))
    fireEvent.click(screen.getByTestId('UsageView.range.7d'))

    await waitFor(() => expect(mockFetchDashboard).toHaveBeenCalledWith('7d', 'local'))
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

// ---------------------------------------------------------------------------
// The scope (S5c)
// ---------------------------------------------------------------------------

describe('UsageView — the scope', () => {
  it('offers no scope pills, and asks for local, on a machine with no hub', async () => {
    render(<UsageView onClose={vi.fn()} />)
    await waitFor(() => expect(mockFetchDashboard).toHaveBeenCalledWith('today', 'local'))
    expect(screen.queryByTestId('UsageView.scope')).not.toBeInTheDocument()
    expect(screen.queryByTestId('UsageView.hubChip')).not.toBeInTheDocument()
    // `machine` is not a grouping when there is one machine.
    expect(screen.queryByTestId('UsageView.groupBy.machine')).not.toBeInTheDocument()
    expect(screen.queryByTestId('MachinesPanel')).not.toBeInTheDocument()
  })

  it('offers them once a hub is enabled, starting on this machine', async () => {
    mockHubStatus.mockResolvedValue(makeHubStatus())
    render(<UsageView onClose={vi.fn()} />)

    await waitFor(() => expect(screen.getByTestId('UsageView.scope')).toBeInTheDocument())
    expect(screen.getByTestId('UsageView.scope')).toHaveAttribute('data-value', 'local')
    const pills = screen.getByTestId('UsageView.scope').querySelectorAll('button')
    expect([...pills].map((p) => p.getAttribute('data-value'))).toEqual(['local', 'all'])
    expect(pills[0]).toHaveTextContent('This machine')
    expect(pills[1]).toHaveTextContent('All machines')
  })

  it('refetches with the new scope and remembers it for next time', async () => {
    mockHubStatus.mockResolvedValue(makeHubStatus())
    render(<UsageView onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('UsageView.scope.all')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('UsageView.scope.all'))

    await waitFor(() => expect(mockFetchDashboard).toHaveBeenCalledWith('today', 'all'))
    expect(window.localStorage.getItem('claudeui.usage.scope')).toBe('all')
  })

  it('opens on the stored scope, and the pills fall back when the hub is gone', async () => {
    window.localStorage.setItem('claudeui.usage.scope', 'all')
    mockHubStatus.mockResolvedValue(makeHubStatus())
    const { unmount } = render(<UsageView onClose={vi.fn()} />)
    await waitFor(() => expect(mockFetchDashboard).toHaveBeenCalledWith('today', 'all'))
    unmount()

    // The hub has since been forgotten. ONE read, with the stored preference —
    // the query downgrades and reports the scope it used, so waiting for the
    // status before the first read would only have cost a second fetch (M8).
    mockFetchDashboard.mockClear()
    mockHubStatus.mockResolvedValue(makeHubStatus({ enabled: false, deviceId: null }))
    mockFetchDashboard.mockResolvedValue(makeDashboard({ scope: 'local' }))
    render(<UsageView onClose={vi.fn()} />)

    await waitFor(() => expect(screen.getByTestId('Summary')).toBeInTheDocument())
    expect(mockFetchDashboard).toHaveBeenCalledTimes(1)
    expect(mockFetchDashboard).toHaveBeenCalledWith('today', 'all')
    // And no pills, because there is no hub to offer them for.
    expect(screen.queryByTestId('UsageView.scope')).not.toBeInTheDocument()
  })

  it('reads the ledger once on mount when the stored scope is all', async () => {
    window.localStorage.setItem('claudeui.usage.scope', 'all')
    mockHubStatus.mockResolvedValue(makeHubStatus())
    render(<UsageView onClose={vi.fn()} />)

    await waitFor(() => expect(screen.getByTestId('UsageView.scope')).toBeInTheDocument())
    expect(mockFetchDashboard).toHaveBeenCalledTimes(1)
    expect(mockFetchDashboard).toHaveBeenCalledWith('today', 'all')
  })

  it('drops the machine group-by when the hub is disabled outside the pills (R1)', async () => {
    window.localStorage.setItem('claudeui.usage.scope', 'all')
    mockHubStatus.mockResolvedValue(makeHubStatus())
    // A provider tree with a real leaf, so an empty breakdown can only mean the
    // tree was rooted on a dimension the data does not have.
    const withSpend = (scope: 'local' | 'all'): UsageDashboardData =>
      makeDashboard({
        scope,
        providers: [
          makeProvider({
            accounts: [
              makeAccount({
                machines: ['dev-self'],
                remoteOnly: false,
                models: [
                  {
                    engineId: 'claude',
                    vendorId: 'anthropic',
                    modelId: 'claude-opus-5',
                    totals: makeTotals({ displayCostUsd: 42, apiCostUsd: 42 }),
                    dispatched: null
                  }
                ]
              })
            ]
          })
        ],
        totals: makeTotals({ displayCostUsd: 42 }),
        machines: [makeMachine({ totals: makeTotals({ displayCostUsd: 42 }) })]
      })
    mockFetchDashboard.mockImplementation(async (_range: string, scope: string) =>
      withSpend(scope as 'local' | 'all')
    )
    render(<UsageView onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('UsageView.groupBy.machine')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('UsageView.groupBy.machine'))
    await waitFor(() =>
      expect(screen.getByTestId('BreakdownTable')).toHaveAttribute('data-group-by', 'machine')
    )

    // The hub is forgotten in Settings — no click on this screen at all. The
    // status re-read waits out the same debounce the other nudges use, so the
    // assertion is given longer than it.
    mockHubStatus.mockResolvedValue(makeHubStatus({ enabled: false, deviceId: null }))
    syncHandlers.get('usage-hub:changed')!()

    // Waited for on the GROUP-BY, not on the pill. The pill unmounts in the
    // render where the scope flips, while the reset is an effect that runs after
    // it — so waiting for the pill leaves a window in which the tree is still
    // rooted on `machine`, and under suite load the next assertion landed in it.
    await waitFor(
      () =>
        expect(screen.getByTestId('BreakdownTable')).toHaveAttribute('data-group-by', 'provider'),
      { timeout: 5_000 }
    )
    expect(screen.queryByTestId('UsageView.groupBy.machine')).not.toBeInTheDocument()
    // The breakdown must NOT be left rooted on a dimension the data no longer
    // has, which drew "Nothing in this range to break down" under a $42 hero.
    expect(screen.queryByTestId('BreakdownTable.empty')).not.toBeInTheDocument()
  })

  it('ignores a stored value that is not a scope', async () => {
    window.localStorage.setItem('claudeui.usage.scope', 'everything')
    mockHubStatus.mockResolvedValue(makeHubStatus())
    render(<UsageView onClose={vi.fn()} />)
    await waitFor(() => expect(mockFetchDashboard).toHaveBeenCalledWith('today', 'local'))
  })

  it('offers the machine grouping under all only, and drops it on the way back', async () => {
    mockHubStatus.mockResolvedValue(makeHubStatus())
    mockFetchDashboard.mockImplementation(async (_range: string, scope: string) =>
      makeDashboard({ scope: scope as 'local' | 'all', machines: [makeMachine()] })
    )
    render(<UsageView onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('UsageView.scope.all')).toBeInTheDocument())
    expect(screen.queryByTestId('UsageView.groupBy.machine')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('UsageView.scope.all'))
    await waitFor(() => expect(screen.getByTestId('UsageView.groupBy.machine')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('UsageView.groupBy.machine'))
    await waitFor(() =>
      expect(screen.getByTestId('BreakdownTable')).toHaveAttribute('data-group-by', 'machine')
    )

    // Back to this machine: the pill goes, and so does the selection — a
    // breakdown rooted on a dimension the data no longer has is not a table.
    fireEvent.click(screen.getByTestId('UsageView.scope.local'))
    await waitFor(() =>
      expect(screen.queryByTestId('UsageView.groupBy.machine')).not.toBeInTheDocument()
    )
    expect(screen.getByTestId('BreakdownTable')).toHaveAttribute('data-group-by', 'provider')
  })

  it('mounts the machines card last on Spend, and only when the answer is combined', async () => {
    mockHubStatus.mockResolvedValue(makeHubStatus())
    mockFetchDashboard.mockImplementation(async (_range: string, scope: string) =>
      makeDashboard({ scope: scope as 'local' | 'all', machines: [makeMachine()] })
    )
    render(<UsageView onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('Summary')).toBeInTheDocument())
    expect(screen.queryByTestId('MachinesPanel')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('UsageView.scope.all'))
    await waitFor(() => expect(screen.getByTestId('MachinesPanel')).toBeInTheDocument())

    // LAST on the tab (the owner's ruling on the mockup).
    const cards = [...screen.getByTestId('UsageView.panel').children]
    expect(cards[cards.length - 1]).toBe(screen.getByTestId('MachinesPanel'))

    // And never on the plans tab, whatever the scope.
    fireEvent.click(screen.getByTestId('UsageView.tab.plans'))
    await waitFor(() => expect(screen.getByTestId('WindowValue')).toBeInTheDocument())
    expect(screen.queryByTestId('MachinesPanel')).not.toBeInTheDocument()
  })

  it('keeps the scope pills on the plans tab', async () => {
    mockHubStatus.mockResolvedValue(makeHubStatus())
    render(<UsageView onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('UsageView.scope')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('UsageView.tab.plans'))
    expect(screen.getByTestId('UsageView.scope')).toBeInTheDocument()
  })
})

describe('UsageView — the hub chip', () => {
  const HOUR = 60 * 60 * 1000

  it('counts the machines, reports the state and says how fresh the view is', async () => {
    mockHubStatus.mockResolvedValue(
      makeHubStatus({
        lastPullAt: Date.now() - 90_000,
        remote: {
          epoch: 4,
          devices: [
            {
              deviceId: 'dev-peer',
              deviceName: 'studio',
              os: 'darwin',
              appVersion: '3.3.0',
              lastPushAt: Date.now() - HOUR,
              retired: false
            }
          ]
        }
      })
    )
    render(<UsageView onClose={vi.fn()} />)

    await waitFor(() => expect(screen.getByTestId('UsageView.hubChip')).toBeInTheDocument())
    const chip = screen.getByTestId('UsageView.hubChip')
    // This machine plus the peer.
    expect(chip).toHaveTextContent('Hub · 2 machines')
    expect(chip).toHaveTextContent('synced 1m ago')
    expect(chip).toHaveAttribute('data-state', 'idle')
    expect(chip).toHaveAttribute('data-severity', 'ok')
    expect(chip).not.toHaveAttribute('data-behind')
  })

  it('flags a peer that has not pushed for a day, and never this machine', async () => {
    mockHubStatus.mockResolvedValue(
      makeHubStatus({
        // This machine has not pushed for two days; that is its own connection's
        // problem and the state dot's business, never a "behind" count.
        lastPushAt: Date.now() - 48 * HOUR,
        remote: {
          epoch: 4,
          devices: [
            {
              deviceId: 'dev-late',
              deviceName: 'laptop',
              os: 'darwin',
              appVersion: '3.2.0',
              lastPushAt: Date.now() - 31 * HOUR,
              retired: false
            },
            {
              deviceId: 'dev-retired',
              deviceName: 'old-server',
              os: 'linux',
              appVersion: '3.1.0',
              lastPushAt: Date.now() - 40 * 24 * HOUR,
              retired: true
            }
          ]
        }
      })
    )
    render(<UsageView onClose={vi.fn()} />)

    await waitFor(() => expect(screen.getByTestId('UsageView.hubChip')).toBeInTheDocument())
    // One: the retired machine is history, not a gap.
    expect(screen.getByTestId('UsageView.hubChip')).toHaveAttribute('data-behind', '1')
    expect(screen.getByTestId('UsageView.hubChip.behind')).toHaveTextContent('1 behind')
    // And it is not counted as a machine either (M3): this one plus the late
    // peer is two, not three.
    expect(screen.getByTestId('UsageView.hubChip')).toHaveTextContent('Hub · 2 machines')
  })

  it('grades a refused credential critical and carries the reason in the tooltip', async () => {
    mockHubStatus.mockResolvedValue(
      makeHubStatus({ state: 'needs-credentials', lastError: 'the hub refused the service token' })
    )
    render(<UsageView onClose={vi.fn()} />)

    await waitFor(() => expect(screen.getByTestId('UsageView.hubChip')).toBeInTheDocument())
    const chip = screen.getByTestId('UsageView.hubChip')
    expect(chip).toHaveAttribute('data-severity', 'crit')
    expect(chip.getAttribute('title')).toBe('the hub refused the service token')
  })

  it('re-reads the hub and the ledger a debounce after the client changes state', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      mockHubStatus.mockResolvedValue(makeHubStatus())
      render(<UsageView onClose={vi.fn()} />)
      await waitFor(() => expect(mockHubStatus).toHaveBeenCalledTimes(1))
      await waitFor(() => expect(mockFetchDashboard).toHaveBeenCalledTimes(1))

      const onHub = syncHandlers.get('usage-hub:changed')
      expect(onHub).toBeDefined()
      onHub!()
      onHub!()
      // A nudge is not a read.
      expect(mockHubStatus).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(2_000)
      // All THREE: a finished pull is a new machine list, new remote buckets to
      // fold, AND new relayed limit readings. Without the third, a peer's meters
      // only showed up the next time this screen was opened (F1).
      await waitFor(() => expect(mockHubStatus).toHaveBeenCalledTimes(2))
      expect(mockFetchDashboard).toHaveBeenCalledTimes(2)
      expect(mockFetchLimits).toHaveBeenCalledTimes(2)
      // Still never a refresh grant: the relayed read is local and free.
      expect(mockFetchLimits.mock.calls.every(([refresh]) => refresh === false)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
