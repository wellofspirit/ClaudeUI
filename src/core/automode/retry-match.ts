/**
 * The harness fact behind decision 4 (anti re-roll): is the action now being
 * judged a RETRY of a call the harness already refused?
 *
 * The judge cannot work this out reliably from prose, and the transcript gives
 * it no tool-use ids — `slimTranscript` renders prior calls as
 * `<toolName> <json input>` lines with no id (classifier.ts). So the fact is
 * computed here, purely, from what the judge is already given
 * ({@link RetryMatchInput}) and merged into the `{"meta":…}` line by
 * `buildUserPrompt`:
 *
 * ```
 * {"meta":{"retryOf":{"match":"identical"|"subset","outcome":"automode-blocked"|
 *   "rejected-by-user","call":"<the earlier call, as the transcript renders it>"}}}
 * ```
 *
 * `call` is the SAME string the transcript renders for that call
 * ({@link renderToolCall}), cut to {@link RETRY_CALL_MAX_CHARS} characters plus
 * `…`, so the judge can point at it. Matching is deliberately narrow:
 *
 * - only prior calls whose recorded outcome is `automode-blocked` or
 *   `rejected-by-user` (a denied call is a decision; `ok`/`error`/`unanswered`
 *   are not);
 * - the same tool name;
 * - `identical` — for a shell call, the same whitespace-normalised `command` in
 *   the same `workdir` (resolved against the session cwd when the caller supplies
 *   one, so a re-spelling of the same directory still matches; other keys such as
 *   a `description` are ignored); for any other tool, a deep-equal input;
 * - `subset` — for a shell command in the same `workdir`, every top-level segment of the current
 *   command (`&&` `||` `;` / newline — NOT `|`) also appears among the earlier
 *   call's segments, and the commands differ; for an edit tool carrying an
 *   `edits` array, the same target path and every current edit present in the
 *   earlier list;
 * - anything else is no fact at all (the judge judges it on its merits).
 *
 * Most recent match wins. No fact is emitted rather than a guess: a wrong
 * `identical` would read as an unconsented re-roll, and a wrong `subset` would
 * hide a changed action behind an old refusal.
 *
 * Pure and engine-neutral (no fs, no clock, no engine imports): the retry check
 * runs inside the classifier on every judge call, including the confirmation
 * sample.
 */
import type { ChatMessage } from '../../shared/types'
import type { ToolOutcome } from './ground-truth'
import { normalizePath, resolveTarget, shellCommandOf } from './shell-lexical'

/** How much of the earlier call the fact carries (the transcript's own line, cut). */
export const RETRY_CALL_MAX_CHARS = 300

/** The marker a cut `call` ends with. */
const CUT_MARKER = '…'

/** The outcomes that mean "the harness refused this call" (see `ToolOutcome`). */
const RETRY_OUTCOMES: ReadonlySet<ToolOutcome> = new Set<ToolOutcome>([
  'automode-blocked',
  'rejected-by-user'
])

/** What a matching earlier refusal is, as the judge is told it. */
export interface RetryFact {
  match: 'identical' | 'subset'
  outcome: 'automode-blocked' | 'rejected-by-user'
  /** The earlier call as the transcript renders it (cut to {@link RETRY_CALL_MAX_CHARS}). */
  call: string
}

/** What {@link retryFactOf} reads: the same pieces {@link ClassifyInput} carries. */
export interface RetryMatchInput {
  messages: ChatMessage[]
  outcomes?: Record<string, ToolOutcome>
  action: { toolName: string; input: Record<string, unknown> }
  /** The session working directory; without it `workdir` is compared as written. */
  cwd?: string
  /** The host platform, so a win32 workdir comparison ignores case. */
  platform?: NodeJS.Platform
}

/**
 * A tool call as the judge's transcript renders it — ONE function for the
 * transcript (`slimTranscript`) and for `retryOf.call`, so the string the judge
 * is asked to look for is byte-identical to the line it can see.
 */
export function renderToolCall(
  toolName: string,
  toolInput: Record<string, unknown> | undefined
): string {
  return `${toolName} ${JSON.stringify(toolInput ?? {})}`
}

/** Tool names whose input names a file to write (pi, opencode, Codex shapes). */
const EDIT_TOOL_NAMES: ReadonlySet<string> = new Set([
  'edit',
  'write',
  'multiedit',
  'apply_patch',
  'patch',
  'notebookedit',
  'notebook_edit'
])

/** Edit tools whose targets live in a patch text, not a path argument. */
const PATCH_TOOL_NAMES: ReadonlySet<string> = new Set(['apply_patch', 'patch'])

/** `*** Add File: p` / `*** Update File: p` / `*** Delete File: p` (apply_patch). */
const PATCH_FILE_HEADER = /^\s*\*\*\*\s*(?:Add|Update|Delete) File:\s*(.*?)\s*$/i
/** `*** Move to: p` — an update that also writes its destination. */
const PATCH_MOVE_TO = /^\s*\*\*\*\s*Move to:\s*(.*?)\s*$/i

