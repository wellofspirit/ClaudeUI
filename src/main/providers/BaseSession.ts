import type { BrowserWindow } from 'electron'
import type {
  ChatMessage,
  SessionStatus,
  EngineId,
  ApprovalDecision,
  PermissionSuggestion,
  ModelCostEntry,
  QueuedItem
} from '../../shared/types'
import type { ResolvedCapabilities } from '../../shared/model-capabilities'
import type { ISession } from './ISession'
import { SessionQueue } from './session-queue'
import { dispatchedCostsByRouting } from '../services/db'
import { logger } from '../services/logger'
import { emitEvent } from '../services/sync-host'

/**
 * Abstract base class holding engine-neutral plumbing shared by all session
 * implementations (ClaudeSession, future opencode session, etc.).
 *
 * Owns:
 *  - Instance fields: win, routingId, cwd, messageHistory, inactivity timer
 *  - protected send() — one emission through the funnel, to every subscriber
 *  - getMessages() / setInactivityTimeout() — common ISession implementations
 *  - baseStatusFields() — injects engineId + capabilities into a SessionStatus object
 *
 * Subclasses must implement:
 *  - abstract readonly engineId: EngineId
 *  - abstract readonly capabilities: ResolvedCapabilities
 *  - All remaining ISession methods (run, interrupt, cancel, resolveApproval, etc.)
 *  - dispose() — resource teardown
 */
export abstract class BaseSession implements ISession {
  // ---------------------------------------------------------------------------
  // Instance fields
  // ---------------------------------------------------------------------------
  //
  // `addExtraWindow` / `removeExtraWindow` / `getExtraWindows` were DELETED by
  // SyncCore phase 4c. "Extra window" was the shape the delivery privilege took:
  // the desktop renderer was the fan-out target, and every other client had to be
  // dressed up as a fake `BrowserWindow` to receive anything. Clients are uniform
  // subscribers now — `addSyncSubscriber` in `services/sync-host.ts`.

  protected win: BrowserWindow
  /** Mutable: SessionManager.rekey() writes this when the session UUID arrives. */
  routingId: string
  readonly cwd: string
  protected messageHistory: ChatMessage[] = []
  protected inactivityTimer: ReturnType<typeof setTimeout> | null = null
  protected inactivityTimeoutMs = 15 * 60 * 1000
  /**
   * Cross-engine dispatched cost (ADR-033 Slice C), keyed `${engineId}:${modelId}`.
   * Accumulated per-dispatch-turn (NOT cumulative snapshots, unlike the
   * engines' own cost fields — see addDispatchedCost's doc comment), durable
   * across reloads via seedDispatchedCosts(). Kept separate from each engine's
   * own costBaseUsd/modelCostBase — dispatched spend is reported as its own
   * tagged rows (ModelCostEntry.dispatched), never folded into the headline
   * totalCostUsd (product decision — see the TopBar breakdown).
   */
  protected dispatchedCosts = new Map<
    string,
    { engineId: EngineId; modelId: string; costUsd: number }
  >()

  /**
   * Queue of record for prompts sent while this session is busy (ADR-053).
   * Every transition broadcasts the FULL list on `session:queue-changed`, so
   * the desktop renderer and every remote client converge on the same queue.
   */
  protected readonly queue = new SessionQueue((items) =>
    this.send('session:queue-changed', { items })
  )

  /** Serializes {@link flushQueuedItems} against overlapping boundary signals. */
  private flushingQueue = false

  /**
   * Thinking-span clock (SyncCore phase 4b). `thinkingStartedAt` is the wall
   * clock at the first thinking delta of the current span; `sealedThinkingMs`
   * holds an already-sealed span's elapsed time until the next
   * `session:message` can carry it.
   *
   * Lives HERE, on the one chokepoint all three engines' events pass through
   * ({@link send}), rather than in claude-session / OpencodeSession / PiSession:
   * the seal rule is a function of (channel, payload) only, it is the exact rule
   * `applyEvent` applies to decide a span ended, and three copies of a clock +
   * state machine would be three chances to disagree with it.
   */
  private thinkingStartedAt: number | null = null
  private sealedThinkingMs: number | null = null

  constructor(routingId: string, win: BrowserWindow, cwd: string) {
    this.routingId = routingId
    this.win = win
    this.cwd = cwd
  }

  // ---------------------------------------------------------------------------
  // Abstract members — subclasses must implement
  // ---------------------------------------------------------------------------

