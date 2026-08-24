/**
 * Layer 2: the presentation fork.
 *
 * TerminalPanel is the single container for both surfaces — availability, the
 * pool query and the ADR-054 step-up all resolve once and are handed to whichever
 * view the viewport calls for. This suite is the guard in BOTH directions: a
 * phone must never get the bottom panel, and a desktop must never get the
 * takeover, no matter what else changes in here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, act, screen, cleanup, waitFor } from '@testing-library/react'
import { useSessionStore } from '../../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import type { ClaudeAPI, TerminalAvailability } from '../../../../../../shared/types'

let mobileProps: { gate?: React.ReactNode; readOnly?: boolean } | null = null

vi.mock('../View', () => ({
  TerminalPanelView: () => React.createElement('div', { 'data-testid': 'TerminalPanelView' })
}))

vi.mock('../TerminalMobileView', () => ({
  TerminalMobileView: (props: { gate?: React.ReactNode; readOnly?: boolean }) => {
    mobileProps = props
    return React.createElement('div', { 'data-testid': 'TerminalMobileView' }, props.gate ?? null)
  }
}))

const ROUTE = 'route-term-fork'
const CWD = '/d/repo-fork'

const originalMatchMedia = window.matchMedia
const originalInnerWidth = window.innerWidth

/** useIsMobile seeds from innerWidth and only then subscribes to the media query. */
function setViewportIsMobile(isMobile: boolean): void {
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

describe('TerminalPanel — mobile/desktop presentation fork', () => {
  let app: TestApp

  beforeEach(async () => {
    mobileProps = null
    app = await bootTestApp()
    app.bridge.ipcMain.handle('terminal:create', async () => 'term-fork-1')
    app.bridge.ipcMain.handle('terminal:pool', async () => [])
    useSessionStore.getState().createNewSession(ROUTE, CWD)
    useSessionStore.setState({
      activeSessionId: ROUTE,
      terminalGroups: {},
      terminalPanelOpen: true
    })
  })

  afterEach(() => {
    cleanup()
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {}, terminalGroups: {} })
    window.matchMedia = originalMatchMedia
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: originalInnerWidth
    })
  })

  async function renderPanel(): Promise<void> {
    const { TerminalPanel } = await import('../TerminalPanel')
    await act(async () => {
      render(React.createElement(TerminalPanel, {}))
    })
  }

  it('mounts the takeover on a phone, never the bottom panel', async () => {
    setViewportIsMobile(true)
    await renderPanel()

    expect(screen.getByTestId('TerminalMobileView')).toBeInTheDocument()
    expect(screen.queryByTestId('TerminalPanelView')).toBeNull()
  })

  it('mounts the bottom panel on a desktop, never the takeover (regression lock)', async () => {
    setViewportIsMobile(false)
    await renderPanel()

    expect(screen.getByTestId('TerminalPanelView')).toBeInTheDocument()
    expect(screen.queryByTestId('TerminalMobileView')).toBeNull()
  })

  it('routes the web gate into the takeover, with the SAME body desktop shows', async () => {
    setViewportIsMobile(true)
    const real = window.api as unknown as ClaudeAPI & {
      terminalAvailability: () => Promise<TerminalAvailability>
      onTerminalDetached: (cb: () => void) => () => void
    }
    real.platform = 'web' as ClaudeAPI['platform']
    real.terminalAvailability = vi.fn(async () => ({
      allowed: false,
      granted: false,
      needsStepUp: false,
      readsAllowed: false,
      stepUp: null
    }))
    real.onTerminalDetached = vi.fn(() => () => {})

    await renderPanel()

    await waitFor(() => expect(screen.getByTestId('TerminalPanel.unavailable')).toBeInTheDocument())
    // The gate arrives as a prop rather than being rebuilt by the mobile view —
    // one ceremony, two frames.
    expect(mobileProps?.gate).toBeTruthy()
    expect(screen.queryByTestId('TerminalPanel')).toBeNull()
  })
})
