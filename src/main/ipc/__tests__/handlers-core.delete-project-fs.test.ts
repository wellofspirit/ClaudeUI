/**
 * @vitest-environment node
 *
 * `deleteProject` over a REAL (temporary) `~/.claude/projects`, for the folded worktrees: what
 * survives on disk matters more here than which functions were called, so the file helpers are the
 * real ones and only `os.homedir()` is moved into a temp dir. The worktree folders themselves are
 * temp dirs too and must come out untouched.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as nodeOs from 'os'
import * as path from 'path'

const { home } = vi.hoisted(() => ({ home: { dir: '' } }))
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, default: { ...actual, homedir: () => home.dir }, homedir: () => home.dir }
})

vi.mock('../../../core/services/skill-scanner', () => ({ scanSkills: vi.fn(async () => []) }))
vi.mock('../../../core/services/claude-settings', () => ({ saveCleanupPeriodDays: vi.fn() }))
vi.mock('../../../core/services/ui-config', () => ({
  saveSessionConfig: vi.fn(),
  loadEngineConfig: vi.fn(() => ({}))
}))
vi.mock('../../../core/services/sync-seed', () => ({ refreshCanonicalDirectories: vi.fn() }))
vi.mock('../../../core/services/session-delete', () => ({
  deleteSessionByEngine: vi.fn(async () => true)
}))
vi.mock('../../../core/services/engine-history', () => ({
  readSessionHistory: vi.fn(async () => ({ messages: [], taskNotifications: [] }))
}))
vi.mock('../../../core/services/session-watcher', () => ({ unwatchSession: vi.fn() }))
vi.mock('../../../core/automode/judge-route', () => ({
  describeJudgeModels: vi.fn(),
  resolveJudgeRoute: vi.fn()
}))

import { deleteProject } from '../../../core/ipc/handlers-core'
import { syncCore } from '../../../core/services/sync-host'
import { cwdToProjectKey } from '../../../shared/project-key'

let tmp: string
let projects: string
let repo: string
let wtA: string
let wtB: string

const manager = (): any => ({ cancel: vi.fn(), get: vi.fn(), forEach: vi.fn() })

function transcript(key: string, id: string): string {
  const dir = path.join(projects, key)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${id}.jsonl`)
  fs.writeFileSync(file, '{}\n')
  return file
}

function worktreeGroup(cwd: string, name: string, ids: string[]): any {
  const projectKey = cwdToProjectKey(cwd)
  return {
    cwd,
    projectKey,
    folderName: name,
    linkedWorktree: { worktreePath: cwd, repoRoot: repo, name, branch: 'b' },
    sessions: ids.map((sessionId) => ({
      sessionId,
      cwd,
      projectKey,
      engineId: 'claude'
    }))
  }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(nodeOs.tmpdir(), 'delete-project-fold-'))
  home.dir = path.join(tmp, 'home')
  projects = path.join(home.dir, '.claude', 'projects')
  repo = path.join(tmp, 'repo')
  wtA = path.join(tmp, 'wt-a')
  wtB = path.join(tmp, 'wt-b')
  for (const d of [repo, wtA, wtB]) {
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, 'keep.txt'), 'work')
  }
  syncCore.resetCanonicalForTests()
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('deleteProject over folded worktrees (real files)', () => {
  it('a synthesised parent: its listed worktree transcripts go, its Claude folder (memory) survives', async () => {
    const parentKey = cwdToProjectKey(repo)
    const memory = path.join(projects, parentKey, 'memory', 'MEMORY.md')
    fs.mkdirSync(path.dirname(memory), { recursive: true })
    fs.writeFileSync(memory, 'remember')
    const unlisted = transcript(parentKey, 'unlisted')
    const a1 = transcript(cwdToProjectKey(wtA), 'a1')
    syncCore.setDirectories([worktreeGroup(wtA, 'wt-a', ['a1'])] as never)

    await deleteProject(manager(), parentKey)

    expect(fs.existsSync(a1)).toBe(false)
    expect(fs.existsSync(path.join(projects, cwdToProjectKey(wtA)))).toBe(false) // emptied
    expect(fs.readFileSync(memory, 'utf8')).toBe('remember')
    expect(fs.existsSync(unlisted)).toBe(true)
  })

  it('an existing parent keeps today’s rule; a worktree dir with other content stays, an empty one goes', async () => {
    const parentKey = cwdToProjectKey(repo)
    const parentFile = transcript(parentKey, 'p1')
    const a1 = transcript(cwdToProjectKey(wtA), 'a1')
    const b1 = transcript(cwdToProjectKey(wtB), 'b1')
    const stray = transcript(cwdToProjectKey(wtB), 'unlisted')
    const other = transcript(cwdToProjectKey(repo + '2'), 'o1')
    syncCore.setDirectories([
      {
        cwd: repo,
        projectKey: parentKey,
        folderName: 'repo',
        sessions: [{ sessionId: 'p1', cwd: repo, projectKey: parentKey, engineId: 'claude' }]
      },
      worktreeGroup(wtA, 'wt-a', ['a1']),
      worktreeGroup(wtB, 'wt-b', ['b1'])
    ] as never)

    await deleteProject(manager(), parentKey)

    expect(fs.existsSync(path.join(projects, parentKey))).toBe(false)
    expect(fs.existsSync(parentFile)).toBe(false)
    expect(fs.existsSync(a1)).toBe(false)
    expect(fs.existsSync(path.join(projects, cwdToProjectKey(wtA)))).toBe(false)
    expect(fs.existsSync(b1)).toBe(false)
    expect(fs.existsSync(stray)).toBe(true) // the worktree dir still holds an unlisted transcript
    expect(fs.existsSync(other)).toBe(true) // a similar key, another project
    // The worktree folders themselves are never touched.
    for (const d of [wtA, wtB])
      expect(fs.readFileSync(path.join(d, 'keep.txt'), 'utf8')).toBe('work')
  })

  it('a key the listing has no group for (stale request, worktrees gone since the dialog): memory survives', async () => {
    const parentKey = cwdToProjectKey(repo)
    const memory = path.join(projects, parentKey, 'memory', 'MEMORY.md')
    fs.mkdirSync(path.dirname(memory), { recursive: true })
    fs.writeFileSync(memory, 'remember')
    const transcriptFile = transcript(parentKey, 'unlisted')
    syncCore.setDirectories([] as never)

    await deleteProject(manager(), parentKey)

    expect(fs.readFileSync(memory, 'utf8')).toBe('remember')
    expect(fs.existsSync(transcriptFile)).toBe(true)
  })

  it('a worktree group asked for by its own key: its transcripts go, its folder only when empty', async () => {
    const wtKey = cwdToProjectKey(wtA)
    const a1 = transcript(wtKey, 'a1')
    const stray = transcript(wtKey, 'unlisted')
    syncCore.setDirectories([worktreeGroup(wtA, 'wt-a', ['a1'])] as never)

    await deleteProject(manager(), wtKey)

    expect(fs.existsSync(a1)).toBe(false)
    expect(fs.existsSync(stray)).toBe(true) // never `rm -r`
  })

  it('a live session no listing holds loses its transcript under its own cwd key; a lossy neighbour is untouched', async () => {
    const parentKey = cwdToProjectKey(repo)
    const memory = path.join(projects, parentKey, 'memory', 'MEMORY.md')
    fs.mkdirSync(path.dirname(memory), { recursive: true })
    fs.writeFileSync(memory, 'remember')
    const liveFile = transcript(cwdToProjectKey(wtA), 'live-1')
    const neighbour = transcript(cwdToProjectKey(wtB), 'neighbour')
    syncCore.setDirectories([worktreeGroup(wtA, 'wt-a', [])] as never)
    syncCore.emit('session:created', ['live-1', { cwd: wtA }])
    syncCore.emit('session:created', ['neighbour', { cwd: wtB }])

    await deleteProject(manager(), parentKey)

    expect(fs.existsSync(liveFile)).toBe(false)
    expect(fs.existsSync(neighbour)).toBe(true)
    expect(fs.readFileSync(memory, 'utf8')).toBe('remember')
  })

  it('repo "/a/b" without a root group and its worktree "/a-b" share one key dir: transcripts go, the dir’s memory stays', async () => {
    const wt = path.join(tmp, 'a-b')
    const root = path.join(tmp, 'a', 'b')
    // Same lossy key on purpose: build the group by hand.
    const key = cwdToProjectKey(wt)
    fs.mkdirSync(wt, { recursive: true })
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(wt, 'keep.txt'), 'work')
    const memory = path.join(projects, key, 'memory', 'MEMORY.md')
    fs.mkdirSync(path.dirname(memory), { recursive: true })
    fs.writeFileSync(memory, 'remember')
    const t1 = transcript(key, 'w1')
    syncCore.setDirectories([
      {
        cwd: wt,
        projectKey: key,
        folderName: 'a-b',
        linkedWorktree: { worktreePath: wt, repoRoot: root, name: 'a-b', branch: 'b' },
        sessions: [{ sessionId: 'w1', cwd: wt, projectKey: key, engineId: 'claude' }]
      }
    ] as never)

    await deleteProject(manager(), cwdToProjectKey(root))

    expect(fs.existsSync(t1)).toBe(false)
    expect(fs.readFileSync(memory, 'utf8')).toBe('remember')
    expect(fs.readFileSync(path.join(wt, 'keep.txt'), 'utf8')).toBe('work')
  })

  it('a new folder with only live sessions: their transcripts go, the folder’s memory survives', async () => {
    const fresh = path.join(tmp, 'fresh')
    fs.mkdirSync(fresh, { recursive: true })
    const key = cwdToProjectKey(fresh)
    const memory = path.join(projects, key, 'memory', 'MEMORY.md')
    fs.mkdirSync(path.dirname(memory), { recursive: true })
    fs.writeFileSync(memory, 'remember')
    const t1 = transcript(key, 'live-1')
    const listedElsewhere = transcript(cwdToProjectKey(repo), 'p1')
    syncCore.setDirectories([
      {
        cwd: repo,
        projectKey: cwdToProjectKey(repo),
        folderName: 'repo',
        sessions: [
          { sessionId: 'p1', cwd: repo, projectKey: cwdToProjectKey(repo), engineId: 'claude' }
        ]
      }
    ] as never)
    syncCore.emit('session:created', ['live-1', { cwd: fresh }])

    await deleteProject(manager(), key)

    expect(fs.existsSync(t1)).toBe(false)
    expect(fs.readFileSync(memory, 'utf8')).toBe('remember')
    expect(fs.existsSync(listedElsewhere)).toBe(true)
  })
})
