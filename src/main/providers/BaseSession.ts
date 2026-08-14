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
import { addExtraSink, removeExtraSink, extraSinks, emitEvent } from '../services/sync-host'

/**
 * Abstract base class holding engine-neutral plumbing shared by all session
 * implementations (ClaudeSession, future opencode session, etc.).
 *
 * Owns:
 *  - The extraWindows static set (broadcast to remote clients)
 *  - Instance fields: win, routingId, cwd, messageHistory, inactivity timer
 *  - protected send() — IPC broadcast to win + extraWindows
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
  // Static: extra broadcast windows (remote clients)
  // ---------------------------------------------------------------------------

  // The registry itself lives in `services/sync-host.ts` (SyncCore phase 4a):
  // the delivery adapter is the only thing that fans out to it, and keeping the
  // set here would make `sync-host` ↔ `BaseSession` a cycle. These accessors
  // stay as-is so every existing call site and test is unchanged; both they and
  // the registry are 4c deletion targets.

  static addExtraWindow(win: BrowserWindow): void {
    addExtraSink(win)
  }

  static removeExtraWindow(win: BrowserWindow): void {
    removeExtraSink(win)
  }

  static getExtraWindows(): Set<BrowserWindow> {
    return extraSinks()
  }

  // ---------------------------------------------------------------------------
  // Instance fields
  // ---------------------------------------------------------------------------

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
   * Broadcast a domain event to this session's window and every extra window.
   *
   * SyncCore phase 4a: delegates to the emission funnel, so the event is appended
   * to the ring and applied to canonical state BEFORE it is delivered — the
   * ordering that makes "a snapshot at seq N contains every event through N"
   * true by construction. Delivery semantics are unchanged: `this.win` (the
   * session's OWN window, not a process-global one) plus all extras.
   *
   * `routingId` rides as `args[0]`, which is the wire encoding of contract 2's
   * `sessionId` — positional, not a named field (see sync-core.md §"Wire
   * encoding"). It is read fresh on every send, so a rekey mid-turn is picked up
   * without any re-registration.
   */
  protected send(channel: string, data: unknown): void {
    emitEvent(channel, [this.routingId, data], 'all', this.win)
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
