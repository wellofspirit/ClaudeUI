/**
 * Link-safe tree walking — the one primitive behind deleting and measuring a worktree.
 *
 * A worktree is full of things agents made by hand: `node_modules` and `vendor/x` junctions into
 * the main checkout, symlinks, 44k-file trees. Every entry is `lstat`ed and a link (symlink or
 * Windows junction) is treated as a LEAF: unlinked or counted itself, never entered, so the
 * target of a link is never touched. Deleting also goes through here instead of `fs.rm` because a
 * Windows lock (EBUSY/EPERM) must come back as a per-path failure list, not abort at the first
 * error. Node has no openat-style no-follow, so a link swapped in between the `lstat` and the
 * unlink is a residual race (ADR-112).
 *
 * Imports no Electron and no git, so the unit-node project tests it against plain temp dirs.
 */

import * as fs from 'fs'
import * as path from 'path'

export interface TreeFailure {
  path: string
  code: string
}

/** The filesystem calls the walkers use; tests inject failures through it. */
export interface TreeFs {
  lstat(p: string): Promise<fs.Stats>
  readdir(p: string): Promise<string[]>
  unlink(p: string): Promise<void>
  rmdir(p: string): Promise<void>
  chmod(p: string, mode: number): Promise<void>
}

const nodeFs: TreeFs = {
  lstat: (p) => fs.promises.lstat(p),
  readdir: (p) => fs.promises.readdir(p),
  unlink: (p) => fs.promises.unlink(p),
  rmdir: (p) => fs.promises.rmdir(p),
  chmod: (p, mode) => fs.promises.chmod(p, mode)
}

/** fs operations in flight: a 44k-file tree is neither serial nor an unbounded fan-out. */
const WALK_CONCURRENCY = 16
const PROGRESS_INTERVAL_MS = 250
/** Windows: how long a directory that will not go yet (delete-pending child, scanner) gets to settle. */
const WIN_RMDIR_BACKOFF_MS = 75

export function errorCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' && code ? code : 'UNKNOWN'
}

/** At most `max` tasks run at once; a finished task hands its slot straight to the next waiter. */
function createLimiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0
  const waiting: Array<() => void> = []
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve))
    else active++
    try {
      return await task()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else active--
    }
  }
}

/** Calls `emit` at most every PROGRESS_INTERVAL_MS; `flush` sends the latest unsent value. */
function createThrottle<T>(emit: ((value: T) => void) | undefined): {
  push(value: T): void
  flush(): void
} {
  let last = 0
  let pending: { value: T } | null = null
  return {
    push(value) {
      if (!emit) return
      const now = Date.now()
      if (now - last >= PROGRESS_INTERVAL_MS) {
        last = now
        pending = null
        emit(value)
      } else pending = { value }
    },
    flush() {
      if (emit && pending) emit(pending.value)
      pending = null
    }
  }
}

interface WalkVisitor {
  /** Names directly under the root to leave alone (the root then stays non-empty). */
  skipTopLevel?: ReadonlySet<string>
  /** A link, or anything that is not a directory. Throw to record a failure for it. */
  leaf(p: string, st: fs.Stats): Promise<void>
  /**
   * A real directory after all its children were handled. `clean` = none failed and none was
   * skipped. Return true when the directory itself is dealt with.
   */
  dir?(p: string, st: fs.Stats, clean: boolean): Promise<boolean>
  failure(p: string, err: unknown): void
  /** True once the answer is known: entries not started yet are skipped (in-flight ones finish). */
  stop?(): boolean
  /**
   * `leaf` does no filesystem work, so it runs without a slot of its own. Needed for `stop` to
   * take effect: a leaf queued behind the whole directory's pending lstats would count its
   * file only after all of them had run.
   */
  cheapLeaf?: boolean
}

/**
 * The shared no-follow walk. Visits children concurrently (bounded), directories post-order.
 * Resolves true when the entry at `root` and everything under it was handled.
 */
