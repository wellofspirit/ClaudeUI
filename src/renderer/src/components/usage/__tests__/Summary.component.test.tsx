/**
 * `Summary` — the dashboard's headline (ADR-071 §8, mockup Summary B / D).
 *
 * The figures are the contract: the hero is the display cost, the unpriced
 * badge is ADR-030's "an unknown is never a zero", and below the mobile
 * breakpoint the whole card collapses to the one-line strip.
 */

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Summary } from '../Summary'
import { buildProviderColorMap } from '../usage-utils'
import type { UsageDashboardData } from '../../../../../shared/types'
import {
  makeAccount,
  makeDashboard,
  makeDay,
  makeMachine,
  makeProvider,
  makeTotals
} from './dashboard-fixtures'

function colors(ids: string[]): Map<string, string> {
  return buildProviderColorMap(ids)
}

describe('Summary — variant B', () => {
  it('renders the range display cost as the hero figure', () => {
    const data = makeDashboard({
      totals: makeTotals({ displayCostUsd: 123.456, billedCostUsd: 23.4 }),
      coveredUsd: 100
    })
    render(<Summary data={data} compact={false} providerColors={colors(['anthropic'])} />)
    expect(screen.getByTestId('Summary.hero')).toHaveTextContent('$123.46')
    expect(screen.getByTestId('Summary.coverageBar')).toBeInTheDocument()
    expect(screen.getByTestId('Summary.providerBar')).toBeInTheDocument()
    expect(screen.queryByTestId('Summary.strip')).not.toBeInTheDocument()
  })

  it('shows the unpriced count beside the figure only when there is one', () => {
    const none = makeDashboard({ totals: makeTotals({ displayCostUsd: 5 }) })
    const { unmount } = render(
      <Summary data={none} compact={false} providerColors={colors(['anthropic'])} />
    )
    expect(screen.queryByTestId('Summary.unpriced')).not.toBeInTheDocument()
    unmount()

    const some = makeDashboard({
      totals: makeTotals({ displayCostUsd: 5, unknownApiCostCount: 3 })
    })
    render(<Summary data={some} compact={false} providerColors={colors(['anthropic'])} />)
    expect(screen.getByTestId('Summary.unpriced')).toHaveTextContent('+3 unpriced')
  })

  it('draws one provider-bar segment per provider, in the query order', () => {
    const data = makeDashboard({
      providers: [
        makeProvider({
          providerId: 'anthropic',
          label: 'Anthropic',
          totals: makeTotals({ displayCostUsd: 80 }),
          accounts: [makeAccount()]
        }),
        makeProvider({
          providerId: 'openai',
          label: 'OpenAI',
          totals: makeTotals({ displayCostUsd: 20 }),
          accounts: [makeAccount({ accountKey: 'chatgpt:w:u', providerId: 'openai' })]
        })
      ],
      totals: makeTotals({ displayCostUsd: 100 })
    })
    render(<Summary data={data} compact={false} providerColors={colors(['anthropic', 'openai'])} />)
    const segments = screen
      .getByTestId('Summary.providerBar')
      .querySelectorAll('[data-provider-id]')
    expect(Array.from(segments).map((s) => s.getAttribute('data-provider-id'))).toEqual([
      'anthropic',
      'openai'
    ])
  })

  it('captions the hero as spend and states the rule behind it', () => {
    const data = makeDashboard({ totals: makeTotals({ displayCostUsd: 9 }) })
    render(<Summary data={data} compact={false} providerColors={colors(['anthropic'])} />)
    // Not "API-equivalent": half the figure can be an actual charge.
    expect(screen.getByTestId('Summary')).toHaveTextContent('Spend · last 30 days')
    expect(screen.getByTestId('Summary.hero').getAttribute('title')).toContain(
      'the actual charge for turns billed to a key'
    )
  })

  it('captions the Today range as a word, not as a duration', () => {
    const data = makeDashboard({ range: 'today', totals: makeTotals({ displayCostUsd: 9 }) })
    render(<Summary data={data} compact={false} providerColors={colors(['anthropic'])} />)
    expect(screen.getByTestId('Summary')).toHaveTextContent('Spend · today')
  })

  it('names the range on the compact strip, Today included', () => {
    const data = makeDashboard({ range: 'today', totals: makeTotals({ displayCostUsd: 9 }) })
    render(<Summary data={data} compact providerColors={colors(['anthropic'])} />)
    expect(screen.getByTestId('Summary.strip')).toHaveTextContent('today')
  })

  it('footnotes the unattributed total only when it is non-zero', () => {
    const zero = makeDashboard({ unattributedUsd: 0 })
    const { unmount } = render(
      <Summary data={zero} compact={false} providerColors={colors(['anthropic'])} />
    )
    expect(screen.queryByTestId('Summary.unattributed')).not.toBeInTheDocument()
    unmount()

    const some = makeDashboard({ unattributedUsd: 4.2 })
    render(<Summary data={some} compact={false} providerColors={colors(['anthropic'])} />)
    expect(screen.getByTestId('Summary.unattributed')).toHaveTextContent('$4.20')
  })
})

