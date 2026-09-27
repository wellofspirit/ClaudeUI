/**
 * @vitest-environment node
 *
 * A resume target with no transcript on disk spawns FRESH.
 *
 * Incident: session `2844ac32` was spawned with `--resume 2844ac32` for a
 * transcript that never existed (a cli.js spawned but never prompted leaves
 * none), cli.js exited `No conversation found with session ID …`, and the
 * renderer's retry did exactly the same. The renderer has four paths that pick
 * a resume; the decision is made once, here, in the constructor.
 *
 * Mock scaffold mirrors `claude-session-relocated-transcript.test.ts`; os.homedir
 * is pointed at a temp dir so nothing touches the real ~/.claude.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import * as fs from 'fs'
import * as nodePath from 'path'
import { subscribeWindowToSync } from '../../../test/helpers/sync-subscriber-window'
import { clearSyncSubscribersForTests } from '../sync-host'

// ONE temp home for the file, created while mocks are hoisted: modules in
// ClaudeSession's import graph read os.homedir() at LOAD time.
const { TEMP_HOME } = await vi.hoisted(async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  return { TEMP_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'claude-resume-missing-')) }
})

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    homedir: () => TEMP_HOME,
    default: { ...actual, homedir: () => TEMP_HOME }
  }
})

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
vi.mock('../cross-engine-dispatcher', () => ({
  crossEngineDispatcher: { dispatch: vi.fn(), resolveApproval: vi.fn(), disposeFor: vi.fn() },
  crossEngineDispatchAvailable: (): boolean => false
}))
const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
vi.mock('../logger', () => ({ logger: mockLogger }))
vi.mock('../ui-config', () => ({
  saveSlashCommands: vi.fn(),
  loadEngineConfig: vi.fn(() => ({}))
}))
vi.mock('../claude-mcp', () => ({
  loadMcpServers: vi.fn(() => ({})),
  readDisabledMcpServers: vi.fn(() => [])
}))
const { mockComputeTokenMetrics } = vi.hoisted(() => ({
  mockComputeTokenMetrics: vi.fn(async (_path: string, _model?: string) => ({
    totalTokens: 0,
    totalCostUsd: 0
  }))
}))
vi.mock('../session-history', () => ({
  computeTokenMetrics: mockComputeTokenMetrics,
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
vi.mock('../../../main/services/account-manager', () => ({
  accountManager: { getState: vi.fn(() => ({ enabled: false, activeId: null })) }
}))
vi.mock('../../../main/auth/ClaudeAuthProvider', () => ({
  claudeAuthProvider: { buildAccountRef: vi.fn(() => null), updateAuthSource: vi.fn() }
}))
const { mockReadAgentIdentity } = vi.hoisted(() => ({ mockReadAgentIdentity: vi.fn() }))
vi.mock('../agent-identity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent-identity')>()
  return { ...actual, readAgentIdentity: mockReadAgentIdentity }
})

// Import AFTER mocks.
import { ClaudeSession } from '../claude-session'
import type { BrowserWindow } from 'electron'
import { emptyAgentIdentity } from '../agent-identity'
import type { EngineSpawnOptions } from '../../providers/ISession'

const REPO = '/r/repo'
const HOME_KEY = '-r-repo'
const WORKTREE_KEY = '-r-repo--claude-worktrees-wt'

const live: ClaudeSession[] = []

beforeEach(() => {
  mockReadAgentIdentity.mockResolvedValue(emptyAgentIdentity())
})

afterEach(() => {
  for (const s of live.splice(0)) s.cancel()
  clearSyncSubscribersForTests()
  fs.rmSync(nodePath.join(TEMP_HOME, '.claude', 'projects'), { recursive: true, force: true })
  vi.clearAllMocks()
})

afterAll(() => {
  fs.rmSync(TEMP_HOME, { recursive: true, force: true })
})

function seed(projectKey: string, sessionId: string): void {
  const dir = nodePath.join(TEMP_HOME, '.claude', 'projects', projectKey)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(nodePath.join(dir, `${sessionId}.jsonl`), '{}\n')
}

function makeFakeQueryHandle(
  messages: Array<Record<string, unknown>>
): AsyncIterable<unknown> & Record<string, unknown> {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
      for (const m of messages) yield m
    },
    initializationResult: (): Promise<never> => new Promise<never>(() => {}),
    interrupt: vi.fn(async () => {})
  }
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
  subscribeWindowToSync(
    win as unknown as { webContents: { send: (c: string, ...a: unknown[]) => void } }
  )
  return { win, sent }
}

/** Construct, run one prompt, and return the options cli.js was spawned with. */
async function spawnOptions(
  routingId: string,
  opts: EngineSpawnOptions,
  wire: Array<Record<string, unknown>> = []
): Promise<{ options: Record<string, unknown>; sent: Array<[string, string, unknown]> }> {
  mockQuery.mockImplementation(() => makeFakeQueryHandle(wire))
  const { win, sent } = makeWin()
  const session = new ClaudeSession(routingId, win, REPO, opts)
  live.push(session)
  await session.run('go')
  expect(mockQuery).toHaveBeenCalledTimes(1)
  const [{ options }] = mockQuery.mock.calls[0] as [{ options: Record<string, unknown> }]
  return { options, sent }
}

