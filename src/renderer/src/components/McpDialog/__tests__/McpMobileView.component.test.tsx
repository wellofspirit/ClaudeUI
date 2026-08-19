/**
 * Layer 2: the mobile MCP fork (viewport ≤768px).
 *
 * The container (`McpDialog`) is shared with desktop, so these tests drive the
 * REAL container and assert which presentation it picked and how that
 * presentation behaves. The desktop half is asserted here too — a fork that
 * quietly changes desktop is the failure mode this guards.
 *
 * `useIsMobile` reads `window.matchMedia`, which the jsdom setup stubs as
 * never-matching; each block installs its own stub for the breakpoint it needs.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { McpDialog } from '../McpDialog'
import type { McpServerConfig } from '../../../../../shared/types'

const CWD = '/d/repo'
const ROUTING_ID = 'route-mcp-mobile'

const originalMatchMedia = window.matchMedia
const originalInnerWidth = window.innerWidth

/** Live `matchMedia` subscribers, so a test can flip the breakpoint mid-render. */
let mqlListeners: Array<(e: MediaQueryListEvent) => void> = []

function setViewportIsMobile(isMobile: boolean): void {
  // `useIsMobile` seeds its state from innerWidth and only then subscribes to
  // the media query, so BOTH have to say the same thing.
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: isMobile ? 390 : 1280
  })
  window.matchMedia = ((query: string) => ({
    matches: isMobile && query.includes('max-width: 768px'),
    media: query,
    onchange: null,
    addEventListener: (_type: string, cb: (e: MediaQueryListEvent) => void) => {
      mqlListeners.push(cb)
    },
    removeEventListener: (_type: string, cb: (e: MediaQueryListEvent) => void) => {
      mqlListeners = mqlListeners.filter((l) => l !== cb)
    },
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia
}

/** Cross the breakpoint on a MOUNTED tree — a rotate/resize, not a remount. */
function crossBreakpoint(isMobile: boolean): void {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: isMobile ? 390 : 1280
  })
  act(() => {
    for (const cb of [...mqlListeners]) cb({ matches: isMobile } as MediaQueryListEvent)
  })
}

function stdio(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return { type: 'stdio', command: 'npx', ...overrides }
}

