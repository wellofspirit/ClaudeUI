/**
 * Make a fake `BrowserWindow` behave like a CLIENT — SyncCore phase 4c.
 *
 * Engine tests observe what a session emits by handing it a stub window and
 * reading `win.webContents.send.mock.calls`. That worked because the desktop
 * window WAS the delivery target for replicated events, which is precisely the
 * privilege 4c deleted: a session emission now goes to every registered
 * subscriber and to no window at all.
 *
 * Rather than rewrite several hundred assertions, this registers the stub as a
 * subscriber and replays each delivery into the same `send(channel, ...args)`
 * shape. The test keeps asserting on the events a client receives — which is what
 * it was always really asserting on — and the stub stops pretending to be a
 * privileged window.
 *
 * ## The stream lane (phase 5 S1)
 *
 * `session:stream` / `session:subagent-stream` are no longer events, so they no
 * longer reach a sync subscriber at all. The stub therefore also registers a
 * STREAM sink, watching every session it is told about, and re-materializes each
 * frame with the shared {@link streamFrameToEmission} — the same inverse the
 * ADR-005 plugin bridge uses, so there is one answer to "what did the emitter
 * send" rather than one per consumer.
 *
 * CLIENTS never use that inverse: they fold `applyStreamFrame`, which is what the
 * offsets are for. It exists only for in-process consumers whose contract
 * predates the lane split.
 *
 * S2 moved the three TAILS (`session:bash-output`, `session:background-output`,
 * `automation:stream-event`) onto the same lane in the PASS-THROUGH flavor. Those
 * need no inverse at all — the frame carries `(channel, args)` verbatim — but
 * they do need the unfiltered delivery they had as events, so they arrive through
 * a stream OBSERVER rather than through the watch-filtered sink.
 */

import {
  addStreamObserver,
  addStreamSubscriber,
  addSyncSubscriber,
  setStreamWatch,
  syncCore
} from '../../core/services/sync-host'
import { streamFrameToEmission, type LaneFrame } from '../../core/shared/sync/stream'

interface WindowLike {
  webContents: { send: (channel: string, ...args: unknown[]) => void }
}

let nextStubConnection = 0

/** Subscribe `win` to the funnel's fan-out AND to every session's stream lane. */
export function subscribeWindowToSync(win: WindowLike): () => void {
  const offEvents = addSyncSubscriber((_seq, channel, args) => {
    win.webContents.send(channel, ...args)
  })

  const connectionId = `test-stub-${nextStubConnection++}`
  const offStream = addStreamSubscriber(connectionId, (frame: LaneFrame) => {
    if (frame.type === 'stream-ev') return // delivered through the observer below
    // The SHARED inverse — the same one the plugin bridge uses. Hand-rolling it
    // here would be a second answer to "what did the emitter send", in the one
    // place nobody would think to look for it.
    const emission = streamFrameToEmission(frame)
    if (!emission) return
    win.webContents.send(emission.channel, emission.routingId, emission.data)
  })

  // The PASS-THROUGH flavor (phase 5 S2) rides the OBSERVER list instead, and
  // that is not a shortcut: these three channels were unfiltered `replicated`
  // events until S2, so the stub received every one of them regardless of which
  // session it was. An observer reproduces exactly that, while the watch-filtered
  // sink above would silently drop a tail for a session the re-watch below has
  // not caught up with yet — turning a lane change into hundreds of failed engine
  // assertions about output the engine did emit.
  const offTails = addStreamObserver((frame: LaneFrame) => {
    if (frame.type !== 'stream-ev') return
    win.webContents.send(frame.channel, ...frame.args)
  })

  // A stub has no watch effect, so it re-watches whatever canonical currently
  // holds after every event. Cheap (a handful of ids in a unit test) and it makes
  // a session created mid-test visible without the test knowing it must
  // subscribe. `replay: false` because a re-watch of an unchanged set would
  // re-deliver every accumulation as duplicate deltas — the stub wants the LIVE
  // frames only, which is what these assertions were always about.
  const offWatch = addSyncSubscriber((_seq, channel, args) => {
    // Canonical must KNOW a session before a delta can be placed in it — an
    // offset is a length, and there is nothing to measure otherwise. Production
    // gets that from `session:created`, which `prepareAndCreateSession` emits
    // synchronously at spawn; an engine unit test constructs its session object
    // directly and never runs that path, so the stub seeds the entry from the
    // first session-scoped event it sees (a `session:status` from the engine's
    // own constructor, in practice).
    const routingId = args[0]
    if (
      channel.startsWith('session:') &&
      typeof routingId === 'string' &&
      !syncCore.getCanonicalState().sessions[routingId]
    ) {
      syncCore.seedSession(routingId, {})
    }
    setStreamWatch(connectionId, Object.keys(syncCore.getCanonicalState().sessions), {
      replay: false
    })
  })

  return () => {
    offEvents()
    offStream()
    offTails()
    offWatch()
  }
}
