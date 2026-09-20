/**
 * `BreakdownTable` — the tree table (ADR-071 §8 item 6, mockup Breakdown A).
 *
 * Two things are worth guarding. The arithmetic: every rung is a fold of the
 * same leaves, so a subtotal must equal the sum of the rows under it and the
 * grand total must equal what the query reported, whichever pill reordered the
 * hierarchy. And the honesty: a dispatched sub-total is marked but never added
 * twice, and an unpriced turn is counted beside the figure it is missing from
 * rather than folded into it as a zero (ADR-030).
 */

import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { BreakdownTable } from '../BreakdownTable'
import { buildProviderColorMap } from '../usage-utils'
import { makeAccount, makeDashboard, makeProvider, makeTotals } from './dashboard-fixtures'
import type { DashboardModel, UsageDashboardData } from '../../../../../shared/types'

const COLORS = buildProviderColorMap(['anthropic', 'openai'])

function makeModel(
  engineId: string,
  modelId: string,
  displayCostUsd: number,
  extra: Partial<DashboardModel> = {}
): DashboardModel {
  return {
    engineId,
    vendorId: engineId === 'codex' ? 'openai' : 'anthropic',
    modelId,
    totals: makeTotals({
      displayCostUsd,
      apiCostUsd: displayCostUsd,
      requestCount: 1,
      tokens: { input: 1_000, output: 100, cacheWrite: 0, cacheRead: 0 }
    }),
    dispatched: null,
    ...extra
  }
}

/**
 * Two providers, three accounts, four model rows, with the figures chosen so a
 * wrong fold shows up as a wrong dollar amount rather than as a near miss:
 *
 *   Anthropic $15 = acct-a $10 (Opus 5 $6 + Sonnet 5 $4) + acct-b $5 (Opus 5 $5)
 *   OpenAI    $8  = acct-c $8  (gpt-6-astra $8, 3 turns unpriced)
 */
function fixture(): UsageDashboardData {
  const sonnet = makeModel('claude', 'claude-sonnet-5', 4, {
    dispatched: makeTotals({ displayCostUsd: 1.5, apiCostUsd: 1.5, requestCount: 2 })
  })
  const acctA = makeAccount({
    accountKey: 'anthropic:org-1:acct-a',
    label: 'acct-a',
    providerId: 'anthropic',
    totals: makeTotals({ displayCostUsd: 10, apiCostUsd: 10, requestCount: 2 }),
    models: [makeModel('claude', 'claude-opus-5', 6), sonnet],
    dispatched: makeTotals({ displayCostUsd: 1.5, apiCostUsd: 1.5, requestCount: 2 })
  })
  const acctB = makeAccount({
    accountKey: 'anthropic:org-1:acct-b',
    label: 'acct-b',
    providerId: 'anthropic',
    totals: makeTotals({ displayCostUsd: 5, apiCostUsd: 5, requestCount: 1 }),
    models: [makeModel('claude', 'claude-opus-5', 5)]
  })
  const acctC = makeAccount({
    accountKey: 'chatgpt:w:u',
    label: 'acct-c',
    providerId: 'openai',
    billingType: 'apiKey',
    totals: makeTotals({ displayCostUsd: 8, billedCostUsd: 8, requestCount: 1 }),
    models: [
      makeModel('codex', 'gpt-6-astra', 8, {
        totals: makeTotals({
          displayCostUsd: 8,
          billedCostUsd: 8,
          unknownApiCostCount: 3,
          requestCount: 1,
          tokens: { input: 2_000, output: 200, cacheWrite: 0, cacheRead: 0 }
        })
      })
    ]
  })

  return makeDashboard({
    totals: makeTotals({
      displayCostUsd: 23,
      apiCostUsd: 15,
      billedCostUsd: 8,
      unknownApiCostCount: 3,
      requestCount: 4
    }),
    providers: [
      makeProvider({
        providerId: 'anthropic',
        label: 'Anthropic',
        totals: makeTotals({ displayCostUsd: 15, apiCostUsd: 15 }),
        accounts: [acctA, acctB]
      }),
      makeProvider({
        providerId: 'openai',
        label: 'OpenAI',
        totals: makeTotals({ displayCostUsd: 8, billedCostUsd: 8, unknownApiCostCount: 3 }),
        accounts: [acctC]
      })
    ]
  })
}

/** The rendered rows at one depth, as `label → display-cost cell` pairs. */
function rowsAtLevel(level: number): Array<[string, string]> {
  return screen
    .getAllByTestId('BreakdownTable.row')
    .filter((r) => r.getAttribute('data-level') === String(level))
    .map((r) => [
      within(r).getByTestId('BreakdownTable.row.label').textContent ?? '',
      r.querySelectorAll('td')[4].textContent ?? ''
    ])
}

