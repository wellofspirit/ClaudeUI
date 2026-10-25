import { simpleGit, type SimpleGit } from 'simple-git'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type {
  WorktreeInfo,
  WorktreeStatus,
  WorktreeInventory,
  WorktreeInventoryEntry,
  WorktreeInspection,
  WorktreeSize,
  WorktreeRemoveResult
} from '../../shared/types'
import { logger } from './logger'
import { isPathInside } from './path-containment'
import { listTreeFiles, measureTree, removeTreeLinkSafe, type TreeFailure } from './worktree-fs'
import {
  collectHolders,
  createHolderMatcher,
  holdersOf,
  type HolderSources
} from './worktree-holders'
import {
  classifyWorktreeLocation,
  forgetLinkedWorktrees,
  isFilesystemRootPath,
  isRealChildOf,
  locateGit,
  normaliseWorktreePath,
  pathEqualOrInside,
  readGitFilePointer,
  readSmallFile,
  realOrResolved,
  resolveRepoRoot,
  samePath,
  type GitLocation
} from './worktree-root'

const LOG = 'worktree'
const WORKTREES_DIR = '.claude/worktrees'
const UNCOMMITTED_SAMPLE_MAX = 20
const COMMIT_SAMPLE_MAX = 10
const FAILURES_MAX = 20

/**
 * Worktree names become both a directory segment (`<root>/.claude/worktrees/<name>`)
 * and a git branch (`worktree-<name>`). Restrict them to a conservative,
 * separator-free character set so a renderer/model-supplied name can never
 * traverse out of the managed directory (`../..`) or inject git ref syntax.
 */
const WORKTREE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const WORKTREE_NAME_MAX = 100

/** Absolute path of the managed worktrees directory for a given git root. */
function getManagedWorktreesRoot(gitRoot: string): string {
  return path.join(gitRoot, WORKTREES_DIR)
}

/** Throw unless `name` is a safe worktree name (main-side enforcement of R2). */
export function validateWorktreeName(name: string): void {
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name.length > WORKTREE_NAME_MAX ||
    name === '.' ||
    name === '..' ||
    !WORKTREE_NAME_RE.test(name)
  ) {
    throw new Error(`Invalid worktree name: ${JSON.stringify(name)}`)
  }
}

/** The branch HEAD currently points at in the repo root, or null if detached. */
async function getCurrentBranch(git: SimpleGit): Promise<string | null> {
  try {
    const branch = (await git.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    return branch === 'HEAD' ? null : branch
  } catch {
    return null
  }
}

/** The branch `origin/HEAD` points at (`main` for `origin/main`), or null without a remote. */
async function getRemoteDefaultBranch(git: SimpleGit): Promise<string | null> {
  try {
    const ref = (await git.raw(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim()
    return ref.startsWith('origin/') ? ref.slice('origin/'.length) : null
  } catch {
    return null
  }
}

function requireRepoRoot(cwd: string): string {
  const root = resolveRepoRoot(cwd)
  if (!root) throw new Error(`Not inside a git repository: ${cwd}`)
  return root
}

export async function createWorktree(cwd: string, name: string): Promise<WorktreeInfo> {
  validateWorktreeName(name)

  // From a worktree's cwd this is still the MAIN root, so worktrees never nest.
  const gitRoot = requireRepoRoot(cwd)
  const git = simpleGit(gitRoot)

  const worktreesBase = getManagedWorktreesRoot(gitRoot)
  await fs.promises.mkdir(worktreesBase, { recursive: true })

  const worktreePath = path.join(worktreesBase, name)
  // Defense-in-depth: even with a validated name, never let the target escape
  // the managed directory.
  if (!isPathInside(worktreesBase, worktreePath)) {
    throw new Error(`Worktree path escapes the managed directory: ${worktreePath}`)
  }
  const branchName = `worktree-${name}`

  // Get current HEAD commit before creating worktree
  const headCommit = (await git.revparse(['HEAD'])).trim()

  // Create the worktree with a new branch from HEAD
  await git.raw(['worktree', 'add', '-b', branchName, worktreePath, 'HEAD'])
  // A "not a worktree" answer cached for this path (the 30 s negative cache) must not hide the
  // marker of the worktree that now exists.
  forgetLinkedWorktrees([worktreePath])

  // Copy settings.local.json if it exists
  const localSettingsPath = path.join(gitRoot, '.claude', 'settings.local.json')
  const wtSettingsDir = path.join(worktreePath, '.claude')
  try {
    if (fs.existsSync(localSettingsPath)) {
      await fs.promises.mkdir(wtSettingsDir, { recursive: true })
      await fs.promises.copyFile(localSettingsPath, path.join(wtSettingsDir, 'settings.local.json'))
    }
  } catch (err) {
    logger.warn(LOG, 'Failed to copy settings.local.json', err)
  }

  // Configure core.hooksPath if .husky or .git/hooks exist
  try {
    const huskyDir = path.join(gitRoot, '.husky')
    const gitHooksDir = path.join(gitRoot, '.git', 'hooks')
    const wtGit = simpleGit(worktreePath)
    if (fs.existsSync(huskyDir)) {
      await wtGit.addConfig('core.hooksPath', huskyDir)
    } else if (fs.existsSync(gitHooksDir)) {
      await wtGit.addConfig('core.hooksPath', gitHooksDir)
    }
  } catch (err) {
    logger.warn(LOG, 'Failed to configure hooksPath', err)
  }

  const info: WorktreeInfo = {
    worktreePath,
    worktreeBranch: branchName,
    worktreeName: name,
    originalCwd: cwd,
    gitRoot,
    originalHeadCommit: headCommit,
    createdAt: Date.now(),
    origin: 'created'
  }

  logger.info(LOG, `Created worktree "${name}" at ${worktreePath} on branch ${branchName}`)
  return info
}

// ---------------------------------------------------------------------------
// Unique commits (D3, C-B5)
// ---------------------------------------------------------------------------

/**
 * The revision arguments that select exactly the commits deleting a branch (or abandoning a
 * detached HEAD) would lose: reachable from it, from no other branch, remote-tracking ref or tag.
 * `refs/heads/<b>` is the positive ref (a tag named like the branch must not shadow it) and
 * `--exclude=<b>` keeps the branch itself out of the `--branches` that follows it. Works without
 * a remote.
 */
function uniqueCommitArgs(branch: string | null, head: string | null): string[] | null {
  if (branch) {
    return [
      `refs/heads/${branch}`,
      '--not',
      `--exclude=${branch}`,
      '--branches',
      '--remotes',
      '--tags'
    ]
  }
  if (head && /^[0-9a-f]{40,64}$/i.test(head)) {
    return [head, '--not', '--branches', '--remotes', '--tags']
  }
  return null
}

async function countUniqueCommits(
  git: SimpleGit,
  branch: string | null,
  head: string | null
): Promise<number> {
  const args = uniqueCommitArgs(branch, head)
  if (!args) return 0
  const out = await git.raw(['rev-list', '--count', ...args])
  return parseInt(out.trim(), 10) || 0
}

async function sampleUniqueCommits(
  git: SimpleGit,
  branch: string | null,
  head: string | null
): Promise<Array<{ sha: string; subject: string }>> {
  const args = uniqueCommitArgs(branch, head)
  if (!args) return []
  const out = await git.raw(['log', '-n', String(COMMIT_SAMPLE_MAX), '--format=%H%x1f%s', ...args])
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [sha, ...subject] = line.split('\u001f')
      return { sha, subject: subject.join('\u001f') }
    })
}

/** An untracked path that is a link, or a directory holding nothing but links (and empty directories). */
async function isOnlyLinks(abs: string): Promise<boolean> {
  try {
    const st = await fs.promises.lstat(abs)
    if (st.isSymbolicLink()) return true
    return st.isDirectory() && (await listTreeFiles(abs, 1, { stopAfter: 1 })).count === 0
  } catch {
    return false // gone since git looked: still reported
  }
}

interface StatusEntry {
  /** The two-letter porcelain code (`??` untracked, `!!` ignored, ...). */
  code: string
  file: string
}

/**
 * `git status` as entries. Untracked LINKS (the `node_modules` / `vendor/x` junctions an agent
 * makes into the main checkout), and untracked directories holding nothing else, are not changes
 * the user made, so they are dropped.
 */
async function statusEntries(
  worktreePath: string,
  extraArgs: string[] = []
): Promise<StatusEntry[]> {
  const raw = await simpleGit(worktreePath).raw([
    '--no-optional-locks',
    'status',
    '--porcelain',
    '-z',
    ...extraArgs
  ])
  const tokens = raw.split('\0')
  const out: StatusEntry[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.length < 4) continue
    const code = token.slice(0, 2)
    // A rename or copy is followed by a token holding its origin path.
    if (/[RC]/.test(code)) i++
    const file = token.slice(3)
    if (code === '??' && (await isOnlyLinks(path.join(worktreePath, file.replace(/\/+$/, ''))))) {
      continue
    }
    out.push({ code, file })
  }
  return out
}

