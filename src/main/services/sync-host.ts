/**
 * SyncCore's host adapter — the ONE place `webContents.send` happens for a
 * replicated event (SyncCore phase 4a, ADR-051).
 *
 * `src/main/sync/` is Electron-free by lint fence, so the fan-out is injected
 * from here. This module owns:
 *
 *  - the process-wide {@link syncCore} singleton;
 *  - the **extra-window registry** (the remote bridge, the plugin bridge).
 *    `BaseSession.addExtraWindow/getExtraWindows` delegate to it. The registry
 *    lives here rather than on `BaseSession` so the dependency runs one way —
 *    `BaseSession` → `sync-host` — instead of forming a cycle. The registry
 *    itself, and `BaseSession`'s static accessors over it, are 4c deletion
 *    targets (clients become uniform subscribers, so "extra window" stops being
 *    a concept);
 *  - the delivery callback, wired to TODAY'S EXACT targets — asymmetries
 *    preserved verbatim, not tidied (`create-session.ts`'s skip-the-main-window
 *    path is a named 4c deletion target, not a 4a fix);
 *  - {@link emitEvent}, the helper every former hand-rolled `getExtraWindows()`
 *    loop now calls.
 *
 * A guard test asserts no `getExtraWindows()` fan-out loop survives outside this
 * file — that is what makes "one emission ⇒ one ring append" enforceable rather
 * than aspirational.
 */

import type { BrowserWindow } from 'electron'
import { SyncCore, type Delivery } from '../sync/sync-core'
import { compareShadow, formatShadowDiff, CLIENT_WRITTEN_FIELDS } from '../sync/shadow'
import type { FullStateSnapshot } from '../../shared/remote-protocol'
import { logger } from './logger'

const LOG_SOURCE = 'sync-core'

// ---------------------------------------------------------------------------
// Extra-window registry
// ---------------------------------------------------------------------------

const extraWindows = new Set<BrowserWindow>()

export function addExtraSink(win: BrowserWindow): void {
  extraWindows.add(win)
}

export function removeExtraSink(win: BrowserWindow): void {
  extraWindows.delete(win)
}

export function extraSinks(): Set<BrowserWindow> {
  return extraWindows
}

/**
 * An extra window that understands sequenced delivery (the remote bridge).
 * Detected structurally so neither `src/main/sync` nor this adapter needs to
 * import the bridge, and so a plain extra sink (the plugin bridge) keeps its
 * unsequenced `webContents.send` path.
 */
interface SequencedSink {
  deliverSequenced(seq: number, channel: string, args: unknown[]): void
}

function asSequencedSink(target: unknown): SequencedSink | null {
  const candidate = target as Partial<SequencedSink> | null
  return candidate && typeof candidate.deliverSequenced === 'function'
    ? (candidate as SequencedSink)
    : null
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/** The host's primary window — the desktop renderer (client #1 from 4c on). */
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

function sendToExtras(seq: number, channel: string, args: unknown[]): void {
  for (const w of extraWindows) {
    if (w.isDestroyed()) continue
    const sink = asSequencedSink(w)
    if (sink) {
      // The bridge must carry the RING seq — re-numbering there would make the
      // WS frame's seq disagree with what a catchup replays.
      sink.deliverSequenced(seq, channel, args)
    } else {
      w.webContents.send(channel, ...args)
    }
  }
}

/** The delivery callback — today's fan-out, per target, verbatim. */
function hostDelivery(seq: number, channel: string, args: unknown[], delivery: Delivery): void {
  const win = (delivery.window as BrowserWindow | undefined) ?? primaryWindow
  switch (delivery.target) {
    case 'main-only':
      sendToWindow(win, channel, args)
      return
    case 'extras-only':
      sendToExtras(seq, channel, args)
      return
    case 'all':
      sendToWindow(win, channel, args)
      sendToExtras(seq, channel, args)
      return
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
 * @param target   which sockets/windows see it
 * @param win      the window this emission's "main" target is, when it is not
 *                 the app's primary window (`BaseSession`'s per-session `win`)
 */
export function emitEvent(
  channel: string,
  args: unknown[],
  target: Delivery['target'],
  win?: BrowserWindow | null
): void {
  syncCore.emit(channel, args, { target, window: win ?? undefined })
}

// ---------------------------------------------------------------------------
// Shadow watch (dev only — SyncCore phase 4a item 9)
// ---------------------------------------------------------------------------

/** How often the dev shadow watch diffs canonical against the renderer. */
const SHADOW_INTERVAL_MS = 15_000

/** Env flag that arms the watch. Absent in every production build path. */
export const SHADOW_ENV_FLAG = 'CLAUDEUI_SYNC_SHADOW'

let shadowTimer: ReturnType<typeof setInterval> | null = null

/**
 * Periodically diff canonical state against the renderer replica and log a
 * BOUNDED summary when they disagree.
 *
 * Off unless `CLAUDEUI_SYNC_SHADOW=1`: canonical state is shadow in 4a, so this
 * is a development instrument, not a product feature — no telemetry, no
 * user-facing surface, and no cost at all when the flag is absent.
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
  // known 4a divergence, not signal. Without this the watch logs noise every tick.
  const diffs = compareShadow(canonical, renderer, { unseeded, ignoreFields: CLIENT_WRITTEN_FIELDS })
  if (diffs.length === 0) return
  logger.warn(
    LOG_SOURCE,
    `shadow divergence (${diffs.length} field(s) at seq ${canonical.seq}):\n` +
      formatShadowDiff(diffs).join('\n')
  )
}
