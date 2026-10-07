/**
 * @vitest-environment node
 *
 * Tests for opencode-session-list (opencode 2.x, ADR-093 §6 / S9):
 *  - the sidebar list comes from `GET /api/session?parentID=null` (global,
 *    paged), served from the last listing at once and refreshed in the
 *    background — never a spawn per call; [] when opencode is not installed;
 *  - loadOpencodeSessionHistory loads a transcript via the HTTP API (global-by-id).
 *  - deleteOpencodeSession routes to the HTTP API (global-by-id), best-effort.
 * All best-effort; none throws.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const {
  mockAcquire,
  mockAcquireIfRunning,
  mockReleaseIfCurrent,
  mockIsBinaryAvailable,
  MockOpencodeClient,
  mockListMessages,
  mockListSessions,
  mockGetSession,
  mockDeleteSession,
  mockDeleteSessionFiles,
  mockWarmCache,
  mockBuildAccountRef
} = vi.hoisted(() => ({
  mockAcquire: vi.fn(),
  mockAcquireIfRunning: vi.fn(),
  mockReleaseIfCurrent: vi.fn(),
  mockIsBinaryAvailable: vi.fn(),
  MockOpencodeClient: vi.fn(),
  mockListMessages: vi.fn(),
  mockListSessions: vi.fn(),
  mockGetSession: vi.fn(),
  mockDeleteSession: vi.fn(),
  mockDeleteSessionFiles: vi.fn(),
  mockWarmCache: vi.fn(),
  mockBuildAccountRef: vi.fn()
}))

vi.mock('../../../core/opencode/OpencodeServerManager', () => ({
  opencodeServerManager: {
    setServerStartedHook: vi.fn(),
    acquire: mockAcquire,
    acquireIfRunning: mockAcquireIfRunning,
    releaseIfCurrent: mockReleaseIfCurrent,
    isBinaryAvailable: mockIsBinaryAvailable
  }
}))
// One 2.x client answers all (list → listSessions, history → listMessages, delete → deleteSession).
vi.mock('../../../core/opencode/OpencodeClient', () => ({ OpencodeClient: MockOpencodeClient }))
vi.mock('../../../core/services/persisted-sessions-dir', () => ({
  PERSISTED_SESSIONS_DIR: '/tmp/persisted'
}))
vi.mock('../../../core/services/db', () => ({
  // The history load merges durable dispatched-cost rows into its status line.
  dispatchedCostsByRouting: () => []
}))
// The status line prices history under the vendor's billing type; the real
// provider would spawn/read opencode's own auth.json on the machine running
// the suite. No account ref → 'unknown', which is what these tests assume.
vi.mock('../../../core/auth/OpencodeAuthProvider', () => ({
  opencodeAuthProvider: { buildAccountRef: mockBuildAccountRef, warmCache: mockWarmCache }
}))
vi.mock('../../../core/services/delete-session-files', () => ({
  deleteSessionFiles: mockDeleteSessionFiles
}))
// `deleteSessionByEngine` dispatches through `engine-history`, whose table holds
// a reader for EVERY engine — so importing it drags Claude's transcript reader
// into a leaf test about opencode, and with it session-history → block-usage →
// usage-fetcher → claude-session → collab-tool → the cross-engine dispatcher,
// which builds its singleton at module load off the `db` module this file mocks
// narrowly. Nothing here exercises it: the Claude assertions below reach only
// `deleteSessionFiles`, already mocked above. Severed at the test boundary rather
// than by widening the `db` mock, which would pull the whole engine graph in
// behind it.
vi.mock('../../../core/services/session-history', () => ({
  listDirectories: vi.fn(),
  loadSessionHistory: vi.fn(),
  resolveForkAnchor: vi.fn()
}))

import {
  __resetOpencodeSessionListForTests,
  deleteOpencodeSession,
  listOpencodeSessionsForReconcile,
  listOpencodeSessionsGlobal,
  __resetOpencodeSessionListThrottleForTests,
  loadOpencodeSessionHistory,
  onOpencodeSessionListChanged,
  readOpencodeSessions,
  MAX_BACKOFF_MS,
  REFRESH_MIN_INTERVAL_MS,
  STALE_LISTING_MS
} from '../../../core/services/opencode-session-list'
import type { OpencodeClient as RealOpencodeClient } from '../../../core/opencode/OpencodeClient'
import { deleteSessionByEngine } from '../../../core/services/session-delete'

const LEASE = { baseUrl: 'http://127.0.0.1:1', authHeader: 'Basic x', directory: '/tmp/persisted' }
const LIST_LEASE = { waitForHostedTools: false, lingerMs: 60_000 }
const RIDE_LEASE = { ...LIST_LEASE, anyConfig: true }

beforeEach(() => {
  __resetOpencodeSessionListForTests()
  mockIsBinaryAvailable.mockReset().mockReturnValue(true)
  mockAcquire.mockReset().mockResolvedValue(LEASE)
  mockAcquireIfRunning.mockReset().mockResolvedValue(LEASE)
  mockReleaseIfCurrent.mockReset()
  mockListSessions.mockReset().mockResolvedValue([])
  mockListMessages.mockReset()
  mockGetSession.mockReset().mockRejectedValue(new Error('no session read in this test'))
  mockDeleteSession.mockReset()
  mockDeleteSessionFiles.mockReset().mockResolvedValue(undefined)
  mockWarmCache.mockReset().mockResolvedValue(undefined)
  mockBuildAccountRef.mockReset().mockReturnValue(null)
  MockOpencodeClient.mockReset().mockImplementation(function () {
    return {
      listMessages: mockListMessages,
      getSession: mockGetSession,
      deleteSession: mockDeleteSession,
      listSessions: mockListSessions
    }
  })
})

afterEach(() => {
  vi.useRealTimers()
})

/** A 2.x `Session.Info` as `GET /api/session` returns it. */
function apiSession(
  id: string,
  directory: string,
  updated: number,
  extra: { title?: string; archived?: number; created?: number } = {}
): Record<string, unknown> {
  return {
    id,
    projectID: 'prj',
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    location: { directory },
    time: {
      created: extra.created ?? 1,
      updated,
      ...(extra.archived !== undefined ? { archived: extra.archived } : {})
    },
    ...(extra.title !== undefined ? { title: extra.title } : {})
  }
}

