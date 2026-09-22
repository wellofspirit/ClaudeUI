/**
 * `WindowValue` — what a subscription window delivers (ADR-071 §7/§8, mockup
 * Window value B → A → C).
 *
 * The rules worth guarding are arithmetic, not layout: a window under the 5%
 * floor must never reach an average (it is kept, faint, because hiding it would
 * hide the noise), the comparison's x-scale must be shared inside a kind or two
 * plans are not comparable at all, and an open window must be marked as one
 * because its dollars are not final.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import { WindowValue } from '../WindowValue'
import { buildProviderColorMap } from '../usage-utils'
import {
  makeAccount,
  makeDashboard,
  makeLimits,
  makeMachine,
  makeProvider
} from './dashboard-fixtures'
import { chooseSelectMenuOption, selectMenuValue } from '@test/helpers/select-menu'
import type { AccountLimits, UsageWindowSummaryRow } from '../../../../../shared/types'

const COLORS = buildProviderColorMap(['anthropic', 'openai'])
const END = Date.parse('2026-09-18T09:00:00.000Z')
const DAY = 86_400_000

const CLAUDE = 'anthropic:org-1:acct-1'
const CHATGPT = 'chatgpt:w1:u1'

/**
 * One `usage_window` summary row. The two derived fields follow S3b's rule
 * rather than being hand-written per test: null under the floor, otherwise the
 * division, so a fixture cannot accidentally disagree with core.
 */
function makeRow(overrides: Partial<UsageWindowSummaryRow> = {}): UsageWindowSummaryRow {
  const peakPercent = overrides.peakPercent ?? 50
  const apiCostUsd = overrides.apiCostUsd ?? 10
  const priced = peakPercent >= 5
  return {
    accountKey: CLAUDE,
    windowKind: '7d',
    canonicalEnd: END,
    windowStart: END - 7 * DAY,
    windowMinutes: null,
    peakPercent,
    apiCostUsd,
    billedCostUsd: 0,
    unknownCostCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    sampleCount: 4,
    closed: true,
    updatedAt: END,
    usdPerPercent: priced ? apiCostUsd / peakPercent : null,
    impliedFullWindowUsd: priced ? (apiCostUsd / peakPercent) * 100 : null,
    biased: true,
    ...overrides
  }
}

function dashboardWithAccounts(): ReturnType<typeof makeDashboard> {
  return makeDashboard({
    providers: [
      makeProvider({
        providerId: 'anthropic',
        accounts: [makeAccount({ accountKey: CLAUDE, label: 'Claude · personal' })]
      }),
      makeProvider({
        providerId: 'openai',
        label: 'OpenAI',
        accounts: [
          makeAccount({ accountKey: CHATGPT, providerId: 'openai', label: 'ChatGPT · personal' })
        ]
      })
    ]
  })
}

/** The caption under each column of one chart, in column order. */
function captions(chart: HTMLElement): string[] {
  return within(chart)
    .getAllByTestId('WindowValue.perWindow.caption')
    .map((c) => c.textContent ?? '')
}

let mockFetchWindows: ReturnType<typeof vi.fn>

beforeEach(() => {
  mockFetchWindows = vi.fn().mockResolvedValue([])
  // Assign onto the existing window — replacing `window` loses the document ref
  // `waitFor` needs.
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    fetchUsageWindows: mockFetchWindows
  }
})

async function renderWith(
  rows: UsageWindowSummaryRow[] | Promise<UsageWindowSummaryRow[]>,
  limits: AccountLimits[] | null = null
): Promise<void> {
  mockFetchWindows.mockReturnValue(Array.isArray(rows) ? Promise.resolve(rows) : rows)
  render(
    <WindowValue
      data={dashboardWithAccounts()}
      limits={limits}
      providerColors={COLORS}
      range="30d"
    />
  )
  await waitFor(() => expect(mockFetchWindows).toHaveBeenCalled())
}

