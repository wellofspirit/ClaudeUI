/**
 * @vitest-environment node
 *
 * Push-to-talk lifecycle on the ClaudeSession side — the part that runs BEFORE
 * a `VoiceClient` owns the capture.
 *
 * `voiceStartRecording` opens the microphone at once and then awaits the voice
 * server, which on a first press means spawning cli.js (seconds; up to the 15 s
 * `ensureActiveQuery` deadline). A release lands in that window more often than
 * not, so these pin:
 *  - a stop during the pending start ENDS it — the start never reaches a
 *    `VoiceClient`, and the renderer is left idle;
 *  - a stop→start pair does not let the first start's cancellation clobber the
 *    second;
 *  - a cancelled start whose spawn then fails does not throw at the renderer;
 *  - a stop with nothing to stop still reports idle (the renderer was told
 *    `connecting` by this session, not by the client);
 *  - the client reads the session's LIVE routing id (a rekey mid-capture).
 *
 * Mock scaffold mirrors claude-session-compact-boundary.test.ts; `VoiceClient`
 * is a recorder, its own protocol is voice-client.test.ts's.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { subscribeWindowToSync } from '../../../test/helpers/sync-subscriber-window'
import { clearSyncSubscribersForTests } from '../../../core/services/sync-host'
import { setHostWindow } from '../../../core/services/host-window'

const { mockQuery, capture, voiceClients } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  capture: { start: vi.fn(() => true), stop: vi.fn() },
  voiceClients: [] as Array<{
    getRoutingId: () => string
    startRecording: ReturnType<typeof vi.fn>
    stopRecording: ReturnType<typeof vi.fn>
  }>
}))

vi.mock('electron', async () => await import('../../../test/stubs/electron-shim'))

vi.mock('../../../core/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/sdk')>()
  return {
    ...actual,
    query: mockQuery,
    locateBunClaude: (): string => __filename,
    getCliVersion: (): string => '0.0.0-test'
  }
})

vi.mock('../../../core/opencode/OpencodeServerManager', () => ({
  opencodeServerManager: { isBinaryAvailable: (): boolean => false }
}))
vi.mock('../../../core/services/cross-engine-dispatcher', () => ({
  crossEngineDispatcher: { dispatch: vi.fn(), resolveApproval: vi.fn(), disposeFor: vi.fn() },
  crossEngineDispatchAvailable: (): boolean => false
}))
vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
vi.mock('../../../core/services/ui-config', () => ({
  saveSlashCommands: vi.fn(),
  loadEngineConfig: vi.fn(() => ({}))
}))
vi.mock('../../../core/services/claude-mcp', () => ({
  loadMcpServers: vi.fn(() => ({})),
  readDisabledMcpServers: vi.fn(() => [])
}))
vi.mock('../../../core/services/session-history', () => ({
  computeTokenMetrics: vi.fn(async () => ({ totalTokens: 0, totalCostUsd: 0 })),
  fallbackBlockText: vi.fn(() => '')
}))
vi.mock('../../../core/services/skill-scanner', () => ({ scanSkills: vi.fn(async () => []) }))
vi.mock('../../../core/services/subagent-watcher', () => ({ unwatchAllSubagents: vi.fn() }))
vi.mock('../../../core/services/voice-capture', () => ({
  startRecording: () => capture.start(),
  stopRecording: () => capture.stop()
}))
vi.mock('../../../core/services/voice-client', () => ({
  // A client that never leaves idle — enough to see whether a start reached it.
  VoiceClient: class {
    startRecording = vi.fn(async () => {})
    stopRecording = vi.fn(async () => {})
    updatePort = vi.fn()
    destroy = vi.fn()
    currentState = (): string => 'idle'
    constructor(
      _port: number,
      _win: unknown,
      readonly getRoutingId: () => string
    ) {
      voiceClients.push(this)
    }
  }
}))
vi.mock('../../../core/services/context-window', () => ({
  getContextWindowSize: vi.fn(() => 200000)
}))
vi.mock('../../../core/services/usage-fetcher', () => ({
  usageFetcher: { updateFromRateLimitEvent: vi.fn(), fetch: vi.fn(async () => null) }
}))
vi.mock('../../../core/services/usage-provider', () => ({ resolveUsageProvider: vi.fn() }))
vi.mock('../account-manager', () => ({
  accountManager: { getState: vi.fn(() => ({ enabled: false, activeId: null })) }
}))
vi.mock('../../auth/ClaudeAuthProvider', () => ({
  claudeAuthProvider: { buildAccountRef: vi.fn(() => null), updateAuthSource: vi.fn() }
}))

// Import AFTER mocks.
import { ClaudeSession } from '../../../core/services/claude-session'
import type { BrowserWindow } from 'electron'

const PORT = 4321

function makeWin(): { win: BrowserWindow; sent: Array<[string, string, unknown]> } {
  const sent: Array<[string, string, unknown]> = []
  const win = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, routingId: string, data: unknown): void => {
        sent.push([channel, routingId, data])
      }
    }
  } as unknown as BrowserWindow
  subscribeWindowToSync(
    win as unknown as { webContents: { send: (c: string, ...a: unknown[]) => void } }
  )
  // `voice:state` is HOST-LOCAL: it reaches the host window, never a subscriber.
  setHostWindow(win as never)
  return { win, sent }
}

function voiceStates(sent: Array<[string, string, unknown]>): Array<[string, unknown]> {
  return sent.filter(([c]) => c === 'voice:state').map(([, id, state]) => [id, state])
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void
  let reject!: (e: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * Replace the spawn + voice-server start with a gate per call. Resolving a gate
 * publishes the port exactly as the real `voiceStartServer` does.
 */
