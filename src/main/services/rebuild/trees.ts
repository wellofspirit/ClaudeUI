/**
 * The source trees a desktop rebuild may build: the host's own list, never a
 * path a client supplies (a rebuild runs the tree's build scripts with the
 * user's rights). Clients see `{ id, name, branch, commit, dirty }`; the path
 * stays here, and a rebuild names a tree by its id, which is looked up in a
 * fresh listing.
 *
 * The source repository is the `appUpdateSourcePath` setting when set (an
 * absolute path; host-owned, see `saveUiSettings`), else a local build's own
 * `sourcePath` (build-info). Release builds without the setting have none.
 * Trees = `git worktree list --porcelain` of that repository (its main
 * checkout first), keeping only ClaudeUI checkouts: a `package.json` named
 * `claudui` and a `scripts/build.mjs`. Bare, missing and prunable entries are
 * dropped.
 */

import { createHash } from 'node:crypto'
import * as path from 'node:path'
import type { BuildInfo, DevBuildInfo } from '../../../shared/build-info'
import type { AppUpdateTree } from '../../../shared/types/app-update'
import type { Exec } from '../app-update/exec'
import { CLAUDEUI_PACKAGE_NAME, isClaudeUiCheckout } from '../../../core/services/claudeui-checkout'

// One rule with the admin setter of the rebuild source (`app-update:set-source`).
export { CLAUDEUI_PACKAGE_NAME, isClaudeUiCheckout }

export interface SourceTree extends AppUpdateTree {
  /** Host-side only: never in a view or a command result. */
  path: string
}

export interface PorcelainWorktree {
  path: string
  head: string | null
  /** `refs/heads/x` → `x`; null when detached. */
  branch: string | null
  bare: boolean
  prunable: boolean
}

/** `git worktree list --porcelain` output → its entries, in order (the main worktree first). */
export function parseWorktreePorcelain(text: string): PorcelainWorktree[] {
  const out: PorcelainWorktree[] = []
  let cur: PorcelainWorktree | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (line === '') {
      if (cur) out.push(cur)
      cur = null
      continue
    }
    const sp = line.indexOf(' ')
    const key = sp < 0 ? line : line.slice(0, sp)
    const value = sp < 0 ? '' : line.slice(sp + 1)
    if (key === 'worktree') {
      if (cur) out.push(cur)
      cur = { path: value, head: null, branch: null, bare: false, prunable: false }
      continue
    }
    if (!cur) continue
    if (key === 'HEAD' && /^[0-9a-f]{7,64}$/.test(value)) cur.head = value
    else if (key === 'branch') cur.branch = value.replace(/^refs\/heads\//, '')
    else if (key === 'detached') cur.branch = null
    else if (key === 'bare') cur.bare = true
    else if (key === 'prunable') cur.prunable = true
  }
  if (cur) out.push(cur)
  return out.filter((w) => w.path !== '')
}

/** The id a tree is named by: the first 16 hex of sha256 of its resolved path. */
export function treeIdFor(treePath: string): string {
  return createHash('sha256').update(path.resolve(treePath), 'utf8').digest('hex').slice(0, 16)
}

/**
 * The repository to list trees from: the setting (an absolute path) when set,
 * else a local build's `sourcePath`; null when there is none.
 */
export function sourceRepoFor(
  setting: string | undefined,
  info: BuildInfo | DevBuildInfo
): string | null {
  const configured = typeof setting === 'string' ? setting.trim() : ''
  if (configured !== '') return path.isAbsolute(configured) ? path.resolve(configured) : null
  if (
    info.kind === 'local' &&
    typeof info.sourcePath === 'string' &&
    path.isAbsolute(info.sourcePath)
  )
    return path.resolve(info.sourcePath)
  return null
}

export interface ListTreesDeps {
  exec: Exec
  /** Defaults to {@link isClaudeUiCheckout}. */
  isCheckout?: (dir: string) => boolean
  log?: (message: string) => void
}

const GIT_TIMEOUT_MS = 20_000

/** The ClaudeUI trees of `repo`, with their paths (host-side). Empty when git cannot list them. */
export async function listTrees(repo: string, deps: ListTreesDeps): Promise<SourceTree[]> {
  const log = deps.log ?? (() => {})
  const isCheckout = deps.isCheckout ?? isClaudeUiCheckout
  const listed = await deps.exec('git', ['-C', repo, 'worktree', 'list', '--porcelain'], {
    timeoutMs: GIT_TIMEOUT_MS
  })
  if (listed.code !== 0) {
    log(`git worktree list failed (exit ${listed.code})`)
    return []
  }
  const entries = parseWorktreePorcelain(listed.stdout)
  const main = entries[0]?.path
  const kept = entries.filter((w) => !w.bare && !w.prunable && isCheckout(w.path))
  return Promise.all(
    kept.map(async (w): Promise<SourceTree> => {
      // --no-optional-locks: listing must never take index.lock in a worktree an agent commits in.
      const status = await deps.exec(
        'git',
        ['-C', w.path, '--no-optional-locks', 'status', '--porcelain'],
        {
          timeoutMs: GIT_TIMEOUT_MS
        }
      )
      const dirty =
        status.code === 0 ? status.stdout.split(/\r?\n/).filter((l) => l.trim() !== '').length : 0
      return {
        id: treeIdFor(w.path),
        path: path.resolve(w.path),
        name: w.path === main ? 'main checkout' : path.basename(w.path),
        branch: w.branch,
        commit: w.head ? w.head.slice(0, 7) : null,
        dirty
      }
    })
  )
}

/** A tree as every client sees it: no path. */
export function publicTree(t: SourceTree): AppUpdateTree {
  return { id: t.id, name: t.name, branch: t.branch, commit: t.commit, dirty: t.dirty }
}
