/**
 * The flush of held X-Agent results (ADR-105 §3): "delivered when the parent is live
 * again".
 *
 * An X-Agent that ends while its parent is not live (no session object, the engine down, a
 * cap reached) leaves its result in the parent's inbox (`session_inbox`, origin
 * `dispatch-result`). Nothing but the user's next prompt flushed that inbox before; this
 * adds the one edge that means "the parent's engine is up and idle again":
 *
 *   the first `session:status` with state `idle`, from a session object whose
 *   `isEngineLive()` is true, after the session was armed by
 *     - a `disconnected` status (its engine went down: an idle timeout, an account
 *       switch or effort respawn, a Disconnect),
 *     - a `session:created` (a new object for the id: a respawn or a reopen), or
 *     - a hold of one of its results (the cap, a refused steer).
 *
 * Evidence (a real `ClaudeSession` on a fake cli.js, `dispatch-result-flush.component.test.ts`):
 * the new object's constructor emits `idle` while `isEngineLive()` is still false, a spawn
 * emits `idle` again once cli.js answered `initialize` (live), `cancel()` emits
 * `disconnected` (not live), and the respawn emits `idle` (live) again. So the constructor's
 * status is skipped (the engine is not up) and the first live `idle` flushes. A reopened
 * session spawns nothing until the user's prompt, whose own flush then delivers the inbox
 * before the engine starts: "a message never resumes a closed session" (ADR-104 §6) stays
 * true — the flush follows the user's action that brought the parent back, never a
 * delivery of its own.
 *
 * De-dup: the edge disarms the session before it flushes, and the flush runs on the
 * target's delivery chain, so a user prompt's flush and this one cannot deliver a row twice
 * (rows are marked delivered by id, under the same chain). A flush stops at the dispatch
 * wake cap; the rest waits for the user's next prompt.
 */
import type { SessionManager } from './session-manager'
import { deliver, flushHeldDispatchResults, hasHeldDispatchResults } from './session-delivery'
import type { DispatchResultItem, DispatchResultOutcome } from './dispatch-parent'
import { logger } from './logger'

type HostObserver = (channel: string, args: unknown[]) => void

export interface DispatchResultFlush {
  /** Open the edge for a session (a result was held for it). */
  arm(routingId: string): void
  /** The armed ids (tests). */
  armed(): string[]
  stop(): void
}

/**
 * An X-Agent's end into its parent's inbox, as the dispatcher's lookup hands it over
 * (`DispatchParentLookup.deliver`, wired in `core-services.ts`): origin `dispatch-result`,
 * waking, through the one delivery rule. A hold arms the flush edge for that parent.
 */
export async function deliverDispatchResult(
  manager: SessionManager,
  flush: Pick<DispatchResultFlush, 'arm'>,
  parentId: string,
  item: DispatchResultItem
): Promise<DispatchResultOutcome> {
  const outcome = await deliver(manager, parentId, {
    origin: 'dispatch-result',
    wake: true,
    from: item.from,
    text: item.text,
    ...(item.reportRun !== undefined ? { reportRun: item.reportRun } : {})
  })
  if (outcome.result === 'held') flush.arm(parentId)
  return outcome
}

export function watchDispatchResultFlush(
  manager: SessionManager,
  addObserver: (observer: HostObserver) => () => void
): DispatchResultFlush {
  // Ids armed and not yet live. Bounded by the sessions of this process: a deleted one leaves
  // (`session:removed`), a re-keyed one moves (the status that re-keys it), and an id that
  // never comes up again costs one string until the process ends.
  const armed = new Set<string>()

  const onEvent: HostObserver = (channel, args) => {
    const first = args[0]
    if (typeof first !== 'string') return
    let id: string = first
    try {
      if (channel === 'session:created') {
        armed.add(id)
        return
      }
      if (channel === 'session:removed') {
        armed.delete(id)
        return
      }
      if (channel !== 'session:status') return
      const status = args[1] as { state?: string; sessionId?: string | null } | undefined
      // The status that re-keys a session (its engine id differs from the id it was created
      // under) moves its armed edge to the new id; the manager follows it in the same tick.
      if (status?.sessionId && status.sessionId !== id && armed.delete(id)) {
        armed.add(status.sessionId)
        id = status.sessionId
      }
      const state = status?.state
      if (state === 'disconnected') {
        armed.add(id)
        return
      }
      if (state !== 'idle' || !armed.has(id)) return
      // The manager may still answer to the id the session was created under in the tick
      // its re-keying status arrives: ask for either.
      const key = manager.get(id) ? id : first
      const session = manager.get(key)
      // The constructor of a new object says `idle` before any engine exists: not the edge.
      if (!session || session.isEngineLive?.() !== true) return
      armed.delete(id)
      if (!hasHeldDispatchResults(session, key)) return
      void flushHeldDispatchResults(manager, key).catch((err) =>
        logger.warn('DispatchResultFlush', `flush for ${key} failed: ${String(err)}`)
      )
    } catch (err) {
      logger.warn('DispatchResultFlush', `"${channel}" observer failed: ${String(err)}`)
    }
  }

  const stop = addObserver(onEvent)
  return {
    arm: (routingId) => void armed.add(routingId),
    armed: () => [...armed],
    stop
  }
}
