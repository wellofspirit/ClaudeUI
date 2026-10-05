/**
 * A System selection (ADR-082 §2-3): which detected install to run, read from
 * the detection cache (`./detect/detection-cache.ts`) and never by probing.
 *
 * The cache is a file in the user's home, so a record is checked against the
 * files it names before anything in it is spawned. That catches a stale,
 * corrupt or hand-edited record; it is not a defence against someone who can
 * write `~/.claude` (they could equally add a `settings.json` hook). An install
 * is used only when all of these hold:
 *
 *   - its version is still `tested` or `untested` under the manifest this
 *     build carries (`classifyVersion`), whatever detection labelled it;
 *   - the file that runs, and for pi a node from disk, still has the size and
 *     mtime detection saw (`isFingerprintFresh`);
 *   - its launch is the one detection would have built for those files: a
 *     native install is spawned as its fingerprinted `realPath`; pi is
 *     `<node> <realPath>` with the fingerprinted node, only the launcher's
 *     `PI_MANAGED_INSTALL_ROOT` (a directory above the script) in its env and
 *     at most that node's directory in `pathPrepend`. For a pi on Electron's
 *     own Node the cached command is ignored and rebuilt from this process
 *     (`process.execPath` with `ELECTRON_NODE_ENV`); outside Electron
 *     (`claudeui-server`) such an install cannot run.
 *
 * The launch returned is rebuilt from the checked fields, never the cached
 * object. Pure apart from the `stat`s behind `isFingerprintFresh`.
 */
import * as path from 'node:path'
import type {
  DetectedInstall,
  HarnessDetection,
  HarnessId,
  HarnessLaunch
} from '../../shared/harness-types'
import { bestSystemInstall, isFingerprintFresh } from './detect/detection-cache'
import { nodeVersionOk } from './detect/node-choice'
import { ELECTRON_NODE_ENV, nativeLaunch, nodeScriptLaunch } from './launch'
import { compareVersions } from './store'
import { classifyVersion, versionReason } from './version-gate'

const LABELS: Record<HarnessId, string> = {
  claude: 'Claude Code',
  opencode: 'opencode',
  pi: 'pi',
  codex: 'Codex'
}

/** The launcher environment a cached pi launch may carry, besides Electron's. */
const PI_LAUNCH_ENV: ReadonlySet<string> = new Set(['PI_MANAGED_INSTALL_ROOT'])

export interface SystemContext {
  /** Electron's executable and Node version when this process is Electron, else null. */
  electron: { execPath: string; nodeVersion: string } | null
  platform?: NodeJS.Platform
}

export type SystemOutcome =
  | {
      kind: 'ok'
      install: DetectedInstall
      /** `realPath`: the native executable, or pi's script. */
      path: string
      launch: HarnessLaunch
      version: string
    }
  | {
      kind: 'fallback'
      reason: string
      /** Whether a background re-detection could change the answer. */
      redetect: boolean
    }

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function isInside(file: string, dir: string, platform: NodeJS.Platform): boolean {
  const api = platform === 'win32' ? path.win32 : path.posix
  const rel = api.relative(
    platform === 'win32' ? dir.toLowerCase() : dir,
    platform === 'win32' ? file.toLowerCase() : file
  )
  return rel !== '' && !rel.startsWith('..') && !api.isAbsolute(rel)
}

function onElectronNode(install: DetectedInstall): boolean {
  return install.node !== undefined && 'kind' in install.node
}

function runnable(install: DetectedInstall): boolean {
  return install.verdict === 'tested' || install.verdict === 'untested'
}

/**
 * Re-label an install's version against the current manifest: a cache written
 * by an older build may call a version tested that this build does not. Only
 * the four version verdicts move; `unsupported` and `failed` stand.
 */
export function reclassifyInstall(id: HarnessId, install: DetectedInstall): DetectedInstall {
  const versionVerdicts = ['tested', 'untested', 'too-old', 'incompatible']
  if (!install.version || !versionVerdicts.includes(install.verdict)) return install
  const verdict = classifyVersion(id, install.version)
  if (verdict === install.verdict) return install
  // The reason moves with the label: the cached one describes the old verdict.
  const reason = versionReason(id, install.version, verdict)
  const { reason: _stale, ...rest } = install
  return { ...rest, verdict, ...(reason !== undefined ? { reason } : {}) }
}

