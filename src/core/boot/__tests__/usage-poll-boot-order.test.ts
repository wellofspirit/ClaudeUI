/**
 * @vitest-environment node
 *
 * WHEN the usage poll starts, relative to the host applying the active
 * credential dir (S2e round 2).
 *
 * `usageFetcher.startPolling()` used to run inside `registerSessionIpc`, which
 * `startCoreServices` calls well BEFORE `afterSessionGraph` — the hook where the
 * desktop runs `accountManager.init()` and therefore `applyActive()` /
 * `setSecurestorageEnv({ dir })`. Two things went wrong with that order, and
 * neither is visible in a passing app:
 *
 *  1. the first `trackActiveAccount()` saw NO dir, took the single-account path
 *     and settled S2e's one-shot repair marker as done before it had ever run;
 *  2. the account-switch listener was already subscribed when the boot-time
 *     apply landed, so every launch fired a second, pointless `fetch()`.
 *
 * The graph around `startCoreServices` is mocked the way
 * `codex/__tests__/rules-sync-wiring.test.ts` mocks it: the subject is the
 * ORDER of two calls, not anything either of them does.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const usageMocks = vi.hoisted(() => ({
  usageFetcher: {
    setSessionGetter: vi.fn(),
    setIntervalSecs: vi.fn(),
    startPolling: vi.fn(),
    fetch: vi.fn(async () => null)
  }
}))
vi.mock('../../services/usage-fetcher', () => usageMocks)

vi.mock('../../services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), applyFilter: vi.fn() }
}))

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
  credentialSync: {
    start: vi.fn(async () => {}),
    configure: vi.fn(),
    getStatus: vi.fn(async () => ({ activeId: null, accounts: [] }))
  }
}))
vi.mock('../../shared-providers', () => ({
  sharedProviderService: { syncAll: vi.fn(async () => {}) }
}))
vi.mock('../host-anchor', () => ({
  createHostAnchor: vi.fn(() => ({ reconcileAndAutostart: vi.fn(async () => {}) }))
}))
vi.mock('../../codex/rules-sync', () => ({
  armCodexRulesSync: vi.fn(),
  syncCodexRulesFile: vi.fn(() => ({ wrote: false, path: '/fixture/claudeui.rules', skipped: [] }))
}))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('the usage poll and the active credential dir', () => {
  it('starts polling only after the host has applied the active account', async () => {
    const { startCoreServices } = await import('../core-services')
    const afterSessionGraph = vi.fn()

    startCoreServices({
      remoteAccessDisabled: true,
      authDeps: {} as never,
      autostart: false,
      afterSessionGraph
    })

    expect(afterSessionGraph).toHaveBeenCalledTimes(1)
    expect(usageMocks.usageFetcher.startPolling).toHaveBeenCalledTimes(1)
    // THE CONTRACT. `afterSessionGraph` is where the desktop applies
    // `CLAUDE_SECURESTORAGE_CONFIG_DIR`; nothing may resolve an account
    // identity — or subscribe to the switch that changes it — before it.
    expect(afterSessionGraph.mock.invocationCallOrder[0]).toBeLessThan(
      usageMocks.usageFetcher.startPolling.mock.invocationCallOrder[0]
    )
  })

  it('starts polling on a host that wires nothing after the session graph', async () => {
    // `claudeui-server` passes no hook, and it still has to poll.
    const { startCoreServices } = await import('../core-services')

    startCoreServices({ remoteAccessDisabled: true, authDeps: {} as never, autostart: false })

    expect(usageMocks.usageFetcher.startPolling).toHaveBeenCalledTimes(1)
  })
})
