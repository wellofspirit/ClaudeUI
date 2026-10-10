/**
 * `~/.claude/ui/harness-detection.json`: the last detection per harness, so a
 * spawn never waits on a `--version` probe (ADR-082 §3). The resolver reads it
 * for a System selection (`../system-source.ts`); the background scheduler
 * (`./scheduler.ts`) writes it.
 *
 * Main-owned, like `harnesses.json` (`../selection-store.ts`): written
 * atomically with mode 0600, per harness (a save replaces the harnesses it is
 * given and keeps the rest). Reads never throw: a missing, unreadable or
 * malformed file, or a malformed entry, reads as nothing cached.
 *
 * A cached install is trusted only while its fingerprint holds
 * (`isFingerprintFresh`: one `stat` of the file that runs, and of pi's node,
 * matching size and mtime), so an upgrade or removal behind the cache is
 * noticed without a probe.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type {
  DetectedInstall,
  DetectedVerdict,
  HarnessDetection,
  HarnessId,
  HarnessInstallKind
} from '../../../shared/harness-types'
import { isHarnessId } from '../../../shared/harness-types'
import { readJsonFileForWrite, writeFileAtomicSync } from '../../services/write-json-atomic'
import { compareVersions } from '../store'

/** Resolved at call time so a redirected home (tests) is honoured. */
export function harnessDetectionPath(): string {
  return path.join(os.homedir(), '.claude', 'ui', 'harness-detection.json')
}

export type DetectionCache = Partial<Record<HarnessId, HarnessDetection>>

const VERDICTS: ReadonlySet<string> = new Set<DetectedVerdict>([
  'tested',
  'untested',
  'too-old',
  'incompatible',
  'unsupported',
  'failed'
])

