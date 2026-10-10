/**
 * Retention for the managed store (ADR-082 §4): versions no session uses are
 * removed after seven days.
 *
 * A version directory is removed only when all of these hold:
 *
 *   - it is not the manifest's tested version;
 *   - it is not the version the selection names: an exact version, or for
 *     `latest` the newest installed one (what the resolver would pick). The
 *     selection's version counts even while the source is System, because
 *     switching back restores it;
 *   - it is not the managed version the resolver runs right now (a session
 *     spawned from it may still be running; on macOS and Linux nothing else
 *     would stop its files from being removed under it);
 *   - it was last used (`last-used`, touched by the resolver) more than seven
 *     days ago; without `last-used`, `install.json`'s `installedAt`; without
 *     either, the directory's own mtime.
 *
 * Only directories named like a version are considered. Removal renames the
 * directory into `.trash/` first, so a version is either whole or gone; a
 * rename that fails (Windows EPERM: a running process holds a file in it) is
 * skipped and retried next time. Stale `.staging` / `.trash` entries go too.
 *
 * Runs in the background after the boot detection (`startDetectionScheduler`'s
 * `afterBoot`), never on a spawn path. One info line with the counts. A harness
 * that lost a version is invalidated once, so clients hear `harness:changed`.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type {
  HarnessId,
  HarnessManifest,
  HarnessSelection,
  ResolvedHarness
} from '../../../shared/harness-types'
import { HARNESS_IDS } from '../../../shared/harness-types'
import { logger } from '../../services/logger'
import { harnessManifest } from '../manifests'
import { invalidateHarness, resolveHarness } from '../resolve'
import { HARNESS_VERSION_RE, harnessSelection } from '../selection-store'
import { LAST_USED_FILE, harnessStoreRoot, installedVersions, readInstallRecord } from '../store'
import { cleanStaleEntries, moveToTrash } from './store-writer'
import { aboveCeiling, withinRange } from '../version-gate'

export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export interface GcDeps {
  now?: () => number
  manifest?: (id: HarnessId) => HarnessManifest
  selection?: (id: HarnessId) => HarnessSelection
  /** The resolver's current answer for `id` (default `resolveHarness`). */
  resolved?: (id: HarnessId) => Pick<ResolvedHarness, 'source' | 'version'>
  /** Moves a version directory aside (default `moveToTrash`); throws when it is in use. */
  remove?: (dir: string, label: string) => Promise<void>
  /**
   * Called once per harness that lost a version (default `invalidateHarness`),
   * so the Installed page hears `harness:changed` and re-reads the store.
   */
  invalidate?: (id: HarnessId) => void
}

export interface GcResult {
  removed: string[]
  kept: number
  /** Directories that could not be removed (in use); retried next time. */
  skipped: string[]
  /** Stale `.staging` / `.trash` entries removed. */
  stale: number
}

function mtime(file: string): number | null {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return null
  }
}

/** When `version` was last used, by the rules above. */
function lastUsed(id: HarnessId, version: string, dir: string): number {
  const touched = mtime(path.join(dir, LAST_USED_FILE))
  if (touched !== null) return touched
  const installedAt = Date.parse(readInstallRecord(id, version)?.installedAt ?? '')
  if (Number.isFinite(installedAt)) return installedAt
  return mtime(dir) ?? 0
}

/** The versions of `id` retention must keep regardless of age. */
function protectedVersions(
  id: HarnessId,
  manifest: HarnessManifest,
  selection: HarnessSelection,
  resolved: Pick<ResolvedHarness, 'source' | 'version'>
): Set<string> {
  const keep = new Set([manifest.tested])
  if (resolved.source === 'managed' && resolved.version) keep.add(resolved.version)
  if (selection.version === 'latest') {
    const newest = installedVersions(id).find((v) => withinRange(manifest, v))
    if (newest) keep.add(newest)
  } else if (selection.version && selection.version !== 'tested') {
    keep.add(selection.version)
  }
  return keep
}

/** Remove unused managed versions. Never throws. */
export async function collectHarnessGarbage(deps: GcDeps = {}): Promise<GcResult> {
  const now = (deps.now ?? Date.now)()
  const manifestOf = deps.manifest ?? harnessManifest
  const selectionOf = deps.selection ?? ((id: HarnessId) => harnessSelection(id))
  const resolvedOf = deps.resolved ?? ((id: HarnessId) => resolveHarness(id))
  const remove = deps.remove ?? moveToTrash
  const invalidate = deps.invalidate ?? ((id: HarnessId) => invalidateHarness(id))
  const result: GcResult = { removed: [], kept: 0, skipped: [], stale: 0 }

  try {
    result.stale = await cleanStaleEntries(now)
    for (const id of HARNESS_IDS) {
      const root = path.join(harnessStoreRoot(), id)
      let names: string[]
      try {
        names = fs
          .readdirSync(root, { withFileTypes: true })
          .filter((e) => e.isDirectory() && HARNESS_VERSION_RE.test(e.name))
          .map((e) => e.name)
      } catch {
        continue
      }
      const manifest = manifestOf(id)
      const keep = protectedVersions(id, manifest, selectionOf(id), resolvedOf(id))
      let removedAny = false
      for (const version of names) {
        const dir = path.join(root, version)
        // Past this build's ceiling: another (newer) ClaudeUI's install in the
        // shared store, never this build's to retire.
        if (
          keep.has(version) ||
          aboveCeiling(manifest, version) ||
          now - lastUsed(id, version, dir) < RETENTION_MS
        ) {
          result.kept++
          continue
        }
        try {
          await remove(dir, `${id}-${version}`)
          result.removed.push(`${id} ${version}`)
          removedAny = true
        } catch (err) {
          result.skipped.push(`${id} ${version}`)
          logger.debug(
            'harness',
            `could not remove ${id} ${version} (${(err as NodeJS.ErrnoException).code ?? String(err)}); retrying next time`
          )
        }
      }
      if (removedAny) {
        try {
          invalidate(id)
        } catch (err) {
          logger.warn('harness', `invalidating ${id} after GC failed`, err)
        }
      }
    }
  } catch (err) {
    logger.warn('harness', `harness GC failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  logger.info(
    'harness',
    `harness GC: removed ${result.removed.length}${
      result.removed.length > 0 ? ` (${result.removed.join(', ')})` : ''
    }, kept ${result.kept}, in use ${result.skipped.length}, stale staging/trash ${result.stale}`
  )
  return result
}
