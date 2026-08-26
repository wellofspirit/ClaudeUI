/**
 * Layer 2: Component tests for XTermInstance.
 *
 * XTermInstance is a thin wrapper around xterm.js — no meaningful FC/View
 * split is possible (all logic lives in effects bridging xterm to IPC). We
 * mock the xterm Terminal class to verify the IPC wiring.
 *
 * Tested flows:
 *   1. user-typed data (onData callback) → writeTerminal IPC
 *   2. terminal:data event from main → term.write
 *   3. initial size syncs to PTY via resizeTerminal IPC
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, act } from '@testing-library/react'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'

// Capture xterm instances created during the test so we can drive them
const termInstances: MockTerm[] = []
let dataCallbacks: Array<(data: string) => void> = []

class MockTerm {
  cols = 80
  rows = 24
  options: Record<string, unknown> = {}
  write = vi.fn()
  reset = vi.fn()
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
}

class MockResizeObserver {
  observe(): void {}
  disconnect(): void {}
}

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    constructor() {
      const inst = new MockTerm()
      termInstances.push(inst)
      return inst as any
    }
  } as any
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn()
  } as any
}))

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

describe('XTermInstance', () => {
  let app: TestApp
  let writeCalls: Array<{ id: string; data: string }>
  let resizeCalls: Array<{ id: string; cols: number; rows: number }>
  let attachCalls: string[]
  let detachCalls: string[]

  beforeEach(async () => {
    app = await bootTestApp()
    writeCalls = []
    resizeCalls = []
    attachCalls = []
    detachCalls = []
    termInstances.length = 0
    dataCallbacks = []
    ;(global as any).ResizeObserver = MockResizeObserver
    // requestAnimationFrame fires synchronously in jsdom
    ;(global as any).requestAnimationFrame = (cb: FrameRequestCallback) => {
      cb(0)
      return 0
    }

    app.bridge.ipcMain.handle('terminal:write', async (_e, id: string, data: string) => {
      writeCalls.push({ id, data })
    })
    app.bridge.ipcMain.handle(
      'terminal:resize',
      async (_e, id: string, cols: number, rows: number) => {
        resizeCalls.push({ id, cols, rows })
      }
    )
    app.bridge.ipcMain.handle('terminal:attach', async (_e, id: string) => {
      attachCalls.push(id)
      return true
    })
    app.bridge.ipcMain.handle('terminal:detach', async (_e, id: string) => {
      detachCalls.push(id)
    })
  })

  afterEach(() => {
    app.teardown()
  })

  async function renderFC(
    terminalId = 'term-1',
    isActive = true,
    extra: { readOnly?: boolean; onBlockedInput?: () => void } = {}
  ): Promise<{ rerender: (props: Record<string, unknown>) => void }> {
    const { XTermInstance } = await import('../XTermInstance')
    let view!: ReturnType<typeof render>
    await act(async () => {
      view = render(React.createElement(XTermInstance, { terminalId, isActive, ...extra }))
    })
    return {
      rerender: (props) =>
        view.rerender(
          React.createElement(XTermInstance, { terminalId, isActive, ...extra, ...props } as never)
        )
    }
  }

  it('forwards user input to writeTerminal IPC', async () => {
    await renderFC('term-xyz')

    // Simulate xterm calling the onData callback (user typed)
    await act(async () => {
      dataCallbacks[0]?.('hello\r')
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(writeCalls).toEqual([{ id: 'term-xyz', data: 'hello\r' }])
  })

  it('writes terminal:data events to the xterm instance', async () => {
    await renderFC('term-xyz')

    const term = termInstances[0]
    term.write.mockClear()

    await act(async () => {
      app.emit('terminal:data', { terminalId: 'term-xyz', data: 'from pty' })
    })

    expect(term.write).toHaveBeenCalledWith('from pty')
  })

  it('ignores terminal:data events for a different terminalId', async () => {
    await renderFC('term-xyz')

    const term = termInstances[0]
    term.write.mockClear()

    await act(async () => {
      app.emit('terminal:data', { terminalId: 'other-term', data: 'not mine' })
    })

    expect(term.write).not.toHaveBeenCalled()
  })

  // A `replay` chunk is the server's scrollback ring — the terminal's WHOLE
  // history. The desktop lane is a broadcast, so some of those bytes may already
  // be on screen, and the clear that makes the delivery idempotent must travel
  // IN THE STREAM (RIS, `ESC c`), not as an out-of-band `term.reset()`.
  //
  // Why the shape and not just the effect: xterm's `write()` is deferred (it
  // queues into a WriteBuffer drained on a later task) while `reset()` is
  // synchronous and does NOT discard that queue. `reset(); write(replay)` in a
  // batch that also carried a live chunk therefore clears an empty screen and
  // then draws live+replay — double scrollback in exactly the race the flag
  // exists to close. A mock cannot reproduce that timing, so this pins the only
  // thing that distinguishes the two implementations: WHAT is written.
  it('prefixes a replay chunk with RIS in-band instead of calling reset()', async () => {
    await renderFC('term-xyz')
    const term = termInstances[0]
    term.write.mockClear()
    term.reset.mockClear()

    await act(async () => {
      app.emit('terminal:data', { terminalId: 'term-xyz', data: 'live' })
      app.emit('terminal:data', { terminalId: 'term-xyz', data: 'live+history', replay: true })
      app.emit('terminal:data', { terminalId: 'term-xyz', data: 'after' })
    })

    // The out-of-band reset is the bug — its absence is the fix.
    expect(term.reset).not.toHaveBeenCalled()

    const written = term.write.mock.calls.map((c) => c[0] as string)
    expect(written).toHaveLength(3)
    // Live chunks go through verbatim: no clear, nothing prepended.
    expect(written[0]).toBe('live')
    expect(written[2]).toBe('after')
    // The replay carries its own clear, ahead of the history it replaces.
    expect(written[1].startsWith('\x1bc')).toBe(true)
    expect(written[1]).toBe('\x1bclive+history')
  })

  // Attach is what makes a tab render a pty it did not spawn (per-cwd pool), and
  // it must be registered AFTER the data listener so the replay is not missed.
  it('attaches on mount and detaches on unmount', async () => {
    const { XTermInstance } = await import('../XTermInstance')
    let view: ReturnType<typeof render>
    await act(async () => {
      view = render(React.createElement(XTermInstance, { terminalId: 'term-pool', isActive: true }))
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(attachCalls).toEqual(['term-pool'])

    await act(async () => {
      view!.unmount()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(detachCalls).toEqual(['term-pool'])
  })

  it('syncs initial size to PTY via resizeTerminal IPC', async () => {
    await renderFC('term-xyz')
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(resizeCalls.length).toBeGreaterThanOrEqual(1)
    expect(resizeCalls[0].id).toBe('term-xyz')
  })
  /**
   * ADR-054's read/act split at the keyboard.
   *
   * The server drops a stale `term-input` frame SILENTLY — an error would be an
   * oracle for which terminals exist — so a read-only view cannot learn from a
   * refusal and has to hold the key back itself.
   */
  describe('read-only input gating (ADR-054 series 2)', () => {
    it('holds the keystroke back and asks for a proof instead', async () => {
      const onBlockedInput = vi.fn()
      await renderFC('term-ro', true, { readOnly: true, onBlockedInput })
      const type = dataCallbacks[dataCallbacks.length - 1]

      await act(async () => {
        type?.('ls\r')
        await new Promise((r) => setTimeout(r, 0))
      })

      expect(writeCalls, 'a refused keystroke must never reach the pty').toEqual([])
      expect(onBlockedInput).toHaveBeenCalledTimes(1)
    })

    it('DROPS the key rather than buffering it across the ceremony', async () => {
      // Replaying what was typed at a shell whose state has moved on is worse
      // than making the user retype one command.
      const onBlockedInput = vi.fn()
      const { rerender } = await renderFC('term-ro', true, { readOnly: true, onBlockedInput })
      const type = dataCallbacks[dataCallbacks.length - 1]
      await act(async () => {
        type?.('rm -rf /\r')
        await new Promise((r) => setTimeout(r, 0))
      })

      await act(async () => {
        rerender({ readOnly: false })
        await new Promise((r) => setTimeout(r, 0))
      })
      expect(writeCalls).toEqual([])
    })

    it('types again once the gate opens — WITHOUT re-mounting the terminal', async () => {
      // The mount effect keys on `terminalId` alone and must not re-run: tearing
      // it down would drop the pty attachment and the scrollback with it. So the
      // handler installed once has to see the CURRENT gate, not the mount-time
      // one.
      const { rerender } = await renderFC('term-ro', true, { readOnly: true })
      const mounted = termInstances.length
      // The handler of the view THIS case mounted: the suite does not unmount
      // between cases, so index 0 belongs to the first test's terminal.
      const type = dataCallbacks[dataCallbacks.length - 1]

      // Two steps, deliberately: the gate has to be COMMITTED before the key
      // arrives, which is the ordering the real panel produces (availability
      // refresh, re-render, then the user types again).
      await act(async () => {
        rerender({ readOnly: false })
      })
      await act(async () => {
        type?.('echo hi\r')
        await new Promise((r) => setTimeout(r, 0))
      })

      expect(writeCalls).toEqual([{ id: 'term-ro', data: 'echo hi\r' }])
      expect(termInstances.length, 'the pty view must survive the gate opening').toBe(mounted)
    })
  })
})