describe('BreakdownTable — the hierarchy', () => {
  it('opens the top rung and leaves the detail closed', () => {
    render(<BreakdownTable data={fixture()} groupBy="provider" providerColors={COLORS} />)

    // Providers, then their accounts; the model rows wait to be asked for.
    expect(rowsAtLevel(0).map(([label]) => label)).toEqual(['Anthropic', 'OpenAI'])
    expect(rowsAtLevel(1).map(([label]) => label)).toEqual(['acct-a', 'acct-b', 'acct-c'])
    expect(rowsAtLevel(2)).toHaveLength(0)
  })

  it('expands and collapses a row from its toggle', () => {
    render(<BreakdownTable data={fixture()} groupBy="provider" providerColors={COLORS} />)

    const acctA = screen
      .getAllByTestId('BreakdownTable.row')
      .find((r) => r.getAttribute('data-key')?.endsWith('anthropic:org-1:acct-a'))
    expect(acctA).toBeDefined()
    expect(acctA).toHaveAttribute('data-expanded', 'false')

    fireEvent.click(within(acctA!).getByTestId('BreakdownTable.row.toggle'))
    expect(
      screen
        .getAllByTestId('BreakdownTable.row')
        .find((r) => r.getAttribute('data-key')?.endsWith('anthropic:org-1:acct-a'))
    ).toHaveAttribute('data-expanded', 'true')
    expect(rowsAtLevel(2).map(([label]) => label)).toEqual(['Opus 5', 'Sonnet 5'])

    // And the provider above it folds its whole subtree away again.
    const provider = screen
      .getAllByTestId('BreakdownTable.row')
      .find((r) => r.getAttribute('data-key') === 'provider/anthropic')
    fireEvent.click(within(provider!).getByTestId('BreakdownTable.row.toggle'))
    expect(rowsAtLevel(1).map(([label]) => label)).toEqual(['acct-c'])
    expect(rowsAtLevel(2)).toHaveLength(0)
  })

  it('every subtotal is the sum of the rows under it', () => {
    render(<BreakdownTable data={fixture()} groupBy="provider" providerColors={COLORS} />)

    expect(rowsAtLevel(0)).toEqual([
      ['Anthropic', expect.stringContaining('$15.00')],
      ['OpenAI', expect.stringContaining('$8.00')]
    ])
    // $10.00 + $5.00 = the Anthropic header, $8.00 = the OpenAI one.
    expect(rowsAtLevel(1).map(([, cost]) => cost)).toEqual([
      expect.stringContaining('$10.00'),
      expect.stringContaining('$5.00'),
      expect.stringContaining('$8.00')
    ])

    const acctA = screen
      .getAllByTestId('BreakdownTable.row')
      .find((r) => r.getAttribute('data-key')?.endsWith('anthropic:org-1:acct-a'))
    fireEvent.click(within(acctA!).getByTestId('BreakdownTable.row.toggle'))
    // $6.00 + $4.00 = acct-a.
    expect(rowsAtLevel(2).map(([, cost]) => cost)).toEqual([
      expect.stringContaining('$6.00'),
      expect.stringContaining('$4.00')
    ])
  })

  it('reorders on the group-by, folding the same leaves a different way', () => {
    const data = fixture()
    const { unmount } = render(
      <BreakdownTable data={data} groupBy="engine" providerColors={COLORS} />
    )
    // claude ran $6 + $4 + $5, codex ran $8.
    expect(rowsAtLevel(0)).toEqual([
      ['Claude', expect.stringContaining('$15.00')],
      ['Codex', expect.stringContaining('$8.00')]
    ])
    // One model rung under the engine, with Opus summed across both accounts.
    expect(rowsAtLevel(1)).toEqual([
      ['Opus 5', expect.stringContaining('$11.00')],
      ['Sonnet 5', expect.stringContaining('$4.00')],
      ['gpt-6-astra', expect.stringContaining('$8.00')]
    ])
    unmount()

    render(<BreakdownTable data={data} groupBy="model" providerColors={COLORS} />)
    expect(rowsAtLevel(0)).toEqual([
      ['Opus 5', expect.stringContaining('$11.00')],
      ['gpt-6-astra', expect.stringContaining('$8.00')],
      ['Sonnet 5', expect.stringContaining('$4.00')]
    ])
    // Opus 5 splits back into the two accounts that ran it.
    expect(rowsAtLevel(1)).toEqual([
      ['acct-a', expect.stringContaining('$6.00')],
      ['acct-b', expect.stringContaining('$5.00')],
      ['acct-c', expect.stringContaining('$8.00')],
      ['acct-a', expect.stringContaining('$4.00')]
    ])
  })
})

