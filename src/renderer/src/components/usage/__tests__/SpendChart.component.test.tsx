/**
 * `SpendChart` — spend over time (ADR-071 §8 item 5, mockup Spend over time A / B).
 *
 * The geometry is the contract: one column per day of the range whatever the
 * data is (a sparse `byProvider` is a gap, not a missing column), a bar that
 * never exceeds the owner's 14px cap, and a stack that draws exactly the
 * providers that spent something that day. The subtitle is the honesty check —
 * the daily series only splits by provider, and the chart has to say so rather
 * than let the header's group-by imply otherwise.
 */

import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { SpendChart, shouldPinToLatest } from '../SpendChart'
import { buildProviderColorMap } from '../usage-utils'
import { makeAccount, makeDashboard, makeProvider, makeTotals } from './dashboard-fixtures'
import type { DashboardDay, UsageDashboardData } from '../../../../../shared/types'

const COLORS = buildProviderColorMap(['anthropic', 'openai'])

/** `YYYY-MM-DD` for a UTC instant — only used to generate a contiguous range. */
function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** A day whose providers are given as plain display dollars. */
function makeDay(date: string, byProvider: Record<string, number>): DashboardDay {
  const display = Object.values(byProvider).reduce((s, v) => s + v, 0)
  return {
    date,
    byProvider: Object.fromEntries(
      Object.entries(byProvider).map(([id, usd]) => [
        id,
        { apiCostUsd: usd, billedCostUsd: 0, displayCostUsd: usd }
      ])
    ),
    totals: makeTotals({ displayCostUsd: display, apiCostUsd: display })
  }
}

function twoProviderDashboard(days: DashboardDay[]): UsageDashboardData {
  return makeDashboard({
    days,
    providers: [
      makeProvider({
        providerId: 'anthropic',
        label: 'Anthropic',
        totals: makeTotals({ displayCostUsd: 30 }),
        accounts: [makeAccount()]
      }),
      makeProvider({
        providerId: 'openai',
        label: 'OpenAI',
        totals: makeTotals({ displayCostUsd: 10 }),
        accounts: [makeAccount({ accountKey: 'chatgpt:w:u', providerId: 'openai' })]
      })
    ]
  })
}

