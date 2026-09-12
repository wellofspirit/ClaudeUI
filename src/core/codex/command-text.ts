/**
 * Codex never runs a model's command directly: `Shell::derive_exec_args`
 * (codex-rs/core/src/shell.rs) turns the model-supplied script into the argv
 * `[<shell path>, "-lc" | "-c", <script>]` for zsh/bash/sh, and the app server
 * puts `shlex_join(argv)` on the wire as the approval request's `command`
 * (codex-rs/app-server/src/bespoke_event_handling.rs). Gating that string
 * directly means a user's `Bash(rm -rf:*)` deny rule never matches and an
 * always-allow suggestion becomes `Bash(/bin/zsh -lc rm -rf x:*)` — a rule no
 * human would write and that no other engine would ever match.
 */

/** Shell basenames Codex can wrap a command with. */
const SHELLS = new Set(['zsh', 'bash', 'sh'])
/** The only two wrapper flags Codex emits, each as ONE argv element. */
const FLAGS = new Set(['-lc', '-c'])
const WHITESPACE = new Set([' ', '\t', '\n', '\r'])
/** Backslash inside double quotes only escapes these; elsewhere it is literal. */
const DQ_ESCAPABLE = new Set(['$', '`', '"', '\\', '\n'])

/**
 * POSIX-ish word split, the inverse of the `shlex::try_join` that produced the
 * wire string: one level of quoting is removed and adjacent quoted/bare runs
 * concatenate into a single word. Returns `null` for input this cannot be sure
 * of (unterminated quote, trailing lone backslash) — the caller then leaves the
 * command alone rather than guessing.
 */
function shlexSplit(input: string): string[] | null {
  const tokens: string[] = []
  let token = ''
  let started = false
  for (let i = 0; i < input.length; i++) {
    const char = input[i]
    if (WHITESPACE.has(char)) {
      if (started) tokens.push(token)
      token = ''
      started = false
      continue
    }
    started = true
    if (char === "'") {
      const end = input.indexOf("'", i + 1)
      if (end === -1) return null
      token += input.slice(i + 1, end)
      i = end
    } else if (char === '"') {
      i++
      for (;;) {
        if (i >= input.length) return null
        const inner = input[i]
        if (inner === '"') break
        if (inner === '\\' && i + 1 < input.length && DQ_ESCAPABLE.has(input[i + 1])) {
          token += input[i + 1]
          i += 2
          continue
        }
        token += inner
        i++
      }
    } else if (char === '\\') {
      if (i + 1 >= input.length) return null
      token += input[i + 1]
      i++
    } else token += char
  }
  if (started) tokens.push(token)
  return tokens
}

/** `/bin/zsh` -> `zsh`, `C:\Git\bin\bash.exe` -> `bash`; mirrors Rust `file_stem`. */
function shellName(token: string): string {
  const base = token.split(/[/\\]/).pop() ?? token
  return base.toLowerCase().replace(/\.exe$/, '')
}

/**
 * Strip exactly one Codex login-shell wrapper, returning the script the model
 * actually asked to run. Anything that is not the precise wrapper shape — a
 * different shell, a flag Codex does not emit, extra arguments, unbalanced
 * quotes — comes back untouched.
 *
 * The shape accepted here is deliberately the same one Codex's own
 * `extract_bash_command` (codex-rs/shell-command/src/bash.rs) accepts: exactly
 * three argv elements, flag `-lc` or `-c`, shell resolving to zsh/bash/sh.
 * Widening it would unwrap commands Codex never wrapped, which would silently
 * defeat a deny rule aimed at the shell itself (`Bash(sh:*)`).
 *
 * Unwrapping is applied ONCE. A script that is itself `bash -c '...'` is the
 * model's own nesting and stays visible to the rules as written.
 */
export function unwrapShellCommand(command: string): string {
  const tokens = shlexSplit(command)
  if (!tokens || tokens.length !== 3) return command
  const [shell, flag, script] = tokens
  if (!FLAGS.has(flag) || !SHELLS.has(shellName(shell))) return command
  return script
}