/**
 * The launch to spawn for `install`, rebuilt from its fingerprinted files, or
 * null when the cached launch is not what detection would have written.
 */
function checkedLaunch(install: DetectedInstall, ctx: SystemContext): HarnessLaunch | null {
  const platform = ctx.platform ?? process.platform
  const cached = install.launch
  if (!cached) return null
  if (!samePath(install.fingerprint.path, install.realPath, platform)) return null

  if (!install.node) {
    const plain = cached.args.length === 0 && !cached.env && (cached.pathPrepend ?? []).length === 0
    return plain && samePath(cached.command, install.realPath, platform)
      ? nativeLaunch(install.realPath)
      : null
  }

  if (install.id !== 'pi') return null
  if (cached.args.length !== 1 || !samePath(cached.args[0], install.realPath, platform)) {
    return null
  }
  const onElectron = 'kind' in install.node
  const allowed = new Set([...PI_LAUNCH_ENV, ...(onElectron ? Object.keys(ELECTRON_NODE_ENV) : [])])
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(cached.env ?? {})) {
    if (!allowed.has(key)) return null
    if (key in ELECTRON_NODE_ENV) continue
    // The launcher's install root is a directory above the script it runs.
    if (!isInside(install.realPath, value, platform)) return null
    env[key] = value
  }
  const prepend = cached.pathPrepend ?? []

  if (onElectron) {
    if (prepend.length > 0 || !ctx.electron) return null
    return nodeScriptLaunch(ctx.electron.execPath, install.realPath, {
      ...env,
      ...ELECTRON_NODE_ENV
    })
  }

  const nodePath = (install.node as { path: string }).path
  const print = install.nodeFingerprint
  if (!samePath(cached.command, nodePath, platform)) return null
  if (!print || !samePath(print.path, nodePath, platform)) return null
  const nodeDir = path.dirname(nodePath)
  if (!prepend.every((dir) => samePath(dir, nodeDir, platform))) return null
  return nodeScriptLaunch(
    nodePath,
    install.realPath,
    Object.keys(env).length > 0 ? env : undefined,
    prepend.length > 0 ? [nodeDir] : undefined
  )
}

/**
 * What a System selection of `id` runs, from `detection` (the cached one;
 * undefined when detection has not run). Never throws.
 */
export function resolveSystemInstall(
  id: HarnessId,
  detection: HarnessDetection | undefined,
  ctx: SystemContext
): SystemOutcome {
  const label = LABELS[id]
  if (!detection) {
    return { kind: 'fallback', reason: 'System detection has not run yet', redetect: true }
  }

  // Electron's Node is only there inside Electron, and only when new enough.
  const electronOk = ctx.electron !== null && nodeVersionOk(ctx.electron.nodeVersion)
  const current = detection.installs.map((install) => reclassifyInstall(id, install))
  const installs = current.filter((install) => electronOk || !onElectronNode(install))
  const best = bestSystemInstall({ ...detection, installs })
  if (!best) {
    const onlyOnElectron = current.some((i) => runnable(i) && onElectronNode(i))
    if (onlyOnElectron) {
      return {
        kind: 'fallback',
        reason: `No usable System ${label} found: the one detected runs on ClaudeUI's own Node, which this process does not have`,
        redetect: false
      }
    }
    // Name why the install the user most likely means (the newest one) is not
    // usable, so the fallback explains itself ("2.1.198 is older than <floor>").
    const newest = [...current]
      .filter((i) => i.reason !== undefined)
      .sort((a, b) => compareVersions(b.version ?? '0.0.0', a.version ?? '0.0.0'))[0]
    return {
      kind: 'fallback',
      reason: newest
        ? `No usable System ${label} found: ${newest.reason}`
        : `No usable System ${label} found`,
      redetect: false
    }
  }
  if (!isFingerprintFresh(best)) {
    return {
      kind: 'fallback',
      reason: `System ${label} changed since it was detected`,
      redetect: true
    }
  }
  const launch = checkedLaunch(best, ctx)
  if (!launch) {
    return {
      kind: 'fallback',
      reason: `System ${label}'s detection record does not match the install`,
      redetect: true
    }
  }
  return { kind: 'ok', install: best, path: best.realPath, launch, version: best.version as string }
}
