/**
 * The desktop renderer's sync transport — SyncCore phase 4c (ADR-051).
 *
 * The renderer stops being a specially-delivered window and becomes **client #1**:
 * it subscribes over a `MessagePortMain` pair and speaks the same four frames the
 * WebSocket clients speak, byte for byte
 * (`{type:'sync'}` → `{type:'sync-full'|'sync-catchup'}`, then `{type:'event'}` —
 * plus, since phase 5 S1, `{type:'stream'}` for the volatile lane).
 * Nothing about the protocol is desktop-specific; **the port IS the trust**, so
 * there are no auth frames on it.
 *
 * ## Why a port and not `webContents.send`
 *
 * `webContents.send` has no cursor, so the renderer could never tell "I have
 * applied through seq N" — which is what makes catchup, gap detection and the
 * pre-mount buffer possible. Those are exactly the three defects remote.md
 * recorded against the phone client (drop-before-mount, silent gaps, no resync),
 * and the desktop had them too; it just crashed less visibly because it also read
 * state from disk. On the port the renderer gets the phase-0 {@link SyncClient}
 * verbatim, so those properties come for free and are proven by the same tests.
 *
 * ## Lifecycle
 *
 * One channel per RENDERER LOAD, keyed off `did-finish-load`:
 *
 *  - a reload produces a brand-new renderer with an empty store, so it must get a
 *    fresh port AND a fresh `sync-full`. Re-posting is therefore mandatory, not an
 *    optimization; the previous port is closed and its subscriber dropped first so
 *    a stale renderer can never keep receiving (and so the ring is not fanned out
 *    to a dead sink);
 *  - the subscriber is registered only once the first `sync` has been ANSWERED,
 *    and in the same synchronous tick as reading the snapshot. Registering earlier
 *    would push events the client cannot place (no epoch, no cursor); registering
 *    later — after any `await` — would drop everything emitted in between.
 */

import { MessageChannelMain, type BrowserWindow, type MessagePortMain } from 'electron'
import { syncCore, addSyncSubscriber, addStreamSubscriber } from './sync-host'
import { desktopConnection } from '../ipc/command-registry'
import { logger } from './logger'

const LOG_SOURCE = 'sync-port'

/** The channel the port itself rides on. Not a domain event — a handshake. */
export const SYNC_PORT_CHANNEL = 'sync-port'

/** One renderer load's transport. */
interface PortSession {
  port: MessagePortMain
  unsubscribe: (() => void) | null
  /** The volatile lane's sink for this load (phase 5 S1). */
  unsubscribeStream: (() => void) | null
}

/**
 * Give `win`'s renderer a sync port on every load.
 *
 * Idempotent per window: call it once at window construction (before `loadURL`,
 * so the first `did-finish-load` is not missed).
 */
export function attachSyncPort(win: BrowserWindow): void {
  let active: PortSession | null = null

  const teardown = (): void => {
    if (!active) return
    active.unsubscribe?.()
    active.unsubscribeStream?.()
    try {
      active.port.close()
    } catch {
      // Already closed with the renderer — nothing to release.
    }
    active = null
  }

  win.webContents.on('did-finish-load', () => {
    // A reload replaced the renderer: the old port belongs to a document that no
    // longer exists, and its subscriber would fan the ring out to nothing.
    teardown()

    const { port1, port2 } = new MessageChannelMain()
    const session: PortSession = { port: port1, unsubscribe: null, unsubscribeStream: null }
    active = session

    port1.on('message', (event) => {
      handleFrame(session, event.data)
    })
    port1.on('close', () => {
      if (active === session) teardown()
    })
    port1.start()

    // `epoch` rides the handshake purely as a diagnostic — the client learns the
    // authoritative one from the sync-full/catchup answer, exactly like a WS
    // client does.
    win.webContents.postMessage(SYNC_PORT_CHANNEL, { epoch: syncCore.epoch() }, [port2])
  })

  win.on('closed', teardown)
}

/**
 * One frame from the renderer. `sync` is the only thing a client sends on this
 * transport: commands still ride `ipcRenderer.invoke` (the invoke surface is
 * untouched by 4c), and there is no auth to negotiate.
 */
function handleFrame(session: PortSession, frame: unknown): void {
  if (!frame || typeof frame !== 'object') return
  const message = frame as { type?: unknown; lastSeq?: unknown; epoch?: unknown }
  if (message.type !== 'sync') {
    logger.warn(LOG_SOURCE, `ignoring unexpected frame type "${String(message.type)}"`)
    return
  }
  const lastSeq = typeof message.lastSeq === 'number' ? message.lastSeq : 0
  const epoch = typeof message.epoch === 'string' ? message.epoch : undefined

  // Same decision function the WebSocket server uses (shared/sync/sync-decision).
  const decision = syncCore.answerSync(lastSeq, epoch)
  if (decision.kind === 'full') {
    post(session, { type: 'sync-full', state: decision.state, epoch: decision.epoch })
  } else {
    post(session, { type: 'sync-catchup', events: decision.events, epoch: decision.epoch })
  }

  // Subscribe AFTER the answer and in the SAME tick — see the module note.
  if (!session.unsubscribe) {
    session.unsubscribe = addSyncSubscriber((seq, channel, args) => {
      post(session, { type: 'event', seq, channel, args })
    })
    // The volatile lane (phase 5 S1). Registered alongside — and, like a WS
    // client's, it starts watching NOTHING: the renderer's watch effect sends
    // `stream:watch` for whatever session it is showing. The desktop's
    // connection id is the process-wide `desktopConnection()`, which is the same
    // identity its `stream:watch` invoke dispatches under.
    //
    // NO BACKPRESSURE CAP HERE (unlike the WS sink, phase 5 S2). A `MessagePort`
    // has no `bufferedAmount` to measure — there is no socket, no network, and no
    // encryption queue; a post is a structured clone handed to the renderer's
    // event loop in the same process. The condition the cap exists for (a remote
    // link too slow for the token rate) cannot arise, and dropping frames on the
    // guess would cost the desktop its live typing for nothing.
    session.unsubscribeStream = addStreamSubscriber(
      desktopConnection().connectionId,
      (streamFrame) => post(session, streamFrame)
    )
  }
}

function post(session: PortSession, frame: unknown): void {
  try {
    session.port.postMessage(frame)
  } catch (err) {
    // The renderer went away between the fan-out and this post. Drop the sink
    // rather than logging once per event for the rest of the process's life.
    logger.debug(
      LOG_SOURCE,
      `port post failed, dropping subscriber: ${err instanceof Error ? err.message : String(err)}`
    )
    session.unsubscribe?.()
    session.unsubscribe = null
    session.unsubscribeStream?.()
    session.unsubscribeStream = null
  }
}
