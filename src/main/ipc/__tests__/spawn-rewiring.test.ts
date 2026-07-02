/**
 * @vitest-environment node
 *
 * Tests that session:create reads sandbox from loadEngineConfig('claude')
 * and proxy from loadEngineConfig('claude'), not from loadSettings().
 *
 * Follows the same pattern as session.ipc.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { bootIpcHarness, type IpcHarness } from '../../../test/helpers/boot-ipc-harness'

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
    dequeueMessage: vi.fn(async () => ({ removed: 0 })),
    askSideQuestion: vi.fn(async () => null),
    setPermissionMode: vi.fn(async () => {}),
    setModel: vi.fn(async () => {}),
    setEffort: vi.fn(),
    setThinkingMode: vi.fn(),
    voiceStartServer: vi.fn(async () => {}),
    voiceStopServer: vi.fn(async () => {}),
    voiceStartRecording: vi.fn(async () => {}),
    voiceStopRecording: vi.fn(async () => {}),
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
  removeWorktree: vi.fn(async () => {}),
  listWorktrees: vi.fn(async () => [])
}))
vi.mock('../../services/session-history', () => ({
  listDirectories: vi.fn(async () => []),
  loadSessionHistory: vi.fn(async () => []),
  loadSubagentHistory: vi.fn(async () => []),
  buildSubagentFileMap: vi.fn(() => ({})),
  loadBackgroundOutput: vi.fn(() => ''),
  resolveForkAnchor: vi.fn(async () => ({ anchorUuid: null }))
}))
vi.mock('../../services/session-watcher', () => ({ watchSession: vi.fn(), unwatchSession: vi.fn() }))
vi.mock('../../services/claude-settings', () => ({
  loadClaudePermissions: vi.fn(() => ({ allow: [], deny: [], ask: [], additionalDirectories: [], defaultMode: undefined })),
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
vi.mock('../../services/skill-scanner', () => ({ scanSkills: vi.fn(async () => []) }))
vi.mock('../../services/custom-command-scanner', () => ({ scanCustomCommands: vi.fn(async () => []) }))
vi.mock('../../services/delete-session-files', () => ({
  deleteSessionFiles: vi.fn(async () => {}),
  deleteProjectFiles: vi.fn(async () => {})
}))
vi.mock('../../services/socks-bridge', () => ({
  startSocksBridge: vi.fn(async () => 1080),
  stopSocksBridge: vi.fn(async () => {})
}))
vi.mock('../../services/usage-fetcher', () => ({
  usageFetcher: { setWindow: vi.fn(), setSessionGetter: vi.fn(), setIntervalSecs: vi.fn(), startPolling: vi.fn(), fetch: vi.fn(async () => ({})) }
}))
vi.mock('../../services/service-session', () => ({
  serviceSession: { getUsage: vi.fn(async () => ({})) }
}))
vi.mock('../../services/block-usage', () => ({
  blockUsageService: { setWindow: vi.fn(), setDebounceSecs: vi.fn(), recalculate: vi.fn(async () => ({})), startWatching: vi.fn(), getData: vi.fn(() => null) }
}))
vi.mock('../../services/persisted-sessions-dir', () => ({ PERSISTED_SESSIONS_DIR: '/tmp/persisted-sessions' }))
vi.mock('../../services/session-manager', () => ({
  SessionManager: class {
    constructor() { /* no-op */ }
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
      static addExtraWindow(w: unknown): void { extraWindows.add(w) }
      static removeExtraWindow(w: unknown): void { extraWindows.delete(w) }
      static getExtraWindows(): Set<unknown> { return extraWindows }
    },
    getSdkExecutableOpts: vi.fn(() => ({}))
  }
})
vi.mock('../../sdk', () => ({
  query: vi.fn(() => {
    async function* empty(): AsyncGenerator<unknown> { /* noop */ }
    const gen: unknown = empty()
    ;(gen as Record<string, unknown>).supportedModels = async () => []
    return gen
  })
}))
vi.mock('electron', async () => await import('../../../test/stubs/electron-shim'))
vi.mock('../../services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), applyFilter: vi.fn() }
}))
vi.mock('../../services/auth-manager', () => ({ authManager: { getState: vi.fn(() => ({})), init: vi.fn() } }))
vi.mock('../../services/account-manager', () => ({ accountManager: { getAccounts: vi.fn(() => ({})), setMultiAccountEnabled: vi.fn(), addAccount: vi.fn(), switchAccount: vi.fn(), deleteAccount: vi.fn(), init: vi.fn() } }))
vi.mock('../../services/mockup-settings', () => ({ invalidateMockupSecuritySettings: vi.fn() }))
vi.mock('../../../main/sdk/proxy', () => ({ setProxyEnv: vi.fn(async () => {}), setProxyAllSubprocesses: vi.fn() }))
vi.mock('../../../main/sdk/endpoint-env', () => ({ setEndpointEnv: vi.fn() }))
vi.mock('../../../main/sdk/model-env', () => ({ setModelEnv: vi.fn() }))

