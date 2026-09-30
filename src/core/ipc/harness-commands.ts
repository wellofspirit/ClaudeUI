/**
 * The harness manager's channels (ADR-082 arc 2, S4), declared ONCE and served
 * by both transports: the Installed page reads and drives these, on the
 * desktop and from a phone alike.
 *
 * ## Capabilities
 *
 * - Reads (`harness:state`, `harness:versions`) declare `config`, a `query`:
 *   free on every tier, like `ide:availability`. Every device sees the page.
 * - Writes declare `admin` (ADR-082 §7): installing a binary from a remote
 *   device is close to remote code execution, and so is choosing which program
 *   runs (`set-selection`) or running every program detection finds on the
 *   host (`detect`). A base remote connection never holds `admin`; a passkey or
 *   break-glass one does, and at the `strong` tier a write also needs the
 *   mutation window (`classifyDispatch` → `mutation`). The desktop renderer's
 *   host connection holds every capability. The four are pinned in
 *   `PINNED_CAPABILITIES`, so no later edit can relabel one `config`.
 *
 * ## Results
 *
 * Every result is discriminated by `status` or `kind`, never an `ok` key: the
 * preload and web `unwrap` treat any object carrying `ok` as their own envelope
 * and would return its `.data` (undefined). Bad arguments throw.
 *
 * ## Events (`startHarnessEvents`)
 *
 * `harness:changed { id }` whenever the resolver is invalidated for a harness
 * (a detection finished, an install finished, a selection was saved, retention
 * removed a version): a nudge, and the client re-reads `harness:state`.
 * `harness:install-progress` carries `HarnessInstallProgress` (at most four a
 * second per install, from the installer). Both are replicated sync events, so
 * the desktop renderer and every remote client get them the same way.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type {
  DetectedInstall,
  HarnessDetection,
  HarnessDetectionStatus,
  HarnessId,
  HarnessInstallCancelResult,
  HarnessInstallProgress,
  HarnessInstallResult,
  HarnessManagedVersionView,
  HarnessSelection,
  HarnessStateEntry,
  HarnessStateSnapshot,
  HarnessSystemInstallView,
  HarnessSystemView,
  HarnessVersionsResult,
  HarnessesConfig
} from '../../shared/harness-types'
import { HARNESS_IDS, isHarnessId } from '../../shared/harness-types'
import { loadDetectionCache } from '../harness/detect/detection-cache'
import { currentElectron } from '../harness/detect/node-choice'
import { detectionStatus, requestDetection } from '../harness/detect/scheduler'
import { activeInstalls, installHarness, onInstallProgress } from '../harness/install/installer'
import { availableVersions, latestVersion } from '../harness/install/upstream'
import { harnessManifest } from '../harness/manifests'
import {
  bundledHarnessVersion,
  harnessAvailable,
  invalidateHarness,
  onHarnessChanged,
  resolveHarness
} from '../harness/resolve'
import {
  HARNESS_VERSION_RE,
  harnessSelection,
  loadHarnessesConfig,
  saveHarnessesConfig
} from '../harness/selection-store'
import { LAST_USED_FILE, installDir, installedVersions, readInstallRecord } from '../harness/store'
import { reclassifyInstall, resolveSystemInstall } from '../harness/system-source'
import { versionAccepted } from '../harness/version-gate'
import type { CommandRegistration } from './command-registry'

/** The channels declared here; `registerSessionIpc` unbinds them before re-registering. */
export const HARNESS_CHANNELS = [
  'harness:state',
  'harness:versions',
  'harness:set-selection',
  'harness:install',
  'harness:install-cancel',
  'harness:detect'
] as const

const LABELS: Record<HarnessId, string> = {
  claude: 'Claude Code',
  opencode: 'opencode',
  pi: 'pi',
  codex: 'Codex'
}

// ── State snapshot ────────────────────────────────────────────────────────────

function installView(id: HarnessId, raw: DetectedInstall): HarnessSystemInstallView {
  const install = reclassifyInstall(id, raw)
  const node = install.node
  // Picked field by field: the launch, its environment and the fingerprints
  // stay in main.
  return {
    displayPath: install.displayPath,
    version: install.version,
    verdict: install.verdict,
    ...(install.reason !== undefined ? { reason: install.reason } : {}),
    installKind: install.installKind,
    ...(node
      ? {
          node:
            'kind' in node
              ? { kind: 'electron' as const, version: node.version }
              : { kind: 'node' as const, path: node.path, version: node.version }
        }
      : {})
  }
}