describe('Summary — variant D (narrow)', () => {
  it('collapses to the one-line strip and keeps the hero figure', () => {
    const data = makeDashboard({
      totals: makeTotals({ displayCostUsd: 42, billedCostUsd: 2, unknownApiCostCount: 1 }),
      coveredUsd: 40
    })
    render(<Summary data={data} compact providerColors={colors(['anthropic'])} />)
    const strip = screen.getByTestId('Summary.strip')
    expect(strip).toBeInTheDocument()
    expect(screen.getByTestId('Summary.hero')).toHaveTextContent('$42.00')
    expect(strip).toHaveTextContent('$40.00')
    expect(strip).toHaveTextContent('$2.00')
    expect(screen.getByTestId('Summary.unpriced')).toHaveTextContent('+1 unpriced')
    // One subscription account in the default fixture.
    expect(strip).toHaveTextContent('covered by 1 plan')
    // The tall half of B is what the strip drops.
    expect(screen.queryByTestId('Summary.coverageBar')).not.toBeInTheDocument()
  })

  it('counts the SUBSCRIPTION accounts, not the providers', () => {
    const data = makeDashboard({
      providers: [
        makeProvider({
          providerId: 'anthropic',
          accounts: [
            makeAccount({ accountKey: 'anthropic:o:a1' }),
            makeAccount({ accountKey: 'anthropic:o:a2' })
          ]
        }),
        makeProvider({
          providerId: 'openai',
          label: 'OpenAI',
          accounts: [
            makeAccount({ accountKey: 'chatgpt:w:u', providerId: 'openai' }),
            makeAccount({
              accountKey: 'openrouter:key:abcd',
              providerId: 'openai',
              billingType: 'apiKey'
            })
          ]
        })
      ]
    })
    render(<Summary data={data} compact providerColors={colors(['anthropic', 'openai'])} />)
    expect(screen.getByTestId('Summary.strip')).toHaveTextContent('covered by 3 plans')
  })

  it('omits the qualifier when no plan covered anything', () => {
    const data = makeDashboard({
      providers: [
        makeProvider({
          providerId: 'openrouter',
          accounts: [makeAccount({ providerId: 'openrouter', billingType: 'apiKey' })]
        })
      ]
    })
    render(<Summary data={data} compact providerColors={colors(['openrouter'])} />)
    const strip = screen.getByTestId('Summary.strip')
    expect(strip).toHaveTextContent('covered')
    expect(strip).not.toHaveTextContent('plan')
  })
})

// ---------------------------------------------------------------------------
// Bar geometry: every segment is a share of the HERO, never of its neighbours
// ---------------------------------------------------------------------------

function widths(bar: HTMLElement): Array<{ id: string | null; pct: number }> {
  return Array.from(bar.querySelectorAll<HTMLElement>('[style*="width"]')).map((el) => ({
    id: el.getAttribute('data-segment') ?? el.getAttribute('data-provider-id'),
    pct: parseFloat(el.style.width)
  }))
}

