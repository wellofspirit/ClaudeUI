import type { BrowserWindow } from 'electron'
import type {
  ChatMessage,
  SessionStatus,
  EngineId,
  ApprovalDecision,
  PermissionSuggestion,
  ModelCostEntry
} from '../../shared/types'
import type { ResolvedCapabilities } from '../../shared/model-capabilities'
import type { ISession } from './ISession'
import { dispatchedCostsByRouting } from '../services/db'
import { logger } from '../services/logger'

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

  private static extraWindows = new Set<BrowserWindow>()

  static addExtraWindow(win: BrowserWindow): void {
    this.extraWindows.add(win)
  }

  static removeExtraWindow(win: BrowserWindow): void {
    this.extraWindows.delete(win)
  }

  static getExtraWindows(): Set<BrowserWindow> {
    return this.extraWindows
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
   * Broadcast an IPC event to the main window and all extra windows.
   * Identical semantics to the former private ClaudeSession.send().
   */
  protected send(channel: string, data: unknown): void {
    if (!this.win.isDestroyed()) {
      this.win.webContents.send(channel, this.routingId, data)
    }
    for (const w of BaseSession.extraWindows) {
      if (!w.isDestroyed()) w.webContents.send(channel, this.routingId, data)
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
