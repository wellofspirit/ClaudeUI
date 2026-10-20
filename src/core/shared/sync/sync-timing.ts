/**
 * The client half of the `SyncStats` measurement: what a `sync-full` cost the
 * RECEIVING side, relayed into the host's log through the existing renderer →
 * host relay (`window.api.logRelay`) so it lands beside the host's own lines.
 *
 * Both clients report once per `sync-full`, at `info` (so the same
 * `CLAUDE_UI_LOG=SyncStats:info` enablement shows it), escalating to `warn` when
 * the client's total passes {@link SYNC_TIMING_WARN_MS}. Pure and Electron-free: the
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

/** Relay one `sync-full` timing line. A missing relay (no host to log to) is a no-op. */
export function relaySyncTiming(relay: Relay | undefined, t: SyncTiming): void {
  if (!relay) return
  const total = syncTimingTotalMs(t)
  const fields = [`transport=${t.transport}`]
  if (t.frameChars !== undefined) fields.push(`frameChars=${t.frameChars}`)
  if (t.decodeMs !== undefined) fields.push(`decodeMs=${t.decodeMs.toFixed(1)}`)
  if (t.syncToFrameMs !== undefined) fields.push(`syncToFrameMs=${t.syncToFrameMs.toFixed(1)}`)
  fields.push(`hydrateMs=${t.hydrateMs.toFixed(1)}`, `totalMs=${total.toFixed(1)}`)
  const slow = total > SYNC_TIMING_WARN_MS
  relay(
    slow ? 'warn' : 'info',
    SYNC_STATS_SOURCE,
    `${slow ? 'slow ' : ''}client sync-full applied: ${fields.join(' ')}`
  )
}
