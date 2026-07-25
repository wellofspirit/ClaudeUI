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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { WsInvokeRequest } from '../../../shared/remote-protocol'

// ---------------------------------------------------------------------------
// Mocks for every service remote-handlers.ts imports.
// ---------------------------------------------------------------------------

vi.mock('../../services/session-history', () => ({
  listDirectories: vi.fn(async () => [{ id: 'dir-1' }]),
  loadSessionHistory: vi.fn(async () => [{ id: 'm1' }]),
  loadSubagentHistory: vi.fn(async () => []),
  buildSubagentFileMap: vi.fn(() => ({})),
  loadBackgroundOutput: vi.fn(() => '')
}))

vi.mock('../../services/delete-session-files', () => ({
  deleteSessionFiles: vi.fn(async () => {}),
  deleteProjectFiles: vi.fn(async () => {})
}))

const uiConfigMocks = vi.hoisted(() => ({
  loadSettings: vi.fn(() => ({ theme: 'dark' })),
  saveSettings: vi.fn(),
  loadSessionConfig: vi.fn(() => ({})),
  saveSessionConfig: vi.fn(),
  loadSlashCommands: vi.fn(() => []),
  loadEngineConfig: vi.fn(() => ({})),
  loadVendorConfig: vi.fn(() => ({}))
}))

vi.mock('../../services/ui-config', () => uiConfigMocks)

vi.mock('../../opencode/model-discovery', () => ({
  resolveOpencodeSpawnModel: vi.fn(async (m?: string) => m ?? 'opencode/zen-free'),
  invalidateOpencodeModelCache: vi.fn()
}))

vi.mock('../../sdk/proxy', () => ({
  setProxyEnv: vi.fn(),
  setProxyAllSubprocesses: vi.fn()
}))

vi.mock('../../sdk/endpoint-env', () => ({
  setEndpointEnv: vi.fn()
}))

vi.mock('../../sdk/model-env', () => ({
  setModelEnv: vi.fn()
}))

vi.mock('../../services/socks-bridge', () => ({
  startSocksBridge: vi.fn(async () => 1080),
  stopSocksBridge: vi.fn(async () => {})
}))

vi.mock('../../services/claude-settings', () => ({
  loadClaudePermissions: vi.fn(() => ({ allow: [], deny: [], ask: [] })),
  loadCleanupPeriodDays: vi.fn(() => 30),
  saveCleanupPeriodDays: vi.fn()
}))

vi.mock('../../services/claude-mcp', () => ({
  loadMcpServers: vi.fn(() => ({})),
  readDisabledMcpServers: vi.fn(() => [])
}))

vi.mock('../../services/skill-scanner', () => ({
  scanSkills: vi.fn(async () => [])
}))

vi.mock('../../services/custom-command-scanner', () => ({
  scanCustomCommands: vi.fn(async () => [])
}))

vi.mock('../../services/usage-fetcher', () => ({
  usageFetcher: { fetch: vi.fn(async () => ({ a: 1 })), setIntervalSecs: vi.fn() }
}))

vi.mock('../../services/block-usage', () => ({
  blockUsageService: {
    getData: vi.fn(() => null),
    recalculate: vi.fn(async () => ({ blocks: [] })),
    setDebounceSecs: vi.fn()
  }
}))

vi.mock('../../services/persisted-sessions-dir', () => ({
  PERSISTED_SESSIONS_DIR: '/tmp/persisted'
}))

vi.mock('../../services/claude-session', () => {
  const extraWindows = new Set<any>()
  return {
    ClaudeSession: class {
      static addExtraWindow(w: any): void {
        extraWindows.add(w)
      }
      static removeExtraWindow(w: any): void {
        extraWindows.delete(w)
      }
      static getExtraWindows(): Set<any> {
        return extraWindows
      }
    },
    getSdkExecutableOpts: vi.fn(() => ({}))
  }
})

vi.mock('../../sdk', () => ({
  query: vi.fn(() => {
    async function* empty(): AsyncGenerator<unknown> {
      /* */
    }
    const gen: any = empty()
    gen.supportedModels = async () => [{ value: 'sonnet', description: '' }]
    return gen
  })
}))

// Cross-engine dispatcher (ADR-033) — the real singleton pulls the opencode
// client graph (electron at runtime); stub it for the prefix-routing tests.
const crossEngineSpies = vi.hoisted(() => ({
  resolveApproval: vi.fn((requestId: string) => requestId.startsWith('xeng:')),
  dispatch: vi.fn(),
  disposeFor: vi.fn(),
  stopDispatch: vi.fn(() => false)
}))

