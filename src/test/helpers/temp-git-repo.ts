/**
 * makeTempGitRepo — create an isolated throwaway git repository for tests.
 *
 * Returns the absolute path plus a cleanup() fn. Tests should call cleanup()
 * in afterEach/afterAll to remove the tmp dir. Uses os.tmpdir() so nothing
 * persists between test runs.
 *
 * Keep the surface minimal — the tests themselves interact with `simple-git`
 * or run raw commands as needed; this helper only bootstraps the repo.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import simpleGit, { type SimpleGit } from 'simple-git'

export interface TempGitRepo {
  /** Absolute path to the repo root */
  path: string
  /** simple-git handle bound to the repo */
  git: SimpleGit
  /** Write a file relative to the repo root, creating parents */
  writeFile: (relPath: string, content: string) => Promise<void>
  /** Read a file relative to the repo root */
  readFile: (relPath: string) => Promise<string>
  /** Delete a file from the working tree */
  unlink: (relPath: string) => Promise<void>
  /** Convenience: stage, commit, return commit hash */
  commit: (message: string, paths?: string[]) => Promise<string>
  /** Clean up the repo dir */
  cleanup: () => Promise<void>
}

export interface MakeTempRepoOptions {
  /** Initial commit message. Default "initial". null/false = no initial commit. */
  initialCommit?: string | false | null
  /** Seed files created before the initial commit (relPath -> content) */
  seed?: Record<string, string>
  /** Default branch name. Default "main". */
  defaultBranch?: string
  /** Author name (for commits). Default "Test User". */
  author?: { name: string; email: string }
  /** Whether to allow symlinks on Windows (noop elsewhere). Default false. */
  allowSymlinks?: boolean
}

const DEFAULT_AUTHOR = { name: 'Test User', email: 'test@example.com' }

export async function makeTempGitRepo(opts: MakeTempRepoOptions = {}): Promise<TempGitRepo> {
  const repoPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'claudeui-git-test-'))
  const defaultBranch = opts.defaultBranch ?? 'main'
  const author = opts.author ?? DEFAULT_AUTHOR

  const git = simpleGit(repoPath)
  await git.init(['--initial-branch=' + defaultBranch])
  // Pin author to avoid depending on the test runner's global git config
  await git.addConfig('user.name', author.name)
  await git.addConfig('user.email', author.email)
  await git.addConfig('commit.gpgsign', 'false')
  await git.addConfig('tag.gpgsign', 'false')

  const writeFile = async (relPath: string, content: string): Promise<void> => {
    const abs = path.join(repoPath, relPath)
    await fs.promises.mkdir(path.dirname(abs), { recursive: true })
    await fs.promises.writeFile(abs, content, 'utf-8')
  }
  const readFile = async (relPath: string): Promise<string> => {
    return fs.promises.readFile(path.join(repoPath, relPath), 'utf-8')
  }
  const unlink = async (relPath: string): Promise<void> => {
    await fs.promises.unlink(path.join(repoPath, relPath))
  }
  const commit = async (message: string, paths: string[] = []): Promise<string> => {
    if (paths.length > 0) await git.add(paths)
    else await git.add('-A')
    const res = await git.commit(message, { '--allow-empty': null })
    return res.commit
  }

  if (opts.seed) {
    for (const [rel, content] of Object.entries(opts.seed)) {
      await writeFile(rel, content)
    }
  }

  if (opts.initialCommit !== false && opts.initialCommit !== null) {
    const msg = opts.initialCommit ?? 'initial'
    // Ensure at least one file exists so the initial commit isn't empty
    if (!opts.seed || Object.keys(opts.seed).length === 0) {
      await writeFile('README.md', '# test repo\n')
    }
    await git.add('-A')
    await git.commit(msg)
  }

  const cleanup = async (): Promise<void> => {
    try {
      await fs.promises.rm(repoPath, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // Windows may still hold file handles briefly — ignore; next run's mkdtemp makes a fresh dir anyway.
    }
  }

  return { path: repoPath, git, writeFile, readFile, unlink, commit, cleanup }
}

/**
 * Create a bare remote repo that can be used as push/pull target for another
 * tempGitRepo. Returns the absolute path + cleanup.
 */
export async function makeBareRemoteRepo(): Promise<{
  path: string
  cleanup: () => Promise<void>
}> {
  const repoPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'claudeui-git-remote-'))
  await simpleGit(repoPath).init(['--bare'])
  return {
    path: repoPath,
    cleanup: async () => {
      try {
        await fs.promises.rm(repoPath, { recursive: true, force: true, maxRetries: 5 })
      } catch {
        /* ignore */
      }
    }
  }
}
