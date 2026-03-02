import simpleGit from 'simple-git'
import * as fs from 'fs'
import * as path from 'path'
import type { WorktreeInfo, WorktreeEntry, WorktreeStatus } from '../../shared/types'
import { logger } from './logger'

const WORKTREES_DIR = '.claude/worktrees'

async function findGitRoot(cwd: string): Promise<string> {
  const git = simpleGit(cwd)
  const root = await git.revparse(['--show-toplevel'])
  return root.trim()
}

export async function createWorktree(cwd: string, name: string): Promise<WorktreeInfo> {
  const gitRoot = await findGitRoot(cwd)
  const git = simpleGit(gitRoot)

  const worktreesBase = path.join(gitRoot, WORKTREES_DIR)
  await fs.promises.mkdir(worktreesBase, { recursive: true })

  const worktreePath = path.join(worktreesBase, name)
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

export async function getWorktreeStatus(worktreePath: string, originalHead: string): Promise<WorktreeStatus> {
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

export async function removeWorktree(worktreePath: string, branch: string, gitRoot: string): Promise<void> {
  const git = simpleGit(gitRoot)

  try {
    await git.raw(['worktree', 'remove', '--force', worktreePath])
  } catch (err) {
    logger.warn('worktree', `Failed to remove worktree at ${worktreePath}`, err)
    // If worktree remove fails, try manual cleanup
    try {
      if (fs.existsSync(worktreePath)) {
        await fs.promises.rm(worktreePath, { recursive: true, force: true })
      }
      await git.raw(['worktree', 'prune'])
    } catch (cleanupErr) {
      logger.error('worktree', 'Manual cleanup also failed', cleanupErr)
    }
  }

  // Best-effort branch delete
  try {
    await git.raw(['branch', '-D', branch])
  } catch (err) {
    logger.warn('worktree', `Failed to delete branch ${branch}`, err)
  }

  logger.info('worktree', `Removed worktree at ${worktreePath} and branch ${branch}`)
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
