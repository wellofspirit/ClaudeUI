/**
 * Harness ground truth for the auto-mode classifier — phase 3 of
 * `docs/automode-rework-plan.md` §5, behavioural reference
 * `docs/protocol-cc/14-auto-mode-classifier.md` §5.
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
import {
  AGENT_CONTROL_DIRS,
  AGENT_CONTROL_FILES,
  agentControlSequenceHits,
  foldName,
  isAgentControlPath
} from './agent-control-paths'
import {
  isAbsolutePosixish,
  isDescendant,
  normalizePath,
  resolveTarget,
  toPosixish
} from './shell-lexical'

// ── Outcome annotations ───────────────────────────────────────────────────────

/**
 * How a completed tool call ended, with cli.js's prescribed meanings (ref §5).
 *
 * This is deliberately a SUBSET of cli.js's eight values plus ONE of our own:
 * the four cli.js values are the ones our harness can actually observe today.
 * The others (`interrupted`, `blocked-by-permissions`, `automode-unavailable`,
 * `automode-parsing-error`) are not invented here — an outcome we cannot
 * measure would be a lie to the judge, and per ref §5 the absence of an
 * outcome is explicitly *not* success, so omitting is always the safe fallback.
 * `unanswered` has no cli.js counterpart because cli.js has no equivalent
 * failure: it is measured directly by PiBridgeHost's abandonment timer (the
 * pi child stopped polling the approval bridge before ClaudeUI answered — see
 * PiSession.handleBridgeAbandoned), so recording it is a fact, not a guess.
 *
 * | Value | Meaning to the classifier |
 * |---|---|
 * | `ok` | ran without harness error — **not** a safety verdict, not precedent |
 * | `error` | harness/tool error; may not have executed |
 * | `rejected-by-user` | the human declined **this** call; a retry without new authorization should be blocked |
 * | `automode-blocked` | this classifier denied it |
 * | `unanswered` | ClaudeUI's decision never reached the agent (it stopped waiting); the call never ran, and nobody refused it — a re-attempt is a fresh proposal that Transient Retry may cover |
 */
export type ToolOutcome = 'ok' | 'error' | 'rejected-by-user' | 'automode-blocked' | 'unanswered'

/**
 * Outcomes that record a permission DECISION rather than an execution result.
 * They are sticky: once a call was refused, the engine may still report the
 * tool part as `error` moments later (opencode surfaces a rejected permission
 * as a failed tool), and letting that overwrite `rejected-by-user` would erase
 * exactly the annotation Transient Retry depends on.
 */
