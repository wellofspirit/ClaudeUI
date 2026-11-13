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
import { closeMockupWatchersUnder } from '../../services/mockup-watch-registry'
import { setHostAuth, type HostAuth } from '../../host'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { WsInvokeRequest } from '../../../shared/remote-protocol'
import {
  describeRemoteSurface,
  readRemoteSurface,
  serializeRemoteSurface,
  REMOTE_SURFACE_PATH,
  REMOTE_SURFACE_UPDATE_COMMAND,
  type RemoteSurfaceEntry
} from '../../../test/helpers/remote-surface'

// ---------------------------------------------------------------------------
// Mocks for every service remote-handlers.ts imports.
// ---------------------------------------------------------------------------

vi.mock('../../services/session-history', () => ({
  listDirectories: vi.fn(async () => [{ id: 'dir-1' }]),
  loadSessionHistory: vi.fn(async () => [{ id: 'm1' }]),
  loadSessionStatusLine: vi.fn(async () => ({ totalCostUsd: 1 })),
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
  loadVendorConfig: vi.fn(() => ({})),
  loadSharedAutoModeConfig: vi.fn(() => ({})),
  saveSharedAutoModeConfig: vi.fn()
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
  opencodeServerManager: {
    setServerStartedHook: () => {},
    isBinaryAvailable: vi.fn(() => false)
  }
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
  locatePiBinary: vi.fn(() => null),
  locatePiDisplayPath: vi.fn(() => null)
}))

// `engine:is-installed` is the harness resolver's answer (ADR-082), tested in
// src/core/harness; here only the routing matters, off the real vendor/ tree.
vi.mock('../../harness/resolve', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../harness/resolve')>()),
  engineInstalled: vi.fn(() => false)
}))

vi.mock('../../auth/vault/CredentialSync', () => ({
  credentialSync: { getStatus: vi.fn(() => ({ connected: false })) }
}))

vi.mock('../../../main/services/account-manager', () => ({
  accountManager: { getState: vi.fn(() => ({ enabled: false, accounts: [] })) }
}))

vi.mock('../../services/session-watcher', () => ({
  watchSession: vi.fn(),
  unwatchSession: vi.fn()
}))

vi.mock('../../services/opencode-session-list', () => ({
  listOpencodeSessionsGlobal: vi.fn(async () => []),
  loadOpencodeSessionHistory: vi.fn(async () => ({ messages: [], statusLine: null }))
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
  setProxyEnv: vi.fn()
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
  saveCleanupPeriodDays: vi.fn()
}))

const trustSpies = vi.hoisted(() => ({
  getWorkspaceTrust: vi.fn(),
  setWorkspaceTrust: vi.fn()
}))

vi.mock('../../services/claude-settings', () => ({
  loadClaudePermissions: vi.fn(() => ({ allow: [], deny: [], ask: [] })),
  loadCleanupPeriodDays: vi.fn(() => 30),
  saveCleanupPeriodDays: claudeSettingsSpies.saveCleanupPeriodDays,
  saveClaudePermissions: claudeSettingsSpies.saveClaudePermissions
}))

vi.mock('../../services/claude-workspace-trust', () => ({
  getWorkspaceTrust: trustSpies.getWorkspaceTrust,
  setWorkspaceTrust: trustSpies.setWorkspaceTrust
}))

