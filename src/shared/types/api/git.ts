import type { GitBranchData, GitStatusData } from '../git'

export interface GitAPI {
  gitCheckRepo(cwd: string): Promise<boolean>
  gitGetStatus(cwd: string): Promise<GitStatusData>
  gitGetBranches(cwd: string): Promise<GitBranchData>
  gitCheckout(cwd: string, branch: string): Promise<void>
  /** `base` = the commit-ish to branch from (`checkout -b name base`); omitted = the current HEAD. */
  gitCreateBranch(cwd: string, name: string, base?: string | null): Promise<void>
  gitGetFilePatch(
    cwd: string,
    filePath: string,
    staged: boolean,
    ignoreWhitespace: boolean
  ): Promise<{ patch: string; isBinary?: boolean }>
  gitGetFileContents(
    cwd: string,
    filePath: string,
    staged: boolean
  ): Promise<{ oldContent: string; newContent: string }>
  gitStageFile(cwd: string, filePath: string): Promise<void>
  gitUnstageFile(cwd: string, filePath: string): Promise<void>
  gitDiscardFile(cwd: string, filePath: string): Promise<void>
  gitStageAll(cwd: string): Promise<void>
  gitUnstageAll(cwd: string): Promise<void>
  gitCommit(cwd: string, message: string): Promise<string>
  gitPush(cwd: string): Promise<void>
  gitPushWithUpstream(cwd: string, branch: string): Promise<void>
  /** `mode` picks how a diverged pull reconciles (`--rebase` / `--no-rebase`); omitted = git's own config. */
  gitPull(cwd: string, mode?: 'merge' | 'rebase'): Promise<{ summary: string }>
  /** `git stash push -u` labelled `ClaudeUI autostash: <branch> <ISO time>`. */
  gitStashPush(cwd: string): Promise<void>
  /** Apply the stash with this commit sha, then drop exactly that entry. A conflict leaves it in place. */
  gitStashRestore(cwd: string, sha: string): Promise<void>
  gitFetch(cwd: string): Promise<void>
  /**
   * Replace this connection's set of git-watched cwds (phase 5 S2).
   *
   * The union of every connection's set drives the host's polling, so `[]` is how
   * a client stops watching and there is no separate stop verb. Per-connection:
   * the set dies with the socket, which is why the watcher re-sends on every
   * answered `sync`. Bounded server-side (`MAX_GIT_WATCH`); an over-long set is
   * refused rather than clipped. Answering always emits a `git:status-update` for
   * every cwd in the set — a fresh poller's first tick, or the cached status.
   */
  watchGit(cwds: string[]): Promise<void>
}