describe('WindowValue — states', () => {
  it('reads the windows once, from the dashboard range', async () => {
    const data = dashboardWithAccounts()
    mockFetchWindows.mockResolvedValue([])
    render(<WindowValue data={data} limits={null} providerColors={COLORS} range="30d" />)
    await waitFor(() => expect(mockFetchWindows).toHaveBeenCalledTimes(1))
    expect(mockFetchWindows).toHaveBeenCalledWith({ sinceTs: data.fromTs })
  })

  it('scopes its caption to the range, and admits open windows on today', async () => {
    mockFetchWindows.mockResolvedValue([])
    const { unmount } = render(
      <WindowValue
        data={dashboardWithAccounts()}
        limits={null}
        providerColors={COLORS}
        range="30d"
      />
    )
    expect(screen.getByTestId('WindowValue')).toHaveTextContent(
      'windows ending in the last 30 days'
    )
    unmount()

    render(
      <WindowValue
        data={dashboardWithAccounts()}
        limits={null}
        providerColors={COLORS}
        range="today"
      />
    )
    expect(screen.getByTestId('WindowValue')).toHaveTextContent(
      'windows ending today or still open'
    )
  })

  it('shows the loading state until the read lands', async () => {
    await renderWith(new Promise<UsageWindowSummaryRow[]>(() => {}))
    expect(screen.getByTestId('WindowValue.loading')).toBeInTheDocument()
    expect(screen.queryByTestId('WindowValue.footnote')).not.toBeInTheDocument()
  })

  it('shows the error state when the read rejects', async () => {
    mockFetchWindows.mockRejectedValue(new Error('database is locked'))
    render(
      <WindowValue
        data={dashboardWithAccounts()}
        limits={null}
        providerColors={COLORS}
        range="30d"
      />
    )
    expect(await screen.findByTestId('WindowValue.error')).toHaveTextContent('database is locked')
  })

  it('shows the empty state when no window exists yet', async () => {
    await renderWith([])
    expect(await screen.findByTestId('WindowValue.empty')).toHaveTextContent('No closed window yet')
    expect(screen.queryByTestId('WindowValue.compare')).not.toBeInTheDocument()
  })

  it('states the bias exactly once', async () => {
    await renderWith([makeRow()])
    await screen.findByTestId('WindowValue.compare')
    const notes = screen.getAllByTestId('WindowValue.footnote')
    expect(notes).toHaveLength(1)
    expect(notes[0].textContent).toMatch(/reads low/)
  })
})

