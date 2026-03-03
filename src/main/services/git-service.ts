import simpleGit, { type SimpleGit } from 'simple-git'
import * as fs from 'fs'
import * as path from 'path'
import type { GitStatusData, GitBranchData, GitFileStatus } from '../../shared/types'
import { logger } from './logger'

export class GitService {
  private git: SimpleGit
  private cwd: string
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private lastStatusJson = ''

  constructor(cwd: string) {
    this.cwd = cwd
    this.git = simpleGit(cwd)
  }

  async isGitRepo(): Promise<boolean> {
    try {
      await this.git.revparse(['--is-inside-work-tree'])
      return true
    } catch {
      return false
    }
  }

  async getStatus(): Promise<GitStatusData> {
    const status = await this.git.status()

    const files: GitFileStatus[] = status.files.map((f) => ({
      path: f.path,
      index: f.index || ' ',
      working: f.working_dir || ' '
    }))

    // Compute lines added/removed across staged + unstaged changes
    let linesAdded = 0
    let linesRemoved = 0
    try {
      const parseNumstat = (raw: string): void => {
        for (const line of raw.trim().split('\n')) {
          if (!line) continue
          const [added, removed] = line.split('\t')
          // Binary files show '-' for both columns
          if (added !== '-') linesAdded += parseInt(added, 10) || 0
          if (removed !== '-') linesRemoved += parseInt(removed, 10) || 0
        }
      }
      // Unstaged changes (including untracked via diff --no-index workaround)
      const unstaged = await this.git.diff(['--numstat'])
      parseNumstat(unstaged)
      // Staged changes
      const staged = await this.git.diff(['--cached', '--numstat'])
      parseNumstat(staged)
      // Untracked files — count all their lines as additions
      for (const f of status.not_added) {
        try {
          const absPath = path.resolve(this.cwd, f)
          const stat = await fs.promises.stat(absPath)
          if (!stat.isFile()) continue
          const content = await fs.promises.readFile(absPath, 'utf-8')
          const lineCount = content.split('\n').length
          // If file ends with newline, split produces an extra empty string
          linesAdded += content.endsWith('\n') ? lineCount - 1 : lineCount
        } catch (err) {
          logger.warn('GitService', `Failed to read untracked file for line count: ${f}`, err)
        }
      }
    } catch (err) {
      logger.warn('GitService', 'Failed to compute diff line counts', err)
    }

    return {
      branch: status.current || 'HEAD',
      ahead: status.ahead,
      behind: status.behind,
      trackingBranch: status.tracking || null,
      files,
      staged: status.staged,
      unstaged: status.modified.concat(status.deleted),
      untracked: status.not_added,
      linesAdded,
      linesRemoved
    }
  }

