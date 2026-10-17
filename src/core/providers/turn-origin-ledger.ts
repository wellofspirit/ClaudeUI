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
 * Slice 1c adds what the start gate reads beside them: whether the current turn is
 * the host's own (`host-instruction`), whether a session another session started
 * has heard from a client yet (`agentCreated`), and how many sessions this turn
 * has started.
 *
 * Lives on the session object, so it follows a rekey for free and dies with the
 * session. Memory only, like the other per-process guards (`BlockedCallLedger`).
 */

/** Default cap on agent-started turns between two user prompts. */
export const AGENT_TURN_BUDGET = 10

/** Most sessions one user turn may start (session tools, spec §7.1). */
export const STARTS_PER_USER_TURN = 10

/** What a prompt that reaches {@link TurnOriginLedger.userPrompt} speaks for. */
export interface UserPromptKind {
  /** The host acting on the user's standing setting or click (context pressure). */
  hostInstruction?: boolean
  /** The brief a session tool gave a session it just started: the user did not type it. */
  agentBrief?: boolean
}

export class TurnOriginLedger {
  private clean = true
  private starts = 0
  private budgetLogged = false
  private hostTurn = false
  private createdByAgent = false
  private sessionStarts = 0

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

  /** Is the current turn the host's own instruction rather than something the user typed? */
  get hostInstructionTurn(): boolean {
    return this.hostTurn
  }

  /**
   * Was this session started by another session and no client has prompted it
   * since? Set at birth by the start flow; cleared only by a client prompt.
   */
  get agentCreated(): boolean {
    return this.createdByAgent
  }

  /** Sessions this user turn has started so far. */
  get sessionStartsSinceUser(): number {
    return this.sessionStarts
  }

  get startsLeft(): boolean {
    return this.sessionStarts < STARTS_PER_USER_TURN
  }

  /**
   * A `user` or `host-instruction` prompt: the user spoke. The brief a session
   * tool sends a new session resets taint and budgets like any prompt but is not a
   * client typing, so it leaves `agentCreated` alone; so does the host's own
   * instruction (a standing setting is not the user typing into this session).
   */
  userPrompt(kind: UserPromptKind = {}): void {
    this.clean = true
    this.starts = 0
    this.budgetLogged = false
    this.sessionStarts = 0
    this.hostTurn = kind.hostInstruction === true
    if (!kind.hostInstruction && !kind.agentBrief) this.createdByAgent = false
  }

  /** This session was started by another session's tool: no client has spoken to it yet. */
  markAgentCreated(): void {
    this.createdByAgent = true
  }

  /** This turn started a session. */
  sessionStarted(): void {
    this.sessionStarts++
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
