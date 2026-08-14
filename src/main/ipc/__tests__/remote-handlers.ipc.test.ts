/**
 * @vitest-environment node
 *
 * Layer 1/2 hybrid tests for remote-handlers.ts + remote-dispatcher.ts.
 *
 * Verifies:
 *  - allowed channels are registered and dispatch to the underlying service
 *  - desktop-only channels are never exposed on the remote transport
 *    (capability grants — the denylist they used to sit on is gone)
 *  - the dispatcher propagates handler errors so remote clients see them
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { subscribeWindowToSync } from '../../../test/helpers/sync-subscriber-window'
import { clearSyncSubscribersForTests } from '../../services/sync-host'
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
  invalidateOpencodeModelCache: vi.fn(),
  discoverOpencodeModels: vi.fn(async () => []),
  discoverOpencodeProviderCatalog: vi.fn(async () => []),
  getOpencodeProviderModels: vi.fn(async () => [])
}))

vi.mock('../../opencode/OpencodeServerManager', () => ({
  opencodeServerManager: { isBinaryAvailable: vi.fn(() => false) }
}))

vi.mock('../../pi/model-discovery', () => ({
  discoverPiModels: vi.fn(async () => []),
  getPiModelCatalogGroups: vi.fn(async () => []),
  // Also consumed by the shared-providers graph pulled in transitively.
  invalidatePiModelCache: vi.fn(),
  resolvePiSpawnModel: vi.fn(async (m?: string) => m),
  getPiModelCatalog: vi.fn(async () => []),
  effortLevelsFromModel: vi.fn(() => [])
}))

vi.mock('../../pi/pi-locate', () => ({
  piBinaryAvailable: vi.fn(() => false),
  locatePiBinary: vi.fn(() => null)
}))

vi.mock('../../auth/vault/CredentialSync', () => ({
  credentialSync: { getStatus: vi.fn(() => ({ connected: false })) }
}))

vi.mock('../../services/account-manager', () => ({
  accountManager: { getState: vi.fn(() => ({ enabled: false, accounts: [] })) }
}))

vi.mock('../../services/session-watcher', () => ({
  watchSession: vi.fn(),
  unwatchSession: vi.fn()
}))

vi.mock('../../services/opencode-session-list', () => ({
  listOpencodeSessionsGlobal: vi.fn(async () => []),
  loadOpencodeSessionHistory: vi.fn(async () => [])
}))

// NB: pi-session-list is a lightweight fs reader whose `piAgentDir` export is
// also used by the shared-providers graph — mocking it wholesale drops that and
// breaks the import chain, so we let the real module load (remote-handlers only
// calls its list/history fns on invoke, which these tests don't exercise).

// A GitService stub whose methods return sentinel values so the git:* dispatch
// tests can assert routing + get/release bracketing without a real repo.
const gitSvcStub = vi.hoisted(() => ({
  isGitRepo: vi.fn(async () => true),
  getStatus: vi.fn(async () => ({ files: [] })),
  getBranches: vi.fn(async () => ['main']),
  checkout: vi.fn(async () => {}),
  createBranch: vi.fn(async () => {}),
  getFilePatch: vi.fn(async () => 'diff'),
  getFileContents: vi.fn(async () => 'contents'),
  stageFile: vi.fn(async () => {}),
  unstageFile: vi.fn(async () => {}),
  discardFile: vi.fn(async () => {}),
  stageAll: vi.fn(async () => {}),
  unstageAll: vi.fn(async () => {}),
  commit: vi.fn(async () => 'sha'),
  push: vi.fn(async () => {}),
  pushWithUpstream: vi.fn(async () => {}),
  pull: vi.fn(async () => {}),
  fetch: vi.fn(async () => {}),
  startPolling: vi.fn(),
  stopPolling: vi.fn()
}))

const gitManagerSpies = vi.hoisted(() => ({
  get: vi.fn(() => gitSvcStub),
  release: vi.fn(),
  getIfExists: vi.fn(() => gitSvcStub)
}))

vi.mock('../../services/git-service', () => ({
  gitServiceManager: gitManagerSpies
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
  stopSocksBridge: vi.fn(async () => {}),
  // session.ipc.ts's proxy connectivity test now reuses the bridge's handshake.
  socks5Connect: vi.fn(async () => {
    throw new Error('socks5Connect not stubbed for this test')
  })
}))

const claudeSettingsSpies = vi.hoisted(() => ({
  saveClaudePermissions: vi.fn(),
  isWorkspaceTrusted: vi.fn(() => true)
}))

vi.mock('../../services/claude-settings', () => ({
  loadClaudePermissions: vi.fn(() => ({ allow: [], deny: [], ask: [] })),
  loadCleanupPeriodDays: vi.fn(() => 30),
  saveCleanupPeriodDays: vi.fn(),
  saveClaudePermissions: claudeSettingsSpies.saveClaudePermissions,
  isWorkspaceTrusted: claudeSettingsSpies.isWorkspaceTrusted
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

vi.mock('../../services/claude-session', () => ({
  // 4c: no static extra-window registry to stub — clients are subscribers.
  ClaudeSession: class {},
  getSdkExecutableOpts: vi.fn(() => ({}))
}))

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
import {
  CommandRegistry,
  commandRegistry,
  makeRemoteConnection,
  LEGACY_REMOTE_GRANTS,
  PINNED_CAPABILITIES
} from '../command-registry'
import { gitWatchRegistry, GIT_WATCH_OWNER_REMOTE } from '../../services/git-watch-registry'
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

/**
 * The connection every dispatch in this file runs as: a token-authenticated
 * remote client holding the legacy-policy grant set — exactly what
 * RemoteServer mints on authentication. Using the real grants (not an
 * all-capability stand-in) is what makes these tests double as the parity
 * check: a channel that stopped being reachable would fail here.
 */
