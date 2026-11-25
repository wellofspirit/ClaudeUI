/**
 * The desktop's `AppUpdateHost` (`core/host.ts`): what the core update service
 * (`core/services/app-update.ts`) needs from a packaged desktop build. Wired in
 * `boot-core.ts` for packaged builds only (`bun run dev` keeps `null`).
 *
 * - `buildInfo` is this build's `out/build-info.json`; `target` is
 *   `desktop-darwin-arm64` or `desktop-win32-x64` (else none: no updates).
 * - `eligibility` is the relaunch machinery's (`relaunch/eligibility.ts`: the
 *   install marker, a writable parent, not translocated, nothing extra in a
 *   Windows install folder).
 * - `stage` unpacks a verified archive beside the install
 *   (`app-update/stage.ts`, with the macOS signature policy), `isStaged`
 *   re-checks a staged folder after a restart, and `apply` restarts into it
 *   through the relaunch service (`swap`, source `release`).
 * - Rebuilds (`rebuild/`): the trees the host lists from the source checkout
 *   (the `appUpdateSourcePath` setting, else a local build's own source), a
 *   rebuild staged beside the install, and `applyRebuild` (`swap`, source
 *   `rebuild`). A rebuild and a relaunch never overlap: each refuses while the
 *   other is in flight.
 * - `bootCleanup` is the boot sweep (`app-update/boot-cleanup.ts`), run after
 *   the relaunch reconciliation, and only while single-instance enforcement is on.
 * - No rebuild where no desktop build is published (`target()` null: an Intel
 *   Mac, Windows on Arm): there is nothing a rebuild could be checked against.
 *
 * Staged ids are folder names, checked against the exact staging-name pattern
 * for this install before any use; no path from a client ever reaches a disk
 * operation, and a rebuild names its tree by an id the host looks up itself.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AppUpdateHost } from '../../core/host'
import { defaultAppUpdateStatePath, parseAppUpdateState } from '../../core/services/app-update'
import { readBuildInfo } from '../../core/services/build-info'
import { logger } from '../../core/services/logger'
import type { BuildInfo, DevBuildInfo } from '../../shared/build-info'
import type { AppUpdateEligibility } from '../../shared/types/app-update'
import type { UpdateTarget } from '../../shared/update-manifest'
import { bootCleanup } from './app-update/boot-cleanup'
import { execTool, type Exec } from './app-update/exec'
import { checkStagedBuild, stageArchive, stagedPathFor, type StageDeps } from './app-update/stage'
import { checkEligibility, type EligibilityProbes } from './relaunch/eligibility'
import {
  caseInsensitivePaths,
  installKeyFor,
  installLocation,
  relaunchStateDir,
  type RelaunchPlatform
} from './relaunch/paths'
import type { RelaunchService } from './relaunch/relaunch-service'
import { createRebuilder, type Rebuilder, type RebuilderDeps } from './rebuild/rebuild'
import { listTrees, publicTree, sourceRepoFor } from './rebuild/trees'

const LOG = 'app-update'

export interface DesktopAppUpdateDeps {
  platform: string
  arch: string
  execPath: string
  /** `app.getAppPath()`: where `out/build-info.json` is. */
  appPath: string
  /** The relaunch service, read at use (configured after the quit coordinator exists). */
  relaunch: () => RelaunchService | null
  /** The `appUpdateSourcePath` setting (`appSetting`), read at use. */
  sourceSetting: () => string | undefined
  /**
   * Single-instance enforcement is on (`index.ts`). Off (CLAUDEUI_ALLOW_MULTIPLE_INSTANCES=1,
   * or dev), another copy may be running from a backup or staging folder, so the
   * boot sweep is skipped. Default off.
   */
  singleInstance?: boolean
  home?: string
  exec?: Exec
  probes?: EligibilityProbes
  buildInfo?: () => BuildInfo | DevBuildInfo
  /** The update state file (S3), whose staged id the boot sweep keeps. */
  statePath?: () => string
  now?: () => number
  /** Test seams for staging and the rebuilder. */
  stage?: Partial<StageDeps>
  rebuilder?: Partial<RebuilderDeps>
}