export async function getWorktreeStatus(
  worktreePath: string,
  originalHead: string
): Promise<WorktreeStatus> {
  const git = simpleGit(worktreePath)

  // Get uncommitted files
  const files = (await statusEntries(worktreePath)).map((e) => e.file)

  // Get commits ahead of original HEAD
  let commitsAhead = 0
  if (originalHead) {
    try {
      const count = await git.raw(['rev-list', '--count', `${originalHead}..HEAD`])
      commitsAhead = parseInt(count.trim(), 10) || 0
    } catch (err) {
      logger.warn(LOG, 'Failed to count commits ahead', err)
    }
  }

  const branch = await getCurrentBranch(git)
  let uniqueCommits = 0
  try {
    const head = (await git.raw(['rev-parse', 'HEAD'])).trim()
    uniqueCommits = await countUniqueCommits(git, branch, head)
  } catch (err) {
    logger.warn(LOG, 'Failed to count unique commits', err)
  }

  return {
    uncommittedFiles: files.length,
    commitsAhead,
    files,
    uniqueCommits,
    branch
  }
}

// ---------------------------------------------------------------------------
// Inventory (R5)
// ---------------------------------------------------------------------------

interface PorcelainBlock {
  path: string
  head: string | null
  branch: string | null
  bare: boolean
  locked: boolean
  lockReason?: string
}

/** `git worktree list --porcelain`: blank-line-separated blocks, the first being the main worktree. */
export function parseWorktreePorcelain(text: string): PorcelainBlock[] {
  const blocks: PorcelainBlock[] = []
  for (const raw of text.split(/\r?\n\r?\n/)) {
    const block: PorcelainBlock = { path: '', head: null, branch: null, bare: false, locked: false }
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) block.path = line.slice('worktree '.length)
      else if (line.startsWith('HEAD ')) block.head = line.slice('HEAD '.length).trim()
      else if (line.startsWith('branch refs/heads/')) {
        block.branch = line.slice('branch refs/heads/'.length).trim()
      } else if (line === 'bare') block.bare = true
      else if (line === 'locked' || line.startsWith('locked ')) {
        block.locked = true
        const reason = line.slice('locked'.length).trim()
        if (reason) block.lockReason = reason
      }
    }
    if (block.path) blocks.push(block)
  }
  return blocks
}