function systemView(id: HarnessId, detection: HarnessDetection | undefined): HarnessSystemView {
  const outcome = resolveSystemInstall(id, detection, { electron: currentElectron() })
  return {
    detectedAt: detection?.detectedAt ?? null,
    installs: (detection?.installs ?? []).map((install) => installView(id, install)),
    choice:
      outcome.kind === 'ok'
        ? { kind: 'ok', displayPath: outcome.install.displayPath, version: outcome.version }
        : { kind: 'fallback', reason: outcome.reason }
  }
}

function lastUsedAt(id: HarnessId, version: string): string | undefined {
  try {
    return fs.statSync(path.join(installDir(id, version), LAST_USED_FILE)).mtime.toISOString()
  } catch {
    return undefined
  }
}

function managedView(id: HarnessId): HarnessManagedVersionView[] {
  const out: HarnessManagedVersionView[] = []
  for (const version of installedVersions(id)) {
    const record = readInstallRecord(id, version)
    if (!record) continue
    const lastUsed = lastUsedAt(id, version)
    out.push({
      version,
      verified: record.verified,
      installedAt: record.installedAt,
      ...(lastUsed ? { lastUsed } : {})
    })
  }
  return out
}

function stateEntry(
  id: HarnessId,
  config: HarnessesConfig,
  detection: HarnessDetection | undefined
): HarnessStateEntry {
  const { tested, floor, ceiling } = harnessManifest(id)
  const resolved = resolveHarness(id)
  return {
    id,
    manifest: { tested, floor, ceiling },
    selection: { ...harnessSelection(id, config) },
    resolved: {
      source: resolved.source,
      version: resolved.version,
      path: resolved.path,
      ...(resolved.displayPath !== undefined ? { displayPath: resolved.displayPath } : {}),
      ...(resolved.reason !== undefined ? { reason: resolved.reason } : {}),
      available: harnessAvailable(id)
    },
    system: systemView(id, detection),
    managed: managedView(id),
    ...(id === 'claude' ? { bundledVersion: bundledHarnessVersion('claude') } : {})
  }
}

// ── Argument validation ───────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function harnessIdOf(payload: unknown): HarnessId {
  const id = isRecord(payload) ? payload.id : undefined
  if (!isHarnessId(id)) throw new Error(`Unknown harness: ${JSON.stringify(id)}`)
  return id
}

/** `tested`, `latest` or an exact version; anything else is refused before it reaches a path. */
function versionArg(payload: unknown): string {
  const version = isRecord(payload) ? payload.version : undefined
  if (
    typeof version !== 'string' ||
    !(version === 'tested' || version === 'latest' || HARNESS_VERSION_RE.test(version))
  ) {
    throw new Error(`Invalid harness version: ${JSON.stringify(version)}`)
  }
  return version
}

/** Why `version` cannot be the ClaudeUI choice for `id`, or null when it can. */
function managedVersionProblem(id: HarnessId, version: unknown): string | null {
  const label = LABELS[id]
  if (typeof version !== 'string') return `Invalid ${label} version`
  if (id === 'codex' && version !== 'tested') {
    return `ClaudeUI's Codex is locked to ${harnessManifest('codex').tested}`
  }
  if (version === 'tested' || version === 'latest') return null
  if (HARNESS_VERSION_RE.test(version) && versionAccepted(id, version)) return null
  const { floor, ceiling } = harnessManifest(id)
  return `${label} ${version} is not supported: ClaudeUI runs ${floor} and later, before ${ceiling}`
}

/**
 * A selection `id` can take, normalised, or a throw that says why not:
 *
 * - Claude Code offers `bundled | system` and no version choice;
 * - opencode, pi and Codex offer `managed | system`. Their `version` is the
 *   ClaudeUI choice: `tested`, `latest` or an exact version in [floor,
 *   ceiling), and Codex's copy is locked to its pin (`tested` only). It is kept
 *   while System is selected, so switching back restores it (ADR-082 §2): a
 *   selection that names no version keeps `previous`'s when that one is still
 *   valid, and a `managed` one with neither is `tested`.
 */
