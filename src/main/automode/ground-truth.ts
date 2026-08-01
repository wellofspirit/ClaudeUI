/**
 * Harness ground truth for the auto-mode classifier — phase 3 of
 * `docs/automode-rework-plan.md` §5, behavioural reference
 * `docs/protocol/14-auto-mode-classifier.md` §5.
 *
 * Four kinds of fact the judge cannot get from the transcript. The first three
 * are missing because the slimmer deliberately drops tool RESULTS; the fourth
 * is missing because it is not in the transcript at all — it is a property of
 * the HOST (where a path resolves to), not of the conversation:
 *
 * 1. **`{"outcome":…}` annotations** — how a prior tool call ended. Without
 *    them post-block consent inheritance is unreachable (a denial is a tool
 *    result) and the mandatory Transient Retry exception is a permissiveness
 *    hole (nothing marks a prior attempt as refused).
 * 2. **`{"meta":{"gitStatus":…}}`** — measured, not inferred, working-tree
 *    state before commands that can destroy uncommitted work or ship it.
 * 3. **`{"meta":{"repoVisibility":…}}` / `EnvironmentInfo.remotes`** — the
 *    trust anchors for the exfiltration rules.
 * 4. **`{"meta":{"redirects":…}}`** — where a shell redirect would actually
 *    write. `cmd > build.log 2>&1` is an unanalysable file overwrite from the
 *    string alone, so it escalates every time; resolving the target against the
 *    session's own scope makes the safe case decidable in stage 1.
 *
 * This module is engine-neutral and dependency-injected: every capture takes an
 * optional {@link CaptureExec}, so the detection tables and the parsers are unit
 * testable without touching a real repository. Captures NEVER throw and NEVER
 * use a shell — `spawn(cmd, args, { shell: false })` only, since the argument
 * they carry (a cwd) is host-owned but the surrounding session is not.
 *
 * The cardinal rule of this file: **a failed capture emits nothing**. A fake
 * `{"clean":true}` would clear the policy's "presume dirty" default on no
 * evidence, which is strictly worse than the noisy status quo.
 */

import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'

// ── Outcome annotations ───────────────────────────────────────────────────────

/**
 * How a completed tool call ended, with cli.js's prescribed meanings (ref §5).
 *
 * This is deliberately a SUBSET of cli.js's eight values: these four are the
 * ones our harness can actually observe today. The others (`interrupted`,
 * `blocked-by-permissions`, `automode-unavailable`, `automode-parsing-error`)
 * are not invented here — an outcome we cannot measure would be a lie to the
 * judge, and per ref §5 the absence of an outcome is explicitly *not* success,
 * so omitting is always the safe fallback.
 *
 * | Value | Meaning to the classifier |
 * |---|---|
 * | `ok` | ran without harness error — **not** a safety verdict, not precedent |
 * | `error` | harness/tool error; may not have executed |
 * | `rejected-by-user` | the human declined **this** call; a retry without new authorization should be blocked |
 * | `automode-blocked` | this classifier denied it |
 */
export type ToolOutcome = 'ok' | 'error' | 'rejected-by-user' | 'automode-blocked'

/**
 * Outcomes that record a permission DECISION rather than an execution result.
 * They are sticky: once a call was refused, the engine may still report the
 * tool part as `error` moments later (opencode surfaces a rejected permission
 * as a failed tool), and letting that overwrite `rejected-by-user` would erase
 * exactly the annotation Transient Retry depends on.
 */
const DECISION_OUTCOMES: ReadonlySet<ToolOutcome> = new Set<ToolOutcome>([
  'rejected-by-user',
  'automode-blocked'
])

/** Bound on a session's outcome map — a long session must not grow it forever. */
export const MAX_TOOL_OUTCOMES = 500

/**
 * Record an outcome into a session-scoped map, oldest-first bounded at `max`.
 *
 * Two behaviours worth knowing:
 * - a DECISION outcome ({@link DECISION_OUTCOMES}) is never overwritten by an
 *   execution outcome (`ok`/`error`) — see the constant's doc;
 * - insertion order is refreshed on every accepted write, so eviction drops the
 *   least recently *updated* call, and the transcript's oldest entries (whose
 *   tool calls the slimmer may still be rendering) go first.
 */
