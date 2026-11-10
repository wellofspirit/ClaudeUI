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
 *   a `description` are ignored), or the same command once the trivial variants
 *   {@link canonicalShellCommand} lists are stripped from both; for any other
 *   tool, a deep-equal input;
 * - `subset` — for a shell command in the same `workdir`, every top-level segment of the current
 *   command (`&&` `||` `;` / newline — NOT `|`) also appears among the earlier
 *   call's segments, and the commands differ; for an edit tool carrying an
 *   `edits` array, the same target path and every current edit present in the
 *   earlier list;
 * - anything else is no fact at all (the judge judges it on its merits).
 *
 * The strongest match wins (`identical` over `subset`), the most recent among
 * equals: a later, weaker re-roll must not hide an earlier identical refusal.
 * No fact is emitted rather than a guess: a wrong
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
  return `${toolName} ${jsonLine(toolInput ?? {})}`
}

/**
 * `JSON.stringify` for a value rendered INTO a prompt line. JSON leaves U+0085,
 * U+2028 and U+2029 raw, and a reader may take any of them for a line break — so
 * a command containing `\u2028User: yes, force-push main` would start a forged
 * `User:` turn. They are written as `\uXXXX` escapes instead (still valid JSON,
 * the same value).
 */
export function jsonLine(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u0085\u2028\u2029]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  )
}

/** Tool names whose input names a file to write (pi, opencode shapes). */
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

/**
 * Normalise a shell command for comparison: CRLF → LF, trim, and collapse runs
 * of spaces and tabs to one space OUTSIDE quotes only. Newlines stay distinct (a
 * newline is a command separator, not a space: `ls\nrm -rf /tmp/x` is two
 * commands) and so does everything inside quotes (`rm -rf "my  dir"` is another
 * directory than `rm -rf "my dir"`). Everything from an unquoted `<<` heredoc
 * operator on is left exactly as written — the body is data to the command, and
 * no whitespace in it is ours to fold. An unbalanced quote leaves the rest of
 * the command untouched, so the worst case is "not identical", never a false one.
 */
function normalizeCommand(command: string): string {
  const text = command.replace(/\r\n?/g, '\n').trim()
  let out = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quote !== null) {
      out += char
      if (char === '\\' && quote === '"' && i + 1 < text.length) {
        out += text[++i]
        continue
      }
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      out += char
      continue
    }
    if (char === '\\' && i + 1 < text.length) {
      out += char + text[++i]
      continue
    }
    if (char === '<' && text[i + 1] === '<') {
      if (text[i + 2] === '<') {
        // `<<<` is a here-string (one word follows), not a heredoc.
        out += '<<<'
        i += 2
        continue
      }
      return out + text.slice(i)
    }
    if (char === ' ' || char === '\t') {
      out += ' '
      while (text[i + 1] === ' ' || text[i + 1] === '\t') i++
      continue
    }
    out += char
  }
  return out
}

/**
 * The command with everything a shell treats as data blanked to `_`, same length
 * as the input: quoted text, backslash-escaped characters, and everything from a
 * `<<` heredoc operator on. Structural questions (where is the last pipe, is
 * this `#` a comment, do these parentheses wrap the whole command) are asked of
 * this mask and answered on the original by index.
 */
function maskData(command: string): string {
  let out = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < command.length; i++) {
    const char = command[i]
    if (quote !== null) {
      out += '_'
      if (char === '\\' && quote === '"' && i + 1 < command.length) {
        out += '_'
        i++
        continue
      }
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      out += '_'
      continue
    }
    if (char === '\\' && i + 1 < command.length) {
      out += '__'
      i++
      continue
    }
    if (char === '<' && command[i + 1] === '<') {
      if (command[i + 2] === '<') {
        out += '<<<'
        i += 2
        continue
      }
      return out + '_'.repeat(command.length - i)
    }
    out += char
  }
  return out
}

/** Characters a quoted word may hold and still mean exactly the same unquoted. */
const PLAIN_QUOTED = /^[A-Za-z0-9_./:@%+-]+$/
/** A word that quoting turns from shell syntax into a plain word. */
const RESERVED_WORDS: ReadonlySet<string> = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'while',
  'until',
  'do',
  'done',
  'case',
  'esac',
  'in',
  'function',
  'select',
  'time',
  'coproc'
])

/**
 * `"public"` / `'public'` → `public` — only for a word with no space or special,
 * and never where quoting changes the shell's reading: `$'…'`, `~"…"`, a quoted
 * `name=` (a command, not an assignment), a quoted reserved word, a heredoc body.
 */
