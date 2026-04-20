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

/* eslint-disable @typescript-eslint/no-explicit-any */

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
  focus = vi.fn()
  dispose = vi.fn()
  loadAddon = vi.fn()
  open = vi.fn()

  onData(cb: (data: string) => void): { dispose: () => void } {
    dataCallbacks.push(cb)
    return { dispose: () => { dataCallbacks = dataCallbacks.filter((c) => c !== cb) } }
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
  } as any,
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn()
  } as any,
}))

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

describe('XTermInstance', () => {
  let app: TestApp
  let writeCalls: Array<{ id: string; data: string }>
  let resizeCalls: Array<{ id: string; cols: number; rows: number }>

  beforeEach(async () => {
    app = await bootTestApp()
    writeCalls = []
    resizeCalls = []
    termInstances.length = 0
    dataCallbacks = []

    ;(global as any).ResizeObserver = MockResizeObserver
    // requestAnimationFrame fires synchronously in jsdom
    ;(global as any).requestAnimationFrame = (cb: FrameRequestCallback) => { cb(0); return 0 }

    app.bridge.ipcMain.handle('terminal:write', async (_e, id: string, data: string) => {
      writeCalls.push({ id, data })
    })
    app.bridge.ipcMain.handle('terminal:resize', async (_e, id: string, cols: number, rows: number) => {
      resizeCalls.push({ id, cols, rows })
    })
  })

  afterEach(() => {
    app.teardown()
  })

  async function renderFC(terminalId = 'term-1', isActive = true): Promise<void> {
    const { XTermInstance } = await import('../XTermInstance')
    await act(async () => {
      render(React.createElement(XTermInstance, { terminalId, isActive }))
    })
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

  it('syncs initial size to PTY via resizeTerminal IPC', async () => {
    await renderFC('term-xyz')
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    expect(resizeCalls.length).toBeGreaterThanOrEqual(1)
    expect(resizeCalls[0].id).toBe('term-xyz')
  })
})
