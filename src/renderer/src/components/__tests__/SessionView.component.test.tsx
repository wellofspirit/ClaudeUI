/**
 * Layer 2: Component tests for SessionView's mobile task takeover.
 *
 * On desktop, opening a task shows TaskDetailPanel as a resizable side panel
 * next to ChatPanel (rightPanel === 'task', gated by !isMobile). On mobile
 * there's no room for a side panel, so SessionView instead renders
 * MobileTaskView — a full-screen replacement for ChatPanel in the same
 * content slot, with a back button that drives the same closeTaskPanel
 * store action as the desktop panel's close (X) button.
 *
 * All heavy child components (Sidebar, ChatPanel, GitPanel, ...) are stubbed
 * to keep this test scoped to SessionView's own layout branching — the
 * real MobileTaskView and TaskDetailPanel FC->View wiring is exercised via
 * a stubbed TaskDetailPanel View so we can assert the variant it receives.
 *
 * Tested flows:
 *   1. isMobile + rightPanel='task' → MobileTaskView renders, ChatPanel does not
 *   2. MobileTaskView back button → closeTaskPanel → rightPanel clears, ChatPanel restored
 *   3. isMobile + rightPanel='none' → normal ChatPanel, no MobileTaskView (regression lock)
 *   4. !isMobile + rightPanel='task' → desktop side panel unchanged (regression lock)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, screen, act, cleanup } from '@testing-library/react'
import { useSessionStore } from '../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { seed, mirrorStoreIntoReplica } from '@test/helpers/replica-seed'
import { resolveCodexCapabilities } from '../../../../shared/model-capabilities'

// ---------------------------------------------------------------------------
// Mobile flag — mutated per-test, read lazily by the mocked hook
// ---------------------------------------------------------------------------

let mockIsMobile = false
vi.mock('../../hooks/useIsMobile', () => ({
  useIsMobile: () => mockIsMobile,
  useVisualViewportHeight: () => undefined
}))

// ---------------------------------------------------------------------------
// Stub every heavy child so this test is scoped to SessionView's own layout
// branching (mount would otherwise pull in Sidebar/ChatPanel/GitPanel's full
// IPC-backed trees).
// ---------------------------------------------------------------------------

vi.mock('../Sidebar', () => ({
  Sidebar: () => <div data-testid="Sidebar" />
}))
vi.mock('../chat/ChatPanel', () => ({
  ChatPanel: () => <div data-testid="ChatPanel" />
}))
vi.mock('../git/GitPanel', () => ({
  GitPanel: () => <div data-testid="GitPanel" />
}))
vi.mock('../git/MobileGitView', () => ({
  MobileGitView: () => <div data-testid="MobileGitView" />
}))
vi.mock('../plan/PlanReviewPanel', () => ({
  PlanReviewPanel: () => <div data-testid="PlanReviewPanel" />
}))
vi.mock('../MockupPanel', () => ({
  MockupPanel: () => <div data-testid="MockupPanel" />
}))
vi.mock('../usage/UsageView', () => ({
  UsageView: () => <div data-testid="UsageView" />
}))
vi.mock('../automation/AutomationView', () => ({
  AutomationView: () => <div data-testid="AutomationView" />
}))
vi.mock('../plugin/PluginWebView', () => ({
  PluginWebView: () => <div data-testid="PluginWebView" />
}))
vi.mock('../terminal/TerminalPanel', () => ({
  TerminalPanel: () => <div data-testid="TerminalPanel" />
}))
vi.mock('../QuitWorktreeModal', () => ({
  QuitWorktreeModal: () => <div data-testid="QuitWorktreeModal" />
}))
// SessionView hosts the settings dialog on MOBILE ONLY (the sidebar drawer that
// hosts it on desktop is unmounted when it closes, so it cannot both dismiss the
// drawer and survive). Stubbed so the assertion is about the routing, not about
// the ~200KB settings-sections tree.
let settingsProps: { initialTarget?: { page?: string; group?: string } } | undefined
vi.mock('../SettingsDialog', () => ({
  SettingsDialog: (props: { initialTarget?: { page?: string; group?: string } }) => {
    settingsProps = props
    return <div data-testid="SettingsDialog" />
  }
}))
vi.mock('../../hooks/useGitWatcher', () => ({ useGitWatcher: () => {} }))
vi.mock('../../hooks/useAutomationEvents', () => ({ useAutomationEvents: () => {} }))
vi.mock('../../hooks/useTerminalColdCleanup', () => ({ useTerminalColdCleanup: () => {} }))

// TaskDetailPanel is a real, separately-tested FC (see
// TaskDetailPanel/__tests__/TaskDetailPanel.component.test.ts). Stub its View
// here so this file can assert which `variant` it's mounted with (the
// desktop side panel vs. the mobile fullscreen takeover) without depending on
// its internal entry-classification logic.
vi.mock('../TaskDetailPanel/View', () => ({
  TaskDetailPanelView: (props: { variant?: string; style?: React.CSSProperties }) => (
    <div
      data-testid="TaskDetailPanel"
      data-variant={props.variant ?? 'panel'}
      style={props.style}
    />
  )
}))

const ROUTE = 'route-session-view'

describe('SessionView — mobile task takeover', () => {
  let app: TestApp

  beforeEach(async () => {
    ;(window as any).matchMedia =
      (window as any).matchMedia ||
      ((): MediaQueryList =>
        ({
          matches: false,
          media: '',
          onchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false
        }) as unknown as MediaQueryList)

    mockIsMobile = false
    app = await bootTestApp()
    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
    useSessionStore.setState({ activeSessionId: ROUTE })
    // Give the session a Task tool_use so TaskDetailPanel's real FC (wrapped
    // by the stubbed View) has something to classify.
    seed.message(ROUTE, {
      id: 'm1',
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          toolUseId: 'tu-1',
          toolName: 'Task',
          toolInput: { description: 'Investigate the flaky test' }
        }
      ],
      timestamp: Date.now()
    })
  })

  afterEach(() => {
    // Unmount the tree (SessionView reads window.api.platform directly during
    // render) BEFORE tearing down window.api / resetting the store — a
    // teardown-then-setState order would leave SessionView mounted while a
    // zustand-triggered re-render runs with window.api already gone.
    cleanup()
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {}, terminalPanelOpen: false })
    mirrorStoreIntoReplica()
  })

  async function renderSessionView(): Promise<void> {
    const { SessionView } = await import('../SessionView')
    await act(async () => {
      render(React.createElement(SessionView))
    })
  }

  it('Shift+Tab cycles the permission mode of a codex session like any other engine', async () => {
    const modes: unknown[][] = []
    app.bridge.ipcMain.handle('session:set-permission-mode', (_e: unknown, ...args: unknown[]) => {
      modes.push(args)
      return null
    })
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [ROUTE]: {
          ...state.sessions[ROUTE],
          selectedEngineId: 'codex',
          permissionMode: 'default',
          status: {
            ...state.sessions[ROUTE].status,
            engineId: 'codex',
            capabilities: resolveCodexCapabilities()
          }
        }
      }
    }))
    mirrorStoreIntoReplica()

    await renderSessionView()
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true }))
    })

    expect(modes).toEqual([[ROUTE, 'acceptEdits']])
  })

  it('mobile + rightPanel=task: renders MobileTaskView full-screen, not ChatPanel', async () => {
    mockIsMobile = true
    useSessionStore.getState().openTaskPanel(ROUTE, 'tu-1')

    await renderSessionView()

    expect(screen.getByTestId('MobileTaskView')).toBeInTheDocument()
    expect(screen.queryByTestId('ChatPanel')).not.toBeInTheDocument()
    // Reuses TaskDetailPanel — full width, fullscreen variant — not a fork.
    const panel = screen.getByTestId('TaskDetailPanel')
    expect(panel.dataset.variant).toBe('fullscreen')
    // Task description surfaced as the title (cheaply available).
    expect(screen.getByText('Investigate the flaky test')).toBeInTheDocument()
  })

  it('mobile back button closes the panel via closeTaskPanel, restoring ChatPanel', async () => {
    mockIsMobile = true
    useSessionStore.getState().openTaskPanel(ROUTE, 'tu-1')

    await renderSessionView()

    expect(screen.getByTestId('MobileTaskView')).toBeInTheDocument()

    await act(async () => {
      screen.getByTestId('MobileTaskView.back').click()
    })

    expect(useSessionStore.getState().sessions[ROUTE].rightPanel).toBe('none')
    expect(screen.queryByTestId('MobileTaskView')).not.toBeInTheDocument()
    expect(screen.getByTestId('ChatPanel')).toBeInTheDocument()
  })

  it('mobile + rightPanel=none: ChatPanel renders normally, no takeover', async () => {
    mockIsMobile = true

    await renderSessionView()

    expect(screen.getByTestId('ChatPanel')).toBeInTheDocument()
    expect(screen.queryByTestId('MobileTaskView')).not.toBeInTheDocument()
  })

  it('desktop + rightPanel=task: side panel unchanged (regression lock)', async () => {
    mockIsMobile = false
    useSessionStore.getState().openTaskPanel(ROUTE, 'tu-1')

    await renderSessionView()

    expect(screen.getByTestId('ChatPanel')).toBeInTheDocument()
    expect(screen.queryByTestId('MobileTaskView')).not.toBeInTheDocument()
    const panel = screen.getByTestId('TaskDetailPanel')
    expect(panel.dataset.variant).toBe('panel')
  })

  // The git panel gets the same treatment as the task panel: a side panel on
  // desktop, a full-screen takeover of the ChatPanel slot on mobile.
  it('mobile + rightPanel=git: renders MobileGitView full-screen, not ChatPanel', async () => {
    mockIsMobile = true
    useSessionStore.getState().openGitPanel(ROUTE)

    await renderSessionView()

    expect(screen.getByTestId('MobileGitView')).toBeInTheDocument()
    expect(screen.queryByTestId('ChatPanel')).not.toBeInTheDocument()
    // Never both — the desktop side panel stays out of the mobile layout.
    expect(screen.queryByTestId('GitPanel')).not.toBeInTheDocument()
  })

  it('desktop + rightPanel=git: side panel unchanged (regression lock)', async () => {
    mockIsMobile = false
    useSessionStore.getState().openGitPanel(ROUTE)

    await renderSessionView()

    expect(screen.getByTestId('ChatPanel')).toBeInTheDocument()
    expect(screen.getByTestId('GitPanel')).toBeInTheDocument()
    expect(screen.queryByTestId('MobileGitView')).not.toBeInTheDocument()
  })

  it('mobile + rightPanel=task still wins over git when both were opened', async () => {
    mockIsMobile = true
    useSessionStore.getState().openGitPanel(ROUTE)
    useSessionStore.getState().openTaskPanel(ROUTE, 'tu-1')

    await renderSessionView()

    // rightPanel is a single slot — the last opener owns it.
    expect(screen.getByTestId('MobileTaskView')).toBeInTheDocument()
    expect(screen.queryByTestId('MobileGitView')).not.toBeInTheDocument()
  })

  // ── the settings host ─────────────────────────────────────────────────────
  //
  // `open-settings` is the app-wide deep-link channel, and exactly one host must
  // answer it. `SettingsPanel` answers from INSIDE the sidebar, so it can only
  // do so while the sidebar is mounted; SessionView answers for the complement —
  // mobile, and a desktop window whose sidebar is collapsed. That second case
  // used to be nobody's, which made every deep link in the app inert once the
  // sidebar was collapsed (S5c round 3).

  it('mobile: an open-settings event mounts the settings dialog outside the drawer', async () => {
    mockIsMobile = true
    settingsProps = undefined
    await renderSessionView()

    expect(screen.queryByTestId('SettingsDialog')).not.toBeInTheDocument()

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('open-settings', { detail: { page: 'claude', group: 'sandbox' } })
      )
    })

    expect(screen.getByTestId('SettingsDialog')).toBeInTheDocument()
    // The target is forwarded verbatim, as SettingsPanel does on desktop.
    expect(settingsProps).toMatchObject({
      initialTarget: { page: 'claude', group: 'sandbox' }
    })
  })

  it('desktop with the sidebar open: SessionView ignores open-settings', async () => {
    mockIsMobile = false
    localStorage.setItem('sidebarCollapsed', 'false')
    await renderSessionView()

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('open-settings', { detail: { page: 'claude', group: 'sandbox' } })
      )
    })

    // SettingsPanel, inside the sidebar, owns it here.
    expect(screen.queryByTestId('SettingsDialog')).not.toBeInTheDocument()
  })

  it('desktop with the sidebar COLLAPSED: SessionView answers the deep link', async () => {
    // The sidebar is unmounted in this state, and with it the only listener
    // there used to be — so the sandbox pill, the remote modal and the usage
    // dashboard's `Hub settings →` all fired into nothing.
    mockIsMobile = false
    localStorage.setItem('sidebarCollapsed', 'true')
    settingsProps = undefined
    await renderSessionView()

    expect(screen.queryByTestId('SettingsDialog')).not.toBeInTheDocument()

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('open-settings', { detail: { page: 'remote', group: 'usage-hub' } })
      )
    })

    expect(screen.getByTestId('SettingsDialog')).toBeInTheDocument()
    expect(settingsProps).toMatchObject({
      initialTarget: { page: 'remote', group: 'usage-hub' }
    })
  })

  it('widening past the breakpoint keeps the dialog while the sidebar stays collapsed', async () => {
    // WHAT CHANGED IN ROUND 3, and why this case reads the other way now.
    // Ownership is `isMobile || sidebarCollapsed`, not `isMobile`. Rotating an
    // iPad to landscape leaves the sidebar collapsed, so the sidebar's own host
    // is still not mounted — dropping the dialog here would close Settings under
    // the user AND leave the channel unowned, which is the defect this round
    // fixed rather than a state to preserve.
    mockIsMobile = true
    const { SessionView } = await import('../SessionView')
    let view!: ReturnType<typeof render>
    await act(async () => {
      view = render(React.createElement(SessionView))
    })

    await act(async () => {
      window.dispatchEvent(new CustomEvent('open-settings', { detail: {} }))
    })
    expect(screen.getByTestId('SettingsDialog')).toBeInTheDocument()

    mockIsMobile = false
    await act(async () => {
      view.rerender(React.createElement(SessionView))
    })
    expect(screen.getByTestId('SettingsDialog')).toBeInTheDocument()

    // What must still never happen: a dialog PARKED across a hand-off and
    // resurrected later. A fresh desktop mount with the sidebar open shows
    // nothing, whatever a previous viewport was doing.
    view.unmount()
    localStorage.setItem('sidebarCollapsed', 'false')
    await act(async () => {
      render(React.createElement(SessionView))
    })
    expect(screen.queryByTestId('SettingsDialog')).not.toBeInTheDocument()
  })

  // ── Terminal (M3) ─────────────────────────────────────────────────────────
  // Two mount points, one component. Desktop keeps the always-mounted bottom
  // panel (display:none preserves xterm scrollback locally); mobile mounts the
  // fullscreen takeover only while it is open — the host replays the scrollback
  // ring on re-attach, so a permanently-mounted hidden xterm buys a phone
  // nothing. Exactly one of the two may ever exist.

  it('mobile: the terminal mounts only while the panel flag is set', async () => {
    mockIsMobile = true
    await renderSessionView()
    expect(screen.queryByTestId('TerminalPanel')).toBeNull()

    await act(async () => {
      useSessionStore.getState().setTerminalPanelOpen(true)
    })
    expect(screen.getAllByTestId('TerminalPanel')).toHaveLength(1)

    await act(async () => {
      useSessionStore.getState().setTerminalPanelOpen(false)
    })
    expect(screen.queryByTestId('TerminalPanel')).toBeNull()
  })

  it('desktop: the bottom panel stays mounted either way (regression lock)', async () => {
    mockIsMobile = false
    await renderSessionView()
    // Closed, but present — the display:none wrapper is what preserves scrollback.
    expect(screen.getAllByTestId('TerminalPanel')).toHaveLength(1)

    await act(async () => {
      useSessionStore.getState().setTerminalPanelOpen(true)
    })
    // Still exactly one: opening must not add the mobile takeover alongside it.
    expect(screen.getAllByTestId('TerminalPanel')).toHaveLength(1)

    await act(async () => {
      useSessionStore.getState().setTerminalPanelOpen(false)
    })
  })
})