async function walkTree(root: string, visitor: WalkVisitor, tfs: TreeFs): Promise<boolean> {
  const limit = createLimiter(WALK_CONCURRENCY)

  const visit = async (p: string, depth: number): Promise<boolean> => {
    let st: fs.Stats
    try {
      // Checked once the slot is won, not when the visit is created: a directory's whole
      // listing is queued at once, and a stop must reach the entries still waiting.
      const got = await limit(async () => (visitor.stop?.() ? null : tfs.lstat(p)))
      if (!got) return true
      st = got
    } catch (err) {
      if (errorCode(err) === 'ENOENT') return true
      visitor.failure(p, err)
      return false
    }

    // A link is never entered, whatever it points at.
    if (st.isSymbolicLink() || !st.isDirectory()) {
      try {
        await (visitor.cheapLeaf ? visitor.leaf(p, st) : limit(() => visitor.leaf(p, st)))
        return true
      } catch (err) {
        if (errorCode(err) === 'ENOENT') return true
        visitor.failure(p, err)
        return false
      }
    }

    let names: string[]
    try {
      names = await limit(() => readdirRetry(tfs, p, st))
    } catch (err) {
      if (errorCode(err) === 'ENOENT') return true
      visitor.failure(p, err)
      return false
    }
    // Narrow the lstat -> readdir window: still the very directory that was classified, not a
    // link or another directory swapped in under the same name (a residual race remains, ADR-112).
    try {
      const again = await limit(() => tfs.lstat(p))
      if (!sameDirectory(st, again)) {
        visitor.failure(p, Object.assign(new Error('changed while walking'), { code: 'ECHANGED' }))
        return false
      }
    } catch (err) {
      if (errorCode(err) === 'ENOENT') return true
      visitor.failure(p, err)
      return false
    }
    let skipped = false
    const kept: string[] = []
    for (const name of names) {
      if (depth === 0 && visitor.skipTopLevel?.has(name)) skipped = true
      else kept.push(name)
    }
    const results = await Promise.all(kept.map((name) => visit(path.join(p, name), depth + 1)))
    const clean = !skipped && results.every(Boolean)
    if (!visitor.dir) return clean
    try {
      return await limit(() => visitor.dir!(p, st, clean))
    } catch (err) {
      if (errorCode(err) === 'ENOENT') return true
      visitor.failure(p, err)
      return false
    }
  }

  return visit(root, 0)
}

function sameDirectory(before: fs.Stats, after: fs.Stats): boolean {
  return (
    after.isDirectory() &&
    !after.isSymbolicLink() &&
    after.dev === before.dev &&
    after.ino === before.ino
  )
}

/** POSIX: an unreadable directory is made owner-accessible and read once more (C-S6). */
async function readdirRetry(tfs: TreeFs, p: string, st: fs.Stats): Promise<string[]> {
  try {
    return await tfs.readdir(p)
  } catch (err) {
    if (errorCode(err) !== 'EACCES' || process.platform === 'win32') throw err
    await tfs.chmod(p, (st.mode & 0o7777) | 0o700)
    return tfs.readdir(p)
  }
}

/**
 * Run `op`; on a permission error make the entry (then, on POSIX, its parent) writable and retry
 * once. The walk's `root` never gets its parent touched: that directory is outside what is being
 * deleted, and may be reached through a link.
 */
async function withPermissionRetry(
  tfs: TreeFs,
  p: string,
  noFileChmod: boolean,
  op: () => Promise<void>,
  root: string
): Promise<void> {
  try {
    return await op()
  } catch (err) {
    const code = errorCode(err)
    if (code !== 'EPERM' && code !== 'EACCES') throw err
    // Windows: git's pack files are read-only, and the attribute blocks the delete.
    if (!noFileChmod) {
      try {
        await tfs.chmod(p, 0o666)
        return await op()
      } catch (retryErr) {
        const retryCode = errorCode(retryErr)
        if (retryCode !== 'EPERM' && retryCode !== 'EACCES') throw retryErr
      }
    }
    // POSIX: removing a child needs write permission on the parent directory.
    if (process.platform === 'win32' || p === root) throw err
    const parent = path.dirname(p)
    const pst = await tfs.lstat(parent)
    // chmod follows links: never widen what a link points at.
    if (pst.isSymbolicLink()) throw err
    await tfs.chmod(parent, (pst.mode & 0o7777) | 0o700)
    return op()
  }
}

async function unlinkLeaf(tfs: TreeFs, p: string, st: fs.Stats, root: string): Promise<void> {
  const isLink = st.isSymbolicLink()
  try {
    // chmod follows links, so a link only ever gets the plain unlink / rmdir attempts.
    await withPermissionRetry(tfs, p, isLink, () => tfs.unlink(p), root)
  } catch (err) {
    if (!isLink) throw err
    // Windows: a directory link or junction can answer to rmdir rather than unlink.
    await tfs.rmdir(p)
  }
}

/**
 * rmdir with the permission retry; on Windows one short wait and a second attempt for
 * ENOTEMPTY/EBUSY, which is what a directory whose last child is still delete-pending (or being
 * scanned) answers for a moment after the child's unlink returned.
 */
async function rmdirSettled(tfs: TreeFs, p: string, root: string): Promise<void> {
  const attempt = (): Promise<void> => withPermissionRetry(tfs, p, true, () => tfs.rmdir(p), root)
  try {
    await attempt()
  } catch (err) {
    const code = errorCode(err)
    if (process.platform !== 'win32' || (code !== 'ENOTEMPTY' && code !== 'EBUSY')) throw err
    await new Promise<void>((resolve) => setTimeout(resolve, WIN_RMDIR_BACKOFF_MS))
    await attempt()
  }
}

