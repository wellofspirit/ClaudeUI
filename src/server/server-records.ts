/**
 * The records the server's monitor and worker keep in ClaudeUI's relaunch state
 * dir (`~/.claude/ui/relaunch/`, shared with the desktop's relaunch machinery,
 * whose own file names these never collide with):
 *
 *   health/<installKey(root)>.json   the worker's health record, written once its
 *                                    listener is bound (design review ruling 4)
 *   server-<token>.result.json       one result per restart, written by the monitor
 *
 * Both shapes are the desktop's (`src/shared/relaunch.ts`); a server result also
 * carries the install key, so two server installs on one machine each read
 * their own. Part of the monitor protocol (`server-layout.ts`).
 */

import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  parseHealthRecord,
  parseRelaunchResult,
  type HealthRecord,
  type RelaunchResult
} from '../shared/relaunch'
import { writeFileAtomic } from './server-layout'

/** The relaunch state dir. `home` is injectable: tests never touch the real `~/.claude/ui`. */
export function serverStateDir(home: string = os.homedir()): string {
  return path.join(home, '.claude', 'ui', 'relaunch')
}

/**
 * First 16 hex of sha256 of the install root (lower-cased on Windows, whose paths
 * are case-insensitive): the desktop's `installKeyFor` formula.
 */
export function installKeyFor(root: string, platform: string): string {
  const p = path.resolve(root)
  return createHash('sha256')
    .update(platform === 'win32' ? p.toLowerCase() : p, 'utf8')
    .digest('hex')
    .slice(0, 16)
}

export const healthFile = (stateDir: string, installKey: string): string =>
  path.join(stateDir, 'health', `${installKey}.json`)

const RESULT_RE = /^server-([0-9a-f]{32})\.result\.json$/
export const resultFile = (stateDir: string, token: string): string =>
  path.join(stateDir, `server-${token}.result.json`)

/** Compact JSON in the desktop's key order (its bash helper reads it with `sed`). */
export function writeHealth(
  stateDir: string,
  installKey: string,
  record: HealthRecord,
  platform: string
): void {
  const { version, buildId, pid, at } = record
  writeFileAtomic(
    healthFile(stateDir, installKey),
    JSON.stringify({ version, buildId, pid, at }),
    platform
  )
}

export function readHealth(stateDir: string, installKey: string): HealthRecord | null {
  try {
    return parseHealthRecord(JSON.parse(fs.readFileSync(healthFile(stateDir, installKey), 'utf8')))
  } catch {
    return null
  }
}

export function writeResult(
  stateDir: string,
  installKey: string,
  result: RelaunchResult,
  platform: string
): void {
  writeFileAtomic(
    resultFile(stateDir, result.token),
    JSON.stringify({ ...result, installKey }),
    platform
  )
}

/** The newest result this install's monitor wrote, or null. Never throws. */
export function lastResult(stateDir: string, installKey: string): RelaunchResult | null {
  let names: string[]
  try {
    names = fs.readdirSync(stateDir)
  } catch {
    return null
  }
  let newest: RelaunchResult | null = null
  for (const name of names) {
    const m = RESULT_RE.exec(name)
    if (!m) continue
    let raw: unknown
    try {
      raw = JSON.parse(fs.readFileSync(path.join(stateDir, name), 'utf8'))
    } catch {
      continue
    }
    if ((raw as { installKey?: unknown } | null)?.installKey !== installKey) continue
    const result = parseRelaunchResult(raw)
    if (result && result.token === m[1] && (!newest || result.at > newest.at)) newest = result
  }
  return newest
}

export const RESULT_KEEP_MS = 30 * 24 * 60 * 60_000

/** Unlink this monitor's result files older than 30 days (single files; never throws). */
export function pruneResults(stateDir: string, now: number): void {
  let names: string[]
  try {
    names = fs.readdirSync(stateDir)
  } catch {
    return
  }
  for (const name of names) {
    if (!RESULT_RE.test(name)) continue
    const file = path.join(stateDir, name)
    try {
      const stat = fs.lstatSync(file)
      if (stat.isFile() && now - stat.mtimeMs > RESULT_KEEP_MS) fs.unlinkSync(file)
    } catch {
      /* raced, or not ours to read */
    }
  }
}
