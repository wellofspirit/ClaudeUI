/**
 * Host side of `sync:report-timing`: the web client's cost of one full sync,
 * written into the host log as a `SyncStats` line.
 *
 * A browser has no way into the host log (its `logRelay` is console-only), and
 * this is the one narrow door. It is deliberately a REPORT, not a log API:
 *
 *  - **Numbers only.** The argument is validated field by field and the HOST
 *    formats the line ({@link formatSyncTiming}), so no client-supplied string
 *    can reach the log — no injected newlines, no forged `SyncStats` host lines.
 *  - **Quiet refusal.** Anything malformed, or over the per-connection budget, is
 *    dropped with no log and no error: a refusal that logged would hand a client
 *    a way to fill the log, and one that answered would be an oracle.
 *  - **Bounded.** {@link MAX_REPORTS_PER_MINUTE} per connection, and values are
 *    clamped, so a hostile client can neither flood the log nor print absurd numbers.
 *
 * Declared `chat` / `query` (remote-handlers.ts): every connection that can sync
 * holds `chat`, and a query is not audited — a diagnostic must not write audit rows.
 */

import { logger } from './logger'
import { SYNC_STATS_SOURCE } from '../shared/sync/snapshot-stats'
import { formatSyncTiming, type SyncTimingReport } from '../shared/sync/sync-timing'

/** Reports one connection may make per {@link WINDOW_MS}; a sync-full is rare, so 6 is generous. */
export const MAX_REPORTS_PER_MINUTE = 6
const WINDOW_MS = 60_000
/** A frame is never larger than the largest string a WebSocket will carry (2^31). */
export const MAX_FRAME_BYTES = 2 ** 31
/** No timing is believable past ten minutes; a larger value is clamped, not trusted. */
export const MAX_REPORT_MS = 10 * 60 * 1000
/**
 * Defence in depth for the per-connection map: entries normally go with the socket
 * ({@link SyncTimingReports.releaseConnection}), this bounds it if a close path is ever missed.
 */
const MAX_TRACKED_CONNECTIONS = 1024

/** A finite number ≥ 0, clamped to `max`; anything else is not a number we accept. */
function clampedNumber(value: unknown, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return Math.min(value, max)
}

/**
 * Validate one client report. A plain object whose `frameBytes`, `decodeMs` and
 * `hydrateMs` are finite numbers ≥ 0 (and `syncToFrameMs` too when present — a
 * client that never timed its `sync` omits it); unknown keys are ignored. Returns
 * the clamped numbers, or `null` for anything else.
 */
export function parseSyncTimingReport(raw: unknown): SyncTimingReport | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const proto = Object.getPrototypeOf(raw)
  if (proto !== Object.prototype && proto !== null) return null
  const fields = raw as Record<string, unknown>

  const frameBytes = clampedNumber(fields.frameBytes, MAX_FRAME_BYTES)
  const decodeMs = clampedNumber(fields.decodeMs, MAX_REPORT_MS)
  const hydrateMs = clampedNumber(fields.hydrateMs, MAX_REPORT_MS)
  if (frameBytes === null || decodeMs === null || hydrateMs === null) return null

  const rawSync = fields.syncToFrameMs
  if (rawSync === undefined) return { frameBytes, decodeMs, hydrateMs }
  const syncToFrameMs = clampedNumber(rawSync, MAX_REPORT_MS)
  if (syncToFrameMs === null) return null
  return { frameBytes, decodeMs, syncToFrameMs, hydrateMs }
}

/** Per-connection sliding-window budget plus the report handler. */
export class SyncTimingReports {
  private readonly calls = new Map<string, number[]>()

  /** Consume one slot of `connectionId`'s budget; false when it is spent. */
  private allow(connectionId: string, now: number): boolean {
    const recent = (this.calls.get(connectionId) ?? []).filter((t) => now - t < WINDOW_MS)
    if (recent.length >= MAX_REPORTS_PER_MINUTE) {
      this.calls.set(connectionId, recent)
      return false
    }
    recent.push(now)
    // Re-insert so the Map's insertion order is least-recently-used first.
    this.calls.delete(connectionId)
    this.calls.set(connectionId, recent)
    if (this.calls.size > MAX_TRACKED_CONNECTIONS) {
      const oldest = this.calls.keys().next().value
      if (oldest !== undefined) this.calls.delete(oldest)
    }
    return true
  }

  /**
   * Handle one report. The call counts against the budget whether or not it
   * validates, so malformed spam is throttled like any other.
   */
  report(connectionId: string, raw: unknown, now: number = Date.now()): void {
    if (!this.allow(connectionId, now)) return
    const parsed = parseSyncTimingReport(raw)
    if (!parsed) return
    const { level, message } = formatSyncTiming({
      transport: 'web',
      frameChars: Math.floor(parsed.frameBytes),
      decodeMs: parsed.decodeMs,
      syncToFrameMs: parsed.syncToFrameMs,
      hydrateMs: parsed.hydrateMs
    })
    if (level === 'warn') logger.warn(SYNC_STATS_SOURCE, message)
    else logger.info(SYNC_STATS_SOURCE, message)
  }

  /** The socket is gone: forget its budget. Called from the remote server's close paths. */
  releaseConnection(connectionId: string): void {
    this.calls.delete(connectionId)
  }

  /** Test seam: how many connections hold a budget entry. */
  trackedConnections(): number {
    return this.calls.size
  }
}

/** The one registry the remote handler and the remote server's close paths share. */
export const syncTimingReports = new SyncTimingReports()
