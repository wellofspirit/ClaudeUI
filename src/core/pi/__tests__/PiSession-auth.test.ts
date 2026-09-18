/**
 * @vitest-environment node
 *
 * PiSession — a rejected credential raises the sign-in (ADR-068 §4).
 *
 * The twin of `src/core/opencode/__tests__/OpencodeSession-auth.test.ts`, with
 * the same posture: the vendor→provider mapping is REAL, only its DISK READ is
 * replaced, so no test reads `~/.claude/ui/providers`.
 *
 * Kept out of the 5k-line `PiSession.test.ts` because the module double for
 * `chatgpt-route` is file-scoped and has no business applying to every other
 * PiSession test in that file.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { subscribeWindowToSync } from '../../../test/helpers/sync-subscriber-window'
import { clearSyncSubscribersForTests } from '../../services/sync-host'
import type { PiEvent, PiAssistantMessage } from '../pi-protocol'

/** A stub window that is also a sync CLIENT — see the helper's doc comment. */
class MockWindow extends EventEmitter {
  webContents = { send: vi.fn() }
  constructor() {
    super()
    subscribeWindowToSync(this)
  }
  isDestroyed(): boolean {
    return false
  }
}

afterEach(() => {
  clearSyncSubscribersForTests()
})

interface MockClient {
  start: ReturnType<typeof vi.fn>
  request: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  onEvent: ReturnType<typeof vi.fn>
  onExit: ReturnType<typeof vi.fn>
  onEventCb: ((ev: PiEvent) => void) | null
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
    sessionId: 'pi-sess-auth',
    sessionFile: '/tmp/s.jsonl'
  }
}

