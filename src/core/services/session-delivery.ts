/**
 * Delivery of items that are not the user's into a session (slice 1a, spec
 * §5.1 / §6.5): another session's message, or an agent's note. Engine-neutral —
 * the wire is one adapter method per engine (`ISession.deliverNonUser`); this
 * module is the RULE.
 *
 *  - target busy → the engine's queue (it joins the running turn);
 *  - target idle, and the item is a `session-message` or carries `wake`, and the
 *    agent-turn budget has room → a turn starts on it;
 *  - an X-Agent's result (`dispatch-result`, ADR-105 §3) wakes like a session message but
 *    outside that budget: it has its own cap of wakes since the user last spoke;
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
import {
  X_AGENT_KEY_PREFIX,
  X_AGENT_MESSAGE_KEY_PREFIX,
  isXAgentMessageSender,
  wrapperSender
} from '../../shared/session-message-wrapper'
import { DISPATCH_WAKE_CAP } from '../providers/turn-origin-ledger'
import type { SessionManager } from './session-manager'
import {
  addInboxItem,
  heldInboxCount,
  heldInboxItems,
  markInboxDelivered,
  markDispatchReportDelivered,
  type InboxItem
} from './db'
import { logger } from './logger'
import { emitEvent } from './sync-host'

const LOG = 'SessionDelivery'

/** Most undelivered items one target keeps. Past it, delivery is refused out loud (an X-Agent's result is never refused: see `hold`). */
export const HELD_INBOX_CAP = 100
/** Longest body kept or delivered; the rest is cut and says so. */
export const ITEM_BODY_MAX = 20_000
const TRUNCATION_MARKER = '\n[... message truncated ...]'

