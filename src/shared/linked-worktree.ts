/**
 * Reading the `linkedWorktree` marker the main process puts on a directory group
 * (`DirectoryGroup.linkedWorktree`, set in `sync-seed.listAllDirectories`).
 *
 * Pure and dependency-free so the renderer (which cannot import the core path helpers) and the
 * replica projection share one lookup. The cwd key is derived from the path's OWN shape, not from
 * `window.api.platform`: the web client reports `web` for every host OS, and engines hand the same
 * Windows directory back with either separator (opencode keeps forward slashes, Claude backslashes).
 */

import type { DirectoryGroup, LinkedWorktree, WorktreeInfo } from './types'

const cwdKeyMemo = new Map<string, string>()
const CWD_KEY_MEMO_MAX = 4096

function computeWorktreeCwdKey(p: string): string {
  let r = p.replace(/\\/g, '/').replace(/^\/\/\?\//, '')
  const windows = /^[A-Za-z]:/.test(r) || r.startsWith('//')
  if (r.length > 1 && !/^[A-Za-z]:\/$/.test(r)) r = r.replace(/\/+$/, '')
  return windows ? r.toLowerCase() : r
}

/**
 * One spelling per directory: forward slashes, no extended-length prefix, no trailing slash,
 * lower-cased when it is a Windows path. Memoised per input string: every sidebar row selector
 * calls it on each store update.
 */
export function worktreeCwdKey(p: string): string {
  if (!p) return ''
  const memo = cwdKeyMemo.get(p)
  if (memo !== undefined) return memo
  const key = computeWorktreeCwdKey(p)
  if (cwdKeyMemo.size >= CWD_KEY_MEMO_MAX) cwdKeyMemo.clear()
  cwdKeyMemo.set(p, key)
  return key
}

const indexCache = new WeakMap<readonly DirectoryGroup[], ReadonlyMap<string, LinkedWorktree>>()

/** Marked groups of a listing by cwd key. Cached per listing array (the replica swaps the array on change). */
export function linkedWorktreeIndex(
  directories: readonly DirectoryGroup[]
): ReadonlyMap<string, LinkedWorktree> {
  let index = indexCache.get(directories)
  if (!index) {
    const built = new Map<string, LinkedWorktree>()
    for (const g of directories) {
      if (g.linkedWorktree) built.set(worktreeCwdKey(g.cwd), g.linkedWorktree)
    }
    index = built
    indexCache.set(directories, index)
  }
  return index
}

/** The linked worktree `cwd` is the directory of, per the listing; null when it is not (or not listed). */
export function linkedWorktreeFor(
  directories: readonly DirectoryGroup[],
  cwd: string | null | undefined
): LinkedWorktree | null {
  if (!cwd) return null
  return linkedWorktreeIndex(directories).get(worktreeCwdKey(cwd)) ?? null
}

/**
 * The `WorktreeInfo` a session in a linked worktree shows when nothing explicit was recorded
 * (`worktreeInfoMap[id]` always wins). Not offered for removal: `origin: 'detected'`, and an empty
 * `originalHeadCommit` marks it as never created by ClaudeUI. An empty branch (detached HEAD)
 * hides the pill's branch row.
 */
export function worktreeInfoFromLinked(lw: LinkedWorktree): WorktreeInfo {
  return {
    worktreePath: lw.worktreePath,
    worktreeBranch: lw.branch,
    worktreeName: lw.name,
    originalCwd: lw.repoRoot,
    gitRoot: lw.repoRoot,
    originalHeadCommit: '',
    createdAt: 0,
    origin: 'detected'
  }
}

/**
 * Did ClaudeUI create this worktree (so the session-delete and quit modals may offer removing it)?
 * Entries written before `origin` existed carry none: an empty `originalHeadCommit` means detected.
 */
export function isCreatedWorktree(
  info: Pick<WorktreeInfo, 'origin' | 'originalHeadCommit'>
): boolean {
  return info.origin ? info.origin === 'created' : info.originalHeadCommit !== ''
}