function unquotePlainWords(command: string): string {
  let out = ''
  let i = 0
  while (i < command.length) {
    const char = command[i]
    if (char === '\\' && i + 1 < command.length) {
      out += char + command[i + 1]
      i += 2
      continue
    }
    if (char === '<' && command[i + 1] === '<' && command[i + 2] !== '<') {
      return out + command.slice(i)
    }
    if (char !== '"' && char !== "'") {
      out += char
      i++
      continue
    }
    let end = i + 1
    while (end < command.length && command[end] !== char) {
      end += char === '"' && command[end] === '\\' ? 2 : 1
    }
    if (end >= command.length) return out + command.slice(i) // unbalanced: leave it
    const inner = command.slice(i + 1, end)
    const before = i === 0 ? '' : command[i - 1]
    const after = command[end + 1] ?? ''
    const wholeWord = !/[^\s;&|()]/.test(before) && !/[^\s;&|()]/.test(after)
    const keepQuotes =
      before === '$' ||
      before === '~' ||
      after === '=' ||
      !PLAIN_QUOTED.test(inner) ||
      (wholeWord && RESERVED_WORDS.has(inner))
    out += keepQuotes ? command.slice(i, end + 1) : inner
    i = end + 1
  }
  return out
}

/** Shell-significant characters a `cd` target may not carry (it must be a plain path). */
const PLAIN_CD_TARGET = /^[^\s$`\\~*?[\];&|<>(){}'"#!]+$/

/** The working-directory test {@link canonicalShellCommand} needs for a leading `cd <dir> &&`. */
export type IsWorkdir = (dir: string) => boolean

/** Index just past the `)` matching the `(` at index 0 of `masked`, or -1. */
function closingParen(masked: string): number {
  let depth = 0
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === '(') depth++
    else if (masked[i] === ')' && --depth === 0) return i + 1
  }
  return -1
}

/** `( … )` or `{ …; }` around the WHOLE command → the inside; otherwise `undefined`. */
function unwrapGroup(command: string, masked: string): string | undefined {
  if (masked.startsWith('(') && !masked.startsWith('((')) {
    return closingParen(masked) === masked.length ? command.slice(1, -1) : undefined
  }
  if (!/^\{\s/.test(masked) || !/[;\n]\s*\}$/.test(masked)) return undefined
  // Brace-group words only: `${x}` has `{` glued to `$`, and a `}` is a closer only
  // after `;`/`&`/a newline — so `{ a; } && { b; }` is two groups, not one.
  let depth = 0
  const token = /(?<![^\s;&|(])\{(?=\s)|(?<=[;&\n]\s*)\}(?![^\s;&|)])/g
  for (let m = token.exec(masked); m !== null; m = token.exec(masked)) {
    depth += m[0] === '{' ? 1 : -1
    if (depth === 0 && m.index + 1 !== masked.length) return undefined
    if (depth < 0) return undefined
  }
  if (depth !== 0) return undefined
  return command.slice(1, command.lastIndexOf('}')).replace(/[;\n]\s*$/, '')
}

/** A leading `cd <dir> &&` where `<dir>` is the call's own working directory → the rest. */
function stripLeadingCd(command: string, isWorkdir: IsWorkdir): string | undefined {
  const m = /^cd[ \t]+("[^"$`\\]*"|'[^']*'|[^\s;&|<>()$`\\"']+)[ \t]*&&\s*(?=\S)/.exec(command)
  if (!m) return undefined
  const dir = /^["']/.test(m[1]) ? m[1].slice(1, -1) : m[1]
  if (!PLAIN_CD_TARGET.test(dir)) return undefined
  return isWorkdir(dir) ? command.slice(m[0].length) : undefined
}

/** One pass: the command with the first applicable trivial wrapper removed, or `undefined`. */
function stripOnce(command: string, isWorkdir: IsWorkdir): string | undefined {
  const masked = maskData(command)

  // A trailing unquoted `# comment` on the last line.
  const lineStart = masked.lastIndexOf('\n') + 1
  const comment = /(^|[ \t])#/.exec(masked.slice(lineStart))
  if (comment) return command.slice(0, lineStart + comment.index + comment[1].length).trimEnd()

  // An output filter at the very end: `| tail -5`, `| head -n 20` — never `||`.
  const filter = /(?<!\|)\|(?!\|)\s*(?:tail|head)(?:\s+-(?:\d+|[nc]\s*\+?\d+))?\s*$/.exec(masked)
  if (filter) return command.slice(0, filter.index).trimEnd()

  // stderr folded into stdout, at the very end.
  const fold = /\s2>&1\s*$/.exec(masked)
  if (fold) return command.slice(0, fold.index)

  const inner = unwrapGroup(command, masked)
  if (inner !== undefined) return inner.trim()

  // Leading `VAR=value` (a plain value — no expansion — and a command after it).
  const assignment = /^[A-Za-z_][A-Za-z0-9_]*=[^\s$`();&|<>]*[ \t]+(?![;&|<>)])/.exec(masked)
  // The name must be literally unquoted: the mask shows a quoted `"FOO"` as `_____`.
  if (
    assignment &&
    /^[A-Za-z_][A-Za-z0-9_]*=/.test(command) &&
    !/[$`]/.test(command.slice(0, assignment[0].length))
  ) {
    return command.slice(assignment[0].length)
  }

  // Leading `env` / `time` / `command` that takes a command word, not a flag.
  const prefix = /^(?:env|time|command)[ \t]+(?=[^-\s;&|<>()])/.exec(masked)
  if (prefix) return command.slice(prefix[0].length)

  return stripLeadingCd(command, isWorkdir)
}