describe('BreakdownTable — the honest columns', () => {
  it('marks the dispatched part of a row without adding it again', () => {
    render(<BreakdownTable data={fixture()} groupBy="provider" providerColors={COLORS} />)

    const marked = screen
      .getAllByTestId('BreakdownTable.row')
      .filter((r) => within(r).queryByTestId('BreakdownTable.row.dispatched') !== null)
    // The provider and the account the dispatched turns ran under — and no
    // other row, because nothing else in the fixture dispatched anything.
    expect(marked.map((r) => r.getAttribute('data-key'))).toEqual([
      'provider/anthropic',
      'provider/anthropic/anthropic:org-1:acct-a'
    ])
    expect(within(marked[0]).getByTestId('BreakdownTable.row.dispatched')).toHaveTextContent(
      '$1.50 dispatched'
    )
    // The row's own cost is untouched: the marker names part of it, not an extra.
    expect(marked[0].querySelectorAll('td')[4]).toHaveTextContent('$15.00')
  })

  it('counts the turns nothing could price beside the figure they are missing from', () => {
    render(<BreakdownTable data={fixture()} groupBy="provider" providerColors={COLORS} />)

    const badges = screen.getAllByTestId('BreakdownTable.row.unpriced')
    // The OpenAI provider row, the account under it, and the footer total —
    // the three figures those three turns are missing from.
    expect(badges).toHaveLength(3)
    for (const badge of badges) expect(badge).toHaveTextContent('+3 unpriced')

    const anthropic = screen
      .getAllByTestId('BreakdownTable.row')
      .find((r) => r.getAttribute('data-key') === 'provider/anthropic')
    expect(within(anthropic!).queryByTestId('BreakdownTable.row.unpriced')).toBeNull()
  })

  it('reports the query’s own totals in the footer, not a re-derived sum', () => {
    render(<BreakdownTable data={fixture()} groupBy="provider" providerColors={COLORS} />)

    const total = screen.getByTestId('BreakdownTable.total')
    const cells = total.querySelectorAll('td')
    expect(cells[0]).toHaveTextContent('Total')
    expect(cells[2]).toHaveTextContent('$15.00') // api
    expect(cells[3]).toHaveTextContent('$8.00') // billed
    expect(cells[4]).toHaveTextContent('$23.00') // display
    expect(cells[4]).toHaveTextContent('+3 unpriced')
    expect(cells[5]).toHaveTextContent('100%')
  })

  it('counts turns rather than dollars when the dispatched work was not priced', () => {
    // A free or unpriced engine's dispatched sub-total is a real $0.00, and
    // `↗ $0.00 dispatched` reads as a broken figure instead of a fact.
    const free = makeModel('opencode', 'glm-5-free', 0, {
      totals: makeTotals({ displayCostUsd: 0, requestCount: 9, unknownApiCostCount: 9 }),
      dispatched: makeTotals({ displayCostUsd: 0, requestCount: 4, unknownApiCostCount: 4 })
    })
    const data = makeDashboard({
      totals: makeTotals({ displayCostUsd: 0, unknownApiCostCount: 9, requestCount: 9 }),
      providers: [
        makeProvider({
          providerId: 'deadp',
          label: 'deadp',
          totals: makeTotals({ displayCostUsd: 0, unknownApiCostCount: 9 }),
          accounts: [
            makeAccount({
              accountKey: 'deadp:key:abc',
              label: 'deadp key',
              providerId: 'deadp',
              billingType: 'free',
              totals: makeTotals({ displayCostUsd: 0, unknownApiCostCount: 9 }),
              models: [free]
            })
          ]
        })
      ]
    })
    render(<BreakdownTable data={data} groupBy="engine" providerColors={COLORS} />)

    const marker = screen.getAllByTestId('BreakdownTable.row.dispatched')[0]
    expect(marker).toHaveTextContent('4 turns dispatched')
    expect(marker).not.toHaveTextContent('$0.00 dispatched')
    // The title still names the figure, so nothing is hidden.
    expect(marker.getAttribute('title')).toContain('$0.00')
  })

  it('writes an unbilled total the same way it writes an unbilled row', () => {
    const data = fixture()
    data.totals.billedCostUsd = 0
    render(<BreakdownTable data={data} groupBy="provider" providerColors={COLORS} />)

    const billed = screen.getByTestId('BreakdownTable.total').querySelectorAll('td')[3]
    expect(billed).toHaveTextContent('—')
    expect(billed).not.toHaveTextContent('$0.00')
    expect(billed.getAttribute('title')).toContain('Nothing was charged')
  })

  it('says so when the range holds nothing to break down', () => {
    const empty = makeDashboard({ providers: [], totals: makeTotals() })
    render(<BreakdownTable data={empty} groupBy="provider" providerColors={COLORS} />)
    expect(screen.getByTestId('BreakdownTable.empty')).toBeInTheDocument()
    expect(screen.queryAllByTestId('BreakdownTable.row')).toHaveLength(0)
  })
})
