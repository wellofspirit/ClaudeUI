/**
 * What a live session has read from non-user sources, and how many turns those
 * sources have started (slice 1a, spec §5.1). Two counters, both reset by the
 * user speaking:
 *
 *  - `userOriginClean` — true until a message from another session or an agent
 *    is delivered, back to true on the next `user` / `host-instruction` prompt.
 *    Slice 1c's start gate reads it: a session that has taken in agent text since
 *    the user last spoke cannot start another session on its own say-so.
 *  - `agentTurnStartsSinceUser` — turns a non-user item started since the user
 *    last spoke. Past {@link AGENT_TURN_BUDGET}, an idle session is not woken
 *    again: the item is held until the user (or a busy turn) takes it.
 *
 * Lives on the session object, so it follows a rekey for free and dies with the
 * session. Memory only, like the other per-process guards (`BlockedCallLedger`).
 */

/** Default cap on agent-started turns between two user prompts. */
export const AGENT_TURN_BUDGET = 10

export class TurnOriginLedger {
  private clean = true
  private starts = 0
  private budgetLogged = false

  constructor(readonly cap: number = AGENT_TURN_BUDGET) {}

  get userOriginClean(): boolean {
    return this.clean
  }

  get agentTurnStartsSinceUser(): number {
    return this.starts
  }

  /** May another non-user item start a turn? */
  get budgetLeft(): boolean {
    return this.starts < this.cap
  }

  /** A `user` or `host-instruction` prompt: the user spoke. */
  userPrompt(): void {
    this.clean = true
    this.starts = 0
    this.budgetLogged = false
  }

  /** True the first time the budget runs out since the user last spoke (log once, not per held item). */
  noteBudgetExhausted(): boolean {
    const first = !this.budgetLogged
    this.budgetLogged = true
    return first
  }

  /** A non-user item reached (or was queued into) the session's context. */
  nonUserDelivered(): void {
    this.clean = false
  }

  /** A non-user item started a turn on an idle session. */
  agentTurnStarted(): void {
    this.starts++
  }
}