export function validateHarnessSelection(
  id: HarnessId,
  raw: unknown,
  previous?: HarnessSelection
): HarnessSelection {
  if (!isRecord(raw)) throw new Error('A harness selection must be an object')
  const label = LABELS[id]
  const sources = id === 'claude' ? ['bundled', 'system'] : ['managed', 'system']
  const source = raw.source
  if (typeof source !== 'string' || !sources.includes(source)) {
    throw new Error(`${label} runs from ${sources.join(' or ')}, not ${JSON.stringify(source)}`)
  }
  if (id === 'claude') {
    if (raw.version !== undefined) throw new Error('Claude Code has no version choice')
    return { source: source as HarnessSelection['source'] }
  }
  let version = raw.version
  if (version === undefined) {
    const kept = previous?.version
    version = kept !== undefined && managedVersionProblem(id, kept) === null ? kept : undefined
  } else {
    const problem = managedVersionProblem(id, version)
    if (problem) throw new Error(problem)
  }
  if (version === undefined && source === 'managed') version = 'tested'
  return version === undefined
    ? { source: source as HarnessSelection['source'] }
    : { source: source as HarnessSelection['source'], version: version as string }
}

function harnessIdsArg(payload: unknown): HarnessId[] | undefined {
  const ids = isRecord(payload) ? payload.ids : undefined
  if (ids === undefined) return undefined
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every(isHarnessId)) {
    throw new Error(`Invalid harness list: ${JSON.stringify(ids)}`)
  }
  return [...new Set(ids)]
}

// ── Installs in flight ────────────────────────────────────────────────────────

/**
 * One `AbortController` per `harness:install` request in flight, grouped by
 * harness and exact version, so `harness:install-cancel` can abort it: an
 * `AbortSignal` cannot cross IPC. Shared by both transports (a phone can cancel
 * an install the desktop started, which is what the installer's shared job
 * means anyway). The installer stops the download once every request that
 * joined it has aborted.
 */
export class InstallRequests {
  private readonly byKey = new Map<string, Set<AbortController>>()

  private static key(id: HarnessId, version: string): string {
    return `${id}@${version}`
  }

  add(id: HarnessId, version: string): AbortController {
    const controller = new AbortController()
    const key = InstallRequests.key(id, version)
    let set = this.byKey.get(key)
    if (!set) {
      set = new Set()
      this.byKey.set(key, set)
    }
    set.add(controller)
    return controller
  }

  remove(id: HarnessId, version: string, controller: AbortController): void {
    const key = InstallRequests.key(id, version)
    const set = this.byKey.get(key)
    if (!set) return
    set.delete(controller)
    if (set.size === 0) this.byKey.delete(key)
  }

  /** Abort every request for `id@version`. Returns how many there were. */
  abort(id: HarnessId, version: string): number {
    const key = InstallRequests.key(id, version)
    const set = this.byKey.get(key)
    if (!set) return 0
    this.byKey.delete(key)
    for (const controller of set) controller.abort()
    return set.size
  }
}

const installRequests = new InstallRequests()

// ── Declarations ──────────────────────────────────────────────────────────────

/** The work these commands hand off; injected in tests, the app's singletons otherwise. */
export interface HarnessCommandDeps {
  install?: (
    id: HarnessId,
    version: string,
    opts: { signal: AbortSignal }
  ) => Promise<HarnessInstallResult>
  activeInstalls?: () => HarnessInstallProgress[]
  latestVersion?: (id: HarnessId) => Promise<string | null>
  availableVersions?: (id: HarnessId) => Promise<string[]>
  requestDetection?: (ids: readonly HarnessId[] | undefined, reason: 'user') => Promise<void>
  detectionStatus?: () => HarnessDetectionStatus
  requests?: InstallRequests
}

/** `harness:state`: filesystem reads only (the store, the two JSON files, a stat per install). */
export function harnessStateSnapshot(deps: HarnessCommandDeps = {}): HarnessStateSnapshot {
  const config = loadHarnessesConfig()
  const cache = loadDetectionCache()
  const harnesses = {} as Record<HarnessId, HarnessStateEntry>
  for (const id of HARNESS_IDS) harnesses[id] = stateEntry(id, config, cache[id])
  return {
    harnesses,
    detection: { ...(deps.detectionStatus ?? detectionStatus)() },
    installs: (deps.activeInstalls ?? activeInstalls)()
  }
}

