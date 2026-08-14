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
import { CommandRegistry, makeRemoteConnection } from '../command-registry'
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
  listDirEntries,
  setPermissionMode
} from '../handlers-core'
import { syncCore, addSyncSubscriber } from '../../services/sync-host'

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
    const registry = new CommandRegistry()
    const dispatcher = new RemoteDispatcher(registry)
    registry.register({
      channel: 'mcp:status',
      capability: 'config',
      kind: 'query',
      transport: 'remote',
      handler: (rid: string) => mcpStatus(manager, rid)
    })

    const direct = await mcpStatus(manager, 'rid-1')
    const viaDispatcher = await dispatcher.handle(
      { type: 'invoke', id: '1', channel: 'mcp:status', args: ['rid-1'] },
      makeRemoteConnection('token', null)
    )

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

  it('saveSessions broadcasts to every subscriber, whoever saved (4c)', () => {
    // 4a split this by origin: a desktop save delivered `extras-only` because the
    // saving renderer "already knew". 4c deleted that — the saver is a subscriber
    // like everyone else, and the payload is a whole-config replace, so its own
    // echo is idempotent while remaining authoritative for every other client.
    const win = makeFakeWindow()
    const config = { sessions: [] } as any
    const sink = vi.fn()
    const off = addSyncSubscriber(sink)
    try {
      saveSessions(config)
      expect(sink).toHaveBeenCalledWith(expect.any(Number), 'config:sessions-changed', [config])
      // Never a targeted window send for a replicated channel.
      expect(win.webContents.send).not.toHaveBeenCalled()
    } finally {
      off()
    }
  })

  it('a DESKTOP-originated saveSessions is visible in the next getSnapshot (phase 4b)', () => {
    // The apply has to happen regardless of who saved — otherwise a phone that
    // resynced after a desktop pin/rename would read the pre-save registry until
    // the file watcher happened to fire. SyncCore applies before it delivers,
    // which is what makes this hold; this test is the thing that would notice if
    // that changed.
    syncCore.resetCanonicalForTests()
    saveSessions({
      recentSessions: ['rid-a'],
      pinnedSessions: ['rid-a'],
      customTitles: { 'rid-a': 'Renamed' }
    } as any)

    const snap = syncCore.getSnapshot()
    expect(snap.recentSessionIds).toEqual(['rid-a'])
    expect(snap.pinnedSessionIds).toEqual(['rid-a'])
    expect(snap.customTitles).toEqual({ 'rid-a': 'Renamed' })
  })

  it('listDirEntries returns the default empty shape for a nonexistent path', async () => {
    const res = await listDirEntries('/does/not/exist/zzzzz-unique')
    expect(res).toEqual({ entries: [], isRoot: false, resolvedPath: '' })
  })

  describe('setPermissionMode', () => {
    it('delegates to session.setPermissionMode when a live session exists, without sending directly', async () => {
      const sessionStub = makeSessionStub({ setPermissionMode: vi.fn(async () => {}) })
      const manager = makeManager(sessionStub)
      const win = makeFakeWindow()

      await setPermissionMode(manager, 'rid-1', 'acceptEdits')

      expect(sessionStub.setPermissionMode).toHaveBeenCalledWith('acceptEdits')
      expect(win.webContents.send).not.toHaveBeenCalled()
    })

    it('echoes session:permission-mode to every subscriber when no session exists (pre-spawn)', async () => {
      const manager = makeManager(undefined)
      const win = makeFakeWindow()
      const sink = vi.fn()
      const off = addSyncSubscriber(sink)
      try {
        await setPermissionMode(manager, 'rid-pre-spawn', 'plan')

        expect(sink).toHaveBeenCalledWith(expect.any(Number), 'session:permission-mode', [
          'rid-pre-spawn',
          'plan'
        ])
        expect(win.webContents.send).not.toHaveBeenCalled()
      } finally {
        off()
      }
    })

    it('does not throw and sends nothing for an invalid mode string', async () => {
      const manager = makeManager(undefined)
      const sink = vi.fn()
      const off = addSyncSubscriber(sink)

      await expect(setPermissionMode(manager, 'rid-1', 'not-a-real-mode')).resolves.not.toThrow()
      expect(sink).not.toHaveBeenCalled()
      off()
    })

    it('does not throw and does not call session.setPermissionMode for an invalid mode on a live session', async () => {
      const sessionStub = makeSessionStub({ setPermissionMode: vi.fn(async () => {}) })
      const manager = makeManager(sessionStub)

      await setPermissionMode(manager, 'rid-1', 'bogus')

      expect(sessionStub.setPermissionMode).not.toHaveBeenCalled()
    })
  })
})
