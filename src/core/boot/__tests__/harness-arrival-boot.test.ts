/**
 * @vitest-environment node
 *
 * The boot seam for a harness that ARRIVES (ADR-082 §8, "As built (S7d)"): pi
 * or opencode going from not running to running gets the shared providers'
 * current state and then the ChatGPT credential, and CredentialSync is told
 * which harnesses run. The graph around `startCoreServices` is mocked the way
 * `usage-poll-boot-order.test.ts` mocks it; `watchHarnessArrivals` itself is
 * tested in `harness/__tests__/arrivals.test.ts`.
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
const arrivalMocks = vi.hoisted(() => {
  const order: string[] = []
  return {
    order,
    credentialSync: {
      start: vi.fn(async () => void order.push('reconcile')),
      configure: vi.fn(),
      getStatus: vi.fn(async () => ({ activeId: null, accounts: [] })),
      harnessArrived: vi.fn(async (id: string) => void order.push(`feed:${id}`))
    },
    sharedProviderService: {
      syncAll: vi.fn(async () => void order.push('sync')),
      adoptNativeKeys: vi.fn(async () => void order.push('adopt')),
      harnessArrived: vi.fn(async (id: string) => void order.push(`providers:${id}`))
    },
    watch: { ids: [] as string[], onArrival: null as ((id: string) => void) | null }
  }
})
vi.mock('../../auth/vault/CredentialSync', () => ({ credentialSync: arrivalMocks.credentialSync }))
vi.mock('../../shared-providers', () => ({
  sharedProviderService: arrivalMocks.sharedProviderService
}))
vi.mock('../../harness/arrivals', () => ({
  watchHarnessArrivals: vi.fn((ids: string[], onArrival: (id: string) => void) => {
    arrivalMocks.watch.ids = ids
    arrivalMocks.watch.onArrival = onArrival
    return () => {}
  })
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
  arrivalMocks.order.length = 0
})

describe('a harness arriving, at the boot seam', () => {
  it('watches pi and opencode and delivers providers, then the ChatGPT credential', async () => {
    const { startCoreServices } = await import('../core-services')
    startCoreServices({ remoteAccessDisabled: true, authDeps: {} as never, autostart: false })

    expect(arrivalMocks.watch.ids).toEqual(['pi', 'opencode'])
    await vi.waitFor(() => expect(arrivalMocks.order).toContain('adopt'))
    arrivalMocks.order.length = 0
    arrivalMocks.watch.onArrival?.('pi')
    await vi.waitFor(() => expect(arrivalMocks.order).toEqual(['providers:pi', 'feed:pi']))
    expect(arrivalMocks.sharedProviderService.harnessArrived).toHaveBeenCalledWith('pi')
    expect(arrivalMocks.credentialSync.harnessArrived).toHaveBeenCalledWith('pi')
  })

  it('a failed provider delivery still feeds the credential', async () => {
    const { startCoreServices } = await import('../core-services')
    startCoreServices({ remoteAccessDisabled: true, authDeps: {} as never, autostart: false })
    arrivalMocks.sharedProviderService.harnessArrived.mockRejectedValueOnce(new Error('locked'))

    arrivalMocks.watch.onArrival?.('opencode')
    await vi.waitFor(() =>
      expect(arrivalMocks.credentialSync.harnessArrived).toHaveBeenCalledWith('opencode')
    )
  })

  it('tells CredentialSync which harnesses run', async () => {
    const { startCoreServices } = await import('../core-services')
    startCoreServices({ remoteAccessDisabled: true, authDeps: {} as never, autostart: false })
    const wired = arrivalMocks.credentialSync.configure.mock.calls.find(
      ([options]) => typeof (options as { harnessRuns?: unknown }).harnessRuns === 'function'
    )
    expect(wired).toBeDefined()
  })
})
