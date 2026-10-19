/**
 * Delivery of items that are not the user's into a session (slice 1a, spec
 * §5.1 / §6.5): another session's message, or an agent's note. Engine-neutral —
 * the wire is one adapter method per engine (`ISession.deliverNonUser`); this
 * module is the RULE.
 *
 *  - target busy → the engine's queue (it joins the running turn);
 *  - target idle, and the item is a `session-message` or carries `wake`, and the
 *    agent-turn budget has room → a turn starts on it;
 *  - target idle without wake / no live session object / engine process gone /
 *    budget spent / the engine could not take it → HELD in the `session_inbox`
 *    table, never lost.
 *
 * Held items go out, oldest first, ahead of the target's next turn of ANY origin
 * ({@link flushHeld}, called from the prompt path and from a delivery that is
 * about to start a turn), through the same adapter, so each engine's own
 * queue/steer carries them.
 *
 * Taint and budget live on the session (`originLedger`); nothing here keeps
 * per-session state of its own except the per-target work chain. The session
 * tools (`session-tools.ts`), context pressure and the prompt path call it.
 */
import type { ISession, NonUserItem } from '../providers/ISession'
import type { SessionManager } from './session-manager'
import {
  addInboxItem,
  heldInboxCount,
  heldInboxItems,
  markInboxDelivered,
  type InboxItem
} from './db'
import { logger } from './logger'
import { emitEvent } from './sync-host'

const LOG = 'SessionDelivery'

/** Most undelivered items one target keeps. Past it, delivery is refused out loud. */
export const HELD_INBOX_CAP = 100
/** Longest body kept or delivered; the rest is cut and says so. */
export const ITEM_BODY_MAX = 20_000
const TRUNCATION_MARKER = '\n[... message truncated ...]'

/** Why an item was held instead of delivered. */
export type HeldWhy =
  'idle-no-wake' | 'no-live-session' | 'engine-exited' | 'budget-exhausted' | 'engine-unavailable'

export type DeliveryResult =
  | { result: 'delivered' }
  | { result: 'queued' }
  | { result: 'held'; why: HeldWhy }
  | { result: 'refused'; why: 'inbox-full' }

/** Read-only view of a live session's taint and agent-turn budget (for slice 1c's gates). */
export interface OriginState {
  userOriginClean: boolean
  agentTurnStartsSinceUser: number
  agentTurnBudget: number
}

export function sessionOriginState(manager: SessionManager, routingId: string): OriginState | null {
  const ledger = manager.get(routingId)?.originLedger
  if (!ledger) return null
  return {
    userOriginClean: ledger.userOriginClean,
    agentTurnStartsSinceUser: ledger.agentTurnStartsSinceUser,
    agentTurnBudget: ledger.cap
  }
}

/**
 * One chain of work per target. A delivery and a flush both read the held rows,
 * await the engine, and only then mark them delivered; two of them overlapping
 * would deliver the same row twice. Every entry point below joins the target's
 * chain, so they run one after another.
 */
const chains = new Map<string, Promise<unknown>>()
// Two properties worth knowing. The chain inherits the engines' request timeouts:
// a hung opencode server delays that target's later deliveries (and the user's
// prompt, which joins the chain only while the inbox is non-empty) until the
// client times out — the same bound the user's own steers have. And it is keyed by
// the id the caller passed: across the one status that rekeys a session, a flush
// under the old id and a delivery under the new one run on different chains;
// rows are marked delivered by row id, so that cannot repeat a row on its own.

function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
  const run = (chains.get(key) ?? Promise.resolve()).then(work, work)
  const tail = run.catch(() => {})
  chains.set(key, tail)
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key)
  })
  return run
}

function cappedBody(text: string): string {
  return text.length > ITEM_BODY_MAX
    ? text.slice(0, ITEM_BODY_MAX - TRUNCATION_MARKER.length) + TRUNCATION_MARKER
    : text
}

/**
 * Deliver `item` to `target` (a routing id for now; slice 1b passes refs). Never
 * throws for an item that cannot be delivered: it is held and the result says
 * why — or refused, when the target's inbox is full.
 *
 * A message never brings a closed session back: an idle target whose engine
 * process is gone holds it (`engine-exited`) until the user's next prompt, which
 * has already re-read the transcript before it respawns.
 */
export function deliver(
  manager: SessionManager,
  target: string,
  item: NonUserItem
): Promise<DeliveryResult> {
  return serialized(target, () =>
    deliverNow(manager, target, { ...item, text: cappedBody(item.text) })
  )
}

