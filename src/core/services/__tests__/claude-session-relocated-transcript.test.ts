/**
 * @vitest-environment node
 *
 * ClaudeSession finds a transcript cli.js relocated into a worktree's project
 * dir (`EnterWorktree`).
 *
 * `transcriptPathFor` used to DERIVE the path from `this.cwd`, so for a
 * relocated transcript the resume cost seed read nothing (logging `Resume seed
 * found no usable transcript at …/-…-repo/<sid>.jsonl` — the real incident), the
 * agent-identity seed came back empty, and the post-turn reconcile read a file
 * that no longer existed. The lookup is now LOCATED on every call, which also
 * covers a live session whose file moves mid-session.
 *
 * Mock scaffold mirrors `claude-session-agent-resume.test.ts`; os.homedir is
 * pointed at a temp dir so nothing touches the real ~/.claude.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import * as fs from 'fs'
import * as nodePath from 'path'

// ONE temp home for the file, created while mocks are hoisted: modules in
// ClaudeSession's import graph read os.homedir() at LOAD time, before any
// beforeEach could run. Each test clears the projects dir instead.
const { TEMP_HOME } = await vi.hoisted(async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  return { TEMP_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'claude-relocated-')) }
})

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    homedir: () => TEMP_HOME,
    default: { ...actual, homedir: () => TEMP_HOME }
  }
})

vi.mock('electron', async () => await import('../../../test/stubs/electron-shim'))
vi.mock('../../sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../sdk')>()
  return {
    ...actual,
    query: vi.fn(),
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
vi.mock('../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
vi.mock('../ui-config', () => ({
  saveSlashCommands: vi.fn(),
  loadEngineConfig: vi.fn(() => ({}))
}))
vi.mock('../claude-mcp', () => ({
  loadMcpServers: vi.fn(() => ({})),
  readDisabledMcpServers: vi.fn(() => [])
}))
// The cost seed's read — its path argument is what these tests pin.
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
// The identity seed's read — likewise, only the path it is handed matters here.
const { mockReadAgentIdentity } = vi.hoisted(() => ({ mockReadAgentIdentity: vi.fn() }))
vi.mock('../agent-identity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent-identity')>()
  return { ...actual, readAgentIdentity: mockReadAgentIdentity }
})

// Import AFTER mocks.
import { ClaudeSession } from '../claude-session'
import { emptyAgentIdentity } from '../agent-identity'

const REPO = '/r/repo'
const HOME_KEY = '-r-repo'
const WORKTREE_KEY = '-r-repo--claude-worktrees-wt'

const live: ClaudeSession[] = []

beforeEach(() => {
  mockReadAgentIdentity.mockResolvedValue(emptyAgentIdentity())
})

afterEach(() => {
  for (const s of live.splice(0)) s.cancel()
  fs.rmSync(nodePath.join(TEMP_HOME, '.claude', 'projects'), { recursive: true, force: true })
  vi.clearAllMocks()
})

afterAll(() => {
  fs.rmSync(TEMP_HOME, { recursive: true, force: true })
})

function transcriptPath(projectKey: string, sessionId: string): string {
  return nodePath.join(TEMP_HOME, '.claude', 'projects', projectKey, `${sessionId}.jsonl`)
}

function seed(projectKey: string, sessionId: string): string {
  const file = transcriptPath(projectKey, sessionId)
  fs.mkdirSync(nodePath.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{}\n')
  return file
}

function make(opts: ConstructorParameters<typeof ClaudeSession>[3] = {}): ClaudeSession {
  const session = new ClaudeSession('rid', null, REPO, opts)
  live.push(session)
  return session
}

describe('ClaudeSession — a worktree-relocated transcript', () => {
  it('seeds cost and agent identity from the RELOCATED transcript on resume', () => {
    const relocated = seed(WORKTREE_KEY, 'sess-b')

    make({ resumeSessionId: 'sess-b' })

    // PRE-FIX both were handed `-r-repo/sess-b.jsonl`, a file that does not
    // exist: the cost seed warned "found no usable transcript" and the resumed
    // session's agents were unknown until they spoke again.
    expect(mockComputeTokenMetrics.mock.calls[0]?.[0]).toBe(relocated)
    expect(mockReadAgentIdentity).toHaveBeenCalledWith(relocated)
  })

  it('still reads the cwd-derived transcript in the common case', () => {
    const home = seed(HOME_KEY, 'sess-a')
    make({ resumeSessionId: 'sess-a' })
    expect(mockReadAgentIdentity).toHaveBeenCalledWith(home)
  })

  it('getSessionLogPath follows a file that moves MID-session', () => {
    const session = make()
    ;(session as unknown as { sessionId: string }).sessionId = 'sess-live'

    // Not on disk yet: the derived path, which is where cli.js will write it.
    expect(session.getSessionLogPath()).toBe(transcriptPath(HOME_KEY, 'sess-live'))

    const home = seed(HOME_KEY, 'sess-live')
    expect(session.getSessionLogPath()).toBe(home)

    // `EnterWorktree` moves the live file. Resolved per call, so the post-turn
    // reconcile reads it where it now is rather than where the session began.
    const moved = transcriptPath(WORKTREE_KEY, 'sess-live')
    fs.mkdirSync(nodePath.dirname(moved), { recursive: true })
    fs.renameSync(home, moved)
    expect(session.getSessionLogPath()).toBe(moved)
  })
})