/** What the repo around a cwd looks like, from the filesystem (C-S4). */
interface RepoContext {
  /** '' when unknown (a worktree of a bare repo). */
  repoRoot: string
  /** '' when the repo root is unknown. */
  managedRoot: string
  commonDir: string
  /** Where git commands run: the repo root, else the common dir. */
  gitCwd: string
  /** Neither `.claude` nor `.claude/worktrees` is a link, so the managed root is where it says. */
  managedReal: boolean
  /** `<repoRoot>/.git` is a real directory and is the common dir: orphans can be told from clones. */
  rootVerified: boolean
}

function isRealDirectory(p: string): boolean {
  try {
    const st = fs.lstatSync(p)
    return st.isDirectory() && !st.isSymbolicLink()
  } catch {
    return false
  }
}

function repoContext(cwd: string): RepoContext {
  const loc: GitLocation | null = locateGit(cwd)
  if (!loc) throw new Error(`Not inside a git repository: ${cwd}`)
  const repoRoot = loc.repoRoot ?? ''
  const managedRoot = repoRoot ? getManagedWorktreesRoot(repoRoot) : ''
  let managedReal = false
  let rootVerified = false
  if (repoRoot) {
    // The `.claude` and `.claude/worktrees` entries may not exist yet: only a link is disqualifying.
    const claudeDir = path.join(repoRoot, '.claude')
    const links = [claudeDir, managedRoot].some((p) => {
      try {
        return fs.lstatSync(p).isSymbolicLink()
      } catch {
        return false
      }
    })
    const expected = path.join(realOrResolved(repoRoot), WORKTREES_DIR)
    managedReal =
      !links &&
      normaliseWorktreePath(realOrResolved(managedRoot)) === normaliseWorktreePath(expected)
    rootVerified =
      isRealDirectory(path.join(repoRoot, '.git')) &&
      samePath(path.join(repoRoot, '.git'), loc.commonDir)
  }
  return {
    repoRoot,
    managedRoot,
    commonDir: loc.commonDir,
    gitCwd: repoRoot || loc.commonDir,
    managedReal,
    rootVerified
  }
}

const NOT_VERIFIABLE = 'not verifiably a worktree of this repo'

/**
 * BACKLINK RULE. A registered directory is only deletable when its `.git` is a FILE whose
 * `gitdir:` is `<this repo's common dir>/worktrees/<id>` AND that `<id>/gitdir` points back at
 * the directory. A hand-edited `.git/worktrees/<id>/gitdir` therefore cannot make an arbitrary
 * directory deletable. Returns the reason it fails, null when it holds. A directory with no `.git`
 * at all is a shell, allowed ONLY when it really is a direct child of the managed root (by
 * canonical path: a junction below `.claude/worktrees` leads out of it, and a registration forged
 * through one would otherwise delete what it points at).
 */
function backlinkProblem(dir: string, managed: boolean, ctx: RepoContext): string | null {
  const dotGit = path.join(dir, '.git')
  let st: fs.Stats
  try {
    st = fs.lstatSync(dotGit)
  } catch {
    return managed && isRealChildOf(ctx.managedRoot, dir)
      ? null
      : `${NOT_VERIFIABLE} (no .git file)`
  }
  if (st.isSymbolicLink() || !st.isFile()) return `${NOT_VERIFIABLE} (.git is not a file)`
  const admin = readGitFilePointer(dotGit)
  if (!admin) return `${NOT_VERIFIABLE} (unreadable .git file)`
  const adminParent = path.dirname(admin)
  if (
    path.basename(adminParent).toLowerCase() !== 'worktrees' ||
    !samePath(path.dirname(adminParent), ctx.commonDir)
  ) {
    return `${NOT_VERIFIABLE} (.git points at another repository)`
  }
  const back = readSmallFile(path.join(admin, 'gitdir'))?.trim()
  if (!back || !samePath(path.dirname(path.resolve(admin, back)), dir)) {
    return `${NOT_VERIFIABLE} (its registration points elsewhere)`
  }
  return null
}

/** Why an unregistered directory under the managed root is not a removable shell, else null (C-B2). */
function orphanProblem(dir: string, ctx: RepoContext): string | null {
  const dotGit = path.join(dir, '.git')
  let st: fs.Stats
  try {
    st = fs.lstatSync(dotGit)
  } catch {
    return null
  }
  if (st.isSymbolicLink()) return 'contains a .git link'
  if (st.isDirectory()) return 'a git repository, not a worktree'
  const admin = readGitFilePointer(dotGit)
  const underThisRepo =
    !!admin &&
    path.basename(path.dirname(admin)).toLowerCase() === 'worktrees' &&
    samePath(path.dirname(path.dirname(admin)), ctx.commonDir)
  return underThisRepo ? null : 'its .git file points at another repository'
}

/** The porcelain block git lists for `entryPath` right now, undefined when it is not registered. */
async function registrationOf(
  git: SimpleGit,
  entryPath: string
): Promise<PorcelainBlock | undefined> {
  const porcelain = await git.raw(['worktree', 'list', '--porcelain'])
  return parseWorktreePorcelain(porcelain)
    .slice(1)
    .find((b) => !b.bare && samePath(path.resolve(b.path), entryPath))
}

/**
 * What `lstat` says about `p`: only ENOENT/ENOTDIR prove it absent. Any other error (EACCES, EIO,
 * a stalled or offline share) proves nothing, so it is reported as an error, never as "gone".
 */
function lstatProbe(p: string): 'present' | 'absent' | { code: string } {
  try {
    fs.lstatSync(p)
    return 'present'
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'absent'
    return { code: code ?? String(err) }
  }
}

/** False only for a path that is provably absent: an unreadable one still "exists" (N1). */
function lstatExists(p: string): boolean {
  return lstatProbe(p) !== 'absent'
}

interface LoadedInventory {
  ctx: RepoContext
  inventory: WorktreeInventory
}