export function recordToolOutcome(
  map: Map<string, ToolOutcome>,
  toolUseId: string,
  outcome: ToolOutcome,
  max = MAX_TOOL_OUTCOMES
): void {
  if (!toolUseId) return
  const existing = map.get(toolUseId)
  if (existing && DECISION_OUTCOMES.has(existing) && !DECISION_OUTCOMES.has(outcome)) return
  map.delete(toolUseId)
  map.set(toolUseId, outcome)
  while (map.size > max) {
    const oldest = map.keys().next()
    if (oldest.done) break
    map.delete(oldest.value)
  }
}

// ── Command-shape detection (pure) ────────────────────────────────────────────

/**
 * Split a shell command into the segments an evaluator must judge separately.
 * Chained commands are the obvious evasion (`ls && rm -rf /x`), so every
 * detector below runs per segment — matching the policy's COMPOSITE ACTIONS
 * evaluation rule.
 *
 * `&&` and `||` are matched before the single-character forms so they are not
 * split into two empty segments.
 */
export function splitCommandSegments(command: string): string[] {
  return command
    .split(/&&|\|\||[;|&\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

interface Segment {
  /** Lowercased basename of the executable, `.exe` stripped. */
  cmd: string
  args: string[]
}

/** `C:\Program Files\Git\bin\git.exe` / `/usr/bin/git` → `git`. */
function executableName(token: string): string {
  const base = token.replace(/\\/g, '/').split('/').pop() ?? token
  return base.toLowerCase().replace(/\.exe$/, '')
}

/**
 * Tokenize one segment into `{cmd, args}`, skipping leading environment
 * assignments and `sudo`/`env` wrappers so `FOO=1 sudo rm -rf x` still reads as
 * an `rm`. Deliberately naive about quoting: the detectors only ever compare
 * whole tokens against fixed words and flag letters, where a stray quote can
 * cost a meta line but can never invent one.
 */
function parseSegment(segment: string): Segment | null {
  const tokens = segment.trim().split(/\s+/).filter(Boolean)
  let i = 0
  while (
    i < tokens.length &&
    (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]) || tokens[i] === 'sudo' || tokens[i] === 'env')
  ) {
    i++
  }
  if (i >= tokens.length) return null
  return { cmd: executableName(tokens[i]), args: tokens.slice(i + 1) }
}

/** True when `args` carries BOTH the recursive and force flags, in any spelling. */
function hasRecursiveAndForce(args: string[]): boolean {
  let recursive = false
  let force = false
  for (const a of args) {
    if (a === '--recursive') recursive = true
    else if (a === '--force') force = true
    else if (/^-[A-Za-z]+$/.test(a)) {
      if (a.includes('r') || a.includes('R')) recursive = true
      if (a.includes('f')) force = true
    }
  }
  return recursive && force
}

/** Global flags that consume the NEXT token, so its value is never mistaken
 *  for the subcommand (`git -C dir push`, `gh --repo x pr create`). */
const VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--repo', '-R', '--exec-path'])

/**
 * The subcommand of a `git`/`gh` invocation plus everything after it, skipping
 * global flags.
 */
function subcommandOf(args: string[]): { sub: string; rest: string[] } | null {
  let i = 0
  while (i < args.length) {
    const a = args[i]
    if (VALUE_FLAGS.has(a)) {
      i += 2
      continue
    }
    if (a.startsWith('-')) {
      i++
      continue
    }
    return { sub: a.toLowerCase(), rest: args.slice(i + 1) }
  }
  return null
}

/** First non-flag token — the second-level subcommand (`gh pr create`). */
function firstWord(args: string[]): string | undefined {
  return args.find((a) => !a.startsWith('-'))?.toLowerCase()
}

function segmentNeedsGitStatus(seg: Segment): boolean {
  // `rm -rf` — the only non-git vehicle in ref §5's list. Both flags are
  // required, so `rm -r dist` (a routine clean build) stays quiet, and the
  // command name is matched exactly so `grep -rf pattern .` never matches.
  if (seg.cmd === 'rm') return hasRecursiveAndForce(seg.args)
  if (seg.cmd !== 'git') return false
  const g = subcommandOf(seg.args)
  if (!g) return false
  switch (g.sub) {
    // Commands that can destroy uncommitted work.
    case 'reset':
      return g.rest.includes('--hard')
    case 'checkout':
    case 'restore':
      return g.rest.includes('.') || g.rest.includes('./')
    case 'clean':
      return g.rest.some((a) => a === '--force' || (/^-[A-Za-z]+$/.test(a) && a.includes('f')))
    // Commands that stage/ship whatever the tree currently holds — the judge
    // needs to know WHAT is about to be swept up (ref §5).
    case 'add':
    case 'commit':
    case 'push':
    case 'stash':
      return true
    default:
      return false
  }
}

function segmentNeedsRepoVisibility(seg: Segment): boolean {
  if (seg.cmd !== 'git' && seg.cmd !== 'gh') return false
  const g = subcommandOf(seg.args)
  if (!g) return false
  if (seg.cmd === 'git') {
    if (g.sub === 'push') return true
    if (g.sub === 'remote') {
      const s = firstWord(g.rest)
      return s === 'add' || s === 'set-url'
    }
    return false
  }
  if (seg.cmd === 'gh') {
    if (g.sub === 'repo' || g.sub === 'release') return true
    if (g.sub === 'pr') {
      const s = firstWord(g.rest)
      return s === 'create' || s === 'merge'
    }
  }
  return false
}

/**
 * Does this command warrant a measured `gitStatus` meta line? (ref §5: before
 * commands that can destroy uncommitted work, and before add/stage/commit/push.)
 */
export function needsGitStatus(command: string): boolean {
  return splitCommandSegments(command).some((s) => {
    const seg = parseSegment(s)
    return seg ? segmentNeedsGitStatus(seg) : false
  })
}

/**
 * Does this command warrant a resolved `repoVisibility`? (ref §5: the
 * exfil-capable git/gh surface — push, remote add/set-url, pr create/merge,
 * release, repo.) `git commit` deliberately does NOT match: nothing leaves the
 * machine, so paying for a `gh` round trip would be noise.
 */
export function needsRepoVisibility(command: string): boolean {
  return splitCommandSegments(command).some((s) => {
    const seg = parseSegment(s)
    return seg ? segmentNeedsRepoVisibility(seg) : false
  })
}

/**
 * Permission categories whose input carries a raw shell command string. Kept
 * here rather than in the engine wiring so pi (phase 4) inherits it.
 */
const SHELL_CATEGORIES = new Set(['bash', 'shell'])

/** The shell command a proposed action would run, or `null` if it is not one. */
export function shellCommandOf(
  toolName: string,
  input: Record<string, unknown> | undefined
): string | null {
  if (!SHELL_CATEGORIES.has(toolName.toLowerCase())) return null
  const command = input?.command
  return typeof command === 'string' && command.trim().length > 0 ? command : null
}

// ── Redirect analysis (pure) ──────────────────────────────────────────────────

/**
 * The roots a redirect target may legitimately land in. `cwd` is the session's
 * working tree; `tempDirs` comes from {@link tempDirRoots}; `additionalDirectories`
 * is the user's own permission grant (the same list `classifierEnvironment`
 * publishes to the judge).
 */
export interface RedirectScope {
  cwd: string
  tempDirs?: readonly string[]
  additionalDirectories?: readonly string[]
}

/**
 * What the harness MEASURED about a command's shell redirects.
 *
 * Field semantics differ on purpose:
 * - `targets` / `unresolvable` carry the target **as written**, so the judge can
 *   match them against the command text it was shown;
 * - `outOfScope` carries the **resolved** absolute path, because `> ../../x` is
 *   only alarming once you can see where it lands;
 * - `protectedHits` carries the offending path COMPONENT (`.git`, `.bashrc`),
 *   which is the fact, not the path.
 *
 * Unlike the whole-analysis contract (a `null` return means "emit nothing"),
 * the empty arrays here are load-bearing: `"outOfScope":[]` says we looked.
 */
export interface RedirectAnalysis {
  /** Every file target, as written. Excludes fd-duplications and null sinks. */
  targets: string[]
  /** True only when every target resolved INSIDE a scope root and none is protected. */
  allInScope: boolean
  /** Resolved absolute paths that landed outside every scope root. */
  outOfScope: string[]
  /** Targets carrying `$`, a backtick, `~` or a glob char — not measurable from the string. */
  unresolvable: string[]
  /** Protected path components hit by any target (`.git`, `.env*`, shell rc files). */
  protectedHits: string[]
}

/**
 * Path components that make a target off-limits no matter where it resolves —
 * repo/agent internals, credential stores, and the shell rc files that are the
 * classic persistence vehicle (Unauthorized Persistence). Compared
 * case-insensitively: over-matching costs an escalation, under-matching costs a
 * silent write to `~/.BASHRC` on a case-insensitive filesystem.
 */
const PROTECTED_COMPONENTS: ReadonlySet<string> = new Set([
  '.git',
  '.claude',
  '.pi',
  '.ssh',
  '.bashrc',
  '.zshrc',
  '.profile',
  '.bash_profile'
])

/** Anything the shell would expand or match at run time: we cannot know the
 *  target from the string, so it is reported as unresolvable rather than guessed. */
const UNRESOLVABLE_CHARS = /[$`~*?[\]{}]/

/** Sinks that discard their input — writing to them is not a file overwrite, so
 *  they are dropped from `targets` entirely (reporting `/dev/null` as
 *  out-of-scope would turn the single commonest redirect idiom into a
 *  danger signal). A command whose ONLY targets are sinks yields `null`, i.e.
 *  the pre-existing behaviour, never a fabricated all-clear. */
const NULL_SINKS: ReadonlySet<string> = new Set(['/dev/null', 'nul'])

/** A command with more redirects than this cannot be summarised honestly in one
 *  meta line, so it emits nothing and escalates as before. */
export const MAX_REDIRECT_TARGETS = 20

/** Characters that terminate an unquoted redirect target token. */
const TARGET_END = new Set([' ', '\t', '\n', '\r', ';', '|', '&', '<', '>', '(', ')'])

/**
 * Pull the FILE targets out of a command's redirect operators.
 *
 * Handles `>`, `>>`, `N>`, `N>>`, `&>`, `&>>`, `>&file`, `>>&file`, with or
 * without whitespace before the target, and a quoted target (`> "build out.log"`).
 * fd-duplications (`2>&1`, `>&2`, `2>&-`) target no file and are dropped.
 * Input redirects and heredocs (`<`, `<<`) are reads — the scanner never
 * triggers on them.
 *
 * Deliberately QUOTE-BLIND outside a target token, matching {@link parseSegment}'s
 * convention and for the same reason inverted: a `>` inside a quoted string
 * yields a spurious target (an extra escalation), while honouring quotes would
 * let `bash -c "cmd > ~/.bashrc"` report zero redirects and so claim, wrongly,
 * that this command redirects nothing dangerous. Over-reporting is the safe
 * error here. It also means segment splitting is unnecessary: a redirect
 * operator binds to the token after it regardless of which segment it sits in
 * (and {@link splitCommandSegments} would tear `2>&1` in half at the `&`).
 */
function extractRedirectTargets(command: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < command.length) {
    const ch = command[i]
    if (ch !== '>' && !(ch === '&' && command[i + 1] === '>')) {
      i++
      continue
    }
    if (ch === '&') i++ // `&>` / `&>>` — both streams to one file
    i++ // the first `>`
    if (command[i] === '>') i++ // append; identical for our purposes
    let sawAmpersand = false
    if (command[i] === '&') {
      sawAmpersand = true
      i++
    }
    while (command[i] === ' ' || command[i] === '\t') i++
    let raw: string
    const quote = command[i]
    if (quote === '"' || quote === "'") {
      const end = command.indexOf(quote, i + 1)
      if (end === -1) {
        raw = command.slice(i + 1)
        i = command.length
      } else {
        raw = command.slice(i + 1, end)
        i = end + 1
      }
    } else {
      const start = i
      while (i < command.length && !TARGET_END.has(command[i])) i++
      raw = command.slice(start, i)
    }
    // `>&1`, `2>&-` — a duplication of a file descriptor, not a file.
    if (sawAmpersand && /^\d*-?$/.test(raw)) continue
    if (raw.length > 0) out.push(raw)
  }
  return out
}

/** `\` → `/`, collapsed slashes, and (win32 only) the Git-Bash `/d/x` spelling
 *  folded onto `d:/x`. Gated on platform because `/e/tc` is a real directory on
 *  Linux; `platform` is injectable so both branches are testable anywhere. */
function toPosixish(raw: string, platform: NodeJS.Platform): string {
  let s = raw.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  if (platform === 'win32') {
    const msys = /^\/([A-Za-z])(\/|$)/.exec(s)
    if (msys) s = `${msys[1]}:${s.slice(2) || '/'}`
  }
  return s
}

function isAbsolutePosixish(s: string, platform: NodeJS.Platform): boolean {
  if (s.startsWith('/')) return true
  return platform === 'win32' && /^[A-Za-z]:\//.test(s)
}

interface NormalizedPath {
  /** Canonical comparison form, e.g. `d:/repo/build.log` or `/repo/build.log`. */
  full: string
  /** Path components, drive prefix excluded — what the protected-name check reads. */
  components: string[]
}

/**
 * Resolve+normalize without `node:path`, so a test's verdict does not depend on
 * the OS running it (the whole point of the injectable `platform`). `.` and `..`
 * are collapsed textually — there are no symlinks to consult, and a `..` that
 * climbs past the root simply stops there.
 */
function normalizePath(raw: string, platform: NodeJS.Platform): NormalizedPath {
  const s = toPosixish(raw, platform)
  let drive = ''
  let rest = s
  if (platform === 'win32') {
    const m = /^([A-Za-z]:)(\/|$)/.exec(s)
    if (m) {
      drive = m[1].toLowerCase()
      rest = s.slice(m[1].length)
    }
  }
  const absolute = rest.startsWith('/')
  const components: string[] = []
  for (const part of rest.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      components.pop()
      continue
    }
    components.push(part)
  }
  return { full: drive + (absolute || drive ? '/' : '') + components.join('/'), components }
}

/** Resolve a possibly-relative target against `cwd`, both in posix-ish form. */
function resolveTarget(cwd: string, target: string, platform: NodeJS.Platform): NormalizedPath {
  const t = toPosixish(target, platform)
  if (isAbsolutePosixish(t, platform)) return normalizePath(t, platform)
  return normalizePath(`${toPosixish(cwd, platform).replace(/\/+$/, '')}/${t}`, platform)
}

/** True iff `target` is a PROPER descendant of `root` (root-equal is not inside,
 *  mirroring {@link isPathInside} in services/path-containment.ts). */
function isDescendant(root: string, target: string, platform: NodeJS.Platform): boolean {
  const fold = (s: string): string => (platform === 'win32' ? s.toLowerCase() : s)
  const r = fold(root).replace(/\/+$/, '')
  return fold(target).startsWith(`${r}/`)
}

function protectedComponentsOf(components: readonly string[]): string[] {
  const hits: string[] = []
  for (const c of components) {
    const lower = c.toLowerCase()
    if (PROTECTED_COMPONENTS.has(lower) || lower.startsWith('.env')) hits.push(c)
  }
  return hits
}

/**
 * The temp roots a redirect may legitimately write to. Read from the env rather
 * than hard-coded so a session running under a sandboxed `TMPDIR` is judged
 * against the temp dir it actually has.
 */
export function tempDirRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  let osTemp: string | undefined
  try {
    osTemp = tmpdir()
  } catch {
    // Never throw out of the approval path for a missing temp dir; one fewer
    // scope root only ever costs an escalation.
  }
  const candidates = [osTemp, env.TMPDIR, env.TEMP, env.TMP]
  return [...new Set(candidates.filter((v): v is string => !!v && v.trim().length > 0))]
}

/**
 * Measure where a command's shell redirects would write.
 *
 * This exists because a redirect is an un-analysable file overwrite from the
 * command string alone, so `cmd > build.log 2>&1` — a log-and-grep loop, the
 * hottest safe path there is — otherwise escalates to the slow judge every
 * single time. Resolving the target against the session's own scope turns that
 * into a measured fact the fast stage can act on (rule corpus: Local Operations).
 *
 * Returns `null` — meaning emit NO meta line — when the command has no file
 * redirect at all, or has more than {@link MAX_REDIRECT_TARGETS} of them. As
 * everywhere in this file, saying nothing is the fallback; the one thing that
 * must never happen is a fabricated `allInScope: true`.
 */
export function analyzeRedirects(
  command: string,
  scope: RedirectScope,
  platform: NodeJS.Platform = process.platform
): RedirectAnalysis | null {
  const raws = extractRedirectTargets(command)
  if (raws.length === 0 || raws.length > MAX_REDIRECT_TARGETS) return null

  const roots = [scope.cwd, ...(scope.tempDirs ?? []), ...(scope.additionalDirectories ?? [])]
    .filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
    .map((r) => normalizePath(r, platform).full)

  const targets: string[] = []
  const outOfScope: string[] = []
  const unresolvable: string[] = []
  const protectedHits = new Set<string>()

  for (const raw of raws) {
    if (NULL_SINKS.has(toPosixish(raw, platform).toLowerCase())) continue
    targets.push(raw)
    // The protected-name check runs on the RAW spelling too, so `~/.bashrc`
    // is still reported as an rc-file write even though `~` makes it
    // unresolvable — the two facts are independent.
    for (const hit of protectedComponentsOf(toPosixish(raw, platform).split('/'))) {
      protectedHits.add(hit)
    }
    if (UNRESOLVABLE_CHARS.test(raw)) {
      unresolvable.push(raw)
      continue
    }
    const resolved = resolveTarget(scope.cwd, raw, platform)
    for (const hit of protectedComponentsOf(resolved.components)) protectedHits.add(hit)
    if (!roots.some((root) => isDescendant(root, resolved.full, platform))) {
      outOfScope.push(resolved.full)
    }
  }

  if (targets.length === 0) return null
  return {
    targets,
    allInScope: outOfScope.length === 0 && unresolvable.length === 0 && protectedHits.size === 0,
    outOfScope,
    unresolvable,
    protectedHits: [...protectedHits]
  }
}

// ── Capture primitives ────────────────────────────────────────────────────────

export interface CaptureExecResult {
  /** Process exited 0 within the budget. */
  ok: boolean
  stdout: string
}

/** Injected process runner — the seam every capture is tested through. */
export type CaptureExec = (
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number }
) => Promise<CaptureExecResult>

/** Budget for the git captures (ref: these run on the approval hot path). */
export const GIT_CAPTURE_TIMEOUT_MS = 1500
/** `gh` hits the network on a cold cache, so it gets a slightly longer leash. */
export const GH_CAPTURE_TIMEOUT_MS = 2000
/** Hard cap on captured stdout — a 100k-file repo must not blow up the heap. */
const MAX_CAPTURE_BYTES = 1_000_000

/**
 * `spawn` with `shell: false` — the arguments are fixed literals here, and
 * keeping the shell out means a hostile `cwd` can never become a command.
 * Never rejects: a spawn failure, a non-zero exit and a timeout all resolve to
 * `{ ok: false }`, which every caller turns into "emit nothing".
 */
const defaultExec: CaptureExec = (command, args, { cwd, timeoutMs }) =>
  new Promise<CaptureExecResult>((resolve) => {
    let settled = false
    const finish = (r: CaptureExecResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }
    const timer = setTimeout(() => {
      try {
        child?.kill()
      } catch {
        /* already gone */
      }
      finish({ ok: false, stdout: '' })
    }, timeoutMs)
    timer.unref?.()

    let child: ReturnType<typeof spawn> | undefined
    try {
      child = spawn(command, args, {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      })
    } catch {
      finish({ ok: false, stdout: '' })
      return
    }
    let stdout = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_CAPTURE_BYTES) stdout += chunk.toString('utf-8')
    })
    child.on('error', () => finish({ ok: false, stdout: '' }))
    child.on('close', (code) => finish({ ok: code === 0, stdout }))
  })

// ── Captures ──────────────────────────────────────────────────────────────────

export interface GitRemote {
  name: string
  url: string
}

/**
 * Session-start git remotes — the trust anchor for the push/publish rules
 * (ref §9.1 "Trusted repo"). Callers must capture this ONCE per session and
 * cache it: a remote added mid-session is precisely what the exfiltration rules
 * exist to catch, so refreshing would let an attacker whitelist their own
 * destination.
 *
 * Only `(fetch)` lines are read — `git remote -v` prints fetch and push URLs
 * for every remote, and a remote with divergent URLs would otherwise be listed
 * twice.
 */
export async function captureGitRemotes(
  cwd: string,
  exec: CaptureExec = defaultExec
): Promise<GitRemote[]> {
  let res: CaptureExecResult
  try {
    res = await exec('git', ['remote', '-v'], { cwd, timeoutMs: GIT_CAPTURE_TIMEOUT_MS })
  } catch {
    return []
  }
  if (!res.ok) return []
  const remotes: GitRemote[] = []
  const seen = new Set<string>()
  for (const raw of res.stdout.split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(raw.trim())
    if (!m) continue
    const key = `${m[1]}\u0000${m[2]}`
    if (seen.has(key)) continue
    seen.add(key)
    remotes.push({ name: m[1], url: m[2] })
  }
  return remotes
}

export interface GitStatusMeta {
  /** No entries at all — this is what clears the policy's "presume dirty" default. */
  clean: boolean
  /** Count of TRACKED changes (staged + unstaged); untracked files are listed instead. */
  modified: number
  /** Untracked paths, capped at {@link MAX_UNTRACKED_NAMES} — the names matter (`.env`). */
  untracked: string[]
  /** Only present when the list above was capped, so the judge knows it is partial. */
  untrackedTotal?: number
}

/** Untracked names are the point (`.env`, `id_rsa`), but the list must stay bounded. */
export const MAX_UNTRACKED_NAMES = 20

/** Un-escape a `git status --porcelain` path (quoted only when it needs to be). */
function unquotePath(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"') || path.length < 2) return path
  return path.slice(1, -1).replace(/\\(["\\])/g, '$1')
}

/**
 * Measured working-tree state. Returns `null` — meaning "emit NO meta line" —
 * on any failure, timeout, or non-repo cwd. A fabricated `{"clean":true}` would
 * clear the policy's dirty-tree presumption on zero evidence.
 */
export async function captureGitStatus(
  cwd: string,
  exec: CaptureExec = defaultExec
): Promise<GitStatusMeta | null> {
  let res: CaptureExecResult
  try {
    res = await exec('git', ['status', '--porcelain'], { cwd, timeoutMs: GIT_CAPTURE_TIMEOUT_MS })
  } catch {
    return null
  }
  if (!res.ok) return null
  const lines = res.stdout
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim().length > 0)
  const untracked: string[] = []
  let modified = 0
  for (const line of lines) {
    if (line.startsWith('??')) untracked.push(unquotePath(line.slice(2).trim()))
    else modified++
  }
  const capped = untracked.length > MAX_UNTRACKED_NAMES
  return {
    clean: lines.length === 0,
    modified,
    untracked: capped ? untracked.slice(0, MAX_UNTRACKED_NAMES) : untracked,
    ...(capped ? { untrackedTotal: untracked.length } : {})
  }
}

/**
 * Repository visibility. `'unknown'` is a real, reportable answer (ref §5
 * renders it explicitly): it means the harness LOOKED and could not tell —
 * `gh` absent, not a GitHub remote, not authenticated — which is different from
 * no line at all.
 *
 * The value is validated against the known set rather than passed through:
 * `gh` output reaches the prompt verbatim, so an unconstrained string would be
 * one more channel into the judge's context.
 */
export type RepoVisibility = 'public' | 'private' | 'internal' | 'unknown'

export async function captureRepoVisibility(
  cwd: string,
  exec: CaptureExec = defaultExec
): Promise<RepoVisibility> {
  let res: CaptureExecResult
  try {
    res = await exec('gh', ['repo', 'view', '--json', 'visibility', '-q', '.visibility'], {
      cwd,
      timeoutMs: GH_CAPTURE_TIMEOUT_MS
    })
  } catch {
    return 'unknown'
  }
  if (!res.ok) return 'unknown'
  const v = res.stdout.trim().toLowerCase()
  return v === 'public' || v === 'private' || v === 'internal' ? v : 'unknown'
}
