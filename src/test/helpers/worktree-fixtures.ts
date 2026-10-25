/**
 * Scratch scaffolding for worktree tests: a throwaway base directory (for out-of-repo worktree
 * layouts, a sentinel that links point at, a fake home) and a few git conveniences. Everything
 * lives under os.tmpdir(); cleanup only ever touches the base this created.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { TempGitRepo } from './temp-git-repo'
import { normaliseWorktreePath } from '../../core/services/worktree-root'

export interface Scratch {
  base: string
  /** A directory a test points links at; `keep.txt` and `sub/deep.txt` must survive any removal. */
  sentinel: string
  sentinelIntact(): boolean
  cleanup(): void
}

export function makeScratch(): Scratch {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeui-wtscratch-'))
  const sentinel = path.join(base, 'sentinel')
  fs.mkdirSync(path.join(sentinel, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(sentinel, 'keep.txt'), 'precious')
  fs.writeFileSync(path.join(sentinel, 'sub', 'deep.txt'), 'precious too')
  return {
    base,
    sentinel,
    sentinelIntact: () => {
      try {
        return (
          fs.readFileSync(path.join(sentinel, 'keep.txt'), 'utf-8') === 'precious' &&
          fs.readFileSync(path.join(sentinel, 'sub', 'deep.txt'), 'utf-8') === 'precious too'
        )
      } catch {
        return false
      }
    },
    cleanup: () => {
      try {
        fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 })
      } catch {
        // a Windows handle may linger; the next run makes a fresh base
      }
    }
  }
}

/** A directory junction (Windows) / symlink (elsewhere) at `at`, pointing at `target`. */
export function makeLink(target: string, at: string): void {
  fs.mkdirSync(path.dirname(at), { recursive: true })
  fs.symlinkSync(target, at, 'junction')
}

/** `git worktree add` at an arbitrary path (detached unless a branch is named). */
export async function addWorktreeAt(
  repo: TempGitRepo,
  at: string,
  opts: { branch?: string; detach?: boolean } = {}
): Promise<void> {
  const args = ['worktree', 'add']
  if (opts.branch) args.push('-b', opts.branch)
  else if (opts.detach !== false) args.push('--detach')
  args.push(at)
  await repo.git.raw(args)
}

/** The normalised paths `git worktree list` reports (main worktree included). */
export async function registeredPaths(repo: TempGitRepo): Promise<string[]> {
  const out = await repo.git.raw(['worktree', 'list', '--porcelain'])
  return out
    .split(/\r?\n/)
    .filter((l) => l.startsWith('worktree '))
    .map((l) => normaliseWorktreePath(l.slice('worktree '.length)))
}
