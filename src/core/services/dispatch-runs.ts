/**
 * The dispatch RUN registry (ADR-105 §2, slice B-2a).
 *
 * A run is one `dispatch_agent` launch driven to its end: the target's spawn or resume
 * and one turn on it. It is registered here, by its ledger id, for its whole life, and
 * owns everything the launching call used to: the stop handle, the liveness watchdog
 * and heartbeat (in the dispatcher's turn bodies), and its slot against the concurrency
 * cap. It is never tied to the MCP request that started it (its abort signal, its
 * progress token), to the dispatcher's call frame, or to the parent's session object.
 *
 * The blocking form of the tool launches the same run and awaits `done`; the
 * background form returns once `launched` fires (the target's ledger row exists).
 * This module is a LEAF: types only from the dispatcher, no runtime imports.
 */
import type { EngineId } from '../../shared/types'
import type { DispatchResult } from './cross-engine-dispatcher'

export interface DispatchRunInit {
  /** The dispatching session's durable id AT LAUNCH (follow `registry.parentOf` for the live one). */
  parentId: string
  /** The launching tool call's id (the card the task record is keyed by); absent = no card. */
  toolUseId: string | undefined
  /** Background: the launch returns at once and the call's lifetime does not own the run. */
  background: boolean
  engine: EngineId
  /** The new target's `name` (already trimmed), for the uniqueness check among in-flight launches. */
  name: string | null
  /** The task record's description. */
  description: string | undefined
  /** `session_id` was passed: the run continues an existing target. */
  continuation: boolean
  /** The parent's autonomy mode when the call was made (the target row's, once it is bound). */
  launchMode: string
  startedAt: number
}

export class DispatchRun {
  /** The target's ledger id (`s-xxxxxx`); null until its row exists. */
  ledgerId: string | null = null
  /** The harness's own session id, as told to the caller. */
  harnessId: string | null = null
  /**
   * The user pressed Stop (card, remote client, a parent's interrupt for a blocking
   * run). One per run.
   */
  readonly stopController = new AbortController()
  /**
   * The blocking call's abandonment — its MCP request was cancelled (Esc, teardown). A
   * background run has no such owner, so nothing ever aborts this for it.
   */
  readonly cancelController = new AbortController()
  /**
   * The X-Agent is to END with this run (ADR-105 §5): the user pressed Stop on its card, or
   * its parent session was deleted. Set before `stopController` aborts; when the run's body
   * returns the dispatcher ends the target for good (row `stopped`, process released,
   * harness state removed). A parent's own interrupt of a blocking call never sets it: that
   * target stays resumable.
   */
  endRequested = false
  /** A terminal `task-notification` went out (a body's own, or the run-end closer's). */
  notified = false
  /** This run created its target (as opposed to continuing one). */
  createdTarget = false
  /** The mode a parent with no session object is judged under; see `DispatchRunInit.launchMode`. */
  launchMode: string
  /**
   * This run ends in a report the X-Agent hands back (`hand_back`, ADR-105 §3) rather than in
   * its last message. Set by the dispatcher when it creates the run.
   */
  handBackRequired = false
  /** The report the agent handed back (the first call of the run); null until then. */
  report: { text: string; callId: string | undefined } | null = null
  /** Resolves when {@link report} is set: the turn bodies race it. */
  readonly reported: Promise<void>
  private markReported!: () => void
  /** Follow-up prompts sent because a turn ended without a report (at most three). */
  nudges = 0
  /** What the run's turns (the first and each nudge) spent, for its one terminal notification. */
  usage = { totalTokens: 0, toolUses: 0, durationMs: 0 }
  /** How a run that reached its end through a report decision ended (set by the dispatcher); null otherwise. */
  finishedAs: { status: 'delivered' | 'fallback' | 'withheld'; report: string | null } | null = null
  /** The status of the terminal notification the run emitted. */
  terminalStatus: 'completed' | 'failed' | 'stopped' | null = null
  /** The text of that notification (a failure's reason, a legacy run's last message). */
  terminalSummary: string | null = null
  /** The parent session was deleted: nothing is left to tell, so no result is delivered. */
  parentEnded = false
  /** The run's end was delivered into the parent (or held for it): never twice. */
  resultSent = false
  /** The run's number in the report store (set when its end was recorded). */
  reportRun: number | null = null
  /** The run's turn hit a liveness cap (a `failed` end that was a timeout). */
  timedOut = false
  /** The blocking form's MCP progress ping; unset for a background run. */
  onHeartbeat: ((beats: number) => void) | undefined
  /** Resolves with the run's result when it ends (the registry slot is already free). */
  done!: Promise<DispatchResult>
  /** Resolves when the target's ledger row exists (`bind`), or never. */
  readonly launched: Promise<void>
  private markLaunched!: () => void
  private isBound = false

  constructor(readonly init: DispatchRunInit) {
    this.launchMode = init.launchMode
    this.launched = new Promise<void>((resolve) => (this.markLaunched = resolve))
    this.reported = new Promise<void>((resolve) => (this.markReported = resolve))
  }

  /**
   * Take the run's report. Only the first call of a run does; a later one is refused
   * (`false`). Wakes whoever races {@link reported}.
   */
  acceptReport(text: string, callId: string | undefined): boolean {
    if (this.report) return false
    this.report = { text, callId }
    this.markReported()
    return true
  }

