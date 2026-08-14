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
import { render, fireEvent, screen, act, cleanup, waitFor } from '@testing-library/react'
import { useSessionStore } from '../../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { TopBar } from '../TopBar'
import { SidebarContext } from '../../../SessionView'
import type { GitStatusData, StatusLineData } from '../../../../../../shared/types'

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

  it('formats hour-scale durations as "Nh Nm" (seconds dropped as noise)', () => {
    // 1415m 20s of active time reads terribly — the hours tier kicks in at 1h.
    useSessionStore
      .getState()
      .setStatusLine(ROUTE, makeStatusLine({ totalDurationMs: 84_920_000 }))

    const { unmount } = render(<TopBar hasContent />)
    fireEvent.mouseEnter(screen.getByTestId('TopBar.info'))

    expect(screen.getByTestId('TopBar.sessionTime')).toHaveTextContent('23h 35m')
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

// ---------------------------------------------------------------------------
// The mobile-web fullscreen control is GONE from TopBar — it moved to a
// double-tap gesture on the chat scroll area (see
// hooks/__tests__/useFullscreenDoubleTap.unit.test.tsx). This block is the
// regression lock: even with every condition the old gate required satisfied,
// no button may come back. Fullscreen state lives on `document`/`window`, not
// the store, so every mutated global is captured up front and restored in
// afterEach — nothing here may leak into the other describe blocks.
// ---------------------------------------------------------------------------

describe('TopBar — mobile web fullscreen control removed', () => {
  let app: TestApp

  const originalMatchMedia = window.matchMedia
  const originalFullscreenEnabled = (document as unknown as { fullscreenEnabled?: boolean })
    .fullscreenEnabled
  const originalRequestFullscreen = document.documentElement.requestFullscreen
  const originalExitFullscreen = (document as unknown as { exitFullscreen?: () => Promise<void> })
    .exitFullscreen
  const originalFullscreenElement = (document as unknown as { fullscreenElement?: Element | null })
    .fullscreenElement

  function setStandalone(standalone: boolean): void {
    window.matchMedia = ((query: string) => ({
      matches: query === '(display-mode: standalone)' && standalone,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {}
    })) as unknown as typeof window.matchMedia
  }

  function setFullscreenApiSupported(): void {
    ;(document as unknown as { fullscreenEnabled: boolean }).fullscreenEnabled = true
    document.documentElement.requestFullscreen = vi.fn(() => Promise.resolve())
    ;(document as unknown as { exitFullscreen: () => Promise<void> }).exitFullscreen = vi.fn(() =>
      Promise.resolve()
    )
  }

  function renderTopBar(isMobile: boolean) {
    return render(
      <SidebarContext.Provider value={{ collapsed: false, toggle: () => {}, isMobile }}>
        <TopBar hasContent />
      </SidebarContext.Provider>
    )
  }

  beforeEach(async () => {
    app = await bootTestApp()
    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
    useSessionStore.setState({ activeSessionId: ROUTE })
    ;(document as unknown as { fullscreenElement: Element | null }).fullscreenElement = null
    setStandalone(false)
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })

    window.matchMedia = originalMatchMedia
    document.documentElement.requestFullscreen = originalRequestFullscreen

    const doc = document as unknown as {
      fullscreenEnabled?: boolean
      exitFullscreen?: () => Promise<void>
      fullscreenElement?: Element | null
    }
    if (originalFullscreenEnabled === undefined) delete doc.fullscreenEnabled
    else doc.fullscreenEnabled = originalFullscreenEnabled
    if (originalExitFullscreen === undefined) delete doc.exitFullscreen
    else doc.exitFullscreen = originalExitFullscreen
    if (originalFullscreenElement === undefined) delete doc.fullscreenElement
    else doc.fullscreenElement = originalFullscreenElement
  })

  it('never renders TopBar.fullscreen, even with every old gate condition satisfied', () => {
    setFullscreenApiSupported()
    setStandalone(false)
    app.api.platform = 'web'

    const { unmount } = renderTopBar(true)
    expect(screen.queryByTestId('TopBar.fullscreen')).toBeNull()
    unmount()
  })
})

