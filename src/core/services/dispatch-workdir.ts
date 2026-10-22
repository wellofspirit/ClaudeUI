/**
 * Where an X-Agent may be told to run (`dispatch_agent`'s `workdir`, ADR-033 / ADR-105): a
 * directory the dispatching session itself may work in, so naming it hands the target nothing the
 * parent did not have. That is the parent's own working directory, or one of the user's
 * `additionalDirectories` (the merge of the user, project and local Claude settings).
 *
 * One function, called from `CrossEngineDispatcher.launchRun` before anything spawns. The
 * containment test is `session-tools`' (`withinOrEqual`, the one `session_start` applies to its
 * `cwd`): both sides are compared by real path, so a symlink or a junction inside the parent's tree
 * that leads out of it is outside.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { uiPath, withinOrEqual } from './session-tools'

export type WorkdirResolution =
  | {
      ok: true
      /** The directory's real path, in the style a session's cwd carries (`uiPath`): where the target runs. */
      cwd: string
    }
  | { ok: false; text: string }

/** `~` and `~/x` are the user's home; `~name` is not expanded (it is a relative name). */
function expandHome(p: string): string {
  if (p === '~') return os.homedir()
  return p.startsWith('~/') || p.startsWith('~\\') ? path.join(os.homedir(), p.slice(2)) : p
}

/**
 * Resolve `workdir` (absolute, `~`-relative, or relative to `parentCwd`) and check that it is an
 * existing directory inside `parentCwd` or one of `additionalDirectories`.
 *
 * The answer is the REAL path, not the spelling given: what was checked is what the target is
 * started in, so a link swapped in after this returns cannot redirect it. The containment verdict
 * comes before the existence one, so a refusal never tells the caller whether a path OUTSIDE its
 * reach exists. An additional directory that does not exist contains nothing and is skipped by the
 * comparison itself.
 */
export function resolveDispatchWorkdir(
  workdir: string,
  parentCwd: string,
  additionalDirectories: readonly string[] = []
): WorkdirResolution {
  const resolved = path.resolve(parentCwd, expandHome(workdir))
  const shown = workdir === resolved ? resolved : `${workdir} (${resolved})`
  const roots = [
    ...new Set([
      parentCwd,
      ...additionalDirectories.map((dir) => path.resolve(parentCwd, expandHome(dir)))
    ])
  ]
  if (!roots.some((root) => withinOrEqual(root, resolved))) {
    return {
      ok: false,
      text:
        `dispatch_agent "workdir" ${shown} is not inside your working directory or the user's ` +
        `additional directories (${roots.join(', ')}). Use a directory inside one of them.`
    }
  }
  let real: string
  try {
    real = fs.realpathSync.native(resolved)
    if (!fs.statSync(real).isDirectory()) {
      return { ok: false, text: `dispatch_agent "workdir" ${shown} is not a directory.` }
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return {
      ok: false,
      text:
        code === 'ENOENT' || code === 'ENOTDIR'
          ? `dispatch_agent "workdir" ${shown} does not exist. Create the directory first ` +
            '(a git worktree, for instance), then dispatch again.'
          : `dispatch_agent "workdir" ${shown} cannot be read (${code ?? 'unreadable'}).`
    }
  }
  return { ok: true, cwd: uiPath(real) }
}