  get background(): boolean {
    return this.init.background
  }
  get toolUseId(): string | undefined {
    return this.init.toolUseId
  }
  get bound(): boolean {
    return this.isBound
  }

  /** The target's identity is known: the run now answers to its ledger id. */
  bind(ledgerId: string, harnessId: string): void {
    this.ledgerId = ledgerId
    this.harnessId = harnessId
    this.isBound = true
    this.markLaunched()
  }

  /** The turn bodies' heartbeat tick; only the blocking form has anyone to tell. */
  heartbeat(beats: number): void {
    this.onHeartbeat?.(beats)
  }
}

/** How many re-keyed parents the registry remembers (see `rekey`). */
export const MAX_RENAMED_PARENTS = 1024

/**
 * The registries that hold at least one run right now (a drained one leaves the set).
 * Session objects, which cannot import the dispatcher, ask {@link hasRunningDispatch} on every idle-timer reset, so the answer
 * comes from here, in memory, with no database in the way.
 */
const registriesWithRuns = new Set<DispatchRunRegistry>()

/**
 * Does this process run an X-Agent for `parentId` (its durable id; a re-key is followed)?
 * A parent's idle timer must not fire under one (ADR-105 §3): the timer's `cancel()` would
 * drop the session object the run reports into. A run of another process is not this
 * process's concern. Registered for a run's whole life, so it holds from the launch until
 * the run has ended and left the registry.
 */
export function hasRunningDispatch(parentId: string): boolean {
  for (const registry of registriesWithRuns) {
    if (registry.ofParent(parentId).length > 0) return true
  }
  return false
}

/** Test seam: how many registries hold a run right now (a drained one leaves the set). */
export function registriesHoldingRunsForTests(): number {
  return registriesWithRuns.size
}

export class DispatchRunRegistry {
  private readonly runs = new Set<DispatchRun>()
  private readonly byLedger = new Map<string, DispatchRun>()
  private readonly byToolUse = new Map<string, DispatchRun>()
  /** A re-keyed session's old id → its durable one (`syncCore.onRekey`); no per-emit DB read. */
  private readonly renamed = new Map<string, string>()

  /** Running runs — what the concurrency cap counts. */
  get size(): number {
    return this.runs.size
  }

  all(): DispatchRun[] {
    return [...this.runs]
  }

  add(run: DispatchRun): void {
    this.runs.add(run)
    registriesWithRuns.add(this)
    if (run.toolUseId) this.byToolUse.set(run.toolUseId, run)
  }

  /** The run's target row exists: it is now findable by its ledger id too. */
  bind(run: DispatchRun, ledgerId: string, harnessId: string): void {
    run.bind(ledgerId, harnessId)
    this.byLedger.set(ledgerId, run)
  }

  remove(run: DispatchRun): void {
    this.runs.delete(run)
    if (this.runs.size === 0) registriesWithRuns.delete(this)
    if (run.ledgerId && this.byLedger.get(run.ledgerId) === run) this.byLedger.delete(run.ledgerId)
    if (run.toolUseId && this.byToolUse.get(run.toolUseId) === run)
      this.byToolUse.delete(run.toolUseId)
  }

  /** Every run `parentId` launched (a re-keyed parent's old id is followed), bound or not. */
  ofParent(parentId: string): DispatchRun[] {
    const parent = this.parentOf(parentId)
    return [...this.runs].filter((run) => this.parentOf(run.init.parentId) === parent)
  }

  /** A run by its ledger id or its launching tool_use id. */
  find(id: string): DispatchRun | undefined {
    return this.byLedger.get(id) ?? this.byToolUse.get(id)
  }

  byLedgerId(ledgerId: string): DispatchRun | undefined {
    return this.byLedger.get(ledgerId)
  }

  /**
   * A launch of a NEW target of `parentId` that holds `name` and has no ledger row yet
   * (the window between its registration and its row, where the ledger cannot answer).
   * Once a run is bound, its row is the one place a name is looked up.
   */
  holdingName(parentId: string, name: string): DispatchRun | undefined {
    const parent = this.parentOf(parentId)
    for (const run of this.runs) {
      if (
        !run.bound &&
        run.init.name === name &&
        !run.init.continuation &&
        this.parentOf(run.init.parentId) === parent
      )
        return run
    }
    return undefined
  }

  /** `syncCore.onRekey`: a session's temporary id became its durable one. */
  rekey(oldId: string, newId: string): void {
    if (oldId === newId) return
    this.renamed.delete(oldId)
    this.renamed.set(oldId, newId)
    // Bounded: a session is re-keyed once (its temporary id to its durable one), and only a
    // run or target created under the temporary id still asks for it. The oldest go first.
    if (this.renamed.size > MAX_RENAMED_PARENTS)
      this.renamed.delete(this.renamed.keys().next().value as string)
  }

  /** The durable id of a parent seen under `id` (follows re-keys; bounded against a cycle). */
  parentOf(id: string): string {
    let current = id
    for (let hops = 0; hops < 16; hops++) {
      const next = this.renamed.get(current)
      if (next === undefined || next === current) return current
      current = next
    }
    return current
  }
}
