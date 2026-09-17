/**
 * Render-loss detector — audit the projection at every turn end (F4).
 *
 * Two of twenty real-turn desktop drives on 2026-09-12 (first turn of a new
 * Codex session, test suites running concurrently) rendered only the user bubble
 * and a spinner while core's canonical held every message. Which renderer layer
 * lost them — the fold, or the projection — was never captured, because by the
 * time anyone looked the app had moved on. This module makes the next occurrence
 * self-reporting.
 *
 * ## What it checks, and why those four
 *
 * The store's `messages` is a BY-REFERENCE projection of the replica's canonical
 * (`replica.ts`'s `projectSession` assigns `messages: c.messages`, committed
 * through an identity diff). So the invariant after any commit is exact, not
 * approximate: `store.sessions[id].messages === canonical.sessions[id].messages`
 * for every id canonical knows. A difference IS a projection bug, and no amount
 * of equal CONTENT makes it benign — an entry the projection rebuilt instead of
 * sharing is an entry a later identity-diffed commit will skip.
 *
 *  - `projection` — that invariant broken (a store entry holding a different
 *    array, or missing entirely while canonical still has the session);
 *  - `retired` — a store key a rekey should have retired (`resolveRekeyed(k) !== k`
 *    while `k` is still resident), i.e. the rekey's view-state carry-over failed
 *    and the session is split-brained across two keys;
 *  - `emptyTurn` — the SYMPTOM itself, regardless of which layer lost the reply:
 *    an idle turn whose transcript ends on the user;
 *  - `resyncs` — a resync landed during the turn. `applyFullState` REPLACES
 *    canonical, so it is the one routine event that can explain a transcript the
 *    renderer no longer has.
 *
 * ## Rules it does not get to break
 *
 * It **observes**. It never mutates state, never triggers a resync and never
 * throws into the fold: a cure here would destroy the evidence it exists to
 * collect, and a detector that can crash the renderer is worse than the bug.
 * It registers through {@link onReplicaApplied} — the post-fold observer seam —
 * rather than taking a second event tap, so it cannot change what the fold sees.
 * And it is SILENT when everything is fine: one warn line per finding-bearing
 * turn, nothing at all otherwise, because a per-turn info line would bury the
 * one line that matters.
 */

import { onReplicaApplied, getReplicaState, resolveRekeyed } from '../stores/replica'
import { useSessionStore } from '../stores/session-store'
import { getSyncResyncCount, getSyncClient } from '../../../core/shared/sync/client-registry'
import type { CanonicalSessionState, CanonicalState } from '../../../core/shared/sync/state'
import type { ChatMessage, SessionStatus } from '../../../shared/types'

/**
 * How long after the turn-end status the audit reads the state.
 *
 * Long enough that a reply still in flight behind the status (a trailing
 * `session:message`, a seal, a resync's snapshot) has landed, short enough that
 * the next turn has not started. A `running` status inside the window cancels
 * the audit outright, so this is a floor on "settled", not a guess at it.
 */
export const PROJECTION_AUDIT_DELAY_MS = 1500

export type ProjectionFindingKind = 'projection' | 'retired' | 'emptyTurn' | 'resyncs'

/** The only shape of the store the audit reads. `PerSessionState` satisfies it. */
export type AuditStoreSessions = Readonly<
  Record<string, { readonly messages: readonly ChatMessage[] } | undefined>
>

export interface ProjectionAuditInput {
  /** The session whose turn just ended, already followed through any rekey. */
  id: string
  /** The state the triggering `session:status` carried — read, never re-derived. */
  endedState: 'idle' | 'error'
  storeSessions: AuditStoreSessions
  canonical: CanonicalState
  /** {@link resolveRekeyed} in production; injected so the audit stays pure. */
  resolveRetired: (storeKey: string) => string
  resyncCount: number
  /** Resyncs since this session's turn started. */
  resyncDelta: number
  lastSeq: number | null
}

/** One line of JSON, sized to be read in a log rather than parsed by a tool. */
export interface ProjectionAuditReport {
  id: string
  findings: ProjectionFindingKind[]
  storeCount: number
  canonicalCount: number
  storeRoles: Record<string, number>
  canonicalRoles: Record<string, number>
  /** Every id whose store array is not canonical's — not only the audited one. */
  projectionIds: string[]
  retiredIds: string[]
  resyncCount: number
  resyncDelta: number
  lastSeq: number | null
}