vi.mock('../../services/claude-mcp', () => ({
  loadMcpServers: vi.fn(() => ({})),
  listMcpCatalog: vi.fn(() => ({ servers: [], skipped: [] })),
  readDisabledMcpServers: vi.fn(() => [])
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

// A SPY over the REAL prepareAndCreateSession: the null-normalisation guard
// below asserts on the args object the remote handler hands across the
// transport boundary, while every other `session:create` test in this file
// keeps exercising the real shared implementation underneath.
const createSessionSpy = vi.hoisted(() => ({ prepareAndCreateSession: vi.fn() }))

vi.mock('../create-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../create-session')>()
  createSessionSpy.prepareAndCreateSession.mockImplementation(actual.prepareAndCreateSession)
  return { ...actual, prepareAndCreateSession: createSessionSpy.prepareAndCreateSession }
})

// Import AFTER mocks.
import { cachedClaudeModels, resetCachedClaudeModels } from '../../services/claude-model-catalog'
import { hostAppVersion } from '../../host'
import { loadOpencodeSessionHistory } from '../../services/opencode-session-list'
import { dispatchLedger } from '../../services/dispatch-target-ledger'
import { getCliVersion } from '../../sdk/harness'
import { RemoteDispatcher } from '../../services/remote-dispatcher'
import {
  registerRemoteHandlers,
  registerRemoteVersionInfo,
  resetRemoteVersionInfoForTests
} from '../remote-handlers'
import {
  CommandRegistry,
  commandRegistry,
  makeRemoteConnection,
  AUTH_OFF_GRANTS,
  ENROLL_ONLY_GRANTS,
  PINNED_CAPABILITIES,
  type Capability
} from '../command-registry'
import { setAutomationManager } from '../automation-commands'
import {
  AUTHCFG_CHANNELS as CLASSIFIED_AUTHCFG_CHANNELS,
  AUTHCFG_FREE_CHANNELS as CLASSIFIED_AUTHCFG_FREE_CHANNELS,
  PASSKEY_ADMIN_CHANNELS as CLASSIFIED_PASSKEY_ADMIN_CHANNELS,
  SHELL_ACT_VERBS,
  classifyDispatch,
  SHELL_READ_VERBS
} from '../../services/step-up-tier'
import { gitWatchRegistry } from '../../services/git-watch-registry'
import { voiceRelay } from '../../services/voice-relay'
import { sharedProviderService } from '../../shared-providers'
import { resolveClaudeCapabilities } from '../../../shared/model-capabilities'
import {
  discoverOpencodeProviderCatalog,
  resolveOpencodeSpawnModel
} from '../../opencode/model-discovery'
import { discoverPiModels } from '../../pi/model-discovery'
import { opencodeServerManager } from '../../opencode/OpencodeServerManager'
import { setProxyEnv } from '../../sdk/proxy'
import { setEndpointEnv } from '../../sdk/endpoint-env'
import { setModelEnv } from '../../sdk/model-env'
import { usageFetcher } from '../../services/usage-fetcher'
import { blockUsageService } from '../../services/block-usage'
import { logger } from '../../services/logger'
import { startApplyingSettings } from '../../services/app-settings-apply'
import { getMockupSecuritySettings } from '../../services/mockup-settings'
import { blobStore } from '../../services/blob-store'
import { query } from '../../sdk'
import {
  loadSessionHistory as loadClaudeHistoryMock,
  loadSessionStatusLine as loadStatusLineMock,
  loadSubagentHistory as loadSubagentHistoryMock
} from '../../services/session-history'
import { engineInstalled } from '../../harness/resolve'

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
const remoteConn = makeRemoteConnection('password', null)

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
  queuedItems: [],
  enqueuePrompt: vi.fn(),
  recallQueued: vi.fn(async () => ({ recalled: ['a'], notRecalled: 0 })),
  applyConfig: vi.fn(async () => {}),
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
    // `account:get` now reads the core HostAuth seam (S2) rather than importing
    // account-manager directly — wire a stub with the state the test asserts on.
    setHostAuth({
      getAccountState: () => ({ enabled: false, accounts: [] })
    } as unknown as HostAuth)
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
    // The core side effects of a save run in `applySettings`, driven by the event the save emits.
    startApplyingSettings(sessionManagerStub)
  })

  afterEach(() => {
    // gitWatchRegistry is a module singleton shared with the desktop IPC path —
    // unwind this connection's interest so watch state can't leak between tests.
    gitWatchRegistry.releaseConnection(remoteConn.connectionId)
    clearSyncSubscribersForTests()
    vi.clearAllMocks()
  })

  it('still discovers pi when the unrelated Claude catalog fails', async () => {
    vi.mocked(query).mockImplementationOnce(() => {
      throw new Error('Claude unavailable')
    })
    const native = {
      engineId: 'pi' as const,
      vendorId: 'openai-codex',
      vendorName: 'ChatGPT',
      models: [{ value: 'native', displayName: 'Native', description: '', engineId: 'pi' as const }]
    }
    vi.mocked(discoverPiModels).mockResolvedValueOnce([native])
    const groups = await dispatcher.handle(makeRequest('session:get-engine-models'), remoteConn)
    expect(groups).toEqual(
      expect.arrayContaining([native, expect.objectContaining({ engineId: 'claude', models: [] })])
    )
  })

  // A remote client's per-engine request: the id reaches the shared handler,
  // only that engine answers, and an id that is not an engine rejects.
  it('session:get-engine-models answers only the engine a remote client asks for', async () => {
    const native = {
      engineId: 'pi' as const,
      vendorId: 'openai-codex',
      vendorName: 'ChatGPT',
      models: [{ value: 'native', displayName: 'Native', description: '', engineId: 'pi' as const }]
    }
    vi.mocked(discoverPiModels).mockResolvedValueOnce([native])
    await expect(
      dispatcher.handle(makeRequest('session:get-engine-models', 'pi'), remoteConn)
    ).resolves.toEqual([native])
    expect(vi.mocked(query)).not.toHaveBeenCalled()
    await expect(
      dispatcher.handle(makeRequest('session:get-engine-models', 'gemini'), remoteConn)
    ).rejects.toThrow(/unknown engine/)
  })

  describe('voice:start (the REAL handler — the e2e flow declares its own copy)', () => {
    const start = (...args: unknown[]) =>
      dispatcher.handle(makeRequest('voice:start', ...args), remoteConn)

    it("binds the calling connection's owner and passes the preview choice as the 5th relay argument", async () => {
      const relay = vi.spyOn(voiceRelay, 'start').mockResolvedValue(undefined)
      try {
        await start('rid-1', 'en', { preview: false })

        expect(relay).toHaveBeenCalledTimes(1)
        const [manager, owner, routingId, language, opts] = relay.mock.calls[0]
        expect(manager).toBe(sessionManagerStub)
        expect(owner.key).toBe(remoteConn.connectionId)
        expect([routingId, language]).toEqual(['rid-1', 'en'])
        expect(opts).toEqual({ preview: false })
      } finally {
        relay.mockRestore()
      }
    })

    it('leaves preview to the server when the argument is absent, null or malformed', async () => {
      const relay = vi.spyOn(voiceRelay, 'start').mockResolvedValue(undefined)
      try {
        await start('rid-1', 'en')
        await start('rid-1', null, null)
        await start('rid-1', 'en', 'nope')
        await start('rid-1', 'en', { preview: true })

        expect(relay.mock.calls.map((call) => call[4])).toEqual([
          { preview: undefined },
          { preview: undefined },
          { preview: undefined },
          { preview: true }
        ])
        // null language is normalised the way it always was.
        expect(relay.mock.calls[1][3]).toBeUndefined()
      } finally {
        relay.mockRestore()
      }
    })
  })

  // The model probe, title and commit message never run a turn that could use
  // a plugin's tools, so their processes skip the post-initialize reload.
  it.each([
    ['session:get-models', []],
    ['session:generate-title', ['a conversation']],
    ['session:generate-commit-message', ['diff --git a/x b/x']]
  ])('%s spawns its process without a plugin reload', async (channel, args) => {
    await dispatcher.handle(makeRequest(channel, ...args), remoteConn)
    expect(vi.mocked(query)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(query).mock.calls[0][0].options).toMatchObject({ reloadPlugins: false })
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

  it('routes an after-the-fact block approval to the session, and its nudge through the send path (ADR-091 part 6)', async () => {
    sessionStub.approveBlocked = vi.fn(() => ({ prompt: 'nudge' }))
    try {
      await dispatcher.handle(makeRequest('session:approve-blocked', 'rid-1', 'call-1'), remoteConn)
      expect(sessionStub.approveBlocked).toHaveBeenCalledWith('call-1')
      expect(sessionStub.run).toHaveBeenCalledWith('nudge', undefined)
    } finally {
      delete sessionStub.approveBlocked
    }
  })

  it('routes ordinary approval responses to the session', async () => {
    await dispatcher.handle(
      makeRequest('session:approval-response', 'rid-1', 'req-1', 'allow'),
      remoteConn
    )
    expect(sessionStub.resolveApproval).toHaveBeenCalledWith('req-1', 'allow', undefined, undefined)
    expect(crossEngineSpies.resolveApproval).not.toHaveBeenCalled()
  })

  it('an answer retires the card on every client: emits session:approval-dismiss for the routing id (pi, xeng:)', async () => {
    // pi's resolveApproval and the dispatcher's claude/pi-kind cards emit
    // nothing on a human answer, and the answering client only drops its own copy.
    await dispatcher.handle(
      makeRequest('session:approval-response', 'pi-rid', 'req-pi', 'allow'),
      remoteConn
    )
    expect(win.webContents.send).toHaveBeenCalledWith('session:approval-dismiss', 'pi-rid', {
      requestId: 'req-pi'
    })
    await dispatcher.handle(
      makeRequest('session:approval-response', 'parent-rid', 'xeng:perm-9', 'deny'),
      remoteConn
    )
    expect(win.webContents.send).toHaveBeenCalledWith('session:approval-dismiss', 'parent-rid', {
      requestId: 'xeng:perm-9'
    })
  })

  it('a resolve that throws still dismisses the card and still rejects', async () => {
    sessionStub.resolveApproval.mockImplementationOnce(() => {
      throw new Error('Stale or unknown approval')
    })
    await expect(
      dispatcher.handle(
        makeRequest('session:approval-response', 'pi-rid-2', 'req-x', 'allow'),
        remoteConn
      )
    ).rejects.toThrow('Stale or unknown approval')
    expect(win.webContents.send).toHaveBeenCalledWith('session:approval-dismiss', 'pi-rid-2', {
      requestId: 'req-x'
    })
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
    const res = await dispatcher.handle(
      makeRequest('session:stop-task', 'rid-1', 'toolu_ordinary_1'),
      remoteConn
    )
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
    // The shared-provider MUTATIONS are now remote-registered too (S4 / ADR-057):
    // the everything-remote ruling reaches provider routing as well.
    for (const channel of [
      'shared-provider:save',
      'shared-provider:probe',
      'shared-provider:remove',
      'shared-provider:set-route',
      'shared-provider:set-key',
      'shared-provider:adopt-native',
      'shared-provider:set-curation',
      'shared-provider:set-disabled',
      'shared-provider:sync',
      'shared-provider:use-stored-key',
      'shared-provider:disconnect',
      'shared-provider:set-default'
    ])
      expect(channels).toContain(channel)
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
    // (text, uploads, refs) — no attachments, so neither half exists.
    expect(sessionStub.enqueuePrompt).toHaveBeenCalledWith('later', undefined, undefined)
    expect(win.webContents.send).not.toHaveBeenCalledWith(
      'session:user-message',
      'rid-1',
      expect.anything()
    )
  })

  it('blob:get serves a blob over the remote transport; a miss is null, not an error', async () => {
    const bytes = Buffer.from('remote-blob-bytes')
    const ref = blobStore.putBytes('image/webp', bytes)!

    expect(await dispatcher.handle(makeRequest('blob:get', ref.blobId), remoteConn)).toEqual({
      mediaType: 'image/webp',
      base64Data: bytes.toString('base64')
    })
    expect(await dispatcher.handle(makeRequest('blob:get', 'b'.repeat(64)), remoteConn)).toBeNull()
    expect(await dispatcher.handle(makeRequest('blob:get', 'not-a-hash'), remoteConn)).toBeNull()
    expect(await dispatcher.handle(makeRequest('blob:get', 42), remoteConn)).toBeNull()
  })

  it('blob:get is a base-reachable chat query, so a plain token connection can fetch images', () => {
    const decl = commandRegistry.declaration('blob:get')
    expect(decl?.capability).toBe('chat')
    expect(decl?.kind).toBe('query')
    expect(AUTH_OFF_GRANTS.has(decl!.capability)).toBe(true)
    expect(commandRegistry.channels('remote')).toContain('blob:get')
  })

  describe('sync:report-timing', () => {
    const REPORT = { frameBytes: 2048, decodeMs: 3.5, syncToFrameMs: 40, hydrateMs: 12.25 }

    function syncStatsLines(): string[] {
      return [...vi.mocked(logger.info).mock.calls, ...vi.mocked(logger.warn).mock.calls]
        .filter(([source]) => source === 'SyncStats')
        .map(([, message]) => message as string)
    }

    beforeEach(() => {
      vi.mocked(logger.info).mockClear()
      vi.mocked(logger.warn).mockClear()
    })

    it('is a base-reachable chat QUERY that takes the connection, registered for remote only', () => {
      const decl = commandRegistry.declaration('sync:report-timing')
      expect(decl).toMatchObject({ capability: 'chat', kind: 'query', withConnection: true })
      // `chat` is in the base grant set, so every connection that can sync holds it.
      expect(AUTH_OFF_GRANTS.has(decl!.capability)).toBe(true)
      expect(commandRegistry.get('sync:report-timing', 'remote')).toBeDefined()
      // A `query` is read-class: free on every step-up tier and never audited.
      expect(
        classifyDispatch({ channel: 'sync:report-timing', capability: 'chat', kind: 'query' })
      ).toBe('read')
    })

    it('writes one host-formatted SyncStats line for a valid report', async () => {
      await dispatcher.handle(
        makeRequest('sync:report-timing', REPORT),
        makeRemoteConnection('password', null)
      )
      expect(syncStatsLines()).toEqual([
        'client sync-full applied: transport=web frameChars=2048 decodeMs=3.5 ' +
          'syncToFrameMs=40.0 hydrateMs=12.3 totalMs=55.8'
      ])
    })

    it('answers nothing for a malformed report and logs nothing', async () => {
      const conn = makeRemoteConnection('password', null)
      for (const bad of [
        null,
        'x',
        [1, 2],
        { ...REPORT, decodeMs: -1 },
        { ...REPORT, hydrateMs: '1' }
      ]) {
        expect(
          await dispatcher.handle(makeRequest('sync:report-timing', bad), conn)
        ).toBeUndefined()
      }
      expect(await dispatcher.handle(makeRequest('sync:report-timing'), conn)).toBeUndefined()
      expect(syncStatsLines()).toEqual([])
    })

    it('is refused for a connection without the chat class', async () => {
      const enrollOnly = makeRemoteConnection('enroll-token', null, ENROLL_ONLY_GRANTS)
      await expect(
        dispatcher.handle(makeRequest('sync:report-timing', REPORT), enrollOnly)
      ).rejects.toThrow(/Permission denied: "sync:report-timing" requires the "chat" capability/)
      expect(syncStatsLines()).toEqual([])
    })

    it('rate-limits per connection (6 a minute) through the real dispatch path', async () => {
      const noisy = makeRemoteConnection('password', null)
      const quiet = makeRemoteConnection('password', null)
      for (let i = 0; i < 9; i++) {
        await dispatcher.handle(makeRequest('sync:report-timing', REPORT), noisy)
      }
      expect(syncStatsLines()).toHaveLength(6)
      // Another connection's budget is its own: `withConnection` carries the right id.
      await dispatcher.handle(makeRequest('sync:report-timing', REPORT), quiet)
      expect(syncStatsLines()).toHaveLength(7)
    })

    it('ignores padded arguments: only the first is the report', async () => {
      await dispatcher.handle(
        makeRequest('sync:report-timing', REPORT, { frameBytes: 'evil' }, 'x'),
        makeRemoteConnection('password', null)
      )
      expect(syncStatsLines()).toHaveLength(1)
    })
  })

  it('session:send rejects when routingId not found', async () => {
    sessionManagerStub.get.mockReturnValueOnce(undefined)
    await expect(
      dispatcher.handle(makeRequest('session:send', 'missing', 'x'), remoteConn)
    ).rejects.toThrow(/No session for routingId/)
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

  it('mcp:load-catalog serves the catalog to a remote client', async () => {
    const res = await dispatcher.handle(makeRequest('mcp:load-catalog', '/repo'), remoteConn)
    expect(res).toEqual({ servers: [], skipped: [] })
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
      // The value is persisted AND the running session is told to re-read it —
      // notifySettingsChanged is the ISession hot-reload seam, so the call is the
      // contract; the persisted value is what it would re-read.
      expect(claudeSettingsSpies.saveCleanupPeriodDays).toHaveBeenCalledWith(30)
      expect(sessionStub.notifySettingsChanged).toHaveBeenCalledTimes(1)
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
      await dispatcher.handle(
        makeRequest('claude:save-permissions', 'user', PERMS, undefined),
        remoteConn
      )
      expect(claudeSettingsSpies.saveClaudePermissions).toHaveBeenCalledWith(
        'user',
        PERMS,
        undefined
      )
      expect(sessionStub.notifySettingsChanged).toHaveBeenCalled()
    })

    it('notifies user-scope writes even when a cwd is supplied (rules are global)', async () => {
      await dispatcher.handle(
        makeRequest('claude:save-permissions', 'user', PERMS, '/other/repo'),
        remoteConn
      )
      // sessionStub has no cwd, so only the user-scope rule can reach it.
      expect(claudeSettingsSpies.saveClaudePermissions).toHaveBeenCalledWith(
        'user',
        PERMS,
        '/other/repo'
      )
      expect(sessionStub.notifySettingsChanged).toHaveBeenCalledTimes(1)
    })

    it('scopes a project-scope write to sessions on that cwd', async () => {
      await dispatcher.handle(
        makeRequest('claude:save-permissions', 'project', PERMS, '/repo-a'),
        remoteConn
      )
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
      await dispatcher.handle(
        makeRequest('claude:save-permissions', 'project', PERMS, '/repo-a'),
        remoteConn
      )
      expect(sessionStub.notifySettingsChanged).toHaveBeenCalledTimes(1)
    })

    it('survives a session whose notifySettingsChanged rejects', async () => {
      sessionStub.notifySettingsChanged.mockRejectedValueOnce(new Error('child is gone'))
      await expect(
        dispatcher.handle(
          makeRequest('claude:save-permissions', 'user', PERMS, undefined),
          remoteConn
        )
      ).resolves.toBeUndefined()
    })
  })

  it('claude:workspace-trust reports the trust state for a cwd', async () => {
    const state = { root: '/repo-a', trusted: false, worktree: false }
    trustSpies.getWorkspaceTrust.mockReturnValueOnce(state)
    const res = await dispatcher.handle(
      makeRequest('claude:workspace-trust', '/repo-a'),
      remoteConn
    )
    expect(trustSpies.getWorkspaceTrust).toHaveBeenCalledWith('/repo-a')
    expect(res).toEqual(state)
  })

  it('claude:set-workspace-trust writes through setWorkspaceTrust and returns the new state', async () => {
    // The delayed refresh timer must not outlive this test (it would fire in a later file).
    vi.useFakeTimers()
    try {
      const state = { root: '/repo-a', trusted: true, worktree: false }
      trustSpies.setWorkspaceTrust.mockResolvedValueOnce(state)
      const res = await dispatcher.handle(
        makeRequest('claude:set-workspace-trust', '/repo-a', true),
        remoteConn
      )
      expect(trustSpies.setWorkspaceTrust).toHaveBeenCalledWith('/repo-a', true)
      expect(res).toEqual(state)
      vi.runOnlyPendingTimers()
    } finally {
      vi.useRealTimers()
    }
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
    const res = await dispatcher.handle(
      makeRequest('session:stop-task', 'ghost', 'tool-1'),
      remoteConn
    )
    expect(res).toEqual({ success: false, error: 'No active session' })
  })

  it('session:dequeue-message returns {removed:0} when session missing', async () => {
    sessionManagerStub.get.mockReturnValueOnce(undefined)
    const res = await dispatcher.handle(
      makeRequest('session:dequeue-message', 'ghost', 'val'),
      remoteConn
    )
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

    it('session:set-thinking-mode routes to session.applyConfig', async () => {
      await dispatcher.handle(
        makeRequest('session:set-thinking-mode', 'rid-1', 'think'),
        remoteConn
      )
      expect(sessionStub.applyConfig).toHaveBeenCalledWith({ thinkingMode: 'think' })
    })

    it('session:ask-side-question returns the session answer', async () => {
      const res = await dispatcher.handle(
        makeRequest('session:ask-side-question', 'rid-1', 'q?'),
        remoteConn
      )
      expect(sessionStub.askSideQuestion).toHaveBeenCalledWith('q?')
      expect(res).toBe('answer')
    })

    it('session:ask-side-question returns null when session missing', async () => {
      sessionManagerStub.get.mockReturnValueOnce(undefined)
      const res = await dispatcher.handle(
        makeRequest('session:ask-side-question', 'ghost', 'q?'),
        remoteConn
      )
      expect(res).toBeNull()
    })

    it('session:delete-session and session:delete-project are registered', () => {
      const channels = dispatcher.channels()
      expect(channels).toContain('session:delete-session')
      expect(channels).toContain('session:delete-project')
    })
  })

  describe('app:version-info', () => {
    // The override is module-global: neither this describe's own override nor one
    // left by an earlier test may reach the next.
    beforeEach(() => resetRemoteVersionInfoForTests())
    afterEach(() => resetRemoteVersionInfoForTests())

    // A web client's Settings › About read this and got nothing: the channel was
    // registered only by `registerRemoteVersionInfo`, which the desktop calls
    // BEFORE `registerRemoteHandlers` (a no-op then) and claudeui-server never
    // calls at all.
    it('is served by registerRemoteHandlers alone, from what the host published (GUARD)', async () => {
      expect(dispatcher.has('app:version-info')).toBe(true)
      const res = (await dispatcher.handle(makeRequest('app:version-info'), remoteConn)) as {
        appVersion: string
        cliVersion: string
      }
      expect(res.appVersion).toBe(hostAppVersion())
      expect(res.cliVersion).toBe(getCliVersion())
    })

    it('registerRemoteVersionInfo overrides it, before or after registration (GUARD)', async () => {
      registerRemoteVersionInfo({ appVersion: '1.2.3', cliVersion: '2.9' })
      const fresh = new RemoteDispatcher()
      registerRemoteHandlers(fresh, sessionManagerStub)
      // Called BEFORE the second registration, as the desktop does.
      expect(await fresh.handle(makeRequest('app:version-info'), remoteConn)).toEqual({
        appVersion: '1.2.3',
        cliVersion: '2.9'
      })
      // And after.
      registerRemoteVersionInfo({ appVersion: '4', cliVersion: '5' })
      expect(await fresh.handle(makeRequest('app:version-info'), remoteConn)).toEqual({
        appVersion: '4',
        cliVersion: '5'
      })
    })

    it('the override from the previous test does not outlive it (the reset seam)', async () => {
      const res = (await dispatcher.handle(makeRequest('app:version-info'), remoteConn)) as {
        appVersion: string
      }
      expect(res.appVersion).toBe(hostAppVersion())
    })
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

    // The watch is recursive, so an escaping directory would arm an fs.watch over an
    // arbitrary tree. The handler must refuse silently (no watcher), not throw.
    it('mockup:watch refuses a path-traversal directory and arms nothing', async () => {
      try {
        await expect(
          dispatcher.handle(makeRequest('mockup:watch', cwd, '../../..'), remoteConn)
        ).resolves.toBeUndefined()
        await dispatcher.handle(makeRequest('mockup:watch', cwd, '../../secret'), remoteConn)
        expect(closeMockupWatchersUnder(cwd)).toBe(0)
        // Sanity: the in-root path still arms a watcher (non-vacuous).
        await dispatcher.handle(makeRequest('mockup:watch', cwd, 'm1'), remoteConn)
        expect(closeMockupWatchersUnder(cwd)).toBe(1)
      } finally {
        closeMockupWatchersUnder(cwd)
      }
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

  describe('remote mockup watcher + worktree removal (C-S7, ADR-112)', () => {
    it('a remote mockup watch is visible to the worktree remover, which closes it and frees the key', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cui-rmockup-'))
      try {
        fs.mkdirSync(path.join(root, '.claude', 'ui', 'mockups', 'm1'), { recursive: true })
        await dispatcher.handle(makeRequest('mockup:watch', root, 'm1'), remoteConn)

        expect(closeMockupWatchersUnder(root)).toBe(1)
        // Re-armable: the has() guard no longer sees the closed watcher.
        await dispatcher.handle(makeRequest('mockup:watch', root, 'm1'), remoteConn)
        expect(closeMockupWatchersUnder(root)).toBe(1)
        await dispatcher.handle(makeRequest('mockup:watch', root, 'm1'), remoteConn)
        await dispatcher.handle(makeRequest('mockup:unwatch', root, 'm1'), remoteConn)
        expect(closeMockupWatchersUnder(root)).toBe(0)
      } finally {
        closeMockupWatchersUnder(root)
        fs.rmSync(root, { recursive: true, force: true })
      }
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
        'git:stash-push',
        'git:stash-restore',
        'git:fetch',
        // Live watching: previously unregistered web no-ops, which is why the
        // remote client's gitStatus stayed null and its changes pill never
        // rendered. Now a per-connection interest set on the shared registry.
        'git:watch'
      ]) {
        // Exposure now means "registered for the remote transport"; that the
        // capability is also granted is pinned by the parity block at the
        // bottom of this file.
        expect(channels).toContain(ch)
      }
    })

    it('git:watch registers this connection and starts exactly one poller', async () => {
      await expect(
        dispatcher.handle(makeRequest('git:watch', { cwds: ['/tmp/proj'] }), remoteConn)
      ).resolves.toBeUndefined()
      expect(gitManagerSpies.get).toHaveBeenCalledWith('/tmp/proj')
      expect(gitSvcStub.startPolling).toHaveBeenCalledTimes(1)
      expect(gitWatchRegistry.watchersOf('/tmp/proj')).toEqual([remoteConn.connectionId])

      // Re-stating the same set must NOT re-start the poller (that would replace
      // the live callback and silence every other watcher).
      await dispatcher.handle(makeRequest('git:watch', { cwds: ['/tmp/proj'] }), remoteConn)
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
        await dispatcher.handle(makeRequest('git:watch', { cwds: ['/tmp/proj'] }), remoteConn)
        const emit = gitSvcStub.startPolling.mock.calls[0][0] as (s: unknown) => void
        emit({ files: [], branch: 'main' })
        expect(pushed).toEqual([{ cwd: '/tmp/proj', status: { files: [], branch: 'main' } }])
      } finally {
        gitWatchRegistry.init(null)
      }
    })

    it('an empty git:watch set releases the cwd and stops the poller', async () => {
      await dispatcher.handle(makeRequest('git:watch', { cwds: ['/tmp/proj'] }), remoteConn)
      await expect(
        dispatcher.handle(makeRequest('git:watch', { cwds: [] }), remoteConn)
      ).resolves.toBeUndefined()
      expect(gitSvcStub.stopPolling).toHaveBeenCalledTimes(1)
      expect(gitManagerSpies.release).toHaveBeenCalledWith('/tmp/proj')
      expect(gitWatchRegistry.watchersOf('/tmp/proj')).toEqual([])
    })

    it('an empty git:watch from a connection watching nothing is a no-op', async () => {
      await expect(
        dispatcher.handle(makeRequest('git:watch', { cwds: [] }), remoteConn)
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

    describe('session:get-opencode-providers — shared-route claims (remote parity)', () => {
      const entry = (id: string): any => ({
        id,
        name: id,
        authState: 'authenticated',
        authMethods: ['api'],
        modelCount: 1,
        disabled: false,
        actions: {
          canSetCredential: true,
          canEditDeclaration: false,
          canRemove: true,
          removeKind: 'credential'
        }
      })
      const chatgptDefinition: any = {
        id: 'chatgpt',
        name: 'ChatGPT',
        kind: 'subscription',
        models: [],
        managed: true,
        routes: {
          pi: { enabled: true, providerId: 'openai-codex' },
          opencode: { enabled: true, providerId: 'openai' }
        }
      }

      let definitionsSpy: { mockRestore: () => void } | undefined

      afterEach(() => {
        vi.mocked(opencodeServerManager.isBinaryAvailable).mockReturnValue(false)
        vi.mocked(discoverOpencodeProviderCatalog).mockResolvedValue([])
        definitionsSpy?.mockRestore()
        definitionsSpy = undefined
      })

      function serve(catalog: unknown[], definitions: unknown[]): void {
        vi.mocked(opencodeServerManager.isBinaryAvailable).mockReturnValue(true)
        vi.mocked(discoverOpencodeProviderCatalog).mockResolvedValue(catalog as never)
        definitionsSpy = vi
          .spyOn(sharedProviderService, 'listDefinitions')
          .mockReturnValue(definitions as never)
      }

      it('marks the entry an ENABLED shared route delivers, exactly as the desktop handler does', async () => {
        serve([entry('openai'), entry('groq')], [chatgptDefinition])
        const result = (await dispatcher.handle(
          makeRequest('session:get-opencode-providers'),
          remoteConn
        )) as any[]
        // The desktop handler's decoration, so a phone shows the same "delivered by
        // ChatGPT" warning (and the Remove is refused for the same reason).
        expect(result.find((e) => e.id === 'openai').sharedProviderClaim).toEqual({
          id: 'chatgpt',
          name: 'ChatGPT'
        })
        expect(result.find((e) => e.id === 'groq').sharedProviderClaim).toBeUndefined()
      })

      it('leaves the entry unmarked once the route is switched off', async () => {
        serve(
          [entry('openai')],
          [
            {
              ...chatgptDefinition,
              routes: { ...chatgptDefinition.routes, opencode: { enabled: false } }
            }
          ]
        )
        const [openai] = (await dispatcher.handle(
          makeRequest('session:get-opencode-providers'),
          remoteConn
        )) as any[]
        expect(openai.sharedProviderClaim).toBeUndefined()
      })

      it('still serves the plain catalog when the shared definitions cannot be read', async () => {
        serve([entry('openai')], [])
        vi.mocked(sharedProviderService.listDefinitions).mockImplementation(() => {
          throw new Error('unreadable')
        })
        const result = (await dispatcher.handle(
          makeRequest('session:get-opencode-providers'),
          remoteConn
        )) as any[]
        expect(result.map((e) => e.id)).toEqual(['openai'])
        expect(result[0].sharedProviderClaim).toBeUndefined()
      })

      it('is empty without an opencode binary — nothing to decorate', async () => {
        vi.mocked(opencodeServerManager.isBinaryAvailable).mockReturnValue(false)
        await expect(
          dispatcher.handle(makeRequest('session:get-opencode-providers'), remoteConn)
        ).resolves.toEqual([])
      })
    })

    it('an opencode/pi history read carries the ledger’s X-Agent cards (ADR-105 §5), as the sidebar’s cold load needs', async () => {
      const parent = `oc-parent-${process.pid}`
      const row = dispatchLedger.create({
        engine: 'pi',
        harnessRef: `h-${parent}`,
        parentSessionId: parent,
        parentEngine: 'opencode',
        parentToolUseId: 'call_dispatch',
        cwd: '/x',
        parentCwd: '/x',
        model: 'm',
        launchMode: 'default',
        accountKey: null,
        callerRestriction: null,
        name: null,
        description: null
      })
      const messages = [
        {
          id: 'm1',
          role: 'assistant',
          content: [
            { type: 'tool_use', toolUseId: 'call_dispatch', toolName: 'claudeui_dispatch_agent' }
          ],
          timestamp: 1
        }
      ]
      vi.mocked(loadOpencodeSessionHistory).mockResolvedValueOnce({
        messages,
        statusLine: null
      } as never)
      const res = (await dispatcher.handle(
        makeRequest('session:load-opencode-history', parent),
        remoteConn
      )) as { activeTasks?: Record<string, { taskId: string }> }
      expect(res.activeTasks).toEqual({
        call_dispatch: expect.objectContaining({ taskId: row.id, taskType: 'dispatch' })
      })
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
      await expect(
        dispatcher.handle(makeRequest('git:push', '/tmp/proj'), remoteConn)
      ).rejects.toThrow('remote rejected')
      expect(gitManagerSpies.release).toHaveBeenCalledWith('/tmp/proj')
    })

    it('session:load-history declares withProgress and forwards the reporter to the Claude reader (ADR-102)', async () => {
      expect(commandRegistry.declaration('session:load-history')?.withProgress).toBe(true)
      const progress = vi.fn()
      await dispatcher.handle(
        makeRequest('session:load-history', 'sess-1', 'proj-key', null),
        remoteConn,
        progress
      )
      // The reporter LEADS the handler args (not the wire's), and the wire's
      // null anchor is still normalised to undefined. No options on the wire
      // (an old client's 3-arg call) means the full read.
      expect(loadClaudeHistoryMock).toHaveBeenLastCalledWith('sess-1', 'proj-key', undefined, {
        onProgress: progress,
        deferStatusLine: false
      })
    })

    it('session:load-history validates its options arg: only a literal deferStatusLine === true defers (ADR-102 Arc 2)', async () => {
      const progress = vi.fn()
      const deferredOf = async (...options: unknown[]): Promise<unknown> => {
        await dispatcher.handle(
          makeRequest('session:load-history', 'sess-1', 'proj-key', null, ...options),
          remoteConn,
          progress
        )
        return (
          vi.mocked(loadClaudeHistoryMock).mock.lastCall?.[3] as { deferStatusLine?: boolean }
        ).deferStatusLine
      }
      expect(await deferredOf({ deferStatusLine: true })).toBe(true)
      // Anything else is ignored, never coerced: non-objects, wrong types, extras.
      expect(await deferredOf({ deferStatusLine: 'true' })).toBe(false)
      expect(await deferredOf({ deferStatusLine: 1 })).toBe(false)
      expect(await deferredOf({ deferStatusLine: false })).toBe(false)
      expect(await deferredOf({})).toBe(false)
      expect(await deferredOf(null)).toBe(false)
      expect(await deferredOf('deferStatusLine')).toBe(false)
      expect(await deferredOf(42)).toBe(false)
      expect(await deferredOf(['deferStatusLine'])).toBe(false)
      // Extra fields are ignored and are not forwarded.
      expect(await deferredOf({ deferStatusLine: true, resumeSessionAt: 'x', onProgress: 1 })).toBe(
        true
      )
      expect(vi.mocked(loadClaudeHistoryMock).mock.lastCall?.[3]).toEqual({
        onProgress: progress,
        deferStatusLine: true
      })
    })

    it('session:load-status-line is an fs-read query that declares withProgress and forwards the reporter (ADR-102 Arc 2)', async () => {
      expect(commandRegistry.declaration('session:load-status-line')).toMatchObject({
        capability: 'fs-read',
        kind: 'query',
        withProgress: true
      })
      // The server sends its `sending` frame only for a channel this says reports.
      expect(dispatcher.reportsProgress('session:load-status-line')).toBe(true)
      const progress = vi.fn()
      const res = await dispatcher.handle(
        makeRequest('session:load-status-line', 'sess-1', 'proj-key'),
        remoteConn,
        progress
      )
      expect(res).toEqual({ totalCostUsd: 1 })
      expect(loadStatusLineMock).toHaveBeenLastCalledWith('sess-1', 'proj-key', progress)
    })

    it('session:load-subagent-history declares withProgress (the transport `sending` frame) and keeps its wire args (ADR-102 Arc 2, C8)', async () => {
      expect(commandRegistry.declaration('session:load-subagent-history')?.withProgress).toBe(true)
      expect(dispatcher.reportsProgress('session:load-subagent-history')).toBe(true)
      await dispatcher.handle(
        makeRequest('session:load-subagent-history', 'sess-1', 'proj-key', 'agent-9'),
        remoteConn
      )
      // The reporter takes the leading slot, so the wire args land where they did.
      expect(loadSubagentHistoryMock).toHaveBeenLastCalledWith('sess-1', 'proj-key', 'agent-9')
    })

    // The three Claude history readers join sessionId / projectKey (/ agentId) into a
    // ~/.claude/projects path, and these channels are reachable by any `fs-read`
    // caller. A traversal value must be refused before the reader (the filesystem) runs.
    describe.each([
      ['session:load-history', () => loadClaudeHistoryMock, []],
      ['session:load-status-line', () => loadStatusLineMock, []],
      ['session:load-subagent-history', () => loadSubagentHistoryMock, ['agent-9']]
    ] as const)('%s path-segment validation', (channel, reader, tail) => {
      it.each([
        ['sessionId', ['../x', 'proj-key']],
        ['sessionId', ['a/b', 'proj-key']],
        ['sessionId', ['a\\b', 'proj-key']],
        ['sessionId', ['', 'proj-key']],
        ['projectKey', ['sess-1', '../x']],
        ['projectKey', ['sess-1', 'a/b']],
        ['projectKey', ['sess-1', 'a\\b']],
        ['projectKey', ['sess-1', '..']],
        ['projectKey', ['sess-1', '']]
      ])('refuses a bad %s (%j) before any read (GUARD — fails pre-fix)', async (label, ids) => {
        vi.mocked(reader()).mockClear()
        await expect(
          dispatcher.handle(makeRequest(channel, ...ids, ...tail), remoteConn)
        ).rejects.toThrow(new RegExp(`Invalid ${label}`))
        expect(reader()).not.toHaveBeenCalled()
      })

      it('passes a valid call through unchanged', async () => {
        vi.mocked(reader()).mockClear()
        await dispatcher.handle(makeRequest(channel, 'sess-1', 'proj-key', ...tail), remoteConn)
        expect(reader()).toHaveBeenCalledTimes(1)
        expect(vi.mocked(reader()).mock.lastCall?.slice(0, 2 + tail.length)).toEqual([
          'sess-1',
          'proj-key',
          ...tail
        ])
      })
    })

    it('session:load-subagent-history refuses a bad agentId before any read (GUARD — fails pre-fix)', async () => {
      vi.mocked(loadSubagentHistoryMock).mockClear()
      for (const agentId of ['../x', 'a/b', 'a\\b', '..', '']) {
        await expect(
          dispatcher.handle(
            makeRequest('session:load-subagent-history', 'sess-1', 'proj-key', agentId),
            remoteConn
          )
        ).rejects.toThrow(/Invalid agentId/)
      }
      expect(loadSubagentHistoryMock).not.toHaveBeenCalled()
    })

    it('account:get returns the account-manager state', async () => {
      const res = await dispatcher.handle(makeRequest('account:get'), remoteConn)
      expect(res).toEqual({ enabled: false, accounts: [] })
    })

    it('engine:is-installed asks the harness resolver for every engine, claude included', async () => {
      vi.mocked(engineInstalled).mockImplementation((id) => id === 'pi')
      expect(
        await dispatcher.handle(makeRequest('engine:is-installed', 'claude'), remoteConn)
      ).toBe(false)
      expect(
        await dispatcher.handle(makeRequest('engine:is-installed', 'opencode'), remoteConn)
      ).toBe(false)
      expect(await dispatcher.handle(makeRequest('engine:is-installed', 'pi'), remoteConn)).toBe(
        true
      )
      expect(vi.mocked(engineInstalled).mock.calls.map(([id]) => id)).toStrictEqual([
        'claude',
        'opencode',
        'pi'
      ])
    })

    it('registers the account mutations (S4 / ADR-057 — config, not admin)', () => {
      // Previously desktop-only; now remote-registered under the everything-
      // remote ruling. They declare `config` (in AUTH_OFF_GRANTS) and `account:add`
      // is remote-aware (skips the host browser, surfaces manualUrl).
      const channels = dispatcher.channels()
      for (const ch of ['account:add', 'account:switch', 'account:delete', 'account:set-enabled']) {
        expect(channels).toContain(ch)
      }
    })
  })

  // Remote/desktop session:create parity — the remote handler now delegates to
  // the shared prepareAndCreateSession() (create-session.ts), so engineId
  // threading and engine-config sourcing must match the desktop IPC handler.
  describe('session:create parity', () => {
    it('threads engineId through to manager.create (GUARD — fails pre-fix)', async () => {
      await dispatcher.handle(
        makeRequest('session:create', 'rid-engine', { cwd: '/tmp/proj', engineId: 'opencode' }),
        remoteConn
      )
      expect(sessionManagerStub.create).toHaveBeenCalled()
      // manager.create's 5th positional arg (index 4) is engineId.
      expect(sessionManagerStub.create.mock.calls[0][4]).toBe('opencode')
    })

    it('legacy positional args: threads engineId through to manager.create', async () => {
      await dispatcher.handle(
        makeRequest(
          'session:create',
          'rid-engine-legacy',
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

      try {
        await dispatcher.handle(
          makeRequest('session:create', 'rid-sandbox', { cwd: '/tmp/proj' }),
          remoteConn
        )

        expect(sessionManagerStub.create).toHaveBeenCalled()
        // manager.create's 4th positional arg (index 3) is the EngineSpawnOptions object.
        expect(sessionManagerStub.create.mock.calls[0][3].sandboxConfig).toEqual(SENTINEL)
      } finally {
        // The decoy is never consumed when the code sources sandbox correctly, and
        // vi.clearAllMocks() leaves queued once-values alone — so it would answer the
        // next test that calls loadSettings (config:load-settings). Reset restores
        // the vi.fn(impl) default.
        uiConfigMocks.loadSettings.mockReset()
      }
    })

    it('claude path (default engineId) applies vendor config and skips opencode resolution', async () => {
      await dispatcher.handle(
        makeRequest('session:create', 'rid-claude', { cwd: '/tmp/proj' }),
        remoteConn
      )

      expect(uiConfigMocks.loadVendorConfig).toHaveBeenCalledWith('anthropic')
      expect(resolveOpencodeSpawnModel).not.toHaveBeenCalled()
    })

    it('opencode path resolves the spawn model and skips vendor config', async () => {
      await dispatcher.handle(
        makeRequest('session:create', 'rid-opencode', {
          cwd: '/tmp/proj',
          engineId: 'opencode',
          config: { model: 'opencode/some-model' }
        }),
        remoteConn
      )

      expect(resolveOpencodeSpawnModel).toHaveBeenCalledWith('opencode/some-model')
      expect(uiConfigMocks.loadVendorConfig).not.toHaveBeenCalled()
      const resolvedModel = await (resolveOpencodeSpawnModel as unknown as ReturnType<typeof vi.fn>)
        .mock.results[0].value
      // manager.create's 4th positional arg (index 3) is the EngineSpawnOptions object.
      expect(sessionManagerStub.create.mock.calls[0][3].model).toBe(resolvedModel)
    })

    // The web client marshals `invoke` args as JSON, so an OMITTED optional
    // argument arrives as an explicit `null` (Electron IPC preserves
    // `undefined`, which is why the desktop never hit this). `null` is not
    // "unset" to the code downstream: an engine that validates the effort
    // treats only `undefined` as "no effort" and would reject every fresh
    // session created from the web client.
    it('legacy positional args: normalises null optional args to absent before prepareAndCreateSession (GUARD — fails pre-fix)', async () => {
      await dispatcher.handle(
        makeRequest(
          'session:create',
          'rid-nulls',
          '/tmp/proj',
          null, // effort
          null, // resumeSessionId
          null, // permissionMode
          null, // model
          null, // thinkingMode
          null, // resumeSessionAt
          null, // forkSession
          null, // engineId
          null // announce
        ),
        remoteConn
      )

      expect(createSessionSpy.prepareAndCreateSession).toHaveBeenCalledTimes(1)
      const args = createSessionSpy.prepareAndCreateSession.mock.calls[0][2]
      for (const key of ['config', 'resume', 'engineId', 'announce'] as const) {
        expect(args[key], `${key} must be absent, not null`).toBeUndefined()
      }
      // Required args are untouched.
      expect(args.routingId).toBe('rid-nulls')
      expect(args.cwd).toBe('/tmp/proj')
    })

    it('an object request carries nothing but what it names (nulls and unknown keys never reach the spawn)', async () => {
      await dispatcher.handle(
        makeRequest('session:create', 'rid-obj-bare', {
          cwd: '/tmp/proj',
          engineId: null,
          config: null,
          resume: 'not-an-object',
          announce: null,
          bogus: { sandboxConfig: 1 }
        }),
        remoteConn
      )

      expect(createSessionSpy.prepareAndCreateSession.mock.calls[0][2]).toEqual({
        routingId: 'rid-obj-bare',
        cwd: '/tmp/proj'
      })
    })

    it('an object request without a string cwd is refused', async () => {
      await expect(
        dispatcher.handle(
          makeRequest('session:create', 'rid-obj-bad', { engineId: 'opencode' }),
          remoteConn
        )
      ).rejects.toThrow(/string cwd/)
      expect(createSessionSpy.prepareAndCreateSession).not.toHaveBeenCalled()
    })

    it('legacy positional args: passes real optional values through to the same request', async () => {
      await dispatcher.handle(
        makeRequest(
          'session:create',
          'rid-values',
          '/tmp/proj',
          'high',
          'resume-1',
          'plan',
          'opencode/luna',
          'think',
          'anchor-1',
          false,
          'opencode',
          { effort: 'xhigh', thinkingMode: null }
        ),
        remoteConn
      )

      expect(createSessionSpy.prepareAndCreateSession.mock.calls[0][2]).toEqual({
        routingId: 'rid-values',
        cwd: '/tmp/proj',
        engineId: 'opencode',
        config: {
          effort: 'high',
          permissionMode: 'plan',
          model: 'opencode/luna',
          thinkingMode: 'think'
        },
        // `false` is a real value, not "unset" — `?? undefined` must not eat it.
        resume: { sessionId: 'resume-1', at: 'anchor-1', fork: false },
        announce: { effort: 'xhigh', thinkingMode: null }
      })
    })

    it('an object request reaches prepareAndCreateSession with every field', async () => {
      await dispatcher.handle(
        makeRequest('session:create', 'rid-values-obj', {
          cwd: '/tmp/proj',
          engineId: 'opencode',
          config: {
            effort: 'high',
            permissionMode: 'plan',
            model: 'opencode/luna',
            thinkingMode: 'think'
          },
          resume: { sessionId: 'resume-1', at: 'anchor-1', fork: false },
          announce: { effort: 'xhigh', thinkingMode: null }
        }),
        remoteConn
      )

      expect(createSessionSpy.prepareAndCreateSession.mock.calls[0][2]).toEqual({
        routingId: 'rid-values-obj',
        cwd: '/tmp/proj',
        engineId: 'opencode',
        config: {
          effort: 'high',
          permissionMode: 'plan',
          model: 'opencode/luna',
          thinkingMode: 'think'
        },
        resume: { sessionId: 'resume-1', at: 'anchor-1', fork: false },
        announce: { effort: 'xhigh', thinkingMode: null }
      })
    })

    it('broadcasts session:created to the main window (remote notifies desktop)', async () => {
      await dispatcher.handle(
        makeRequest('session:create', 'rid-broadcast', { cwd: '/tmp/proj' }),
        remoteConn
      )

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

    it('stores the context-pressure setting only in its valid form, whoever sends it (slice 4)', async () => {
      await dispatcher.handle(
        makeRequest('config:save-settings', {
          contextPressure: { mode: 'sometimes', thresholds: [95, 5, 40, 40, 'x', 120, 60] }
        }),
        remoteConn
      )
      expect(uiConfigMocks.saveSettings.mock.calls[0][0].contextPressure).toEqual({
        mode: 'off',
        thresholds: [40, 60, 95]
      })
      // Absent stays absent: the default is not written into every profile.
      uiConfigMocks.saveSettings.mockClear()
      await dispatcher.handle(makeRequest('config:save-settings', { theme: 'dark' }), remoteConn)
      expect(uiConfigMocks.saveSettings.mock.calls[0][0]).not.toHaveProperty('contextPressure')
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

    it('a save flips the mockup CSP settings, as a watcher change does', async () => {
      await dispatcher.handle(
        makeRequest('config:save-settings', { mockupAllowHttp: true }),
        remoteConn
      )
      expect(getMockupSecuritySettings().allowHttp).toBe(true)

      await dispatcher.handle(
        makeRequest('config:save-settings', { mockupAllowHttp: false }),
        remoteConn
      )
      expect(getMockupSecuritySettings().allowHttp).toBe(false)
    })

    it('persists a key this build does not know, unchanged (a newer build wrote it)', async () => {
      const future = { fromANewerBuild: { nested: [1, 2] }, theme: 'dark' }
      await dispatcher.handle(makeRequest('config:save-settings', future), remoteConn)
      expect(uiConfigMocks.saveSettings).toHaveBeenCalledWith(future)
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

    it('a remote model-picker fetch feeds the host catalog automation runs read (GUARD)', async () => {
      // Headless / remote hosts never run the desktop `fetchModels`; their picker
      // fetch is the only thing that can tell an automation run which rows exist.
      resetCachedClaudeModels()
      expect(cachedClaudeModels()).toEqual([])
      await dispatcher.handle(makeRequest('session:get-models'), remoteConn)
      expect(cachedClaudeModels()).toEqual([{ value: 'sonnet', description: '' }])

      resetCachedClaudeModels()
      await dispatcher.handle(makeRequest('session:get-engine-models'), remoteConn)
      expect(cachedClaudeModels()).toEqual([{ value: 'sonnet', description: '' }])
    })

    it('keeps the per-engine starting-effort map through save and broadcast', async () => {
      // `engineEffortDefaults` is an ordinary UI setting, not engine/vendor-owned:
      // no strip list may eat it, and every client (the desktop included) must be
      // handed it back on `config:settings-changed`.
      const engineEffortDefaults = { pi: { 'anthropic/claude-opus-5-5': 'high' } }
      await dispatcher.handle(
        makeRequest('config:save-settings', { theme: 'light', engineEffortDefaults }),
        remoteConn
      )

      expect(uiConfigMocks.saveSettings.mock.calls[0][0]).toEqual(
        expect.objectContaining({ engineEffortDefaults })
      )
      expect(win.webContents.send).toHaveBeenCalledWith(
        'config:settings-changed',
        expect.objectContaining({ engineEffortDefaults })
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
// The remote surface is pinned by the checked-in dump (remote-surface.jsonl; the
// test "the remote surface equals the checked-in dump" in the describe below):
// every channel registerRemoteHandlers registers, with its capability, kind and
// routing flags. What the dump cannot say is kept by hand here: which channels
// a base connection cannot reach (NOT_GRANTED_AT_CONNECT) and how the authcfg
// namespace splits for the step-up classifier (AUTHCFG_WRITE_CHANNELS and
// AUTHCFG_FREE_CHANNELS_PIN).
// ---------------------------------------------------------------------------

/**
 * ADR-054 decision 6 — the remote-access SETTINGS WRITES.
 *
 * Every one declares `admin` (outside {@link AUTH_OFF_GRANTS}, so
 * authenticating never suffices) AND is gated on a presence proof inside the
 * mutation window on every tier — the transport classifies this namespace as
 * `authcfg`. What makes the widening safe to review is what is ABSENT: the `off`
 * master switch. Auth-DISABLING operations stay host-anchor only and stay in
 * `remote:set-config`, which has no remote registration at all (pinned below).
 */
const AUTHCFG_WRITE_CHANNELS = [
  'authcfg:apply',
  // ADR-056 item C. `authcfg:lan-link` sits in the WRITE half despite being a
  // `query`, and that is the decision under test: what gates a verb in this
  // namespace is what it DISCLOSES — here a live channel key — not its kind.
  'authcfg:lan-link',
  'authcfg:rotate-lan-key',
  'authcfg:set-password'
] as const

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

/**
 * Every remote channel whose capability is outside AUTH_OFF_GRANTS, i.e. that an
 * authenticated token/tailnet connection cannot reach at connect. Registered
 * remotely all the same, each behind a proof the registry's grant set encodes:
 *
 * - terminal (`shell`): reached only with the desktop-only `allow_terminal`
 *   toggle (persisted in `remote_config`, never in remotely-writable settings),
 *   a step-up ceremony that verifies a fresh password proof against the auth
 *   failure budget, and an idle decay on the grant it arms.
 *   `terminal:availability` is deliberately `config` (a client must be able to
 *   ask "may I?" without holding the answer), so it is not here;
 *   `terminal:kill-by-cwd` is deliberately not registered remotely (a cold-session
 *   cleanup that belongs to the desktop).
 * - passkeys (`enroll` / `admin`): a proven identity, or a one-time enrollment
 *   link for the two registration verbs.
 * - `authcfg:*` (`admin`): the remote-access settings; writes also need a
 *   presence proof inside the mutation window on every tier. The `off` master
 *   switch is absent by design: it stays in `remote:set-config`, which has no
 *   remote registration.
 * - `ide:mint-entry` (`ide`): the grant is armed by a step-up iff the
 *   host-anchored `allow_ide` toggle is on, and revoked in place when it is off.
 *   `ide:availability` is `config`, for the reason `terminal:availability` is.
 * - harness writes and speech-pack writes (`admin`): putting a program or the
 *   speech pack on the host. Their reads are `config` / `chat`.
 *
 * A new line here is a decision that needs its reason: it makes another
 * capability reachable only to a stronger identity, and it must not declare
 * `host` (checked below).
 */
const NOT_GRANTED_AT_CONNECT: Record<string, Capability> = {
  'terminal:attach': 'shell',
  'terminal:create': 'shell',
  'terminal:detach': 'shell',
  'terminal:kill': 'shell',
  'terminal:pool': 'shell',
  'terminal:resize': 'shell',
  'terminal:write': 'shell',
  'webauthn:register-options': 'enroll',
  'webauthn:register-verify': 'enroll',
  'webauthn:credentials': 'admin',
  'webauthn:mint-enroll-token': 'admin',
  'webauthn:rename': 'admin',
  'webauthn:revoke': 'admin',
  'authcfg:apply': 'admin',
  'authcfg:end': 'admin',
  'authcfg:get': 'admin',
  'authcfg:lan-link': 'admin',
  'authcfg:rotate-lan-key': 'admin',
  'authcfg:set-password': 'admin',
  'ide:mint-entry': 'ide',
  'harness:set-selection': 'admin',
  'harness:install': 'admin',
  'harness:install-cancel': 'admin',
  'harness:detect': 'admin',
  'harness:set-update-mode': 'admin',
  'harness:update-all': 'admin',
  'harness:check-updates': 'admin',
  'harness:answer-upgrade-prompt': 'admin',
  'voice:pack-install': 'admin',
  'voice:pack-install-cancel': 'admin',
  'voice:pack-remove': 'admin'
}

/** Table keys whose capability is `capability`, or that start with `prefix`. */
const notGrantedChannels = (match: { capability?: Capability; prefix?: string }): string[] =>
  Object.entries(NOT_GRANTED_AT_CONNECT)
    .filter(
      ([c, cap]) =>
        (match.capability === undefined || cap === match.capability) &&
        (match.prefix === undefined || c.startsWith(match.prefix))
    )
    .map(([c]) => c)

describe('remote surface parity (phase 1 port)', () => {
  // The dispatcher the two S1b reachability cases below actually call through —
  // the same object `registerRemoteHandlers` was handed, resolving against the
  // shared registry exactly as production does.
  let dispatcher: RemoteDispatcher

  beforeEach(() => {
    // Subscribes a fake desktop client to the funnel, mirroring production's
    // "somebody else is listening too" (the parity assertions below read the
    // registry, not this sink).
    makeFakeWindow()
    dispatcher = new RemoteDispatcher()
    registerRemoteHandlers(dispatcher, sessionManagerStub)
    // Registered later in the real bootstrap, once build versions are known.
    registerRemoteVersionInfo({ appVersion: '1', cliVersion: '3' })
  })

  afterEach(() => {
    gitWatchRegistry.releaseConnection(remoteConn.connectionId)
  })

  it('the remote surface equals the checked-in dump', () => {
    const live = describeRemoteSurface(commandRegistry)
    expect(live.length).toBeGreaterThan(200) // a registrar that did not run must not pass
    if (process.env.UPDATE_REMOTE_SURFACE === '1') {
      if (process.env.CI) throw new Error('refusing to rewrite the remote surface dump in CI')
      fs.writeFileSync(REMOTE_SURFACE_PATH, serializeRemoteSurface(live))
      return
    }
    const dump = readRemoteSurface()
    const liveBy = new Map(live.map((e) => [e.channel, e]))
    const dumpBy = new Map(dump.map((e) => [e.channel, e]))
    const added = live.filter((e) => !dumpBy.has(e.channel)).map((e) => e.channel)
    const removed = dump.filter((e) => !liveBy.has(e.channel)).map((e) => e.channel)
    const changed: string[] = []
    for (const e of live) {
      const old = dumpBy.get(e.channel)
      if (!old) continue
      const fields = (Object.keys(e) as (keyof RemoteSurfaceEntry)[])
        .filter((k) => e[k] !== old[k])
        .map((k) => `${k}: ${JSON.stringify(old[k])} -> ${JSON.stringify(e[k])}`)
      if (fields.length) changed.push(`${e.channel} (${fields.join('; ')})`)
    }
    const list = (title: string, xs: string[]): string[] =>
      xs.length ? [`${title}:`, ...xs.map((x) => `  ${x}`)] : []
    const message = [
      'The static remote surface (what registerRemoteHandlers registers; plugin channels are not covered) differs from remote-surface.jsonl.',
      ...list('In the registry, not in the dump (added)', added),
      ...list('In the dump, not in the registry (removed)', removed),
      ...list('Declaration changed (dump -> registry)', changed),
      `If the change is intended, regenerate the dump: ${REMOTE_SURFACE_UPDATE_COMMAND}`,
      'Then commit the regenerated remote-surface.jsonl: the dump diff is how a change to the remote surface gets reviewed.',
      'A channel whose capability is outside the base grant set (AUTH_OFF_GRANTS) also needs a line in the hand-kept non-base table in this file.'
    ].join('\n')
    if (added.length || removed.length || changed.length) throw new Error(message)
    expect(live).toEqual(dump)
  })

  it('automode:judge-model-support is a base-reachable config QUERY, like get-engine-models', () => {
    const decl = commandRegistry.declaration('automode:judge-model-support')
    const twin = commandRegistry.declaration('session:get-engine-models')
    expect(decl?.capability).toBe('config')
    expect(decl?.capability).toBe(twin?.capability)
    expect(decl?.kind).toBe('query')
    expect(decl?.kind).toBe(twin?.kind)
    expect(AUTH_OFF_GRANTS.has(decl!.capability)).toBe(true)
  })

  it('automode:judge-route-resting is a base-reachable config QUERY, like judge-model-support', () => {
    const decl = commandRegistry.declaration('automode:judge-route-resting')
    const twin = commandRegistry.declaration('automode:judge-model-support')
    expect(decl?.capability).toBe('config')
    expect(decl?.capability).toBe(twin?.capability)
    expect(decl?.kind).toBe('query')
    expect(decl?.kind).toBe(twin?.kind)
    expect(AUTH_OFF_GRANTS.has(decl!.capability)).toBe(true)
  })

  it('the S1b sweep keeps its deliberate capabilities, and automations are config', () => {
    // `opencode-agents:generate` spends model tokens, so it is `chat`, not
    // `config` — the one deliberate difference inside the sweep.
    expect(commandRegistry.declaration('opencode-agents:generate')?.capability).toBe('chat')
    expect(commandRegistry.declaration('worktree:create')?.capability).toBe('git')
    // Automations are host-side CONFIGURATION (see ipc/automation-commands.ts),
    // and their reads are reads.
    expect(commandRegistry.declaration('automation:save')).toMatchObject({
      capability: 'config',
      kind: 'command'
    })
    expect(commandRegistry.declaration('automation:list')).toMatchObject({
      capability: 'config',
      kind: 'query'
    })
  })

  it('the provider registry is a base-reachable `config` query (ADR-065 phase 6)', () => {
    // The unified provider list must be readable by the same ordinary
    // authenticated connection that reaches the writes behind its rows —
    // otherwise the remote provider page renders nothing while every button on
    // it would have worked.
    for (const channel of ['provider-registry:list', 'shared-provider:own-key-holders']) {
      expect(commandRegistry.declaration(channel)).toMatchObject({
        capability: 'config',
        kind: 'query'
      })
      expect(AUTH_OFF_GRANTS.has(commandRegistry.declaration(channel)!.capability)).toBe(true)
    }
  })

  it('automation:save dispatches over the remote transport, and fails closed without `config`', async () => {
    // RED BEFORE S1b: `automation:*` had no remote registration at all, so this
    // same dispatch answered `Channel not available: automation:save` — the
    // unregistered-channel shape, which `automation-commands.test.ts` pins
    // explicitly against a registry that has not registered them.
    const saved: unknown[] = []
    setAutomationManager({
      upsert: (a: unknown) => saved.push(a)
    } as unknown as Parameters<typeof setAutomationManager>[0])

    const granted = makeRemoteConnection('password', null)
    await dispatcher.handle(makeRequest('automation:save', { id: 'nightly' }), granted)
    expect(saved).toEqual([{ id: 'nightly' }])

    // An enrollment link holds `enroll` and nothing else — the narrowest real
    // connection the server mints.
    const ungranted = makeRemoteConnection('enroll-token', null, ENROLL_ONLY_GRANTS)
    await expect(
      dispatcher.handle(makeRequest('automation:save', { id: 'nightly' }), ungranted)
    ).rejects.toThrow(/Permission denied: "automation:save" requires the "config" capability/)
    expect(saved).toHaveLength(1)
  })

  it('refuses a traversal id on every newly-remote path-building family (F1)', async () => {
    // RED BEFORE the F1 fix: `config:save-engine-config` with this engineId wrote
    // `~/.claude/settings.json` — Claude Code's hooks + permissions file, whose
    // contents execute with no approval gate — from any authenticated remote
    // connection. `opencode-agents:save` was the same shape against arbitrary
    // `.md` (e.g. `~/.claude/CLAUDE.md`, standing model instructions).
    //
    // This asserts the PERIMETER (`ipc/config-commands.ts`), which is the layer a
    // transport can see: `ui-config` is mocked in this file, so nothing here could
    // reach the service backstop. That second layer is unit-tested directly in
    // `services/__tests__/ui-config-path-guard.test.ts` and
    // `opencode/__tests__/opencode-agents.test.ts`.
    const conn = makeRemoteConnection('password', null)
    const escapes = ['../../settings', '..', 'a/b', 'a\\b', 'C:evil', '.hidden', '']

    for (const bad of escapes) {
      // The two config families throw (no `safeHandler` envelope on them).
      await expect(
        dispatcher.handle(makeRequest('config:save-engine-config', bad, {}), conn),
        `engineId ${JSON.stringify(bad)}`
      ).rejects.toThrow(/Invalid engineId/)
      await expect(
        dispatcher.handle(makeRequest('config:load-engine-config', bad), conn)
      ).rejects.toThrow(/Invalid engineId/)
      await expect(
        dispatcher.handle(makeRequest('config:save-vendor-config', bad, {}), conn)
      ).rejects.toThrow(/Invalid vendorId/)
      await expect(
        dispatcher.handle(makeRequest('config:load-vendor-config', bad), conn)
      ).rejects.toThrow(/Invalid vendorId/)

      // The agent family is `safeHandler`-wrapped, so the refusal arrives as the
      // envelope the desktop and the web client both already read.
      for (const [channel, args] of [
        ['opencode-agents:read', [bad, 'global']],
        ['opencode-agents:save', [{ name: bad, scope: 'global', mode: 'all' }]],
        ['opencode-agents:delete', [bad, 'global']],
        ['opencode-agents:set-disabled', [bad, 'global', undefined, true]]
      ] as Array<[string, unknown[]]>) {
        const result = (await dispatcher.handle(makeRequest(channel, ...args), conn)) as {
          ok: boolean
          error?: string
        }
        expect(result.ok, `${channel} ${JSON.stringify(bad)}`).toBe(false)
        expect(result.error).toMatch(/Invalid agent name/)
      }
    }

    // …and the real vocabularies still pass: engine ids, provider ids, and the
    // agent names the settings UI produces.
    for (const good of ['claude', 'opencode', 'pi']) {
      await expect(
        dispatcher.handle(makeRequest('config:load-engine-config', good), conn)
      ).resolves.toBeDefined()
    }
    for (const good of ['anthropic', 'openai-codex', 'github-copilot', 'zen']) {
      await expect(
        dispatcher.handle(makeRequest('config:load-vendor-config', good), conn)
      ).resolves.toBeDefined()
    }
  })

  it('a traversal automation id is refused at the perimeter, over the remote transport too', async () => {
    const spy = vi.fn()
    setAutomationManager({ delete: spy } as unknown as Parameters<typeof setAutomationManager>[0])
    await expect(
      dispatcher.handle(
        makeRequest('automation:delete', '../..'),
        makeRemoteConnection('password', null)
      )
    ).rejects.toThrow(/Invalid automation id/)
    expect(spy).not.toHaveBeenCalled()
  })

  it('every exposed channel outside NOT_GRANTED_AT_CONNECT is reachable under the legacy grant set', () => {
    const unreachable = commandRegistry
      .channels('remote')
      .map((c) => [c, commandRegistry.declaration(c)!.capability] as const)
      .filter(([, cap]) => !AUTH_OFF_GRANTS.has(cap))
    // The complete list of channels a token/tailnet connection cannot reach, as
    // the hand-kept table says (with the reason for each family). Anything else
    // appearing here is a channel that silently stopped being reachable — or
    // started being one.
    const expected = [...Object.entries(NOT_GRANTED_AT_CONNECT)].sort(([a], [b]) =>
      a.localeCompare(b)
    )
    expect(
      [...unreachable].sort(([a], [b]) => a.localeCompare(b)),
      `these channels declare a capability remote connections do not hold: ${unreachable
        .map(([c, cap]) => `${c}(${cap})`)
        .join(', ')}`
    ).toEqual(expected)
  })

  it('no NOT_GRANTED_AT_CONNECT entry declares `host`', () => {
    // A host-physical verb must never be sanctioned for remote by one table line.
    expect(
      Object.entries(NOT_GRANTED_AT_CONNECT).filter(([, cap]) => cap === 'host'),
      'host capability channels in the table'
    ).toEqual([])
  })

  it('the passkey channels are unreachable from a plain token connection', async () => {
    const conn = makeRemoteConnection('password', null)
    const passkeyChannels = notGrantedChannels({ prefix: 'webauthn:' })
    expect(passkeyChannels.length).toBe(6)
    for (const channel of passkeyChannels) {
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
    const conn = makeRemoteConnection('password', null)
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

  it('every registered webauthn channel is deliberately classified: gated OR free, never both', () => {
    // ADR-054 decision 6: passkey MANAGEMENT writes join the settings-session
    // class; the list and the enrollment ceremony stay free. A new `webauthn:*`
    // verb added to neither list would classify by `kind` and be reachable with no
    // unlocked editor, so it has to be argued for here. The literal lists are this
    // file's own, so the pin does not import what it pins.
    const gatedLiteral = ['webauthn:mint-enroll-token', 'webauthn:rename', 'webauthn:revoke']
    const freeLiteral = [
      'webauthn:credentials',
      'webauthn:register-options',
      'webauthn:register-verify'
    ]
    const registered = commandRegistry.channels('remote').filter((c) => c.startsWith('webauthn:'))
    const gated = registered.filter((c) => CLASSIFIED_PASSKEY_ADMIN_CHANNELS.has(c))
    expect(gated.sort()).toEqual(gatedLiteral)
    expect(registered.filter((c) => !gated.includes(c)).sort()).toEqual(freeLiteral)
    for (const channel of freeLiteral) expect(gatedLiteral).not.toContain(channel)

    for (const channel of registered) {
      const decl = commandRegistry.declaration(channel)!
      const cls = classifyDispatch({ channel, capability: decl.capability, kind: decl.kind })
      if (gatedLiteral.includes(channel)) expect(cls, channel).toBe('authcfg')
      else expect(cls, channel).not.toBe('authcfg')
    }
  })

  it('no remotely-registered channel can write the auth-DISABLING switch', () => {
    // ADR-054 decision 6, structurally. `remote:set-config` is the only writer of
    // `authPolicy: 'off'`, and it has no remote registration — so the host anchor
    // holds by construction rather than by a capability check (a passkey
    // connection DOES hold `admin`). The settings verbs that ARE web-reachable
    // live in their own namespace, and `authcfg:apply` refuses an `off` auth-mode
    // with a typed error (asserted in authcfg-commands.test.ts).
    //
    // The namespace is no longer EMPTY on this transport (owner ruling,
    // 2026-08-28): `remote:status-view` reads a redacted status. It is pinned as
    // an exact list rather than a prefix emptiness check precisely so the next
    // `remote:*` registration has to be argued for here — a `query` that
    // discloses no key is a different thing from a mutation that could stop the
    // listener the caller is riding, and only the first is sanctioned.
    expect(commandRegistry.channels('remote').filter((c) => c.startsWith('remote:'))).toEqual([
      'remote:status-view'
    ])
    // Named individually, because THIS is the self-kill protection: none of the
    // host-anchor verbs may acquire a remote handler.
    for (const channel of [
      'remote:start',
      'remote:stop',
      'remote:status',
      'remote:interfaces',
      'remote:get-config',
      'remote:set-config',
      'remote:set-password',
      'remote:clear-password',
      'remote:tailscale-detect',
      'remote:force-reserve'
    ]) {
      expect(commandRegistry.get(channel, 'remote'), channel).toBeUndefined()
    }
    expect(
      commandRegistry
        .channels('remote')
        .filter((c) => c.startsWith('authcfg:'))
        .sort()
    ).toEqual([...AUTHCFG_CHANNELS].sort())
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
    const conn = makeRemoteConnection('password', null)
    const shellChannels = notGrantedChannels({ capability: 'shell' })
    expect(shellChannels.length).toBe(7)
    for (const channel of shellChannels) {
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
    // SIX sanctioned widenings, each deliberate and each behind a proven
    // identity: the terminal set (ADR-052 decision 6), the passkey set
    // (decision 1), the `authcfg:*` settings namespace (ADR-054 §6, extended by
    // ADR-056 with the two LAN-channel verbs — which is also when the namespace
    // joined the pin table, `admin` having shrunk to exactly these two
    // families), the IDE mint (ADR-064), and the harness manager's writes
    // (ADR-082 §7: `admin`, so a passkey or break-glass connection only), and
    // the speech pack's writes (ADR-101 §6: `admin`, the same reason).
    // Everything else in the pin table must still be absent from the remote
    // surface — which, for `remote:set-config`, is what makes the `off` master
    // switch structurally unreachable from a remote client now that a passkey
    // connection holds `admin`.
    const exposed = new Set(commandRegistry.channels('remote'))
    const sanctioned = new Set<string>(Object.keys(NOT_GRANTED_AT_CONNECT))
    for (const channel of Object.keys(PINNED_CAPABILITIES)) {
      if (sanctioned.has(channel)) continue
      expect(exposed.has(channel), `${channel} must not be on the remote surface`).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// S4 — the vendor-OAuth / account / native-OAuth family, dispatched (ADR-057).
//
// The parity block above pins that these channels are REGISTERED and reachable
// under the base grant set. This block drives them through the shared registry
// with an injected fake auth provider, so it covers what registration alone
// cannot: fail-closed gating, token-never-on-wire, and the opencode-`auto`
// remote refusal.
// ---------------------------------------------------------------------------

describe('S4 vendor-credential surface dispatch (ADR-057)', () => {
  let dispatcher: RemoteDispatcher

  // A fake provider standing in for whatever engineId is asked for — the branch
  // that matters (opencode-auto refusal) keys on the engineId ARG, not on which
  // provider object comes back.
  const fakeProvider = {
    probe: vi.fn(async () => ({
      openai: { authState: 'authenticated', billingType: 'apiKey', label: 'API key' }
    })),
    listVendorCredentialIds: vi.fn(async () => ({ openai: 'api' as const })),
    oauthAuthorize: vi.fn(async () => ({
      url: 'https://auth.example.com/oauth?x=1',
      method: 'auto' as const,
      instructions: 'Sign in.'
    })),
    cancelVendorOauth: vi.fn(async () => {}),
    // Parameters spelled out (not `vi.fn(async () => true)`) so the null-guard
    // below can read `mock.calls[0][2]` — an argument-less fake types its calls
    // as an empty tuple.
    oauthCallback: vi.fn(async (_vendorId: string, _method: number, _code?: string) => true)
  }

  beforeEach(() => {
    fakeProvider.probe.mockClear()
    fakeProvider.cancelVendorOauth.mockClear()
    fakeProvider.oauthCallback.mockClear()
    makeFakeWindow()
    dispatcher = new RemoteDispatcher()
    registerRemoteHandlers(dispatcher, sessionManagerStub, undefined, {
      requireEngineAuth: () => fakeProvider as never,
      setAccountEnabled: async (enabled: boolean) => ({
        enabled,
        activeId: null,
        accounts: []
      })
    })
  })

  afterEach(() => {
    gitWatchRegistry.releaseConnection(remoteConn.connectionId)
    clearSyncSubscribersForTests()
  })

  it('an ordinary authenticated (config) connection reaches vendor-auth:probe', async () => {
    const conn = makeRemoteConnection('password', null)
    const res = (await dispatcher.handle(makeRequest('vendor-auth:probe', 'opencode'), conn)) as {
      ok: boolean
      data?: unknown
    }
    expect(res.ok).toBe(true)
    expect(fakeProvider.probe).toHaveBeenCalledTimes(1)
  })

  it('an enroll-only connection is refused (fail-closed — config not held)', async () => {
    const conn = makeRemoteConnection('enroll-token', null, ENROLL_ONLY_GRANTS)
    await expect(
      dispatcher.handle(makeRequest('vendor-auth:probe', 'opencode'), conn)
    ).rejects.toThrow(/Permission denied: "vendor-auth:probe" requires the "config" capability/)
    expect(fakeProvider.probe).not.toHaveBeenCalled()
  })

  it('token material never crosses the wire (probe/list-keys carry no access/refresh/key)', async () => {
    const conn = makeRemoteConnection('password', null)
    const probe = (await dispatcher.handle(makeRequest('vendor-auth:probe', 'opencode'), conn)) as {
      ok: boolean
      data: Record<string, Record<string, unknown>>
    }
    const keys = (await dispatcher.handle(
      makeRequest('vendor-auth:list-keys', 'opencode'),
      conn
    )) as { ok: boolean; data: Record<string, unknown> }
    const SECRET_FIELDS = ['access', 'refresh', 'token', 'key', 'apiKey', 'secret']
    for (const entry of Object.values(probe.data)) {
      for (const field of SECRET_FIELDS) expect(entry).not.toHaveProperty(field)
    }
    // list-keys is a map of vendorId → 'api' | 'oauth' — kinds, never material.
    expect(Object.values(keys.data)).toEqual(['api'])
  })

  it("refuses opencode's `auto` method from a REMOTE caller and tears the flow down", async () => {
    const conn = makeRemoteConnection('password', null)
    const res = (await dispatcher.handle(
      makeRequest('vendor-auth:oauth-authorize', 'opencode', 'anthropic', 0),
      conn
    )) as { ok: boolean; error?: string }
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/only completes on the host machine/)
    expect(fakeProvider.cancelVendorOauth).toHaveBeenCalledTimes(1)
  })

  it("does NOT refuse pi's ChatGPT `auto` remotely — it completes via paste-back", async () => {
    const conn = makeRemoteConnection('password', null)
    const res = (await dispatcher.handle(
      makeRequest('vendor-auth:oauth-authorize', 'pi', 'openai-codex', 0),
      conn
    )) as { ok: boolean; data?: { url: string } }
    expect(res.ok).toBe(true)
    expect(res.data?.url).toContain('auth.example.com')
    expect(fakeProvider.cancelVendorOauth).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // JSON-null optional arguments in the SHARED command modules.
  //
  // 922644bf normalised the remote-only handlers in `remote-handlers.ts`; the
  // declarations `session.ipc.ts` and `remote-handlers.ts` BOTH spread carried
  // the same class. The web client marshals `invoke` args as JSON and
  // `api-adapter.ts` forwards every declared parameter positionally, so an
  // argument the renderer stopped short of arrives here as an explicit `null`
  // rather than `undefined`. These two are the ones whose consumers actually
  // break on it — see `src/core/ipc/wire-args.ts`.
  // -------------------------------------------------------------------------

  it('vendor-auth:oauth-callback normalises a null code to undefined (GUARD — fails pre-fix)', async () => {
    const conn = makeRemoteConnection('password', null)
    // The `auto` method awaits the host loopback with NO code — the renderer
    // simply omits the argument, and the wire turns that into null.
    const res = (await dispatcher.handle(
      makeRequest('vendor-auth:oauth-callback', 'opencode', 'anthropic', 0, null),
      conn
    )) as { ok: boolean }
    expect(res.ok).toBe(true)
    // `OpencodeClient.oauthCallback` spreads `code` into the POST body on
    // `code !== undefined`, and opencode types that field
    // `Schema.optional(Schema.String)` — a null would be sent and rejected.
    expect(
      fakeProvider.oauthCallback.mock.calls[0][2],
      'code must be undefined, not null'
    ).toBeUndefined()
  })

  it('vendor-auth:oauth-callback passes a real pasted code through unchanged', async () => {
    const conn = makeRemoteConnection('password', null)
    await dispatcher.handle(
      makeRequest('vendor-auth:oauth-callback', 'pi', 'openai-codex', 0, 'pasted-code#state'),
      conn
    )
    expect(fakeProvider.oauthCallback.mock.calls[0]).toEqual([
      'openai-codex',
      0,
      'pasted-code#state'
    ])
  })

  it('shared-provider:set-default normalises a null modelId to undefined (GUARD — fails pre-fix)', async () => {
    const setDefault = vi
      .spyOn(sharedProviderService, 'setRouteDefaultModel')
      .mockResolvedValue(undefined)
    try {
      const conn = makeRemoteConnection('password', null)
      // Clearing the default: `ProviderSheet.tsx` sends `value || undefined`.
      const res = (await dispatcher.handle(
        makeRequest('shared-provider:set-default', 'ollama-local', 'pi', null),
        conn
      )) as { ok: boolean }
      expect(res.ok).toBe(true)
      // `undefined` DROPS `defaultModel` from the saved definition; `null` keeps
      // it, and `SharedProviderRepository.save`'s `isRoute` check then refuses
      // the whole write with "Invalid shared provider routes".
      expect(setDefault.mock.calls[0][2], 'modelId must be undefined, not null').toBeUndefined()
    } finally {
      setDefault.mockRestore()
    }
  })

  it('shared-provider:set-default passes a real modelId through unchanged', async () => {
    const setDefault = vi
      .spyOn(sharedProviderService, 'setRouteDefaultModel')
      .mockResolvedValue(undefined)
    try {
      const conn = makeRemoteConnection('password', null)
      await dispatcher.handle(
        makeRequest('shared-provider:set-default', 'ollama-local', 'pi', 'llama-4'),
        conn
      )
      expect(setDefault.mock.calls[0]).toEqual(['ollama-local', 'pi', 'llama-4'])
    } finally {
      setDefault.mockRestore()
    }
  })
})
