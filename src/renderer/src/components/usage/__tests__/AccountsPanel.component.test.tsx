/**
 * `AccountsPanel` — accounts grouped by provider with their limit meters
 * inline (ADR-071 §8, mockup Accounts C), and the Claude block analytics behind
 * an expander on an Anthropic row.
 *
 * The join is the thing worth guarding: spend comes from the ledger and windows
 * come from the limits provider, and an account that appears on only one side
 * still has to render honestly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { AccountsPanel } from '../AccountsPanel'
import { SEVERITY_ICON, buildProviderColorMap } from '../usage-utils'
import type { AccountLimits, BlockUsageData } from '../../../../../shared/types'
import {
  makeAccount,
  makeDashboard,
  makeLimits,
  makeMachine,
  makeProvider,
  makeTotals,
  makeWindow
} from './dashboard-fixtures'

const COLORS = buildProviderColorMap(['anthropic', 'openai'])

function emptyBlockUsage(): BlockUsageData {
  return {
    currentBlock: null,
    recentBlocks: [],
    todaySnapshots: [],
    dailyHistory: [],
    accounts: [],
    accountFilter: null,
    perEngine: undefined
  } as unknown as BlockUsageData
}

describe('AccountsPanel — grouping', () => {
  it('renders one provider header per provider, with its subtotal', () => {
    const data = makeDashboard({
      providers: [
        makeProvider({
          providerId: 'anthropic',
          label: 'Anthropic',
          totals: makeTotals({ displayCostUsd: 75 }),
          accounts: [makeAccount({ totals: makeTotals({ displayCostUsd: 75 }) })]
        }),
        makeProvider({
          providerId: 'openai',
          label: 'OpenAI',
          totals: makeTotals({ displayCostUsd: 25 }),
          accounts: [
            makeAccount({
              accountKey: 'chatgpt:w1:u1',
              providerId: 'openai',
              label: 'work workspace',
              totals: makeTotals({ displayCostUsd: 25 })
            })
          ]
        })
      ],
      totals: makeTotals({ displayCostUsd: 100 })
    })

    render(<AccountsPanel data={data} limits={[]} blockUsage={null} providerColors={COLORS} />)

    const headers = screen.getAllByTestId('AccountsPanel.provider')
    expect(headers.map((h) => h.getAttribute('data-provider-id'))).toEqual(['anthropic', 'openai'])
    const subtotals = screen.getAllByTestId('AccountsPanel.provider.subtotal')
    expect(subtotals[0]).toHaveTextContent('$75.00')
    expect(subtotals[0]).toHaveTextContent('75%')
    expect(subtotals[1]).toHaveTextContent('$25.00')

    const accounts = screen.getAllByTestId('AccountsPanel.account')
    expect(accounts.map((a) => a.getAttribute('data-account-key'))).toEqual([
      'anthropic:org-1:acct-1',
      'chatgpt:w1:u1'
    ])
    expect(screen.getAllByTestId('AccountsPanel.account.spend')[1]).toHaveTextContent('$25.00')
  })

  it('says so when the range holds no usage at all', () => {
    render(
      <AccountsPanel
        data={makeDashboard({ providers: [] })}
        limits={[]}
        blockUsage={null}
        providerColors={COLORS}
      />
    )
    expect(screen.getByTestId('AccountsPanel')).toHaveTextContent('No usage recorded in this range')
  })
})

describe('AccountsPanel — limit meters', () => {
  // The weekly resets below are a fixed Thursday 09:00; pin "now" to the Tuesday
  // before it so they stay in the future (a weekday reset with an `(in …)`
  // countdown) whatever day the suite runs. Only `Date` is faked.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 8, 22, 12, 0, 0))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([
    [20, 'ok'],
    [70, 'warn'],
    [95, 'crit']
  ])('grades %i%% as %s and always prints the number', (pct, severity) => {
    const data = makeDashboard()
    render(
      <AccountsPanel
        data={data}
        limits={[makeLimits({ windows: [makeWindow({ usedPercent: pct })] })]}
        blockUsage={null}
        providerColors={COLORS}
      />
    )
    const meter = screen.getByTestId('AccountsPanel.meter')
    expect(meter).toHaveAttribute('data-severity', severity)
    expect(meter).toHaveAttribute('data-kind', '5h')
    expect(meter).toHaveTextContent(`${pct}%`)
  })

  it('shows a 5-hour reset as a countdown and a weekly one as a weekday', () => {
    const weekly = new Date(2026, 8, 24, 9, 0, 0)
    render(
      <AccountsPanel
        data={makeDashboard()}
        limits={[
          makeLimits({
            windows: [
              makeWindow({
                kind: '5h',
                label: '5-hour',
                // Half a minute of slack so the floor in formatDuration is stable.
                resetsAt: new Date(Date.now() + 5_430_000).toISOString()
              }),
              makeWindow({ kind: '7d', label: '7-day', resetsAt: weekly.toISOString() })
            ]
          })
        ]}
        blockUsage={null}
        providerColors={COLORS}
      />
    )
    const [fiveHour, sevenDay] = screen.getAllByTestId('AccountsPanel.meter')
    // The title is the guarantee: the reset text itself is hidden below `xl`
    // so that three meters fit on one line.
    expect(fiveHour.getAttribute('title')).toContain('resets in 1h 30m')
    expect(sevenDay.getAttribute('title')).toContain('resets Thu 09:00')
    // The other reading stays a hover away rather than being lost.
    expect(sevenDay.getAttribute('title')).toContain('(in ')
    expect(within(fiveHour).getByTestId('AccountsPanel.meter.reset')).toHaveTextContent('in 1h 30m')
    expect(within(sevenDay).getByTestId('AccountsPanel.meter.reset')).toHaveTextContent('Thu 09:00')
  })

  /**
   * S3c — a ChatGPT plan whose ONLY limit is weekly delivers it in the
   * `primary` slot. Kinded by position it arrived here as `5h` / `5-hour` and
   * its reset was drawn as a countdown ("in 28h 55m"); kinded by the duration
   * the backend states, it is the weekly window it always was.
   */
  it('renders a lone weekly ChatGPT window as 7-day, with a weekday reset', () => {
    const weekly = new Date(2026, 8, 24, 9, 0, 0)
    render(
      <AccountsPanel
        data={makeDashboard()}
        limits={[
          makeLimits({
            accountKey: 'chatgpt:ws-1:user-1',
            label: 'chat@example.test',
            vendorId: 'openai',
            windows: [
              makeWindow({
                kind: '7d',
                label: '7-day',
                usedPercent: 63,
                resetsAt: weekly.toISOString(),
                windowMinutes: 10_080
              })
            ]
          })
        ]}
        blockUsage={null}
        providerColors={COLORS}
      />
    )

    const meter = screen.getByTestId('AccountsPanel.meter')
    expect(meter).toHaveAttribute('data-kind', '7d')
    expect(meter).toHaveTextContent('7-day')
    expect(meter.getAttribute('title')).toContain('resets Thu 09:00')
    expect(within(meter).getByTestId('AccountsPanel.meter.reset')).toHaveTextContent('Thu 09:00')
  })

  /**
   * Round 2 — a plan whose two limits are the same length. The meters are keyed
   * by kind, so `7d` twice would be a duplicate React key and one row standing
   * for two windows; `7d:secondary` keeps them distinct and labelled.
   */
  it('draws two same-length windows as two meters with distinct kinds', () => {
    render(
      <AccountsPanel
        data={makeDashboard()}
        limits={[
          makeLimits({
            accountKey: 'chatgpt:ws-1:user-1',
            vendorId: 'openai',
            windows: [
              makeWindow({ kind: '7d', label: '7-day', usedPercent: 63, windowMinutes: 10_080 }),
              makeWindow({
                kind: '7d:secondary',
                label: '7-day secondary',
                usedPercent: 12,
                windowMinutes: 10_080
              })
            ]
          })
        ]}
        blockUsage={null}
        providerColors={COLORS}
      />
    )

    const meters = screen.getAllByTestId('AccountsPanel.meter')
    expect(meters.map((m) => m.getAttribute('data-kind'))).toEqual(['7d', '7d:secondary'])
    expect(meters[1]).toHaveTextContent('7-day secondary')
    expect(meters[1]).toHaveTextContent('12%')
  })

  /**
   * The meter has to PASS the stated length on, not just the kind: the reset
   * form is chosen by length now, and a row whose kind and duration disagree —
   * a reading kinded before S3c, refreshed after it — must follow the duration.
   */
  it('chooses the reset form from the stated minutes, not the kind', () => {
    const weekly = new Date(2026, 8, 24, 9, 0, 0)
    render(
      <AccountsPanel
        data={makeDashboard()}
        limits={[
          makeLimits({
            windows: [
              makeWindow({
                kind: '5h',
                label: '5-hour',
                resetsAt: weekly.toISOString(),
                windowMinutes: 10_080
              })
            ]
          })
        ]}
        blockUsage={null}
        providerColors={COLORS}
      />
    )

    expect(
      within(screen.getByTestId('AccountsPanel.meter')).getByTestId('AccountsPanel.meter.reset')
    ).toHaveTextContent('Thu 09:00')
  })

  it('keeps the icon and the percent at every width, and only folds the reset', () => {
    render(
      <AccountsPanel
        data={makeDashboard()}
        limits={[makeLimits({ windows: [makeWindow({ usedPercent: 95 })] })]}
        blockUsage={null}
        providerColors={COLORS}
      />
    )
    const meter = screen.getByTestId('AccountsPanel.meter')
    const reset = within(meter).getByTestId('AccountsPanel.meter.reset')
    expect(reset.className).toContain('hidden')
    expect(reset.className).toContain('xl:inline')
    // Severity never rests on colour alone, at any width.
    const always = meter.textContent?.replace(reset.textContent ?? '', '') ?? ''
    expect(always).toContain('95%')
    expect(always).toContain(SEVERITY_ICON.crit)
  })

  it('renders one meter per window', () => {
    render(
      <AccountsPanel
        data={makeDashboard()}
        limits={[
          makeLimits({
            windows: [
              makeWindow({ kind: '5h', label: '5-hour' }),
              makeWindow({ kind: '7d', label: '7-day', usedPercent: 41 })
            ]
          })
        ]}
        blockUsage={null}
        providerColors={COLORS}
      />
    )
    expect(
      screen.getAllByTestId('AccountsPanel.meter').map((m) => m.getAttribute('data-kind'))
    ).toEqual(['5h', '7d'])
  })
})

