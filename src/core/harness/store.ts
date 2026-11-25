/**
 * ClaudeUI's managed harness store (ADR-082 §4):
 *
 *   ~/.claude/ui/harnesses/<id>/<version>/
 *     <payload>       the release's payload (opencode: the binary; pi: its
 *                     whole release directory)
 *     install.json    HarnessInstallRecord, written last
 *     last-used       touched when the resolver picks this version (GC)
 *   ~/.claude/ui/harnesses/.staging/   installs in progress (`install/store-writer.ts`)
 *   ~/.claude/ui/harnesses/.trash/     directories moved aside, deleted later
 *
 * The installer (`install/store-writer.ts`) writes versions by atomic
 * directory rename; this module reads them, and writes only `last-used`. A
 * directory without a valid `install.json` for this host is not an install.
 * `CLAUDEUI_HARNESS_STORE` moves the root (tests, development).
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { HarnessId, HarnessInstallRecord } from '../../shared/harness-types'
import { HARNESS_VERSION_RE } from './selection-store'
import { compareVersions } from '../../shared/version-compare'

export const HARNESS_STORE_ENV = 'CLAUDEUI_HARNESS_STORE'

const VERIFIED: ReadonlySet<string> = new Set(['reviewed', 'publisher'])

/** Resolved at call time so a redirected home or env (tests) is honoured. */
export function harnessStoreRoot(): string {
  const override = process.env[HARNESS_STORE_ENV]
  return override ? path.resolve(override) : path.join(os.homedir(), '.claude', 'ui', 'harnesses')
}

/** The directory for one version. Throws on a version that is not a safe directory name. */
export function installDir(id: HarnessId, version: string): string {
  if (!HARNESS_VERSION_RE.test(version)) throw new Error(`Invalid ${id} version: ${version}`)
  return path.join(harnessStoreRoot(), id, version)
}

/**
 * `<versionDir>/last-used`: its mtime is when the resolver last picked this
 * version. Retention (`install/gc.ts`) keeps a version used in the last seven
 * days.
 */
export const LAST_USED_FILE = 'last-used'

/**
 * Record that `version` was just resolved for a spawn. Once per resolution
 * (the resolver caches), never per spawn. Never throws: a read-only store only
 * loses retention precision.
 */
export function markVersionUsed(id: HarnessId, version: string, now: Date = new Date()): void {
  try {
    fs.writeFileSync(path.join(installDir(id, version), LAST_USED_FILE), `${now.toISOString()}\n`)
  } catch {
    // Missing directory or read-only store: GC falls back to install.json's installedAt.
  }
}

/**
 * The version's `install.json` when it is valid for this harness, this version
 * and this host; otherwise null. Never throws.
 */
export function readInstallRecord(id: HarnessId, version: string): HarnessInstallRecord | null {
  if (!HARNESS_VERSION_RE.test(version)) return null
  let record: unknown
  try {
    record = JSON.parse(
      fs.readFileSync(path.join(installDir(id, version), 'install.json'), 'utf-8')
    )
  } catch {
    return null
  }
  if (record === null || typeof record !== 'object') return null
  const r = record as Record<string, unknown>
  if (
    r.id !== id ||
    r.version !== version ||
    r.platform !== process.platform ||
    r.arch !== process.arch ||
    typeof r.installedAt !== 'string' ||
    typeof r.verified !== 'string' ||
    !VERIFIED.has(r.verified)
  ) {
    return null
  }
  return {
    id,
    version,
    platform: process.platform,
    arch: process.arch,
    installedAt: r.installedAt,
    verified: r.verified as HarnessInstallRecord['verified']
  }
}

/** Semver order (`src/shared/version-compare.ts`), re-exported for the core callers. */
export { compareVersions }

/** Installed versions of `id` for this host, newest first. Never throws. */
export function installedVersions(id: HarnessId): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(path.join(harnessStoreRoot(), id), { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isDirectory() && readInstallRecord(id, e.name) !== null)
    .map((e) => e.name)
    .sort((a, b) => compareVersions(b, a))
}