/** True when `toolName` is an edit-class tool (its input names what it writes). */
export function isEditTool(toolName: string): boolean {
  return EDIT_TOOL_NAMES.has(toolName.trim().toLowerCase())
}

/** The single path an edit-style input carries, in any engine's spelling. */
function pathArgumentOf(input: Record<string, unknown>): string | undefined {
  for (const key of ['path', 'file_path', 'filePath', 'filepath', 'notebook_path']) {
    const value = input[key]
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return undefined
}

/**
 * Every path an edit-class action would write, or `null` when that cannot be
 * told for a PATCH (no patch text, no readable file header, an empty header) —
 * the caller sends that to the full review rather than assuming the patch is
 * innocent. `[]` for a tool that is not an edit tool at all, and for an
 * edit/write whose input carries no path argument at all: such a call writes
 * nothing (the tool itself would reject it), so it is not evidence of an
 * agent-control target.
 *
 * Read conservatively: a header line this parser does not recognise simply
 * contributes no path. The shapes are pi's `path` / legacy `file_path`,
 * opencode's `filePath` (and 2.x `path`), Claude's `notebook_path`, and
 * apply_patch/patch's header lines. ANY edit-class input carrying a string
 * `patchText` is read as a patch (exit review #7): opencode judges its `edit`
 * category for write, edit AND patch tools, so the tool name cannot be trusted
 * to say which of them it was.
 */
export function editPathsOf(toolName: string, input: Record<string, unknown>): string[] | null {
  if (!isEditTool(toolName)) return []
  if (typeof input.patchText === 'string') {
    const paths: string[] = []
    for (const line of input.patchText.split(/\r\n|\r|\n/)) {
      const match = PATCH_FILE_HEADER.exec(line) ?? PATCH_MOVE_TO.exec(line)
      if (!match) continue
      const target = match[1].trim()
      if (target.length === 0) return null
      paths.push(target)
    }
    return paths.length > 0 ? paths : null
  }
  if (PATCH_TOOL_NAMES.has(toolName.trim().toLowerCase())) return null
  const path = pathArgumentOf(input)
  return path === undefined ? [] : [path]
}

/** Collapse every run of whitespace (newlines included) and trim. */
function normalizeCommand(command: string): string {
  return command.replace(/\s+/g, ' ').trim()
}

/**
 * Split a shell command at its TOP-LEVEL `&&`, `||`, `;` and newlines — never
 * `|` (a pipeline is one action: `ls | sh` must not look like a subset of a
 * blocked `ls`). Quote-aware for single and double quotes and backslash
 * escapes; an unbalanced quote leaves the rest of the command in one segment,
 * so the worst case is "no subset fact", never a false one.
 */
export function splitShellSegments(command: string): string[] {
  const segments: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < command.length; i++) {
    const char = command[i]
    if (quote !== null) {
      current += char
      if (char === '\\' && quote === '"' && i + 1 < command.length) {
        current += command[++i]
        continue
      }
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === '\\' && i + 1 < command.length) {
      current += char + command[++i]
      continue
    }
    if (char === ';' || char === '\n' || char === '\r') {
      segments.push(current)
      current = ''
      continue
    }
    if ((char === '&' || char === '|') && command[i + 1] === char) {
      segments.push(current)
      current = ''
      i++
      continue
    }
    current += char
  }
  segments.push(current)
  return segments.map(normalizeCommand).filter((segment) => segment.length > 0)
}

/** Structural equality over JSON-shaped values (key order irrelevant). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((value, i) => deepEqual(value, b[i]))
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const aRecord = a as Record<string, unknown>
  const bRecord = b as Record<string, unknown>
  const aKeys = Object.keys(aRecord)
  const bKeys = Object.keys(bRecord)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(bRecord, key) && deepEqual(aRecord[key], bRecord[key])
  )
}

/** Current segments all appear among the earlier call's, and the commands differ. */
function isShellSubset(current: string, earlier: string): boolean {
  if (normalizeCommand(current) === normalizeCommand(earlier)) return false
  const currentSegments = splitShellSegments(current)
  if (currentSegments.length === 0) return false
  const earlierSegments = new Set(splitShellSegments(earlier))
  return currentSegments.every((segment) => earlierSegments.has(segment))
}

/**
 * `subset` for an edit tool: the same target and every current edit present in
 * the earlier `edits` array. An edit shape without an `edits` array on both
 * sides is not a subset — it is either identical (handled above) or different.
 */
function isEditSubset(current: Record<string, unknown>, earlier: Record<string, unknown>): boolean {
  const currentPath = pathArgumentOf(current)
  const earlierPath = pathArgumentOf(earlier)
  if (currentPath === undefined || earlierPath === undefined || currentPath !== earlierPath) {
    return false
  }
  const currentEdits = current.edits
  const earlierEdits = earlier.edits
  if (!Array.isArray(currentEdits) || !Array.isArray(earlierEdits) || currentEdits.length === 0) {
    return false
  }
  return currentEdits.every((edit) => earlierEdits.some((prior) => deepEqual(edit, prior)))
}