describe('ClaudeSession — a resume target with no transcript', () => {
  it('spawns fresh (no `resume`) and skips both seeds', async () => {
    const { options } = await spawnOptions('ghost', { resumeSessionId: 'ghost' })

    // PRE-FIX: `resume: 'ghost'` → cli.js exits "No conversation found".
    expect(options).not.toHaveProperty('resume')
    expect(options).not.toHaveProperty('forkSession')
    expect(mockComputeTokenMetrics).not.toHaveBeenCalled()
    expect(mockReadAgentIdentity).not.toHaveBeenCalled()
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'ClaudeSession',
      'Resume target ghost has no transcript on disk — starting fresh'
    )
  })

  it('reports the id cli.js mints, which is what rekeys the session off the dead id', async () => {
    const { options, sent } = await spawnOptions('ghost', { resumeSessionId: 'ghost' }, [
      { type: 'system', subtype: 'init', session_id: 'minted', model: 'claude-sonnet-4-6' }
    ])
    expect(options).not.toHaveProperty('resume')
    // `session:status` carrying a sessionId ≠ routingId is the rekey trigger
    // (sync-core `pendingRekeyFor` → reducer `rekeyTargetFor`).
    const statuses = sent
      .filter(([c, rid]) => c === 'session:status' && rid === 'ghost')
      .map(([, , d]) => (d as { sessionId?: string | null }).sessionId)
    expect(statuses).toContain('minted')
  })

  it('keeps `resume` when the transcript is where cwd says', async () => {
    seed(HOME_KEY, 'real')
    const { options } = await spawnOptions('real', { resumeSessionId: 'real' })
    expect(options.resume).toBe('real')
    expect(mockReadAgentIdentity).toHaveBeenCalledTimes(1)
    expect(mockLogger.warn).not.toHaveBeenCalledWith(
      'ClaudeSession',
      expect.stringContaining('has no transcript on disk')
    )
  })

  it('keeps `resume` for a transcript cli.js relocated into a worktree project dir', async () => {
    seed(WORKTREE_KEY, 'moved')
    const { options } = await spawnOptions('moved', { resumeSessionId: 'moved' })
    expect(options.resume).toBe('moved')
  })

  it('leaves a fork with a missing SOURCE unchanged — that is a real error, not a fresh start', async () => {
    const { options } = await spawnOptions('branch-rid', {
      resumeSessionId: 'gone-source',
      resumeSessionAt: 'anchor-uuid',
      forkSession: true
    })
    expect(options.resume).toBe('gone-source')
    expect(options.resumeSessionAt).toBe('anchor-uuid')
    expect(options.forkSession).toBe(true)
    // The identity seed still runs for a fork, exactly as before.
    expect(mockReadAgentIdentity).toHaveBeenCalledTimes(1)
  })
})
