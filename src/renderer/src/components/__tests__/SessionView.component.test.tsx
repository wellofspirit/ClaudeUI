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
    <div data-testid="TaskDetailPanel" data-variant={props.variant ?? 'panel'} style={props.style} />
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
    useSessionStore.getState().addMessage(ROUTE, {
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
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
  })

  async function renderSessionView(): Promise<void> {
    const { SessionView } = await import('../SessionView')
    await act(async () => {
      render(React.createElement(SessionView))
    })
  }

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
})
