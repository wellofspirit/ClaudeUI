/**
 * Where a repo and its linked worktrees are — filesystem facts only, no git spawn.
 *
 * Everything here is derived by walking up to the first `.git` and reading the few small files
 * git keeps there (`.git` file, `<common>/worktrees/<id>/{commondir,gitdir,HEAD}`). The repo root
 * is therefore never taken from the wire and never from `--show-toplevel` (which answers the
 * WORKTREE when the caller's cwd is one, and nothing when that worktree was deleted).
 *
 * Sync on purpose: a handful of small reads per cwd, cached, called from listing code.
 */

import * as fs from 'fs'
import * as path from 'path'
import type { LinkedWorktree } from '../../shared/types'

/**
 * One spelling for one location: absolute, forward slashes, no trailing separator, no `\\?\`
 * prefix, lower-cased on win32 (case-insensitive file system). The stable id of a worktree and
 * the key every path comparison goes through. `platform` is for tests.
 */
export function normaliseWorktreePath(
  p: string,
  platform: NodeJS.Platform = process.platform
): string {
  const win = platform === 'win32'
  const impl = win ? path.win32 : path.posix
  let r = impl.resolve(p)
  if (win) {
    r = r.replace(/\\/g, '/').replace(/^\/\/\?\//, '')
    r = r.toLowerCase()
  }
  if (r.length > 1 && r.endsWith('/') && !/^[a-z]:\/$/.test(r)) r = r.replace(/\/+$/, '')
  return r
}

function isFilesystemRoot(normalised: string): boolean {
  return (
    normalised === '/' || /^[a-z]:\/$/.test(normalised) || /^\/\/[^/]+\/[^/]+$/.test(normalised)
  )
}

/** `candidate` is `root` or inside it (both spellings are normalised first). */
export function pathEqualOrInside(root: string, candidate: string): boolean {
  const r = normaliseWorktreePath(root)
  const c = normaliseWorktreePath(candidate)
  if (c === r) return true
  return c.startsWith(r.endsWith('/') ? r : `${r}/`)
}

/**
 * The canonical spelling of a path (8.3 names, drive-letter case, links). A path that does not
 * exist yet is canonical up to its nearest existing ancestor and lexical below it, so a link in
 * the middle of a missing path still shows where the path would really be.
 */
export function realOrResolved(p: string): string {
  const resolved = path.resolve(p)
  const tail: string[] = []
  let head = resolved
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(head), ...tail.reverse())
    } catch {
      const parent = path.dirname(head)
      if (parent === head) return resolved
      tail.push(path.basename(head))
      head = parent
    }
  }
}

/** `dir` really sits directly under `parent` (links in either spelling resolved). */
export function isRealChildOf(parent: string, dir: string): boolean {
  return samePath(path.dirname(realOrResolved(dir)), parent)
}

/**
 * `candidate` is `root` or inside it by the lexical spelling OR by the canonical one — either
 * side may be spelled through a link or a short name (C-S8).
 */
export function pathEqualOrInsideReal(root: string, candidate: string): boolean {
  return (
    pathEqualOrInside(root, candidate) ||
    pathEqualOrInside(realOrResolved(root), realOrResolved(candidate))
  )
}

/** Both spellings name the same place. */
export function samePath(a: string, b: string): boolean {
  return (
    normaliseWorktreePath(a) === normaliseWorktreePath(b) ||
    normaliseWorktreePath(realOrResolved(a)) === normaliseWorktreePath(realOrResolved(b))
  )
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p)
  } catch {
    return null
  }
}

export function readSmallFile(p: string): string | null {
  try {
    const st = fs.lstatSync(p)
    if (!st.isFile() || st.size > 4096) return null
    return fs.readFileSync(p, 'utf-8')
  } catch {
    return null
  }
}

/** Where git keeps the facts about the repository a directory belongs to. */
export interface GitLocation {
  /** The directory that holds the `.git` entry found. */
  topDir: string
  /** The git dir shared by the main worktree and every linked one. */
  commonDir: string
  /**
   * The main worktree. For a linked worktree: the common dir's parent, only when that dir is
   * `.git` itself (a bare repo's or a submodule's worktree has none). A submodule's own `.git`
   * file makes the submodule directory its root.
   */
  repoRoot: string | null
  /** Set when `topDir` is a linked worktree: its admin dir `<common>/worktrees/<id>`. */
  adminDir: string | null
}

