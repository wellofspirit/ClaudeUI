import type { WorktreeInfo } from '../../../shared/types'
import { worktreeCwdKey } from '../../../shared/linked-worktree'

/**
 * The directory a session actually works in: its worktree when it entered one
 * (Claude `EnterWorktree`, opencode `session.moved`), else its spawn `cwd`. Everything git and
 * terminal keys on this; `cwd` itself stays the spawn directory (permissions, spawn, sidebar).
 * A session spawned in the worktree or a folder inside it keeps that folder: the listing's
 * linked-worktree marker names the worktree ROOT for any directory under it.
 */
export function sessionWorkdir(s: { cwd?: string; worktreeInfo?: WorktreeInfo | null }): string {
  const cwd = s.cwd || ''
  const worktree = s.worktreeInfo?.worktreePath || ''
  if (!worktree) return cwd
  if (cwd) {
    const cwdKey = worktreeCwdKey(cwd)
    const worktreeKey = worktreeCwdKey(worktree)
    if (cwdKey === worktreeKey || cwdKey.startsWith(`${worktreeKey}/`)) return cwd
  }
  return worktree
}