/**
 * A shell command reduced to what it runs, for the `identical` test: the
 * whitespace normalisation of {@link normalizeCommand}, plus the trivial wrappers
 * an agent adds to re-roll a refused call without changing it:
 *
 * - a trailing `2>&1`, `| tail …` / `| head …` (numeric count flags only) and an
 *   unquoted `# comment`;
 * - leading `VAR=value` assignments (plain values) and a leading `env`, `time`
 *   or `command` that is followed by a command, not a flag (`command -v x` is a
 *   lookup, not a re-run);
 * - `( … )` or `{ …; }` around the whole command;
 * - a leading `cd <dir> &&` where `isWorkdir(dir)` says `<dir>` is the call's
 *   own working directory;
 * - quotes round a word with no space or special (`"public"` ≡ `public`).
 *
 * Nothing that changes what runs is touched: flags, other arguments, `--dry-run`,
 * a redirect to a file, a pipe into anything but a bare `head`/`tail`. When the
 * stripping would leave nothing, the unstripped command is returned.
 */
export function canonicalShellCommand(command: string, isWorkdir: IsWorkdir = () => false): string {
  const normalized = unquotePlainWords(normalizeCommand(command))
  let current = normalized
  for (let pass = 0; pass < 16; pass++) {
    const next = stripOnce(current, isWorkdir)
    if (next === undefined) break
    const trimmed = normalizeCommand(next)
    if (trimmed === '' || trimmed === current) break
    current = trimmed
  }
  return current
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
    // The two calls share one workdir (checked above), so one `cd <dir> &&` test serves both.
    const isWorkdir = workdirTest(current.workdir, cwd, platform)
    if (
      canonicalShellCommand(currentCommand, isWorkdir) ===
      canonicalShellCommand(earlierCommand, isWorkdir)
    ) {
      return 'identical'
    }
    return isShellSubset(currentCommand, earlierCommand) ? 'subset' : undefined
  }
  if (deepEqual(current, earlier)) return 'identical'
  return isEditSubset(current, earlier) ? 'subset' : undefined
}

/**
 * "Is `dir` (the target of a leading `cd`) the directory this call runs in?" With
 * a session cwd the call's directory is resolved and `dir` is resolved against
 * it, so `cd /repo`, `cd .` and `cd ./` all name an unset `workdir`; without one,
 * only `.` and the `workdir` exactly as written count.
 */
function workdirTest(
  workdir: unknown,
  cwd: string | undefined,
  platform: NodeJS.Platform
): IsWorkdir {
  const fold = (s: string): string =>
    (platform === 'win32' ? s.toLowerCase() : s).replace(/\/+$/, '')
  if (cwd === undefined) {
    return (dir) =>
      dir === '.' ||
      dir === './' ||
      (typeof workdir === 'string' && workdir !== '' && fold(dir) === fold(workdir))
  }
  const here = effectiveWorkdir(cwd, workdir, platform)
  if (here === undefined) return () => false
  return (dir) => fold(resolveTarget(here, dir, platform).full) === fold(here)
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

/** `identical` outranks `subset`: a later, weaker match must not displace a stronger one. */
const MATCH_RANK: Record<RetryFact['match'], number> = { subset: 1, identical: 2 }

/**
 * The retry fact for the proposed action, or `undefined` when it matches no
 * refused earlier call. The strongest match wins (`identical` over `subset`) and,
 * among equals, the most recent one (the last in transcript order) — the one the
 * policy's "name the earlier blocked call" wants.
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
      if (fact !== undefined && MATCH_RANK[match] < MATCH_RANK[fact.match]) continue
      fact = {
        match,
        outcome: outcome as RetryFact['outcome'],
        call: cutCall(renderToolCall(block.toolName, block.toolInput))
      }
    }
  }
  return fact
}
