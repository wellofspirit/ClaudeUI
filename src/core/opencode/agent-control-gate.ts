/**
 * opencode's auto-mode edit gate (ADR-084 §3).
 *
 * In auto mode every opencode `edit` ask reaches ClaudeUI (`buildAutoModeRuleset`),
 * and `OpencodeSession.handleAutoModeApproval` clears the ordinary ones here,
 * host-side, with the shared agent-control matcher — no judge call. Anything
 * that names an agent-control path, or whose targets cannot all be told, goes
 * to the judge.
 *
 * What an `edit` ask names (vendor/opencode-src/packages/opencode/src/tool/):
 *  - `patterns`: the written path(s) relative to the project worktree —
 *    edit.ts:104/147, write.ts:56, apply_patch.ts:205. For apply_patch these
 *    are the SOURCE paths only; a move destination is not among them.
 *  - the approval's `input`: the tool call's own input when the event mapper
 *    found it (`{filePath, …}` for edit/write, `{patchText}` for apply_patch),
 *    else the ask's `metadata` (`{filepath, diff, …}`, or for apply_patch
 *    `{files: [{filePath, movePath?, …}]}` with absolute paths —
 *    apply_patch.ts:194-202).
 *
 * Patterns are resolved against the session cwd. opencode makes them relative
 * to the git worktree root, which ClaudeUI does not track; when cwd is the
 * worktree root (the usual case) that is exact, and when cwd is below it the
 * resolved path keeps at least the ancestors the real one does, so a match is
 * never lost (see `isAgentControlTarget` — inside cwd is matched relative,
 * outside it absolute).
 */
import { isAgentControlTarget } from '../automode/agent-control-paths'

/** apply_patch's move directive (vendor/opencode-src/packages/opencode/src/patch/index.ts:92). */
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