describe('WindowValue — B, subscriptions compared', () => {
  it('excludes a window under the 5% floor from the average', async () => {
    await renderWith([
      makeRow({ apiCostUsd: 10, canonicalEnd: END }),
      makeRow({ apiCostUsd: 30, canonicalEnd: END - 7 * DAY }),
      // Peak 2%: its $900 would treble the average if it were counted.
      makeRow({ apiCostUsd: 900, peakPercent: 2, canonicalEnd: END - 14 * DAY })
    ])

    const row = await screen.findByTestId('WindowValue.compare.row')
    expect(row).toHaveAttribute('data-account-key', CLAUDE)
    expect(row).toHaveTextContent('2w · avg $20.00')
    expect(row.getAttribute('title')).toContain('$10.00 – $30.00')
  })

  it('leaves out an account whose only windows are open or under the floor', async () => {
    await renderWith([
      makeRow({ apiCostUsd: 10 }),
      makeRow({ accountKey: CHATGPT, apiCostUsd: 40, closed: false }),
      makeRow({ accountKey: CHATGPT, apiCostUsd: 40, peakPercent: 1, canonicalEnd: END - DAY })
    ])
    await screen.findByTestId('WindowValue.compare.row')
    const keys = screen
      .getAllByTestId('WindowValue.compare.row')
      .map((r) => r.getAttribute('data-account-key'))
    expect(keys).toEqual([CLAUDE])
  })

  it('shares one x-scale inside a kind, so two rows are comparable', async () => {
    await renderWith([
      // Peak 100% keeps the implied-value tick equal to the delivered dollars,
      // so the domain is exactly the largest bar.
      makeRow({ apiCostUsd: 10, peakPercent: 100 }),
      makeRow({ apiCostUsd: 20, peakPercent: 100, canonicalEnd: END - 7 * DAY }),
      makeRow({ accountKey: CHATGPT, apiCostUsd: 20, peakPercent: 100 }),
      makeRow({
        accountKey: CHATGPT,
        apiCostUsd: 40,
        peakPercent: 100,
        canonicalEnd: END - 7 * DAY
      })
    ])

    await screen.findByTestId('WindowValue.compare')
    const [first, second] = screen.getAllByTestId('WindowValue.compare.row')
    // Sorted by average delivered: ChatGPT ($30) above Claude ($15).
    expect(first).toHaveAttribute('data-account-key', CHATGPT)
    const width = (row: HTMLElement): number =>
      parseFloat(
        (row.querySelector('[data-testid="WindowValue.compare.row.range"]') as HTMLElement).style
          .width
      )
    // Spans of $20 and $10 on one scale.
    expect(width(first) / width(second)).toBeCloseTo(2, 5)
    // And the ticks sit at the mean implied value, which is the mean delivered here.
    const tick = (row: HTMLElement): number =>
      parseFloat(
        (row.querySelector('[data-testid="WindowValue.compare.row.full"]') as HTMLElement).style
          .left
      )
    expect(tick(first) / tick(second)).toBeCloseTo(2, 5)
  })

  it('groups the rows by kind, 5-hour before weekly', async () => {
    await renderWith([
      makeRow({ windowKind: '7d' }),
      makeRow({ windowKind: '5h', canonicalEnd: END - DAY }),
      makeRow({ windowKind: '7d:fable', canonicalEnd: END - 2 * DAY })
    ])
    await screen.findByTestId('WindowValue.compare')
    expect(
      screen.getAllByTestId('WindowValue.compare.kind').map((k) => k.getAttribute('data-kind'))
    ).toEqual(['5h', '7d', '7d:fable'])
  })

  /**
   * S3c — a ChatGPT plan states each window's length, so a kind can be any
   * duration. Ordering by the two literals dropped `3d` and `1h` into the
   * "anything new" bucket after the scoped weeklies, and labelled them with
   * their raw kind.
   */
  it('orders an arbitrary duration by its length and labels it in words', async () => {
    await renderWith([
      makeRow({ windowKind: '7d' }),
      makeRow({ windowKind: '3d', canonicalEnd: END - DAY }),
      makeRow({ windowKind: '1h', canonicalEnd: END - 2 * DAY }),
      makeRow({ windowKind: '5h', canonicalEnd: END - 3 * DAY })
    ])
    await screen.findByTestId('WindowValue.compare')
    const kinds = screen.getAllByTestId('WindowValue.compare.kind')
    expect(kinds.map((k) => k.getAttribute('data-kind'))).toEqual(['1h', '5h', '3d', '7d'])
    expect(kinds[0]).toHaveTextContent('1-hour')
    expect(kinds[2]).toHaveTextContent('3-day')
  })

  it('names the account from the credentials when the ledger has no row for it', async () => {
    await renderWith(
      [makeRow({ accountKey: 'anthropic:org-9:acct-9' })],
      [makeLimits({ accountKey: 'anthropic:org-9:acct-9', label: 'Claude · work' })]
    )
    expect(await screen.findByTestId('WindowValue.compare.row')).toHaveTextContent('Claude · work')
  })
})

