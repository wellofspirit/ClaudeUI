/**
 * Layer 2: the MOBILE sizing regime of XTermInstance (ADR-060).
 *
 * The desktop terminal fits both axes and pushes the result at the pty. A phone
 * doing that clamps a shared shell the desktop is driving at 120 columns down to
 * ~48, and PSReadLine's absolute-cursor repaints then garble against the
 * narrower grid — the bug this mode exists to fix. So `mirrorGrid` inverts the
 * width relationship: cols come FROM the pty (the attach reply, then
 * `terminal:resized`) and are never pushed back; only rows are.
 *
 * xterm is mocked, as in the sibling suite: everything here is the wiring
 * between the attach reply, the resize events and the IPC pushes, and none of it
 * needs a real terminal. What a real terminal IS needed for — that a synthetic
 * WheelEvent actually drives xterm 6's viewport — is a browser fact, verified by
 * probe against Chromium and recorded in ADR-060; this file pins that the
 * gesture produces the event.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, act } from '@testing-library/react'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'

const termInstances: MockTerm[] = []

class MockTerm {
  cols = 80
  rows = 24
  options: Record<string, unknown> = {}
  element: HTMLElement | null = null
  write = vi.fn()
  reset = vi.fn()
  focus = vi.fn()
  dispose = vi.fn()
  loadAddon = vi.fn()
  input = vi.fn()
  resize = vi.fn((cols: number, rows: number) => {
    this.cols = cols
    this.rows = rows
  })
  open = vi.fn((el: HTMLElement) => {
    this.element = el
  })
  onData(): { dispose: () => void } {
    return { dispose: () => {} }
  }
}

/** Rows the fit addon claims the box can show. Mutated per test. */
let proposedRows = 40
const fitCalls: number[] = []

class MockResizeObserver {
  static last: MockResizeObserver | null = null
  constructor(private cb: () => void) {
    MockResizeObserver.last = this
  }
  observe(): void {}
  disconnect(): void {}
  trigger(): void {
    this.cb()
  }
}

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    constructor() {
      const inst = new MockTerm()
      termInstances.push(inst)
      return inst as never
    }
  } as never
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    activate(): void {}
    fit(): void {
      fitCalls.push(fitCalls.length)
      // The real addon fits BOTH axes — that is exactly what mirror mode must
      // not do, so the mock has to actually move cols for the assertion to bite.
      const t = termInstances[termInstances.length - 1]
      t?.resize(48, proposedRows)
    }
    proposeDimensions(): { cols: number; rows: number } {
      return { cols: 48, rows: proposedRows }
    }
  } as never
}))

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

/**
 * A TouchEvent jsdom can dispatch.
 *
 * jsdom has no `Touch` constructor, and the handler only ever reads
 * `touches[0].clientX/clientY` (plus `cancelable`), so a plain Event carrying a
 * touch-shaped list is a faithful stand-in and keeps the test honest about what
 * the production code is allowed to depend on.
 */
function touch(type: string, points: Array<{ clientX: number; clientY: number }>): Event {
  const e = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(e, 'touches', { value: points })
  Object.defineProperty(e, 'changedTouches', { value: points })
  return e
}