async function loadInventory(cwd: string, sources?: HolderSources): Promise<LoadedInventory> {
  const ctx = repoContext(cwd)
  const porcelain = await simpleGit(ctx.gitCwd).raw(['worktree', 'list', '--porcelain'])
  const blocks = parseWorktreePorcelain(porcelain)
  const managedRootForLayout = ctx.managedReal ? ctx.managedRoot : null

  const entries: WorktreeInventoryEntry[] = []
  const seen = new Set<string>()
  const remember = (p: string): void => {
    seen.add(normaliseWorktreePath(p))
    seen.add(normaliseWorktreePath(realOrResolved(p)))
  }
  // The first block is the main worktree: never an entry. Bare blocks hold no files.
  for (const b of blocks.slice(1)) {
    if (b.bare) continue
    const wtPath = path.resolve(b.path)
    if (ctx.repoRoot && samePath(wtPath, ctx.repoRoot)) continue
    const present = lstatExists(wtPath)
    const { location, name } = classifyWorktreeLocation(wtPath, managedRootForLayout)
    const entry: WorktreeInventoryEntry = {
      id: normaliseWorktreePath(wtPath),
      name,
      path: wtPath,
      location,
      kind: present ? 'worktree' : 'missing',
      branch: b.branch,
      head: b.head,
      locked: b.locked,
      contains: [],
      holders: []
    }
    if (b.lockReason) entry.lockReason = b.lockReason
    if (present) {
      const problem = backlinkProblem(wtPath, location === 'managed', ctx)
      if (problem) entry.invalidReason = problem
    }
    entries.push(entry)
    remember(wtPath)
  }

  // Orphans: directories directly under a REAL managed root that git does not list.
  if (ctx.managedRoot && ctx.managedReal && ctx.rootVerified) {
    let names: string[] = []
    try {
      names = await fs.promises.readdir(ctx.managedRoot)
    } catch {
      // no managed root yet
    }
    for (const dirName of names) {
      const orphanPath = path.join(ctx.managedRoot, dirName)
      if (seen.has(normaliseWorktreePath(orphanPath))) continue
      let st: fs.Stats
      try {
        st = await fs.promises.lstat(orphanPath)
      } catch {
        continue
      }
      if (!st.isDirectory() && !st.isSymbolicLink()) continue
      if (seen.has(normaliseWorktreePath(realOrResolved(orphanPath))) && !st.isSymbolicLink())
        continue
      const entry: WorktreeInventoryEntry = {
        id: normaliseWorktreePath(orphanPath),
        name: dirName,
        path: orphanPath,
        location: 'managed',
        kind: 'orphan',
        branch: null,
        head: null,
        locked: false,
        contains: [],
        holders: []
      }
      const problem = orphanProblem(orphanPath, ctx)
      if (problem) entry.invalidReason = problem
      entries.push(entry)
    }
  }

  for (const outer of entries) {
    for (const inner of entries) {
      if (inner.id !== outer.id && pathEqualOrInside(outer.path, inner.path)) {
        outer.contains.push(inner.id)
      }
    }
  }
  if (sources) {
    // One matcher: each holder directory is resolved to its canonical spelling once, not per entry.
    const holdersAt = createHolderMatcher(collectHolders(sources))
    for (const entry of entries) entry.holders = holdersAt(entry.path)
  }

  return {
    ctx,
    inventory: {
      repoRoot: ctx.repoRoot || ctx.gitCwd,
      managedRoot: ctx.managedRoot,
      entries
    }
  }
}

/**
 * Every linked worktree git lists for the repo around `cwd`, wherever it lives, plus orphan
 * directories under `<repo>/.claude/worktrees`. `sources` fills each entry's holders; without it
 * they are empty.
 */
export async function inventoryWorktrees(
  cwd: string,
  sources?: HolderSources
): Promise<WorktreeInventory> {
  return (await loadInventory(cwd, sources)).inventory
}

async function findEntry(
  cwd: string,
  id: string
): Promise<LoadedInventory & { entry: WorktreeInventoryEntry }> {
  const loaded = await loadInventory(cwd)
  const entry = loaded.inventory.entries.find((e) => e.id === id)
  if (!entry) throw new Error(`worktree not found: ${id}`)
  return { ...loaded, entry }
}

/** What removing the worktree would lose: uncommitted files and commits found nowhere else. */
export async function inspectWorktree(cwd: string, id: string): Promise<WorktreeInspection> {
  const { entry, ctx } = await findEntry(cwd, id)
  const out: WorktreeInspection = {
    uncommittedFiles: 0,
    uncommittedSample: [],
    ignoredEntries: 0,
    uniqueCommits: 0,
    uniqueCommitSample: []
  }
  // An entry the remover refuses (a link, a path through one, a `.git` that points elsewhere) is
  // not walked: nothing it holds can be lost by a removal that will not happen (N4).
  if (entry.invalidReason) return out
  if (entry.kind === 'missing') {
    // No files to lose, but the branch it was on may hold commits.
    const git = simpleGit(ctx.gitCwd)
    out.uniqueCommits = await countUniqueCommits(git, entry.branch, entry.head)
    out.uniqueCommitSample = await sampleUniqueCommits(git, entry.branch, entry.head)
    return out
  }
  const dotGitIsFile = (() => {
    try {
      return fs.lstatSync(path.join(entry.path, '.git')).isFile()
    } catch {
      return false
    }
  })()
  if (entry.kind === 'worktree' && dotGitIsFile && !entry.invalidReason) {
    // `.git` is verified, so git answers for THIS directory and not for the repo above it.
    const entries = await statusEntries(entry.path, ['--ignored'])
    const changed = entries.filter((e) => e.code !== '!!')
    out.uncommittedFiles = changed.length
    out.uncommittedSample = changed.slice(0, UNCOMMITTED_SAMPLE_MAX).map((e) => e.file)
    out.ignoredEntries = entries.length - changed.length
  } else {
    // A shell (or an unverified directory): any file that is not a link is work that would be lost.
    const files = await listTreeFiles(entry.path, UNCOMMITTED_SAMPLE_MAX)
    out.uncommittedFiles = files.count
    out.uncommittedSample = files.sample
  }
  if (entry.kind === 'worktree') {
    const git = simpleGit(ctx.gitCwd)
    out.uniqueCommits = await countUniqueCommits(git, entry.branch, entry.head)
    out.uniqueCommitSample = await sampleUniqueCommits(git, entry.branch, entry.head)
  }
  return out
}

