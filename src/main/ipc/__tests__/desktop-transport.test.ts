/**
 * @vitest-environment node
 *
 * ADR-102 — the desktop half of invoke progress: the `invoke:with-progress`
 * ipcMain channel. Electron is mocked down to `ipcMain`'s handler table, so the
 * REAL binder runs and the real registry dispatches; what is pinned here is the
 * reporter's addressing (the calling window only), its lifecycle (flushed, then
 * closed, BEFORE the invoke resolves) and the destroyed-sender guard.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers, ipcMainMock } = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  return {
    handlers,
    ipcMainMock: {
      handle: vi.fn((channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
        if (handlers.has(channel)) throw new Error(`second handler for '${channel}'`)
        handlers.set(channel, fn)
      }),
      removeHandler: vi.fn((channel: string) => {
        handlers.delete(channel)
      })
    }
  }
})
vi.mock('electron', () => ({ ipcMain: ipcMainMock }))
vi.mock('../../../core/services/db', () => ({ appendAuditLog: vi.fn() }))
vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import { installDesktopTransport } from '../desktop-transport'
import { handleIpc, setDesktopTransportBinder } from '../../../core/ipc/desktop-transport-binding'
import { commandRegistry } from '../../../core/ipc/command-registry'
import type { ProgressReporter } from '../../../shared/remote-protocol'

const WITH = 'invoke:with-progress'
const CHANNEL = 'test:desktop-progress'

function fakeSender(destroyed = false): {
  send: ReturnType<typeof vi.fn>
  isDestroyed: () => boolean
  destroy: () => void
} {
  let dead = destroyed
  return { send: vi.fn(), isDestroyed: () => dead, destroy: () => (dead = true) }
}

/** Invoke the bound `invoke:with-progress` handler the way Electron would. */
function invokeWithProgress(sender: unknown, ...args: unknown[]): Promise<unknown> {
  return Promise.resolve(handlers.get(WITH)!({ sender }, ...args))
}

beforeEach(() => {
  vi.useFakeTimers()
  handlers.clear()
  ipcMainMock.handle.mockClear()
  ipcMainMock.removeHandler.mockClear()
  installDesktopTransport()
})

afterEach(() => {
  vi.useRealTimers()
  setDesktopTransportBinder(null)
  commandRegistry.reset()
})

describe('invoke:with-progress (desktop transport)', () => {
  it('is bound once on install, and a second install replaces rather than throws', () => {
    expect(handlers.has(WITH)).toBe(true)
    expect(() => installDesktopTransport()).not.toThrow()
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith(WITH)
  })

  it('sends progress to the calling window only, with the call id, and flushes the tail before resolving', async () => {
    handleIpc({
      channel: CHANNEL,
      capability: 'fs-read',
      kind: 'query',
      withProgress: true,
      handler: async (progress: ProgressReporter, arg: string) => {
        progress({ done: 0, total: 10, phase: 'transcript' })
        progress({ done: 6, total: 10, phase: 'costs' }) // throttled away...
        return `loaded ${arg}`
      }
    })
    const sender = fakeSender()
    const result = await invokeWithProgress(sender, 'call-1', CHANNEL, 'x')

    expect(result).toBe('loaded x')
    // ...and flushed by the transport before the invoke settled.
    expect(sender.send.mock.calls).toEqual([
      ['invoke:progress', 'call-1', { done: 0, total: 10, phase: 'transcript' }],
      ['invoke:progress', 'call-1', { done: 6, total: 10, phase: 'costs' }]
    ])
    // Closed: nothing trails the resolution, even once the interval elapses.
    vi.advanceTimersByTime(1000)
    expect(sender.send).toHaveBeenCalledTimes(2)
  })

  it('a destroyed sender (window reload mid-load) stops reporting without failing the call', async () => {
    const sender = fakeSender()
    handleIpc({
      channel: CHANNEL,
      capability: 'fs-read',
      kind: 'query',
      withProgress: true,
      handler: async (progress: ProgressReporter) => {
        progress({ done: 0, total: 10, phase: 'transcript' })
        sender.destroy()
        vi.advanceTimersByTime(1000)
        progress({ done: 5, total: 10, phase: 'transcript' })
        return 'ok'
      }
    })
    await expect(invokeWithProgress(sender, 'call-2', CHANNEL)).resolves.toBe('ok')
    expect(sender.send).toHaveBeenCalledTimes(1)
  })

  it('rejects a non-string call id or channel before dispatching anything', async () => {
    const sender = fakeSender()
    await expect(invokeWithProgress(sender, 7, CHANNEL)).rejects.toThrow(/must be strings/)
    await expect(invokeWithProgress(sender, 'c', { toString: () => CHANNEL })).rejects.toThrow(
      /must be strings/
    )
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('still goes through the registry: an unknown channel is refused, not invented', async () => {
    await expect(invokeWithProgress(fakeSender(), 'c', 'no:such-channel')).rejects.toThrow(
      /Channel not available/
    )
  })

  it('a channel without withProgress works and sends no progress', async () => {
    handleIpc({
      channel: CHANNEL,
      capability: 'fs-read',
      kind: 'query',
      handler: async (arg: string) => `plain ${arg}`
    })
    const sender = fakeSender()
    await expect(invokeWithProgress(sender, 'c', CHANNEL, 'y')).resolves.toBe('plain y')
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('a failing handler rejects and drops its pending tail', async () => {
    handleIpc({
      channel: CHANNEL,
      capability: 'fs-read',
      kind: 'query',
      withProgress: true,
      handler: async (progress: ProgressReporter) => {
        progress({ done: 0, total: 10, phase: 'transcript' })
        progress({ done: 4, total: 10, phase: 'transcript' })
        throw new Error('boom')
      }
    })
    const sender = fakeSender()
    await expect(invokeWithProgress(sender, 'c', CHANNEL)).rejects.toThrow('boom')
    vi.advanceTimersByTime(1000)
    expect(sender.send).toHaveBeenCalledTimes(1)
  })
})
