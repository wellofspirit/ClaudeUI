import simpleGit, { type SimpleGit } from 'simple-git'
import * as fs from 'fs'
import * as path from 'path'
import type { GitStatusData, GitBranchData, GitFileStatus } from '../../shared/types'
import { logger } from './logger'
import { isPathInside } from './path-containment'

/**
 * Skip line counting / diff content for files larger than this. A multi-GB
 * blob (DuckDB / sqlite / video) would crash the main process via V8's
 * String::kMaxLength when read as utf-8, and even merely-large files produce
 * unusable diffs.
 */
const MAX_TEXT_FILE_BYTES = 10 * 1024 * 1024

/** Bytes to sniff when classifying a file as binary. Matches git's heuristic. */
const BINARY_SNIFF_BYTES = 8000

/**
 * Hard caps for the untracked-file line-count pass.
 *
 * simple-git hardcodes `--untracked-files=all` on `git status`, so a working
 * tree with an unignored `node_modules`/`dist` yields *thousands* of entries in
 * `status.not_added`. Reading every one of them in full on every 5 s poll was
 * the dominant term in the main-process OOM that made the app vanish without a
 * log or a crash dump. Past either cap we stop counting lines; the files still
 * appear in the status lists, only their line counts are missing (surfaced via
 * `lineCountsTruncated`).
 */
const MAX_UNTRACKED_LINECOUNT_FILES = 200
/** Cumulative bytes read by the untracked line-count pass, per getStatus() call. */
const MAX_UNTRACKED_LINECOUNT_BYTES = 50 * 1024 * 1024

/**
 * Cap on the entries put into the status payload that crosses the IPC boundary
 * (structured clone to the main window + every extra window, every poll).
 */
const MAX_STATUS_LIST_ENTRIES = 5000

/** Entry cap for the per-file line-count cache; cleared wholesale when exceeded. */
const LINE_COUNT_CACHE_MAX_ENTRIES = 10_000

/** Number of unreadable paths sampled into the single aggregated warn per poll. */
const READ_ERROR_SAMPLE_SIZE = 3

interface LineCountCacheEntry {
  size: number
  mtimeMs: number
  /** Lines attributed to this file. 0 for binary / oversized files. */
  lines: number
}

/**
 * Cheap change detector for the poller. Must be O(files) with a small constant
 * and must cover everything the UI renders off a status update: the branch
 * headline, the per-file status letters, and the aggregate line counts.
 *
 * Deliberately not `JSON.stringify(status)` — that re-serialised an unbounded
 * payload (paths appear in `files` *and* in the category arrays) on every tick.
 */
function statusFingerprint(status: GitStatusData): string {
  const parts: string[] = [
    status.branch,
    String(status.ahead),
    String(status.behind),
    status.trackingBranch ?? '',
    String(status.linesAdded),
    String(status.linesRemoved),
    status.lineCountsTruncated ? '1' : '0',
    status.filesTruncated ? '1' : '0',
    String(status.files.length)
  ]
  for (const f of status.files) parts.push(`${f.path}:${f.index}:${f.working}`)
  return parts.join('\n')
}

/**
 * Heuristic binary detection: open the file and scan the first 8 KB for a
 * NUL byte. This is the same heuristic git uses in `convert.c is_binary()`
 * and is what `git diff` falls back to when no `.gitattributes` rule applies.
 *
 * Returns false on I/O errors so callers can let the downstream readFile
 * surface a more specific error.
 */
async function isBinaryFile(absPath: string): Promise<boolean> {
  let fh: fs.promises.FileHandle | null = null
  try {
    fh = await fs.promises.open(absPath, 'r')
    const buf = Buffer.alloc(BINARY_SNIFF_BYTES)
    const { bytesRead } = await fh.read(buf, 0, BINARY_SNIFF_BYTES, 0)
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true
    }
    return false
  } catch {
    return false
  } finally {
    if (fh)
      await fh.close().catch(() => {
        /* ignore */
      })
  }
}

/** Render a git-style placeholder patch for a new untracked binary file. */
function binaryAddedPatch(filePath: string): string {
  return [
    `diff --git a/${filePath} b/${filePath}`,
    `new file mode 100644`,
    `Binary files /dev/null and b/${filePath} differ`,
    ''
  ].join('\n')
}

