/**
 * @vitest-environment node
 *
 * Layer 1 unit tests for worktree service.
 *
 * Uses real temp git repos via makeTempGitRepo(). simple-git is NOT mocked —
 * we want to catch regressions in the actual `git worktree` CLI argument
 * shapes and porcelain output parsing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { simpleGit } from 'simple-git'
import { makeTempGitRepo, type TempGitRepo } from '../../../test/helpers/temp-git-repo'

// Silence logger writes during tests.
vi.mock('../../../core/services/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}))

// Import after the mock is registered.
import { createWorktree, removeWorktree, getWorktreeStatus } from '../../../core/services/worktree'
import type { HolderSources } from '../../../core/services/worktree-holders'

/** The legacy entry point needs holder sources; none of these tests has a session. */
const noHolders: { sources: HolderSources } = {
  sources: { sessions: () => [], xAgents: () => [], terminals: () => [] }
}

// ---------------------------------------------------------------------------
// createWorktree
// ---------------------------------------------------------------------------

describe('createWorktree', () => {
  let repo: TempGitRepo

  beforeEach(async () => {
    repo = await makeTempGitRepo()
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  it('creates a worktree directory and checks out a named branch', async () => {
    const info = await createWorktree(repo.path, 'feature-x')

    expect(info.worktreeName).toBe('feature-x')
    expect(info.worktreeBranch).toBe('worktree-feature-x')
    expect(info.originalCwd).toBe(repo.path)
    expect(info.gitRoot).toBeTruthy()
    expect(info.originalHeadCommit).toMatch(/^[0-9a-f]{40}$/)
    expect(info.createdAt).toBeGreaterThan(0)

    // Worktree dir exists
    expect(fs.existsSync(info.worktreePath)).toBe(true)
    // Worktree path lives inside the .claude/worktrees folder
    expect(info.worktreePath.includes(path.join('.claude', 'worktrees'))).toBe(true)
    // HEAD of the worktree resolves to the expected branch
    const wtGit = simpleGit(info.worktreePath)
    const branch = (await wtGit.revparse(['--abbrev-ref', 'HEAD'])).trim()
    expect(branch).toBe('worktree-feature-x')
  })

  it('fails cleanly when the target worktree path already exists', async () => {
    // First create succeeds
    const first = await createWorktree(repo.path, 'dup')
    expect(fs.existsSync(first.worktreePath)).toBe(true)

    // Second call with the same name should throw — git refuses because
    // both the worktree dir and the branch are already taken.
    await expect(createWorktree(repo.path, 'dup')).rejects.toThrow()
  })

  it('copies .claude/settings.local.json into the worktree when present', async () => {
    // Seed a settings file before creating the worktree
    await repo.writeFile('.claude/settings.local.json', '{"ok":true}')
    const info = await createWorktree(repo.path, 'seeded')

    const copied = path.join(info.worktreePath, '.claude', 'settings.local.json')
    expect(fs.existsSync(copied)).toBe(true)
    expect(await fs.promises.readFile(copied, 'utf-8')).toBe('{"ok":true}')
  })
})

// ---------------------------------------------------------------------------
// removeWorktree
// ---------------------------------------------------------------------------

describe('removeWorktree', () => {
  let repo: TempGitRepo

  beforeEach(async () => {
    repo = await makeTempGitRepo()
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  it('removes the worktree directory AND deletes the branch', async () => {
    const info = await createWorktree(repo.path, 'to-remove')
    expect(fs.existsSync(info.worktreePath)).toBe(true)

    // Verify the branch exists before removal
    const branchesBefore = await simpleGit(repo.path).branch()
    expect(branchesBefore.all).toContain(info.worktreeBranch)

    await removeWorktree(info.worktreePath, info.worktreeBranch, info.gitRoot, noHolders)

    // Both dir and branch are gone
    expect(fs.existsSync(info.worktreePath)).toBe(false)
    const branchesAfter = await simpleGit(repo.path).branch()
    expect(branchesAfter.all).not.toContain(info.worktreeBranch)
  })

  it('force-removes a worktree with uncommitted changes', async () => {
    const info = await createWorktree(repo.path, 'dirty')

    // Introduce an uncommitted change in the worktree
    const dirtyFile = path.join(info.worktreePath, 'dirty.txt')
    await fs.promises.writeFile(dirtyFile, 'uncommitted\n', 'utf-8')
    const wtGit = simpleGit(info.worktreePath)
    await wtGit.add('dirty.txt')

    // removeWorktree uses --force internally, so dirty state should not block.
    await removeWorktree(info.worktreePath, info.worktreeBranch, info.gitRoot, noHolders)
    expect(fs.existsSync(info.worktreePath)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// removeWorktree — containment + branch protection (audit C2)
// ---------------------------------------------------------------------------

describe('removeWorktree containment', () => {
  let repo: TempGitRepo
  let outside: string

  beforeEach(async () => {
    repo = await makeTempGitRepo()
    // A sibling directory OUTSIDE the repo entirely — the classic C2 target.
    outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'claudeui-outside-'))
    await fs.promises.writeFile(path.join(outside, 'keepme.txt'), 'precious\n', 'utf-8')
  })

  afterEach(async () => {
    await repo.cleanup()
    try {
      await fs.promises.rm(outside, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      /* ignore */
    }
  })

  it('refuses to remove a path outside the managed worktrees directory (and never rm -rf it)', async () => {
    await expect(removeWorktree(outside, 'main', repo.path, noHolders)).rejects.toThrow(
      /outside the managed directory/
    )
    // The out-of-tree directory and its contents are untouched.
    expect(fs.existsSync(outside)).toBe(true)
    expect(fs.existsSync(path.join(outside, 'keepme.txt'))).toBe(true)
  })

  it('refuses to remove the repository root itself', async () => {
    await expect(removeWorktree(repo.path, 'main', repo.path, noHolders)).rejects.toThrow(
      /not a worktree of its repository/
    )
    expect(fs.existsSync(path.join(repo.path, 'README.md'))).toBe(true)
  })

  it('a contained non-worktree path is handled without touching anything outside', async () => {
    // A stray directory inside .claude/worktrees that is NOT a registered worktree.
    const stray = path.join(repo.path, '.claude', 'worktrees', 'stray')
    await fs.promises.mkdir(stray, { recursive: true })
    await fs.promises.writeFile(path.join(stray, 'f.txt'), 'x\n', 'utf-8')

    await expect(removeWorktree(stray, 'main', repo.path, noHolders)).resolves.toMatchObject({
      outcome: 'removed'
    })
    expect(fs.existsSync(stray)).toBe(false)

    // Nothing outside the repo was affected.
    expect(fs.existsSync(path.join(outside, 'keepme.txt'))).toBe(true)
  })

  it('derives the branch from git records — a renderer-supplied branch name is ignored', async () => {
    const info = await createWorktree(repo.path, 'inject')
    // A valuable, non-checked-out branch the renderer must not be able to target
    // by passing its name as the "branch" argument.
    await simpleGit(repo.path).raw(['branch', 'important-release'])

    // Malicious/incorrect renderer-supplied branch.
    await removeWorktree(info.worktreePath, 'important-release', info.gitRoot, noHolders)

    const branches = await simpleGit(repo.path).branch()
    // The targeted branch survives; only the porcelain-derived branch is removed.
    expect(branches.all).toContain('important-release')
    expect(branches.all).not.toContain('worktree-inject')
    expect(fs.existsSync(info.worktreePath)).toBe(false)
  })

  it('never deletes main/master even when passed as the branch argument', async () => {
    const info = await createWorktree(repo.path, 'safe')
    await removeWorktree(info.worktreePath, 'main', info.gitRoot, noHolders)

    const branches = await simpleGit(repo.path).branch()
    expect(branches.all).toContain('main')
    expect(branches.all).not.toContain('worktree-safe')
    expect(fs.existsSync(info.worktreePath)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// createWorktree — name validation (audit M-GT3)
// ---------------------------------------------------------------------------

describe('createWorktree name validation', () => {
  let repo: TempGitRepo

  beforeEach(async () => {
    repo = await makeTempGitRepo()
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  it.each(['../evil', '..', '.', 'a/b', 'a\\b', '', 'foo/../../etc', '.hidden', ' leading'])(
    'rejects unsafe name %j',
    async (name) => {
      await expect(createWorktree(repo.path, name)).rejects.toThrow(/Invalid worktree name/)
      // No directory should have been created under the managed root.
      const base = path.join(repo.path, '.claude', 'worktrees')
      if (fs.existsSync(base)) {
        const entries = await fs.promises.readdir(base)
        expect(entries).toEqual([])
      }
    }
  )

  it('accepts a valid name with the allowed punctuation set', async () => {
    const info = await createWorktree(repo.path, 'ok_name-1.2')
    expect(info.worktreeName).toBe('ok_name-1.2')
    expect(fs.existsSync(info.worktreePath)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// getWorktreeStatus
// ---------------------------------------------------------------------------

describe('getWorktreeStatus', () => {
  let repo: TempGitRepo

  beforeEach(async () => {
    repo = await makeTempGitRepo()
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  it('returns zero counts for a freshly-created clean worktree', async () => {
    const info = await createWorktree(repo.path, 'clean')
    const status = await getWorktreeStatus(info.worktreePath, info.originalHeadCommit)

    expect(status.uncommittedFiles).toBe(0)
    expect(status.commitsAhead).toBe(0)
    expect(status.files).toEqual([])
  })

  it('reports uncommitted files and commits-ahead count', async () => {
    const info = await createWorktree(repo.path, 'busy')
    const wtGit = simpleGit(info.worktreePath)

    // One tracked file change that becomes a commit (commits ahead)
    const trackedFile = path.join(info.worktreePath, 'tracked.txt')
    await fs.promises.writeFile(trackedFile, 'first change\n', 'utf-8')
    await wtGit.add('tracked.txt')
    await wtGit.addConfig('user.name', 'Test User')
    await wtGit.addConfig('user.email', 'test@example.com')
    await wtGit.commit('first change on worktree branch')

    // Another uncommitted file
    const dirtyFile = path.join(info.worktreePath, 'dirty.txt')
    await fs.promises.writeFile(dirtyFile, 'uncommitted\n', 'utf-8')

    const status = await getWorktreeStatus(info.worktreePath, info.originalHeadCommit)
    expect(status.commitsAhead).toBe(1)
    expect(status.uncommittedFiles).toBe(1)
    expect(status.files).toContain('dirty.txt')
  })
})