  async getBranches(): Promise<GitBranchData> {
    const summary = await this.git.branch(['-a', '--no-color'])
    const local: string[] = []
    const remote: string[] = []
    const tracking: Record<string, string> = {}

    for (const [name, info] of Object.entries(summary.branches)) {
      if (name.startsWith('remotes/')) {
        // Strip "remotes/" prefix for display
        const remoteName = name.replace(/^remotes\//, '')
        // Skip HEAD pointers
        if (!remoteName.includes('/HEAD')) {
          remote.push(remoteName)
        }
      } else {
        local.push(name)
      }
      // Capture tracking info if available
      if ((info as { tracking?: string }).tracking) {
        tracking[name] = (info as { tracking?: string }).tracking!
      }
    }

    return {
      current: summary.current,
      local,
      remote,
      tracking
    }
  }

  async checkout(branch: string): Promise<void> {
    await this.git.checkout(branch)
  }

  async createBranch(name: string): Promise<void> {
    await this.git.checkoutLocalBranch(name)
  }

  async getFilePatch(
    filePath: string,
    staged: boolean,
    ignoreWhitespace: boolean = false
  ): Promise<{ patch: string }> {
    const args: string[] = ['diff']
    if (staged) args.push('--cached')
    if (ignoreWhitespace) args.push('-w')
    args.push('--', filePath)

    try {
      const patch = await this.git.raw(args)
      if (patch) return { patch }

      // Empty patch — could be an untracked file.
      // Generate a unified diff manually since `git diff --no-index` exits
      // with code 1 when differences exist and simple-git treats that as error.
      const absPath = path.resolve(this.cwd, filePath)
      let content: string
      try {
        content = await fs.promises.readFile(absPath, 'utf-8')
      } catch (err) {
        logger.warn('GitService', `Failed to read untracked file for patch: ${filePath}`, err)
        return { patch: '' }
      }
      if (!content) return { patch: '' }

      const lines = content.replace(/\r\n/g, '\n').split('\n')
      // Remove trailing empty line from split (file ends with \n)
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
      const body = lines.map((l) => `+${l}`).join('\n')
      const unified = [
        `--- /dev/null`,
        `+++ b/${filePath}`,
        `@@ -0,0 +1,${lines.length} @@`,
        body,
      ].join('\n')
      return { patch: unified }
    } catch (err) {
      logger.warn('GitService', `Failed to get file patch: ${filePath}`, err)
      return { patch: '' }
    }
  }

  async getFileContents(
    filePath: string,
    staged: boolean
  ): Promise<{ oldContent: string; newContent: string }> {
    const absPath = path.resolve(this.cwd, filePath)
    const normEol = (s: string): string => s.replace(/\r\n/g, '\n')

    try {
      if (staged) {
        let oldContent = ''
        try { oldContent = await this.git.show([`HEAD:${filePath}`]) } catch (err) { logger.warn('GitService', `Failed to get HEAD content for staged file: ${filePath}`, err) }
        let newContent = ''
        try { newContent = await this.git.show([`:${filePath}`]) } catch (err) { logger.warn('GitService', `Failed to get index content for staged file: ${filePath}`, err) }
        return { oldContent: normEol(oldContent), newContent: normEol(newContent) }
      } else {
        let oldContent = ''
        try { oldContent = await this.git.show([`:${filePath}`]) } catch (err) {
          logger.warn('GitService', `Failed to get index content for unstaged file: ${filePath}`, err)
          try { oldContent = await this.git.show([`HEAD:${filePath}`]) } catch (err2) { logger.warn('GitService', `Failed to get HEAD content for untracked file: ${filePath}`, err2) }
        }
        let newContent = ''
        try { newContent = await fs.promises.readFile(absPath, 'utf-8') } catch (err) { logger.warn('GitService', `Failed to read working tree file: ${filePath}`, err) }
        return { oldContent: normEol(oldContent), newContent: normEol(newContent) }
      }
    } catch (err) {
      logger.warn('GitService', `Failed to get file contents: ${filePath}`, err)
      return { oldContent: '', newContent: '' }
    }
  }

  async stageFile(filePath: string): Promise<void> {
    await this.git.add(filePath)
  }

  async unstageFile(filePath: string): Promise<void> {
    await this.git.reset(['HEAD', '--', filePath])
  }

  async stageAll(): Promise<void> {
    await this.git.add('-A')
  }

  async unstageAll(): Promise<void> {
    await this.git.reset(['HEAD'])
  }

  async commit(message: string): Promise<string> {
    const result = await this.git.commit(message)
    return result.commit
  }

  async push(): Promise<void> {
    await this.git.push()
  }

  async pushWithUpstream(branch: string): Promise<void> {
    await this.git.push(['--set-upstream', 'origin', branch])
  }

  async pull(): Promise<{ summary: string }> {
    const result = await this.git.pull()
    const s = result.summary
    return { summary: `${s.changes} changes, ${s.insertions} insertions, ${s.deletions} deletions` }
  }

  async fetch(): Promise<void> {
    await this.git.fetch(['--all', '--prune'])
  }

  /**
   * Discard all changes to a file, restoring it to HEAD state.
   * For untracked files, deletes the file from disk.
   */
  async discardFile(filePath: string): Promise<void> {
    // Check if file is tracked by trying to show it from HEAD
    let tracked = true
    try {
      await this.git.show([`HEAD:${filePath}`])
    } catch {
      // Also check index — newly added files exist in index but not HEAD
      try {
        await this.git.show([`:${filePath}`])
      } catch {
        tracked = false
      }
    }

    if (!tracked) {
      // Untracked file — delete from disk
      const absPath = path.resolve(this.cwd, filePath)
      await fs.promises.unlink(absPath)
    } else {
      // Tracked file — unstage and restore working tree to HEAD
      // git checkout HEAD -- <file> handles both staged and unstaged changes
      await this.git.checkout(['HEAD', '--', filePath])
    }
  }

  startPolling(callback: (status: GitStatusData) => void, intervalMs: number): void {
    this.stopPolling()
    const poll = async (): Promise<void> => {
      try {
        const status = await this.getStatus()
        const json = JSON.stringify(status)
        if (json !== this.lastStatusJson) {
          this.lastStatusJson = json
          callback(status)
        }
      } catch (err) {
        logger.warn('GitService', 'Polling error while fetching git status', err)
      }
    }
    // Initial poll
    poll()
    this.pollTimer = setInterval(poll, intervalMs)
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  destroy(): void {
    this.stopPolling()
  }
}

// ---------------------------------------------------------------------------
// GitServiceManager — singleton registry, one GitService per cwd
// ---------------------------------------------------------------------------

interface GitServiceEntry {
  service: GitService
  refCount: number
}

class GitServiceManager {
  private services = new Map<string, GitServiceEntry>()

  get(cwd: string): GitService {
    const entry = this.services.get(cwd)
    if (entry) {
      entry.refCount++
      return entry.service
    }
    const service = new GitService(cwd)
    this.services.set(cwd, { service, refCount: 1 })
    return service
  }

  release(cwd: string): void {
    const entry = this.services.get(cwd)
    if (!entry) return
    entry.refCount--
    if (entry.refCount <= 0) {
      entry.service.destroy()
      this.services.delete(cwd)
    }
  }

  getIfExists(cwd: string): GitService | undefined {
    return this.services.get(cwd)?.service
  }
}

export const gitServiceManager = new GitServiceManager()
