/**
 * @vitest-environment node
 *
 * Unit tests for handlers-core.ts — the session-domain handler bodies shared
 * by session.ipc.ts (desktop) and remote-handlers.ts (remote WebSocket).
 *
 * Focus: each exported fn behaves identically regardless of which surface
 * calls it. The REQUIRED parity assertion registers a shared fn on a real
 * RemoteDispatcher and compares its result against a direct (desktop-style)
 * call for the same args — proving the "thin wrapper, no envelope" invariant
 * holds end-to-end, not just by inspection of the wrapper code.
 */

import { describe, it, expect, vi } from 'vitest'
import { RemoteDispatcher } from '../../services/remote-dispatcher'
import { resolveClaudeCapabilities } from '../../../shared/model-capabilities'

vi.mock('../../services/skill-scanner', () => ({
  scanSkills: vi.fn(async () => [])
}))

vi.mock('../../services/claude-settings', () => ({
  saveCleanupPeriodDays: vi.fn()
}))

vi.mock('../../services/ui-config', () => ({
  saveSessionConfig: vi.fn(),
  // Pulled in transitively via claude-session → collab-tool →
  // cross-engine-dispatcher (ADR-033).
  loadEngineConfig: vi.fn(() => ({}))
}))

// Import AFTER mocks.
import {
  mcpStatus,
  stopTask,
  getPlanContent,
  getSessionLogPath,
  dequeueMessage,
  saveSessions,
  listDirEntries
} from '../handlers-core'

function makeSessionStub(overrides: Record<string, unknown> = {}): any {
  return {
    engineId: 'claude',
    cwd: '/tmp/cwd',
    capabilities: resolveClaudeCapabilities('default'),
    willQueue: false,
    mcpServerStatus: vi.fn(async () => [{ name: 'srv', connected: true }]),
    ...overrides
  }
}

function makeManager(sessionStub: any): any {
  return {
    get: vi.fn(() => sessionStub),
    forEach: vi.fn((cb: (s: any) => void) => cb(sessionStub))
  }
}

function makeFakeWindow(): any {
  return {
    webContents: { send: vi.fn() },
    isDestroyed: () => false
  }
}

describe('handlers-core', () => {
  it('mcpStatus behaves identically whether called directly (desktop-style) or via RemoteDispatcher', async () => {
    const sessionStub = makeSessionStub()
    const manager = makeManager(sessionStub)
    const dispatcher = new RemoteDispatcher()
    dispatcher.register('mcp:status', (rid: string) => mcpStatus(manager, rid))

    const direct = await mcpStatus(manager, 'rid-1')
    const viaDispatcher = await dispatcher.handle({
      type: 'invoke',
      id: '1',
      channel: 'mcp:status',
      args: ['rid-1']
    })

    expect(viaDispatcher).toEqual(direct)
    expect(direct).toEqual([{ name: 'srv', connected: true }])
  })

  it('stopTask returns the "no active session" shape when the session is missing', async () => {
    const manager = makeManager(undefined)
    const res = await stopTask(manager, 'ghost', 'tool-1')
    expect(res).toEqual({ success: false, error: 'No active session' })
  })

  it('stopTask returns the capability-false shape when backgroundTasks is unsupported', async () => {
    const sessionStub = makeSessionStub({
      capabilities: { ...resolveClaudeCapabilities('default'), backgroundTasks: false }
    })
    const manager = makeManager(sessionStub)
    const res = await stopTask(manager, 'rid-1', 'tool-1')
    expect(res).toEqual({ success: false, error: 'Provider does not support background tasks' })
  })

  it('getPlanContent falls back to null when the session lacks getPlanContent', async () => {
    const sessionStub = makeSessionStub() // capabilities.plan is true, no getPlanContent method
    const manager = makeManager(sessionStub)
    expect(getPlanContent(manager, 'rid-1')).toBeNull()
  })

  it('getSessionLogPath falls back to null when the session lacks getSessionLogPath', () => {
    const sessionStub = makeSessionStub()
    const manager = makeManager(sessionStub)
    expect(getSessionLogPath(manager, 'rid-1')).toBeNull()
  })

  it('dequeueMessage falls back to {removed: 0} when the session is missing', async () => {
    const manager = makeManager(undefined)
    const res = await dequeueMessage(manager, 'ghost', 'val')
    expect(res).toEqual({ removed: 0 })
  })

  it('saveSessions only broadcasts to the main window when notifyMainWindow is true', () => {
    const win = makeFakeWindow()
    const config = { sessions: [] } as any

    saveSessions(win, config, { notifyMainWindow: false })
    expect(win.webContents.send).not.toHaveBeenCalled()

    saveSessions(win, config, { notifyMainWindow: true })
    expect(win.webContents.send).toHaveBeenCalledWith('config:sessions-changed', config)
  })

  it('listDirEntries returns the default empty shape for a nonexistent path', async () => {
    const res = await listDirEntries('/does/not/exist/zzzzz-unique')
    expect(res).toEqual({ entries: [], isRoot: false, resolvedPath: '' })
  })
})
