/**
 * The desktop renderer's half of the sync port — SyncCore phase 4c (ADR-051).
 *
 * Mirror image of `src/web/connection.ts`: that file owns a WebSocket, this one
 * owns a `MessagePort`, and both feed the SAME phase-0 {@link SyncClient}. The
 * frames are identical — `{type:'sync'}` out, `{type:'sync-full'|'sync-catchup'}`
 * and `{type:'event'}` in, plus `{type:'stream'}` for the volatile lane — so the
 * renderer is client #1 in the literal sense:
 * nothing about its protocol is desktop-specific, and there is no auth on it
 * because the port itself is the capability.
 *
 * ## How the port arrives
 *
 * `MessagePort` cannot cross `contextBridge`, so the preload takes delivery from
 * `ipcRenderer.on('sync-port')` and hands it to the main world with
 * `window.postMessage(SYNC_PORT_MESSAGE, '*', [port])` — the pattern Electron's
 * own message-ports guide prescribes. {@link startDesktopSync} installs the
 * window listener FIRST and only then calls `window.api.acquireSyncPort()`, so the
 * hand-off cannot race: the preload holds the port until asked.
 *
 * ## Reload
 *
 * A reload is a brand-new renderer with an empty store, so main creates a fresh
 * channel per load and this module asks for a fresh `sync-full` (`lastSeq: 0`).
 * The `hasHydrated` flag distinguishes that first hydration from a later resync
 * exactly as the web client's does, because the two are NOT the same operation:
 * a resync must not clobber local navigation (ADR-041).
 */

import { SyncClient } from '../../../shared/sync/sync-client'
import { setSyncClient } from '../../../shared/sync/client-registry'
import type { FullStateSnapshot, EventEntry } from '../../../shared/remote-protocol'

/**
 * The `window.postMessage` tag the preload uses to transfer the port into the
 * main world. Shared so the two halves cannot disagree on the string.
 */
export const SYNC_PORT_MESSAGE = 'claudeui:sync-port'

type FullStateHandler = (state: FullStateSnapshot, isResync: boolean) => void

interface SyncFrame {
  type?: string
  seq?: number
  channel?: string
  args?: unknown[]
  state?: FullStateSnapshot
  events?: EventEntry[]
  epoch?: string
}

/**
 * Connect the renderer to the main process's SyncCore and install the resulting
 * client in the shared registry.
 *
 * @param onFullState applies a snapshot to the store. `isResync` is false for the
 *                    first snapshot of this renderer's life and true afterwards.
 * @returns the client, so the caller can assert on it in tests.
 */
export function startDesktopSync(onFullState: FullStateHandler): SyncClient {
  let port: MessagePort | null = null
  /** Queued while the port has not arrived (only the initial `sync` can queue). */
  let pendingSync: { lastSeq: number; epoch?: string } | null = null
  let hasHydrated = false

  const client = new SyncClient({ requestResync: () => sendSync() })
  client.setFullStateHandler((state) => {
    const isResync = hasHydrated
    hasHydrated = true
    onFullState(state, isResync)
  })

  function sendSync(): void {
    const frame = { lastSeq: client.getLastSeq(), epoch: client.getEpoch() }
    if (!port) {
      pendingSync = frame
      return
    }
    port.postMessage({ type: 'sync', ...frame })
  }

  function handleFrame(frame: SyncFrame): void {
    switch (frame.type) {
      case 'sync-full':
        if (frame.state && frame.epoch) {
          client.applyFullState(frame.state, frame.epoch, frame.state.seq)
        }
        return
      case 'sync-catchup':
        if (Array.isArray(frame.events) && frame.epoch) {
          client.applyCatchup(frame.events, frame.epoch)
        }
        return
      case 'event':
        if (typeof frame.seq === 'number' && typeof frame.channel === 'string') {
          client.receiveEvent({ seq: frame.seq, channel: frame.channel, args: frame.args ?? [] })
        }
        return
      case 'stream':
        // The volatile lane (phase 5 S1). Validated inside the client, so this
        // decoder stays a router; it never touches the cursor.
        client.receiveStreamFrame(frame)
        return
      default:
        // An unknown frame is a version skew between preload and renderer, which
        // cannot happen inside one build. Ignore rather than throw: a throw here
        // would take down the message pump for every later frame.
        return
    }
  }

  window.addEventListener('message', (event: MessageEvent) => {
    // `event.source === window` is the guard Electron's guide prescribes: only the
    // preload (same frame) can post with this tag, and an iframe (the mockup
    // preview runs one) must not be able to inject sync frames.
    if (event.source !== window || event.data !== SYNC_PORT_MESSAGE) return
    const incoming = event.ports[0]
    if (!incoming) return
    port = incoming
    port.onmessage = (message: MessageEvent): void => handleFrame(message.data as SyncFrame)
    port.start()
    // Ask for state. `lastSeq` is 0 on a fresh renderer, so this is always a
    // sync-full in practice; going through the same frame the web client sends
    // keeps one code path for both.
    const frame = pendingSync ?? { lastSeq: client.getLastSeq(), epoch: client.getEpoch() }
    pendingSync = null
    port.postMessage({ type: 'sync', ...frame })
  })

  setSyncClient(client)
  // Only now — the listener above must exist before the preload posts.
  window.api.acquireSyncPort()
  return client
}
