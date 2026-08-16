/**
 * `stream:watch` — the volatile lane's subscription verb (SyncCore phase 5 S1).
 *
 * ONE declaration, spread by both transport registrars (`session.ipc.ts` for the
 * desktop port, `remote-handlers.ts` for the WebSocket), so the two surfaces
 * cannot drift about its capability, kind or shape — the registry throws on a
 * disagreement, and this is what keeps the throw unreachable.
 *
 * **A query, not a command.** Phase 1 pre-decided this: a subscription toggle has
 * no domain effect, so it is unaudited (sync-core.md contract 4). That is the
 * opposite of `terminal:attach`, which is a subscription toggle declared
 * `command` purely because security.md §Audit requires terminal lifecycle with
 * identity — there is no such requirement for "which session is this phone
 * looking at", and a row per navigation would bury the commands that matter.
 *
 * **`chat`, the base remote surface.** Watching a session's deltas reveals
 * nothing a `sync-full` would not already hand the same connection: the
 * accumulation IS a snapshot field. Anything stronger would mean a client could
 * read the coalesced answer but not watch it arrive. The S2 tails do not change
 * that: all three were `replicated` events until S2, so every authenticated
 * connection already received every one of them unasked — the lane makes that
 * strictly narrower, never wider.
 *
 * **Read-class, by construction.** `classifyDispatch` maps a non-`shell` `query`
 * to `read`, which `evaluateStepUp` allows on every tier and refreshes NOTHING —
 * the same rule `terminal:pool` relies on (sync-core.md §Terminal: "that focus
 * re-ask is also why the query must not feed the grant decay"). The watch effect
 * re-fires on every reconnect and every session switch, so a refreshing read here
 * would let an idle tab renew its own step-up window forever.
 */

import { MAX_STREAM_WATCH } from '../../shared/sync/stream'
import { setStreamWatch } from '../services/sync-host'
import type { CommandConnection, CommandRegistration } from './command-registry'

/**
 * Validate ONE replace-set from the payload. Bounded like the terminal pool
 * index, and for the same reason: this array's length is chosen by a remote
 * client and the result is held for the socket's lifetime, so an unbounded one is
 * a main-process memory bomb reachable from a single frame. REFUSED rather than
 * truncated — a silently-clipped set would leave the client believing it is
 * watching things it is not.
 */
function watchSet(raw: unknown, field: string, noun: string): string[] {
  if (!Array.isArray(raw)) {
    throw new Error(`stream:watch: ${field} must be an array`)
  }
  if (raw.length > MAX_STREAM_WATCH) {
    throw new Error(`stream:watch: at most ${MAX_STREAM_WATCH} ${noun} may be watched at once`)
  }
  const ids = raw.filter((id): id is string => typeof id === 'string' && id !== '')
  if (ids.length !== raw.length) {
    throw new Error(`stream:watch: ${field} must be non-empty strings`)
  }
  return ids
}

/**
 * Replace this connection's watch sets, then push the replay.
 *
 * REPLACE, never additive: the client sends the set it wants and never has to
 * remember what it asked for last, which is also what makes re-sending the same
 * set the cure for an offset/turnId mismatch.
 *
 * **`automationRuns` is a SECOND, independently-replaced set** (phase 5 S2) —
 * the scope `automation:stream-event` is filtered by. Optional, and omitting it
 * leaves the automation set untouched rather than clearing it: absence is
 * silence. Sending `[]` is how a client stops watching automations.
 *
 * Its entries are AUTOMATION ids, not run ids. The emission carries
 * `{automationId, type, text}` and no run identity, so run-level scoping would
 * have to be invented here; the renderer already narrows to the viewed run from
 * its own store. Recorded in docs/architecture/sync-channels.md as the coarser
 * granularity it is.
 */
export function handleStreamWatch(
  connection: CommandConnection,
  payload: { sessionIds?: unknown; automationRuns?: unknown } | undefined
): void {
  const sessionIds = watchSet(payload?.sessionIds, 'sessionIds', 'sessions')
  const automationRuns =
    payload?.automationRuns === undefined
      ? undefined
      : watchSet(payload.automationRuns, 'automationRuns', 'automations')
  setStreamWatch(connection.connectionId, sessionIds, { automationRuns })
}

/** The transport-agnostic half of the registration. */
export const STREAM_WATCH_COMMAND: Omit<CommandRegistration, 'transport'> = {
  channel: 'stream:watch',
  capability: 'chat',
  kind: 'query',
  withConnection: true,
  handler: handleStreamWatch
}