describe('SpendChart — variant A, stacked columns', () => {
  it('draws one column per day of the range, keyed by its date', () => {
    const days = [
      makeDay('2026-09-18', { anthropic: 3 }),
      makeDay('2026-09-19', { anthropic: 5, openai: 2 }),
      makeDay('2026-09-20', { openai: 1 })
    ]
    render(
      <SpendChart data={twoProviderDashboard(days)} providerColors={COLORS} groupBy="provider" />
    )

    const columns = screen.getAllByTestId('SpendChart.column')
    expect(columns).toHaveLength(days.length)
    expect(columns.map((c) => c.getAttribute('data-date'))).toEqual([
      '2026-09-18',
      '2026-09-19',
      '2026-09-20'
    ])
  })

  it('stacks exactly the providers present that day — a sparse day is a gap, not a zero bar', () => {
    const days = [
      makeDay('2026-09-18', { anthropic: 3 }),
      makeDay('2026-09-19', { anthropic: 5, openai: 2 }),
      // Nothing at all on this day: a column, but no segments.
      makeDay('2026-09-20', {})
    ]
    render(
      <SpendChart data={twoProviderDashboard(days)} providerColors={COLORS} groupBy="provider" />
    )

    const columns = screen.getAllByTestId('SpendChart.column')
    expect(within(columns[0]).getAllByTestId('SpendChart.segment')).toHaveLength(1)
    expect(within(columns[1]).getAllByTestId('SpendChart.segment')).toHaveLength(2)
    expect(within(columns[2]).queryAllByTestId('SpendChart.segment')).toHaveLength(0)

    expect(
      within(columns[1])
        .getAllByTestId('SpendChart.segment')
        .map((s) => s.getAttribute('data-provider-id'))
    ).toEqual(['anthropic', 'openai'])
  })

  it('never draws a bar wider than the 14px cap, at any range length', () => {
    const few = [makeDay('2026-09-19', { anthropic: 5 }), makeDay('2026-09-20', { anthropic: 9 })]
    const { unmount } = render(
      <SpendChart data={twoProviderDashboard(few)} providerColors={COLORS} groupBy="provider" />
    )
    for (const seg of screen.getAllByTestId('SpendChart.segment')) {
      expect(Number(seg.getAttribute('width'))).toBeLessThanOrEqual(14)
    }
    unmount()

    // 91 columns is the 90-day range: the bars get thin, the chart scrolls, and
    // the cap still holds at the other end.
    const many = Array.from({ length: 91 }, (_, i) =>
      makeDay(isoDay(Date.UTC(2026, 5, 22) + i * 86_400_000), { anthropic: i + 1 })
    )
    render(
      <SpendChart data={twoProviderDashboard(many)} providerColors={COLORS} groupBy="provider" />
    )
    expect(screen.getAllByTestId('SpendChart.column')).toHaveLength(91)
    for (const seg of screen.getAllByTestId('SpendChart.segment')) {
      expect(Number(seg.getAttribute('width'))).toBeLessThanOrEqual(14)
    }
    expect(screen.getByTestId('SpendChart.scroll')).toBeInTheDocument()
    expect(screen.getByTestId('SpendChart.axis')).toBeInTheDocument()
  })

  it('keeps every stacked segment inside the 130px plot, whatever the day totals', () => {
    // A 31-day range with an order-of-magnitude spread and a day that is almost
    // nothing: the minimum-height floor must not push a stack out of the box,
    // and the nice-number axis must have headroom over the tallest column.
    const days = Array.from({ length: 31 }, (_, i) =>
      makeDay(isoDay(Date.UTC(2026, 7, 21) + i * 86_400_000), {
        anthropic: i === 5 ? 0.0001 : (i % 7) * 12 + 1,
        openai: i % 3 === 0 ? 0.02 : 0
      })
    )
    render(
      <SpendChart data={twoProviderDashboard(days)} providerColors={COLORS} groupBy="provider" />
    )

    const PAD_T = 6
    const PLOT_BOTTOM = 130 - 16
    for (const seg of screen.getAllByTestId('SpendChart.segment')) {
      const y = Number(seg.getAttribute('y'))
      const height = Number(seg.getAttribute('height'))
      expect(y).toBeGreaterThanOrEqual(PAD_T)
      expect(height).toBeGreaterThan(0)
      expect(y + height).toBeLessThanOrEqual(PLOT_BOTTOM)
    }
  })

  it('names every provider of the hovered day, with the day total', () => {
    const days = [makeDay('2026-09-19', { anthropic: 5, openai: 2 })]
    render(
      <SpendChart data={twoProviderDashboard(days)} providerColors={COLORS} groupBy="provider" />
    )

    expect(screen.queryByTestId('SpendChart.tooltip')).not.toBeInTheDocument()
    fireEvent.mouseEnter(screen.getAllByTestId('SpendChart.column')[0])

    const tooltip = screen.getByTestId('SpendChart.tooltip')
    expect(tooltip).toHaveTextContent('Anthropic')
    expect(tooltip).toHaveTextContent('$5.00')
    expect(tooltip).toHaveTextContent('OpenAI')
    expect(tooltip).toHaveTextContent('$2.00')
    expect(tooltip).toHaveTextContent('Total')
    expect(tooltip).toHaveTextContent('$7.00')
  })

  it('shows a total that adds up to the lines it is under', () => {
    // $364.3151 + $0.7451 is an unrounded $365.06, which the tooltip printed
    // beside the lines $364.32 and $0.75 — arithmetic a reader can see fail.
    const days = [makeDay('2026-09-19', { anthropic: 364.3151, openai: 0.7451 })]
    render(
      <SpendChart data={twoProviderDashboard(days)} providerColors={COLORS} groupBy="provider" />
    )
    fireEvent.mouseEnter(screen.getAllByTestId('SpendChart.column')[0])

    const tooltip = screen.getByTestId('SpendChart.tooltip')
    expect(tooltip).toHaveTextContent('$364.32')
    expect(tooltip).toHaveTextContent('$0.75')
    expect(tooltip).toHaveTextContent('$365.07')
  })

  it('says nothing was spent rather than drawing an empty scale', () => {
    render(
      <SpendChart
        data={twoProviderDashboard([makeDay('2026-09-20', {})])}
        providerColors={COLORS}
        groupBy="provider"
      />
    )
    expect(screen.getByTestId('SpendChart.empty')).toBeInTheDocument()
    expect(screen.queryAllByTestId('SpendChart.column')).toHaveLength(0)
  })
})