const { clients, MockPiRpcClient, MockPiBridgeHost } = vi.hoisted(() => {
  const clients: MockClient[] = []
  const MockPiRpcClient = vi.fn().mockImplementation(function () {
    const inst: MockClient = {
      onEventCb: null,
      start: vi.fn().mockResolvedValue(undefined),
      request: vi.fn((cmd: { type: string }) => {
        if (cmd.type === 'get_state') return Promise.resolve(GET_STATE_RESPONSE)
        return Promise.resolve({ type: 'response', command: cmd.type, success: true })
      }),
      send: vi.fn(),
      onEvent: vi.fn((cb: (ev: PiEvent) => void) => {
        inst.onEventCb = cb
        return () => {}
      }),
      onExit: vi.fn(() => () => {}),
      dispose: vi.fn()
    }
    clients.push(inst)
    return inst
  })
  const MockPiBridgeHost = vi.fn().mockImplementation(function () {
    return {
      start: vi.fn().mockResolvedValue({ url: 'http://127.0.0.1:9999', token: 'tok' }),
      dispose: vi.fn()
    }
  })
  return { clients, MockPiRpcClient, MockPiBridgeHost }
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
vi.mock('../../services/mermaid-tool', () => ({
  createMermaidServer: vi.fn(() => ({ tools: [] }))
}))
vi.mock('../../services/mockup-tool', () => ({ createMockupServer: vi.fn(() => ({ tools: [] })) }))
vi.mock('../../services/cross-engine-dispatcher', () => ({
  crossEngineDispatcher: { dispatch: vi.fn(), disposeFor: vi.fn(), stopDispatch: vi.fn() },
  crossEngineDispatchAvailable: vi.fn().mockReturnValue(false)
}))
vi.mock('../PiBridgeHost', () => ({
  PiBridgeHost: MockPiBridgeHost,
  writeBridgeExtension: vi.fn().mockReturnValue('/fake/tmp/bridge.ts'),
  writeSubagentExtension: vi.fn().mockReturnValue('/fake/tmp/subagent.ts')
}))
vi.mock('../../auth/PiAuthProvider', () => ({
  piAuthProvider: {
    probe: vi.fn().mockResolvedValue({}),
    buildPiAccountRef: vi.fn().mockReturnValue(null)
  }
}))
vi.mock('node:fs', () => ({ existsSync: vi.fn().mockReturnValue(false) }))
vi.mock('node:os', () => ({
  homedir: vi.fn().mockReturnValue('/fake/home'),
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
vi.mock('../../services/ui-config', () => ({
  loadEngineConfig: vi.fn().mockReturnValue({ autoMode: { enabled: false } }),
  loadSharedAutoModeConfig: () => ({})
}))

/**
 * The vendor→provider mapping is REAL; only its disk read is replaced. The
 * fixture is the shipped ChatGPT definition with both routes on, so a pi
 * `openai-codex` rejection maps to the vault provider and anything else falls
 * back to the `pi:` namespace.
 */
vi.mock('../../shared-providers/chatgpt-route', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared-providers/chatgpt-route')>()
  return {
    ...actual,
    piAuthRequiredProviderId: (vendorId: string): string =>
      actual.authRequiredProviderId(
        vendorId,
        {
          id: 'chatgpt',
          name: 'ChatGPT',
          kind: 'subscription',
          models: [],
          managed: true,
          routes: {
            pi: { enabled: true, providerId: 'openai-codex' },
            opencode: { enabled: true, providerId: 'openai' }
          }
        },
        'pi'
      )
  }
})

import { PiSession } from '../PiSession'
import type { HostWindowHandle } from '../../host'

function erroredMessage(overrides: Partial<PiAssistantMessage>): PiAssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'openai-responses',
    provider: 'openai-codex',
    model: 'gpt-5-codex',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: 'error',
    timestamp: 1,
    ...overrides
  }
}

/** Drive one failed turn through the REAL mapper and return what the client saw. */
async function runFailedTurn(
  routingId: string,
  message: PiAssistantMessage
): Promise<{ win: MockWindow; session: PiSession; calls: unknown[][] }> {
  const win = new MockWindow()
  const session = new PiSession(routingId, win as unknown as HostWindowHandle, '/cwd')
  await session.run('hello')
  const handler = clients[clients.length - 1].onEventCb!
  handler({ type: 'message_start', message: erroredMessage({ stopReason: 'stop' }) })
  handler({ type: 'message_end', message })
  return { win, session, calls: win.webContents.send.mock.calls }
}

beforeEach(() => {
  clients.length = 0
  MockPiRpcClient.mockClear()
  MockPiBridgeHost.mockClear()
})

describe('PiSession — a 401/403 turn raises session:auth-required', () => {
  it('emits the MAPPED provider id and keeps pi’s own words as an error row', async () => {
    const { session, calls } = await runFailedTurn(
      'rid-auth-1',
      erroredMessage({
        errorMessage:
          'OpenAI API error (401): {"message":"Missing bearer or basic authentication in header","type":"invalid_request_error","code":"unauthorized"}'
      })
    )

    const authCall = calls.find((c) => c[0] === 'session:auth-required')
    expect(authCall).toBeDefined()
    // pi's vendor id is `openai-codex`; the PROVIDER is what the dialog acts on.
    expect(authCall![2]).toEqual({ providerId: 'chatgpt' })

    // The event carries no text, so the vendor's verbatim message must survive
    // as an ordinary error row — otherwise the words are simply lost.
    const errorCall = calls.find((c) => c[0] === 'session:error')
    expect(errorCall).toBeDefined()
    expect(String(errorCall![2])).toContain('Missing bearer or basic authentication in header')

    session.cancel()
  })

  it('namespaces a vendor the shared route does not own under `pi:`', async () => {
    const { session, calls } = await runFailedTurn(
      'rid-auth-2',
      erroredMessage({
        api: 'anthropic-messages',
        provider: 'anthropic',
        errorMessage:
          '401 {"type":"error","error":{"type":"authentication_error","message":"API key is invalid."},"request_id":null}'
      })
    )

    expect(calls.find((c) => c[0] === 'session:auth-required')![2]).toEqual({
      providerId: 'pi:anthropic'
    })

    session.cancel()
  })

  it('a 429 emits session:error only — no sign-in is owed', async () => {
    const { session, calls } = await runFailedTurn(
      'rid-auth-3',
      erroredMessage({
        errorMessage: 'OpenAI API error (429): {"message":"Rate limit reached"}'
      })
    )

    expect(calls.find((c) => c[0] === 'session:auth-required')).toBeUndefined()
    const errorCall = calls.find((c) => c[0] === 'session:error')
    expect(String(errorCall![2])).toContain('Rate limit reached')

    session.cancel()
  })
})
