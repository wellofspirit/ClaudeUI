/**
 * Relaunch: the shapes every layer shares (the main-process service, the core
 * commands, the desktop renderer and the web client). Pure, no Node imports.
 *
 * A relaunch quits ClaudeUI and a detached helper starts it again; a `swap`
 * also replaces the install with a staged build and rolls back when the new
 * build never reports healthy. The helper writes one result per job.
 */

export type RelaunchMode = 'relaunch' | 'swap'

/**
 * - `ok`          relaunched and reported healthy
 * - `updated`     swapped and the new build reported healthy
 * - `no-health`   relaunched, but no healthy boot was seen in time
 * - `rolled-back` swapped, the new build never reported healthy, the old one is back
 * - `aborted`     ClaudeUI did not quit, or files stayed in use: nothing changed
 * - `failed`      a preflight or rename failed: the install was relaunched as it was
 * - `interrupted` the helper was stopped after the swap landed, before the new build
 *                 reported healthy; the next boot records it `updated` (recovered)
 *                 when the running version is the job's target
 */
export type RelaunchStatus =
  'ok' | 'updated' | 'no-health' | 'rolled-back' | 'aborted' | 'failed' | 'interrupted'

export const RELAUNCH_STATUSES: readonly RelaunchStatus[] = [
  'ok',
  'updated',
  'no-health',
  'rolled-back',
  'aborted',
  'failed',
  'interrupted'
]

/** `<t>.result.json`, written by the helper (or by boot reconciliation for a recovered job). */
export interface RelaunchResult {
  token: string
  status: RelaunchStatus
  mode: RelaunchMode
  fromVersion: string
  toVersion: string
  reason?: string
  /** Epoch ms. */
  at: number
  /** Set by boot reconciliation: the helper died, but the swap had landed. */
  recovered?: boolean
}

/**
 * `relaunch/health/<installKey>.json`: written by a healthy boot of an install
 * (a packaged desktop, or a server worker under its monitor) and awaited by
 * whatever restarted it: the desktop's helper, the server's monitor.
 */
export interface HealthRecord {
  version: string
  buildId: string | null
  pid: number
  /** Epoch ms. */
  at: number
}

/** `app:relaunch-availability`. */
export interface RelaunchAvailability {
  available: boolean
  reason?: string
}

/** `app:restart-impact`: what a restart interrupts. */
export interface RestartImpact {
  /** Sessions whose turn is running. */
  workingSessions: number
  /** Live terminals (every pty, desktop and remote). */
  terminals: number
  /** Connected remote clients. */
  remoteClients: number
}

/** `app:relaunch`. No `ok` key: the transports' `unwrap` would take it for their envelope. */
export interface RelaunchAccepted {
  accepted: true
}

/** The client's open session and unsent drafts, carried across a restart or a reload. */
export interface RestoreRecord {
  activeSessionId: string | null
  drafts: Record<string, string>
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Bounds on what a restore record may carry (it crosses IPC and sits on disk). */
export const RESTORE_MAX_DRAFTS = 200
export const RESTORE_MAX_DRAFT_CHARS = 200_000

/** A restore record from untrusted input, trimmed to sane bounds; null when unusable. */
export function parseRestoreRecord(raw: unknown): RestoreRecord | null {
  if (!isRecord(raw)) return null
  const active = raw.activeSessionId
  if (active !== null && active !== undefined && typeof active !== 'string') return null
  const drafts: Record<string, string> = {}
  if (isRecord(raw.drafts)) {
    for (const [id, text] of Object.entries(raw.drafts)) {
      if (Object.keys(drafts).length >= RESTORE_MAX_DRAFTS) break
      if (id === '' || typeof text !== 'string' || text === '') continue
      drafts[id] = text.slice(0, RESTORE_MAX_DRAFT_CHARS)
    }
  }
  return { activeSessionId: typeof active === 'string' && active !== '' ? active : null, drafts }
}

/** A result file from disk, or null when it is not one. */
export function parseRelaunchResult(raw: unknown): RelaunchResult | null {
  if (!isRecord(raw)) return null
  const { token, status, mode, fromVersion, toVersion, reason, at, recovered } = raw
  if (typeof token !== 'string' || !/^[0-9a-f]{32}$/.test(token)) return null
  if (!RELAUNCH_STATUSES.includes(status as RelaunchStatus)) return null
  if (mode !== 'relaunch' && mode !== 'swap') return null
  if (typeof fromVersion !== 'string' || typeof toVersion !== 'string') return null
  if (typeof at !== 'number' || !Number.isFinite(at)) return null
  const result: RelaunchResult = {
    token,
    status: status as RelaunchStatus,
    mode,
    fromVersion,
    toVersion,
    at
  }
  if (typeof reason === 'string' && reason !== '') result.reason = reason
  if (recovered === true) result.recovered = true
  return result
}

/** A health record from disk, or null when it is not one. */
export function parseHealthRecord(raw: unknown): HealthRecord | null {
  if (!isRecord(raw)) return null
  const { version, buildId, pid, at } = raw
  if (typeof version !== 'string' || version === '') return null
  if (buildId !== null && typeof buildId !== 'string') return null
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null
  if (typeof at !== 'number' || !Number.isFinite(at)) return null
  return { version, buildId, pid, at }
}
