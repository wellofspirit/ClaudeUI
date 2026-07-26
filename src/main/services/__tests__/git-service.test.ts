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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { GitService, gitServiceManager } from '../git-service'
import { logger } from '../logger'
import type { GitStatusData } from '../../../shared/types'
import {
  makeTempGitRepo,
  makeBareRemoteRepo,
  type TempGitRepo
} from '../../../test/helpers/temp-git-repo'

const norm = (s: string): string => s.replace(/\r\n/g, '\n')

/** Poll until `pred` holds or `timeoutMs` elapses. Windows git calls are slow. */
const waitFor = async (pred: () => boolean, timeoutMs: number): Promise<void> => {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) return
    await new Promise((r) => setTimeout(r, 5))
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// isGitRepo
// ---------------------------------------------------------------------------

describe('GitService.isGitRepo', () => {
  let tempDir: string

  afterEach(async () => {
    if (tempDir) {
      try {
        await fs.promises.rm(tempDir, { recursive: true, force: true, maxRetries: 5 })
      } catch {
        /* ignore */
      }
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

  it('skips untracked files larger than the size cap to avoid V8 string-length crashes', async () => {
    // A small countable untracked file
    await repo.writeFile('small.txt', 'a\nb\nc\n')
    // An "oversized" untracked blob — just over 10 MiB. We don't actually need
    // to exceed V8's kMaxLength; the guard skips anything above the cap. This
    // protects against the real-world case (multi-GB DuckDB / sqlite files in
    // the working tree) which previously crashed the main process via
    // fs.readFile(path, 'utf-8').
    const big = Buffer.alloc(10 * 1024 * 1024 + 1, 0x61) // 'a' bytes, no newlines
    await fs.promises.writeFile(path.join(repo.path, 'huge.bin'), big)

    const status = await svc.getStatus()
    expect(status.untracked).toEqual(expect.arrayContaining(['small.txt', 'huge.bin']))
    // Only small.txt's 3 lines should be counted; huge.bin is skipped.
    expect(status.linesAdded).toBe(3)
  })

  it('skips line counting for untracked binary files (NUL byte sniff)', async () => {
    // Small text file that should be counted
    await repo.writeFile('readme.txt', 'one\ntwo\n')
    // Small binary file: contains a NUL byte in the first 8 KB sniff window.
    // Simulates a sqlite/duckdb-style header with embedded NULs.
    const bin = Buffer.from([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x00, 0x42, 0x4c, 0x4f, 0x42])
    await fs.promises.writeFile(path.join(repo.path, 'data.db'), bin)

    const status = await svc.getStatus()
    expect(status.untracked).toEqual(expect.arrayContaining(['readme.txt', 'data.db']))
    // Only readme.txt's 2 lines should count; data.db is detected as binary.
    expect(status.linesAdded).toBe(2)
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

  it('returns isBinary placeholder for an untracked binary file (no file content leaked)', async () => {
    // SQLite-like header — NUL byte in the first 8 KB triggers the binary sniff.
    // Include a string that would be visible if we mistakenly fell back to the
    // text-patch synthesis, so we can assert it never surfaces in the patch.
    const sentinel = 'SECRET-DO-NOT-LEAK'
    const bin = Buffer.concat([
      Buffer.from('SQLite format 3'),
      Buffer.from([0x00]),
      Buffer.from(sentinel)
    ])
    await fs.promises.writeFile(path.join(repo.path, 'data.db'), bin)

    const { patch, isBinary } = await svc.getFilePatch('data.db', false)
    expect(isBinary).toBe(true)
    const normalized = norm(patch)
    expect(normalized).toMatch(/^diff --git a\/data\.db b\/data\.db/m)
    expect(normalized).toMatch(/^Binary files \/dev\/null and b\/data\.db differ$/m)
    // Critical: the actual file bytes must not appear in the patch.
    expect(patch.includes(sentinel)).toBe(false)
    expect(patch.includes('@@')).toBe(false)
  })

  it('returns isBinary placeholder for an untracked oversize file (size cap)', async () => {
    // Just over the 10 MiB cap. Filled with a printable byte so the binary
    // sniff would NOT classify it as binary — this exercises the size-cap
    // path independently of the NUL-byte heuristic.
    const big = Buffer.alloc(10 * 1024 * 1024 + 1, 0x61)
    await fs.promises.writeFile(path.join(repo.path, 'huge.log'), big)

    const { patch, isBinary } = await svc.getFilePatch('huge.log', false)
    expect(isBinary).toBe(true)
    const normalized = norm(patch)
    expect(normalized).toMatch(/^Binary files \/dev\/null and b\/huge\.log differ$/m)
    // The huge buffer must not appear in the patch.
    expect(patch.length).toBeLessThan(1024)
  })

  it('marks tracked binary diffs as isBinary (git emits its own placeholder)', async () => {
    // Tracked binary — commit one binary blob, then mutate it.
    const v1 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])
    const v2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x02])
    await fs.promises.writeFile(path.join(repo.path, 'icon.png'), v1)
    await repo.git.add('icon.png')
    await repo.commit('add icon')
    await fs.promises.writeFile(path.join(repo.path, 'icon.png'), v2)

    const { patch, isBinary } = await svc.getFilePatch('icon.png', false)
    expect(isBinary).toBe(true)
    expect(patch).toMatch(/Binary files .* differ/)
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
// Tracked content / diff size caps (audit M-GT1)
//
// Before the cap, clicking a huge TRACKED file buffered it fully (git show /
// git diff into a JS string) and IPC'd a multi-hundred-MB payload — and a
// multi-GB tracked blob crashed the main process on V8's String::kMaxLength.
// getFilePatch must return a "too large" placeholder (isBinary) instead of the
// giant diff; getFileContents must return a marker per oversized side, never
// the content.
// ---------------------------------------------------------------------------

describe('GitService tracked size caps (M-GT1)', () => {
  let repo: TempGitRepo
  let svc: GitService
  // 10 MiB + 1 of printable 'a' — over the 10 MiB cap, and NOT binary (no NUL),
  // so this exercises the size cap independently of the binary heuristic.
  const OVERSIZE = 10 * 1024 * 1024 + 1

  beforeEach(async () => {
    repo = await makeTempGitRepo()
    svc = new GitService(repo.path)
    // Commit a huge tracked text file, then modify it so there is a real diff.
    await fs.promises.writeFile(path.join(repo.path, 'huge.txt'), Buffer.alloc(OVERSIZE, 0x61))
    await repo.git.add('huge.txt')
    await repo.commit('add huge tracked file')
    await fs.promises.appendFile(path.join(repo.path, 'huge.txt'), 'zzz\n')
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  it('getFilePatch returns a too-large placeholder for an oversized tracked file (no giant diff)', async () => {
    const { patch, isBinary } = await svc.getFilePatch('huge.txt', false)
    expect(isBinary).toBe(true)
    // The placeholder — never the 10 MiB of content, never a real hunk.
    expect(patch.length).toBeLessThan(1024)
    expect(patch).toMatch(/too large/i)
    expect(patch.includes('@@')).toBe(false)
    // A long run of the file's bytes must not appear.
    expect(patch.includes('a'.repeat(1000))).toBe(false)
  })

  it('getFileContents returns a marker per oversized side, never the content', async () => {
    const { oldContent, newContent } = await svc.getFileContents('huge.txt', false)
    // old side = the committed index blob (10 MiB) → marker.
    expect(oldContent).toMatch(/too large/i)
    expect(oldContent.length).toBeLessThan(512)
    // new side = the working-tree file (10 MiB) → marker.
    expect(newContent).toMatch(/too large/i)
    expect(newContent.length).toBeLessThan(512)
    expect(newContent.includes('a'.repeat(1000))).toBe(false)
  })

  it('does not affect a normal-sized tracked file (cap is non-vacuous)', async () => {
    await repo.writeFile('small.txt', 'one\ntwo\n')
    await repo.commit('seed small')
    await repo.writeFile('small.txt', 'one\ntwo\nthree\n')
    const { patch, isBinary } = await svc.getFilePatch('small.txt', false)
    expect(isBinary).toBeUndefined()
    expect(norm(patch)).toMatch(/\+three/m)
    const { oldContent, newContent } = await svc.getFileContents('small.txt', false)
    expect(norm(oldContent)).toBe('one\ntwo\n')
    expect(norm(newContent)).toBe('one\ntwo\nthree\n')
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
// Path containment for file operations (audit M-GT2 / gpt#5)
//
// Every IPC-exposed file op must reject a repo-relative path that escapes the
// repository root. The most dangerous is discardFile: a `../secret` path fails
// both `git show` probes, is classified untracked, and pre-fix was fs.unlink'd
// outside the repo.
// ---------------------------------------------------------------------------

describe('GitService path containment', () => {
  let repo: TempGitRepo
  let svc: GitService
  let sentinel: string

  beforeEach(async () => {
    repo = await makeTempGitRepo()
    svc = new GitService(repo.path)
    // A precious file OUTSIDE the repo, addressable via `../` from repo root.
    sentinel = path.resolve(repo.path, '..', `claudeui-sentinel-${Date.now()}.txt`)
    await fs.promises.writeFile(sentinel, 'do-not-touch\n', 'utf-8')
  })

  afterEach(async () => {
    try {
      await fs.promises.rm(sentinel, { force: true, maxRetries: 5 })
    } catch {
      /* ignore */
    }
    await repo.cleanup()
  })

  const relToSentinel = (): string => `../${path.basename(sentinel)}`

  it('discardFile refuses a ../ path and never unlinks the outside file', async () => {
    await expect(svc.discardFile(relToSentinel())).rejects.toThrow(/outside the repository/)
    expect(fs.existsSync(sentinel)).toBe(true)
  })

  it('discardFile refuses a deep traversal that escapes via a subdirectory', async () => {
    await expect(svc.discardFile(`sub/../../${path.basename(sentinel)}`)).rejects.toThrow(
      /outside the repository/
    )
    expect(fs.existsSync(sentinel)).toBe(true)
  })

  it('getFileContents refuses a ../ path', async () => {
    await expect(svc.getFileContents(relToSentinel(), false)).rejects.toThrow(
      /outside the repository/
    )
    expect(fs.existsSync(sentinel)).toBe(true)
  })

  it('getFilePatch refuses a ../ path', async () => {
    await expect(svc.getFilePatch(relToSentinel(), false)).rejects.toThrow(/outside the repository/)
  })

  it('stageFile refuses a ../ path', async () => {
    await expect(svc.stageFile(relToSentinel())).rejects.toThrow(/outside the repository/)
  })

  it('unstageFile refuses a ../ path', async () => {
    await expect(svc.unstageFile(relToSentinel())).rejects.toThrow(/outside the repository/)
  })

  it('still operates on a legitimately nested in-repo path', async () => {
    // A file in a subdirectory must remain fully functional post-containment.
    await repo.writeFile('nested/dir/file.txt', 'v1\n')
    await repo.commit('seed nested')
    await repo.writeFile('nested/dir/file.txt', 'v2\n')

    const { oldContent, newContent } = await svc.getFileContents('nested/dir/file.txt', false)
    expect(norm(oldContent)).toBe('v1\n')
    expect(norm(newContent)).toBe('v2\n')

    await svc.discardFile('nested/dir/file.txt')
    expect(norm(await repo.readFile('nested/dir/file.txt'))).toBe('v1\n')
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

    // Wait for the initial poll to fire. On Windows CI, each simple-git
    // subprocess call costs ~150-200ms, so a fixed timeout is flaky.
    await waitFor(() => calls.length >= 1, 5000)
    const initialCalls = calls.length
    expect(initialCalls).toBeGreaterThanOrEqual(1)

    // Hold steady — no more new calls while repo state is unchanged.
    await new Promise((r) => setTimeout(r, 300))
    expect(calls.length).toBe(initialCalls)

    // Now change the repo state — next poll should fire the callback.
    await repo.writeFile('change.txt', 'new\n')
    await waitFor(() => calls.length > initialCalls, 5000)
    expect(calls.length).toBeGreaterThan(initialCalls)

    svc.stopPolling()
    const afterStop = calls.length
    await new Promise((r) => setTimeout(r, 300))
    expect(calls.length).toBe(afterStop)
  })
})

// ---------------------------------------------------------------------------
// startPolling — in-flight guard (main-process OOM regression guard)
//
// Before the guard, `setInterval(poll, 5000)` fired regardless of whether the
// previous async getStatus() had settled. On a large working tree each poll
// took longer than the interval, so invocations accumulated behind simple-git's
// per-instance task queue until the main process ran out of heap — a V8 abort,
// which produces no JS exception, no log line, and no Windows WER entry.
// ---------------------------------------------------------------------------

const emptyStatus = (over: Partial<GitStatusData> = {}): GitStatusData => ({
  branch: 'main',
  ahead: 0,
  behind: 0,
  trackingBranch: null,
  files: [],
  staged: [],
  unstaged: [],
  untracked: [],
  linesAdded: 0,
  linesRemoved: 0,
  ...over
})

describe('GitService polling in-flight guard', () => {
  let repo: TempGitRepo
  let svc: GitService

  beforeEach(async () => {
    repo = await makeTempGitRepo()
    svc = new GitService(repo.path)
  })

  afterEach(async () => {
    svc.stopPolling()
    vi.restoreAllMocks()
    await repo.cleanup()
  })

  it('skips ticks while the previous getStatus() is still in flight', async () => {
    let started = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    vi.spyOn(svc, 'getStatus').mockImplementation(async () => {
      started++
      await gate
      return emptyStatus()
    })

    // ~20 ticks would fire in 200 ms at a 10 ms interval.
    svc.startPolling(() => {}, 10)
    await sleep(200)
    expect(started).toBe(1)

    // Once the in-flight poll settles, polling resumes normally.
    release()
    await waitFor(() => started > 1, 1000)
    expect(started).toBeGreaterThan(1)
  })

  it('does not fire the callback for a poll that settles after stopPolling', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    vi.spyOn(svc, 'getStatus').mockImplementation(async () => {
      await gate
      return emptyStatus()
    })

    const calls: GitStatusData[] = []
    svc.startPolling((s) => calls.push(s), 10)
    await sleep(30)
    svc.stopPolling()
    release()
    await sleep(50)
    expect(calls).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// startPolling — cheap fingerprint change detection
// ---------------------------------------------------------------------------

describe('GitService polling change detection', () => {
  let repo: TempGitRepo
  let svc: GitService

  beforeEach(async () => {
    repo = await makeTempGitRepo()
    svc = new GitService(repo.path)
  })

  afterEach(async () => {
    svc.stopPolling()
    vi.restoreAllMocks()
    await repo.cleanup()
  })

  it('fires on per-file status letter changes and on ahead/behind changes, not on repeats', async () => {
    const modified = (): GitStatusData =>
      emptyStatus({
        files: [{ path: 'a.txt', index: ' ', working: 'M' }],
        unstaged: ['a.txt'],
        linesAdded: 1
      })
    // Same branch, same file count, same line counts — only the status letters
    // move. A fingerprint that skipped per-file letters would miss this.
    const staged = (): GitStatusData =>
      emptyStatus({
        files: [{ path: 'a.txt', index: 'M', working: ' ' }],
        staged: ['a.txt'],
        linesAdded: 1
      })

    const queue: GitStatusData[] = [
      modified(),
      modified(), // fresh object, identical content → must NOT fire
      staged(),
      staged(), // fresh object, identical content → must NOT fire
      emptyStatus({
        files: [{ path: 'a.txt', index: 'M', working: ' ' }],
        staged: ['a.txt'],
        linesAdded: 1,
        ahead: 1
      })
    ]
    let consumed = 0
    vi.spyOn(svc, 'getStatus').mockImplementation(async () => {
      const next = queue[Math.min(consumed, queue.length - 1)]
      consumed++
      return next
    })

    const fired: GitStatusData[] = []
    svc.startPolling((s) => fired.push(s), 5)
    await waitFor(() => consumed >= queue.length, 3000)
    await sleep(30)
    svc.stopPolling()

    expect(consumed).toBeGreaterThanOrEqual(queue.length)
    expect(fired.length).toBe(3)
    expect(fired[0].files[0].working).toBe('M')
    expect(fired[1].files[0].index).toBe('M')
    expect(fired[2].ahead).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// getStatus — untracked line-count budget + cache
// ---------------------------------------------------------------------------

describe('GitService untracked line-count budget', () => {
  let repo: TempGitRepo
  let svc: GitService

  beforeEach(async () => {
    repo = await makeTempGitRepo()
    svc = new GitService(repo.path)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await repo.cleanup()
  })

  it('caps how many untracked files it line-counts and flags the truncation', async () => {
    // 205 untracked files, one countable line each. Cap is 200.
    const total = 205
    await Promise.all(
      Array.from({ length: total }, (_, i) =>
        repo.writeFile(`u${String(i).padStart(4, '0')}.txt`, 'a\n')
      )
    )

    const readSpy = vi.spyOn(fs.promises, 'readFile')
    const status = await svc.getStatus()

    // Every file is still reported — only the line counts are budgeted.
    expect(status.untracked.length).toBe(total)
    expect(status.lineCountsTruncated).toBe(true)
    expect(status.linesAdded).toBe(200)
    expect(readSpy).toHaveBeenCalledTimes(200)
  })

  it('stops line-counting once the cumulative byte budget is exhausted', async () => {
    // 6 × 9 MiB = 54 MiB of untracked text; the budget is 50 MiB, so the 6th
    // file must not be read. Each file is one line (no newline anywhere).
    const chunk = Buffer.alloc(9 * 1024 * 1024, 0x61)
    for (let i = 0; i < 6; i++) {
      await fs.promises.writeFile(path.join(repo.path, `big${i}.log`), chunk)
    }

    const readSpy = vi.spyOn(fs.promises, 'readFile')
    const status = await svc.getStatus()

    expect(status.untracked.length).toBe(6)
    expect(status.lineCountsTruncated).toBe(true)
    // 5 × 9 MiB = 45 MiB read; the 6th would push past 50 MiB.
    expect(readSpy).toHaveBeenCalledTimes(5)
    expect(status.linesAdded).toBe(5)
  })

  it('caches line counts by (size, mtime) so unchanged files are read once', async () => {
    await repo.writeFile('a.txt', 'one\ntwo\n')
    await repo.writeFile('b.txt', 'x\n')

    const first = await svc.getStatus()
    expect(first.linesAdded).toBe(3)

    const readSpy = vi.spyOn(fs.promises, 'readFile')
    const openSpy = vi.spyOn(fs.promises, 'open')
    const second = await svc.getStatus()
    expect(second.linesAdded).toBe(3)
    // Nothing changed on disk — no full reads and no binary sniffs at all.
    expect(readSpy).not.toHaveBeenCalled()
    expect(openSpy).not.toHaveBeenCalled()

    // Changing one file's size invalidates only that entry.
    await repo.writeFile('b.txt', 'x\ny\nz\n')
    const third = await svc.getStatus()
    expect(third.linesAdded).toBe(5)
    expect(readSpy).toHaveBeenCalledTimes(1)
  })

  it('caps the status lists that cross the IPC boundary', async () => {
    // 5100 untracked entries; the IPC cap is 5000. Protects the structured
    // clone broadcast to every open window on a pathological working tree.
    const total = 5100
    const batch = 500
    for (let start = 0; start < total; start += batch) {
      await Promise.all(
        Array.from({ length: Math.min(batch, total - start) }, (_, i) =>
          repo.writeFile(`f${String(start + i).padStart(5, '0')}.txt`, 'a\n')
        )
      )
    }

    const status = await svc.getStatus()
    expect(status.filesTruncated).toBe(true)
    expect(status.untracked).toHaveLength(5000)
    expect(status.files).toHaveLength(5000)
    // Line counting is separately budgeted and stops far earlier.
    expect(status.lineCountsTruncated).toBe(true)
    expect(status.linesAdded).toBe(200)
  })

  it('leaves lineCountsTruncated unset for an ordinary working tree', async () => {
    await repo.writeFile('a.txt', 'one\n')
    const status = await svc.getStatus()
    expect(status.lineCountsTruncated).toBeUndefined()
    expect(status.filesTruncated).toBeUndefined()
  })

  it('emits a single aggregated warn instead of one per unreadable file', async () => {
    await Promise.all(Array.from({ length: 5 }, (_, i) => repo.writeFile(`bad${i}.txt`, 'x\n')))
    // Simulate the real-world failure mode (EPERM / Windows long paths) for
    // just these five files; everything else must keep working.
    const realStat = fs.promises.stat
    vi.spyOn(fs.promises, 'stat').mockImplementation(((p: fs.PathLike) => {
      if (String(p).includes('bad')) {
        return Promise.reject(Object.assign(new Error('EPERM'), { code: 'EPERM' }))
      }
      return realStat(p)
    }) as unknown as typeof fs.promises.stat)
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    const status = await svc.getStatus()
    expect(status.untracked.length).toBe(5)
    const untrackedWarns = warnSpy.mock.calls.filter((c) =>
      String(c[1]).includes('untracked file(s) for line count')
    )
    expect(untrackedWarns).toHaveLength(1)
    expect(untrackedWarns[0][1]).toContain('Failed to read 5 untracked file(s)')
    expect(untrackedWarns[0][1]).toContain('bad0.txt')
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
    try {
      gitServiceManager.release(repo.path)
    } catch {
      /* noop */
    }
    try {
      gitServiceManager.release(repo.path)
    } catch {
      /* noop */
    }
    try {
      gitServiceManager.release(repo.path)
    } catch {
      /* noop */
    }
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
