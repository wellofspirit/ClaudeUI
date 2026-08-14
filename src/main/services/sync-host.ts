/**
 * SyncCore's host adapter — the ONE place a domain event leaves the main process
 * (SyncCore phase 4a, rewired by 4c; ADR-051).
 *
 * `src/main/sync/` is Electron-free by lint fence, so the fan-out is injected
 * from here. This module owns:
 *
 *  - the process-wide {@link syncCore} singleton;
 *  - the **subscriber registry** — every client is one `(seq, channel, args)`
 *    sink and nothing distinguishes them. The desktop renderer's MessagePort
 *    (`services/sync-port.ts`), the WebSocket broadcaster
 *    (`services/remote-server.ts`) and the plugin bridge
 *    (`services/plugin-manager.ts`) all register the same way;
 *  - the delivery callback, which routes by the channel's CLASS and nothing else;
 *  - {@link emitEvent}, the one emission helper.
 *
 * ## What 4c deleted
 *
 * The **delivery privilege** (remote.md defect 2, second half). 4a preserved
 * today's fan-out verbatim: a distinguished `primaryWindow` got a targeted
 * `webContents.send` for every replicated channel, an "extra window" registry
 * held the fake-`BrowserWindow` remote bridge, and three call sites chose
 * `extras-only` to skip the renderer they assumed already knew. All of that is
 * gone:
 *
 *  - `extraWindows` / `addExtraSink` / `extraSinks` and `BaseSession`'s static
 *    accessors over them — replaced by {@link addSyncSubscriber};
 *  - the structural `deliverSequenced` sniffing and the `RemoteBridge`
 *    fake-window class — a subscriber IS the sequenced interface;
 *  - `Delivery.target` and the `notifyMainWindow` asymmetry — delivery follows
 *    the channel class (see `src/shared/sync/channels.ts`).
 *
 * A `webContents.send` survives for exactly one lane: `host-local` channels
 * (window chrome, native pickers, voice, OAuth, desktop PTY bytes, the
 * log-viewer window). Those are not sync, they are the host talking to its own
 * shell, and the funnel guard asserts nothing else uses that path.
 */

import type { BrowserWindow } from 'electron'
import { SyncCore, type Delivery } from '../sync/sync-core'
import { compareShadow, formatShadowDiff, CLIENT_WRITTEN_FIELDS } from '../sync/shadow'
import type { FullStateSnapshot } from '../../shared/remote-protocol'
import { logger } from './logger'

const LOG_SOURCE = 'sync-core'

// ---------------------------------------------------------------------------
// Subscriber registry
// ---------------------------------------------------------------------------

/**
 * One client's delivery sink. Receives the RING-assigned seq — never a
 * re-numbering: the seq a client stores as its cursor has to be the one a
 * catchup replays from, so the number is assigned once, by the ring, and copied
 * from there to every subscriber.
 */
export type SyncSubscriber = (seq: number, channel: string, args: unknown[]) => void

const subscribers = new Set<SyncSubscriber>()

/** Register a client. Returns the unsubscribe. */
export function addSyncSubscriber(sink: SyncSubscriber): () => void {
  subscribers.add(sink)
  return () => {
    subscribers.delete(sink)
  }
}

/** How many clients are currently subscribed (diagnostics + tests). */
export function syncSubscriberCount(): number {
  return subscribers.size
}