export interface DesktopAppUpdateHost extends AppUpdateHost {
  /** The boot sweep. Never throws. */
  bootCleanup(): void
  /** Why a relaunch must wait for a rebuild, or null. */
  rebuildBusy(): string | null
}

/** This host's manifest asset key, or null where no desktop build is published. */
export function desktopTarget(platform: string, arch: string): UpdateTarget | null {
  if (platform === 'darwin' && arch === 'arm64') return 'desktop-darwin-arm64'
  if (platform === 'win32' && arch === 'x64') return 'desktop-win32-x64'
  return null
}

export function createDesktopAppUpdateHost(deps: DesktopAppUpdateDeps): DesktopAppUpdateHost {
  const platform: RelaunchPlatform | null =
    deps.platform === 'darwin' || deps.platform === 'win32' ? deps.platform : null
  const home = deps.home ?? os.homedir()
  const exec = deps.exec ?? execTool
  const now = deps.now ?? Date.now
  const stateDir = relaunchStateDir(home)
  const downloads = path.join(home, '.claude', 'ui', 'updates', 'desktop')
  const statePath = deps.statePath ?? defaultAppUpdateStatePath
  const log = (message: string): void => logger.info(LOG, message)

  let info: BuildInfo | DevBuildInfo | null = null
  const buildInfo = (): BuildInfo | DevBuildInfo => {
    if (!info) info = deps.buildInfo?.() ?? readBuildInfo(deps.appPath, true)
    return info
  }

  // Folders this process created beside the install or in the downloads dir:
  // the boot sweep never touches them (a staging or rebuild may be running).
  const created = new Set<string>()
  const keyOf = (p: string): string => {
    const r = path.resolve(p)
    return platform && caseInsensitivePaths(platform) ? r.toLowerCase() : r
  }
  const markCreated = (p: string): void => void created.add(keyOf(p))
  const release = (p: string): void => void created.delete(keyOf(p))

  const eligible = (): ReturnType<typeof checkEligibility> =>
    checkEligibility({
      packaged: true,
      platform: deps.platform,
      execPath: deps.execPath,
      probes: deps.probes
    })

  /** The install, or throw the reason it cannot be updated now. */
  function installOrThrow(): { path: string; platform: RelaunchPlatform } {
    const e = eligible()
    if (!e.ok) throw new Error(e.reason)
    return { path: e.installPath, platform: e.platform }
  }

  function relaunchOrThrow(): RelaunchService {
    const svc = deps.relaunch()
    if (!svc) throw new Error('ClaudeUI is still starting; try again in a moment')
    return svc
  }

  const sourceRepo = (): string | null => {
    try {
      return sourceRepoFor(deps.sourceSetting(), buildInfo())
    } catch {
      return null
    }
  }

  const rebuilder: Rebuilder | null = platform
    ? createRebuilder({
        platform,
        install: () => {
          const e = eligible()
          if (e.ok) return { ok: true, path: e.installPath }
          const where = installLocation(deps.execPath, deps.platform)
          return { ok: false, reason: e.reason, ...(where.ok ? { path: where.path } : {}) }
        },
        stateDir,
        downloadsDir: downloads,
        listTrees: async () => {
          const repo = sourceRepo()
          return repo ? listTrees(repo, { exec, log }) : []
        },
        relaunchBusy: () => deps.relaunch()?.relaunchInProgress() ?? false,
        exec,
        onCreated: markCreated,
        onReleased: release,
        log,
        ...deps.rebuilder
      })
    : null

  return {
    buildInfo,

    target: () => desktopTarget(deps.platform, deps.arch),

    async eligibility(): Promise<AppUpdateEligibility> {
      const e = eligible()
      return e.ok ? { ok: true } : { ok: false, reason: e.reason }
    },

    downloadsDir: () => downloads,

    async stage(archivePath, version) {
      const install = installOrThrow()
      const staged = await stageArchive(
        {
          platform: install.platform,
          installPath: install.path,
          stateDir,
          exec,
          onCreated: markCreated,
          log,
          ...deps.stage
        },
        archivePath,
        version
      )
      return { stagedId: path.basename(staged) }
    },

    async isStaged(stagedId, version) {
      const e = eligible()
      if (!e.ok) return false
      const staged = stagedPathFor(e.installPath, stagedId, e.platform)
      return staged !== null && checkStagedBuild(staged, e.platform, version).ok
    },

    async apply(stagedId, version) {
      const install = installOrThrow()
      const staged = stagedPathFor(install.path, stagedId, install.platform)
      if (!staged) throw new Error('The staged update is not one ClaudeUI staged here')
      await relaunchOrThrow().requestRelaunch({
        mode: 'swap',
        stagedPath: staged,
        toVersion: version,
        source: 'release'
      })
    },

    rebuildAvailable() {
      if (!rebuilder || !desktopTarget(deps.platform, deps.arch)) return false
      const repo = sourceRepo()
      if (!repo) return false
      try {
        return fs.statSync(repo).isDirectory()
      } catch {
        return false
      }
    },

    async trees() {
      const repo = sourceRepo()
      if (!rebuilder || !repo || !desktopTarget(deps.platform, deps.arch)) return []
      // The checkout this local build came from, so the panel picks it first
      // when no tree's HEAD is the build's commit any more.
      const info = buildInfo()
      const own =
        info.kind === 'local' &&
        typeof info.sourcePath === 'string' &&
        path.isAbsolute(info.sourcePath)
          ? keyOf(info.sourcePath)
          : null
      return (await listTrees(repo, { exec, log })).map((t) => ({
        ...publicTree(t),
        ...(own !== null && keyOf(t.path) === own ? { buildSource: true as const } : {})
      }))
    },

    async rebuild(treeId, onProgress) {
      if (!rebuilder) throw new Error('This build cannot rebuild itself')
      if (!desktopTarget(deps.platform, deps.arch))
        throw new Error(
          `ClaudeUI publishes no desktop build for ${deps.platform}-${deps.arch}, so it cannot rebuild and update itself here`
        )
      return rebuilder.start(treeId, onProgress)
    },

    async cancelRebuild() {
      await rebuilder?.cancel()
    },

    async stopRebuild() {
      await rebuilder?.stop()
    },

    async applyRebuild() {
      const built = rebuilder?.built()
      if (!built) throw new Error('No rebuild is ready to apply')
      await relaunchOrThrow().requestRelaunch({
        mode: 'swap',
        stagedPath: built.stagedPath,
        toVersion: built.version,
        source: 'rebuild'
      })
    },

    rebuildBusy: () => rebuilder?.busy() ?? null,

    bootCleanup() {
      if (!deps.singleInstance) {
        log('boot sweep skipped: single-instance enforcement is off, another copy may be running')
        return
      }
      try {
        const e = eligible()
        if (!e.ok) {
          log(`boot sweep skipped: ${e.reason}`)
          return
        }
        let stagedId: string | null = null
        try {
          stagedId =
            parseAppUpdateState(JSON.parse(fs.readFileSync(statePath(), 'utf8'))).staged
              ?.stagedId ?? null
        } catch {
          /* no state file: nothing staged */
        }
        bootCleanup({
          platform: e.platform,
          installPath: e.installPath,
          installKey: installKeyFor(e.installPath, e.platform),
          stateDir,
          downloadsDir: downloads,
          stagedId,
          spared: (dir) => created.has(keyOf(dir)),
          now: now()
        })
      } catch (err) {
        logger.warn(LOG, `boot sweep failed: ${String(err)}`)
      }
    }
  }
}

// ── The process's host ────────────────────────────────────────────────────────

let current: DesktopAppUpdateHost | null = null

/** Publish (or clear) the desktop host, for the relaunch busy check and the boot sweep. */
export function setDesktopAppUpdateHost(host: DesktopAppUpdateHost | null): void {
  current = host
}

export function desktopAppUpdateHost(): DesktopAppUpdateHost | null {
  return current
}
