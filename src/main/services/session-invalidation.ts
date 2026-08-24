/**
 * "The credential these engine processes hold is stale" — main-side.
 *
 * Two events invalidate every running engine process's cached credential: a
 * multi-account switch (`AccountManager.persistAndApply` re-points
 * `CLAUDE_SECURESTORAGE_CONFIG_DIR`) and a successful native OAuth login
 * (`AuthManager.finalize`). Both used to be handled ONLY by asking the desktop
 * renderer to flip its own `sdkActive` flags — `account:respawn-sessions` /
 * `auth:state`, both `host-local` — which had two defects:
 *
 *  1. **The processes kept running.** Nothing stopped the cli.js / opencode / pi
 *     child that had already cached the OLD credential; it stayed live and would
 *     happily serve the next turn on the account the user just switched away
 *     from. The flag only changed what the UI *said*.
 *  2. **Only the desktop learned about it.** A phone or a second window went on
 *     showing `sdkActive: true`, and a resync re-asserted it from canonical —
 *     which never heard about the switch at all, because a host-local channel
 *     neither rings nor folds.
 *
 * Cancelling MAIN-SIDE fixes both at once and needs no new channel: `cancel()`
 * broadcasts a `session:status` with `state: 'disconnected'`, which the shared
 * reducer folds to `sdkActive: false` + dropped approvals on every replica
 * (`shared/sync/reducer.ts`, the `disconnected` branch) and in canonical, so a
 * client that reconnects afterwards is told the same thing a live one saw.
 *
 * The desktop respawn UX is unchanged: `account:respawn-sessions` still fires,
 * the renderer still runs `respawnAllSessions()`, and the next send still
 * spawns a fresh backend that re-reads the new credential. That local write is
 * now idempotent with the fold rather than the only thing that happens.
 *
 * ## Why an injected callback rather than an import
 *
 * The live sessions live in the `SessionManager` that `registerSessionIpc()`
 * builds. Importing it here would drag `ipc/session.ipc.ts` — and with it half
 * the service graph — into two leaf services that are unit-tested with almost
 * nothing mocked. `bootCore()` already sits above both cycles and owns the
 * manager, so it is the one place that can close the loop (the same reasoning
 * `boot-core.ts` records for `setCallerSessionLookup`).
 */

import { logger } from '../../core/services/logger'

const LOG_SOURCE = 'session-invalidation'

/** The bit of `SessionManager` this module needs — kept structural so the policy
 *  below is testable without building a real manager or an Electron window. */
interface CancellableSessions {
  forEach(fn: (session: { engineId: string; cancel(): void }) => void): void
}

/**
 * Cancel every live CLAUDE session — the policy both triggers actually want.
 *
 * Scope is deliberately narrow. An account switch re-points
 * `CLAUDE_SECURESTORAGE_CONFIG_DIR` and a successful login replaces the Anthropic
 * OAuth token; neither touches opencode's or pi's vendor credentials (ADR-036).
 * Killing a pi turn because the user switched Claude accounts destroys work for
 * no reason, so engine is checked per session.
 *
 * `forEach` + `cancel`, never `SessionManager.cancelAll()`: `cancelAll` also
 * CLEARS the registry map, which would drop the very opencode/pi session objects
 * nothing re-creates (the renderer's respawn only re-spawns what its own store
 * lists, and `manager.get()` would return undefined for the rest). `cancel()`
 * leaves each object usable for a later `run()`.
 */
export function cancelClaudeSessions(manager: CancellableSessions): void {
  manager.forEach((session) => {
    if (session.engineId === 'claude') session.cancel()
  })
}

let canceller: (() => void) | null = null

/**
 * Publish the "stop every live session" action. Called once from `bootCore()`
 * with the process-wide `SessionManager`; `null` clears it (test teardown).
 */
export function setLiveSessionCanceller(fn: (() => void) | null): void {
  canceller = fn
}

/**
 * Stop every live engine process because the credential it cached is no longer
 * the one the app would spawn with.
 *
 * Best-effort by construction: a windowless-but-not-yet-booted process (or a
 * unit test that never wired the canceller) simply has no sessions to stop, and
 * an auth flow must never fail because of it.
 */
export function invalidateLiveSessions(reason: string): void {
  if (!canceller) {
    logger.debug(LOG_SOURCE, `no session canceller wired; nothing to invalidate (${reason})`)
    return
  }
  logger.info(LOG_SOURCE, `cancelling live sessions: ${reason}`)
  try {
    canceller()
  } catch (err) {
    logger.warn(LOG_SOURCE, `session cancellation failed (${reason})`, err)
  }
}
