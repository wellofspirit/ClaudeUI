/**
 * The relaunch lock: `relaunch/lock/` (mkdir is the atomic test-and-set),
 * holding `owner.json` `{ token, pid, at }`. Taken by the main process before
 * the job is written and released by the helper when it exits (or by the main
 * process when the helper never got going). Stale after 15 minutes, or once its
 * token has a result: a helper that died cannot hold every later restart hostage.
 *
 * Nothing here is recursive: release unlinks `owner.json` and removes the then
 * empty directory, so a lock dir holding anything unexpected stays put.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { isToken, lockDir } from './paths'

export const LOCK_STALE_MS = 15 * 60_000
const OWNER_FILE = 'owner.json'

export interface LockOwner {
  token: string
  pid: number
  /** Epoch ms. */
  at: number
}

export interface LockState {
  /** Null when `owner.json` is missing or unreadable (a half-written lock). */
  owner: LockOwner | null
  /** The lock dir's mtime, the age of a lock with no readable owner. */
  mtimeMs: number
}

/** Take the lock; false when it is held (by anyone). */
export function takeLock(stateDir: string, owner: LockOwner): boolean {
  fs.mkdirSync(stateDir, { recursive: true })
  const dir = lockDir(stateDir)
  try {
    fs.mkdirSync(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  }
  fs.writeFileSync(path.join(dir, OWNER_FILE), JSON.stringify(owner), { mode: 0o600 })
  return true
}

/** The lock as it is on disk, or null when nobody holds it. */
export function readLock(stateDir: string): LockState | null {
  const dir = lockDir(stateDir)
  let mtimeMs: number
  try {
    mtimeMs = fs.statSync(dir).mtimeMs
  } catch {
    return null
  }
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(dir, OWNER_FILE), 'utf8')
    ) as Partial<LockOwner>
    if (isToken(raw.token) && typeof raw.pid === 'number' && typeof raw.at === 'number')
      return { owner: { token: raw.token, pid: raw.pid, at: raw.at }, mtimeMs }
  } catch {
    /* half-written */
  }
  return { owner: null, mtimeMs }
}

/** Stale: older than 15 minutes, or its job already has a result. */
export function isLockStale(
  lock: LockState,
  now: number,
  hasResult: (token: string) => boolean
): boolean {
  const at = lock.owner?.at ?? lock.mtimeMs
  if (now - at > LOCK_STALE_MS) return true
  return lock.owner !== null && hasResult(lock.owner.token)
}

/** Release the lock (only when `token` is given and matches, or unconditionally without one). */
export function releaseLock(stateDir: string, token?: string): void {
  const dir = lockDir(stateDir)
  if (token !== undefined) {
    const lock = readLock(stateDir)
    if (lock?.owner && lock.owner.token !== token) return
  }
  try {
    fs.unlinkSync(path.join(dir, OWNER_FILE))
  } catch {
    /* already gone */
  }
  try {
    fs.rmdirSync(dir)
  } catch {
    /* gone, or holds something we did not put there: leave it */
  }
}
