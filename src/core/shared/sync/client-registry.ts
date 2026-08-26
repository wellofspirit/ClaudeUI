/**
 * The client's ONE {@link SyncClient}, wherever it is running — SyncCore phase 4c.
 *
 * Before 4c the two clients subscribed to replicated events through two different
 * surfaces that happened to have the same shape: the desktop renderer used
 * `window.api.onFoo()` (preload → `ipcRenderer.on`, no seq, no cursor, no
 * buffering) and the web client used `window.api.onFoo()` too, but backed by the
 * WebSocket transport's `SyncClient`. Parity was a hand-maintained coincidence —
 * the `api-adapter` mirror ADR-008's typecheck only checks the SIGNATURES of.
 *
 * Now there is one subscription surface for both: this registry. The transport
 * (MessagePort on the desktop, WebSocket on the web) constructs the client and
 * installs it here; every replicated-channel listener in the app goes through
 * {@link onSyncEvent}. The per-channel `window.api.onFoo` members survive only
 * for HOST-LOCAL channels, which are genuinely per-transport (a web client has no
 * window chrome, no microphone, no local OAuth browser).
 *
 * Registration is allowed BEFORE the client exists. Both entry points install it
 * before React renders, so this is belt-and-braces rather than a real ordering —
 * but a listener silently dropped because it registered one tick early is exactly
 * the class of bug phase 0's readiness gate exists to prevent, and it would be
 * invisible.
 */

import type {
  SyncClient,
  SyncListener,
  SyncEventTap,
  SyncStreamTap,
  SyncAnsweredTap
} from './sync-client'
import type { SyncEventMap } from './events'

let client: SyncClient | null = null

/** Which of the client's taps a deferred registration belongs to. */
type DeferredKind = 'channel' | 'any-event' | 'stream' | 'answered'

interface DeferredListener {
  kind: DeferredKind
  /** Non-null only for `kind: 'channel'`. */
  channel: string | null
  cb: SyncListener | SyncEventTap | SyncStreamTap | SyncAnsweredTap
  /** The real unsubscribe, once a client exists to register against. */
  off: (() => void) | null
  cancelled: boolean
}

function attach(next: SyncClient, entry: DeferredListener): () => void {
  switch (entry.kind) {
    case 'channel':
      return next.on(entry.channel as string)(entry.cb as SyncListener)
    case 'any-event':
      return next.onAnyEvent(entry.cb as SyncEventTap)
    case 'stream':
      return next.onStreamFrame(entry.cb as SyncStreamTap)
    case 'answered':
      return next.onSyncAnswered(entry.cb as SyncAnsweredTap)
  }
}

function defer(entry: Omit<DeferredListener, 'off' | 'cancelled'>): () => void {
  const full: DeferredListener = { ...entry, off: null, cancelled: false }
  if (client) {
    const off = attach(client, full)
    return off
  }
  deferred.push(full)
  return () => {
    full.cancelled = true
    full.off?.()
    full.off = null
  }
}

/** Listeners registered before the transport installed its client. */
const deferred: DeferredListener[] = []

/**
 * Install the transport's client. Called once per page lifetime, before the app
 * renders. Replaces any previous client (the test harness re-boots per test).
 */
export function setSyncClient(next: SyncClient): void {
  client = next
  for (const entry of deferred.splice(0)) {
    if (entry.cancelled) continue
    entry.off = attach(next, entry)
  }
}

/** The installed client, or null before the transport has run. */
export function getSyncClient(): SyncClient | null {
  return client
}

/**
 * Subscribe to a replicated / volatile channel. Returns the unsubscribe.
 *
 * Typed by {@link SyncEventMap}, which is where the ~45 `ClaudeAPI.onFoo`
 * signatures moved: the callback receives the event's `args` spread, exactly as
 * `webContents.send`'s listeners did — the wire shape did not change in 4c, only
 * who delivers it (see sync-core.md §"Wire encoding").
 */
export function onSyncEvent<K extends keyof SyncEventMap>(
  channel: K,
  cb: SyncEventMap[K]
): () => void {
  return defer({ kind: 'channel', channel, cb: cb as SyncListener })
}

/**
 * Subscribe to EVERY event, channel-agnostic — the client replica's feed
 * (SyncCore phase 4c). Deferred identically to {@link onSyncEvent}, because the
 * replica is installed by the store module and the store can be imported before
 * the transport runs (the web client imports it lazily, after `sync-full`).
 */
export function onSyncAnyEvent(cb: SyncEventTap): () => void {
  return defer({ kind: 'any-event', channel: null, cb })
}

/**
 * Subscribe to the VOLATILE STREAM lane (phase 5 S1) — the replica's second
 * feed. Deferred identically to {@link onSyncAnyEvent}, and for the same reason:
 * the replica is installed by the store module, which the web client imports
 * lazily.
 */
export function onSyncStreamFrame(cb: SyncStreamTap): () => void {
  return defer({ kind: 'stream', channel: null, cb })
}

/**
 * Run `cb` after every answered `sync` — initial, resync and reconnect. The
 * stream lane's watch effect keys on it, because a watch set dies with the
 * socket that held it.
 */
export function onSyncAnswered(cb: SyncAnsweredTap): () => void {
  return defer({ kind: 'answered', channel: null, cb })
}

/**
 * The app's listeners are mounted — flush whatever arrived while they were not.
 *
 * Idempotent and permanent (the gate is a one-way latch, see `SyncClient`). Call
 * it from the LAST effect that registers replicated listeners, on both clients:
 * before this, every event buffers rather than being acked into the void
 * (docs/architecture/remote.md defect 4).
 */
export function markSyncReady(): void {
  client?.markReady()
}

/** Drop the installed client. Test seam — production installs exactly one. */
export function resetSyncClientForTests(): void {
  client = null
  deferred.length = 0
}
