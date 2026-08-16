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
 *  - the **stream registry** (phase 5 S1) — the volatile lane's parallel: one
 *    sink per CONNECTION plus that connection's `stream:watch` set, so a delta
 *    reaches only the clients looking at that session;
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
import { sessionIdOfStream, streamEventScopeOf, type LaneFrame } from '../../shared/sync/stream'
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
// Stream registry (SyncCore phase 5 S1)
// ---------------------------------------------------------------------------
//
// The volatile lane's parallel to {@link addSyncSubscriber}, and deliberately NOT
// the same registry: an event subscriber receives everything, always, while a
// stream sink receives only the sessions its connection asked for. Keyed by
// `connectionId` because the watch set is PER CONNECTION and dies with the socket
// — which is what preserves ADR-054's promise that a 4010 max-age cut ends every
// authority the socket held, this one included.

/** One connection's stream sink. Carries BOTH lane flavors (phase 5 S2). */
export type StreamSink = (frame: LaneFrame) => void

interface StreamSubscriber {
  sink: StreamSink
  /** Routing ids this connection is watching — a REPLACE set, never additive. */
  watch: Set<string>
  /**
   * Automation ids this connection is watching (phase 5 S2) — the second scope
   * the lane filters on, because `automation:stream-event` belongs to the
   * automation surface rather than to a session. Kept SEPARATE rather than merged
   * into one id space: a session id and an automation id are minted by different
   * subsystems, and a collision would silently cross-deliver.
   */
  automationWatch: Set<string>
}

const streamSubscribers = new Map<string, StreamSubscriber>()

/**
 * Register a connection's stream sink. Returns the unregister, which the
 * transport calls on socket close (WS) or port teardown (desktop).
 *
 * Registering does NOT subscribe to anything: the connection starts watching
 * nothing and must send `stream:watch`.
 */
export function addStreamSubscriber(connectionId: string, sink: StreamSink): () => void {
  streamSubscribers.set(connectionId, { sink, watch: new Set(), automationWatch: new Set() })
  return () => {
    streamSubscribers.delete(connectionId)
  }
}

/**
 * Apply a `stream:watch` — REPLACE semantics, so the call is idempotent and a
 * client never has to track what it previously asked for.
 *
 * Pushes the replay for every newly-watched session immediately (the
 * terminal-attach symmetry): one `offset: 0` frame per non-empty accumulation,
 * which is a REPLACE by construction and is therefore the lane's self-heal. The
 * replay goes out for the WHOLE new set, not just the added ids: re-sending the
 * same set is exactly how a client cures a mismatch.
 *
 * `automationRuns` is the SECOND set (phase 5 S2), replaced independently: it is
 * `undefined` when the caller said nothing about automations, and an absent set
 * is silence, not a clear. There is nothing to replay for it — pass-through
 * frames have no accumulation to re-state, which is what "honest-lossy" means.
 *
 * Returns the number of frames pushed (diagnostics + tests). A no-op for an
 * unregistered connection — the desktop's own port registers on first sync, and a
 * socket can close between the frame landing and this running.
 */
