import { describe, expect, it } from 'vitest'
import { unwrapShellCommand } from '../command-text'

/**
 * The wire string is `shlex_join(argv)` of the argv Codex built in
 * `Shell::derive_exec_args` (codex-rs/core/src/shell.rs), so every case below
 * is written the way `shlex::try_join` would have emitted it.
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
    ['non-wrapper command unchanged', 'ls -la', 'ls -la'],
    ['bare command unchanged', 'ls', 'ls'],
    ['extra args after the script unchanged', '/bin/zsh -lc ls extra', '/bin/zsh -lc ls extra'],
    ['missing script unchanged', '/bin/zsh -lc', '/bin/zsh -lc'],
    // Codex only ever emits `-lc`/`-c` as a single argv element
    // (codex-rs/shell-command/src/bash.rs `extract_bash_command`).
    ['split -l -c unchanged', '/bin/zsh -l -c ls', '/bin/zsh -l -c ls'],
    ['reordered -cl unchanged', '/bin/zsh -cl ls', '/bin/zsh -cl ls'],
    ['unknown flag unchanged', '/bin/zsh -x ls', '/bin/zsh -x ls'],
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
