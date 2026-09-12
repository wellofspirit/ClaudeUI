/**
 * @vitest-environment node
 *
 * The three places that regenerate `$CODEX_HOME/rules/claudeui.rules`.
 *
 * `syncCodexRulesFile` is mocked in every case, so nothing here touches a real
 * (or temp) `CODEX_HOME` — what is under test is that each trigger calls it,
 * once, and that the scope-gated ones do not fire on a write the generated file
 * cannot possibly depend on.
 *
 * Everything else these three entry points drag in is mocked away too: the four
 * engine session classes, the settings store, and the whole `startCoreServices`
 * service graph. The trigger is the subject; the graph is not.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const emptyPerms = (deny: string[] = []) => ({
  allow: [],
  deny,
  ask: [],
  additionalDirectories: [],
  defaultMode: undefined
})

const rulesSyncMocks = vi.hoisted(() => ({
  armCodexRulesSync: vi.fn(),
  syncCodexRulesFile: vi.fn(() => ({ wrote: false, path: '/fixture/claudeui.rules', skipped: [] }))
}))
vi.mock('../rules-sync', () => rulesSyncMocks)

vi.mock('../../services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), applyFilter: vi.fn() }
}))

// ── (a) Codex spawn prep ─────────────────────────────────────────────────────

const locateMocks = vi.hoisted(() => ({ codexBinaryAvailable: vi.fn(() => true) }))
vi.mock('../codex-locate', () => locateMocks)
vi.mock('../../services/claude-session', () => ({ ClaudeSession: class {} }))
vi.mock('../../opencode/OpencodeSession', () => ({ OpencodeSession: class {} }))
vi.mock('../../pi/PiSession', () => ({ PiSession: class {} }))
vi.mock('../CodexSession', () => ({ CodexSession: class {} }))
vi.mock('../../providers/claude-spawn-prep', () => ({
  claudeSpawnPrep: vi.fn(),
  applyProxyEnv: vi.fn(),
  applyEndpointEnv: vi.fn(),
  applyModelEnv: vi.fn()
}))
vi.mock('../../opencode/opencode-spawn-prep', () => ({ opencodeSpawnPrep: vi.fn() }))
vi.mock('../../pi/pi-spawn-prep', () => ({ piSpawnPrep: vi.fn() }))

// ── (b) The two permission writers ───────────────────────────────────────────

const settingsMocks = vi.hoisted(() => ({
  saveClaudePermissions: vi.fn(),
  saveCleanupPeriodDays: vi.fn(),
  loadClaudePermissions: vi.fn(() => ({
    allow: [],
    deny: [],
    ask: [],
    additionalDirectories: [],
    defaultMode: undefined
  }))
}))
vi.mock('../../services/claude-settings', () => settingsMocks)
vi.mock('../../services/skill-scanner', () => ({ scanSkills: vi.fn(async () => []) }))
vi.mock('../../services/ui-config', () => ({
  saveSessionConfig: vi.fn(),
  saveSettings: vi.fn(),
  loadEngineConfig: vi.fn(() => ({})),
  loadVendorConfig: vi.fn(() => ({}))
}))

// ── (c) The core boot graph ──────────────────────────────────────────────────

const bootMocks = vi.hoisted(() => ({
  sessionManager: { get: () => undefined, forEach: () => {} }
}))
vi.mock('../../ipc/session.ipc', () => ({
  registerSessionIpc: vi.fn(() => bootMocks.sessionManager)
}))
vi.mock('../../ipc/terminal.ipc', () => ({ registerTerminalIpc: vi.fn() }))
vi.mock('../../ipc/automation.ipc', () => ({ registerAutomationIpc: vi.fn(() => ({})) }))
vi.mock('../../ipc/webauthn.ipc', () => ({ registerWebauthnIpc: vi.fn() }))
vi.mock('../../ipc/authcfg.ipc', () => ({ registerAuthcfgIpc: vi.fn() }))
vi.mock('../../ipc/remote-view-commands', () => ({ registerRemoteViewIpc: vi.fn() }))
vi.mock('../../ipc/ide-commands', () => ({ registerIdeIpc: vi.fn() }))
vi.mock('../../ipc/remote-handlers', () => ({ registerRemoteHandlers: vi.fn() }))
vi.mock('../../ipc/command-registry', () => ({ hostConnection: vi.fn(() => ({})) }))
vi.mock('../../services/remote-server', () => ({
  RemoteServer: class {
    terminalSink = vi.fn()
    setIdeService = vi.fn()
  }
}))
vi.mock('../../services/remote-dispatcher', () => ({ RemoteDispatcher: class {} }))
vi.mock('../../services/tailscale-manager', () => ({ TailscaleManager: class {} }))
vi.mock('../../services/terminal-service', () => ({ terminalService: { setRemoteSink: vi.fn() } }))
vi.mock('../../services/vscode-web-service', () => ({
  vscodeWebService: { setHostActor: vi.fn() }
}))
vi.mock('../../opencode/OpencodeServerManager', () => ({
  opencodeServerManager: { setCallerSessionLookup: vi.fn(), setDispatchAgent: vi.fn() }
}))
vi.mock('../../services/cross-engine-dispatcher', () => ({
  crossEngineDispatcher: { dispatch: vi.fn() }
}))
vi.mock('../../auth/vault/CredentialSync', () => ({
  credentialSync: { start: vi.fn(async () => {}) }
}))
vi.mock('../../shared-providers', () => ({
  sharedProviderService: { syncAll: vi.fn(async () => {}) }
}))
vi.mock('../../boot/host-anchor', () => ({
  createHostAnchor: vi.fn(() => ({ reconcileAndAutostart: vi.fn(async () => {}) }))
}))

beforeEach(() => {
  vi.clearAllMocks()
  locateMocks.codexBinaryAvailable.mockReturnValue(true)
})

describe('codex spawn prep', () => {
  it('syncs the rule file exactly once before a Codex session is created', async () => {
    await import('../../providers/register-engines')
    const { spawnPrepRegistry } = await import('../../providers/SpawnPrepRegistry')

    const result = await spawnPrepRegistry.require('codex')('gpt-5.6-codex', {})

    expect(rulesSyncMocks.syncCodexRulesFile).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ resolvedModel: 'gpt-5.6-codex' })
  })

  it('does not sync when Codex is not installed — the prep fails first', async () => {
    await import('../../providers/register-engines')
    const { spawnPrepRegistry } = await import('../../providers/SpawnPrepRegistry')
    locateMocks.codexBinaryAvailable.mockReturnValue(false)

    await expect(spawnPrepRegistry.require('codex')('gpt-5.6-codex', {})).rejects.toThrow(
      'Codex is not installed'
    )
    expect(rulesSyncMocks.syncCodexRulesFile).not.toHaveBeenCalled()
  })
})

describe('permission writes', () => {
  const manager = { forEach: vi.fn() } as never

  it('regenerates the rule file after a USER-scope permission save', async () => {
    const { savePermissionsAndNotify } = await import('../../ipc/handlers-core')

    savePermissionsAndNotify(manager, 'user', emptyPerms(['Bash(rm:*)']))

    expect(settingsMocks.saveClaudePermissions).toHaveBeenCalledTimes(1)
    expect(rulesSyncMocks.syncCodexRulesFile).toHaveBeenCalledTimes(1)
  })

  it('does not regenerate for project/local scopes — the file compiles user scope only', async () => {
    const { savePermissionsAndNotify } = await import('../../ipc/handlers-core')

    savePermissionsAndNotify(manager, 'project', emptyPerms(), '/repo')
    savePermissionsAndNotify(manager, 'local', emptyPerms(), '/repo')

    expect(settingsMocks.saveClaudePermissions).toHaveBeenCalledTimes(2)
    expect(rulesSyncMocks.syncCodexRulesFile).not.toHaveBeenCalled()
  })

  it('regenerates when an "always allow" answer persists a USER-scope rule', async () => {
    const { persistAllowSuggestions } = await import('../../opencode/permission-compiler')

    const wrote = persistAllowSuggestions(
      [
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'userSettings',
          rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }]
        }
      ],
      '/repo'
    )

    expect(wrote).toBe(true)
    expect(settingsMocks.saveClaudePermissions).toHaveBeenCalledWith(
      'user',
      expect.objectContaining({ allow: ['Bash(ls:*)'] }),
      '/repo'
    )
    expect(rulesSyncMocks.syncCodexRulesFile).toHaveBeenCalledTimes(1)
  })

  it('does not regenerate when an "always allow" answer lands in local scope', async () => {
    const { persistAllowSuggestions } = await import('../../opencode/permission-compiler')

    persistAllowSuggestions(
      [
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'localSettings',
          rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }]
        }
      ],
      '/repo'
    )

    expect(settingsMocks.saveClaudePermissions).toHaveBeenCalledTimes(1)
    expect(rulesSyncMocks.syncCodexRulesFile).not.toHaveBeenCalled()
  })
})

describe('core boot', () => {
  it('regenerates the rule file once on startup, on the path both hosts share', async () => {
    const { startCoreServices } = await import('../../boot/core-services')

    startCoreServices({ remoteAccessDisabled: true, authDeps: {} as never, autostart: false })

    expect(rulesSyncMocks.syncCodexRulesFile).toHaveBeenCalledTimes(1)
    // Boot is also what ARMS the other two triggers against the user's own
    // `$CODEX_HOME`; without it they are no-ops (see rules-sync.test.ts).
    expect(rulesSyncMocks.armCodexRulesSync).toHaveBeenCalledTimes(1)
    expect(rulesSyncMocks.armCodexRulesSync.mock.invocationCallOrder[0]).toBeLessThan(
      rulesSyncMocks.syncCodexRulesFile.mock.invocationCallOrder[0]
    )
  })
})