async function deliverNow(
  manager: SessionManager,
  target: string,
  item: NonUserItem
): Promise<DeliveryResult> {
  const session = manager.get(target)
  if (!session?.deliverNonUser) return hold(manager, target, item, 'no-live-session')
  const ledger = session.originLedger

  let leadStarted = false
  if (!session.willQueue) {
    if (session.isEngineLive && !session.isEngineLive()) {
      return hold(manager, target, item, 'engine-exited')
    }
    if (item.origin !== 'session-message' && !item.wake) {
      return hold(manager, target, item, 'idle-no-wake')
    }
    if (ledger && !ledger.budgetLeft) {
      if (ledger.noteBudgetExhausted()) {
        // The audited form (method `agent`) comes with the session tools.
        logger.warn(
          LOG,
          `agent-turn budget (${ledger.cap} turns since the user last spoke) spent for ${target}: holding ${item.origin} from ${item.from.key}`
        )
      }
      return hold(manager, target, item, 'budget-exhausted')
    }
    // Older held items lead: this item then joins the turn they start.
    if (hasHeld(session, target)) {
      leadStarted = await flushNow(manager, target)
      if (leadStarted) ledger?.agentTurnStarted()
      // The flush stopped at a row the engine would not take: this item must not
      // overtake it.
      if (hasHeld(session, target)) return hold(manager, target, item, 'engine-unavailable')
    }
  }

  const outcome = await session.deliverNonUser(item)
  if (outcome === 'unavailable') return hold(manager, target, item, 'engine-unavailable')
  ledger?.nonUserDelivered()
  if (outcome === 'started') {
    ledger?.agentTurnStarted()
    return { result: 'delivered' }
  }
  return { result: leadStarted ? 'delivered' : 'queued' }
}

/**
 * Deliver everything held for this session, oldest first, as the leading items of
 * a turn. Called when the user's prompt is about to start one and from
 * {@link deliver} before it starts a turn on a newer item. The first item starts
 * the turn (`wake` is forced), the rest join it through the engine's queue/steer
 * path. Stops at the first item the engine cannot take; the rest stay held.
 * Returns whether a turn was started. Unlike {@link deliver} it does not check
 * that the engine is alive: the user speaking is what brings it back.
 */
export function flushHeld(manager: SessionManager, routingId: string): Promise<boolean> {
  return serialized(routingId, () => flushNow(manager, routingId))
}

async function flushNow(manager: SessionManager, routingId: string): Promise<boolean> {
  const session = manager.get(routingId)
  if (!session?.deliverNonUser) return false
  let started = false
  try {
    for (const row of heldFor(session, routingId)) {
      const outcome = await session.deliverNonUser({
        origin: row.origin,
        text: row.body,
        from: { key: row.fromKey, title: row.fromTitle },
        wake: true,
        ...(row.senderModeClass ? { senderModeClass: row.senderModeClass } : {})
      })
      if (outcome === 'unavailable') break
      markInboxDelivered(row.id)
      session.originLedger?.nonUserDelivered()
      if (outcome === 'started') started = true
    }
  } catch (err) {
    logger.warn(LOG, `flushing the held inbox of ${routingId} failed: ${errText(err)}`)
  } finally {
    emitHeldCount(routingId, session)
  }
  return started
}

/** Does this session have items waiting? (A fresh DB read; false when the DB is unavailable.) */
export function hasHeld(session: ISession, routingId: string): boolean {
  try {
    return heldFor(session, routingId).length > 0
  } catch {
    return false
  }
}

/** Held rows under every key the session answers to (its routing id and its engine session id). */
function heldFor(session: ISession, routingId: string): InboxItem[] {
  const keys = new Set([routingId])
  const engineId = session.getSessionId?.()
  if (engineId) keys.add(engineId)
  return [...keys].flatMap((key) => heldInboxItems(key)).sort((a, b) => a.id - b.id)
}

function inboxRow(target: string, item: NonUserItem): Parameters<typeof addInboxItem>[0] {
  return {
    target,
    origin: item.origin,
    fromKey: item.from.key,
    fromTitle: item.from.title,
    senderModeClass: item.senderModeClass ?? null,
    body: item.text
  }
}

function hold(
  manager: SessionManager,
  target: string,
  item: NonUserItem,
  why: HeldWhy
): DeliveryResult {
  if (heldInboxCount(target) >= HELD_INBOX_CAP) {
    logger.warn(
      LOG,
      `inbox of ${target} is full (${HELD_INBOX_CAP}): refusing ${item.origin} from ${item.from.key}`
    )
    return { result: 'refused', why: 'inbox-full' }
  }
  addInboxItem(inboxRow(target, item))
  emitHeldCount(target, manager.get(target))
  return { result: 'held', why }
}

/**
 * Put an item an engine took but never read back into the inbox (the process
 * died, cli.js refused it). The caller was told "delivered", so the cap does not
 * apply: dropping it would be the silent loss the inbox exists to prevent.
 */
export function reholdNonUserItem(session: ISession, item: NonUserItem): void {
  addInboxItem(inboxRow(session.routingId, item))
  emitHeldCount(session.routingId, session)
}

/** Replicate the held count of a live session (a no-op for one canonical does not know). */
export function emitHeldCount(routingId: string, session: ISession | undefined): void {
  if (!session) return
  let count = 0
  try {
    count = heldFor(session, routingId).length
  } catch (err) {
    logger.warn(LOG, `held count of ${routingId} unavailable: ${errText(err)}`)
    return
  }
  emitEvent('session:held-changed', [routingId, { count }])
}

/** The count for a key with no live session (a resumed session's birth). */
export function heldCountFor(key: string): number {
  try {
    return heldInboxCount(key)
  } catch {
    return 0
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