  abstract readonly engineId: EngineId
  abstract readonly capabilities: ResolvedCapabilities
  abstract readonly willQueue: boolean
  abstract getSessionId(): string | null
  abstract run(
    prompt: string | null,
    attachments?: Array<{ mediaType: string; base64Data: string; fileName?: string }>
  ): Promise<void>
  abstract interrupt(): Promise<void>
  abstract cancel(): void
  abstract resolveApproval(
    requestId: string,
    decision: ApprovalDecision,
    answers?: Record<string, string>,
    updatedPermissions?: PermissionSuggestion[]
  ): void
  abstract setModel(model: string): Promise<void>
  abstract setPermissionMode(mode: string): Promise<void>
  abstract dispose(): void

  // ---------------------------------------------------------------------------
  // Concrete shared implementations
  // ---------------------------------------------------------------------------

  getMessages(): ChatMessage[] {
    return this.messageHistory
  }

  /**
   * Default implementation for engines that do not support the sideQuestion
   * capability. Always returns null — callers check `capabilities.sideQuestion`
   * before invoking.
   */
  async askSideQuestion(_question: string): Promise<string | null> {
    return null
  }

  setInactivityTimeout(ms: number): void {
    this.inactivityTimeoutMs = ms
    if (!this.willQueue) this.resetInactivityTimer()
  }

  // ---------------------------------------------------------------------------
  // Queue of record (ADR-053) — engine-neutral policy, per-engine transports
  // ---------------------------------------------------------------------------

  get queuedItems(): QueuedItem[] {
    return this.queue.pending()
  }

  enqueuePrompt(
    text: string,
    attachments?: Array<{ mediaType: string; base64Data: string; fileName?: string }>
  ): void {
    const item = this.queue.add(text, attachments)
    this.queue.emit()
    this.onPromptQueued(item)
  }

  /**
   * What happens the instant an item lands in the queue.
   *
   * The default HOLDS it: opencode and pi commit-on-post (their steer/coalesce
   * posts are unrecallable the moment they land), so forwarding at keypress
   * would leave a zero-length take-back window. They forward from
   * {@link flushQueuedItems} at the next observed sub-turn boundary instead.
   * ClaudeSession overrides this to push straight into cli.js's native queue,
   * which already has real sub-turn timing AND a real per-item dequeue.
   */
  protected onPromptQueued(_item: QueuedItem): void {
    // Held until a boundary — see the doc comment.
  }

  /**
   * Forward every held item, oldest first, at an engine sub-turn boundary.
   * Serialized: a boundary firing while a forward is in flight is a no-op —
   * the running loop picks newly queued items up on its next pass.
   */
  protected async flushQueuedItems(): Promise<void> {
    if (this.flushingQueue) return
    this.flushingQueue = true
    try {
      for (let item = this.queue.nextUnforwarded(); item; item = this.queue.nextUnforwarded()) {
        this.queue.markForwarded(item)
        await this.run(item.text, item.attachments)
        // Delivery is acknowledged by the engine's own post-success path
        // (onPromptDelivered). Still pending here means the send failed —
        // which already surfaced `session:error` — so put the item back in the
        // recallable pool and stop; the next boundary retries it. Never mark it
        // consumed: that would paint a message into the transcript that the
        // engine never received.
        if (item.state === 'queued') {
          this.queue.unmarkForwarded(item)
          break
        }
      }
    } finally {
      this.flushingQueue = false
    }
  }

  /**
   * A prompt reached the engine. Consumes the matching queued item and
   * broadcasts; a no-op for ordinary never-queued sends, so engines can call it
   * from their single post-send success path.
   */
  protected onPromptDelivered(prompt: string): void {
    if (this.queue.consumeByText(prompt)) this.queue.emit()
  }

  async recallQueued(): Promise<{ recalled: string[]; notRecalled: number }> {
    const recalled: string[] = []
    let notRecalled = 0
    for (const item of this.queue.pending()) {
      if (await this.tryRecallQueuedItem(item)) {
        this.queue.setState(item, 'recalled')
        recalled.push(item.text)
      } else {
        notRecalled++
      }
    }
    this.queue.emit()
    return { recalled, notRecalled }
  }

  /**
   * Can this item still be taken back? Default (opencode/pi): only while core
   * still holds it — once forwarded the engine owns it. ClaudeSession asks
   * cli.js instead, since cli.js's queue is the holder there.
   */
  protected async tryRecallQueuedItem(item: QueuedItem): Promise<boolean> {
    return !this.queue.isForwarded(item)
  }

