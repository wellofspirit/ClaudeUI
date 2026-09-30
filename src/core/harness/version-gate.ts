/**
 * Which versions of a harness ClaudeUI accepts (ADR-082 §3), from its release
 * manifest (`./manifests.ts`):
 *
 *   tested        equals the manifest's `tested`
 *   untested      floor ≤ v < ceiling and not tested; older-than-tested
 *                 versions at or above the floor are untested too
 *   too-old       below the floor
 *   incompatible  at or above the ceiling (the next major), or not a version
 *
 * The ceiling compares the release core only, so a pre-release of the next
 * major (`3.0.0-beta.1`) is incompatible rather than "just below 3.0.0". The
 * floor keeps full semver order, so a pre-release of the floor is too old.
 *
 * Pure: no filesystem, no process.
 */
import type { HarnessId } from '../../shared/harness-types'
import { harnessManifest } from './manifests'
import { HARNESS_VERSION_RE } from './selection-store'
import { compareVersions } from './store'

export type HarnessVersionClass = 'tested' | 'untested' | 'too-old' | 'incompatible'

/** `1.2.3-beta+build` → `1.2.3`. */
function releaseCore(version: string): string {
  return version.split('+')[0].split('-')[0]
}

export function classifyVersion(id: HarnessId, version: string): HarnessVersionClass {
  if (!HARNESS_VERSION_RE.test(version)) return 'incompatible'
  const { tested, floor, ceiling } = harnessManifest(id)
  if (compareVersions(releaseCore(version), ceiling) >= 0) return 'incompatible'
  if (compareVersions(version, floor) < 0) return 'too-old'
  return compareVersions(version, tested) === 0 ? 'tested' : 'untested'
}

/** Can ClaudeUI run this version at all (tested or untested)? */
export function versionAccepted(id: HarnessId, version: string): boolean {
  const verdict = classifyVersion(id, version)
  return verdict === 'tested' || verdict === 'untested'
}
