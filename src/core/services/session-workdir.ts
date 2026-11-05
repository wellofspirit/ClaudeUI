import { existsSync } from 'fs'
import type { WorktreeInfo } from '../../shared/types'
import { sessionWorkdir } from '../../shared/session-workdir'

/**
 * The directory a session works in right now, main-side: the worktree it entered (the same rule the
 * renderer's `sessionWorkdir` applies for the terminal and git) while that directory exists, else
 * its spawn `cwd`. Read it at the moment of use: a session moves after its tool servers are built.
 */
export function currentWorkdir(
  cwd: string,
  info: WorktreeInfo | null | undefined,
  exists: (dir: string) => boolean = existsSync
): string {
  const dir = sessionWorkdir({ cwd, worktreeInfo: info })
  return dir === cwd || exists(dir) ? dir : cwd
}
