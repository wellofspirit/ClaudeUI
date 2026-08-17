/**
 * @vitest-environment node
 *
 * Lifecycle-race guards for PiSession:
 *
 *  H19 — a cancel()→run() respawn installs a NEW client + bridge host. The OLD
 *  client's OS exit event can still be in flight; its onExit handler is guarded
 *  only by `_cancelled` (reset to false by the new run()), so before the fix it
 *  disposed the NEW bridge host, nulled the live client, and nulled
 *  startedPromise. The client-identity guard makes the stale exit a no-op.
 *
 *  M-PI1 — `wasBusy` was snapshotted BEFORE `await ensureStarted()`, so two
 *  run()s during the spawn window both read false; the second then sent a bare
 *  `prompt` (no streamingBehavior) which pi rejects while streaming. Reading it
 *  AFTER ensureStarted makes the second observe busy and steer.
 *
 * Uses a PER-INSTANCE PiRpcClient / PiBridgeHost mock (unlike PiSession.test.ts's
 * shared-object mock) so client identity is distinguishable across respawns.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { PiEvent } from '../pi-protocol'

class MockWindow extends EventEmitter {
  webContents = { send: vi.fn() }
  isDestroyed(): boolean {
    return false
  }
}

interface MockClient {
  start: ReturnType<typeof vi.fn>
  request: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  onEvent: ReturnType<typeof vi.fn>
  onExit: ReturnType<typeof vi.fn>
  onEventCb: ((ev: PiEvent) => void) | null
  onExitCb: (() => void) | null
  disposed: boolean
}

interface MockBridge {
  start: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  disposed: boolean
}

const GET_STATE_RESPONSE = {
  type: 'response',
  command: 'get_state',
  success: true,
  data: {
    model: {
      id: 'unknown',
      name: 'unknown',
      api: 'unknown',
      provider: 'unknown',
      baseUrl: '',
      reasoning: false,
      input: [],
      contextWindow: 0,
      maxTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    },
    thinkingLevel: 'medium',
    isStreaming: false,
    sessionId: 'pi-sess-1',
    sessionFile: '/tmp/s.jsonl'
  }
}

function defaultRequestImpl(cmd: { type: string }): Promise<unknown> {
  switch (cmd.type) {
    case 'get_state':
      return Promise.resolve(GET_STATE_RESPONSE)
    case 'get_session_stats':
      return Promise.resolve({
        type: 'response',
        command: 'get_session_stats',
        success: true,
        data: { cost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
      })
    default:
      return Promise.resolve({ type: 'response', command: cmd.type, success: true })
  }
}

const {
  clients,
  bridgeHosts,
  requestImplHolder,
  MockPiRpcClient,
  MockPiBridgeHost,
  mockDisposeFor,
  mockStopDispatch
} = vi.hoisted(() => {
  const clients: MockClient[] = []
  const bridgeHosts: MockBridge[] = []
  const requestImplHolder: { fn: (cmd: { type: string }) => Promise<unknown> } = {
    fn: (cmd) => {
      switch (cmd.type) {
        case 'get_state':
          return Promise.resolve({
            type: 'response',
            command: 'get_state',
            success: true,
            data: {
              model: {
                id: 'unknown',
                name: 'unknown',
                api: 'unknown',
                provider: 'unknown',
                baseUrl: '',
                reasoning: false,
                input: [],
                contextWindow: 0,
                maxTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
              },
              thinkingLevel: 'medium',
              isStreaming: false,
              sessionId: 'pi-sess-1',
              sessionFile: '/tmp/s.jsonl'
            }
          })
        default:
          return Promise.resolve({ type: 'response', command: cmd.type, success: true })
      }
    }
  }

  const MockPiRpcClient = vi.fn().mockImplementation(function () {
    const inst: MockClient = {
      onEventCb: null,
      onExitCb: null,
      disposed: false,
      start: vi.fn().mockResolvedValue(undefined),
      request: vi.fn((cmd: { type: string }) => requestImplHolder.fn(cmd)),
      send: vi.fn(),
      onEvent: vi.fn((cb: (ev: PiEvent) => void) => {
        inst.onEventCb = cb
        return () => {}
      }),
      onExit: vi.fn((cb: () => void) => {
        inst.onExitCb = cb
        return () => {}
      }),
      dispose: vi.fn(() => {
        inst.disposed = true
      })
    }
    clients.push(inst)
    return inst
  })

  const MockPiBridgeHost = vi.fn().mockImplementation(function () {
    const inst: MockBridge = {
      disposed: false,
      start: vi.fn().mockResolvedValue({ url: 'http://127.0.0.1:9999', token: 'tok' }),
      dispose: vi.fn(() => {
        inst.disposed = true
      })
    }
    bridgeHosts.push(inst)
    return inst
  })

  return {
    clients,
    bridgeHosts,
    requestImplHolder,
    MockPiRpcClient,
    MockPiBridgeHost,
    mockDisposeFor: vi.fn(),
    mockStopDispatch: vi.fn()
  }
})

vi.mock('../PiRpcClient', () => ({ PiRpcClient: MockPiRpcClient }))
vi.mock('../pi-locate', () => ({ locatePiBinary: () => '/fake/pi', piBinaryAvailable: () => true }))
vi.mock('../model-discovery', async () => {
  const actual = await vi.importActual<typeof import('../model-discovery')>('../model-discovery')
  return { ...actual, getPiModelCatalog: vi.fn().mockResolvedValue([]) }
})
vi.mock('../../services/pi-session-list', () => ({
  loadPiSessionHistory: vi.fn().mockResolvedValue([]),
  findPiSessionFile: vi.fn().mockReturnValue(null)
}))
vi.mock('../../services/usage-recorder', () => ({ recordUsageEvent: vi.fn() }))
vi.mock('../../services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
vi.mock('../../services/mermaid-tool', () => ({ createMermaidServer: vi.fn(() => ({ tools: [] })) }))
vi.mock('../../services/mockup-tool', () => ({ createMockupServer: vi.fn(() => ({ tools: [] })) }))
vi.mock('../../services/cross-engine-dispatcher', () => ({
  crossEngineDispatcher: { dispatch: vi.fn(), disposeFor: mockDisposeFor, stopDispatch: mockStopDispatch },
  crossEngineDispatchAvailable: vi.fn().mockReturnValue(false)
}))
vi.mock('../PiBridgeHost', () => ({
  PiBridgeHost: MockPiBridgeHost,
  writeBridgeExtension: vi.fn().mockReturnValue('/fake/tmp/bridge.ts'),
  writeSubagentExtension: vi.fn().mockReturnValue('/fake/tmp/subagent.ts')
}))
vi.mock('../../auth/PiAuthProvider', () => ({
  piAuthProvider: { probe: vi.fn().mockResolvedValue({}), buildPiAccountRef: vi.fn().mockReturnValue(null) }
}))
vi.mock('node:fs', () => ({ existsSync: vi.fn().mockReturnValue(false) }))
vi.mock('node:os', () => ({
  homedir: vi.fn().mockReturnValue('/fake/home'),
  // ground-truth.ts's redirect scope calls tmpdir(); omitting it here makes the
  // call throw through vitest's missing-export proxy.
  tmpdir: vi.fn().mockReturnValue('/tmp')
}))
vi.mock('../../services/claude-settings', () => ({
  loadClaudePermissions: vi.fn().mockReturnValue({
    allow: [],
    deny: [],
    ask: [],
    additionalDirectories: [],
    defaultMode: undefined
  }),
  saveClaudePermissions: vi.fn()
}))

import { PiSession } from '../PiSession'
import type { HostWindowHandle } from '../../host'

function makeSession(): PiSession {
  const win = new MockWindow() as unknown as HostWindowHandle
  return new PiSession('routing-pi-lifecycle', win, '/tmp/cwd')
}

/** Let pending microtasks flush (spawn/prompt awaits settle). */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

