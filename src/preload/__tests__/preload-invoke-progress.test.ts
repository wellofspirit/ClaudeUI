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
    onProgress?: (p: unknown) => void,
    options?: { deferStatusLine?: boolean }
  ) => Promise<unknown>
  loadSessionStatusLine: (
    sessionId: string,
    projectKey: string,
    onProgress?: (p: unknown) => void
  ) => Promise<unknown>
  removeWorktrees: (
    cwd: string,
    ids: string[],
    onProgress?: (p: unknown) => void
  ) => Promise<unknown>
  measureWorktree: (cwd: string, id: string, onProgress?: (p: unknown) => void) => Promise<unknown>
  removeWorktree: (worktreePath: string, branch: string, gitRoot: string) => Promise<unknown>
  inventoryWorktrees: (cwd: string) => Promise<unknown>
  confirmQuit: (removeWorktreePaths?: string[]) => Promise<void>
  ackQuitPrompt: () => Promise<void>
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

  it('carries the Arc 2 options as a 4th wire arg ONLY when given (the 3-arg call stays exact)', async () => {
    electron.ipcRenderer.invoke.mockResolvedValue({ messages: [] })
    await api.loadSessionHistory('sid', 'pk', undefined, undefined, { deferStatusLine: true })
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(
      'session:load-history',
      'sid',
      'pk',
      undefined,
      { deferStatusLine: true }
    )

    await api.loadSessionHistory('sid', 'pk', 'anchor')
    expect(electron.ipcRenderer.invoke.mock.lastCall).toEqual([
      'session:load-history',
      'sid',
      'pk',
      'anchor'
    ])

    // With a callback too: the options ride inside invoke:with-progress's wire args.
    await api.loadSessionHistory('sid', 'pk', undefined, vi.fn(), { deferStatusLine: true })
    const [channel, , inner, ...wire] = electron.ipcRenderer.invoke.mock.lastCall!
    expect(channel).toBe('invoke:with-progress')
    expect(inner).toBe('session:load-history')
    expect(wire).toEqual(['sid', 'pk', undefined, { deferStatusLine: true }])
  })

  it('loadSessionStatusLine is a plain invoke, or invoke:with-progress with a callback', async () => {
    electron.ipcRenderer.invoke.mockResolvedValue({ totalCostUsd: 1 })
    await api.loadSessionStatusLine('sid', 'pk')
    expect(electron.ipcRenderer.invoke.mock.lastCall).toEqual([
      'session:load-status-line',
      'sid',
      'pk'
    ])

    let finish!: (v: unknown) => void
    electron.ipcRenderer.invoke.mockReturnValue(new Promise((r) => (finish = r)))
    const onProgress = vi.fn()
    const p = api.loadSessionStatusLine('sid', 'pk', onProgress)
    const [channel, callId, inner, ...wire] = electron.ipcRenderer.invoke.mock.lastCall!
    expect(channel).toBe('invoke:with-progress')
    expect(inner).toBe('session:load-status-line')
    expect(wire).toEqual(['sid', 'pk'])
    emitProgress(callId, { done: 2, total: 8, phase: 'costs' })
    expect(onProgress).toHaveBeenCalledWith({ done: 2, total: 8, phase: 'costs' })
    finish({ totalCostUsd: 1 })
    await p
  })

  // ADR-112 — the worktree manager. These channels answer the safeHandler envelope, and the
  // progress path returns it raw, so the wrapper must unwrap it itself.
  it('removeWorktrees: plain invoke without a callback; with one it rides invoke:with-progress and unwraps the envelope', async () => {
    electron.ipcRenderer.invoke.mockResolvedValue({
      ok: true,
      data: [{ id: 'a', outcome: 'removed' }]
    })
    await expect(api.removeWorktrees('/repo', ['a'])).resolves.toEqual([
      { id: 'a', outcome: 'removed' }
    ])
    expect(electron.ipcRenderer.invoke.mock.lastCall).toEqual([
      'worktree:remove-many',
      '/repo',
      ['a']
    ])

    const onProgress = vi.fn()
    await expect(api.removeWorktrees('/repo', ['a'], onProgress)).resolves.toEqual([
      { id: 'a', outcome: 'removed' }
    ])
    const [channel, callId, inner, ...wire] = electron.ipcRenderer.invoke.mock.lastCall!
    expect(channel).toBe('invoke:with-progress')
    expect(inner).toBe('worktree:remove-many')
    expect(wire).toEqual(['/repo', ['a']])
    expect(typeof callId).toBe('string')
  })

  it('the legacy removeWorktree always rides invoke:with-progress (its channel is withProgress) and unwraps the envelope', async () => {
    electron.ipcRenderer.invoke.mockResolvedValue({
      ok: true,
      data: { id: '/wt', outcome: 'removed' }
    })
    await expect(api.removeWorktree('/wt', 'feat', '/repo')).resolves.toEqual({
      id: '/wt',
      outcome: 'removed'
    })
    const [channel, callId, inner, ...wire] = electron.ipcRenderer.invoke.mock.lastCall!
    expect(channel).toBe('invoke:with-progress')
    expect(inner).toBe('worktree:remove')
    expect(wire).toEqual(['/wt', 'feat', '/repo'])
    expect(typeof callId).toBe('string')

    electron.ipcRenderer.invoke.mockResolvedValue({ ok: false, error: 'refused' })
    await expect(api.removeWorktree('/wt', 'feat', '/repo')).rejects.toThrow('refused')
  })

  it('measureWorktree with a callback rejects with the handler’s error, not an envelope', async () => {
    electron.ipcRenderer.invoke.mockResolvedValue({ ok: false, error: 'worktree not found: x' })
    await expect(api.measureWorktree('/repo', 'x', vi.fn())).rejects.toThrow(
      'worktree not found: x'
    )
    expect(electron.ipcRenderer.invoke.mock.lastCall![2]).toBe('worktree:measure')
  })

  it('inventoryWorktrees is a plain unwrapped invoke', async () => {
    electron.ipcRenderer.invoke.mockResolvedValue({ ok: true, data: { entries: [] } })
    await expect(api.inventoryWorktrees('/repo')).resolves.toEqual({ entries: [] })
    expect(electron.ipcRenderer.invoke.mock.lastCall).toEqual(['worktree:inventory', '/repo'])
  })

  it('confirmQuit sends the worktree paths (an empty list when none)', async () => {
    electron.ipcRenderer.invoke.mockResolvedValue(undefined)
    await api.confirmQuit()
    expect(electron.ipcRenderer.invoke.mock.lastCall).toEqual(['app:quit-confirm', []])
    await api.confirmQuit(['/repo/.claude/worktrees/a'])
    expect(electron.ipcRenderer.invoke.mock.lastCall).toEqual([
      'app:quit-confirm',
      ['/repo/.claude/worktrees/a']
    ])
  })

  it('ackQuitPrompt invokes app:quit-prompting', async () => {
    electron.ipcRenderer.invoke.mockResolvedValue(undefined)
    await api.ackQuitPrompt()
    expect(electron.ipcRenderer.invoke.mock.lastCall).toEqual(['app:quit-prompting'])
  })

  it('does not expose the raw progress channel on the context bridge (N3)', () => {
    expect(Object.keys(electron.exposed.api as object)).not.toContain('invokeWithProgress')
  })
})