describe('AccountsPanel — reading state', () => {
  it('shows the age of a stale reading beside its meters', () => {
    render(
      <AccountsPanel
        data={makeDashboard()}
        limits={[makeLimits({ state: 'stale', observedAt: Date.now() - 3 * 3_600_000 })]}
        blockUsage={null}
        providerColors={COLORS}
      />
    )
    const chip = screen.getByTestId('AccountsPanel.state')
    expect(chip).toHaveAttribute('data-state', 'stale')
    expect(chip).toHaveTextContent('3h 0m old')
    // Stale is still a reading: the meters stay.
    expect(screen.getByTestId('AccountsPanel.meter')).toBeInTheDocument()
  })

  it('uses ADR-070’s pill words for an account that needs signing in again', () => {
    render(
      <AccountsPanel
        data={makeDashboard()}
        limits={[makeLimits({ state: 'needs-sign-in', windows: [] })]}
        blockUsage={null}
        providerColors={COLORS}
      />
    )
    const chip = screen.getByTestId('AccountsPanel.state')
    expect(chip).toHaveAttribute('data-state', 'needs-sign-in')
    expect(chip).toHaveTextContent('Sign-in needed')
  })

  it('draws a dash — never a zero meter — when nothing was readable', () => {
    render(
      <AccountsPanel
        data={makeDashboard()}
        limits={[makeLimits({ state: 'unavailable', windows: [] })]}
        blockUsage={null}
        providerColors={COLORS}
      />
    )
    const chip = screen.getByTestId('AccountsPanel.state')
    expect(chip).toHaveAttribute('data-state', 'unavailable')
    // Not a bare dash: it says which of "never read" and "read and empty" it is.
    expect(chip).toHaveTextContent('not read')
    expect(chip.getAttribute('title')).toBe(
      'No reading for this account yet. Refresh limits reads its stored credentials.'
    )
    expect(screen.queryByTestId('AccountsPanel.meter')).not.toBeInTheDocument()
  })

  it.each([
    [{ unlimited: false, balance: '1,840' }, '1,840 credits left'],
    [{ unlimited: true, balance: null }, 'Unlimited credits'],
    // A plan whose balance the backend did not report is still a credits plan;
    // "— credits left" read as a balance of nothing.
    [{ unlimited: false, balance: null }, 'credits plan']
  ])('describes a credits plan as %o -> %s', (credits, expected) => {
    render(
      <AccountsPanel
        data={makeDashboard()}
        limits={[makeLimits({ windows: [], credits })]}
        blockUsage={null}
        providerColors={COLORS}
      />
    )
    expect(screen.getByTestId('AccountsPanel.account')).toHaveTextContent(expected)
  })

  it('says "no rate window" for an account the limits read does not cover', () => {
    const data = makeDashboard({
      providers: [
        makeProvider({
          providerId: 'openrouter',
          label: 'openrouter',
          accounts: [
            makeAccount({
              accountKey: 'openrouter:key:abcd',
              providerId: 'openrouter',
              billingType: 'apiKey',
              label: 'openrouter key …a41f'
            })
          ]
        })
      ]
    })
    render(<AccountsPanel data={data} limits={[]} blockUsage={null} providerColors={COLORS} />)
    expect(screen.getByTestId('AccountsPanel.account')).toHaveTextContent('no rate window')
    expect(screen.queryByTestId('AccountsPanel.meter')).not.toBeInTheDocument()
  })

  it('distinguishes "still reading" from "no rate window"', () => {
    render(
      <AccountsPanel
        data={makeDashboard()}
        limits={null}
        blockUsage={null}
        providerColors={COLORS}
      />
    )
    expect(screen.getByTestId('AccountsPanel.account')).toHaveTextContent('reading limits…')
  })
})

