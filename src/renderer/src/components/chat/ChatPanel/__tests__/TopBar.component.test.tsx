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
import type { GitStatusData, SessionStatus, StatusLineData } from '../../../../../../shared/types'
import type { IdeAvailability } from '../../../../../../shared/remote-protocol'
import { resolveClaudeCapabilities } from '../../../../../../shared/model-capabilities'
import { seed, mirrorStoreIntoReplica } from '@test/helpers/replica-seed'

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
    mirrorStoreIntoReplica()
  })

  it('renders Session time and API time from a completed (idle) status line', () => {
    seed.statusLine(ROUTE, makeStatusLine({ totalDurationMs: 65_000, totalApiDurationMs: 40_000 }))

    const { unmount } = render(<TopBar hasContent />)
    fireEvent.mouseEnter(screen.getByTestId('TopBar.info'))

    expect(screen.getByTestId('TopBar.sessionTime')).toHaveTextContent('1m 5s')
    expect(screen.getByTestId('TopBar.apiTime')).toHaveTextContent('40s')
    unmount()
  })

  it('formats hour-scale durations as "Nh Nm" (seconds dropped as noise)', () => {
    // 1415m 20s of active time reads terribly — the hours tier kicks in at 1h.
    seed.statusLine(ROUTE, makeStatusLine({ totalDurationMs: 84_920_000 }))

    const { unmount } = render(<TopBar hasContent />)
    fireEvent.mouseEnter(screen.getByTestId('TopBar.info'))

    expect(screen.getByTestId('TopBar.sessionTime')).toHaveTextContent('23h 35m')
    unmount()
  })

  it('hides API time when totalApiDurationMs is 0 (e.g. opencode, or a reloaded Claude session)', () => {
    seed.statusLine(ROUTE, makeStatusLine({ totalDurationMs: 5_000 }))

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
      seed.statusLine(ROUTE, makeStatusLine({ totalDurationMs: 10_000, turnStartedAtMs }))

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
      seed.statusLine(ROUTE, makeStatusLine({ totalDurationMs: 20_000 }))

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
    mirrorStoreIntoReplica()
  })

  it('hides the breakdown for a single-model session', () => {
    seed.statusLine(
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
    seed.statusLine(
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
    seed.statusLine(
      ROUTE,
      makeStatusLine({
        totalCostUsd: 0.02,
        modelCosts: [{ engineId: 'opencode', modelId: 'gpt-5.4', costUsd: 0.02, dispatched: true }]
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
    mirrorStoreIntoReplica()
  })

  it('marks a dispatched row with data-dispatched + a "· dispatched" suffix, own-engine rows unmarked', () => {
    seed.statusLine(
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
    seed.statusLine(
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
    seed.statusLine(
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
    seed.statusLine(
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
    mirrorStoreIntoReplica()

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

  /**
   * The bar takes `isMobile` from SidebarContext, but the dialogs it opens fork
   * on `useIsMobile()` — a viewport read. A menu test that only sets the context
   * would open the DESKTOP dialog and quietly assert the wrong end of the flow,
   * so tests that follow the tap into a dialog set the viewport too.
   */
  const originalMatchMedia = window.matchMedia
  const originalInnerWidth = window.innerWidth

  function setViewportIsMobile(isMobile: boolean): void {
    // useIsMobile seeds from innerWidth and only then subscribes to the media
    // query, so BOTH have to say the same thing.
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: isMobile ? 390 : 1280
    })
    window.matchMedia = ((query: string) => ({
      matches: isMobile && query.includes('max-width: 768px'),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false
    })) as unknown as typeof window.matchMedia
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
    // Same for the Skills / MCP dialogs the menu can now open.
    app.bridge.ipcMain.handle('config:load-skill-details' as never, async () => [])
    app.bridge.ipcMain.handle('mcp:load-servers' as never, async () => ({}))
    app.bridge.ipcMain.handle('mcp:read-disabled' as never, async () => [])
    app.bridge.ipcMain.handle('mcp:status' as never, async () => null)
    useSessionStore.getState().createNewSession(ROUTE, PLAIN_CWD)
    useSessionStore.setState({ activeSessionId: ROUTE })
  })

  afterEach(() => {
    // Unmount before window.api goes away — TopBar reads window.api.platform
    // during render, and the store reset below would re-render a live tree.
    cleanup()
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
    mirrorStoreIntoReplica()
    window.matchMedia = originalMatchMedia
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: originalInnerWidth
    })
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

  // ── Skills / MCP entries (M2) ─────────────────────────────────────────────
  // Each menu row carries EXACTLY the gate its desktop button uses. The gates
  // live on the session status, so they are driven here through a real status
  // event rather than by poking the store.

  function seedStatus(overrides: Partial<SessionStatus>): void {
    seed.status(ROUTE, {
      state: 'idle',
      // Null: a non-null sessionId that differs from the routing id would be
      // read as a rekey and move the session out from under the test.
      sessionId: null,
      model: null,
      cwd: PLAIN_CWD,
      totalCostUsd: 0,
      engineId: 'claude',
      capabilities: resolveClaudeCapabilities('default'),
      account: null,
      ...overrides
    })
  }

  it('offers Skills and MCP alongside Permissions when the session supports them', () => {
    renderTopBar(true)
    fireEvent.click(screen.getByTestId('TopBar.overflowMenu'))

    expect(screen.getByTestId('TopBar.overflowMenuSkills')).toBeInTheDocument()
    expect(screen.getByTestId('TopBar.overflowMenuMcp')).toBeInTheDocument()
    expect(screen.getByTestId('TopBar.overflowMenuPermissions')).toBeInTheDocument()
  })

  it('drops Skills when the engine has no skills capability', () => {
    seedStatus({
      capabilities: { ...resolveClaudeCapabilities('default'), skills: false }
    })

    renderTopBar(true)
    fireEvent.click(screen.getByTestId('TopBar.overflowMenu'))

    expect(screen.queryByTestId('TopBar.overflowMenuSkills')).toBeNull()
    expect(screen.getByTestId('TopBar.overflowMenuMcp')).toBeInTheDocument()
  })

  it('drops MCP when the model cannot use MCP', () => {
    seedStatus({
      capabilities: { ...resolveClaudeCapabilities('default'), canUseMcp: false }
    })

    renderTopBar(true)
    fireEvent.click(screen.getByTestId('TopBar.overflowMenu'))

    expect(screen.queryByTestId('TopBar.overflowMenuMcp')).toBeNull()
    expect(screen.getByTestId('TopBar.overflowMenuSkills')).toBeInTheDocument()
  })

  it('drops MCP for a non-Claude engine even with canUseMcp true (.mcp.json is Claude-only config)', () => {
    seedStatus({
      engineId: 'opencode',
      capabilities: { ...resolveClaudeCapabilities('default'), canUseMcp: true, skills: true }
    })

    renderTopBar(true)
    fireEvent.click(screen.getByTestId('TopBar.overflowMenu'))

    expect(screen.queryByTestId('TopBar.overflowMenuMcp')).toBeNull()
    // Skills is engine-neutral — opencode keeps it.
    expect(screen.getByTestId('TopBar.overflowMenuSkills')).toBeInTheDocument()
  })

  it('opens the SKILLS mobile fork from the overflow menu', async () => {
    setViewportIsMobile(true)
    renderTopBar(true)

    fireEvent.click(screen.getByTestId('TopBar.overflowMenu'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('TopBar.overflowMenuSkills'))
      await new Promise((r) => setTimeout(r, 0))
    })

    // End to end: a phone tap lands on the phone surface, not the 900px dialog.
    expect(screen.getByTestId('SkillsMobileView')).toBeInTheDocument()
    expect(screen.queryByTestId('SkillsDialog')).toBeNull()
    expect(screen.queryByTestId('TopBar.overflowMenuSkills')).toBeNull()
  })

  it('opens the MCP mobile fork from the overflow menu', async () => {
    setViewportIsMobile(true)
    renderTopBar(true)

    fireEvent.click(screen.getByTestId('TopBar.overflowMenu'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('TopBar.overflowMenuMcp'))
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(screen.getByTestId('McpMobileView')).toBeInTheDocument()
    expect(screen.queryByTestId('McpDialog')).toBeNull()
    expect(screen.queryByTestId('TopBar.overflowMenuMcp')).toBeNull()
  })

  it('desktop still reaches Skills and MCP through its own buttons, not a menu', () => {
    renderTopBar(false)

    expect(screen.getByTestId('TopBar.skills')).toBeInTheDocument()
    expect(screen.getByTestId('TopBar.mcp')).toBeInTheDocument()
    expect(screen.queryByTestId('TopBar.overflowMenuSkills')).toBeNull()
    expect(screen.queryByTestId('TopBar.overflowMenuMcp')).toBeNull()
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
    mirrorStoreIntoReplica()
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

  it('is hidden on mobile — the phone reaches the terminal from the ⋯ menu instead', () => {
    renderTopBar(true)
    expect(screen.queryByTestId('TopBar.terminal')).toBeNull()
    expect(screen.getByTestId('TopBar.overflowMenu')).toBeInTheDocument()
  })

  // ── Mobile ⋯ entry (M3) ───────────────────────────────────────────────────
  // The bar has no room for the button on a phone, so the entry moved into the
  // overflow menu — carrying the desktop button's gate verbatim, so the two
  // surfaces can never disagree about whether this client can have a shell.

  it('offers Terminal in the ⋯ menu, first, matching the desktop bar order', () => {
    renderTopBar(true)
    fireEvent.click(screen.getByTestId('TopBar.overflowMenu'))

    expect(screen.getByTestId('TopBar.overflowMenuTerminal')).toBeInTheDocument()
    // Desktop reads VSCode · Terminal · Skills · MCP · Permissions left to right.
    const labels = screen
      .getAllByRole('button')
      .map((b) => b.getAttribute('data-testid'))
      .filter(
        (id): id is string =>
          !!id && id.startsWith('TopBar.overflowMenu') && id !== 'TopBar.overflowMenu'
      )
    expect(labels[0]).toBe('TopBar.overflowMenuTerminal')
  })

  it('drops the ⋯ Terminal entry when the host says the remote terminal is off', async () => {
    app.api.platform = 'web'
    terminalAvailability.mockResolvedValue({
      allowed: false,
      granted: false,
      needsStepUp: false,
      stepUp: null
    })

    renderTopBar(true)
    await waitFor(() => expect(terminalAvailability).toHaveBeenCalled())
    await act(async () => {
      await Promise.resolve()
    })

    fireEvent.click(screen.getByTestId('TopBar.overflowMenu'))
    expect(screen.queryByTestId('TopBar.overflowMenuTerminal')).toBeNull()
    // The rest of the menu is untouched by the terminal's answer.
    expect(screen.getByTestId('TopBar.overflowMenuPermissions')).toBeInTheDocument()
  })

  it('drops the ⋯ Terminal entry while the first availability query is in flight', async () => {
    app.api.platform = 'web'
    // Never resolves: an affordance that flashes in and back out is worse than
    // one that appears a beat late.
    terminalAvailability.mockReturnValue(new Promise(() => {}))

    renderTopBar(true)
    await act(async () => {
      await Promise.resolve()
    })

    fireEvent.click(screen.getByTestId('TopBar.overflowMenu'))
    expect(screen.queryByTestId('TopBar.overflowMenuTerminal')).toBeNull()
  })

  it('opens the terminal from the ⋯ menu through the same helper the button uses', async () => {
    renderTopBar(true)

    fireEvent.click(screen.getByTestId('TopBar.overflowMenu'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('TopBar.overflowMenuTerminal'))
      await new Promise((r) => setTimeout(r, 0))
    })

    // Same store flag, same auto-open of pool slot 0 for the active cwd.
    expect(useSessionStore.getState().terminalPanelOpen).toBe(true)
    expect(createTerminal).toHaveBeenCalledWith(TERM_CWD, 0)
    // The menu closes behind the takeover.
    expect(screen.queryByTestId('TopBar.overflowMenuTerminal')).toBeNull()
  })

  it('desktop never grows a ⋯ Terminal entry (fork guard)', () => {
    renderTopBar(false)
    expect(screen.getByTestId('TopBar.terminal')).toBeInTheDocument()
    expect(screen.queryByTestId('TopBar.overflowMenuTerminal')).toBeNull()
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
    // Slot 0 of this cwd's terminal POOL — which attaches to an existing shell
    // there (another surface's) rather than always spawning a second one.
    expect(createTerminal).toHaveBeenCalledWith(TERM_CWD, 0)
    const group = useSessionStore.getState().terminalGroups[TERM_CWD]
    expect(group?.tabs).toHaveLength(1)
    expect(group?.tabs[0]).toMatchObject({
      id: 'term-topbar-1',
      title: 'Terminal',
      cwd: TERM_CWD,
      poolIndex: 0
    })
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

// ---------------------------------------------------------------------------
// VSCode button — ADR-064. Desktop is the `vscode://` deep link and must stay
// byte-identical (it asks the host NOTHING). Web is an entirely different flow:
// gated on `ide:availability`, it pre-opens a tab SYNCHRONOUSLY (the popup
// blocker rule), mints a one-time entry and navigates the tab into the proxied
// workbench — or explains, in a dialog, why it cannot.
// ---------------------------------------------------------------------------

describe('TopBar — VSCode button (remote IDE, ADR-064)', () => {
  let app: TestApp
  let ideAvailability: ReturnType<typeof vi.fn>
  let ideMintEntry: ReturnType<typeof vi.fn>
  let openInVSCode: ReturnType<typeof vi.fn>
  let fakeTab: {
    location: { href: string }
    close: ReturnType<typeof vi.fn>
    document: { write: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }
  }
  let windowOpen: ReturnType<typeof vi.fn>
  /**
   * The web bundle's step-up gate (`src/web/main.tsx` installs it before React
   * mounts). The IDE flow now drives it DIRECTLY — the ceremony has to finish
   * before a tab exists — so it is a first-class fixture here rather than
   * something the invoke gate hides.
   */
  let stepUpRequest: ReturnType<typeof vi.fn>

  const IDE_CWD = '/d/repo-topbar-ide'
  const originalWindowOpen = window.open
  const stepUpGlobal = window as unknown as {
    __STEP_UP_REQUEST__?: (channel: string) => Promise<boolean>
  }
  /**
   * What the NEXT `ide:availability` call answers. Mutable so a test can change
   * the host's answer between the mount query (which gates the button) and the
   * post-failure re-query (which sources the dialog's detail).
   */
  let answer: IdeAvailability

  function ok(overrides: Partial<IdeAvailability> = {}): IdeAvailability {
    return {
      allowed: true,
      granted: true,
      needsStepUp: false,
      originAllowed: true,
      probe: { ok: true, cliPath: '/opt/vscode/bin/code-tunnel' },
      runtime: 'running',
      ...overrides
    }
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
    answer = ok()
    ideAvailability = vi.fn(async () => answer)
    ideMintEntry = vi.fn(async () => ({ url: '/vscode/enter?it=token' }))
    openInVSCode = vi.fn(async () => {})
    Object.assign(window.api as unknown as Record<string, unknown>, {
      ideAvailability,
      ideMintEntry,
      openInVSCode
    })
    fakeTab = {
      location: { href: '' },
      close: vi.fn(),
      document: { write: vi.fn(), close: vi.fn() }
    }
    windowOpen = vi.fn(() => fakeTab)
    window.open = windowOpen as unknown as typeof window.open
    stepUpRequest = vi.fn(async () => true)
    stepUpGlobal.__STEP_UP_REQUEST__ = stepUpRequest as unknown as (
      channel: string
    ) => Promise<boolean>
    useSessionStore.getState().createNewSession(ROUTE, IDE_CWD)
    useSessionStore.setState({ activeSessionId: ROUTE })
  })

  afterEach(() => {
    cleanup()
    app.teardown()
    window.open = originalWindowOpen
    delete stepUpGlobal.__STEP_UP_REQUEST__
    // Directly, not through `updateSettings`: this runs after `app.teardown()`
    // has dropped `window.api`, and the reset is store hygiene, not a save.
    useSessionStore.setState((s) => ({ settings: { ...s.settings, theme: 'dark' } }))
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
    mirrorStoreIntoReplica()
  })

  // ── Visibility ────────────────────────────────────────────────────────────

  it('renders on desktop without ever asking the host about availability', () => {
    renderTopBar(false)
    expect(screen.getByTestId('TopBar.openVSCode')).toBeInTheDocument()
    expect(ideAvailability).not.toHaveBeenCalled()
  })

  it('stays hidden on web while the first availability query is still in flight', async () => {
    app.api.platform = 'web'
    ideAvailability.mockReturnValue(new Promise(() => {}))
    renderTopBar(false)

    await act(async () => {
      await Promise.resolve()
    })
    expect(ideAvailability).toHaveBeenCalled()
    expect(screen.queryByTestId('TopBar.openVSCode')).toBeNull()
  })

  it('stays hidden on web when the owner has the remote IDE turned off', async () => {
    app.api.platform = 'web'
    answer = ok({ allowed: false, granted: false })
    renderTopBar(false)

    await waitFor(() => expect(ideAvailability).toHaveBeenCalled())
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.queryByTestId('TopBar.openVSCode')).toBeNull()
  })

  it('stays hidden on web when the availability query fails outright', async () => {
    app.api.platform = 'web'
    ideAvailability.mockRejectedValue(new Error('no handler'))
    renderTopBar(false)

    await waitFor(() => expect(ideAvailability).toHaveBeenCalled())
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.queryByTestId('TopBar.openVSCode')).toBeNull()
  })

  it('renders on web once the host says the remote IDE is allowed', async () => {
    app.api.platform = 'web'
    renderTopBar(false)

    await waitFor(() => expect(screen.getByTestId('TopBar.openVSCode')).toBeInTheDocument())
  })

  it('is hidden on mobile even when the host allows it (no phone entry point)', async () => {
    app.api.platform = 'web'
    renderTopBar(true)
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.queryByTestId('TopBar.openVSCode')).toBeNull()
  })

  // ── The click flow ────────────────────────────────────────────────────────

  it('opens the tab SYNCHRONOUSLY on the click, then navigates it to the minted entry', async () => {
    app.api.platform = 'web'
    let resolveMint: (entry: { url: string }) => void = () => {}
    ideMintEntry.mockReturnValue(
      new Promise<{ url: string }>((resolve) => {
        resolveMint = resolve
      })
    )
    renderTopBar(false)
    await waitFor(() => expect(screen.getByTestId('TopBar.openVSCode')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('TopBar.openVSCode'))

    // THE regression this test exists for: a pop-up blocker kills a
    // `window.open` issued after an await, so the tab must be claimed on the
    // click's own gesture — i.e. BEFORE the mint has resolved.
    expect(windowOpen).toHaveBeenCalledWith('', '_blank')
    expect(ideMintEntry).toHaveBeenCalledWith(IDE_CWD, 'dark')
    expect(fakeTab.location.href).toBe('')
    // The grant is already held, so nothing ceremonial runs on this path at all.
    expect(stepUpRequest).not.toHaveBeenCalled()

    await act(async () => {
      resolveMint({ url: '/vscode/enter?it=token' })
      await Promise.resolve()
    })

    expect(fakeTab.location.href).toBe('/vscode/enter?it=token')
    expect(fakeTab.close).not.toHaveBeenCalled()
    expect(screen.queryByTestId('IdeUnavailableDialog')).toBeNull()
  })

  // ── The client's colour scheme rides the mint (ADR-064 polish) ─────────────

  it.each([
    ['light', 'light'],
    // ClaudeUI's third palette is a DARK scheme; VS Code has two, so the mapping
    // is the client's to make and only the derived answer goes on the wire.
    ['monokai', 'dark'],
    ['dark', 'dark']
  ] as const)('sends themeKind %s → %s with the mint', async (theme, expected) => {
    app.api.platform = 'web'
    useSessionStore.setState((s) => ({ settings: { ...s.settings, theme } }))
    renderTopBar(false)
    await waitFor(() => expect(screen.getByTestId('TopBar.openVSCode')).toBeInTheDocument())

    await act(async () => {
      fireEvent.click(screen.getByTestId('TopBar.openVSCode'))
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(ideMintEntry).toHaveBeenCalledWith(IDE_CWD, expected)
    // The pre-opened placeholder wears the same scheme, so a dark client never
    // sees a white flash while the mint round-trips.
    const written = String(fakeTab.document.write.mock.calls[0]?.[0] ?? '')
    expect(written).toContain(expected === 'light' ? 'background:#ffffff' : 'background:#1e1e1e')
  })

  // ── Ceremony first, tab second (ADR-064 polish) ───────────────────────────

  it('runs the step-up ceremony BEFORE any tab exists, then opens and mints', async () => {
    app.api.platform = 'web'
    answer = ok({ granted: false, needsStepUp: true })
    let grant: (granted: boolean) => void = () => {}
    stepUpRequest.mockReturnValue(
      new Promise<boolean>((resolve) => {
        grant = resolve
      })
    )
    renderTopBar(false)
    await waitFor(() => expect(screen.getByTestId('TopBar.openVSCode')).toBeInTheDocument())

    await act(async () => {
      fireEvent.click(screen.getByTestId('TopBar.openVSCode'))
      await Promise.resolve()
    })

    // THE regression this test exists for: the ceremony renders in THIS tab, so
    // a tab opened first would push the app into the background and leave the
    // operator staring at "Opening VS Code…" with the prompt behind it.
    expect(stepUpRequest).toHaveBeenCalledWith('ide:mint-entry')
    expect(windowOpen).not.toHaveBeenCalled()
    expect(ideMintEntry).not.toHaveBeenCalled()

    // The host's answer after the grant — the flow re-reads it before minting.
    answer = ok()
    await act(async () => {
      grant(true)
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(windowOpen).toHaveBeenCalledWith('', '_blank')
    expect(ideMintEntry).toHaveBeenCalledWith(IDE_CWD, 'dark')
    expect(windowOpen.mock.invocationCallOrder[0]).toBeLessThan(
      ideMintEntry.mock.invocationCallOrder[0]
    )
    expect(fakeTab.location.href).toBe('/vscode/enter?it=token')
    expect(screen.queryByTestId('TopBar.openVSCodeError')).toBeNull()
  })

  it('a refused ceremony leaves nothing behind: no tab, no mint, no copy', async () => {
    app.api.platform = 'web'
    answer = ok({ granted: false, needsStepUp: true })
    stepUpRequest.mockResolvedValue(false)
    renderTopBar(false)
    await waitFor(() => expect(screen.getByTestId('TopBar.openVSCode')).toBeInTheDocument())

    await act(async () => {
      fireEvent.click(screen.getByTestId('TopBar.openVSCode'))
      await new Promise((r) => setTimeout(r, 0))
    })

    // The operator declined. They know what they did; there is nothing to tell
    // them, and a dialog explaining the security model would be noise.
    expect(windowOpen).not.toHaveBeenCalled()
    expect(ideMintEntry).not.toHaveBeenCalled()
    expect(screen.queryByTestId('IdeUnavailableDialog')).toBeNull()
    expect(screen.queryByTestId('TopBar.openVSCodeError')).toBeNull()
  })

  it('tells the operator to click AGAIN when the post-ceremony tab is refused', async () => {
    app.api.platform = 'web'
    answer = ok({ granted: false, needsStepUp: true })
    windowOpen.mockReturnValue(null)
    renderTopBar(false)
    await waitFor(() => expect(screen.getByTestId('TopBar.openVSCode')).toBeInTheDocument())

    await act(async () => {
      fireEvent.click(screen.getByTestId('TopBar.openVSCode'))
      await new Promise((r) => setTimeout(r, 0))
    })

    // Not a pop-up-blocker problem: the ceremony consumed the click's user
    // gesture, the grant is now HELD, and the next click takes the synchronous
    // fast path. Different situation, different words.
    const line = screen.getByTestId('TopBar.openVSCodeError')
    expect(line).toHaveTextContent('VS Code unlocked')
    expect(line).toHaveTextContent('click the button again')
    expect(line).not.toHaveTextContent('Allow pop-ups')
    expect(ideMintEntry).not.toHaveBeenCalled()
    expect(screen.queryByTestId('IdeUnavailableDialog')).toBeNull()
  })

  it('falls back to the old order in a build with no step-up gate installed', async () => {
    // The desktop build has no ceremony at all, and a web build that somehow
    // mounted without the global must still open the IDE — the invoke gate runs
    // the ceremony in that case, exactly as it did before this change.
    app.api.platform = 'web'
    answer = ok({ granted: false, needsStepUp: true })
    delete stepUpGlobal.__STEP_UP_REQUEST__
    renderTopBar(false)
    await waitFor(() => expect(screen.getByTestId('TopBar.openVSCode')).toBeInTheDocument())

    await act(async () => {
      fireEvent.click(screen.getByTestId('TopBar.openVSCode'))
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(windowOpen).toHaveBeenCalledWith('', '_blank')
    expect(ideMintEntry).toHaveBeenCalledWith(IDE_CWD, 'dark')
  })

  it('closes the pre-opened tab and explains a typed refusal in the dialog', async () => {
    app.api.platform = 'web'
    renderTopBar(false)
    await waitFor(() => expect(screen.getByTestId('TopBar.openVSCode')).toBeInTheDocument())

    // The host's answer changes AFTER the mount query: the button was gated on
    // the healthy answer, the mint refuses, and the dialog's detail comes from a
    // fresh query rather than from the (deliberately detail-free) refusal.
    ideMintEntry.mockRejectedValue(new Error('ide-unavailable:cli-not-found'))
    answer = ok({
      probe: { ok: false, reason: 'cli-not-found', detail: 'nothing on PATH or in Program Files' }
    })

    await act(async () => {
      fireEvent.click(screen.getByTestId('TopBar.openVSCode'))
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(fakeTab.close).toHaveBeenCalled()
    expect(screen.getByTestId('IdeUnavailableDialog')).toHaveAttribute(
      'data-reason',
      'cli-not-found'
    )
    expect(screen.getByTestId('IdeUnavailableDialog.reason')).toHaveTextContent(
      'No VS Code CLI was found on the host'
    )
    expect(screen.getByTestId('IdeUnavailableDialog.detail')).toHaveTextContent(
      'nothing on PATH or in Program Files'
    )

    fireEvent.click(screen.getByTestId('IdeUnavailableDialog.close'))
    expect(screen.queryByTestId('IdeUnavailableDialog')).toBeNull()
  })

  it('pre-flights an excluded origin: dialog only, no tab and no mint', async () => {
    app.api.platform = 'web'
    answer = ok({ originAllowed: false, originReason: 'origin-not-allowed' })
    renderTopBar(false)
    await waitFor(() => expect(screen.getByTestId('TopBar.openVSCode')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('TopBar.openVSCode'))

    expect(screen.getByTestId('IdeUnavailableDialog')).toHaveAttribute(
      'data-reason',
      'origin-not-allowed'
    )
    expect(screen.getByTestId('IdeUnavailableDialog.reason')).toHaveTextContent(
      'Tailscale HTTPS address'
    )
    expect(ideMintEntry).not.toHaveBeenCalled()
    expect(windowOpen).not.toHaveBeenCalled()
  })

  it('pre-flights a failed CLI probe the same way, carrying the probe detail', async () => {
    app.api.platform = 'web'
    answer = ok({ probe: { ok: false, reason: 'cli-invalid', detail: 'exit code 9009' } })
    renderTopBar(false)
    await waitFor(() => expect(screen.getByTestId('TopBar.openVSCode')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('TopBar.openVSCode'))

    expect(screen.getByTestId('IdeUnavailableDialog')).toHaveAttribute('data-reason', 'cli-invalid')
    expect(screen.getByTestId('IdeUnavailableDialog.detail')).toHaveTextContent('exit code 9009')
    expect(ideMintEntry).not.toHaveBeenCalled()
    expect(windowOpen).not.toHaveBeenCalled()
  })

  it('a cancelled step-up ceremony closes the tab in silence — no dialog', async () => {
    app.api.platform = 'web'
    renderTopBar(false)
    await waitFor(() => expect(screen.getByTestId('TopBar.openVSCode')).toBeInTheDocument())

    // What the web invoke gate rethrows when the operator dismisses the passkey
    // prompt: the ORIGINAL refusal, which is not an IDE refusal.
    ideMintEntry.mockRejectedValue(new Error('needs-step-up'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await act(async () => {
        fireEvent.click(screen.getByTestId('TopBar.openVSCode'))
        await new Promise((r) => setTimeout(r, 0))
      })

      expect(fakeTab.close).toHaveBeenCalled()
      expect(screen.queryByTestId('IdeUnavailableDialog')).toBeNull()
      expect(screen.queryByTestId('TopBar.openVSCodeError')).toBeNull()
    } finally {
      warn.mockRestore()
    }
  })

  it('surfaces a blocked pop-up inline and never navigates the app tab away', async () => {
    app.api.platform = 'web'
    windowOpen.mockReturnValue(null)
    renderTopBar(false)
    await waitFor(() => expect(screen.getByTestId('TopBar.openVSCode')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('TopBar.openVSCode'))

    const line = screen.getByTestId('TopBar.openVSCodeError')
    expect(line).toHaveTextContent('Allow pop-ups')
    // Distinct from the post-ceremony copy: here the operator has a blocker to
    // fix, and telling them to click again would just fail again.
    expect(line).not.toHaveTextContent('click the button again')
    expect(ideMintEntry).not.toHaveBeenCalled()
    expect(screen.queryByTestId('IdeUnavailableDialog')).toBeNull()
  })

  // ── Desktop stays the deep link ───────────────────────────────────────────

  it('desktop click still hands the cwd to the vscode:// deep link and nothing else', async () => {
    renderTopBar(false)

    await act(async () => {
      fireEvent.click(screen.getByTestId('TopBar.openVSCode'))
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(openInVSCode).toHaveBeenCalledWith(IDE_CWD)
    expect(ideAvailability).not.toHaveBeenCalled()
    expect(ideMintEntry).not.toHaveBeenCalled()
    expect(windowOpen).not.toHaveBeenCalled()
    expect(screen.queryByTestId('IdeUnavailableDialog')).toBeNull()
  })
})
