/**
 * Staging a verified release archive beside the install (Critical: the staged
 * folder is what the relaunch helper swaps in, and every recursive delete here
 * goes through the deletion gate).
 *
 * The staged build is `.<base>.update-<version>-<t8>` in the install's parent
 * (S1 naming, a fresh token each time), so the swap is two same-volume renames.
 * It is unpacked into the extract container first (`extract-container.ts`:
 * `.<base>.extract-<version>-<t8>`, created with its staging record), checked
 * there, and only then renamed to the staging name:
 *
 * - macOS: the zip's central directory is vetted (`vet-release-zip.ts`: names
 *   inside `ClaudeUI.app/`, no `..`, no path through a link, links that stay in
 *   the bundle) before `ditto -x -k --noqtn <zip> <container>` (ditto keeps the
 *   bundle's symlinks; same volume as the install). The container must then hold
 *   exactly one entry besides its record, a real `ClaudeUI.app` directory, which
 *   must pass the signature policy (`codesign.ts`).
 * - Windows: the zip (no root folder) is extracted into `<container>/app` by the
 *   harness archive reader (no links, no traversal).
 * - Both: the build's install marker must be present, a desktop marker, and
 *   carry exactly `version`; on Windows its top-level entries must be the ones
 *   the marker lists.
 *
 * A failure (or an interruption: the boot sweep) removes the container through
 * the gate, which proves it ours by its staging record whatever was unpacked.
 * Errors carry no local path: every client sees them.
 */

import * as fs from 'node:fs'
import { extractZip as harnessExtractZip } from '../../../core/harness/install/archive'
import { unexpectedEntries, type InstallMarker } from '../../../shared/install-marker'
import { EXTRACTED_APP, removeOwnedDir, stagedNamePattern } from '../relaunch/delete-gate'
import { readInstallMarker } from '../relaunch/eligibility'
import {
  caseInsensitivePaths,
  newToken as freshToken,
  pathFor,
  type RelaunchPlatform
} from '../relaunch/paths'
import { checkStagedSignature, type SignaturePolicyArgs, type SignatureVerdict } from './codesign'
import type { Exec } from './exec'
import {
  closeContainer,
  containerEntries,
  discardContainer,
  openExtractContainer,
  promote
} from './extract-container'
import { vetReleaseZip } from './vet-release-zip'

export const DITTO = '/usr/bin/ditto'

/** A desktop release, unpacked: generous next to the harness defaults, still bounded. */
const WIN_EXTRACT_LIMITS = {
  maxEntryBytes: 1024 * 1024 * 1024,
  maxTotalBytes: 3 * 1024 * 1024 * 1024,
  maxEntries: 100_000
}

export interface StageDeps {
  platform: RelaunchPlatform
  installPath: string
  /** The relaunch state dir (the gate consults its lock). */
  stateDir: string
  exec: Exec
  extractZip?: typeof harnessExtractZip
  checkSignature?: (args: SignaturePolicyArgs) => Promise<SignatureVerdict>
  /** macOS: vet the zip before ditto (default: `vetReleaseZip`). */
  vetZip?: (archive: string) => Promise<void>
  newToken?: () => string
  now?: () => number
  /** Every folder created beside the install, as it is created (the boot sweep spares them). */
  onCreated?: (dir: string) => void
  log?: (message: string) => void
}

export type StagedCheck = { ok: true; marker: InstallMarker } | { ok: false; reason: string }

function isRealDir(dir: string): boolean {
  try {
    const stat = fs.lstatSync(dir)
    return !stat.isSymbolicLink() && stat.isDirectory()
  } catch {
    return false
  }
}

/**
 * Is `stagedPath` a usable staged build: a real directory with a desktop
 * install marker carrying `version` (when given), and on Windows nothing at its
 * top level the marker does not list?
 */
