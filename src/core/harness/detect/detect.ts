/**
 * System detection (ADR-082 §3): find every install of a harness on this
 * machine, work out what ClaudeUI would spawn for it, ask it its version in
 * isolation, and label it.
 *
 *   candidates (`candidates.ts`)
 *     → resolve, executing nothing (`resolve-install.ts`)
 *     → de-duplicate by the file that runs (the first sighting keeps its
 *       display path, so a PATH hit beats the package directory behind it)
 *     → pi: choose its node (`node-choice.ts`)
 *     → `--version`, isolated (`probe.ts`), at most `concurrency` at once
 *     → classify: `classifyVersion` (`../version-gate.ts`), plus
 *       `unsupported` (cannot be run) and `failed` (the probe did not answer
 *       with a version). A Codex without its `codex-code-mode-host`
 *       (`codexHostFor`) is `unsupported` even at a good version.
 *
 * The scheduler (`./scheduler.ts`) runs it in the background and caches the
 * result (`./detection-cache.ts`), which the resolver reads for a System
 * selection; nothing on a spawn path waits on it. Never throws.
 */
import * as os from 'node:os'
import * as path from 'node:path'
import type {
  DetectedInstall,
  DetectedNode,
  HarnessDetection,
  HarnessId,
  HarnessLaunch
} from '../../../shared/harness-types'
import { HARNESS_IDS } from '../../../shared/harness-types'
import { ELECTRON_NODE_ENV, nodeScriptLaunch } from '../launch'
import { harnessManifest } from '../manifests'
import { codexHostFor } from '../resolve'
import { classifyVersion } from '../version-gate'
import { harnessCandidates } from './candidates'
import { fingerprintOf } from './fs-util'
import { chooseNode, currentElectron } from './node-choice'
import { searchPathEntries } from './path-entries'
import { probeVersion } from './probe'
import { resolveCandidate, type InstallResolution } from './resolve-install'
import type { RunFn, SpawnFn } from './run'

export { bestSystemInstall } from './detection-cache'

export interface DetectDeps {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  arch?: string
  homedir?: string
  /** The helper runner for `reg.exe`, the login shell and `node --version`. */
  run?: RunFn
  /** The runner for the harness `--version` probes (default: the real one over `spawn`). */
  probeRun?: RunFn
  /** The spawn behind the default probe runner. */
  spawn?: SpawnFn
  /** The directories to search; skips the PATH and fresh-PATH reads when given. */
  pathEntries?: readonly string[]
  /** Probes at once (default 3). */
  concurrency?: number
  /** Electron's executable and Node version; defaults to this process's, null outside Electron. */
  electron?: { execPath: string; nodeVersion: string } | null
  /** `node --version` cache (default: the module-level one). */
  nodeCache?: Map<string, string | null>
  /** Where probe directories are created (default `os.tmpdir()`). */
  tmpdir?: string
  now?: () => Date
}

const LABELS: Record<HarnessId, string> = {
  claude: 'Claude Code',
  opencode: 'opencode',
  pi: 'pi',
  codex: 'Codex'
}

interface Context {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  arch: string
  homedir: string
  pathEntries: readonly string[]
  deps: DetectDeps
  limit: <T>(task: () => Promise<T>) => Promise<T>
}

/** A limiter: at most `n` tasks run at once. */
function limiter(n: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0
  const queue: (() => void)[] = []
  const next = (): void => {
    active--
    queue.shift()?.()
  }
  return <T>(task: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      const start = (): void => {
        active++
        task().then(resolve, reject).finally(next)
      }
      if (active < n) start()
      else queue.push(start)
    })
}

async function prepare(deps: DetectDeps): Promise<Context> {
  const env = deps.env ?? process.env
  const platform = deps.platform ?? process.platform
  const pathEntries =
    deps.pathEntries ??
    (await searchPathEntries({ env, platform, ...(deps.run ? { run: deps.run } : {}) }))
  return {
    env,
    platform,
    arch: deps.arch ?? process.arch,
    homedir: deps.homedir ?? os.homedir(),
    pathEntries,
    deps,
    limit: limiter(Math.max(1, deps.concurrency ?? 3))
  }
}

function key(p: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? p.toLowerCase() : p
}

function versionReason(
  id: HarnessId,
  version: string,
  verdict: DetectedInstall['verdict']
): string | undefined {
  const { tested, floor, ceiling } = harnessManifest(id)
  const label = LABELS[id]
  switch (verdict) {
    case 'too-old':
      return `${label} ${version} is older than ${floor}, the oldest ClaudeUI supports`
    case 'incompatible':
      return `${label} ${version} is not supported: ClaudeUI needs a version from ${floor} up to, not including, ${ceiling}`
    case 'untested':
      return `ClaudeUI was tested with ${label} ${tested}`
    default:
      return undefined
  }
}