describe('Summary — coverage bar geometry', () => {
  it('paints a tiny covered figure as a tiny sliver of a large hero', () => {
    // The owner's profile before attribution: $0.39 covered under a $3,735 hero.
    const data = makeDashboard({
      totals: makeTotals({ displayCostUsd: 3735, billedCostUsd: 0 }),
      coveredUsd: 0.39
    })
    render(<Summary data={data} compact={false} providerColors={colors(['anthropic'])} />)
    const segs = widths(screen.getByTestId('Summary.coverageBar'))
    const covered = segs.find((s) => s.id === 'covered')!
    expect(covered.pct).toBeLessThan(1)
    // Present but sub-pixel: a minimum width keeps it from vanishing entirely.
    expect(
      screen.getByTestId('Summary.coverageBar').querySelector('[data-segment="covered"]')
    ).toHaveStyle({ minWidth: '2px' })
  })

  it('splits the hero into covered, billed and the remainder nobody can name', () => {
    const data = makeDashboard({
      totals: makeTotals({ displayCostUsd: 100, billedCostUsd: 25 }),
      coveredUsd: 60
    })
    render(<Summary data={data} compact={false} providerColors={colors(['anthropic'])} />)
    const segs = widths(screen.getByTestId('Summary.coverageBar'))
    expect(segs.map((s) => s.id)).toEqual(['covered', 'billed', 'unknown'])
    expect(segs.map((s) => s.pct)).toEqual([60, 25, 15])
    expect(segs.reduce((sum, s) => sum + s.pct, 0)).toBe(100)
    expect(screen.getByTestId('Summary')).toHaveTextContent('Billing unknown')
  })

  it('omits a segment that is worth nothing rather than drawing a zero', () => {
    const data = makeDashboard({
      totals: makeTotals({ displayCostUsd: 100, billedCostUsd: 0 }),
      coveredUsd: 100
    })
    render(<Summary data={data} compact={false} providerColors={colors(['anthropic'])} />)
    const segs = widths(screen.getByTestId('Summary.coverageBar'))
    expect(segs.map((s) => s.id)).toEqual(['covered'])
    expect(segs[0].pct).toBe(100)
  })

  it('names in the legend exactly the segments the bar drew', () => {
    // The owner's profile: nothing billed to a card, so no billed segment and
    // no "Billed to a card" key to hunt for.
    const data = makeDashboard({
      totals: makeTotals({ displayCostUsd: 3735, billedCostUsd: 0 }),
      coveredUsd: 0.39
    })
    render(<Summary data={data} compact={false} providerColors={colors(['anthropic'])} />)
    const bar = screen.getByTestId('Summary.coverageBar')
    const drawn = Array.from(bar.querySelectorAll('[data-segment]')).map((el) =>
      el.getAttribute('data-segment')
    )
    const summary = screen.getByTestId('Summary')
    const keys = Array.from(summary.querySelectorAll('[data-legend]')).map((el) =>
      el.getAttribute('data-legend')
    )
    expect(drawn).toEqual(['covered', 'unknown'])
    expect(keys).toEqual(drawn)
    expect(summary).not.toHaveTextContent('Billed to a card')
    expect(summary).toHaveTextContent('Billing unknown')
  })

  it('sizes provider segments by their share of the hero too', () => {
    const data = makeDashboard({
      providers: [
        makeProvider({
          providerId: 'anthropic',
          totals: makeTotals({ displayCostUsd: 75 }),
          accounts: [makeAccount()]
        }),
        makeProvider({
          providerId: 'openai',
          label: 'OpenAI',
          totals: makeTotals({ displayCostUsd: 5 }),
          accounts: [makeAccount({ accountKey: 'chatgpt:w:u', providerId: 'openai' })]
        })
      ],
      totals: makeTotals({ displayCostUsd: 100 })
    })
    render(<Summary data={data} compact={false} providerColors={colors(['anthropic', 'openai'])} />)
    const segs = widths(screen.getByTestId('Summary.providerBar'))
    expect(segs).toEqual([
      { id: 'anthropic', pct: 75 },
      { id: 'openai', pct: 5 }
    ])
  })
})

// ---------------------------------------------------------------------------
// The combined scope (S5c)
// ---------------------------------------------------------------------------

