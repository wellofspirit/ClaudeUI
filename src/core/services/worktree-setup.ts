import { simpleGit, type SimpleGit } from 'simple-git'
import ignore from 'ignore'
import * as fs from 'fs'
import * as path from 'path'
import { logger } from './logger'
import { isPathInside } from './path-containment'
import { realOrResolved } from './worktree-root'

const LOG = 'worktree'
const WORKTREES_DIR = '.claude/worktrees'

/**
 * What a fresh worktree needs besides the checkout, mirroring Claude Code's own worktree setup:
 * hooks that resolve inside it, an ignore rule for the managed folder, and the files
 * `.worktreeinclude` asks for. Every step is best-effort: a failure is logged and never fails
 * the creation that called it.
 */
export async function setupWorktree(gitRoot: string, worktreePath: string): Promise<void> {
  const git = simpleGit(gitRoot)
  await runStep('configure hooksPath', () => shareRelativeHooksPath(gitRoot))
  await runStep('ignore the worktrees folder', () =>
    ignoreWorktreesFolder(git, gitRoot, worktreePath)
  )
  await runStep('copy .worktreeinclude files', () =>
    copyWorktreeInclude(git, gitRoot, worktreePath)
  )
}

async function runStep(what: string, step: () => Promise<void>): Promise<void> {
  try {
    await step()
  } catch (err) {
    logger.warn(LOG, `Failed to ${what}`, err)
  }
}

// ---------------------------------------------------------------------------
// core.hooksPath
// ---------------------------------------------------------------------------

/**
 * A RELATIVE `core.hooksPath` (husky v9: `.husky/_`) resolves against the checkout that runs the
 * hook, and a new worktree does not have that folder (it is generated and gitignored), so its
 * hooks would silently never run. Pin it to the absolute path it already means in the main
 * checkout. Unset or absolute values need nothing: the default `.git/hooks` is shared.
 */
async function shareRelativeHooksPath(gitRoot: string): Promise<void> {
  // `--type=path` expands `~/` the way git does when it runs hooks, so such a value reads as
  // absolute and is left alone.
  const value = (
    await simpleGit(gitRoot).raw(['config', '--local', '--type=path', '--get', 'core.hooksPath'])
  ).trim()
  if (!value || path.isAbsolute(value)) return

  const absolute = path.resolve(gitRoot, value).replace(/\\/g, '/')
  // simple-git refuses hooksPath writes by default (a hostile value is a code-execution vector);
  // this one comes from the repo's own config and is only made absolute.
  const writer = simpleGit({ baseDir: gitRoot, unsafe: { allowUnsafeHooksPath: true } })
  await writer.raw(['config', '--local', 'core.hooksPath', absolute])
}

// ---------------------------------------------------------------------------
// .claude/worktrees/ in the main checkout's status
// ---------------------------------------------------------------------------

/**
 * A repo that does not ignore `.claude/worktrees/` shows the new worktree as an untracked
 * embedded repo (`?? .claude/`). Add it to the repo-local `info/exclude`, which no one commits.
 */
