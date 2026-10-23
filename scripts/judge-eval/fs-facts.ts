/**
 * The `--fs-facts` adapter: historical measurements, replayed as the fs probe
 * `captureRedirects` measures through.
 *
 * It lives here, not in `run.ts`, so a unit test can import the exact functions
 * the runner calls without importing the runner's executable entry point (which
 * would start an eval) — exit review Astra C1.
 *
 * The rule is the measurement module's rule: NEVER FABRICATE. A historical fact
 * that records only `exists` did not record a size or an mtime, so the adapter
 * omits those fields and the capture emits no `empty`/`modifiedSinceSessionStart`
 * (`?? 0` used to invent `empty:true`, which the ILD NOT-list then cleared).
 */

/** One historical filesystem fact for a resolved redirect target. */
export interface FsFactsPath {
  exists: boolean
  size?: number
  mtimeMs?: number
  symlink?: boolean
  realpath?: string
}

export interface FsFactsCase {
  sessionStartMs: number
  paths: Record<string, FsFactsPath>
}

export type FsFacts = Record<string, FsFactsCase>

/** The `fs.Stats` fields `captureRedirects` reads; an absent field = not measured. */
export interface FsFactsStat {
  isSymbolicLink(): boolean
  isFile(): boolean
  size?: number
  mtimeMs?: number
}

/**
 * A `fs.Stats` stand-in built from a fact. `size`/`mtimeMs` are carried over ONLY
 * when the fact recorded them: an exists-only fact yields an existing regular
 * file with no size and no mtime, so production measurement reports
 * `exists:true` and nothing it did not measure.
 */
export function statFromFacts(fact: FsFactsPath): FsFactsStat {
  return {
    isSymbolicLink: () => fact.symlink === true,
    isFile: () => fact.symlink !== true,
    ...(typeof fact.size === 'number' ? { size: fact.size } : {}),
    ...(typeof fact.mtimeMs === 'number' ? { mtimeMs: fact.mtimeMs } : {})
  }
}

function enoent(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: no such file or directory, lstat '${path}'`), {
    code: 'ENOENT'
  })
}

/**
 * What the probe needs to know about the case to tell a LEAF from an ANCESTOR:
 * `RedirectProbe.lstat` receives only a path, and production measures both kinds
 * through it (a target, then its parent, the prefixes before a `..`, the scope
 * roots).
 */
export interface FsFactsTargets {
  /**
   * The resolved redirect targets that lie OUT of every scope root, exactly as
   * `redirectTargetDetails` reports them (see {@link outOfScopeTargets}). Only
   * these have their own `exists`/`empty`/`modifiedSinceSessionStart` reported to
   * the judge, so only these must stay "not measured" when no fact was recorded.
   */
  outOfScope: readonly string[]
}

/** The `path` of every target of `details` that production would measure (out of scope, resolved). */
export function outOfScopeTargets(
  details: readonly { path?: string; root?: string }[] | null | undefined
): string[] {
  const out: string[] = []
  for (const detail of details ?? []) {
    if (detail.path !== undefined && detail.root === undefined) out.push(detail.path)
  }
  return out
}

/**
 * The answer for a path nothing was recorded about: an ordinary, non-link entry
 * of the original machine's tree. Its kind, size and mtime are NOT claimed
 * (`isFile` is false, no `size`, no `mtimeMs`), so nothing is invented.
 */
const ORDINARY_ENTRY: FsFactsStat = {
  isSymbolicLink: () => false,
  isFile: () => false
}

/**
 * The fake probe. Recorded facts always win. For a path with no fact:
 *
 * - WITHOUT `targets` the probe cannot tell a leaf from an ancestor, so every such
 *   path is "not measured" (a non-ENOENT error) — the conservative answer, which
 *   production turns into `reviewRequired`.
 * - WITH `targets` the probe models the original machine as an ordinary
 *   directory tree, assuming NO links on it unless a fact records one:
 *   - `lstat` of an out-of-scope target (the leaf) → "not measured". Inventing
 *     `exists`/`empty` for it would show the judge a fact nobody measured, and a
 *     missing path is NOT `exists:false` — the replay is a different machine.
 *   - `lstat` of anything else (a scope root, an ancestor directory, an in-scope
 *     leaf, whose own state production never reports) → an ordinary entry, not a
 *     link.
 *   - `realpath` of anything else → the path itself, as given (production
 *     normalises the answer). Without this, a case whose redirects are plainly in
 *     scope flips to `allInScope:false` because production now withholds the clean
 *     claim when a probe fails, and the judge sees a different case than the
 *     original machine did.
 *
 * A recorded `exists:false` keeps answering ENOENT, so a missing ancestor still
 * makes production climb to the nearest existing one.
 */
export function fsFactsProbe(
  facts: FsFactsCase,
  targets?: FsFactsTargets
): {
  lstat(path: string): Promise<FsFactsStat>
  realpath(path: string): Promise<string>
} {
  const unmeasuredLeaves = new Set(targets?.outOfScope ?? [])
  const unmeasured = (path: string): Error => new Error(`no fs facts for ${path} (not measured)`)
  /** `undefined` = no fact; the caller decides what that means for its call kind. */
  const recorded = (path: string): FsFactsPath | undefined => {
    const fact = facts.paths[path]
    if (fact && !fact.exists) throw enoent(path)
    return fact
  }
  const isOrdinary = (path: string): boolean => targets !== undefined && !unmeasuredLeaves.has(path)
  return {
    async lstat(path) {
      const fact = recorded(path)
      if (fact) return statFromFacts(fact)
      if (isOrdinary(path)) return ORDINARY_ENTRY
      throw unmeasured(path)
    },
    async realpath(path) {
      const fact = recorded(path)
      if (fact?.symlink === true) {
        if (fact.realpath === undefined)
          throw new Error(`no realpath fact for ${path} (not measured)`)
        return fact.realpath
      }
      if (fact || isOrdinary(path)) return path
      throw unmeasured(path)
    }
  }
}
