/**
 * The small records the relaunch machinery keeps beside its jobs:
 *
 * - `health/<installKey>.json` `{ version, buildId, pid, at }`: written by every
 *   packaged boot once it is healthy, whatever launched it (design review
 *   ruling 3). The helper waits for one newer than its job. Compact JSON in this
 *   key order: the bash helper reads `at` and `version` with `sed`.
 * - `restore.json` `{ at, activeSessionId, drafts }`: the desktop's open session
 *   and unsent drafts, taken once by the next desktop renderer within 10 minutes.
 */

import * as fs from 'node:fs'
import { parseRestoreRecord, type RestoreRecord } from '../../../shared/relaunch'
import { writeAtomicRetrying, type RetryingWriteOptions } from './job'
import { healthDir, healthFile, restoreFile } from './paths'

export interface HealthRecord {
  version: string
  buildId: string | null
  pid: number
  /** Epoch ms. */
  at: number
}

export async function writeHealth(
  stateDir: string,
  installKey: string,
  record: HealthRecord,
  options?: RetryingWriteOptions
): Promise<void> {
  fs.mkdirSync(healthDir(stateDir), { recursive: true })
  const { version, buildId, pid, at } = record
  await writeAtomicRetrying(
    healthFile(stateDir, installKey),
    JSON.stringify({ version, buildId, pid, at }),
    options
  )
}

export const RESTORE_TTL_MS = 10 * 60_000

export async function writeRestore(
  stateDir: string,
  record: RestoreRecord,
  now: number,
  options?: RetryingWriteOptions
): Promise<void> {
  fs.mkdirSync(stateDir, { recursive: true })
  await writeAtomicRetrying(restoreFile(stateDir), JSON.stringify({ at: now, ...record }), options)
}

/** One-shot: the record when it is younger than 10 minutes; the file is gone either way. */
export function takeRestore(stateDir: string, now: number): RestoreRecord | null {
  const file = restoreFile(stateDir)
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    raw = null
  }
  try {
    fs.unlinkSync(file)
  } catch {
    /* absent */
  }
  const at = (raw as { at?: unknown } | null)?.at
  if (typeof at !== 'number' || now - at > RESTORE_TTL_MS || at > now + 60_000) return null
  return parseRestoreRecord(raw)
}