async function ignoreWorktreesFolder(
  git: SimpleGit,
  gitRoot: string,
  worktreePath: string
): Promise<void> {
  // `-q` would hide the answer: simple-git only fails on stderr, and "not ignored" is a silent
  // exit 1. Without it the path is printed iff it is ignored.
  const rel = path.relative(gitRoot, worktreePath).replace(/\\/g, '/')
  if ((await git.raw(['check-ignore', rel])).trim()) return

  const excludeRaw = (await git.raw(['rev-parse', '--git-path', 'info/exclude'])).trim()
  const excludePath = path.resolve(gitRoot, excludeRaw)
  await fs.promises.mkdir(path.dirname(excludePath), { recursive: true })

  let existing = ''
  try {
    existing = await fs.promises.readFile(excludePath, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  // Already there but outranked (a `!.claude/worktrees/` in .gitignore): adding it again won't help.
  if (existing.split(/\r?\n/).includes(`/${WORKTREES_DIR}/`)) return
  const lead = existing === '' || existing.endsWith('\n') ? '' : '\n'
  await fs.promises.appendFile(excludePath, `${lead}# ClaudeUI worktrees\n/${WORKTREES_DIR}/\n`)
}

// ---------------------------------------------------------------------------
// .worktreeinclude
// ---------------------------------------------------------------------------

const LS_IGNORED = ['ls-files', '--others', '--ignored', '--exclude-standard']
const GLOB_CHAR = /[*?[]/

/**
 * Copy the untracked, gitignored files that `<gitRoot>/.worktreeinclude` (gitignore syntax) lists
 * into the new worktree. Tracked and plain-untracked files are never candidates.
 */
async function copyWorktreeInclude(
  git: SimpleGit,
  gitRoot: string,
  worktreePath: string
): Promise<void> {
  let content: string
  try {
    content = await fs.promises.readFile(path.join(gitRoot, '.worktreeinclude'), 'utf-8')
  } catch {
    return
  }
  // An editor's BOM would otherwise glue itself to the first pattern.
  content = content.replace(/^\uFEFF/, '')
  const patterns = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
  if (patterns.length === 0) return

  const matcher = ignore().add(content)
  const listed = (await git.raw([...LS_IGNORED, '--directory', '-z'])).split('\0').filter(Boolean)
  const dirs = listed.filter((entry) => entry.endsWith('/'))
  const files = listed.filter((entry) => !entry.endsWith('/') && matcher.ignores(entry))

  // `--directory` collapses an ignored folder (`node_modules/`) into one entry; list inside only
  // the ones a pattern can reach, so `*.env` does not walk the whole of node_modules.
  const expand = dirs.filter((dir) => patternsReachDir(patterns, matcher, dir))
  if (expand.length > 0) {
    const inside = await git.raw(['--literal-pathspecs', ...LS_IGNORED, '-z', '--', ...expand])
    for (const file of inside.split('\0').filter(Boolean)) {
      if (matcher.ignores(file)) files.push(file)
    }
  }

  // Other worktrees live under the managed folder; a `.claude/` pattern must not copy them.
  const wanted = files.filter((file) => !file.startsWith(`${WORKTREES_DIR}/`))

  // A committed symlink inside the new worktree may point anywhere: judge destinations by where
  // they really land.
  const realWorktree = realOrResolved(worktreePath)
  // Resolved once per folder: an include set can reach thousands of files in a few folders, and
  // the resolution is synchronous.
  const realDirs = new Map<string, string>()
  const copied: string[] = []
  for (const file of wanted) {
    const source = path.join(gitRoot, file)
    const destination = path.join(worktreePath, file)
    try {
      if ((await fs.promises.lstat(source)).isSymbolicLink()) {
        logger.warn(LOG, `Skipping symlink in .worktreeinclude: ${file}`)
        continue
      }
      // The folder's real path does not see a link AT the destination itself (a dangling one
      // would let copyFile write through it), so that is checked on its own.
      if ((await lstatOrNull(destination))?.isSymbolicLink()) {
        logger.warn(LOG, `Skipping .worktreeinclude entry whose destination is a symlink: ${file}`)
        continue
      }
      const dir = path.dirname(destination)
      let realDir = realDirs.get(dir)
      if (realDir === undefined) {
        realDir = realOrResolved(dir)
        realDirs.set(dir, realDir)
      }
      if (!isPathInside(realWorktree, path.join(realDir, path.basename(destination)))) {
        logger.warn(LOG, `Skipping .worktreeinclude entry that escapes the worktree: ${file}`)
        continue
      }
      await fs.promises.mkdir(path.dirname(destination), { recursive: true })
      await fs.promises.copyFile(source, destination)
      copied.push(file)
    } catch (err) {
      logger.warn(LOG, `Failed to copy ${file} into the worktree`, err)
    }
  }
  if (copied.length > 0) logger.info(LOG, `Copied ${copied.length} files from .worktreeinclude`)
}

async function lstatOrNull(p: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.lstat(p)
  } catch {
    return null
  }
}

/** Claude Code's rule for descending into a collapsed ignored directory (`dir` ends with `/`). */
function patternsReachDir(
  patterns: string[],
  matcher: ReturnType<typeof ignore>,
  dir: string
): boolean {
  const reached = patterns.some((pattern) => {
    const p = pattern.startsWith('/') ? pattern.slice(1) : pattern
    if (p.startsWith(dir)) return true

    const glob = p.search(GLOB_CHAR)
    if (glob > 0 && dir.startsWith(p.slice(0, glob))) return true

    // `**/name...`: the first segment after the leading `**/` must be a component of the directory.
    let rest = p
    while (rest.startsWith('**/')) rest = rest.slice(3)
    if (rest === p) return false
    const segment = rest.split('/')[0]
    const segmentGlob = segment.search(GLOB_CHAR)
    const literal = (segmentGlob === -1 ? segment : segment.slice(0, segmentGlob))
      .replace(/\\/g, '')
      .toLowerCase()
    if (!literal) return false
    const parts = dir.slice(0, -1).toLowerCase().split('/')
    return segmentGlob === -1
      ? parts.includes(literal)
      : parts.some((part) => part.startsWith(literal))
  })
  return reached || matcher.ignores(dir.slice(0, -1)) || matcher.ignores(dir)
}