export function harnessCommands(
  deps: HarnessCommandDeps = {}
): Array<Omit<CommandRegistration, 'transport'>> {
  const install = deps.install ?? installHarness
  const latest = deps.latestVersion ?? latestVersion
  const available = deps.availableVersions ?? ((id: HarnessId) => availableVersions(id))
  const detect =
    deps.requestDetection ??
    ((ids: readonly HarnessId[] | undefined, reason: 'user') => requestDetection(ids, reason))
  const requests = deps.requests ?? installRequests

  /** `tested` / `latest` as the exact version the installer will act on, when it can be told. */
  async function exactVersion(id: HarnessId, version: string): Promise<string> {
    if (version === 'tested') return harnessManifest(id).tested
    // The installer asks the same (cached) upstream answer, so the two agree.
    if (version === 'latest') return (await latest(id)) ?? version
    return version
  }

  return [
    {
      channel: 'harness:state',
      capability: 'config',
      kind: 'query',
      handler: async (): Promise<HarnessStateSnapshot> => harnessStateSnapshot(deps)
    },
    {
      channel: 'harness:versions',
      capability: 'config',
      kind: 'query',
      handler: async (payload?: unknown): Promise<HarnessVersionsResult> => {
        const id = harnessIdOf(payload)
        if (id === 'claude') {
          return { status: 'unsupported', id, reason: 'Claude Code has no ClaudeUI-managed copy' }
        }
        const [newest, versions] = await Promise.all([latest(id), available(id)])
        return { status: 'ok', id, latest: newest, available: versions }
      }
    },
    {
      channel: 'harness:set-selection',
      capability: 'admin',
      kind: 'command',
      handler: async (payload?: unknown): Promise<HarnessStateEntry> => {
        const id = harnessIdOf(payload)
        const selection = validateHarnessSelection(
          id,
          isRecord(payload) ? payload.selection : null,
          harnessSelection(id)
        )
        saveHarnessesConfig({ selections: { [id]: selection } })
        // A running session keeps its binary (ADR-079's respawn rule); the next
        // spawn resolves afresh.
        invalidateHarness(id)
        return stateEntry(id, loadHarnessesConfig(), loadDetectionCache()[id])
      }
    },
    {
      channel: 'harness:install',
      capability: 'admin',
      kind: 'command',
      handler: async (payload?: unknown): Promise<HarnessInstallResult> => {
        const id = harnessIdOf(payload)
        const version = await exactVersion(id, versionArg(payload))
        const controller = requests.add(id, version)
        try {
          return await install(id, version, { signal: controller.signal })
        } finally {
          requests.remove(id, version, controller)
        }
      }
    },
    {
      channel: 'harness:install-cancel',
      capability: 'admin',
      kind: 'command',
      handler: async (payload?: unknown): Promise<HarnessInstallCancelResult> => {
        const id = harnessIdOf(payload)
        const version = await exactVersion(id, versionArg(payload))
        const aborted = requests.abort(id, version)
        return { status: aborted > 0 ? 'cancelled' : 'not-running', id, version }
      }
    },
    {
      channel: 'harness:detect',
      capability: 'admin',
      kind: 'command',
      handler: async (payload?: unknown): Promise<HarnessStateSnapshot> => {
        // A user request runs even when background detection is disabled.
        await detect(harnessIdsArg(payload), 'user')
        return harnessStateSnapshot(deps)
      }
    }
  ]
}

// ── Events ────────────────────────────────────────────────────────────────────

export type HarnessEventEmitter = (channel: string, args: unknown[]) => void

let stopEvents: (() => void) | null = null

/**
 * Forward the resolver's invalidations and the installer's progress to the
 * sync funnel (`emitEvent`), from `startCoreServices`. A second call replaces
 * the first (a test that boots core twice), so each event goes out once.
 * Returns the unsubscribe function.
 */
export function startHarnessEvents(emit: HarnessEventEmitter): () => void {
  stopEvents?.()
  const send = (channel: string, args: unknown[]): void => {
    try {
      emit(channel, args)
    } catch {
      // No subscriber can take it (shutdown): the next harness:state read is the truth.
    }
  }
  const offChanged = onHarnessChanged((id) => send('harness:changed', [{ id }]))
  const offProgress = onInstallProgress((progress) => send('harness:install-progress', [progress]))
  const stop = (): void => {
    offChanged()
    offProgress()
    if (stopEvents === stop) stopEvents = null
  }
  stopEvents = stop
  return stop
}
