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
 *
 * ## What 4d changed
 *
 * The host window is no longer a field here: it lives in `services/host-window.ts`
 * and is READ at delivery time. A windowless boot (`CLAUDEUI_NO_WINDOW=1`) has no
 * window to register, so the host-local lane degrades to a no-op while every
 * subscriber keeps receiving — which is the property the phase-4 exit criterion
 * asks for.
 */

import type { BrowserWindow } from 'electron'
import { SyncCore, type Delivery } from '../sync/sync-core'
import { getHostWindow } from './host-window'
import { logger } from './logger'
import {
  detectEnteredWorktree,
  deriveWorktreeName,
  recordWorktreeEntry,
  WORKTREE_ENTER_TOOL_NAMES
} from './worktree-detect'

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

function sendToWindow(win: BrowserWindow | null, channel: string, args: unknown[]): void {
  if (!win || win.isDestroyed()) return
  win.webContents.send(channel, ...args)
}

/**
 * The delivery callback. Two lanes, chosen by class:
 *
 *  - `host-local` → a targeted `webContents.send` to the owning window (or
 *    nowhere at all, when the app runs windowless). Not sync; not ringed; never
 *    reaches a subscriber.
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
    sendToWindow((delivery.window as BrowserWindow | undefined) ?? getHostWindow(), channel, args)
    return
  }
  // Main-side observers run BEFORE the fan-out: their own emissions are queued by
  // SyncCore's reentrancy guard, so they land after this event and never take a
  // lower seq than the event that caused them.
  observeWorktreeEntry(channel, args)
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
// Funnel observers (SyncCore phase 4c)
// ---------------------------------------------------------------------------
//
// The shadow comparator that lived here is DELETED. It existed because the
// renderer interpreted the replicated stream with its own ~40 handlers while
// canonical interpreted it with `applyEvent`, and something had to measure the gap
// between two implementations of one contract. With the renderer folding the same
// reducer (`renderer/src/stores/replica.ts`) there is no second implementation to
// diff, so the instrument has nothing to measure — its remaining value moved into
// the hydration-parity assertions in `e2e/flows/sync-hydration-parity.e2e.test.ts`.
// Gone with it: `main/sync/shadow.ts`, `CLIENT_WRITTEN_FIELDS`, the renderer's
// `__getRemoteState` / `getRemoteStateSnapshot`, and the CLAUDEUI_SYNC_SHADOW flag.

/**
 * Detect an entered worktree from an `EnterWorktree` tool result and persist it
 * (SyncCore phase 4c — the last client-computation violation, moved to main).
 *
 * Runs on DELIVERY, which is after append + apply, so canonical already carries
 * the tool_result attached to its tool_use: the `EnterWorktree` gate can be
 * checked against real state rather than against a regex over the tool NAME.
 */
function observeWorktreeEntry(channel: string, args: unknown[]): void {
  if (channel !== 'session:tool-result') return
  const routingId = args[0]
  const data = args[1] as
    | { toolUseId?: string; result?: string; isError?: boolean }
    | undefined
  if (typeof routingId !== 'string' || !data?.toolUseId || !data.result || data.isError) return
  const state = syncCore.getCanonicalState()
  if (state.worktreeInfoMap[routingId]) return
  const session = state.sessions[routingId]
  if (!session) return
  const isEnterWorktree = session.messages.some((msg) =>
    msg.content.some(
      (b) =>
        b.type === 'tool_use' &&
        b.toolUseId === data.toolUseId &&
        WORKTREE_ENTER_TOOL_NAMES.has(b.toolName)
    )
  )
  if (!isEnterWorktree) return
  const detected = detectEnteredWorktree(data.result)
  if (!detected) return
  try {
    recordWorktreeEntry(
      routingId,
      {
        worktreePath: detected.worktreePath,
        worktreeBranch: detected.worktreeBranch,
        worktreeName: deriveWorktreeName(detected.worktreePath, detected.worktreeBranch),
        originalCwd: session.cwd,
        gitRoot: session.cwd,
        originalHeadCommit: '',
        createdAt: Date.now()
      },
      emitEvent
    )
  } catch (err) {
    logger.warn(
      LOG_SOURCE,
      `worktree detection failed for ${routingId}: ` +
        `${err instanceof Error ? err.message : String(err)}`
    )
  }
}
