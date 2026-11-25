/**
 * THE deletion gate (Critical: anything that deletes user files). The only
 * recursive delete in the relaunch machinery; nothing else may call
 * `fs.rm(…, { recursive: true })` on an install-related path, and the helper
 * scripts never delete recursively at all (they only rename).
 *
 * `removeOwnedDir` refuses unless every check holds:
 *   1. the candidate is a sibling of the install (same parent);
 *   2. its name is ours: `.<base>.(old|failed|update|extract)-<version>-<t8>`,
 *      and the `<t8>` is the job token's when one is given;
 *   3. `lstat` says a real directory (a symlink or a Windows junction is refused);
 *   4. it holds a valid ClaudeUI install marker. An `extract` folder (the
 *      container a release archive is unpacked or a rebuild copied into before
 *      it is renamed to the staging name) is ours by EITHER a marker inside its
 *      real `ClaudeUI.app` directory, OR by provenance: the staging record
 *      (`.claudeui-staging.json`, a regular file) its producer wrote the moment
 *      it created the folder, whose token's first 8 hex equal the name's `<t8>`.
 *      So an extraction or copy that failed or was interrupted part-way, before
 *      any marker landed, is still removable;
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
import {
  caseInsensitivePaths,
  jobFiles,
  pathFor,
  samePath,
  type RelaunchPlatform,
  type SiblingKind
} from './paths'

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

const ALL_KINDS: readonly SiblingKind[] = ['old', 'failed', 'update', 'extract']

/** What an extracted macOS release archive holds, the one entry the marker is looked for in. */
export const EXTRACTED_APP = 'ClaudeUI.app'

/**
 * The staging record an `extract` container carries from the moment it exists:
 * `{ token, version, at }`, written by its producer (`app-update/extract-container.ts`).
 */
export const STAGING_RECORD = '.claudeui-staging.json'

/** Does `dir` hold a staging record (a regular file, not a link) whose token matches `t8`? */
export function stagingRecordMatches(dir: string, t8: string, platform: RelaunchPlatform): boolean {
  const file = pathFor(platform).join(dir, STAGING_RECORD)
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.size > 4096) return false
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown> | null
    if (typeof raw !== 'object' || raw === null) return false
    const { token, version, at } = raw
    if (typeof token !== 'string' || !/^[0-9a-f]{8}(?:[0-9a-f]{24})?$/i.test(token)) return false
    if (typeof version !== 'string' || version === '' || typeof at !== 'number') return false
    return token.slice(0, 8).toLowerCase() === t8.toLowerCase()
  } catch {
    return false
  }
}

/**
 * The name pattern of an install's siblings of `kinds`; groups `kind` and `t8`.
 * `caseInsensitive` on win32 and darwin ({@link caseInsensitivePaths}).
 */
export function siblingNamePattern(
  base: string,
  kinds: readonly SiblingKind[],
  caseInsensitive = false
): RegExp {
  return new RegExp(
    `^\\.${escapeRe(base)}\\.(?<kind>${kinds.join('|')})-[A-Za-z0-9.+-]+-(?<t8>[0-9a-f]{8})$`,
    caseInsensitive ? 'i' : ''
  )
}

/** Every name the relaunch and update machinery give an install's siblings. */
export function ownedNamePattern(base: string, caseInsensitive = false): RegExp {
  return siblingNamePattern(base, ALL_KINDS, caseInsensitive)
}

/** A staged build's name (`.<base>.update-<version>-<t8>`), and nothing else. */
export function stagedNamePattern(base: string, caseInsensitive = false): RegExp {
  return siblingNamePattern(base, ['update'], caseInsensitive)
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

/** `lstat` says a directory, and not a symlink or a Windows junction. */
function isRealDir(dir: string): boolean {
  try {
    const stat = fs.lstatSync(dir)
    return !stat.isSymbolicLink() && stat.isDirectory()
  } catch {
    return false
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
  if (!match?.groups) return refuse('the name is not one the relaunch machinery gives')
  if (
    options.token !== undefined &&
    match.groups.t8.toLowerCase() !== options.token.slice(0, 8).toLowerCase()
  )
    return refuse("the name does not carry this job's token")
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(candidate)
  } catch {
    return refuse('it does not exist')
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return refuse('not a real directory')
  if (match.groups.kind.toLowerCase() === 'extract') {
    const app = p.join(candidate, EXTRACTED_APP)
    const marked = isRealDir(app) && readInstallMarker(app, platform) !== null
    if (!marked && !stagingRecordMatches(candidate, match.groups.t8, platform))
      return refuse(
        `neither a marked ${EXTRACTED_APP} nor a staging record of its own token inside`
      )
  } else if (!readInstallMarker(candidate, platform)) {
    return refuse('no ClaudeUI install marker inside')
  }
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
