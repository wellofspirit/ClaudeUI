/**
 * presentShellCommand — a shell-quoted argv join, rendered as a human would type it.
 *
 * Codex's `commandExecution` item carries `command: string` only: no structured
 * argv reaches the renderer (`core/codex/protocol/v2/ThreadItem.ts`). The app
 * server puts a shell-quoted JOIN of the argv it is about to exec on the wire,
 * so on Windows every `\` in a program path arrives DOUBLED:
 *
 *   "C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command ls
 *
 * No shell would print that and no human typed it. This helper undoes that one
 * level of quoting (`splitShellWords`, the same splitter the gating path uses to
 * invert the join) and re-joins the argv with the minimum quoting a person would
 * actually type.
 *
 * ## Presentation only
 *
 * The string this returns must never reach permission gating or a suggested
 * rule. Codex's gated command is built in `CodexSession`
 * (`unwrapShellCommand(params.command)`) and lives on `PendingApproval.input
 * .command`; that value and this one are computed from different inputs on
 * different sides of the IPC boundary, and they must stay that way. A display
 * transform that leaked into gating would re-quote the text a `Bash(...)` rule
 * matches against, which widens or narrows the rule — a security defect, not a
 * cosmetic one.
 *
 * ## Why this is not safe on every engine's command
 *
 * `splitShellWords` REMOVES one level of escaping. Applied to a string that was
 * never escaped it destroys information: a Claude or opencode `Bash` command is
 * the literal script the model wrote, so `dir C:\new` would come back as
 * `dir C:new` — the `\` consumed as an escape that was never there. No
 * round-trip check can catch that, because the loss happens in the FIRST split
 * and the re-join is then faithful to the wrong tokens. Soundness comes only
 * from the producer's contract ("this string is a quoted join"), which only
 * Codex's `commandExecution` has. Hence the single call site in
 * `CodexEngineToolMap`, and none in the shared card components.
 */

import { splitShellWords } from '../../../core/codex/command-text'

/**
 * Characters a token may contain and still be written bare. Deliberately the
 * conservative shlex allowlist, and deliberately WITHOUT `\` — a bare backslash
 * would be read back as an escape.
 */
const BARE_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/

/** Inside double quotes a backslash escapes only these (and a newline). */
const DQ_ESCAPABLE = /[$`"\\\n]/

/**
 * Double quotes are the form a Windows path wants — inside them a `\` in front
 * of an ordinary character stays literal, which is the whole point here. They
 * are unsafe when the token holds a character the shell would still interpret
 * (`$`, a backtick, a quote), when a `\` sits in front of one of those, or when
 * a `\` ends the token (it would escape the closing quote). A multi-line token
 * is a shell SCRIPT — Codex's wrapped `-lc` payload — and single quotes are the
 * form that reads as one.
 */
function canDoubleQuote(token: string): boolean {
  if (/["$`\n]/.test(token)) return false
  for (let i = 0; i < token.length; i++) {
    if (token[i] !== '\\') continue
    const next = token[i + 1]
    if (next === undefined || DQ_ESCAPABLE.test(next)) return false
    i++
  }
  return true
}

/** One argv element, written the shortest way that reads back as itself. */
function quoteToken(token: string): string {
  if (BARE_SAFE.test(token)) return token
  if (canDoubleQuote(token)) return `"${token}"`
  // Single quotes are literal end to end, so only a `'` needs the shlex splice.
  if (!token.includes("'")) return `'${token}'`
  return `'${token.split("'").join(`'\\''`)}'`
}

/**
 * The quoted join, re-rendered with minimal quoting. Returns the input
 * UNCHANGED whenever that cannot be done truthfully:
 *
 *  - `splitShellWords` gives `null` (unbalanced quote, trailing lone backslash);
 *  - there are no words at all (an empty or whitespace-only command);
 *  - the re-join does not split back into the very same tokens.
 *
 * The last is a self-check, not decoration: it makes a quoting bug in
 * `quoteToken` fail closed, showing the ugly truthful string instead of a
 * prettier wrong one.
 */
export function presentShellCommand(command: string): string {
  const tokens = splitShellWords(command)
  if (!tokens || tokens.length === 0) return command
  const joined = tokens.map(quoteToken).join(' ')
  const reread = splitShellWords(joined)
  if (!reread || reread.length !== tokens.length) return command
  if (reread.some((token, i) => token !== tokens[i])) return command
  return joined
}
