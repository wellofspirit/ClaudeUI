/**
 * THE deletion gate (Critical: anything that deletes user files). The only
 * recursive delete in the relaunch machinery; nothing else may call
 * `fs.rm(…, { recursive: true })` on an install-related path, and the helper
 * scripts never delete recursively at all (they only rename).
 *
 * `removeOwnedDir` refuses unless every check holds:
 *   1. the candidate is a sibling of the install (same parent);
 *   2. its name is ours: `.<base>.(old|failed|update)-<version>-<t8>`, and the
 *      `<t8>` is the job token's when one is given;
 *   3. `lstat` says a real directory (a symlink or a Windows junction is refused);
 *   4. it holds a valid ClaudeUI install marker;
 *   5. no live relaunch lock names it.
 * A refusal returns the reason and logs it; nothing is touched. It never
 * throws: a delete that fails part-way (a file in use) is reported the same way,
 * so a caller sweeping several candidates goes on to the next. Names and paths
 * compare case-insensitively on win32 and darwin, whose filesystems do.
 */

import * as fs from 'node:fs'
import { logger } from '../../../core/services/logger'
import { readInstallMarker } from './eligibility'
import { parseJob } from './job'
import { isLockStale, readLock } from './lock'
import { caseInsensitivePaths, jobFiles, pathFor, samePath, type RelaunchPlatform } from './paths'

export type GateResult = { removed: true } | { removed: false; reason: string }

export interface GateOptions {
  platform: RelaunchPlatform
  /** The relaunch state dir, whose lock is consulted. */
  stateDir: string
  /** When given, the name's `<t8>` must be this token's first 8 hex. */
  token?: string
  now?: number
  log?: (message: string) => void
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The sibling-name pattern for an install basename; group 1 is the `<t8>`.
 * `caseInsensitive` on win32 and darwin ({@link caseInsensitivePaths}).
 */
export function ownedNamePattern(base: string, caseInsensitive = false): RegExp {
  return new RegExp(
    `^\\.${escapeRe(base)}\\.(?:old|failed|update)-[A-Za-z0-9.+-]+-([0-9a-f]{8})$`,
    caseInsensitive ? 'i' : ''
  )
}

/** Does a live (non-stale) lock's job name `candidate`? Unknowable counts as yes. */
function liveLockNames(
  stateDir: string,
  candidate: string,
  same: (a: string, b: string) => boolean,
  now: number
): boolean {
  const lock = readLock(stateDir)
  if (!lock) return false
  const hasResult = (token: string): boolean => fs.existsSync(jobFiles(stateDir, token).result)
  if (isLockStale(lock, now, hasResult)) return false
  if (!lock.owner) return true
  try {
    const job = parseJob(
      JSON.parse(fs.readFileSync(jobFiles(stateDir, lock.owner.token).json, 'utf8'))
    )
    if (!job) return true
    return [job.installPath, job.stagedPath, job.backupPath, job.failedPath].some(
      (p) => p !== '' && same(p, candidate)
    )
  } catch {
    return true
  }
}

export function removeOwnedDir(
  installPath: string,
  candidate: string,
  options: GateOptions
): GateResult {
  const log = options.log ?? ((message: string) => logger.warn('relaunch', message))
  const refuse = (reason: string): GateResult => {
    log(`deletion gate refused ${JSON.stringify(candidate)}: ${reason}`)
    return { removed: false, reason }
  }
  try {
    return gate(installPath, candidate, options, refuse)
  } catch (err) {
    return refuse(`the delete failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function gate(
  installPath: string,
  candidate: string,
  options: GateOptions,
  refuse: (reason: string) => GateResult
): GateResult {
  const { platform, stateDir } = options
  const p = pathFor(platform)
  const same = (a: string, b: string): boolean => samePath(a, b, platform)

  if (!same(p.dirname(p.resolve(candidate)), p.dirname(p.resolve(installPath))))
    return refuse('not a sibling of the install')
  const match = ownedNamePattern(
    p.basename(p.resolve(installPath)),
    caseInsensitivePaths(platform)
  ).exec(p.basename(p.resolve(candidate)))
  if (!match) return refuse('the name is not one the relaunch machinery gives')
  if (
    options.token !== undefined &&
    match[1].toLowerCase() !== options.token.slice(0, 8).toLowerCase()
  )
    return refuse("the name does not carry this job's token")
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(candidate)
  } catch {
    return refuse('it does not exist')
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return refuse('not a real directory')
  if (!readInstallMarker(candidate, platform)) return refuse('no ClaudeUI install marker inside')
  if (liveLockNames(stateDir, candidate, same, options.now ?? Date.now()))
    return refuse('a relaunch in progress names it')

  try {
    fs.rmSync(candidate, { recursive: true, force: false, maxRetries: 3 })
  } catch (err) {
    return refuse(`the delete failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  logger.info('relaunch', `removed ${candidate}`)
  return { removed: true }
}
