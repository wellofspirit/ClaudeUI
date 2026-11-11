import type { EngineId } from './engine'

// ---------------------------------------------------------------------------
// Worktree types
// ---------------------------------------------------------------------------

export interface WorktreeInfo {
  worktreePath: string
  worktreeBranch: string
  worktreeName: string
  originalCwd: string
  gitRoot: string
  originalHeadCommit: string
  createdAt: number
  /**
   * Who made the worktree: `created` = ClaudeUI's own `createWorktree`, `detected` = parsed from
   * an engine event. Legacy entries carry none: an empty `originalHeadCommit` means detected.
   * Only `created` worktrees are offered for removal by the session-delete and quit modals.
   */
  origin?: 'created' | 'detected'
}

export interface WorktreeStatus {
  uncommittedFiles: number
  commitsAhead: number
  files: string[]
  /** Commits found only on this worktree's branch (or detached HEAD): what removing it would lose. */
  uniqueCommits: number
  /** The branch checked out in the worktree; null when detached. */
  branch: string | null
}

/** A directory that is a linked git worktree of some repo (filesystem facts, no git spawn). */
export interface LinkedWorktree {
  worktreePath: string
  repoRoot: string
  /** Last path segment. */
  name: string
  /** Branch from the worktree's HEAD; '' when detached. */
  branch: string
}

/** Something that keeps a worktree directory in use (a refusal when `live`, a warning otherwise). */
export interface WorktreeHolder {
  kind: 'session' | 'x-agent' | 'terminal'
  id: string
  label: string
  live: boolean
  engine?: EngineId
}

export interface WorktreeInventoryEntry {
  /** Stable wire key: the normalised absolute path (names collide across roots). */
  id: string
  /** Display name: last path segment. */
  name: string
  path: string
  /** By layout, display only: never a permission input. */
  location: 'managed' | 'opencode' | 'other'
  /**
   * worktree: registered in `git worktree list` and the directory is present.
   * orphan: a directory directly under the managed root that git does not list.
   * missing: registered, directory absent.
   */
  kind: 'worktree' | 'orphan' | 'missing'
  /** Branch from the porcelain listing; null when detached or unknown. */
  branch: string | null
  head: string | null
  locked: boolean
  lockReason?: string
  /** Set when remove will refuse the entry as `invalid`: the reason, shown as the row's subtext. */
  invalidReason?: string
  /** Ids of other entries whose directories sit inside this one; removed inner-first or refused. */
  contains: string[]
  holders: WorktreeHolder[]
}

export interface WorktreeInventory {
  /**
   * The repo's main checkout. Display only when `managedRoot` is '': for a bare repo's (or a
   * submodule's) worktrees the root is unknown and this falls back to the git directory, which is
   * not a usable cwd. Call the worktree functions with a path inside a worktree instead.
   */
  repoRoot: string
  /** `<repoRoot>/.claude/worktrees`; '' when the repo root cannot be determined. */
  managedRoot: string
  entries: WorktreeInventoryEntry[]
}

export interface WorktreeInspection {
  /** Changed files (`git status`); for an orphan, the files it still holds that are not links. */
  uncommittedFiles: number
  /** At most 20 paths. */
  uncommittedSample: string[]
  /** Entries git ignores (`status --ignored`), collapsed per directory; informational. */
  ignoredEntries: number
  /** Commits reachable from nowhere else (no other branch, remote-tracking ref or tag). */
  uniqueCommits: number
  /** At most 10 commits. */
  uniqueCommitSample: Array<{ sha: string; subject: string }>
}

export interface WorktreeSize {
  bytes: number
  files: number
  links: number
  errors: number
  /** Newest mtime of anything in the tree; 0 for an empty or missing one. */
  newestMtimeMs: number
}

export interface WorktreeRemoveResult {
  id: string
  outcome: 'removed' | 'refused' | 'partial' | 'failed'
  /** refused: `locked` | `in-use: <holder labels>` | `not-found` | `invalid: <why>`; failed: the error. */
  reason?: string
  /** partial: what could not be deleted (first 20). */
  failures?: Array<{ path: string; code: string }>
  branch?: {
    name: string
    action: 'deleted' | 'kept' | 'protected'
    uniqueCommits: number
    reason?: string
  }
}
