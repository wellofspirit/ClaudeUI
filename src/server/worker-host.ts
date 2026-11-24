/**
 * The worker's side of the monitor protocol (`monitor.ts`, `server-layout.ts`):
 * what `serve` wires into the `HostRelaunch` and `AppUpdateHost` seams
 * (`src/core/host.ts`), and its health record.
 *
 * - Supervised means started by a monitor: `--worker` AND `CLAUDEUI_MONITOR` of a
 *   protocol this build accepts AND an absolute `CLAUDEUI_MONITOR_ROOT`. `--no-monitor`
 *   is never supervised, whatever the environment says (a shell inside a supervised
 *   server inherits it until `main.ts` clears it).
 * - Relaunch: supervised only. It is a graceful shutdown with
 *   {@link RESTART_EXIT_CODE}; the monitor starts the worker again.
 * - Update: compiled builds only. Staging extracts into `versions/` (through
 *   `server-versions.ts`); applying writes `pending` and then restarts the same way.
 *   Eligibility refuses without a monitor, in a container, in a folder it cannot
 *   write, and in an install whose root has no server marker.
 * - Health: once the listener is bound, `relaunch/health/<installKey(root)>.json`.
 *
 * Every reason and error here is shown to every client: none carries a local path.
 */

import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AppUpdateHost, HostRelaunch } from '../core/host'
import type { BuildInfo, DevBuildInfo } from '../shared/build-info'
import type { RelaunchAvailability } from '../shared/relaunch'
import type { AppUpdateEligibility } from '../shared/types/app-update'
import type { UpdateTarget } from '../shared/update-manifest'
import {
  MONITOR_ENV,
  SUPPORTED_MONITOR_PROTOCOLS,
  MONITOR_ROOT_ENV,
  RESTART_EXIT_CODE,
  isValidVersionDir,
  readServerMarker,
  versionRunningFrom,
  versionsDir,
  writePending
} from './server-layout'
import { installKeyFor, lastResult, writeHealth } from './server-records'
import { stageServerArchive } from './server-versions'
import type { Shutdown } from './shutdown'

// ── Supervision ──────────────────────────────────────────────────────────────

export const NO_MONITOR_REASON = 'This server was started with --no-monitor'
export const UNSUPERVISED_REASON = 'This server is not supervised by the ClaudeUI monitor'

export interface Supervision {
  supervised: boolean
  /** Why not (shown to clients); absent when supervised. */
  reason?: string
  /** The monitor's root when supervised; `fallbackRoot` otherwise. */
  root: string
}

export function supervisionOf(
  options: { worker?: boolean; noMonitor?: boolean },
  env: NodeJS.ProcessEnv,
  fallbackRoot: string
): Supervision {
  if (options.noMonitor) return { supervised: false, reason: NO_MONITOR_REASON, root: fallbackRoot }
  const root = env[MONITOR_ROOT_ENV]
  if (
    options.worker === true &&
    SUPPORTED_MONITOR_PROTOCOLS.includes(env[MONITOR_ENV] ?? '') &&
    typeof root === 'string' &&
    path.isAbsolute(root)
  )
    return { supervised: true, root: path.resolve(root) }
  return { supervised: false, reason: UNSUPERVISED_REASON, root: fallbackRoot }
}

/** The monitor's variables, so the shells and engines this worker starts do not inherit them. */
export function clearMonitorEnv(env: NodeJS.ProcessEnv): void {
  delete env[MONITOR_ENV]
  delete env[MONITOR_ROOT_ENV]
}

// ── The lifetime tie ─────────────────────────────────────────────────────────

/** The part of `process.stdin` the tie uses. */
export interface TieStdin {
  on(event: 'end' | 'close', listener: () => void): unknown
  resume(): unknown
}

export interface MonitorTie {
  /** From now on the monitor's end runs `handler` (the graceful shutdown) instead. */
  onGone(handler: () => void): void
}

/**
 * The lifetime tie, as the voice worker's: the monitor holds the worker's stdin
 * open and never writes to it, so its end means the monitor is gone. Attached as
 * soon as supervision is known; while the server is still booting there is
 * nothing to stop gracefully, so it exits at once (`exit`), and once the shutdown
 * exists it is handed over with {@link MonitorTie.onGone}. Fires once.
 */