function gateVoiceServer(session: ClaudeSession, gates: Array<Promise<void>>): void {
  let call = 0
  vi.spyOn(session, 'voiceStartServer').mockImplementation(async () => {
    await gates[call++]
    ;(session as unknown as { voiceServerPort: number }).voiceServerPort = PORT
    return { port: PORT }
  })
}

const liveSessions: ClaudeSession[] = []

function makeSession(routingId: string): {
  session: ClaudeSession
  sent: Array<[string, string, unknown]>
} {
  const { win, sent } = makeWin()
  const session = new ClaudeSession(routingId, win, '/tmp/proj')
  liveSessions.push(session)
  return { session, sent }
}

beforeEach(() => {
  vi.clearAllMocks()
  voiceClients.length = 0
})

afterEach(() => {
  for (const s of liveSessions.splice(0)) s.cancel()
  clearSyncSubscribersForTests()
  setHostWindow(null)
})

describe('ClaudeSession voice — a stop during a pending start ends the capture', () => {
  it('never hands the capture to a VoiceClient, and leaves the renderer idle', async () => {
    const { session, sent } = makeSession('r-voice-cancel')
    const gate = deferred()
    gateVoiceServer(session, [gate.promise])

    const startP = session.voiceStartRecording('en')
    await session.voiceStopRecording()
    gate.resolve()
    await startP

    expect(voiceClients).toHaveLength(0)
    // The microphone was opened once (early capture) and closed by the stop —
    // never reopened afterwards.
    expect(capture.start).toHaveBeenCalledTimes(1)
    expect(capture.stop).toHaveBeenCalled()
    expect(voiceStates(sent).at(-1)).toEqual(['r-voice-cancel', 'idle'])
  })

  it("a stop→start pair: the first start's cancellation does not clobber the second", async () => {
    const { session } = makeSession('r-voice-restart')
    const first = deferred()
    const second = deferred()
    gateVoiceServer(session, [first.promise, second.promise])

    const start1 = session.voiceStartRecording('en')
    await session.voiceStopRecording()
    const start2 = session.voiceStartRecording('en')

    first.resolve()
    await start1
    expect(voiceClients).toHaveLength(0)

    second.resolve()
    await start2
    expect(voiceClients).toHaveLength(1)
    expect(voiceClients[0].startRecording).toHaveBeenCalledTimes(1)
  })

  it('a cancelled start whose spawn then fails (the 15 s deadline) ends quietly', async () => {
    const { session, sent } = makeSession('r-voice-timeout')
    const gate = deferred()
    gateVoiceServer(session, [gate.promise])

    const startP = session.voiceStartRecording('en')
    await session.voiceStopRecording()
    const statesAtStop = voiceStates(sent).length
    gate.reject(new Error('Timed out waiting for SDK session to start'))

    await expect(startP).resolves.toBeUndefined()
    expect(voiceClients).toHaveLength(0)
    expect(voiceStates(sent)).toHaveLength(statesAtStop)
    expect(voiceStates(sent).at(-1)).toEqual(['r-voice-timeout', 'idle'])
  })
})

describe('ClaudeSession voice — cancel() during a pending start', () => {
  it('cancels the start and closes the microphone it opened', async () => {
    const { session } = makeSession('r-voice-dispose')
    const gate = deferred()
    gateVoiceServer(session, [gate.promise])

    const startP = session.voiceStartRecording('en')
    session.cancel()
    expect(capture.stop).toHaveBeenCalled()
    gate.resolve()
    await startP

    expect(voiceClients).toHaveLength(0)
  })
})

describe('ClaudeSession voice — stop always reports the real state', () => {
  it('an idle client after `connecting` was announced: the stop emits idle', async () => {
    const { session, sent } = makeSession('r-voice-heal')
    gateVoiceServer(session, [Promise.resolve()])

    // The session told the renderer `connecting`; the client never left idle.
    await session.voiceStartRecording('en')
    expect(voiceClients).toHaveLength(1)
    expect(voiceStates(sent).at(-1)).toEqual(['r-voice-heal', 'connecting'])

    await session.voiceStopRecording()
    expect(voiceStates(sent).at(-1)).toEqual(['r-voice-heal', 'idle'])
  })
})

describe('ClaudeSession voice — the client follows a rekey', () => {
  it("hands the VoiceClient a getter that reads the session's live routing id", async () => {
    const { session } = makeSession('r-voice-temp')
    gateVoiceServer(session, [Promise.resolve()])
    await session.voiceStartRecording('en')

    // What `SessionManager.rekey` does once cli.js mints the session id.
    ;(session as { routingId: string }).routingId = 'r-voice-minted'
    expect(voiceClients[0].getRoutingId()).toBe('r-voice-minted')
  })
})
