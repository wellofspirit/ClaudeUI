/**
 * The client half of the `SyncStats` measurement: what a `sync-full` cost the
 * RECEIVING side, relayed into the host's log so it lands beside the host's own
 * lines: the desktop renderer through the existing relay (`window.api.logRelay`),
 * the web client through the remote `sync:report-timing` query (its `logRelay` only
 * reaches the browser console), which the host formats with the same function.
 *
 * Both clients report once per `sync-full`, at `info` (so the same
 * `CLAUDE_UI_LOG=SyncStats:info` enablement shows it). The desktop relay escalates
 * to `warn` when the total passes {@link SYNC_TIMING_WARN_MS}; the host's web path
 * never does (a client-controlled number must not choose the level). Pure and Electron-free: the
 * caller hands in the relay, which keeps it testable and keeps `window` out of the
 * shared tree. Numbers only — never snapshot content.
 */

import { SYNC_STATS_SOURCE } from './snapshot-stats'

/** A client whose full sync took longer than this is logged at `warn`. */
export const SYNC_TIMING_WARN_MS = 2000

export interface SyncTiming {
  transport: 'web' | 'desktop'
  /** Raw frame length as received (chars; base64 length under E2E). Web only — a port post has no frame. */
  frameChars?: number
  /** Decrypt + parse of the frame, ms. Web only. */
  decodeMs?: number
  /** `sync` sent → `sync-full` frame received, ms: host build + encode + transfer. Absent when no `sync` was timed. */
  syncToFrameMs?: number
  /** Apply: `hydrateReplica` (web: including the dynamic-import wait) to its return, ms. */
  hydrateMs: number
}

type Relay = (level: string, source: string, message: string) => void

/** What the client spent end to end on this sync: wait + decode + hydrate. */
export function syncTimingTotalMs(t: SyncTiming): number {
  return (t.syncToFrameMs ?? 0) + (t.decodeMs ?? 0) + t.hydrateMs
}

/** One timing line: the level it is logged at and its text. Numbers only. */
export interface SyncTimingLine {
  level: 'info' | 'warn'
  message: string
}

/**
 * Format the line for one `sync-full` timing. Shared by the renderer relay below
 * and the HOST, which formats the web client's report itself (`sync:report-timing`)
 * so both transports' lines have exactly one shape and no client string reaches a log.
 */
export function formatSyncTiming(t: SyncTiming): SyncTimingLine {
  const total = syncTimingTotalMs(t)
  const fields = [`transport=${t.transport}`]
  if (t.frameChars !== undefined) fields.push(`frameChars=${t.frameChars}`)
  if (t.decodeMs !== undefined) fields.push(`decodeMs=${t.decodeMs.toFixed(1)}`)
  if (t.syncToFrameMs !== undefined) fields.push(`syncToFrameMs=${t.syncToFrameMs.toFixed(1)}`)
  fields.push(`hydrateMs=${t.hydrateMs.toFixed(1)}`, `totalMs=${total.toFixed(1)}`)
  const slow = total > SYNC_TIMING_WARN_MS
  return {
    level: slow ? 'warn' : 'info',
    message: `${slow ? 'slow ' : ''}client sync-full applied: ${fields.join(' ')}`
  }
}

/** Relay one `sync-full` timing line. A missing relay (no host to log to) is a no-op. */
export function relaySyncTiming(relay: Relay | undefined, t: SyncTiming): void {
  if (!relay) return
  const { level, message } = formatSyncTiming(t)
  relay(level, SYNC_STATS_SOURCE, message)
}

/**
 * The web client's report to the host (`sync:report-timing`): the one remote
 * channel through which a browser's timing reaches the host log, because a web
 * `logRelay` has no host to write to. Numbers only, by construction; the host
 * re-validates every field ({@link parseSyncTimingReport} in
 * `core/services/sync-timing-report.ts`) and formats the line itself.
 */
export const SYNC_REPORT_TIMING_CHANNEL = 'sync:report-timing'

export interface SyncTimingReport {
  /** Raw frame length as received (chars; the base64 length under E2E, where it is also the byte count). */
  frameBytes: number
  decodeMs: number
  /** Absent when no `sync` was timed (the host then omits the field from its line). */
  syncToFrameMs?: number
  hydrateMs: number
}

/** The report a web client sends for one full sync; `null` when the frame length was not captured. */
export function toSyncTimingReport(t: SyncTiming): SyncTimingReport | null {
  if (t.frameChars === undefined || t.decodeMs === undefined) return null
  return {
    frameBytes: t.frameChars,
    decodeMs: t.decodeMs,
    ...(t.syncToFrameMs !== undefined ? { syncToFrameMs: t.syncToFrameMs } : {}),
    hydrateMs: t.hydrateMs
  }
}