/** Message counts by role — a missing assistant turn, visible at a glance. */
export function countMessageRoles(
  messages: ReadonlyArray<{ role: string }>
): Record<string, number> {
  const roles: Record<string, number> = {}
  for (const m of messages) roles[m.role] = (roles[m.role] ?? 0) + 1
  return roles
}

/** Does this transcript end on a user message — the render-loss symptom? */
export function endsWithUserMessage(messages: ReadonlyArray<{ role: string }>): boolean {
  return messages.length > 0 && messages[messages.length - 1].role === 'user'
}

/**
 * Turns that legitimately end on the user, so `emptyTurn` stays a signal.
 *
 * All three are states canonical actually carries, which is the bar: a guess
 * that a turn was "probably fine" would silence the one finding that names the
 * bug. What canonical does NOT carry is a user INTERRUPT (Escape / Stop) — it
 * rides an IPC invoke, `wasInterrupted` never reaches the wire, and an interrupt
 * that killed a turn before its first token is indistinguishable here from a
 * turn whose reply was lost. So an interrupt is reported, deliberately: the
 * false positive costs one warn line, and excluding it would need a second seam
 * that a phone-driven interrupt would defeat anyway.
 */
function turnLegitimatelyEndsOnUser(session: CanonicalSessionState): boolean {
  // A prompt is held, waiting for this turn to finish — the transcript is
  // SUPPOSED to sit on the user until the queue drains.
  if (session.queue.some((item) => item.state === 'queued')) return true
  // The turn is parked at a permission gate; nothing has been lost yet.
  if (session.pendingApprovals.length > 0) return true
  // A reliable ROOT scaffold exists and its item-addressed value is still arriving.
  // A background child's output cannot explain a missing response in this transcript.
  if (Object.values(session.itemStreams).some((stream) => !stream.target.ownerToolUseId))
    return true
  return false
}

/**
 * The audit itself — pure, so the findings can be pinned over hand-built pairs.
 * Returns `null` when there is nothing to report.
 */
export function auditProjection(input: ProjectionAuditInput): ProjectionAuditReport | null {
  const { id, canonical, storeSessions } = input
  const findings: ProjectionFindingKind[] = []

  // `projection` — checked for EVERY id canonical knows, not only the audited
  // one: the invariant is global, and a sibling session that lost its array is
  // the same bug one turn earlier.
  const projectionIds: string[] = []
  for (const [sessionId, c] of Object.entries(canonical.sessions)) {
    if (storeSessions[sessionId]?.messages !== c.messages) projectionIds.push(sessionId)
  }
  if (projectionIds.length > 0) findings.push('projection')

  const retiredIds = Object.keys(storeSessions).filter((key) => input.resolveRetired(key) !== key)
  if (retiredIds.length > 0) findings.push('retired')

  const session = canonical.sessions[id]
  if (
    input.endedState === 'idle' &&
    session !== undefined &&
    endsWithUserMessage(session.messages) &&
    !turnLegitimatelyEndsOnUser(session)
  ) {
    findings.push('emptyTurn')
  }

  if (input.resyncDelta > 0) findings.push('resyncs')

  if (findings.length === 0) return null
  const storeMessages = storeSessions[id]?.messages ?? []
  const canonicalMessages = session?.messages ?? []
  return {
    id,
    findings,
    storeCount: storeMessages.length,
    canonicalCount: canonicalMessages.length,
    storeRoles: countMessageRoles(storeMessages),
    canonicalRoles: countMessageRoles(canonicalMessages),
    projectionIds,
    retiredIds,
    resyncCount: input.resyncCount,
    resyncDelta: input.resyncDelta,
    lastSeq: input.lastSeq
  }
}

// ---------------------------------------------------------------------------
// The scheduler
// ---------------------------------------------------------------------------

/**
 * One scheduled audit. `id` is MUTABLE because a rekey landing inside the window
 * moves the session under the timer: the callback reads the record's current id,
 * so a carried-over entry can never delete the wrong key and strand its own.
 */
interface PendingAudit {
  id: string
  endedState: 'idle' | 'error'
  handle: ReturnType<typeof setTimeout>
}

/** Pending audits, keyed by the rekey-resolved session id. */
const timers = new Map<string, PendingAudit>()
/**
 * `resyncCount` when each session's current turn started RUNNING.
 *
 * Absent means "this module never saw the turn start", and the delta is then
 * reported as 0 rather than measured from app start: a resync that landed before
 * a turn nobody watched begin cannot be attributed to it, and a `resyncs` finding
 * on a healthy turn would cost exactly what silence-when-healthy buys.
 */
