/**
 * Layer 2: the phone's terminal takeover.
 *
 * The load-bearing claim of this series is that the mobile terminal is the SAME
 * terminal — so the assertions that matter here are the ones a reimplementation
 * would fail:
 *
 *  1. an accessory key's bytes arrive at `terminal:write` having gone through
 *     xterm's own `onData` (the mock's `input()` drives the registered handler,
 *     exactly as a keypress does), and
 *  2. in read-only state the very same tap is HELD BACK and asks for a step-up
 *     instead — which is only true because it never touched `terminal:write`
 *     itself.
 *
 * xterm is lazy-chunked (TerminalSurface owns the boundary), so every mount goes
 * through Suspense and the mock factory doubles as the "did the chunk load"
 * probe, mirroring View.lazy-xterm.component.test.tsx.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, act, cleanup, fireEvent } from '@testing-library/react'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import type { TerminalTab } from '../../../../../../shared/types'
import { TerminalMobileView, type TerminalMobileViewProps } from '../TerminalMobileView'

/** Every onData handler the mounted instances installed, in mount order. */
let dataCallbacks: Array<(data: string) => void> = []

class MockTerm {
  cols = 80
  rows = 24
  options: Record<string, unknown> = {}
  write = vi.fn()
  focus = vi.fn()
  dispose = vi.fn()
  loadAddon = vi.fn()
  open = vi.fn()

  onData(cb: (data: string) => void): { dispose: () => void } {
    dataCallbacks.push(cb)
    return {
      dispose: () => {
        dataCallbacks = dataCallbacks.filter((c) => c !== cb)
      }
    }
  }

  /**
   * The real `Terminal.input(data, wasUserInput)` fires `onData` — that IS the
   * property the accessory keys lean on, so the mock has to honor it rather
   * than record the call. The flag is pinned here rather than per-test:
   * `wasUserInput: true` buys scroll-to-bottom + selection clear on a real
   * xterm, and a regression to `false` should fail every injection test.
   */
  input(data: string, wasUserInput?: boolean): void {
    if (wasUserInput !== true) {
      throw new Error('terminal-input injection must pass wasUserInput=true (scroll-to-bottom)')
    }
    for (const cb of dataCallbacks) cb(data)
  }
}

class MockResizeObserver {
  observe(): void {}
  disconnect(): void {}
}

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    constructor() {
      return new MockTerm() as never
    }
  } as never
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn()
  } as never
}))

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

const CWD = '/d/repo'
const TAB: TerminalTab = { id: 'term-1', title: 'Terminal', cwd: CWD, poolIndex: 0 }
const TAB2: TerminalTab = { id: 'term-2', title: 'build', cwd: CWD, poolIndex: 1 }

function props(overrides: Partial<TerminalMobileViewProps> = {}): TerminalMobileViewProps {
  return {
    visibleTabs: [TAB],
    allTabs: [TAB],
    activeId: TAB.id,
    onSelectTab: vi.fn(),
    onCloseTab: vi.fn(),
    onNewTab: vi.fn(),
    onClosePanel: vi.fn(),
    nextSlot: 1,
    nextSlotRunning: false,
    ...overrides
  }
}