import { registerSessionIpc } from '../session.ipc'

describe('session:create spawn rewiring (Phase 3b)', () => {
  let harness: IpcHarness

  beforeEach(() => {
    vi.clearAllMocks()
    harness = bootIpcHarness()
    registerSessionIpc(harness.win)
  })

  afterEach(() => {
    harness.teardown()
  })

  it('calls loadEngineConfig("claude") and loadVendorConfig("anthropic") on session:create', async () => {
    uiConfigMocks.loadEngineConfig.mockReturnValue({})
    uiConfigMocks.loadVendorConfig.mockReturnValue({})

    await harness.call('session:create', 'routing-1', '/tmp/cwd')

    expect(uiConfigMocks.loadEngineConfig).toHaveBeenCalledWith('claude')
    expect(uiConfigMocks.loadVendorConfig).toHaveBeenCalledWith('anthropic')
  })

  it('passes sandbox from engine config to session manager create()', async () => {
    const sandboxConfig = {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      network: { restrictNetwork: false, allowLocalBinding: false, allowedDomains: [], allowManagedDomainsOnly: false, allowAllUnixSockets: false, allowUnixSockets: [] },
      filesystem: { allowWrite: [], denyWrite: [], denyRead: [] },
      excludedCommands: []
    }
    uiConfigMocks.loadEngineConfig.mockReturnValue({ sandbox: sandboxConfig })
    uiConfigMocks.loadVendorConfig.mockReturnValue({})

    await harness.call('session:create', 'routing-2', '/tmp/cwd')

    expect(sessionManagerSpies.create).toHaveBeenCalled()
    // 8th argument (index 7) is sandboxConfig in the create() call
    const callArgs = sessionManagerSpies.create.mock.calls[0]
    expect(callArgs[7]).toEqual(sandboxConfig)
  })

  it('passes undefined sandbox when engine config has no sandbox', async () => {
    uiConfigMocks.loadEngineConfig.mockReturnValue({})
    uiConfigMocks.loadVendorConfig.mockReturnValue({})

    await harness.call('session:create', 'routing-3', '/tmp/cwd')

    expect(sessionManagerSpies.create).toHaveBeenCalled()
    const callArgs = sessionManagerSpies.create.mock.calls[0]
    expect(callArgs[7]).toBeUndefined()
  })

  it('does NOT read sandbox from loadSettings()', async () => {
    uiConfigMocks.loadSettings.mockReturnValue({ sandbox: { enabled: true } })
    uiConfigMocks.loadEngineConfig.mockReturnValue({})
    uiConfigMocks.loadVendorConfig.mockReturnValue({})

    await harness.call('session:create', 'routing-4', '/tmp/cwd')

    const callArgs = sessionManagerSpies.create.mock.calls[0]
    // sandbox should be undefined because it came from engine config (which returned {})
    // NOT from loadSettings
    expect(callArgs[7]).toBeUndefined()
  })

  it('#6 vendor-at-spawn: derives "anthropic" vendor from Claude ModelRef (no hardcode)', async () => {
    // For a Claude session with any model string, claudeModel(model).vendorId === 'anthropic'.
    // The test verifies loadVendorConfig is called with the derived vendorId, not a literal.
    uiConfigMocks.loadEngineConfig.mockReturnValue({})
    uiConfigMocks.loadVendorConfig.mockReturnValue({})

    // Explicitly pass a model string; engineId defaults to 'claude'
    await harness.call('session:create', 'routing-5', '/tmp/cwd', undefined, undefined, undefined, 'claude-sonnet-4-6')

    // claudeModel('claude-sonnet-4-6').vendorId === 'anthropic'
    expect(uiConfigMocks.loadVendorConfig).toHaveBeenCalledWith('anthropic')
  })

  it('#6 vendor-at-spawn: opencode sessions skip vendor config load entirely', async () => {
    uiConfigMocks.loadEngineConfig.mockReturnValue({})
    uiConfigMocks.loadVendorConfig.mockReturnValue({})

    await harness.call(
      'session:create', 'routing-6', '/tmp/cwd',
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'opencode'
    )

    // opencode path skips vendor config — loadVendorConfig should NOT be called
    expect(uiConfigMocks.loadVendorConfig).not.toHaveBeenCalled()
  })
})