export class GitService {
  private git: SimpleGit
  private cwd: string
  /** Resolved git repo root (may differ from cwd when session starts in a subdirectory) */
  private repoRoot: string | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private lastStatusFingerprint = ''
  /** True while a polled getStatus() is outstanding — ticks arriving now are dropped. */
  private pollInFlight = false
  /**
   * Bumped by every start/stop. A poll that settles after its generation was
   * retired must not fire the callback (stopPolling during an in-flight poll).
   */
  private pollGeneration = 0
  /** Line counts for untracked files, keyed by absolute path, validated by (size, mtimeMs). */
  private lineCountCache = new Map<string, LineCountCacheEntry>()

  constructor(cwd: string) {
    this.cwd = cwd
    this.git = simpleGit(cwd)
  }

  /**
   * Ensure we know the repo root. If the session cwd is a subdirectory of a
   * git repo, we re-initialize simple-git with the repo root so that all
   * paths from `git status` (which are repo-root-relative) resolve correctly
   * for `git diff`, `git show`, `fs.readFile`, etc.
   */
  private async ensureRepoRoot(): Promise<void> {
    if (this.repoRoot !== null) return
    try {
      const toplevel = (await this.git.revparse(['--show-toplevel'])).trim()
      this.repoRoot = toplevel
      if (path.resolve(toplevel) !== path.resolve(this.cwd)) {
        // Re-init simple-git at the repo root so paths align
        this.git = simpleGit(toplevel)
      }
    } catch {
      this.repoRoot = this.cwd
    }
  }

  async isGitRepo(): Promise<boolean> {
    try {
      await this.git.revparse(['--is-inside-work-tree'])
      return true
    } catch {
      return false
    }
  }

  /**
   * Resolve a repo-relative `filePath` to an absolute path, throwing if it
   * escapes the repository root (audit M-GT2 / gpt#5). Every IPC-exposed file
   * operation routes its path through here so a renderer/model-supplied
   * `../secret` can be neither read (`git show` / `readFile`) nor deleted
   * (`fs.unlink`). Callers MUST have run `ensureRepoRoot()` first.
   */
  private resolveContained(filePath: string): string {
    const root = this.repoRoot ?? this.cwd
    const abs = path.resolve(root, filePath)
    if (!isPathInside(root, abs)) {
      throw new Error(`Refusing file operation on path outside the repository: ${filePath}`)
    }
    return abs
  }

  /** Record a line count for `absPath`, bounding the cache with a wholesale clear. */
  private cacheLineCount(absPath: string, stat: fs.Stats, lines: number): void {
    if (this.lineCountCache.size >= LINE_COUNT_CACHE_MAX_ENTRIES) this.lineCountCache.clear()
    this.lineCountCache.set(absPath, { size: stat.size, mtimeMs: stat.mtimeMs, lines })
  }