vi.mock('../../services/cross-engine-dispatcher', () => ({
  crossEngineDispatcher: crossEngineSpies,
  XENG_REQUEST_PREFIX: 'xeng:'
}))

vi.mock('../../services/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    applyFilter: vi.fn()
  }
}))

// Import AFTER mocks.
import { RemoteDispatcher } from '../../services/remote-dispatcher'
import { registerRemoteHandlers, registerRemoteVersionInfo } from '../remote-handlers'
import { resolveClaudeCapabilities } from '../../../shared/model-capabilities'
import { resolveOpencodeSpawnModel } from '../../opencode/model-discovery'
import { setProxyEnv } from '../../sdk/proxy'
import { setEndpointEnv } from '../../sdk/endpoint-env'
import { setModelEnv } from '../../sdk/model-env'
import { usageFetcher } from '../../services/usage-fetcher'
import { blockUsageService } from '../../services/block-usage'
import { logger } from '../../services/logger'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(channel: string, ...args: unknown[]): WsInvokeRequest {
  return { type: 'invoke', id: 'req-1', channel, args }
}

function makeFakeWindow(): any {
  return {
    webContents: { send: vi.fn() },
    isDestroyed: () => false
  }
}

const sessionStub: any = {
  willQueue: false,
  engineId: 'claude',
  capabilities: resolveClaudeCapabilities('default'),
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
  setThinkingMode: vi.fn(),
  askSideQuestion: vi.fn(async () => 'answer'),
  mcpServerStatus: vi.fn(async () => [{ name: 'srv', connected: true }]),
  notifySettingsChanged: vi.fn(async () => {}),
  getPlanContent: vi.fn(() => null),
  getSessionLogPath: vi.fn(() => '/tmp/log'),
  discoverSkills: vi.fn(async () => [])
}

