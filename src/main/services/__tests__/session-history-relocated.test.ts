/**
 * @vitest-environment node
 *
 * Worktree-relocated Claude transcripts (cli.js `EnterWorktree`).
 *
 * cli.js moves the live transcript into the worktree path's project dir
 * (`…/repo/.claude/worktrees/wt` → `-r-repo--claude-worktrees-wt`) and appends
 * `relocated` lines, but the first user entry keeps the ORIGINAL cwd. Keyed by
 * directory, `listDirectories` showed that session as a second project with the
 * same label, and `resolveForkAnchor` — which derived the path from cwd — could
 * not find it, so branching from it failed.
 *
 * Drives the real module against a temp ~/.claude (os.homedir mocked the way
 * `session-history-projectkey.test.ts` does it).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as nodePath from 'path'
import * as nodeOs from 'os'

let TEMP_HOME = ''

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    homedir: () => TEMP_HOME,
    default: { ...actual, homedir: () => TEMP_HOME }
  }
})

beforeEach(() => {
  TEMP_HOME = fs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'relocated-test-'))
})

afterEach(() => {
  if (TEMP_HOME && fs.existsSync(TEMP_HOME)) {
    fs.rmSync(TEMP_HOME, { recursive: true, force: true })
  }
  vi.clearAllMocks()
})

/** Fresh import: the module captures ~/.claude/projects at load time. */
async function freshHistory(): Promise<typeof import('../../../core/services/session-history')> {
  vi.resetModules()
  return import('../../../core/services/session-history')
}

const REPO = '/r/repo'
const WORKTREE = '/r/repo/.claude/worktrees/wt'
const HOME_KEY = '-r-repo'
const WORKTREE_KEY = '-r-repo--claude-worktrees-wt'

/**
 * Write a transcript whose FIRST prompt ran in `firstCwd`. `relocatedTo` appends
 * the line cli.js writes when it moves the file into a worktree's project dir.
 */
function seedTranscript(
  projectKey: string,
  sessionId: string,
  firstCwd: string,
  opts: { relocatedTo?: string; mtimeSec?: number } = {}
): string {
  const dir = nodePath.join(TEMP_HOME, '.claude', 'projects', projectKey)
  fs.mkdirSync(dir, { recursive: true })
  const lines: Array<Record<string, unknown>> = [
    {
      type: 'user',
      userType: 'external',
      uuid: `u-${sessionId}`,
      cwd: firstCwd,
      sessionId,
      timestamp: '2026-09-20T00:00:00.000Z',
      message: { role: 'user', content: `prompt of ${sessionId}` }
    },
    {
      type: 'assistant',
      uuid: `anchor-${sessionId}`,
      cwd: firstCwd,
      sessionId,
      message: { id: `msg_${sessionId}`, content: [{ type: 'text', text: 'hello' }] }
    }
  ]
  if (opts.relocatedTo) {
    lines.push({ type: 'relocated', sessionId, relocatedCwd: opts.relocatedTo })
  }
  const file = nodePath.join(dir, `${sessionId}.jsonl`)
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  if (opts.mtimeSec) fs.utimesSync(file, opts.mtimeSec, opts.mtimeSec)
  return file
}

