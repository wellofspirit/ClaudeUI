/**
 * Layer 1 unit tests for the new engine-split UsageView (Phase 9b).
 *
 * Covers:
 * - Claude tab group renders (4 tabs present)
 * - Default tab is "Current Block"
 * - Clicking each tab shows/hides its panel
 * - opencode section renders per-model rows when perEngine has an opencode entry
 * - opencode section is absent when there's no opencode entry in perEngine
 * - Refresh button calls window.api.refreshPrices
 * - Loading state renders when blockUsage is null
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { UsageView } from '../UsageView'
import { useSessionStore } from '../../../stores/session-store'
import type { BlockUsageData, TokenCounts } from '../../../../../shared/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function zeroTokens(): TokenCounts {
  return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }
}

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
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let mockRefreshPrices: ReturnType<typeof vi.fn>

beforeEach(() => {
  mockRefreshPrices = vi.fn().mockResolvedValue({ count: 3, refreshedAt: Date.now() })

  // Assign api directly on the existing window object — do NOT replace window
  // itself, as that breaks waitFor's container check (it loses the document ref).
  ;(window as any).api = {
    setUsageAccountFilter: vi.fn().mockResolvedValue(undefined),
    refreshPrices: mockRefreshPrices
  }

  useSessionStore.setState({
    blockUsage: null,
    accountUsage: null
  } as any)
})

// ---------------------------------------------------------------------------
// Loading state
// ---------------------------------------------------------------------------

describe('UsageView — loading state', () => {
  it('renders loading message when blockUsage is null', () => {
    useSessionStore.setState({ blockUsage: null } as any)
    render(<UsageView onClose={vi.fn()} />)
    expect(screen.getByText('Loading usage data…')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Claude tab group
// ---------------------------------------------------------------------------

describe('UsageView — Claude tab group', () => {
  beforeEach(() => {
    useSessionStore.setState({
      blockUsage: makeBlockUsage(),
      accountUsage: null
    } as any)
  })

  it('renders all four tab buttons', () => {
    render(<UsageView onClose={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Current Block' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Block Timeline' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '5hr Window' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Recent Blocks' })).toBeInTheDocument()
  })

  it('shows "Current Block" panel by default (no active block empty state)', () => {
    render(<UsageView onClose={vi.fn()} />)
    expect(
      screen.getByText('No active block — start using Claude to begin tracking')
    ).toBeInTheDocument()
  })

  it('shows "Not enough data yet" when Block Timeline tab is clicked and no snapshots', () => {
    render(<UsageView onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Block Timeline' }))
    expect(screen.getByText('Not enough data yet')).toBeInTheDocument()
  })

  it('shows "No window data" when 5hr Window tab is clicked and no accountUsage', () => {
    render(<UsageView onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '5hr Window' }))
    expect(screen.getByText('No window data')).toBeInTheDocument()
  })

  it('shows "No recent blocks" when Recent Blocks tab is clicked and recentBlocks is empty', () => {
    render(<UsageView onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Recent Blocks' }))
    expect(screen.getByText('No recent blocks')).toBeInTheDocument()
  })

  it('clicking back to Current Block restores that panel', () => {
    render(<UsageView onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Block Timeline' }))
    fireEvent.click(screen.getByRole('button', { name: 'Current Block' }))
    expect(
      screen.getByText('No active block — start using Claude to begin tracking')
    ).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Claude section — with an active block
// ---------------------------------------------------------------------------

describe('UsageView — Current Block tab with active block', () => {
  it('renders active badge and model table when block has models', () => {
    const now = Date.now()
    useSessionStore.setState({
      blockUsage: makeBlockUsage({
        currentBlock: {
          id: 'block-1',
          startTime: now - 3_600_000,
          endTime: now + 3_600_000,
          actualEndTime: now + 3_600_000,
          tokens: { inputTokens: 10_000, outputTokens: 5_000, cacheCreationTokens: 0, cacheReadTokens: 0 },
          costUsd: 0.05,
          requestCount: 2,
          isActive: true,
          models: [
            {
              model: 'claude-opus-4-6-20250514',
              tokens: { inputTokens: 10_000, outputTokens: 5_000, cacheCreationTokens: 0, cacheReadTokens: 0 },
              costUsd: 0.05,
              requestCount: 2
            }
          ],
          burnRate: null,
          projectedUsage: null,
          finalApiPercent: null
        }
      }),
      accountUsage: null
    } as any)

    render(<UsageView onClose={vi.fn()} />)
    expect(screen.getByText('active')).toBeInTheDocument()
    // Model should be in the table
    expect(screen.getByText('Opus 4.6')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// opencode section
// ---------------------------------------------------------------------------

describe('UsageView — opencode section absent', () => {
  it('does not render opencode section when perEngine is undefined', () => {
    useSessionStore.setState({
      blockUsage: makeBlockUsage({ perEngine: undefined }),
      accountUsage: null
    } as any)
    render(<UsageView onClose={vi.fn()} />)
    expect(screen.queryByText('opencode')).not.toBeInTheDocument()
  })

  it('does not render opencode section when perEngine has no opencode entry', () => {
    useSessionStore.setState({
      blockUsage: makeBlockUsage({
        perEngine: [
          {
            engineId: 'claude',
            tokens: zeroTokens(),
            costUsd: 0,
            requestCount: 0,
            models: []
          }
        ]
      }),
      accountUsage: null
    } as any)
    render(<UsageView onClose={vi.fn()} />)
    expect(screen.queryByRole('heading', { name: /opencode/i })).not.toBeInTheDocument()
  })
})

describe('UsageView — opencode section present', () => {
  beforeEach(() => {
    useSessionStore.setState({
      blockUsage: makeBlockUsage({
        perEngine: [
          {
            engineId: 'opencode',
            tokens: { inputTokens: 500_000, outputTokens: 240_000, cacheCreationTokens: 0, cacheReadTokens: 0 },
            costUsd: 0.41,
            requestCount: 23,
            models: [
              {
                model: 'zen/glm-4.6',
                tokens: { inputTokens: 300_000, outputTokens: 140_000, cacheCreationTokens: 0, cacheReadTokens: 0 },
                costUsd: 0.27,
                requestCount: 14
              },
              {
                model: 'grok-code-fast',
                tokens: { inputTokens: 200_000, outputTokens: 100_000, cacheCreationTokens: 0, cacheReadTokens: 0 },
                costUsd: 0.14,
                requestCount: 9
              }
            ]
          }
        ]
      }),
      accountUsage: null
    } as any)
  })

  it('renders the opencode card header and badge', () => {
    render(<UsageView onClose={vi.fn()} />)
    expect(screen.getByText('opencode')).toBeInTheDocument()
    expect(screen.getByText('pay-per-token')).toBeInTheDocument()
  })

  it('renders summary row with token/cost/request counts', () => {
    render(<UsageView onClose={vi.fn()} />)
    // Total tokens = 500K + 240K = 740K → formatTokenCount → "740.0K"
    expect(screen.getByText('740.0K')).toBeInTheDocument()
    expect(screen.getByText('$0.41')).toBeInTheDocument()
    expect(screen.getByText('23')).toBeInTheDocument()
  })

  it('renders per-model rows for each model in entry.models', () => {
    render(<UsageView onClose={vi.fn()} />)
    // shortModelName('zen/glm-4.6') → 'glm-4.6' (falls back to last segment)
    // shortModelName('grok-code-fast') → 'code-fast' (falls back)
    // These exist in the table regardless of exact shortened form
    expect(screen.getByText('zen/glm-4.6').closest('tr') ?? screen.queryByText('glm-4.6')).toBeTruthy()
    // Second model appears somewhere
    const allCells = document.querySelectorAll('td')
    const cellTexts = Array.from(allCells).map((c) => c.textContent ?? '')
    const hasGrok = cellTexts.some((t) => t.includes('grok-code-fast') || t.includes('code-fast'))
    expect(hasGrok).toBe(true)
  })

  it('renders the footnote text', () => {
    render(<UsageView onClose={vi.fn()} />)
    expect(
      screen.getByText(/Cost reported by opencode.*models\.dev pricing/)
    ).toBeInTheDocument()
  })

  it('renders the refresh prices button', () => {
    render(<UsageView onClose={vi.fn()} />)
    expect(screen.getByRole('button', { name: /refresh prices/i })).toBeInTheDocument()
  })

  it('calls window.api.refreshPrices when refresh button is clicked', async () => {
    render(<UsageView onClose={vi.fn()} />)
    const btn = screen.getByRole('button', { name: /refresh prices/i })
    fireEvent.click(btn)
    await waitFor(() => expect(mockRefreshPrices).toHaveBeenCalledOnce())
  })

  it('shows "Refreshing…" while the call is in flight', async () => {
    // Hold the promise open
    let resolve!: (v: { count: number; refreshedAt: number }) => void
    mockRefreshPrices.mockReturnValue(
      new Promise((r) => {
        resolve = r
      })
    )
    render(<UsageView onClose={vi.fn()} />)
    const btn = screen.getByRole('button', { name: /refresh prices/i })
    fireEvent.click(btn)
    await waitFor(() => expect(screen.getByText('Refreshing…')).toBeInTheDocument())
    // Resolve to let cleanup finish
    resolve({ count: 1, refreshedAt: Date.now() })
  })

  it('disables the button while refreshing', async () => {
    let resolve!: (v: { count: number; refreshedAt: number }) => void
    mockRefreshPrices.mockReturnValue(
      new Promise((r) => {
        resolve = r
      })
    )
    render(<UsageView onClose={vi.fn()} />)
    const btn = screen.getByRole('button', { name: /refresh prices/i })
    fireEvent.click(btn)
    await waitFor(() => expect(btn).toBeDisabled())
    resolve({ count: 1, refreshedAt: Date.now() })
  })

  it('shows success note after refresh completes', async () => {
    render(<UsageView onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /refresh prices/i }))
    await waitFor(() => expect(screen.getByText('Updated 3 model prices')).toBeInTheDocument())
  })

  it('shows "Refresh failed" note when refreshPrices throws', async () => {
    mockRefreshPrices.mockRejectedValue(new Error('server down'))
    render(<UsageView onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /refresh prices/i }))
    await waitFor(() => expect(screen.getByText('Refresh failed')).toBeInTheDocument())
  })
})

// ---------------------------------------------------------------------------
// Daily Usage section always renders
// ---------------------------------------------------------------------------

describe('UsageView — Daily Usage section', () => {
  it('renders Daily Usage section', () => {
    useSessionStore.setState({
      blockUsage: makeBlockUsage({ dailyHistory: [] }),
      accountUsage: null
    } as any)
    render(<UsageView onClose={vi.fn()} />)
    expect(screen.getByText('Daily Usage')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// "By Engine" table is gone
// ---------------------------------------------------------------------------

describe('UsageView — removed "By Engine" section', () => {
  it('does not render a "By Engine" heading', () => {
    useSessionStore.setState({
      blockUsage: makeBlockUsage({
        perEngine: [
          { engineId: 'claude', tokens: zeroTokens(), costUsd: 0, requestCount: 0, models: [] }
        ]
      }),
      accountUsage: null
    } as any)
    render(<UsageView onClose={vi.fn()} />)
    expect(screen.queryByText('By Engine')).not.toBeInTheDocument()
  })
})
