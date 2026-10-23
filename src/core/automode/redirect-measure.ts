/**
 * P2a-2: the fs half of redirect ground truth.
 *
 * `ground-truth.ts` stays pure and synchronous — it can say WHERE a command's
 * redirects land, never what is already there. This module measures the rest:
 *
 * - `exists` / `empty` / `modifiedSinceSessionStart` for an out-of-scope target;
 * - whether a target (or the directory it writes through) is a symlink, which
 *   turns "inside the worktree" into "the file that would actually be written".
 *
 * Two rules dominate every branch:
 *
 * 1. **Never fabricate.** A failure — lstat throwing something other than
 *    ENOENT, `realpath` refusing, the deadline expiring — emits NO field for
 *    that target. "Not measured" is absence, exactly as in the captures above.
 * 2. **Never hide a write.** An in-scope target whose parent directory
 *    `realpath`s outside the root is `symlinked`, not "in scope": the lexical
 *    path is inside the tree, the file is not. An in-scope parent link to a
 *    PROTECTED directory inside the tree is a protected hit and `symlinked` too
 *    (exit review R1).
 *
 * The pure scanner's detail API is the input ({@link redirectTargetDetails});
 * {@link summarizeRedirects} is the output, so this file adds measurement and
 * nothing else. `probe` is the test seam; the default reads the real fs.
 *
 * One refinement (owner-approved): a target that IS a link but whose
 * `realpath` lands inside a scope root with no protected component is
 * classified by that real path — it is an in-scope write through a link, not an
 * escape. A dangling link, or one resolving out of scope or onto a protected
 * component, is `symlinked`. The same real-target check applies to a link in the
 * DIRECTORY a target is written through.
 */
import { lstat, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  protectedComponentsOf,
  redirectTargetDetails,
  summarizeRedirects,
  type RedirectAnalysis,
  type RedirectMeasurement,
  type RedirectScope,
  type RedirectTargetDetail
} from './ground-truth'
import { isAbsolutePosixish, isDescendant, normalizePath, toPosixish } from './shell-lexical'

/** How long the callers let measurement run before the conservative fallback. */
export const REDIRECT_CAPTURE_TIMEOUT_MS = 400

/** The slice of `fs.Stats` this file reads, so a test probe need not fake one. */
export interface RedirectStat {
  isSymbolicLink(): boolean
  isFile(): boolean
  /**
   * `undefined` means NOT MEASURED, never "zero": a historical fact that did not
   * record the size must not become `empty:true` (exit review Astra C1).
   */
  size?: number
  /** `undefined` means NOT MEASURED, never "the epoch" (exit review Astra C1). */
  mtimeMs?: number
  /**
   * Hard-link count. `undefined` means NOT MEASURED, never "one": an unmeasured
   * count must not change a target's classification. A regular file with more
   * than one link may be the same inode as a file elsewhere.
   */
  nlink?: number
}

/** The injectable fs seam. Both methods reject exactly as their `node:fs` counterparts do. */
export interface RedirectProbe {
  lstat(path: string): Promise<RedirectStat>
  realpath(path: string): Promise<string>
}

/** The real filesystem. */
const hostProbe: RedirectProbe = {
  lstat: (path) => lstat(path),
  realpath: (path) => realpath(path)
}

export interface CaptureRedirectsOptions {
  /** The owning session object's construction time; a resumed session restarts it. */
  sessionStartMs: number
  platform?: NodeJS.Platform
  probe?: RedirectProbe
  timeoutMs?: number
}

/**
 * `redirectTargetDetails` + measured fs facts → the meta contract.
 *
 * Returns `null` exactly when the pure analysis does (no file target). On any
 * failure or when the deadline expires a CONSERVATIVE analysis is returned:
 * established negative facts survive, unchecked hints are dropped and review is
 * forced, so a broken probe can only ever cost an escalation, never clear a target.
 */
export async function captureRedirects(
  command: string,
  scope: RedirectScope,
  options: CaptureRedirectsOptions
): Promise<RedirectAnalysis | null> {
  const platform = options.platform ?? process.platform
  const details = redirectTargetDetails(command, scope, platform)
  if (details === null) return null
  const createsLink = createsLinks(command)
  const progress: MeasureProgress = { outcomes: new Map() }
  const measured = await withinDeadline(
    measureRedirects(
      details,
      scope,
      platform,
      options.probe ?? hostProbe,
      options.sessionStartMs,
      progress
    ),
    options.timeoutMs ?? REDIRECT_CAPTURE_TIMEOUT_MS
  )
  if (measured === null) return conservativeFallback(details, progress)
  // A link the command itself creates did not exist when it was measured, so
  // every in-scope reading predates it: withhold the clean scope claim.
  const final = createsLink
    ? measured.details.map((detail) =>
        detail.root === undefined ? detail : { ...detail, reviewRequired: true as const }
      )
    : measured.details
  return summarizeRedirects(final, measured.measured)
}

/**
 * Does the command text create a link (symbolic, junction or hard)? Deliberately
 * crude and case-insensitive: a false positive only costs an escalation, while a
 * link made in the same command (`ln -s ../out lnk && echo x > lnk/f`) is
 * measured BEFORE it exists and so reads clean. Covers `ln`/`gln`,
 * `cp -l|-s`, `mklink`, and the words only a link-creating command spells
 * (`New-Item -ItemType SymbolicLink|Junction|HardLink`, `fsutil hardlink`,
 * `os.symlink`, `CreateSymbolicLink`).
 */
