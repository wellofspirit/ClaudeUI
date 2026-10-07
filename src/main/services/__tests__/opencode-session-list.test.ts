/**
 * @vitest-environment node
 *
 * Tests for opencode-session-list:
 *  - listOpencodeSessionsGlobal maps opencode's DB rows (read directly, since
 *    GET /session is project-scoped) → SessionInfo[] for the sidebar.
 *  - loadOpencodeSessionHistory loads a transcript via the HTTP API (global-by-id).
 *  - deleteOpencodeSession routes to the HTTP API (global-by-id), best-effort.
 * Both are best-effort and never throw.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
  mockAcquire,
  mockRelease,
  MockOpencodeClient,
  mockListMessages,
  mockGetSession,
  mockDeleteSession,
  mockReadRows,
  mockDeleteSessionFiles,
  mockWarmCache,
  mockBuildAccountRef
} = vi.hoisted(() => ({
  mockAcquire: vi.fn(),
  mockRelease: vi.fn(),
  MockOpencodeClient: vi.fn(),
  mockListMessages: vi.fn(),
  mockGetSession: vi.fn(),
  mockDeleteSession: vi.fn(),
  mockReadRows: vi.fn(),
  mockDeleteSessionFiles: vi.fn(),
  mockWarmCache: vi.fn(),
  mockBuildAccountRef: vi.fn()
}))

vi.mock('../../../core/opencode/OpencodeServerManager', () => ({
  opencodeServerManager: {
    setServerStartedHook: vi.fn(),
    acquire: mockAcquire,
    release: mockRelease
  }
}))
// One 2.x client answers both (history → listMessages, delete → deleteSession).
vi.mock('../../../core/opencode/OpencodeClient', () => ({ OpencodeClient: MockOpencodeClient }))
vi.mock('../../../core/services/persisted-sessions-dir', () => ({
  PERSISTED_SESSIONS_DIR: '/tmp/persisted'
}))
vi.mock('../../../core/services/db', () => ({
  readOpencodeSessionRows: mockReadRows,
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
  listOpencodeSessionsGlobal,
  loadOpencodeSessionHistory,
  deleteOpencodeSession
} from '../../../core/services/opencode-session-list'
import { deleteSessionByEngine } from '../../../core/services/session-delete'

beforeEach(() => {
  mockAcquire
    .mockReset()
    .mockResolvedValue({ baseUrl: 'http://127.0.0.1:1', authHeader: 'Basic x' })
  mockRelease.mockReset()
  mockListMessages.mockReset()
  mockGetSession.mockReset().mockRejectedValue(new Error('no session read in this test'))
  mockDeleteSession.mockReset()
  mockReadRows.mockReset()
  mockDeleteSessionFiles.mockReset().mockResolvedValue(undefined)
  mockWarmCache.mockReset().mockResolvedValue(undefined)
  mockBuildAccountRef.mockReset().mockReturnValue(null)
  MockOpencodeClient.mockReset().mockImplementation(function () {
    return {
      listMessages: mockListMessages,
      getSession: mockGetSession,
      deleteSession: mockDeleteSession
    }
  })
})

describe('listOpencodeSessionsGlobal (direct DB read)', () => {
  it('maps opencode DB rows → SessionInfo[] (engineId opencode, cwd, title fallback, newest first)', async () => {
    mockReadRows.mockReturnValue([
      { id: 'ses_a', directory: '/proj/a', title: 'Fix bug', timeCreated: 1, timeUpdated: 5 },
      { id: 'ses_b', directory: '/proj/b', title: '', timeCreated: 2, timeUpdated: 9 }
    ])
    const infos = await listOpencodeSessionsGlobal()
    expect(infos).toHaveLength(2)
    // newest-first by lastActivityAt (ses_b updated 9 > ses_a 5)
    expect(infos[0]).toMatchObject({
      sessionId: 'ses_b',
      cwd: '/proj/b',
      title: 'Untitled',
      engineId: 'opencode',
      lastActivityAt: 9
    })
    expect(infos[1]).toMatchObject({ sessionId: 'ses_a', title: 'Fix bug', engineId: 'opencode' })
  })

  it("maps opencode's default placeholder title → 'Untitled' (real generated titles pass through)", async () => {
    mockReadRows.mockReturnValue([
      // opencode's un-generated placeholder — must be hidden in the sidebar
      {
        id: 'ph',
        directory: '/d',
        title: 'New session - 2026-06-26T10:20:30.123Z',
        timeCreated: 1,
        timeUpdated: 3
      },
      // child-session placeholder variant
      {
        id: 'ch',
        directory: '/d',
        title: 'Child session - 2026-06-26T10:20:30.123Z',
        timeCreated: 1,
        timeUpdated: 2
      },
      // a real LLM-generated title must NOT be mistaken for a placeholder
      { id: 'real', directory: '/d', title: 'New session - notes', timeCreated: 1, timeUpdated: 1 }
    ])
    const infos = await listOpencodeSessionsGlobal()
    const byId = Object.fromEntries(infos.map((i) => [i.sessionId, i.title]))
    expect(byId.ph).toBe('Untitled')
    expect(byId.ch).toBe('Untitled')
    expect(byId.real).toBe('New session - notes')
  })

  it('skips rows without a directory; falls back to timeCreated when timeUpdated is null', async () => {
    mockReadRows.mockReturnValue([
      { id: 'ok', directory: '/d', title: 't', timeCreated: 7, timeUpdated: null },
      { id: 'nodir', directory: '', title: 't', timeCreated: 1, timeUpdated: 1 }
    ])
    const infos = await listOpencodeSessionsGlobal()
    expect(infos.map((i) => i.sessionId)).toEqual(['ok'])
    expect(infos[0].timestamp).toBe(7)
  })

  it('returns [] (never throws) when the DB read yields nothing', async () => {
    mockReadRows.mockReturnValue([])
    expect(await listOpencodeSessionsGlobal()).toEqual([])
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
    expect(MockOpencodeClient).toHaveBeenCalledWith({
      baseUrl: 'http://127.0.0.1:1',
      authHeader: 'Basic x'
    })
    expect(mockRelease).toHaveBeenCalledWith('/tmp/persisted')
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

describe('listOpencodeSessionsGlobal — Claude-format projectKey (merge regression guard)', () => {
  it('emits projectKey in Claude-format (D--WorkPlace-ClaudeUI) not forward-slash format', async () => {
    mockReadRows.mockReturnValue([
      {
        id: 'ses_1',
        directory: 'D:/WorkPlace/ClaudeUI',
        title: 'Test',
        timeCreated: 1,
        timeUpdated: 2
      }
    ])
    const infos = await listOpencodeSessionsGlobal()
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
    expect(mockRelease).toHaveBeenCalledWith('/tmp/persisted')
  })

  it('builds the 2.x client on the lease and skips the hosted-tools wait (no turn)', async () => {
    await deleteOpencodeSession('ses_del')
    expect(mockAcquire).toHaveBeenCalledWith('/tmp/persisted', { waitForHostedTools: false })
    expect(MockOpencodeClient).toHaveBeenCalledWith(await mockAcquire.mock.results[0].value)
  })

  it('resolves without throwing when the server is down (best-effort)', async () => {
    mockAcquire.mockRejectedValueOnce(new Error('server down'))
    await expect(deleteOpencodeSession('ses_del')).resolves.toBeUndefined()
  })

  it('releases the server even when deleteSession rejects', async () => {
    mockDeleteSession.mockRejectedValueOnce(new Error('not found'))
    await expect(deleteOpencodeSession('ses_del')).resolves.toBeUndefined()
    expect(mockRelease).toHaveBeenCalledWith('/tmp/persisted')
  })
})

describe('deleteSessionByEngine (engine-neutral dispatch)', () => {
  it('routes engineId=opencode → opencode HTTP delete; never touches the filesystem', async () => {
    mockDeleteSession.mockResolvedValueOnce(true)
    await deleteSessionByEngine('ses_oc', 'D--WorkPlace-ClaudeUI', 'opencode')
    // opencode client delete invoked with the engine-owned sessionId
    expect(mockDeleteSession).toHaveBeenCalledWith('ses_oc')
    expect(mockAcquire).toHaveBeenCalledWith('/tmp/persisted', { waitForHostedTools: false })
    // Claude filesystem delete NOT invoked
    expect(mockDeleteSessionFiles).not.toHaveBeenCalled()
  })

  it('routes engineId=claude → deleteSessionFiles; opencode server never acquired', async () => {
    await deleteSessionByEngine('ses_cl', 'D--WorkPlace-ClaudeUI', 'claude')
    expect(mockDeleteSessionFiles).toHaveBeenCalledWith('ses_cl', 'D--WorkPlace-ClaudeUI')
    expect(mockAcquire).not.toHaveBeenCalled()
    expect(mockDeleteSession).not.toHaveBeenCalled()
  })

  it('routes engineId=undefined (legacy callers) → deleteSessionFiles', async () => {
    await deleteSessionByEngine('ses_legacy', 'proj', undefined)
    expect(mockDeleteSessionFiles).toHaveBeenCalledWith('ses_legacy', 'proj')
    expect(mockAcquire).not.toHaveBeenCalled()
  })
})
