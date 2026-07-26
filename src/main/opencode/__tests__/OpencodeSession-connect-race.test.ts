/**
 * @vitest-environment node
 *
 * M-OC1 guard: two prompts landing during the FIRST prompt's connect window
 * (client + openSessionId both null, up to ~15s) must create EXACTLY ONE
 * opencode session, and neither message may be lost. Before the fix both run()s
 * passed `!this.openSessionId` and called createSession — one session orphaned,
 * and the events filtered to the overwritten openSessionId vanished.
 *
 * Self-contained mock scaffold (mirrors OpencodeSession.test.ts) so no real
 * server/HTTP is spawned. The connect is deferred (mockAcquire gated) to hold
 * the window open while the second prompt lands.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'

class MockWindow extends EventEmitter {
  webContents = { send: vi.fn() }
  isDestroyed(): boolean {
    return false
  }
}

const {
  mockAcquire,
  mockRelease,
  mockCreateSession,
  mockGetSession,
  mockPromptAsync,
  mockPatchSession,
  mockSubscribeEvents,
  mockLoadClaudePermissions,
  mockLoadEngineConfig,
  mockListCommands,
  mockListSkills,
  MockOpencodeClient
} = vi.hoisted(() => ({
  mockAcquire: vi.fn(),
  mockRelease: vi.fn(),
  mockCreateSession: vi.fn(),
  mockGetSession: vi.fn(),
  mockPromptAsync: vi.fn(),
  mockPatchSession: vi.fn(),
  mockSubscribeEvents: vi.fn(),
  mockLoadClaudePermissions: vi.fn(),
  mockLoadEngineConfig: vi.fn(),
  mockListCommands: vi.fn(),
  mockListSkills: vi.fn(),
  MockOpencodeClient: vi.fn()
}))

vi.mock('../OpencodeServerManager', () => ({
  opencodeServerManager: { acquire: mockAcquire, release: mockRelease }
}))
vi.mock('../OpencodeClient', () => ({ OpencodeClient: MockOpencodeClient }))
vi.mock('../../services/claude-settings', () => ({
  loadClaudePermissions: mockLoadClaudePermissions,
  saveClaudePermissions: vi.fn()
}))
vi.mock('../../services/ui-config', () => ({ loadEngineConfig: mockLoadEngineConfig }))
vi.mock('../model-discovery', () => ({
  getOpencodeModelContextWindow: vi.fn().mockReturnValue(0),
  getOpencodeModelCapabilities: vi.fn().mockReturnValue(undefined),
  discoverOpencodeModels: vi.fn().mockResolvedValue([]),
  invalidateOpencodeModelCache: vi.fn(),
  parseModelString: (model: string) => {
    const slash = model.indexOf('/')
    return slash < 0
      ? { providerID: 'opencode', modelID: model }
      : { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) }
  }
}))
vi.mock('../command-skill-discovery', () => ({
  discoverOpencodeSkills: vi.fn().mockResolvedValue([])
}))

import { OpencodeSession } from '../OpencodeSession'
import type { BrowserWindow } from 'electron'
import type { OpencodeEvent } from '../protocol/types'

function parkUntilAborted(signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve()
    signal?.addEventListener('abort', () => resolve())
  })
}
// eslint-disable-next-line require-yield
const parkingStream = async function* (signal?: AbortSignal): AsyncGenerator<OpencodeEvent> {
  await parkUntilAborted(signal)
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

function makeSession(): OpencodeSession {
  const win = new MockWindow() as unknown as BrowserWindow
  return new OpencodeSession('routing_oc_race', win, '/tmp/test-cwd', { model: 'anthropic/claude' })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockLoadClaudePermissions.mockReturnValue({
    allow: [],
    deny: [],
    ask: [],
    additionalDirectories: [],
    defaultMode: undefined
  })
  mockLoadEngineConfig.mockReturnValue({ autoMode: { enabled: false } })
  mockCreateSession.mockResolvedValue({ id: 'ses_opencode_1' })
  mockGetSession.mockResolvedValue({ id: 'ses_opencode_1' })
  mockPromptAsync.mockResolvedValue(undefined)
  mockPatchSession.mockResolvedValue(undefined)
  mockListCommands.mockResolvedValue([])
  mockListSkills.mockResolvedValue([])
  mockSubscribeEvents.mockImplementation(parkingStream)
  MockOpencodeClient.mockImplementation(function () {
    return {
      createSession: mockCreateSession,
      getSession: mockGetSession,
      promptAsync: mockPromptAsync,
      patchSession: mockPatchSession,
      subscribeEvents: mockSubscribeEvents,
      listCommands: mockListCommands,
      listSkills: mockListSkills
    }
  })
})

describe('OpencodeSession — M-OC1: two prompts during the connect window', () => {
  it('creates exactly one session and delivers both prompts', async () => {
    // Gate the server acquire so the connect window stays open across both run()s.
    let releaseAcquire!: () => void
    const acquireGate = new Promise<void>((r) => {
      releaseAcquire = r
    })
    mockAcquire.mockImplementation(() =>
      acquireGate.then(() => ({ baseUrl: 'http://127.0.0.1:9999', authHeader: 'Basic test' }))
    )

    const session = makeSession()

    const p1 = session.run('alpha')
    const p2 = session.run('beta') // lands during the connect window
    await flush()

    // Neither createSession fired yet — connect still gated.
    expect(mockCreateSession).not.toHaveBeenCalled()

    releaseAcquire()
    await Promise.all([p1, p2])

    // Exactly ONE opencode session created (no orphan).
    expect(mockCreateSession).toHaveBeenCalledTimes(1)

    // Both prompts delivered to the SAME session — neither lost.
    expect(mockPromptAsync).toHaveBeenCalledTimes(2)
    const sessionIds = mockPromptAsync.mock.calls.map((c) => c[0])
    expect(new Set(sessionIds)).toEqual(new Set(['ses_opencode_1']))
    const texts = mockPromptAsync.mock.calls.map((c) => {
      const parts = (c[1] as { parts: Array<{ type: string; text?: string }> }).parts
      return parts.find((p) => p.type === 'text')?.text
    })
    expect(new Set(texts)).toEqual(new Set(['alpha', 'beta']))
  })
})