const DECISION_OUTCOMES: ReadonlySet<ToolOutcome> = new Set<ToolOutcome>([
  'rejected-by-user',
  'automode-blocked',
  // Sticky for the same reason: pi reports the abandoned call as a failed tool
  // ("approval service unreachable") moments after the bridge gave up, and
  // that `error` must not erase the fact that nobody ever decided.
  'unanswered'
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

// The pure implementation lives in shell-lexical.ts (read-only.ts shares it
// without pulling in node:child_process); existing callers import it from here.
export { shellCommandOf } from './shell-lexical'

// ── Redirect analysis (pure) ──────────────────────────────────────────────────

/** Which shell dialect reads the command. It decides the backslash reading
 *  (ruling 12) and which temp-variable spellings the non-authoritative
 *  `tempVarTargets` hint recognises (ruling 18): `posix` knows `$NAME`/`${NAME}`,
 *  `powershell` knows `$env:NAME`, and `%NAME%` is never a variable in either.
 *  It never expands a target for scope — a `$` target stays unresolvable. */
export type RedirectShell = 'posix' | 'powershell'

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
  /**
   * Where the SHELL starts when that differs from the session cwd — the
   * `workdir` the call runs in (`effectiveShellCwd`). `undefined` means "same as
   * `cwd`"; `null` means the caller could not establish one, which makes every
   * RELATIVE target unresolvable (we will not guess which directory it means).
   */
  shellCwd?: string | null
  /**
   * The host temp-dir variables that are SET, from {@link tempVarValues}. Used
   * ONLY to word the non-authoritative {@link RedirectAnalysis.tempVarTargets}
   * hint: the scanner never expands a variable for scope, so `$TMPDIR/x` stays
   * unresolvable whether or not the variable is listed here (ruling 18).
   */
  tempVars?: Readonly<Record<string, string>>
  /** The dialect that will read the command (see {@link RedirectShell}). */
  shell?: RedirectShell
}

/**
 * What the harness MEASURED about a command's shell redirects.
 *
 * Field semantics differ on purpose:
 * - `targets` / `unresolvable` carry the target **as written**, so the judge can
 *   match them against the command text it was shown;
 * - `outOfScope` carries the **resolved** absolute path plus the per-target
 *   facts P2a-2 measures (`append`, `exists`, `empty`, `modifiedSinceSessionStart`),
 *   because `> ../../x` is only alarming once you can see where it lands and
 *   whether it already existed;
 * - `protectedHits` carries the offending path COMPONENT (`.git`, `.bashrc`),
 *   which is the fact, not the path;
 * - `symlinked` carries the **as-written** targets that are symbolic links,
 *   listed ONLY there (they are dropped from `outOfScope`) and only when
 *   non-empty;
 * - `tempVarTargets` is a NON-AUTHORITATIVE hint, present only when non-empty:
 *   for each unresolvable target that starts with a temp-directory variable it
 *   says which path that variable normally names. It never affects
 *   `allInScope`, `outOfScope` or `unresolvable` — a wrong hint costs nothing,
 *   because the judge reads the command itself;
 * - `quotedTargets` is the QUOTE-BLIND cross-check's residue, present only when
 *   non-empty: raw spellings a `>` inside quoted text / a heredoc body / an
 *   inert argument names that the quote-aware scan did NOT read as a redirect,
 *   and that are not cleanly in scope (outside every root, protected, or not
 *   resolvable). They are probably text (`echo "a > /etc/x"`) but would be a real
 *   write if the text is re-read as shell (`echo 'x > /etc/x' | "$BASH"`), which
 *   the scanner cannot rule out. They are NEVER also in `targets`,
 *   `outOfScope`, `unresolvable` or `protectedHits`, so "probably text" stays
 *   distinguishable from "definitely a write", and any entry makes `allInScope`
 *   false. A raw spelling is shown at most 200 characters;
 * - `unmeasured` is present only when non-empty: the as-written targets whose
 *   containment the harness could not establish (a missing parent under a link,
 *   an unreadable root, a probe timeout, an unknown shell drive). Such a target
 *   may also sit in another list; `allInScope` is false whenever this is present.
 *
 * Unlike the whole-analysis contract (a `null` return means "emit nothing"),
 * the empty arrays here are load-bearing: `"outOfScope":[]` says we looked.
 */
export interface RedirectAnalysis {
  /** Every file target, as written. Excludes fd-duplications and null/stream sinks. */
  targets: string[]
  /** True only when every target resolved INSIDE a scope root, none is protected,
   *  none is a symlink, none is unmeasured and the quote-blind cross-check found
   *  no quote-hidden target that is not cleanly in scope. */
  allInScope: boolean
  /** Resolved targets that landed outside every scope root, with measured facts. */
  outOfScope: RedirectOutOfScopeTarget[]
  /** Targets carrying `$`, a backtick, `~`, a glob char or `%` — not measurable from the string. */
  unresolvable: string[]
  /** Protected path components hit by any target (`.git`, `.env*`, shell rc files). */
  protectedHits: string[]
  /** As-written targets that are symlinks. Present only when non-empty. */
  symlinked?: string[]
  /** Unresolvable targets that start with a temp-directory variable, with the
   *  path that variable normally names. A hint only. Present only when non-empty. */
  tempVarTargets?: RedirectTempVarTarget[]
  /** Quote-hidden targets the quote-blind cross-check found that are not cleanly in
   *  scope, as written. Disjoint from `targets`. Present only when non-empty. */
  quotedTargets?: string[]
  /** As-written targets whose containment could not be established. Present only
   *  when non-empty. */
  unmeasured?: string[]
}

/**
 * One temp-variable hint (ruling 18): the target AS WRITTEN (it is also in
 * `unresolvable`) and the path the temp variable normally names, so a judge can
 * see that `> $TMPDIR/x.log` is probably a scratch write without the scanner
 * ever claiming it is one.
 */
export interface RedirectTempVarTarget {
  /** The unresolvable target as written. */
  target: string
  /** The normalised path the temp variable named, plus the rest of the target. */
  path: string
}

/**
 * One out-of-scope target. `append` is present only when true, and the measured
 * fields only when MEASURED (P2a-2): `exists` whenever it was probed; `empty`
 * and `modifiedSinceSessionStart` only for an existing regular file.
 */
export interface RedirectOutOfScopeTarget {
  /** Resolved absolute path, posix-ish (drive lowercased on win32). */
  path: string
  append?: true
  exists?: boolean
  empty?: boolean
  modifiedSinceSessionStart?: boolean
}

/** What P2a-2 could measure about one resolved target. Absent field = not measured. */
export interface RedirectMeasurement {
  exists?: boolean
  empty?: boolean
  modifiedSinceSessionStart?: boolean
  symlinked?: boolean
}

/**
 * One target's pure facts — the whole intermediate representation between the
 * scanner and the meta line (P2a-2 measures `path`/`root` and then calls
 * {@link summarizeRedirects}).
 *
 * `path` is absent exactly when the target is unresolvable (`~`, a bare `$VAR`,
 * a glob, an unreadable or empty target, a drive-relative `C:x`, or a relative
 * target with an unknown shell cwd). `root` is the scope root the resolved path
 * sits inside, absent when it is out of scope.
 *
 * A single as-written target can yield SEVERAL details: one per shell-state
 * possibility (the shell may or may not have changed directory, ruling 13) and
 * one per reading of a backslash the reader might remove (ruling 6/12). They
 * share `raw`; `summarizeRedirects` de-duplicates `targets` by it.
 */
export interface RedirectTargetDetail {
  /** As written in the command, quotes stripped. */
  raw: string
  /** Resolved absolute path, absent when unresolvable. */
  path?: string
  /** `>>`, `&>>`, `N>>`, `tee -a`, `Add-Content`, `Out-File -Append`, `Tee-Object -Append`. */
  append: boolean
  /** The scope root containing `path`, absent when out of scope. */
  root?: string
  /** Protected components this target hits, as spelled in the checked path. */
  protectedHits: string[]
  /**
   * The directory `raw` was resolved against (the drive root for an absolute
   * target). P2a-2 needs it to `realpath` the prefixes that precede a `..`.
   */
  base?: string
  /**
   * The path a leading temp-directory variable normally names plus the rest of
   * `raw`, present only on an unresolvable target that starts with one (ruling
   * 18). A hint for the judge, never a scope claim: it never promotes a
   * variable target into scope, and an unsupported spelling omits it.
   */
  tempVarPath?: string
  /**
   * The same hint spelled BEFORE `..` is collapsed. The physical check must see
   * `temp/jump/../x` to notice that `jump` is a junction out of temp (exit
   * review R1); the normalised `tempVarPath` alone has lost that evidence.
   */
  tempVarSpelling?: string
  /**
   * The drive the shell is on when this target runs, for a PowerShell rooted
   * path such as `/tmp/x` (which means `<drive>:/tmp/x`). `null` means the
   * shell state could not establish one. Undefined for targets whose spelling
   * does not depend on the shell's current drive.
   */
  shellDrive?: string | null
  /**
   * Containment could not be established (a missing parent under a link, an
   * unreadable root, a timeout, an unknown shell drive). The caller must not
   * claim a clean scope for this target (exit review R3/R4/R5).
   */
  reviewRequired?: true
  /**
   * Found ONLY by the quote-blind cross-check ({@link quoteHiddenTargets}): the
   * quote-aware scan read this `>` as text. Present only on a target that is not
   * cleanly in scope. {@link summarizeRedirects} reports it in `quotedTargets`
   * and nowhere else.
   */
  quoted?: true
}

/**
 * Path components that make a target off-limits no matter where it resolves —
 * repo/agent internals, credential stores, and the shell rc files that are the
 * classic persistence vehicle (Unauthorized Persistence). Compared after the
 * same folding agent-control-paths.ts applies (case, trailing dots/spaces, ADS
 * suffix): over-matching costs an escalation, under-matching costs a silent
 * write to `~/.BASHRC` on a case-insensitive filesystem.
 */
const PROTECTED_COMPONENTS: ReadonlySet<string> = new Set([
  '.git',
  '.claude',
  '.pi',
  '.ssh',
  '.bashrc',
  '.zshrc',
  '.profile',
  '.bash_profile',
  // The other rc files a login or interactive shell sources, and the two git
  // files that carry credentials / submodule URLs (judge-hardening audit).
  '.zshenv',
  '.zprofile',
  '.bash_login',
  '.git-credentials',
  '.gitmodules',
  // Credential/persistence stores (exit review C1). A session started in `~` (or
  // any directory holding one of these) would otherwise report a write to
  // `~/.aws/credentials` as a plain in-scope file, and the Local Operations
  // sentence would clear truncating it. `gcloud` is the component under
  // `.config`; `find ~` trawling is Credential Exploration's business.
  '.aws',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.gnupg',
  '.docker',
  '.kube',
  '.gitconfig',
  'gcloud'
])

/** Anything the shell would expand or match at run time: we cannot know the
 *  target from the string, so it is reported as unresolvable rather than guessed.
 *  `%` is here because `%TEMP%` is a literal name in BOTH bash and PowerShell
 *  (ruling 4) — treating it as a relative path would invent an in-scope write. */
const UNRESOLVABLE_CHARS = /[$`~*?[\]{}%]/

/** Sinks that discard their input — writing to them is not a file overwrite, so
 *  they are dropped from `targets` entirely (reporting `/dev/null` as
 *  out-of-scope would turn the single commonest redirect idiom into a
 *  danger signal). `$null` is PowerShell's automatic variable for the same
 *  thing: `2>$null`, `*>$null` and `| Out-Null` write no file — but ONLY in
 *  PowerShell: in bash `null=/etc/passwd; echo x > $null` writes `/etc/passwd`,
 *  so {@link isSink} drops `$null` for a known PowerShell shell alone. A command
 *  whose ONLY targets are sinks yields `null`, i.e. the pre-existing behaviour,
 *  never a fabricated all-clear. */
const NULL_SINKS: ReadonlySet<string> = new Set(['/dev/null', 'nul'])
/** The PowerShell-only null sink (see {@link NULL_SINKS}). */
const POWERSHELL_NULL_SINK = '$null'

/**
 * Stream pseudo-files: the same class of sink as `/dev/null` (exit review Fable
 * C3). `echo msg > /dev/stderr` is the commonest script idiom there is, and
 * MEASURING it is a new false-block path: on Linux `/dev/stderr` is a symlink to
 * `/proc/self/fd/2` (so it reads as `symlinked`, which no exemption clears), on
 * macOS it is a device (`exists:true`, "an existing file outside the working
 * tree"). They write to the terminal or a file descriptor, never to a named
 * file, so they are dropped from `targets` exactly like null sinks. The command's
 * own real file redirect, if any, is still scanned.
 */
const STREAM_SINK_RE = /^\/(?:dev\/(?:stdout|stderr|tty|fd\/\d+)|proc\/self\/fd\/\d+)$/

/**
 * True when the as-written target names a null or stream sink.
 *
 * Stream pseudo-files are a POSIX-shell meaning (exit review R6): PowerShell
 * resolves `/dev/stderr` to `<current drive>:/dev/stderr`, an ordinary file.
 * So the stream spelling is dropped only where that meaning is established —
 * on a non-Windows host, or in a known POSIX shell on Windows. An unknown
 * Windows dialect keeps the PowerShell file interpretation.
 */
function isSink(raw: string, platform: NodeJS.Platform, shell: RedirectShell | undefined): boolean {
  const posix = toPosixish(raw, platform)
  const folded = posix.toLowerCase()
  if (NULL_SINKS.has(folded)) return true
  // An unknown shell is NOT assumed to be PowerShell: `$null` is then an ordinary
  // variable reference, unresolvable like any other `$` target.
  if (shell === 'powershell' && folded === POWERSHELL_NULL_SINK) return true
  if (platform !== 'win32' || shell === 'posix') {
    if (STREAM_SINK_RE.test(posix)) return true
  }
  // Windows' console device, case-insensitively (`> CON`); only on win32, so a
  // posix file literally named `con` keeps its fact.
  return platform === 'win32' && posix.trim().toLowerCase() === 'con'
}

/** A command with more redirects than this cannot be summarised honestly in one
 *  meta line, so it emits nothing and escalates as before. */
export const MAX_REDIRECT_TARGETS = 20

/**
 * Commands longer than this return no meta at all (ruling 8): the judge reads
 * the command, and a summary of a 200 KB script would cost more than it says.
 */
export const MAX_ANALYZE_COMMAND_LENGTH = 64 * 1024

/** How deep a quoted span / heredoc body is re-read as shell before we stop. */
const MAX_NESTING = 3

/** How many shell-state possibilities one segment may carry before we give up
 *  and call the state unknowable (a bounded walk, ruling 8/13). */
const MAX_SHELL_POSSIBILITIES = 8

/** Characters that terminate an unquoted redirect target token. */
const TARGET_END = new Set([' ', '\t', '\n', '\r', ';', '|', '&', '<', '>', '(', ')'])

/**
 * Commands whose single- AND double-quoted arguments are inert text — a
 * pattern, a filter, a literal — that never reaches a shell. Only a segment led
 * by one of these may have its quoted spans skipped by the redirect scan. An
 * allowlist on purpose: `git submodule foreach '…'`, `make --eval '…'`,
 * `npx -c '…'` all hand quoted text to a shell, and a list of those would never
 * be complete.
 *
 * The PowerShell cmdlets are the same idea in the other shell: `Write-Host
 * "a > b"` prints text, it does not redirect. Matched case-insensitively (the
 * segment's command word is folded to lower case before the lookup).
 */
const INERT_QUOTE_COMMANDS: ReadonlySet<string> = new Set([
  'sed',
  'gsed',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'jq',
  'yq',
  'echo',
  'printf',
  'tr',
  'cut',
  'write-host',
  'write-output',
  'select-string'
])

/**
 * Language interpreters: their quoted arguments are program text (or argv), never
 * shell. A `>` inside `python -c "…"`, `node --eval "…"`, `perl -e '…'` is a
 * phantom target, so every quoted span in a segment containing one of these is
 * inert. Deliberately a SHORT list: the residual is that an interpreter's own
 * shell-out (`os.system("x > y")`, `open(…,'w')`) is not a redirect of THIS
 * command either — the judge reads the payload, and over-reporting a phantom
 * path was the bug.
 */
const LANGUAGE_INTERPRETERS: ReadonlySet<string> = new Set([
  'python',
  'python3',
  'py',
  'node',
  'bun',
  'deno',
  'perl',
  'ruby',
  'php'
])

/**
 * Words that re-read text as shell — a shell, `eval`, a remote/elevated shell,
 * an argument-to-command runner, an interpreter fed on stdin — plus awk, whose
 * own `>` writes a file. Any of them ANYWHERE in the command (`echo '… > x' | sh`)
 * keeps the whole scan quote-blind. The language interpreters above are NOT here:
 * they get the narrower treatment of {@link LANGUAGE_INTERPRETERS}, because
 * `python3` reads its quoted argument as program text, not as a command line.
 *
 * `iex` / `invoke-expression`, `source`, `.`, `at`, `batch` and `wsl` are the
 * spellings that hand text to a shell too (ruling 2); so is any command word
 * that is itself an expansion (checked separately).
 */
const SHELL_REREADERS: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'mksh',
  'ash',
  'fish',
  'csh',
  'tcsh',
  'pwsh',
  'powershell',
  'cmd',
  'eval',
  'iex',
  'invoke-expression',
  'source',
  '.',
  'at',
  'batch',
  'wsl',
  'ssh',
  'su',
  'sudo',
  'doas',
  'runuser',
  'script',
  'watch',
  'xargs',
  'parallel',
  'osascript',
  'tmux',
  'screen',
  'expect',
  'busybox',
  'awk',
  'gawk',
  'mawk',
  'nawk'
])

// ── Lexer ─────────────────────────────────────────────────────────────────────

/** One operator that separates two segments (`null` at the start of a command). */
type SegmentOp = '&&' | '||' | ';' | '|' | '&' | '\n' | '(' | ')' | '{' | '}' | null

/** A shell word: its unquoted text plus where its quoted spans sat. */
interface LexWord {
  /** The word with quotes removed and shell escapes resolved. */
  text: string
  start: number
  end: number
  /** Content ranges of the quoted spans inside this word (delimiters excluded). */
  spans: Array<{ start: number; end: number; quote: "'" | '"' }>
  /** True when the word's text came from exactly ONE quoted span and nothing else. */
  fullyQuoted: boolean
  /** True when this word is the TARGET of a redirect operator (never an argument). */
  redirected?: boolean
}

/** One redirect operator and the word it points at (`word` absent when unreadable). */
interface LexRedirect {
  pos: number
  append: boolean
  /** `false` for input redirects (`<`, `<<<`), which name no write. */
  output: boolean
  word?: LexWord
}

interface LexSegment {
  words: LexWord[]
  start: number
  /** Bracket nesting depth at the segment's first character (0 = top level). */
  depth: number
  /** The operator that separated this segment from the previous one. */
  after: SegmentOp
  /** The operator that ends this segment. */
  sepAfter: SegmentOp
  /**
   * The last LIST operator (`&&`, `||`, `;`, newline, `|`, `&`) in force at this
   * segment, seen through group punctuation: the first member of `a && ( b )` and
   * the redirect that follows `a && { b; } > f` both carry `&&`, where `after`
   * says only `(` / `}`. A group runs only when the operator before it admits it.
   */
  gate: SegmentOp
  /** True when the segment was lexed from inside a quoted span / heredoc body. */
  nested: boolean
}

/** A body that is not shell command text: a heredoc body. */
interface LexBody {
  start: number
  end: number
  /** True when the delimiter was quoted (`<<'X'`, `<<"X"`, `<<\X`). */
  quoted: boolean
}

interface LexedCommand {
  segments: LexSegment[]
  redirects: LexRedirect[]
  bodies: LexBody[]
  /** False for an unbalanced quote, an unterminated heredoc, a PowerShell
   *  here-string or an unquoted `#` at a word start → quote-blind scan. */
  balanced: boolean
  /** Absolute range this command was lexed from (a nested slice, or the whole). */
  start: number
  end: number
  /** True when this command was lexed from inside another command's text. */
  nested: boolean
}

const SEGMENT_BREAKS: ReadonlySet<string> = new Set(['\n', '\r', ';', '|', '&', '(', ')', '{', '}'])
const OPEN_GROUPS: ReadonlySet<string> = new Set(['(', '{'])
const CLOSE_GROUPS: ReadonlySet<string> = new Set([')', '}'])
/** A word that assigns (`FOO=1`, `$x=1`) is skipped when finding a command word. */
const ASSIGNMENT_WORD = /^[A-Za-z_$][A-Za-z0-9_$]*=/

function isAssignmentWord(text: string): boolean {
  return ASSIGNMENT_WORD.test(text)
}

/**
 * One pass over the command producing the top-level segments, their words, the
 * redirect operators with their target words, and the non-shell bodies
 * (heredocs). Every consumer — the redirect scan, the writer-command scan
 * ({@link writerTargets}) and `cd` tracking ({@link shellStates}) — reads this
 * one result, so they cannot disagree about where a quote, a segment or a
 * heredoc starts.
 *
 * Splitting happens at unquoted `; | & newline ( ) { }`, with the operator
 * exceptions bash itself has: `2>&1`/`<&3`, `&>` and `&&`/`||` keep their `&`
 * or `|`. `{`/`}` are separators because a PowerShell/brace-group `cd` changes
 * a different shell than the outer one (see {@link shellStates}).
 *
 * A ROUGH lexer, not a shell parser: it does not understand `case`, `((` or
 * process substitution. Its imprecision NEVER makes text inert by itself —
 * {@link inertRanges} is the only place that decides something is not shell,
 * and it only does so for text both dialects provably agree is not shell. Every
 * other construct degrades to a quote-blind scan of that text, which reports
 * more, never less (ruling 1).
 */
function lexCommand(command: string, offset = 0, nested = false): LexedCommand {
  const segments: LexSegment[] = []
  const redirects: LexRedirect[] = []
  const bodies: LexBody[] = []
  let words: LexWord[] = []
  let word: LexWord | null = null
  let wordStart = 0
  let segStart = offset
  let segDepth = 0
  let depth = 0
  let state: 'out' | 'sq' | 'dq' = 'out'
  let sqStart = 0
  let dqStart = 0
  let outsideChars = 0
  let balanced = true
  let pending: Array<{ delim: string; quoted: boolean; stripTabs: boolean }> = []
  let after: SegmentOp = null
  let listOp: SegmentOp = null
  const gateStack: SegmentOp[] = []
  let pendingRedirect: { pos: number; append: boolean; output: boolean } | null = null
  let paramBraces = 0
  // A `#` comment is only modelled where both dialects agree it starts one
  // (after whitespace or a separator) and PowerShell's `<# … #>` block comment,
  // which spans lines, is absent; anywhere else `#` keeps the quote-blind fallback.
  const lineComments = !command.includes('<#')

  const cur = (at: number): LexWord => {
    if (!word) {
      word = { text: '', start: offset + at, end: offset + at, spans: [], fullyQuoted: false }
      wordStart = at
    }
    return word
  }

  /** True when no word is open, i.e. the next character starts one (a `#` here
   *  would begin a bash comment). Read through a closure so TypeScript sees the
   *  declared type rather than its outer-flow narrowing. */
  const atWordStart = (): boolean =>
    word === null || (word.text.length === 0 && word.spans.length === 0)

  /** True when the current word is an fd prefix (`2`, `*`) touching `at`. */
  const isFdPrefixAt = (at: number): boolean => {
    const w = word
    return (
      w !== null &&
      w.spans.length === 0 &&
      (w.text === '*' || /^\d+$/.test(w.text)) &&
      wordStart + w.text.length === at
    )
  }

  /** True when a close-group character would end a fully-quoted word at depth 0:
   *  the group structure our lexer did not follow (a `)` that closes a real
   *  command substitution we read as quoted text). */
  const quotedWordEndsHere = (): boolean =>
    word !== null && word.spans.length > 0 && outsideChars === 0

  const dropWord = (): void => {
    word = null
    outsideChars = 0
  }

  const endWord = (at: number): void => {
    if (!word) return
    word.end = offset + at
    word.fullyQuoted = word.spans.length === 1 && outsideChars === 0
    if (pendingRedirect) {
      word.redirected = true
      redirects.push({ ...pendingRedirect, word })
      pendingRedirect = null
    }
    if (word.text.length > 0 || word.spans.length > 0 || word.redirected) words.push(word)
    word = null
    outsideChars = 0
  }

  const endSegment = (at: number, op: SegmentOp): void => {
    endWord(at)
    if (pendingRedirect) {
      // A redirect operator with no target at all (`echo x >`): report it as an
      // unreadable target rather than dropping it (ruling 6).
      redirects.push({ ...pendingRedirect })
      pendingRedirect = null
    }
    if (words.length > 0) {
      segments.push({
        words,
        start: segStart,
        depth: segDepth,
        after,
        sepAfter: op,
        gate: listOp,
        nested
      })
    }
    words = []
    after = op
    if (op === '(' || op === '{') gateStack.push(listOp)
    else if (op === ')' || op === '}') listOp = gateStack.pop() ?? listOp
    else if (op !== null) listOp = op
  }

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]

    if (state === 'sq') {
      if (ch === "'") {
        cur(i).spans.push({ start: offset + sqStart, end: offset + i, quote: "'" })
        state = 'out'
      } else cur(i).text += ch
      continue
    }
    if (state === 'dq') {
      if (ch === '\\') {
        const next = command[i + 1]
        // Only shell metacharacters are escapes: `"C:\Users\x"` must keep its
        // separators (PowerShell has no backslash escapes at all).
        if (next !== undefined && /["'\\ $`]/.test(next)) {
          cur(i).text += next
          i++
        } else cur(i).text += ch
      } else if (ch === '"') {
        cur(i).spans.push({ start: offset + dqStart, end: offset + i, quote: '"' })
        state = 'out'
      } else cur(i).text += ch
      continue
    }

    if (ch === "'") {
      cur(i)
      sqStart = i + 1
      state = 'sq'
      continue
    }
    if (ch === '"') {
      cur(i)
      dqStart = i + 1
      state = 'dq'
      continue
    }
    if (ch === '$' && command[i + 1] === "'") {
      // ANSI-C quoting (`$'…'`) is not modelled: bash's escapes inside it change
      // where the quote ends, so the whole command is scanned quote-blind.
      balanced = false
    }
    // PowerShell here-strings (`@"` / `@'` at the end of a line) are NOT
    // modelled (ruling 1): their presence makes the whole command quote-blind.
    if (
      ch === '@' &&
      (command[i + 1] === '"' || command[i + 1] === "'") &&
      (i === 0 || /[\s=;|&({[]/.test(command[i - 1]))
    ) {
      balanced = false
    }
    // Heredoc operator. `<<<` is bash's here-string, not a heredoc (N6).
    if (ch === '<' && command[i + 1] === '<' && command[i + 2] !== '<') {
      const parsed = readHeredocDelimiter(command, i + 2)
      if (parsed) {
        pending.push({ delim: parsed.delim, quoted: parsed.quoted, stripTabs: parsed.stripTabs })
        endWord(i)
        i = parsed.end - 1
        continue
      }
    }
    if (ch === '<' && command[i + 1] === '<' && command[i + 2] === '<') {
      // `<<<`: an input here-string. Its word is not an argument.
      endWord(i)
      pendingRedirect = { pos: offset + i, append: false, output: false }
      i += 2
      continue
    }
    // An unquoted `#` at the start of a word: bash would start a comment, and
    // our lexer cannot know where the comment's text came from → quote-blind
    // for the whole command (R1d).
    if (ch === '#') {
      if (atWordStart()) {
        if (lineComments && (i === 0 || /[\s;|&()]/.test(command[i - 1]))) {
          // A comment runs to the end of the line and is never command text:
          // its quotes, `>`s and `cd`s do not exist for the shell. The newline
          // itself is left to the separator branch.
          endWord(i)
          let end = i
          while (end < command.length && command[end] !== '\n' && command[end] !== '\r') end++
          i = end - 1
          continue
        }
        balanced = false
      }
      cur(i).text += ch
      outsideChars++
      continue
    }
    if (ch === '\\') {
      const next = command[i + 1]
      // Same rule out of quotes: `D:\work\app` keeps its separators, `\ ` still
      // escapes a space. A Windows path is the commoner case on this host.
      if (next !== undefined && /["'\\ $`;|&<>()]/.test(next)) {
        cur(i).text += next
        i++
      } else cur(i).text += ch
      outsideChars++
      continue
    }
    // `${NAME}` is parameter expansion, not a brace group: keep it in the word.
    if (ch === '$' && command[i + 1] === '{') {
      cur(i).text += '${'
      outsideChars++
      i++
      paramBraces++
      continue
    }
    if (ch === '}' && paramBraces > 0) {
      cur(i).text += '}'
      outsideChars++
      paramBraces--
      continue
    }
    if (ch === ' ' || ch === '\t') {
      endWord(i)
      continue
    }
    if (ch === '>' || ch === '<' || (ch === '&' && command[i + 1] === '>')) {
      // A file-descriptor prefix (`2>`, `*>`), or `&>` itself: never a word.
      if ((ch === '>' || ch === '<') && isFdPrefixAt(i)) dropWord()
      endWord(i)
      const op = readRedirectOperator(command, i)
      if (op) {
        i = op.end - 1
        if (op.dup) continue
        pendingRedirect = {
          pos: offset + (ch === '&' ? i - 1 : i),
          append: op.append,
          output: op.output
        }
        continue
      }
      continue
    }
    if (ch === '&' && command[i + 1] === '&') {
      endSegment(i, '&&')
      i++
      segStart = i + 1
      segDepth = depth
      continue
    }
    if (ch === '|' && command[i + 1] === '|') {
      endSegment(i, '||')
      i++
      segStart = i + 1
      segDepth = depth
      continue
    }
    if (SEGMENT_BREAKS.has(ch)) {
      const op: SegmentOp = ch === '\n' || ch === '\r' ? '\n' : (ch as SegmentOp)
      if (CLOSE_GROUPS.has(ch) && depth === 0 && quotedWordEndsHere()) balanced = false
      endSegment(i, op)
      if (OPEN_GROUPS.has(ch)) depth++
      else if (CLOSE_GROUPS.has(ch)) depth = Math.max(0, depth - 1)
      segStart = i + 1
      segDepth = depth
      if (ch === '\n' && pending.length > 0) {
        // The heredoc bodies follow this newline and are not command text.
        let lineStart = i + 1
        for (const h of pending) {
          const body = readHeredocBody(command, lineStart, h.delim, h.stripTabs)
          bodies.push({
            start: offset + lineStart,
            end: offset + body.bodyEnd,
            quoted: h.quoted
          })
          if (!body.terminated) balanced = false
          lineStart = body.next
        }
        pending = []
        i = lineStart - 1
        segStart = lineStart
        segDepth = depth
      }
      continue
    }
    cur(i).text += ch
  }

  if (state !== 'out') balanced = false // unbalanced quote — read nothing as inert
  if (pending.length > 0) balanced = false // unterminated heredoc
  endSegment(command.length, null)
  return {
    segments,
    redirects,
    bodies,
    balanced,
    start: offset,
    end: offset + command.length,
    nested
  }
}

/**
 * One redirect operator starting at `i`: its end, whether it appends, whether it
 * writes a file at all (input redirects do not), and whether it only duplicates
 * a file descriptor (`2>&1`, `>&2`, `2>&-`).
 */
function readRedirectOperator(
  command: string,
  i: number
): { end: number; append: boolean; output: boolean; dup: boolean } | null {
  const ch = command[i]
  if (ch === '<') {
    let j = i + 1
    if (command[j] === '&') {
      // `<&3` is a duplication of an fd, not a file.
      j++
      while (/[\d-]/.test(command[j] ?? '')) j++
      return { end: j, append: false, output: false, dup: true }
    }
    return { end: j, append: false, output: false, dup: false }
  }
  if (ch !== '>' && !(ch === '&' && command[i + 1] === '>')) return null
  let j = ch === '&' ? i + 2 : i + 1
  let append = false
  if (command[j] === '>') {
    append = true
    j++
  }
  if (command[j] === '|') j++ // `>|` — the noclobber override, a truncating write
  let amp = false
  if (command[j] === '&') {
    amp = true
    j++
  }
  if (amp) {
    const rest = command.slice(j)
    const dup = /^(\d+|-)(?=[\s;|&<>)]|$)/.exec(rest)
    // `>& all.log` is csh's redirect-both-to-a-file; `>&1` / `>&-` is a dup.
    if (dup) return { end: j + dup[0].length, append, output: true, dup: true }
  }
  return { end: j, append, output: true, dup: false }
}

/** `<<WORD`, `<<-WORD`, `<<'WORD'`, `<<"WORD"`, `<<\WORD`. */
function readHeredocDelimiter(
  command: string,
  from: number
): { delim: string; quoted: boolean; stripTabs: boolean; end: number } | null {
  let i = from
  const stripTabs = command[i] === '-'
  if (stripTabs) i++
  while (command[i] === ' ' || command[i] === '\t') i++
  const open = command[i]
  if (open === "'" || open === '"') {
    const close = command.indexOf(open, i + 1)
    if (close === -1) return null
    const delim = command.slice(i + 1, close)
    return delim.length > 0 ? { delim, quoted: true, stripTabs, end: close + 1 } : null
  }
  let end = i
  while (end < command.length && !/[\s;|&<>(){}]/.test(command[end])) end++
  let delim = command.slice(i, end)
  if (delim.length === 0) return null
  const quoted = delim.startsWith('\\')
  if (quoted) delim = delim.slice(1)
  return { delim, quoted, stripTabs, end }
}

/** The body lines up to (not including) the delimiter line. */
function readHeredocBody(
  command: string,
  from: number,
  delim: string,
  stripTabs: boolean
): { bodyEnd: number; next: number; terminated: boolean } {
  let p = from
  while (p <= command.length) {
    const nl = command.indexOf('\n', p)
    const lineEnd = nl === -1 ? command.length : nl
    let line = command.slice(p, lineEnd)
    if (line.endsWith('\r')) line = line.slice(0, -1)
    if (stripTabs) line = line.replace(/^\t+/, '')
    if (line === delim)
      return { bodyEnd: p, next: nl === -1 ? command.length : nl + 1, terminated: true }
    if (nl === -1) break
    p = nl + 1
  }
  return { bodyEnd: command.length, next: command.length, terminated: false }
}

/**
 * The names a command word could read as. `s\h` is `sh` to bash (the backslash
 * escapes an ordinary character) but `h` to a Windows path splitter, and the
 * re-reader check must see the shell reading (ruling 2).
 */
function commandNames(text: string): string[] {
  const names = [executableName(text)]
  if (text.includes('\\')) {
    const removed = text.replace(/\\(?![\\/])/g, '')
    if (removed !== text) names.push(executableName(removed))
  }
  return names
}

/** True when the word itself expands into the command to run (`$VAR`, `$(…)`, a backtick). */
function isExpansionWord(word: LexWord): boolean {
  const text = word.text
  return text.startsWith('$') || text.startsWith('`') || text.includes('$(') || text.includes('`')
}

/**
 * A quoted span's content is inert only when both dialects provably read it as
 * text (ruling 1): no `$(`, no backtick, no `\"` and no `""`.
 */
function dqSpanIsText(span: { start: number; end: number }, command: string): boolean {
  const text = command.slice(span.start, span.end)
  return (
    !text.includes('$(') && !text.includes('`') && !text.includes('\\"') && !text.includes('""')
  )
}

/** True when `pos` lies inside any of the sorted, non-overlapping `ranges`. */
function covers(ranges: ReadonlyArray<[number, number]>, pos: number): boolean {
  let lo = 0
  let hi = ranges.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const [s, e] = ranges[mid]
    if (pos < s) hi = mid - 1
    else if (pos >= e) lo = mid + 1
    else return true
  }
  return false
}

/** True when `[start, end)` lies wholly inside one inert range. */
function coveredRange(
  ranges: ReadonlyArray<[number, number]>,
  start: number,
  end: number
): boolean {
  return !covers(ranges, start) ? false : covers(ranges, Math.max(start, end - 1))
}

/**
 * The `[start, end)` ranges the redirect scan must NOT read as shell.
 *
 * Nothing is inert when ANY command word in the command is a
 * {@link SHELL_REREADERS} word (`echo 'x > /etc/p' | sh`, `bash -c "make > /etc/p"`,
 * awk's own `>`), when a command word is itself an expansion (`| $SHELL`), when
 * `bun exec`/`bun x` re-reads its argument, or when `sed`/`gsed` is given an `e`
 * command / `s///e` flag.
 *
 * Otherwise, in a segment whose text both dialects read as text (a
 * {@link INERT_QUOTE_COMMANDS} head, a segment containing a
 * {@link LANGUAGE_INTERPRETERS} word, or a segment that is one quoted string):
 *  - single-quoted spans are inert;
 *  - a double-quoted span is inert ONLY when the word is that one quoted span
 *    and its text holds no `$(`, backtick, `\"` or `""` — anything else is
 *    scanned quote-blind (ruling 1);
 *  - a heredoc body is inert when its delimiter was quoted, or when the body
 *    holds no `$(` and no backtick; otherwise it is scanned as command text.
 */
function inertRanges(command: string, lexed: LexedCommand): Array<[number, number]> {
  if (!lexed.balanced) return []
  if (hasReReader(lexed)) return []

  const out: Array<[number, number]> = []
  for (const seg of lexed.segments) {
    if (!segmentIsText(seg, command)) continue
    for (const w of seg.words) {
      for (const span of w.spans) {
        if (span.quote === "'") {
          out.push([span.start, span.end])
          continue
        }
        if (!w.fullyQuoted) continue
        if (!dqSpanIsText(span, command)) continue
        out.push([span.start, span.end])
      }
    }
  }
  for (const body of lexed.bodies) {
    if (body.end <= body.start) continue
    if (body.quoted) {
      out.push([body.start, body.end])
      continue
    }
    const text = command.slice(body.start, body.end)
    if (!text.includes('$(') && !text.includes('`')) out.push([body.start, body.end])
  }
  return mergeRanges(out)
}

/** Merge overlapping/adjacent ranges and sort them (the cursor walk needs order). */
function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  const sorted = ranges.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = []
  for (const [s, e] of sorted) {
    const last = merged[merged.length - 1]
    if (last && s <= last[1]) last[1] = Math.max(last[1], e)
    else merged.push([s, e])
  }
  return merged
}

/** Which segment heads read every quoted argument as literal text. */
function segmentIsText(seg: LexSegment, command: string): boolean {
  const at = commandWordAt(seg)
  if (at === -1) return false
  const head = executableName(seg.words[at].text)
  if (INERT_QUOTE_COMMANDS.has(head)) return true
  if (seg.words.some((w) => LANGUAGE_INTERPRETERS.has(executableName(w.text)))) return true
  const meaningful = seg.words.filter((w) => !w.redirected && !isAssignmentWord(w.text))
  if (meaningful.length === 1 && meaningful[0].fullyQuoted) {
    // A segment that is nothing but one quoted string (`"$n => $hit"`), and the
    // quoted string is not itself live shell.
    const span = meaningful[0].spans[0]
    return span !== undefined && span.quote === "'" ? true : dqSpanIsText(span, command)
  }
  return false
}

/** True when any command word in the command re-reads text as shell (ruling 2). */
function hasReReader(lexed: LexedCommand): boolean {
  for (const seg of lexed.segments) {
    const at = commandWordAt(seg)
    if (at === -1) continue
    const word = seg.words[at]
    // A segment that is nothing but ONE quoted string is an expression, not an
    // invocation (`"$n => $hit"`), unless the string itself substitutes a
    // command (`"$(echo sh)"`).
    const soleText =
      seg.words.filter((w) => !w.redirected).length === 1 &&
      word.fullyQuoted &&
      !word.text.includes('$(') &&
      !word.text.includes('`')
    if (!soleText && isExpansionWord(word) && seg.depth === 0) return true
    const names = commandNames(word.text)
    if (names.some((n) => SHELL_REREADERS.has(n))) return true
    if (names.includes('bun')) {
      // `bun exec '…'` / `bun x '…'` hand the argument to a command runner.
      const next = seg.words.slice(at + 1).find((w) => !w.redirected && !w.text.startsWith('-'))
      const sub = next ? executableName(next.text) : ''
      if (sub === 'exec' || sub === 'x') return true
    }
    const sedLike = names.some((n) => n === 'sed' || n === 'gsed')
    if (sedLike && seg.words.slice(at + 1).some((w) => sedScriptRunsCommand(w.text))) return true
  }
  return false
}

/**
 * `sed`'s `e` command or an `s///e` flag runs a shell (ruling 2). Conservative on
 * purpose: a false match only makes the scan quote-blind.
 */
function sedScriptRunsCommand(script: string): boolean {
  // An `e` command: at the start, after `;{}`, whitespace, a digit, `$` or `/`,
  // and terminated by whitespace, `;` or end.
  if (/(^|[;{}\s\d$/])e(?=[\s;]|$)/.test(script)) return true
  for (let i = 0; i < script.length; i++) {
    if (script[i] !== 's') continue
    const delim = script[i + 1]
    if (delim === undefined || /[A-Za-z0-9\\]/.test(delim)) continue
    const second = script.indexOf(delim, i + 2)
    if (second === -1) continue
    const third = script.indexOf(delim, second + 1)
    if (third === -1) continue
    const flags = /^[A-Za-z]*/.exec(script.slice(third + 1))
    if (flags && flags[0].includes('e')) return true
  }
  return false
}

// ── Redirect targets ──────────────────────────────────────────────────────────

/** One file target named by a redirect operator or a writer command. */
interface RawTarget {
  /** As written, quotes stripped; `''` when the target could not be read. */
  raw: string
  append: boolean
  /** Where in the command this target was named (for the cd/temp walk). */
  pos: number
  /** True when the operator/flags named no readable word at all. */
  unreadable?: boolean
  /** True when the word carried a quoted span, so bash removed no backslash from it. */
  quoted?: boolean
  /**
   * True when the leading text came from a spelling the shell takes LITERALLY
   * (single quotes, or an escaped `$`). The optional temp hint must be withheld
   * then: the command's variable is never expanded. Computed from the word's
   * source position, never from the redirect operator.
   */
  hintLiteral?: boolean
  /**
   * Set only on a quote-hidden token ({@link quoteHiddenTargets}) that is read as
   * a literal relative NAME in the shell's directory although it carries glob
   * characters: `list[int]:` from `def f() -> list[int]:`, `**Note**` from a
   * markdown `> **Note**`. {@link resolveOneTarget} then skips the "glob =
   * unresolvable" step for it. See {@link isPhantomLiteralName} for the rule.
   */
  literalName?: true
}

/**
 * Is the text starting at `start` a literal spelling of its leading `$…`
 * reference … single-quoted, backslash-escaped (POSIX) or backtick-escaped
 * (PowerShell, including inside double quotes)? The hint is optional, so an
 * unknown spelling withholds it rather than guessing expansion.
 */
function leadingReferenceIsLiteral(command: string, start: number, raw: string): boolean {
  let quote: "'" | '"' | null = null
  for (let i = start; i < command.length && i < start + 512; i++) {
    const ch = command[i]
    if (quote === "'") {
      if (ch === "'") quote = null
      else if (ch === '$') return true
      continue
    }
    if (quote === '"') {
      if ((ch === '\\' || ch === '`') && command[i + 1] === '$') return true
      if (ch === '\\' || ch === '`') {
        i++
        continue
      }
      if (ch === '"') quote = null
      else if (ch === '$') return !sourceRefMatches(command, i, raw)
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (ch === '\\' || ch === '`') {
      if (command[i + 1] === '$') return true
      i++
      continue
    }
    if (ch === '$') {
      // `$'…'` and `$"…"` are literals, not variable expansions.
      if (command[i + 1] === "'" || command[i + 1] === '"') return true
      return !sourceRefMatches(command, i, raw)
    }
  }
  return true
}

/** Parse the leading `$…` reference of a raw target/value, or null. */
function leadingRawRef(raw: string): string | null {
  if (raw.startsWith('${')) {
    const close = raw.indexOf('}')
    return close === -1 ? null : raw.slice(0, close + 1)
  }
  const m = /^\$[A-Za-z_][A-Za-z0-9_:]*/.exec(raw)
  return m ? m[0] : null
}

/** Does the source `$…` at `at` spell exactly the reference the raw target leads with? */
function sourceRefMatches(command: string, at: number, raw: string): boolean {
  if (command[at] !== '$') return false
  let end = at + 1
  if (command[end] === '{') {
    const close = command.indexOf('}', end + 1)
    if (close === -1) return false
    end = close + 1
  } else {
    const m = /^[A-Za-z_][A-Za-z0-9_:]*/.exec(command.slice(at + 1))
    if (!m) return false
    end = at + 1 + m[0].length
  }
  const sourceRef = command.slice(at, end)
  const rawRef = leadingRawRef(raw)
  return rawRef !== null && rawRef === sourceRef
}

/** Everything one command's text yields: targets, segments, and dir-change regions. */
interface Collected {
  targets: RawTarget[]
  /** Segments from every nesting level, in document order, for writer detection. */
  segments: LexSegment[]
  /** Ranges where a nested `cd` makes a relative target unknowable. */
  dirRegions: Array<[number, number]>
}

/**
 * Collect every target and segment from `lexed` and, recursively, from the
 * quoted spans and heredoc bodies that are NOT inert. Non-inert text is re-lexed
 * as command text — that is how a real redirect (or a `tee`) inside
 * `echo "$(date > /etc/p)"`, `sh -c 'date | tee /etc/p'` or an unquoted heredoc
 * is found. Bounded by {@link MAX_NESTING} and {@link MAX_ANALYZE_COMMAND_LENGTH}.
 */
function collectTargets(full: string, lexed: LexedCommand): Collected {
  const collected: Collected = { targets: [], segments: [], dirRegions: [] }

  const visit = (node: LexedCommand, level: number, targetsHere: boolean): void => {
    const inert = node.balanced ? inertRanges(full, node) : []
    if (targetsHere) {
      if (!node.balanced) {
        collected.targets.push(...charTargets(full, node.start, node.end))
      } else {
        for (const r of node.redirects) {
          if (!r.output) continue
          // A `\` right before a newline is bash's line continuation: the target
          // continues on the next line, which we did not read → unresolvable
          // (C-B).
          const continued =
            r.word !== undefined &&
            full[r.word.end - 1] === '\\' &&
            (full[r.word.end] === '\n' || full[r.word.end] === '\r')
          collected.targets.push({
            raw: r.word ? r.word.text : '',
            append: r.append,
            pos: r.pos,
            ...(r.word ? { quoted: r.word.spans.length > 0 } : { unreadable: true }),
            ...(r.word
              ? { hintLiteral: leadingReferenceIsLiteral(full, r.word.start, r.word.text) }
              : {}),
            ...(continued ? { unreadable: true } : {})
          })
        }
      }
    }
    collected.segments.push(...node.segments)
    if (node.nested && hasDirWord(full.slice(node.start, node.end))) {
      collected.dirRegions.push([node.start, node.end])
    }
    if (level >= MAX_NESTING) return
    // A non-inert quoted span / heredoc body is command text: read it as such.
    const regions: Array<[number, number]> = []
    for (const seg of node.segments) {
      for (const w of seg.words) for (const span of w.spans) regions.push([span.start, span.end])
    }
    for (const body of node.bodies) regions.push([body.start, body.end])
    for (const [start, end] of regions) {
      if (end <= start) continue
      if (coveredRange(inert, start, end)) continue
      const sub = lexCommand(full.slice(start, end), start, true)
      // Inside an unbalanced parent the char scan already covered every `>`;
      // the nested visit is still worth it for WRITER commands (`tee`) only.
      visit(sub, level + 1, node.balanced)
    }
  }

  visit(lexed, 0, true)
  return collected
}

/**
 * Quote-blind target extraction for a range, used exactly when the lexer cannot
 * trust its own quote structure (unbalanced quote, unterminated heredoc,
 * PowerShell here-string, `#` comment). Handles `>`, `>>`, `>|`, `N>`, `N>>`,
 * `*>`, `&>`, `&>>`, `>&file`, `>>&file`; fd duplications are dropped.
 */
function charTargets(command: string, from: number, to: number): RawTarget[] {
  const out: RawTarget[] = []
  let i = from
  while (i < to) {
    const ch = command[i]
    if (ch !== '>' && !(ch === '&' && command[i + 1] === '>')) {
      i++
      continue
    }
    const read = readCharTarget(command, i, to)
    if (read.target !== undefined) out.push(read.target)
    i = read.next
  }
  return out
}

/**
 * ONE quote-blind operator read at `at` (a `>` or the `&` of `&>`): its target
 * (absent for a file-descriptor duplication such as `2>&1`) and the index where
 * a scan resumes. {@link charTargets} loops over it; the quote-blind cross-check
 * ({@link quoteHiddenTargets}) calls it per `>` so that one operator's quoted
 * target can never swallow the operators after it.
 */
function readCharTarget(
  command: string,
  at: number,
  to: number,
  swallowUnclosed = true
): { target?: RawTarget; next: number } {
  let i = at
  if (command[i] === '&') i++
  i++
  let append = false
  if (command[i] === '>') {
    append = true
    i++
  }
  if (command[i] === '|') i++
  let sawAmpersand = false
  if (command[i] === '&') {
    sawAmpersand = true
    i++
  }
  while (i < to && (command[i] === ' ' || command[i] === '\t')) i++
  let raw: string
  let quote = command[i]
  if (quote === '"' || quote === "'") {
    const end = command.indexOf(quote, i + 1)
    if (end !== -1 && end < to) {
      raw = command.slice(i + 1, end)
      i = end + 1
    } else if (swallowUnclosed) {
      raw = command.slice(i + 1, to)
      i = to
    } else {
      // A quote that never closes is as likely the CLOSING quote of the text this
      // `>` sits in (`grep '>' $F`) as an opening one: read the token after it
      // instead of swallowing the rest of the command.
      i++
      const start = i
      while (i < to && !TARGET_END.has(command[i])) i++
      raw = command.slice(start, i)
      quote = ''
    }
  } else {
    const start = i
    while (i < to && !TARGET_END.has(command[i])) i++
    raw = command.slice(start, i)
  }
  // `>&1`, `2>&-` — a duplication of a file descriptor, not a file.
  if (sawAmpersand && /^\d*-?$/.test(raw)) return { next: i }
  return {
    target: {
      raw,
      append,
      pos: at,
      ...(quote === '"' || quote === "'" ? { quoted: true } : {}),
      // The spelling's absolute start is not retained here; withhold the hint.
      hintLiteral: true
    },
    next: i
  }
}

/**
 * How many `>` operators the quote-blind cross-check will read that the
 * quote-aware scan did not before the whole analysis says nothing (the safe
 * fallback, exactly like {@link MAX_REDIRECT_TARGETS}). Bounds the one place a
 * 64 KB command could otherwise cost quadratic `indexOf` work.
 */
const MAX_HIDDEN_OPERATORS = 2048

/**
 * How many DISTINCT (spelling, shell state) readings of those the cross-check
 * will resolve before it gives up the same way.
 */
const MAX_HIDDEN_KEYS = 512

/** How much of a quote-hidden spelling `quotedTargets` shows (a swallowed quote
 *  can make one `raw` the whole rest of a 64 KB command). */
const MAX_QUOTED_RAW_LENGTH = 200

/**
 * The QUOTE-BLIND CROSS-CHECK (ADR-106 addendum). The quote-aware scan
 * ({@link inertRanges}) reads `>` inside quoted text as text, which is what
 * stops phantom targets — and also what hides a real write whenever the lexer
 * is wrong about the quote structure or the text is re-read as shell by a
 * mechanism it does not know (`echo "$(echo "a " > /etc/p)"`, `… | "$BASH"`,
 * `find -exec sh -c '… > f' \;`, `& ([scriptblock]::Create('… > f'))`). So every
 * `>` operator in the command text is also read WITHOUT any quote awareness (the
 * pre-ADR-106 behaviour), and the ones the quote-aware scan did not already
 * report are returned here. The caller resolves them like any target and keeps
 * only those that are not cleanly in scope.
 *
 * "Already reported" is decided by operator position, not by spelling: the
 * lexer's position for `>>`/`>|`/`&>>` sits up to two characters after the
 * scanner's own start. Each `>` is read on its own ({@link readCharTarget}), so
 * a quoted target that never closes cannot swallow the operators after it.
 *
 * `null` when more than {@link MAX_HIDDEN_OPERATORS} operators are unreported.
 */
function quoteHiddenTargets(command: string, aware: readonly RawTarget[]): RawTarget[] | null {
  const known = new Set<number>()
  for (const target of aware) known.add(target.pos)
  const operatorChar = (ch: string | undefined): boolean => ch === '>' || ch === '|' || ch === '&'
  const out: RawTarget[] = []
  let examined = 0
  for (let i = command.indexOf('>'); i !== -1; i = command.indexOf('>', i + 1)) {
    // The second `>` of `>>` belongs to the operator read from the first.
    if (command[i - 1] === '>') continue
    const at = command[i - 1] === '&' ? i - 1 : i
    const covered =
      known.has(at) ||
      (operatorChar(command[at + 1]) &&
        (known.has(at + 1) || (operatorChar(command[at + 2]) && known.has(at + 2))))
    if (covered) continue
    if (++examined > MAX_HIDDEN_OPERATORS) return null
    const read = readCharTarget(command, at, command.length, false)
    let target = read.target
    if (target === undefined) continue
    if (target.quoted !== true) {
      // The text would be re-read as shell, which removes the quotes (and an
      // escaped closing quote's backslash): `echo 'x > .bashrc'` names `.bashrc`,
      // not `.bashrc'` — a stray quote must never hide a protected component.
      let raw = target.raw.replace(/["']/g, '').replace(/\\+$/, '')
      // A closer with no opener in the token is code (`rows if x>1]`, `a => {}`),
      // not a glob; dropping it only removes characters from the LAST component.
      while (/\]$/.test(raw) && countOf(raw, '[') < countOf(raw, ']')) raw = raw.slice(0, -1)
      while (/\}$/.test(raw) && countOf(raw, '{') < countOf(raw, '}')) raw = raw.slice(0, -1)
      if (raw !== target.raw) target = { ...target, raw }
    }
    // A token made only of brackets (`=> {`, `-> []`) is no glob: it names a
    // literal file in the shell's directory, which is code text, not a write.
    if (target.quoted !== true && /^[[\]{}]+$/.test(target.raw)) continue
    if (target.raw.trim().length === 0) continue
    // Code and prose carry glob characters (`list[int]:`, `**Note**`): such a token
    // is read as a literal relative name, and so drops out when its directory is in
    // scope — unless the glob could name a protected or agent-control file.
    out.push(isPhantomLiteralName(target.raw) ? { ...target, literalName: true } : target)
  }
  return out
}

/** The names a hidden glob must never be able to match: the protected components
 *  and the agent-control directories and files, plus the `.env` family's stem. */
const PROTECTED_GLOB_NAMES: readonly string[] = [
  ...PROTECTED_COMPONENTS,
  ...AGENT_CONTROL_DIRS,
  ...AGENT_CONTROL_FILES,
  '.env'
]

/**
 * Compile a shell glob (`*`, `?`, `[...]`, `{a,b}`) to an anchored,
 * case-insensitive regular expression, or `null` when it cannot be read
 * (unbalanced braces, an invalid class). A `/` never appears here (the caller
 * rejects it), so `*` may match anything.
 */
function globToRegExp(glob: string): RegExp | null {
  let source = ''
  let braces = 0
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '*') {
      source += '.*'
    } else if (ch === '?') {
      source += '.'
    } else if (ch === '[') {
      let j = i + 1
      if (glob[j] === '!' || glob[j] === '^') j++
      if (glob[j] === ']') j++
      while (j < glob.length && glob[j] !== ']') j++
      if (j >= glob.length) {
        source += '\\['
        continue
      }
      let body = glob.slice(i + 1, j)
      const negated = body.startsWith('!') || body.startsWith('^')
      if (negated) body = body.slice(1)
      source += `[${negated ? '^' : ''}${body.replace(/[\\\]^]/g, '\\$&')}]`
      i = j
    } else if (ch === '{') {
      braces++
      source += '(?:'
    } else if (ch === '}' && braces > 0) {
      braces--
      source += ')'
    } else if (ch === ',' && braces > 0) {
      source += '|'
    } else {
      source += ch.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')
    }
  }
  if (braces !== 0) return null
  try {
    return new RegExp(`^(?:${source})$`, 'i')
  } catch {
    return null
  }
}

