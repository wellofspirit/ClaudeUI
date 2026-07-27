/**
 * @vitest-environment node
 *
 * Lifecycle-race guards for the REAL ClaudeSession:
 *
 *  H17 — a session:send landing in the teardown window (cancel() ended the
 *  messageChannel but run()'s finally hasn't nulled it yet) must NOT push into
 *  the dead channel where it vanishes AFTER sendPrompt broadcast
 *  session:user-message. It must (re-)establish a fresh cli.js run instead.
 *
 *  H17-fence / M-CL3 — a run() finally that is superseded (a fresh run took
 *  over the shared channel), or belongs to a DISPOSED object (replaced under
 *  its routingId), must NOT clobber the live run's state / re-arm the idle
 *  timer / disposeFor() the routingId the live session now owns.
 *
 * Mock scaffold mirrors claude-session-model-cost.component.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('electron', async () => await import('../../../test/stubs/electron-shim'))

vi.mock('../../sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../sdk')>()
  return {
    ...actual,
    query: mockQuery,
    locateBunClaude: (): string => __filename,
    getCliVersion: (): string => '0.0.0-test'
  }
})

vi.mock('../../opencode/OpencodeServerManager', () => ({
  opencodeServerManager: { isBinaryAvailable: (): boolean => false }
}))
const { mockDisposeFor } = vi.hoisted(() => ({ mockDisposeFor: vi.fn() }))
vi.mock('../cross-engine-dispatcher', () => ({
  crossEngineDispatcher: { dispatch: vi.fn(), resolveApproval: vi.fn(), disposeFor: mockDisposeFor },
  crossEngineDispatchAvailable: (): boolean => false
}))
vi.mock('../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
vi.mock('../ui-config', () => ({ saveSlashCommands: vi.fn(), loadEngineConfig: vi.fn(() => ({})) }))
vi.mock('../claude-mcp', () => ({
  loadMcpServers: vi.fn(() => ({})),
  readDisabledMcpServers: vi.fn(() => [])
}))
vi.mock('../session-history', () => ({
  computeTokenMetrics: vi.fn(async () => ({ totalTokens: 0, totalCostUsd: 0 })),
  fallbackBlockText: vi.fn(() => '')
}))
vi.mock('../skill-scanner', () => ({ scanSkills: vi.fn(async () => []) }))
vi.mock('../subagent-watcher', () => ({ unwatchAllSubagents: vi.fn() }))
vi.mock('../voice-capture', () => ({ startRecording: vi.fn(), stopRecording: vi.fn() }))
vi.mock('../voice-client', () => ({ VoiceClient: class {} }))
vi.mock('../context-window', () => ({ getContextWindowSize: vi.fn(() => 200000) }))
vi.mock('../usage-fetcher', () => ({
  usageFetcher: { updateFromRateLimitEvent: vi.fn(), fetch: vi.fn(async () => null) }
}))
vi.mock('../usage-provider', () => ({ resolveUsageProvider: vi.fn() }))
vi.mock('../account-manager', () => ({
  accountManager: { getState: vi.fn(() => ({ enabled: false, activeId: null })) }
}))
vi.mock('../../auth/ClaudeAuthProvider', () => ({
  claudeAuthProvider: { buildAccountRef: vi.fn(() => null), updateAuthSource: vi.fn() }
}))
vi.mock('../auto-classifier', () => ({
  getClassifier: vi.fn(),
  stopClassifier: vi.fn(),
  isSafeTool: vi.fn(() => false),
  buildTranscript: vi.fn(() => '')
}))

import { ClaudeSession } from '../claude-session'
import type { BrowserWindow } from 'electron'

/** A query handle whose for-await PARKS until end() is called — lets a test
 *  hold run() suspended in its for-await loop (mid-session, cli.js "alive") and
 *  then release it to drive run()'s finally on demand. */
function makeParkedHandle(): {
  handle: AsyncIterable<unknown> & Record<string, unknown>
  end: () => void
} {
  let endResolve!: () => void
  const endPromise = new Promise<void>((r) => {
    endResolve = r
  })
  const handle = {
    // eslint-disable-next-line require-yield
    async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
      await endPromise
    },
    initializationResult: (): Promise<never> => new Promise<never>(() => {}),
    interrupt: vi.fn(async () => {})
  }
  return { handle, end: () => endResolve() }
}

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
  return { win, sent }
}

const createdHandles: Array<{ handle: unknown; end: () => void }> = []
const liveSessions: ClaudeSession[] = []

beforeEach(() => {
  vi.clearAllMocks()
  createdHandles.length = 0
  mockQuery.mockImplementation(() => {
    const h = makeParkedHandle()
    createdHandles.push(h)
    return h.handle
  })
})

afterEach(() => {
  for (const h of createdHandles) h.end()
  for (const s of liveSessions.splice(0)) s.cancel()
})

describe('ClaudeSession — H17: send racing teardown re-establishes instead of dropping', () => {
  it('a send after cancel() ended the channel (before finally nulled it) spawns a fresh run', async () => {
    const { win } = makeWin()
    const session = new ClaudeSession('routing-h17', win, '/tmp/proj')
    liveSessions.push(session)

    // First run: parks in the for-await (cli.js "alive").
    const p1 = session.run('first')
    expect(mockQuery).toHaveBeenCalledTimes(1)

    // Idle-timeout auto-cancel (or user Stop) ends the channel + aborts, but
    // the parked run()'s finally has NOT executed — the channel is ended yet
    // still non-null: exactly the H17 window.
    session.cancel()

    // A send landing in that window must (re-)establish a fresh run rather than
    // push into the dead channel (where the message would silently vanish).
    const p2 = session.run('second')
    expect(mockQuery).toHaveBeenCalledTimes(2)

    void p1
    void p2
  })
})