/** Size of the worktree's tree, links counted and not followed. */
export async function measureWorktree(
  cwd: string,
  id: string,
  onProgress?: (progress: { files: number; bytes: number }) => void
): Promise<WorktreeSize> {
  const { entry } = await findEntry(cwd, id)
  if (entry.kind === 'missing' || entry.invalidReason) {
    return { bytes: 0, files: 0, links: 0, errors: 0, newestMtimeMs: 0 }
  }
  return measureTree(entry.path, { onProgress })
}

// ---------------------------------------------------------------------------
// Removal (R1-R3, C-B1..C-B3, C-S2, C-S3, C-S8)
// ---------------------------------------------------------------------------

export interface WorktreeRemoveProgress {
  /** Entries finished so far. */
  done: number
  total: number
  phase: string
}

export type WorktreeRemoveOptions = (
  | {
      /** Refuse while a live session, X-Agent or terminal works inside the directory. */
      enforceHolders: true
      sources: HolderSources
    }
  | { enforceHolders: false }
) & {
  /**
   * Called once at the end with the paths fully removed (not the partly removed: their records
   * stay so a retry still passes `createdOnly`), to drop the recorded `worktreeInfoMap` entries (`forgetWorktreeEntries` in worktree-detect). Injected so this
   * module needs neither the config store nor an emitter.
   */
  forgetEntries?: (worktreePaths: string[]) => void
  /**
   * Called once per entry that is about to be walked, after every refusal check and the final
   * re-verification, right before the first delete (not for a `missing` entry). The IPC layer
   * closes the file watchers it holds under the path: on Windows an open watch handle blocks
   * the delete. A throw is logged and the removal goes on.
   */
  beforeWalk?: (worktreePath: string) => void
  /**
   * C-S11: when given, only an entry for which this returns true may be removed; any other is
   * refused (`invalid: not a worktree ClaudeUI created`) before anything is touched. The legacy
   * entry point and the quit removal pass it; the manager's `remove-many` does not (it removes
   * what the inventory lists: Codex, opencode and orphan shells too).
   */
  createdOnly?: (worktreePath: string) => boolean
}

/** Removals of one repo never overlap: each ends before the next reads a fresh inventory (C-S8). */
const repoLocks = new Map<string, Promise<unknown>>()

function runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = repoLocks.get(key) ?? Promise.resolve()
  const run = previous.then(
    () => task(),
    () => task()
  )
  const tail = run.then(
    () => undefined,
    () => undefined
  )
  repoLocks.set(key, tail)
  void tail.then(() => {
    if (repoLocks.get(key) === tail) repoLocks.delete(key)
  })
  return run
}

/** C-S3: never a target, however it got into the inventory. */
function forbiddenTarget(target: string, ctx: RepoContext): string | null {
  const home = os.homedir()
  const protectedPaths = [ctx.repoRoot, ctx.commonDir, home].filter(Boolean)
  for (const t of new Set([target, realOrResolved(target)])) {
    if (isFilesystemRootPath(t)) return 'a filesystem root'
    for (const keep of protectedPaths) {
      for (const k of new Set([keep, realOrResolved(keep)])) {
        if (pathEqualOrInside(t, k))
          return 'the repository, its git directory or the home directory, or a directory containing them'
      }
    }
    for (const common of new Set([ctx.commonDir, realOrResolved(ctx.commonDir)])) {
      if (pathEqualOrInside(common, t)) return 'inside the git directory'
    }
  }
  return null
}

const NOT_CREATED = 'invalid: not a worktree ClaudeUI created'

const refused = (id: string, reason: string): WorktreeRemoveResult => ({
  id,
  outcome: 'refused',
  reason
})

const failed = (id: string, err: unknown): WorktreeRemoveResult => ({
  id,
  outcome: 'failed',
  reason: err instanceof Error ? err.message : String(err)
})

/**
 * `git worktree remove --force` for a path that must already be gone. Git would delete whatever
 * it finds there with its own walker, so a directory that has reappeared since the checks (an
 * agent recreating it) is reported instead of handed to git.
 */
async function unregisterGone(
  git: SimpleGit,
  entryPath: string
): Promise<{ reappeared: true } | { error: unknown } | null> {
  if (lstatExists(entryPath)) return { reappeared: true }
  try {
    await git.raw(['worktree', 'remove', '--force', entryPath])
  } catch (error) {
    return { error }
  }
  return null
}

interface BranchPlan {
  name: string
  /** null = could not be counted: the branch is kept. */
  unique: number | null
  /** The branch tip when the plan was made; null = could not be read (the branch is kept). */
  tip: string | null
  protectedBecause?: string
}

/** The commit `refs/heads/<name>` points at right now, null when it cannot be read. */
async function branchTip(git: SimpleGit, name: string): Promise<string | null> {
  try {
    const out = (await git.raw(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])).trim()
    return out === '' ? null : out
  } catch {
    return null
  }
}