export interface RemoveTreeOptions {
  /** Names directly under `root` to keep (the worktree's `.git` file). `root` itself then stays. */
  keepTopLevel?: string[]
  /** Throttled count of entries removed so far. */
  onProgress?: (removed: number) => void
  fs?: Partial<TreeFs>
}

export interface RemoveTreeResult {
  /** `root` no longer exists. */
  removed: boolean
  failures: TreeFailure[]
}

/**
 * Delete a tree without ever following a link. `root` itself is `lstat`ed: a link root is
 * unlinked, never entered. Never throws for a per-entry error: the error becomes a
 * `{path, code}` failure, the walk goes on, and a directory that still holds a failed entry is
 * left in place. ENOENT counts as success.
 */
export async function removeTreeLinkSafe(
  root: string,
  opts: RemoveTreeOptions = {}
): Promise<RemoveTreeResult> {
  const tfs: TreeFs = { ...nodeFs, ...opts.fs }
  const failures: TreeFailure[] = []
  const progress = createThrottle(opts.onProgress)
  let removed = 0
  const visitor: WalkVisitor = {
    skipTopLevel: opts.keepTopLevel?.length ? new Set(opts.keepTopLevel) : undefined,
    async leaf(p, st) {
      await unlinkLeaf(tfs, p, st, root)
      progress.push(++removed)
    },
    async dir(p, _st, clean) {
      if (!clean) return false
      await rmdirSettled(tfs, p, root)
      progress.push(++removed)
      return true
    },
    failure(p, err) {
      failures.push({ path: p, code: errorCode(err) })
    }
  }
  await walkTree(root, visitor, tfs)
  progress.flush()
  let gone = false
  try {
    await tfs.lstat(root)
  } catch (err) {
    gone = errorCode(err) === 'ENOENT'
  }
  return { removed: gone, failures }
}

export interface MeasureOptions {
  onProgress?: (progress: { files: number; bytes: number }) => void
  fs?: Partial<TreeFs>
}

export interface TreeMeasure {
  bytes: number
  files: number
  links: number
  errors: number
  newestMtimeMs: number
}

/**
 * Apparent size (`st.size`) of the regular files under `root`. A link is counted and neither
 * followed nor sized; an unreadable entry is counted in `errors`, never thrown. Every entry's
 * mtime feeds `newestMtimeMs` (a directory's changes when something is added or removed in it).
 */
export async function measureTree(root: string, opts: MeasureOptions = {}): Promise<TreeMeasure> {
  const tfs: TreeFs = { ...nodeFs, ...opts.fs }
  const out: TreeMeasure = { bytes: 0, files: 0, links: 0, errors: 0, newestMtimeMs: 0 }
  const progress = createThrottle(opts.onProgress)
  const touch = (st: fs.Stats): void => {
    if (st.mtimeMs > out.newestMtimeMs) out.newestMtimeMs = st.mtimeMs
  }
  await walkTree(
    root,
    {
      async leaf(_p, st) {
        touch(st)
        if (st.isSymbolicLink()) out.links++
        else if (st.isFile()) {
          out.files++
          out.bytes += st.size
          progress.push({ files: out.files, bytes: out.bytes })
        }
      },
      async dir(_p, st) {
        touch(st)
        return true
      },
      failure() {
        out.errors++
      }
    },
    tfs
  )
  progress.flush()
  return out
}

export interface TreeFileListing {
  /** Entries that are not directories and not links. */
  count: number
  /** Up to `limit` of them, `/`-separated relative paths, sorted. */
  sample: string[]
}

/**
 * The files a tree holds (links excluded), for judging whether a shell directory is empty.
 * `stopAfter`: end the walk once that many files were seen (the entries already in flight finish,
 * so `count` is then a lower bound that is at least `stopAfter`) — "does it hold any file?" must
 * not read a 44k-file directory to the end.
 */
export async function listTreeFiles(
  root: string,
  limit: number,
  opts: { fs?: Partial<TreeFs>; stopAfter?: number } = {}
): Promise<TreeFileListing> {
  const tfs: TreeFs = { ...nodeFs, ...opts.fs }
  const out: TreeFileListing = { count: 0, sample: [] }
  await walkTree(
    root,
    {
      async leaf(p, st) {
        if (st.isSymbolicLink()) return
        out.count++
        if (out.sample.length < limit)
          out.sample.push(path.relative(root, p).split(path.sep).join('/') || path.basename(p))
      },
      failure() {
        // an unreadable entry is not evidence of a file
      },
      stop: () => opts.stopAfter !== undefined && out.count >= opts.stopAfter,
      cheapLeaf: true
    },
    tfs
  )
  out.sample.sort()
  return out
}
