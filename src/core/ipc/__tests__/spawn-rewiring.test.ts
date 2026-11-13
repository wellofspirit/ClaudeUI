/**
 * @vitest-environment node
 *
 * Tests that session:create reads proxy from loadEngineConfig('claude'), not from
 * loadSettings(), and that no sandbox rides in the spawn options (it is the shared file's).
 *
 * Follows the same pattern as session.ipc.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { bootIpcHarness, type IpcHarness } from '../../../test/helpers/boot-ipc-harness'
import type { EngineId } from '../../../shared/types'

// hoisted spies
const { sessionManagerSpies } = vi.hoisted(() => {
  const sessionStub: Record<string, unknown> = {
    willQueue: false,
    cwd: '/tmp/cwd',
    engineId: 'claude',
    capabilities: undefined,
    run: vi.fn(),
    resolveApproval: vi.fn(),
    watchBackground: vi.fn(),
    unwatchBackground: vi.fn(),
    readBackgroundRange: vi.fn(() => ''),
    stopTask: vi.fn(async () => ({ success: true })),
    backgroundTask: vi.fn(async () => ({ success: true })),
    askSideQuestion: vi.fn(async () => null),
    setPermissionMode: vi.fn(async () => {}),
    setModel: vi.fn(async () => {}),
    setEffort: vi.fn(),
    setThinkingMode: vi.fn(),
    voiceStartServer: vi.fn(async () => {}),
    voiceStopServer: vi.fn(async () => {}),
    mcpServerStatus: vi.fn(async () => []),
    mcpToggleServer: vi.fn(async () => {}),
    mcpReconnectServer: vi.fn(async () => {}),
    mcpSetServers: vi.fn(async () => ({})),
    notifySettingsChanged: vi.fn(async () => {}),
    getPlanContent: vi.fn(() => null),
    getSessionLogPath: vi.fn(() => null),
    getUsage: vi.fn(async () => null)
  }
  const sessionManagerSpies = {
    create: vi.fn(),
    rekey: vi.fn(),
    get: vi.fn(() => sessionStub),
    cancel: vi.fn(),
    interrupt: vi.fn(async () => {}),
    forEach: vi.fn(),
    setSessionTimeout: vi.fn()
  }
  return { sessionManagerSpies, sessionStub }
})

// Engine / vendor config mocks with configurable returns
const uiConfigMocks = vi.hoisted(() => ({
  loadSettings: vi.fn(() => ({})),
  saveSettings: vi.fn(),
  loadSessionConfig: vi.fn(() => ({})),
  saveSessionConfig: vi.fn(),
  loadSlashCommands: vi.fn(() => []),
  saveSlashCommands: vi.fn(),
  startConfigWatcher: vi.fn(() => () => {}),
  loadEngineConfig: vi.fn(() => ({})),
  saveEngineConfig: vi.fn(),
  loadVendorConfig: vi.fn(() => ({})),
  saveVendorConfig: vi.fn()
}))

vi.mock('../../services/ui-config', () => uiConfigMocks)
vi.mock('../../services/claude-sandbox-watch', () => ({
  startClaudeSandboxWatcher: vi.fn(() => () => {})
}))
vi.mock('../../services/git-service', () => ({
  gitServiceManager: {
    get: vi.fn(() => ({
      isGitRepo: vi.fn(async () => true),
      getStatus: vi.fn(async () => ({ files: [], branch: 'main' })),
      getBranches: vi.fn(async () => ({ current: 'main', all: ['main'] })),
      checkout: vi.fn(async () => {}),
      createBranch: vi.fn(async () => {}),
      getFilePatch: vi.fn(async () => 'patch'),
      getFileContents: vi.fn(async () => 'contents'),
      stageFile: vi.fn(async () => {}),
      unstageFile: vi.fn(async () => {}),
      discardFile: vi.fn(async () => {}),
      stageAll: vi.fn(async () => {}),
      unstageAll: vi.fn(async () => {}),
      commit: vi.fn(async () => ({ sha: 'abc' })),
      push: vi.fn(async () => {}),
      pushWithUpstream: vi.fn(async () => {}),
      pull: vi.fn(async () => ({ ok: true })),
      fetch: vi.fn(async () => {}),
      startPolling: vi.fn(),
      stopPolling: vi.fn()
    })),
    getIfExists: vi.fn(() => undefined),
    release: vi.fn()
  }
}))
vi.mock('../../services/worktree', () => ({
  createWorktree: vi.fn(async () => ({ path: '/tmp/wt', branch: 'feat' })),
  getWorktreeStatus: vi.fn(async () => ({ dirty: false })),
  removeWorktree: vi.fn(async () => {})
}))
vi.mock('../../services/session-history', () => ({
  listDirectories: vi.fn(async () => []),
  loadSessionHistory: vi.fn(async () => []),
  loadSubagentHistory: vi.fn(async () => []),
  buildSubagentFileMap: vi.fn(() => ({})),
  loadBackgroundOutput: vi.fn(() => ''),
  resolveForkAnchor: vi.fn(async () => ({ anchorUuid: null }))
}))
vi.mock('../../services/session-watcher', () => ({
  watchSession: vi.fn(),
  unwatchSession: vi.fn()
}))
vi.mock('../../services/claude-settings', () => ({
  loadClaudePermissions: vi.fn(() => ({
    allow: [],
    deny: [],
    ask: [],
    additionalDirectories: [],
    defaultMode: undefined
  })),
  saveClaudePermissions: vi.fn(),
  loadCleanupPeriodDays: vi.fn(() => undefined),
  saveCleanupPeriodDays: vi.fn()
}))
vi.mock('../../services/claude-mcp', () => ({
  loadMcpServers: vi.fn(() => ({})),
  saveMcpServers: vi.fn(),
  removeMcpServer: vi.fn(),
  readDisabledMcpServers: vi.fn(() => []),
  writeDisabledMcpServers: vi.fn()
}))
vi.mock('../../services/delete-session-files', () => ({
  deleteSessionFiles: vi.fn(async () => {}),
  deleteProjectFiles: vi.fn(async () => {})
}))
vi.mock('../../services/socks-bridge', () => ({
  startSocksBridge: vi.fn(async () => 1080),
  stopSocksBridge: vi.fn(async () => {})
}))
vi.mock('../../services/usage-fetcher', () => ({
  usageFetcher: {
    setWindow: vi.fn(),
    setSessionGetter: vi.fn(),
    setIntervalSecs: vi.fn(),
    startPolling: vi.fn(),
    fetch: vi.fn(async () => ({}))
  }
}))
vi.mock('../../services/service-session', () => ({
  serviceSession: { getUsage: vi.fn(async () => ({})) }
}))
vi.mock('../../services/block-usage', () => ({
  blockUsageService: {
    setWindow: vi.fn(),
    setDebounceSecs: vi.fn(),
    recalculate: vi.fn(async () => ({})),
    startWatching: vi.fn(),
    getData: vi.fn(() => null)
  }
}))
vi.mock('../../services/persisted-sessions-dir', () => ({
  PERSISTED_SESSIONS_DIR: '/tmp/persisted-sessions'
}))
vi.mock('../../services/session-manager', () => ({
  SessionManager: class {
    constructor() {
      /* no-op */
    }
    create = sessionManagerSpies.create
    rekey = sessionManagerSpies.rekey
    get = sessionManagerSpies.get
    cancel = sessionManagerSpies.cancel
    interrupt = sessionManagerSpies.interrupt
    forEach = sessionManagerSpies.forEach
    setSessionTimeout = sessionManagerSpies.setSessionTimeout
  }
}))
vi.mock('../../services/claude-session', () => {
  const extraWindows = new Set<unknown>()
  return {
    ClaudeSession: class {
      static addExtraWindow(w: unknown): void {
        extraWindows.add(w)
      }
      static removeExtraWindow(w: unknown): void {
        extraWindows.delete(w)
      }
      static getExtraWindows(): Set<unknown> {
        return extraWindows
      }
    },
    getSdkExecutableOpts: vi.fn(() => ({}))
  }
})
vi.mock('../../sdk', () => ({
  query: vi.fn(() => {
    async function* empty(): AsyncGenerator<unknown> {
      /* noop */
    }
    const gen: unknown = empty()
    ;(gen as Record<string, unknown>).supportedModels = async () => []
    return gen
  })
}))
vi.mock('electron', async () => await import('../../../test/stubs/electron-shim'))
vi.mock('../../services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), applyFilter: vi.fn() }
}))
vi.mock('../../../main/services/auth-manager', () => ({
  authManager: { getState: vi.fn(() => ({})), init: vi.fn() }
}))
vi.mock('../../../main/services/account-manager', () => ({
  accountManager: {
    getAccounts: vi.fn(() => ({})),
    setMultiAccountEnabled: vi.fn(),
    addAccount: vi.fn(),
    switchAccount: vi.fn(),
    deleteAccount: vi.fn(),
    init: vi.fn()
  }
}))
vi.mock('../../sdk/proxy', () => ({
  setProxyEnv: vi.fn(async () => {})
}))
vi.mock('../../sdk/endpoint-env', () => ({ setEndpointEnv: vi.fn() }))
vi.mock('../../sdk/model-env', () => ({ setModelEnv: vi.fn() }))