describe('ClaudeSession — H17 fence: a superseded run() finally leaves the live run alone', () => {
  it('the old run finishing does not reset isProcessing / clobber the new run', async () => {
    const { win } = makeWin()
    const session = new ClaudeSession('routing-h17-fence', win, '/tmp/proj')
    liveSessions.push(session)

    const p1 = session.run('first')
    session.cancel()
    const p2 = session.run('second') // fresh run took over the shared channel
    expect(mockQuery).toHaveBeenCalledTimes(2)
    expect(session.willQueue).toBe(true) // new run is processing

    // Release the OLD (superseded) run — its finally must NOT null the shared
    // channel or flip isProcessing back to false out from under the new run.
    createdHandles[0].end()
    await p1

    expect(session.willQueue).toBe(true) // still processing the live run

    void p2
  })
})

describe("ClaudeSession — cancel()'s disconnected survives the dying run's finally", () => {
  it("the terminal session:status after a run cancel() ended is 'disconnected', not 'idle'", async () => {
    const { win, sent } = makeWin()
    const session = new ClaudeSession('routing-cancel-status', win, '/tmp/proj')
    liveSessions.push(session)

    const p1 = session.run('hello') // parks in the for-await
    session.cancel() // broadcasts disconnected, aborts, marks cancelled

    // Release the run so its finally executes. Pre-fix it re-emitted the
    // computed 'idle' status over the 'disconnected' cancel() just broadcast.
    createdHandles[0].end()
    await p1

    const statuses = sent
      .filter(([ch]) => ch === 'session:status')
      .map(([, , d]) => (d as { state?: string }).state)
    expect(statuses.at(-1)).toBe('disconnected')

    void p1
  })
})

describe('ClaudeSession — setModel reverts on control-request failure', () => {
  it('a rejected activeQuery.setModel restores the previous model (GUARD — fails pre-fix)', async () => {
    const { win } = makeWin()
    mockQuery.mockImplementationOnce(() => {
      const h = makeParkedHandle()
      ;(h.handle as Record<string, unknown>).setModel = vi.fn(async () => {
        throw new Error('Model not found')
      })
      createdHandles.push(h)
      return h.handle
    })
    const session = new ClaudeSession('routing-setmodel', win, '/tmp/proj')
    liveSessions.push(session)

    const p1 = session.run('hi') // activeQuery is assigned synchronously
    const before = session.status.model

    await expect(session.setModel('claude-nonexistent-9')).rejects.toThrow('Model not found')
    // Pre-fix this.model stayed on the rejected model; now it reverts.
    expect(session.status.model).toEqual(before)

    void p1
  })
})

describe('ClaudeSession — hardening-6: spawn-only run() re-arms the idle timer', () => {
  it('run(null) on a LIVE channel leaves the inactivity timer armed (GUARD — fails pre-fix)', async () => {
    vi.useFakeTimers()
    try {
      const { win } = makeWin()
      const session = new ClaudeSession('routing-spawn-only', win, '/tmp/proj')

      // Establish a live (non-ended) messageChannel; the run parks in for-await.
      const p1 = session.run('first')
      expect(mockQuery).toHaveBeenCalledTimes(1)

      // Spawn-only run (voice server, etc.): run() clears the idle timer up
      // front, then takes the live-channel early return with nothing to push.
      // Pre-fix nothing re-armed the timer, so the cli.js child was never
      // reaped: cancel() (→ disposeFor) never fired.
      await session.run(null)
      expect(mockQuery).toHaveBeenCalledTimes(1) // no new spawn

      mockDisposeFor.mockClear()
      vi.advanceTimersByTime(16 * 60 * 1000)
      expect(mockDisposeFor).toHaveBeenCalledTimes(1)

      void p1
    } finally {
      vi.useRealTimers()
    }
  })

  it('run(prompt) on a live channel still defers re-arming to the turn result', async () => {
    vi.useFakeTimers()
    try {
      const { win } = makeWin()
      const session = new ClaudeSession('routing-live-push', win, '/tmp/proj')

      const p1 = session.run('first')
      await session.run('second') // pushed into the live channel — turn in flight
      expect(mockQuery).toHaveBeenCalledTimes(1)

      mockDisposeFor.mockClear()
      vi.advanceTimersByTime(16 * 60 * 1000)
      // An in-flight turn must NOT be idle-timed-out; `result` re-arms instead.
      expect(mockDisposeFor).not.toHaveBeenCalled()

      void p1
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ClaudeSession — M-CL3: a DISPOSED (replaced) object cannot re-arm its idle timer', () => {
  it('disposed object: run() finally does not re-arm a timer that would disposeFor() the live routingId', async () => {
    vi.useFakeTimers()
    try {
      const { win } = makeWin()
      const session = new ClaudeSession('routing-mcl3', win, '/tmp/proj')

      const p1 = session.run('hello')
      expect(mockQuery).toHaveBeenCalledTimes(1)

      // SessionManager.create-over-existing path: the old object is disposed.
      session.dispose()
      expect(mockDisposeFor).toHaveBeenCalledTimes(1) // cancel()'s own teardown

      // Release the run so its finally executes on the DISPOSED object.
      createdHandles[0].end()
      await p1

      // 15+ min later: a zombie re-armed timer would fire cancel() → a SECOND
      // disposeFor(routingId), tearing down whatever LIVE session now owns it.
      // The disposed fence means no timer was armed.
      vi.advanceTimersByTime(16 * 60 * 1000)
      expect(mockDisposeFor).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