describe('XTermInstance — mirror mode (ADR-060)', () => {
  let app: TestApp
  let resizeCalls: Array<{ id: string; cols: number; rows: number }>
  let attachReply: unknown

  beforeEach(async () => {
    app = await bootTestApp()
    resizeCalls = []
    attachReply = { ok: true, cols: 120, rows: 30 }
    termInstances.length = 0
    fitCalls.length = 0
    proposedRows = 40
    MockResizeObserver.last = null
    ;(global as never as { ResizeObserver: unknown }).ResizeObserver = MockResizeObserver
    ;(global as never as { requestAnimationFrame: unknown }).requestAnimationFrame = (
      cb: FrameRequestCallback
    ): number => {
      cb(0)
      return 0
    }

    app.bridge.ipcMain.handle('terminal:write', async () => {})
    app.bridge.ipcMain.handle(
      'terminal:resize',
      async (_e, id: string, cols: number, rows: number) => {
        resizeCalls.push({ id, cols, rows })
      }
    )
    app.bridge.ipcMain.handle('terminal:attach', async () => attachReply)
    app.bridge.ipcMain.handle('terminal:detach', async () => {})
  })

  afterEach(() => {
    app.teardown()
  })

  async function mount(
    props: { mirrorGrid?: boolean } = { mirrorGrid: true }
  ): Promise<ReturnType<typeof render>> {
    const { XTermInstance } = await import('../XTermInstance')
    let view!: ReturnType<typeof render>
    await act(async () => {
      view = render(
        React.createElement(XTermInstance, { terminalId: 'term-m', isActive: true, ...props })
      )
      // Let the attach promise (and its continuation) settle.
      await new Promise((r) => setTimeout(r, 0))
    })
    return view
  }

  /** The xterm host element, with a non-zero width jsdom would not give it. */
  function hostEl(view: ReturnType<typeof render>): HTMLElement {
    const el = view.container.querySelector('[data-testid="XTermInstance"]') as HTMLElement
    Object.defineProperty(el, 'offsetWidth', { value: 390, configurable: true })
    return el
  }

  // ---------------------------------------------------------------------------
  // Sizing
  // ---------------------------------------------------------------------------

  it('pushes NOTHING before the attach reply, then adopts the pty cols with its own rows', async () => {
    const view = await mount()
    const term = termInstances[0]

    // The whole point: the pre-attach fit is suppressed. A push here would carry
    // xterm's 80-column default and shrink whatever the desktop is running.
    expect(fitCalls).toHaveLength(0)
    expect(term.cols).toBe(120)
    expect(term.rows).toBe(40)
    // Rows are still last-writer-wins, so the pty is told what this box shows.
    expect(resizeCalls).toEqual([{ id: 'term-m', cols: 120, rows: 40 }])
    expect(view.container.querySelector('[data-testid="XTermInstance.panWrapper"]')).not.toBeNull()
  })

  it('does not push at all when its rows already match the pty', async () => {
    proposedRows = 30
    await mount()
    expect(termInstances[0].cols).toBe(120)
    expect(resizeCalls).toEqual([])
  })

  it('adopts cols from terminal:resized and pushes back ROWS ONLY', async () => {
    await mount()
    const term = termInstances[0]
    resizeCalls.length = 0

    await act(async () => {
      app.emit('terminal:resized', { terminalId: 'term-m', cols: 132, rows: 25 })
    })

    expect(term.cols).toBe(132)
    expect(term.rows).toBe(40)
    // The cols in the push are the pty's own, echoed back unchanged — this
    // surface never originates a width.
    expect(resizeCalls).toEqual([{ id: 'term-m', cols: 132, rows: 40 }])
  })

  it('ignores a resized notice for a different terminal', async () => {
    await mount()
    resizeCalls.length = 0
    await act(async () => {
      app.emit('terminal:resized', { terminalId: 'other', cols: 200, rows: 10 })
    })
    expect(termInstances[0].cols).toBe(120)
    expect(resizeCalls).toEqual([])
  })

  /**
   * The termination guard.
   *
   * Two mirroring surfaces (a phone plus a narrow Electron window) with
   * different heights would otherwise counter-push rows at each other forever:
   * A pushes its rows, B is told, B pushes ITS rows, A is told, … A notice whose
   * COLS are unchanged is therefore not acted on — which also swallows the echo
   * of our own push.
   */
  it('never counter-pushes for a rows-only notice (no two-client resize storm)', async () => {
    await mount()
    resizeCalls.length = 0

    // Our own push coming back.
    await act(async () => {
      app.emit('terminal:resized', { terminalId: 'term-m', cols: 120, rows: 40 })
    })
    // Another mirroring client with a taller viewport.
    await act(async () => {
      app.emit('terminal:resized', { terminalId: 'term-m', cols: 120, rows: 55 })
    })

    expect(resizeCalls).toEqual([])
    expect(termInstances[0].rows).toBe(40)
  })

  it('refits ROWS ONLY when its own box changes', async () => {
    const view = await mount()
    hostEl(view)
    resizeCalls.length = 0
    proposedRows = 22

    await act(async () => {
      MockResizeObserver.last!.trigger()
    })

    expect(fitCalls, 'a mirroring surface must never fit its cols').toHaveLength(0)
    expect(termInstances[0].cols).toBe(120)
    expect(resizeCalls).toEqual([{ id: 'term-m', cols: 120, rows: 22 }])
  })

  it('falls back to fitting BOTH axes against a host that reports no geometry', async () => {
    // Version skew: a pre-ADR-060 host answers `true` and never sends
    // `terminal:resized`, so there is nothing to mirror.
    attachReply = true
    const view = await mount()
    const term = termInstances[0]

    expect(fitCalls.length).toBeGreaterThanOrEqual(1)
    expect(term.cols).toBe(48)
    expect(resizeCalls).toEqual([{ id: 'term-m', cols: 48, rows: 40 }])

    // …and it keeps fitting both axes afterwards rather than waiting forever for
    // a geometry push that is never coming.
    hostEl(view)
    resizeCalls.length = 0
    proposedRows = 22
    await act(async () => {
      MockResizeObserver.last!.trigger()
    })
    expect(resizeCalls).toEqual([{ id: 'term-m', cols: 48, rows: 22 }])
  })

  it('does nothing for a stale tab (the terminal is gone)', async () => {
    attachReply = { ok: false }
    await mount()
    expect(fitCalls).toHaveLength(0)
    expect(resizeCalls).toEqual([])
  })

  // ---------------------------------------------------------------------------
  // The desktop regime is untouched
  // ---------------------------------------------------------------------------

  it('without mirrorGrid: fits both axes on mount, no pan wrapper, ignores resized', async () => {
    const view = await mount({})
    expect(view.container.querySelector('[data-testid="XTermInstance.panWrapper"]')).toBeNull()
    expect(fitCalls).toHaveLength(1)
    expect(resizeCalls).toEqual([{ id: 'term-m', cols: 48, rows: 40 }])

    resizeCalls.length = 0
    await act(async () => {
      app.emit('terminal:resized', { terminalId: 'term-m', cols: 132, rows: 25 })
    })
    // Fit-driven surfaces do not react — that asymmetry is what keeps the two
    // regimes from resizing each other.
    expect(termInstances[0].cols).toBe(48)
    expect(resizeCalls).toEqual([])
  })

  // ---------------------------------------------------------------------------
  // Touch scrolling
  // ---------------------------------------------------------------------------

  describe('touch scrolling', () => {
    /** Every wheel event that reached the xterm host. */
    function wheelSpy(el: HTMLElement): WheelEvent[] {
      const seen: WheelEvent[] = []
      el.addEventListener('wheel', (e) => seen.push(e as WheelEvent))
      return seen
    }

    it('turns a claimed vertical drag into wheel events and preventDefaults the move', async () => {
      const view = await mount()
      const el = hostEl(view)
      const wheels = wheelSpy(el)

      el.dispatchEvent(touch('touchstart', [{ clientX: 100, clientY: 400 }]))
      // Past the 8px slop: claimed here, and the slop itself is not scroll.
      const claim = touch('touchmove', [{ clientX: 100, clientY: 380 }])
      el.dispatchEvent(claim)
      const drag = touch('touchmove', [{ clientX: 100, clientY: 360 }])
      el.dispatchEvent(drag)

      expect(claim.defaultPrevented, 'a claimed gesture must not also scroll the page').toBe(true)
      expect(drag.defaultPrevented).toBe(true)
      expect(wheels).toHaveLength(1)
      // Dragging UP (clientY decreasing) is a wheel scrolling DOWN: positive
      // deltaY, matching a real wheel.
      expect(wheels[0].deltaY).toBeGreaterThan(0)
      expect(wheels[0].deltaMode).toBe(0)
      // The legacy alias xterm's normal-buffer path actually reads. Opposite
      // sign to `deltaY`, exactly as a real Chromium wheel event has it — see
      // terminal-touch-scroll.ts.
      expect((wheels[0] as unknown as { wheelDeltaY: number }).wheelDeltaY).toBeLessThan(0)
    })

    it('drag DOWN scrolls back through history (negative deltaY)', async () => {
      const view = await mount()
      const el = hostEl(view)
      const wheels = wheelSpy(el)

      el.dispatchEvent(touch('touchstart', [{ clientX: 100, clientY: 300 }]))
      el.dispatchEvent(touch('touchmove', [{ clientX: 100, clientY: 320 }]))
      el.dispatchEvent(touch('touchmove', [{ clientX: 100, clientY: 340 }]))

      expect(wheels).toHaveLength(1)
      expect(wheels[0].deltaY).toBeLessThan(0)
    })

    it('leaves a TAP alone — it is what focuses the terminal', async () => {
      const view = await mount()
      const el = hostEl(view)
      const wheels = wheelSpy(el)

      const start = touch('touchstart', [{ clientX: 100, clientY: 400 }])
      el.dispatchEvent(start)
      const jitter = touch('touchmove', [{ clientX: 102, clientY: 397 }])
      el.dispatchEvent(jitter)
      el.dispatchEvent(touch('touchend', []))

      expect(start.defaultPrevented).toBe(false)
      expect(jitter.defaultPrevented, 'sub-slop movement must stay a tap').toBe(false)
      expect(wheels).toEqual([])
    })

    it('yields a HORIZONTAL drag to the browser (that axis is the pan container)', async () => {
      const view = await mount()
      const el = hostEl(view)
      const wheels = wheelSpy(el)

      el.dispatchEvent(touch('touchstart', [{ clientX: 100, clientY: 400 }]))
      const pan = touch('touchmove', [{ clientX: 140, clientY: 404 }])
      el.dispatchEvent(pan)
      // Even a later vertical component stays with the browser: the axis is
      // locked for the whole gesture, so a diagonal cannot fight the pan.
      const more = touch('touchmove', [{ clientX: 160, clientY: 340 }])
      el.dispatchEvent(more)

      expect(pan.defaultPrevented).toBe(false)
      expect(more.defaultPrevented).toBe(false)
      expect(wheels).toEqual([])
    })

    it('is not installed on the desktop surface', async () => {
      const view = await mount({})
      const el = hostEl(view)
      const wheels = wheelSpy(el)

      el.dispatchEvent(touch('touchstart', [{ clientX: 100, clientY: 400 }]))
      el.dispatchEvent(touch('touchmove', [{ clientX: 100, clientY: 340 }]))

      expect(wheels).toEqual([])
    })

    it('stops listening once the instance is torn down', async () => {
      const view = await mount()
      const el = hostEl(view)
      const wheels = wheelSpy(el)
      await act(async () => {
        view.unmount()
        await new Promise((r) => setTimeout(r, 0))
      })

      el.dispatchEvent(touch('touchstart', [{ clientX: 100, clientY: 400 }]))
      el.dispatchEvent(touch('touchmove', [{ clientX: 100, clientY: 340 }]))
      expect(wheels).toEqual([])
    })
  })
})
