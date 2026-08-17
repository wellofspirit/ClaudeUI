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
  mockDeleteSession,
  mockReadRows,
  mockDeleteSessionFiles
} = vi.hoisted(() => ({
  mockAcquire: vi.fn(),
  mockRelease: vi.fn(),
  MockOpencodeClient: vi.fn(),
  mockListMessages: vi.fn(),
  mockDeleteSession: vi.fn(),
  mockReadRows: vi.fn(),
  mockDeleteSessionFiles: vi.fn()
}))

vi.mock('../../../core/opencode/OpencodeServerManager', () => ({
  opencodeServerManager: { acquire: mockAcquire, release: mockRelease }
}))
vi.mock('../../../core/opencode/OpencodeClient', () => ({ OpencodeClient: MockOpencodeClient }))
vi.mock('../../../core/services/persisted-sessions-dir', () => ({ PERSISTED_SESSIONS_DIR: '/tmp/persisted' }))
vi.mock('../../../core/services/db', () => ({ readOpencodeSessionRows: mockReadRows }))
vi.mock('../../../core/services/delete-session-files', () => ({ deleteSessionFiles: mockDeleteSessionFiles }))

import {
  listOpencodeSessionsGlobal,
  loadOpencodeSessionHistory,
  deleteOpencodeSession
} from '../../../core/services/opencode-session-list'
import { deleteSessionByEngine } from '../../../core/services/session-delete'

beforeEach(() => {
  mockAcquire.mockReset().mockResolvedValue({ baseUrl: 'http://127.0.0.1:1', authHeader: 'Basic x' })
  mockRelease.mockReset()
  mockListMessages.mockReset()
  mockDeleteSession.mockReset()
  mockReadRows.mockReset()
  mockDeleteSessionFiles.mockReset().mockResolvedValue(undefined)
  MockOpencodeClient.mockReset().mockImplementation(function () {
    return { listMessages: mockListMessages, deleteSession: mockDeleteSession }
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
      { id: 'ph', directory: '/d', title: 'New session - 2026-06-26T10:20:30.123Z', timeCreated: 1, timeUpdated: 3 },
      // child-session placeholder variant
      { id: 'ch', directory: '/d', title: 'Child session - 2026-06-26T10:20:30.123Z', timeCreated: 1, timeUpdated: 2 },
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

describe('listOpencodeSessionsGlobal — Claude-format projectKey (merge regression guard)', () => {
  it('emits projectKey in Claude-format (D--WorkPlace-ClaudeUI) not forward-slash format', async () => {
    mockReadRows.mockReturnValue([
      { id: 'ses_1', directory: 'D:/WorkPlace/ClaudeUI', title: 'Test', timeCreated: 1, timeUpdated: 2 }
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
    expect(mockAcquire).toHaveBeenCalledWith('/tmp/persisted')
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
