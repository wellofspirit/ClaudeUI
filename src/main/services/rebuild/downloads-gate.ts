/**
 * The downloads-dir gate (Critical: anything that deletes user files). The only
 * delete of a rebuild's output (`<downloadsDir>/rebuild-<t8>`, electron-builder's
 * output folder for one rebuild) and of its log (`rebuild-<t8>.log`).
 *
 * `removeDownloadsEntry` refuses unless every check holds:
 *   1. the downloads dir itself is a real directory (not a link);
 *   2. the candidate sits directly inside it;
 *   3. its name is exactly `rebuild-<8 hex>` (then: a real directory, removed
 *      recursively) or `rebuild-<8 hex>.log` (then: a regular file, unlinked).
 * It never throws; a refusal or a failed delete returns the reason, logged.
 * Names and paths compare case-insensitively on win32 and darwin.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { logger } from '../../../core/services/logger'
import type { GateResult } from '../relaunch/delete-gate'

export const REBUILD_DIR_RE = /^rebuild-[0-9a-f]{8}$/
export const REBUILD_LOG_RE = /^rebuild-[0-9a-f]{8}\.log$/

const insensitive = process.platform === 'win32' || process.platform === 'darwin'
const norm = (p: string): string => (insensitive ? path.resolve(p).toLowerCase() : path.resolve(p))

export function removeDownloadsEntry(
  downloadsDir: string,
  candidate: string,
  log: (message: string) => void = (m) => logger.warn('app-update', m)
): GateResult {
  const refuse = (reason: string): GateResult => {
    log(`downloads gate refused ${JSON.stringify(candidate)}: ${reason}`)
    return { removed: false, reason }
  }
  try {
    const dirStat = fs.lstatSync(downloadsDir)
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory())
      return refuse('the downloads folder is not a real directory')
  } catch {
    return refuse('the downloads folder does not exist')
  }
  if (norm(path.dirname(path.resolve(candidate))) !== norm(downloadsDir))
    return refuse('not directly inside the downloads folder')
  const name = path.basename(path.resolve(candidate))
  const isDir = REBUILD_DIR_RE.test(name)
  const isLog = REBUILD_LOG_RE.test(name)
  if (!isDir && !isLog) return refuse('the name is not a rebuild output or log')
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(candidate)
  } catch {
    return refuse('it does not exist')
  }
  try {
    if (isDir) {
      if (stat.isSymbolicLink() || !stat.isDirectory()) return refuse('not a real directory')
      fs.rmSync(candidate, { recursive: true, force: false, maxRetries: 3 })
    } else {
      if (!stat.isFile()) return refuse('not a regular file')
      fs.unlinkSync(candidate)
    }
  } catch (err) {
    return refuse(`the delete failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  logger.info('app-update', `removed ${candidate}`)
  return { removed: true }
}