/** Decided BEFORE the removal: afterwards the worktree and its commits' only name may be gone. */
async function planBranch(
  git: SimpleGit,
  entry: WorktreeInventoryEntry
): Promise<BranchPlan | null> {
  if (!entry.branch) return null
  // The tip is read BEFORE the count: a commit landing in between then moves the tip past the
  // recorded one and the branch is kept, instead of the new commit becoming the "unmoved" tip.
  const tip = await branchTip(git, entry.branch)
  let unique: number | null = null
  try {
    unique = await countUniqueCommits(git, entry.branch, entry.head)
  } catch (err) {
    logger.warn(LOG, `Could not count the unique commits of ${entry.branch}`, err)
  }
  const current = await getCurrentBranch(git)
  const remoteDefault = await getRemoteDefaultBranch(git)
  let protectedBecause: string | undefined
  if (entry.branch === current) protectedBecause = "the repository's current branch"
  else if (entry.branch === 'main' || entry.branch === 'master') protectedBecause = 'main branch'
  else if (entry.branch === remoteDefault) protectedBecause = 'the remote default branch'
  return { name: entry.branch, unique, tip, protectedBecause }
}

/** R2: delete the branch only when every commit is reachable from somewhere else. */
async function applyBranchRule(
  git: SimpleGit,
  plan: BranchPlan | null
): Promise<WorktreeRemoveResult['branch']> {
  if (!plan) return undefined
  const uniqueCommits = plan.unique ?? 0
  if (plan.protectedBecause) {
    logger.warn(LOG, `Skipping deletion of protected branch ${plan.name}`)
    return { name: plan.name, action: 'protected', uniqueCommits, reason: plan.protectedBecause }
  }
  if (plan.unique === null) {
    return {
      name: plan.name,
      action: 'kept',
      uniqueCommits,
      reason: 'its commits could not be counted'
    }
  }
  if (plan.unique > 0) return { name: plan.name, action: 'kept', uniqueCommits }
  // The count above was made against the tip recorded at the start: a commit landed on the
  // branch since (the walk can take minutes) would be lost with it. `rev-parse`, never
  // `update-ref -d`: only `branch -D` keeps git's "checked out in another worktree" refusal.
  const tipNow = plan.tip === null ? null : await branchTip(git, plan.name)
  if (plan.tip === null || tipNow !== plan.tip) {
    return {
      name: plan.name,
      action: 'kept',
      uniqueCommits,
      reason: plan.tip === null ? 'its tip could not be read' : 'moved since the removal started'
    }
  }
  try {
    await git.raw(['branch', '-D', plan.name])
    return { name: plan.name, action: 'deleted', uniqueCommits }
  } catch (err) {
    // e.g. checked out in another worktree
    const reason = err instanceof Error ? err.message.split('\n')[0] : String(err)
    logger.warn(LOG, `Failed to delete branch ${plan.name}`, err)
    return { name: plan.name, action: 'kept', uniqueCommits, reason }
  }
}

async function removeEmptyCodexBucket(entryPath: string): Promise<void> {
  const bucket = path.dirname(entryPath)
  try {
    if (!isRealDirectory(bucket)) return
    await fs.promises.rmdir(bucket) // not recursive: a bucket that still holds anything stays
  } catch {
    // not empty, or already gone
  }
}

const limitFailures = (failures: TreeFailure[]): TreeFailure[] => failures.slice(0, FAILURES_MAX)