describe('TerminalMobileView', () => {
  let app: TestApp
  let writeCalls: Array<{ id: string; data: string }>
  const originalVisualViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport')

  beforeEach(async () => {
    app = await bootTestApp()
    dataCallbacks = []
    writeCalls = []
    ;(global as unknown as { ResizeObserver: unknown }).ResizeObserver = MockResizeObserver
    ;(global as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = (
      cb: FrameRequestCallback
    ) => {
      cb(0)
      return 0
    }
    app.bridge.ipcMain.handle('terminal:write', async (_e, id: string, data: string) => {
      writeCalls.push({ id, data })
    })
    app.bridge.ipcMain.handle('terminal:resize', async () => {})
    app.bridge.ipcMain.handle('terminal:attach', async () => true)
    app.bridge.ipcMain.handle('terminal:detach', async () => {})
  })

  afterEach(() => {
    cleanup()
    app.teardown()
    if (originalVisualViewport) {
      Object.defineProperty(window, 'visualViewport', originalVisualViewport)
    } else {
      delete (window as unknown as { visualViewport?: unknown }).visualViewport
    }
  })

  async function mount(overrides: Partial<TerminalMobileViewProps> = {}): Promise<void> {
    render(<TerminalMobileView {...props(overrides)} />)
    // The xterm chunk lands behind Suspense; every input assertion needs the
    // instance (and therefore its onData handler) to exist first. `getAll`
    // because every tab keeps an instance mounted — scrollback survives a switch.
    await waitFor(() => expect(screen.getAllByTestId('XTermInstance').length).toBeGreaterThan(0))
    await act(async () => {
      await Promise.resolve()
    })
  }

  // ── Accessory keys ───────────────────────────────────────────────────────

  it.each([
    ['esc', '\x1b'],
    ['tab', '\t'],
    ['ctrl-c', '\x03'],
    ['left', '\x1b[D'],
    ['up', '\x1b[A'],
    ['down', '\x1b[B'],
    ['right', '\x1b[C']
  ])('the %s key reaches terminal:write with the exact bytes', async (key, bytes) => {
    await mount()

    const button = screen
      .getAllByTestId('TerminalMobileView.key')
      .find((el) => el.getAttribute('data-key') === key)!
    expect(button).toBeDefined()

    await act(async () => {
      fireEvent.click(button)
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(writeCalls).toEqual([{ id: TAB.id, data: bytes }])
  })

  it('carries all seven keys, in one non-wrapping row', async () => {
    await mount()
    expect(
      screen.getAllByTestId('TerminalMobileView.key').map((el) => el.getAttribute('data-key'))
    ).toEqual(['esc', 'tab', 'ctrl-c', 'left', 'up', 'down', 'right'])
    expect(screen.getByTestId('TerminalMobileView.keyRow').className).toContain('flex-nowrap')
  })

  it('never steals focus from xterm (the soft keyboard has to stay up)', async () => {
    await mount()
    const button = screen.getAllByTestId('TerminalMobileView.key')[0]

    expect(button).toHaveAttribute('tabindex', '-1')
    // Cancelling pointerdown's default is what stops the focus move; `click`
    // still fires, which is why the byte assertions above hold.
    const event = new Event('pointerdown', { bubbles: true, cancelable: true })
    fireEvent(button, event)
    expect(event.defaultPrevented).toBe(true)
  })

  it('holds the key back and asks for a step-up when the connection is read-only', async () => {
    const onBlockedInput = vi.fn()
    await mount({ readOnly: true, onBlockedInput })

    await act(async () => {
      fireEvent.click(
        screen
          .getAllByTestId('TerminalMobileView.key')
          .find((el) => el.getAttribute('data-key') === 'ctrl-c')!
      )
      await new Promise((r) => setTimeout(r, 0))
    })

    // ADR-054: the byte is DROPPED, never buffered, and the ceremony is asked
    // for instead — identical to a typed key, because it is the same handler.
    expect(writeCalls).toEqual([])
    expect(onBlockedInput).toHaveBeenCalledTimes(1)
  })

  it('disables the row when there is no terminal to type into', async () => {
    render(<TerminalMobileView {...props({ visibleTabs: [], allTabs: [], activeId: null })} />)
    for (const button of screen.getAllByTestId('TerminalMobileView.key')) {
      expect(button).toBeDisabled()
    }
    // The panel's own empty state is what fills the surface.
    expect(screen.getByTestId('TerminalPanel.empty')).toBeInTheDocument()
  })

  // ── Chrome ───────────────────────────────────────────────────────────────

  it('renders a chip per visible tab, marks the active one, and drives select/close', async () => {
    const onSelectTab = vi.fn()
    const onCloseTab = vi.fn()
    await mount({
      visibleTabs: [TAB, TAB2],
      allTabs: [TAB, TAB2],
      onSelectTab,
      onCloseTab
    })

    const chips = screen.getAllByTestId('TerminalMobileView.tabChip')
    expect(chips.map((c) => c.getAttribute('data-id'))).toEqual([TAB.id, TAB2.id])
    expect(chips[0]).toHaveAttribute('data-active', 'true')
    expect(chips[1]).not.toHaveAttribute('data-active')

    fireEvent.click(chips[1])
    expect(onSelectTab).toHaveBeenCalledWith(TAB2.id, CWD)

    // Closing must not also select — the × stops the bubble.
    onSelectTab.mockClear()
    fireEvent.click(
      screen
        .getAllByTestId('TerminalMobileView.tabClose')
        .find((el) => el.getAttribute('data-id') === TAB2.id)!
    )
    // Detach only: no `kill` argument may reach the container from a thumb.
    expect(onCloseTab).toHaveBeenCalledWith(TAB2.id)
    expect(onSelectTab).not.toHaveBeenCalled()
  })

  it('back closes the panel through the same flag the desktop close uses', async () => {
    const onClosePanel = vi.fn()
    await mount({ onClosePanel })
    fireEvent.click(screen.getByTestId('TerminalMobileView.back'))
    expect(onClosePanel).toHaveBeenCalledTimes(1)
  })

  it('the + button carries the desktop re-attach hint', async () => {
    const onNewTab = vi.fn()
    await mount({ onNewTab, nextSlotRunning: true, nextSlot: 1 })

    const newTab = screen.getByTestId('TerminalMobileView.newTab')
    expect(newTab).toHaveAttribute('data-running', 'true')
    expect(newTab).toHaveAttribute('title', 'Re-attach to the shell already running in terminal 2')
    expect(screen.getByTestId('TerminalPanel.newTabRunning')).toBeInTheDocument()

    fireEvent.click(newTab)
    expect(onNewTab).toHaveBeenCalledTimes(1)
  })

  it('shows the EXISTING read-only banner inside the takeover', async () => {
    await mount({ readOnly: true })
    expect(screen.getByTestId('TerminalPanel.readOnly')).toBeInTheDocument()
    expect(screen.getByTestId('TerminalMobileView')).toHaveAttribute('data-readonly', 'true')
  })

  // ── Gate ─────────────────────────────────────────────────────────────────

  it('renders the container gate instead of tabs, "+" and the key row', () => {
    render(
      <TerminalMobileView
        {...props()}
        gate={<div data-testid="TerminalPanel.checking">Checking terminal access…</div>}
      />
    )

    expect(screen.getByTestId('TerminalPanel.checking')).toBeInTheDocument()
    // Nothing that acts on a shell this client has not been granted.
    expect(screen.queryByTestId('TerminalMobileView.keyRow')).toBeNull()
    expect(screen.queryByTestId('TerminalMobileView.newTab')).toBeNull()
    expect(screen.queryByTestId('TerminalMobileView.tabChip')).toBeNull()
    // The way out stays.
    expect(screen.getByTestId('TerminalMobileView.back')).toBeInTheDocument()
  })

  // ── Soft keyboard / visual viewport ──────────────────────────────────────

  it('sizes itself to the VISUAL viewport, so the key row survives the keyboard', async () => {
    const listeners: Record<string, () => void> = {}
    const viewport = {
      height: 720,
      addEventListener: (type: string, cb: () => void) => {
        listeners[type] = cb
      },
      removeEventListener: () => {}
    }
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })

    await mount()
    expect(screen.getByTestId('TerminalMobileView')).toHaveStyle({ height: '720px' })

    // Keyboard opens: the visual viewport shrinks, and the takeover follows it
    // (which is also what drives xterm's resize — its container shrinks).
    await act(async () => {
      viewport.height = 380
      listeners.resize?.()
    })
    expect(screen.getByTestId('TerminalMobileView')).toHaveStyle({ height: '380px' })
  })

  it('falls back to full height where no visual viewport is reported', async () => {
    delete (window as unknown as { visualViewport?: unknown }).visualViewport
    await mount()
    expect(screen.getByTestId('TerminalMobileView')).toHaveStyle({ height: '100dvh' })
  })
})
