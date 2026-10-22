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
 *    path is inside the tree, the file is not.
 *
 * The pure scanner's detail API is the input ({@link redirectTargetDetails});
 * {@link summarizeRedirects} is the output, so this file adds measurement and
 * nothing else. `probe` is the test seam; the default reads the real fs.
 *
 * One refinement (owner-approved): a target that IS a link but whose
 * `realpath` lands inside a scope root with no protected component is
 * classified by that real path — it is an in-scope write through a link, not an
 * escape. A dangling link, or one resolving out of scope or onto a protected
 * component, is `symlinked`.
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

/** How long the callers let measurement run before falling back to the pure result. */
export const REDIRECT_CAPTURE_TIMEOUT_MS = 400

/** The slice of `fs.Stats` this file reads, so a test probe need not fake one. */
export interface RedirectStat {
  isSymbolicLink(): boolean
  isFile(): boolean
  size: number
  mtimeMs: number
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
 * failure or when the deadline expires the pure analysis is returned, so a
 * broken probe can only ever cost an escalation, never clear a target.
 */
export async function captureRedirects(
  command: string,
  scope: RedirectScope,
  options: CaptureRedirectsOptions
): Promise<RedirectAnalysis | null> {
  const platform = options.platform ?? process.platform
  const details = redirectTargetDetails(command, scope, platform)
  if (details === null) return null
  const measured = await withinDeadline(
    measureRedirects(details, scope, platform, options.probe ?? hostProbe, options.sessionStartMs),
    options.timeoutMs ?? REDIRECT_CAPTURE_TIMEOUT_MS
  )
  if (measured === null) return summarizeRedirects(details)
  return summarizeRedirects(measured.details, measured.measured)
}

interface MeasuredTargets {
  details: RedirectTargetDetail[]
  measured: Map<string, RedirectMeasurement>
}

interface MeasurementContext {
  /** The probe, with win32's Git-Bash `/tmp` spelling folded onto the host temp dir. */
  probe: RedirectProbe
  platform: NodeJS.Platform
  sessionStartMs: number
  /** The session cwd, normalised: the protected check is relative to it. */
  cwd: string
  /** Scope-root spelling → its real path, for roots `realpath` could establish. */
  realRoots: ReadonlyMap<string, string>
}

/**
 * On win32, Git Bash's `/tmp` is the user temp dir (the usertemp mount), but Node
 * cannot see that mount: `realpath('/tmp')` is `ENOENT` and `lstat('/tmp/x')`
 * probes `<current drive>:\tmp\x`. Scope roots carry the host temp dir as a
 * NATIVE spelling, so `/tmp` is measured through it and `/tmp/…` targets are
 * read there (exit review #3). Only the conventional mount spelling is folded;
 * a POSIX host (and every other root) is untouched.
 */
const GIT_BASH_TMP = '/tmp'

/** The host temp spelling a win32 scope stands `/tmp` for, or `undefined` elsewhere. */
function gitBashTmpRoot(scope: RedirectScope, platform: NodeJS.Platform): string | undefined {
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

/** `probe` with Git Bash's `/tmp` spelling read through the host temp dir. */
function probeFor(probe: RedirectProbe, hostTemp: string | undefined): RedirectProbe {
  if (hostTemp === undefined) return probe
  const map = (path: string): string => {
    if (path === GIT_BASH_TMP) return hostTemp
    if (path.startsWith(`${GIT_BASH_TMP}/`))
      return `${hostTemp}/${path.slice(GIT_BASH_TMP.length + 1)}`
    return path
  }
  return {
    lstat: (path) => probe.lstat(map(path)),
    realpath: (path) => probe.realpath(map(path))
  }
}

async function measureRedirects(
  details: readonly RedirectTargetDetail[],
  scope: RedirectScope,
  platform: NodeJS.Platform,
  probe: RedirectProbe,
  sessionStartMs: number
): Promise<MeasuredTargets> {
  const hostTemp = gitBashTmpRoot(scope, platform)
  const mapped = probeFor(probe, hostTemp)
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
    realRoots
  }
  const measured = new Map<string, RedirectMeasurement>()
  const results = await Promise.all(
    details.map(async (detail) => {
      if (detail.path === undefined) return undefined
      try {
        const outcome = await measureTarget(detail, context)
        if (outcome.measurement !== undefined) measured.set(detail.path, outcome.measurement)
        return outcome.detail
      } catch {
        // Absence, never a guess.
        return undefined
      }
    })
  )
  return {
    // A rewritten detail (a link that resolves in scope) keeps its position, so
    // the meta line's order still follows the command.
    details: details.map((detail, i) => results[i] ?? detail),
    measured
  }
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
  const stat = await readLstat(context.probe, target)
  // A failed lstat tells us nothing — not even that the file is absent.
  if (stat === 'error') return {}

  if (stat !== 'missing' && stat.isSymbolicLink()) {
    const real = await readRealpath(context.probe, target)
    // A dangling link (or one we cannot resolve) is never the file it names.
    if (real === null) return { measurement: { symlinked: true } }
    const realPath = normalizePath(real, context.platform).full
    const root = deepestContainingRoot(context.realRoots, realPath, context.platform)
    const components = protectedComponentsFor(context.cwd, realPath, context.platform)
    if (root !== undefined && protectedComponentsOf(components).length === 0) {
      // The lexical path is a link; the file it writes is INSIDE the tree. Report
      // the real path so `summarizeRedirects` treats it as an ordinary in-scope
      // target instead of an escape.
      return { detail: { ...detail, path: realPath, root: root.spelling } }
    }
    return { measurement: { symlinked: true } }
  }

  // A written `sub/../x` does not prove `sub` is a directory: if any prefix
  // BEFORE a `..` is a link, the collapsed path is not where the write lands.
  if (await linkBeforeDotDot(detail, context)) return { measurement: { symlinked: true } }

  if (detail.root !== undefined) {
    // In scope, but `realpath` the DIRECTORY it writes through. A parent that is
    // a link out of the tree makes `..`-free spellings lie; a target that does
    // not exist yet is exactly when a planted parent link matters most.
    const inside = await parentInsideRoot(detail, context)
    if (inside === false) return { measurement: { symlinked: true } }
    return {}
  }

  // Out of scope, but the DIRECTORY can still be a link: `../outside/keys/…`
  // through a junction onto `~/.ssh` writes a protected file while the spelling
  // looks ordinary (exit review rec). Read the real parent; a different
  // directory is `symlinked`, and protected components of the real target are a
  // protected hit.
  const linked = await outOfScopeThroughLink(detail, context)
  if (linked !== undefined) return linked

  if (stat === 'missing') return { measurement: { exists: false } }
  if (stat.isFile()) {
    return {
      measurement: {
        exists: true,
        empty: stat.size === 0,
        modifiedSinceSessionStart: stat.mtimeMs >= context.sessionStartMs
      }
    }
  }
  // A directory / device / FIFO target exists, but has no "empty" or "mtime of
  // the file's content" fact to report.
  return { measurement: { exists: true } }
}

/** `true` inside, `false` outside, `null` when `realpath` could not establish it. */
async function parentInsideRoot(
  detail: RedirectTargetDetail,
  context: MeasurementContext
): Promise<boolean | null> {
  const rootReal = context.realRoots.get(detail.root as string)
  if (rootReal === undefined) return null
  const parentReal = await readRealpath(context.probe, parentDir(detail.path as string))
  if (parentReal === null) return null
  const real = normalizePath(parentReal, context.platform).full
  return real === rootReal || isDescendant(rootReal, real, context.platform)
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
 * A prefix `realpath` cannot establish (usually because it does not exist)
 * proves nothing and is skipped: absence is never a fabrication.
 */
async function linkBeforeDotDot(
  detail: RedirectTargetDetail,
  context: MeasurementContext
): Promise<boolean> {
  for (const spelling of dotDotReadings(detail, context.platform)) {
    if (await linkBeforeDotDotIn(spelling, context)) return true
  }
  return false
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
async function linkBeforeDotDotIn(spelling: string, context: MeasurementContext): Promise<boolean> {
  const drive = /^([A-Za-z]:)\//.exec(spelling)
  const root = drive ? `${drive[1]}/` : '/'
  let prefix = root
  for (const component of spelling.slice(root.length).split('/')) {
    if (component === '' || component === '.') continue
    if (component === '..') {
      const real = await readRealpath(context.probe, prefix)
      if (real !== null) {
        const realPath = normalizePath(real, context.platform).full
        if (!samePath(realPath, prefix, context.platform)) return true
      }
      prefix = parentDir(prefix)
      continue
    }
    prefix = joinPath(prefix, component)
  }
  return false
}

/**
 * The out-of-scope target's parent `realpath`s somewhere other than its lexical
 * spelling: the write goes through a link, so it is `symlinked` and the real
 * target's protected components are hits. `undefined` when the parent resolves to
 * the same directory (or cannot be measured at all — absence, never a guess).
 */
async function outOfScopeThroughLink(
  detail: RedirectTargetDetail,
  context: MeasurementContext
): Promise<TargetOutcome | undefined> {
  const target = detail.path as string
  const parent = parentDir(target)
  const realParent = await readRealpath(context.probe, parent)
  if (realParent === null) return undefined
  const realParentPath = normalizePath(realParent, context.platform).full
  if (samePath(realParentPath, parent, context.platform)) return undefined
  const realTarget = joinPath(realParentPath, baseName(target))
  const hits = protectedComponentsFor(context.cwd, realTarget, context.platform)
  const protectedHits = [
    ...detail.protectedHits,
    ...protectedComponentsOf(hits).filter((hit) => !detail.protectedHits.includes(hit))
  ]
  if (protectedHits.length === 0) return { measurement: { symlinked: true } }
  return {
    detail: { ...detail, protectedHits },
    measurement: { symlinked: true }
  }
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
 * returns the pure result, which is this module's "nothing was measured" state.
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