async function removeOne(
  cwd: string,
  id: string,
  opts: WorktreeRemoveOptions,
  onPhase: (phase: string) => void
): Promise<{ result: WorktreeRemoveResult; touchedPath?: string }> {
  let loaded: LoadedInventory
  try {
    loaded = await loadInventory(cwd, opts.enforceHolders ? opts.sources : undefined)
  } catch (err) {
    // The inventory could not be read (git failed): that is not "no such entry".
    logger.warn(LOG, `Could not read the worktree inventory for ${id}`, err)
    return { result: failed(id, err) }
  }
  const { ctx, inventory } = loaded
  const entry = inventory.entries.find((e) => e.id === id)
  if (!entry) return { result: refused(id, 'not-found') }
  if (opts.createdOnly && !opts.createdOnly(entry.path)) {
    return { result: refused(id, NOT_CREATED) }
  }
  // A path that cannot be inspected is neither `missing` nor safe to hand to a walker.
  const probe = lstatProbe(entry.path)
  if (typeof probe === 'object') {
    return { result: failed(id, new Error(`cannot inspect ${entry.path}: ${probe.code}`)) }
  }

  if (entry.invalidReason) return { result: refused(id, `invalid: ${entry.invalidReason}`) }
  const forbidden = forbiddenTarget(entry.path, ctx)
  if (forbidden) return { result: refused(id, `invalid: refusing to remove ${forbidden}`) }
  if (entry.locked) return { result: refused(id, 'locked') }
  if (entry.contains.length > 0) {
    const names = entry.contains
      .map((c) => inventory.entries.find((e) => e.id === c)?.name ?? c)
      .join(', ')
    return {
      result: refused(id, `invalid: contains other worktrees (${names}); remove them first`)
    }
  }
  if (opts.enforceHolders) {
    const live = entry.holders.filter((h) => h.live)
    if (live.length > 0) {
      return { result: refused(id, `in-use: ${live.map((h) => h.label).join(', ')}`) }
    }
  }

  const git = simpleGit(ctx.gitCwd)
  const label = entry.name
  const realBefore = normaliseWorktreePath(realOrResolved(entry.path))
  const managed = entry.location === 'managed'

  if (entry.kind === 'missing') {
    const plan = await planBranch(git, entry)
    const unregistered = await unregisterGone(git, entry.path)
    if (unregistered && 'reappeared' in unregistered) {
      return { result: refused(id, 'invalid: reappeared') }
    }
    if (unregistered) {
      logger.warn(
        LOG,
        `Failed to unregister the missing worktree ${entry.path}`,
        unregistered.error
      )
      return { result: failed(id, unregistered.error) }
    }
    const branch = await applyBranchRule(git, plan)
    return {
      result: { id, outcome: 'removed', ...(branch ? { branch } : {}) },
      touchedPath: entry.path
    }
  }

  const plan = entry.kind === 'worktree' ? await planBranch(git, entry) : null

  // Re-verified right before the walk: the checks above ran before the git calls, and nothing
  // may have been swapped, re-registered or started in between.
  const changed = async (): Promise<string | null> => {
    // Registration and lock are re-read: a lock taken (or a registration made or dropped) while
    // the branch was being looked at must stop the walk, not just fail git's unregister after it.
    // This spawns git, so it runs BEFORE the synchronous path checks below, which must stay the
    // last thing between the decision and the walk (an intermediate component swapped for a
    // junction is only caught by the realpath compare).
    const block = await registrationOf(git, entry.path)
    if (entry.kind === 'worktree') {
      if (!block) return 'invalid: no longer a registered worktree'
      if (block.locked) return 'locked'
    } else if (block) {
      return 'invalid: registered as a worktree since'
    }
    if (opts.enforceHolders) {
      // Live holders only, before matching: cold sessions are many and each costs a realpath.
      const live = holdersOf(
        entry.path,
        collectHolders(opts.sources).filter((h) => h.live)
      )
      if (live.length > 0) return `in-use: ${live.map((h) => h.label).join(', ')}`
    }
    if (normaliseWorktreePath(realOrResolved(entry.path)) !== realBefore)
      return 'invalid: the path changed while removing'
    if (entry.kind === 'worktree' && backlinkProblem(entry.path, managed, ctx))
      return `invalid: ${NOT_VERIFIABLE}`
    if (entry.kind === 'orphan' && orphanProblem(entry.path, ctx))
      return 'invalid: no longer a removable shell'
    return null
  }
  const stale = await changed()
  if (stale) return { result: refused(id, stale) }

  try {
    opts.beforeWalk?.(entry.path)
  } catch (err) {
    logger.warn(LOG, `beforeWalk failed for ${entry.path}`, err)
  }
  const progressPhase = (n: number): void => onPhase(`${label}: ${n} entries removed`)
  onPhase(`${label}: removing files`)

  if (entry.kind === 'orphan') {
    const walk = await removeTreeLinkSafe(entry.path, { onProgress: progressPhase })
    if (!walk.removed) {
      return { result: partial(id, walk.failures, entry.path), touchedPath: entry.path }
    }
    return { result: { id, outcome: 'removed' }, touchedPath: entry.path }
  }

  // (1) everything but the `.git` file; (3) a partial walk leaves the entry registered and valid.
  const walk = await removeTreeLinkSafe(entry.path, {
    keepTopLevel: ['.git'],
    onProgress: progressPhase
  })
  if (walk.failures.length > 0) {
    return { result: partial(id, walk.failures, entry.path), touchedPath: entry.path }
  }
  // (2) the `.git` file and the root; the pointer is put back if the root cannot go (an engine
  // process with it as cwd), so the entry still verifies and a retry works.
  const dotGitPath = path.join(entry.path, '.git')
  const dotGitText = readSmallFile(dotGitPath)
  const finish = await removeTreeLinkSafe(entry.path)
  if (!finish.removed) {
    if (dotGitText !== null && !lstatExists(dotGitPath)) {
      try {
        await fs.promises.writeFile(dotGitPath, dotGitText, 'utf-8')
      } catch (err) {
        logger.warn(LOG, `Could not restore ${dotGitPath}`, err)
      }
    }
    return { result: partial(id, finish.failures, entry.path), touchedPath: entry.path }
  }
  // Never `git worktree prune`: it is repo-global and would drop other prunable entries too.
  const unregistered = await unregisterGone(git, entry.path)
  if (unregistered) {
    const code = 'reappeared' in unregistered ? 'REAPPEARED' : 'GIT_UNREGISTER'
    if ('error' in unregistered) {
      logger.warn(LOG, `Removed ${entry.path} but git did not unregister it`, unregistered.error)
    }
    return {
      result: partial(id, [{ path: entry.path, code }], entry.path),
      touchedPath: entry.path
    }
  }
  const branch = await applyBranchRule(git, plan)
  if (entry.location === 'codex') await removeEmptyCodexBucket(entry.path)
  return {
    result: { id, outcome: 'removed', ...(branch ? { branch } : {}) },
    touchedPath: entry.path
  }
}

function partial(id: string, failures: TreeFailure[], entryPath: string): WorktreeRemoveResult {
  const list = failures.length > 0 ? failures : [{ path: entryPath, code: 'ENOTEMPTY' }]
  return { id, outcome: 'partial', failures: limitFailures(list) }
}

/**
 * Remove worktrees by id (the inventory's normalised path), one result per id in order, never
 * throwing for one bad id. Each id is re-resolved against a FRESH inventory, so nothing the
 * client says about a path is trusted. Runs one at a time per repo; entries that contain others
 * are refused unless the inner ones are in the same call (which go first).
 */
