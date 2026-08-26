import type { HostWindowHandle } from '../host'
import type { ChatMessage, EngineId } from '../../shared/types'
import type { ISession, EngineSpawnOptions } from '../providers/ISession'
import { engineRegistry } from '../providers/EngineRegistry'
// Side-effect: registers all engine factories (claude, …) at module load time
import '../providers/register-engines'
import { loadSessionHistory } from './session-history'
import { cwdToProjectKey } from '../../shared/project-key'
import { renameDispatchedUsage } from './db'
import { logger } from './logger'
import { syncCore } from './sync-host'

/**
 * Unsubscribe for whichever SessionManager currently owns core's rekeys.
 *
 * Module-level because the ownership is exclusive: `registerSessionIpc` builds a
 * fresh manager, and it re-runs when macOS re-creates the window after every
 * window has been closed. Without superseding, each new manager would STACK a
 * subscription and every rekey would also be applied to the abandoned managers —
 * which still hold their own session objects, so it would re-key state nothing
 * owns any more.
 */
let activeRekeyUnsubscribe: (() => void) | null = null

export class SessionManager {
  private sessions = new Map<string, ISession>()
  private _sessionTimeoutMs = 15 * 60 * 1000 // default 15 min, 0 = disabled
  /** Unsubscribes this manager from core's rekey notifications. */
  private readonly unsubscribeRekey: () => void

  constructor() {
    // SyncCore phase 4a item 7 — REKEY OWNERSHIP MOVED INTO CORE.
    //
    // Before this, every client reacted to `session:status` by invoking
    // `session:rekey` (useClaudeEvents.ts; web via api-adapter): N clients firing
    // N duplicate invokes at the main process, correct only because
    // {@link rekey} happens to be idempotent. Core now applies the SAME
    // status-driven rule to its canonical state and tells the registry, in the
    // same tick, right after the append — so the ordering invariant holds: no
    // event carrying the NEW routingId can enter the ring before the
    // `session:status` event that introduces it, which is what lets every
    // replica rekey purely from the stream.
    //
    // The `session:rekey` channel survives as an idempotent no-op shim; removing
    // its client call sites is 4c.
    activeRekeyUnsubscribe?.()
    this.unsubscribeRekey = syncCore.onRekey((oldId, newId) => this.rekey(oldId, newId))
    activeRekeyUnsubscribe = this.unsubscribeRekey
  }

  /** Detach from core's rekey notifications (test teardown / app shutdown). */
  disposeRekeyObserver(): void {
    this.unsubscribeRekey()
  }

  /** Update the idle timeout for all current and future sessions. */
  setSessionTimeout(ms: number): void {
    this._sessionTimeoutMs = ms
    this.sessions.forEach((session) => session.setInactivityTimeout(ms))
  }

  create(
    routingId: string,
    /** Host handle for the session (voice capture); `null` when windowless — phase 4d. */
    win: HostWindowHandle | null,
    cwd: string,
    opts: EngineSpawnOptions = {},
    engineId: EngineId = 'claude'
  ): ISession {
    // Clean up existing session with same routingId. dispose() (not cancel()):
    // the old object is being PERMANENTLY replaced under this routingId, so it
    // must be fenced from ever touching the shared routingId again — its late
    // run()-finally must not re-emit status or re-arm an idle timer whose later
    // cancel() would broadcast disconnected for, and disposeFor(), the LIVE
    // replacement session (M-CL3). cancel() leaves the object usable for a
    // later run() and so does NOT set that fence; dispose() does.
    const existing = this.sessions.get(routingId)
    if (existing) {
      existing.dispose()
    }

    const session = engineRegistry.createSession(engineId, routingId, win, cwd, opts)
    session.setInactivityTimeout(this._sessionTimeoutMs)
    this.sessions.set(routingId, session)
    return session
  }

  get(routingId: string): ISession | undefined {
    return this.sessions.get(routingId)
  }

  has(routingId: string): boolean {
    return this.sessions.has(routingId)
  }

  rekey(oldId: string, newId: string): void {
    const session = this.sessions.get(oldId)
    if (!session) return
    // routingId is readonly on ISession (callers must not mutate it), but the
    // concrete BaseSession field is mutable. Cast here is safe — this is the
    // one legitimate place that updates the routing id after session-uuid arrival.
    ;(session as { routingId: string }).routingId = newId
    this.sessions.delete(oldId)
    this.sessions.set(newId, session)

    // Slice C (ADR-033 cross-engine dispatch): carry any dispatched_usage
    // rows recorded under the pre-rekey id forward, so a later resume's
    // seedDispatchedCosts() (keyed by the STABLE post-rekey id) can find them.
    // Best-effort — a DB hiccup here must never break session rekeying.
    try {
      renameDispatchedUsage(oldId, newId)
    } catch (err) {
      logger.warn(
        'SessionManager',
        `renameDispatchedUsage failed (dispatched-cost rows may be orphaned): ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  cancel(routingId: string): void {
    const session = this.sessions.get(routingId)
    if (session) {
      session.cancel()
    }
  }

  async interrupt(routingId: string): Promise<void> {
    const session = this.sessions.get(routingId)
    if (session) {
      await session.interrupt()
    }
  }

  cancelAll(): void {
    this.sessions.forEach((session) => session.cancel())
    this.sessions.clear()
  }

  /** Update the idle timeout for a specific session by routingId. Pass 0 to disable. */
  setInactivityTimeout(routingId: string, ms: number): void {
    const session = this.sessions.get(routingId)
    if (session) {
      session.setInactivityTimeout(ms)
    }
  }

  /** Get the SDK session UUID for a session identified by routingId. */
  getSessionId(routingId: string): string | null {
    return this.sessions.get(routingId)?.getSessionId() ?? null
  }

  /**
   * Get message history for a session by sessionId.
   * Returns in-memory messages if the session is active, otherwise loads from disk.
   */
  async getMessages(sessionId: string, cwd: string): Promise<ChatMessage[]> {
    // Try in-memory first
    for (const session of this.sessions.values()) {
      if (session.getSessionId() === sessionId) {
        return session.getMessages()
      }
    }
    // Fall back to disk
    const projectKey = cwdToProjectKey(cwd)
    const result = await loadSessionHistory(sessionId, projectKey)
    return result.messages
  }

  /** Iterate all active sessions (engine-neutral). */
  forEach(fn: (session: ISession) => void): void {
    this.sessions.forEach(fn)
  }
}
