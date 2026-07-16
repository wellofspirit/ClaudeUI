/**
 * Layer 2: Component test for TopBar's "Session time" / "API time" tooltip
 * rows (Slice A — durable active-turn-processing session time, both engines).
 *
 * Verifies StatusLineData.totalDurationMs + turnStartedAtMs drive the
 * rendered value, including the live 1s tick while a turn is in flight.
 *
 * Uses fake timers ONLY for setInterval/clearInterval (Date stays real) and
 * keeps every test body fully synchronous, explicitly unmounting + restoring
 * real timers before the test returns. This file also matches the broader
 * `unit` project glob (in addition to `component`) like every other
 * `*.component.test.tsx` file in the repo, so it runs twice per `bun run
 * test`; leaving a fake interval pending past the test body, or awaiting a
 * real macrotask mid-test, gives the OTHER duplicate run a window to tear
 * down the shared jsdom `window.api` out from under this one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent, screen, act } from '@testing-library/react'
import { useSessionStore } from '../../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { TopBar } from '../TopBar'
import type { StatusLineData } from '../../../../../../shared/types'

const ROUTE = 'route-topbar'

function makeStatusLine(overrides: Partial<StatusLineData> = {}): StatusLineData {
  return {
    totalCostUsd: 0,
    totalDurationMs: 0,
    totalApiDurationMs: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    contextWindowSize: 0,
    usedPercentage: null,
    remainingPercentage: null,
    turnStartedAtMs: null,
    ...overrides
  }
}

describe('TopBar — Session time / API time', () => {
  let app: TestApp

  beforeEach(async () => {
    app = await bootTestApp()
    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
    useSessionStore.setState({ activeSessionId: ROUTE })
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
  })

  it('renders Session time and API time from a completed (idle) status line', () => {
    useSessionStore
      .getState()
      .setStatusLine(ROUTE, makeStatusLine({ totalDurationMs: 65_000, totalApiDurationMs: 40_000 }))

    const { unmount } = render(<TopBar hasContent />)
    fireEvent.mouseEnter(screen.getByTestId('TopBar.info'))

    expect(screen.getByTestId('TopBar.sessionTime')).toHaveTextContent('1m 5s')
    expect(screen.getByTestId('TopBar.apiTime')).toHaveTextContent('40s')
    unmount()
  })

  it('hides API time when totalApiDurationMs is 0 (e.g. opencode, or a reloaded Claude session)', () => {
    useSessionStore.getState().setStatusLine(ROUTE, makeStatusLine({ totalDurationMs: 5_000 }))

    const { unmount } = render(<TopBar hasContent />)
    fireEvent.mouseEnter(screen.getByTestId('TopBar.info'))

    expect(screen.getByTestId('TopBar.sessionTime')).toHaveTextContent('5s')
    expect(screen.queryByTestId('TopBar.apiTime')).toBeNull()
    unmount()
  })

  it('ticks Session time live once per second while a turn is in flight', () => {
    // Fakes Date + timers together so turnStartedAtMs (captured via
    // Date.now() below) and the interval's later Date.now() reads share the
    // same virtual clock — advanceTimersByTime() then actually moves "now".
    vi.useFakeTimers()
    try {
      const turnStartedAtMs = Date.now()
      useSessionStore
        .getState()
        .setStatusLine(ROUTE, makeStatusLine({ totalDurationMs: 10_000, turnStartedAtMs }))

      const { unmount } = render(<TopBar hasContent />)
      fireEvent.mouseEnter(screen.getByTestId('TopBar.info'))
      // 10s of already-completed turns + ~0s elapsed on the in-flight turn so far.
      expect(screen.getByTestId('TopBar.sessionTime')).toHaveTextContent('10s')

      act(() => {
        vi.advanceTimersByTime(3000)
      })
      // 10s completed + ~3s elapsed on the in-flight turn.
      expect(screen.getByTestId('TopBar.sessionTime')).toHaveTextContent('13s')

      // Unmount (clears the interval) while timers are still fake, so no
      // fake-scheduled callback is left to fire unexpectedly once real
      // timers are restored below.
      unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not tick when idle (turnStartedAtMs null) even with the tooltip open', () => {
    vi.useFakeTimers()
    try {
      useSessionStore.getState().setStatusLine(ROUTE, makeStatusLine({ totalDurationMs: 20_000 }))

      const { unmount } = render(<TopBar hasContent />)
      fireEvent.mouseEnter(screen.getByTestId('TopBar.info'))
      expect(screen.getByTestId('TopBar.sessionTime')).toHaveTextContent('20s')

      act(() => {
        vi.advanceTimersByTime(5000)
      })
      expect(screen.getByTestId('TopBar.sessionTime')).toHaveTextContent('20s')

      unmount()
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// Slice B — per-model cost breakdown in the Cost tooltip row.
// ---------------------------------------------------------------------------

describe('TopBar — per-model cost breakdown (Slice B)', () => {
  let app: TestApp

  beforeEach(async () => {
    app = await bootTestApp()
    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
    useSessionStore.setState({ activeSessionId: ROUTE })
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
  })

  it('hides the breakdown for a single-model session', () => {
    useSessionStore.getState().setStatusLine(
      ROUTE,
      makeStatusLine({
        totalCostUsd: 1.23,
        modelCosts: [{ engineId: 'claude', modelId: 'claude-fable-5', costUsd: 1.23 }]
      })
    )

    const { unmount } = render(<TopBar hasContent />)
    fireEvent.mouseEnter(screen.getByTestId('TopBar.info'))

    expect(screen.queryByTestId('TopBar.costBreakdown')).toBeNull()
    unmount()
  })

  it('shows the breakdown sorted by cost desc for a multi-model session', () => {
    useSessionStore.getState().setStatusLine(
      ROUTE,
      makeStatusLine({
        totalCostUsd: 1.68,
        modelCosts: [
          // Deliberately out of order — the smaller cost listed first — to
          // assert the renderer sorts, rather than trusting input order.
          { engineId: 'claude', modelId: 'claude-sonnet-4-6', costUsd: 0.45 },
          { engineId: 'claude', modelId: 'claude-fable-5', costUsd: 1.23 }
        ]
      })
    )

    const { unmount } = render(<TopBar hasContent />)
    fireEvent.mouseEnter(screen.getByTestId('TopBar.info'))

    const container = screen.getByTestId('TopBar.costBreakdown')
    expect(container).toBeInTheDocument()
    const rows = screen.getAllByTestId('TopBar.costBreakdownRow')
    expect(rows).toHaveLength(2)
    // Sorted highest-cost first.
    expect(rows[0]).toHaveAttribute('data-model', 'claude-fable-5')
    expect(rows[0]).toHaveTextContent('Fable 5')
    expect(rows[0]).toHaveTextContent('$1.23')
    expect(rows[1]).toHaveAttribute('data-model', 'claude-sonnet-4-6')
    expect(rows[1]).toHaveTextContent('Sonnet 4.6')
    expect(rows[1]).toHaveTextContent('$0.45')

    unmount()
  })

  it('shows the breakdown for a single dispatched (cross-engine) row even with just one entry', () => {
    useSessionStore.getState().setStatusLine(
      ROUTE,
      makeStatusLine({
        totalCostUsd: 0.02,
        modelCosts: [
          { engineId: 'opencode', modelId: 'gpt-5.4', costUsd: 0.02, dispatched: true }
        ]
      })
    )

    const { unmount } = render(<TopBar hasContent />)
    fireEvent.mouseEnter(screen.getByTestId('TopBar.info'))

    expect(screen.getByTestId('TopBar.costBreakdown')).toBeInTheDocument()
    expect(screen.getAllByTestId('TopBar.costBreakdownRow')).toHaveLength(1)

    unmount()
  })
})

// ---------------------------------------------------------------------------
// Slice C — dispatched-row marker + "Total incl. dispatched" line.
// ---------------------------------------------------------------------------

describe('TopBar — dispatched (cross-engine) rows and total (Slice C)', () => {
  let app: TestApp

  beforeEach(async () => {
    app = await bootTestApp()
    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
    useSessionStore.setState({ activeSessionId: ROUTE })
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
  })

  it('marks a dispatched row with data-dispatched + a "· dispatched" suffix, own-engine rows unmarked', () => {
    useSessionStore.getState().setStatusLine(
      ROUTE,
      makeStatusLine({
        totalCostUsd: 1.0,
        modelCosts: [
          { engineId: 'claude', modelId: 'claude-sonnet-4-6', costUsd: 1.0 },
          { engineId: 'opencode', modelId: 'openai/gpt-5', costUsd: 0.31, dispatched: true }
        ]
      })
    )

    const { unmount } = render(<TopBar hasContent />)
    fireEvent.mouseEnter(screen.getByTestId('TopBar.info'))

    const rows = screen.getAllByTestId('TopBar.costBreakdownRow')
    expect(rows).toHaveLength(2)

    const ownRow = rows.find((r) => r.getAttribute('data-model') === 'claude-sonnet-4-6')!
    expect(ownRow).not.toHaveAttribute('data-dispatched')
    expect(ownRow).not.toHaveTextContent('dispatched')

    const dispatchedRow = rows.find((r) => r.getAttribute('data-model') === 'openai/gpt-5')!
    expect(dispatchedRow).toHaveAttribute('data-dispatched', 'true')
    expect(dispatchedRow).toHaveTextContent('dispatched')
    expect(dispatchedRow).toHaveTextContent('$0.31')

    unmount()
  })

  it('strips the "provider/" prefix for a dispatched opencode-style model id shortModelName cannot shorten', () => {
    useSessionStore.getState().setStatusLine(
      ROUTE,
      makeStatusLine({
        totalCostUsd: 0,
        modelCosts: [
          { engineId: 'opencode', modelId: 'openai/gpt-5-codex', costUsd: 0.05, dispatched: true }
        ]
      })
    )

    const { unmount } = render(<TopBar hasContent />)
    fireEvent.mouseEnter(screen.getByTestId('TopBar.info'))

    const row = screen.getByTestId('TopBar.costBreakdownRow')
    expect(row).toHaveTextContent('gpt-5-codex')
    expect(row).not.toHaveTextContent('openai/gpt-5-codex')

    unmount()
  })

  it('renders "Total incl. dispatched" as headline cost + dispatched sum when a dispatched row exists', () => {
    useSessionStore.getState().setStatusLine(
      ROUTE,
      makeStatusLine({
        totalCostUsd: 1.0,
        modelCosts: [
          { engineId: 'claude', modelId: 'claude-sonnet-4-6', costUsd: 1.0 },
          { engineId: 'opencode', modelId: 'openai/gpt-5', costUsd: 0.31, dispatched: true },
          { engineId: 'claude', modelId: 'claude-haiku-4-5', costUsd: 0.05, dispatched: true }
        ]
      })
    )

    const { unmount } = render(<TopBar hasContent />)
    fireEvent.mouseEnter(screen.getByTestId('TopBar.info'))

    const total = screen.getByTestId('TopBar.costTotalInclDispatched')
    // 1.00 (headline, own-engine only) + 0.31 + 0.05 dispatched = 1.36
    expect(total).toHaveTextContent('Total incl. dispatched')
    expect(total).toHaveTextContent('$1.36')

    unmount()
  })

  it('hides "Total incl. dispatched" when there are no dispatched rows', () => {
    useSessionStore.getState().setStatusLine(
      ROUTE,
      makeStatusLine({
        totalCostUsd: 1.68,
        modelCosts: [
          { engineId: 'claude', modelId: 'claude-sonnet-4-6', costUsd: 0.45 },
          { engineId: 'claude', modelId: 'claude-fable-5', costUsd: 1.23 }
        ]
      })
    )

    const { unmount } = render(<TopBar hasContent />)
    fireEvent.mouseEnter(screen.getByTestId('TopBar.info'))

    expect(screen.queryByTestId('TopBar.costTotalInclDispatched')).toBeNull()

    unmount()
  })
})