/**
 * True when a quote-hidden token is a PHANTOM: code or prose text a quoted
 * heredoc / string left after a `>` (`def f() -> list[int]:`, a markdown
 * `> **Note**`), which is read as a literal relative name in the shell's directory
 * rather than as a glob it cannot resolve.
 *
 * Only when the token cannot be a path or an expansion — no `/`, `\`, `$`,
 * backtick, `~` or `%`, and no leading `.` — AND its glob cannot match any
 * protected or agent-control name (`.bash*`, `CLAUDE.m?` and `*` can, so they stay
 * named in `quotedTargets`). Real targets never come through here.
 */
function isPhantomLiteralName(raw: string): boolean {
  if (/[/\\$`~%]/.test(raw) || raw.startsWith('.')) return false
  if (!UNRESOLVABLE_CHARS.test(raw)) return false
  const matcher = globToRegExp(raw)
  if (matcher === null) return false
  return !PROTECTED_GLOB_NAMES.some((name) => matcher.test(name))
}

/** How many times `ch` occurs in `text`. */
function countOf(text: string, ch: string): number {
  let n = 0
  for (let i = text.indexOf(ch); i !== -1; i = text.indexOf(ch, i + 1)) n++
  return n
}

/** Every dir-changing word, one match each (no boundary characters consumed). */
const DIR_WORD_EACH =
  /(?<![A-Za-z0-9_-])(?:cd|chdir|pushd|popd|set-location|sl|push-location|pop-location)(?![A-Za-z0-9_-])/gi

/**
 * True when the command spells more directory-changing words than its segments
 * run as commands — one of them sits in quoted text the shell-state walk never
 * reads (`sh -c 'cd /etc; echo x > passwd'`). A quote-hidden RELATIVE target is
 * then unknowable, whatever the walk says the directory is.
 */
function hasHiddenDirWord(command: string, segments: readonly LexSegment[]): boolean {
  const spelled = [...command.matchAll(DIR_WORD_EACH)].length
  if (spelled === 0) return false
  let run = 0
  for (const seg of segments) {
    const at = commandWordAt(seg, false)
    if (at === -1) continue
    if (commandNames(seg.words[at].text).some((n) => DIR_COMMANDS.has(n) || DIR_POISON.has(n))) {
      run++
    }
  }
  return spelled > run
}

/** A resolved target that is certainly inside a scope root, unprotected and measurable. */
function isCleanInScope(detail: RedirectTargetDetail): boolean {
  return (
    detail.path !== undefined &&
    detail.root !== undefined &&
    detail.protectedHits.length === 0 &&
    detail.reviewRequired !== true &&
    detail.shellDrive !== null
  )
}

/** Wrappers whose own name is not the command (`sudo tee`, `env -i tee`). */
const COMMAND_WRAPPERS: ReadonlySet<string> = new Set([
  'sudo',
  'doas',
  'env',
  'command',
  'exec',
  'nohup',
  'time',
  'nice',
  'timeout',
  'stdbuf',
  'ionice',
  'setsid',
  'chrt',
  'taskset',
  'busybox',
  'builtin',
  'xargs'
])

/**
 * The options of the wrappers whose flags are modelled strictly: an option that
 * is not listed here makes the wrapped command's identity a guess, so a writer
 * behind it is reported unreadable instead (see {@link commandWordInfo}).
 * `sudo`/`env`/`timeout`/… keep the older lenient skipping above.
 */
interface WrapperSpec {
  /** Single-letter options that take no value. */
  flags?: string
  /** Single-letter options whose value is attached (`-oL`) or the next word. */
  valueFlags?: string
  /** Single-letter options with an optional, attached-only value (`-i[STR]`). */
  optionalFlags?: string
  /** Long options that take no value. */
  long?: readonly string[]
  /** Long options whose value is `=…` or the next word. */
  longValue?: readonly string[]
  /** Positional words that precede the command (`chrt 10 cmd`, `taskset 0x1 cmd`). */
  positionals?: number
  /** `-5` is a numeric option (`nice -5 cmd`). */
  numeric?: boolean
}

const STRICT_WRAPPERS: ReadonlyMap<string, WrapperSpec> = new Map([
  [
    'stdbuf',
    {
      valueFlags: 'ioe',
      long: ['--help', '--version'],
      longValue: ['--input', '--output', '--error']
    }
  ],
  [
    'ionice',
    {
      flags: 't',
      valueFlags: 'cnpPu',
      long: ['--ignore', '--help', '--version'],
      longValue: ['--class', '--classdata', '--pid', '--pgid', '--uid']
    }
  ],
  ['nice', { valueFlags: 'n', numeric: true, longValue: ['--adjustment'], long: ['--help'] }],
  ['setsid', { flags: 'cfwhV', long: ['--ctty', '--fork', '--wait', '--help', '--version'] }],
  [
    'chrt',
    {
      flags: 'bfiordRavh',
      valueFlags: 'm',
      long: [
        '--batch',
        '--fifo',
        '--idle',
        '--other',
        '--rr',
        '--deadline',
        '--reset-on-fork',
        '--verbose',
        '--max',
        '--help'
      ],
      positionals: 1
    }
  ],
  [
    'taskset',
    { flags: 'cahV', long: ['--cpu-list', '--all-tasks', '--help', '--version'], positionals: 1 }
  ],
  ['busybox', { long: ['--list', '--help'] }],
  ['builtin', {}],
  [
    'xargs',
    {
      flags: '0oprtxh',
      valueFlags: 'adEILnPs',
      optionalFlags: 'eil',
      long: [
        '--null',
        '--open-tty',
        '--interactive',
        '--no-run-if-empty',
        '--verbose',
        '--exit',
        '--help',
        '--version',
        '--show-limits'
      ],
      longValue: [
        '--arg-file',
        '--delimiter',
        '--eof',
        '--replace',
        '--max-lines',
        '--max-args',
        '--max-procs',
        '--max-chars',
        '--process-slot-var'
      ]
    }
  ]
])

/** Reserved words that may precede the command word of a segment. */
const COMMAND_KEYWORDS: ReadonlySet<string> = new Set([
  'then',
  'do',
  'else',
  'elif',
  'if',
  'while',
  'until',
  '!',
  '{',
  'time'
])
/** Wrapper options that consume the NEXT token (`sudo -u root`, `nice -n 5`). */
const WRAPPER_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-u',
  '--user',
  '-g',
  '--group',
  '-n',
  '--adjustment',
  '-s',
  '--signal',
  '-k',
  '--kill-after'
])

/** PowerShell cmdlets/aliases that write a file through an argument. */
const PS_WRITE_CMDLETS: ReadonlySet<string> = new Set([
  'out-file',
  'set-content',
  'add-content',
  'tee-object',
  'export-csv',
  'epcsv',
  'ac'
])
const PS_ALWAYS_APPEND: ReadonlySet<string> = new Set(['add-content', 'ac'])
/** The cmdlet an alias stands for, where the parameter tables are keyed by cmdlet. */
const PS_CMDLET_ALIASES: ReadonlyMap<string, string> = new Map([
  ['ac', 'add-content'],
  ['epcsv', 'export-csv']
])

type PsParamKind = 'path' | 'switch' | 'value'

interface PsParam {
  /** Lower-case full name. */
  name: string
  /** Lower-case aliases (`-ea`, `-PSPath`). */
  aliases: readonly string[]
  /** `path`: names the written file; `switch`: no value; `value`: takes one. */
  kind: PsParamKind
}

const psParam = (name: string, kind: PsParamKind, ...aliases: string[]): PsParam => ({
  name: name.toLowerCase(),
  aliases: aliases.map((alias) => alias.toLowerCase()),
  kind
})

/** The common parameters of every cmdlet (`about_CommonParameters`). */
const PS_COMMON_PARAMS: readonly PsParam[] = [
  psParam('Verbose', 'switch', 'vb'),
  psParam('Debug', 'switch', 'db'),
  psParam('WhatIf', 'switch', 'wi'),
  psParam('Confirm', 'switch', 'cf'),
  psParam('ErrorAction', 'value', 'ea'),
  psParam('WarningAction', 'value', 'wa'),
  psParam('InformationAction', 'value', 'infa', 'ia'),
  psParam('ErrorVariable', 'value', 'ev'),
  psParam('WarningVariable', 'value', 'wv'),
  psParam('InformationVariable', 'value', 'iv', 'infv'),
  psParam('OutVariable', 'value', 'ov'),
  psParam('OutBuffer', 'value', 'ob'),
  psParam('PipelineVariable', 'value', 'pv')
]

/** The `Set-Content` / `Add-Content` parameters (the same set). */
const PS_CONTENT_PARAMS: readonly PsParam[] = [
  psParam('Path', 'path'),
  psParam('LiteralPath', 'path', 'PSPath', 'LP'),
  psParam('Value', 'value'),
  psParam('PassThru', 'switch'),
  psParam('Filter', 'value'),
  psParam('Include', 'value'),
  psParam('Exclude', 'value'),
  psParam('Force', 'switch'),
  psParam('Credential', 'value'),
  psParam('NoNewline', 'switch'),
  psParam('Encoding', 'value'),
  psParam('AsByteStream', 'switch'),
  psParam('Stream', 'value')
]

/** Per cmdlet: every parameter it accepts besides the common ones. */
const PS_CMDLET_PARAMS: ReadonlyMap<string, readonly PsParam[]> = new Map([
  [
    'out-file',
    [
      psParam('FilePath', 'path', 'Path'),
      psParam('LiteralPath', 'path', 'PSPath', 'LP'),
      psParam('Encoding', 'value'),
      psParam('Append', 'switch'),
      psParam('Force', 'switch'),
      psParam('NoClobber', 'switch', 'NoOverwrite'),
      psParam('Width', 'value'),
      psParam('NoNewline', 'switch'),
      psParam('InputObject', 'value')
    ]
  ],
  ['set-content', PS_CONTENT_PARAMS],
  ['add-content', PS_CONTENT_PARAMS],
  [
    'tee-object',
    [
      psParam('FilePath', 'path', 'Path'),
      psParam('LiteralPath', 'path', 'PSPath', 'LP'),
      psParam('InputObject', 'value'),
      psParam('Variable', 'value'),
      psParam('Append', 'switch')
    ]
  ],
  [
    'export-csv',
    [
      psParam('Path', 'path'),
      psParam('LiteralPath', 'path', 'PSPath', 'LP'),
      psParam('Delimiter', 'value'),
      psParam('UseCulture', 'switch'),
      psParam('NoTypeInformation', 'switch', 'NTI'),
      psParam('IncludeTypeInformation', 'switch', 'ITI'),
      psParam('Append', 'switch'),
      psParam('Force', 'switch'),
      psParam('NoClobber', 'switch', 'NoOverwrite'),
      psParam('Encoding', 'value'),
      psParam('InputObject', 'value'),
      psParam('QuoteFields', 'value'),
      psParam('UseQuotes', 'value')
    ]
  ]
])

/**
 * The parameter a PowerShell flag names for `cmdlet`: an exact name or alias, else
 * the ONE parameter whose name or alias it abbreviates. `null` for an unknown or
 * ambiguous flag — PowerShell would refuse the call, but the caller must not
 * assume that: an unrecognised flag makes the written path unreadable, never a
 * guess (`-ErrorAction Stop` must not turn `Stop` into the file).
 */
function resolvePsParam(cmdlet: string, flagName: string): PsParam | null {
  const want = flagName.toLowerCase()
  if (want.length === 0) return null
  const table = [...(PS_CMDLET_PARAMS.get(cmdlet) ?? []), ...PS_COMMON_PARAMS]
  const exact = table.find((p) => p.name === want || p.aliases.includes(want))
  if (exact !== undefined) return exact
  const hits = table.filter(
    (p) => p.name.startsWith(want) || p.aliases.some((alias) => alias.startsWith(want))
  )
  return hits.length === 1 ? hits[0] : null
}

/** PowerShell treats the en dash, em dash and horizontal bar as a parameter dash. */
const PS_FLAG_WORD = /^[-–—―][A-Za-z_?]/

/**
 * True when the word is a PowerShell parameter (`-Path`, `-Path:x`, `–Path`): it
 * starts with a dash and a letter, and does not BEGIN inside a quote — `"-Path"`
 * is a string argument, not a parameter.
 */
function isPsFlagWord(word: LexWord): boolean {
  if (!PS_FLAG_WORD.test(word.text)) return false
  return !(word.spans.length > 0 && word.spans[0].start - 1 === word.start)
}

/** True when the word continues a comma list (`a,`) or the next one does (`, b`). */
function continuesList(word: LexWord, next: LexWord | undefined): boolean {
  return word.text.trimEnd().endsWith(',') || next?.text.trimStart().startsWith(',') === true
}

/** Result of reading the words after a (possibly wrapped) command word. */
interface CommandWordInfo {
  /** Index of the command word, `-1` when the segment has none. */
  at: number
  /**
   * A wrapper option was not recognised, so which word is the command is a guess:
   * the caller reports any writer named after the wrapper as unreadable.
   */
  unsure: boolean
  /** Index of the first wrapper word, `-1` when there is none. */
  wrapperAt: number
  /** Index of an `xargs` wrapper (its stdin supplies more file names), or `-1`. */
  xargsAt: number
}

/**
 * Skip a strictly modelled wrapper's options (see {@link STRICT_WRAPPERS}) from
 * `from`. `next` is the index of the wrapped command; `unsure` is true when an
 * option was not in the wrapper's table.
 */
function skipStrictWrapper(
  words: readonly LexWord[],
  from: number,
  spec: WrapperSpec
): { next: number; unsure: boolean } {
  let i = from
  let unsure = false
  const n = words.length
  while (i < n) {
    const word = words[i]
    if (word.redirected) {
      i++
      continue
    }
    const text = word.text
    if (text === '--') {
      i++
      break
    }
    if (text.startsWith('--') && text.length > 2) {
      const eq = text.indexOf('=')
      const name = eq === -1 ? text : text.slice(0, eq)
      i++
      if (spec.long?.includes(name)) continue
      if (spec.longValue?.includes(name)) {
        if (eq === -1) i++
        continue
      }
      unsure = true
      continue
    }
    if (text.startsWith('-') && text.length > 1) {
      i++
      if (spec.numeric === true && /^-\d+$/.test(text)) continue
      let valueNext = false
      for (let k = 1; k < text.length; k++) {
        const ch = text[k]
        if (spec.flags?.includes(ch)) continue
        if (spec.valueFlags?.includes(ch)) {
          valueNext = k === text.length - 1
          break
        }
        if (spec.optionalFlags?.includes(ch)) break
        unsure = true
        break
      }
      if (valueNext) i++
      continue
    }
    break
  }
  for (let p = 0; p < (spec.positionals ?? 0); p++) {
    while (i < n && words[i].redirected) i++
    if (i < n && !words[i].text.startsWith('-')) i++
  }
  return { next: i, unsure }
}

/**
 * A segment's command word: after assignments, reserved words (`then`, `do`,
 * `else`, `elif`, `!`, …), wrappers and options. Reports whether a wrapper's
 * option was unknown (the answer is then a guess) and where an `xargs` sits.
 *
 * `keywords: false` keeps the older reading in which a reserved word IS the
 * command word. Directory tracking uses it: a `cd` behind `do`/`then` sits in a
 * loop or branch body, so it must keep poisoning the shell state instead of being
 * followed as a plain `cd`.
 */
function commandWordInfo(seg: LexSegment, keywords = true): CommandWordInfo {
  let i = 0
  let unsure = false
  let wrapperAt = -1
  let xargsAt = -1
  while (i < seg.words.length) {
    const word = seg.words[i]
    if (word.redirected || isAssignmentWord(word.text)) {
      i++
      continue
    }
    // `then tee x`, `! tee x`, `do tee x`: the keyword is not the command. A
    // quoted `"then"` is an ordinary word.
    if (keywords && word.spans.length === 0 && COMMAND_KEYWORDS.has(word.text)) {
      i++
      continue
    }
    const name = executableName(word.text)
    if (word.text.startsWith('-') && word.text.length > 1) {
      i++
      continue
    }
    const strict = STRICT_WRAPPERS.get(name)
    if (strict !== undefined) {
      if (wrapperAt === -1) wrapperAt = i
      if (name === 'xargs' && xargsAt === -1) xargsAt = i
      const skipped = skipStrictWrapper(seg.words, i + 1, strict)
      i = skipped.next
      if (skipped.unsure) unsure = true
      continue
    }
    if (COMMAND_WRAPPERS.has(name)) {
      if (wrapperAt === -1) wrapperAt = i
      i++
      // The wrapper's own options and their values are not the command.
      while (i < seg.words.length && seg.words[i].text.startsWith('-')) {
        const opt = seg.words[i].text
        i++
        // `env -C DIR` and `sudo -D DIR` take the directory as the next word, which
        // is not the command (see {@link hasWrapperChdir}).
        const chdir = (name === 'env' && opt === '-C') || (name === 'sudo' && opt === '-D')
        if (WRAPPER_VALUE_FLAGS.has(opt) || chdir) i++
      }
      if (name === 'timeout' && i < seg.words.length && /^\d/.test(seg.words[i].text)) i++
      if (name === 'env') {
        while (
          i < seg.words.length &&
          (isAssignmentWord(seg.words[i].text) || seg.words[i].redirected)
        )
          i++
      }
      continue
    }
    return { at: i, unsure, wrapperAt, xargsAt }
  }
  return { at: -1, unsure, wrapperAt, xargsAt }
}

/** Index of a segment's command word: after assignments, wrappers and options. */
function commandWordAt(seg: LexSegment, keywords = true): number {
  return commandWordInfo(seg, keywords).at
}

/**
 * The unreadable target starting after `pos`: the rest of that command line,
 * trimmed and bounded, so the judge sees WHICH path could not be read
 * (`-Path (Join-Path …)`) instead of a bare flag.
 */
function unreadableTarget(command: string, pos: number, append: boolean): RawTarget {
  const rest = command
    .slice(pos)
    .split(/[\n;|&]/)[0]
    .trim()
  // A leading `(` (a PowerShell subexpression) is cut at its matching `)`.
  let raw = rest
  if (rest.startsWith('(')) {
    let depth = 0
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '(') depth++
      else if (rest[i] === ')') {
        depth--
        if (depth === 0) {
          raw = rest.slice(0, i + 1)
          break
        }
      }
    }
  }
  return { raw: raw.slice(0, 160), append, pos, unreadable: true }
}

/** What a writer segment's trailing `{` (a brace expansion the lexer split) hides. */
interface BraceTail {
  /** The spelling from the glued word (or the `{`) to the end of the statement. */
  target: RawTarget
  /** True when the brace is glued to the segment's last word (`~/{a,b}`). */
  attached: boolean
}

/**
 * The lexer reads `{` as a group separator, so `tee {.git,x}/config` arrives as a
 * `tee` segment with NO arguments followed by fragments. A writer segment that
 * ends at `{` therefore names a target we cannot read: it is reported UNREADABLE,
 * spelled as the text from the `{` (or the word glued to it) to the end of the
 * statement, which keeps the protected components visible.
 */
function braceTail(seg: LexSegment, command: string): BraceTail | null {
  if (seg.sepAfter !== '{') return null
  const last = seg.words[seg.words.length - 1]
  let at = last.end
  while (at < command.length && (command[at] === ' ' || command[at] === '\t')) at++
  if (command[at] !== '{') return null
  const attached = last.end === at && last.redirected !== true
  const start = attached ? last.start : at
  let end = at
  let quote = ''
  for (; end < command.length; end++) {
    const ch = command[end]
    if (quote !== '') {
      if (ch === quote) quote = ''
      continue
    }
    if (ch === "'" || ch === '"') quote = ch
    else if (';|&\n\r<>)'.includes(ch)) break
  }
  const raw = command.slice(start, end).trim().slice(0, 160)
  return { target: { raw, append: false, pos: start, unreadable: true }, attached }
}

/** The ways a bare `tee` can be read. */
type TeeReading = 'bash' | 'powershell'

/**
 * Which readings a `tee` word can have. A path or `.exe` spelling is the native
 * program; the bare word is PowerShell's `Tee-Object` alias on Windows. An unknown
 * Windows shell takes BOTH readings (the worse one wins), and so does PowerShell
 * on a host where the alias does not exist (PowerShell on Linux/macOS runs the
 * native tee).
 */
function teeReadings(
  word: string,
  shell: RedirectShell | undefined,
  platform: NodeJS.Platform
): TeeReading[] {
  if (word.toLowerCase() !== 'tee' || shell === 'posix') return ['bash']
  if (shell === 'powershell') return platform === 'win32' ? ['powershell'] : ['bash', 'powershell']
  return platform === 'win32' ? ['bash', 'powershell'] : ['bash']
}

/**
 * Merge two readings of one command into the worse one: every target of either,
 * and `append` only where BOTH readings name it with an append (a target only one
 * reading writes keeps that reading's flag).
 */
function mergeReadings(first: RawTarget[], second: RawTarget[]): RawTarget[] {
  const out = first.slice()
  for (const target of second) {
    const same = out.findIndex(
      (t) => t.raw === target.raw && (t.unreadable === true) === (target.unreadable === true)
    )
    if (same === -1) out.push(target)
    else out[same] = { ...out[same], append: out[same].append && target.append }
  }
  return out
}

/** bash `tee [-a|--append] [-i|-p] [--] FILE…`: every non-option argument. */
function bashTeeTargets(args: readonly LexWord[], command: string): RawTarget[] {
  const out: RawTarget[] = []
  let append = false
  let optionsDone = false
  for (const word of args) {
    const text = word.text
    if (text.length === 0) continue
    if (!optionsDone && text === '--') {
      optionsDone = true
      continue
    }
    if (!optionsDone && text.startsWith('-') && text.length > 1) {
      // `-a`, `--append`, clusters like `-ai`, `--output-error=warn`. Only the
      // letters tee defines count: `-FilePath` is not an append.
      if (text === '--append' || (/^-[aip]+$/.test(text) && text.includes('a'))) append = true
      continue
    }
    for (const part of splitTargetWord(word)) {
      out.push({
        raw: part,
        append,
        pos: word.start,
        quoted: word.spans.length > 0,
        hintLiteral:
          part === word.text ? leadingReferenceIsLiteral(command, word.start, word.text) : true
      })
    }
  }
  return out
}

/** A PowerShell path parameter and the words that supply its value. */
interface PsPathItem {
  flag: LexWord
  /** Text after the `:` of the colon form (`-Path:x`); absent for `-Path x`. */
  inline?: string
  /** Where that text starts in the command. */
  inlineAt?: number
  /** The words after the flag, for the separate form. */
  values: LexWord[]
}

/**
 * Text after `from` at the end of a statement CUT by `(` can still hold a path
 * flag (`Set-Content (x) -Path C:\Windows\p`): true when that text carries a
 * parameter that is a path flag or unknown for `cmdlet`. Parenthesised groups are
 * dropped first (`(Get-Content a -Raw)`'s `-Raw` is not an argument of ours).
 */
function trailingFlagsHidePath(cmdlet: string, command: string, from: number): boolean {
  let rest = command.slice(from)
  for (let guard = 0; guard < 64 && /\([^()]*\)/.test(rest); guard++) {
    rest = rest.replace(/\([^()]*\)/g, ' ')
  }
  rest = rest.split(/[\n;|&]/)[0]
  for (const m of rest.matchAll(/(?:^|[\s,])[-\u2013\u2014\u2015]([A-Za-z_?][A-Za-z0-9_?]*)/g)) {
    const param = resolvePsParam(cmdlet, m[1])
    if (param === null || param.kind === 'path') return true
  }
  return false
}

/**
 * The targets a PowerShell write cmdlet names. EVERY argument is scanned for a
 * path parameter first (`-Path`, `-FilePath`, `-LiteralPath`, `-PSPath`, any
 * unambiguous abbreviation, the `-Path:value` form); only when none is present does
 * the first positional argument stand in. A parameter that is not in the cmdlet's
 * table, a splat (`@p`) or a comma-continued positional (`"a", "b"`) leaves the
 * positional unknowable, so the target is UNREADABLE — a positional is never
 * guessed. Values of known value-taking parameters are skipped (`-ErrorAction
 * Stop`, `-Value "a", "b"`).
 */
function psWriterTargets(
  cmdlet: string,
  args: readonly LexWord[],
  cmdEnd: number,
  sepAfter: SegmentOp,
  command: string
): RawTarget[] {
  const items: PsPathItem[] = []
  let appendFlag = false
  let unsure = false
  let positional: { word: LexWord; continued: boolean } | undefined
  let positionalOnly = false
  for (let i = 0; i < args.length; i++) {
    const word = args[i]
    const text = word.text
    if (!positionalOnly && word.spans.length === 0 && text === '--') {
      positionalOnly = true
      continue
    }
    if (!positionalOnly && isPsFlagWord(word)) {
      const colon = text.indexOf(':')
      const param = resolvePsParam(cmdlet, (colon === -1 ? text : text.slice(0, colon)).slice(1))
      if (param === null) {
        unsure = true
        continue
      }
      if (param.kind === 'switch') {
        if (param.name === 'append') {
          appendFlag = colon === -1 || text.slice(colon + 1).toLowerCase() === '$true'
        }
        continue
      }
      if (param.kind === 'path' && colon !== -1) {
        items.push({
          flag: word,
          inline: text.slice(colon + 1),
          inlineAt: word.start + colon + 1,
          values: []
        })
        continue
      }
      if (colon !== -1) continue // a value-taking parameter with its value attached
      // The value words: `-Path a, b` and `-Value "a", "b"` continue past a comma.
      const values: LexWord[] = []
      let j = i + 1
      while (j < args.length && !isPsFlagWord(args[j])) {
        values.push(args[j])
        j++
        if (!continuesList(args[j - 1], args[j])) break
      }
      if (param.kind === 'path') items.push({ flag: word, values })
      i = j - 1
      continue
    }
    // A splat can supply any parameter, `-Path` included.
    if (word.spans.length === 0 && text.startsWith('@')) {
      unsure = true
      continue
    }
    if (positional === undefined) positional = { word, continued: continuesList(word, args[i + 1]) }
  }

  const append = PS_ALWAYS_APPEND.has(cmdlet) || appendFlag
  const out: RawTarget[] = []
  const pushWord = (word: LexWord): void => {
    if (word.spans.length > 0 && word.fullyQuoted) {
      out.push({
        raw: word.text,
        append,
        pos: word.start,
        quoted: true,
        hintLiteral: leadingReferenceIsLiteral(command, word.start, word.text)
      })
      return
    }
    for (const part of splitTextWords(word.text)) {
      out.push({
        raw: part.text,
        append,
        pos: word.start,
        unreadable: part.unreadable,
        ...(word.spans.length > 0 ? { quoted: true } : {}),
        hintLiteral:
          part.text === word.text ? leadingReferenceIsLiteral(command, word.start, word.text) : true
      })
    }
  }

  if (items.length > 0) {
    for (const item of items) {
      if (item.inline !== undefined) {
        const value = item.inline
        const valueAt = item.inlineAt ?? item.flag.start
        for (const part of splitTextWords(value)) {
          out.push({
            raw: part.text,
            append,
            pos: item.flag.start,
            unreadable: part.unreadable,
            ...(item.flag.spans.length > 0 ? { quoted: true } : {}),
            hintLiteral:
              part.text === value ? leadingReferenceIsLiteral(command, valueAt, value) : true
          })
        }
        if (value.length === 0) out.push(unreadableTarget(command, item.flag.end, append))
        continue
      }
      if (item.values.length === 0) out.push(unreadableTarget(command, item.flag.end, append))
      for (const word of item.values) pushWord(word)
    }
    return out
  }
  // No explicit path: the positional stands in only when nothing else could have
  // taken its place.
  const cut = sepAfter === '(' && trailingFlagsHidePath(cmdlet, command, cmdEnd)
  if (!unsure && !cut && positional !== undefined && !positional.continued) {
    pushWord(positional.word)
    return out
  }
  if (unsure || cut || positional !== undefined) {
    return [unreadableTarget(command, cmdEnd, append)]
  }
  // A cmdlet that writes a file but named no readable path at all: report the
  // unreadable target rather than dropping the write (ruling 7). Tee-Object
  // without a path writes no file (`-Variable v` is a sink, N8).
  return cmdlet === 'tee-object' ? [] : [unreadableTarget(command, cmdEnd, append)]
}

/**
 * Targets a WRITER COMMAND writes, which no `>` operator names.
 *
 * - bash `tee [-a|--append] [-i|-p] [--] FILE…` — every non-option argument. In
 *   PowerShell `tee` is the `Tee-Object` alias: a known PowerShell shell reads it
 *   that way ({@link psWriterTargets}: it OVERWRITES unless `-Append`), a known
 *   POSIX shell the bash way, and an unknown Windows shell takes the worse of both
 *   ({@link teeReadings}). `--` ends the options (`tee -- -x/…` is a file).
 * - PowerShell (case-insensitive) `Out-File`, `Set-Content`, `Add-Content`,
 *   `Tee-Object`, `Export-Csv`, `ac`, `epcsv`: see {@link psWriterTargets}.
 *   Redirect words are not arguments (`Set-Content 2>$null X`), and an unquoted
 *   `,` splits one word into several paths (ruling 7).
 *
 * Only a segment's COMMAND word counts (after any pipe, shell keyword such as
 * `then`/`do`/`!`, or wrapper such as `sudo`/`stdbuf`/`xargs`) — `rg tee log.txt`
 * is not a write. A wrapper option that is not in its table, or a trailing `{`
 * (a brace expansion), makes the target UNREADABLE rather than a guess. These
 * targets then go through the same resolution, scope and protected-component logic
 * as `>` targets.
 */
function writerTargets(
  seg: LexSegment,
  command: string,
  shell: RedirectShell | undefined,
  platform: NodeJS.Platform
): RawTarget[] {
  const info = commandWordInfo(seg)
  if (info.at === -1) return []
  const isWriterName = (name: string): boolean => PS_WRITE_CMDLETS.has(name) || name === 'tee'
  if (info.unsure) {
    // An unknown wrapper option: which word is the command is a guess, so a writer
    // named anywhere after the wrapper is reported unreadable.
    for (let k = info.wrapperAt + 1; k < seg.words.length; k++) {
      const word = seg.words[k]
      if (!word.redirected && isWriterName(executableName(word.text))) {
        return [unreadableTarget(command, word.end, false)]
      }
    }
    return []
  }
  const wordText = seg.words[info.at].text
  const head = executableName(wordText)
  if (!isWriterName(head)) return []
  const tail = braceTail(seg, command)
  let args = seg.words.slice(info.at + 1).filter((w) => !w.redirected)
  // A word glued to the `{` is part of the unreadable spelling, not a target.
  if (tail?.attached === true) args = args.slice(0, -1)
  const cmdEnd = seg.words[info.at].end

  let out: RawTarget[]
  if (head === 'tee') {
    const readings = teeReadings(wordText, shell, platform)
    const bash = readings.includes('bash') ? bashTeeTargets(args, command) : []
    const ps = readings.includes('powershell')
      ? psWriterTargets('tee-object', args, cmdEnd, seg.sepAfter, command)
      : []
    out = mergeReadings(bash, ps)
  } else {
    out = psWriterTargets(PS_CMDLET_ALIASES.get(head) ?? head, args, cmdEnd, seg.sepAfter, command)
  }
  if (tail !== null) out.push(tail.target)
  // `xargs tee f` also writes every name its stdin supplies.
  if (info.xargsAt !== -1) {
    out.push(unreadableTarget(command, seg.words[info.xargsAt].start, false))
  }
  return out
}

/** Split one word into its unquoted-comma-separated target spellings. */
function splitTargetWord(word: LexWord): string[] {
  // A comma inside a quoted span is part of the path; a word with no quotes is
  // split. A mixed word is split too (over-reporting is the safe error).
  if (word.spans.length > 0 && word.fullyQuoted) return [word.text].filter((t) => t.length > 0)
  return splitTextWords(word.text).map((part) => part.text)
}

interface TextPart {
  text: string
  /** True when the spelling cannot be read as a path (`(Join-Path …)`, `@p`, `$(…)`). */
  unreadable: boolean
}

/** Split a word's text on unquoted commas and classify each spelling. */
function splitTextWords(text: string): TextPart[] {
  const out: TextPart[] = []
  for (const part of text.split(',')) {
    const value = part.trim()
    if (value.length === 0) continue
    // A value starting with `(`, `@` or `$(` cannot be read from the string.
    const unreadable = value.startsWith('(') || value.startsWith('@') || value.startsWith('$(')
    out.push({ text: value, unreadable })
  }
  return out
}

/**
 * Protected path components: repo/agent internals, credential stores, `.env*`
 * (the files that hold a session's secrets) and the shell rc files that are the
 * classic persistence vehicle.
 *
 * Agent-control names come from {@link isAgentControlPath} so edits and
 * redirects agree on ONE notion of "agent control", and every component is
 * folded the way `agent-control-paths.ts` folds it (case, trailing dots/spaces,
 * ADS suffix, 8.3 aliases), which closes `.ssh.\x` and `.bashrc::$DATA`.
 * Directories match as any component; a FILE name only as the last one (a
 * `CLAUDE.md/` directory is not an instructions file).
 *
 * EXPORTED so P2a-2's measurement has no second list to drift from.
 */
export function protectedComponentsOf(components: readonly string[]): string[] {
  const hits: string[] = []
  const last = components.length - 1
  for (let i = 0; i < components.length; i++) {
    const component = components[i]
    const folded = foldName(component)
    if (folded === '') continue
    if (PROTECTED_COMPONENTS.has(folded) || folded.startsWith('.env')) {
      hits.push(component)
      continue
    }
    // Append a dummy final component for non-last positions so FILE names only
    // match where `isAgentControlPath` would match them.
    if (isAgentControlPath(i === last ? component : `${component}/x`)) hits.push(component)
  }
  // Multi-component entries (`.config/git`) are invisible to the per-component
  // look above: report each matched run once, joined as written.
  for (const run of agentControlSequenceHits(components)) hits.push(run)
  return hits
}

// ── Temp variables (hint only — ruling 18) ───────────────────────────────────

/**
 * TEMP VARIABLES ARE A HINT, NEVER AN IN-SCOPE CLAIM (ruling 18). The scanner
 * never expands a variable for scope: a target containing `$` stays
 * unresolvable exactly as HEAD reported it, so no rebinding form — however
 * exotic — can turn one into a false `allInScope: true`.
 *
 * It still reports a NON-AUTHORITATIVE hint for an unresolvable target that
 * STARTS WITH a temp-directory reference — posix `$TMPDIR`/`${TMPDIR}`/`$TEMP`/
 * `$TMP` (and the braced forms), powershell `$env:TEMP`/`$env:TMP` and their
 * braced forms (case-insensitive) — or with a plain variable bound EARLIER by a
 * single top-level `NAME=<one of those>` / `$NAME = <one of those>` segment that
 * always runs (see {@link tempHintBindings}: not in an `if`/`case`/loop body, not
 * after `&&`/`||`/`|` or a line continuation). The whole hint is withheld when the
 * command could rebind the variable ({@link hintTainted}, {@link assignmentCount}).
 * `path` is the host value from {@link RedirectScope.tempVars} plus the rest of
 * the target. A hint never promotes the variable target into scope; unsupported
 * or unvalidated spellings omit it conservatively.
 */
const POWERSHELL_TEMP_NAMES: ReadonlySet<string> = new Set(['TEMP', 'TMP'])

/** The host value of a temp name, folded the way the dialect folds names. */
function hostTempValue(
  name: string,
  shell: RedirectShell,
  tempVars: Readonly<Record<string, string>>
): string | undefined {
  if (shell === 'powershell') {
    if (!POWERSHELL_TEMP_NAMES.has(name.toUpperCase())) return undefined
    const key = Object.keys(tempVars).find((k) => k.toLowerCase() === name.toLowerCase())
    return key === undefined ? undefined : tempVars[key]
  }
  return Object.prototype.hasOwnProperty.call(tempVars, name) ? tempVars[name] : undefined
}

/**
 * Match a host temp reference at the START of `text`, returning the host value
 * and the text after the reference. The reference must end the string or be
 * followed by `/` or `\`; `%NAME%` never matches (it is a literal in both
 * dialects).
 */
function leadingHostTempRef(
  text: string,
  shell: RedirectShell | undefined,
  tempVars: Readonly<Record<string, string>>
): { value: string; rest: string } | null {
  if (!shell) return null
  const refs =
    shell === 'powershell'
      ? [/^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/i, /^\$env:([A-Za-z_][A-Za-z0-9_]*)/i]
      : [/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}/, /^\$([A-Za-z_][A-Za-z0-9_]*)/]
  for (const re of refs) {
    const m = re.exec(text)
    if (!m) continue
    const value = hostTempValue(m[1], shell, tempVars)
    if (value === undefined) return null
    const rest = text.slice(m[0].length)
    return rest === '' || rest.startsWith('/') || rest.startsWith('\\') ? { value, rest } : null
  }
  return null
}

/** A plain `$NAME` / `${NAME}` at the start of `text`; groups 1/2 are the name. */
const PLAIN_VAR_REF = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/

/** True when two variable names are the same variable in `shell`. */
function sameVarName(a: string, b: string, shell: RedirectShell): boolean {
  return shell === 'powershell' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** A same-command temp binding the hint may point through. */
interface TempHintBinding {
  name: string
  /** The value word's text (`$env:TEMP`, `${TMPDIR}/sub`, …). */
  value: string
  /** Command offset just past the assignment segment. */
  end: number
}

/**
 * The binding a SINGLE top-level assignment segment records — `NAME=<temp ref>`
 * or, in PowerShell, `$NAME = <temp ref>` — or `null` for any other segment. A
 * single-quoted value is a literal, never a binding (N7).
 */
function hintBinding(
  seg: LexSegment,
  shell: RedirectShell,
  tempVars: Readonly<Record<string, string>>,
  command: string
): TempHintBinding | null {
  if (seg.nested || seg.depth > 0) return null
  // A binding that may not run (after `&&`/`||`) or runs in a subshell
  // (backgrounded, in a pipeline) names nothing the later target can rely on.
  if (seg.after === '&&' || seg.after === '||' || seg.after === '|') return null
  if (seg.sepAfter === '&' || seg.sepAfter === '|') return null
  const words = seg.words.filter((w) => !w.redirected)
  let name: string
  let value: string
  if (words.length === 1) {
    const text = words[0].text
    const eq = text.indexOf('=')
    if (eq <= 0) return null
    if (words[0].spans.some((s) => s.quote === "'")) return null
    name = text.slice(0, eq).replace(/^\$/, '')
    value = text.slice(eq + 1)
    // An escaped leading reference is a LITERAL value, not the variable.
    const valueAt = words[0].start + eq + 1
    if (leadingReferenceIsLiteral(command, valueAt, value)) return null
  } else if (shell === 'powershell' && words.length === 3 && words[1].text === '=') {
    const m = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(words[0].text)
    if (!m) return null
    if (words[2].spans.some((s) => s.quote === "'")) return null
    name = m[1]
    value = words[2].text
    if (leadingReferenceIsLiteral(command, words[2].start, value)) return null
  } else {
    return null
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null
  // `$null = $env:TEMP` and `$HOME = $env:TEMP` bind nothing: the variable is a
  // constant or read-only, so the assignment is discarded or errors, and a later
  // `$null\x` / `$HOME\x` is NOT the temp path the binding spells.
  if (shell === 'powershell' && PS_UNBINDABLE.has(name.toLowerCase())) return null
  if (leadingHostTempRef(value, shell, tempVars) === null) return null
  return { name, value, end: words[words.length - 1].end }
}

/** PowerShell variables no assignment can change (constant or read-only), lowercased. */
const PS_UNBINDABLE: ReadonlySet<string> = new Set([
  'null',
  'true',
  'false',
  'home',
  'pid',
  'pshome',
  'host',
  'executioncontext',
  'error',
  'psversiontable',
  'psculture',
  'psuiculture',
  'psedition',
  'psstyle',
  'shellid',
  'iswindows',
  'islinux',
  'ismacos',
  'iscoreclr',
  'enabledexperimentalfeatures'
])

/**
 * A loop keyword: a `cd` inside its body moves once per iteration, which we do
 * not model, so a later relative target is unresolvable (C-A).
 */
const LOOP_WORD_RE = /(?:^|[\s;|&(])(?:for|foreach|while|until|select)(?=[\s($])/i

/**
 * Commands that, run IN the current shell, can rebind a variable the hint points
 * through without any `NAME=` spelling in the text: `unset`, the readers that
 * name their target variable, current-scope code execution (`eval`, `source`, `.`,
 * `iex`, `Import-Module`), `trap`/`alias`, and the PowerShell variable cmdlets
 * with their aliases. Read-only `Get-Variable` is kept: a hint is only a hint.
 */
const REBINDING_COMMANDS: ReadonlySet<string> = new Set([
  'unset',
  'read',
  'mapfile',
  'readarray',
  'getopts',
  'trap',
  'alias',
  'eval',
  'source',
  '.',
  'iex',
  'invoke-expression',
  'import-module',
  'ipmo',
  'get-variable',
  'gv',
  'set-variable',
  'sv',
  'new-variable',
  'nv',
  'remove-variable',
  'rv',
  'clear-variable',
  'clv'
])
/** Declaration builtins: they rebind only through an argument (see {@link declarationRebinds}). */
const DECLARE_COMMANDS: ReadonlySet<string> = new Set([
  'export',
  'declare',
  'typeset',
  'readonly',
  'local'
])

/**
 * Text-level rebinding forms — spellings that do not depend on a word being at
 * command position: an environment-drive path (`env:TEMP`, not `$env:TEMP`),
 * `printf -v`, .NET and runspace reflection, `[ref]`, script blocks, an indexed
 * assignment (`TMPDIR[0]=` IS `$TMPDIR`), and a PowerShell script file named
 * anywhere (`.\x.ps1`, `& x.ps1`, `Import-Module x.psm1`: it can change `$env:`
 * for the rest of the command).
 */
const HINT_TEXT_TERMS: readonly string[] = [
  String.raw`(?<![$\w{])env:`,
  String.raw`printf\s+-v`,
  `setenvironmentvariable`,
  String.raw`\[ref\]`,
  `scriptblock`,
  `invokescript`,
  // `$ExecutionContext.SessionState.PSVariable.Set(…)` and runspace `SetVariable`.
  `psvariable`,
  `sessionstate`,
  `setvariable`,
  // `NAME[...]=` — an indexed assignment is the scalar a `$NAME` read sees.
  String.raw`[A-Za-z_][A-Za-z0-9_]*\[[^\]]*\]\s*=(?!=)`,
  String.raw`\.(?:ps1|psm1)\b`
]
const HINT_TAINT_TEXT_RE = new RegExp(HINT_TEXT_TERMS.join('|'), 'i')
/** The PowerShell `variable:` provider drive: `Set-Item variable:t`, `New-Item -Path Variable:\t`. */
const PS_VARIABLE_DRIVE_RE = /(?<![A-Za-z0-9_])variable:/i

/**
 * The raw-text reading of the same hazards, used only when the lexer could not
 * trust its own quote structure (see {@link hintTainted}): every rebinding word
 * ANYWHERE in the text taints. Exit review Fable C1's coarse rule, kept as the
 * fallback — losing a hint costs an escalation at worst.
 */
const HINT_TAINT_RE = new RegExp(
  [
    ...HINT_TEXT_TERMS,
    String.raw`(?<![A-Za-z0-9_])variable:`,
    LOOP_WORD_RE.source,
    String.raw`(?:^|[\s;|&(])(?:` +
      [...REBINDING_COMMANDS, ...DECLARE_COMMANDS, 'set']
        .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`))
        .join('|') +
      String.raw`)(?=[\s(]|$)`
  ].join('|'),
  'i'
)

/** A command word that is nothing but a variable reference (`$c`, `${c}`): its value is the command. */
const BARE_VAR_REF = /^\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)$/

/**
 * A copy of `seg` with every backslash removed from its words, for POSIX command
 * words only: `\eval`, `ev\al` and `"eval"` (the lexer already strips quotes) are
 * all the `eval` builtin. PowerShell has no backslash escapes — there it is a path
 * separator — so its segments are read as lexed.
 */
function withoutEscapes(seg: LexSegment): LexSegment {
  if (!seg.words.some((w) => w.text.includes('\\'))) return seg
  return {
    ...seg,
    words: seg.words.map((w) =>
      w.text.includes('\\') ? { ...w, text: w.text.replace(/\\/g, '') } : w
    )
  }
}

/** True when `set` turns on allexport (`set -a`, `set -ea`, `set -o allexport`). */
function setExportsAll(seg: LexSegment, at: number): boolean {
  const args = seg.words.slice(at + 1).filter((w) => !w.redirected)
  return args.some(
    (w, i) =>
      /^-[A-Za-z]*a[A-Za-z]*$/.test(w.text) ||
      (w.text === '-o' && args[i + 1]?.text.toLowerCase() === 'allexport')
  )
}

/**
 * True when a declaration builtin (`export`, `declare`, `typeset`, `readonly`,
 * `local`) may rebind the hinted variable. A NAMED argument with a static,
 * plainly spelled name (`export CI=1`) cannot: its assignment is counted by
 * {@link assignmentCount}. Everything else is unknowable and taints: no argument
 * at all (`export`, `declare -x`, `export -p`), a nameref option (`declare -n r=TMPDIR`
 * makes `r=…` write `TMPDIR`), a name that expands (`export "$n=/etc"`) or is
 * spelled through quotes (`declare TMP""DIR=/etc` — the shell reads `TMPDIR`, the
 * raw text does not), and `local`/`declare`/`typeset` inside a group, where a
 * function body shadows the variable (`local TMPDIR`) with an unset one.
 */
function declarationRebinds(seg: LexSegment, at: number, command: string, name: string): boolean {
  let named = 0
  for (const word of seg.words.slice(at + 1)) {
    if (word.redirected) continue
    const text = word.text
    if (/^[-+]/.test(text) && text.length > 1) {
      if (/^[-+][A-Za-z]*n/.test(text)) return true
      continue
    }
    named++
    const eq = text.indexOf('=')
    const namePart = eq === -1 ? text : text.slice(0, eq)
    if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?$/.test(namePart)) return true
    if (command.slice(word.start, word.start + namePart.length) !== namePart) return true
  }
  if (named === 0) return true
  return name !== 'export' && name !== 'readonly' && seg.depth > 0
}

/**
 * True when ONE segment, read at command position, may rebind a variable of the
 * shell it runs in: a loop (`for TMPDIR in …`), a current-scope runner or
 * variable command ({@link REBINDING_COMMANDS}), a rebinding declaration
 * ({@link declarationRebinds}), PowerShell's `set` (= `Set-Variable`) or POSIX
 * `set -a`, or a command whose NAME is a variable (`c=eval; $c "…"`).
 *
 * Only the command word counts: `find . -name x`, `git commit -m "fix tests for
 * the parser"` and `export CI=1` hold the same words as arguments, quoted text or
 * a value, and none of them touches `TMPDIR`.
 */
function segmentRebinds(seg: LexSegment, shell: RedirectShell, command: string): boolean {
  const view = shell === 'powershell' ? seg : withoutEscapes(seg)
  if (startsLoop(view, shell)) return true
  const at = commandWordAt(view, true)
  if (at === -1) return false
  const word = view.words[at]
  const name = executableName(word.text)
  if (REBINDING_COMMANDS.has(name)) return true
  if (name === 'set') return shell === 'powershell' || setExportsAll(view, at)
  if (DECLARE_COMMANDS.has(name)) return declarationRebinds(seg, at, command, name)
  // `$c args` runs whatever `c` holds (PowerShell spells that `& $c`).
  return BARE_VAR_REF.test(word.text) && (shell !== 'powershell' || seg.after === '&')
}

/**
 * True when the command could rebind a variable without a plain `NAME=` spelling.
 * Any such form withholds every hint: a hint is only useful when the command
 * visibly leaves the variable alone. (A child shell — `bash -c`, a pipe into `sh`
 * — cannot rebind this shell's variables, and `$env:` writes from a child scope
 * are caught as assignments.)
 *
 * Keywords are tested at COMMAND position of the lexed segments, never in
 * arguments, quoted text or heredoc bodies; the text-level spellings of
 * {@link HINT_TEXT_TERMS} are tested anywhere. A command the lexer could not
 * read (unbalanced quote, unterminated heredoc, …) falls back to
 * {@link HINT_TAINT_RE} over the raw text. In PowerShell a `$( … )` subexpression
 * runs in the CURRENT scope, so the segments lexed from inside a double-quoted
 * string count when they follow `(`; in bash that is a subshell and they do not.
 */
function hintTainted(
  command: string,
  balanced: boolean,
  segments: readonly LexSegment[],
  shell: RedirectShell
): boolean {
  if (!balanced) return HINT_TAINT_RE.test(command)
  if (HINT_TAINT_TEXT_RE.test(command)) return true
  if (shell === 'powershell' && PS_VARIABLE_DRIVE_RE.test(command)) return true
  for (const seg of segments) {
    if (seg.nested && !(shell === 'powershell' && seg.after === '(')) continue
    if (segmentRebinds(seg, shell, command)) return true
  }
  return false
}

/**
 * How many times `name` is assigned in `command`: `=`, indexed, an op-assign, or
 * (PowerShell) a scope- or drive-qualified spelling (`$global:t =`,
 * `${variable:t} =`) or a multi-assignment (`$t, $u = …`, `($t, $u) = …`); in a
 * POSIX shell also the `${NAME:=…}` default-assignment expansion. Any `$`/`{`/
 * `env:` spelling.
 */
function assignmentCount(command: string, name: string, shell: RedirectShell): number {
  const powershell = shell === 'powershell'
  // `name` is an identifier (`[A-Za-z_][A-Za-z0-9_]*`): nothing to escape.
  const qualifier = powershell ? `(?:[A-Za-z]+:)?` : `(?:env:)?`
  const ops = powershell ? String.raw`(?:[-+*/%]|\?\?)?` : String.raw`(?:[-+*/%:]|\?\?)?`
  const flags = powershell ? 'gi' : 'g'
  const tail = String.raw`\}?(?:\[[^\]]*\])?\s*`
  const plain = new RegExp(
    String.raw`(?<![A-Za-z0-9_])\$?\{?` + qualifier + name + tail + ops + `=(?!=)`,
    flags
  )
  let count = [...command.matchAll(plain)].length
  if (powershell) {
    // `$t, $u = 'a', 1`: a variable followed by a comma, and an `=` ends the list.
    const multi = new RegExp(
      String.raw`(?<![A-Za-z0-9_])\$\{?` +
        qualifier +
        name +
        tail +
        String.raw`,[^=;|&\n({}]*(?<![-<>!=~])=(?![=~])`,
      flags
    )
    count += [...command.matchAll(multi)].length
  }
  return count
}

/** The host temp variable a text starts with (`TEMP` for `$env:TEMP\x`), or `null`. */
function hostRefName(text: string, shell: RedirectShell): string | null {
  const m =
    shell === 'powershell'
      ? /^\$\{?env:([A-Za-z_][A-Za-z0-9_]*)/i.exec(text)
      : /^\$\{?([A-Za-z_][A-Za-z0-9_]*)/.exec(text)
  return m ? m[1] : null
}

/**
 * Reserved words that open a compound command a POSIX shell closes with a word of
 * its own (`fi`, `esac`, `done`). A binding between them runs only when the
 * construct says so.
 */
const BLOCK_OPENERS: ReadonlySet<string> = new Set([
  'if',
  'case',
  'for',
  'while',
  'until',
  'select'
])
const BLOCK_CLOSERS: ReadonlySet<string> = new Set(['fi', 'esac', 'done'])
/** Reserved words that may precede the word that opens or closes a construct. */
const BLOCK_LEADERS: ReadonlySet<string> = new Set(['then', 'do', 'else', 'elif', '!', 'time'])

/**
 * +1 when the segment opens an `if`/`case`/loop, -1 when it closes one, else 0 —
 * judged at command position only, so `echo if` and a quoted `"if"` are prose.
 * PowerShell bodies sit in `{ }`, which the lexer already tracks as depth.
 */
function blockDelta(seg: LexSegment): number {
  for (const word of seg.words) {
    if (word.redirected) continue
    if (word.spans.length > 0) return 0
    if (BLOCK_LEADERS.has(word.text)) continue
    if (BLOCK_OPENERS.has(word.text)) return 1
    return BLOCK_CLOSERS.has(word.text) ? -1 : 0
  }
  return 0
}

/**
 * True when the segment after `prev` is not a fresh command: `prev` ended with
 * `&&`, `||` or `|` (the lexer keeps the operator across a newline, so the
 * binding on the next line is still gated or piped), or with a line continuation
 * — a `\` (a backtick in PowerShell) right before the newline — which joins the
 * next line onto `prev`.
 */
function continuesInto(prev: LexSegment, command: string, shell: RedirectShell): boolean {
  if (prev.sepAfter === '&&' || prev.sepAfter === '||' || prev.sepAfter === '|') return true
  const last = prev.words[prev.words.length - 1]
  if (last === undefined) return false
  const next = command[last.end]
  if (next !== '\n' && next !== '\r') return false
  const tail = command[last.end - 1]
  return tail === '\\' || (shell === 'powershell' && tail === '`')
}

/**
 * Every hint binding in the command, in command order. A binding that may not
 * run is no binding at all: one inside an `if`/`elif`/`else`/`case`/loop body
 * (any line), or one that follows a line ending in `&&`, `||`, `|` or a
 * continuation. Those would name a temp path the variable need not hold.
 */
function tempHintBindings(
  segments: readonly LexSegment[],
  shell: RedirectShell | undefined,
  tempVars: Readonly<Record<string, string>>,
  command: string
): TempHintBinding[] {
  if (!shell) return []
  const bindings: TempHintBinding[] = []
  let blocks = 0
  let prev: LexSegment | undefined
  for (const seg of segments) {
    if (seg.nested) continue
    const joined = prev !== undefined && continuesInto(prev, command, shell)
    if (blocks === 0 && !joined) {
      const binding = hintBinding(seg, shell, tempVars, command)
      if (binding) bindings.push(binding)
    }
    if (shell === 'posix') blocks = Math.max(0, blocks + blockDelta(seg))
    prev = seg
  }
  return bindings
}

/**
 * The normalised path `value` + `rest` names, or `undefined` when `rest` climbs
 * OUT of the temp value it is anchored to.
 *
 * A hint says "this is probably a write to scratch space". `$TMPDIR/../../../
 * Documents/thesis.docx` is not: the target is out of the temp root, and the
 * judge is told to treat an `unresolvable` target listed in `tempVarTargets` as
 * "not this rule". Emitting no hint there leaves the write judged on its text
 * (exit review #4). Equal to the root itself is still inside.
 */
function hintPath(
  value: string,
  rest: string,
  platform: NodeJS.Platform
): { path: string; spelling: string } | undefined {
  const root = normalizePath(value, platform).full
  const spelling = toPosixish(`${value.replace(/[\\/]+$/, '')}${rest}`, platform)
  const path = normalizePath(spelling, platform).full
  if (path !== root && !isDescendant(root, path, platform)) return undefined
  return { path, spelling }
}

/** Characters that expand or match at run time; a hint must name a static suffix. */
const DYNAMIC_HINT_SUFFIX = /[$`~*?{}%[\]]/

/**
 * True when the suffix after the temp reference is literal for this shell. A
 * backslash is literal only in PowerShell, where it is a path separator; in
 * POSIX it escapes/removes the next character and the hint is withheld.
 */
function staticHintSuffix(text: string, shell: RedirectShell): boolean {
  if (shell === 'posix' && text.includes('\\')) return false
  return !DYNAMIC_HINT_SUFFIX.test(text)
}

/**
 * The hint for an unresolvable target, or `undefined` when it does not start
 * with a temp reference — directly, or through a binding that ends before it.
 */

function tempHintFor(
  raw: string,
  hintLiteral: boolean | undefined,
  shell: RedirectShell | undefined,
  tempVars: Readonly<Record<string, string>>,
  bindings: readonly TempHintBinding[],
  pos: number,
  platform: NodeJS.Platform,
  command: string
): { path: string; spelling: string } | undefined {
  if (!shell) return undefined
  // Unknown provenance is withheld conservatively; `false` means a normal
  // unquoted/double-quoted expanding reference.
  if (hintLiteral !== false) return undefined
  // In POSIX shell an unquoted backslash is removed or escapes the next
  // character, so the target text alone does not say which path the shell
  // reaches (`temp/ev\il` is `temp/evil`). The hint is optional: withhold it
  // rather than validate a path the shell would not write (exit review R1/N7).
  // PowerShell's backslash is a path separator, so its hints are unaffected.
  if (shell === 'posix' && raw.includes('\\')) return undefined
  const hostAssigned = (text: string): boolean => {
    const name = hostRefName(text, shell)
    return name !== null && assignmentCount(command, name, shell) > 0
  }
  const direct = leadingHostTempRef(raw, shell, tempVars)
  if (direct) {
    if (!staticHintSuffix(direct.rest, shell)) return undefined
    return hostAssigned(raw) ? undefined : hintPath(direct.value, direct.rest, platform)
  }
  const ref = PLAIN_VAR_REF.exec(raw)
  if (!ref) return undefined
  const rest = raw.slice(ref[0].length)
  if (!(rest === '' || rest.startsWith('/') || rest.startsWith('\\'))) return undefined
  const name = ref[1] ?? ref[2]
  let found: TempHintBinding | undefined
  for (const binding of bindings) {
    if (binding.end > pos) continue
    if (sameVarName(binding.name, name, shell)) found = binding
  }
  if (!found) return undefined
  if (shell === 'posix' && found.value.includes('\\')) return undefined
  const host = leadingHostTempRef(found.value, shell, tempVars)
  if (!host || hostAssigned(found.value)) return undefined
  if (!staticHintSuffix(host.rest, shell) || !staticHintSuffix(rest, shell)) return undefined
  return hintPath(host.value, `${host.rest}${rest}`, platform)
}

/**
 * A `cd` inside a loop body moves once per iteration, which we do not model, so
 * a later relative target is unresolvable (C-A). {@link LOOP_WORD_RE} — also a
 * hint-taint term (Fable C1) — is defined with the hint machinery above.
 */

// ── Shell-state dataflow (rulings 4 and 13) ───────────────────────────────────

/** Commands that change the shell's directory to an argument we can resolve. */
const DIR_COMMANDS: ReadonlySet<string> = new Set([
  'cd',
  'chdir',
  'pushd',
  'set-location',
  'sl',
  'push-location'
])
/** Commands that move it somewhere we cannot know (the previous entry). */
const DIR_POISON: ReadonlySet<string> = new Set([
  'popd',
  'pop-location',
  // PowerShell's two no-space spellings of `cd ..` / `cd \`: resolvable in
  // principle, poisoned deliberately (ruling 4).
  'cd..',
  'cd\\'
])
/** Commands that may change it invisibly (`eval`, `source`, `.`, and PowerShell's
 *  `Invoke-Expression`, which runs its text in the CURRENT scope). */
const EVAL_WORDS: ReadonlySet<string> = new Set(['eval', 'source', '.', 'iex', 'invoke-expression'])
/** Every word whose presence in a command line can be a directory change. */
const DIR_WORD_RE =
  /(^|[^A-Za-z0-9_-])(cd|chdir|pushd|popd|set-location|sl|push-location|pop-location)([^A-Za-z0-9_-]|$)/i
/** PowerShell's no-space `cd..` / `cd\` spellings, which the lexer reads as one
 *  word (`cd..`) or as an escaped separator (`cd;`). */
const CD_POISON_RE = /(^|[\s;|&(])cd(\.\.|\\)([\s;|&)]|$)/i

/** True when `text` names a directory-changing command anywhere. */
function hasDirWord(text: string): boolean {
  return DIR_WORD_RE.test(text)
}

/** True when any top-level segment runs a `cd` to a RELATIVE argument. */
function hasRelativeChange(segments: readonly LexSegment[]): boolean {
  for (const seg of segments) {
    if (seg.nested || seg.depth > 0) continue
    const at = commandWordAt(seg, false)
    if (at === -1) continue
    if (!DIR_COMMANDS.has(executableName(seg.words[at].text))) continue
    const args = seg.words.slice(at + 1).filter((w) => !w.redirected && !w.text.startsWith('-'))
    const arg = args[0]?.text
    if (arg === undefined || arg === '') continue
    if (!/^[\\/$]/.test(arg) && !/^[A-Za-z]:[\\/]/.test(arg)) return true
  }
  return false
}

/** Loop keywords, matched only where a command could start (see {@link startsLoop}). */
const LOOP_WORDS: ReadonlySet<string> = new Set(['for', 'foreach', 'while', 'until', 'select'])
/** Reserved words that may precede a loop keyword without being the command. */
const LOOP_LEADERS: ReadonlySet<string> = new Set([
  'then',
  'do',
  'else',
  'elif',
  'if',
  '!',
  '{',
  'time'
])

/**
 * True when the segment starts a loop: an unquoted loop keyword at command
 * position. A `for` inside a quoted message, a heredoc body or an argument is
 * prose, and poisoning the directory on it made every `cd docs && git commit -m
 * 'wait until done'` unresolvable.
 */
function startsLoop(seg: LexSegment, shell?: RedirectShell): boolean {
  for (const word of seg.words) {
    if (word.redirected || isAssignmentWord(word.text)) continue
    if (word.spans.length > 0) return false
    const text = word.text.toLowerCase()
    if (LOOP_WORDS.has(text)) {
      // PowerShell's `select` is Select-Object, and `foreach` after a pipe is
      // ForEach-Object: cmdlets, not loop statements.
      if (
        shell === 'powershell' &&
        (text === 'select' || (text === 'foreach' && seg.after === '|'))
      ) {
        return false
      }
      return true
    }
    if (!LOOP_LEADERS.has(text)) return false
  }
  return false
}

/** True when some top-level segment starts a loop (a `cd` in its body moves once per iteration). */
function hasLoopCommand(segments: readonly LexSegment[]): boolean {
  return segments.some((seg) => !seg.nested && startsLoop(seg))
}

/**
 * `\` right before whitespace or a separator. PowerShell reads a path
 * separator (`cd ..\; echo hi > x`), but the bash-style lexer reads an escape and
 * swallows the separator, so the `cd` segment grows past its real end and every
 * target in it resolves against the directory from BEFORE the `cd`.
 */
const TRAILING_BACKSLASH_RE = /\\(?=[\s;|&()<>])/

/**
 * True when a shell that may be PowerShell can read the command differently from
 * the lexer in a way that moves the directory: a trailing backslash next to a
 * directory change. The directory is then unknowable from the start (the segment
 * boundaries themselves are wrong), exactly like {@link CD_POISON_RE}.
 */
function psBackslashDirRisk(command: string, shell: RedirectShell | undefined): boolean {
  return shell !== 'posix' && TRAILING_BACKSLASH_RE.test(command) && hasDirWord(command)
}

/**
 * True when the command defines code that runs LATER — a shell function, a
 * `trap`, or a PowerShell script block kept in a variable. Its body is resolved
 * where it is written, but runs wherever the shell is when it is called.
 */
function definesDeferredBody(
  segments: readonly LexSegment[],
  command: string,
  shell: RedirectShell | undefined
): boolean {
  for (const seg of segments) {
    if (seg.nested) continue
    const plain = seg.words.filter((w) => !w.redirected)
    const last = plain[plain.length - 1]
    if (last === undefined) continue
    // `$sb = { … }` — a script block run later with `&` or `.`.
    if (shell !== 'posix' && seg.sepAfter === '{' && last.text.endsWith('=')) return true
    const first = plain.find((w) => !isAssignmentWord(w.text))
    if (first === undefined) continue
    const head = first.spans.length === 0 ? first.text.toLowerCase() : ''
    if (head === 'function' || head === 'filter' || head === 'trap') return true
    // `name() { … }`: the lexer ends the segment at `(`.
    if (seg.sepAfter === '(' && plain.length <= 2 && /^\s*\(\s*\)/.test(command.slice(last.end))) {
      return true
    }
  }
  return false
}

/**
 * True when running the command can change the directory somewhere other than a
 * plain top-level `cd` the walk follows — any directory word, or a word that
 * runs text in the current shell. Raw text on purpose: it only gates the
 * deferred-body check, which needs a function or `trap` as well.
 */
function mayChangeDirectory(command: string, segments: readonly LexSegment[]): boolean {
  if (hasDirWord(command)) return true
  return segments.some((seg) => {
    const at = commandWordAt(seg, false)
    return at !== -1 && EVAL_WORDS.has(executableName(seg.words[at].text))
  })
}

/**
 * True when a function, `trap` or script block is defined AND the command
 * changes directory anywhere. The body then runs from a directory the walk did
 * not place it in (`f() { echo hi > x.txt; }; cd ..; f`), so EVERY relative
 * target in the command is unresolvable.
 */
function deferredBodyRisk(
  command: string,
  segments: readonly LexSegment[],
  shell: RedirectShell | undefined
): boolean {
  return definesDeferredBody(segments, command, shell) && mayChangeDirectory(command, segments)
}

/**
 * True when the segment runs its command from another directory through a
 * wrapper — `env -C DIR cmd`, `env --chdir=DIR cmd`, `sudo -D DIR cmd`. The
 * wrapper's own shell stays where it was, but the wrapped command's relative
 * paths (`tee x.txt`) do not.
 */
function hasWrapperChdir(seg: LexSegment): boolean {
  const info = commandWordInfo(seg, false)
  const end = info.at === -1 ? seg.words.length : info.at
  const wrappers = new Set<string>()
  for (let i = 0; i < end; i++) {
    const word = seg.words[i]
    if (word.redirected || word.spans.length > 0) continue
    const text = word.text
    if (/^--chdir(=|$)/.test(text)) return true
    if (/^-[A-Za-z]*C/.test(text) && wrappers.has('env')) return true
    if (/^-[A-Za-z]*D/.test(text) && wrappers.has('sudo')) return true
    wrappers.add(executableName(text))
  }
  return false
}

/**
 * True when a double-quoted word of the segment holds a `$( … )` that changes
 * directory. In PowerShell the subexpression runs in the CURRENT scope, so the
 * `cd` inside it moves the shell (`Write-Host "$(Set-Location ..)"`); bash would
 * run it in a subshell, which is why only a shell that may be PowerShell asks.
 */
function hasSubexpressionDirWord(seg: LexSegment, command: string): boolean {
  for (const word of seg.words) {
    for (const span of word.spans) {
      if (span.quote !== '"') continue
      const text = command.slice(span.start, span.end)
      for (let at = text.indexOf('$('); at !== -1; at = text.indexOf('$(', at + 2)) {
        let depth = 0
        let end = text.length
        for (let k = at + 1; k < text.length; k++) {
          if (text[k] === '(') depth++
          else if (text[k] === ')' && --depth === 0) {
            end = k
            break
          }
        }
        if (hasDirWord(text.slice(at + 2, end))) return true
      }
    }
  }
  return false
}

/**
 * The single directory a `cd`-family segment names, or `null` when it is not
 * resolvable — no argument, `-`, `~`, more than one positional argument, a
 * variable or glob, a drive-relative spelling, or a `\` right before a newline
 * (bash's line continuation, whose continuation we did not read — Q2), a
 * `pushd +N` / `pushd -N` stack rotation, or, outside a known POSIX shell, a
 * splatted argument (`Set-Location @p` is `-Path` from a hashtable, not a
 * directory named `@p`).
 * Redirect words are not cd arguments (`pushd sub > /dev/null`).
 */
function directoryArgument(
  seg: LexSegment,
  at: number,
  platform: NodeJS.Platform,
  command: string,
  shell: RedirectShell | undefined
): string | null {
  const head = executableName(seg.words[at].text)
  const powershell = head === 'set-location' || head === 'sl' || head === 'push-location'
  const args = seg.words.slice(at + 1).filter((w) => !w.redirected)
  const positional: Array<{ text: string; end: number; quoted: boolean }> = []
  for (let i = 0; i < args.length; i++) {
    const text = args[i].text
    // `pushd +1` / `pushd -1` rotate the stack: the directory is an earlier entry.
    if (head === 'pushd' && /^[+-]\d+$/.test(text)) return null
    if (text.startsWith('-') && text.length > 1) {
      if (powershell) {
        const lower = text.toLowerCase()
        const colon = lower.indexOf(':')
        const flag = colon === -1 ? lower : lower.slice(0, colon)
        if (flag === '-path' || flag === '-literalpath') {
          if (colon !== -1) {
            positional.push({
              text: text.slice(colon + 1),
              end: args[i].end,
              quoted: args[i].spans.length > 0
            })
            continue
          }
          if (i + 1 < args.length) {
            positional.push({
              text: args[i + 1].text,
              end: args[i + 1].end,
              quoted: args[i + 1].spans.length > 0
            })
            i++
            continue
          }
        }
      }
      continue
    }
    positional.push({ text, end: args[i].end, quoted: args[i].spans.length > 0 })
  }
  if (positional.length !== 1) return null
  const arg = positional[0]
  if (arg.text === '' || arg.text === '-' || arg.text === '~') return null
  // PowerShell splatting: `Set-Location @p` takes its parameters from $p.
  if (shell !== 'posix' && !arg.quoted && arg.text.startsWith('@')) return null
  // A `\` right before a newline is bash's line continuation: the argument
  // continues on the next line, which we did not read, so where the cd lands is
  // unknowable (Q2).
  if (arg.text.endsWith('\\') && (command[arg.end] === '\n' || command[arg.end] === '\r')) {
    return null
  }
  const target = arg.text
  if (UNRESOLVABLE_CHARS.test(target)) return null
  if (isDriveRelative(target, platform)) return null
  return target
}

/** `C:x` (drive + colon + no separator) is drive-relative, not a path we can place. */
export function isDriveRelative(text: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' && /^[A-Za-z]:(?![\\/])/.test(text)
}

/**
 * One possibility for the shell that runs the rest of an and-or list (ruling 13):
 * where it is and whether the command that produced it succeeded. The list of
 * these REPLACES the round-2 candidate set: it follows the `&&`/`||`/`;`
 * semantics exactly instead of unioning blindly. (Ruling 18 dropped the temp
 * variables from this state: nothing expands for scope any more.)
 */
interface Possibility {
  /** The shell's directory, or `null` when it is unknowable (poisoned). */
  dir: string | null
  /** True when the command that produced this possibility succeeded. */
  ok: boolean
}

/**
 * One top-level segment's shell states: every possibility in force when it
 * starts (`at`, used when a target sits in a segment that provably never runs)
 * and the subset it actually RUNS in (`runs`, with the operator gating applied).
 * A redirect target in the segment resolves against every possibility it runs
 * in; it is in scope only when all of them are.
 */
interface ShellState {
  start: number
  at: readonly Possibility[]
  runs: readonly Possibility[]
}

/** What a shell state becomes once we can no longer follow it (ruling 4/13).
 *  Shared: it is never mutated, only read and replaced. */
const POISONED: readonly Possibility[] = [
  { dir: null, ok: true },
  { dir: null, ok: false }
]

/** The poisoned pair. */
function poisoned(): Possibility[] {
  return POISONED as Possibility[]
}

/** A stable key for de-duplicating possibilities (the walk must stay bounded). */
function possibilityKey(p: Possibility): string {
  return `${p.dir ?? '*'}\u0000${p.ok ? '1' : '0'}`
}

/**
 * De-duplicate the possibilities and, past the cap, fall back to a state we
 * cannot follow (poison) — the safe answer to "more branches than we model"
 * (ruling 8/13).
 */
function mergePossibilities(possibilities: readonly Possibility[]): readonly Possibility[] {
  if (possibilities.length <= 1) return possibilities
  const seen = new Set<string>()
  const unique: Possibility[] = []
  for (const possibility of possibilities) {
    const key = possibilityKey(possibility)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(possibility)
  }
  if (unique.length > MAX_SHELL_POSSIBILITIES) return POISONED
  // The common all-unknown state is shared so the walk can short-circuit.
  if (unique.length === POISONED.length && unique.every((p) => p.dir === null)) {
    return POISONED
  }
  return unique
}

/** The possibilities a segment runs in, given the operator before it (ruling 13):
 *  `&&` runs only after success, `||` only after failure, everything else always. */
function runnableFrom(
  possibilities: readonly Possibility[],
  op: SegmentOp
): readonly Possibility[] {
  if (op === '&&') return possibilities.filter((p) => p.ok)
  if (op === '||') return possibilities.filter((p) => !p.ok)
  return possibilities
}

/**
 * The operator that decides whether a segment runs. Normally the one before it;
 * but the first member of a group (`a && ( b )`) and what follows a group's
 * closer (`a && { b; } > f`) are reached through group punctuation, and the
 * group runs exactly when the operator before IT admits it (the lexer keeps that
 * one as `gate`).
 */
function gatingOp(seg: LexSegment): SegmentOp {
  const op = seg.after
  return op === '(' || op === '{' || op === ')' || op === '}' ? seg.gate : op
}

/** True when the segment could place a poisoned shell again: a `cd`-family word
 *  with an absolute path argument (a cheap pre-check before resolving the cd). */
function mayClearPoison(seg: LexSegment): boolean {
  const at = commandWordAt(seg, false)
  if (at === -1) return false
  if (!DIR_COMMANDS.has(executableName(seg.words[at].text))) return false
  return seg.words.some((w) => !w.redirected && /^[\\/$]|^[A-Za-z]:[\\/]/.test(w.text))
}

/**
 * The one possibility a segment runs from becomes one or two possibilities
 * (ruling 13):
 *
 * - a resolvable `cd X` → `{X, ok}` and `{old dir, fail}` (the cd may fail);
 * - any other command → `{dir, ok}` and `{dir, fail}`;
 * - an unknowable move (`popd`, `cd -`, `eval`, a cd inside a group)
 *   → the poisoned pair (`dir` unknown).
 */
function segmentOutcomes(
  seg: LexSegment,
  from: Possibility,
  platform: NodeJS.Platform,
  command: string,
  shell: RedirectShell | undefined
): Possibility[] {
  const unchanged = (): Possibility[] => [
    { dir: from.dir, ok: true },
    { dir: from.dir, ok: false }
  ]

  // A `$( ... )` in double quotes that changes directory moves a PowerShell
  // shell: the subexpression runs in the current scope.
  if (shell !== 'posix' && hasSubexpressionDirWord(seg, command)) return poisoned()

  const at = commandWordAt(seg, false)
  const head = at === -1 ? '' : executableName(seg.words[at].text)

  // A directory-changing word that is not this segment's own head, or that sits
  // inside a group, moves a shell we cannot follow (ruling 4).
  for (let i = 0; i < seg.words.length; i++) {
    if (seg.words[i].redirected) continue
    const names = commandNames(seg.words[i].text)
    if (!names.some((n) => DIR_COMMANDS.has(n) || DIR_POISON.has(n))) continue
    if (i !== at || seg.depth > 0) return poisoned()
  }

  if (seg.depth > 0) {
    // A real group (`( … )`, `{ …; }`) has an exit status we cannot know, so it
    // yields BOTH statuses — `cd dir && (false) || fallback > f` runs the
    // fallback in `dir` (ruling 15). A brace EXPANSION (`{a,b}`) is not a group
    // at all: the lexer split it as if it were, so the entry status stands and a
    // fragment cannot flip a failed branch to successful.
    if (!isRealGroup(seg, command)) {
      return [{ dir: from.dir, ok: from.ok }]
    }
    return unchanged()
  }

  if (DIR_POISON.has(head)) return poisoned()
  if (EVAL_WORDS.has(head)) return poisoned()
  if (DIR_COMMANDS.has(head)) {
    const arg = directoryArgument(seg, at, platform, command, shell)
    if (arg === null) return poisoned()
    // An absolute `cd` is placeable even from a poisoned directory, which is how
    // a poisoned state gets cleared for `&&`-joined segments (ruling 4).
    if (from.dir === null && !isAbsolutePosixish(toPosixish(arg, platform), platform)) {
      return poisoned()
    }
    const moved = resolveTarget(from.dir ?? '/', arg, platform).full
    return [
      { dir: moved, ok: true },
      { dir: from.dir, ok: false }
    ]
  }

  return unchanged()
}

/**
 * True when a `depth > 0` fragment belongs to a REAL command group rather than
 * to a brace expansion the lexer read as one (ruling 15).
 *
 * `(` always opens a group. `{` opens a bash brace group only as a word of its
 * own — whitespace after it — while `game/{A,B}.cs` is a single word.
 */
function isRealGroup(seg: LexSegment, command: string): boolean {
  if (seg.after === '(') return true
  if (seg.after !== '{') return true
  const after = command[seg.start]
  return after === undefined || /\s/.test(after)
}

/**
 * Walk the top-level segments in order, carrying the set of shell possibilities
 * after each one (ruling 13).
 *
 * `&&`/`||`/`;` are followed exactly: a command runs only in the branches its
 * operator admits, so `cd a/b && true; echo > ../../x` remembers that the cd may
 * have failed, while `cd a/b && make && echo > ../../x` cannot. A background
 * segment (`&`) or a pipeline member runs in a subshell: its cd does not change
 * the parent (pipelines union changed and unchanged — a safe superset for
 * PowerShell). A pipeline, or a group, that follows `&&`/`||` runs only in the
 * branches that operator admits, whichever member a target sits in. Temp
 * variables play no part: nothing expands for scope (ruling 18).
 *
 * When the lexer could not trust the quote structure nothing is tracked (the
 * caller falls back to `relativeUnknown`).
 *
 * Residuals (documented, not modelled): CDPATH is ignored, so a relative `cd`
 * argument not starting with `./` or `../` could resolve under CDPATH (C-C);
 * a second heredoc body maps to the directory of the position where its body
 * sits, not where its `<<` appeared (C-D).
 */
function shellStates(
  command: string,
  lexed: LexedCommand,
  segments: readonly LexSegment[],
  platform: NodeJS.Platform,
  initialCwd: string | null,
  shell: RedirectShell | undefined
): ShellState[] {
  const states: ShellState[] = []
  if (!lexed.balanced) return states
  // A relative `cd` inside a loop body moves once per iteration, which we do not
  // model: poison the directory so every later relative target is unresolvable
  // (C-A). Only a loop keyword at command position counts (see {@link startsLoop}).
  const loopRisk = hasLoopCommand(segments) && hasRelativeChange(segments)
  const lexRisk = CD_POISON_RE.test(command) || psBackslashDirRisk(command, shell)
  let possibilities: readonly Possibility[] = [
    { dir: initialCwd === null || loopRisk || lexRisk ? null : initialCwd, ok: true }
  ]
  // The pipeline being walked: what its members run from (`active`) and the
  // branches an `&&`/`||` in front of it kept it out of (`skipped`).
  let pipe: { skipped: readonly Possibility[]; active: readonly Possibility[] } | null = null

  for (const seg of segments) {
    // A re-lexed span/heredoc body runs in its own shell (or is text): its cd
    // never changes the parent's possibilities. A nested `cd` still makes
    // targets INSIDE it unknowable through `dirRegions`.
    if (seg.nested) continue
    // `a && b | c` is `a && (b | c)`: a pipeline member runs wherever the
    // pipeline started, not in the branches the `&&` kept it out of.
    const member = seg.after === '|' && pipe !== null
    const runs = member && pipe !== null ? pipe.active : runnableFrom(possibilities, gatingOp(seg))
    // `env -C DIR cmd` runs the command's relative paths from another directory
    // without moving this shell: only THIS segment's targets are unknowable.
    states.push({
      start: seg.start,
      at: possibilities,
      runs: hasWrapperChdir(seg) ? POISONED : runs
    })
    const untouched =
      member && pipe !== null ? pipe.skipped : possibilities.filter((p) => !runs.includes(p))
    const pipelines = seg.sepAfter === '|'
    if (runs.length === 0) {
      pipe = pipelines ? { skipped: untouched, active: [] } : null
      continue
    }
    // A poisoned state stays poisoned unless an absolute cd can place it again:
    // the common case in a long command (the cap was hit), so skip the work.
    if (!member && possibilities === POISONED && !mayClearPoison(seg)) {
      pipe = null
      continue
    }

    const produced: Possibility[] = []
    const subshell = seg.after === '|' || pipelines || seg.sepAfter === '&'
    for (const from of runs) {
      if (seg.sepAfter === '&') {
        // Background: the parent keeps its state and continues with status ok.
        produced.push({ dir: from.dir, ok: true })
        continue
      }
      const outcomes = segmentOutcomes(seg, from, platform, command, shell)
      if (subshell) {
        // A pipeline member may run in the same shell in one dialect: keep both
        // the changed and the unchanged branch, a safe superset (ruling 13).
        produced.push({ dir: from.dir, ok: from.ok })
      }
      produced.push(...outcomes)
    }
    pipe = pipelines ? { skipped: untouched, active: mergePossibilities(produced) } : null
    possibilities = mergePossibilities([...untouched, ...produced])
  }
  return states
}

/** The state in force at `pos`: the last segment that starts at or before it. */
function stateAt(states: readonly ShellState[], pos: number): ShellState | undefined {
  // `states` is in document order, so this is a binary search for the last
  // start at or before `pos` (the quote-blind cross-check can ask thousands of times).
  let found: ShellState | undefined
  let lo = 0
  let hi = states.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (states[mid].start <= pos) {
      found = states[mid]
      lo = mid + 1
    } else hi = mid - 1
  }
  return found
}

/** The deepest scope root that CONTAINS `target` (proper descendant, as before). */
function deepestRoot(
  roots: readonly string[],
  target: string,
  platform: NodeJS.Platform
): string | undefined {
  let best: string | undefined
  for (const root of roots) {
    if (!isDescendant(root, target, platform)) continue
    if (best === undefined || root.length > best.length) best = root
  }
  return best
}

/** The scope roots, in the one spelling and de-duplication the whole file uses. */
function scopeRoots(scope: RedirectScope, platform: NodeJS.Platform): string[] {
  return [scope.cwd, ...(scope.tempDirs ?? []), ...(scope.additionalDirectories ?? [])]
    .filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
    .map((r) => normalizePath(r, platform).full)
    .filter((r, i, all) => all.indexOf(r) === i)
}

/** Components of `target` below `root`, or undefined when it is not under it. */
function relativeComponentsUnder(
  root: string,
  target: string,
  platform: NodeJS.Platform
): string[] | undefined {
  const trimmed = root.replace(/\/+$/, '')
  const fold = (s: string): string => (platform === 'win32' ? s.toLowerCase() : s)
  if (!fold(target).startsWith(`${fold(trimmed)}/`)) return undefined
  return target
    .slice(trimmed.length + 1)
    .split('/')
    .filter((c) => c.length > 0)
}

/**
 * The spellings the reader of `command` could take a raw target as (ruling 6/12).
 *
 * With a dialect, the reading is that dialect's alone: PowerShell has no
 * backslash escapes (`D:\work\app\x` is a path), while bash removes an
 * unquoted backslash before an ordinary character (`CLA\UDE.md` is `CLAUDE.md`).
 * With no dialect, keep BOTH readings and let the worse one win, as before.
 */
function targetReadings(
  raw: string,
  quoted: boolean | undefined,
  shell: RedirectShell | undefined
): string[] {
  // Inside quotes bash removes only `\"`, `\$`, `` \` ``, `\\` (already resolved
  // by the lexer), so a quoted word has no second reading.
  if (quoted || !raw.includes('\\')) return [raw]
  const bash = raw.replace(/\\(.)/g, '$1')
  const hasBashReading = bash !== raw && bash.length > 0
  if (shell === 'powershell') return [raw]
  if (shell === 'posix') return hasBashReading ? [bash] : [raw]
  // No dialect named: as before, a Windows absolute spelling is not re-read and
  // both readings are kept so the worse one is reported.
  if (/^[A-Za-z]:[\\/]/.test(raw) || raw.includes(':\\')) return [raw]
  return hasBashReading ? [raw, bash] : [raw]
}

/**
 * Resolve ONE as-written target into the details the analysis reports: one per
 * shell-state possibility it runs in and per backslash reading, plus an
 * unresolvable marker when any reading cannot be placed. Never drops a target
 * (ruling 6/13).
 *
 * Nothing is expanded (ruling 18): a target carrying `$`, a backtick, `~`, a
 * glob char or `%` is unresolvable, exactly as HEAD reported it. Such a target
 * MAY carry the non-authoritative `tempVarPath` hint. The hint never promotes a
 * variable target into scope; unsupported spellings omit it.
 */
function resolveOneTarget(
  target: RawTarget,
  ctx: {
    scope: RedirectScope
    platform: NodeJS.Platform
    roots: readonly string[]
    cwd: string
    state: ShellState
    dirRegions: ReadonlyArray<[number, number]>
    relativeUnknown: boolean
    tempBindings: readonly TempHintBinding[]
    /** The whole command, for the hint's assignment check; '' withholds every hint. */
    command: string
  }
): RedirectTargetDetail[] {
  const out: RedirectTargetDetail[] = []
  const seen = new Set<string>()
  let unresolved = false

  const addResolved = (full: string, base: string, shellDrive?: string | null): void => {
    const key = `${full}\u0000${shellDrive ?? ''}`
    if (seen.has(key)) return
    seen.add(key)
    const viaCwd = relativeComponentsUnder(ctx.cwd, full, ctx.platform)
    const components = viaCwd ?? normalizePath(full, ctx.platform).components
    const root = deepestRoot(ctx.roots, full, ctx.platform)
    out.push({
      raw: target.raw,
      path: full,
      append: target.append,
      ...(root === undefined ? {} : { root }),
      protectedHits: protectedComponentsOf(components),
      base,
      ...(shellDrive === undefined ? {} : { shellDrive })
    })
  }

  const possibilities = ctx.state.runs.length > 0 ? ctx.state.runs : ctx.state.at
  for (const reading of targetReadings(target.raw, target.quoted, ctx.scope.shell)) {
    if (target.unreadable === true || reading.length === 0) {
      unresolved = true
      continue
    }
    const posix = toPosixish(reading, ctx.platform)
    if (isDriveRelative(reading, ctx.platform) || isDriveRelative(posix, ctx.platform)) {
      unresolved = true
      continue
    }
    // A quote-hidden phantom name (`list[int]:`, `**Note**`) is a literal relative
    // name: its glob characters are not expanded (see isPhantomLiteralName).
    if (target.literalName !== true && UNRESOLVABLE_CHARS.test(reading)) {
      unresolved = true
      continue
    }
    if (isAbsolutePosixish(posix, ctx.platform)) {
      const absolute = normalizePath(reading, ctx.platform)
      // A drive-less rooted path is drive-relative in PowerShell: `/tmp/x` is
      // `<shell drive>:/tmp/x`. Keep the drive(s) the shell state allows so the
      // physical measurement reads the right place (exit review R4). A drive we
      // cannot establish is carried as `null` and withholds a clean scope.
      const drives = rootedShellDrives(absolute.full, ctx.scope.shell, possibilities, ctx.platform)
      for (const drive of drives) {
        addResolved(absolute.full, driveOrRoot(absolute.full, ctx.platform), drive)
      }
      continue
    }
    if (
      ctx.relativeUnknown ||
      ctx.dirRegions.some(([start, end]) => target.pos >= start && target.pos < end)
    ) {
      unresolved = true
      continue
    }
    let unknownDir = false
    for (const possibility of possibilities) {
      if (possibility.dir === null) {
        unknownDir = true
        continue
      }
      addResolved(resolveTarget(possibility.dir, reading, ctx.platform).full, possibility.dir)
    }
    if (unknownDir) unresolved = true
  }

  if (unresolved || out.length === 0) {
    const hint =
      ctx.command === ''
        ? undefined
        : tempHintFor(
            target.raw,
            target.hintLiteral,
            ctx.scope.shell,
            ctx.scope.tempVars ?? {},
            ctx.tempBindings,
            target.pos,
            ctx.platform,
            ctx.command
          )
    let shellDrive: string | null | undefined
    if (
      hint !== undefined &&
      ctx.platform === 'win32' &&
      hint.path.startsWith('/') &&
      ctx.scope.shell !== 'posix'
    ) {
      // A rooted temp hint is drive-relative in PowerShell too. A single known
      // drive can be measured; several possible drives are ambiguous, so the
      // hint is withheld rather than checked at the start drive only.
      const drives = rootedShellDrives(hint.path, ctx.scope.shell, possibilities, ctx.platform)
      shellDrive = drives.length === 1 && typeof drives[0] === 'string' ? drives[0] : null
    }
    out.push({
      raw: target.raw,
      append: target.append,
      protectedHits: protectedComponentsOf(rawComponentsForProtection(target.raw)),
      ...(hint === undefined ? {} : { tempVarPath: hint.path, tempVarSpelling: hint.spelling }),
      ...(shellDrive === undefined ? {} : { shellDrive })
    })
  }
  return out
}

/**
 * The shell drives a drive-less rooted target may run on. A target that already
 * names a drive is independent of the current directory, and a known POSIX shell
 * folds `/tmp` through its own mount instead; both need no drive list.
 */
function rootedShellDrives(
  full: string,
  shell: RedirectShell | undefined,
  possibilities: readonly Possibility[],
  platform: NodeJS.Platform
): (string | null | undefined)[] {
  if (platform !== 'win32' || shell === 'posix' || !full.startsWith('/')) return [undefined]
  const drives: (string | null)[] = []
  const add = (drive: string | null): void => {
    if (!drives.some((d) => d === drive)) drives.push(drive)
  }
  for (const possibility of possibilities) {
    if (possibility.dir === null) {
      add(null)
      continue
    }
    const match = /^([a-z]:)\//i.exec(normalizePath(possibility.dir, platform).full)
    add(match ? match[1].toLowerCase() : null)
  }
  return drives.length === 0 ? [null] : drives
}

/**
 * Components of an unreadable target, for the protected-name check only: split
 * on both separators and on whitespace, then drop the quote characters, so a
 * path inside a subexpression (`(Join-Path $env:USERPROFILE '.ssh\\keys')`)
 * still names `.ssh`.
 */
function rawComponentsForProtection(raw: string): string[] {
  const out: string[] = []
  // A brace expansion (`~/{.bashrc,.profile}`, `{.git,x}/config`) names every
  // alternative, so each expanded spelling is read for its components.
  for (const spelling of expandBraces(raw)) {
    for (const component of spelling.split(/[\\/\s]+/)) {
      const bare = component.replace(/^['"]+|['"]+$/g, '')
      if (bare.length > 0 && !out.includes(bare)) out.push(bare)
    }
  }
  return out
}

/** How many spellings {@link expandBraces} will produce before it gives up. */
const MAX_BRACE_SPELLINGS = 64

/**
 * The spellings a bash comma brace expansion names: `{.git,x}/config` →
 * `.git/config`, `x/config`. Nested lists expand too. A `{…}` with no top-level
 * comma (`{a..b}`, `${HOME}`, `{x}`) is left as written. Past
 * {@link MAX_BRACE_SPELLINGS} the text is returned unexpanded, with every brace
 * and comma turned into a separator so that each alternative still shows up as a
 * component of its own (a superset: it can over-report a component, never hide one).
 */
function expandBraces(text: string): string[] {
  const expanded = expandBracesBounded(text)
  return expanded ?? [text.replace(/[{},]/g, '/')]
}

function expandBracesBounded(text: string): string[] | null {
  let open = -1
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{' && text[i - 1] !== '$') {
      open = i
      break
    }
  }
  if (open === -1) return [text]
  // Find the matching close and the top-level commas between.
  let depth = 0
  let close = -1
  const commas: number[] = []
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) {
        close = i
        break
      }
    } else if (text[i] === ',' && depth === 1) commas.push(i)
  }
  if (close === -1) return [text]
  const prefix = text.slice(0, open)
  const suffix = text.slice(close + 1)
  if (commas.length === 0) {
    // Not an expansion: keep the braces as text and expand what follows.
    const rest = expandBracesBounded(suffix)
    return rest === null ? null : rest.map((s) => `${prefix}${text.slice(open, close + 1)}${s}`)
  }
  const bounds = [open, ...commas, close]
  const out: string[] = []
  for (let k = 0; k + 1 < bounds.length; k++) {
    const alt = text.slice(bounds[k] + 1, bounds[k + 1])
    const tails = expandBracesBounded(`${alt}${suffix}`)
    if (tails === null) return null
    for (const tail of tails) {
      out.push(`${prefix}${tail}`)
      if (out.length > MAX_BRACE_SPELLINGS) return null
    }
  }
  return out
}

/** The drive root of an absolute normalized path (`/` or `d:/`). */
function driveOrRoot(full: string, platform: NodeJS.Platform): string {
  const m = platform === 'win32' ? /^([a-z]:)\//.exec(full) : null
  return m ? `${m[1]}/` : '/'
}

/**
 * Every file target of `command` with its pure facts — the whole input P2a-2
 * measures. `null` exactly when {@link analyzeRedirects} returns `null` (no file
 * target, more than {@link MAX_REDIRECT_TARGETS} of them, a command longer than
 * {@link MAX_ANALYZE_COMMAND_LENGTH}, or more quote-hidden operators than the
 * cross-check will read).
 *
 * Besides the quote-aware targets, the list carries the QUOTE-BLIND CROSS-CHECK's
 * details ({@link quoteHiddenTargets}), marked `quoted`: `>` operators the
 * quote-aware scan read as text and that are not cleanly in scope. A command whose
 * only targets are such details is NOT `null`.
 *
 * Stays pure and synchronous: no fs, no env (the host's temp values arrive in
 * `scope.tempVars`), `platform` injected.
 */
export function redirectTargetDetails(
  command: string,
  scope: RedirectScope,
  platform: NodeJS.Platform = process.platform
): RedirectTargetDetail[] | null {
  if (command.length > MAX_ANALYZE_COMMAND_LENGTH) return null
  const lexed = lexCommand(command)
  const collected = collectTargets(command, lexed)
  const found = collected.targets.slice()
  for (const seg of collected.segments) {
    found.push(...writerTargets(seg, command, scope.shell, platform))
  }
  found.sort((a, b) => a.pos - b.pos)
  if (found.length > MAX_REDIRECT_TARGETS) return null
  // The quote-blind cross-check: `>` operators the quote-aware scan read as text.
  const hidden = quoteHiddenTargets(command, collected.targets)
  if (hidden === null) return null
  if (found.length === 0 && hidden.length === 0) return null

  const roots = scopeRoots(scope, platform)
  const cwd = normalizePath(scope.cwd, platform).full
  const initialCwd =
    scope.shellCwd === null ? null : normalizePath(scope.shellCwd ?? scope.cwd, platform).full
  const states = shellStates(command, lexed, collected.segments, platform, initialCwd, scope.shell)
  const initialPossibilities: Possibility[] = [{ dir: initialCwd, ok: true }]
  const initial: ShellState = {
    start: 0,
    at: initialPossibilities,
    runs: initialPossibilities
  }
  // When the lexer could not trust the quote structure, a directory change
  // anywhere makes every relative target unknowable (ruling 4 / R6). So does a
  // function, `trap` or script block that runs later, from wherever the shell
  // is by then, when the command also changes directory.
  const relativeUnknown =
    (!lexed.balanced && hasDirWord(command)) ||
    deferredBodyRisk(command, collected.segments, scope.shell)
  // The hint's bindings, collected once so the per-target lookup stays linear.
  // Withheld entirely when the command could change a variable without a plain
  // assignment; a binding assigned more than once is no binding at all.
  const hintsAllowed =
    scope.shell !== undefined &&
    !hintTainted(command, lexed.balanced, collected.segments, scope.shell)
  const tempBindings = hintsAllowed
    ? tempHintBindings(collected.segments, scope.shell, scope.tempVars ?? {}, command).filter(
        (binding) => assignmentCount(command, binding.name, scope.shell as RedirectShell) === 1
      )
    : []

  const details: RedirectTargetDetail[] = []
  for (const target of found) {
    if (target.raw.length > 0 && isSink(target.raw, platform, scope.shell)) continue
    const state = stateAt(states, target.pos) ?? initial
    details.push(
      ...resolveOneTarget(target, {
        scope,
        platform,
        roots,
        cwd,
        state,
        dirRegions: collected.dirRegions,
        relativeUnknown,
        tempBindings,
        command: hintsAllowed ? command : ''
      })
    )
  }

  // Each quote-hidden operator resolves exactly like a real target (the shell
  // states it would run in, the same roots and protected check), and survives only
  // when it is NOT cleanly in scope — a clean one is a harmless phantom, which is
  // what keeps the false-block gains of the quote-aware scan. Readings are
  // memoised by spelling and shell-state content, so a document full of `a > b`
  // costs one resolution per distinct spelling.
  if (hidden.length > 0) {
    const hiddenDir = hasHiddenDirWord(command, collected.segments)
    const signatures = new Map<ShellState, string>()
    const seen = new Set<string>()
    const listed = new Set<string>()
    for (const target of hidden) {
      if (isSink(target.raw, platform, scope.shell)) continue
      const state = stateAt(states, target.pos) ?? initial
      let signature = signatures.get(state)
      if (signature === undefined) {
        signature = (state.runs.length > 0 ? state.runs : state.at).map(possibilityKey).join('|')
        signatures.set(state, signature)
      }
      const key = `${target.raw}\u0000${target.append}\u0000${target.quoted === true}\u0000${signature}`
      if (seen.has(key)) continue
      if (seen.size >= MAX_HIDDEN_KEYS) return null
      seen.add(key)
      for (const detail of resolveOneTarget(target, {
        scope,
        platform,
        roots,
        cwd,
        state,
        dirRegions: collected.dirRegions,
        relativeUnknown: relativeUnknown || hiddenDir,
        tempBindings: [],
        command: ''
      })) {
        if (isCleanInScope(detail)) continue
        details.push({ ...detail, quoted: true })
        listed.add(detail.raw)
      }
      // Enough to say so: every one of these makes `allInScope` false, and a
      // longer list would only cost the judge tokens.
      if (listed.size >= MAX_REDIRECT_TARGETS) break
    }
  }
  return details.length === 0 ? null : details
}

/**
 * Fold target details plus whatever P2a-2 measured into the meta contract.
 *
 * A `symlinked` target is listed ONLY in `symlinked` (dropped from
 * `outOfScope`) and makes `allInScope` false: the resolved path is not the file
 * that would be written. Measured fields are emitted only when present, and
 * `empty`/`modifiedSinceSessionStart` only for an existing target.
 *
 * `tempVarTargets` is a HINT (ruling 18): it copies the `tempVarPath` of each
 * unresolvable detail and never touches `allInScope`, `outOfScope` or
 * `unresolvable`.
 *
 * A detail marked `quoted` (found only by the quote-blind cross-check) is
 * reported in `quotedTargets` and NOWHERE else — not in `targets`, `outOfScope`,
 * `unresolvable`, `protectedHits` or `symlinked` — so the judge can tell
 * "probably text" from "definitely a write". It still makes `allInScope` false,
 * unless measurement proved it clean after all (resolved in scope through a link,
 * unprotected, not itself a link).
 *
 * `unmeasured` lists the raw spelling of every target that would read in scope but
 * whose containment could not be established (`reviewRequired`), so that
 * `allInScope: false` with every other list empty is no longer unexplained. An
 * out-of-scope target is never listed: `outOfScope` already names it.
 *
 * A raw target may appear in several details (shell-state possibilities,
 * backslash readings): `targets` and `unresolvable` are de-duplicated by the RAW
 * spelling, `outOfScope` by the resolved path, so `> x/../y` after a `;`-joined
 * `cd` lists each distinct place it could write.
 */
export function summarizeRedirects(
  allDetails: readonly RedirectTargetDetail[],
  measured?: ReadonlyMap<string, RedirectMeasurement>
): RedirectAnalysis {
  const details = allDetails.filter((detail) => detail.quoted !== true)
  const quotedTargets = quotedTargetsOf(allDetails, measured)
  const unmeasured: string[] = []
  const targets: string[] = []
  const unresolvable: string[] = []
  const protectedHits: string[] = []
  const outOfScope: RedirectOutOfScopeTarget[] = []
  const symlinked: string[] = []
  const tempVarTargets: RedirectTempVarTarget[] = []
  const groups = new Map<
    string,
    { path: string; append: boolean; measured?: RedirectMeasurement; order: number }
  >()
  let reviewRequired = false
  const hintGroups = new Map<
    string,
    { target: string; paths: Set<string>; veto: boolean; order: number }
  >()

  for (const detail of details) {
    if (!targets.includes(detail.raw)) targets.push(detail.raw)
    if (detail.path === undefined && !unresolvable.includes(detail.raw)) {
      unresolvable.push(detail.raw)
    }
    if (detail.path === undefined) {
      // A raw target can appear several times (two writes, two readings). The
      // clearing hint is published only when EVERY occurrence has a validated
      // hint naming the SAME destination; one literal/unsafe occurrence vetoes
      // it (exit review R1/N7 aggregation).
      let group = hintGroups.get(detail.raw)
      if (group === undefined) {
        group = {
          target: detail.raw,
          paths: new Set(),
          veto: false,
          order: hintGroups.size
        }
        hintGroups.set(detail.raw, group)
      }
      if (detail.tempVarPath === undefined) group.veto = true
      else group.paths.add(detail.tempVarPath)
    }
    if (detail.reviewRequired === true) {
      reviewRequired = true
      // Only a target that would otherwise read IN scope: an out-of-scope one is already
      // listed in `outOfScope`, where a missing `exists`/`empty` already means "not measured".
      // Listing it here too told the judge its location was unknown, which it is not.
      const outOfScopeTarget = detail.path !== undefined && detail.root === undefined
      if (!outOfScopeTarget && !unmeasured.includes(detail.raw)) unmeasured.push(detail.raw)
    }
    for (const hit of detail.protectedHits) {
      if (!protectedHits.includes(hit)) protectedHits.push(hit)
    }
  }
  for (const group of [...hintGroups.values()].sort((a, b) => a.order - b.order)) {
    if (group.veto || group.paths.size !== 1) continue
    tempVarTargets.push({ target: group.target, path: [...group.paths][0] })
  }
  for (const detail of details) {
    if (detail.path === undefined) continue
    const seen = measured?.get(detail.path)
    // A link is not the file that would be written, in scope or out of it.
    if (seen?.symlinked === true) {
      if (!symlinked.includes(detail.raw)) symlinked.push(detail.raw)
      continue
    }
    if (detail.root !== undefined) continue
    const prior = groups.get(detail.path)
    if (prior === undefined) {
      groups.set(detail.path, {
        path: detail.path,
        append: detail.append,
        ...(seen === undefined ? {} : { measured: seen }),
        order: outOfScope.length
      })
      outOfScope.push({ path: detail.path })
    } else {
      // Every possible write to the same resolved path must be append-only for
      // the clearing `append:true` fact to be true (exit review R7).
      prior.append = prior.append && detail.append
      if (prior.measured === undefined && seen !== undefined) prior.measured = seen
    }
  }
  for (const group of groups.values()) {
    const entry = outOfScope[group.order]
    if (group.append) entry.append = true
    const seen = group.measured
    if (seen?.exists !== undefined) entry.exists = seen.exists
    if (seen?.exists === true && seen.empty !== undefined) entry.empty = seen.empty
    if (seen?.exists === true && seen.modifiedSinceSessionStart !== undefined) {
      entry.modifiedSinceSessionStart = seen.modifiedSinceSessionStart
    }
  }

  const analysis: RedirectAnalysis = {
    targets,
    allInScope:
      outOfScope.length === 0 &&
      unresolvable.length === 0 &&
      protectedHits.length === 0 &&
      symlinked.length === 0 &&
      quotedTargets.length === 0 &&
      !reviewRequired,
    outOfScope,
    unresolvable,
    protectedHits
  }
  if (symlinked.length > 0) analysis.symlinked = symlinked
  if (tempVarTargets.length > 0) analysis.tempVarTargets = tempVarTargets
  if (quotedTargets.length > 0) analysis.quotedTargets = quotedTargets
  if (unmeasured.length > 0) analysis.unmeasured = unmeasured
  return analysis
}

/**
 * The raw spellings of the `quoted` details that are not cleanly in scope, once
 * measurement has had its say: a quote-hidden target that measurement proved to
 * resolve in scope (through a link), unprotected and not itself a link is the same
 * harmless phantom the pure stage already drops. De-duplicated by spelling and
 * shown at most {@link MAX_QUOTED_RAW_LENGTH} characters, at most
 * {@link MAX_REDIRECT_TARGETS} of them.
 */
function quotedTargetsOf(
  details: readonly RedirectTargetDetail[],
  measured: ReadonlyMap<string, RedirectMeasurement> | undefined
): string[] {
  const out: string[] = []
  for (const detail of details) {
    if (detail.quoted !== true) continue
    const linked = detail.path !== undefined && measured?.get(detail.path)?.symlinked === true
    if (!linked && isCleanInScope(detail)) continue
    const shown =
      detail.raw.length > MAX_QUOTED_RAW_LENGTH
        ? `${detail.raw.slice(0, MAX_QUOTED_RAW_LENGTH)}…`
        : detail.raw
    if (!out.includes(shown)) out.push(shown)
    if (out.length >= MAX_REDIRECT_TARGETS) break
  }
  return out
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
 * redirect at all, has more than {@link MAX_REDIRECT_TARGETS} of them, or is
 * longer than {@link MAX_ANALYZE_COMMAND_LENGTH}, or has more quote-hidden `>`
 * operators than the cross-check will read ({@link MAX_HIDDEN_OPERATORS}). As
 * everywhere in this file, saying nothing is the fallback; the one thing that
 * must never happen is a fabricated `allInScope: true`.
 *
 * It is NOT `null` when the quote-aware scan found no redirect but the
 * quote-blind cross-check found a quote-hidden `>` that is not cleanly in scope:
 * `targets` is then empty and `quotedTargets` names it.
 */
export function analyzeRedirects(
  command: string,
  scope: RedirectScope,
  platform: NodeJS.Platform = process.platform
): RedirectAnalysis | null {
  const details = redirectTargetDetails(command, scope, platform)
  return details === null ? null : summarizeRedirects(details)
}

/**
 * The temp roots a redirect may legitimately write to. Read from the env rather
 * than hard-coded so a session running under a sandboxed `TMPDIR` is judged
 * against the temp dir it actually has — plus the conventional `/tmp`, because
 * on macOS every env spelling points at the per-user `/var/folders/…/T` and
 * `> /tmp/x`, the commonest scratch idiom there is, would otherwise always
 * measure out-of-scope. `/private/tmp` too: `/tmp` is a symlink to it on macOS
 * and scope matching compares spellings, never resolves links.
 *
 * On win32 `/tmp` is a root as well: pi's bash there is Git Bash, whose `/tmp`
 * is the user temp dir (usertemp mount), and in PowerShell it is
 * `<drive>:\tmp` scratch. Either way it is scratch space, not a protected path,
 * and `/tmp/x` resolves as `/tmp/x` (no drive fold — `/t…` is not the MSYS
 * `/c/…` form).
 */
export function tempDirRoots(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string[] {
  let osTemp: string | undefined
  try {
    // The host's temp dir only describes the host's platform: asked about
    // another one (tests do), it would answer `/tmp` for win32 on a Linux box.
    if (platform === process.platform) osTemp = tmpdir()
  } catch {
    // Never throw out of the approval path for a missing temp dir; one fewer
    // scope root only ever costs an escalation.
  }
  const conventional =
    platform === 'win32' ? ['/tmp'] : platform === 'darwin' ? ['/tmp', '/private/tmp'] : ['/tmp']
  const candidates = [osTemp, env.TMPDIR, env.TEMP, env.TMP, ...conventional]
  return [...new Set(candidates.filter((v): v is string => !!v && v.trim().length > 0))]
}

/**
 * The host temp-dir VARIABLES that are set — the path a target written
 * `$TMPDIR/x` or `$env:TEMP\x` normally names. Used only to word the
 * non-authoritative `tempVarTargets` hint (ruling 18): nothing expands for scope. Only variables the host actually has: an unset
 * one keeps the target unresolvable rather than guessing a path.
 */
export function tempVarValues(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of ['TMPDIR', 'TEMP', 'TMP']) {
    const value = env[name]
    if (typeof value === 'string' && value.trim().length > 0) out[name] = value
  }
  return out
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

// ── Repo-armed git config (ADR-084 §2) ────────────────────────────────────────

/**
 * Does this command run git in any segment? The trigger for the
 * {@link captureGitConfigArmed} meta line, read with the same naive segment
 * parser as the other detectors (a stray quote can cost a meta line, never
 * invent one).
 */
export function hasGitSegment(command: string): boolean {
  return splitCommandSegments(command).some((s) => parseSegment(s)?.cmd === 'git')
}

/** Config scopes the REPO controls. `system` and `global` are the user's own
 *  (difftastic as a global `diff.external` is theirs), so they never arm. */
const REPO_SCOPES: ReadonlySet<string> = new Set(['local', 'worktree', 'command'])

/**
 * Keys that make an otherwise read-only git command run a program, matched on
 * the lowercased key, plus one that moves where it reads. `filter.<driver>.process`
 * is git's long-running filter protocol, which runs a program exactly where
 * `clean`/`smudge` would.
 */
const ARMED_KEY_PATTERNS: readonly RegExp[] = [
  /^diff\.external$/,
  /^diff\..+\.(?:command|textconv)$/,
  /^filter\..+\.(?:clean|smudge|process)$/,
  /^core\.fsmonitor$/,
  /^core\.hookspath$/,
  /^gpg\.program$/,
  /^gpg\..+\.program$/,
  /^log\.showsignature$/,
  /^core\.pager$/,
  /^pager\..+$/,
  // Not a program: it redirects status/diff/ls-files/show to another
  // directory, whose paths the checker's scope rules never see (the command
  // names none). Any value arms. A session whose cwd is a submodule's work
  // tree (its git dir sets core.worktree legitimately) loses the git bypass —
  // accepted.
  /^core\.worktree$/
]

/** `core.fsmonitor` set to a boolean is git's built-in daemon, not a hook program. */
const GIT_BOOLEAN = /^(?:true|false|yes|no|on|off|1|0)$/i

/** A subsection the judge may be shown as written; anything else is masked. */
const SAFE_SUBSECTION = /^[A-Za-z0-9_.-]{1,64}$/

/**
 * The key as reported. A subsection (`diff."<name>".textconv`) is text the
 * repo's author chose, and the list reaches the judge's prompt, so one outside
 * a plain identifier charset is masked as `*` — the fact is "a textconv is
 * set", not what the attacker called it.
 */
function reportedKey(lowerKey: string): string {
  const first = lowerKey.indexOf('.')
  const last = lowerKey.lastIndexOf('.')
  if (first === last) return lowerKey
  const sub = lowerKey.slice(first + 1, last)
  return SAFE_SUBSECTION.test(sub)
    ? lowerKey
    : `${lowerKey.slice(0, first)}.*${lowerKey.slice(last)}`
}

function isArmed(lowerKey: string, value: string | undefined): boolean {
  if (!ARMED_KEY_PATTERNS.some((re) => re.test(lowerKey))) return false
  // A bare `fsmonitor` key (no `=`) is boolean true.
  if (lowerKey === 'core.fsmonitor') return value !== undefined && !GIT_BOOLEAN.test(value.trim())
  return true
}

/**
 * Which repo-controlled git config keys would make git run a program in `cwd`
 * (ADR-084 §2). Runs `git --no-pager config --list --show-scope --includes -z`
 * with `shell: false`, so include-sourced entries are seen under the scope of
 * the file that included them; then, only when that came back with a list,
 * `git ls-files` for gitlinks (see {@link indexHasGitlink}).
 *
 * `-z` rather than the line format the ADR names: records are
 * `<scope>\0<key>\n<value>\0` (a bare key has no `\n`), so a multi-line value
 * can neither forge nor split a record.
 *
 * Returns the sorted, de-duplicated ARMED keys — never their values, which can
 * hold paths or tokens — `[]` for a clean repo, and `null` whenever the answer
 * is not known:
 * - the capture failed, threw or timed out (git missing, non-zero exit);
 * - the output was cut at the capture cap, or a record is malformed — an armed
 *   key could sit past the cut;
 * - there is no `local` entry at all: `git config --list` succeeds outside a
 *   repository, and every repository git creates has local entries, so this
 *   is how "not a repo" reads here;
 * - the index holds a gitlink (see {@link indexHasGitlink}).
 *
 * Callers treat `null` as "cannot verify": the static bypass refuses, and the
 * judge's meta line is simply absent.
 */
export async function captureGitConfigArmed(
  cwd: string,
  exec: CaptureExec = defaultExec
): Promise<string[] | null> {
  let res: CaptureExecResult
  try {
    res = await exec(
      'git',
      ['--no-pager', 'config', '--list', '--show-scope', '--includes', '-z'],
      { cwd, timeoutMs: GIT_CAPTURE_TIMEOUT_MS }
    )
  } catch {
    return null
  }
  if (!res.ok || typeof res.stdout !== 'string') return null
  const out = res.stdout
  if (out.length >= MAX_CAPTURE_BYTES) return null
  if (out.length > 0 && !out.endsWith('\0')) return null
  const fields = out.length > 0 ? out.slice(0, -1).split('\0') : []
  if (fields.length % 2 !== 0) return null

  let sawLocal = false
  const armed = new Set<string>()
  for (let i = 0; i < fields.length; i += 2) {
    const scope = fields[i]
    const entry = fields[i + 1]
    const nl = entry.indexOf('\n')
    const key = (nl === -1 ? entry : entry.slice(0, nl)).toLowerCase()
    const value = nl === -1 ? undefined : entry.slice(nl + 1)
    if (scope === '' || key === '') return null
    if (scope === 'local') sawLocal = true
    if (!REPO_SCOPES.has(scope)) continue
    if (isArmed(key, value)) armed.add(reportedKey(key))
  }
  if (!sawLocal) return null
  if ((await indexHasGitlink(cwd, exec)) !== false) return null
  return [...armed].sort()
}

/**
 * The two ways to list index modes, tried in order. `--format=%(objectmode)`
 * (git ≥ 2.38) prints 7 bytes per entry, so the capture cap is reached only
 * past ~140k tracked files; `--stage` (every git) prints the object id and
 * path too, ~50+ bytes per entry, and is the fallback when `--format` is
 * refused. Each `-z` record must match its shape exactly.
 */
const LS_FILES_MODE_QUERIES: ReadonlyArray<{ args: string[]; record: RegExp }> = [
  {
    args: ['--no-pager', 'ls-files', '-z', '--format=%(objectmode)'],
    record: /^([0-7]{6})$/
  },
  {
    args: ['--no-pager', 'ls-files', '--stage', '-z'],
    record: /^([0-7]{6}) [0-9a-f]{40,64} [0-3]\t./s
  }
]

/** The index mode of a gitlink (a submodule commit). */
const GITLINK_MODE = '160000'

/**
 * Does the index in `cwd` hold a gitlink? `null` when it cannot be told
 * (both queries failed, timeout, output cut at the capture cap, a malformed
 * record).
 *
 * Why it matters to {@link captureGitConfigArmed}: `git status` and `git diff`
 * run `git status --porcelain=2` inside every populated submodule, with THAT
 * repository's own config — its `core.fsmonitor`, its `core.hooksPath`, its
 * `diff.external` — none of which the superproject's `git config --list` shows.
 * So a repo with a gitlink cannot be verified. This keys off the index, not
 * `submodule.*` config, because the recursion follows any populated gitlink
 * whether or not `.gitmodules` or the config names it. Fail closed rather than
 * recurse: repos with submodules lose only the git part of the bypass.
 */
async function indexHasGitlink(cwd: string, exec: CaptureExec): Promise<boolean | null> {
  for (const query of LS_FILES_MODE_QUERIES) {
    let res: CaptureExecResult
    try {
      res = await exec('git', query.args, { cwd, timeoutMs: GIT_CAPTURE_TIMEOUT_MS })
    } catch {
      return null
    }
    // A refused `--format` (older git) exits non-zero: try the next query.
    if (!res.ok || typeof res.stdout !== 'string') continue
    const out = res.stdout
    if (out.length >= MAX_CAPTURE_BYTES) return null
    if (out.length === 0) return false
    if (!out.endsWith('\0')) return null
    for (const record of out.slice(0, -1).split('\0')) {
      const m = query.record.exec(record)
      if (!m) return null
      if (m[1] === GITLINK_MODE) return true
    }
    return false
  }
  return null
}
