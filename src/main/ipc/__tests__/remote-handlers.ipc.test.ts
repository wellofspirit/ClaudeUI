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
import {
  AUTHCFG_CHANNELS as CLASSIFIED_AUTHCFG_CHANNELS,
  AUTHCFG_FREE_CHANNELS as CLASSIFIED_AUTHCFG_FREE_CHANNELS,
  SHELL_ACT_VERBS,
  SHELL_READ_VERBS
} from '../../services/step-up-tier'
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
    registerRemoteHandlers(dispatcher, sessionManagerStub)
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
    // ADR-052 passkeys: registered for remote, but behind `enroll`/`admin`,
    // neither of which a token/tailnet connection ever holds.
    for (const channel of [
      'webauthn:register-options',
      'webauthn:register-verify',
      'webauthn:credentials',
      'webauthn:rename',
      'webauthn:revoke',
      'webauthn:mint-enroll-token'
    ])
      expect(channels).toContain(channel)
  })

  it('does NOT expose desktop-only channels on the remote transport', () => {
    const channels = dispatcher.channels()
    expect(channels).not.toContain('session:pick-folder')
    expect(channels).not.toContain('app:quit-confirm')
    expect(channels).not.toContain('window:minimize')
  })

  it('keeps every remote:* server-config channel OFF the remote transport (ADR-052 `off`)', () => {
    // The auth policy — including the `off` master switch — is written ONLY
    // through `remote:set-config`. That channel having no remote registration is
    // the structural reason a remote client can never disable authentication;
    // the `admin` pin alone is no longer sufficient, because a passkey
    // connection DOES hold `admin`.
    const channels = dispatcher.channels()
    for (const channel of [
      'remote:get-config',
      'remote:set-config',
      'remote:set-password',
      'remote:clear-password',
      'remote:tailscale-detect',
      'remote:force-reserve'
    ])
      expect(channels).not.toContain(channel)
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
  // The volatile lane's subscription verb (SyncCore phase 5 S1). `chat`, and a
  // QUERY — a subscription toggle with no domain effect, so it is unaudited.
  'stream:watch',
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

/**
 * Terminal channels added AFTER the phase-2 widening, listed separately for the
 * same reason {@link POST_PORT_CHANNELS} is: the set above is the record of
 * what that widening exposed, and later additions must read as their own
 * decision rather than be back-dated into it.
 *
 * `terminal:pool` reports which slots of a cwd hold a live pty — what the tab
 * strip badges "a shell is still running here" from, now that closing a tab
 * only detaches. It declares `shell`, so it joins the gated set below and
 * inherits every pin in this file.
 */
const POST_PHASE2_TERMINAL_CHANNELS = ['terminal:pool'] as const

/** Every terminal channel behind the `shell` capability (i.e. all but availability). */
const SHELL_GATED_CHANNELS = [
  ...PHASE2_TERMINAL_CHANNELS.filter((c) => c !== 'terminal:availability'),
  ...POST_PHASE2_TERMINAL_CHANNELS
]

/**
 * Channels added AFTER the phase-1 port, listed separately so the pre-port set
 * above stays a faithful record of what the port had to preserve.
 *
 * `session:clear-conversation` (F4) is `chat`, the same capability as
 * `session:cancel` and `session:send`: "start fresh" is a conversation action a
 * phone must be able to take, and it touches nothing outside the session it
 * names.
 */
const POST_PORT_CHANNELS = ['session:clear-conversation'] as const

/**
 * ADR-052 passkeys. Listed separately for the same reason the terminal set is:
 * these are the SECOND deliberate widening of the remote surface, and the pins
 * below must show them as an explicit decision rather than absorb them into the
 * pre-port baseline.
 *
 * Every one declares `enroll` or `admin`, neither of which is in
 * {@link LEGACY_REMOTE_GRANTS} — so registering them changed what a
 * passkey-authenticated connection can reach, and changed NOTHING for a
 * token/tailnet one.
 */
const PASSKEY_CHANNELS = [
  'webauthn:credentials',
  'webauthn:mint-enroll-token',
  'webauthn:register-options',
  'webauthn:register-verify',
  'webauthn:rename',
  'webauthn:revoke'
] as const

/**
 * ADR-054 decision 6 — the remote-access SETTINGS WRITES. The THIRD deliberate
 * widening, listed separately for the same reason the other two are.
 *
 * Every one declares `admin` (outside {@link LEGACY_REMOTE_GRANTS}, so
 * authenticating never suffices) AND is gated on a presence proof inside the
 * mutation window on every tier — the transport classifies this namespace as
 * `authcfg`. What makes the widening safe to review is what is ABSENT: the `off`
 * master switch. Auth-DISABLING operations stay host-anchor only and stay in
 * `remote:set-config`, which has no remote registration at all (pinned below).
 */
const AUTHCFG_WRITE_CHANNELS = ['authcfg:apply', 'authcfg:set-password'] as const

/**
 * The FREE half. Same `admin` gate, but no settings session demanded:
 * `authcfg:get` READS (the pane's default state is the read), and `authcfg:end`
 * only ever gives authority back — gating a revocation would let an operator
 * open an editor under `strong` and then be refused permission to close it.
 *
 * Listed apart from the writes because the pins below say different things about
 * them: all four are registered and all need `admin`, but only the writes may
 * appear in the classifier's `AUTHCFG_CHANNELS`.
 */
const AUTHCFG_FREE_CHANNELS_PIN = ['authcfg:end', 'authcfg:get'] as const

/** Everything in the namespace, for the registration pins. */
const AUTHCFG_CHANNELS = [...AUTHCFG_FREE_CHANNELS_PIN, ...AUTHCFG_WRITE_CHANNELS] as const

/** channel → the capability it must declare (the reachability decision). */
const PASSKEY_CAPABILITIES: Record<string, 'enroll' | 'admin'> = {
  'webauthn:register-options': 'enroll',
  'webauthn:register-verify': 'enroll',
  'webauthn:credentials': 'admin',
  'webauthn:mint-enroll-token': 'admin',
  'webauthn:rename': 'admin',
  'webauthn:revoke': 'admin'
}

describe('remote surface parity (phase 1 port)', () => {
  beforeEach(() => {
    // Subscribes a fake desktop client to the funnel, mirroring production's
    // "somebody else is listening too" (the parity assertions below read the
    // registry, not this sink).
    makeFakeWindow()
    registerRemoteHandlers(new RemoteDispatcher(), sessionManagerStub)
    // Registered later in the real bootstrap, once build versions are known.
    registerRemoteVersionInfo({ appVersion: '1', sdkVersion: '2', cliVersion: '3' })
  })

  afterEach(() => {
    gitWatchRegistry.releaseOwner(GIT_WATCH_OWNER_REMOTE)
  })

  it('exposes exactly the pre-port channel set plus the phase-2 terminal and passkey channels', () => {
    expect(commandRegistry.channels('remote')).toEqual(
      [
        ...PRE_PORT_REMOTE_CHANNELS,
        ...PHASE2_TERMINAL_CHANNELS,
        ...POST_PHASE2_TERMINAL_CHANNELS,
        ...POST_PORT_CHANNELS,
        ...PASSKEY_CHANNELS,
        ...AUTHCFG_CHANNELS
      ].sort()
    )
  })

  it('every exposed channel outside the shell/passkey sets is reachable under the legacy grant set', () => {
    const unreachable = commandRegistry
      .channels('remote')
      .map((c) => [c, commandRegistry.declaration(c)!.capability] as const)
      .filter(([, cap]) => !LEGACY_REMOTE_GRANTS.has(cap))
    // The complete list of channels a token/tailnet connection cannot reach:
    // the shell-gated terminal set (step-up) and the passkey set (a proven
    // human, or a one-time enrollment link). Anything else appearing here is a
    // channel that silently stopped being reachable — or started being one.
    const expected = [
      ...SHELL_GATED_CHANNELS.map((c) => [c, 'shell'] as const),
      ...PASSKEY_CHANNELS.map((c) => [c, PASSKEY_CAPABILITIES[c]] as const),
      ...AUTHCFG_CHANNELS.map((c) => [c, 'admin'] as const)
    ].sort(([a], [b]) => a.localeCompare(b))
    expect(
      [...unreachable].sort(([a], [b]) => a.localeCompare(b)),
      `these channels declare a capability remote connections do not hold: ${unreachable
        .map(([c, cap]) => `${c}(${cap})`)
        .join(', ')}`
    ).toEqual(expected)
  })

  it('the passkey channels are unreachable from a plain token connection', async () => {
    const conn = makeRemoteConnection('token', null)
    for (const channel of PASSKEY_CHANNELS) {
      await expect(
        commandRegistry.dispatch(channel, 'remote', ['x'], conn),
        `${channel} must require enroll/admin`
      ).rejects.toThrow(/Permission denied/)
    }
  })

  it('the authcfg channels are unreachable from a plain token connection', async () => {
    // The capability half of the gate. The FRESHNESS half (a presence proof
    // inside the mutation window, on every tier) is enforced at the transport
    // and asserted over a real socket in remote-step-up-tiers.test.ts.
    const conn = makeRemoteConnection('token', null)
    for (const channel of AUTHCFG_CHANNELS) {
      await expect(
        commandRegistry.dispatch(channel, 'remote', ['x'], conn),
        `${channel} must require admin`
      ).rejects.toThrow(/Permission denied/)
    }
  })

  it('every registered `shell` channel is classified read or act — exactly once', () => {
    // The LIVE half of the ADR-054 coverage pin (its static twin, over
    // PINNED_CAPABILITIES, is in services/__tests__/step-up-tier.test.ts). A new
    // terminal channel that nobody classified would silently take
    // `classifyDispatch`'s fail-closed ACT branch, which is the right failure but
    // the wrong way to find out.
    const shellChannels = commandRegistry
      .channels()
      .filter((c) => commandRegistry.declaration(c)!.capability === 'shell')
    expect(shellChannels.length).toBeGreaterThan(5)
    const unclassified = shellChannels.filter(
      (c) => !SHELL_READ_VERBS.has(c) && !SHELL_ACT_VERBS.has(c)
    )
    expect(unclassified, `unclassified shell verbs: ${unclassified.join(', ')}`).toEqual([])
    const both = shellChannels.filter((c) => SHELL_READ_VERBS.has(c) && SHELL_ACT_VERBS.has(c))
    expect(both, `classified BOTH ways: ${both.join(', ')}`).toEqual([])
  })

  it('the CLASSIFIER knows exactly the authcfg MUTATIONS that are registered', () => {
    // The coupling that makes the namespace's freshness rule real: a verb
    // registered here but missing from `AUTHCFG_CHANNELS` in step-up-tier.ts
    // would be classified `mutation` — i.e. silently FREE under the default
    // `medium` tier — instead of demanding a presence proof on every tier.
    // Compared against this file's own literal list so the pin stays
    // independent of the thing it is pinning.
    expect([...CLASSIFIED_AUTHCFG_CHANNELS].sort()).toEqual([...AUTHCFG_WRITE_CHANNELS].sort())
  })

  it('every registered authcfg channel is in EXACTLY ONE classifier set', () => {
    // The guard that keeps "outside the gated set" from ever meaning
    // "accidentally free". Two members of this namespace are legitimately exempt
    // (`authcfg:get` reads; `authcfg:end` only revokes), so "is it in
    // AUTHCFG_CHANNELS?" stopped being a complete question on its own — and a
    // new verb added to NEITHER set would be classified `mutation`, i.e.
    // reachable with no unlocked editor at all under the default tier.
    //
    // So the namespace is pinned as a partition: every registered channel is in
    // one set or the other, never both and never neither, and this file's own
    // literal lists say which. A verb someone forgets to classify fails here even
    // if they also forget to update these lists.
    const registered = commandRegistry.channels('remote').filter((c) => c.startsWith('authcfg:'))
    const gated = registered.filter((c) => CLASSIFIED_AUTHCFG_CHANNELS.has(c))
    const free = registered.filter((c) => CLASSIFIED_AUTHCFG_FREE_CHANNELS.has(c))
    expect(gated.sort()).toEqual([...AUTHCFG_WRITE_CHANNELS].sort())
    expect(free.sort()).toEqual([...AUTHCFG_FREE_CHANNELS_PIN].sort())
    expect([...gated, ...free].sort()).toEqual([...registered].sort())
    for (const channel of registered) {
      expect(
        CLASSIFIED_AUTHCFG_CHANNELS.has(channel) && CLASSIFIED_AUTHCFG_FREE_CHANNELS.has(channel),
        `${channel} is in BOTH sets`
      ).toBe(false)
    }
    // The one that must never be gated, stated on its own so the reason survives
    // a future edit to the lists above: Cancel has to work unconditionally.
    expect(CLASSIFIED_AUTHCFG_CHANNELS.has('authcfg:end')).toBe(false)
  })

  it('no remotely-registered channel can write the auth-DISABLING switch', () => {
    // ADR-054 decision 6, structurally. `remote:set-config` is the only writer of
    // `authPolicy: 'off'`, and it has no remote registration — so the host anchor
    // holds by construction rather than by a capability check (a passkey
    // connection DOES hold `admin`). The settings verbs that ARE web-reachable
    // live in their own namespace, and `authcfg:apply` refuses an `off` auth-mode
    // with a typed error (asserted in authcfg-commands.test.ts).
    expect(commandRegistry.channels('remote').filter((c) => c.startsWith('remote:'))).toEqual([])
    expect(commandRegistry.channels('remote').filter((c) => c.startsWith('authcfg:')).sort()).toEqual(
      [...AUTHCFG_CHANNELS].sort()
    )
  })

  it('declares the terminal KINDS the gates depend on', () => {
    // Since ADR-054 the shell idle deadline is refreshed by the read/act VERB
    // SETS, not by `kind` — `terminal:attach` is a `command` that reads and
    // `terminal:pool` is a `query` that is still a shell read, so keying the
    // refresh on `kind` would have been wrong in both directions (that coupling
    // is pinned in step-up-tier.test.ts).
    //
    // `kind` still carries the AUDIT contract, which is why these declarations
    // stay pinned: a terminal lifecycle channel relabelled `query` silently
    // stops being audited, and security.md §Audit requires spawn/attach/detach/
    // exit in the trail. `terminal:pool` is a `query` precisely because it moves
    // no lifecycle and has nothing to record.
    expect(commandRegistry.declaration('terminal:pool')).toMatchObject({
      capability: 'shell',
      kind: 'query'
    })
    for (const channel of ['terminal:create', 'terminal:kill', 'terminal:attach'] as const) {
      expect(commandRegistry.declaration(channel), channel).toMatchObject({
        capability: 'shell',
        kind: 'command'
      })
    }
  })

  it('the phase-2 terminal channels are unreachable WITHOUT a step-up grant', async () => {
    // The registration is not the gate — the grant set is. A connection holding
    // the standard remote grants is refused by the registry itself.
    const conn = makeRemoteConnection('token', null)
    for (const channel of SHELL_GATED_CHANNELS) {
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

  it('exposes no channel whose capability the old denylist stood for, except the sanctioned ones', () => {
    // Two sanctioned widenings, both deliberate and both behind a ceremony:
    // the terminal set (ADR-052 decision 6) and the passkey set (decision 1).
    // Everything else in the pin table must still be absent from the remote
    // surface — which, for `remote:set-config`, is what makes the `off` master
    // switch structurally unreachable from a remote client now that a passkey
    // connection holds `admin`.
    const exposed = new Set(commandRegistry.channels('remote'))
    const sanctioned = new Set<string>([...SHELL_GATED_CHANNELS, ...PASSKEY_CHANNELS])
    for (const channel of Object.keys(PINNED_CAPABILITIES)) {
      if (sanctioned.has(channel)) continue
      expect(exposed.has(channel), `${channel} must not be on the remote surface`).toBe(false)
    }
  })
})
