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
import { opencodeCredentialStore } from '../../opencode/opencode-credentials'

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
  opencodeServerManager: {
    setServerStartedHook: vi.fn(),
    setCallerSessionLookup: vi.fn(),
    setDispatchAgent: vi.fn(),
    setHandBack: vi.fn(),
    setXAgentCaller: vi.fn()
  }
}))
vi.mock('../../services/cross-engine-dispatcher', () => ({
  crossEngineDispatcher: { dispatch: vi.fn(), configureParents: vi.fn(() => () => {}) }
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
      harnessArrived: vi.fn(async (id: string) => void order.push(`providers:${id}`)),
      configure: vi.fn()
    },
    watch: { ids: [] as string[], onArrival: null as ((id: string) => void) | null }
  }
})
const syncHostMocks = vi.hoisted(() => ({ emitEvent: vi.fn() }))
vi.mock('../../services/sync-host', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/sync-host')>()),
  emitEvent: syncHostMocks.emitEvent
}))
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
const claimMocks = vi.hoisted(() => ({ claimedOpencodeIds: vi.fn((): Set<string> => new Set()) }))
vi.mock('../../shared-providers/opencode-claims', () => claimMocks)
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

  it('hands the dispatcher its parent lookup and the re-key feed, so a run outlives its launching call (ADR-105)', async () => {
    const { startCoreServices } = await import('../core-services')
    const { crossEngineDispatcher } = await import('../../services/cross-engine-dispatcher')
    const unsubscribe = vi.fn()
    vi.mocked(crossEngineDispatcher.configureParents).mockReturnValueOnce(unsubscribe)
    const core = startCoreServices({
      remoteAccessDisabled: true,
      authDeps: {} as never,
      autostart: false
    })
    const [lookup, onRekey, onHostEvent] = vi.mocked(crossEngineDispatcher.configureParents).mock
      .calls[0]
    expect(lookup).toMatchObject({
      session: expect.any(Function),
      emit: expect.any(Function),
      readMessages: expect.any(Function)
    })
    expect(onRekey).toEqual(expect.any(Function))
    // ...and the host's event feed: a parent's disconnect re-raises its X-Agents' cards, its
    // deletion ends them.
    expect(onHostEvent).toEqual(expect.any(Function))
    // The host's teardown drops that subscription.
    expect(unsubscribe).not.toHaveBeenCalled()
    core.releaseDispatchParents()
    expect(unsubscribe).toHaveBeenCalledOnce()
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

  it('turns a vault API-key change into the payload-free provider:credentials-changed', async () => {
    const { startCoreServices } = await import('../core-services')
    startCoreServices({ remoteAccessDisabled: true, authDeps: {} as never, autostart: false })
    const hooks = arrivalMocks.sharedProviderService.configure.mock.calls.at(-1)?.[0] as
      { onApiKeyChanged?: () => void } | undefined
    expect(hooks?.onApiKeyChanged).toBeTypeOf('function')
    syncHostMocks.emitEvent.mockClear()
    hooks!.onApiKeyChanged!()
    expect(syncHostMocks.emitEvent).toHaveBeenCalledWith('provider:credentials-changed', [])
  })
})

describe('an opencode Remove, at the boot seam (AC-6)', () => {
  /**
   * `vendor-auth:remove` and the Remove modal reach `removeVendorAuth` with no other check, so
   * the store's in-lease guard is the ONLY refusal for a provider an enabled shared route
   * delivers. Its production predicate is wired here, in `startCoreServices`, and nowhere the
   * store's own tests (which inject a guard) can see.
   */
  async function wiredGuard(): Promise<(integrationID: string) => boolean | Promise<boolean>> {
    const configure = vi.spyOn(opencodeCredentialStore, 'configure').mockImplementation(() => {})
    try {
      const { startCoreServices } = await import('../core-services')
      startCoreServices({ remoteAccessDisabled: true, authDeps: {} as never, autostart: false })
      const guard = configure.mock.calls
        .map(([deps]) => deps.claimedBySharedRoute)
        .find((fn) => fn !== undefined)
      expect(guard, 'startCoreServices wires claimedBySharedRoute into the store').toBeDefined()
      return guard!
    } finally {
      configure.mockRestore()
    }
  }

  it('hands the credential store a guard that answers from the enabled shared routes', async () => {
    claimMocks.claimedOpencodeIds.mockReturnValue(new Set(['openai']))
    const guard = await wiredGuard()

    expect(await guard('openai')).toBe(true)
    expect(await guard('groq')).toBe(false)
  })

  it('reads the claims fresh on every ask, so a route enabled mid-session is caught', async () => {
    claimMocks.claimedOpencodeIds.mockReturnValue(new Set())
    const guard = await wiredGuard()
    expect(await guard('openai')).toBe(false)

    claimMocks.claimedOpencodeIds.mockReturnValue(new Set(['openai']))
    expect(await guard('openai')).toBe(true)
  })

  it('fails closed: a claim lookup that throws makes the guard throw, never answer false', async () => {
    claimMocks.claimedOpencodeIds.mockImplementation(() => {
      throw new Error('definitions unreadable')
    })
    const guard = await wiredGuard()

    await expect(Promise.resolve().then(() => guard('openai'))).rejects.toThrow(
      'definitions unreadable'
    )
  })
})