  async getStatus(): Promise<GitStatusData> {
    await this.ensureRepoRoot()
    const status = await this.git.status()

    const files: GitFileStatus[] = status.files.map((f) => ({
      path: f.path,
      index: f.index || ' ',
      working: f.working_dir || ' '
    }))

    // Compute lines added/removed across staged + unstaged changes
    let linesAdded = 0
    let linesRemoved = 0
    let lineCountsTruncated = false
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
      // Untracked files — count all their lines as additions, but skip
      // anything that's too large (V8 string-length crash) or binary (line
      // count is meaningless and reading wastes I/O).
      //
      // Bounded three ways: a file-count cap, a cumulative byte budget, and a
      // (size, mtimeMs)-validated cache so an unchanged file is read at most
      // once across polls. Unreadable files are aggregated into a single warn
      // — per-file warns meant thousands of synchronous appendFileSync calls
      // per poll on trees with long paths / EPERM entries.
      let filesConsidered = 0
      let bytesRead = 0
      let readErrors = 0
      const readErrorSamples: string[] = []
      for (const f of status.not_added) {
        if (filesConsidered >= MAX_UNTRACKED_LINECOUNT_FILES) {
          lineCountsTruncated = true
          break
        }
        filesConsidered++
        try {
          const absPath = path.resolve(this.repoRoot!, f)
          const stat = await fs.promises.stat(absPath)
          if (!stat.isFile()) continue
          const cached = this.lineCountCache.get(absPath)
          if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
            linesAdded += cached.lines
            continue
          }
          if (stat.size > MAX_TEXT_FILE_BYTES) {
            this.cacheLineCount(absPath, stat, 0)
            continue
          }
          if (await isBinaryFile(absPath)) {
            this.cacheLineCount(absPath, stat, 0)
            continue
          }
          // Budget is checked immediately before the full read (and only for
          // files we would actually read), so the guarantee is a hard "never
          // read more than MAX_UNTRACKED_LINECOUNT_BYTES per getStatus()".
          if (bytesRead + stat.size > MAX_UNTRACKED_LINECOUNT_BYTES) {
            lineCountsTruncated = true
            break
          }
          const content = await fs.promises.readFile(absPath, 'utf-8')
          bytesRead += stat.size
          const lineCount = content.split('\n').length
          // If file ends with newline, split produces an extra empty string
          const lines = content.endsWith('\n') ? lineCount - 1 : lineCount
          linesAdded += lines
          this.cacheLineCount(absPath, stat, lines)
        } catch {
          readErrors++
          if (readErrorSamples.length < READ_ERROR_SAMPLE_SIZE) readErrorSamples.push(f)
        }
      }
      if (readErrors > 0) {
        logger.warn(
          'GitService',
          `Failed to read ${readErrors} untracked file(s) for line count (e.g. ${readErrorSamples.join(', ')})`
        )
      }
    } catch (err) {
      logger.warn('GitService', 'Failed to compute diff line counts', err)
    }

    // Bound what crosses the IPC boundary — a pathological working tree would
    // otherwise structured-clone an unbounded payload to every open window.
    const unstagedAll = status.modified.concat(status.deleted)
    const filesTruncated =
      files.length > MAX_STATUS_LIST_ENTRIES ||
      status.staged.length > MAX_STATUS_LIST_ENTRIES ||
      unstagedAll.length > MAX_STATUS_LIST_ENTRIES ||
      status.not_added.length > MAX_STATUS_LIST_ENTRIES

    return {
      branch: status.current || 'HEAD',
      ahead: status.ahead,
      behind: status.behind,
      trackingBranch: status.tracking || null,
      files: files.slice(0, MAX_STATUS_LIST_ENTRIES),
      staged: status.staged.slice(0, MAX_STATUS_LIST_ENTRIES),
      unstaged: unstagedAll.slice(0, MAX_STATUS_LIST_ENTRIES),
      untracked: status.not_added.slice(0, MAX_STATUS_LIST_ENTRIES),
      linesAdded,
      linesRemoved,
      ...(lineCountsTruncated ? { lineCountsTruncated: true } : {}),
      ...(filesTruncated ? { filesTruncated: true } : {})
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
  ): Promise<{ patch: string; isBinary?: boolean }> {
    await this.ensureRepoRoot()
    // Reject traversal before handing the path to git or reading it (throws
    // out of the try below so the IPC layer surfaces a failed result).
    const absPath = this.resolveContained(filePath)
    const args: string[] = ['diff']
    if (staged) args.push('--cached')
    if (ignoreWhitespace) args.push('-w')
    args.push('--', filePath)

    try {
      const patch = await this.git.raw(args)
      if (patch) {
        // Tracked-file path: git itself emits "Binary files ... differ" for
        // binary content. Surface that to the renderer so it can show a
        // proper notice instead of "No changes".
        const isBinary = /^Binary files .+ differ$/m.test(patch)
        return isBinary ? { patch, isBinary: true } : { patch }
      }

      // Empty patch — could be an untracked file.
      // Generate a unified diff manually since `git diff --no-index` exits
      // with code 1 when differences exist and simple-git treats that as error.
      let stat: fs.Stats
      try {
        stat = await fs.promises.stat(absPath)
      } catch (err) {
        logger.warn('GitService', `Failed to stat untracked file for patch: ${filePath}`, err)
        return { patch: '' }
      }
      if (!stat.isFile()) return { patch: '' }

      // Treat oversized or binary untracked files as binary — never read
      // their content into a JS string (multi-GB files crash V8) and never
      // dump arbitrary bytes into the diff view.
      if (stat.size > MAX_TEXT_FILE_BYTES || (await isBinaryFile(absPath))) {
        return { patch: binaryAddedPatch(filePath), isBinary: true }
      }

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
        body
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
    await this.ensureRepoRoot()
    // Reject traversal before any `git show` / working-tree read.
    const absPath = this.resolveContained(filePath)
    const normEol = (s: string): string => s.replace(/\r\n/g, '\n')

    try {
      if (staged) {
        let oldContent = ''
        try {
          oldContent = await this.git.show([`HEAD:${filePath}`])
        } catch (err) {
          logger.warn('GitService', `Failed to get HEAD content for staged file: ${filePath}`, err)
        }
        let newContent = ''
        try {
          newContent = await this.git.show([`:${filePath}`])
        } catch (err) {
          logger.warn('GitService', `Failed to get index content for staged file: ${filePath}`, err)
        }
        return { oldContent: normEol(oldContent), newContent: normEol(newContent) }
      } else {
        let oldContent = ''
        try {
          oldContent = await this.git.show([`:${filePath}`])
        } catch (err) {
          logger.warn(
            'GitService',
            `Failed to get index content for unstaged file: ${filePath}`,
            err
          )
          try {
            oldContent = await this.git.show([`HEAD:${filePath}`])
          } catch (err2) {
            logger.warn(
              'GitService',
              `Failed to get HEAD content for untracked file: ${filePath}`,
              err2
            )
          }
        }
        let newContent = ''
        try {
          newContent = await fs.promises.readFile(absPath, 'utf-8')
        } catch (err) {
          logger.warn('GitService', `Failed to read working tree file: ${filePath}`, err)
        }
        return { oldContent: normEol(oldContent), newContent: normEol(newContent) }
      }
    } catch (err) {
      logger.warn('GitService', `Failed to get file contents: ${filePath}`, err)
      return { oldContent: '', newContent: '' }
    }
  }

  async stageFile(filePath: string): Promise<void> {
    await this.ensureRepoRoot()
    this.resolveContained(filePath)
    await this.git.add(filePath)
  }

  async unstageFile(filePath: string): Promise<void> {
    await this.ensureRepoRoot()
    this.resolveContained(filePath)
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
    await this.ensureRepoRoot()
    // Reject traversal FIRST — a `../secret` path fails both `git show` probes
    // below, gets classified untracked, and would otherwise be fs.unlink'd
    // outside the repo (audit gpt#5).
    const absPath = this.resolveContained(filePath)
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
      await fs.promises.unlink(absPath)
    } else {
      // Tracked file — unstage and restore working tree to HEAD
      // git checkout HEAD -- <file> handles both staged and unstaged changes
      await this.git.checkout(['HEAD', '--', filePath])
    }
  }

  startPolling(callback: (status: GitStatusData) => void, intervalMs: number): void {
    this.stopPolling()
    const generation = ++this.pollGeneration
    const poll = async (): Promise<void> => {
      // In-flight guard: on a big working tree a single getStatus() can outlast
      // the interval. Without this, invocations pile up behind simple-git's
      // per-instance task queue and the retained parse results exhaust the
      // main-process heap (a V8 abort, not a catchable exception).
      if (this.pollInFlight) return
      this.pollInFlight = true
      try {
        const status = await this.getStatus()
        // Retired by stopPolling()/restart while we were awaiting — drop it.
        if (generation !== this.pollGeneration) return
        const fingerprint = statusFingerprint(status)
        if (fingerprint !== this.lastStatusFingerprint) {
          this.lastStatusFingerprint = fingerprint
          callback(status)
        }
      } catch (err) {
        logger.warn('GitService', 'Polling error while fetching git status', err)
      } finally {
        this.pollInFlight = false
      }
    }
    // Initial poll
    poll()
    this.pollTimer = setInterval(poll, intervalMs)
  }

  stopPolling(): void {
    // Retire the current generation so an in-flight poll can't fire the
    // callback after the caller has torn its listener down.
    this.pollGeneration++
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  destroy(): void {
    this.stopPolling()
    this.lineCountCache.clear()
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
