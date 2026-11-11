// ---------------------------------------------------------------------------
// Git integration types
// ---------------------------------------------------------------------------

export interface GitFileStatus {
  path: string
  index: string // staged status: ' '|'M'|'A'|'D'|'R'|'?'|'!'
  working: string // working tree status
}

export interface GitStatusData {
  branch: string
  ahead: number
  behind: number
  trackingBranch: string | null
  files: GitFileStatus[]
  staged: string[]
  unstaged: string[]
  untracked: string[]
  linesAdded: number
  linesRemoved: number
  /**
   * True when the untracked-file line-count pass hit its file-count or byte
   * budget, so `linesAdded` undercounts. The files themselves are still listed.
   */
  lineCountsTruncated?: boolean
  /** True when `files`/`staged`/`unstaged`/`untracked` were capped for IPC. */
  filesTruncated?: boolean
}

/** One branch row of the branch dropdown, from a single `git for-each-ref`. */
export interface GitBranchDetail {
  /** `feat/x` for a local branch, `origin/feat/x` for a remote-tracking one. */
  name: string
  kind: 'local' | 'remote'
  /** Last commit time, unix seconds. */
  commitTime: number
  /** Short upstream name (`origin/feat/x`); local branches only. */
  upstream?: string
  /** Commits ahead of / behind the upstream (0 without one, and when `gone`). */
  ahead: number
  behind: number
  /** The upstream branch was deleted on the remote. */
  gone: boolean
  /** The branch ClaudeUI's checkout is on. */
  current: boolean
  /**
   * Checked out in ANOTHER worktree (git refuses to check it out twice): where, and whether
   * that is the repository's main checkout rather than a linked worktree.
   */
  worktree?: { path: string; main: boolean }
}

/** A stash made by the dropdown's "Stash and switch" (`ClaudeUI autostash: <branch> <ISO time>`). */
export interface GitAutostash {
  sha: string
  /** The branch the changes were stashed from. */
  branch: string
  /** ISO time from the stash label. */
  time: string
}

/** The pull settings git would apply, read with `git config --get` (any scope). */
export interface GitPullConfig {
  /** `pull.rebase` / `branch.<current>.rebase`: `rebase` (true/merges/interactive), `merge` (false), or unset. */
  rebase: 'rebase' | 'merge' | null
  /** `pull.ff`, lowercased; null when unset. */
  ff: 'only' | 'true' | 'false' | null
}

export interface GitBranchData {
  current: string
  local: string[]
  remote: string[]
  tracking: Record<string, string>
  /** Every local and remote-tracking branch, newest commit first. */
  details: GitBranchDetail[]
  /** ClaudeUI autostashes in the (repository-wide) stash stack, newest first. */
  autostashes: GitAutostash[]
  pullConfig: GitPullConfig
  /** Commits of the current branch that no remote has yet; counted only while it has no upstream. */
  unpublished: number
}