/** The `gitdir: <x>` target of a `.git` file, resolved against the directory holding it. */
export function readGitFilePointer(dotGitFile: string): string | null {
  const text = readSmallFile(dotGitFile)
  const m = text?.match(/^gitdir:\s*(.+?)\s*$/m)
  return m ? path.resolve(path.dirname(dotGitFile), m[1]) : null
}

/**
 * Walk up from the nearest existing ancestor of `start` to the first `.git` and interpret it. A
 * `.git` that is a link, or a `.git` file whose structure does not hold up, ends the search with
 * null — a repo further up is not the repo of this directory.
 */
export function locateGit(start: string): GitLocation | null {
  let dir = path.resolve(start)
  for (;;) {
    const dotGit = path.join(dir, '.git')
    const st = lstatOrNull(dotGit)
    if (st) return interpretDotGit(dir, dotGit, st)
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function interpretDotGit(dir: string, dotGit: string, st: fs.Stats): GitLocation | null {
  // `st` is an lstat: a link to a directory or file is neither, and ends the search below.
  if (st.isDirectory()) return { topDir: dir, commonDir: dotGit, repoRoot: dir, adminDir: null }
  if (!st.isFile()) return null
  const gitdir = readGitFilePointer(dotGit)
  if (!gitdir) return null
  let gitdirStat: fs.Stats | null
  try {
    gitdirStat = fs.statSync(gitdir)
  } catch {
    gitdirStat = null
  }
  if (!gitdirStat?.isDirectory()) return null
  const commondirText = readSmallFile(path.join(gitdir, 'commondir'))
  if (commondirText === null) {
    // A submodule's or a --separate-git-dir repo's own pointer: the directory is its root.
    return { topDir: dir, commonDir: gitdir, repoRoot: dir, adminDir: null }
  }
  const common = path.resolve(gitdir, commondirText.trim())
  const adminParent = path.dirname(gitdir)
  const structured =
    path.basename(adminParent).toLowerCase() === 'worktrees' &&
    samePath(path.dirname(adminParent), common)
  if (!structured) return null
  let repoRoot: string | null = null
  if (path.basename(common) === '.git') {
    const candidate = path.dirname(common)
    const rootDotGit = lstatOrNull(path.join(candidate, '.git'))
    if (rootDotGit?.isDirectory() && !rootDotGit.isSymbolicLink()) repoRoot = candidate
  }
  return { topDir: dir, commonDir: common, repoRoot, adminDir: gitdir }
}

/** The repo's main working tree for a path anywhere in it, in one of its worktrees or in a deleted one. */
export function resolveRepoRoot(cwdOrPath: string): string | null {
  return locateGit(cwdOrPath)?.repoRoot ?? null
}

/** `ref: refs/heads/b` -> b; a sha, or anything else, -> '' (detached). */
function branchOfHead(adminDir: string): string {
  const text = readSmallFile(path.join(adminDir, 'HEAD'))
  const m = text?.match(/^ref:\s*refs\/heads\/(.+?)\s*$/m)
  return m ? m[1] : ''
}

export type WorktreeLocation = 'managed' | 'opencode' | 'other'

/**
 * Classify a worktree directory by layout (display only): under `<repo>/.claude/worktrees`;
 * opencode `<...>/worktree/<6 chars>/<slug>`. The name is the last segment, the path below the
 * managed root for a managed one.
 */
export function classifyWorktreeLocation(
  worktreePath: string,
  managedRoot: string | null
): { location: WorktreeLocation; name: string } {
  const p = path.resolve(worktreePath)
  const last = path.basename(p)
  if (managedRoot && normaliseWorktreePath(p) !== normaliseWorktreePath(managedRoot)) {
    // Lexically AND really inside: a junction below the managed root leads out of it.
    if (
      pathEqualOrInside(managedRoot, p) &&
      pathEqualOrInside(realOrResolved(managedRoot), realOrResolved(p))
    ) {
      const rel = path.relative(path.resolve(managedRoot), p).split(path.sep).join('/')
      return { location: 'managed', name: rel || last }
    }
  }
  const bucket = path.basename(path.dirname(p))
  const parentOfBucket = path.basename(path.dirname(path.dirname(p))).toLowerCase()
  if (bucket.length === 6 && parentOfBucket === 'worktree')
    return { location: 'opencode', name: last }
  return { location: 'other', name: last }
}

interface LinkedCacheEntry {
  found: LinkedWorktree
  adminDir: string
}

const linkedCache = new Map<string, LinkedCacheEntry>()
/** cwd key -> `Date.now()` until which "not a linked worktree" is trusted. */
const linkedMisses = new Map<string, number>()
/** How long a miss is trusted: a listing refresh re-asks every group's cwd, most of them plain repos. */
const LINKED_MISS_TTL_MS = 30_000
const LINKED_MISS_MAX = 2000
/** Hits are bounded the same way: one entry per distinct cwd spelling asked about. */
const LINKED_CACHE_MAX = 2000

/**
 * The linked worktree a cwd is in, read from the disk now (no cache): for a decision that is
 * recorded or that gates a permission input.
 */
export function linkedWorktreeOfUncached(cwd: string): LinkedWorktree | null {
  return locateLinked(cwd)?.found ?? null
}

function locateLinked(cwd: string): LinkedCacheEntry | null {
  const loc = locateGit(cwd)
  if (!loc?.adminDir || !loc.repoRoot) return null
  return {
    adminDir: loc.adminDir,
    found: {
      worktreePath: loc.topDir,
      repoRoot: loc.repoRoot,
      name: classifyWorktreeLocation(loc.topDir, null).name,
      branch: branchOfHead(loc.adminDir)
    }
  }
}

/** A cached worktree is still one: its `.git` is a file and the admin dir it points into exists. */
function stillLinked(entry: LinkedCacheEntry): boolean {
  if (!lstatOrNull(path.join(entry.found.worktreePath, '.git'))?.isFile()) return false
  try {
    return fs.statSync(entry.adminDir).isDirectory()
  } catch {
    return false
  }
}

/**
 * The linked worktree a cwd is in (the cwd itself or any directory under it), or null for a
 * main checkout, a plain directory, a submodule, or a worktree whose repo root cannot be told.
 * Filesystem only. A hit is revalidated with an lstat and a stat and its branch re-read from
 * HEAD each time (a worktree removed behind our back, or a checkout inside it, shows at once); a
 * miss is trusted for {@link LINKED_MISS_TTL_MS} (a directory can become a worktree later).
 * Drop both with {@link forgetLinkedWorktrees} when a worktree is removed or created.
 */
export function linkedWorktreeOf(cwd: string): LinkedWorktree | null {
  const key = normaliseWorktreePath(cwd)
  const hit = linkedCache.get(key)
  if (hit) {
    if (stillLinked(hit)) {
      const branch = branchOfHead(hit.adminDir)
      if (branch !== hit.found.branch) hit.found = { ...hit.found, branch }
      return hit.found
    }
    linkedCache.delete(key)
  }
  const now = Date.now()
  const missUntil = linkedMisses.get(key)
  if (missUntil !== undefined) {
    if (now < missUntil) return null
    linkedMisses.delete(key)
  }
  const located = locateLinked(cwd)
  if (!located) {
    if (linkedMisses.size >= LINKED_MISS_MAX) linkedMisses.clear()
    linkedMisses.set(key, now + LINKED_MISS_TTL_MS)
    return null
  }
  if (linkedCache.size >= LINKED_CACHE_MAX) linkedCache.clear()
  linkedCache.set(key, located)
  return located.found
}

/** Drop cached lookups for these worktree paths (and anything inside them); none = all. */
export function forgetLinkedWorktrees(worktreePaths?: string[]): void {
  if (!worktreePaths) {
    linkedCache.clear()
    linkedMisses.clear()
    return
  }
  for (const [key, value] of linkedCache) {
    if (worktreePaths.some((p) => pathEqualOrInside(p, value.found.worktreePath)))
      linkedCache.delete(key)
  }
  for (const key of linkedMisses.keys()) {
    if (worktreePaths.some((p) => pathEqualOrInside(p, key))) linkedMisses.delete(key)
  }
}

/** Never a removal target: the filesystem root, or a drive root. */
export function isFilesystemRootPath(p: string): boolean {
  return isFilesystemRoot(normaliseWorktreePath(p))
}