export async function removeWorktrees(
  cwd: string,
  ids: string[],
  progress: (p: WorktreeRemoveProgress) => void,
  opts: WorktreeRemoveOptions
): Promise<WorktreeRemoveResult[]> {
  let lockKey: string
  try {
    // The canonical spelling: the same repo reached through a link or a short name shares a lock.
    lockKey = normaliseWorktreePath(realOrResolved(repoContext(cwd).commonDir))
  } catch {
    return ids.map((id) => refused(id, 'not-found'))
  }
  return runExclusive(lockKey, async () => {
    const results: WorktreeRemoveResult[] = new Array(ids.length)
    const touched: string[] = []
    // Only a fully removed path loses its recorded entries: a partial one keeps them, so the
    // `createdOnly` check still recognises it and a retry (quit ladder, cleanup Retry) is allowed.
    const removedPaths: string[] = []
    // Inner entries first: a path's ancestors can only be removed once it is gone.
    const order = ids
      .map((id, index) => ({ id, index, depth: id.split('/').length }))
      .sort((a, b) => b.depth - a.depth || a.index - b.index)
    let done = 0
    // Progress is reporting only: a callback that throws (a window closed mid-removal) must not
    // fail an entry that was removed, nor end the loop and lose the results so far.
    const report = (phase: string): void => {
      try {
        progress({ done, total: ids.length, phase })
      } catch (err) {
        logger.warn(LOG, 'A progress callback threw', err)
      }
    }
    for (const { id, index } of order) {
      report('starting')
      try {
        const { result, touchedPath } = await removeOne(cwd, id, opts, report)
        results[index] = result
        if (touchedPath) touched.push(touchedPath)
        if (touchedPath && result.outcome === 'removed') removedPaths.push(touchedPath)
        logger.info(
          LOG,
          `Remove worktree ${id}: ${result.outcome}${result.reason ? ` (${result.reason})` : ''}`
        )
      } catch (err) {
        logger.error(LOG, `Removing worktree ${id} failed`, err)
        results[index] = {
          id,
          outcome: 'failed',
          reason: err instanceof Error ? err.message : String(err)
        }
      }
      done++
    }
    report('done')
    if (touched.length > 0) {
      forgetLinkedWorktrees(touched)
    }
    if (removedPaths.length > 0) {
      try {
        opts.forgetEntries?.(removedPaths)
      } catch (err) {
        logger.warn(LOG, 'Could not drop the removed worktrees from the session records', err)
      }
    }
    return results
  })
}

/**
 * Remove ONE worktree by its path (session-delete cleanup modal, quit removal). The repo is found
 * from the PATH, never from a caller-supplied root (renderer-supplied, untrusted), and the path
 * must be an inventory entry of that repo — matched as a directory (`samePath`), not by spelling:
 * anything else is refused by throwing. Returns the same result as {@link removeWorktrees}.
 *
 * `recordedGitRoot` (the repository root ClaudeUI recorded when it created the worktree: main-
 * owned session data, never the renderer's) is the second place to look when the path itself
 * leads nowhere — a worktree outside its repo whose folder is already gone. If no entry turns up
 * and the folder does not exist, there is nothing to delete: a path ClaudeUI created
 * (`opts.createdOnly`) just has its recorded entries dropped (`opts.forgetEntries`).
 */
export async function removeWorktreeAtPath(
  worktreePath: string,
  opts: WorktreeRemoveOptions,
  recordedGitRoot?: string,
  progress: (p: WorktreeRemoveProgress) => void = () => {}
): Promise<WorktreeRemoveResult> {
  const find = async (
    start: string
  ): Promise<{ cwd: string; entry: WorktreeInventoryEntry } | null> => {
    const loc = locateGit(start)
    if (!loc) return null
    // The directory holding the `.git` found: a usable cwd for a bare repo's worktree too, where
    // the common dir (`x.git`) is not a place to locate a repository from.
    const { inventory } = await loadInventory(loc.topDir)
    const entry = inventory.entries.find((e) => samePath(e.path, worktreePath))
    return entry ? { cwd: loc.topDir, entry } : null
  }
  let found = await find(worktreePath)
  if (!found && recordedGitRoot) found = await find(recordedGitRoot)
  if (!found) {
    if (!lstatExists(worktreePath) && opts.createdOnly?.(worktreePath)) {
      try {
        opts.forgetEntries?.([worktreePath])
      } catch (err) {
        logger.warn(LOG, 'Could not drop the vanished worktree from the session records', err)
      }
      return { id: normaliseWorktreePath(worktreePath), outcome: 'removed' }
    }
    throw new Error(
      locateGit(worktreePath)
        ? `Refusing to remove worktree ${worktreePath}: not a worktree of its repository`
        : `Refusing to remove worktree outside the managed directory: ${worktreePath}`
    )
  }
  const [result] = await removeWorktrees(found.cwd, [found.entry.id], progress, opts)
  return result
}

/**
 * The older single-path entry point (session-delete cleanup modal). Holders are always enforced
 * (`deps.sources` is required; the quit path, which opts out, calls {@link removeWorktreeAtPath}).
 */
export async function removeWorktree(
  worktreePath: string,
  // The renderer-supplied branch is intentionally ignored: it is untrusted
  // (harvested from tool-result text) and `main` is a legal value. The branch
  // to delete is derived from git's worktree records instead.
  _requestedBranch: string,
  _gitRoot: string,
  deps: {
    /** Required: this entry point always refuses a directory a live session works in. */
    sources: HolderSources
    forgetEntries?: (worktreePaths: string[]) => void
    beforeWalk?: (worktreePath: string) => void
    /** C-S11: see {@link WorktreeRemoveOptions.createdOnly}. */
    createdOnly?: (worktreePath: string) => boolean
    /** Per-entry and per-batch progress, as {@link removeWorktrees} reports it. */
    progress?: (p: WorktreeRemoveProgress) => void
  }
): Promise<WorktreeRemoveResult> {
  // Not optional at runtime either: a wire caller without sources must not silently skip R3.
  if (!deps?.sources) {
    throw new Error('removeWorktree needs the holder sources; use removeWorktrees to opt out')
  }
  return removeWorktreeAtPath(
    worktreePath,
    {
      enforceHolders: true,
      sources: deps.sources,
      forgetEntries: deps.forgetEntries,
      beforeWalk: deps.beforeWalk,
      createdOnly: deps.createdOnly
    },
    undefined,
    deps.progress
  )
}