describe('AccountsPanel — Claude drill-in', () => {
  it('toggles the block analytics under an Anthropic account row', () => {
    render(
      <AccountsPanel
        data={makeDashboard()}
        limits={[]}
        blockUsage={emptyBlockUsage()}
        providerColors={COLORS}
      />
    )
    expect(screen.queryByTestId('AccountsPanel.drillIn')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('AccountsPanel.drillIn.toggle'))
    const drillIn = screen.getByTestId('AccountsPanel.drillIn')
    // The moved tab group, behaviour unchanged.
    expect(within(drillIn).getByRole('button', { name: 'Current Block' })).toBeInTheDocument()
    expect(
      within(drillIn).getByText('No active block — start using Claude to begin tracking')
    ).toBeInTheDocument()

    fireEvent.click(within(drillIn).getByRole('button', { name: 'Recent Blocks' }))
    expect(screen.getByText('No recent blocks')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('AccountsPanel.drillIn.toggle'))
    expect(screen.queryByTestId('AccountsPanel.drillIn')).not.toBeInTheDocument()
  })

  it('offers no expander on a non-Anthropic account', () => {
    const data = makeDashboard({
      providers: [
        makeProvider({
          providerId: 'openai',
          label: 'OpenAI',
          accounts: [makeAccount({ accountKey: 'chatgpt:w:u', providerId: 'openai' })]
        })
      ]
    })
    render(
      <AccountsPanel
        data={data}
        limits={[]}
        blockUsage={emptyBlockUsage()}
        providerColors={COLORS}
      />
    )
    expect(screen.queryByTestId('AccountsPanel.drillIn.toggle')).not.toBeInTheDocument()
  })

  it('does not pretend to have block data before it arrives', () => {
    render(
      <AccountsPanel data={makeDashboard()} limits={[]} blockUsage={null} providerColors={COLORS} />
    )
    fireEvent.click(screen.getByTestId('AccountsPanel.drillIn.toggle'))
    expect(screen.getByTestId('ClaudeBlocksDrillIn')).toHaveTextContent('Loading block analytics…')
  })
})