export function tieToMonitor(stdin: TieStdin, exit: () => void): MonitorTie {
  let handler: () => void = exit
  let fired = false
  const gone = (): void => {
    if (fired) return
    fired = true
    handler()
  }
  stdin.on('end', gone)
  stdin.on('close', gone)
  stdin.resume()
  return {
    onGone(next) {
      handler = next
    }
  }
}

// ── Restart ──────────────────────────────────────────────────────────────────

export interface Restarter {
  /** Why a restart cannot start now, or null. */
  refusal(): string | null
  /**
   * Start the graceful shutdown with {@link RESTART_EXIT_CODE}, a moment from now
   * so the reply to the request that asked for it goes out first. Throws the
   * refusal when there is one.
   */
  restart(reason: string): void
  /**
   * Hand over the shutdown once it exists; returns the one to use for signals and
   * the monitor's exit, so a restart is refused once any stop has begun.
   */
  attach(shutdown: Shutdown): Shutdown
}

export function createRestarter(supervision: Supervision, delayMs = 250): Restarter {
  let shutdown: Shutdown | null = null
  let stopping = false
  const refusal = (): string | null => {
    if (!supervision.supervised) return supervision.reason ?? UNSUPERVISED_REASON
    if (stopping) return 'The server is already stopping or restarting'
    if (!shutdown) return 'The server is still starting'
    return null
  }
  return {
    refusal,
    restart(reason) {
      const refused = refusal()
      if (refused) throw new Error(refused)
      stopping = true
      const s = shutdown as Shutdown
      setTimeout(() => s(reason, RESTART_EXIT_CODE), delayMs)
    },
    attach(s) {
      shutdown = s
      return (reason, code) => {
        stopping = true
        s(reason, code)
      }
    }
  }
}

export function createServerHostRelaunch(args: {
  restarter: Restarter
  stateDir: string
  installKey: string
}): HostRelaunch {
  return {
    availability(): RelaunchAvailability {
      const reason = args.restarter.refusal()
      return reason ? { available: false, reason } : { available: true }
    },
    async relaunch(): Promise<void> {
      args.restarter.restart('relaunch requested')
    },
    lastResult() {
      return lastResult(args.stateDir, args.installKey)
    }
  }
}

// ── Eligibility ──────────────────────────────────────────────────────────────

/**
 * An update runs the server from a new executable (`versions/<v>/…`), and both
 * the Windows Firewall and the macOS Application Firewall approve executables
 * one by one, so an approval of the old one does not carry over.
 */
export const FIREWALL_NOTICE =
  'macOS and Windows firewalls approve each server executable separately; allow the port instead (see docs)'

/** This host's server asset in the update manifest, or null where none is published. */
export function serverUpdateTarget(platform: string, arch: string): UpdateTarget | null {
  if (platform === 'darwin' && arch === 'arm64') return 'server-darwin-arm64'
  if (platform === 'win32' && arch === 'x64') return 'server-win32-x64'
  if (platform === 'linux' && arch === 'x64') return 'server-linux-x64'
  if (platform === 'linux' && arch === 'arm64') return 'server-linux-arm64'
  return null
}

export interface ContainerProbes {
  exists(file: string): boolean
  /** null when unreadable. */
  readFile(file: string): string | null
  env: NodeJS.ProcessEnv
}

export const diskContainerProbes: ContainerProbes = {
  exists: (file) => fs.existsSync(file),
  readFile: (file) => {
    try {
      return fs.readFileSync(file, 'utf8')
    } catch {
      return null
    }
  },
  env: process.env
}

/**
 * The first sign that this process runs in a container, or null. cgroup v2 shows
 * `0::/` inside a container, which is why the marker files come first.
 */
export function containerSign(probes: ContainerProbes): string | null {
  if (probes.exists('/.dockerenv')) return '/.dockerenv'
  if (probes.exists('/run/.containerenv')) return '/run/.containerenv'
  if (probes.env.KUBERNETES_SERVICE_HOST) return 'KUBERNETES_SERVICE_HOST'
  const cgroup = probes.readFile('/proc/1/cgroup')
  if (cgroup !== null && /docker|kubepods|containerd/.test(cgroup)) return '/proc/1/cgroup'
  return null
}

/**
 * POSIX: `access(W_OK)`. Windows: `access` only checks the read-only attribute,
 * so probe by creating and removing an empty directory (never anything recursive).
 */
