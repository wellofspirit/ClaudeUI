import type { LinkedWorktree } from './worktree'
import type { SessionInfo } from './session'

export interface DirEntry {
  name: string
  isDirectory: boolean
}

/**
 * Where a directory browse can sensibly START on the host — the places rail of
 * the remote picker (ADR-046). Every field is best-effort: the host answers
 * with whatever it could determine and the rail hides the rest, so a probe
 * failure costs one shortcut rather than the whole dialog.
 */
export interface ListPlacesResult {
  /** Home directory, POSIX-normalized without a trailing separator. `''` when unknown. */
  home: string
  /** Host machine name, rendered as the dialog's "on <hostname>". `''` when unknown. */
  hostname: string
  /** Reachable filesystem roots: `['C:/', 'D:/']` on Windows, `['/']` elsewhere. */
  drives: string[]
}

export interface DirectoryGroup {
  cwd: string
  projectKey: string
  folderName: string
  sessions: SessionInfo[]
  /**
   * Set (main side, filesystem facts only) when `cwd` is a linked git worktree, wherever it
   * lives (`<repo>/.claude/worktrees`, opencode's data dir). Every session
   * row in this group is a worktree session; the sidebar and the pill read it by normalised cwd.
   */
  linkedWorktree?: LinkedWorktree
}