describe('SpendChart — the mode toggle', () => {
  const days = [
    makeDay('2026-09-19', { anthropic: 5, openai: 2 }),
    makeDay('2026-09-20', { anthropic: 9 })
  ]

  it('switches between stacked columns and one row per provider', () => {
    render(
      <SpendChart data={twoProviderDashboard(days)} providerColors={COLORS} groupBy="provider" />
    )

    expect(screen.getByTestId('SpendChart')).toHaveAttribute('data-mode', 'stacked')
    expect(screen.getAllByTestId('SpendChart.column')).toHaveLength(2)
    expect(screen.queryAllByTestId('SpendChart.row')).toHaveLength(0)

    fireEvent.click(screen.getByTestId('SpendChart.mode.perProvider'))

    expect(screen.getByTestId('SpendChart')).toHaveAttribute('data-mode', 'perProvider')
    expect(screen.queryAllByTestId('SpendChart.column')).toHaveLength(0)
    const rows = screen.getAllByTestId('SpendChart.row')
    expect(rows.map((r) => r.getAttribute('data-provider-id'))).toEqual(['anthropic', 'openai'])
    // Each row carries the provider's range total beside its own scale.
    expect(within(rows[0]).getByTestId('SpendChart.row.total')).toHaveTextContent('$14.00')
    expect(within(rows[1]).getByTestId('SpendChart.row.total')).toHaveTextContent('$2.00')

    fireEvent.click(screen.getByTestId('SpendChart.mode.stacked'))
    expect(screen.getAllByTestId('SpendChart.column')).toHaveLength(2)
  })

  it('hides a provider that spent nothing, and counts it in the note', () => {
    // A free or unpriced provider has no scale, so its row would be a bare
    // baseline — the same thing a failed load would look like.
    const data = makeDashboard({
      days,
      providers: [
        makeProvider({
          providerId: 'anthropic',
          label: 'Anthropic',
          totals: makeTotals({ displayCostUsd: 14 }),
          accounts: [makeAccount()]
        }),
        makeProvider({
          providerId: 'openai',
          label: 'OpenAI',
          totals: makeTotals({ displayCostUsd: 2 }),
          accounts: [makeAccount({ accountKey: 'chatgpt:w:u', providerId: 'openai' })]
        }),
        makeProvider({
          providerId: 'llamacpp',
          label: 'llamacpp',
          totals: makeTotals({ displayCostUsd: 0 }),
          accounts: [makeAccount({ accountKey: 'llamacpp:key:x', providerId: 'llamacpp' })]
        })
      ]
    })
    render(<SpendChart data={data} providerColors={COLORS} groupBy="provider" />)
    fireEvent.click(screen.getByTestId('SpendChart.mode.perProvider'))

    expect(
      screen.getAllByTestId('SpendChart.row').map((r) => r.getAttribute('data-provider-id'))
    ).toEqual(['anthropic', 'openai'])
    expect(screen.getByTestId('SpendChart.rowsNote')).toHaveTextContent(
      '1 provider with no spend hidden'
    )
  })
})

describe('SpendChart — scroll-to-latest', () => {
  // jsdom reports every layout figure as 0, so the decision is asserted as a
  // function of the numbers rather than through a rendered scroll position.
  it('pins on the first pass of a mount', () => {
    expect(
      shouldPinToLatest({
        hasPinned: false,
        dayCountChanged: false,
        distanceFromEnd: 999,
        threshold: 40
      })
    ).toBe(true)
  })

  it('pins whenever the range changed, however the old chart was scrolled', () => {
    // The regression: 30d fitted its viewport, so `scrollLeft` was 0 and the
    // distance-from-end guard read it as "parked at the far left on purpose",
    // leaving 90d showing its oldest 30 days.
    expect(
      shouldPinToLatest({
        hasPinned: true,
        dayCountChanged: true,
        distanceFromEnd: 205,
        threshold: 22
      })
    ).toBe(true)
  })

  it('keeps the reader pinned across a resize when they were at the end', () => {
    expect(
      shouldPinToLatest({
        hasPinned: true,
        dayCountChanged: false,
        distanceFromEnd: 10,
        threshold: 40
      })
    ).toBe(true)
  })

  it('leaves a reader who scrolled back where they are on a resize', () => {
    expect(
      shouldPinToLatest({
        hasPinned: true,
        dayCountChanged: false,
        distanceFromEnd: 400,
        threshold: 40
      })
    ).toBe(false)
  })
})

describe('SpendChart — what it can split by', () => {
  const days = [makeDay('2026-09-20', { anthropic: 5, openai: 2 })]

  it('says nothing extra when the header is already grouping by provider', () => {
    render(
      <SpendChart data={twoProviderDashboard(days)} providerColors={COLORS} groupBy="provider" />
    )
    expect(screen.queryByTestId('SpendChart.subtitle')).not.toBeInTheDocument()
  })

  it('admits it is still stacked by provider when the header asks for anything else', () => {
    for (const groupBy of ['account', 'engine', 'model'] as const) {
      const { unmount } = render(
        <SpendChart data={twoProviderDashboard(days)} providerColors={COLORS} groupBy={groupBy} />
      )
      const subtitle = screen.getByTestId('SpendChart.subtitle')
      expect(subtitle).toHaveTextContent('Stacked by provider')
      expect(subtitle).toHaveTextContent(groupBy)
      unmount()
    }
  })
})
