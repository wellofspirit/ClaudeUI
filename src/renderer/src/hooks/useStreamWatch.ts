/**
 * The volatile lane's subscription effect — SyncCore phase 5 S1.
 *
 * Streaming deltas are subscription-scoped now: the host pushes them only to
 * connections whose `stream:watch` set names the session. This hook is what
 * keeps that set equal to "the session this client is looking at", on BOTH
 * surfaces — the desktop and the web client mount the same renderer, so there is
 * one implementation and one place the rule can be wrong.
 *
 * It re-sends on exactly three things, which are the three ways the set can stop
 * being true:
 *
 *  - **mount** — nothing is watched until something asks;
 *  - **selection change** — the previous session's deltas stop being interesting
 *    and the new one's start (REPLACE semantics make this one call);
 *  - **every answered `sync`** — the initial one, a resync, and every reconnect.
 *    A watch set is per-CONNECTION and dies with the socket, so a phone that
 *    backgrounded and came back holds none; `SyncClient.onSyncAnswered` is the
 *    only signal that spans the transports (they own the socket, the store owns
 *    the selection, and neither can see the other).
 *
 * Sessions NOT watched still converge — at message boundaries, over the event
 * lane, exactly as a client that never opened them does. That is the design: the
 * accumulation is a snapshot field, so the coalesced answer always arrives; only
 * the token-by-token animation is scoped.
 *
 * The replica registers its mismatch cure through {@link setStreamRewatch}: an
 * offset/turnId mismatch is healed by re-sending the same set, which the server
 * answers with the coalesced value at `offset: 0`.
 */

import { useEffect, useRef, useState } from 'react'
import { onSyncAnswered } from '../../../shared/sync/client-registry'
import { setStreamRewatch } from '../stores/replica'
import { useSessionStore } from '../stores/session-store'

export function useStreamWatch(): void {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  // Bumped by every answered sync. A counter rather than a boolean, because two
  // reconnects in a row must both re-fire the effect.
  const [connectionGeneration, setConnectionGeneration] = useState(0)
  const latest = useRef<string | null>(activeSessionId)
  latest.current = activeSessionId

  useEffect(() => onSyncAnswered(() => setConnectionGeneration((n) => n + 1)), [])

  useEffect(() => {
    const send = (): void => {
      const sessionIds = latest.current ? [latest.current] : []
      void window.api.watchStreams(sessionIds).catch(() => {
        // An older host (or a refusal) leaves this client on the event lane —
        // message-boundary updates, no live typing. Silent on purpose: a toast
        // for a degraded animation would be noise, and the next answered sync
        // retries anyway.
      })
    }
    send()
    setStreamRewatch(send)
    return () => setStreamRewatch(null)
  }, [activeSessionId, connectionGeneration])
}