// ---------------------------------------------------------------------------
// Mobile right-side entry points (Option C): the changes pill (the only way
// into MobileGitView from the bar) plus a "⋯" overflow menu holding the
// actions whose desktop buttons don't fit a phone bar. Desktop must gain
// nothing — the overflow button is mobile-only.
// ---------------------------------------------------------------------------

describe('TopBar — mobile entry points', () => {
  let app: TestApp

  // setGitStatus populates a module-level cache keyed by cwd that outlives
  // store resets (createEmptySession re-hydrates isGitRepo/gitStatus from it),
  // so each git-shaped fixture needs a cwd of its own or tests leak into each
  // other in file order.
  const GIT_CWD = '/d/repo-topbar-git'
  const PLAIN_CWD = '/d/repo-topbar-plain'

  function makeGitStatus(overrides: Partial<GitStatusData> = {}): GitStatusData {
    return {
      branch: 'main',
      ahead: 0,
      behind: 0,
      trackingBranch: 'origin/main',
      files: [{ path: 'a.ts', index: ' ', working: 'M' }],
      staged: [],
      unstaged: ['a.ts'],
      untracked: [],
      linesAdded: 3,
      linesRemoved: 1,
      ...overrides
    } as GitStatusData
  }

  function renderTopBar(isMobile: boolean) {
    return render(
      <SidebarContext.Provider value={{ collapsed: true, toggle: () => {}, isMobile }}>
        <TopBar hasContent />
      </SidebarContext.Provider>
    )
  }

  beforeEach(async () => {
    app = await bootTestApp()
    // The permissions dialog loads on open; keep both probes resolvable so the
    // menu → dialog assertion isn't racing a rejected IPC.
    app.bridge.ipcMain.handle('claude:load-permissions' as never, async () => ({
      allow: [],
      deny: [],
      ask: [],
      additionalDirectories: []
    }))
    app.bridge.ipcMain.handle('claude:workspace-trust' as never, async () => true)
    useSessionStore.getState().createNewSession(ROUTE, PLAIN_CWD)
    useSessionStore.setState({ activeSessionId: ROUTE })
  })

  afterEach(() => {
    // Unmount before window.api goes away — TopBar reads window.api.platform
    // during render, and the store reset below would re-render a live tree.
    cleanup()
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
  })

  it('renders GitChangesPill on mobile once the session is a git repo with status', () => {
    useSessionStore.getState().createNewSession('route-topbar-gitrepo', GIT_CWD)
    useSessionStore.setState({ activeSessionId: 'route-topbar-gitrepo' })
    useSessionStore.getState().setIsGitRepo('route-topbar-gitrepo', true)
    useSessionStore.getState().setGitStatus('route-topbar-gitrepo', makeGitStatus())

    renderTopBar(true)
    expect(screen.getByTestId('GitChangesPill')).toBeInTheDocument()
  })

  it('omits GitChangesPill on mobile outside a git repo (the pill self-gates)', () => {
    renderTopBar(true)
    expect(screen.queryByTestId('GitChangesPill')).toBeNull()
  })

  it('renders the ⋯ overflow button on mobile when a cwd is set', () => {
    renderTopBar(true)
    expect(screen.getByTestId('TopBar.overflowMenu')).toBeInTheDocument()
    // Closed until tapped.
    expect(screen.queryByTestId('TopBar.overflowMenuPermissions')).toBeNull()
  })

  it('hides the ⋯ button entirely when there are no items to show (no cwd)', () => {
    useSessionStore.getState().createNewSession('route-topbar-nocwd', '')
    useSessionStore.setState({ activeSessionId: 'route-topbar-nocwd' })

    renderTopBar(true)
    expect(screen.queryByTestId('TopBar.overflowMenu')).toBeNull()
  })

  it('opens the permissions dialog from the overflow menu', async () => {
    renderTopBar(true)

    fireEvent.click(screen.getByTestId('TopBar.overflowMenu'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('TopBar.overflowMenuPermissions'))
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(screen.getByTestId('PermissionsDialog')).toBeInTheDocument()
    // The menu closes behind the dialog.
    expect(screen.queryByTestId('TopBar.overflowMenuPermissions')).toBeNull()
  })

  it('closes the overflow menu on outside pointerdown and on Escape', () => {
    renderTopBar(true)

    fireEvent.click(screen.getByTestId('TopBar.overflowMenu'))
    expect(screen.getByTestId('TopBar.overflowMenuPermissions')).toBeInTheDocument()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByTestId('TopBar.overflowMenuPermissions')).toBeNull()

    fireEvent.click(screen.getByTestId('TopBar.overflowMenu'))
    expect(screen.getByTestId('TopBar.overflowMenuPermissions')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('TopBar.overflowMenuPermissions')).toBeNull()
  })

  it('desktop keeps its own buttons and never grows a ⋯ menu (regression lock)', () => {
    renderTopBar(false)

    expect(screen.queryByTestId('TopBar.overflowMenu')).toBeNull()
    expect(screen.getByTestId('TopBar.permissions')).toBeInTheDocument()
    expect(screen.getByTestId('TopBar.openVSCode')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Terminal toggle button. The Ctrl/Cmd+` keybinding is unreachable in a browser
// (macOS owns Cmd+`, Edge swallows Ctrl+`), so the bar carries the only visible
// entry point. Both it and the keydown handler call the SAME helper
// (components/terminal/toggle-terminal.ts) — this block is that helper's
// behavioral coverage; SessionView's keydown path is not re-tested.
//
// Visibility is gated on the host's own `terminal:availability` answer, but
// ONLY on web: desktop resolves "allowed" synchronously with no IPC at all
// (the remote toggle governs remote access, never the local shell).
// ---------------------------------------------------------------------------

describe('TopBar — terminal toggle button', () => {
  let app: TestApp
  let createTerminal: ReturnType<typeof vi.fn>
  let terminalAvailability: ReturnType<typeof vi.fn>

  const TERM_CWD = '/d/repo-topbar-term'

  function renderTopBar(isMobile: boolean) {
    return render(
      <SidebarContext.Provider value={{ collapsed: false, toggle: () => {}, isMobile }}>
        <TopBar hasContent />
      </SidebarContext.Provider>
    )
  }

  beforeEach(async () => {
    app = await bootTestApp()
    createTerminal = vi.fn(async () => 'term-topbar-1')
    ;(window.api as unknown as { createTerminal: unknown }).createTerminal = createTerminal
    terminalAvailability = vi.fn(async () => ({
      allowed: true,
      granted: true,
      needsStepUp: false,
      stepUp: null
    }))
    ;(window.api as unknown as { terminalAvailability: unknown }).terminalAvailability =
      terminalAvailability
    useSessionStore.getState().createNewSession(ROUTE, TERM_CWD)
    useSessionStore.setState({
      activeSessionId: ROUTE,
      terminalGroups: {},
      terminalPanelOpen: false
    })
  })

  afterEach(() => {
    cleanup()
    app.teardown()
    useSessionStore.setState({
      activeSessionId: null,
      sessions: {},
      terminalGroups: {},
      terminalPanelOpen: false
    })
  })

  it('renders on desktop without ever asking the host about availability', () => {
    renderTopBar(false)
    expect(screen.getByTestId('TopBar.terminal')).toBeInTheDocument()
    expect(terminalAvailability).not.toHaveBeenCalled()
  })

  it('renders on web once the host says the remote terminal is allowed', async () => {
    app.api.platform = 'web'
    renderTopBar(false)

    await waitFor(() => expect(screen.getByTestId('TopBar.terminal')).toBeInTheDocument())
    expect(terminalAvailability).toHaveBeenCalled()
  })

  it('stays hidden on web when the owner has the remote terminal turned off', async () => {
    app.api.platform = 'web'
    terminalAvailability.mockResolvedValue({
      allowed: false,
      granted: false,
      needsStepUp: false,
      stepUp: null
    })
    renderTopBar(false)

    await waitFor(() => expect(terminalAvailability).toHaveBeenCalled())
    // Flush the resolved-promise state update before asserting absence.
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.queryByTestId('TopBar.terminal')).toBeNull()
  })

  it('stays hidden on web while the first availability query is still in flight', async () => {
    app.api.platform = 'web'
    // Never resolves: an affordance that flashes in and back out is worse than
    // one that appears a beat late.
    terminalAvailability.mockReturnValue(new Promise(() => {}))
    renderTopBar(false)

    await act(async () => {
      await Promise.resolve()
    })
    expect(terminalAvailability).toHaveBeenCalled()
    expect(screen.queryByTestId('TopBar.terminal')).toBeNull()
  })

  it('stays hidden on web when the availability query fails outright', async () => {
    app.api.platform = 'web'
    terminalAvailability.mockRejectedValue(new Error('no handler'))
    renderTopBar(false)

    await waitFor(() => expect(terminalAvailability).toHaveBeenCalled())
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.queryByTestId('TopBar.terminal')).toBeNull()
  })

  it('is hidden on mobile (terminal is desktop-web only — ADR-048)', () => {
    renderTopBar(true)
    expect(screen.queryByTestId('TopBar.terminal')).toBeNull()
  })

  it('names the reachable binding per platform in the tooltip', () => {
    // Pinned rather than inherited from process.platform, so the assertion
    // means the same thing on a macOS dev box as it does in CI.
    app.api.platform = 'win32'
    renderTopBar(false)
    expect(screen.getByTestId('TopBar.terminal')).toHaveAttribute('title', 'Terminal (Ctrl+`)')
    cleanup()

    app.api.platform = 'darwin'
    renderTopBar(false)
    expect(screen.getByTestId('TopBar.terminal')).toHaveAttribute('title', 'Terminal (⌥`)')
  })

  it('opens the panel and auto-creates the first tab for the active cwd', async () => {
    renderTopBar(false)

    await act(async () => {
      fireEvent.click(screen.getByTestId('TopBar.terminal'))
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(useSessionStore.getState().terminalPanelOpen).toBe(true)
    expect(createTerminal).toHaveBeenCalledWith(TERM_CWD)
    const group = useSessionStore.getState().terminalGroups[TERM_CWD]
    expect(group?.tabs).toHaveLength(1)
    expect(group?.tabs[0]).toMatchObject({ id: 'term-topbar-1', title: 'Terminal', cwd: TERM_CWD })
  })

  it('closes on a second click without spawning another terminal', async () => {
    renderTopBar(false)

    await act(async () => {
      fireEvent.click(screen.getByTestId('TopBar.terminal'))
      await new Promise((r) => setTimeout(r, 0))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('TopBar.terminal'))
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(useSessionStore.getState().terminalPanelOpen).toBe(false)
    expect(createTerminal).toHaveBeenCalledTimes(1)
  })

  it('with no active session cwd: opens the panel but spawns NOTHING (no orphan PTY)', async () => {
    // Pre-fix, the '.'-fallback spawned a real shell into group '.', which no
    // view ever shows (selectVisibleTerminalTabs bails on an empty cwd) — an
    // invisible orphan the visible button would have made easy to hit from the
    // welcome screen. The panel's own empty state is the affordance instead.
    useSessionStore.setState({ activeSessionId: null })

    renderTopBar(false)
    await act(async () => {
      fireEvent.click(screen.getByTestId('TopBar.terminal'))
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(useSessionStore.getState().terminalPanelOpen).toBe(true)
    expect(createTerminal).not.toHaveBeenCalled()
    expect(useSessionStore.getState().terminalGroups['.']).toBeUndefined()
  })

  it('reuses an existing tab group for the cwd instead of spawning a duplicate', async () => {
    useSessionStore.getState().addTerminalTab({ id: 'term-existing', title: 'A', cwd: TERM_CWD })

    renderTopBar(false)
    await act(async () => {
      fireEvent.click(screen.getByTestId('TopBar.terminal'))
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(useSessionStore.getState().terminalPanelOpen).toBe(true)
    expect(createTerminal).not.toHaveBeenCalled()
    expect(useSessionStore.getState().terminalGroups[TERM_CWD]?.tabs).toHaveLength(1)
  })
})
