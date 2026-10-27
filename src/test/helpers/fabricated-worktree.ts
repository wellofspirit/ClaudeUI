/**
 * A fabricated repo and linked worktree on disk: a `.git` directory plus the handful of files git
 * keeps under `worktrees/<id>`. No git is spawned, which is all the filesystem-only detection
 * (`linkedWorktreeOf`) reads.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const write = (p: string, content: string): void => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}

export function makeScratchDir(prefix = 'claudeui-fab-'): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
}

/** A main checkout (a `.git` directory). */
export function fabricateRepo(root: string): string {
  fs.mkdirSync(path.join(root, '.git'), { recursive: true })
  return root
}

/**
 * Register `worktreePath` as a linked worktree of the repo at `root`. `head` is the worktree's
 * HEAD file content: a `ref: refs/heads/<b>` line, or a sha for a detached worktree.
 */
export function fabricateWorktree(
  root: string,
  worktreePath: string,
  id: string,
  head = 'ref: refs/heads/worktree-feat'
): string {
  const common = path.join(root, '.git')
  const admin = path.join(common, 'worktrees', id)
  write(path.join(admin, 'commondir'), `${common}\n`)
  write(path.join(admin, 'gitdir'), `${path.join(worktreePath, '.git')}\n`)
  write(path.join(admin, 'HEAD'), `${head}\n`)
  write(path.join(worktreePath, '.git'), `gitdir: ${admin}\n`)
  return worktreePath
}
