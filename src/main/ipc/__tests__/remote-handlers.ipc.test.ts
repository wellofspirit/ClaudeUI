/**
 * @vitest-environment node
 *
 * Layer 1/2 hybrid tests for remote-handlers.ts + remote-dispatcher.ts.
 *
 * Verifies:
 *  - allowed channels are registered and dispatch to the underlying service
 *  - RemoteDispatcher's blocklist rejects desktop-only channels without
 *    invoking the underlying handler
 *  - the dispatcher propagates handler errors so remote clients see them
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { WsInvokeRequest } from '../../../shared/remote-protocol'

// ---------------------------------------------------------------------------
// Mocks for every service remote-handlers.ts imports.
// ---------------------------------------------------------------------------

vi.mock('../../services/session-history', () => ({
  listDirectories: vi.fn(async () => [{ id: 'dir-1' }]),
  loadSessionHistory: vi.fn(async () => [{ id: 'm1' }]),
  loadSubagentHistory: vi.fn(async () => []),
  buildSubagentFileMap: vi.fn(() => ({})),
  loadBackgroundOutput: vi.fn(() => ''),
}))

vi.mock('../../services/ui-config', () => ({
  loadSettings: vi.fn(() => ({ theme: 'dark' })),
  saveSettings: vi.fn(),
  loadSessionConfig: vi.fn(() => ({})),
  saveSessionConfig: vi.fn(),
  loadSlashCommands: vi.fn(() => []),
}))

vi.mock('../../services/claude-settings', () => ({
  loadClaudePermissions: vi.fn(() => ({ allow: [], deny: [], ask: [] })),
}))

vi.mock('../../services/claude-mcp', () => ({
  loadMcpServers: vi.fn(() => ({})),
  readDisabledMcpServers: vi.fn(() => []),
}))

vi.mock('../../services/skill-scanner', () => ({
  scanSkills: vi.fn(async () => []),
}))

vi.mock('../../services/custom-command-scanner', () => ({
  scanCustomCommands: vi.fn(async () => []),
}))

vi.mock('../../services/usage-fetcher', () => ({
  usageFetcher: { fetch: vi.fn(async () => ({ a: 1 })) },
}))

vi.mock('../../services/block-usage', () => ({
  blockUsageService: {
    getData: vi.fn(() => null),
    recalculate: vi.fn(async () => ({ blocks: [] })),
  },
}))

vi.mock('../../services/persisted-sessions-dir', () => ({
  PERSISTED_SESSIONS_DIR: '/tmp/persisted',
}))

vi.mock('../../services/claude-session', () => {
  const extraWindows = new Set<any>()
  return {
    ClaudeSession: class {
      static addExtraWindow(w: any): void { extraWindows.add(w) }
      static removeExtraWindow(w: any): void { extraWindows.delete(w) }
      static getExtraWindows(): Set<any> { return extraWindows }
    },
    getSdkExecutableOpts: vi.fn(() => ({})),
  }
})

vi.mock('../../sdk', () => ({
  query: vi.fn(() => {
    async function* empty(): AsyncGenerator<unknown> { /* */ }
    const gen: any = empty()
    gen.supportedModels = async () => [{ value: 'sonnet', description: '' }]
    return gen
  }),
}))

