/**
 * @vitest-environment jsdom
 *
 * ADR-102 — the REAL preload's progress plumbing: `loadSessionHistory` rides
 * `invoke:with-progress` only when a callback is given, `invoke:progress`
 * messages are routed to the call that owns the id, and the raw
 * `invokeWithProgress` is not part of the surface handed to the main world.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => {
  const listeners = new Map<string, Array<(event: unknown, ...args: unknown[]) => void>>()
  return {
    listeners,
    exposed: {} as Record<string, unknown>,
    ipcRenderer: {
      invoke: vi.fn(),
      send: vi.fn(),
      sendSync: vi.fn(),
      on: vi.fn((channel: string, fn: (event: unknown, ...args: unknown[]) => void) => {
        listeners.set(channel, [...(listeners.get(channel) ?? []), fn])
      }),
      removeListener: vi.fn()
    }
  }
})
vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, api: unknown) => {
      electron.exposed[name] = api
    }
  },
  ipcRenderer: electron.ipcRenderer
}))

type Api = {
  loadSessionHistory: (
    sessionId: string,
    projectKey: string,
    resumeSessionAt?: string,
    onProgress?: (p: unknown) => void
  ) => Promise<unknown>
}
let api: Api

/** Deliver one `invoke:progress` message to every router listener, as main would. */
function emitProgress(callId: unknown, progress: unknown): void {
  for (const fn of electron.listeners.get('invoke:progress') ?? []) fn({}, callId, progress)
}

beforeEach(async () => {
  vi.resetModules()
  electron.listeners.clear()
  electron.ipcRenderer.invoke.mockReset()
  Object.defineProperty(process, 'contextIsolated', { value: true, configurable: true })
  await import('../index')
  api = electron.exposed.api as Api
})

afterEach(() => {
  Object.defineProperty(process, 'contextIsolated', { value: undefined, configurable: true })
})

describe('preload — loadSessionHistory progress', () => {
  it('without a callback it is the plain invoke, byte for byte', async () => {
    electron.ipcRenderer.invoke.mockResolvedValue({ messages: [] })
    await api.loadSessionHistory('sid', 'pk', 'anchor')
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledTimes(1)
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(
      'session:load-history',
      'sid',
      'pk',
      'anchor'
    )
  })

  it('with a callback it rides invoke:with-progress and routes progress by call id', async () => {
    let finish!: (v: unknown) => void
    electron.ipcRenderer.invoke.mockReturnValue(new Promise((r) => (finish = r)))
    const a = vi.fn()
    const b = vi.fn()
    const pa = api.loadSessionHistory('sid-a', 'pk', undefined, a)
    const pb = api.loadSessionHistory('sid-b', 'pk', undefined, b)

    const [[chA, idA, channelA, ...argsA], [, idB]] = electron.ipcRenderer.invoke.mock.calls
    expect(chA).toBe('invoke:with-progress')
    expect(channelA).toBe('session:load-history')
    expect(argsA).toEqual(['sid-a', 'pk', undefined])
    expect(idA).not.toBe(idB)

    emitProgress(idA, { done: 1, total: 4, phase: 'transcript' })
    emitProgress(idB, { done: 3, total: 4, phase: 'costs' })
    expect(a).toHaveBeenCalledTimes(1)
    expect(a).toHaveBeenCalledWith({ done: 1, total: 4, phase: 'transcript' })
    expect(b).toHaveBeenCalledWith({ done: 3, total: 4, phase: 'costs' })

    finish({ messages: [] })
    await Promise.all([pa, pb])
    // The listener is gone once the call settles: a late message is dropped.
    emitProgress(idA, { done: 4, total: 4, phase: 'sending' })
    expect(a).toHaveBeenCalledTimes(1)
  })

  it('drops the listener when the call rejects, and ignores a non-string id', async () => {
    electron.ipcRenderer.invoke.mockRejectedValue(new Error('boom'))
    const onProgress = vi.fn()
    await expect(api.loadSessionHistory('s', 'pk', undefined, onProgress)).rejects.toThrow('boom')
    const id = electron.ipcRenderer.invoke.mock.calls[0][1]
    emitProgress(id, { done: 1, total: 2, phase: 'x' })
    emitProgress(42, { done: 1, total: 2, phase: 'x' })
    expect(onProgress).not.toHaveBeenCalled()
  })

  it('does not expose the raw progress channel on the context bridge (N3)', () => {
    expect(Object.keys(electron.exposed.api as object)).not.toContain('invokeWithProgress')
  })
})