/** Why an item was held instead of delivered. */
export type HeldWhy =
  | 'idle-no-wake'
  | 'no-live-session'
  | 'engine-exited'
  | 'budget-exhausted'
  | 'dispatch-cap'
  | 'engine-unavailable'

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
    // An X-Agent's result is always held and framed under its prefixed sender key.
    deliverNow(manager, target, { ...item, from: wrapperSender(item), text: cappedBody(item.text) })
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
    if (item.origin === 'dispatch-result') {
      // Its own cap, not the agent-turn budget: an X-Agent's result is the session's own
      // work coming back. Past the cap it waits for the user's next prompt.
      if (ledger && !ledger.dispatchWakesLeft) {
        if (ledger.noteDispatchCapReached()) {
          logger.warn(
            LOG,
            `dispatch-result cap (${DISPATCH_WAKE_CAP} wakes since the user last spoke) reached for ${target}: holding ${item.from.key}`
          )
        }
        return hold(manager, target, item, 'dispatch-cap')
      }
    } else if (ledger && !ledger.budgetLeft) {
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
      leadStarted = await flushNow(manager, target, { countStart: true })
      // The flush stopped at a row the engine would not take: this item must not
      // overtake it.
      if (hasHeld(session, target)) return hold(manager, target, item, 'engine-unavailable')
    }
  }

  const outcome = await session.deliverNonUser(item)
  if (outcome === 'unavailable') return hold(manager, target, item, 'engine-unavailable')
  ledger?.nonUserDelivered()
  if (outcome === 'started') {
    countStart(ledger, item.origin)
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

/** A turn a non-user item started: an X-Agent's result counts against its own cap, the rest against the budget. */
function countStart(ledger: ISession['originLedger'], origin: NonUserItem['origin']): void {
  if (origin === 'dispatch-result') ledger?.dispatchWakeStarted()
  else ledger?.agentTurnStarted()
}

interface FlushOptions {
  /** Count a turn the flush starts (a delivery that leads with older items; not the user's own prompt). */
  countStart?: boolean
  /** Deliver only the rows of this origin, oldest first (the rest stay held, in order). */
  only?: NonUserItem['origin']
  /** Stop before a row the session's cap would not let start a turn (an X-Agent result flush). */
  respectCap?: boolean
}

async function flushNow(
  manager: SessionManager,
  routingId: string,
  options: FlushOptions = {}
): Promise<boolean> {
  const session = manager.get(routingId)
  if (!session?.deliverNonUser) return false
  let started = false
  try {
    const held = heldFor(session, routingId)
    const carried = options.only
      ? messagesBeforeResults(session, held, options.only)
      : new Set<number>()
    for (const row of held) {
      if (options.only && row.origin !== options.only && !carried.has(row.id)) continue
      // A row that would start a turn past its cap stays held: the cap resets with the
      // user's next prompt, and that prompt's own flush then takes it.
      if (options.respectCap && !started && !carried.has(row.id) && !capLeft(session, row.origin))
        break
      const outcome = await session.deliverNonUser({
        origin: row.origin,
        text: row.body,
        from: { key: row.fromKey, title: row.fromTitle },
        wake: true,
        ...(row.senderModeClass ? { senderModeClass: row.senderModeClass } : {})
      })
      if (outcome === 'unavailable') break
      markInboxDelivered(row.id)
      if (row.origin === 'dispatch-result') stampReportDelivered(row)
      session.originLedger?.nonUserDelivered()
      if (outcome === 'started') {
        started = true
        if (options.countStart) countStart(session.originLedger, row.origin)
      }
    }
  } catch (err) {
    logger.warn(LOG, `flushing the held inbox of ${routingId} failed: ${errText(err)}`)
  } finally {
    emitHeldCount(routingId, session)
  }
  return started
}

/**
 * The held messages an X-Agent sent BEFORE a held result of its own (ADR-105 §4): a flush that
 * delivers only results must not put the result ahead of the question that preceded it. They ride
 * along in arrival order, only while the session still has agent-turn budget (a message counts in it,
 * and the result's own cap does not lift that); the rest of the inbox waits for the user's prompt.
 */
function messagesBeforeResults(
  session: ISession,
  held: InboxItem[],
  only: NonUserItem['origin']
): Set<number> {
  const lastResult = new Map<string, number>()
  for (const row of held) {
    if (row.origin !== only || !row.fromKey.startsWith(X_AGENT_KEY_PREFIX)) continue
    lastResult.set(row.fromKey.slice(X_AGENT_KEY_PREFIX.length), row.id)
  }
  const out = new Set<number>()
  if (lastResult.size === 0 || !capLeft(session, 'session-message')) return out
  for (const row of held) {
    if (row.origin !== 'session-message' || !isXAgentMessageSender(row.fromKey)) continue
    const last = lastResult.get(row.fromKey.slice(X_AGENT_MESSAGE_KEY_PREFIX.length))
    if (last !== undefined && row.id < last) out.add(row.id)
  }
  return out
}

/**
 * A held X-Agent result went out: the report row of exactly its run (the row carries the run
 * number, the sender key is the X-Agent's ledger id) is stamped delivered. A row with no run
 * (an interrupted-at-quit notice) stamps nothing.
 */
function stampReportDelivered(row: InboxItem): void {
  if (row.reportRun === null) return
  try {
    const targetId = row.fromKey.startsWith(X_AGENT_KEY_PREFIX)
      ? row.fromKey.slice(X_AGENT_KEY_PREFIX.length)
      : row.fromKey
    markDispatchReportDelivered(targetId, row.reportRun)
  } catch (err) {
    logger.warn(LOG, `could not stamp the report of ${row.fromKey} delivered: ${errText(err)}`)
  }
}

function capLeft(session: ISession, origin: NonUserItem['origin']): boolean {
  const ledger = session.originLedger
  if (!ledger) return true
  return origin === 'dispatch-result' ? ledger.dispatchWakesLeft : ledger.budgetLeft
}

/**
 * Deliver the X-Agent results held for this session (ADR-105 §3), waking it: the flush a
 * session coming back up triggers (`dispatch-result-flush.ts`). Other held items stay held
 * for the user's next prompt, as before. Stops at the wake cap. Returns whether a turn
 * was started.
 */
export function flushHeldDispatchResults(
  manager: SessionManager,
  routingId: string
): Promise<boolean> {
  return serialized(routingId, () =>
    flushNow(manager, routingId, { only: 'dispatch-result', respectCap: true, countStart: true })
  )
}

/** Does this session have X-Agent results waiting? (A fresh DB read; false when the DB is unavailable.) */
export function hasHeldDispatchResults(session: ISession, routingId: string): boolean {
  try {
    return heldFor(session, routingId).some((row) => row.origin === 'dispatch-result')
  } catch {
    return false
  }
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
    body: item.text,
    ...(item.reportRun !== undefined ? { reportRun: item.reportRun } : {})
  }
}

function hold(
  manager: SessionManager,
  target: string,
  item: NonUserItem,
  why: HeldWhy
): DeliveryResult {
  // An X-Agent result is bounded by the number of runs and is the only trace of the run the
  // parent model will ever get: it is never refused for capacity (as a given-back item is not).
  if (item.origin !== 'dispatch-result' && heldInboxCount(target) >= HELD_INBOX_CAP) {
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
