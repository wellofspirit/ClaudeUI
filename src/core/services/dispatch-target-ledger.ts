/**
 * The X-Agent ledger as the rest of the app sees it (ADR-105, slice B-1).
 *
 * `dispatch_target` (operational.db, via `db.ts`) holds one row per dispatch target:
 * the harness session that stays on disk, hidden from every list, so the dispatcher
 * can resume it when its parent continues the conversation. This module is a LEAF —
 * it imports `db.ts` and the ref-minting rule and nothing else — because three
 * readers that sit under the dispatcher's own import graph need the one question
 * "is this harness session a dispatch target?" (the Claude history list, block
 * usage's per-file parse, the Codex history list): the dispatcher reaches
 * `block-usage` through `claude-session`, so a helper living in either would be an
 * import cycle.
 *
 * Spend is NOT stored here: it stays in `usage_event` (origin `dispatch`, session_id
 * = the harness id), which is also why the readers can skip a target's transcript
 * without losing a cent.
 */
import { homedir } from 'node:os'
import path from 'node:path'
import {
  allDispatchTargetHarnessRefs,
  dispatchTargetSpend,
  dispatchTargetsByParent,
  getDispatchTarget,
  getDispatchTargetByHarnessRef,
  insertDispatchTargetWithRef,
  interruptRunningDispatchTargets,
  updateDispatchTarget,
  type DispatchTargetPatch,
  type DispatchTargetRow,
  type DispatchTargetState
} from './db'
import { mintRef } from './session-ref-mint'
import { logger } from './logger'
import { isRef } from '../../shared/session-links'
import type { EngineId } from '../../shared/types'

export type { DispatchTargetRow, DispatchTargetState, DispatchTargetPatch }

/** What the dispatcher supplies when it creates a target; the store adds the id and the clocks. */
export type NewDispatchTarget = Omit<
  DispatchTargetRow,
  'id' | 'state' | 'createdAt' | 'lastActiveAt'
>

/**
 * The ledger as the dispatcher uses it — injectable (`DispatcherDeps.ledger`) so the
 * dispatcher's tests stay off the operational DB, defaulting to {@link dispatchLedger}.
 */
export interface DispatchLedgerStore {
  /** Insert a `running` row and register it with the hide predicate, BEFORE the harness spawns. */
  create(input: NewDispatchTarget): DispatchTargetRow
  get(id: string): DispatchTargetRow | undefined
  getByHarnessRef(engine: EngineId, harnessRef: string): DispatchTargetRow | undefined
  /** Every target a parent session owns, newest first. */
  byParent(parentSessionId: string): DispatchTargetRow[]
  update(id: string, patch: DispatchTargetPatch): void
  /** What the target's turns have cost so far (the `dispatch` rows of `usage_event`). */
  spend(harnessRef: string): { costUsd: number; unpricedTurns: number }
}

// ── The hide predicate ──────────────────────────────────────────────────────

let hidden: Set<string> | null = null
let loadedAt = 0

/**
 * How long a cache MISS is trusted before the ledger is read again. Two instances can
 * share one operational.db and one `~/.claude/projects` (a dev and a packaged build
 * side by side, `claudeui-server` beside the desktop), and a row the OTHER instance
 * wrote is not in this cache: until it is re-read that instance's target transcript
 * would list in the sidebar and be counted a second time by block usage.
 */
export const DISPATCH_CACHE_TTL_MS = 30_000

function loadHidden(): Set<string> | null {
  try {
    hidden = new Set(allDispatchTargetHarnessRefs())
    loadedAt = Date.now()
  } catch (err) {
    // A reader that cannot see the ledger must not fail its own scan. Never loaded: it
    // retries next call. Loaded before: it keeps the old cache and waits out another TTL.
    if (hidden) loadedAt = Date.now()
    logger.warn(
      'DispatchLedger',
      `could not read the dispatch ledger: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  return hidden
}

function hiddenSessions(): Set<string> | null {
  return hidden ?? loadHidden()
}

/**
 * Is `sessionId` a harness session a dispatch target owns? A hit answers from the
 * cache, which every insert in this process refreshes. A MISS is the common case (every
 * ordinary transcript), so it re-reads the ledger only when the cache is older than
 * {@link DISPATCH_CACHE_TTL_MS} — once per interval, not once per file — to pick up rows
 * another instance sharing the DB wrote. Never throws.
 */
export function isDispatchTargetSession(sessionId: string): boolean {
  const cache = hiddenSessions()
  if (!cache) return false
  if (cache.has(sessionId)) return true
  if (Date.now() - loadedAt < DISPATCH_CACHE_TTL_MS) return false
  return loadHidden()?.has(sessionId) ?? false
}

/** Forget the cache: the next question re-reads the ledger. For tests and bulk edits. */
export function resetDispatchTargetSessions(): void {
  hidden = null
  loadedAt = 0
}

// ── The store ───────────────────────────────────────────────────────────────

/** Collisions on 30 bits are rare; a handful of retries makes a failure not worth modelling. */
const REF_ATTEMPTS = 8

/**
 * The real store. The target's id is a session ref: it is registered in `session_ref`
 * (engine = the target's, session id = the harness id) so B-4's `resolveRef` finds the
 * X-Agent by it, and so the ref is unique across both namespaces.
 */
export const dispatchLedger: DispatchLedgerStore = {
  create(input) {
    const now = Date.now()
    for (let attempt = 0; attempt < REF_ATTEMPTS; attempt++) {
      const id = mintRef()
      const row: DispatchTargetRow = {
        ...input,
        id,
        state: 'running',
        createdAt: now,
        lastActiveAt: now
      }
      // One transaction: the ref, or this harness session, may already be taken. A taken
      // harness id cannot be fixed by another ref, so that case ends in the throw below.
      if (!insertDispatchTargetWithRef(row)) continue
      hiddenSessions()?.add(row.harnessRef)
      return row
    }
    throw new Error('Could not record the dispatch target')
  },
  get: (id) => getDispatchTarget(id),
  spend: (harnessRef) => dispatchTargetSpend(harnessRef),
  getByHarnessRef: (engine, harnessRef) => getDispatchTargetByHarnessRef(engine, harnessRef),
  byParent: (parentSessionId) => dispatchTargetsByParent(parentSessionId),
  update(id, patch) {
    updateDispatchTarget(id, patch)
    if (patch.harnessRef !== undefined) hiddenSessions()?.add(patch.harnessRef)
  }
}

/**
 * Boot, once per process: a row still `running` belongs to a process that no longer
 * exists (an app quit or a crash). Nothing resumes automatically (ADR-105 §5).
 */
export function interruptStaleDispatchTargets(): number {
  try {
    return interruptRunningDispatchTargets()
  } catch (err) {
    logger.warn(
      'DispatchLedger',
      `boot pass over the dispatch ledger failed: ${err instanceof Error ? err.message : String(err)}`
    )
    return 0
  }
}

// ── pi's session directory ──────────────────────────────────────────────────

/**
 * `~/.claude/ui/dispatch/pi/<ledgerId>` — a pi target's `--session-dir`. Outside `~/.pi`
 * on purpose, as ADR-089's `pi-subagents`: the pi history list reads only
 * `~/.pi/agent/sessions`, so the target is hidden by where it lives. The id is a ref and
 * is validated before it reaches a path.
 */
export function dispatchPiSessionDir(ledgerId: string, home: string = homedir()): string {
  if (!isRef(ledgerId)) throw new Error(`not a dispatch target id: ${ledgerId}`)
  return path.join(home, '.claude', 'ui', 'dispatch', 'pi', ledgerId)
}
