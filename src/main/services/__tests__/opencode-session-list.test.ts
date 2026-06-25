/**
 * @vitest-environment node
 *
 * Tests for opencode-session-list:
 *  - listOpencodeSessionsGlobal maps opencode's DB rows (read directly, since
 *    GET /session is project-scoped) → SessionInfo[] for the sidebar.
 *  - loadOpencodeSessionHistory loads a transcript via the HTTP API (global-by-id).
 * Both are best-effort and never throw.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockAcquire, mockRelease, MockOpencodeClient, mockListMessages, mockReadRows } = vi.hoisted(
  () => ({
    mockAcquire: vi.fn(),
    mockRelease: vi.fn(),
    MockOpencodeClient: vi.fn(),
    mockListMessages: vi.fn(),
    mockReadRows: vi.fn()
  })
)

vi.mock('../../opencode/OpencodeServerManager', () => ({
  opencodeServerManager: { acquire: mockAcquire, release: mockRelease }
}))
vi.mock('../../opencode/OpencodeClient', () => ({ OpencodeClient: MockOpencodeClient }))
vi.mock('../persisted-sessions-dir', () => ({ PERSISTED_SESSIONS_DIR: '/tmp/persisted' }))
vi.mock('../db', () => ({ readOpencodeSessionRows: mockReadRows }))

import { listOpencodeSessionsGlobal, loadOpencodeSessionHistory } from '../opencode-session-list'

beforeEach(() => {
  mockAcquire.mockReset().mockResolvedValue({ baseUrl: 'http://127.0.0.1:1', authHeader: 'Basic x' })
  mockRelease.mockReset()
  mockListMessages.mockReset()
  mockReadRows.mockReset()
  MockOpencodeClient.mockReset().mockImplementation(function () {
    return { listMessages: mockListMessages }
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

describe('loadOpencodeSessionHistory (HTTP, global-by-id)', () => {
  it('converts stored messages → ChatMessage[] and releases the server', async () => {
    mockListMessages.mockResolvedValue([
      { info: { id: 'm1', role: 'user', time: { created: 1 } }, parts: [{ type: 'text', text: 'hi' }] },
      {
        info: { id: 'm2', role: 'assistant', time: { created: 2 } },
        parts: [{ type: 'text', text: 'hello' }]
      },
      // system message → dropped by the converter
      { info: { id: 'm3', role: 'system', time: { created: 3 } }, parts: [{ type: 'text', text: 's' }] }
    ])
    const msgs = await loadOpencodeSessionHistory('ses_a')
    expect(msgs.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(msgs[0].role).toBe('user')
    expect(mockRelease).toHaveBeenCalledWith('/tmp/persisted')
  })

  it('returns [] (never throws) on error', async () => {
    mockListMessages.mockRejectedValueOnce(new Error('boom'))
    expect(await loadOpencodeSessionHistory('ses_a')).toEqual([])
  })
})
