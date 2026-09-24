/**
 * @vitest-environment node
 *
 * Canonical's resume seed (`create-session.ts` `seedCanonicalTranscript`) reads
 * a worktree-relocated Claude transcript from where it actually lives.
 *
 * cli.js's `EnterWorktree` moves the transcript into the worktree path's
 * project dir while the session's cwd still derives the ORIGINAL key, so a
 * seed that derived its projectKey from cwd read nothing and every client
 * resumed that session onto an empty canonical transcript.
 *
 * Only the seam is driven: the engine sessions and spawn preps are stubbed
 * (this is not a spawn test), and `readSessionHistory` is the spy — the
 * projectKey it is handed is the whole assertion. os.homedir points at a temp
 * dir so nothing touches the real ~/.claude.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as nodePath from 'path'

// One temp home for the file, created while mocks are hoisted — modules in the
// import graph read os.homedir() at LOAD time.
const { TEMP_HOME } = await vi.hoisted(async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  return { TEMP_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'create-seed-relocated-')) }
})

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    homedir: () => TEMP_HOME,
    default: { ...actual, homedir: () => TEMP_HOME }
  }
})

vi.mock('../../../core/services/claude-session', () => ({ ClaudeSession: class {} }))
vi.mock('../../../core/opencode/OpencodeSession', () => ({ OpencodeSession: class {} }))
vi.mock('../../../core/pi/PiSession', () => ({ PiSession: class {} }))
vi.mock('../../../core/codex/CodexSession', () => ({ CodexSession: class {} }))
vi.mock('../../../core/providers/claude-spawn-prep', () => ({
  claudeSpawnPrep: vi.fn(async (model?: string) => ({ resolvedModel: model }))
}))
vi.mock('../../../core/opencode/opencode-spawn-prep', () => ({
  opencodeSpawnPrep: vi.fn(async (model?: string) => ({ resolvedModel: model }))
}))
vi.mock('../../../core/pi/pi-spawn-prep', () => ({
  piSpawnPrep: vi.fn(async (model?: string) => ({ resolvedModel: model }))
}))
vi.mock('../../../core/services/ui-config', () => ({ loadEngineConfig: () => ({}) }))
vi.mock('../../../core/services/cross-engine-dispatcher', () => ({
  crossEngineDispatcher: { dispatch: vi.fn(), stopDispatch: vi.fn(), disposeFor: vi.fn() },
  crossEngineDispatchAvailable: () => false
}))
vi.mock('../../../core/services/db', () => ({ getSessionMeta: () => undefined }))
const { readSessionHistory } = vi.hoisted(() => ({
  readSessionHistory: vi.fn(
    async (_id: string, _key: string, _anchor?: string, _engine?: string) => ({
      messages: [],
      taskNotifications: [],
      customTitle: null,
      statusLine: null,
      agentIdToToolUseId: {},
      warnings: []
    })
  )
}))
vi.mock('../../../core/services/engine-history', () => ({ readSessionHistory }))

// Import AFTER mocks.
import { prepareAndCreateSession } from '../../../core/ipc/create-session'
import { syncCore } from '../../../core/services/sync-host'

const REPO = '/r/repo'
const HOME_KEY = '-r-repo'
const WORKTREE_KEY = '-r-repo--claude-worktrees-wt'

function seed(projectKey: string, sessionId: string): void {
  const dir = nodePath.join(TEMP_HOME, '.claude', 'projects', projectKey)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(nodePath.join(dir, `${sessionId}.jsonl`), '{}\n')
}

async function resume(sessionId: string, engineId?: 'claude' | 'opencode'): Promise<void> {
  const manager = { create: vi.fn() } as never
  await prepareAndCreateSession(manager, null, {
    routingId: `rid-${sessionId}`,
    cwd: REPO,
    resumeSessionId: sessionId,
    engineId
  })
}

afterEach(() => {
  fs.rmSync(nodePath.join(TEMP_HOME, '.claude', 'projects'), { recursive: true, force: true })
  syncCore.resetCanonicalForTests()
  vi.clearAllMocks()
})

afterAll(() => {
  fs.rmSync(TEMP_HOME, { recursive: true, force: true })
})

describe('seedCanonicalTranscript — a worktree-relocated Claude transcript', () => {
  it('reads the transcript from the worktree project dir it was moved to', async () => {
    seed(WORKTREE_KEY, 'sess-b')
    await resume('sess-b', 'claude')
    // PRE-FIX: `cwdToProjectKey(REPO)` → '-r-repo', where the file is not.
    expect(readSessionHistory.mock.calls[0]?.[1]).toBe(WORKTREE_KEY)
  })

  it('a caller that omits engineId is Claude too (the legacy default)', async () => {
    seed(WORKTREE_KEY, 'sess-b')
    await resume('sess-b')
    expect(readSessionHistory.mock.calls[0]?.[1]).toBe(WORKTREE_KEY)
  })

  it('keeps the cwd-derived key when the transcript is where cwd says', async () => {
    seed(HOME_KEY, 'sess-a')
    await resume('sess-a', 'claude')
    expect(readSessionHistory.mock.calls[0]?.[1]).toBe(HOME_KEY)
  })

  it('leaves other engines on the cwd-derived key (they ignore it, and skip the scan)', async () => {
    // Even a same-id Claude file elsewhere must not steer another engine's read.
    seed(WORKTREE_KEY, 'oc-1')
    await resume('oc-1', 'opencode')
    expect(readSessionHistory.mock.calls[0]?.[1]).toBe(HOME_KEY)
  })
})