describe('McpDialog mobile fork', () => {
  let app: TestApp
  let onClose: ReturnType<typeof vi.fn<() => void>>
  let toggleDisabledCalls: Array<{ cwd: string; name: string; enabled: boolean }>
  let toggleCalls: Array<{ routingId: string; name: string; enabled: boolean }>
  let removeCalls: Array<{ scope: string; name: string }>
  let reconnectCalls: Array<{ name: string }>

  beforeEach(async () => {
    app = await bootTestApp()
    onClose = vi.fn<() => void>()
    toggleDisabledCalls = []
    toggleCalls = []
    removeCalls = []
    reconnectCalls = []

    app.bridge.ipcMain.handle('mcp:load-servers', async (_e, scope: string) => {
      if (scope === 'user') return { 'user-srv': stdio() }
      if (scope === 'project') return { 'proj-srv': stdio({ command: 'node' }) }
      return {}
    })
    app.bridge.ipcMain.handle('mcp:read-disabled', async () => ['proj-srv'])
    app.bridge.ipcMain.handle('mcp:status', async () => null)
    app.bridge.ipcMain.handle('mcp:remove-server', async (_e, scope: string, name: string) => {
      removeCalls.push({ scope, name })
    })
    app.bridge.ipcMain.handle(
      'mcp:toggle-disabled',
      async (_e, cwd: string, name: string, enabled: boolean) => {
        toggleDisabledCalls.push({ cwd, name, enabled })
      }
    )
    app.bridge.ipcMain.handle(
      'mcp:toggle',
      async (_e, routingId: string, name: string, enabled: boolean) => {
        toggleCalls.push({ routingId, name, enabled })
        return { ok: true, data: undefined }
      }
    )
    app.bridge.ipcMain.handle('mcp:reconnect', async (_e, _routingId: string, name: string) => {
      reconnectCalls.push({ name })
      return { ok: true, data: undefined }
    })
    app.bridge.ipcMain.handle('mcp:set-servers', async () => ({ ok: true, data: undefined }))
    app.bridge.ipcMain.handle('mcp:save-servers', async () => {})
  })

  afterEach(() => {
    cleanup()
    app.teardown()
    mqlListeners = []
    window.matchMedia = originalMatchMedia
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: originalInnerWidth
    })
  })

  /** Two config scopes + the disabled-list read all resolve on open. */
  async function settle(): Promise<void> {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }

  async function renderDialog(routingId: string | null = null): Promise<ReturnType<typeof render>> {
    let result!: ReturnType<typeof render>
    await act(async () => {
      result = render(<McpDialog open cwd={CWD} routingId={routingId} onClose={onClose} />)
    })
    await settle()
    return result
  }

  function row(name: string): HTMLElement {
    return screen.getAllByTestId('McpMobileView.row').find((r) => r.dataset.id === name)!
  }

  async function openDetail(name: string): Promise<void> {
    await act(async () => {
      fireEvent.click(row(name))
    })
  }

  // ── fork guard ────────────────────────────────────────────────────────────

  it('renders the mobile view at ≤768px', async () => {
    setViewportIsMobile(true)
    await renderDialog()

    expect(screen.getByTestId('McpMobileView')).toBeInTheDocument()
    expect(screen.queryByTestId('McpDialog')).not.toBeInTheDocument()
  })

  it('renders the untouched desktop view above 768px', async () => {
    setViewportIsMobile(false)
    await renderDialog()

    expect(screen.getByTestId('McpDialog')).toBeInTheDocument()
    expect(screen.queryByTestId('McpMobileView')).not.toBeInTheDocument()
    // The desktop structure is the filter + list column beside a detail pane,
    // with the Add Server affordance mobile deliberately drops.
    expect(screen.getByTestId('McpDialog.filter')).toBeInTheDocument()
    expect(screen.getByTestId('McpDialog.addServer')).toBeInTheDocument()
    expect(screen.getAllByTestId('McpDialog.serverRow').length).toBe(2)
  })

  it('clears a desktop filter when the viewport crosses into mobile mid-dialog', async () => {
    setViewportIsMobile(false)
    await renderDialog()

    await act(async () => {
      fireEvent.change(screen.getByTestId('McpDialog.filter'), { target: { value: 'user' } })
    })
    expect(screen.getAllByTestId('McpDialog.serverRow')).toHaveLength(1)

    crossBreakpoint(true)

    // The mobile fork renders no filter input, so a filter carried across the
    // breakpoint would hide servers with nothing on screen explaining why.
    expect(screen.getByTestId('McpMobileView')).toBeInTheDocument()
    expect(screen.getAllByTestId('McpMobileView.row').map((r) => r.dataset.id)).toEqual([
      'user-srv',
      'proj-srv'
    ])
  })

  describe('on mobile', () => {
    beforeEach(() => setViewportIsMobile(true))

    it('lands on the list with one row per configured server', async () => {
      await renderDialog()

      const rows = screen.getAllByTestId('McpMobileView.row')
      expect(rows.map((r) => r.dataset.id)).toEqual(['user-srv', 'proj-srv'])
      expect(screen.queryByTestId('McpMobileView.detail')).not.toBeInTheDocument()
      // Add is omitted on mobile (raw-JSON form; see MobileView's header note).
      expect(screen.queryByTestId('McpDialog.addServer')).not.toBeInTheDocument()
    })

    it('the header close button calls onClose', async () => {
      await renderDialog()
      fireEvent.click(screen.getByTestId('McpMobileView.close'))
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    // ── drill-down ──────────────────────────────────────────────────────────

    it('a row tap opens the detail screen; back returns to the list', async () => {
      await renderDialog()
      await openDetail('user-srv')

      const detail = screen.getByTestId('McpMobileView.detail')
      expect(detail).toHaveAttribute('data-id', 'user-srv')
      expect(screen.queryAllByTestId('McpMobileView.row')).toHaveLength(0)
      // Config is re-presented read-only.
      expect(detail.textContent).toContain('npx')

      await act(async () => {
        fireEvent.click(screen.getByTestId('McpMobileView.back'))
      })

      expect(screen.queryByTestId('McpMobileView.detail')).not.toBeInTheDocument()
      expect(screen.getAllByTestId('McpMobileView.row')).toHaveLength(2)
    })

    it('reopening lands on the list, not on the last-viewed server', async () => {
      const { rerender } = await renderDialog()
      await openDetail('user-srv')
      expect(screen.getByTestId('McpMobileView.detail')).toBeInTheDocument()

      await act(async () => {
        rerender(<McpDialog open={false} cwd={CWD} routingId={null} onClose={onClose} />)
      })
      await act(async () => {
        rerender(<McpDialog open cwd={CWD} routingId={null} onClose={onClose} />)
      })
      await settle()

      // The container drops the selection on close, so neither layout can
      // reopen mid-drill-down.
      expect(screen.queryByTestId('McpMobileView.detail')).not.toBeInTheDocument()
      expect(screen.getAllByTestId('McpMobileView.row')).toHaveLength(2)
    })

    it('renders the desktop blast-radius badges on tools', async () => {
      app.bridge.ipcMain.handle('mcp:status', async () => [
        {
          name: 'user-srv',
          status: 'connected',
          scope: 'user',
          config: stdio(),
          tools: [
            {
              name: 'write_file',
              annotations: { destructive: true, openWorld: true }
            },
            { name: 'read_file', annotations: { readOnly: true } }
          ]
        }
      ])

      await renderDialog(ROUTING_ID)
      await openDetail('user-srv')

      expect(screen.getByTestId('McpMobileView.toolsList')).toBeInTheDocument()
      const kinds = screen
        .getAllByTestId('McpMobileView.toolBadge')
        .map((b) => b.getAttribute('data-kind'))
      // The only place the UI says a tool writes or reaches the network.
      expect(kinds).toEqual(['destructive', 'openWorld', 'readOnly'])
    })

    it('carries the disabled status onto the row toggle and the detail status', async () => {
      await renderDialog()

      const toggles = screen.getAllByTestId('McpMobileView.toggle')
      const proj = toggles.find((t) => t.dataset.id === 'proj-srv')!
      const user = toggles.find((t) => t.dataset.id === 'user-srv')!
      // read-disabled named proj-srv; user-srv is merely not_started, which the
      // container also treats as "off" (its toggle enables).
      expect(proj).toHaveAttribute('data-on', 'false')
      expect(user).toHaveAttribute('data-on', 'false')

      await openDetail('proj-srv')
      expect(screen.getByTestId('McpMobileView.status')).toHaveAttribute('data-status', 'disabled')
    })

    // ── mutations ───────────────────────────────────────────────────────────

    it('the inline row toggle drives the config channel when there is no live session', async () => {
      await renderDialog(null)

      await act(async () => {
        fireEvent.click(
          screen.getAllByTestId('McpMobileView.toggle').find((t) => t.dataset.id === 'proj-srv')!
        )
      })

      expect(toggleDisabledCalls).toEqual([{ cwd: CWD, name: 'proj-srv', enabled: true }])
      expect(toggleCalls).toHaveLength(0)
    })

    it('reconnect is offered on the detail screen only while a session is live', async () => {
      await renderDialog(null)
      await openDetail('proj-srv')
      // No routingId → nothing to reconnect to.
      expect(screen.queryByTestId('McpMobileView.reconnect')).not.toBeInTheDocument()
      cleanup()

      await renderDialog(ROUTING_ID)
      await openDetail('proj-srv')
      await act(async () => {
        fireEvent.click(screen.getByTestId('McpMobileView.reconnect'))
      })
      expect(reconnectCalls).toEqual([{ name: 'proj-srv' }])
    })

    it('remove needs two taps: the first only arms the confirm', async () => {
      await renderDialog()
      await openDetail('user-srv')

      // The id is stable across both states (ADR-027: identity, not state);
      // `data-armed` is the discriminator.
      const remove = (): HTMLElement => screen.getByTestId('McpMobileView.remove')
      expect(remove()).toHaveAttribute('data-armed', 'false')

      await act(async () => {
        fireEvent.click(remove())
      })
      expect(removeCalls).toHaveLength(0)
      expect(remove()).toHaveAttribute('data-armed', 'true')

      await act(async () => {
        fireEvent.click(remove())
      })
      expect(removeCalls).toEqual([{ scope: 'user', name: 'user-srv' }])
    })

    it('acting on a neighbouring control disarms the confirm', async () => {
      await renderDialog()
      await openDetail('proj-srv')

      await act(async () => {
        fireEvent.click(screen.getByTestId('McpMobileView.remove'))
      })
      expect(screen.getByTestId('McpMobileView.remove')).toHaveAttribute('data-armed', 'true')

      await act(async () => {
        fireEvent.click(screen.getByTestId('McpMobileView.detailToggle'))
      })

      // Enable/Disable is a change of intent — the next Remove tap must arm,
      // not delete.
      expect(screen.getByTestId('McpMobileView.remove')).toHaveAttribute('data-armed', 'false')
      expect(removeCalls).toHaveLength(0)
    })

    it('an armed remove disarms itself after 3s', async () => {
      await renderDialog()
      await openDetail('user-srv')

      // Fakes are installed only AFTER the load settles, so the 3s timer is the
      // one this test controls; the unmount happens while they are still fake so
      // nothing fake-scheduled can fire into a torn-down window.api.
      vi.useFakeTimers()
      try {
        act(() => {
          fireEvent.click(screen.getByTestId('McpMobileView.remove'))
        })
        expect(screen.getByTestId('McpMobileView.remove')).toHaveAttribute('data-armed', 'true')

        act(() => {
          vi.advanceTimersByTime(3000)
        })

        expect(screen.getByTestId('McpMobileView.remove')).toHaveAttribute('data-armed', 'false')
        expect(removeCalls).toHaveLength(0)
        cleanup()
      } finally {
        vi.useRealTimers()
      }
    })

    it('an armed remove does not survive a change of subject', async () => {
      await renderDialog()
      await openDetail('user-srv')

      await act(async () => {
        fireEvent.click(screen.getByTestId('McpMobileView.remove'))
      })
      expect(screen.getByTestId('McpMobileView.remove')).toHaveAttribute('data-armed', 'true')

      await act(async () => {
        fireEvent.click(screen.getByTestId('McpMobileView.back'))
      })
      await openDetail('proj-srv')

      // proj-srv's Remove must be back in its safe state, not inherited armed.
      expect(screen.getByTestId('McpMobileView.remove')).toHaveAttribute('data-armed', 'false')
    })
  })
})