const remoteConn = makeRemoteConnection('token', null)

/**
 * A stub window that is also a CLIENT (SyncCore phase 4c).
 *
 * A remote-originated broadcast used to be asserted by watching the DESKTOP
 * window's `webContents.send` — the remote handler passed `notifyMainWindow: true`
 * so the desktop, uniquely, got a targeted send. 4c deleted that: every client
 * (desktop included) is a subscriber, so the stub subscribes and the assertions
 * below keep reading the same `send(channel, ...args)` shape.
 */
function makeFakeWindow(): any {
  const win = {
    webContents: { send: vi.fn() },
    isDestroyed: () => false
  }
  subscribeWindowToSync(win)
  return win
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
  queuedItems: [],
  enqueuePrompt: vi.fn(),
  recallQueued: vi.fn(async () => ({ recalled: ['a'], notRecalled: 0 })),
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

// Routing basics run against a PRIVATE registry so they can never pollute the
// shared one the parity pin at the bottom of this file reads. Capability gating
// itself is covered in remote-dispatcher.test.ts.
describe('RemoteDispatcher routing', () => {
  let registry: CommandRegistry
  let dispatcher: RemoteDispatcher

  beforeEach(() => {
    registry = new CommandRegistry()
    dispatcher = new RemoteDispatcher(registry)
  })

  it('throws when dispatching to an unregistered channel', async () => {
    await expect(dispatcher.handle(makeRequest('ghost:channel'), remoteConn)).rejects.toThrow(
      /Channel not available: ghost:channel/
    )
  })

  it('propagates handler errors for allowed channels', async () => {
    registry.register({
      channel: 'test:boom',
      capability: 'chat',
      kind: 'query',
      transport: 'remote',
      handler: async () => {
        throw new Error('fail')
      }
    })
    await expect(dispatcher.handle(makeRequest('test:boom'), remoteConn)).rejects.toThrow('fail')
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
    // gitWatchRegistry is a module singleton shared with the desktop IPC path —
    // unwind the remote owner so watch state can't leak between tests.
    gitWatchRegistry.releaseOwner(GIT_WATCH_OWNER_REMOTE)
    clearSyncSubscribersForTests()
    vi.clearAllMocks()
  })

  it("routes 'xeng:'-prefixed approval responses to the cross-engine dispatcher (ADR-033)", async () => {
    await dispatcher.handle(
      makeRequest('session:approval-response', 'rid-1', 'xeng:perm-7', 'deny', { feedback: 'no' }),
      remoteConn
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
    await dispatcher.handle(makeRequest('session:approval-response', 'rid-1', 'req-1', 'allow'), remoteConn)
    expect(sessionStub.resolveApproval).toHaveBeenCalledWith('req-1', 'allow', undefined, undefined)
    expect(crossEngineSpies.resolveApproval).not.toHaveBeenCalled()
  })

  it("routes a known dispatch toolUseId to the cross-engine dispatcher's stopDispatch, scoped by routingId (ADR-033 M3)", async () => {
    crossEngineSpies.stopDispatch.mockReturnValueOnce(true)
    const res = await dispatcher.handle(
      makeRequest('session:stop-task', 'rid-1', 'toolu_dispatch_1'),
      remoteConn
    )
    expect(crossEngineSpies.stopDispatch).toHaveBeenCalledWith('toolu_dispatch_1', 'rid-1')
    expect(res).toEqual({ success: true })
    expect(sessionStub.stopTask).not.toHaveBeenCalled()
  })

  it('falls through to the session stopTask when the id is not a known dispatch', async () => {
    const res = await dispatcher.handle(makeRequest('session:stop-task', 'rid-1', 'toolu_ordinary_1'), remoteConn)
    expect(crossEngineSpies.stopDispatch).toHaveBeenCalledWith('toolu_ordinary_1', 'rid-1')
    expect(sessionStub.stopTask).toHaveBeenCalledWith('toolu_ordinary_1')
    expect(res).toEqual({ success: true })
  })

  it('isDispatch=true: arms a durable stop-intent, returns success even with no live turn, never touches the session path', async () => {
    // Default stopDispatch mock returns false — the upstream race window.
    const res = await dispatcher.handle(
      makeRequest('session:stop-task', 'rid-1', 'toolu_disp_racy', true),
      remoteConn
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

  it('does NOT expose desktop-only channels on the remote transport', () => {
    const channels = dispatcher.channels()
    expect(channels).not.toContain('session:pick-folder')
    expect(channels).not.toContain('app:quit-confirm')
    expect(channels).not.toContain('window:minimize')
  })

  it('session:send dispatches to session.run + broadcasts', async () => {
    await dispatcher.handle(makeRequest('session:send', 'rid-1', 'hi'), remoteConn)
    expect(sessionStub.run).toHaveBeenCalledWith('hi', undefined)
    expect(win.webContents.send).toHaveBeenCalledWith(
      'session:user-message',
      'rid-1',
      expect.objectContaining({ prompt: 'hi' })
    )
  })

  // ADR-053 — a queued send produces a queue item, never a user-message relay.
  it('session:send on a busy session enqueues instead of broadcasting', async () => {
    sessionStub.willQueue = true
    try {
      await dispatcher.handle(makeRequest('session:send', 'rid-1', 'later'), remoteConn)
    } finally {
      sessionStub.willQueue = false
    }
    expect(sessionStub.enqueuePrompt).toHaveBeenCalledWith('later', undefined)
    expect(win.webContents.send).not.toHaveBeenCalledWith(
      'session:user-message',
      'rid-1',
      expect.anything()
    )
  })

  it('session:send rejects when routingId not found', async () => {
    sessionManagerStub.get.mockReturnValueOnce(undefined)
    await expect(dispatcher.handle(makeRequest('session:send', 'missing', 'x'), remoteConn)).rejects.toThrow(
      /No session for routingId/
    )
  })

  it('session:cancel dispatches to manager.cancel', async () => {
    await dispatcher.handle(makeRequest('session:cancel', 'rid-1'), remoteConn)
    expect(sessionManagerStub.cancel).toHaveBeenCalledWith('rid-1')
  })

  it('config:load-settings returns settings', async () => {
    const res = await dispatcher.handle(makeRequest('config:load-settings'), remoteConn)
    expect(res).toEqual({ theme: 'dark' })
  })

  it('usage:fetch dispatches to usageFetcher.fetch', async () => {
    const res = await dispatcher.handle(makeRequest('usage:fetch'), remoteConn)
    expect(res).toEqual({ a: 1 })
  })

  it('mcp:status returns empty when session missing', async () => {
    sessionManagerStub.get.mockReturnValueOnce(undefined)
    const res = await dispatcher.handle(makeRequest('mcp:status', 'ghost'), remoteConn)
    expect(res).toEqual([])
  })

  it('mcp:status routes to session.mcpServerStatus when session present', async () => {
    const res = await dispatcher.handle(makeRequest('mcp:status', 'rid-1'), remoteConn)
    expect(res).toEqual([{ name: 'srv', connected: true }])
    expect(sessionStub.mcpServerStatus).toHaveBeenCalled()
  })

  // ISession optional-member safety (Item 3) — isClaudeSession casts were
  // replaced with capability checks + optional-call (`?.`) + neutral forEach.
  describe('ISession optional-member safety (Item 3)', () => {
    it('claude:set-cleanup-period triggers notifySettingsChanged via the neutral forEach', async () => {
      await dispatcher.handle(makeRequest('claude:set-cleanup-period', 30), remoteConn)
      expect(sessionStub.notifySettingsChanged).toHaveBeenCalled()
    })

    it('mcp:status returns [] without throwing for a capability-true session lacking mcpServerStatus', async () => {
      sessionManagerStub.get.mockReturnValueOnce({
        engineId: 'claude',
        capabilities: resolveClaudeCapabilities('default')
        // No mcpServerStatus method.
      })
      const res = await dispatcher.handle(makeRequest('mcp:status', 'rid-min'), remoteConn)
      expect(res).toEqual([])
    })
  })

  // Guard: `claude:save-permissions` was desktop-only — the channel was never
  // registered on the dispatcher (the web api-adapter stubbed the call out to a
  // silent no-op), so editing permissions from the remote client did nothing.
  describe('claude:save-permissions (remote write parity)', () => {
    const PERMS = {
      allow: ['Bash(git:*)'],
      deny: [],
      ask: [],
      additionalDirectories: [],
      defaultMode: undefined
    }

    it('is registered on the dispatcher', () => {
      expect(dispatcher.channels()).toContain('claude:save-permissions')
    })

    it('persists the rules and hot-reloads sessions for a user-scope write', async () => {
      await dispatcher.handle(makeRequest('claude:save-permissions', 'user', PERMS, undefined), remoteConn)
      expect(claudeSettingsSpies.saveClaudePermissions).toHaveBeenCalledWith(
        'user',
        PERMS,
        undefined
      )
      expect(sessionStub.notifySettingsChanged).toHaveBeenCalled()
    })

    it('notifies user-scope writes even when a cwd is supplied (rules are global)', async () => {
      await dispatcher.handle(makeRequest('claude:save-permissions', 'user', PERMS, '/other/repo'), remoteConn)
      expect(sessionStub.notifySettingsChanged).toHaveBeenCalled()
    })

    it('scopes a project-scope write to sessions on that cwd', async () => {
      await dispatcher.handle(makeRequest('claude:save-permissions', 'project', PERMS, '/repo-a'), remoteConn)
      expect(claudeSettingsSpies.saveClaudePermissions).toHaveBeenCalledWith(
        'project',
        PERMS,
        '/repo-a'
      )
      // sessionStub has no cwd → not this workspace → left alone.
      expect(sessionStub.notifySettingsChanged).not.toHaveBeenCalled()

      sessionManagerStub.forEach.mockImplementationOnce((cb: (s: any) => void) =>
        cb({ ...sessionStub, cwd: '/repo-a' })
      )
      await dispatcher.handle(makeRequest('claude:save-permissions', 'project', PERMS, '/repo-a'), remoteConn)
      expect(sessionStub.notifySettingsChanged).toHaveBeenCalledTimes(1)
    })

    it('survives a session whose notifySettingsChanged rejects', async () => {
      sessionStub.notifySettingsChanged.mockRejectedValueOnce(new Error('child is gone'))
      await expect(
        dispatcher.handle(makeRequest('claude:save-permissions', 'user', PERMS, undefined), remoteConn)
      ).resolves.toBeUndefined()
    })
  })

  it('claude:workspace-trust reports the trust flag for a cwd', async () => {
    claudeSettingsSpies.isWorkspaceTrusted.mockReturnValueOnce(false)
    const res = await dispatcher.handle(makeRequest('claude:workspace-trust', '/repo-a'), remoteConn)
    expect(claudeSettingsSpies.isWorkspaceTrusted).toHaveBeenCalledWith('/repo-a')
    expect(res).toBe(false)
  })

  it('file:list-dir returns structured result on error (no throw)', async () => {
    // Invalid path → handler catches internally and returns default shape.
    const res: any = await dispatcher.handle(
      makeRequest('file:list-dir', '/does/not/exist/zzzzz-unique'),
      remoteConn
    )
    expect(res).toHaveProperty('entries')
    expect(res).toHaveProperty('isRoot')
    expect(res).toHaveProperty('resolvedPath')
    expect(Array.isArray(res.entries)).toBe(true)
  })

  it('session:stop-task returns error shape when session missing', async () => {
    sessionManagerStub.get.mockReturnValueOnce(undefined)
    const res = await dispatcher.handle(makeRequest('session:stop-task', 'ghost', 'tool-1'), remoteConn)
    expect(res).toEqual({ success: false, error: 'No active session' })
  })

  it('session:dequeue-message returns {removed:0} when session missing', async () => {
    sessionManagerStub.get.mockReturnValueOnce(undefined)
    const res = await dispatcher.handle(makeRequest('session:dequeue-message', 'ghost', 'val'), remoteConn)
    expect(res).toEqual({ removed: 0 })
  })

  // Regression: these were missing from both the dispatcher and the web
  // api-adapter, so the remote client either crashed (undefined method) or
  // hit "Channel not available". They're now wired end-to-end.
  describe('newly-bridged channels', () => {
    it('session:interrupt routes to manager.interrupt', async () => {
      await dispatcher.handle(makeRequest('session:interrupt', 'rid-1'), remoteConn)
      expect(sessionManagerStub.interrupt).toHaveBeenCalledWith('rid-1')
    })

    it('session:set-thinking-mode routes to session.setThinkingMode', async () => {
      await dispatcher.handle(makeRequest('session:set-thinking-mode', 'rid-1', 'think'), remoteConn)
      expect(sessionStub.setThinkingMode).toHaveBeenCalledWith('think')
    })

    it('session:ask-side-question returns the session answer', async () => {
      const res = await dispatcher.handle(makeRequest('session:ask-side-question', 'rid-1', 'q?'), remoteConn)
      expect(sessionStub.askSideQuestion).toHaveBeenCalledWith('q?')
      expect(res).toBe('answer')
    })

    it('session:ask-side-question returns null when session missing', async () => {
      sessionManagerStub.get.mockReturnValueOnce(undefined)
      const res = await dispatcher.handle(makeRequest('session:ask-side-question', 'ghost', 'q?'), remoteConn)
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
    const res = await dispatcher.handle(makeRequest('app:version-info'), remoteConn)
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
      const res = await dispatcher.handle(makeRequest('mockup:read-html', cwd, 'm1'), remoteConn)
      expect(res).toBe('<h1>hello</h1>')
    })

    it('mockup:read-html rejects for a missing mockup', async () => {
      await expect(
        dispatcher.handle(makeRequest('mockup:read-html', cwd, 'does-not-exist'), remoteConn)
      ).rejects.toThrow()
    })

    // R6 GUARD (fails pre-fix — the handler joined cwd+directory with no
    // containment, so a '../'-laden directory escaped the mockups root).
    it('mockup:read-html rejects a path-traversal directory', async () => {
      // Drop a file OUTSIDE the mockups root that a traversal would try to reach.
      const outside = path.join(cwd, '.claude', 'ui', 'secret.html')
      fs.writeFileSync(outside, '<h1>secret</h1>')
      await expect(
        dispatcher.handle(makeRequest('mockup:read-html', cwd, '../../secret'), remoteConn)
      ).rejects.toThrow(/Invalid mockup directory/)
      // Sanity: the in-root path still works (non-vacuous).
      const ok = await dispatcher.handle(makeRequest('mockup:read-html', cwd, 'm1'), remoteConn)
      expect(ok).toBe('<h1>hello</h1>')
    })

    it('mockup:watch/unwatch are idempotent and tolerate a missing directory', async () => {
      // Missing dir → no-op, no throw.
      await expect(
        dispatcher.handle(makeRequest('mockup:watch', cwd, 'ghost'), remoteConn)
      ).resolves.toBeUndefined()
      // Real dir → watches; second call is a no-op (already watching).
      await dispatcher.handle(makeRequest('mockup:watch', cwd, 'm1'), remoteConn)
      await dispatcher.handle(makeRequest('mockup:watch', cwd, 'm1'), remoteConn)
      // Unwatch tears down without throwing; double-unwatch is safe.
      await dispatcher.handle(makeRequest('mockup:unwatch', cwd, 'm1'), remoteConn)
      await expect(
        dispatcher.handle(makeRequest('mockup:unwatch', cwd, 'm1'), remoteConn)
      ).resolves.toBeUndefined()
    })
  })

  // R5 — full channel parity (user decision: register every channel the web
  // api-adapter invokes that a remote grant covers). These were missing from the
  // dispatcher, so the web client hit "Channel not available" for git, live
  // transcript watching, multi-engine catalogs, account state, etc.
  describe('full channel parity (R5)', () => {
    it('registers the full git surface incl. mutations', () => {
      const channels = dispatcher.channels()
      for (const ch of [
        'git:check-repo',
        'git:status',
        'git:branches',
        'git:checkout',
        'git:create-branch',
        'git:file-patch',
        'git:file-contents',
        'git:stage-file',
        'git:unstage-file',
        'git:discard-file',
        'git:stage-all',
        'git:unstage-all',
        'git:commit',
        'git:push',
        'git:push-with-upstream',
        'git:pull',
        'git:fetch',
        // Live watching: previously unregistered web no-ops, which is why the
        // remote client's gitStatus stayed null and its changes pill never
        // rendered. Now routed through the shared gitWatchRegistry.
        'git:start-watching',
        'git:stop-watching'
      ]) {
        // Exposure now means "registered for the remote transport"; that the
        // capability is also granted is pinned by the parity block at the
        // bottom of this file.
        expect(channels).toContain(ch)
      }
    })

    it('git:start-watching registers the remote owner and starts exactly one poller', async () => {
      await expect(
        dispatcher.handle(makeRequest('git:start-watching', '/tmp/proj'), remoteConn)
      ).resolves.toBeUndefined()
      expect(gitManagerSpies.get).toHaveBeenCalledWith('/tmp/proj')
      expect(gitSvcStub.startPolling).toHaveBeenCalledTimes(1)
      expect(gitWatchRegistry.ownersOf('/tmp/proj')).toEqual([GIT_WATCH_OWNER_REMOTE])

      // A second remote client on the same cwd attaches; it must NOT re-start the
      // poller (that would replace the live callback).
      await dispatcher.handle(makeRequest('git:start-watching', '/tmp/proj'), remoteConn)
      expect(gitSvcStub.startPolling).toHaveBeenCalledTimes(1)
    })

    it('a remote poll reaches the injected fan-out (i.e. the bridge/extra windows)', async () => {
      const pushed: Array<{ cwd: string; status: unknown }> = []
      // registerRemoteHandlers never installs a fan-out (session.ipc.ts owns the
      // window handles and does that), so the singleton's broadcast is null here.
      // Detach again at the end or this closure would silently become the
      // broadcast for every later test in this file.
      gitWatchRegistry.init((cwd, status) => pushed.push({ cwd, status }))
      try {
        await dispatcher.handle(makeRequest('git:start-watching', '/tmp/proj'), remoteConn)
        const emit = gitSvcStub.startPolling.mock.calls[0][0] as (s: unknown) => void
        emit({ files: [], branch: 'main' })
        expect(pushed).toEqual([{ cwd: '/tmp/proj', status: { files: [], branch: 'main' } }])
      } finally {
        gitWatchRegistry.init(null)
      }
    })

    it('git:stop-watching releases the remote owner and stops the poller', async () => {
      await dispatcher.handle(makeRequest('git:start-watching', '/tmp/proj'), remoteConn)
      await expect(
        dispatcher.handle(makeRequest('git:stop-watching', '/tmp/proj'), remoteConn)
      ).resolves.toBeUndefined()
      expect(gitSvcStub.stopPolling).toHaveBeenCalledTimes(1)
      expect(gitManagerSpies.release).toHaveBeenCalledWith('/tmp/proj')
      expect(gitWatchRegistry.ownersOf('/tmp/proj')).toEqual([])
    })

    it('git:stop-watching for a cwd nobody watches is a no-op', async () => {
      await expect(
        dispatcher.handle(makeRequest('git:stop-watching', '/tmp/never'), remoteConn)
      ).resolves.toBeUndefined()
      expect(gitSvcStub.stopPolling).not.toHaveBeenCalled()
    })

    it('registers the multi-engine + account + generation channels', () => {
      const channels = dispatcher.channels()
      for (const ch of [
        'session:list-opencode',
        'session:load-opencode-history',
        'session:list-pi',
        'session:load-pi-history',
        'session:get-engine-models',
        'session:get-pi-model-catalog',
        'session:get-opencode-providers',
        'session:get-opencode-provider-models',
        'session:watch-session',
        'session:unwatch-session',
        'session:set-reasoning-variant',
        'session:write-custom-title',
        'session:generate-title',
        'session:generate-commit-message',
        'engine:is-installed',
        'pi:auth-status',
        'pi:binary-path',
        'account:get'
      ]) {
        expect(channels).toContain(ch)
      }
    })

    it('git:commit dispatches to the service with get/release bracketing', async () => {
      const res = await dispatcher.handle(makeRequest('git:commit', '/tmp/proj', 'msg'), remoteConn)
      expect(gitManagerSpies.get).toHaveBeenCalledWith('/tmp/proj')
      expect(gitSvcStub.commit).toHaveBeenCalledWith('msg')
      expect(gitManagerSpies.release).toHaveBeenCalledWith('/tmp/proj')
      expect(res).toBe('sha')
    })

    it('git service is released even when the operation throws', async () => {
      gitSvcStub.push.mockRejectedValueOnce(new Error('remote rejected'))
      await expect(dispatcher.handle(makeRequest('git:push', '/tmp/proj'), remoteConn)).rejects.toThrow(
        'remote rejected'
      )
      expect(gitManagerSpies.release).toHaveBeenCalledWith('/tmp/proj')
    })

    it('account:get returns the account-manager state', async () => {
      const res = await dispatcher.handle(makeRequest('account:get'), remoteConn)
      expect(res).toEqual({ enabled: false, accounts: [] })
    })

    it('engine:is-installed reports claude=true, opencode/pi from the binary probes', async () => {
      expect(await dispatcher.handle(makeRequest('engine:is-installed', 'claude'), remoteConn)).toBe(true)
      expect(await dispatcher.handle(makeRequest('engine:is-installed', 'opencode'), remoteConn)).toBe(false)
      expect(await dispatcher.handle(makeRequest('engine:is-installed', 'pi'), remoteConn)).toBe(false)
    })

    it('does NOT register account mutations (they are admin-capability)', () => {
      const channels = dispatcher.channels()
      for (const ch of ['account:add', 'account:switch', 'account:delete', 'account:set-enabled']) {
        expect(channels).not.toContain(ch)
      }
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
        ),
        remoteConn
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

      await dispatcher.handle(makeRequest('session:create', 'rid-sandbox', '/tmp/proj'), remoteConn)

      expect(sessionManagerStub.create).toHaveBeenCalled()
      // manager.create's 4th positional arg (index 3) is the EngineSpawnOptions object.
      expect(sessionManagerStub.create.mock.calls[0][3].sandboxConfig).toEqual(SENTINEL)
    })

    it('claude path (default engineId) applies vendor config and skips opencode resolution', async () => {
      await dispatcher.handle(makeRequest('session:create', 'rid-claude', '/tmp/proj'), remoteConn)

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
        ),
        remoteConn
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
      await dispatcher.handle(makeRequest('session:create', 'rid-broadcast', '/tmp/proj'), remoteConn)

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
        }),
        remoteConn
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

      await dispatcher.handle(makeRequest('config:save-settings', { theme: 'dark' }), remoteConn)
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
        }),
        remoteConn
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
        }),
        remoteConn
      )

      expect(win.webContents.send).toHaveBeenCalledWith(
        'config:settings-changed',
        expect.not.objectContaining({ sandbox: expect.anything() })
      )
    })
  })
  // LOW-RW3 — session:write-custom-title interpolates both caller-supplied
  // identifiers straight into ~/.claude/projects/<projectKey>/<sessionId>.jsonl.
  // This handler is reachable by ANY token-holding remote client, so a
  // traversal segment let a remote peer append attacker-controlled JSON to an
  // arbitrary *.jsonl on the host.
  describe('session:write-custom-title path-segment validation', () => {
    let appendSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      appendSpy = vi.spyOn(fs.promises, 'appendFile').mockResolvedValue(undefined)
    })

    afterEach(() => {
      appendSpy.mockRestore()
    })

    it.each([
      ['..', 'sess-1'],
      ['a/b', 'sess-1'],
      ['a\\b', 'sess-1'],
      ['../../..', 'sess-1'],
      ['proj', '..'],
      ['proj', 'a/b'],
      ['proj', 'a\\b'],
      ['proj', '../../etc/evil']
    ])(
      'rejects traversal (projectKey=%j, sessionId=%j) without writing (GUARD — fails pre-fix)',
      async (projectKey, sessionId) => {
        await expect(
          dispatcher.handle(
            makeRequest('session:write-custom-title', sessionId, projectKey, 'pwned'),
            remoteConn
          )
        ).rejects.toThrow(/Invalid (sessionId|projectKey)/)
        expect(appendSpy).not.toHaveBeenCalled()
      }
    )

    it('rejects empty identifiers without writing', async () => {
      await expect(
        dispatcher.handle(makeRequest('session:write-custom-title', '', 'proj', 't'), remoteConn)
      ).rejects.toThrow(/Invalid sessionId/)
      await expect(
        dispatcher.handle(makeRequest('session:write-custom-title', 'sess-1', '', 't'), remoteConn)
      ).rejects.toThrow(/Invalid projectKey/)
      expect(appendSpy).not.toHaveBeenCalled()
    })

    it('still writes for plain identifiers, under the projects root', async () => {
      await dispatcher.handle(
        makeRequest('session:write-custom-title', 'sess-1', '-d-proj', 'My title'),
        remoteConn
      )
      expect(appendSpy).toHaveBeenCalledTimes(1)
      const [target, payload] = appendSpy.mock.calls[0]
      expect(String(target)).toBe(
        path.join(os.homedir(), '.claude', 'projects', '-d-proj', 'sess-1.jsonl')
      )
      expect(String(payload)).toContain('"customTitle":"My title"')
    })
  })
})