const LINK_WORD_RE = /symlink|symboliclink|junction|hardlink|mklink/i
const LINK_COMMAND_RE = /(?:^|[\s;&|(`/\\])(?:g?ln)(?=[\s;&|)]|$)/i
/** `cp` flags are case-sensitive: `-l` hard-links, `-s` symlinks, `-L` follows. */
const LINK_COPY_RE = /\bcp\b[^;&|\n]*\s-[a-zA-Z]*[ls]/

function createsLinks(command: string): boolean {
  return LINK_WORD_RE.test(command) || LINK_COMMAND_RE.test(command) || LINK_COPY_RE.test(command)
}

/**
 * A timeout (or a probe rejection) must never restore the pure result's unsafe
 * facts (exit review R5): the pure `allInScope: true` and a temp hint whose
 * containment was not checked are exactly what the measurement removed. Keep
 * every established negative fact from the completed targets, drop all temp
 * hints, and force full review for the rest.
 */
function conservativeFallback(
  details: readonly RedirectTargetDetail[],
  progress: MeasureProgress
): RedirectAnalysis {
  const measured = new Map<string, RedirectMeasurement>()
  const fallback = details.map((detail, i) => {
    const done = progress.outcomes.get(i)
    const base = done?.detail ?? detail
    const clean = { ...base, reviewRequired: true as const }
    delete clean.tempVarPath
    delete clean.tempVarSpelling
    if (done?.measurement !== undefined && clean.path !== undefined) {
      measured.set(clean.path, mergeMeasurement(measured.get(clean.path), done.measurement))
    }
    return clean
  })
  return summarizeRedirects(fallback, measured)
}

interface MeasuredTargets {
  details: RedirectTargetDetail[]
  measured: Map<string, RedirectMeasurement>
  /** Which target positions this root reading actually measured. */
  applicable?: boolean[]
}

interface MeasurementContext {
  /** The probe, with the win32 `/tmp` spelling folded per dialect (see {@link rootPlanFor}). */
  probe: RedirectProbe
  platform: NodeJS.Platform
  sessionStartMs: number
  /** The session cwd, normalised: the protected check is relative to it. */
  cwd: string
  /**
   * `realpath(cwd)`, or `null` when it cannot be established. A cwd reached
   * through a link (a junction, macOS `/tmp` → `/private/tmp`, a worktree under
   * `.claude/worktrees/…`) must not make its own ancestors count as protected
   * components of every real target beneath it.
   */
  realCwd: string | null
  /** Scope-root spelling → its real path, for roots `realpath` could establish. */
  realRoots: ReadonlyMap<string, string>
  /** Which `/tmp` fold, if any, the probe applies (see {@link rootPlanFor}). */
  tmpRoot: string | undefined
  /**
   * The temp roots a `tempVarPath` hint can name, normalised: the values of the
   * host temp variables (`scope.tempVars`). Empty when none is set.
   */
  tempRoots: readonly string[]
}

/**
 * On win32, Git Bash's `/tmp` is the user temp dir (the usertemp mount), but
 * Node cannot see that mount: `realpath('/tmp')` is `ENOENT` and `lstat('/tmp/x')`
 * probes `<current drive>:\tmp\x`. Scope roots carry the host temp dir as a
 * NATIVE spelling, so `/tmp` is measured through it and `/tmp/…` targets are
 * read there (exit review #3). Only the conventional mount spelling is folded;
 * a POSIX host (and every other root) is untouched.
 *
 * The fold is DIALECT-SPECIFIC (exit review R2): PowerShell reads `/tmp/x` as
 * `<shell drive>:\tmp\x`, not as the usertemp mount. So the mapping applies only
 * for `shell: 'posix'`; `powershell` probes the drive-rooted spelling; an
 * unknown dialect probes BOTH and keeps the worse result — never a clean fact
 * measured at the wrong location.
 */
const GIT_BASH_TMP = '/tmp'

/** The host temp spelling a win32 scope stands `/tmp` for, or `undefined` elsewhere. */
function hostTempSpelling(scope: RedirectScope, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'win32') return undefined
  const native = (scope.tempDirs ?? []).find((root) => {
    const full = normalizePath(root, platform).full
    return full !== GIT_BASH_TMP && full !== '/private/tmp'
  })
  if (native !== undefined) return normalizePath(native, platform).full
  try {
    return normalizePath(tmpdir(), platform).full
  } catch {
    // No host temp dir to measure `/tmp` through: leave the root unmeasured
    // rather than guess one.
    return undefined
  }
}

/** The drive root of the shell's start directory (`d:/`), for PowerShell's `/tmp`. */
function shellDriveTmp(scope: RedirectScope, platform: NodeJS.Platform): string | undefined {
  const dir = scope.shellCwd ?? scope.cwd
  if (typeof dir !== 'string') return undefined
  const full = normalizePath(dir, platform).full
  const drive = /^([a-z]:)\//.exec(full)
  return drive ? `${drive[1]}/tmp` : undefined
}

interface RootPlan {
  /** The physical `/tmp` reading(s) this target's spelling can mean. */
  roots: (string | undefined)[]
  /** A rootless PowerShell path whose current drive could not be established. */
  unknownDrive: boolean
}

/**
 * The `/tmp` reading(s) for ONE target. PowerShell resolves a drive-less rooted
 * path against the CURRENT drive, so a `cd` before the redirect changes it; the
 * scanner carries the possible drives in `detail.shellDrive` (exit review R4).
 * An unknown dialect keeps the POSIX host reading AND every possible drive; a
 * drive it cannot establish forces review rather than a clean scope claim.
 */
function rootPlanFor(
  detail: RedirectTargetDetail,
  scope: RedirectScope,
  platform: NodeJS.Platform
): RootPlan {
  if (platform !== 'win32') return { roots: [undefined], unknownDrive: false }
  // A hint names a real temp path even though the target itself is unresolvable;
  // its `/tmp` spelling must be folded exactly like a resolved target's (R1).
  const target = detail.path ?? detail.tempVarPath
  if (target === undefined || !isTmpSpelling(target, platform)) {
    return { roots: [undefined], unknownDrive: false }
  }
  const hostTemp = hostTempSpelling(scope, platform)
  if (scope.shell === 'posix') {
    return hostTemp === undefined
      ? { roots: [], unknownDrive: true }
      : { roots: [hostTemp], unknownDrive: false }
  }
  if (scope.shell === 'powershell') {
    const drive = detail.shellDrive
    if (drive === null) return { roots: [], unknownDrive: true }
    if (typeof drive === 'string') {
      return { roots: [`${drive}/tmp`], unknownDrive: false }
    }
    const fallback = shellDriveTmp(scope, platform)
    return fallback === undefined
      ? { roots: [], unknownDrive: true }
      : { roots: [fallback], unknownDrive: false }
  }
  // Unknown dialect: BOTH readings, and every drive the shell state allows.
  const roots: (string | undefined)[] = []
  const add = (root: string | undefined): void => {
    if (!roots.includes(root)) roots.push(root)
  }
  if (hostTemp !== undefined) add(hostTemp)
  let drive: string | null | undefined = detail.shellDrive
  if (drive === undefined) drive = shellDriveTmp(scope, platform)?.replace(/\/tmp$/, '')
  if (typeof drive === 'string') add(`${drive}/tmp`)
  return {
    roots: roots.length === 0 ? [undefined] : roots,
    unknownDrive: typeof drive !== 'string'
  }
}

/** `/tmp` and `/TMP/…`: Git Bash's usertemp mount folds case on win32 (exit review N2). */
function isTmpSpelling(path: string, platform: NodeJS.Platform): boolean {
  const fold = (s: string): string => (platform === 'win32' ? s.toLowerCase() : s)
  const folded = fold(path)
  return folded === GIT_BASH_TMP || folded.startsWith(`${GIT_BASH_TMP}/`)
}

/** `path` with a win32 `/tmp` spelling read through `tmpRoot`. */
function mapTmpPath(path: string, tmpRoot: string | undefined, platform: NodeJS.Platform): string {
  if (tmpRoot === undefined || !isTmpSpelling(path, platform)) return path
  const folded = platform === 'win32' ? path.toLowerCase() : path
  if (folded === GIT_BASH_TMP) return tmpRoot
  // The `/tmp` prefix has the same length in every case, so slice the original.
  return `${tmpRoot}/${path.slice(GIT_BASH_TMP.length + 1)}`
}

/** `probe` with a win32 `/tmp` spelling (any case) read through `tmpRoot`. */
function probeFor(
  probe: RedirectProbe,
  tmpRoot: string | undefined,
  platform: NodeJS.Platform
): RedirectProbe {
  if (tmpRoot === undefined) return probe
  return {
    lstat: (path) => probe.lstat(mapTmpPath(path, tmpRoot, platform)),
    realpath: (path) => probe.realpath(mapTmpPath(path, tmpRoot, platform))
  }
}

async function measureRedirects(
  details: readonly RedirectTargetDetail[],
  scope: RedirectScope,
  platform: NodeJS.Platform,
  probe: RedirectProbe,
  sessionStartMs: number,
  progress: MeasureProgress
): Promise<MeasuredTargets> {
  const plans = details.map((detail) => rootPlanFor(detail, scope, platform))
  const roots: (string | undefined)[] = []
  for (const plan of plans) {
    for (const root of plan.roots) if (!roots.includes(root)) roots.push(root)
  }
  if (roots.length === 0) roots.push(undefined)
  const runs: MeasuredTargets[] = []
  for (const tmpRoot of roots) {
    const applicable = plans.map((plan) => !plan.unknownDrive && plan.roots.includes(tmpRoot))
    runs.push(
      await measureWith(
        details,
        scope,
        platform,
        probe,
        sessionStartMs,
        tmpRoot,
        applicable,
        progress
      )
    )
  }
  const merged = runs.length === 1 ? runs[0] : worseOf(runs, details)
  merged.details = merged.details.map((detail, i) => {
    if (!plans[i].unknownDrive) return detail
    // An unresolvable hint whose temp path cannot be placed on a known drive is
    // not a checked hint: drop it rather than keep a clean-looking fact.
    if (detail.path === undefined && detail.tempVarPath !== undefined) {
      const withoutHint = { ...detail, reviewRequired: true as const }
      delete withoutHint.tempVarPath
      delete withoutHint.tempVarSpelling
      return withoutHint
    }
    return { ...detail, reviewRequired: true as const }
  })
  return merged
}

interface ProgressOutcome {
  detail: RedirectTargetDetail
  measurement?: RedirectMeasurement
}

/** Per-target outcomes already established when a deadline expires (R5). */
interface MeasureProgress {
  outcomes: Map<number, ProgressOutcome>
}

function recordProgress(
  progress: MeasureProgress,
  index: number,
  detail: RedirectTargetDetail,
  outcome: TargetOutcome | undefined
): void {
  if (outcome === undefined) return
  const nextDetail = outcome.detail ?? detail
  const prior = progress.outcomes.get(index)
  if (prior === undefined) {
    progress.outcomes.set(index, {
      detail: nextDetail,
      ...(outcome.measurement ? { measurement: outcome.measurement } : {})
    })
    return
  }
  const detailWinner =
    nextDetail.protectedHits.length > prior.detail.protectedHits.length ? nextDetail : prior.detail
  const protectedHits = [...prior.detail.protectedHits]
  for (const hit of nextDetail.protectedHits) {
    if (!protectedHits.includes(hit)) protectedHits.push(hit)
  }
  const reviewRequired = prior.detail.reviewRequired === true || nextDetail.reviewRequired === true
  const measurement =
    outcome.measurement === undefined
      ? prior.measurement
      : prior.measurement === undefined
        ? outcome.measurement
        : worseMeasurement(prior.measurement, outcome.measurement)
  progress.outcomes.set(index, {
    detail: {
      ...detailWinner,
      protectedHits,
      ...(reviewRequired ? { reviewRequired: true as const } : {})
    },
    ...(measurement === undefined ? {} : { measurement })
  })
}

async function measureWith(
  details: readonly RedirectTargetDetail[],
  scope: RedirectScope,
  platform: NodeJS.Platform,
  probe: RedirectProbe,
  sessionStartMs: number,
  tmpRoot: string | undefined,
  applicable: readonly boolean[],
  progress: MeasureProgress
): Promise<MeasuredTargets> {
  const mapped = probeFor(probe, tmpRoot, platform)
  const realRoots = new Map<string, string>()
  await Promise.all(
    scopeRoots(scope, platform).map(async (root) => {
      const real = await readRealpath(mapped, root)
      if (real !== null) realRoots.set(root, normalizePath(real, platform).full)
    })
  )

  const context: MeasurementContext = {
    probe: mapped,
    platform,
    sessionStartMs,
    cwd: normalizePath(scope.cwd, platform).full,
    realCwd: await readRealCwd(mapped, scope.cwd, platform),
    realRoots,
    tmpRoot,
    tempRoots: tempVarRoots(scope, platform)
  }
  const measured = new Map<string, RedirectMeasurement>()
  const results = await Promise.all(
    details.map(async (detail, i) => {
      if (!applicable[i]) return undefined
      if (detail.path === undefined) {
        // An unresolvable target carrying a temp hint: drop the hint when the
        // path it names is reached through a link OUT of the temp root it names
        // (exit review N7). The unresolvable detail itself is never dropped.
        if (detail.tempVarPath === undefined) return undefined
        const hint = await hintOutcome(detail, context)
        if (hint.stays) return undefined
        const withoutHint = { ...detail, protectedHits: [...detail.protectedHits] }
        delete withoutHint.tempVarPath
        delete withoutHint.tempVarSpelling
        for (const hit of hint.protectedHits) {
          if (!withoutHint.protectedHits.includes(hit)) withoutHint.protectedHits.push(hit)
        }
        // Negative evidence from a hint (containment escape or a protected real
        // destination) survives a different target's timeout.
        recordProgress(progress, i, detail, { detail: withoutHint })
        return withoutHint
      }
      try {
        const outcome = await measureTarget(detail, context)
        recordProgress(progress, i, detail, outcome)
        if (outcome.measurement !== undefined) {
          // One resolved path can be reached by several spellings; a plain
          // reading must never erase another spelling's `symlinked` (N3).
          measured.set(
            detail.path,
            mergeMeasurement(measured.get(detail.path), outcome.measurement)
          )
        }
        return outcome.detail
      } catch {
        // An exception is not an absence: the target's containment is
        // unresolved, so the pure `allInScope` must not be restored.
        return { ...detail, reviewRequired: true as const }
      }
    })
  )
  return {
    // A rewritten detail (a link that resolves in scope) keeps its position, so
    // the meta line's order still follows the command.
    details: details.map((detail, i) => results[i] ?? detail),
    measured,
    applicable: [...applicable]
  }
}

/**
 * Merge the readings of an unknown dialect, keeping the WORSE result per target
 * (exit review R2): a protected hit, `symlinked`, an existing out-of-scope file
 * — any of them beats a clean reading of the same as-written target.
 */
function worseOf(
  runs: readonly MeasuredTargets[],
  source: readonly RedirectTargetDetail[]
): MeasuredTargets {
  const measured = new Map<string, RedirectMeasurement>()
  for (const run of runs) {
    for (const [path, reading] of run.measured) {
      const prior = measured.get(path)
      measured.set(path, prior === undefined ? reading : worseMeasurement(prior, reading))
    }
  }
  const details = runs[0].details.map((first, i) => {
    // Only a run that actually measured this target may decide its outcome; a
    // non-applicable run must not resurrect an unsafe hint or a clean reading.
    const candidates = runs
      .filter((run) => run.applicable?.[i] !== false)
      .map((run) => ({ run, detail: run.details[i] ?? first }))
    if (candidates.length === 0) candidates.push({ run: runs[0], detail: first })
    let best = candidates[0].detail
    let bestScore = outcomeScore(best, source[i], candidates[0].run)
    const protectedHits: string[] = []
    let reviewRequired = false
    for (const candidate of candidates) {
      for (const hit of candidate.detail.protectedHits) {
        if (!protectedHits.includes(hit)) protectedHits.push(hit)
      }
      if (candidate.detail.reviewRequired === true) reviewRequired = true
      const score = outcomeScore(candidate.detail, source[i], candidate.run)
      if (score > bestScore) {
        best = candidate.detail
        bestScore = score
      }
    }
    return {
      ...best,
      protectedHits,
      ...(reviewRequired ? { reviewRequired: true as const } : {})
    }
  })
  return { details, measured }
}

/** How alarming one reading of a target is; ties keep the first reading. */
function outcomeScore(
  detail: RedirectTargetDetail,
  source: RedirectTargetDetail | undefined,
  run: MeasuredTargets
): number {
  const reading = source?.path === undefined ? undefined : run.measured.get(source.path)
  return (
    (detail.reviewRequired === true ? 10_000 : 0) +
    detail.protectedHits.length * 100 +
    // A removed temp hint is stronger evidence than one that was not checked.
    (source?.tempVarPath !== undefined && detail.tempVarPath === undefined ? 200 : 0) +
    (reading?.symlinked === true ? 50 : 0) +
    (reading?.exists === true ? 10 : reading?.exists === false ? 5 : 0)
  )
}

function worseMeasurement(a: RedirectMeasurement, b: RedirectMeasurement): RedirectMeasurement {
  const score = (m: RedirectMeasurement): number =>
    (m.symlinked === true ? 8 : 0) + (m.exists === true ? 4 : m.exists === false ? 2 : 0)
  return score(b) > score(a) ? b : a
}

interface TargetOutcome {
  measurement?: RedirectMeasurement
  /** Present when the link resolves in scope and the target is classified by its real path. */
  detail?: RedirectTargetDetail
}

async function measureTarget(
  detail: RedirectTargetDetail,
  context: MeasurementContext
): Promise<TargetOutcome> {
  const target = detail.path as string

  // On win32 a drive-less absolute path other than the folded `/tmp` is not the
  // file Git Bash would write: `/etc`, `/usr`, `/bin`, `/opt` are MSYS mounts
  // under Git's install root, while Node probes `<process drive>:\etc`. An
  // `exists`/`empty`/`mtime` read there is a fabrication, so the target keeps
  // only its pure facts (exit review N4). The link checks still run.
  if (!isMeasurableTarget(target, context)) {
    // An IN-SCOPE target whose root Node cannot read (a UNC cwd, `\\host\share`,
    // `\\wsl$\…`) cannot be checked for a link to outside, so it must not clear
    // as in scope (a junction inside it would otherwise write anywhere).
    if (detail.root !== undefined) return { detail: { ...detail, reviewRequired: true } }
    // A drive-less win32 mount (`/etc`) cannot be read by Node; measuring it
    // would fabricate. An explicit link before `..` is still visible from the
    // spelling, but no physical prefix probe is attempted.
    const traversal = await linkBeforeDotDot(detail, context)
    if (traversal === 'link') return { measurement: { symlinked: true } }
    if (traversal === 'unknown') return { detail: { ...detail, reviewRequired: true } }
    return {}
  }

  const stat = await readLstat(context.probe, target)
  // A failed lstat tells us nothing about existence — not even that the file is
  // absent. It does NOT unmake a planted directory link either, so the link
  // checks still run (exit review NIT); only measured fields are withheld.
  if (stat === 'error') {
    const traversal = await linkBeforeDotDot(detail, context)
    if (traversal === 'link') return { measurement: { symlinked: true } }
    if (traversal === 'unknown') return { detail: { ...detail, reviewRequired: true } }
    const linked = await throughLink(detail, context)
    if (linked?.measurement !== undefined) return linked
    // The leaf could itself be a link (to anywhere); a benign parent does not
    // establish its identity, so do not clear the target as in-scope.
    return {
      detail: { ...(linked?.detail ?? detail), reviewRequired: true }
    }
  }

  // A written `sub/../x` does not prove `sub` is a directory: if any prefix
  // BEFORE a `..` is a link, the collapsed path is not where the write lands.
  // This MUST run before the final-file-link shortcut below: a safe lexical
  // leaf link is irrelevant when `jump/..` escapes (exit review R2).
  const traversal = await linkBeforeDotDot(detail, context)
  if (traversal === 'link') return { measurement: { symlinked: true } }
  if (traversal === 'unknown') return { detail: { ...detail, reviewRequired: true } }

  if (stat !== 'missing' && stat.isSymbolicLink()) {
    const real = await readRealpath(context.probe, target)
    // A dangling link (or one we cannot resolve) is never the file it names.
    if (real === null) return { measurement: { symlinked: true } }
    const realPath = normalizePath(real, context.platform).full
    const root = deepestContainingRoot(context.realRoots, realPath, context.platform)
    const components = realProtectedComponents(realPath, context)
    if (root !== undefined && protectedComponentsOf(components).length === 0) {
      // The lexical path is a link; the file it writes is INSIDE the tree. Report
      // the real path so `summarizeRedirects` treats it as an ordinary in-scope
      // target instead of an escape. A `..` before the leaf was rejected above,
      // so this safe link is reached only when the shell really reaches the file.
      const inScope = { ...detail, path: realPath, root: root.spelling }
      if (isHardLinked(await readLstat(context.probe, realPath))) {
        return { detail: { ...inScope, reviewRequired: true } }
      }
      return { detail: inScope }
    }
    return { measurement: { symlinked: true } }
  }

  // In scope, the DIRECTORY it writes through can still be a link: `ordinary/`
  // onto `.claude` and `../outside/keys/` onto `~/.ssh` must be seen before any
  // ordinary/in-scope claim (exit review R1 + rec). `undefined` = the parent
  // resolves to the same directory (or cannot be measured at all).
  const linked = await throughLink(detail, context)
  if (linked?.measurement !== undefined) return linked
  // An OUT-OF-SCOPE link onto a protected real target adds the hit but keeps
  // the measured facts read THROUGH the link (exit review N5).
  const effective = linked?.detail ?? detail
  const outcome = (measurement: RedirectMeasurement | undefined): TargetOutcome => {
    if (effective === detail) return measurement === undefined ? {} : { measurement }
    return measurement === undefined ? { detail: effective } : { detail: effective, measurement }
  }

  if (effective.root !== undefined) {
    // An existing in-scope regular file with several hard links may be the same
    // inode as a file elsewhere (`mklink /H`, `ln`): the write is not confined.
    if (isHardLinked(stat)) return { detail: { ...effective, reviewRequired: true } }
    return outcome(undefined)
  }

  if (stat === 'missing') return outcome({ exists: false })
  if (stat.isFile()) {
    return outcome({
      exists: true,
      // Only measured facts: an unrecorded size/mtime stays absent, never 0
      // (exit review Astra C1 — `?? 0` fabricated `empty:true` in replay).
      ...(typeof stat.size === 'number' ? { empty: stat.size === 0 } : {}),
      ...(typeof stat.mtimeMs === 'number'
        ? { modifiedSinceSessionStart: stat.mtimeMs >= context.sessionStartMs }
        : {})
    })
  }
  // A directory / device / FIFO target exists, but has no "empty" or "mtime of
  // the file's content" fact to report.
  return outcome({ exists: true })
}

/** A measured regular file with more than one hard link; an unmeasured count is `false`. */
function isHardLinked(stat: StatReading): boolean {
  return (
    stat !== 'missing' &&
    stat !== 'error' &&
    !stat.isSymbolicLink() &&
    stat.isFile() &&
    typeof stat.nlink === 'number' &&
    stat.nlink > 1
  )
}

/**
 * On win32 only a drive-rooted path and the folded `/tmp` mount name a location
 * Node can read (exit review N4). Everything else — `/etc`, `/usr`, … — is a
 * Git Bash mount at a place Node would not look.
 */
function isMeasurableTarget(target: string, context: MeasurementContext): boolean {
  if (context.platform !== 'win32') return true
  const full = normalizePath(target, context.platform).full
  if (!full.startsWith('/')) return true
  return context.tmpRoot !== undefined && isTmpSpelling(full, context.platform)
}

/** The link check for the target's kind: in-scope parents, or out-of-scope ones. */
async function throughLink(
  detail: RedirectTargetDetail,
  context: MeasurementContext
): Promise<TargetOutcome | undefined> {
  return detail.root !== undefined
    ? inScopeThroughLink(detail, context)
    : outOfScopeThroughLink(detail, context)
}

/**
 * An IN-SCOPE target whose parent `realpath`s to a DIFFERENT directory inside
 * ANY scope root (not only the one the spelling named): the write lands at
 * `realParent/basename`. If that real target names
 * a protected component (`ordinary/` → `.claude`, `.git/hooks`, `.aws`), it is a
 * protected hit AND `symlinked`, never ordinary in-scope ground truth (exit
 * review R1). An unprotected link that stays inside the root is still an
 * ordinary write (owner refinement).
 *
 * Returns `undefined` when the parent is the lexical one, cannot be established,
 * or the real target is unprotected — absence, never a fabricated finding.
 */
async function inScopeThroughLink(
  detail: RedirectTargetDetail,
  context: MeasurementContext
): Promise<TargetOutcome | undefined> {
  const rootReal = context.realRoots.get(detail.root as string)
  // Without the root's physical spelling containment cannot be established;
  // an unchecked target must not clear as in-scope (exit review R3/R5).
  if (rootReal === undefined) return { detail: { ...detail, reviewRequired: true } }
  const target = detail.path as string
  // Resolve the nearest EXISTING ancestor and carry the missing suffix: a
  // missing `ordinary/new` still writes through the existing `ordinary` junction
  // (exit review R3). This is not a link finding for an ordinary new path: an
  // unresolved physical walk merely withholds the clean scope claim.
  const realTarget = await physicalTarget(context.probe, target, context.platform, context.tmpRoot)
  if (realTarget === null) return { detail: { ...detail, reviewRequired: true } }
  const realTargetPath = normalizePath(realTarget, context.platform).full
  // The real target may sit in ANY scope root, not only the one the lexical path
  // named: a worktree junction onto the main checkout (both roots granted) is an
  // ordinary in-scope write. Out of every root is still a parent link out of the
  // tree: the spelling is not where the write lands.
  const inside = [...context.realRoots.values()].some(
    (real) =>
      samePath(realTargetPath, real, context.platform) ||
      isDescendant(real, realTargetPath, context.platform)
  )
  if (!inside) return { measurement: { symlinked: true } }
  // `realProtectedComponents` reads components relative to realpath(cwd) when the
  // target sits under it and absolutely otherwise, exactly as `ground-truth.ts`
  // does for a directly spelled path in another root (rule 5/R7): a link into
  // another root never reads more leniently than naming that path would.
  const protectedHits = withNewHits(
    detail.protectedHits,
    protectedComponentsOf(realProtectedComponents(realTargetPath, context)),
    context.platform
  )
  if (protectedHits.length === detail.protectedHits.length) return undefined
  return {
    detail: { ...detail, protectedHits },
    measurement: { symlinked: true }
  }
}

/**
 * `have` plus the `found` hits it does not already name. A name is the same hit
 * whatever its case on win32: the physical walk returns the on-disk casing
 * (`.claude`) of a component the command spelled `.CLAUDE`, and counting that as
 * a second hit would report a plain in-scope write as `symlinked`.
 */
function withNewHits(
  have: readonly string[],
  found: readonly string[],
  platform: NodeJS.Platform
): string[] {
  const fold = (s: string): string => (platform === 'win32' ? s.toLowerCase() : s)
  const known = new Set(have.map(fold))
  const out = [...have]
  for (const hit of found) {
    if (known.has(fold(hit))) continue
    known.add(fold(hit))
    out.push(hit)
  }
  return out
}

type StatReading = RedirectStat | 'missing' | 'error'

async function readLstat(probe: RedirectProbe, path: string): Promise<StatReading> {
  try {
    return await probe.lstat(path)
  } catch (err) {
    return isEnoent(err) ? 'missing' : 'error'
  }
}

async function readRealpath(probe: RedirectProbe, path: string): Promise<string | null> {
  try {
    return await probe.realpath(path)
  } catch {
    return null
  }
}

/**
 * The physical path a target would write, even when the target (or an immediate
 * parent) does not exist yet: resolve the nearest EXISTING ancestor and append
 * the missing components. This is how a new file below an existing junction is
 * still recognised as writing through that junction (exit review R3). `null`
 * means the physical path could not be established, which is review-worthy, not
 * a clean fact.
 */
async function physicalTarget(
  probe: RedirectProbe,
  target: string,
  platform: NodeJS.Platform,
  tmpRoot?: string
): Promise<string | null> {
  const full = normalizePath(mapTmpPath(target, tmpRoot, platform), platform).full
  // A leaf's own identity is measured elsewhere (a link is handled before this
  // helper). What containment needs is the PARENT directory's physical path,
  // so climb only through paths positively established missing (ENOENT) and
  // keep the missing suffix. An existing but unreadable directory whose realpath
  // fails stays unestablished; it is never reconstructed from a higher ancestor.
  const suffix: string[] = [baseName(full)]
  let current = parentDir(full)
  for (;;) {
    const stat = await readLstat(probe, current)
    if (stat === 'missing') {
      const parent = parentDir(current)
      if (parent === current) {
        const real = await readRealpath(probe, current)
        if (real === null) return null
        return appendComponents(normalizePath(real, platform).full, suffix)
      }
      suffix.unshift(baseName(current))
      current = parent
      continue
    }
    const real = await readRealpath(probe, current)
    if (real === null) return null
    return appendComponents(normalizePath(real, platform).full, suffix)
  }
}

function appendComponents(base: string, components: readonly string[]): string {
  let out = base
  for (const component of components) out = joinPath(out, component)
  return out
}

/** `realpath(cwd)` in comparison form, or `null` when it cannot be established. */
async function readRealCwd(
  probe: RedirectProbe,
  cwd: string,
  platform: NodeJS.Platform
): Promise<string | null> {
  const real = await readRealpath(probe, normalizePath(cwd, platform).full)
  return real === null ? null : normalizePath(real, platform).full
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

/** The scope roots, in the same spelling and de-duplication `ground-truth.ts` uses. */
function scopeRoots(scope: RedirectScope, platform: NodeJS.Platform): string[] {
  return [scope.cwd, ...(scope.tempDirs ?? []), ...(scope.additionalDirectories ?? [])]
    .filter((root): root is string => typeof root === 'string' && root.trim().length > 0)
    .map((root) => normalizePath(root, platform).full)
    .filter((root, i, all) => all.indexOf(root) === i)
}

/** The parent of a normalised posix-ish path (`/a/b` → `/a`, `d:/x` → `d:/`). */
function parentDir(path: string): string {
  const at = path.lastIndexOf('/')
  if (at < 0) return '.'
  if (at === 0) return '/'
  // A drive root must keep its slash: `realpath('d:')` means "the process's cwd
  // on drive d", not the root, and a drive root's parent is itself.
  if (at === 2 && /^[A-Za-z]:$/.test(path.slice(0, 2))) return `${path.slice(0, 2)}/`
  return path.slice(0, at)
}

interface RealRoot {
  spelling: string
  real: string
}

function deepestContainingRoot(
  realRoots: ReadonlyMap<string, string>,
  target: string,
  platform: NodeJS.Platform
): RealRoot | undefined {
  let best: RealRoot | undefined
  for (const [spelling, real] of realRoots) {
    if (!isDescendant(real, target, platform)) continue
    if (best === undefined || real.length > best.real.length) best = { spelling, real }
  }
  return best
}

/** Components of `target` below `root` (both normalised absolute spellings). */
function relativeComponents(root: string, target: string): string[] {
  const rest = target.slice(root.length).replace(/^\/+/, '')
  return rest === '' ? [] : rest.split('/')
}

/**
 * The components the protected-name check reads for `target`, mirroring
 * `isAgentControlTarget`: relative to the session cwd when the path is inside
 * it (so a worktree under `.claude/worktrees/…` is not a `.claude` hit),
 * absolute components otherwise (so `../../settings.json` from a worktree still
 * names `.claude`). Temp and additional roots no longer relativise (rule 5/R7).
 */
function protectedComponentsFor(cwd: string, target: string, platform: NodeJS.Platform): string[] {
  const trimmed = cwd.replace(/\/+$/, '')
  const fold = (s: string): string => (platform === 'win32' ? s.toLowerCase() : s)
  if (fold(target).startsWith(`${fold(trimmed)}/`)) {
    return relativeComponents(trimmed, target)
  }
  return normalizePath(target, platform).components
}

/**
 * {@link protectedComponentsFor} for a REAL path: when the target sits under
 * `realpath(cwd)` it is relativised against THAT, not the lexical cwd. A session
 * cwd reached through a link (`D:/x` a junction, macOS `/tmp` → `/private/tmp`)
 * otherwise makes the cwd's own ancestors — including `.claude` in a worktree
 * path — count as protected components of every in-scope write.
 */
function realProtectedComponents(realTarget: string, context: MeasurementContext): string[] {
  const realCwd = context.realCwd
  if (realCwd !== null) {
    const target = normalizePath(realTarget, context.platform).full
    if (samePath(target, realCwd, context.platform)) return []
    if (isDescendant(realCwd, target, context.platform)) {
      return relativeComponents(realCwd, target)
    }
  }
  return protectedComponentsFor(context.cwd, realTarget, context.platform)
}

/** Join `base` and one component, without doubling a root slash. */
function joinPath(base: string, component: string): string {
  const trimmed = base.replace(/\/+$/, '')
  return trimmed === '' ? `/${component}` : `${trimmed}/${component}`
}

/**
 * Ruling 10: a written path with a `..` after a component is only textually
 * collapsible. `realpath` every prefix that precedes a `..`; a prefix that is a
 * link makes the target `symlinked` — `sub/../x` with `sub` a link does NOT
 * write `<cwd>/x`.
 *
 * The walk uses the RESOLVED readings of `detail.raw`, not its raw spelling
 * (exit review #2): `toPosixish` folds a Git-Bash `/c/…` target onto `c:/…`, and
 * each backslash reading is walked too, so `l\nk/../bs.txt` is checked as
 * `lnk/../bs.txt`. A reading only counts when it collapses to the path the
 * scanner resolved, so a spelling the shell could not have read is ignored.
 *
 * A prefix positively established MISSING proves nothing and is skipped. A
 * prefix that exists (or cannot be read) but whose `realpath` fails leaves the
 * traversal UNESTABLISHED: no symlink is fabricated, but the target cannot be
 * called clean (exit review R1/R5 failure completeness).
 */
type Traversal = 'link' | 'none' | 'unknown'

async function linkBeforeDotDot(
  detail: RedirectTargetDetail,
  context: MeasurementContext
): Promise<Traversal> {
  let unknown = false
  for (const spelling of dotDotReadings(detail, context.platform)) {
    const outcome = await linkBeforeDotDotIn(spelling, context)
    if (outcome === 'link') return 'link'
    if (outcome === 'unknown') unknown = true
  }
  return unknown ? 'unknown' : 'none'
}

/** The un-collapsed absolute spellings of a target that a shell could have read. */
function dotDotReadings(detail: RedirectTargetDetail, platform: NodeJS.Platform): string[] {
  const base = detail.base
  if (base === undefined || detail.path === undefined) return []
  const readings = new Set<string>([detail.raw.replace(/\\/g, '/')])
  // A bash/posix reading removes an unquoted backslash before any character.
  if (detail.raw.includes('\\')) readings.add(detail.raw.replace(/\\(.)/g, '$1'))
  const trimmedBase = base.replace(/\/+$/, '')
  const out: string[] = []
  for (const reading of readings) {
    const posix = toPosixish(reading, platform)
    const spelling = isAbsolutePosixish(posix, platform)
      ? posix
      : trimmedBase === ''
        ? `/${posix}`
        : `${trimmedBase}/${posix}`
    if (!spelling.split('/').includes('..')) continue
    // Only a reading the scanner actually resolved can describe this target.
    if (normalizePath(spelling, platform).full !== detail.path) continue
    if (!out.includes(spelling)) out.push(spelling)
  }
  return out
}

/** Walk one absolute, un-collapsed spelling, `realpath`ing every prefix before a `..`. */
async function linkBeforeDotDotIn(
  spelling: string,
  context: MeasurementContext
): Promise<Traversal> {
  const drive = /^([A-Za-z]:)\//.exec(spelling)
  const root = drive ? `${drive[1]}/` : '/'
  let prefix = root
  let unknown = false
  for (const component of spelling.slice(root.length).split('/')) {
    if (component === '' || component === '.') continue
    if (component === '..') {
      const outcome = await prefixMovesDotDot(prefix, context)
      if (outcome === 'link') return 'link'
      if (outcome === 'unknown') unknown = true
      prefix = parentDir(prefix)
      continue
    }
    prefix = joinPath(prefix, component)
  }
  return unknown ? 'unknown' : 'none'
}

/**
 * Does `prefix/..` physically land somewhere other than the lexical collapse?
 *
 * Only when the component being cancelled is itself a link: an ancestor link, a
 * mapped `/tmp`, an 8.3 short name or a mapped drive above the `..` cancels out
 * on BOTH sides (exit review N6). So compare the physical parent OF THE PREFIX
 * with the physical path of the prefix's lexical parent:
 *
 *   parentDir(realpath(prefix))  vs  realpath(parentDir(prefix))
 *
 * (Exit review #2's earlier check compared `realpath(prefix)` with the LEXICAL
 * prefix, which flagged every ancestor link and the `/tmp` fold.)
 */
async function prefixMovesDotDot(prefix: string, context: MeasurementContext): Promise<Traversal> {
  const real = await readRealpath(context.probe, prefix)
  if (real === null) {
    // Only a path positively established missing is a confirmed no-op.
    return (await readLstat(context.probe, prefix)) === 'missing' ? 'none' : 'unknown'
  }
  const lexicalParent = parentDir(prefix)
  const realParent = await readRealpath(context.probe, lexicalParent)
  if (realParent === null) {
    return (await readLstat(context.probe, lexicalParent)) === 'missing' ? 'none' : 'unknown'
  }
  const realPath = normalizePath(real, context.platform).full
  const realParentPath = normalizePath(realParent, context.platform).full
  return !samePath(parentDir(realPath), realParentPath, context.platform) ? 'link' : 'none'
}

/**
 * The out-of-scope target's parent `realpath`s somewhere other than its lexical
 * spelling: the write goes through a link. That alone is NOT `symlinked`: `lstat`
 * reads through the link, so `exists`/`empty`/`mtime` already describe the real
 * file, and flagging every relocated folder (`Documents` → another drive, macOS
 * `/var` → `/private/var`) would drop those clearing facts (exit review N5).
 *
 * What matters is where the real target sits: its protected components are hits.
 * `undefined` when the parent resolves to the same directory, the real target is
 * unprotected, or nothing can be measured (absence, never a guess).
 */
async function outOfScopeThroughLink(
  detail: RedirectTargetDetail,
  context: MeasurementContext
): Promise<TargetOutcome | undefined> {
  const target = detail.path as string
  const realTarget = await physicalTarget(context.probe, target, context.platform, context.tmpRoot)
  if (realTarget === null) return undefined
  const realTargetPath = normalizePath(realTarget, context.platform).full
  if (samePath(realTargetPath, target, context.platform)) return undefined
  const protectedHits = withNewHits(
    detail.protectedHits,
    protectedComponentsOf(realProtectedComponents(realTargetPath, context)),
    context.platform
  )
  if (protectedHits.length === detail.protectedHits.length) return undefined
  return { detail: { ...detail, protectedHits } }
}

/**
 * Merge two measurements of the same resolved path (exit review N3): two
 * spellings can share it, and a plain reading must never erase a `symlinked`
 * one — an `exists:false` measured on the plain spelling would otherwise clear
 * a write that actually goes through a link.
 */
function mergeMeasurement(
  prior: RedirectMeasurement | undefined,
  next: RedirectMeasurement
): RedirectMeasurement {
  if (prior === undefined) return next
  if (prior.symlinked === true) return prior
  if (next.symlinked === true) return next
  return next
}

/** The normalised values of the host temp variables — what a hint can name. */
function tempVarRoots(scope: RedirectScope, platform: NodeJS.Platform): string[] {
  const roots: string[] = []
  for (const value of Object.values(scope.tempVars ?? {})) {
    if (typeof value !== 'string' || value.trim() === '') continue
    const full = normalizePath(value, platform).full
    if (!roots.includes(full)) roots.push(full)
  }
  return roots
}

/**
 * Does a `tempVarPath` hint stay inside the temp root it names (exit review
 * N7)? The lexical check in `ground-truth.ts` cannot see that `$TMPDIR/…/tlink`
 * is a junction out of temp, and an unresolvable target is never link-measured,
 * so the hint would clear an overwrite outside scratch space.
 *
 * The hint's parent (or nearest existing ancestor, for a not-yet-created scratch
 * path) must resolve inside the real temp root. A final file link is followed
 * too. Absence, unreadable evidence or a failed traversal drops the hint.
 */
interface HintOutcome {
  /** True only when the hint is contained in temp AND names no protected target. */
  stays: boolean
  /** Protected components the physical destination is known to hit. */
  protectedHits: string[]
}

/**
 * Does a `tempVarPath` hint name a safe scratch destination (exit review N7/R1)?
 * The lexical check in `ground-truth.ts` cannot see that `$TMPDIR/…/tlink` is a
 * junction out of temp, and an unresolvable target is never link-measured, so
 * the hint would clear an overwrite outside scratch space.
 *
 * The hint's parent (or nearest existing ancestor, for a not-yet-created scratch
 * path) must resolve inside the real temp root. The final file link is followed
 * too, and a `..` before the leaf is walked through the uncollapsed spelling.
 * A destination inside temp that names a PROTECTED component (`.claude`,
 * `.ssh`, …) is not a clearing hint either; its verified hits are retained.
 */
async function hintOutcome(
  detail: RedirectTargetDetail,
  context: MeasurementContext
): Promise<HintOutcome> {
  const hint = detail.tempVarPath as string
  const platform = context.platform
  let root: string | undefined
  for (const candidate of context.tempRoots) {
    if (!samePath(candidate, hint, platform) && !isDescendant(candidate, hint, platform)) continue
    // The deepest matching root is the temp directory the hint was built from.
    if (root === undefined || candidate.length > root.length) root = candidate
  }
  if (root === undefined) return { stays: false, protectedHits: [] }
  // The normalised hint has lost a `..`; the spelling before collapse is what
  // exposes `temp/jump/../x` when `jump` is a junction out of temp (R1).
  const spelling = detail.tempVarSpelling
  if (spelling !== undefined) {
    if (!isAbsolutePosixish(spelling, platform)) return { stays: false, protectedHits: [] }
    if ((await linkBeforeDotDotIn(spelling, context)) !== 'none') {
      return { stays: false, protectedHits: [] }
    }
  }
  const realRoot = await readRealpath(context.probe, root)
  if (realRoot === null) return { stays: false, protectedHits: [] }
  const realRootPath = normalizePath(realRoot, platform).full
  // A final file link must be followed too: `temp/leaf` may point outside temp.
  const leaf = await readLstat(context.probe, hint)
  if (leaf === 'error') return { stays: false, protectedHits: [] }
  let physical: string | null
  if (leaf !== 'missing' && leaf.isSymbolicLink()) {
    physical = await readRealpath(context.probe, hint)
    if (physical === null) return { stays: false, protectedHits: [] }
  } else {
    // Missing parents below an existing junction are reconstructed, never
    // assumed safe (R3); an ordinary new scratch file still resolves inside.
    physical = await physicalTarget(context.probe, hint, platform, context.tmpRoot)
    if (physical === null) return { stays: false, protectedHits: [] }
  }
  const physicalPath = normalizePath(physical, platform).full
  const protectedHits = protectedComponentsOf(realProtectedComponents(physicalPath, context))
  const inside =
    samePath(physicalPath, realRootPath, platform) ||
    isDescendant(realRootPath, physicalPath, platform)
  return { stays: inside && protectedHits.length === 0, protectedHits }
}

/** Two normalised absolute spellings name the same path (case-insensitively on win32). */
function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const fold = (s: string): string => (platform === 'win32' ? s.toLowerCase() : s)
  const norm = (s: string): string => fold(normalizePath(s, platform).full).replace(/\/+$/, '')
  return norm(a) === norm(b)
}

/** The last component of a normalised posix-ish path. */
function baseName(path: string): string {
  const at = path.lastIndexOf('/')
  return at < 0 ? path : path.slice(at + 1)
}

/**
 * `work` or `null` on timeout. A rejection also yields `null`: the caller then
 * builds the conservative fallback (negative evidence only, review forced).
 * Handlers are always attached, so a late rejection cannot go unhandled.
 */
function withinDeadline<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(
      () => {
        if (settled) return
        settled = true
        resolve(null)
      },
      Math.max(0, ms)
    )
    const finish = (value: T | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    work.then(finish, () => finish(null))
  })
}