describe('listDirectories — a relocated session stays in its home project', () => {
  it('merges a relocated session into its home group, keeping its own file key', async () => {
    seedTranscript(HOME_KEY, 'sess-a', REPO, { mtimeSec: 1_000 })
    seedTranscript(WORKTREE_KEY, 'sess-b', REPO, { relocatedTo: WORKTREE, mtimeSec: 2_000 })

    const { listDirectories } = await freshHistory()
    const groups = await listDirectories()

    // PRE-FIX: two groups, both labelled `repo` (same cwd, different key).
    expect(groups).toHaveLength(1)
    const [group] = groups
    expect(group.projectKey).toBe(HOME_KEY)
    expect(group.cwd).toBe(REPO)
    expect(group.folderName).toBe('repo')
    // Newest first, as before.
    expect(group.sessions.map((s) => s.sessionId)).toEqual(['sess-b', 'sess-a'])
    // Each session still names the dir its FILE lives in — history / watch /
    // rename / single delete address the file through it.
    const byId = Object.fromEntries(group.sessions.map((s) => [s.sessionId, s]))
    expect(byId['sess-a'].projectKey).toBe(HOME_KEY)
    expect(byId['sess-b'].projectKey).toBe(WORKTREE_KEY)
  })

  it('builds the home group even when the home dir does not exist', async () => {
    seedTranscript(WORKTREE_KEY, 'sess-b', REPO, { relocatedTo: WORKTREE })

    const { listDirectories } = await freshHistory()
    const groups = await listDirectories()

    expect(groups).toHaveLength(1)
    expect(groups[0].projectKey).toBe(HOME_KEY)
    expect(groups[0].cwd).toBe(REPO)
    expect(groups[0].folderName).toBe('repo')
    expect(groups[0].sessions.map((s) => [s.sessionId, s.projectKey])).toEqual([
      ['sess-b', WORKTREE_KEY]
    ])
  })

  it('keeps a session BORN in the worktree in its own group (out of scope, unchanged)', async () => {
    seedTranscript(HOME_KEY, 'sess-a', REPO, { mtimeSec: 1_000 })
    seedTranscript(WORKTREE_KEY, 'sess-w', WORKTREE, { mtimeSec: 2_000 })

    const { listDirectories } = await freshHistory()
    const groups = await listDirectories()

    expect(groups.map((g) => [g.projectKey, g.cwd, g.sessions.map((s) => s.sessionId)])).toEqual([
      [WORKTREE_KEY, WORKTREE, ['sess-w']],
      [HOME_KEY, REPO, ['sess-a']]
    ])
  })

  it('a relocated member and a worktree-born session in the SAME dir split correctly', async () => {
    seedTranscript(HOME_KEY, 'sess-a', REPO, { mtimeSec: 1_000 })
    seedTranscript(WORKTREE_KEY, 'sess-b', REPO, { relocatedTo: WORKTREE, mtimeSec: 3_000 })
    seedTranscript(WORKTREE_KEY, 'sess-w', WORKTREE, { mtimeSec: 2_000 })

    const { listDirectories } = await freshHistory()
    const groups = await listDirectories()

    expect(groups.map((g) => [g.projectKey, g.sessions.map((s) => s.sessionId)])).toEqual([
      [HOME_KEY, ['sess-b', 'sess-a']],
      [WORKTREE_KEY, ['sess-w']]
    ])
    // The worktree group's label comes from its own session, not the relocated one.
    expect(groups[1].cwd).toBe(WORKTREE)
  })
})

describe('resolveForkAnchor — a relocated transcript', () => {
  it('finds the transcript under the worktree key from the session’s ORIGINAL cwd', async () => {
    seedTranscript(WORKTREE_KEY, 'sess-b', REPO, { relocatedTo: WORKTREE })

    const { resolveForkAnchor } = await freshHistory()
    const res = await resolveForkAnchor('sess-b', REPO, 'msg_sess-b', 'claude', 0)

    // PRE-FIX: the path was derived from REPO → `-r-repo/sess-b.jsonl` →
    // 'transcript-not-found', so branching from a relocated session failed.
    expect(res.reason).toBeUndefined()
    expect(res.anchorUuid).toBe('anchor-sess-b')
  })

  it('still reports transcript-not-found when no dir holds it', async () => {
    seedTranscript(HOME_KEY, 'other', REPO)
    const { resolveForkAnchor } = await freshHistory()
    const res = await resolveForkAnchor('ghost', REPO, 'msg_x', 'claude', 0)
    expect(res).toEqual({ anchorUuid: null, reason: 'transcript-not-found' })
  })
})