export function checkStagedBuild(
  stagedPath: string,
  platform: RelaunchPlatform,
  version?: string
): StagedCheck {
  if (!isRealDir(stagedPath)) return { ok: false, reason: 'The staged build is missing' }
  const marker = readInstallMarker(stagedPath, platform)
  if (!marker) return { ok: false, reason: 'The staged build has no ClaudeUI install marker' }
  if (!marker.version) return { ok: false, reason: 'The staged build does not say its version' }
  if (version !== undefined && marker.version !== version)
    return { ok: false, reason: `The staged build is ${marker.version}, not ${version}` }
  if (platform === 'win32') {
    let names: string[]
    try {
      names = fs.readdirSync(stagedPath)
    } catch {
      return { ok: false, reason: 'The staged build could not be read' }
    }
    const extra = unexpectedEntries(names, marker, true)
    if (extra.length > 0)
      return {
        ok: false,
        reason: `The staged build holds files its marker does not list: ${extra.slice(0, 5).join(', ')}`
      }
  }
  return { ok: true, marker }
}

/**
 * The staged folder a staged id names, or null when the id is not exactly a
 * staging name for this install (`.<base>.update-<version>-<t8>`: no separator,
 * no other kind of sibling).
 */
export function stagedPathFor(
  installPath: string,
  stagedId: string,
  platform: RelaunchPlatform
): string | null {
  const p = pathFor(platform)
  if (typeof stagedId !== 'string' || /[\\/\0]/.test(stagedId)) return null
  if (!stagedNamePattern(p.basename(installPath), caseInsensitivePaths(platform)).test(stagedId))
    return null
  return p.join(p.dirname(installPath), stagedId)
}

/** Stage `archive` (already verified against the signed manifest) as `version`. Returns the staged folder. */
export async function stageArchive(
  deps: StageDeps,
  archive: string,
  version: string
): Promise<string> {
  const { platform, installPath } = deps
  const p = pathFor(platform)
  const log = deps.log ?? (() => {})
  const gate = { platform, stateDir: deps.stateDir, log }
  // Vetted before anything is created beside the install.
  if (platform === 'darwin') await (deps.vetZip ?? vetReleaseZip)(archive)
  const container = openExtractContainer({
    installPath,
    version,
    token: (deps.newToken ?? freshToken)(),
    platform,
    now: (deps.now ?? Date.now)()
  })
  deps.onCreated?.(container.dir)
  let promoted = false
  try {
    if (platform === 'darwin') {
      const r = await deps.exec(DITTO, ['-x', '-k', '--noqtn', archive, container.dir], {
        timeoutMs: 10 * 60_000
      })
      if (r.code !== 0) throw new Error(`The update could not be unpacked (ditto exit ${r.code})`)
      const names = containerEntries(container.dir)
      if (names.length !== 1 || names[0] !== EXTRACTED_APP)
        throw new Error(`The update archive does not hold exactly one ${EXTRACTED_APP}`)
      if (!isRealDir(container.inner))
        throw new Error(`The update's ${EXTRACTED_APP} is not a folder`)
    } else {
      fs.mkdirSync(container.inner)
      await (deps.extractZip ?? harnessExtractZip)(archive, container.inner, {
        platform: 'win32',
        limits: WIN_EXTRACT_LIMITS
      })
    }

    const check = checkStagedBuild(container.inner, platform, version)
    if (!check.ok) throw new Error(check.reason)

    if (platform === 'darwin') {
      const verdict = await (deps.checkSignature ?? checkStagedSignature)({
        exec: deps.exec,
        installPath,
        stagedPath: container.inner,
        log
      })
      if (!verdict.ok) throw new Error(verdict.reason)
    }
    deps.onCreated?.(container.staged)
    promote(container)
    promoted = true
    closeContainer(container, installPath, gate)
    log(`staged ${version} as ${p.basename(container.staged)}`)
    return container.staged
  } catch (err) {
    discardContainer(container, installPath, gate)
    if (promoted) {
      const r = removeOwnedDir(installPath, container.staged, gate)
      if (!r.removed) log(`left a staged build in place (${r.reason})`)
    }
    if (err instanceof Error && err.message.includes(p.dirname(installPath)))
      throw new Error('The update could not be staged beside ClaudeUI', { cause: err })
    throw err
  }
}