vi.mock('../../services/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

// Import AFTER mocks.
import { RemoteDispatcher } from '../../services/remote-dispatcher'
import { registerRemoteHandlers } from '../remote-handlers'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(channel: string, ...args: unknown[]): WsInvokeRequest {
  return { type: 'invoke', id: 'req-1', channel, args }
}

function makeFakeWindow(): any {
  return {
    webContents: { send: vi.fn() },
    isDestroyed: () => false,
  }
}

const sessionStub: any = {
  willQueue: false,
  run: vi.fn(),
  resolveApproval: vi.fn(),
  watchBackground: vi.fn(),
  unwatchBackground: vi.fn(),
  readBackgroundRange: vi.fn(() => ''),
  stopTask: vi.fn(async () => ({ success: true })),
  backgroundTask: vi.fn(async () => ({ success: true })),
  dequeueMessage: vi.fn(async () => ({ removed: 1 })),
  setPermissionMode: vi.fn(async () => {}),
  setModel: vi.fn(async () => {}),
  setEffort: vi.fn(),
  mcpServerStatus: vi.fn(async () => [{ name: 'srv', connected: true }]),
  getPlanContent: vi.fn(() => null),
  getSessionLogPath: vi.fn(() => '/tmp/log'),
}

const sessionManagerStub: any = {
  create: vi.fn(),
  rekey: vi.fn(),
  get: vi.fn(() => sessionStub),
  cancel: vi.fn(),
  getTeamInfo: vi.fn(() => null),
}

describe('RemoteDispatcher', () => {
  let dispatcher: RemoteDispatcher

  beforeEach(() => {
    dispatcher = new RemoteDispatcher()
  })

  it('throws when dispatching to an unregistered channel', async () => {
    await expect(dispatcher.handle(makeRequest('ghost:channel'))).rejects.toThrow(
      /Channel not available: ghost:channel/
    )
  })

  it('propagates handler errors for allowed channels', async () => {
    dispatcher.register('test:boom', async () => { throw new Error('fail') })
    await expect(dispatcher.handle(makeRequest('test:boom'))).rejects.toThrow('fail')
  })

  it('silently skips registration of blocklisted channels', () => {
    const handler = vi.fn()
    dispatcher.register('session:pick-folder', handler)
    expect(dispatcher.has('session:pick-folder')).toBe(false)
  })

  it.each([
    'window:minimize',
    'window:maximize',
    'window:close',
    'session:pick-folder',
    'session:open-teams-view',
    'app:quit-confirm',
    'app:open-in-vscode',
    'terminal:create',
    'terminal:write',
    'terminal:resize',
    'terminal:kill',
    'terminal:kill-by-cwd',
  ])('blocks desktop-only channel: %s', async (channel) => {
    const handler = vi.fn(async () => 'SHOULD NOT RUN')
    dispatcher.register(channel, handler)

    // Not registered.
    expect(dispatcher.has(channel)).toBe(false)
    // Dispatching rejects with a typed error.
    await expect(dispatcher.handle(makeRequest(channel))).rejects.toThrow(
      new RegExp(`Channel not available: ${channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
    )
    // The underlying handler was never invoked.
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('registerRemoteHandlers', () => {
  let dispatcher: RemoteDispatcher
  let win: any

  beforeEach(() => {
    dispatcher = new RemoteDispatcher()
    win = makeFakeWindow()
    Object.values(sessionManagerStub).forEach((fn) => {
      if (typeof fn === 'function') (fn as any).mockClear?.()
    })
    Object.values(sessionStub).forEach((fn) => {
      if (typeof fn === 'function') (fn as any).mockClear?.()
    })
    sessionManagerStub.get.mockReturnValue(sessionStub)
    registerRemoteHandlers(dispatcher, sessionManagerStub, win)
  })

  afterEach(() => { vi.clearAllMocks() })

  it('registers the expected set of allowed channels', () => {
    const channels = dispatcher.channels()
    // Sample a few families — all must be present.
    expect(channels).toContain('session:create')
    expect(channels).toContain('session:send')
    expect(channels).toContain('session:cancel')
    expect(channels).toContain('session:approval-response')
    expect(channels).toContain('config:load-settings')
    expect(channels).toContain('config:save-settings')
    expect(channels).toContain('mcp:status')
    expect(channels).toContain('mcp:load-servers')
    expect(channels).toContain('usage:fetch')
    expect(channels).toContain('file:list-dir')
  })

  it('does NOT register blocklisted channels', () => {
    const channels = dispatcher.channels()
    expect(channels).not.toContain('session:pick-folder')
    expect(channels).not.toContain('session:open-teams-view')
    expect(channels).not.toContain('app:quit-confirm')
    expect(channels).not.toContain('window:minimize')
  })

  it('session:send dispatches to session.run + broadcasts', async () => {
    await dispatcher.handle(makeRequest('session:send', 'rid-1', 'hi'))
    expect(sessionStub.run).toHaveBeenCalledWith('hi', undefined)
    expect(win.webContents.send).toHaveBeenCalledWith(
      'session:user-message',
      'rid-1',
      expect.objectContaining({ prompt: 'hi', queued: false })
    )
  })

  it('session:send rejects when routingId not found', async () => {
    sessionManagerStub.get.mockReturnValueOnce(undefined)
    await expect(
      dispatcher.handle(makeRequest('session:send', 'missing', 'x'))
    ).rejects.toThrow(/No session for routingId/)
  })

  it('session:cancel dispatches to manager.cancel', async () => {
    await dispatcher.handle(makeRequest('session:cancel', 'rid-1'))
    expect(sessionManagerStub.cancel).toHaveBeenCalledWith('rid-1')
  })

  it('config:load-settings returns settings', async () => {
    const res = await dispatcher.handle(makeRequest('config:load-settings'))
    expect(res).toEqual({ theme: 'dark' })
  })

  it('usage:fetch dispatches to usageFetcher.fetch', async () => {
    const res = await dispatcher.handle(makeRequest('usage:fetch'))
    expect(res).toEqual({ a: 1 })
  })

  it('mcp:status returns empty when session missing', async () => {
    sessionManagerStub.get.mockReturnValueOnce(undefined)
    const res = await dispatcher.handle(makeRequest('mcp:status', 'ghost'))
    expect(res).toEqual([])
  })

  it('mcp:status routes to session.mcpServerStatus when session present', async () => {
    const res = await dispatcher.handle(makeRequest('mcp:status', 'rid-1'))
    expect(res).toEqual([{ name: 'srv', connected: true }])
    expect(sessionStub.mcpServerStatus).toHaveBeenCalled()
  })

  it('file:list-dir returns structured result on error (no throw)', async () => {
    // Invalid path → handler catches internally and returns default shape.
    const res: any = await dispatcher.handle(
      makeRequest('file:list-dir', '/does/not/exist/zzzzz-unique')
    )
    expect(res).toHaveProperty('entries')
    expect(res).toHaveProperty('isRoot')
    expect(res).toHaveProperty('resolvedPath')
    expect(Array.isArray(res.entries)).toBe(true)
  })

  it('session:stop-task returns error shape when session missing', async () => {
    sessionManagerStub.get.mockReturnValueOnce(undefined)
    const res = await dispatcher.handle(makeRequest('session:stop-task', 'ghost', 'tool-1'))
    expect(res).toEqual({ success: false, error: 'No active session' })
  })

  it('session:dequeue-message returns {removed:0} when session missing', async () => {
    sessionManagerStub.get.mockReturnValueOnce(undefined)
    const res = await dispatcher.handle(makeRequest('session:dequeue-message', 'ghost', 'val'))
    expect(res).toEqual({ removed: 0 })
  })
})