async function finish(r: InstallResolution, ctx: Context): Promise<DetectedInstall> {
  const { deps } = ctx
  const base = {
    id: r.id,
    displayPath: r.displayPath,
    realPath: r.realPath,
    installKind: r.installKind,
    fingerprint: fingerprintOf(r.realPath)
  }
  if (r.status === 'unsupported') {
    return { ...base, launch: null, version: null, verdict: 'unsupported', reason: r.reason }
  }

  let launch: HarnessLaunch | null = r.launch
  let node: DetectedNode | undefined
  let nodeFingerprint: DetectedInstall['nodeFingerprint']
  if (r.nodeFor) {
    const choice = await chooseNode(r.nodeFor.preferredNodes, {
      env: ctx.env,
      platform: ctx.platform,
      pathEntries: ctx.pathEntries,
      electron: deps.electron === undefined ? currentElectron() : deps.electron,
      ...(deps.run ? { run: deps.run } : {}),
      ...(deps.nodeCache ? { cache: deps.nodeCache } : {})
    })
    if (choice.kind === 'none') {
      return { ...base, launch: null, version: null, verdict: 'unsupported', reason: choice.reason }
    }
    if (choice.kind === 'electron') {
      // No `pathPrepend`: the launcher's own node is not the one that runs.
      launch = nodeScriptLaunch(choice.path, r.nodeFor.script, {
        ...r.nodeFor.env,
        ...ELECTRON_NODE_ENV
      })
      node = { kind: 'electron', version: choice.version }
    } else {
      // The launcher's node directory goes first on PATH only when that node
      // is the one chosen; a too-old `pi-node` must not shadow the real one.
      const nodeDir = key(path.dirname(choice.path), ctx.platform)
      const prepend = (r.nodeFor.pathPrepend ?? []).filter(
        (dir) => key(dir, ctx.platform) === nodeDir
      )
      launch = nodeScriptLaunch(choice.path, r.nodeFor.script, r.nodeFor.env, prepend)
      node = { path: choice.path, version: choice.version }
      nodeFingerprint = fingerprintOf(choice.path)
    }
  }
  if (!launch) {
    return {
      ...base,
      launch: null,
      version: null,
      verdict: 'unsupported',
      reason: 'Nothing to run'
    }
  }
  const withNode = {
    ...(node ? { node } : {}),
    ...(nodeFingerprint ? { nodeFingerprint } : {})
  }

  const probe = await probeVersion(r.id, launch, {
    env: ctx.env,
    platform: ctx.platform,
    ...(deps.probeRun ? { run: deps.probeRun } : {}),
    ...(deps.spawn ? { spawn: deps.spawn } : {}),
    ...(deps.tmpdir ? { tmpdir: deps.tmpdir } : {})
  })
  if (probe.status === 'failed') {
    return { ...base, ...withNode, launch, version: null, verdict: 'failed', reason: probe.reason }
  }
  if (probe.status === 'not-a-version') {
    return {
      ...base,
      ...withNode,
      launch,
      version: null,
      verdict: 'incompatible',
      reason: `--version printed "${probe.output}", which is not a version`
    }
  }

  const version = probe.version
  const verdict = classifyVersion(r.id, version)
  if (
    r.id === 'codex' &&
    (verdict === 'tested' || verdict === 'untested') &&
    codexHostFor(r.realPath) === null
  ) {
    return {
      ...base,
      ...withNode,
      launch,
      version,
      verdict: 'unsupported',
      reason: 'codex-code-mode-host not found beside it'
    }
  }
  const reason = versionReason(r.id, version, verdict)
  return { ...base, ...withNode, launch, version, verdict, ...(reason ? { reason } : {}) }
}

async function detectWith(id: HarnessId, ctx: Context): Promise<HarnessDetection> {
  const candidates = harnessCandidates(id, {
    env: ctx.env,
    platform: ctx.platform,
    arch: ctx.arch,
    homedir: ctx.homedir,
    pathEntries: ctx.pathEntries
  })
  const resolveDeps = { env: ctx.env, platform: ctx.platform, arch: ctx.arch, homedir: ctx.homedir }
  const seen = new Set<string>()
  const resolutions: InstallResolution[] = []
  for (const candidate of candidates) {
    const r = resolveCandidate(candidate, resolveDeps)
    if (!r) continue
    const k = key(r.realPath, ctx.platform)
    if (seen.has(k)) continue
    seen.add(k)
    resolutions.push(r)
  }
  const installs = await Promise.all(
    resolutions.map((r) =>
      ctx.limit(() =>
        finish(r, ctx).catch((err: unknown): DetectedInstall => ({
          id: r.id,
          displayPath: r.displayPath,
          realPath: r.realPath,
          installKind: r.installKind,
          fingerprint: fingerprintOf(r.realPath),
          launch: null,
          version: null,
          verdict: 'failed',
          reason: err instanceof Error ? err.message : String(err)
        }))
      )
    )
  )
  return { id, detectedAt: (ctx.deps.now?.() ?? new Date()).toISOString(), installs }
}

/** Every install of `id` on this machine, labelled. Never rejects. */
export async function detectHarness(
  id: HarnessId,
  deps: DetectDeps = {}
): Promise<HarnessDetection> {
  return detectWith(id, await prepare(deps))
}

/**
 * Every install of each harness in `ids` (all by default), sharing one PATH
 * read and one probe limit. Never rejects.
 */
export async function detectHarnesses(
  ids: readonly HarnessId[] = HARNESS_IDS,
  deps: DetectDeps = {}
): Promise<HarnessDetection[]> {
  const ctx = await prepare(deps)
  return Promise.all(ids.map((id) => detectWith(id, ctx)))
}