/** Drop every subscriber. Test seam only — production unsubscribes individually. */
export function clearSyncSubscribersForTests(): void {
  subscribers.clear()
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/**
 * The host's own window. Only `host-local` channels target it now, and only
 * when the emission did not name a window of its own.
 */
let primaryWindow: BrowserWindow | null = null

/** Register the main BrowserWindow with the funnel. Idempotent. */
export function setSyncWindow(win: BrowserWindow | null): void {
  primaryWindow = win
}

export function getSyncWindow(): BrowserWindow | null {
  return primaryWindow
}

function sendToWindow(win: BrowserWindow | null, channel: string, args: unknown[]): void {
  if (!win || win.isDestroyed()) return
  win.webContents.send(channel, ...args)
}

/**
 * The delivery callback. Two lanes, chosen by class:
 *
 *  - `host-local` → a targeted `webContents.send` to the owning window. Not
 *    sync; not ringed; never reaches a subscriber.
 *  - everything else → EVERY subscriber, always.
 *
 * Each subscriber is fenced: the desktop port and the WS broadcaster must not be
 * able to break each other (a destroyed port throwing on `postMessage` used to
 * be a fake-window `isDestroyed()` check; now it is a caught error). The set is
 * copied before iteration so a sink that unsubscribes from inside its own
 * callback cannot truncate the fan-out.
 */
function hostDelivery(
  seq: number,
  channel: string,
  args: unknown[],
  delivery: Delivery & { cls: string }
): void {
  if (delivery.cls === 'host-local') {
    sendToWindow((delivery.window as BrowserWindow | undefined) ?? primaryWindow, channel, args)
    return
  }
  for (const sink of [...subscribers]) {
    try {
      sink(seq, channel, args)
    } catch (err) {
      logger.error(
        LOG_SOURCE,
        `subscriber threw delivering "${channel}" (seq ${seq}); other clients unaffected: ` +
          `${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
}

/** The process-wide core. One ring, one canonical state, one epoch. */
export const syncCore = new SyncCore({
  onUnclassified: (channel) =>
    logger.error(
      LOG_SOURCE,
      `refusing to emit unclassified channel "${channel}" — add it to ` +
        `src/shared/sync/channels.ts (see docs/architecture/sync-channels.md)`
    ),
  onApplyError: (channel, err) =>
    logger.error(
      LOG_SOURCE,
      `applyEvent("${channel}") threw; canonical state skipped this event but ` +
        `delivery continued: ${err instanceof Error ? err.message : String(err)}`
    )
})

syncCore.setDelivery(hostDelivery)

/**
 * Emit a domain event through the funnel.
 *
 * @param channel  the event channel (must be classified — fail-closed)
 * @param args     the wire args, positional exactly as `webContents.send` sent
 *                 them (`(routingId, data)` for session-scoped channels)
 * @param win      HOST-LOCAL emissions only: the window this event belongs to,
 *                 when it is not the app's primary window. Ignored for every
 *                 replicated / volatile channel — those go to every subscriber
 *                 and a call site has no say in it (4c).
 */
export function emitEvent(channel: string, args: unknown[], win?: BrowserWindow | null): void {
  syncCore.emit(channel, args, { window: win ?? undefined })
}

// ---------------------------------------------------------------------------
// Shadow watch (dev only — SyncCore phase 4a item 9, inverted by 4b)
// ---------------------------------------------------------------------------

/** How often the dev shadow watch diffs the renderer replica against canonical. */
const SHADOW_INTERVAL_MS = 15_000

/** Env flag that arms the watch. Absent in every production build path. */
export const SHADOW_ENV_FLAG = 'CLAUDEUI_SYNC_SHADOW'

let shadowTimer: ReturnType<typeof setInterval> | null = null

/**
 * Periodically diff the renderer's replica against canonical state and log a
 * BOUNDED summary when they disagree.
 *
 * The direction of suspicion flipped in 4b: canonical is now the state of record
 * (`sync-full` serves it), so what this watch surfaces is the DESKTOP store
 * showing something no reconnecting client would see. It survives 4c — the
 * renderer's store still interprets the event stream with its own handlers, so
 * the duplication the comparator measures is still there; it retires with the
 * renderer's adoption of the shared reducer.
 *
 * Off unless `CLAUDEUI_SYNC_SHADOW=1` — a development instrument, not a product
 * feature: no telemetry, no user-facing surface, and no cost at all when the flag
 * is absent.
 *
 * Deliberately tolerant: the renderer round-trip can fail (not yet mounted, page
 * reloading) and a failed compare must never be louder than a real divergence.
 */
export function startShadowWatch(win: BrowserWindow): void {
  if (process.env[SHADOW_ENV_FLAG] !== '1') return
  if (shadowTimer) return
  logger.info(LOG_SOURCE, `shadow watch armed (${SHADOW_ENV_FLAG}=1)`)
  shadowTimer = setInterval(() => {
    void runShadowCompare(win)
  }, SHADOW_INTERVAL_MS)
}

export function stopShadowWatch(): void {
  if (!shadowTimer) return
  clearInterval(shadowTimer)
  shadowTimer = null
}

async function runShadowCompare(win: BrowserWindow): Promise<void> {
  if (win.isDestroyed()) return
  // Capture canonical FIRST and remember its seq: the renderer pull is async, so
  // events landing mid-round-trip would otherwise read as divergence.
  const canonical = syncCore.getSnapshot()
  let renderer: FullStateSnapshot | null = null
  try {
    renderer = (await win.webContents.executeJavaScript(
      'window.__getRemoteState ? window.__getRemoteState() : null'
    )) as FullStateSnapshot | null
  } catch {
    return // renderer not ready — not a divergence
  }
  if (!renderer) return
  if (syncCore.currentSeq() !== canonical.seq) return // raced; try again next tick

  const state = syncCore.getCanonicalState()
  const unseeded = new Set(
    Object.entries(state.sessions)
      .filter(([, s]) => !s.seeded)
      .map(([id]) => id)
  )
  // Skip the client-written fields (sync-channels.md §"Client-written state") —
  // known divergence, not signal. Without this the watch logs noise every tick.
  const diffs = compareShadow(canonical, renderer, { unseeded, ignoreFields: CLIENT_WRITTEN_FIELDS })
  if (diffs.length === 0) return
  logger.warn(
    LOG_SOURCE,
    `shadow divergence (${diffs.length} field(s) at seq ${canonical.seq}):\n` +
      formatShadowDiff(diffs).join('\n')
  )
}