const sessionManagerStub: any = {
  create: vi.fn(),
  rekey: vi.fn(),
  get: vi.fn(() => sessionStub),
  cancel: vi.fn(),
  interrupt: vi.fn(async () => {}),
  forEach: vi.fn((cb: (s: any) => void) => cb(sessionStub)),
  setSessionTimeout: vi.fn()
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
    dispatcher.register('test:boom', async () => {
      throw new Error('fail')
    })
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
    'app:quit-confirm',
    'app:open-in-vscode',
    'terminal:create',
    'terminal:write',
    'terminal:resize',
    'terminal:kill',
    'terminal:kill-by-cwd'
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

  afterEach(() => {
    vi.clearAllMocks()
  })

  it("routes 'xeng:'-prefixed approval responses to the cross-engine dispatcher (ADR-033)", async () => {
    await dispatcher.handle(
      makeRequest('session:approval-response', 'rid-1', 'xeng:perm-7', 'deny', { feedback: 'no' })
    )
    expect(crossEngineSpies.resolveApproval).toHaveBeenCalledWith(
      'xeng:perm-7',
      'deny',
      { feedback: 'no' },
      undefined
    )
    expect(sessionStub.resolveApproval).not.toHaveBeenCalled()
  })

  it('routes ordinary approval responses to the session', async () => {
    await dispatcher.handle(makeRequest('session:approval-response', 'rid-1', 'req-1', 'allow'))
    expect(sessionStub.resolveApproval).toHaveBeenCalledWith('req-1', 'allow', undefined, undefined)
    expect(crossEngineSpies.resolveApproval).not.toHaveBeenCalled()
  })

  it("routes a known dispatch toolUseId to the cross-engine dispatcher's stopDispatch, scoped by routingId (ADR-033 M3)", async () => {
    crossEngineSpies.stopDispatch.mockReturnValueOnce(true)
    const res = await dispatcher.handle(
      makeRequest('session:stop-task', 'rid-1', 'toolu_dispatch_1')
    )
    expect(crossEngineSpies.stopDispatch).toHaveBeenCalledWith('toolu_dispatch_1', 'rid-1')
    expect(res).toEqual({ success: true })
    expect(sessionStub.stopTask).not.toHaveBeenCalled()
  })

  it('falls through to the session stopTask when the id is not a known dispatch', async () => {
    const res = await dispatcher.handle(makeRequest('session:stop-task', 'rid-1', 'toolu_ordinary_1'))
    expect(crossEngineSpies.stopDispatch).toHaveBeenCalledWith('toolu_ordinary_1', 'rid-1')
    expect(sessionStub.stopTask).toHaveBeenCalledWith('toolu_ordinary_1')
    expect(res).toEqual({ success: true })
  })

  it('isDispatch=true: arms a durable stop-intent, returns success even with no live turn, never touches the session path', async () => {
    // Default stopDispatch mock returns false — the upstream race window.
    const res = await dispatcher.handle(
      makeRequest('session:stop-task', 'rid-1', 'toolu_disp_racy', true)
    )
    expect(crossEngineSpies.stopDispatch).toHaveBeenCalledWith('toolu_disp_racy', 'rid-1', {
      armIfUnknown: true
    })
    expect(res).toEqual({ success: true })
    expect(sessionStub.stopTask).not.toHaveBeenCalled()
  })

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
    for (const channel of [
      'shared-provider:list',
      'shared-provider:statuses',
      'shared-provider:models'
    ])
      expect(channels).toContain(channel)
    for (const channel of [
      'shared-provider:save',
      'shared-provider:remove',
      'shared-provider:set-route',
      'shared-provider:set-key',
      'shared-provider:sync',
      'shared-provider:disconnect',
      'shared-provider:set-default'
    ])
      expect(channels).not.toContain(channel)
  })

  it('does NOT register blocklisted channels', () => {
    const channels = dispatcher.channels()
    expect(channels).not.toContain('session:pick-folder')
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
    await expect(dispatcher.handle(makeRequest('session:send', 'missing', 'x'))).rejects.toThrow(
      /No session for routingId/
    )
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

  // ISession optional-member safety (Item 3) — isClaudeSession casts were
  // replaced with capability checks + optional-call (`?.`) + neutral forEach.
  describe('ISession optional-member safety (Item 3)', () => {
    it('claude:set-cleanup-period triggers notifySettingsChanged via the neutral forEach', async () => {
      await dispatcher.handle(makeRequest('claude:set-cleanup-period', 30))
      expect(sessionStub.notifySettingsChanged).toHaveBeenCalled()
    })

    it('mcp:status returns [] without throwing for a capability-true session lacking mcpServerStatus', async () => {
      sessionManagerStub.get.mockReturnValueOnce({
        engineId: 'claude',
        capabilities: resolveClaudeCapabilities('default')
        // No mcpServerStatus method.
      })
      const res = await dispatcher.handle(makeRequest('mcp:status', 'rid-min'))
      expect(res).toEqual([])
    })
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

  // Regression: these were missing from both the dispatcher and the web
  // api-adapter, so the remote client either crashed (undefined method) or
  // hit "Channel not available". They're now wired end-to-end.
  describe('newly-bridged channels', () => {
    it('session:interrupt routes to manager.interrupt', async () => {
      await dispatcher.handle(makeRequest('session:interrupt', 'rid-1'))
      expect(sessionManagerStub.interrupt).toHaveBeenCalledWith('rid-1')
    })

    it('session:set-thinking-mode routes to session.setThinkingMode', async () => {
      await dispatcher.handle(makeRequest('session:set-thinking-mode', 'rid-1', 'think'))
      expect(sessionStub.setThinkingMode).toHaveBeenCalledWith('think')
    })

    it('session:ask-side-question returns the session answer', async () => {
      const res = await dispatcher.handle(makeRequest('session:ask-side-question', 'rid-1', 'q?'))
      expect(sessionStub.askSideQuestion).toHaveBeenCalledWith('q?')
      expect(res).toBe('answer')
    })

    it('session:ask-side-question returns null when session missing', async () => {
      sessionManagerStub.get.mockReturnValueOnce(undefined)
      const res = await dispatcher.handle(makeRequest('session:ask-side-question', 'ghost', 'q?'))
      expect(res).toBeNull()
    })

    it('session:delete-session and session:delete-project are registered', () => {
      const channels = dispatcher.channels()
      expect(channels).toContain('session:delete-session')
      expect(channels).toContain('session:delete-project')
    })
  })

  it('registerRemoteVersionInfo exposes app:version-info on the dispatcher', async () => {
    expect(dispatcher.has('app:version-info')).toBe(false)
    registerRemoteVersionInfo({ appVersion: '1.2.3', sdkVersion: '0.9', cliVersion: '2.9' })
    const res = await dispatcher.handle(makeRequest('app:version-info'))
    expect(res).toEqual({ appVersion: '1.2.3', sdkVersion: '0.9', cliVersion: '2.9' })
  })

  // Regression: mockup channels must be reachable over remote — the web client
  // crashed with "window.api.readMockupHtml is not a function" because these
  // were never registered on the dispatcher (nor in the web api-adapter).
  describe('mockup preview', () => {
    let cwd: string

    beforeEach(() => {
      cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-remote-'))
      const dir = path.join(cwd, '.claude', 'ui', 'mockups', 'm1')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'index.html'), '<h1>hello</h1>')
    })

    afterEach(() => {
      fs.rmSync(cwd, { recursive: true, force: true })
    })

    it('registers the mockup channels', () => {
      const channels = dispatcher.channels()
      expect(channels).toContain('mockup:read-html')
      expect(channels).toContain('mockup:watch')
      expect(channels).toContain('mockup:unwatch')
    })

    it('mockup:read-html returns the mockup index.html contents', async () => {
      const res = await dispatcher.handle(makeRequest('mockup:read-html', cwd, 'm1'))
      expect(res).toBe('<h1>hello</h1>')
    })

    it('mockup:read-html rejects for a missing mockup', async () => {
      await expect(
        dispatcher.handle(makeRequest('mockup:read-html', cwd, 'does-not-exist'))
      ).rejects.toThrow()
    })

    it('mockup:watch/unwatch are idempotent and tolerate a missing directory', async () => {
      // Missing dir → no-op, no throw.
      await expect(
        dispatcher.handle(makeRequest('mockup:watch', cwd, 'ghost'))
      ).resolves.toBeUndefined()
      // Real dir → watches; second call is a no-op (already watching).
      await dispatcher.handle(makeRequest('mockup:watch', cwd, 'm1'))
      await dispatcher.handle(makeRequest('mockup:watch', cwd, 'm1'))
      // Unwatch tears down without throwing; double-unwatch is safe.
      await dispatcher.handle(makeRequest('mockup:unwatch', cwd, 'm1'))
      await expect(
        dispatcher.handle(makeRequest('mockup:unwatch', cwd, 'm1'))
      ).resolves.toBeUndefined()
    })
  })

  // Remote/desktop session:create parity — the remote handler now delegates to
  // the shared prepareAndCreateSession() (create-session.ts), so engineId
  // threading and engine-config sourcing must match the desktop IPC handler.
  describe('session:create parity', () => {
    it('threads engineId through to manager.create (GUARD — fails pre-fix)', async () => {
      await dispatcher.handle(
        makeRequest(
          'session:create',
          'rid-engine',
          '/tmp/proj',
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          'opencode'
        )
      )
      expect(sessionManagerStub.create).toHaveBeenCalled()
      // manager.create's 5th positional arg (index 4) is engineId.
      expect(sessionManagerStub.create.mock.calls[0][4]).toBe('opencode')
    })

    it('sources sandbox from loadEngineConfig, not loadSettings', async () => {
      const SENTINEL = { enabled: true, marker: 'sentinel' }
      uiConfigMocks.loadEngineConfig.mockReturnValueOnce({ sandbox: SENTINEL })
      uiConfigMocks.loadSettings.mockReturnValueOnce({
        sandbox: { enabled: true, DIFFERENT: true }
      } as unknown as ReturnType<typeof uiConfigMocks.loadSettings>)

      await dispatcher.handle(makeRequest('session:create', 'rid-sandbox', '/tmp/proj'))

      expect(sessionManagerStub.create).toHaveBeenCalled()
      // manager.create's 4th positional arg (index 3) is the EngineSpawnOptions object.
      expect(sessionManagerStub.create.mock.calls[0][3].sandboxConfig).toEqual(SENTINEL)
    })

    it('claude path (default engineId) applies vendor config and skips opencode resolution', async () => {
      await dispatcher.handle(makeRequest('session:create', 'rid-claude', '/tmp/proj'))

      expect(uiConfigMocks.loadVendorConfig).toHaveBeenCalledWith('anthropic')
      expect(resolveOpencodeSpawnModel).not.toHaveBeenCalled()
    })

    it('opencode path resolves the spawn model and skips vendor config', async () => {
      await dispatcher.handle(
        makeRequest(
          'session:create',
          'rid-opencode',
          '/tmp/proj',
          undefined,
          undefined,
          undefined,
          'opencode/some-model',
          undefined,
          undefined,
          undefined,
          'opencode'
        )
      )

      expect(resolveOpencodeSpawnModel).toHaveBeenCalledWith('opencode/some-model')
      expect(uiConfigMocks.loadVendorConfig).not.toHaveBeenCalled()
      const resolvedModel = await (
        resolveOpencodeSpawnModel as unknown as ReturnType<typeof vi.fn>
      ).mock.results[0].value
      // manager.create's 4th positional arg (index 3) is the EngineSpawnOptions object.
      expect(sessionManagerStub.create.mock.calls[0][3].model).toBe(resolvedModel)
    })

    it('broadcasts session:created to the main window (remote notifies desktop)', async () => {
      await dispatcher.handle(makeRequest('session:create', 'rid-broadcast', '/tmp/proj'))

      expect(win.webContents.send).toHaveBeenCalledWith(
        'session:created',
        'rid-broadcast',
        expect.objectContaining({ cwd: '/tmp/proj' })
      )
    })
  })

  // Remote/desktop config:save-settings parity — the remote handler now
  // delegates to the shared saveUiSettings() (handlers-core.ts), so field
  // stripping, env re-application, interval/log/timeout propagation, and
  // broadcast targeting must match the desktop IPC handler.
  describe('config:save-settings parity', () => {
    it('strips engine/vendor-owned fields before persisting (GUARD — fails pre-fix)', async () => {
      await dispatcher.handle(
        makeRequest('config:save-settings', {
          theme: 'light',
          sandbox: { enabled: true, marker: 'sentinel' },
          proxy: { enabled: true, marker: 'sentinel' },
          anthropicEndpoint: { enabled: true, marker: 'sentinel' },
          modelOverride: { enabled: true, marker: 'sentinel' }
        })
      )

      expect(uiConfigMocks.saveSettings).toHaveBeenCalled()
      const persisted = uiConfigMocks.saveSettings.mock.calls[0][0]
      expect(persisted).toEqual(expect.objectContaining({ theme: 'light' }))
      expect(persisted).not.toHaveProperty('sandbox')
      expect(persisted).not.toHaveProperty('proxy')
      expect(persisted).not.toHaveProperty('anthropicEndpoint')
      expect(persisted).not.toHaveProperty('modelOverride')
    })

    it('applies endpoint/model env sourced from the vendor store (GUARD — fails pre-fix)', async () => {
      uiConfigMocks.loadEngineConfig.mockReturnValueOnce({})
      uiConfigMocks.loadVendorConfig.mockReturnValueOnce({
        endpoint: { enabled: true, baseUrl: 'https://sentinel.example' },
        modelOverride: { enabled: true, model: 'sentinel-model' }
      })

      await dispatcher.handle(makeRequest('config:save-settings', { theme: 'dark' }))
      // applyProxyEnv is fire-and-forget (`.catch(...)`) — flush the microtask queue.
      await new Promise((r) => setImmediate(r))

      expect(setEndpointEnv).toHaveBeenCalledWith(
        expect.objectContaining({ ANTHROPIC_BASE_URL: 'https://sentinel.example' })
      )
      expect(setModelEnv).toHaveBeenCalledWith(
        expect.objectContaining({ ANTHROPIC_MODEL: 'sentinel-model' })
      )
      // Proxy disabled (loadEngineConfig has no `proxy` key) → cleared to null.
      expect(setProxyEnv).toHaveBeenCalledWith(null)
    })

    it('propagates usage/analytics intervals, log filter, and session timeout (GUARD — fails pre-fix)', async () => {
      await dispatcher.handle(
        makeRequest('config:save-settings', {
          usageRefreshSecs: 77,
          analyticsRefreshSecs: 88,
          logLevel: 'debug',
          logFilter: 'Proxy',
          sessionTimeoutMins: 5
        })
      )

      expect(usageFetcher.setIntervalSecs).toHaveBeenCalledWith(77)
      expect(blockUsageService.setDebounceSecs).toHaveBeenCalledWith(88)
      expect(logger.applyFilter).toHaveBeenCalledWith('Proxy', 'debug')
      expect(sessionManagerStub.setSessionTimeout).toHaveBeenCalledWith(300000)
    })

    it('broadcasts the stripped settings to the main window (remote notifies desktop)', async () => {
      await dispatcher.handle(
        makeRequest('config:save-settings', {
          theme: 'light',
          sandbox: { enabled: true, marker: 'sentinel' }
        })
      )

      expect(win.webContents.send).toHaveBeenCalledWith(
        'config:settings-changed',
        expect.not.objectContaining({ sandbox: expect.anything() })
      )
    })
  })
})
