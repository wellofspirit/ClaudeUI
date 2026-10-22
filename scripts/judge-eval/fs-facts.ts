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
 * The fake probe: facts answer, absence throws a non-ENOENT "not measured" error.
 * A path missing from the facts is NOT `exists:false` — the replay is a different
 * machine, and inventing absence would clear the policy's presumption.
 */
export function fsFactsProbe(facts: FsFactsCase): {
  lstat(path: string): Promise<FsFactsStat>
  realpath(path: string): Promise<string>
} {
  const lookup = (path: string): FsFactsPath => {
    const fact = facts.paths[path]
    if (!fact) throw new Error(`no fs facts for ${path} (not measured)`)
    if (!fact.exists) throw enoent(path)
    return fact
  }
  return {
    async lstat(path) {
      return statFromFacts(lookup(path))
    },
    async realpath(path) {
      const fact = lookup(path)
      if (fact.symlink === true) {
        if (fact.realpath === undefined)
          throw new Error(`no realpath fact for ${path} (not measured)`)
        return fact.realpath
      }
      return path
    }
  }
}
