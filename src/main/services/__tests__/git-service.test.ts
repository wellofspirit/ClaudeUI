/**
 * @vitest-environment node
 *
 * Layer 1 unit tests for GitService + gitServiceManager.
 *
 * These tests use real temporary git repos via makeTempGitRepo() — simple-git
 * is NOT mocked. We want the wrapper's argument shapes and result parsing to
 * be exercised against real git output.
 *
 * On Windows, line endings inside diffs/file contents are normalized with
 * .replace(/\r\n/g, '\n') before assertions.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { GitService, gitServiceManager } from '../git-service'
import { makeTempGitRepo, makeBareRemoteRepo, type TempGitRepo } from '../../../test/helpers/temp-git-repo'

const norm = (s: string): string => s.replace(/\r\n/g, '\n')

// ---------------------------------------------------------------------------
// isGitRepo
// ---------------------------------------------------------------------------

describe('GitService.isGitRepo', () => {
  let tempDir: string

  afterEach(async () => {
    if (tempDir) {
      try { await fs.promises.rm(tempDir, { recursive: true, force: true, maxRetries: 5 }) } catch { /* ignore */ }
    }
  })

  it('returns false for a non-git directory', async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'claudeui-nongit-'))
    const svc = new GitService(tempDir)
    expect(await svc.isGitRepo()).toBe(false)
  })

  it('returns true for a real git repo', async () => {
    const repo = await makeTempGitRepo()
    tempDir = repo.path
    const svc = new GitService(repo.path)
    expect(await svc.isGitRepo()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// getStatus
// ---------------------------------------------------------------------------

describe('GitService.getStatus', () => {
  let repo: TempGitRepo
  let svc: GitService

  beforeEach(async () => {
    repo = await makeTempGitRepo()
    svc = new GitService(repo.path)
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  it('returns clean repo with empty files list and correct branch', async () => {
    const status = await svc.getStatus()
    expect(status.branch).toBe('main')
    expect(status.files).toEqual([])
    expect(status.staged).toEqual([])
    expect(status.unstaged).toEqual([])
    expect(status.untracked).toEqual([])
    expect(status.linesAdded).toBe(0)
    expect(status.linesRemoved).toBe(0)
  })

  it("reports staged files with index !== ' '", async () => {
    await repo.writeFile('new.txt', 'hello\n')
    await repo.git.add('new.txt')
    const status = await svc.getStatus()
    const entry = status.files.find((f) => f.path === 'new.txt')
    expect(entry).toBeDefined()
    expect(entry!.index).not.toBe(' ')
    expect(status.staged).toContain('new.txt')
  })

  it("reports unstaged modifications with working !== ' '", async () => {
    await repo.writeFile('tracked.txt', 'v1\n')
    await repo.commit('add tracked')
    await repo.writeFile('tracked.txt', 'v2\n')
    const status = await svc.getStatus()
    const entry = status.files.find((f) => f.path === 'tracked.txt')
    expect(entry).toBeDefined()
    expect(entry!.working).not.toBe(' ')
    expect(status.unstaged).toContain('tracked.txt')
  })

  it('reports untracked files in untracked[]', async () => {
    await repo.writeFile('untracked.txt', 'new file\n')
    const status = await svc.getStatus()
    expect(status.untracked).toContain('untracked.txt')
    const entry = status.files.find((f) => f.path === 'untracked.txt')
    expect(entry).toBeDefined()
    expect(entry!.working).toBe('?')
  })

  it('reports deleted files', async () => {
    await repo.writeFile('doomed.txt', 'goodbye\n')
    await repo.commit('add doomed')
    await repo.unlink('doomed.txt')
    const status = await svc.getStatus()
    // deleted files appear in unstaged (service concats modified + deleted)
    expect(status.unstaged).toContain('doomed.txt')
    const entry = status.files.find((f) => f.path === 'doomed.txt')
    expect(entry).toBeDefined()
    expect(entry!.working).toBe('D')
  })

  it('surfaces ahead/behind when tracking a remote', async () => {
    const remote = await makeBareRemoteRepo()
    try {
      await repo.git.addRemote('origin', remote.path)
      await repo.git.push(['-u', 'origin', 'main'])
      // Make a local commit — should be ahead 1
      await repo.writeFile('more.txt', 'more\n')
      await repo.commit('add more')
      const status = await svc.getStatus()
      expect(status.trackingBranch).toBe('origin/main')
      expect(status.ahead).toBe(1)
      expect(status.behind).toBe(0)
    } finally {
      await remote.cleanup()
    }
  })

  it('computes linesAdded/linesRemoved across staged, unstaged, and untracked', async () => {
    // seed a tracked file and commit
    await repo.writeFile('tracked.txt', 'line1\nline2\n')
    await repo.commit('seed')
    // unstaged modification: +1 line
    await repo.writeFile('tracked.txt', 'line1\nline2\nline3\n')
    // staged change to another file: +2 lines
    await repo.writeFile('staged.txt', 'a\nb\n')
    await repo.git.add('staged.txt')
    // untracked file: 3 lines
    await repo.writeFile('untracked.txt', 'u1\nu2\nu3\n')

    const status = await svc.getStatus()
    // 1 (unstaged) + 2 (staged) + 3 (untracked) = 6 added
    expect(status.linesAdded).toBe(6)
    expect(status.linesRemoved).toBe(0)
  })

  it('counts untracked file lines correctly with CRLF and no-trailing-newline', async () => {
    // No trailing newline + CRLF
    await repo.writeFile('crlf.txt', 'a\r\nb\r\nc')
    const status = await svc.getStatus()
    expect(status.untracked).toContain('crlf.txt')
    // 3 lines ("a", "b", "c"), no trailing newline → counted as 3 additions
    // (git normalizes differently, but service reads the file directly and counts via split('\n'))
    // The file content has 2 \n characters (from \r\n pairs) → split yields 3 pieces
    expect(status.linesAdded).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// getBranches
// ---------------------------------------------------------------------------

describe('GitService.getBranches', () => {
  let repo: TempGitRepo
  let svc: GitService

  beforeEach(async () => {
    repo = await makeTempGitRepo()
    svc = new GitService(repo.path)
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  it('marks current branch and lists local + remote; tracking follows simple-git branch summary shape', async () => {
    const remote = await makeBareRemoteRepo()
    try {
      await repo.git.addRemote('origin', remote.path)
      await repo.git.push(['-u', 'origin', 'main'])
      // Add a second local branch
      await repo.git.checkoutLocalBranch('feature')
      await repo.writeFile('f.txt', 'feat\n')
      await repo.commit('feat')
      await repo.git.checkout('main')

      const branches = await svc.getBranches()
      expect(branches.current).toBe('main')
      expect(branches.local).toEqual(expect.arrayContaining(['main', 'feature']))
      expect(branches.remote).toEqual(expect.arrayContaining(['origin/main']))
      // simple-git's `branch(['-a'])` summary does not populate `info.tracking`
      // on branch entries (tracking info is only surfaced via `status()`), so
      // the service's `tracking` record is always empty for current simple-git.
      // This test pins that contract — if a future simple-git upgrade starts
      // populating it, this assertion will fail and we should update the service.
      expect(branches.tracking).toEqual({})
    } finally {
      await remote.cleanup()
    }
  })

  it('handles detached HEAD (current is SHA prefix from simple-git)', async () => {
    // Make a second commit so we have something to detach onto
    await repo.writeFile('a.txt', 'a\n')
    const sha = await repo.commit('second')
    // Detach HEAD at the commit
    await repo.git.checkout([sha])
    const branches = await svc.getBranches()
    // simple-git reports the short SHA as `current` when HEAD is detached.
    // The service passes that through as-is — we just assert it's not a
    // named branch. (If simple-git ever returns '' for detached HEAD, this
    // test and the service's fallback to 'HEAD' should be revisited.)
    expect(branches.current).not.toBe('main')
    expect(branches.current.length).toBeGreaterThan(0)
    expect(sha.startsWith(branches.current) || branches.current.startsWith(sha)).toBe(true)
    // local list may still include 'main' (still points at initial commit)
    expect(branches.local).toEqual(expect.arrayContaining(['main']))
  })
})

// ---------------------------------------------------------------------------
// checkout / createBranch
// ---------------------------------------------------------------------------

describe('GitService.checkout / createBranch', () => {
  let repo: TempGitRepo
  let svc: GitService

  beforeEach(async () => {
    repo = await makeTempGitRepo()
    svc = new GitService(repo.path)
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  it('switches to an existing branch', async () => {
    await repo.git.checkoutLocalBranch('dev')
    await repo.git.checkout('main')
    await svc.checkout('dev')
    const b = await svc.getBranches()
    expect(b.current).toBe('dev')
  })

  it('rejects checkout of nonexistent branch', async () => {
    await expect(svc.checkout('nonexistent-branch')).rejects.toThrow()
  })

  it('createBranch creates and switches to the new branch', async () => {
    await svc.createBranch('feature/new')
    const b = await svc.getBranches()
    expect(b.current).toBe('feature/new')
    expect(b.local).toContain('feature/new')
  })
})

// ---------------------------------------------------------------------------
// stageFile / unstageFile / stageAll / unstageAll
// ---------------------------------------------------------------------------

describe('GitService staging', () => {
  let repo: TempGitRepo
  let svc: GitService

  beforeEach(async () => {
    repo = await makeTempGitRepo()
    svc = new GitService(repo.path)
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  it('stageFile moves a file from unstaged into the staged list', async () => {
    await repo.writeFile('tracked.txt', 'v1\n')
    await repo.commit('seed')
    await repo.writeFile('tracked.txt', 'v2\n')
    let status = await svc.getStatus()
    expect(status.unstaged).toContain('tracked.txt')
    expect(status.staged).not.toContain('tracked.txt')
    await svc.stageFile('tracked.txt')
    status = await svc.getStatus()
    expect(status.staged).toContain('tracked.txt')
    // After staging, the working tree status should be clean ' ' (index 'M',
    // working ' ') — i.e., no more unstaged modifications for this file.
    const entry = status.files.find((f) => f.path === 'tracked.txt')
    expect(entry).toBeDefined()
    expect(entry!.working).toBe(' ')
    expect(entry!.index).toBe('M')
  })

  it('stageFile handles paths with spaces', async () => {
    await repo.writeFile('file with spaces.txt', 'hi\n')
    await svc.stageFile('file with spaces.txt')
    const status = await svc.getStatus()
    expect(status.staged).toContain('file with spaces.txt')
  })

  it('stageFile handles paths with unicode', async () => {
    const unicodePath = '日本語ファイル.txt'
    await repo.writeFile(unicodePath, 'konnichiwa\n')
    await svc.stageFile(unicodePath)
    const status = await svc.getStatus()
    expect(status.staged).toContain(unicodePath)
  })

  it('unstageFile moves a file back from staged', async () => {
    await repo.writeFile('new.txt', 'x\n')
    await repo.git.add('new.txt')
    let status = await svc.getStatus()
    expect(status.staged).toContain('new.txt')
    await svc.unstageFile('new.txt')
    status = await svc.getStatus()
    expect(status.staged).not.toContain('new.txt')
    // Now an untracked file
    expect(status.untracked).toContain('new.txt')
  })

  it('stageAll / unstageAll bulk ops', async () => {
    await repo.writeFile('tracked.txt', 'v1\n')
    await repo.commit('seed')
    await repo.writeFile('tracked.txt', 'v2\n')
    await repo.writeFile('other.txt', 'o\n')
    await svc.stageAll()
    let status = await svc.getStatus()
    expect(status.staged).toEqual(expect.arrayContaining(['tracked.txt', 'other.txt']))
    await svc.unstageAll()
    status = await svc.getStatus()
    expect(status.staged).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// commit
// ---------------------------------------------------------------------------

describe('GitService.commit', () => {
  it('returns commit SHA on success', async () => {
    const repo = await makeTempGitRepo()
    try {
      const svc = new GitService(repo.path)
      await repo.writeFile('a.txt', 'hello\n')
      await svc.stageFile('a.txt')
      const sha = await svc.commit('add a.txt')
      expect(sha).toMatch(/^[0-9a-f]{7,40}$/)
      // verify log contains this sha
      const log = await repo.git.log()
      expect(log.latest!.hash.startsWith(sha) || sha.startsWith(log.latest!.hash)).toBe(true)
    } finally {
      await repo.cleanup()
    }
  })

  it('rejects commit with empty message', async () => {
    const repo = await makeTempGitRepo()
    try {
      const svc = new GitService(repo.path)
      await repo.writeFile('a.txt', 'hi\n')
      await svc.stageFile('a.txt')
      await expect(svc.commit('')).rejects.toThrow()
    } finally {
      await repo.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// push / pushWithUpstream / pull / fetch
// ---------------------------------------------------------------------------

describe('GitService remote operations', () => {
  it('push succeeds against a bare remote', async () => {
    const remote = await makeBareRemoteRepo()
    const repo = await makeTempGitRepo()
    try {
      const svc = new GitService(repo.path)
      await repo.git.addRemote('origin', remote.path)
      await repo.git.push(['-u', 'origin', 'main'])
      // Make a new commit and push via service
      await repo.writeFile('p.txt', 'push me\n')
      await repo.commit('add p')
      await expect(svc.push()).resolves.toBeUndefined()
      // Verify commit landed in bare remote by checking log
      const log = await repo.git.log(['origin/main'])
      expect(log.all.some((c) => c.message === 'add p')).toBe(true)
    } finally {
      await repo.cleanup()
      await remote.cleanup()
    }
  })

  it('push rejects on non-fast-forward', async () => {
    const remote = await makeBareRemoteRepo()
    const repoA = await makeTempGitRepo()
    const repoB = await makeTempGitRepo()
    try {
      await repoA.git.addRemote('origin', remote.path)
      await repoA.git.push(['-u', 'origin', 'main'])
      // B clones by fetching + setting up tracking
      await repoB.git.addRemote('origin', remote.path)
      await repoB.git.fetch(['origin'])
      // Reset repoB to remote main so both share history
      await repoB.git.reset(['--hard', 'origin/main'])
      await repoB.git.branch(['--set-upstream-to=origin/main', 'main'])

      // A makes a divergent commit and pushes
      await repoA.writeFile('a.txt', 'A\n')
      await repoA.commit('from A')
      await repoA.git.push()

      // B makes its own commit, which won't fast-forward onto remote/main
      await repoB.writeFile('b.txt', 'B\n')
      await repoB.commit('from B')

      const svcB = new GitService(repoB.path)
      await expect(svcB.push()).rejects.toThrow()
    } finally {
      await repoA.cleanup()
      await repoB.cleanup()
      await remote.cleanup()
    }
  })

  it('pushWithUpstream creates upstream tracking', async () => {
    const remote = await makeBareRemoteRepo()
    const repo = await makeTempGitRepo()
    try {
      await repo.git.addRemote('origin', remote.path)
      // Create a new branch without upstream
      await repo.git.checkoutLocalBranch('feature')
      await repo.writeFile('f.txt', 'f\n')
      await repo.commit('feat')
      const svc = new GitService(repo.path)
      await svc.pushWithUpstream('feature')
      // Verify tracking is configured — `git status` reports it, which is
      // what the service's getStatus() surfaces via trackingBranch.
      const status = await svc.getStatus()
      expect(status.trackingBranch).toBe('origin/feature')
    } finally {
      await repo.cleanup()
      await remote.cleanup()
    }
  })

  it('pull returns a summary on success', async () => {
    const remote = await makeBareRemoteRepo()
    const repoA = await makeTempGitRepo()
    const repoB = await makeTempGitRepo()
    try {
      await repoA.git.addRemote('origin', remote.path)
      await repoA.git.push(['-u', 'origin', 'main'])
      await repoB.git.addRemote('origin', remote.path)
      await repoB.git.fetch(['origin'])
      await repoB.git.reset(['--hard', 'origin/main'])
      await repoB.git.branch(['--set-upstream-to=origin/main', 'main'])

      // A adds a commit + pushes
      await repoA.writeFile('new.txt', 'new content\nmore\n')
      await repoA.commit('add new')
      await repoA.git.push()

      const svcB = new GitService(repoB.path)
      const result = await svcB.pull()
      expect(result.summary).toMatch(/changes/)
      expect(result.summary).toMatch(/insertions/)
    } finally {
      await repoA.cleanup()
      await repoB.cleanup()
      await remote.cleanup()
    }
  })

  it('fetch runs without error against a bare remote', async () => {
    const remote = await makeBareRemoteRepo()
    const repo = await makeTempGitRepo()
    try {
      await repo.git.addRemote('origin', remote.path)
      await repo.git.push(['-u', 'origin', 'main'])
      const svc = new GitService(repo.path)
      await expect(svc.fetch()).resolves.toBeUndefined()
    } finally {
      await repo.cleanup()
      await remote.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// getFilePatch
// ---------------------------------------------------------------------------

describe('GitService.getFilePatch', () => {
  let repo: TempGitRepo
  let svc: GitService

  beforeEach(async () => {
    repo = await makeTempGitRepo()
    svc = new GitService(repo.path)
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  it('returns unified diff for a modified tracked file (staged=false)', async () => {
    await repo.writeFile('t.txt', 'line1\nline2\n')
    await repo.commit('seed')
    await repo.writeFile('t.txt', 'line1\nline2-modified\n')
    const { patch } = await svc.getFilePatch('t.txt', false)
    const normalized = norm(patch)
    expect(normalized).toMatch(/^diff --git/m)
    expect(normalized).toMatch(/-line2/m)
    expect(normalized).toMatch(/\+line2-modified/m)
  })

  it('returns diff for staged changes (staged=true)', async () => {
    await repo.writeFile('t.txt', 'one\n')
    await repo.commit('seed')
    await repo.writeFile('t.txt', 'one\ntwo\n')
    await repo.git.add('t.txt')
    const { patch } = await svc.getFilePatch('t.txt', true)
    const normalized = norm(patch)
    expect(normalized).toMatch(/^diff --git/m)
    expect(normalized).toMatch(/\+two/m)
  })

  it('synthesizes patch for untracked file with --- /dev/null header', async () => {
    await repo.writeFile('untracked.txt', 'hello\nworld\n')
    const { patch } = await svc.getFilePatch('untracked.txt', false)
    const normalized = norm(patch)
    expect(normalized).toMatch(/^--- \/dev\/null/m)
    expect(normalized).toMatch(/^\+\+\+ b\/untracked\.txt/m)
    expect(normalized).toMatch(/^@@ -0,0 \+1,2 @@/m)
    expect(normalized).toMatch(/^\+hello/m)
    expect(normalized).toMatch(/^\+world/m)
  })

  it('synthesized patch normalizes CRLF to LF in body', async () => {
    // Write a file with CRLF line endings; no trailing newline
    const abs = path.join(repo.path, 'crlf.txt')
    await fs.promises.writeFile(abs, 'a\r\nb\r\nc', 'utf-8')
    const { patch } = await svc.getFilePatch('crlf.txt', false)
    // The synthesized body should contain "+a\n+b\n+c" — no raw \r
    expect(patch.includes('\r')).toBe(false)
    const normalized = norm(patch)
    expect(normalized).toMatch(/^\+a$/m)
    expect(normalized).toMatch(/^\+b$/m)
    expect(normalized).toMatch(/^\+c$/m)
    expect(normalized).toMatch(/^@@ -0,0 \+1,3 @@/m)
  })
})

// ---------------------------------------------------------------------------
// getFileContents
// ---------------------------------------------------------------------------

describe('GitService.getFileContents', () => {
  let repo: TempGitRepo
  let svc: GitService

  beforeEach(async () => {
    repo = await makeTempGitRepo()
    svc = new GitService(repo.path)
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  it('returns oldContent/newContent for an unstaged modification', async () => {
    await repo.writeFile('t.txt', 'v1\n')
    await repo.commit('seed')
    await repo.writeFile('t.txt', 'v2\n')
    const { oldContent, newContent } = await svc.getFileContents('t.txt', false)
    expect(norm(oldContent)).toBe('v1\n')
    expect(norm(newContent)).toBe('v2\n')
  })

  it('returns oldContent/newContent for a staged change', async () => {
    await repo.writeFile('t.txt', 'v1\n')
    await repo.commit('seed')
    await repo.writeFile('t.txt', 'v2\n')
    await repo.git.add('t.txt')
    const { oldContent, newContent } = await svc.getFileContents('t.txt', true)
    expect(norm(oldContent)).toBe('v1\n')
    expect(norm(newContent)).toBe('v2\n')
  })
})

// ---------------------------------------------------------------------------
// discardFile
// ---------------------------------------------------------------------------

describe('GitService.discardFile', () => {
  let repo: TempGitRepo
  let svc: GitService

  beforeEach(async () => {
    repo = await makeTempGitRepo()
    svc = new GitService(repo.path)
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  it('restores a tracked file to HEAD state', async () => {
    await repo.writeFile('t.txt', 'original\n')
    await repo.commit('seed')
    await repo.writeFile('t.txt', 'modified\n')
    await svc.discardFile('t.txt')
    const content = await repo.readFile('t.txt')
    expect(norm(content)).toBe('original\n')
    const status = await svc.getStatus()
    expect(status.unstaged).not.toContain('t.txt')
  })

  it('deletes an untracked file from disk', async () => {
    await repo.writeFile('new.txt', 'hi\n')
    const abs = path.join(repo.path, 'new.txt')
    expect(fs.existsSync(abs)).toBe(true)
    await svc.discardFile('new.txt')
    expect(fs.existsSync(abs)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// startPolling / stopPolling
// ---------------------------------------------------------------------------

describe('GitService polling', () => {
  let repo: TempGitRepo
  let svc: GitService

  beforeEach(async () => {
    repo = await makeTempGitRepo()
    svc = new GitService(repo.path)
  })

  afterEach(async () => {
    svc.stopPolling()
    await repo.cleanup()
  })

  it('fires callback on change but not on no-op polls', async () => {
    const calls: number[] = []
    svc.startPolling((_status) => {
      calls.push(Date.now())
    }, 50)

    // Wait for initial poll + a couple of noop polls.
    await new Promise((r) => setTimeout(r, 250))
    const initialCalls = calls.length
    // Initial poll should have fired at least once (state was empty, transitioned to JSON form).
    expect(initialCalls).toBeGreaterThanOrEqual(1)

    // Hold steady — no more new calls
    await new Promise((r) => setTimeout(r, 200))
    expect(calls.length).toBe(initialCalls)

    // Now change the repo state — next poll should fire the callback
    await repo.writeFile('change.txt', 'new\n')
    await new Promise((r) => setTimeout(r, 250))
    expect(calls.length).toBeGreaterThan(initialCalls)

    svc.stopPolling()
    const afterStop = calls.length
    await new Promise((r) => setTimeout(r, 200))
    expect(calls.length).toBe(afterStop)
  })
})

// ---------------------------------------------------------------------------
// gitServiceManager
// ---------------------------------------------------------------------------

describe('gitServiceManager', () => {
  let repo: TempGitRepo

  beforeEach(async () => {
    repo = await makeTempGitRepo()
  })

  afterEach(async () => {
    // Ensure manager is cleaned for this cwd
    // Repeatedly release until the entry is gone (idempotent on extra releases)
    try { gitServiceManager.release(repo.path) } catch { /* noop */ }
    try { gitServiceManager.release(repo.path) } catch { /* noop */ }
    try { gitServiceManager.release(repo.path) } catch { /* noop */ }
    await repo.cleanup()
  })

  it('get() returns the same instance for the same cwd and increments refCount', () => {
    const a = gitServiceManager.get(repo.path)
    const b = gitServiceManager.get(repo.path)
    expect(a).toBe(b)
    // getIfExists should return the instance
    expect(gitServiceManager.getIfExists(repo.path)).toBe(a)
    // Release twice to fully clean up (refCount went to 2)
    gitServiceManager.release(repo.path)
    expect(gitServiceManager.getIfExists(repo.path)).toBe(a)
    gitServiceManager.release(repo.path)
    expect(gitServiceManager.getIfExists(repo.path)).toBeUndefined()
  })

  it('release decrements refCount and destroys when it reaches 0', () => {
    const a = gitServiceManager.get(repo.path)
    expect(gitServiceManager.getIfExists(repo.path)).toBe(a)
    gitServiceManager.release(repo.path)
    // refCount was 1 → destroyed
    expect(gitServiceManager.getIfExists(repo.path)).toBeUndefined()
    // Extra release is a no-op (no throw)
    expect(() => gitServiceManager.release(repo.path)).not.toThrow()
  })
})