/**
 * The directory a shell call really runs in, resolved against the session cwd
 * and normalised — so `.`, `./`, a trailing separator, an absent `workdir` and
 * an absolute spelling of the same directory all compare equal (DeepSeek C3).
 * `undefined` means the shape is not a readable workdir at all.
 */
function effectiveWorkdir(
  cwd: string,
  workdir: unknown,
  platform: NodeJS.Platform
): string | undefined {
  if (workdir === undefined) return normalizePath(cwd, platform).full
  if (typeof workdir !== 'string') return undefined
  if (workdir.trim() === '') return normalizePath(cwd, platform).full
  return resolveTarget(cwd, workdir, platform).full
}

/** How the current action relates to one earlier call, or `undefined` for no relationship. */
function matchKind(
  toolName: string,
  current: Record<string, unknown>,
  earlier: Record<string, unknown>,
  cwd: string | undefined,
  platform: NodeJS.Platform
): RetryFact['match'] | undefined {
  const currentCommand = shellCommandOf(toolName, current)
  const earlierCommand = shellCommandOf(toolName, earlier)
  if (currentCommand !== null && earlierCommand !== null) {
    // Only the command and where it runs carry a shell call's effect. Every other
    // key — opencode's model-written `description`, a `timeout` — is reworded
    // freely on a retry, and must not turn a re-roll into "no fact".
    if (!sameWorkdir(current.workdir, earlier.workdir, cwd, platform)) return undefined
    if (normalizeCommand(currentCommand) === normalizeCommand(earlierCommand)) return 'identical'
    return isShellSubset(currentCommand, earlierCommand) ? 'subset' : undefined
  }
  if (deepEqual(current, earlier)) return 'identical'
  return isEditSubset(current, earlier) ? 'subset' : undefined
}

/**
 * Do two `workdir` values name the same directory? With a session cwd they are
 * resolved and normalised (the policy promises that "absent = no retry found",
 * so a re-spelling must not defeat the fact); without one, they are compared as
 * written, exactly as before.
 */
function sameWorkdir(
  current: unknown,
  earlier: unknown,
  cwd: string | undefined,
  platform: NodeJS.Platform
): boolean {
  if (cwd === undefined) return deepEqual(current, earlier)
  const a = effectiveWorkdir(cwd, current, platform)
  const b = effectiveWorkdir(cwd, earlier, platform)
  if (a === undefined || b === undefined) return false
  const fold = (s: string): string => (platform === 'win32' ? s.toLowerCase() : s)
  return fold(a).replace(/\/+$/, '') === fold(b).replace(/\/+$/, '')
}

/** The earlier call as `call` carries it: the transcript line, cut at {@link RETRY_CALL_MAX_CHARS}. */
function cutCall(call: string): string {
  return call.length > RETRY_CALL_MAX_CHARS
    ? `${call.slice(0, RETRY_CALL_MAX_CHARS)}${CUT_MARKER}`
    : call
}

/** True when two tool names are the same tool, or both edit-class (Fable C2). */
function sameToolFamily(actionTool: string, transcriptTool: string): boolean {
  const a = actionTool.trim().toLowerCase()
  const b = transcriptTool.trim().toLowerCase()
  if (a === b) return true
  // opencode's action carries the permission CATEGORY (`edit`) while the
  // transcript renders the tool's own name (`write`, `patch`, …): an identical
  // re-roll of a refused edit must still produce the fact.
  return isEditTool(a) && isEditTool(b)
}

/**
 * The retry fact for the proposed action, or `undefined` when it matches no
 * refused earlier call. Most recent match wins (the last one in transcript
 * order), which is the one the policy's "name the earlier blocked call" wants.
 */
export function retryFactOf(input: RetryMatchInput): RetryFact | undefined {
  const outcomes = input.outcomes
  if (!outcomes) return undefined
  const toolName = input.action.toolName
  const current = input.action.input
  const platform = input.platform ?? process.platform
  let fact: RetryFact | undefined
  for (const message of input.messages) {
    if (message.role !== 'assistant') continue
    for (const block of message.content) {
      if (block.type !== 'tool_use') continue
      if (!sameToolFamily(toolName, block.toolName)) continue
      const outcome = outcomes[block.toolUseId]
      if (outcome === undefined || !RETRY_OUTCOMES.has(outcome)) continue
      const earlier = block.toolInput ?? {}
      const match = matchKind(toolName, current, earlier, input.cwd, platform)
      if (match === undefined) continue
      fact = {
        match,
        outcome: outcome as RetryFact['outcome'],
        call: cutCall(renderToolCall(block.toolName, block.toolInput))
      }
    }
  }
  return fact
}