const KINDS: ReadonlySet<string> = new Set<HarnessInstallKind>([
  'npm',
  'pnpm',
  'bun',
  'native-installer',
  'homebrew',
  'scoop',
  'winget',
  'standalone',
  'pi-managed',
  'path'
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((v) => typeof v === 'string')
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((a) => typeof a === 'string')
}

function sanitizeLaunch(value: unknown): DetectedInstall['launch'] | undefined {
  if (value === null) return null
  if (!isRecord(value) || typeof value.command !== 'string' || !value.command) return undefined
  if (!isStringArray(value.args)) return undefined
  if (value.env !== undefined && !isStringRecord(value.env)) return undefined
  if (value.pathPrepend !== undefined && !isStringArray(value.pathPrepend)) return undefined
  return {
    command: value.command,
    args: [...value.args],
    ...(value.env ? { env: { ...(value.env as Record<string, string>) } } : {}),
    ...(value.pathPrepend ? { pathPrepend: [...value.pathPrepend] } : {})
  }
}

type Fingerprint = DetectedInstall['fingerprint']

function sanitizeFingerprint(value: unknown): Fingerprint | null {
  if (
    !isRecord(value) ||
    typeof value.path !== 'string' ||
    typeof value.size !== 'number' ||
    typeof value.mtimeMs !== 'number'
  ) {
    return null
  }
  return { path: value.path, size: value.size, mtimeMs: value.mtimeMs }
}

function sanitizeNode(value: unknown): DetectedInstall['node'] | null {
  if (!isRecord(value) || typeof value.version !== 'string') return null
  if (value.kind === 'electron') return { kind: 'electron', version: value.version }
  return typeof value.path === 'string' ? { path: value.path, version: value.version } : null
}

function sanitizeInstall(id: HarnessId, value: unknown): DetectedInstall | null {
  if (!isRecord(value) || value.id !== id) return null
  const { displayPath, realPath, installKind, version, verdict, reason, fingerprint } = value
  if (typeof displayPath !== 'string' || typeof realPath !== 'string') return null
  if (typeof installKind !== 'string' || !KINDS.has(installKind)) return null
  if (typeof verdict !== 'string' || !VERDICTS.has(verdict)) return null
  if (version !== null && typeof version !== 'string') return null
  if (reason !== undefined && typeof reason !== 'string') return null
  const print = sanitizeFingerprint(fingerprint)
  if (!print) return null
  const launch = sanitizeLaunch(value.launch)
  if (launch === undefined) return null
  const node = value.node === undefined ? undefined : sanitizeNode(value.node)
  if (node === null) return null
  const nodePrint =
    value.nodeFingerprint === undefined ? undefined : sanitizeFingerprint(value.nodeFingerprint)
  if (nodePrint === null) return null
  return {
    id,
    displayPath,
    realPath,
    launch,
    installKind: installKind as HarnessInstallKind,
    version,
    verdict: verdict as DetectedVerdict,
    ...(reason !== undefined ? { reason } : {}),
    fingerprint: print,
    ...(node ? { node } : {}),
    ...(nodePrint ? { nodeFingerprint: nodePrint } : {})
  }
}

function sanitizeDetection(id: HarnessId, value: unknown): HarnessDetection | null {
  if (!isRecord(value) || value.id !== id || typeof value.detectedAt !== 'string') return null
  if (!Array.isArray(value.installs)) return null
  const installs: DetectedInstall[] = []
  for (const each of value.installs) {
    const install = sanitizeInstall(id, each)
    if (install) installs.push(install)
  }
  return { id, detectedAt: value.detectedAt, installs }
}

/** The cached detections, validated. Never throws. */
export function loadDetectionCache(file = harnessDetectionPath()): DetectionCache {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch {
    return {}
  }
  if (!isRecord(parsed) || !isRecord(parsed.detections)) return {}
  const out: DetectionCache = {}
  for (const [id, value] of Object.entries(parsed.detections)) {
    if (!isHarnessId(id)) continue
    const detection = sanitizeDetection(id, value)
    if (detection) out[id] = detection
  }
  return out
}

/**
 * Replace the cached detection of each harness in `detections`; the others
 * are kept. A present-but-unreadable file is backed up (by
 * `readJsonFileForWrite`) and replaced: this is a cache, rebuilt by the next
 * detection. Throws only when the write itself fails.
 */
export function saveDetectionCache(
  detections: readonly HarnessDetection[],
  file = harnessDetectionPath()
): void {
  let current: Record<string, unknown>
  try {
    current = readJsonFileForWrite(file)
  } catch {
    current = {}
  }
  const merged: Record<string, unknown> = isRecord(current.detections)
    ? { ...current.detections }
    : {}
  for (const detection of detections) merged[detection.id] = detection
  writeFileAtomicSync(file, JSON.stringify({ ...current, detections: merged }, null, 2) + '\n', {
    mode: 0o600,
    dirMode: 0o700
  })
}

function fresh(print: Fingerprint): boolean {
  try {
    const st = fs.statSync(print.path)
    return st.isFile() && st.size === print.size && st.mtimeMs === print.mtimeMs
  } catch {
    return false
  }
}

/**
 * Is the file that runs still the one detection saw (same size and mtime)?
 * For pi on a node from disk, that node too (`nodeFingerprint`).
 */
export function isFingerprintFresh(
  install: Pick<DetectedInstall, 'fingerprint' | 'nodeFingerprint'>
): boolean {
  if (!fresh(install.fingerprint)) return false
  return install.nodeFingerprint === undefined || fresh(install.nodeFingerprint)
}

/**
 * The install a System selection would run: the newest `tested` or `untested`
 * one (at the same version, `tested` wins), or null when none qualifies.
 */
export function bestSystemInstall(detection: HarnessDetection): DetectedInstall | null {
  let best: DetectedInstall | null = null
  for (const install of detection.installs) {
    if (install.verdict !== 'tested' && install.verdict !== 'untested') continue
    if (!install.version || !install.launch) continue
    if (!best) {
      best = install
      continue
    }
    const order = compareVersions(install.version, best.version as string)
    if (order > 0 || (order === 0 && install.verdict === 'tested' && best.verdict !== 'tested')) {
      best = install
    }
  }
  return best
}
