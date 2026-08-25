/**
 * Layer 2: Component test for UsagePanel's weekly per-model bars.
 *
 * The server-labeled weekly buckets (`rate_limits.limits[]`, kind
 * "weekly_scoped" — e.g. Fable) arrive as `AccountUsage.sevenDayModels`. Their
 * label is server-supplied, so the panel must render one bar per entry without
 * knowing any model name, and must not double-render a model the legacy
 * seven_day_opus / seven_day_sonnet windows already cover.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import type { AccountUsage } from '../../../../../shared/types'

// UsagePanel reads exactly two slices off the store.
const { store } = vi.hoisted(() => ({
  store: { blockUsage: null as unknown, setActiveView: vi.fn() }
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
