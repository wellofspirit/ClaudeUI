/**
 * Harness ground truth for the auto-mode classifier — phase 3 of
 * `docs/automode-rework-plan.md` §5, behavioural reference
 * `docs/protocol/14-auto-mode-classifier.md` §5.
 *
 * Three kinds of fact the judge cannot get from the transcript, because the
 * slimmer deliberately drops tool RESULTS:
 *
 * 1. **`{"outcome":…}` annotations** — how a prior tool call ended. Without
 *    them post-block consent inheritance is unreachable (a denial is a tool
 *    result) and the mandatory Transient Retry exception is a permissiveness
 *    hole (nothing marks a prior attempt as refused).
 * 2. **`{"meta":{"gitStatus":…}}`** — measured, not inferred, working-tree
 *    state before commands that can destroy uncommitted work or ship it.
 * 3. **`{"meta":{"repoVisibility":…}}` / `EnvironmentInfo.remotes`** — the
 *    trust anchors for the exfiltration rules.
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
