import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { SEGMENT_TRAVERSAL } from './path-containment'
import { cwdToProjectKey } from '../../shared/project-key'

/**
 * Where a Claude transcript actually lives on disk.
 *
 * The app used to DERIVE a transcript's path from the session's cwd —
 * `~/.claude/projects/<cwdToProjectKey(cwd)>/<sid>.jsonl` — and that is wrong
 * for one case cli.js creates on its own: `EnterWorktree` relocates the live
 * transcript (the `.jsonl` AND its `<sid>/` folder) into the project dir of the
 * worktree path (`…/<repo>/.claude/worktrees/<name>` →
 * `-…-<repo>--claude-worktrees-<name>`), while the transcript's first user entry
 * keeps the ORIGINAL cwd. `ExitWorktree` moves it back. cli.js's own `--resume`
 * finds it either way; every reader here that derived the path from cwd missed
 * it (resume cost seed, identity seed, post-turn reconcile, canonical seed,
 * fork anchor).
 *
 * Kept out of `session-history.ts` on purpose: that module pulls in the DB and
 * the pricing tables, and the callers here (a session constructor, the create
 * path, the manager) need nothing but this lookup.
 */

function defaultProjectsRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects')
}

/**
 * Absolute path of a Claude transcript, or null. Tries the cwd-derived project
 * dir first (the common case, one existsSync), then scans
 * `~/.claude/projects/<dir>/<sid>.jsonl` (one readdir) — a transcript cli.js
 * relocated into a worktree's project dir lives under a key its session cwd
 * does not derive.
 *
 * Synchronous by design: callers sit in constructors and per-turn paths, and
 * the hint hit is a single stat. The scan is one readdir plus one stat per
 * project dir, paid only when the hint misses.
 *
 * @param root — overrides ~/.claude/projects; used by tests.
 */
export function locateClaudeTranscript(
  sessionId: string,
  cwdHint?: string,
  root: string = defaultProjectsRoot()
): string | null {
  // The id is interpolated into a path below — a separator or `..` segment
  // would let a caller probe (and a reader then open) any `*.jsonl` on disk.
  if (!sessionId || SEGMENT_TRAVERSAL.test(sessionId) || sessionId.includes('\0')) return null
  const fileName = `${sessionId}.jsonl`

  if (cwdHint) {
    const hinted = path.join(root, cwdToProjectKey(cwdHint), fileName)
    if (fs.existsSync(hinted)) return hinted
  }

  let dirs: string[]
  try {
    dirs = fs.readdirSync(root)
  } catch {
    return null
  }
  for (const dir of dirs) {
    const candidate = path.join(root, dir, fileName)
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

/**
 * The project key (directory name under ~/.claude/projects) a Claude
 * transcript lives under: the located file's parent dir when it exists, else
 * the cwd-derived key — which is what every caller used before, and where a
 * transcript that does not exist YET will be written.
 */
export function claudeProjectKeyFor(
  sessionId: string,
  cwd: string,
  root: string = defaultProjectsRoot()
): string {
  const located = locateClaudeTranscript(sessionId, cwd, root)
  return located ? path.basename(path.dirname(located)) : cwdToProjectKey(cwd)
}