/** Let the background refresh a list call kicked land. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
  await new Promise((done) => setImmediate(done))
}

describe('the opencode session list (2.x API, ADR-093 §6; onInteraction policy)', () => {
  it('maps root sessions → SessionInfo[] (cwd from location, title fallback, archived and ClaudeUI throwaways left out, newest first)', async () => {
    mockListSessions.mockResolvedValue([
      apiSession('ses_a', '/proj/a', 5, { title: 'Fix bug' }),
      apiSession('ses_b', '/proj/b', 9),
      apiSession('ses_old', '/proj/a', 7, { title: 'Archived', archived: 8 }),
      apiSession('ses_ph', '/proj/a', 3, { title: 'New session - 2026-06-26T10:20:30.123Z' }),
      apiSession('ses_real', '/proj/a', 2, { title: 'New session - notes' }),
      apiSession('ses_disp', '/proj/a', 6, { title: 'xeng-dispatch' }),
      apiSession('ses_side', '/proj/a', 6, { title: 'side-question' }),
      apiSession('ses_gen', '/proj/a', 6, { title: 'agent-generate' })
    ])
    const infos = await listOpencodeSessionsForReconcile()
    expect(mockListSessions).toHaveBeenCalledWith({ parentID: 'null' })
    expect(infos.map((i) => i.sessionId)).toEqual(['ses_b', 'ses_a', 'ses_ph', 'ses_real'])
    expect(infos[0]).toMatchObject({
      sessionId: 'ses_b',
      cwd: '/proj/b',
      title: 'Untitled',
      engineId: 'opencode',
      lastActivityAt: 9,
      timestamp: 9
    })
    expect(infos.find((i) => i.sessionId === 'ses_ph')?.title).toBe('Untitled')
    expect(infos.find((i) => i.sessionId === 'ses_real')?.title).toBe('New session - notes')
  })

  it('serves the last listing at once and refreshes in the background, riding ANY running server', async () => {
    mockListSessions.mockResolvedValue([apiSession('ses_a', '/proj/a', 5)])
    const changed = vi.fn()
    onOpencodeSessionListChanged(changed)

    // No listing yet: nothing to serve, a refresh is kicked.
    expect(await listOpencodeSessionsGlobal()).toEqual([])
    await flush()
    expect(mockAcquireIfRunning).toHaveBeenCalledWith('/tmp/persisted', RIDE_LEASE)
    expect(mockAcquire).not.toHaveBeenCalled()
    expect(mockReleaseIfCurrent).toHaveBeenCalledWith('/tmp/persisted', LEASE)
    expect(changed).toHaveBeenCalledTimes(1)

    // Served from the cache, no second read inside the refresh window.
    const second = await listOpencodeSessionsGlobal()
    expect(second.map((i) => i.sessionId)).toEqual(['ses_a'])
    await flush()
    expect(mockListSessions).toHaveBeenCalledTimes(1)
  })

  it('when a server may be STARTED: the first listing; then only an interaction on a stale listing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000_000)
    mockAcquireIfRunning.mockResolvedValue(null) // nothing running
    mockListSessions.mockResolvedValue([apiSession('ses_a', '/proj/a', 5)])
    await listOpencodeSessionsGlobal()
    await flush()
    expect(mockAcquire).toHaveBeenCalledTimes(1) // the first listing

    // A background refresh never starts one.
    vi.setSystemTime(1_000_000 + STALE_LISTING_MS + REFRESH_MIN_INTERVAL_MS)
    await listOpencodeSessionsGlobal()
    await flush()
    expect(mockAcquire).toHaveBeenCalledTimes(1)

    // An interaction on a FRESH listing does not either…
    vi.setSystemTime(1_000_000 + 2 * REFRESH_MIN_INTERVAL_MS)
    // (the listing is from 1_000_000: fresh enough)
    vi.setSystemTime(1_000_000 + STALE_LISTING_MS - 1)
    await listOpencodeSessionsGlobal({ interaction: true })
    await flush()
    expect(mockAcquire).toHaveBeenCalledTimes(1)

    // …on a stale one it does.
    vi.setSystemTime(1_000_000 + 2 * STALE_LISTING_MS)
    await listOpencodeSessionsGlobal({ interaction: true })
    await flush()
    expect(mockAcquire).toHaveBeenCalledTimes(2)
  })

  it('a failed start or read backs off exponentially (never a retry every 20 s), up to a cap', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    let now = 1_000_000
    vi.setSystemTime(now)
    mockAcquireIfRunning.mockResolvedValue(null)
    mockAcquire.mockRejectedValue(new Error('broken install'))
    await listOpencodeSessionsGlobal()
    await flush()
    expect(mockAcquire).toHaveBeenCalledTimes(1)
    // 2 × 20 s back-off: a try at +21 s (past the throttle) is still skipped, interaction too.
    now += REFRESH_MIN_INTERVAL_MS + 1_000
    vi.setSystemTime(now)
    await listOpencodeSessionsGlobal({ interaction: true })
    await flush()
    expect(mockAcquire).toHaveBeenCalledTimes(1)
    now = 1_000_000 + 2 * REFRESH_MIN_INTERVAL_MS + 1_000
    vi.setSystemTime(now)
    await listOpencodeSessionsGlobal()
    await flush()
    expect(mockAcquire).toHaveBeenCalledTimes(2)
    // The next wait doubled (80 s).
    vi.setSystemTime(now + 3 * REFRESH_MIN_INTERVAL_MS)
    await listOpencodeSessionsGlobal()
    await flush()
    expect(mockAcquire).toHaveBeenCalledTimes(2)
    vi.setSystemTime(now + 4 * REFRESH_MIN_INTERVAL_MS + 1_000)
    await listOpencodeSessionsGlobal()
    await flush()
    expect(mockAcquire).toHaveBeenCalledTimes(3)
    // Capped: after many failures the wait is never longer than MAX_BACKOFF_MS.
    for (let i = 0; i < 10; i++) {
      now += MAX_BACKOFF_MS + 1_000
      vi.setSystemTime(now)
      await listOpencodeSessionsGlobal()
      await flush()
    }
    expect(mockAcquire).toHaveBeenCalledTimes(13)
  })

  it('concurrent triggers (several focus events, windows) share ONE refresh in flight', async () => {
    let release!: (v: unknown) => void
    mockListSessions.mockReturnValueOnce(new Promise((resolve) => (release = resolve)))
    const changed = vi.fn()
    onOpencodeSessionListChanged(changed)
    await Promise.all([
      listOpencodeSessionsGlobal({ interaction: true }),
      listOpencodeSessionsGlobal({ interaction: true }),
      listOpencodeSessionsGlobal({ interaction: true }),
      listOpencodeSessionsGlobal()
    ])
    await flush()
    release([apiSession('ses_a', '/proj/a', 5)])
    await flush()
    expect(mockAcquireIfRunning).toHaveBeenCalledTimes(1)
    expect(mockListSessions).toHaveBeenCalledTimes(1)
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('NEVER blocks the panel: with a refresh hanging, the listing answers from cache at once (timed)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000_000)
    const many = Array.from({ length: 2_000 }, (_, i) =>
      apiSession(`ses_${i}`, '/proj/a', 5_000 - i)
    )
    mockListSessions.mockResolvedValueOnce(many)
    await listOpencodeSessionsForReconcile() // warm cache
    // Every later refresh hangs forever (a server that never answers).
    mockAcquireIfRunning.mockReturnValue(new Promise(() => {}))
    mockAcquire.mockReturnValue(new Promise(() => {}))
    vi.setSystemTime(1_000_000 + 2 * STALE_LISTING_MS)
    vi.useRealTimers()
    const samples: number[] = []
    for (let i = 0; i < 50; i++) {
      const t0 = performance.now()
      const rows = await listOpencodeSessionsGlobal({ interaction: true })
      samples.push(performance.now() - t0)
      expect(rows).toHaveLength(2_000)
    }
    samples.sort((a, b) => a - b)
    const median = samples[25]
    const p95 = samples[47]
    // The IPC also copies the answer (structured clone) to the renderer.
    const rows = await listOpencodeSessionsGlobal()
    const c0 = performance.now()
    structuredClone(rows)
    const cloneMs = performance.now() - c0
    // Reported in the S9 results: the IPC body with a warm cache of 2 000 sessions.
    console.info(
      `listOpencodeSessionsGlobal warm cache (2000 rows): median ${median.toFixed(3)} ms, p95 ${p95.toFixed(3)} ms; payload clone ${cloneMs.toFixed(2)} ms`
    )
    expect(p95).toBeLessThan(20)
    // One refresh in flight (hanging), not one per call.
    expect(mockAcquireIfRunning).toHaveBeenCalledTimes(2)
    void cloneMs
  })

  it('opencode not installed: [] and no server, ever', async () => {
    mockIsBinaryAvailable.mockReturnValue(false)
    expect(await listOpencodeSessionsGlobal({ interaction: true })).toEqual([])
    expect(await listOpencodeSessionsForReconcile()).toEqual([])
    await flush()
    expect(mockAcquire).not.toHaveBeenCalled()
    expect(mockAcquireIfRunning).not.toHaveBeenCalled()
  })

  it('a failed refresh keeps the last listing (never throws)', async () => {
    mockListSessions.mockResolvedValueOnce([apiSession('ses_a', '/proj/a', 5)])
    await listOpencodeSessionsForReconcile()
    mockListSessions.mockRejectedValueOnce(new Error('500'))
    __resetOpencodeSessionListThrottleForTests()
    expect((await listOpencodeSessionsForReconcile()).map((i) => i.sessionId)).toEqual(['ses_a'])
    expect(await listOpencodeSessionsGlobal()).toHaveLength(1)
  })

  it('the reconciler never starts a server: nothing running → the last listing', async () => {
    mockAcquireIfRunning.mockResolvedValue(null)
    expect(await listOpencodeSessionsForReconcile()).toEqual([])
    expect(mockAcquire).not.toHaveBeenCalled()
  })

  it('pages through every root session (real client, cursor paging) and narrows by directory', async () => {
    const { OpencodeClient } = await vi.importActual<{
      OpencodeClient: typeof RealOpencodeClient
    }>('../../../core/opencode/OpencodeClient')
    const page1 = Array.from({ length: 200 }, (_, i) => apiSession(`ses_${i}`, '/proj/a', 1000 - i))
    const page2 = [apiSession('ses_last', '/proj/b', 1)]
    const urls: string[] = []
    const fetch = vi.fn(async (url: string) => {
      urls.push(url)
      const second = url.includes('cursor=')
      return new Response(
        JSON.stringify({ data: second ? page2 : page1, cursor: { next: second ? null : 'c2' } }),
        { status: 200 }
      )
    })
    const client = new OpencodeClient(
      { baseUrl: 'http://127.0.0.1:9', authHeader: 'Basic x', directory: '/srv' },
      { fetch }
    )
    const infos = await readOpencodeSessions(client)
    expect(infos).toHaveLength(201)
    expect(infos.at(-1)).toMatchObject({ sessionId: 'ses_last', cwd: '/proj/b' })
    expect(urls[0]).toContain('parentID=null')
    expect(urls[0]).not.toContain('directory=')
    expect(urls[1]).toContain('cursor=c2')

    urls.length = 0
    await readOpencodeSessions(client, '/proj/b')
    expect(urls[0]).toContain(`directory=${encodeURIComponent('/proj/b')}`)
  })

  it('a delete drops the session from the listing at once', async () => {
    mockListSessions.mockResolvedValueOnce([
      apiSession('ses_a', '/proj/a', 5),
      apiSession('ses_b', '/proj/b', 4)
    ])
    await listOpencodeSessionsForReconcile()
    const changed = vi.fn()
    onOpencodeSessionListChanged(changed)
    await deleteOpencodeSession('ses_a')
    expect(changed).toHaveBeenCalledTimes(1)
    expect((await listOpencodeSessionsGlobal()).map((i) => i.sessionId)).toEqual(['ses_b'])
  })
})

// 2.x stored rows (ADR-093 S4): `GET /api/session/:id/message` → Session.Message.Info.
const user = (id: string, created: number, text: string) => ({
  id,
  type: 'user',
  text,
  time: { created }
})
const assistant = (
  id: string,
  created: number,
  content: unknown[],
  extra: Record<string, unknown> = {}
) => ({
  id,
  type: 'assistant',
  agent: 'build',
  model: { providerID: 'anthropic', id: 'claude-sonnet-4-6' },
  content,
  time: { created, completed: created + 1 },
  ...extra
})

describe('loadOpencodeSessionHistory (HTTP, global-by-id, 2.x rows)', () => {
  it('converts stored rows → ChatMessage[] and releases the server', async () => {
    mockListMessages.mockResolvedValue([
      user('msg_u1', 1, 'hi'),
      assistant('msg_a1', 2, [{ type: 'text', text: 'hello' }]),
      // carry nothing a transcript row shows
      { id: 'msg_s', type: 'synthetic', text: 'internal', time: { created: 3 } },
      { id: 'msg_i', type: 'idle', outcome: 'succeeded', time: { created: 4 } }
    ])
    const { messages } = await loadOpencodeSessionHistory('ses_a')
    expect(messages.map((m) => [m.id, m.role])).toEqual([
      ['msg_u1', 'user'],
      ['msg_a1', 'assistant']
    ])
    expect(MockOpencodeClient).toHaveBeenCalledWith(LEASE)
    expect(mockReleaseIfCurrent).toHaveBeenCalledWith('/tmp/persisted', LEASE)
  })

  it("reads a subagent call's child and returns its transcript and outcome", async () => {
    const call = {
      type: 'tool',
      id: 'call_sub',
      name: 'subagent',
      state: {
        status: 'completed',
        input: { agent: 'general', description: 'look', prompt: 'go' },
        content: [
          {
            type: 'text',
            text: '<subagent sessionID="ses_child" state="completed">\ndone\n</subagent>'
          }
        ],
        metadata: { sessionID: 'ses_child', status: 'completed' }
      },
      time: { created: 3 }
    }
    mockListMessages.mockImplementation(async (id: string) =>
      id === 'ses_a'
        ? [user('msg_u1', 1, 'spawn'), assistant('msg_a1', 2, [call])]
        : [
            user('msg_cu', 3, 'child prompt'),
            assistant('msg_c1', 4, [{ type: 'text', text: 'done' }])
          ]
    )
    const history = await loadOpencodeSessionHistory('ses_a')
    expect(mockListMessages).toHaveBeenCalledWith('ses_child')
    expect(history.subagentMessages).toEqual({
      call_sub: [expect.objectContaining({ id: 'msg_c1', role: 'assistant' })]
    })
    expect(history.taskNotifications).toEqual([
      expect.objectContaining({ taskId: 'ses_child', toolUseId: 'call_sub', status: 'completed' })
    ])
  })

  it('returns no messages and no status line (never throws) on error', async () => {
    mockListMessages.mockRejectedValueOnce(new Error('boom'))
    expect(await loadOpencodeSessionHistory('ses_a')).toEqual({ messages: [], statusLine: null })
  })

  // S1d — the line the reopened session paints before anything spawns.
  it('builds the status line AFTER warming the auth probe, so the bill is resolved', async () => {
    // The probe is what turns `unknown` into `subscription`; building the line
    // before it lands would report a null bill for a covered session.
    mockWarmCache.mockImplementation(async () => {
      mockBuildAccountRef.mockReturnValue({ billingType: 'subscription' })
    })
    mockListMessages.mockResolvedValue([
      user('msg_u1', 1, 'hi'),
      assistant('msg_a1', 2, [{ type: 'text', text: 'hello' }], {
        cost: 0,
        tokens: { input: 1_000_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
      })
    ])

    const { statusLine } = await loadOpencodeSessionHistory('ses_a')
    expect(mockWarmCache).toHaveBeenCalled()
    expect(statusLine?.billedCostUsd).toBe(0)
    expect(statusLine?.totalCostUsd).toBeCloseTo(3, 10)
  })

  it('counts children and the session remainder (title generation) in the line', async () => {
    const call = {
      type: 'tool',
      id: 'call_sub',
      name: 'subagent',
      state: {
        status: 'completed',
        input: {},
        content: [{ type: 'text', text: 'ok' }],
        metadata: { sessionID: 'ses_child', status: 'completed' }
      },
      time: { created: 3 }
    }
    const zero = { reasoning: 0, cache: { read: 0, write: 0 } }
    mockListMessages.mockImplementation(async (id: string) =>
      id === 'ses_a'
        ? [assistant('msg_a1', 2, [call], { cost: 1, tokens: { input: 10, output: 1, ...zero } })]
        : [assistant('msg_c1', 4, [], { cost: 2, tokens: { input: 20, output: 2, ...zero } })]
    )
    // The own session's cumulative: its step plus a title generation (0.5, 5 in / 1 out).
    mockGetSession.mockResolvedValue({ cost: 1.5, tokens: { input: 15, output: 2, ...zero } })
    mockBuildAccountRef.mockReturnValue({ billingType: 'api' })
    const { statusLine } = await loadOpencodeSessionHistory('ses_a')
    expect(statusLine?.totalCostUsd).toBeCloseTo(3.5, 10)
    expect(statusLine?.totalInputTokens).toBe(35)
    expect(statusLine?.totalOutputTokens).toBe(4)
    // Context is the own session's last step, not the child's.
    expect(statusLine?.contextWindow?.used).toBe(10)
  })

  it('still returns the transcript and a line when the probe rejects', async () => {
    mockWarmCache.mockRejectedValue(new Error('opencode is down'))
    mockListMessages.mockResolvedValue([
      assistant('msg_a1', 2, [{ type: 'text', text: 'hello' }], {
        cost: 0.5,
        tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } }
      })
    ])

    const { messages, statusLine } = await loadOpencodeSessionHistory('ses_a')
    expect(messages.map((m) => m.id)).toEqual(['msg_a1'])
    expect(statusLine).not.toBeNull()
  })

  it('has no status line to paint when the session stored no messages', async () => {
    mockListMessages.mockResolvedValue([])
    expect(await loadOpencodeSessionHistory('ses_a')).toEqual({
      messages: [],
      statusLine: null,
      lastModel: null
    })
  })

  // R1b — a session opencode created on its own has no model persisted on our
  // side, so the transcript's last step is where the reopened session's model
  // comes from.
  it('names the model the LAST step answered on', async () => {
    mockListMessages.mockResolvedValue([
      assistant('msg_a1', 1, [], { model: { providerID: 'openai', id: 'gpt-old' } }),
      assistant('msg_a2', 3, [], { model: { providerID: 'alicloud', id: 'qwen-x' } })
    ])

    const { lastModel } = await loadOpencodeSessionHistory('ses_a')
    expect(lastModel).toEqual({ engineId: 'opencode', vendorId: 'alicloud', modelId: 'qwen-x' })
  })

  it('names no model when the transcript has no assistant message', async () => {
    mockListMessages.mockResolvedValue([user('msg_u1', 1, 'hi')])

    const { lastModel } = await loadOpencodeSessionHistory('ses_a')
    expect(lastModel).toBeNull()
  })
})

describe('the opencode session list — Claude-format projectKey (merge regression guard)', () => {
  it('emits projectKey in Claude-format (D--WorkPlace-ClaudeUI) not forward-slash format', async () => {
    mockListSessions.mockResolvedValue([
      apiSession('ses_1', 'D:/WorkPlace/ClaudeUI', 2, { title: 'Test' })
    ])
    const infos = await listOpencodeSessionsForReconcile()
    expect(infos).toHaveLength(1)
    expect(infos[0].projectKey).toBe('D--WorkPlace-ClaudeUI')
    // cwd stays as the real (unmodified) path
    expect(infos[0].cwd).toBe('D:/WorkPlace/ClaudeUI')
    // Would fail under the old forward-slash key 'D:/WorkPlace/ClaudeUI'
    expect(infos[0].projectKey).not.toBe('D:/WorkPlace/ClaudeUI')
  })
})

describe('deleteOpencodeSession (HTTP, global-by-id)', () => {
  it('calls client.deleteSession with the sessionId and releases the server', async () => {
    mockDeleteSession.mockResolvedValueOnce(true)
    await deleteOpencodeSession('ses_del')
    expect(mockDeleteSession).toHaveBeenCalledWith('ses_del')
    expect(mockReleaseIfCurrent).toHaveBeenCalledWith('/tmp/persisted', LEASE)
  })

  it('rides any running server (no hosted-tools wait); starts one only when none runs', async () => {
    await deleteOpencodeSession('ses_del')
    expect(mockAcquireIfRunning).toHaveBeenCalledWith('/tmp/persisted', RIDE_LEASE)
    expect(mockAcquire).not.toHaveBeenCalled()
    expect(MockOpencodeClient).toHaveBeenCalledWith(LEASE)
    mockAcquireIfRunning.mockResolvedValueOnce(null)
    await deleteOpencodeSession('ses_del2')
    expect(mockAcquire).toHaveBeenCalledWith('/tmp/persisted', LIST_LEASE)
  })

  it('resolves without throwing when the server is down (best-effort)', async () => {
    mockAcquireIfRunning.mockRejectedValueOnce(new Error('server down'))
    await expect(deleteOpencodeSession('ses_del')).resolves.toBeUndefined()
  })

  it('releases the server even when deleteSession rejects', async () => {
    mockDeleteSession.mockRejectedValueOnce(new Error('not found'))
    await expect(deleteOpencodeSession('ses_del')).resolves.toBeUndefined()
    expect(mockReleaseIfCurrent).toHaveBeenCalledWith('/tmp/persisted', LEASE)
  })
})

describe('deleteSessionByEngine (engine-neutral dispatch)', () => {
  it('routes engineId=opencode → opencode HTTP delete; never touches the filesystem', async () => {
    mockDeleteSession.mockResolvedValueOnce(true)
    await deleteSessionByEngine('ses_oc', 'D--WorkPlace-ClaudeUI', 'opencode')
    // opencode client delete invoked with the engine-owned sessionId
    expect(mockDeleteSession).toHaveBeenCalledWith('ses_oc')
    expect(mockAcquireIfRunning).toHaveBeenCalledWith('/tmp/persisted', RIDE_LEASE)
    // Claude filesystem delete NOT invoked
    expect(mockDeleteSessionFiles).not.toHaveBeenCalled()
  })

  it('routes engineId=claude → deleteSessionFiles; opencode server never acquired', async () => {
    await deleteSessionByEngine('ses_cl', 'D--WorkPlace-ClaudeUI', 'claude')
    expect(mockDeleteSessionFiles).toHaveBeenCalledWith('ses_cl', 'D--WorkPlace-ClaudeUI')
    expect(mockAcquire).not.toHaveBeenCalled()
    expect(mockAcquireIfRunning).not.toHaveBeenCalled()
    expect(mockDeleteSession).not.toHaveBeenCalled()
  })

  it('routes engineId=undefined (legacy callers) → deleteSessionFiles', async () => {
    await deleteSessionByEngine('ses_legacy', 'proj', undefined)
    expect(mockDeleteSessionFiles).toHaveBeenCalledWith('ses_legacy', 'proj')
    expect(mockAcquire).not.toHaveBeenCalled()
  })
})
