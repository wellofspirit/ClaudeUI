/**
 * Layer 2: the web client's terminal affordance is driven ENTIRELY by
 * `terminal:availability` (SyncCore phase 2, capability honesty).
 *
 * Desktop is deliberately not re-tested here — it never consults availability
 * (see DESKTOP_AVAILABILITY in terminal-availability.ts), which is what keeps its
 * behavior identical to pre-phase-2. `TerminalPanel.component.test.ts` covers
 * that path unchanged.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, act, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { useSessionStore } from '../../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import type { ClaudeAPI, TerminalAvailability } from '../../../../../../shared/types'

let viewRendered = 0
let viewProps: {
  onNewTab: () => Promise<void>
  readOnly?: boolean
  onBlockedInput?: () => void
} | null = null
vi.mock('../View', () => ({
  TerminalPanelView: (props: { onNewTab: () => Promise<void> }) => {
    viewRendered++
    viewProps = props
    return React.createElement('div', { 'data-testid': 'TerminalPanelView' })
  }
}))

const ROUTE = 'route-web-term'
const CWD = '/d/repo'

/** The web-only members this suite drives, spied on top of the real test API. */
interface WebApiOverrides {
  terminalAvailability: ReturnType<typeof vi.fn>
  terminalStepUp: ReturnType<typeof vi.fn>
  createTerminal: ReturnType<typeof vi.fn>
  onTerminalDetached: ReturnType<typeof vi.fn>
}

