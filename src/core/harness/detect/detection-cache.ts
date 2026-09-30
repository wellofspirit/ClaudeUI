/**
 * `~/.claude/ui/harness-detection.json`: the last detection per harness, so a
 * spawn never waits on a `--version` probe (ADR-082 §3; the resolver reads it
 * in arc 2, S2c).
 *
 * Main-owned, like `harnesses.json` (`../selection-store.ts`): written
 * atomically with mode 0600, per harness (a save replaces the harnesses it is
 * given and keeps the rest). Reads never throw: a missing, unreadable or
 * malformed file, or a malformed entry, reads as nothing cached.
 *
 * A cached install is trusted only while its fingerprint holds
 * (`isFingerprintFresh`: one `stat` of the file that runs, matching size and
 * mtime), so an upgrade or removal behind the cache is noticed without a probe.
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

function sanitizeLaunch(value: unknown): DetectedInstall['launch'] | undefined {
  if (value === null) return null
  if (!isRecord(value) || typeof value.command !== 'string' || !value.command) return undefined
  if (!Array.isArray(value.args) || !value.args.every((a) => typeof a === 'string'))
    return undefined
  if (value.env !== undefined && !isStringRecord(value.env)) return undefined
  return {
    command: value.command,
    args: [...(value.args as string[])],
    ...(value.env ? { env: { ...(value.env as Record<string, string>) } } : {})
  }
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
  if (
    !isRecord(fingerprint) ||
    typeof fingerprint.path !== 'string' ||
    typeof fingerprint.size !== 'number' ||
    typeof fingerprint.mtimeMs !== 'number'
  ) {
    return null
  }
  const launch = sanitizeLaunch(value.launch)
  if (launch === undefined) return null
  const node = value.node === undefined ? undefined : sanitizeNode(value.node)
  if (node === null) return null
  return {
    id,
    displayPath,
    realPath,
    launch,
    installKind: installKind as HarnessInstallKind,
    version,
    verdict: verdict as DetectedVerdict,
    ...(reason !== undefined ? { reason } : {}),
    fingerprint: { path: fingerprint.path, size: fingerprint.size, mtimeMs: fingerprint.mtimeMs },
    ...(node ? { node } : {})
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

/** Is the file that runs still the one detection saw (same size and mtime)? */
export function isFingerprintFresh(install: Pick<DetectedInstall, 'fingerprint'>): boolean {
  try {
    const st = fs.statSync(install.fingerprint.path)
    return st.size === install.fingerprint.size && st.mtimeMs === install.fingerprint.mtimeMs
  } catch {
    return false
  }
}