// Partial mock: only the spawn-model resolver is doubled, so the module's other
// exports (OpencodeSession reads several) stay real.
const opencodeDiscoveryMocks = vi.hoisted(() => ({
  resolveOpencodeSpawnModel: vi.fn(async (m?: string) => m)
}))
vi.mock('../../opencode/model-discovery', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveOpencodeSpawnModel: opencodeDiscoveryMocks.resolveOpencodeSpawnModel
}))

import { ModelUnavailableError } from '../../../shared/model-errors'
import { registerSessionIpc } from '../session.ipc'
import { setHostWindow } from '../../services/host-window'

describe('session:create spawn rewiring (Phase 3b)', () => {
  let harness: IpcHarness

  beforeEach(() => {
    vi.clearAllMocks()
    harness = bootIpcHarness()
    setHostWindow(harness.win)
    registerSessionIpc({
      // S3 stage 1b: the desktop-auth pair is injected now (the registrar left
      // `src/main` and must not import the Electron-bound singletons). Neither
      // channel family under test touches these, so a throwing stub is the
      // honest double — it fails loudly if that ever stops being true.
      requireEngineAuth: () => {
        throw new Error('requireEngineAuth is not stubbed in this suite')
      },
      setAccountEnabled: () => {
        throw new Error('setAccountEnabled is not stubbed in this suite')
      }
    })
  })

  afterEach(() => {
    setHostWindow(null)
    harness.teardown()
  })

  it('calls loadEngineConfig("claude") and loadVendorConfig("anthropic") on session:create', async () => {
    uiConfigMocks.loadEngineConfig.mockReturnValue({})
    uiConfigMocks.loadVendorConfig.mockReturnValue({})

    await harness.call('session:create', 'routing-1', { cwd: '/tmp/cwd' })

    expect(uiConfigMocks.loadEngineConfig).toHaveBeenCalledWith('claude')
    expect(uiConfigMocks.loadVendorConfig).toHaveBeenCalledWith('anthropic')
  })

  it('carries no sandbox into the spawn options: the session reads the shared file itself', async () => {
    uiConfigMocks.loadEngineConfig.mockReturnValue({ sandbox: { enabled: true } })
    uiConfigMocks.loadVendorConfig.mockReturnValue({})

    await harness.call('session:create', 'routing-2', { cwd: '/tmp/cwd' })

    expect(sessionManagerSpies.create).toHaveBeenCalled()
    // 4th argument (index 3) is the EngineSpawnOptions object in the create() call
    const callArgs = sessionManagerSpies.create.mock.calls[0]
    expect(callArgs[3]).not.toHaveProperty('sandboxConfig')
  })

  it('#6 vendor-at-spawn: derives "anthropic" vendor from Claude ModelRef (no hardcode)', async () => {
    // For a Claude session with any model string, claudeModel(model).vendorId === 'anthropic'.
    // The test verifies loadVendorConfig is called with the derived vendorId, not a literal.
    uiConfigMocks.loadEngineConfig.mockReturnValue({})
    uiConfigMocks.loadVendorConfig.mockReturnValue({})

    // Explicitly pass a model string; engineId defaults to 'claude'
    await harness.call('session:create', 'routing-5', {
      cwd: '/tmp/cwd',
      config: { model: 'claude-sonnet-4-6' }
    })

    // claudeModel('claude-sonnet-4-6').vendorId === 'anthropic'
    expect(uiConfigMocks.loadVendorConfig).toHaveBeenCalledWith('anthropic')
  })

  it('#6 vendor-at-spawn: opencode sessions skip vendor config load entirely', async () => {
    uiConfigMocks.loadEngineConfig.mockReturnValue({})
    uiConfigMocks.loadVendorConfig.mockReturnValue({})

    await harness.call('session:create', 'routing-6', { cwd: '/tmp/cwd', engineId: 'opencode' })

    // opencode path skips vendor config — loadVendorConfig should NOT be called
    expect(uiConfigMocks.loadVendorConfig).not.toHaveBeenCalled()
  })

  it('Item 4 GUARD: unknown engineId throws from prepareAndCreateSession and never applies Claude vendor/env (fails pre-fix)', async () => {
    uiConfigMocks.loadEngineConfig.mockReturnValue({})
    uiConfigMocks.loadVendorConfig.mockReturnValue({})
    await expect(
      harness.call('session:create', 'routing-unknown', {
        cwd: '/tmp/cwd',
        engineId: 'gemini' as unknown as EngineId
      })
    ).rejects.toThrow(/No spawn-prep registered for engine "gemini"/)
    // Pre-fix, the else-is-claude branch applied Anthropic vendor config + env for
    // any non-'opencode' id (including bogus ones). Post-fix, require() throws first.
    expect(uiConfigMocks.loadVendorConfig).not.toHaveBeenCalled()
  })

  /**
   * Item 3a end-to-end: spawn-prep throws → prepareAndCreateSession rejects →
   * the IPC invoke rejects with a message naming the model, and NO session is
   * created. Pre-fix the resolver substituted a different model and the session
   * spawned on it silently.
   */
  it('Item 3a GUARD: an unavailable requested model rejects session:create and never reaches SessionManager', async () => {
    uiConfigMocks.loadEngineConfig.mockReturnValue({})
    opencodeDiscoveryMocks.resolveOpencodeSpawnModel.mockRejectedValueOnce(
      new ModelUnavailableError('opencode', 'openai/gpt-5.5')
    )

    await expect(
      harness.call('session:create', 'routing-stale-model', {
        cwd: '/tmp/cwd',
        engineId: 'opencode',
        config: { model: 'openai/gpt-5.5' }
      })
    ).rejects.toThrow(/openai\/gpt-5\.5/)

    expect(sessionManagerSpies.create).not.toHaveBeenCalled()
  })
})
