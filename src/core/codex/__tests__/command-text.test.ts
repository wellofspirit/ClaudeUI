import { describe, expect, it } from 'vitest'
import { unwrapShellCommand } from '../command-text'

/**
 * The wire string is `shlex_join(argv)` of the argv Codex built in
 * `Shell::derive_exec_args` (codex-rs/core/src/shell.rs), so the cases below are
 * written the way that join emits them — single-quoted where `shlex::try_quote`
 * would quote, plus the doubled-backslash double-quoted form the app server has
 * been observed to produce for a Windows program path.
 *
 * What may be unwrapped is exactly what that generator can emit, shape for
 * shape; the `unchanged` cases are the near-misses that must stay whole.
 */
describe('unwrapShellCommand', () => {
  const cases: [name: string, input: string, expected: string][] = [
    ['zsh -lc, bare script', '/bin/zsh -lc ls', 'ls'],
    ['zsh -lc, single-quoted script', "/bin/zsh -lc 'rm -rf x'", 'rm -rf x'],
    ['bash -c, double-quoted script', '/bin/bash -c "echo hi"', 'echo hi'],
    ['sh -lc', '/bin/sh -lc "git status"', 'git status'],
    ['bare shell name, no path', 'zsh -lc ls', 'ls'],
    // shlex single-quotes anything outside its allowlist, so a Windows shell
    // path arrives quoted rather than backslash-mangled.
    ['windows shell path', "'C:\\Program Files\\Git\\bin\\bash.exe' -lc ls", 'ls'],
    ['nested double quotes survive', '/bin/zsh -lc \'echo "a b"\'', 'echo "a b"'],
    ['nested single quotes survive', '/bin/zsh -lc "echo \'a b\'"', "echo 'a b'"],
    // `shlex::try_quote` escapes an embedded `'` as `'\''`.
    [
      'shlex-escaped inner quote',
      "/bin/zsh -lc 'git commit -m '\\''wip'\\'''",
      "git commit -m 'wip'"
    ],
    ['inner whitespace is preserved verbatim', "/bin/zsh -lc 'ls   -la'", 'ls   -la'],
    ['unwraps exactly once', "/bin/zsh -lc '/bin/zsh -lc ls'", '/bin/zsh -lc ls'],

    // --- Windows. `derive_exec_args` wraps with PowerShell or cmd there, and
    // these shapes are pinned upstream by `core/src/shell_tests.rs`
    // (`derive_exec_args`, which asserts BOTH PowerShell forms) and
    // `app-server/tests/suite/v2/selected_environment.rs` (the `-Command` and
    // `/c` joins). `-NoProfile` is present exactly when the shell is NOT a
    // login shell, so both PowerShell forms occur in the field.
    [
      'pwsh -Command (login shell), shlex-quoted path',
      "'C:\\Program Files\\PowerShell\\7\\pwsh.exe' -Command ls",
      'ls'
    ],
    // The form the app server has been observed to put on the wire: the path
    // double-quoted with its separators DOUBLED. One level of quoting comes off
    // either way, so the shell basename still resolves.
    [
      'pwsh -Command, doubled-backslash double-quoted path',
      '"C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe" -Command ls',
      'ls'
    ],
    ['pwsh -NoProfile -Command (not a login shell)', 'pwsh.exe -NoProfile -Command ls', 'ls'],
    [
      'pwsh -NoProfile -Command, quoted script',
      "'C:\\Program Files\\PowerShell\\7\\pwsh.exe' -NoProfile -Command 'rm -rf x'",
      'rm -rf x'
    ],
    // `detect_shell_type` resolves powershell.exe to the same `ShellType`.
    [
      'powershell.exe -Command',
      "'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' -Command 'git status'",
      'git status'
    ],
    ['powershell -NoProfile -Command', 'powershell -NoProfile -Command ls', 'ls'],
    ['cmd /c', "'C:\\Windows\\System32\\cmd.exe' /c dir", 'dir'],
    ['cmd /c, quoted script', 'cmd.exe /c "dir /b"', 'dir /b'],
    // Same one-level rule as the POSIX case, and load-bearing: a model that
    // itself asks to run `pwsh -Command evil` inside the wrapper must keep that
    // nesting visible, so a `Bash(pwsh:*)` deny still bites it.
    [
      'unwraps a Windows wrapper exactly once',
      "pwsh.exe -NoProfile -Command 'pwsh -Command evil'",
      'pwsh -Command evil'
    ],

    ['non-wrapper command unchanged', 'ls -la', 'ls -la'],
    ['bare command unchanged', 'ls', 'ls'],
    ['extra args after the script unchanged', '/bin/zsh -lc ls extra', '/bin/zsh -lc ls extra'],
    ['missing script unchanged', '/bin/zsh -lc', '/bin/zsh -lc'],
    // Codex only ever emits `-lc`/`-c` as a single argv element
    // (codex-rs/shell-command/src/bash.rs `extract_bash_command`).
    ['split -l -c unchanged', '/bin/zsh -l -c ls', '/bin/zsh -l -c ls'],
    ['reordered -cl unchanged', '/bin/zsh -cl ls', '/bin/zsh -cl ls'],
    ['unknown flag unchanged', '/bin/zsh -x ls', '/bin/zsh -x ls'],

    // --- Windows near-misses. `derive_exec_args` cannot emit any of these, so
    // unwrapping them would hand gating an inner payload in place of the argv
    // the model actually wrote — defeating a deny aimed at the shell itself.
    ['pwsh -File unchanged', 'pwsh -File script.ps1', 'pwsh -File script.ps1'],
    // `-EncodedCommand` deliberately does NOT unwrap. `exec_policy.rs` lists it
    // beside `-Command` only as an argv prefix the POLICY can talk about, not as
    // something the generator emits; the payload is base64 UTF-16LE, so
    // "unwrapping" it would mean decoding, handing the rules an opaque blob and
    // erasing the one signal a user might want to deny outright.
    ['pwsh -EncodedCommand unchanged', 'pwsh -EncodedCommand bHMA', 'pwsh -EncodedCommand bHMA'],
    [
      'pwsh -NoProfile -EncodedCommand unchanged',
      'pwsh -NoProfile -EncodedCommand bHMA',
      'pwsh -NoProfile -EncodedCommand bHMA'
    ],
    ['cmd /k unchanged', 'cmd /k dir', 'cmd /k dir'],
    // PowerShell and cmd accept these spellings themselves, but the generator
    // emits `-Command` and `/c` verbatim, so an argv carrying one did not come
    // from it. Mirroring the generator means matching its exact bytes.
    ['pwsh -command lowercase unchanged', 'pwsh -command ls', 'pwsh -command ls'],
    ['cmd /C uppercase unchanged', 'cmd /C dir', 'cmd /C dir'],
    // Five elements: one flag too many for any shape.
    [
      'five-element pwsh command unchanged',
      'pwsh -NoProfile -Command ls extra',
      'pwsh -NoProfile -Command ls extra'
    ],
    ['pwsh -NoProfile without -Command unchanged', 'pwsh -NoProfile ls', 'pwsh -NoProfile ls'],
    // The generator appends `-NoProfile` BEFORE `-Command`; the flags are matched
    // as an ordered sequence, not as a set, so the reverse is not its output.
    [
      'pwsh -Command -NoProfile reversed unchanged',
      'pwsh -Command -NoProfile ls',
      'pwsh -Command -NoProfile ls'
    ],
    ['pwsh -Command with extra arg unchanged', 'pwsh -Command ls extra', 'pwsh -Command ls extra'],
    // Flags never cross shell families: `-NoProfile` is checked in sequence and
    // `/c` belongs to cmd alone.
    ['pwsh /c unchanged', 'pwsh /c ls', 'pwsh /c ls'],
    ['cmd -Command unchanged', 'cmd -Command dir', 'cmd -Command dir'],
    ['zsh -Command unchanged', '/bin/zsh -Command ls', '/bin/zsh -Command ls'],
    ['pwsh -lc unchanged', 'pwsh -lc ls', 'pwsh -lc ls'],

    // `detect_shell_type` recognizes only zsh/bash/sh/pwsh/cmd; fish is not a
    // shell Codex can wrap with.
    ['non-codex shell unchanged', '/usr/bin/fish -lc ls', '/usr/bin/fish -lc ls'],
    ['suffix-only shell name unchanged', '/usr/bin/ksh -lc ls', '/usr/bin/ksh -lc ls'],
    ['unterminated quote unchanged', "/bin/zsh -lc 'oops", "/bin/zsh -lc 'oops"],
    ['empty string unchanged', '', ''],
    ['writeStdin argv unchanged', 'write_stdin --session-id 7 hi', 'write_stdin --session-id 7 hi']
  ]
  it.each(cases)('%s', (_name, input, expected) => {
    expect(unwrapShellCommand(input)).toBe(expected)
  })
})