describe('TerminalPanel — web availability gate', () => {
  let app: TestApp
  let api: WebApiOverrides
  let detachedListeners: Array<(p: { terminalId: string; reason: string }) => void>

  beforeEach(async () => {
    viewRendered = 0
    viewProps = null
    detachedListeners = []
    // The real harness API (the store needs most of it), re-pointed at the web
    // platform and with the phase-2 terminal members spied.
    app = await bootTestApp()
    const real = window.api as unknown as ClaudeAPI & WebApiOverrides
    real.platform = 'web' as ClaudeAPI['platform']
    real.terminalAvailability = vi.fn(async (): Promise<TerminalAvailability> => ({
      allowed: true,
      granted: true,
      needsStepUp: false,
      stepUp: null
    }))
    real.terminalStepUp = vi.fn(async () => ({ ok: true }))
    real.createTerminal = vi.fn(async () => 'term-1')
    real.onTerminalDetached = vi.fn((cb: (p: { terminalId: string; reason: string }) => void) => {
      detachedListeners.push(cb)
      return () => {}
    })
    api = real

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
  })

  async function renderPanel(): Promise<void> {
    const { TerminalPanel } = await import('../TerminalPanel')
    await act(async () => {
      render(React.createElement(TerminalPanel, { style: {} }))
    })
  }

  it('renders the terminal only once the server says it is allowed and granted', async () => {
    await renderPanel()
    await waitFor(() => expect(screen.getByTestId('TerminalPanelView')).toBeTruthy())
    expect(api.terminalAvailability).toHaveBeenCalled()
  })

  it('explains the desktop toggle instead of rendering a shell it cannot drive', async () => {
    api.terminalAvailability.mockResolvedValue({
      allowed: false,
      granted: false,
      needsStepUp: false
    })
    await renderPanel()

    await waitFor(() => expect(screen.getByTestId('TerminalPanel.unavailable')).toBeTruthy())
    expect(screen.queryByTestId('TerminalPanelView')).toBeNull()
    expect(viewRendered).toBe(0)
  })

  it('shows the step-up prompt when allowed but not granted, and re-checks after unlocking', async () => {
    api.terminalAvailability.mockResolvedValue({
      allowed: true,
      granted: false,
      needsStepUp: true
    })
    await renderPanel()

    await waitFor(() => expect(screen.getByTestId('TerminalStepUpPrompt')).toBeTruthy())
    expect(screen.queryByTestId('TerminalPanelView')).toBeNull()

    api.terminalAvailability.mockResolvedValue({
      allowed: true,
      granted: true,
      needsStepUp: false
    })
    fireEvent.change(screen.getByTestId('TerminalStepUpPrompt.password'), {
      target: { value: 'correct horse battery staple' }
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('TerminalStepUpPrompt.submit'))
    })

    expect(api.terminalStepUp).toHaveBeenCalledWith('correct horse battery staple', undefined)
    await waitFor(() => expect(screen.getByTestId('TerminalPanelView')).toBeTruthy())
  })

  it('surfaces a refused step-up inline and stays locked', async () => {
    api.terminalAvailability.mockResolvedValue({
      allowed: true,
      granted: false,
      needsStepUp: true
    })
    api.terminalStepUp.mockResolvedValue({
      ok: false,
      code: 'invalid-proof',
      error: 'That password did not match.'
    })
    await renderPanel()
    await waitFor(() => expect(screen.getByTestId('TerminalStepUpPrompt')).toBeTruthy())

    fireEvent.change(screen.getByTestId('TerminalStepUpPrompt.password'), {
      target: { value: 'wrong' }
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('TerminalStepUpPrompt.submit'))
    })

    expect(screen.getByTestId('TerminalStepUpPrompt.error').textContent).toContain(
      'That password did not match.'
    )
    expect(screen.queryByTestId('TerminalPanelView')).toBeNull()
  })

  it('re-checks availability when the server detaches this client', async () => {
    await renderPanel()
    await waitFor(() => expect(screen.getByTestId('TerminalPanelView')).toBeTruthy())

    api.terminalAvailability.mockResolvedValue({
      allowed: false,
      granted: false,
      needsStepUp: false
    })
    await act(async () => {
      for (const cb of detachedListeners) cb({ terminalId: 'term-1', reason: 'policy-off' })
    })

    await waitFor(() => expect(screen.getByTestId('TerminalPanel.unavailable')).toBeTruthy())
  })

  it('falls back to the step-up prompt when the grant decays between check and click', async () => {
    await renderPanel()
    await waitFor(() => expect(screen.getByTestId('TerminalPanelView')).toBeTruthy())

    // The check said "granted", but the server's clock disagreed by the time the
    // user pressed "+". The panel must recover into the ceremony, not throw.
    api.createTerminal.mockRejectedValue(new Error('needs-step-up'))
    await act(async () => {
      await viewProps!.onNewTab()
    })

    await waitFor(() => expect(screen.getByTestId('TerminalStepUpPrompt')).toBeTruthy())
  })

  it('rethrows a create failure that is NOT about the grant', async () => {
    await renderPanel()
    await waitFor(() => expect(screen.getByTestId('TerminalPanelView')).toBeTruthy())

    api.createTerminal.mockRejectedValue(new Error('spawn ENOENT'))
    await expect(viewProps!.onNewTab()).rejects.toThrow('spawn ENOENT')
    expect(screen.queryByTestId('TerminalStepUpPrompt')).toBeNull()
  })
  /**
   * ADR-054's read/act split, from the client's side.
   *
   * The state that did not exist before: armed once (so scrollback is unlocked
   * for this socket's lifetime) but idle past the ACT window. The stream keeps
   * flowing and the server refuses keystrokes — SILENTLY, because an error would
   * be an oracle for which terminals exist. So the panel must render the
   * terminal rather than a wall, and hold the first key back itself.
   */
  describe('read-only (ADR-054 series 2)', () => {
    const READ_ONLY: TerminalAvailability = {
      allowed: true,
      granted: false,
      needsStepUp: true,
      readsAllowed: true,
      stepUp: null
    }

    it('renders the TERMINAL, not the step-up wall, when reads are still allowed', async () => {
      api.terminalAvailability.mockResolvedValue(READ_ONLY)
      await renderPanel()

      await waitFor(() => expect(screen.getByTestId('TerminalPanelView')).toBeTruthy())
      expect(screen.queryByTestId('TerminalStepUpPrompt')).toBeNull()
      expect(viewProps!.readOnly).toBe(true)
    })

    it('keeps the WALL when the connection was never armed', async () => {
      // First access ever still costs one proof (decision 4): scrollback and the
      // live-shell inventory are sensitive, so "never armed" is a genuine wall
      // rather than the read-only state.
      api.terminalAvailability.mockResolvedValue({ ...READ_ONLY, readsAllowed: false })
      await renderPanel()

      await waitFor(() => expect(screen.getByTestId('TerminalStepUpPrompt')).toBeTruthy())
      expect(screen.queryByTestId('TerminalPanelView')).toBeNull()
    })

    it('keeps the WALL against an older host that reports no readsAllowed at all', async () => {
      api.terminalAvailability.mockResolvedValue({
        allowed: true,
        granted: false,
        needsStepUp: true,
        stepUp: null
      })
      await renderPanel()

      await waitFor(() => expect(screen.getByTestId('TerminalStepUpPrompt')).toBeTruthy())
    })

    it('a held-back keystroke opens ONE ceremony and re-checks when it lands', async () => {
      const request = vi.fn(async () => true)
      ;(window as unknown as { __STEP_UP_REQUEST__?: typeof request }).__STEP_UP_REQUEST__ = request
      api.terminalAvailability.mockResolvedValue(READ_ONLY)
      await renderPanel()
      await waitFor(() => expect(screen.getByTestId('TerminalPanelView')).toBeTruthy())

      api.terminalAvailability.mockResolvedValue({
        allowed: true,
        granted: true,
        needsStepUp: false,
        readsAllowed: true,
        stepUp: null
      })
      await act(async () => {
        viewProps!.onBlockedInput!()
      })

      expect(request).toHaveBeenCalledWith('terminal:write')
      await waitFor(() => expect(viewProps!.readOnly).toBe(false))
      delete (window as unknown as { __STEP_UP_REQUEST__?: unknown }).__STEP_UP_REQUEST__
    })

    it('is inert where no gate is installed — the desktop build has no ceremony', async () => {
      delete (window as unknown as { __STEP_UP_REQUEST__?: unknown }).__STEP_UP_REQUEST__
      api.terminalAvailability.mockResolvedValue(READ_ONLY)
      await renderPanel()
      await waitFor(() => expect(screen.getByTestId('TerminalPanelView')).toBeTruthy())
      // Must not throw: the panel is shared with a build that never installs one.
      await act(async () => {
        viewProps!.onBlockedInput!()
      })
      expect(viewProps!.readOnly).toBe(true)
    })

    it('a refused ACT does not flatten the right to WATCH', async () => {
      // The regression the split exists to prevent: `terminal:create` refused for
      // staleness says nothing about reading, and treating it as "no terminal
      // here" would wall off shells this connection may still see.
      api.terminalAvailability.mockResolvedValue(READ_ONLY)
      await renderPanel()
      await waitFor(() => expect(screen.getByTestId('TerminalPanelView')).toBeTruthy())

      api.createTerminal.mockRejectedValue(new Error('needs-step-up'))
      await act(async () => {
        await viewProps!.onNewTab()
      })

      expect(screen.queryByTestId('TerminalStepUpPrompt')).toBeNull()
      expect(viewProps!.readOnly).toBe(true)
    })
  })
})
