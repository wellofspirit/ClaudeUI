import simpleGit, { type SimpleGit } from 'simple-git'
import * as fs from 'fs'
import * as path from 'path'
import type { WorktreeInfo, WorktreeEntry, WorktreeStatus } from '../../shared/types'
import { logger } from './logger'
import { isPathInside } from './path-containment'

const WORKTREES_DIR = '.claude/worktrees'

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
function validateWorktreeName(name: string): void {
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

/**
 * Resolve the branch checked out at `worktreePath` from git's own records,
 * never from a renderer-supplied value. Returns null when the path is not a
 * registered worktree or is in detached-HEAD state (in which case the caller
 * must NOT delete any branch).
 */
async function resolveWorktreeBranch(git: SimpleGit, worktreePath: string): Promise<string | null> {
  let porcelain: string
  try {
    porcelain = await git.raw(['worktree', 'list', '--porcelain'])
  } catch (err) {
    logger.warn('worktree', 'Failed to list worktrees for branch resolution', err)
    return null
  }
  const targetAbs = path.resolve(worktreePath)
  // Porcelain output is blank-line-separated blocks; each has a `worktree <path>`
  // line and either `branch refs/heads/<name>` or `detached`.
  for (const block of porcelain.split(/\r?\n\r?\n/)) {
    let blockPath: string | null = null
    let branchRef: string | null = null
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) blockPath = line.slice('worktree '.length).trim()
      else if (line.startsWith('branch ')) branchRef = line.slice('branch '.length).trim()
    }
    if (blockPath && path.relative(path.resolve(blockPath), targetAbs) === '') {
      if (branchRef && branchRef.startsWith('refs/heads/')) {
        return branchRef.slice('refs/heads/'.length)
      }
      return null
    }
  }
  return null
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

async function findGitRoot(cwd: string): Promise<string> {
  const git = simpleGit(cwd)
  const root = await git.revparse(['--show-toplevel'])
  return root.trim()
}

export async function createWorktree(cwd: string, name: string): Promise<WorktreeInfo> {
  validateWorktreeName(name)

  const gitRoot = await findGitRoot(cwd)
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

  // Copy settings.local.json if it exists
  const localSettingsPath = path.join(gitRoot, '.claude', 'settings.local.json')
  const wtSettingsDir = path.join(worktreePath, '.claude')
  try {
    if (fs.existsSync(localSettingsPath)) {
      await fs.promises.mkdir(wtSettingsDir, { recursive: true })
      await fs.promises.copyFile(localSettingsPath, path.join(wtSettingsDir, 'settings.local.json'))
    }
  } catch (err) {
    logger.warn('worktree', 'Failed to copy settings.local.json', err)
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
    logger.warn('worktree', 'Failed to configure hooksPath', err)
  }

  const info: WorktreeInfo = {
    worktreePath,
    worktreeBranch: branchName,
    worktreeName: name,
    originalCwd: cwd,
    gitRoot,
    originalHeadCommit: headCommit,
    createdAt: Date.now()
  }

  logger.info('worktree', `Created worktree "${name}" at ${worktreePath} on branch ${branchName}`)
  return info
}

export async function getWorktreeStatus(
  worktreePath: string,
  originalHead: string
): Promise<WorktreeStatus> {
  const git = simpleGit(worktreePath)

  // Get uncommitted files
  const statusResult = await git.raw(['status', '--porcelain'])
  const files = statusResult.trim().split('\n').filter(Boolean)

  // Get commits ahead of original HEAD
  let commitsAhead = 0
  if (originalHead) {
    try {
      const count = await git.raw(['rev-list', '--count', `${originalHead}..HEAD`])
      commitsAhead = parseInt(count.trim(), 10) || 0
    } catch (err) {
      logger.warn('worktree', 'Failed to count commits ahead', err)
    }
  }

  return {
    uncommittedFiles: files.length,
    commitsAhead,
    files: files.map((f) => f.slice(3)) // strip status prefix
  }
}

export async function removeWorktree(
  worktreePath: string,
  // The renderer-supplied branch is intentionally ignored: it is untrusted
  // (harvested from tool-result text) and `main` is a legal value. The branch
  // to delete is derived from git's worktree records instead.
  _requestedBranch: string,
  gitRoot: string
): Promise<void> {
  // Containment is the boundary (audit C2): a path outside the managed
  // worktrees directory must never be handed to `git worktree remove` nor to
  // the `rm -rf` fallback. Validate BEFORE touching git or the filesystem.
  const managedRoot = getManagedWorktreesRoot(gitRoot)
  if (!isPathInside(managedRoot, worktreePath)) {
    throw new Error(`Refusing to remove worktree outside the managed directory: ${worktreePath}`)
  }

  const git = simpleGit(gitRoot)

  // Derive the real branch (and the repo's current branch) BEFORE removal —
  // afterwards the worktree is gone from the porcelain listing.
  const branchToDelete = await resolveWorktreeBranch(git, worktreePath)
  const currentBranch = await getCurrentBranch(git)

  try {
    await git.raw(['worktree', 'remove', '--force', worktreePath])
  } catch (err) {
    logger.warn('worktree', `Failed to remove worktree at ${worktreePath}`, err)
    // Contained fallback: the path is proven inside the managed root above, so
    // the recursive rm can only ever touch our own worktrees directory.
    try {
      if (fs.existsSync(worktreePath)) {
        await fs.promises.rm(worktreePath, { recursive: true, force: true })
      }
      await git.raw(['worktree', 'prune'])
    } catch (cleanupErr) {
      logger.error('worktree', 'Manual cleanup also failed', cleanupErr)
    }
  }

  // Best-effort branch delete — only the git-derived branch, never the repo's
  // current branch, and never main/master (belt-and-braces against a
  // misconfigured worktree whose branch resolves to a protected name).
  if (
    branchToDelete &&
    branchToDelete !== currentBranch &&
    branchToDelete !== 'main' &&
    branchToDelete !== 'master'
  ) {
    try {
      await git.raw(['branch', '-D', branchToDelete])
    } catch (err) {
      logger.warn('worktree', `Failed to delete branch ${branchToDelete}`, err)
    }
  } else if (branchToDelete) {
    logger.warn('worktree', `Skipping deletion of protected/current branch ${branchToDelete}`)
  }

  logger.info(
    'worktree',
    `Removed worktree at ${worktreePath}${branchToDelete ? ` and branch ${branchToDelete}` : ''}`
  )
}

export async function listWorktrees(cwd: string): Promise<WorktreeEntry[]> {
  const gitRoot = await findGitRoot(cwd)
  const worktreesBase = path.join(gitRoot, WORKTREES_DIR)

  if (!fs.existsSync(worktreesBase)) return []

  const entries: WorktreeEntry[] = []
  const dirEntries = await fs.promises.readdir(worktreesBase, { withFileTypes: true })

  for (const entry of dirEntries) {
    if (!entry.isDirectory()) continue

    const wtPath = path.join(worktreesBase, entry.name)
    const gitFile = path.join(wtPath, '.git')
    const exists = fs.existsSync(gitFile)

    // Try to determine branch
    let branch = `worktree-${entry.name}`
    if (exists) {
      try {
        const wtGit = simpleGit(wtPath)
        const branchResult = await wtGit.revparse(['--abbrev-ref', 'HEAD'])
        branch = branchResult.trim()
      } catch {
        // fallback to convention
      }
    }

    entries.push({
      name: entry.name,
      path: wtPath,
      branch,
      exists
    })
  }

  return entries
}
