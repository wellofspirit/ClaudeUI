/**
 * The command a Codex card shows is a shell-quoted JOIN of argv, so the cases
 * below are written the way a joiner emits them — Windows double quotes with
 * doubled separators, POSIX single quotes with the `'\''` splice.
 *
 * Two of these tests are the reason the transform is scoped to Codex rather than
 * shared by every engine's command card:
 *
 *  - `leaves a lone backslash consumed once it has been split` documents that a
 *    string which was never escaped LOSES its backslash, so this helper may only
 *    ever see a producer that escapes;
 *  - `refuses to guess` documents the fail-safe: unbalanced quoting renders the
 *    original.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { presentShellCommand } from '../present-shell-command'

describe('presentShellCommand', () => {
  const cases: [name: string, input: string, expected: string][] = [
    // The live Windows bug (screenshot, 2026-09-19): a pwsh wrapper whose path
    // separators arrived doubled, in both the card header and the `$` line.
    [
      'windows pwsh wrapper loses its doubled separators',
      '"C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe" -Command ls',
      '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command ls'
    ],
    ['a bare command is left bare', 'ls', 'ls'],
    [
      'flags and paths stay unquoted',
      'git log --oneline -n 5 src/core',
      'git log --oneline -n 5 src/core'
    ],
    // A shlex-joined POSIX wrapper. The script is one argv element and still
    // reads as one; only the quote character changes, and it changes to the one
    // a person types around a path (see the windows case above). Both forms
    // split back to the identical argv, which the round-trip check enforces.
    ['a single-quoted script stays one word', "/bin/zsh -lc 'rm -rf x'", '/bin/zsh -lc "rm -rf x"'],
    // `'\''` is the only way a single-quoted token can carry a `'`. Unwound, the
    // token is plain text a human would simply double-quote.
    [
      'an escaped inner quote becomes the form a human types',
      "/bin/zsh -lc 'git commit -m '\\''wip'\\'''",
      '/bin/zsh -lc "git commit -m \'wip\'"'
    ],
    // Double quotes are unavailable when the token carries a `"` or a `$` (one
    // would close the quote, the other would expand), so single quotes — literal
    // end to end — are the honest form.
    [
      'a token holding a double quote takes single quotes',
      '/bin/sh -c "echo \\"a b\\""',
      '/bin/sh -c \'echo "a b"\''
    ],
    [
      'a token holding a dollar takes single quotes',
      "/bin/sh -c 'echo $HOME'",
      "/bin/sh -c 'echo $HOME'"
    ],
    // A multi-line token is a shell SCRIPT; single quotes are the form that
    // reads as one, and a newline inside double quotes is not a shape anyone
    // types.
    [
      'a multi-line script keeps single quotes',
      "/bin/zsh -lc 'set -e\necho hi'",
      "/bin/zsh -lc 'set -e\necho hi'"
    ],
    ['an empty argv element stays visible', '"" ls', '"" ls'],
    ['an empty command is unchanged', '', ''],
    ['a whitespace-only command is unchanged', '   ', '   ']
  ]
  it.each(cases)('%s', (_name, input, expected) => {
    expect(presentShellCommand(input)).toBe(expected)
  })

  it('refuses to guess when the quoting is unbalanced', () => {
    // `splitShellWords` returns null here; a truthful ugly string beats a pretty
    // wrong one, so the wire string renders exactly as it arrived.
    expect(presentShellCommand('"C:\\\\Program Files\\\\pwsh.exe -Command ls')).toBe(
      '"C:\\\\Program Files\\\\pwsh.exe -Command ls'
    )
    expect(presentShellCommand("echo 'oops")).toBe("echo 'oops")
    expect(presentShellCommand('echo trailing\\')).toBe('echo trailing\\')
  })

  it('leaves a lone backslash consumed once it has been split', () => {
    // THE scoping test. `C:\new` was never escaped, so splitting it consumes the
    // `\` as an escape for `n`: the token is already `C:new` and no re-join can
    // recover the original. That irreversible loss is why this helper is applied
    // only to Codex's shell-quoted join and never to a Claude/opencode/pi
    // command, which is the literal script the model wrote.
    expect(presentShellCommand('dir C:\\new')).toBe('dir C:new')
    // The corollary: a producer that DOES escape never hands us that shape — the
    // token arrives quoted, and then the backslash survives intact.
    expect(presentShellCommand('dir "C:\\\\new"')).toBe('dir "C:\\new"')
    expect(presentShellCommand("dir 'C:\\new'")).toBe('dir "C:\\new"')
  })

  it('is never reachable from the gating side of the app', () => {
    // Permission decisions and suggested rules are built in src/core. If this
    // presentation helper ever appears there, a display transform has been
    // routed into gating, which can widen or narrow a `Bash(...)` rule.
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          // Core's own tests NAME this helper — the approval-path pin in
          // `codex/__tests__/codex-session.test.ts` cites it by path to say what
          // must never reach the gated string. Only shipping code is gating.
          if (entry.name !== '__tests__') walk(path)
          continue
        }
        if (!entry.name.endsWith('.ts')) continue
        const text = readFileSync(path, 'utf8')
        if (text.includes('presentShellCommand') || text.includes('present-shell-command'))
          offenders.push(path)
      }
    }
    walk(join(process.cwd(), 'src', 'core'))
    expect(offenders).toEqual([])
  })
})