// ---------------------------------------------------------------------------
// PARITY PIN — "zero change to the effective remote surface" (SyncCore phase 1).
//
// Encoded LITERALLY from the pre-port registrations (`dispatcher.register(...)`
// in remote-handlers.ts) minus the then-dispatcher's BLOCKED denylist — which
// subtracted nothing, because the denylist and the registration set never
// overlapped: the denylist was belt-and-braces over an explicit allowlist.
//
// This is the review gate for the port. It runs against the REAL shared
// registry after the real registrars, so it fails on a channel that silently
// gained or lost remote reachability — including via a capability change,
// since every listed channel must also resolve under the legacy grant set.
//
// Later phases add to this list ONLY with a deliberate, reviewed entry:
//   - `session:recall-queued` (phase 3 / ADR-053) — the itemized replacement
//     for `session:dequeue-message`, same `chat` capability as the channel it
//     supersedes, so the effective remote surface is unchanged in substance.
// ---------------------------------------------------------------------------

const PRE_PORT_REMOTE_CHANNELS = [
  'account:get',
  'app:version-info',
  'claude:get-cleanup-period',
  'claude:load-permissions',
  'claude:save-permissions',
  'claude:set-cleanup-period',
  'claude:workspace-trust',
  'config:load-sessions',
  'config:load-settings',
  'config:load-skill-details',
  'config:load-slash-commands',
  'config:save-sessions',
  'config:save-settings',
  'config:scan-custom-commands',
  'engine:is-installed',
  'file:list-dir',
  'git:branches',
  'git:check-repo',
  'git:checkout',
  'git:commit',
  'git:create-branch',
  'git:discard-file',
  'git:fetch',
  'git:file-contents',
  'git:file-patch',
  'git:pull',
  'git:push',
  'git:push-with-upstream',
  'git:stage-all',
  'git:stage-file',
  'git:start-watching',
  'git:status',
  'git:stop-watching',
  'git:unstage-all',
  'git:unstage-file',
  'mcp:load-servers',
  'mcp:read-disabled',
  'mcp:status',
  'mockup:read-html',
  'mockup:unwatch',
  'mockup:watch',
  'pi:auth-status',
  'pi:binary-path',
  'session:approval-response',
  'session:ask-side-question',
  'session:background-task',
  'session:build-subagent-file-map',
  'session:cancel',
  'session:create',
  'session:delete-project',
  'session:delete-session',
  'session:dequeue-message',
  'session:generate-commit-message',
  'session:generate-title',
  'session:get-engine-models',
  'session:get-models',
  'session:get-opencode-provider-models',
  'session:get-opencode-providers',
  'session:get-pi-model-catalog',
  'session:get-plan-content',
  'session:get-session-log-path',
  'session:interrupt',
  'session:list-directories',
  'session:list-opencode',
  'session:list-pi',
  'session:load-background-output',
  'session:load-history',
  'session:load-opencode-history',
  'session:load-pi-history',
  'session:load-subagent-history',
  'session:read-background-range',
  'session:recall-queued',
  'session:rekey',
  'session:remove-opencode-provider',
  'session:resolve-fork-anchor',
  'session:send',
  'session:set-effort',
  'session:set-model',
  'session:set-opencode-provider-disabled',
  'session:set-permission-mode',
  'session:set-reasoning-variant',
  'session:set-thinking-mode',
  'session:stop-task',
  'session:unwatch-background',
  'session:unwatch-session',
  'session:watch-background',
  'session:watch-session',
  'session:write-custom-title',
  'shared-provider:list',
  'shared-provider:models',
  'shared-provider:statuses',
  'usage:fetch',
  'usage:fetch-block',
  'usage:fetch-dispatched',
  'usage:set-account-filter',
] as const