export function setStreamWatch(
  connectionId: string,
  sessionIds: readonly string[],
  options: { replay?: boolean; automationRuns?: readonly string[] } = {}
): number {
  const entry = streamSubscribers.get(connectionId)
  if (!entry) return 0
  entry.watch = new Set(sessionIds)
  if (options.automationRuns) entry.automationWatch = new Set(options.automationRuns)
  // `replay: false` exists for ONE caller — the engine-test stub window, which
  // re-watches after every emission and would otherwise re-deliver every
  // already-watched session's accumulation as duplicate deltas. No production
  // path uses it: the replay IS the self-heal, and a client that skipped it would
  // have no way back from a mismatch.
  if (options.replay === false) return 0
  let pushed = 0
  for (const routingId of entry.watch) {
    for (const frame of syncCore.streamReplay(routingId)) {
      try {
        entry.sink(frame)
        pushed++
      } catch (err) {
        logger.error(
          LOG_SOURCE,
          `stream sink threw during replay of ${routingId}: ` +
            `${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
  }
  return pushed
}

/**
 * Deliver ONE lane frame to ONE connection, bypassing the watch sets entirely
 * (SyncCore phase 5 S3).
 *
 * The lane's third delivery rule, and the narrowest. {@link streamDelivery} asks
 * "who is LOOKING at this session"; this asks "who is HOLDING this device". They
 * are different questions, and the first is the wrong one for a remote voice
 * capture: a phone and a laptop watching the same session would both receive the
 * phone's interim transcripts and both type them into their own drafts, and the
 * `voice:state` recording indicator would light up on a client whose microphone
 * is not on. Transcription belongs to the connection whose microphone produced
 * it, exactly as PTY bytes belong to the socket that attached
 * (`RemoteServer.terminalSink`).
 *
 * Returns false when the connection has no sink — a socket that closed while a
 * transcript was in flight, which is an ordinary race and not an error. The
 * caller's cure is to stop the capture, which the socket's close handler is
 * already doing.
 *
 * Same lane, same guarantees: never ringed, never logged, no seq, no replay.
 */
export function sendToStreamConnection(connectionId: string, frame: LaneFrame): boolean {
  const entry = streamSubscribers.get(connectionId)
  if (!entry) return false
  try {
    entry.sink(frame)
    return true
  } catch (err) {
    logger.error(
      LOG_SOURCE,
      `stream sink threw delivering a targeted frame to ${connectionId}: ` +
        `${err instanceof Error ? err.message : String(err)}`
    )
    return false
  }
}

/** What `connectionId` is watching (diagnostics + tests). */
export function streamWatchOf(connectionId: string): string[] {
  return [...(streamSubscribers.get(connectionId)?.watch ?? [])].sort()
}

/** How many connections hold a stream sink (diagnostics + tests). */
export function streamSubscriberCount(): number {
  return streamSubscribers.size
}

/** Drop every stream sink. Test seam only. */
export function clearStreamSubscribersForTests(): void {
  streamSubscribers.clear()
}

/**
 * IN-PROCESS observers of the stream lane — every frame, no watch set.
 *
 * Deliberately a SECOND list rather than a fake connection in
 * {@link streamSubscribers}. A watch set is a remote client's statement about
 * what it is looking at; an in-process observer has no session selection, no
 * socket to die with, and no capability to check. Conflating them would mean
 * inventing a connection id for something that is not a connection, and every
 * `stream:watch` bound would then have to reason about entries no client owns.
 *
 * The one production consumer is the ADR-005 plugin bridge, which was a
 * subscriber of `session:stream` before phase 5 S1 moved those channels off the
 * event lane — and of the three TAILS before S2 moved those. Restoring it here
 * keeps a plugin's contract unchanged by a lane change it has no part in — the
 * alternative was silently deleting token deltas and bash output from every
 * plugin.
 */
const streamObservers = new Set<StreamSink>()

/** Register an in-process observer of every stream frame. Returns the removal. */
export function addStreamObserver(sink: StreamSink): () => void {
  streamObservers.add(sink)
  return () => {
    streamObservers.delete(sink)
  }
}

/** Drop every stream observer. Test seam only — the leak net the other two registries have. */
export function clearStreamObserversForTests(): void {
  streamObservers.clear()
}

/**
 * The stream fan-out: every connection whose watch set names the frame's session,
 * and nobody else. Fenced per sink for the same reason the event lane is — one
 * dead socket must not stop the others.
 */
function streamDelivery(frame: LaneFrame): void {
  // One predicate for both flavors: a text frame names its session in the
  // streamId, a pass-through frame names its scope in the payload. Derived from
  // the ONE shared parser in each case — a second answer here about "who is this
  // for" is exactly the drift `shared/sync/stream.ts` exists to prevent.
  let wants: (entry: StreamSubscriber) => boolean
  let label: string
  if (frame.type === 'stream-ev') {
    const scope = streamEventScopeOf(frame)
    if (!scope) return
    wants =
      scope.kind === 'automation'
        ? (entry) => entry.automationWatch.has(scope.id)
        : (entry) => entry.watch.has(scope.id)
    label = `${frame.channel} (${scope.kind} ${scope.id})`
  } else {
    const routingId = sessionIdOfStream(frame.streamId)
    if (!routingId) return
    wants = (entry) => entry.watch.has(routingId)
    label = frame.streamId
  }

  for (const entry of [...streamSubscribers.values()]) {
    if (!wants(entry)) continue
    try {
      entry.sink(frame)
    } catch (err) {
      logger.error(
        LOG_SOURCE,
        `stream sink threw delivering ${label}: ` +
          `${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
  // In-process observers see every frame — they have no watch set to filter by.
  for (const observer of [...streamObservers]) {
    try {
      observer(frame)
    } catch (err) {
      logger.error(
        LOG_SOURCE,
        `stream observer threw on ${label}: ` +
          `${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
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
 * `volatile` channels never arrive here at all: `SyncCore.process` returns before
 * delivery for them and calls {@link streamDelivery} instead.
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
syncCore.setStreamDelivery(streamDelivery)

// A rekey moves the session's identity, and the watch sets are keyed by routing
// id — so they move with it, in the same tick canonical does. The alternative
// (waiting for each client's own watch effect to re-fire on the new id) would
// drop every delta of the rest of the turn on the floor, which is precisely the
// mid-stream rekey case (`session-rekey-mid-stream.e2e.test.ts`).
syncCore.onRekey((oldId, newId) => {
  for (const entry of streamSubscribers.values()) {
    if (!entry.watch.delete(oldId)) continue
    entry.watch.add(newId)
  }
})

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