beforeEach(() => {
  clients.length = 0
  bridgeHosts.length = 0
  requestImplHolder.fn = defaultRequestImpl
  MockPiRpcClient.mockClear()
  MockPiBridgeHost.mockClear()
  mockDisposeFor.mockClear()
  mockStopDispatch.mockClear()
})

describe('PiSession — H19: stale onExit from a superseded client is a no-op', () => {
  it('the old client exit does not dispose the respawned bridge host or null the live client', async () => {
    const session = makeSession()

    // First spawn (client A + bridge A).
    await session.run('first')
    expect(clients).toHaveLength(1)
    expect(bridgeHosts).toHaveLength(1)
    const clientA = clients[0]
    const staleOnExit = clientA.onExitCb!
    expect(staleOnExit).toBeTypeOf('function')

    // cancel() disposes A + bridge A and clears the memo.
    session.cancel()
    expect(clientA.disposed).toBe(true)
    expect(bridgeHosts[0].disposed).toBe(true)

    // Respawn (client B + bridge B) — run() reset _cancelled to false.
    await session.run('second')
    expect(clients).toHaveLength(2)
    expect(bridgeHosts).toHaveLength(2)
    const clientB = clients[1]
    const bridgeB = bridgeHosts[1]

    // Now client A's OS exit finally lands — its handler must recognise it no
    // longer owns the session and bail (the `_cancelled` guard doesn't catch
    // it: run() reset the flag to false).
    staleOnExit()

    // Bridge B must NOT have been torn down (otherwise every later tool_call in
    // B fails "approval service unreachable").
    expect(bridgeB.disposed).toBe(false)
    expect(bridgeB.dispose).not.toHaveBeenCalled()

    // The live client B must still be attached: interrupt() routes an `abort`
    // to it (a nulled this.client would make interrupt a silent no-op).
    clientB.request.mockClear()
    await session.interrupt()
    expect(clientB.request).toHaveBeenCalledWith({ type: 'abort' })
  })
})

describe('PiSession — M-PI1: second run() during spawn steers, not a bare prompt', () => {
  it('two run()s during the spawn window: the second sends streamingBehavior=steer', async () => {
    const session = makeSession()

    // Defer the spawn: get_state hangs until we release it, holding both run()s
    // inside `await ensureStarted()`.
    let releaseGetState!: () => void
    const gate = new Promise<void>((r) => {
      releaseGetState = r
    })
    requestImplHolder.fn = (cmd) => {
      if (cmd.type === 'get_state') {
        return gate.then(() => GET_STATE_RESPONSE)
      }
      return defaultRequestImpl(cmd)
    }

    const p1 = session.run('a')
    const p2 = session.run('b')
    await flush() // both are now parked on the shared startedPromise

    releaseGetState()
    await Promise.all([p1, p2])

    // Exactly one client spawned (memoized doStart).
    expect(clients).toHaveLength(1)
    const prompts = clients[0].request.mock.calls
      .map((c) => c[0] as { type: string; message?: string; streamingBehavior?: string })
      .filter((c) => c.type === 'prompt')

    expect(prompts).toHaveLength(2)
    // First prompt is the turn opener — no streamingBehavior.
    const first = prompts.find((p) => p.message === 'a')!
    const second = prompts.find((p) => p.message === 'b')!
    expect(first.streamingBehavior).toBeUndefined()
    // Second observed busy AFTER ensureStarted → steers.
    expect(second.streamingBehavior).toBe('steer')
  })
})