export function canWriteDir(dir: string, platform: string): boolean {
  if (platform !== 'win32') {
    try {
      fs.accessSync(dir, fs.constants.W_OK)
      return true
    } catch {
      return false
    }
  }
  try {
    fs.rmdirSync(fs.mkdtempSync(path.join(dir, '.claudeui-probe-')))
    return true
  } catch {
    return false
  }
}

export interface EligibilityArgs {
  supervision: Supervision
  platform: string
  container?: ContainerProbes
  canWrite?: (dir: string) => boolean
}

export function serverUpdateEligibility(args: EligibilityArgs): AppUpdateEligibility {
  const { supervision, platform } = args
  if (!supervision.supervised)
    return {
      ok: false,
      reason: `${supervision.reason ?? UNSUPERVISED_REASON}: updates are announced, not installed`
    }
  if (containerSign(args.container ?? diskContainerProbes))
    return { ok: false, reason: 'This server runs in a container: update its image instead' }
  const canWrite = args.canWrite ?? ((dir: string) => canWriteDir(dir, platform))
  const root = supervision.root
  if (!canWrite(root))
    return { ok: false, reason: "Can't update here: the server folder is not writable" }
  let versions: fs.Stats | null
  try {
    versions = fs.lstatSync(versionsDir(root))
  } catch {
    versions = null
  }
  if (versions && (versions.isSymbolicLink() || !versions.isDirectory()))
    return { ok: false, reason: "Can't update here: versions/ is not a real directory" }
  if (versions && !canWrite(versionsDir(root)))
    return { ok: false, reason: "Can't update here: the versions folder is not writable" }
  if (!readServerMarker(root))
    return {
      ok: false,
      reason:
        'This install predates self-update (no install marker): reinstall it once to enable updates'
    }
  return platform === 'win32' || platform === 'darwin'
    ? { ok: true, notice: FIREWALL_NOTICE }
    : { ok: true }
}

// ── The update seam ──────────────────────────────────────────────────────────

export interface ServerAppUpdateDeps {
  supervision: Supervision
  restarter: Restarter
  platform: string
  arch: string
  /** The running worker's executable (a `versions/` folder's, or the flat install's). */
  execPath: string
  buildInfo: () => BuildInfo | DevBuildInfo
  home?: string
  container?: ContainerProbes
  canWrite?: (dir: string) => boolean
  log?: (message: string) => void
  newToken?: () => string
}

export function createServerAppUpdateHost(deps: ServerAppUpdateDeps): AppUpdateHost {
  const { supervision, platform } = deps
  const root = supervision.root
  return {
    buildInfo: deps.buildInfo,
    target: () => serverUpdateTarget(platform, deps.arch),
    eligibility: async () =>
      serverUpdateEligibility({
        supervision,
        platform,
        container: deps.container,
        canWrite: deps.canWrite
      }),
    downloadsDir: () => path.join(deps.home ?? os.homedir(), '.claude', 'ui', 'updates', 'server'),
    stage: (archive, version) =>
      stageServerArchive({ root, archive, version, platform, log: deps.log }),
    isStaged: async (stagedId, version) =>
      stagedId === version && isValidVersionDir(root, version, platform),
    async apply(stagedId, version) {
      const refused = deps.restarter.refusal()
      if (refused) throw new Error(refused)
      if (stagedId !== version || !isValidVersionDir(root, version, platform))
        throw new Error(`${version} is no longer staged; download it again`)
      writePending(
        root,
        {
          token: (deps.newToken ?? (() => randomBytes(16).toString('hex')))(),
          from: versionRunningFrom(root, deps.execPath, platform),
          to: version
        },
        platform
      )
      deps.restarter.restart(`update to ${version} requested`)
    }
  }
}

// ── Health ───────────────────────────────────────────────────────────────────

/** Write this worker's health record (supervised only; the monitor is waiting on it). Never throws. */
export function reportWorkerHealthy(args: {
  supervision: Supervision
  stateDir: string
  platform: string
  version: string
  buildId: string | null
  pid: number
  now: number
  log: (message: string) => void
}): void {
  if (!args.supervision.supervised) return
  try {
    writeHealth(
      args.stateDir,
      installKeyFor(args.supervision.root, args.platform),
      { version: args.version, buildId: args.buildId, pid: args.pid, at: args.now },
      args.platform
    )
  } catch (err) {
    args.log(
      `could not write the health record: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}