const resyncBaselines = new Map<string, number>()
/** The installed disposer, or null — {@link startProjectionAudit} is idempotent. */
let installed: (() => void) | null = null

/**
 * Start auditing. Called once from each entry point, next to `startReplica()`.
 *
 * Idempotent for the same reason `startReplica` is: the web client reaches its
 * start path on every `sync-full`, and a second observer would double every
 * warn line.
 */
export function startProjectionAudit(): () => void {
  if (installed) return installed
  const off = onReplicaApplied(observeStatus)
  installed = () => {
    off()
    for (const pending of timers.values()) clearTimeout(pending.handle)
    timers.clear()
    resyncBaselines.clear()
    installed = null
  }
  return installed
}

function observeStatus(channel: string, args: unknown[]): void {
  if (channel !== 'session:status') return
  const routingId = args[0]
  if (typeof routingId !== 'string' || routingId === '') return
  const state = (args[1] as SessionStatus | undefined)?.state
  // Observers run AFTER the fold, so a rekey carried by this very status has
  // already moved the session: the id the event named may be retired already.
  const id = resolveRekeyed(routingId)
  if (id !== routingId) carryOver(routingId, id)

  if (state === 'running') {
    const pending = timers.get(id)
    if (pending !== undefined) {
      // A new turn started inside the previous one's audit window: the audit is
      // moot, and the baseline starts over — the previous turn's resyncs are
      // not this turn's.
      clearTimeout(pending.handle)
      timers.delete(id)
      resyncBaselines.set(id, getSyncResyncCount())
      return
    }
    // Only the FIRST `running` of a turn takes the baseline. Later ones inside
    // the same turn (a status echo, the status that carries a Codex rekey) must
    // not move it, or a resync between turn start and rekey is never attributed.
    if (!resyncBaselines.has(id)) resyncBaselines.set(id, getSyncResyncCount())
    return
  }
  if (state !== 'idle' && state !== 'error') return
  // Coalesced per id: the first schedule wins, so a burst of terminal statuses
  // (status, then result, then a config echo) audits once and at a bounded
  // delay rather than sliding forward on each one.
  if (timers.has(id)) return
  const pending: PendingAudit = {
    id,
    endedState: state,
    handle: setTimeout(() => {
      timers.delete(pending.id)
      runAudit(pending.id, pending.endedState)
    }, PROJECTION_AUDIT_DELAY_MS)
  }
  timers.set(id, pending)
}

/**
 * Move a session's pending audit and resync baseline onto the id a rekey just
 * gave it — the detector's own version of the view carry-over the replica does.
 * Without it the first Codex turn of every session loses its baseline (recorded
 * under the minted routing id) and the audit could neither attribute a resync to
 * that turn nor decline to.
 */
function carryOver(oldId: string, newId: string): void {
  const baseline = resyncBaselines.get(oldId)
  if (baseline !== undefined && !resyncBaselines.has(newId)) resyncBaselines.set(newId, baseline)
  resyncBaselines.delete(oldId)
  const pending = timers.get(oldId)
  if (pending === undefined) return
  timers.delete(oldId)
  // An audit already scheduled under the new id wins — it was scheduled from a
  // status that already knew the session's real name.
  if (timers.has(newId)) {
    clearTimeout(pending.handle)
    return
  }
  pending.id = newId
  timers.set(newId, pending)
}

function runAudit(id: string, endedState: 'idle' | 'error'): void {
  try {
    const target = resolveRekeyed(id)
    const baseline = resyncBaselines.get(id) ?? resyncBaselines.get(target)
    resyncBaselines.delete(id)
    resyncBaselines.delete(target)
    const resyncCount = getSyncResyncCount()
    const report = auditProjection({
      id: target,
      endedState,
      storeSessions: useSessionStore.getState().sessions,
      canonical: getReplicaState(),
      resolveRetired: resolveRekeyed,
      resyncCount,
      resyncDelta: baseline === undefined ? 0 : resyncCount - baseline,
      lastSeq: getSyncClient()?.getLastSeq() ?? null
    })
    if (!report) return
    window.api?.logRelay?.('warn', 'ProjectionAudit', JSON.stringify(report))
  } catch {
    /* the detector must never break the app it is watching */
  }
}
