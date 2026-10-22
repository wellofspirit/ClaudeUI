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
import {
  protectedComponentsOf,
  redirectTargetDetails,
  summarizeRedirects,
  type RedirectAnalysis,
  type RedirectMeasurement,
  type RedirectScope,
  type RedirectTargetDetail
} from './ground-truth'
import { isDescendant, normalizePath } from './shell-lexical'

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
  probe: RedirectProbe
  platform: NodeJS.Platform
  sessionStartMs: number
  /** The session cwd, normalised: the protected check is relative to it. */
  cwd: string
  /** Scope-root spelling → its real path, for roots `realpath` could establish. */
  realRoots: ReadonlyMap<string, string>
}

async function measureRedirects(
  details: readonly RedirectTargetDetail[],
  scope: RedirectScope,
  platform: NodeJS.Platform,
  probe: RedirectProbe,
  sessionStartMs: number
): Promise<MeasuredTargets> {
  const realRoots = new Map<string, string>()
  await Promise.all(
    scopeRoots(scope, platform).map(async (root) => {
      const real = await readRealpath(probe, root)
      if (real !== null) realRoots.set(root, normalizePath(real, platform).full)
    })
  )

  const context: MeasurementContext = {
    probe,
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
 * A prefix `realpath` cannot establish (usually because it does not exist)
 * proves nothing and is skipped: absence is never a fabrication.
 */
async function linkBeforeDotDot(
  detail: RedirectTargetDetail,
  context: MeasurementContext
): Promise<boolean> {
  const components = detail.raw
    .replace(/\\/g, '/')
    .split('/')
    .filter((c) => c.length > 0 && c !== '.')
  if (!components.includes('..') || detail.base === undefined) return false
  let prefix = detail.base.replace(/\/+$/, '')
  for (const component of components) {
    if (component === '..') {
      if (prefix !== '') {
        const real = await readRealpath(context.probe, prefix)
        if (real !== null) {
          const realPath = normalizePath(real, context.platform).full
          if (realPath !== normalizePath(prefix, context.platform).full) return true
        }
      }
      prefix = prefix === '' ? '' : parentDir(prefix)
      continue
    }
    prefix = joinPath(prefix, component)
  }
  return false
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