  /**
   * The engine stopped serving this session (disconnect / teardown, ADR-045).
   * Whatever is still queued can never run — cli.js's queue died with its
   * process, and a held item has no engine left to forward to — so recall it
   * and say so. Nothing is restored into any input: only an explicit user
   * take-back returns text to the client (ADR-053).
   */
  protected recallQueuedOnEngineLoss(): void {
    for (const item of this.queue.pending()) this.queue.setState(item, 'recalled')
    this.queue.emit()
  }

  /** Public wrapper over the protected send() — see ISession.emit doc comment. */
  emit(channel: string, data: unknown): void {
    this.send(channel, data)
  }

  /**
   * Accumulate one cross-engine dispatched-agent turn's spend (ADR-033 Slice
   * C) — see ISession.addDispatchedCost's doc comment for the calling
   * convention. Unlike the engines' own cost accumulators (which REPLACE from
   * a cumulative-within-process snapshot, see ClaudeSession/OpencodeSession's
   * costBaseUsd/liveTotalCostUsd split), dispatched turn costs arrive as
   * discrete PER-TURN values (cross-engine-dispatcher.ts's turnCostUsd) — so
   * this is a plain `+=`. Re-emits a fresh status line so the TopBar tooltip
   * updates live, via the engine-specific hook below (BaseSession has no
   * status-line builder of its own).
   */
  addDispatchedCost(engineId: EngineId, modelId: string, costUsd: number): void {
    const key = `${engineId}:${modelId}`
    const existing = this.dispatchedCosts.get(key)
    this.dispatchedCosts.set(key, {
      engineId,
      modelId,
      costUsd: (existing?.costUsd ?? 0) + costUsd
    })
    this.onDispatchedCostsChanged()
  }

  /**
   * Hook fired after addDispatchedCost/seedDispatchedCosts change
   * dispatchedCosts — subclasses override to re-emit their status line
   * (`this.send('session:status-line', this.buildStatusLineFromAccumulators())`
   * for Claude, `this.sendStatusLine()` for opencode). No-op by default so a
   * hypothetical future engine that never seeds/emits doesn't need to care.
   */
  protected onDispatchedCostsChanged(): void {
    // Intentionally empty — see doc comment.
  }

  /** Current dispatched-cost rows as ModelCostEntry[], each tagged `dispatched: true`. */
  protected dispatchedCostEntries(): ModelCostEntry[] {
    return [...this.dispatchedCosts.values()].map((entry) => ({
      engineId: entry.engineId,
      modelId: entry.modelId,
      costUsd: entry.costUsd,
      dispatched: true
    }))
  }