/**
 * THE ONE SANCTIONED SURFACE CHANGE since the phase-1 port (SyncCore phase 2,
 * ADR-052 decision 6 / security.md §"Terminal posture").
 *
 * Why this is not the failure mode the pin above exists to catch: every channel
 * here declares `shell`, which is NOT in {@link LEGACY_REMOTE_GRANTS}, so
 * registering them changes nothing about what an authenticated connection can
 * do. Reaching them requires all three gates, all enforced server-side —
 * (1) the desktop-only `allow_terminal` toggle (persisted in `remote_config`,
 * never in remotely-writable settings), (2) a step-up ceremony that verifies a
 * fresh password proof against the same failure budget as auth, and (3) an idle
 * decay on the grant that ceremony arms.
 *
 * `terminal:availability` is the exception's exception: `config`-capability
 * (hence reachable) because a client must be able to ask "may I?" WITHOUT
 * already holding the answer. It returns three booleans and nothing else.
 *
 * `terminal:kill-by-cwd` is deliberately absent — that lifecycle sweep belongs
 * to the desktop's own cold-session cleanup, and a remote client has no reason
 * to mass-kill the operator's shells.
 */
const PHASE2_TERMINAL_CHANNELS = [
  'terminal:attach',
  'terminal:availability',
  'terminal:create',
  'terminal:detach',
  'terminal:kill',
  'terminal:resize',
  'terminal:write'
] as const

