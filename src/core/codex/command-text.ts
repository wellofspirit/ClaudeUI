/**
 * Codex never runs a model's command directly: `Shell::derive_exec_args`
 * (codex-rs/core/src/shell.rs) turns the model-supplied script into an argv
 * built around the user's shell — `[<shell path>, "-lc" | "-c", <script>]` for
 * zsh/bash/sh, `[<pwsh path>, "-NoProfile"?, "-Command", <script>]` for
 * PowerShell, `[<cmd path>, "/c", <script>]` for cmd — and the app server puts
 * `shlex_join(argv)` on the wire as the approval request's `command`
 * (codex-rs/app-server/src/bespoke_event_handling.rs). Gating that string
 * directly means a user's `Bash(rm -rf:*)` deny rule never matches and an
 * always-allow suggestion becomes `Bash(/bin/zsh -lc rm -rf x:*)` — a rule no
 * human would write and that no other engine would ever match.
 */

const WHITESPACE = new Set([' ', '\t', '\n', '\r'])
/** Backslash inside double quotes only escapes these; elsewhere it is literal. */
const DQ_ESCAPABLE = new Set(['$', '`', '"', '\\', '\n'])

/**
 * POSIX-ish word split, the inverse of the `shlex::try_join` that produced the
 * wire string: one level of quoting is removed and adjacent quoted/bare runs
 * concatenate into a single word. Returns `null` for input this cannot be sure
 * of (unterminated quote, trailing lone backslash) — the caller then leaves the
 * command alone rather than guessing.
 *
 * Exported because `rules-sync.ts` needs the SAME splitter to turn a Claude
 * `Bash(<prefix>:*)` rule into the argv prefix an execpolicy `prefix_rule`
 * matches. A second splitter there would be a second set of quoting bugs.
 */
export function splitShellWords(input: string): string[] | null {
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

/** Shell basenames, by family, that Codex can wrap a command with. */
const POSIX_SHELLS = new Set(['zsh', 'bash', 'sh'])
/** `detect_shell_type` resolves both executables to `ShellType::PowerShell`. */
const POWERSHELLS = new Set(['pwsh', 'powershell'])
const CMD_SHELLS = new Set(['cmd'])

/**
 * Every wrapper shape `Shell::derive_exec_args` can emit, as the exact argv
 * elements it puts between the shell path and the single script argument. The
 * `match` there is over the whole `ShellType` enum with no wildcard arm, so
 * these five rows are the complete set: `Zsh | Bash | Sh` (`-lc` when
 * `use_login_shell`, else `-c`), `PowerShell` (`-Command`, prefixed with
 * `-NoProfile` when NOT a login shell — the flag is added on the `!` branch)
 * and `Cmd` (`/c`). Pinned upstream by `core/src/shell_tests.rs`
 * `derive_exec_args` and `app-server/tests/suite/v2/selected_environment.rs`.
 */
const WRAPPERS: ReadonlyArray<{ shells: ReadonlySet<string>; flags: readonly string[] }> = [
  { shells: POSIX_SHELLS, flags: ['-lc'] },
  { shells: POSIX_SHELLS, flags: ['-c'] },
  { shells: POWERSHELLS, flags: ['-Command'] },
  { shells: POWERSHELLS, flags: ['-NoProfile', '-Command'] },
  { shells: CMD_SHELLS, flags: ['/c'] }
]

/**
 * Strip exactly one Codex shell wrapper, returning the script the model
 * actually asked to run. Anything that is not one of the precise wrapper shapes
 * — a different shell, a flag Codex does not emit, extra arguments, unbalanced
 * quotes — comes back untouched.
 *
 * The rule is **mirror the generator**, not "only POSIX shells": the accepted
 * set is exactly the argv `Shell::derive_exec_args` can produce, shape for
 * shape (see `WRAPPERS`), and nothing else. Accepting only the POSIX shapes was
 * a security defect, not a gap: Codex on Windows wraps with PowerShell or cmd,
 * so every Windows command was gated as the whole wrapper string — a
 * `Bash(rm -rf:*)` deny never bound, and the suggested rule carried the
 * machine's absolute `pwsh.exe` path.
 *
 * Widening BEYOND the generator is what stays forbidden. Accepting a shell
 * Codex cannot wrap with, or a flag it does not emit (`-EncodedCommand`,
 * `-File`, `cmd /k`), would unwrap a command Codex never wrapped: the inner
 * payload would reach gating in place of the argv the model wrote, silently
 * defeating a deny rule aimed at the shell itself (`Bash(sh:*)`,
 * `Bash(pwsh:*)`). Flag spellings match case-sensitively for that same reason —
 * PowerShell and cmd would themselves accept `-command` and `/C`, but the
 * generator emits neither, so an argv carrying one did not come from it.
 *
 * Unwrapping is applied ONCE. A script that is itself `bash -c '...'` or
 * `pwsh -Command '...'` is the model's own nesting and stays visible to the
 * rules as written.
 */
export function unwrapShellCommand(command: string): string {
  const tokens = splitShellWords(command)
  // Every wrapper is shell + at least one flag + exactly one script argument,
  // so fewer than three elements cannot be one. Longer argvs are rejected by
  // the flag-sequence comparison below rather than by a second length cap.
  if (!tokens || tokens.length < 3) return command
  const shell = shellName(tokens[0])
  const flags = tokens.slice(1, -1)
  const script = tokens[tokens.length - 1]
  const matched = WRAPPERS.some(
    (wrapper) =>
      wrapper.shells.has(shell) &&
      wrapper.flags.length === flags.length &&
      wrapper.flags.every((flag, index) => flag === flags[index])
  )
  return matched ? script : command
}
