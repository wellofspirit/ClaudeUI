/**
 * `AccountsPanel` — accounts grouped by provider with their limit meters
 * inline (ADR-071 §8, mockup Accounts C), and the Claude block analytics behind
 * an expander on an Anthropic row.
 *
 * The join is the thing worth guarding: spend comes from the ledger and windows
 * come from the limits provider, and an account that appears on only one side
 * still has to render honestly.
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { AccountsPanel } from '../AccountsPanel'
import { SEVERITY_ICON, buildProviderColorMap } from '../usage-utils'
import type { BlockUsageData } from '../../../../../shared/types'
import {
  makeAccount,
  makeDashboard,
  makeLimits,
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