/** Of those, the ones gated behind the `shell` capability (i.e. all but availability). */
const PHASE2_SHELL_CHANNELS = PHASE2_TERMINAL_CHANNELS.filter((c) => c !== 'terminal:availability')

describe('remote surface parity (phase 1 port)', () => {
  let win: any

  beforeEach(() => {
    win = makeFakeWindow()
    registerRemoteHandlers(new RemoteDispatcher(), sessionManagerStub, win)
    // Registered later in the real bootstrap, once build versions are known.
    registerRemoteVersionInfo({ appVersion: '1', sdkVersion: '2', cliVersion: '3' })
  })

  afterEach(() => {
    gitWatchRegistry.releaseOwner(GIT_WATCH_OWNER_REMOTE)
  })

  it('exposes exactly the pre-port channel set plus the phase-2 terminal channels', () => {
    expect(commandRegistry.channels('remote')).toEqual(
      [...PRE_PORT_REMOTE_CHANNELS, ...PHASE2_TERMINAL_CHANNELS].sort()
    )
  })

  it('every exposed channel except the shell-gated terminal ones is reachable under the legacy grant set', () => {
    const unreachable = commandRegistry
      .channels('remote')
      .map((c) => [c, commandRegistry.declaration(c)!.capability] as const)
      .filter(([, cap]) => !LEGACY_REMOTE_GRANTS.has(cap))
    expect(
      unreachable,
      `these channels declare a capability remote connections do not hold: ${unreachable
        .map(([c, cap]) => `${c}(${cap})`)
        .join(', ')}`
    ).toEqual(PHASE2_SHELL_CHANNELS.map((c) => [c, 'shell'] as const))
  })

  it('the phase-2 terminal channels are unreachable WITHOUT a step-up grant', async () => {
    // The registration is not the gate — the grant set is. A connection holding
    // the standard remote grants is refused by the registry itself.
    const conn = makeRemoteConnection('token', null)
    for (const channel of PHASE2_SHELL_CHANNELS) {
      await expect(
        commandRegistry.dispatch(channel, 'remote', ['x'], conn),
        `${channel} must require the shell capability`
      ).rejects.toThrow(/Permission denied/)
    }
    // …and the honesty query stays answerable without it.
    await expect(
      commandRegistry.dispatch('terminal:availability', 'remote', [], conn)
    ).resolves.toMatchObject({ allowed: false, granted: false })
  })

  it('exposes no channel whose capability the old denylist stood for, except the terminal ones', () => {
    const exposed = new Set(commandRegistry.channels('remote'))
    const sanctioned = new Set<string>(PHASE2_SHELL_CHANNELS)
    for (const channel of Object.keys(PINNED_CAPABILITIES)) {
      if (sanctioned.has(channel)) continue
      expect(exposed.has(channel), `${channel} must not be on the remote surface`).toBe(false)
    }
  })
})