describe('WindowValue — A, per window', () => {
  it('defaults to the account with the most closed windows and charts them oldest first', async () => {
    await renderWith([
      makeRow({ accountKey: CHATGPT, canonicalEnd: END }),
      makeRow({ canonicalEnd: END }),
      makeRow({ canonicalEnd: END - 7 * DAY }),
      makeRow({ canonicalEnd: END - 14 * DAY })
    ])

    await screen.findByTestId('WindowValue.perWindow')
    expect(selectMenuValue(screen.getByTestId('WindowValue.perWindow.account'))).toBe(CLAUDE)
    expect(
      screen.getAllByTestId('WindowValue.perWindow.column').map((c) => c.getAttribute('data-end'))
    ).toEqual([String(END - 14 * DAY), String(END - 7 * DAY), String(END)])
  })

  it('charts the account the selector names', async () => {
    await renderWith([
      makeRow({ canonicalEnd: END }),
      makeRow({ canonicalEnd: END - 7 * DAY }),
      makeRow({ accountKey: CHATGPT, canonicalEnd: END - 21 * DAY })
    ])
    await screen.findByTestId('WindowValue.perWindow')

    chooseSelectMenuOption(screen.getByTestId('WindowValue.perWindow.account'), CHATGPT)

    expect(
      screen.getAllByTestId('WindowValue.perWindow.column').map((c) => c.getAttribute('data-end'))
    ).toEqual([String(END - 21 * DAY)])
  })

  it('draws one chart per kind of window the account has', async () => {
    await renderWith([makeRow({ windowKind: '5h' }), makeRow({ windowKind: '7d' })])
    await screen.findByTestId('WindowValue.perWindow')
    expect(
      screen.getAllByTestId('WindowValue.perWindow.chart').map((c) => c.getAttribute('data-kind'))
    ).toEqual(['5h', '7d'])
  })

  it('marks the open window and keeps it out of the implied-value figure', async () => {
    await renderWith([
      makeRow({ apiCostUsd: 10, peakPercent: 100, canonicalEnd: END - 7 * DAY }),
      makeRow({ apiCostUsd: 3, peakPercent: 30, canonicalEnd: END, closed: false })
    ])

    await screen.findByTestId('WindowValue.perWindow')
    const columns = screen.getAllByTestId('WindowValue.perWindow.column')
    expect(columns.map((c) => c.getAttribute('data-open'))).toEqual(['false', 'true'])
    expect(columns[1].getAttribute('title')).toContain('Still open')
    // The closed window implies $10 at 100%; the open one is not averaged in.
    const chart = screen.getByTestId('WindowValue.perWindow.chart')
    expect(chart).toHaveTextContent('implied full window ≈ $10.00')
    // The caption belongs to the reserved row under the plot, never drawn over a
    // column: one caption cell per column, and only the open one is captioned.
    expect(captions(chart)).toEqual(['', 'open'])
    expect(chart).toHaveTextContent('latest · 1 open')
  })

  it('reserves the caption row even when nothing is open', async () => {
    await renderWith([makeRow({ canonicalEnd: END - 7 * DAY }), makeRow({ canonicalEnd: END })])
    await screen.findByTestId('WindowValue.perWindow')
    const chart = screen.getByTestId('WindowValue.perWindow.chart')
    expect(captions(chart)).toEqual(['', ''])
    expect(chart).not.toHaveTextContent('open')
  })

  it('draws a window under the floor faint and says why', async () => {
    await renderWith([
      makeRow({ apiCostUsd: 10, canonicalEnd: END - 7 * DAY }),
      makeRow({ apiCostUsd: 1, peakPercent: 2, canonicalEnd: END })
    ])
    await screen.findByTestId('WindowValue.perWindow')
    const columns = screen.getAllByTestId('WindowValue.perWindow.column')
    expect(columns.map((c) => c.getAttribute('data-faint'))).toEqual(['false', 'true'])
    expect(columns[1].getAttribute('title')).toContain('Under the 5% floor')
  })

  it('counts the unpriced turns on the window they are missing from (ADR-030)', async () => {
    await renderWith([makeRow({ apiCostUsd: 10, unknownCostCount: 3 })])
    await screen.findByTestId('WindowValue.perWindow')
    const column = screen.getByTestId('WindowValue.perWindow.column')
    expect(column.getAttribute('title')).toContain('+3 unpriced')
    expect(screen.getByTestId('WindowValue.perWindow.chart')).toHaveTextContent('+3')
  })
})