describe('Summary — all machines', () => {
  /** $75 Anthropic of which $30 relayed, $25 OpenAI all local. */
  function combined(overrides: Partial<UsageDashboardData> = {}): UsageDashboardData {
    return makeDashboard({
      scope: 'all',
      providers: [
        makeProvider({
          providerId: 'anthropic',
          label: 'Anthropic',
          totals: makeTotals({ displayCostUsd: 75 }),
          accounts: [makeAccount()]
        }),
        makeProvider({
          providerId: 'openai',
          label: 'OpenAI',
          totals: makeTotals({ displayCostUsd: 25 }),
          accounts: [makeAccount({ accountKey: 'chatgpt:w:u', providerId: 'openai' })]
        })
      ],
      totals: makeTotals({ displayCostUsd: 100 }),
      localUsd: 70,
      remoteUsd: 30,
      machines: [
        makeMachine({ deviceId: 'dev-self', self: true }),
        makeMachine({
          deviceId: 'dev-peer',
          self: false,
          totals: makeTotals({ displayCostUsd: 30 })
        })
      ],
      days: [
        {
          date: '2026-09-21',
          byProvider: {
            anthropic: { apiCostUsd: 75, billedCostUsd: 0, displayCostUsd: 75 },
            openai: { apiCostUsd: 25, billedCostUsd: 0, displayCostUsd: 25 }
          },
          byProviderRemote: {
            anthropic: { apiCostUsd: 30, billedCostUsd: 0, displayCostUsd: 30 }
          },
          totals: makeTotals({ displayCostUsd: 100 })
        }
      ],
      ...overrides
    })
  }

  it('names the scope and splits the hero into this machine and what was relayed', () => {
    render(
      <Summary data={combined()} compact={false} providerColors={colors(['anthropic', 'openai'])} />
    )

    expect(screen.getByTestId('Summary')).toHaveTextContent('all machines')
    const line = screen.getByTestId('Summary.machinesLine')
    expect(line).toHaveTextContent('$70.00 on this machine')
    expect(line).toHaveTextContent('$30.00 relayed from 1 machine')
    // The hero itself is untouched: the scope widens what it means, not the rule.
    expect(screen.getByTestId('Summary.hero')).toHaveTextContent('$100.00')
  })

  it('distinguishes the machines that spent from the machines there are', () => {
    // Two peers the hub knows about, one of them idle, plus a retired one that
    // is not counted at all: `2 of 3` would be wrong, `1 of 2` is right (M3).
    const data = combined({
      machines: [
        makeMachine({ deviceId: 'dev-self', self: true }),
        makeMachine({
          deviceId: 'dev-peer',
          self: false,
          totals: makeTotals({ displayCostUsd: 30 })
        }),
        makeMachine({ deviceId: 'dev-idle', self: false, totals: makeTotals() }),
        makeMachine({ deviceId: 'dev-old', self: false, retired: true, totals: makeTotals() })
      ]
    })
    render(<Summary data={data} compact={false} providerColors={colors(['anthropic', 'openai'])} />)
    expect(screen.getByTestId('Summary.machinesLine')).toHaveTextContent(
      '$30.00 from 1 of 2 other machines'
    )
  })

  it('says `relayed from N machines` when every other machine spent something', () => {
    render(
      <Summary data={combined()} compact={false} providerColors={colors(['anthropic', 'openai'])} />
    )
    expect(screen.getByTestId('Summary.machinesLine')).toHaveTextContent(
      '$30.00 relayed from 1 machine'
    )
  })

  it('says so when nothing has been relayed yet, rather than claiming $0.00 from 0 machines', () => {
    const data = combined({
      localUsd: 100,
      remoteUsd: 0,
      days: [makeDay('2026-09-21', { anthropic: 75, openai: 25 })]
    })
    render(<Summary data={data} compact={false} providerColors={colors(['anthropic', 'openai'])} />)
    expect(screen.getByTestId('Summary.machinesLine')).toHaveTextContent(
      'nothing relayed yet from the other machines'
    )
  })

  it('hatches each provider’s remote share inside its own segment, never beside it', () => {
    render(
      <Summary data={combined()} compact={false} providerColors={colors(['anthropic', 'openai'])} />
    )

    const bar = screen.getByTestId('Summary.providerBar')
    const hatched = bar.querySelectorAll('[data-testid="Summary.providerBar.remote"]')
    // Only the provider that HAS a remote share.
    expect([...hatched].map((el) => el.getAttribute('data-provider-id'))).toEqual(['anthropic'])
    // 30 of Anthropic's 75 — a share of the segment, so the segment is still 75%
    // of the bar and the bar still totals the hero.
    expect((hatched[0] as HTMLElement).style.width).toBe('40%')
    expect((hatched[0] as HTMLElement).style.backgroundImage).toContain('repeating-linear-gradient')
    expect(hatched[0].getAttribute('title')).toBe('Anthropic · other machines $30.00')
  })

  it('adds a legend entry only for a provider with a remote share', () => {
    render(
      <Summary data={combined()} compact={false} providerColors={colors(['anthropic', 'openai'])} />
    )
    const entries = screen.getAllByTestId('Summary.legend.remote')
    expect(entries.map((e) => e.getAttribute('data-provider-id'))).toEqual(['anthropic'])
    expect(entries[0]).toHaveTextContent('other machines')
    expect(entries[0]).toHaveTextContent('$30.00')
  })

  it('changes nothing under local: no machines line, no hatch, no legend entry', () => {
    const data = makeDashboard({
      providers: [
        makeProvider({
          providerId: 'anthropic',
          totals: makeTotals({ displayCostUsd: 75 }),
          accounts: [makeAccount()]
        })
      ],
      totals: makeTotals({ displayCostUsd: 75 })
    })
    render(<Summary data={data} compact={false} providerColors={colors(['anthropic'])} />)

    expect(screen.queryByTestId('Summary.machinesLine')).not.toBeInTheDocument()
    expect(screen.queryByTestId('Summary.providerBar.remote')).not.toBeInTheDocument()
    expect(screen.queryByTestId('Summary.legend.remote')).not.toBeInTheDocument()
    expect(screen.getByTestId('Summary')).not.toHaveTextContent('all machines')
  })

  it('carries the machines line into the phone strip too', () => {
    render(
      <Summary data={combined()} compact={true} providerColors={colors(['anthropic', 'openai'])} />
    )
    expect(screen.getByTestId('Summary.strip')).toBeInTheDocument()
    expect(screen.getByTestId('Summary.machinesLine')).toHaveTextContent('$70.00 on this machine')
  })
})