  /**
   * Seed dispatchedCosts from durable storage (ADR-033 Slice C — cost survives
   * reloads, mirroring Slice B's costBaseUsd seeding). REPLACES the map
   * (never adds) — safe to call at most-once-per-object-lifetime call sites
   * (ClaudeSession's constructor; OpencodeSession's replayStoredHistory,
   * itself gated to run once). Keyed by `this.routingId` — the STABLE id a
   * later reopen/resume will construct the session object with (a fresh
   * session's temporary pre-rekey id naturally has zero rows; SessionManager.
   * rekey() carries any dispatch already recorded under it forward via
   * renameDispatchedUsage, so the eventual stable id sees them here).
   *
   * Best-effort: called bare from session-construction paths (ClaudeSession's
   * constructor, OpencodeSession's replayStoredHistory) — a DB open/query
   * failure must never break session creation over a cosmetic feature, so
   * failures are swallowed and logged (same pattern as SessionManager.rekey's
   * renameDispatchedUsage call).
   */
  protected seedDispatchedCosts(): void {
    try {
      const rows = dispatchedCostsByRouting(this.routingId)
      this.dispatchedCosts = new Map(
        rows.map((row) => [
          `${row.targetEngine}:${row.targetModel}`,
          { engineId: row.targetEngine as EngineId, modelId: row.targetModel, costUsd: row.costUsd }
        ])
      )
    } catch (err) {
      logger.warn(
        'BaseSession',
        `seedDispatchedCosts failed (dispatched-cost breakdown starts empty): ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  // ---------------------------------------------------------------------------
  // Protected helpers
  // ---------------------------------------------------------------------------

  protected resetInactivityTimer(): void {
    this.clearInactivityTimer()
    if (this.inactivityTimeoutMs > 0) {
      this.inactivityTimer = setTimeout(() => {
        this.cancel()
      }, this.inactivityTimeoutMs)
    }
  }

  protected clearInactivityTimer(): void {
    // accessible from ClaudeSession.cancel()
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer)
      this.inactivityTimer = null
    }
  }

  /**
   * Broadcast a domain event to every client.
   *
   * SyncCore phase 4a: delegates to the emission funnel, so the event is appended
   * to the ring and applied to canonical state BEFORE it is delivered — the
   * ordering that makes "a snapshot at seq N contains every event through N"
   * true by construction.
   *
   * Phase 4c dropped the delivery target and the per-session window: every
   * channel a session emits is replicated or volatile, so it reaches every
   * SUBSCRIBER, and the session's own `this.win` is no longer part of the fan-out
   * (the desktop renderer is a subscriber like any other). `this.win` survives as
   * the spawn/host handle the engines need, not as a delivery target.
   *
   * `routingId` rides as `args[0]`, which is the wire encoding of contract 2's
   * `sessionId` — positional, not a named field (see sync-core.md §"Wire
   * encoding"). It is read fresh on every send, so a rekey mid-turn is picked up
   * without any re-registration.
   *
   * The payload passes through {@link trackThinkingSpan} first, which is where a
   * sealed thinking span's elapsed ms is attached (phase 4b).
   */
  protected send(channel: string, data: unknown): void {
    emitEvent(channel, [this.routingId, this.trackThinkingSpan(channel, data)])
  }

  /**
   * Time the current thinking span and stamp its elapsed ms on the event that
   * seals it — the emitter half of replicable "Thought for Xs".
   *
   * The seal points mirror the renderer's store handlers exactly (session-store
   * `appendStreamingThinking` / `appendStreamingText` / `addMessage` /
   * `setStatus` / `retractMessages`), because those are the points `applyEvent`
   * mirrors too:
   *
   *  - a `thinking` delta OPENS the span (first delta wins — a span is one
   *    continuous run of thinking output);
   *  - a `text` delta SEALS it, but there is no thinking block on the wire yet:
   *    park the elapsed time for the message that will carry the block;
   *  - a `session:message` with any non-thinking content seals a still-open span
   *    and carries either that elapsed time or the parked one, ONCE (the reducer
   *    owns it from there — re-sending would stamp a later span with a stale
   *    duration);
   *  - `idle`/`disconnected` status and a retraction abandon an open span with no
   *    stamp, exactly as the renderer's safety nets do.
   *
   * Returns the payload to emit — a shallow copy when a duration is attached, so
   * the caller's object (which engines also keep in their own message history) is
   * never mutated.
   */
  private trackThinkingSpan(channel: string, data: unknown): unknown {
    switch (channel) {
      case 'session:stream': {
        const delta = data as { type?: string } | null
        if (delta?.type === 'thinking') {
          this.thinkingStartedAt ??= Date.now()
        } else if (this.thinkingStartedAt !== null) {
          this.sealedThinkingMs = Date.now() - this.thinkingStartedAt
          this.thinkingStartedAt = null
        }
        return data
      }
      case 'session:message': {
        const message = data as ChatMessage | null
        if (!message || !Array.isArray(message.content)) return data
        const sealsHere =
          this.thinkingStartedAt !== null &&
          message.content.some((b) => b.type === 'text' || b.type === 'tool_use')
        const durationMs = sealsHere ? Date.now() - this.thinkingStartedAt! : this.sealedThinkingMs
        if (sealsHere) this.thinkingStartedAt = null
        if (durationMs === null) return data
        this.sealedThinkingMs = null
        return { ...message, thinkingDurationMs: durationMs }
      }
      case 'session:status': {
        const status = data as SessionStatus | null
        if (status?.state === 'idle' || status?.state === 'disconnected') {
          this.thinkingStartedAt = null
        }
        return data
      }
      case 'session:messages-retracted':
        this.thinkingStartedAt = null
        return data
      default:
        return data
    }
  }

  /**
   * Returns the engineId + capabilities fields that every subclass must merge
   * into its SessionStatus object. Keeps status construction DRY.
   */
  protected baseStatusFields(): Pick<SessionStatus, 'engineId' | 'capabilities'> {
    return {
      engineId: this.engineId,
      capabilities: this.capabilities
    }
  }
}