describe('WindowValue — C, peak vs delivered', () => {
  it('plots one dot per closed window, faint under the floor', async () => {
    await renderWith([
      makeRow({ apiCostUsd: 10, peakPercent: 50 }),
      makeRow({ apiCostUsd: 1, peakPercent: 2, canonicalEnd: END - 7 * DAY }),
      makeRow({ apiCostUsd: 5, closed: false, canonicalEnd: END - 14 * DAY })
    ])

    await screen.findByTestId('WindowValue.scatter')
    const dots = screen.getAllByTestId('WindowValue.scatter.dot')
    expect(dots).toHaveLength(2)
    expect(dots.map((d) => d.getAttribute('data-faint'))).toEqual(['false', 'true'])
    expect(dots[0]).toHaveAttribute('data-kind', '7d')
    expect(dots[0].style.left).toBe('50%')
  })

  it('names the account, the kind and the window on hover', async () => {
    await renderWith([makeRow({ apiCostUsd: 10, peakPercent: 40, unknownCostCount: 2 })])
    await screen.findByTestId('WindowValue.scatter')
    const title = screen.getByTestId('WindowValue.scatter.dot').getAttribute('title') ?? ''
    expect(title).toContain('Claude · personal')
    expect(title).toContain('7-day')
    expect(title).toContain('Peak used   40%')
    expect(title).toContain('+2 unpriced')
  })

  it('says so rather than drawing an empty plot when nothing has closed', async () => {
    await renderWith([makeRow({ closed: false })])
    await screen.findByTestId('WindowValue.scatter')
    expect(screen.queryByTestId('WindowValue.scatter.dot')).not.toBeInTheDocument()
    expect(screen.getByTestId('WindowValue.scatter')).toHaveTextContent('No closed window yet')
    // The open window still has a column: A is the section that can show it.
    expect(screen.getByTestId('WindowValue.perWindow.column')).toHaveAttribute('data-open', 'true')
  })
})

// ---------------------------------------------------------------------------
// The combined scope (S5c)
// ---------------------------------------------------------------------------

describe('WindowValue — all machines', () => {
  it('asks the query for the combined windows and says how many machines went in', async () => {
    const data = makeDashboard({
      scope: 'all',
      machines: [
        makeMachine({ deviceId: 'dev-self', self: true }),
        makeMachine({ deviceId: 'dev-peer', self: false }),
        // Retired, and therefore not one of the machines the numerator was
        // summed over — the same count the chip and the summary print (M3).
        makeMachine({ deviceId: 'dev-old', self: false, retired: true })
      ]
    })
    // One row, so the card draws its sections rather than its empty state.
    mockFetchWindows.mockResolvedValue([makeRow()])
    render(<WindowValue data={data} limits={[]} providerColors={COLORS} range="30d" />)

    await waitFor(() =>
      expect(mockFetchWindows).toHaveBeenCalledWith({ sinceTs: data.fromTs, scope: 'all' })
    )
    await waitFor(() =>
      expect(screen.getByTestId('WindowValue.combined')).toHaveTextContent(
        'combined across 2 machines'
      )
    )
    // The bias footnote is unchanged: the hub closes the other-machines half and
    // nothing closes the claude.ai half.
    expect(screen.getByTestId('WindowValue.footnote')).toBeInTheDocument()
  })

  it('asks for nothing but the range under local, and says nothing about machines', async () => {
    const data = makeDashboard()
    render(<WindowValue data={data} limits={[]} providerColors={COLORS} range="30d" />)

    await waitFor(() => expect(mockFetchWindows).toHaveBeenCalledWith({ sinceTs: data.fromTs }))
    expect(screen.queryByTestId('WindowValue.combined')).not.toBeInTheDocument()
  })
})
