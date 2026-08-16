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
 * S2 added the TAILS to the same lane, in two scopes: the two session tails ride
 * the session set above, and `automation:stream-event` rides an automation set
 * this hook sends alongside it. Tails have no accumulation, so an unwatched one
 * does not converge — it is simply not seen, and the transcript is completed by
 * the tool_result / run-message on the event lane.
 *
 * The replica registers its mismatch cure through {@link setStreamRewatch}: an
 * offset/turnId mismatch is healed by re-sending the same set, which the server
 * answers with the coalesced value at `offset: 0`.
 */

import { useEffect, useRef, useState } from 'react'
import { onSyncAnswered } from '../../../shared/sync/client-registry'
import { setStreamRewatch } from '../stores/replica'
import { useAutomationStore } from '../stores/automation-store'
import { useSessionStore } from '../stores/session-store'

export function useStreamWatch(): void {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  // The AUTOMATION scope (phase 5 S2). Sent from the SAME effect rather than from
  // a second hook next to the automation listeners: `stream:watch` replaces the
  // set it is given, so two independent senders would each have to know about the
  // other's scope to avoid clearing it. One caller, one statement of what this
  // client is looking at.
  const selectedAutomationId = useAutomationStore((s) => s.selectedAutomationId)
  // Bumped by every answered sync. A counter rather than a boolean, because two
  // reconnects in a row must both re-fire the effect.
  const [connectionGeneration, setConnectionGeneration] = useState(0)
  const latest = useRef<{ session: string | null; automation: string | null }>({
    session: activeSessionId,
    automation: selectedAutomationId
  })
  latest.current = { session: activeSessionId, automation: selectedAutomationId }

  useEffect(() => onSyncAnswered(() => setConnectionGeneration((n) => n + 1)), [])

  useEffect(() => {
    const send = (): void => {
      const sessionIds = latest.current.session ? [latest.current.session] : []
      const automationIds = latest.current.automation ? [latest.current.automation] : []
      void window.api.watchStreams(sessionIds, automationIds).catch(() => {
        // An older host (or a refusal) leaves this client on the event lane —
        // message-boundary updates, no live typing. Silent on purpose: a toast
        // for a degraded animation would be noise, and the next answered sync
        // retries anyway.
      })
    }
    send()
    setStreamRewatch(send)
    return () => setStreamRewatch(null)
  }, [activeSessionId, selectedAutomationId, connectionGeneration])
}