// The panel never fetches: everything it draws is passed in, so a widget cannot
// spend a refresh grant behind the shell's back (ADR-071 §6).
describe('AccountsPanel — no I/O', () => {
  it('touches no window.api', () => {
    const api = { fetchAccountLimits: vi.fn() }
    ;(window as unknown as { api: unknown }).api = api
    render(
      <AccountsPanel
        data={makeDashboard()}
        limits={[makeLimits()]}
        blockUsage={null}
        providerColors={COLORS}
      />
    )
    expect(api.fetchAccountLimits).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// The union of the two lists, and the one key that never joins
// ---------------------------------------------------------------------------

describe('AccountsPanel — unknown never joins', () => {
  it('never lends a stored credential state to an unattributed ledger row', () => {
    // The owner's profile: 56k rows keyed `unknown` across several providers,
    // and one stored Claude account whose identity is not captured, which the
    // limits provider also reports under `unknown`.
    const data = makeDashboard({
      providers: [
        makeProvider({
          providerId: 'anthropic',
          label: 'Anthropic',
          accounts: [
            makeAccount({
              accountKey: 'unknown',
              label: 'Unattributed (before attribution)',
              billingType: 'unknown'
            })
          ]
        }),
        makeProvider({
          providerId: 'openai',
          label: 'OpenAI',
          accounts: [
            makeAccount({
              accountKey: 'unknown',
              providerId: 'openai',
              label: 'Unattributed (before attribution)',
              billingType: 'unknown'
            })
          ]
        })
      ]
    })
    render(
      <AccountsPanel
        data={data}
        limits={[
          makeLimits({
            accountKey: 'unknown',
            label: 'stored@example.test',
            state: 'unavailable',
            windows: []
          })
        ]}
        blockUsage={null}
        providerColors={COLORS}
      />
    )

    const ledgerRows = screen
      .getAllByTestId('AccountsPanel.account')
      .filter((r) => !r.hasAttribute('data-limits-only'))
    expect(ledgerRows).toHaveLength(2)
    for (const row of ledgerRows) {
      expect(row).toHaveTextContent('no account identity')
      expect(row).not.toHaveTextContent('no rate window')
      expect(within(row).queryByTestId('AccountsPanel.state')).not.toBeInTheDocument()
    }
  })

  it('stamps the provider on every account row so one unknown row can be addressed', () => {
    const data = makeDashboard({
      providers: [
        makeProvider({
          providerId: 'anthropic',
          accounts: [makeAccount({ accountKey: 'unknown', billingType: 'unknown' })]
        }),
        makeProvider({
          providerId: 'openai',
          label: 'OpenAI',
          accounts: [
            makeAccount({ accountKey: 'unknown', providerId: 'openai', billingType: 'unknown' })
          ]
        })
      ]
    })
    render(<AccountsPanel data={data} limits={[]} blockUsage={null} providerColors={COLORS} />)
    const rows = screen.getAllByTestId('AccountsPanel.account')
    expect(rows.map((r) => r.getAttribute('data-provider-id'))).toEqual(['anthropic', 'openai'])
  })
})

describe('AccountsPanel — accounts with limits but no spend', () => {
  it('lists a signed-in account that ran nothing in the range', () => {
    render(
      <AccountsPanel
        data={makeDashboard({ providers: [] })}
        limits={[
          makeLimits({
            accountKey: 'anthropic:org-9:acct-9',
            label: 'idle@example.test',
            windows: [makeWindow({ kind: '5h', label: '5-hour', usedPercent: 100 })]
          })
        ]}
        blockUsage={null}
        providerColors={COLORS}
      />
    )
    const row = screen.getByTestId('AccountsPanel.account')
    expect(row).toHaveAttribute('data-account-key', 'anthropic:org-9:acct-9')
    expect(row).toHaveAttribute('data-limits-only', 'true')
    expect(row).toHaveAttribute('data-provider-id', 'anthropic')
    expect(within(row).getByTestId('AccountsPanel.meter')).toHaveAttribute('data-severity', 'crit')
    const spend = within(row).getByTestId('AccountsPanel.account.spend')
    expect(spend).toHaveTextContent('—')
    expect(spend).toHaveAttribute('title', 'no spend in this range')
    // A provider group was created for it, with no ledger subtotal to show.
    expect(screen.getByTestId('AccountsPanel.provider')).toHaveAttribute(
      'data-provider-id',
      'anthropic'
    )
    expect(screen.getByTestId('AccountsPanel.provider.subtotal')).toHaveTextContent('$0.00')
  })

  it('does not list an account that already has a ledger row', () => {
    render(
      <AccountsPanel
        data={makeDashboard()}
        limits={[makeLimits()]}
        blockUsage={null}
        providerColors={COLORS}
      />
    )
    expect(screen.getAllByTestId('AccountsPanel.account')).toHaveLength(1)
    expect(screen.getByTestId('AccountsPanel.account')).not.toHaveAttribute('data-limits-only')
  })

  it('lists an unknown-keyed credential as its own row, with why it has no identity', () => {
    const data = makeDashboard({
      providers: [
        makeProvider({
          providerId: 'anthropic',
          accounts: [makeAccount({ accountKey: 'unknown', billingType: 'unknown' })]
        })
      ]
    })
    render(
      <AccountsPanel
        data={data}
        limits={[
          makeLimits({
            accountKey: 'unknown',
            label: 'stored@example.test',
            state: 'stale',
            observedAt: Date.now() - 3 * 3_600_000
          })
        ]}
        blockUsage={null}
        providerColors={COLORS}
      />
    )
    const limitsRow = screen
      .getAllByTestId('AccountsPanel.account')
      .find((r) => r.getAttribute('data-limits-only') === 'true')
    expect(limitsRow).toBeDefined()
    expect(limitsRow!).toHaveAttribute('data-account-key', 'unknown')
    expect(limitsRow!).toHaveTextContent('stored@example.test')
    expect(limitsRow!).toHaveTextContent('identity captured once this account is active')
    expect(within(limitsRow!).getByTestId('AccountsPanel.state')).toHaveAttribute(
      'data-state',
      'stale'
    )
    // And the ledger's own unknown row is still separate and still identity-less.
    const ledgerRow = screen
      .getAllByTestId('AccountsPanel.account')
      .find((r) => !r.hasAttribute('data-limits-only'))
    expect(ledgerRow!).toHaveTextContent('no account identity')
  })
})

describe('AccountsPanel — a provider that priced nothing', () => {
  function unpricedProviderData(): ReturnType<typeof makeDashboard> {
    return makeDashboard({
      providers: [
        makeProvider({
          providerId: 'llamacpp',
          label: 'llamacpp',
          totals: makeTotals({ displayCostUsd: 0, requestCount: 412, unknownApiCostCount: 412 }),
          accounts: [
            makeAccount({
              accountKey: 'unknown',
              providerId: 'llamacpp',
              billingType: 'unknown',
              totals: makeTotals({ displayCostUsd: 0 })
            })
          ]
        })
      ],
      totals: makeTotals({ displayCostUsd: 0 })
    })
  }

  it('folds it to its header, with the turn counts kept in view', () => {
    render(
      <AccountsPanel
        data={unpricedProviderData()}
        limits={[]}
        blockUsage={null}
        providerColors={COLORS}
      />
    )
    const header = screen.getByTestId('AccountsPanel.provider')
    expect(header).toHaveAttribute('data-collapsed', 'true')
    expect(header).toHaveTextContent('412 turns')
    expect(header).toHaveTextContent('412 unpriced')
    expect(header).not.toHaveTextContent('free')
    expect(screen.queryByTestId('AccountsPanel.account')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('AccountsPanel.provider.toggle'))
    expect(screen.getByTestId('AccountsPanel.provider')).toHaveAttribute('data-collapsed', 'false')
    expect(screen.getByTestId('AccountsPanel.account')).toBeInTheDocument()
  })

  it('calls a zero-cost provider with nothing unpriced free, not "0 unpriced"', () => {
    const data = makeDashboard({
      providers: [
        makeProvider({
          providerId: 'deadp',
          label: 'deadp',
          totals: makeTotals({ displayCostUsd: 0, requestCount: 147, unknownApiCostCount: 0 }),
          accounts: [
            makeAccount({
              accountKey: 'unknown',
              providerId: 'deadp',
              billingType: 'free',
              totals: makeTotals({ displayCostUsd: 0 })
            })
          ]
        })
      ],
      totals: makeTotals({ displayCostUsd: 0 })
    })
    render(<AccountsPanel data={data} limits={[]} blockUsage={null} providerColors={COLORS} />)
    const header = screen.getByTestId('AccountsPanel.provider')
    expect(header).toHaveAttribute('data-collapsed', 'true')
    expect(header).toHaveTextContent('147 turns')
    expect(header).toHaveTextContent('free')
    expect(header).not.toHaveTextContent('unpriced')
  })

  it('never folds a provider whose credential has meters to show', () => {
    render(
      <AccountsPanel
        data={unpricedProviderData()}
        limits={[
          makeLimits({
            accountKey: 'llamacpp:key:abcd',
            vendorId: 'llamacpp',
            label: 'llamacpp key a41f',
            windows: [makeWindow({ usedPercent: 95 })]
          })
        ]}
        blockUsage={null}
        providerColors={COLORS}
      />
    )
    const header = screen.getByTestId('AccountsPanel.provider')
    expect(header).not.toHaveAttribute('data-collapsed')
    expect(screen.getByTestId('AccountsPanel.meter')).toBeInTheDocument()
  })

  it('leaves a provider that priced its turns expanded', () => {
    render(
      <AccountsPanel data={makeDashboard()} limits={[]} blockUsage={null} providerColors={COLORS} />
    )
    expect(screen.getByTestId('AccountsPanel.provider')).not.toHaveAttribute('data-collapsed')
    expect(screen.getByTestId('AccountsPanel.account')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Relayed readings and the machines column (ADR-072 §4, slice S5c)
// ---------------------------------------------------------------------------

describe('AccountsPanel — a relayed reading', () => {
  const PEER_KEY = 'chatgpt:w9:u9'
  /**
   * A uuid, not a word. The name has to come from the READING, and an id that
   * happened to read like a name would have hidden the round-1 defect: under
   * `local` the machine list is empty, so the tag printed the id's prefix.
   */
  const PEER_ID = '3f2a1b9c-7e42-4a51-9a10-6c0d5b8e2f31'

  /** A reading another machine took, as `readAccountLimits` relays it. */
  function relayed(overrides: Partial<AccountLimits> = {}): AccountLimits {
    return makeLimits({
      accountKey: PEER_KEY,
      label: 'p•••@e•••.test',
      labelMasked: true,
      vendorId: 'openai',
      source: { deviceId: PEER_ID, deviceName: 'studio-mac' },
      observedAt: Date.now() - 6 * 60_000,
      windows: [makeWindow({ kind: '7d', label: '7-day', usedPercent: 61 })],
      ...overrides
    })
  }

  it('tags every meter it feeds with the machine that took it and how old it is', () => {
    const data = makeDashboard({ providers: [] })
    render(
      <AccountsPanel
        data={data}
        limits={[
          relayed({
            windows: [
              makeWindow({ kind: '5h', label: '5-hour', usedPercent: 13 }),
              makeWindow({ kind: '7d', label: '7-day', usedPercent: 61 })
            ]
          })
        ]}
        blockUsage={emptyBlockUsage()}
        providerColors={COLORS}
      />
    )

    // One per meter, not one per row: a reader scanning a single meter must not
    // have to look elsewhere to learn who read it.
    const tags = screen.getAllByTestId('AccountsPanel.relayed')
    expect(tags).toHaveLength(2)
    expect(tags.map((t) => t.getAttribute('data-device-id'))).toEqual([PEER_ID, PEER_ID])
    // The NAME, on a `local` payload whose machine list is empty (R2).
    expect(tags[0]).toHaveTextContent('via studio-mac · 6m')
    expect(tags[0].textContent).not.toContain(PEER_ID.slice(0, 8))
  })

  it('falls back to the id only when the hub no longer lists the device', () => {
    // What the relay itself writes when `remote_device` holds no row: the id IS
    // the name by then, so nothing on this side has to guess.
    render(
      <AccountsPanel
        data={makeDashboard({ providers: [] })}
        limits={[relayed({ source: { deviceId: PEER_ID, deviceName: PEER_ID } })]}
        blockUsage={emptyBlockUsage()}
        providerColors={COLORS}
      />
    )
    expect(screen.getByTestId('AccountsPanel.relayed')).toHaveTextContent(`via ${PEER_ID}`)
  })

  it('says a masked label is masked, and explains why in the title', () => {
    render(
      <AccountsPanel
        data={makeDashboard({ providers: [] })}
        limits={[relayed()]}
        blockUsage={emptyBlockUsage()}
        providerColors={COLORS}
      />
    )
    const tag = screen.getByTestId('AccountsPanel.masked')
    expect(tag).toHaveTextContent('masked')
    expect(tag.getAttribute('title')).toContain('Only another machine holds a credential')
  })

  it('shows the masked tag on a LEDGER row too, so the scopes read alike', () => {
    // Under `all` the peer's account has buckets, so it is a ledger row and its
    // name comes from the query rather than from the reading. Reading only the
    // reading's flag made the tag appear under `local` and vanish under `all`
    // for one and the same account (round 3, item 3).
    const data = makeDashboard({
      scope: 'all',
      providers: [
        makeProvider({
          providerId: 'anthropic',
          accounts: [
            makeAccount({
              accountKey: 'anthropic:org-9:acct-9',
              label: 'a•••@e•••.test',
              labelMasked: true,
              machines: ['dev-peer'],
              remoteOnly: true
            })
          ]
        })
      ],
      machines: [
        makeMachine({ deviceId: 'dev-self', self: true }),
        makeMachine({ deviceId: 'dev-peer', deviceName: 'studio', self: false })
      ]
    })
    render(
      <AccountsPanel
        data={data}
        limits={[]}
        blockUsage={emptyBlockUsage()}
        providerColors={COLORS}
      />
    )

    expect(screen.getByTestId('AccountsPanel.account')).toHaveTextContent('a•••@e•••.test')
    expect(screen.getByTestId('AccountsPanel.masked')).toBeInTheDocument()
  })

  it('tags nothing on a local reading', () => {
    render(
      <AccountsPanel
        data={makeDashboard()}
        limits={[makeLimits()]}
        blockUsage={emptyBlockUsage()}
        providerColors={COLORS}
      />
    )
    expect(screen.queryByTestId('AccountsPanel.relayed')).not.toBeInTheDocument()
    expect(screen.queryByTestId('AccountsPanel.masked')).not.toBeInTheDocument()
  })
})

describe('AccountsPanel — the machines column', () => {
  const SHARED = 'anthropic:org-1:acct-1'
  const PEER_ONLY = 'anthropic:org-2:acct-2'

  function combined() {
    return makeDashboard({
      scope: 'all',
      providers: [
        makeProvider({
          providerId: 'anthropic',
          totals: makeTotals({ displayCostUsd: 100 }),
          accounts: [
            makeAccount({
              accountKey: SHARED,
              machines: ['dev-self', 'dev-peer'],
              remoteOnly: false,
              totals: makeTotals({ displayCostUsd: 60 })
            }),
            makeAccount({
              accountKey: PEER_ONLY,
              label: 'other@example.test',
              machines: ['dev-peer'],
              remoteOnly: true,
              totals: makeTotals({ displayCostUsd: 40 })
            })
          ]
        })
      ],
      totals: makeTotals({ displayCostUsd: 100 }),
      machines: [
        makeMachine({ deviceId: 'dev-self', deviceName: 'desk', self: true }),
        makeMachine({ deviceId: 'dev-peer', deviceName: 'studio', self: false })
      ]
    })
  }

  it('counts the machines an account is used on, and names a single one', () => {
    render(
      <AccountsPanel
        data={combined()}
        limits={[]}
        blockUsage={emptyBlockUsage()}
        providerColors={COLORS}
      />
    )

    const cells = screen.getAllByTestId('AccountsPanel.account.machines')
    expect(cells[0]).toHaveTextContent('2 machines')
    expect(cells[0].getAttribute('title')).toBe('desk, studio')
    // A single machine that is not this one is NAMED; this machine's own row
    // needs no name at all.
    expect(cells[1]).toHaveTextContent('studio only')
  })

  it('reads `this machine` for an account only this machine spent on', () => {
    const data = makeDashboard({
      scope: 'all',
      providers: [
        makeProvider({
          providerId: 'anthropic',
          accounts: [makeAccount({ machines: ['dev-self'], remoteOnly: false })]
        })
      ],
      machines: [makeMachine({ deviceId: 'dev-self', deviceName: 'desk', self: true })]
    })
    render(
      <AccountsPanel
        data={data}
        limits={[]}
        blockUsage={emptyBlockUsage()}
        providerColors={COLORS}
      />
    )
    expect(screen.getByTestId('AccountsPanel.account.machines')).toHaveTextContent('this machine')
  })

  it('is hidden below the tablet breakpoint, where the row has no room for it', () => {
    // jsdom has no layout, so what is assertable here is the RULE; the verifier
    // measures the 406px row. The column was 100px of it and pushed the spend
    // figure and the relayed tag out of reach (F2).
    render(
      <AccountsPanel
        data={combined()}
        limits={[]}
        blockUsage={emptyBlockUsage()}
        providerColors={COLORS}
      />
    )
    for (const cell of screen.getAllByTestId('AccountsPanel.account.machines')) {
      expect(cell.className).toContain('hidden')
      expect(cell.className).toContain('md:block')
    }
  })

  it('is absent under local — one machine needs no column', () => {
    render(
      <AccountsPanel
        data={makeDashboard()}
        limits={[makeLimits()]}
        blockUsage={emptyBlockUsage()}
        providerColors={COLORS}
      />
    )
    expect(screen.queryByTestId('AccountsPanel.account.machines')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Narrow widths (S5c round 3, item 2)
//
// jsdom has no layout, so what is assertable here is the RULE the layout rests
// on — the card contains no horizontal scroller at all, and the meters are a
// full-width row that follows the label and the spend below `lg` and rejoins
// them at `lg`. The verifier measures the result at 348 CSS px.
// ---------------------------------------------------------------------------

describe('AccountsPanel — the narrow layout', () => {
  it('contains no horizontal scroller, at any width', () => {
    render(
      <AccountsPanel
        data={makeDashboard()}
        limits={[makeLimits()]}
        blockUsage={emptyBlockUsage()}
        providerColors={COLORS}
      />
    )
    // Round 2 put one of these on every row: six scrollbars on one card, and
    // the relayed tag still ended up outside it.
    expect(
      screen.getByTestId('AccountsPanel').querySelectorAll('[class*="overflow-x-auto"]')
    ).toHaveLength(0)
    expect(
      screen.getByTestId('AccountsPanel').querySelectorAll('[class*="min-w-max"]')
    ).toHaveLength(0)
  })

  it('puts the meters on their own line below lg and back in the row at lg', () => {
    render(
      <AccountsPanel
        data={makeDashboard()}
        limits={[makeLimits()]}
        blockUsage={emptyBlockUsage()}
        providerColors={COLORS}
      />
    )
    const meters = screen.getByTestId('AccountsPanel.account.meters')
    // Below `lg`: last in the flex order, and the full width — which is what
    // forces the wrap, so the line above it is the label and the spend.
    expect(meters.className).toContain('order-last')
    expect(meters.className).toContain('w-full')
    // At `lg`: back to its DOM position, sharing the line.
    expect(meters.className).toContain('lg:order-none')
    expect(meters.className).toContain('lg:w-auto')
    expect(meters.className).toContain('lg:flex-1')
    // And the row itself wraps rather than scrolling.
    expect(meters.parentElement?.className).toContain('flex-wrap')
  })

  it('keeps the spend on the first line, before the meters wrap', () => {
    render(
      <AccountsPanel
        data={makeDashboard()}
        limits={[makeLimits()]}
        blockUsage={emptyBlockUsage()}
        providerColors={COLORS}
      />
    )
    // No `order-last`, so it stays with the label whatever the meters do.
    const spend = screen.getByTestId('AccountsPanel.account.spend')
    expect(spend.className).not.toContain('order-last')
    expect(spend.className).toContain('shrink-0')
  })
})
