/**
 * opencode's auto-mode edit gate (ADR-084 §3).
 *
 * In auto mode every opencode `edit` ask reaches ClaudeUI (`permission-v2.ts` `autoModeGates`),
 * and `OpencodeSession.handleAutoModeApproval` clears the ordinary ones here,
 * host-side, with the shared agent-control matcher — no judge call. Anything
 * that names an agent-control path, or whose targets cannot all be told, goes
 * to the judge.
 *
 * What an `edit` ask names (vendor/opencode-src/packages/core/src/tool/plugin/):
 *  - `patterns` (the ask's resources): the written path(s) — edit.ts, write.ts,
 *    patch.ts; for a patch they include its move destinations.
 *  - the approval's `input`: the tool call's own input (`{path, …}` for
 *    edit/write, `{patchText}` for patch), else the ask's `metadata`
 *    (`{filepath, diff, files}`). The 1.x shapes (`filePath`, apply_patch's
 *    `files[].movePath`) are still read: they only add paths to check.
 *
 * Patterns are resolved against the session cwd. opencode makes them relative
 * to the git worktree root, which ClaudeUI does not track; when cwd is the
 * worktree root (the usual case) that is exact, and when cwd is below it the
 * resolved path keeps at least the ancestors the real one does, so a match is
 * never lost (see `isAgentControlTarget` — inside cwd is matched relative,
 * outside it absolute).
 */
import { isAgentControlTarget } from '../automode/agent-control-paths'

/** A patch's move directive (vendor/opencode-src/packages/util/src/patch.ts). */
const MOVE_TO = /^\s*\*\*\* Move to:(.*)$/i

/**
 * Every `*** Move to:` destination in a patch text, or null when one is empty.
 * Scanned more loosely than opencode parses (any line break, leading space,
 * any case): a line opencode would not read as a move only adds a path to
 * check, never hides one.
 */
export function applyPatchMoveDestinations(patchText: string): string[] | null {
  const moves: string[] = []
  for (const line of patchText.split(/\r\n|\r|\n/)) {
    const match = MOVE_TO.exec(line)
    if (!match) continue
    const destination = match[1].trim()
    if (!destination) return null
    moves.push(destination)
  }
  return moves
}

/**
 * Every path an opencode `edit` ask would write — its patterns plus what the
 * input adds (the edit/write path, apply_patch move destinations) — or null
 * when that cannot be determined (no patterns, or an input of no known shape).
 */
export function opencodeEditTargets(
  patterns: readonly string[] | undefined,
  input: Record<string, unknown>
): string[] | null {
  if (!patterns || patterns.length === 0) return null
  const targets = [...patterns]
  if (typeof input.patchText === 'string') {
    const moves = applyPatchMoveDestinations(input.patchText)
    if (moves === null) return null
    targets.push(...moves)
  } else if (Array.isArray(input.files)) {
    for (const file of input.files as unknown[]) {
      if (!file || typeof file !== 'object') return null
      const movePath = (file as { movePath?: unknown }).movePath
      if (movePath === undefined) continue
      if (typeof movePath !== 'string' || !movePath) return null
      targets.push(movePath)
    }
  } else if (typeof input.path === 'string') {
    // opencode 2.x `edit`/`write` (`tool/plugin/edit.ts`, `write.ts`: `filePath` → `path`).
    targets.push(input.path)
  } else if (typeof input.filePath === 'string' || typeof input.filepath === 'string') {
    targets.push((typeof input.filePath === 'string' ? input.filePath : input.filepath) as string)
  } else {
    return null
  }
  return targets
}

/** True when every target of this `edit` ask is clear of agent-control paths. */
export function editClearsAgentControl(
  patterns: readonly string[] | undefined,
  input: Record<string, unknown>,
  cwd: string
): boolean {
  const targets = opencodeEditTargets(patterns, input)
  return targets !== null && targets.every((target) => !isAgentControlTarget(target, cwd))
}
