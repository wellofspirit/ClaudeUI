import type { BrowserWindow } from 'electron'
import { v4 as uuid } from 'uuid'
import { opencodeServerManager } from './OpencodeServerManager'
import type { ServerConnection } from './OpencodeServerManager'
import { OpencodeClient } from './OpencodeClient'
import { BaseSession } from '../providers/BaseSession'
import type { EngineSpawnOptions } from '../providers/ISession'
import type { ResolvedCapabilities } from '../../shared/model-capabilities'
import { resolveOpencodeCapabilities } from '../../shared/model-capabilities'
import type {
  ChatMessage,
  ContentBlock,
  SessionStatus,
  ApprovalDecision,
  PermissionSuggestion,
  PendingApproval,
  AccountRef,
  MeteringSnapshot,
  AutoModeConfig,
  AskUserQuestion,
  StatusLineData,
  SkillInfo,
  ModelCostEntry
} from '../../shared/types'
import { opencodeModel } from '../../shared/types'
import {
  getOpencodeModelContextWindow,
  getOpencodeModelCapabilities,
  discoverOpencodeModels,
  parseModelString
} from './model-discovery'
import { equivalentCostUsd } from '../../shared/pricing'
import { logger } from '../services/logger'
import {
  mapEvent,
  extractToolResult,
  convertStoredMessage,
  computeStoredDurationMs
} from './event-mapper'
import type { MapperOutput, MessageAccumulator } from './event-mapper'
import { BashStreamGate } from './bash-stream-gate'
import { discoverOpencodeSkills } from './command-skill-discovery'
import { opencodeAuthProvider } from '../auth/OpencodeAuthProvider'
import { recordUsageEvent } from '../services/usage-recorder'
import { loadClaudePermissions, saveClaudePermissions } from '../services/claude-settings'
import {
  compileClaudeRulesToOpencode,
  suggestionDestinationToScope,
  suggestionRuleToClaudeString,
  withoutAllowRules
} from './permission-compiler'
import type { OpencodePermissionRule } from './permission-compiler'
import { matchesUserAskRule } from './wildcard'
import { makeJudgeTransportWithFallback } from './judge-transport'
import type { JudgeEndpointProbe } from './judge-transport'
import {
  classify,
  isAutoModeFastPathAllowed,
  type EnvironmentInfo,
  type JudgeTransport
} from '../automode/classifier'
import { AutoModeDenialTracker, formatAutoModeDenyReason } from '../automode/denial-tracker'
import {
  analyzeRedirects,
  captureGitRemotes,
  captureGitStatus,
  captureRepoVisibility,
  needsGitStatus,
  needsRepoVisibility,
  recordToolOutcome,
  shellCommandOf,
  tempDirRoots,
  type GitRemote,
  type RepoVisibility,
  type ToolOutcome
} from '../automode/ground-truth'
import { loadEngineConfig } from '../services/ui-config'
import type { ClaudePermissions, PermissionScope } from '../../shared/types'
import { blockUsageService } from '../services/block-usage'
import { crossEngineDispatcher, crossEngineDispatchAvailable } from '../services/cross-engine-dispatcher'
// Permission ruleset helper — extracted to permission-ruleset.ts so
// cross-engine-dispatcher.ts can depend on it without importing THIS module
// (which would cycle back now that this file imports crossEngineDispatcher
// above). Re-exported here for back-compat with any other existing importer.
import { buildRuleset } from './permission-ruleset'
import type { PermissionRule } from './permission-ruleset'
export { buildRuleset } from './permission-ruleset'
export type { PermissionRule } from './permission-ruleset'

const DEFAULT_MODEL = 'opencode/mimo-v2.5-free'

/**
 * Gates the ClaudeUI-hosted `claudeui_dispatch_agent` tool (ADR-033 M2) in
 * EVERY autonomy mode, appended LAST (after buildRuleset + the user's own
 * compiled rules) so last-match-wins can't accidentally auto-allow it via a
 * blanket user rule. In `auto`/`full` mode the ADR-023 LLM gatekeeper fields
 * the resulting permission.asked like any other gated tool — intended parity,
 * not a special case.
 */
const DISPATCH_AGENT_ASK_RULE: PermissionRule = {
  permission: 'claudeui_dispatch_agent',
  pattern: '*',
  action: 'ask'
}

/**
 * The ruleset every THROWAWAY opencode session is patched with before it is
 * prompted (the auto-mode judge, `/btw` side questions). Both are tool-LESS by
 * design — they must answer from text alone — and both are hazardous without
 * this patch, for two independent reasons:
 *
 *  1. SECURITY. A fresh opencode session inherits the vendor's `{*: allow}`
 *     default (verified: agent.ts's `defaults` = `Permission.fromConfig({"*":
 *     "allow", …})`). The judge is fed a possibly attacker-influenced
 *     transcript and asked to reason about it; an unpatched judge session could
 *     be talked into really running bash/edit, with no human and no gate.
 *  2. LIVENESS. `client.prompt` runs a SYNCHRONOUS server-side turn. An
 *     ask-class action on a session with no SSE consumer emits a
 *     `permission.asked` that our main consumer filters out (foreign
 *     sessionID) and nobody ever answers → the prompt blocks forever → the
 *     parent turn hangs.
 *
 * `deny` (not `ask`) is what makes it hang-proof: opencode's evaluator
 * short-circuits a matching deny with a DeniedError BEFORE the Event.Asked
 * path (permission/index.ts `ask()`), so nothing is ever published.
 * `{permission:'*', pattern:'*'}` matches every tool via `Wildcard.match` →
 * regex `.*`.
 */
const DENY_ALL_TOOLS_RULESET: PermissionRule[] = [{ permission: '*', pattern: '*', action: 'deny' }]

/**
 * The patch body for a throwaway session: deny-all AND sealed.
 *
 * The ruleset alone is not sufficient. opencode stores "always" approvals in
 * INSTANCE-GLOBAL state (not keyed by session) and `evaluate()` appends that
 * list AFTER the session ruleset, with last-match-wins — so any pattern the
 * user ever always-approved anywhere on this server outranks the deny-all
 * above (auto-mode rework plan §7 Q5, confirmed live). `permissionHermetic`
 * is the fork's fix (ADR-037 P2): a sealed session is evaluated against its
 * own ruleset only, and never contributes to the global list either.
 *
 * Sent unconditionally, with no fork detection: the stock PATCH payload
 * schema ignores unknown keys (measured against the unpatched 1.18.9 release
 * build — Effect Schema's default is to strip excess properties), so an
 * unpatched server drops the field and behaves exactly as it does today. A
 * capability probe here would buy nothing and add a failure mode.
 */
const SEALED_THROWAWAY_PATCH = {
  permission: DENY_ALL_TOOLS_RULESET,
  permissionHermetic: true,
} as const

export class OpencodeSession extends BaseSession {
  readonly engineId = 'opencode' as const

  private _capabilities: ResolvedCapabilities
  get capabilities(): ResolvedCapabilities {
    return this._capabilities
  }

  private conn: ServerConnection | null = null
  private client: OpencodeClient | null = null
  private openSessionId: string | null = null
  private sseAbort: AbortController | null = null
  private isProcessing = false
  /**
   * Cost tracking — base + live overlay (Slice B, durable across reloads,
   * mirrors ClaudeSession's costBaseUsd/liveTotalCostUsd split).
   *
   * - costBaseUsd / modelCostBase: cost from stored history, seeded ONCE at
   *   replayStoredHistory (a single OpencodeSession object only ever replays
   *   once — replayStoredHistory is gated on `!this.openSessionId`/`!this.
   *   openSessionId` branches that can't re-fire after openSessionId is set —
   *   so no respawn-fold is needed here, unlike Claude's spawn-per-turn model).
   * - liveTotalCostUsd / liveModelCosts: cost accumulated THIS live session,
   *   since resume/creation. liveTotalCostUsd is synced from
   *   sumAccumulatorCosts(accumulators) (event-mapper.ts) — a full recompute
   *   over live accumulators only, which is why the historical base MUST live
   *   in a separate field rather than seeding the same one sumAccumulatorCosts
   *   writes to (a live cost_update would otherwise overwrite/discard the
   *   seeded historical total).
   *
   * this.totalCostUsd (below) is a getter: costBaseUsd + liveTotalCostUsd.
   */
  private costBaseUsd = 0
  private modelCostBase = new Map<string, number>()
  private liveTotalCostUsd = 0
  /** modelId → summed cost, own (non-child) messages only, populated in
   *  recordTurnUsage at the same point each message's cost is finalized. */
  private liveModelCosts = new Map<string, number>()
  private startTimeMs = 0
  /** Accumulated ACTIVE (turn-processing) duration of completed turns, ms.
   *  Base is reconstructed from stored history on resume (replayStoredHistory),
   *  then incremented per-turn from each `result` event — mirrors Claude's
   *  accTotalDurationMs. Idle time between turns never counts. */
  private accTotalDurationMs = 0
  /** Latest assistant prompt size (input + cacheRead) for context-used % in the status line. */
  private lastContextLength = 0
  private _model: string
  private permissionMode: string
  private reasoningVariant: string | null = null
  private agent: string | null = null
  // Pending permission approvals, requestId → the approval's toolUseId (the
  // tool part's callID, `undefined` if the engine didn't carry one). The value
  // is what lets resolveApproval annotate the RIGHT tool call when the human
  // rejects (phase 3 outcome annotations).
  private pendingApprovals = new Map<string, string | undefined>()
  // Pending model-elicitation questions (question.asked) keyed by requestId.
  // Stored so resolveApproval can map the ordered answers Record→string[][].
  private pendingQuestions = new Map<string, AskUserQuestion[]>()
  // Per-message part accumulator keyed by messageId
  private accumulators = new Map<string, MessageAccumulator>()
  // Track last emitted tool completion per partId to avoid double-emitting
  private emittedToolResults = new Set<string>()
  // Live bash output streaming (own-session only — parity with Claude's
  // bash-output-streaming patch). Dedups unchanged cumulative-output snapshots
  // and throttles emissions to the trailing edge of a ~100ms window per
  // toolUseId; see bash-stream-gate.ts. Cancelled per-toolUseId on tool
  // completion/error and entirely on session teardown (cancel()).
  private bashStreamGate = new BashStreamGate((toolUseId, output) => {
    this.send('session:bash-output', {
      toolUseId,
      output,
      totalLines: output.split('\n').length,
      totalBytes: Buffer.byteLength(output, 'utf-8')
    })
  })
  // Metering: message ids already recorded to usage_event (the accumulators map
  // persists across turns, so without this every session.idle re-iterates all
  // prior messages; the DB UNIQUE(message_id) already dedups, this just avoids
  // the repeated round-trips on long sessions).
  private recordedUsageMessageIds = new Set<string>()
  // Phase 8d — child session routing for the `task` tool.
  // Maps childSessionId → parentToolUseId (the task part's callID).
  // Populated by the event-mapper when it sees a task tool part with
  // state.metadata.sessionId; entries are deleted after the child's
  // session.idle (task-notification dispatch). Cleared in cancel()/dispose().
  private childSessions = new Map<string, string>()
  // Auto-mode (full) LLM gatekeeper state (ADR-023).
  private _autoModeConfig: AutoModeConfig | undefined
  // Consecutive / same-rule / total denial caps, shared with pi (denial-tracker.ts).
  private autoDenials = new AutoModeDenialTracker()
  // Whether THIS session's opencode server exposes the patched tool-less
  // `POST /judge/completion` (ADR-037 P1). Probed once, lazily, on the first
  // judge call; the object identity is the cache, so every judge transport
  // built for this session shares one probe.
  private judgeEndpointProbe: JudgeEndpointProbe = {}
  // The USER-authored half of the last ruleset we patched onto the session
  // (compiled allow/ask/deny). Kept so the auto-mode gatekeeper can re-match a
  // pending approval against the user's own `ask` rules, which outrank the
  // classifier (ADR-023 G9). opencode discards the matched rule before it
  // publishes `permission.asked`, so this is the only way to recover provenance.
  // `null` = not compiled yet. The SSE consumer starts BEFORE the first
  // applyPermissionMode, so an approval can race it — see userOriginRules().
  private lastCompiledUserRules: OpencodePermissionRule[] | null = null
  // ── Phase 3 ground truth (docs/automode-rework-plan.md §5) ────────────────
  // How prior tool calls ended, keyed by toolUseId. Fed to the classifier as
  // `{"outcome":…}` annotations — the ONLY channel by which a refusal reaches
  // the judge, since the slimmer drops tool results. Bounded by
  // recordToolOutcome (MAX_TOOL_OUTCOMES) so a long session can't grow it
  // unboundedly.
  private toolOutcomes = new Map<string, ToolOutcome>()
  // SESSION-START git remotes — resolved once, lazily, at the first classifier
  // use and then frozen for the session's lifetime. Never refreshed: a remote
  // added mid-session is exactly what the exfiltration rules exist to catch, so
  // re-reading would let the agent whitelist its own destination (ref §9.1).
  private sessionRemotes: GitRemote[] | null = null
  private sessionRemotesPromise: Promise<GitRemote[]> | null = null
  // Repo visibility — also resolved at most once per session (a `gh` round trip
  // on the approval hot path), including the 'unknown' answer.
  private sessionRepoVisibility: RepoVisibility | null = null
  private sessionRepoVisibilityPromise: Promise<RepoVisibility> | null = null
  // Discovered command names (populated in run(null) eager connect). Used by
  // run(prompt) to route /command tokens to runCommand instead of promptAsync.
  private knownCommandNames = new Set<string>()
  // Set true by cancel()/dispose(), reset to false at the top of each run(), so
  // ensureConnected() can detect a cancel that landed mid-acquire (during THIS
  // run's connect window) and release the freshly-acquired ref.
  private _cancelled = false
  // Memoized in-flight connection acquire. Both run(null)'s eagerConnect and
  // run(prompt) await the SAME promise, so a prompt sent before the eager
  // acquire resolves does NOT trigger a second acquire (ref-count stays 1).
  private connectingPromise: Promise<void> | null = null
  // Memoized in-flight "establish" (connect + create/resume session + SSE +
  // permission mode) for the FIRST prompt of a turn. A second prompt landing
  // during the connect window (client + openSessionId both still null, up to
  // ~15s) awaits this SAME promise and then steers into the one session it
  // created, instead of taking the main path and calling createSession a second
  // time — which orphaned one session and lost the events filtered to the
  // overwritten openSessionId (M-OC1). Cleared once the first prompt's run()
  // settles (its finally).
  private establishingPromise: Promise<void> | null = null
  // Replay-once memo. On resume BOTH eagerConnect() (run(null)) and
  // establishSession() (run(prompt)) gate on `!openSessionId` with an await
  // window between the check and the set, so a prompt arriving during the eager
  // connect can drive both into replayStoredHistory() for the same session —
  // replaying the whole transcript (and re-emitting every session:message)
  // twice. Memoize on the sessionId: the second caller awaits the SAME in-flight
  // replay (preserving the history-before-new-prompt ordering) and never re-runs.
  private replayInFlight: Promise<void> | null = null
  private replayedSessionId: string | null = null

  // The opencode session id to resume (passed from sidebar when clicking a
  // persisted opencode session). When set, we skip createSession and replay
  // the stored message history before accepting new prompts.
  private resumeSessionId: string | undefined

  /** Resolve capabilities for the current model from the discovery cache. */
  private resolveCapsForModel(): ResolvedCapabilities {
    const { providerID, modelID } = parseModelString(this._model)
    const base = resolveOpencodeCapabilities(getOpencodeModelCapabilities(providerID, modelID))
    // ADR-030/ADR-033 M4-A: the static flag is true (both directions ship),
    // ANDed with the honest runtime check — always true for opencode (Claude
    // is ClaudeUI's bundled default engine), kept explicit rather than
    // hardcoded so the semantics stay identical to the Claude side.
    return {
      ...base,
      crossEngineDispatch: base.crossEngineDispatch && crossEngineDispatchAvailable('opencode')
    }
  }

  constructor(routingId: string, win: BrowserWindow, cwd: string, opts: EngineSpawnOptions = {}) {
    super(routingId, win, cwd)
    // effort/sandboxConfig/thinkingMode/resumeSessionAt/forkSession are intentionally
    // unread — Claude-only options per EngineSpawnOptions' docs / ADR-030.
    this._model = opts.model ?? DEFAULT_MODEL
    this.permissionMode = opts.permissionMode ?? 'default'
    this.resumeSessionId = opts.resumeSessionId || undefined
    this._capabilities = this.resolveCapsForModel()
    this.sendStatus()
    this.sendStatusLine()
    // Warm the auth provider cache asynchronously so account is populated on
    // the next status emit (e.g. when run() begins). A cross-vendor model switch
    // re-reads from the cached map, so this only needs to warm once per session.
    opencodeAuthProvider.warmCache().then(() => { this.sendStatus(); this.sendStatusLine() }).catch(() => {})
  }

  get willQueue(): boolean {
    return this.isProcessing
  }

  /** costBaseUsd + liveTotalCostUsd (see the field doc comment for the split). */
  private get totalCostUsd(): number {
    return this.costBaseUsd + this.liveTotalCostUsd
  }

  /** modelCostBase merged with liveModelCosts, summed per model id. */
  private get modelCostEntries(): ModelCostEntry[] {
    const merged = new Map<string, number>(this.modelCostBase)
    for (const [modelId, cost] of this.liveModelCosts) {
      merged.set(modelId, (merged.get(modelId) ?? 0) + cost)
    }
    return [...merged.entries()].map(([modelId, costUsd]) => ({
      engineId: 'opencode' as const,
      modelId,
      costUsd
    }))
  }

  get status(): SessionStatus {
    const parsed = parseModelString(this._model)
    const account: AccountRef | null = opencodeAuthProvider.buildAccountRef(parsed.providerID)
    return {
      state: this.isProcessing ? 'running' : 'idle',
      sessionId: this.openSessionId,
      model: opencodeModel(parsed.providerID, parsed.modelID),
      cwd: this.cwd,
      totalCostUsd: this.totalCostUsd,
      account,
      ...this.baseStatusFields()
    }
  }

  getSessionId(): string | null {
    return this.openSessionId
  }

  /** Public accessor for cross-engine dispatch (ADR-033 M2) — the caller-session
   *  lookup wired in main/index.ts reads this to inherit autonomy into a
   *  dispatched Claude target. `permissionMode` itself stays private. */
  getAutonomyMode(): string {
    return this.permissionMode
  }

  protected override resetInactivityTimer(): void {
    this.clearInactivityTimer()
    if (this.inactivityTimeoutMs > 0) {
      this.inactivityTimer = setTimeout(() => {
        logger.info('OpencodeSession', `Idle timeout — auto-disconnecting`)
        this.cancel()
      }, this.inactivityTimeoutMs)
    }
  }

  /** Slice C — re-emit the status line so a dispatched-cost update reaches the
   *  TopBar tooltip live (BaseSession.addDispatchedCost's hook). */
  protected override onDispatchedCostsChanged(): void {
    this.sendStatusLine()
  }

  /**
   * Build the ContentBlock[] for a locally-recorded user ChatMessage, mirroring
   * the renderer's optimistic addUserMessage (session-store.ts): attachments
   * first (image/document blocks), then a trailing text block. Keeps
   * getMessages() / replay fidelity for image/PDF attachments sent via opencode.
   */
  private buildUserContent(
    prompt: string,
    attachments?: Array<{ mediaType: string; base64Data: string; fileName?: string }>
  ): ContentBlock[] {
    const content: ContentBlock[] = []
    for (const att of attachments ?? []) {
      if (att.mediaType === 'application/pdf') {
        content.push({
          type: 'document',
          mediaType: 'application/pdf',
          base64Data: att.base64Data,
          fileName: att.fileName
        })
      } else {
        content.push({
          type: 'image',
          mediaType: att.mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
          base64Data: att.base64Data,
          fileName: att.fileName
        })
      }
    }
    if (prompt) content.push({ type: 'text', text: prompt })
    return content
  }

  async run(
    prompt: string | null,
    attachments?: Array<{ mediaType: string; base64Data: string; fileName?: string }>
  ): Promise<void> {
    this.clearInactivityTimer()
    // Reset the cancel flag so it only guards THIS run's connect window. cancel()
    // is also fired by the idle timeout; without this reset a session that
    // idle-timed-out would refuse to reconnect on a subsequent prompt.
    this._cancelled = false

    // ── Eager connect (parity with Claude's spawn-only path) ─────────────────
    // run(null) is called at session creation to warm the connection + discover
    // slash commands / skills before the first prompt arrives. We acquire the
    // server, fetch commands + skills (instance/cwd-scoped, no opencode session
    // needed), emit the two events, and keep the connection for reuse.
    // Any failure degrades silently — opencode is optional. Arm the inactivity
    // timer so an opened-but-never-prompted session still releases its server ref.
    if (prompt === null) {
      void this.eagerConnect()
      this.resetInactivityTimer()
      return
    }

    // ── Steer path: prompt arriving mid-turn coalesces into the running opencode
    // loop. We post immediately — opencode's
    // runLoop re-reads the message list each step and picks it up — then emit
    // session:steer-consumed so the renderer moves the queued card into chat.
    // We do NOT touch isProcessing / startTimeMs / createSession / ensureSSEConsumer /
    // applyPermissionMode — the ongoing turn already owns all of that.
    if (this.isProcessing && this.client && this.openSessionId) {
      const userMsg: ChatMessage = {
        id: uuid(),
        role: 'user',
        content: this.buildUserContent(prompt, attachments),
        timestamp: Date.now()
      }
      this.messageHistory.push(userMsg)
      try {
        await this.sendPrompt(prompt, attachments)
      } catch (err) {
        // The steer was NOT delivered. Emitting session:steer-consumed here
        // (the pre-fix behavior) told the renderer the message was sent while it
        // silently vanished (M-OC9). Roll back the optimistic history push and
        // surface the failure instead — do NOT consume the message.
        logger.warn(
          'OpencodeSession',
          `steer send failed: ${err instanceof Error ? err.message : String(err)}`
        )
        this.messageHistory = this.messageHistory.filter((m) => m !== userMsg)
        this.send('session:error', err instanceof Error ? err.message : String(err))
        return
      }
      this.send('session:steer-consumed', { prompt })
      return
    }

    // ── Second prompt during the connect window (M-OC1) ──────────────────────
    // The steer guard above needs client + openSessionId, both still null while
    // the FIRST prompt is connecting (up to ~15s). A second prompt landing here
    // must NOT fall through to the main path — both would pass `!openSessionId`
    // and call createSession, orphaning one session and losing the events
    // filtered to the overwritten id. Wait for the in-flight establish, then
    // re-enter: the steer guard now holds (client + openSessionId set), so this
    // prompt coalesces into the SINGLE session instead of creating a second.
    if (this.establishingPromise) {
      try {
        await this.establishingPromise
      } catch {
        return // the first prompt's establish failed; it already surfaced session:error
      }
      if (this._cancelled || !this.client || !this.openSessionId || !this.isProcessing) return
      return this.run(prompt, attachments)
    }

    this.isProcessing = true
    this.sendStatus()

    // Memoize the establish phase (connect + create/resume + SSE + permission)
    // so a second prompt during the connect window (above) awaits the SAME
    // establish and never creates a duplicate session (M-OC1).
    const establishing = this.establishSession()
    this.establishingPromise = establishing
    try {
      await establishing
      // Cancelled mid-connect (idle timeout / user cancel) or no session could
      // be established — bail cleanly instead of dereferencing a null
      // client/session below.
      if (!this.client || this._cancelled || !this.openSessionId) {
        this.isProcessing = false
        this.sendStatus()
        this.resetInactivityTimer()
        return
      }

      // 5. Record the user message in local history (for getMessages()). Do NOT
      // emit session:message — the renderer adds the user message optimistically
      // (addUserMessage) and session:send relays session:user-message, mirroring
      // ClaudeSession. Emitting here would render the prompt twice.
      const userMsg: ChatMessage = {
        id: uuid(),
        role: 'user',
        content: this.buildUserContent(prompt, attachments),
        timestamp: Date.now()
      }
      this.messageHistory.push(userMsg)

      // 6. Send prompt — route slash commands to runCommand when the name is known
      this.startTimeMs = Date.now()
      await this.sendPrompt(prompt, attachments)
    } catch (err) {
      logger.error('OpencodeSession', `run() error: ${err instanceof Error ? err.message : String(err)}`)
      this.isProcessing = false
      this.send('session:error', err instanceof Error ? err.message : String(err))
      this.sendStatus()
      this.resetInactivityTimer()
    } finally {
      // Release the memo once THIS prompt's run() settles — a later prompt that
      // arrives after the turn is established takes the steer path directly.
      this.establishingPromise = null
    }
  }

  /**
   * Establish the opencode session for a turn: acquire the connection, create
   * or resume the opencode session, start the SSE consumer, and apply the
   * permission mode. Extracted from run() and memoized there (establishingPromise)
   * so two prompts landing during the connect window share ONE establish and
   * create exactly ONE session (M-OC1). Leaves client/openSessionId null when
   * cancelled mid-connect; the caller checks and bails.
   */
  private async establishSession(): Promise<void> {
    // 1. Connect (memoized — shares the in-flight acquire with eagerConnect so
    //    a prompt sent before the eager acquire resolves never double-acquires).
    await this.ensureConnected()
    if (!this.client || this._cancelled) return

    // 2. Create or resume opencode session
    if (!this.openSessionId) {
      if (this.resumeSessionId) {
        // Resume: reuse the prior session id (skip createSession).
        // Verify the session exists first — if not, fall back to creating fresh.
        try {
          await this.client.getSession(this.resumeSessionId)
          this.openSessionId = this.resumeSessionId
          logger.info('OpencodeSession', `Resuming opencode session ${this.openSessionId}`)
        } catch {
          logger.warn(
            'OpencodeSession',
            `Resume session ${this.resumeSessionId} not found — creating fresh session`
          )
          this.resumeSessionId = undefined
        }
      }
      if (!this.openSessionId) {
        // Omit `title` so opencode stamps its default placeholder
        // ("New session - <ISO>"). That placeholder is what gates opencode's
        // own async title generation (SessionPrompt.ensureTitle fires only when
        // `isDefaultTitle(session.title)` holds). Passing `title: ''` here would
        // store an empty string — which opencode treats as a deliberate
        // user-set title and so NEVER auto-titles — leaving the session
        // permanently "Untitled". The placeholder is mapped back to a friendly
        // label in opencode-session-list.ts until generation lands a real title.
        const s = await this.client.createSession({})
        this.openSessionId = s.id
      }
      // Emit status with the session id so the renderer can rekey
      this.sendStatus()

      // 2a. On resume: replay stored history BEFORE accepting new prompts.
      // This paints the prior transcript in the chat view so the user sees context.
      if (this.resumeSessionId && this.openSessionId === this.resumeSessionId) {
        await this.replayStoredHistory(this.openSessionId)
      }
    }

    // 3. Start SSE consumer BEFORE sending prompt (so no events are missed)
    this.ensureSSEConsumer()

    // 4. Apply autonomy/permission mode
    await this.applyPermissionMode(this.permissionMode)
  }

  /**
   * Load stored messages for a resumed session and replay them to the renderer
   * as `session:message` (and `session:tool-result`) events, in order, BEFORE the
   * first new prompt.  This populates the chat view with the prior transcript.
   *
   * Uses `convertStoredMessage` from the event-mapper for part→block mapping
   * (parity with live turns — no divergent renderer path).
   *
   * Best-effort: any failure is swallowed and logged; it NEVER blocks the new prompt.
   *
   * Memoized (replayInFlight / replayedSessionId) so eagerConnect() and
   * establishSession() racing on resume replay exactly once — see the field docs.
   */
  private async replayStoredHistory(sessionId: string): Promise<void> {
    if (this.replayedSessionId === sessionId) return
    if (this.replayInFlight) return this.replayInFlight
    this.replayInFlight = this.replayStoredHistoryInner(sessionId)
    try {
      await this.replayInFlight
      // Inner swallows its own errors, so reaching here means "attempted" —
      // never replay this session again (a retry would double-emit history).
      this.replayedSessionId = sessionId
    } finally {
      this.replayInFlight = null
    }
  }

  private async replayStoredHistoryInner(sessionId: string): Promise<void> {
    if (!this.client) return
    try {
      const storedMessages = await this.client.listMessages(sessionId)
      logger.info('OpencodeSession', `Replaying ${storedMessages.length} stored messages for ${sessionId}`)

      // Reconstruct the active-duration baseline from history BEFORE any new
      // turn runs (run() sets startTimeMs / accumulates further turns after
      // this call returns) — see computeStoredDurationMs for the semantic.
      this.accTotalDurationMs = computeStoredDurationMs(storedMessages)

      // Slice B — cost durability across reloads: seed costBaseUsd/modelCostBase
      // from stored history BEFORE ensureSSEConsumer() starts (run()/eagerConnect()
      // both call replayStoredHistory before starting the SSE consumer), so the
      // live overlay never has to catch up from zero. listMessages(sessionId)
      // only returns THIS session's own messages — child (subagent) messages
      // live under a distinct session id and are never included here, so no
      // explicit child filtering is needed (mirrors sumAccumulatorCosts/
      // recordTurnUsage excluding children from the live overlay).
      let seededCostBase = 0
      const seededModelCostBase = new Map<string, number>()
      for (const stored of storedMessages) {
        const info = stored.info
        if (!info || info.role !== 'assistant') continue
        const cost = typeof info.cost === 'number' ? info.cost : 0
        seededCostBase += cost
        const modelId = info.modelID
        if (modelId) {
          seededModelCostBase.set(modelId, (seededModelCostBase.get(modelId) ?? 0) + cost)
        }
      }
      this.costBaseUsd = seededCostBase
      this.modelCostBase = seededModelCostBase
      // Slice C — cross-engine dispatched cost durability: seed from
      // dispatched_usage, keyed by this.routingId (the STABLE id a later
      // reopen constructs this session object with — see seedDispatchedCosts'
      // doc comment on BaseSession).
      this.seedDispatchedCosts()
      // Push the seeded totals to the renderer NOW — otherwise the durable
      // cost sits in memory but never reaches the TopBar tooltip until the
      // next live cost_update/result event (which may be turns away, or never,
      // if the user just reopens a session to look at it).
      this.sendStatusLine()

      for (const stored of storedMessages) {
        const msg = convertStoredMessage(stored)
        if (!msg) continue

        // Add to local history (for getMessages() and future turns)
        const idx = this.messageHistory.findIndex((m) => m.id === msg.id)
        if (idx >= 0) {
          this.messageHistory[idx] = msg
        } else {
          this.messageHistory.push(msg)
        }

        // Emit to renderer
        this.send('session:message', msg)

        // Emit tool_result events for completed tool parts so the renderer
        // can display tool output blocks. Mirrors dispatchMapperOutput 'message' case.
        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            this.recordToolOutcome(block.toolUseId, block.isError ? 'error' : 'ok')
            this.send('session:tool-result', {
              toolUseId: block.toolUseId,
              result: block.toolResult,
              isError: block.isError ?? false,
              ...(block.fileDiffs ? { fileDiffs: block.fileDiffs } : {})
            })
          }
        }
      }
    } catch (err) {
      logger.warn(
        'OpencodeSession',
        `replayStoredHistory failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Acquire the opencode server connection + build the client, exactly once.
   * Memoized via `connectingPromise`: concurrent callers (run(null)'s eagerConnect
   * and a racing run(prompt)) await the SAME acquire, so the ref count is always 1.
   * Race safety: if cancel() lands while acquire() is awaiting, the freshly
   * acquired ref is released immediately and conn/client stay null.
   */
  private async ensureConnected(): Promise<void> {
    if (this.conn) return
    if (!this.connectingPromise) {
      this.connectingPromise = (async () => {
        const c = await opencodeServerManager.acquire(this.cwd)
        if (this._cancelled) {
          opencodeServerManager.release(this.cwd)
          return
        }
        this.conn = c
        this.client = new OpencodeClient(c.baseUrl, c.authHeader)
      })().finally(() => {
        this.connectingPromise = null
      })
    }
    await this.connectingPromise
  }

  /**
   * Eager connect: acquire the server (memoized) + discover commands/skills +
   * emit events. Called from run(null); fires and is caught internally (never
   * throws to caller). Degrades silently — opencode is optional.
   *
   * On resume (resumeSessionId set): also replays stored history so the chat
   * view is populated before the user sends a new prompt.
   */
  private async eagerConnect(): Promise<void> {
    try {
      await this.ensureConnected()
      // Cancelled mid-connect, or connect produced no client — bail (no discovery).
      if (!this.client || this._cancelled) return

      // Fetch commands + skills in parallel — both are cwd/instance-scoped,
      // no opencode session needed.
      const [commands, skills] = await Promise.all([
        this.client.listCommands().catch((err) => {
          logger.warn('OpencodeSession', `listCommands failed: ${err instanceof Error ? err.message : String(err)}`)
          return []
        }),
        this.client.listSkills().catch((err) => {
          logger.warn('OpencodeSession', `listSkills failed: ${err instanceof Error ? err.message : String(err)}`)
          return []
        })
      ])

      // Store command names for slash routing in run(prompt)
      this.knownCommandNames = new Set(commands.map((c) => c.name))

      // Emit session:slash-commands — names prefixed with '/' to match Claude's
      // contract (claude-session.ts:883-887). Renderer slash menu is engine-neutral.
      const slashCommands = commands.map((c) => ({
        name: '/' + c.name,
        description: c.description
      }))
      this.send('session:slash-commands', slashCommands)

      // Emit session:skills — name list only (renderer's SkillsDialog calls the
      // IPC to get full details; this just tells it skills are available).
      const skillNames = skills.map((s) => s.name)
      this.send('session:skills', skillNames)

      // Resume path: verify + replay stored history so the chat view is populated
      // before the user sends a new prompt. This mirrors Claude's historical
      // session load (which reads JSONL from disk at sidebar click time).
      if (this.resumeSessionId && !this.openSessionId) {
        try {
          await this.client.getSession(this.resumeSessionId)
          this.openSessionId = this.resumeSessionId
          this.sendStatus()
          await this.replayStoredHistory(this.openSessionId)
        } catch {
          // Session not found on server — clear the resumeSessionId so run(prompt)
          // will create a fresh session instead of attempting to resume.
          logger.warn(
            'OpencodeSession',
            `eagerConnect: resume session ${this.resumeSessionId} not found — will create fresh`
          )
          this.resumeSessionId = undefined
        }
      }

      // Discovery may not have run before this session was constructed (cold cache),
      // in which case capabilities.vision (etc.) defaulted to false. Ensure the model
      // catalog is warm, then recompute + re-emit so image-capable models enable paste.
      await discoverOpencodeModels().catch(() => [])
      const nextCaps = this.resolveCapsForModel()
      if (nextCaps.vision !== this._capabilities.vision || nextCaps.contextWindow !== this._capabilities.contextWindow) {
        this._capabilities = nextCaps
        this.sendStatus()
        this.sendStatusLine()
      }
    } catch (err) {
      // Any failure degrades silently — opencode is optional
      logger.warn(
        'OpencodeSession',
        `eagerConnect failed (opencode optional): ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Route the prompt to runCommand (slash routing) or promptAsync.
   * If prompt starts with /known-command, invoke via the command API.
   * Unknown slash tokens fall through to promptAsync (model sees the literal text).
   * On BadRequest from runCommand, fall back to promptAsync so a name mismatch
   * never wedges the turn.
   */
  private async sendPrompt(
    prompt: string,
    attachments?: Array<{ mediaType: string; base64Data: string; fileName?: string }>
  ): Promise<void> {
    const parsed = parseModelString(this._model)

    // Build file parts once — they ride along with BOTH the runCommand and the
    // promptAsync path so attachments are never dropped on a slash command.
    const fileParts: Array<{ type: 'file'; mime: string; url: string }> = (attachments ?? []).map(
      (att) => ({ type: 'file', mime: att.mediaType, url: `data:${att.mediaType};base64,${att.base64Data}` })
    )

    // Slash command routing — only when we have a live connection + session
    const slashMatch = prompt.match(/^\/(\S+)\s*([\s\S]*)$/)
    if (slashMatch && this.client && this.openSessionId) {
      const commandName = slashMatch[1]
      const commandArgs = (slashMatch[2] ?? '').trim()
      if (this.knownCommandNames.has(commandName)) {
        try {
          await this.client.runCommand(this.openSessionId, {
            command: commandName,
            arguments: commandArgs,
            // Carry any file attachments into the command turn.
            ...(fileParts.length > 0 ? { parts: fileParts } : {})
          })
          // Success — SSE consumer handles the streaming output + session.idle
          return
        } catch (err) {
          // BadRequest ("Available commands: …") or other error — fall back to
          // promptAsync so the turn isn't wedged by an edge-case name mismatch.
          logger.warn(
            'OpencodeSession',
            `runCommand(${commandName}) failed, falling back to promptAsync: ${err instanceof Error ? err.message : String(err)}`
          )
          // Fall through to promptAsync below
        }
      }
    }

    // Default path: send via promptAsync (model sees literal prompt text)
    const parts: Array<{ type: 'text'; text: string } | { type: 'file'; mime: string; url: string }> = [
      { type: 'text', text: prompt },
      ...fileParts
    ]
    await this.client!.promptAsync(this.openSessionId!, {
      model: { providerID: parsed.providerID, modelID: parsed.modelID },
      agent: this.agent ?? undefined,
      parts,
      ...(this.reasoningVariant != null ? { variant: this.reasoningVariant } : {})
    })
  }

  private ensureSSEConsumer(): void {
    if (this.sseAbort) return // already running
    this.sseAbort = new AbortController()
    // Fire and forget — runs in background
    this.consumeEvents().catch((err) => {
      if (!this.sseAbort?.signal.aborted) {
        logger.error('OpencodeSession', `SSE consumer error: ${err instanceof Error ? err.message : String(err)}`)
      }
    })
  }

  private async consumeEvents(): Promise<void> {
    const abort = this.sseAbort
    if (!abort) return
    const signal = abort.signal
    if (!this.client || !this.openSessionId) {
      // Never actually started — release the guard so a later run() can retry.
      if (this.sseAbort === abort) this.sseAbort = null
      return
    }
    // Starts at liveTotalCostUsd (0 for a fresh/just-resumed session) — NOT
    // this.totalCostUsd (costBaseUsd + liveTotalCostUsd) — because
    // sumAccumulatorCosts (event-mapper.ts) always REPLACES this ref with a
    // full recompute over the (base-less) live accumulators map. Seeding it
    // with the base here would just get discarded on the first cost_update;
    // the base is combined with the live value only at the totalCostUsd getter.
    const totalCostRef = { value: this.liveTotalCostUsd }

    try {
      for await (const ev of this.client.subscribeEvents(signal)) {
        if (signal.aborted) break
        if (!this.openSessionId) continue

        const output = mapEvent(ev, this.openSessionId, this.accumulators, this.startTimeMs, totalCostRef, this.childSessions)
        this.liveTotalCostUsd = totalCostRef.value

        this.dispatchMapperOutput(output)
      }
    } catch (err) {
      if (!signal.aborted) {
        logger.error('OpencodeSession', `SSE stream error: ${err instanceof Error ? err.message : String(err)}`)
      }
    } finally {
      // The event stream ended. opencode holds this subscription open for the
      // whole session, so a NON-aborted end means the server died or the
      // transport broke (the vendor also ends the stream on instance dispose).
      // Pre-fix, sseAbort stayed non-null → ensureSSEConsumer() no-opped forever,
      // isProcessing stayed stuck true, interrupt() waited on a session.idle that
      // never comes, and every later run() steered into a dead session (H20).
      // Clear the guard so the next run() re-establishes the consumer; on an
      // unexpected mid-turn end, unwedge isProcessing and surface the drop.
      const deliberate = signal.aborted
      if (this.sseAbort === abort) this.sseAbort = null
      if (!deliberate && this.isProcessing) {
        this.isProcessing = false
        this.send('session:error', 'opencode connection lost — resend to reconnect')
        this.sendStatus()
        this.resetInactivityTimer()
      }
    }
  }

  private dispatchMapperOutput(output: MapperOutput): void {
    switch (output.kind) {
      case 'stream':
        this.send('session:stream', { type: output.streamType, text: output.delta })
        break

      case 'message': {
        const msg = output.message
        // Upsert into local history
        const idx = this.messageHistory.findIndex((m) => m.id === msg.id)
        if (idx >= 0) {
          this.messageHistory[idx] = msg
        } else {
          this.messageHistory.push(msg)
        }
        this.send('session:message', msg)

        // Check for newly completed tool parts in the accumulator
        const acc = this.accumulators.get(msg.id)
        if (acc) {
          for (const [partId, snap] of acc.parts) {
            const cacheKey = `${msg.id}:${partId}`
            if (!this.emittedToolResults.has(cacheKey)) {
              const toolRes = extractToolResult(partId, snap)
              if (toolRes) {
                this.emittedToolResults.add(cacheKey)
                // Phase 3: the classifier's `{"outcome":…}` annotation for this
                // call. Recorded HERE rather than derived from messageHistory at
                // classify time because live assistant messages carry no
                // tool_result blocks at all (buildChatMessage emits tool_use
                // only — results are a separate channel); deriving would work
                // only for replayed history and miss the in-turn retry, which is
                // precisely what Transient Retry needs to see.
                this.recordToolOutcome(toolRes.toolUseId, toolRes.isError ? 'error' : 'ok')
                this.send('session:tool-result', toolRes)
              }
            }
          }

          // Live bash output streaming (parity with Claude's bash-output-streaming
          // patch): while a `bash` tool part is still running, opencode's shell tool
          // republishes a cumulative stdout+stderr tail preview on state.metadata.output.
          // Feed it through bashStreamGate so LiveBashOutput updates during the run
          // instead of only after completion. Own-session only — subagent-message
          // (child) dispatch never reaches this branch. On completion/error, drop the
          // gate's tracking for this toolUseId (the final result is already covered by
          // the session:tool-result emitted above).
          for (const [partId, snap] of acc.parts) {
            if (snap.type !== 'tool' || snap.toolName !== 'bash') continue
            const toolUseId = snap.callID ?? partId
            const status = snap.state?.status
            if (status === 'completed' || status === 'error') {
              this.bashStreamGate.cancel(toolUseId)
              continue
            }
            if (status !== 'running') continue
            const liveOutput = snap.state?.metadata?.output
            if (typeof liveOutput === 'string' && liveOutput.length > 0) {
              this.bashStreamGate.update(toolUseId, liveOutput)
            }
          }
        }
        break
      }

      case 'approval': {
        const approval = output.approval
        this.pendingApprovals.set(approval.requestId, approval.toolUseId)

        if (approval.toolName === 'AskUserQuestion') {
          // Model-elicitation questions (question.asked) must ALWAYS go to the
          // human regardless of autonomy mode — the auto-mode classifier judges
          // tool PERMISSIONS, not user-facing structured questions. Store the
          // question list so resolveApproval can map answers in order.
          const input = approval.input as { questions?: AskUserQuestion[] }
          this.pendingQuestions.set(approval.requestId, input.questions ?? [])
          this.send('session:approval-request', approval)
        } else {
          // Permission approval: auto mode (full) → LLM gatekeeper; else → human.
          // See ADR-023.
          if (this.isAutoMode(this.permissionMode)) {
            void this.handleAutoModeApproval(approval)
          } else {
            this.send('session:approval-request', approval)
          }
        }
        break
      }

      case 'approval-resolved': {
        // M-OC2: a permission was resolved server-side (`permission.replied`) —
        // either the reply we sent, or a sibling the vendor cascade-rejected /
        // cascade-approved. Clear our local pending bookkeeping so a later reply
        // can't fire, and retract the (now-stale) card in the renderer via the
        // existing dismiss channel. All are no-ops if the request is unknown.
        const { requestId } = output
        this.pendingApprovals.delete(requestId)
        this.pendingQuestions.delete(requestId)
        this.send('session:approval-dismiss', { requestId })
        break
      }

      case 'result':
        this.isProcessing = false
        // Turn just completed — its wall-clock cost moves from the live
        // "in flight" delta (turnStartedAtMs) into the completed-turns total.
        this.accTotalDurationMs += output.result.durationMs ?? 0
        // Metering (Phase 7 Pass 1) — record one usage_event per assistant
        // message in this turn. We record at session.idle (result) so we have
        // the final cumulative token + cost state for each message_id.
        this.recordTurnUsage()
        // Metering (Phase 7 Pass 2) — emit the engine-neutral MeteringSnapshot.
        this.sendMetering()
        // Status line — emit final values at turn end (parity with Claude's result emit).
        this.sendStatusLine()
        // Phase 9b — refresh the per-engine dashboard immediately when an opencode
        // turn ends. Without this, the opencode section only updates on the Claude
        // usage poll (which may not fire at all in opencode-only sessions).
        // recalculate() is self-guarded with a concurrency flag, so back-to-back
        // turns queue safely.
        blockUsageService.recalculate().catch(() => {})
        // output.result.totalCostUsd is the LIVE-only value (event-mapper's
        // totalCostUsd ref has no notion of the seeded historical base) —
        // override with the getter so a resumed session's result payload
        // reports the same durable total as the status line / session:status.
        this.send('session:result', { ...output.result, totalCostUsd: this.totalCostUsd })
        this.sendStatus()
        this.resetInactivityTimer()
        break

      case 'cost_update':
        // totalCostUsd already updated via ref. Update lastContextLength from the
        // latest assistant message's cumulative token snapshot (input + cacheRead is
        // the running prompt size — the "context used" dimension). Then emit the
        // status line live so the renderer updates during the turn (parity with Claude).
        if (output.tokens) {
          this.lastContextLength = (output.tokens.input ?? 0) + (output.tokens.cache?.read ?? 0)
        }
        this.sendStatusLine()
        break

      case 'auth-required':
        this.isProcessing = false
        this.send('session:vendor-auth-required', { vendorId: output.vendorId, message: output.message })
        this.sendStatus()
        this.resetInactivityTimer()
        break

      case 'error':
        this.isProcessing = false
        this.send('session:error', output.message)
        this.sendStatus()
        this.resetInactivityTimer()
        break

      case 'subagent-stream':
        this.send('session:subagent-stream', {
          toolUseId: output.toolUseId,
          type: output.streamType,
          text: output.delta
        })
        break

      case 'subagent-message': {
        const { toolUseId, message } = output
        this.send('session:subagent-message', { toolUseId, message })

        // Extract newly completed child tool parts → session:subagent-tool-result.
        // Mirrors the own 'message' case's extractToolResult + emittedToolResults dedup.
        const childAcc = this.accumulators.get(message.id)
        if (childAcc) {
          for (const [partId, snap] of childAcc.parts) {
            const cacheKey = `${message.id}:${partId}`
            if (!this.emittedToolResults.has(cacheKey)) {
              const toolRes = extractToolResult(partId, snap)
              if (toolRes) {
                this.emittedToolResults.add(cacheKey)
                this.send('session:subagent-tool-result', {
                  toolUseId,
                  toolResultToolUseId: toolRes.toolUseId,
                  result: toolRes.result,
                  isError: toolRes.isError,
                  ...(toolRes.fileDiffs ? { fileDiffs: toolRes.fileDiffs } : {})
                })
              }
            }
          }
        }
        break
      }

      case 'task-notification':
        this.send('session:task-notification', output.notification)
        // Tidy: remove the completed/failed child mapping so its sessionId is no
        // longer tracked (also prevents a future session with the same id from
        // being misrouted if opencode reuses ids).
        if (output.notification.toolUseId) {
          this.childSessions.delete(output.notification.taskId)
        }
        break

      case 'todos':
        // Feed the floating Todo widget via the existing session:plan channel,
        // which is already wired through preload → useClaudeEvents.onPlanSteps → setTodos.
        this.send('session:plan', output.items)
        break

      case 'ignore':
        break
    }
  }

  async interrupt(): Promise<void> {
    if (this.client && this.openSessionId) {
      try {
        await this.client.abortSession(this.openSessionId)
      } catch (err) {
        logger.warn('OpencodeSession', `abort failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  cancel(): void {
    this.clearInactivityTimer()
    this._cancelled = true
    this.isProcessing = false
    this.lastContextLength = 0
    this.sseAbort?.abort()
    this.sseAbort = null
    this.childSessions.clear()
    // Tear down any cross-engine dispatch targets owned by this session
    // (ADR-033 M2 — mirrors ClaudeSession.cancel()'s identical call).
    crossEngineDispatcher.disposeFor(this.routingId)
    // Drop all pending bash-output throttle timers — nothing left to flush to
    // once the SSE consumer stops; a firing timer after teardown would send()
    // to a session that's going away.
    this.bashStreamGate.cancelAll()
    // Interrupt the turn server-side BEFORE releasing our server ref. Releasing
    // only KILLS the opencode process when we hold the LAST ref; if another
    // same-cwd session keeps the server alive, our turn would otherwise keep
    // running headless (no SSE consumer), burning tokens until it finishes.
    // Fire-and-forget: if we ARE the last ref the release below kills the
    // process and this in-flight abort just fails silently. Captured before the
    // release nulls `this.client`.
    if (this.client && this.openSessionId) {
      // Optional-chain the result: cancel() runs on the teardown path (dispose)
      // and must never throw. abortSession returns a Promise in production, but
      // a partial/mock client can return undefined — `?.catch` keeps teardown
      // crash-proof either way.
      void this.client.abortSession(this.openSessionId)?.catch(() => {})
    }
    if (this.conn) {
      opencodeServerManager.release(this.cwd)
      this.conn = null
      this.client = null
    }
    this.sendStatus()
  }

  resolveApproval(
    requestId: string,
    decision: ApprovalDecision,
    answers?: Record<string, string>,
    updatedPermissions?: PermissionSuggestion[]
  ): void {
    const approvalToolUseId = this.pendingApprovals.get(requestId)
    this.pendingApprovals.delete(requestId)
    if (!this.client) return

    // ── Model-elicitation question (question.asked) ──────────────────────────
    // These are entirely separate from permission approvals: we reply via
    // /question/{id}/reply (with answers) or /question/{id}/reject, NOT
    // /permission/{id}/reply. The stored pendingQuestions list provides the
    // ordered question objects so we can reconstruct the string[][] answers
    // that opencode expects.
    if (this.pendingQuestions.has(requestId)) {
      const questions = this.pendingQuestions.get(requestId)!
      this.pendingQuestions.delete(requestId)

      const allow = decision === 'allow' || decision === 'allowForSession'
      if (allow && answers) {
        // Map answers: Record<string,string> → string[][] in question ORDER.
        // Key: q.question || 'q' + index  (mirrors AskUserQuestionBlock View.tsx keyOf)
        // MultiSelect values: comma-space joined → split back to string[]
        // Single-select: wrap as [value]
        const mapped: string[][] = questions.map((q, i) => {
          const key = q.question || `q${i}`
          const raw = answers[key] ?? ''
          if (q.multiSelect) {
            // AskUserQuestionBlock joins selections with ', '
            return raw ? raw.split(', ') : []
          }
          return raw ? [raw] : []
        })
        this.client.replyQuestion(requestId, mapped).catch((err) => {
          logger.warn('OpencodeSession', `replyQuestion failed: ${err instanceof Error ? err.message : String(err)}`)
        })
      } else {
        // deny or allow without answers → reject the question
        this.client.rejectQuestion(requestId).catch((err) => {
          logger.warn('OpencodeSession', `rejectQuestion failed: ${err instanceof Error ? err.message : String(err)}`)
        })
      }
      return
    }

    // ── Permission approval (permission.asked) ───────────────────────────────
    const allow = decision === 'allow' || decision === 'allowForSession'
    // "always allow" = the user checked persist-rule suggestions in the dialog.
    const persist = allow && !!updatedPermissions && updatedPermissions.length > 0
    // 'always' tells opencode to remember the allow for this session; we send it
    // for an explicit allowForSession OR when the user checked "always allow".
    const reply = !allow ? 'reject' : persist || decision === 'allowForSession' ? 'always' : 'once'
    // On deny, attach model-visible feedback (parity with claude-session.ts):
    // reject-with-message → CorrectedError → the tool call fails but the turn
    // continues, so the model can adjust and retry instead of dying.
    const message = reply === 'reject' ? answers?.feedback || 'User denied' : undefined

    // Phase 3 — a HUMAN refusal is the strongest signal the judge can get: it
    // makes the Transient Retry exception inapplicable to a re-attempt and
    // turns the retry into a consent question. Only a reject maps here; an
    // allow leaves the call to report its own ok/error outcome.
    if (reply === 'reject' && approvalToolUseId) {
      this.recordToolOutcome(approvalToolUseId, 'rejected-by-user')
    }

    const replied = message
      ? this.client.replyPermission(requestId, reply, message)
      : this.client.replyPermission(requestId, reply)
    replied.catch((err) => {
      logger.warn('OpencodeSession', `replyPermission failed: ${err instanceof Error ? err.message : String(err)}`)
    })

    // Persist the rule to the shared store so it recompiles onto opencode next
    // spawn + shows in PermissionsDialog (session + shared store — ADR-022).
    if (persist) this.persistAllowRules(updatedPermissions!)
  }

  /** Write "always allow" suggestions to the shared Claude permission store. */
  private persistAllowRules(suggestions: PermissionSuggestion[]): void {
    try {
      const byScope = new Map<'user' | 'project' | 'local', string[]>()
      for (const s of suggestions) {
        if (s.type !== 'addRules' || s.behavior !== 'allow' || !s.rules) continue
        const scope = suggestionDestinationToScope(s.destination)
        if (!scope) continue // 'session' → opencode's 'always' reply already covers it
        const arr = byScope.get(scope) ?? []
        for (const r of s.rules) arr.push(suggestionRuleToClaudeString(r))
        byScope.set(scope, arr)
      }
      for (const [scope, ruleStrings] of byScope) {
        const perms = loadClaudePermissions(scope, this.cwd)
        const allowSet = new Set(perms.allow)
        for (const r of ruleStrings) allowSet.add(r)
        saveClaudePermissions(scope, { ...perms, allow: [...allowSet] }, this.cwd)
      }
    } catch (err) {
      logger.warn(
        'OpencodeSession',
        `persisting allow rules failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  async setModel(model: string): Promise<void> {
    this._model = model
    this._capabilities = this.resolveCapsForModel()
    // Reset the reasoning variant — the new model may have different variants.
    this.reasoningVariant = null
    this.sendStatus()
    this.sendStatusLine()
  }

  setReasoningVariant(variant: string | null): void {
    this.reasoningVariant = variant
  }

  async setPermissionMode(mode: string): Promise<void> {
    this.permissionMode = mode
    if (this.openSessionId && this.client) {
      // applyPermissionMode now fails CLOSED (throws). Surface that as an error
      // banner rather than rejecting the IPC call — a rejected
      // `session:set-permission-mode` invoke would blow up in the renderer with
      // no user-visible explanation. The session keeps the OLD server-side
      // ruleset (never a widened one), `this.permissionMode` holds the newly
      // requested mode, and the next `run()` re-applies it — failing the TURN
      // if it still can't be applied. The prompt boundary, not this setter, is
      // where the fail-closed guarantee actually has to hold.
      try {
        await this.applyPermissionMode(mode)
      } catch (err) {
        this.send('session:error', err instanceof Error ? err.message : String(err))
      }
    }
    this.send('session:permission-mode', mode)
  }

  private async applyPermissionMode(mode: string): Promise<void> {
    if (!this.client || !this.openSessionId) return
    // Plan mode additionally switches to opencode's read-only `plan` agent
    // (its planning system prompt + plan_exit flow); all other modes use the
    // default `build` agent. We ALWAYS patch a ruleset (including plan) so the
    // session's effective permissions are deterministic and never inherit a
    // stale override from a previous mode. See buildRuleset / ADR-022.
    this.agent = mode === 'plan' ? 'plan' : null
    // In auto mode (full + classifier enabled) we use the acceptEdits base so the
    // ruleset auto-allows reads + edits and only bash/webfetch raise
    // `permission.asked` → the classifier judges just those (the acceptEdits-
    // equivalence fast-path, parity with cli.js). Classifier-disabled `full`
    // falls through to buildRuleset('full') = the gated `default` (ADR-023).
    const autoMode = this.isAutoMode(mode)
    const baseMode = autoMode ? 'acceptEdits' : mode
    // Compose: autonomy-mode base ruleset + the user's neutral permission rules
    // (Claude's allow/ask/deny + additionalDirectories) compiled to opencode and
    // appended AFTER the base so they override it (last-match-wins). This makes
    // the SAME configured rules apply to opencode as to Claude. See ADR-022.
    const userRules = this.compiledUserRules()
    // Remember the user-origin half for the auto-mode ask-rule precedence check
    // (G9) — see `lastCompiledUserRules`. This keeps the FULL set including the
    // allow rules the patched ruleset drops below: G9's re-match honours
    // opencode's last-match-wins over the user half, so feeding it a filtered
    // view would be lying to the provenance check about what the user wrote.
    // A formerly-allowed action re-matches as `allow` there → not an ask rule →
    // it goes to the JUDGE, which is the whole point of the filter. (Only the
    // ask tier is read back, and the compiler emits allow→ask→deny, so an ask
    // already outranks an allow under last-match-wins either way.)
    this.lastCompiledUserRules = userRules
    // AUTO MODE: patch the user's ALLOW rules OUT of the session ruleset, so the
    // actions they would have silently auto-allowed raise `permission.asked` and
    // reach the classifier instead of bypassing it (cli.js §3 step 2 parity —
    // see `withoutAllowRules` for the full reasoning and the live evasion that
    // motivated it). Ask + deny + the base + DISPATCH_AGENT_ASK_RULE are
    // unchanged; every other mode keeps the full compiled set.
    const effectiveUserRules = autoMode ? withoutAllowRules(userRules) : userRules
    const ruleset = [...buildRuleset(baseMode), ...effectiveUserRules, DISPATCH_AGENT_ASK_RULE]
    try {
      await this.client.patchSession(this.openSessionId, { permission: ruleset })
    } catch (err) {
      // FAIL CLOSED. This patch is the ONLY thing standing between the user's
      // chosen autonomy mode (+ their deny rules) and the vendor's `{*: allow}`
      // session default (agent.ts's `defaults`). Warn-and-continue meant a
      // transient 500 / dropped connection silently downgraded a `plan` or
      // `default` session to allow-everything for the whole turn — the model
      // then edits and runs commands with no gate and no prompt, and the user
      // sees nothing but a log line. Throwing propagates to `run()`'s catch,
      // which emits `session:error` and NEVER reaches `sendPrompt`: no prompt,
      // no tools, a visible error instead of a silent fail-open.
      const detail = err instanceof Error ? err.message : String(err)
      logger.error('OpencodeSession', `patchSession failed (refusing to run ungated): ${detail}`)
      throw new Error(`Could not apply permission mode "${mode}" to the opencode session: ${detail}`)
    }
  }

  /** Merge the user/project/local permission scopes. Best-effort: a load/parse
   *  failure yields empty permissions rather than breaking the turn. Read fresh
   *  each time so a settings.json edit mid-session takes effect. */
  private mergedUserPermissions(): ClaudePermissions {
    const merged: ClaudePermissions = {
      allow: [],
      deny: [],
      ask: [],
      additionalDirectories: [],
      defaultMode: undefined
    }
    try {
      const scopes: PermissionScope[] = ['user', 'project', 'local']
      for (const scope of scopes) {
        const p = loadClaudePermissions(scope, this.cwd)
        merged.allow.push(...p.allow)
        merged.ask.push(...p.ask)
        merged.deny.push(...p.deny)
        merged.additionalDirectories.push(...p.additionalDirectories)
      }
    } catch (err) {
      logger.warn(
        'OpencodeSession',
        `loading user permission rules failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
    return merged
  }

  /** Merge the user/project/local permission scopes and compile them to opencode
   *  rules (allow→ask→deny). Best-effort: a load/parse failure yields no rules
   *  rather than breaking the turn. */
  private compiledUserRules(): ReturnType<typeof compileClaudeRulesToOpencode> {
    try {
      return compileClaudeRulesToOpencode(this.mergedUserPermissions())
    } catch (err) {
      logger.warn(
        'OpencodeSession',
        `compiling user permission rules failed: ${err instanceof Error ? err.message : String(err)}`
      )
      return []
    }
  }

  // ── Auto mode (full) LLM permission gatekeeper (ADR-023) ──────────────────

  private autoModeConfig(): AutoModeConfig {
    if (this._autoModeConfig === undefined) {
      try {
        this._autoModeConfig = loadEngineConfig('opencode').autoMode ?? {}
      } catch {
        this._autoModeConfig = {}
      }
    }
    return this._autoModeConfig
  }

  /** The user-authored (compiled) rules the last patched ruleset carried. Falls
   *  back to compiling them on demand: the SSE consumer is started before the
   *  first `applyPermissionMode`, so a `permission.asked` can arrive before the
   *  cache is warm, and G9 must not silently degrade to "no user rules". */
  private userOriginRules(): OpencodePermissionRule[] {
    if (this.lastCompiledUserRules === null) {
      this.lastCompiledUserRules = this.compiledUserRules()
    }
    return this.lastCompiledUserRules
  }

  /** Record how a tool call ended, for the classifier's `{"outcome":…}`
   *  annotations. Bounded + decision-sticky — see recordToolOutcome. */
  private recordToolOutcome(toolUseId: string, outcome: ToolOutcome): void {
    recordToolOutcome(this.toolOutcomes, toolUseId, outcome)
  }

  /** Session-start git remotes, captured ONCE and frozen (ref §9.1). The
   *  promise is memoized too, so two approvals racing the first classifier call
   *  share a single `git remote -v`. Never throws — an empty list is the
   *  policy's restrictive fallback. */
  private async sessionGitRemotes(): Promise<GitRemote[]> {
    if (this.sessionRemotes) return this.sessionRemotes
    this.sessionRemotesPromise ??= captureGitRemotes(this.cwd)
    this.sessionRemotes = await this.sessionRemotesPromise
    return this.sessionRemotes
  }

  /** Repo visibility, resolved at most once per session ('unknown' included —
   *  it is a real answer meaning "we looked and could not tell"). */
  private async sessionVisibility(): Promise<RepoVisibility> {
    if (this.sessionRepoVisibility) return this.sessionRepoVisibility
    this.sessionRepoVisibilityPromise ??= captureRepoVisibility(this.cwd)
    this.sessionRepoVisibility = await this.sessionRepoVisibilityPromise
    return this.sessionRepoVisibility
  }

  /** Host-supplied ground truth for the classifier's Environment section
   *  (plan phase 2 + 3). Trust slots come from the user's engine config and
   *  default to EMPTY — the policy renders "nothing is trusted" for an empty
   *  slot, so omitting a list is the restrictive choice, not the permissive one.
   *
   *  `repoVisibility` is only filled with a DEFINITE answer: leaving it unset
   *  renders the policy's "unknown — assume PRIVATE for confidentiality, assume
   *  PUBLIC for secret exposure" guidance, which is strictly more useful than
   *  the bare word "unknown". */
  private async classifierEnvironment(): Promise<EnvironmentInfo> {
    const cfg = this.autoModeConfig()
    const additionalDirectories = [...new Set(this.mergedUserPermissions().additionalDirectories)]
    const remotes = await this.sessionGitRemotes()
    const visibility = this.sessionRepoVisibility
    return {
      cwd: this.cwd,
      platform: process.platform,
      ...(remotes.length ? { remotes } : {}),
      ...(visibility && visibility !== 'unknown' ? { repoVisibility: visibility } : {}),
      ...(additionalDirectories.length ? { additionalDirectories } : {}),
      ...(cfg.trustedDomains?.length ? { trustedDomains: cfg.trustedDomains } : {}),
      ...(cfg.trustedRegistries?.length ? { trustedRegistries: cfg.trustedRegistries } : {}),
      ...(cfg.protectedPatterns?.length ? { protectedPatterns: cfg.protectedPatterns } : {})
    }
  }

  /** Per-ACTION measured ground truth → the classifier's `{"meta":{…}}` line
   *  (ref §5). Only shell-like actions qualify, only the command shapes the
   *  reference names trigger a capture, and a capture that fails contributes
   *  NOTHING — a fabricated `{"clean":true}` would clear the policy's dirty-tree
   *  presumption on no evidence. The 1.5 s/2 s capture timeouts are the budget
   *  for the await this adds to the approval path. */
  private async captureActionMeta(
    toolName: string,
    input: Record<string, unknown>
  ): Promise<Record<string, unknown> | undefined> {
    const command = shellCommandOf(toolName, input)
    if (!command) return undefined
    const meta: Record<string, unknown> = {}
    if (needsGitStatus(command)) {
      const gitStatus = await captureGitStatus(this.cwd)
      if (gitStatus) meta.gitStatus = gitStatus
    }
    if (needsRepoVisibility(command)) {
      meta.repoVisibility = await this.sessionVisibility()
    }
    // Pure and synchronous — no subprocess, so unlike the captures above it
    // costs nothing to attempt on every shell action. Scope mirrors what
    // `classifierEnvironment` publishes (cwd + the user's additionalDirectories)
    // plus the process's temp roots.
    const redirects = analyzeRedirects(command, {
      cwd: this.cwd,
      tempDirs: tempDirRoots(),
      additionalDirectories: this.mergedUserPermissions().additionalDirectories
    })
    if (redirects) meta.redirects = redirects
    return Object.keys(meta).length > 0 ? meta : undefined
  }

  /** Auto mode is active for `full`/`auto` autonomy unless explicitly disabled. */
  private isAutoMode(mode: string): boolean {
    return (mode === 'full' || mode === 'auto') && this.autoModeConfig().enabled !== false
  }

  /** A JudgeTransport backed by a fresh, stateless opencode judge session per call
   *  (so the judge never accumulates prior Q&As; we trade cache for correctness).
   *  Judge model defaults to the session's own model (ADR-023), override via config.
   *
   *  This is now the FALLBACK path — {@link makeJudgeFn} prefers the patched
   *  server's tool-less `POST /judge/completion` (ADR-037 P1) and only lands
   *  here on a server that does not expose it.
   *
   *  The judge session is patched TOOL-DENIED before it is prompted — see
   *  DENY_ALL_TOOLS_RULESET for why (a security judge reasoning over
   *  attacker-influenced transcript text must not be able to execute anything,
   *  and a synchronous prompt on a consumer-less session must not be able to
   *  block on an unanswerable approval). The judge needs no tools: it returns a
   *  verdict from text alone.
   *
   *  A patch FAILURE propagates rather than being swallowed — the caller
   *  (`handleAutoModeApproval`) catches it and falls back to asking the human,
   *  which is the correct fail-closed outcome. Proceeding to prompt an
   *  un-denied session would reinstate exactly the hazard above.
   *
   *  `maxTokens` / `stopSequences` on the request are ignored: opencode's prompt
   *  API exposes neither (the ADR-023 deviation). They stay on the interface
   *  because the classifier populates them for a future direct-API transport
   *  (plan phase 5), and ignoring an advisory field is the documented contract. */
  private makeSessionJudgeFn(): JudgeTransport | null {
    const client = this.client
    if (!client) return null
    const parsed = parseModelString(this.autoModeConfig().judgeModel ?? this._model)
    return async ({ system, user }) => {
      const js = await client.createSession({ title: 'auto-mode-judge' })
      try {
        await client.patchSession(js.id, SEALED_THROWAWAY_PATCH)
        const resp = (await client.prompt(js.id, {
          model: { providerID: parsed.providerID, modelID: parsed.modelID },
          system,
          parts: [{ type: 'text', text: user }]
        })) as { parts?: Array<{ type?: string; text?: string }> }
        return (resp?.parts ?? [])
          .filter((p) => p?.type === 'text')
          .map((p) => p?.text ?? '')
          .join('')
      } finally {
        client.deleteSession(js.id).catch(() => {})
      }
    }
  }

  /**
   * The judge transport actually used: the patched server's tool-less
   * `POST /judge/completion` (ADR-037 P1) when this opencode has it, otherwise
   * the tool-denied judge session above.
   *
   * The endpoint version is strictly better — no session, no tool registry, no
   * permission evaluation (so plan §7 Q5's instance-global `approved` list has
   * nothing to pierce), and it enforces `maxTokens`/`stopSequences` for real,
   * closing the ADR-023 advisory-fields deviation on this path.
   *
   * Availability is probed once per session and cached in
   * {@link judgeEndpointProbe}; see judge-transport.ts for why the probe reads
   * `/doc` rather than POSTing the prompt speculatively.
   */
  private makeJudgeFn(): JudgeTransport | null {
    const fallback = this.makeSessionJudgeFn()
    if (!fallback) return null
    const conn = this.conn
    if (!conn) return fallback
    const parsed = parseModelString(this.autoModeConfig().judgeModel ?? this._model)
    return makeJudgeTransportWithFallback({
      target: { baseUrl: conn.baseUrl, authHeader: conn.authHeader },
      model: { providerID: parsed.providerID, modelID: parsed.modelID },
      fallback,
      probe: this.judgeEndpointProbe,
    })
  }

  private async handleAutoModeApproval(approval: PendingApproval): Promise<void> {
    const category = approval.toolName
    // G9 — an explicit USER-authored `ask` rule outranks the classifier
    // (ref §3 step 1 / porting note #1). Letting the judge auto-approve exactly
    // the actions the user singled out would make auto mode a permission
    // DOWNGRADE. Checked before both fast paths: an ask the user wrote on
    // `read` must still reach them. Zero judge calls on a match.
    if (matchesUserAskRule(this.userOriginRules(), category, approval.patterns)) {
      logger.info(
        'OpencodeSession',
        `auto-mode → human: user ask rule matches ${category} (${(approval.patterns ?? ['*']).join(', ')})`
      )
      this.fallbackToHuman(approval)
      return
    }
    // Fast-path: read-only/safe tools never need the judge.
    if (isAutoModeFastPathAllowed(category)) {
      this.autoReply(approval.requestId, 'once')
      return
    }
    const judge = this.makeJudgeFn()
    if (!judge) {
      this.fallbackToHuman(approval)
      return
    }
    try {
      // Phase 3 ground truth. actionMeta FIRST: it is what resolves repo
      // visibility, and classifierEnvironment picks the resolved value up on
      // this same call rather than one approval later.
      const actionMeta = await this.captureActionMeta(category, approval.input)
      const environment = await this.classifierEnvironment()
      const result = await classify(
        {
          messages: this.messageHistory,
          action: { toolName: category, input: approval.input },
          environment,
          ...(actionMeta ? { actionMeta } : {}),
          ...(this.toolOutcomes.size ? { outcomes: Object.fromEntries(this.toolOutcomes) } : {}),
          twoStageMode: this.autoModeConfig().twoStageMode ?? 'both'
        },
        judge
      )
      // G10 — the judge call is async and the user can switch autonomy mode
      // while it is in flight (ref §3 step 5 / cli.js's
      // `mode_changed_while_queued`). Re-read the CURRENT mode: if auto mode is
      // no longer active the verdict is stale authority, so discard it and ask.
      if (!this.isAutoMode(this.permissionMode)) {
        logger.info(
          'OpencodeSession',
          `auto-mode verdict discarded — permission mode changed to "${this.permissionMode}" while the judge ran`
        )
        this.fallbackToHuman(approval)
        return
      }
      logger.info(
        'OpencodeSession',
        `auto-mode ${result.block ? 'BLOCK' : 'allow'} (stage=${result.stage}` +
          `${result.category ? `, rule=${result.category}` : ''}) ${category}` +
          (result.reason ? ` — ${result.reason}` : '')
      )
      if (result.unavailable) {
        this.fallbackToHuman(approval)
        return
      }
      if (result.block) {
        // Denial caps (3 consecutive / 2 on the same rule / 20 total) — too many
        // blocks → hand control to the human, with the cap's own sentence as the
        // approval card's `decisionReason` so they see WHY they were asked.
        const capped = this.autoDenials.recordBlock(result.category)
        if (capped) {
          this.fallbackToHuman(approval, capped)
          return
        }
        // Phase 3 — annotate the blocked call so a re-attempt is judged as a
        // retry of something THIS monitor denied (post-block consent
        // inheritance), not as a fresh proposal.
        if (approval.toolUseId) this.recordToolOutcome(approval.toolUseId, 'automode-blocked')
        this.autoReply(approval.requestId, 'reject', formatAutoModeDenyReason(result))
      } else {
        this.autoDenials.recordAllow()
        this.autoReply(approval.requestId, 'once')
      }
    } catch (err) {
      logger.warn(
        'OpencodeSession',
        `auto-mode classify failed: ${err instanceof Error ? err.message : String(err)}`
      )
      this.fallbackToHuman(approval)
    }
  }

  /**
   * Resolve a pending approval programmatically (the classifier's decision).
   * A reject `message` becomes model-visible feedback (CorrectedError) so the
   * turn survives the denial and the agent can see why it was blocked.
   */
  private autoReply(requestId: string, reply: 'once' | 'reject', message?: string): void {
    this.pendingApprovals.delete(requestId)
    const replied = message
      ? this.client?.replyPermission(requestId, reply, message)
      : this.client?.replyPermission(requestId, reply)
    replied?.catch((err) => {
      logger.warn('OpencodeSession', `replyPermission failed: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  /** Classifier couldn't decide (unavailable / cap / error) → ask the human.
   *
   *  `decisionReason` is the one-line explanation the approval card renders
   *  above the buttons (ApprovalButtons / FloatingApproval read
   *  `PendingApproval.decisionReason`) — set on the denial-cap handoffs, where
   *  "auto mode gave up on this" is not otherwise visible. Spread rather than
   *  mutated: the caller's approval object is also the one the SSE consumer
   *  keeps, and this is a presentation detail of THIS send. */
  private fallbackToHuman(approval: PendingApproval, decisionReason?: string): void {
    this.send('session:approval-request', decisionReason ? { ...approval, decisionReason } : approval)
  }

  /**
   * Ask a one-off question outside the main conversation history (the `/btw`
   * command). Uses a fresh throwaway opencode session so the question never
   * pollutes the main session's history. Mirrors the `makeJudgeFn` pattern.
   * Returns the joined assistant text, or null on any failure. Never throws.
   *
   * `client.prompt` runs a SYNCHRONOUS server-side turn (POST /session/{id}/message
   * blocks until the turn fully completes). Claude's `/btw` is tool-less; ours
   * must match — and critically, must be HANG-PROOF: if the model called a tool
   * that needed approval, opencode would emit `permission.asked` for THIS
   * throwaway session, which our main SSE consumer filters out (foreign
   * sessionID) and never answers → the synchronous prompt would hang forever
   * (spinner stuck). So we patch a deny-all ruleset on the throwaway session
   * BEFORE prompting: opencode's permission evaluator short-circuits a matching
   * `deny` WITHOUT publishing `permission.asked` (verified vs 1.17.9 —
   * permission/index.ts `ask()` returns DeniedError before the Event.Asked path;
   * `{permission:'*', pattern:'*'}` matches every tool via Wildcard.match → regex
   * `.*`). The model therefore just answers in text — tool-less, hang-proof. The
   * system prompt is a belt-and-suspenders nudge. (We deliberately avoid the
   * prompt body's `tools` field, which opencode marks as deprecated.)
   */
  override async askSideQuestion(question: string): Promise<string | null> {
    try {
      await this.ensureConnected()
      if (!this.client || this._cancelled) return null

      const parsed = parseModelString(this._model)
      const js = await this.client.createSession({ title: 'side-question' })
      try {
        // Deny every tool AND seal the session so an instance-global "always"
        // approval cannot outrank that deny (see SEALED_THROWAWAY_PATCH).
        // Best-effort; the system prompt still discourages tools if the patch
        // were to fail.
        await this.client.patchSession(js.id, SEALED_THROWAWAY_PATCH)
        const resp = (await this.client.prompt(js.id, {
          model: { providerID: parsed.providerID, modelID: parsed.modelID },
          system: 'Answer the following question concisely and directly. Do not use tools.',
          parts: [{ type: 'text', text: question }]
        })) as { parts?: Array<{ type?: string; text?: string }> }
        const text = (resp?.parts ?? [])
          .filter((p) => p?.type === 'text')
          .map((p) => p?.text ?? '')
          .join('')
        return text || null
      } finally {
        this.client.deleteSession(js.id).catch(() => {})
      }
    } catch (err) {
      logger.warn(
        'OpencodeSession',
        `askSideQuestion failed: ${err instanceof Error ? err.message : String(err)}`
      )
      return null
    }
  }

  sendStatus(): void {
    this.send('session:status', this.status)
  }

  /**
   * Record one usage_event per accumulated assistant message at turn end.
   * Called at session.idle so we have final cumulative token + cost state.
   * Failures are swallowed by recordUsageEvent — never breaks a turn.
   *
   * Phase 9a: child accumulators (isChild) are now also metered, but under the
   * CHILD's own model + childSessionId — not the parent's. If a child accumulator
   * has no model info, it is skipped (never attributed to the parent model).
   */
  private recordTurnUsage(): void {
    const parsed = parseModelString(this._model)
    const ownAccount = opencodeAuthProvider.buildAccountRef(parsed.providerID)

    for (const [messageId, acc] of this.accumulators) {
      // Only record assistant messages that have cost or token data
      if (acc.role === 'user' || acc.role === 'system') continue
      if (!acc.cost && !acc.tokens) continue
      // Skip messages already recorded in a prior session.idle this session
      // (the DB dedups anyway; this avoids the redundant round-trip).
      if (this.recordedUsageMessageIds.has(messageId)) continue
      this.recordedUsageMessageIds.add(messageId)

      const tokens = acc.tokens
      // Reasoning tokens are billed as OUTPUT tokens by every provider opencode
      // meters this way (acc.cost already includes them) — fold them into the
      // output figure so the row's token counts and equiv cost don't undercount.
      const outputTokens = (tokens?.output ?? 0) + (tokens?.reasoning ?? 0)

      if (!acc.isChild) {
        // Slice B — per-model cost breakdown: attribute this message's final
        // (now-stable) cost to the model active when it was recorded. Own
        // accumulators don't carry a per-message model (unlike child ones),
        // but since this loop only visits each messageId once (guarded by
        // recordedUsageMessageIds above) and runs at turn end, `parsed.modelID`
        // IS the model that produced this message — a mid-session model switch
        // naturally attributes turn N's messages to whichever model was active
        // when turn N's session.idle fired. Matches recordUsageEvent's own
        // attribution below (same simplification, same precedent).
        this.liveModelCosts.set(
          parsed.modelID,
          (this.liveModelCosts.get(parsed.modelID) ?? 0) + (acc.cost ?? 0)
        )

        // Own (parent) message — attribute to this session's model.
        recordUsageEvent({
          engineId: 'opencode',
          vendorId: parsed.providerID,
          accountId: ownAccount?.accountId ?? null,
          accountUuid: null, // opencode does not expose an OAuth account UUID yet
          modelId: parsed.modelID,
          tokens: {
            input: tokens?.input ?? 0,
            output: outputTokens,
            cacheWrite: tokens?.cache?.write ?? 0,
            cacheWrite1h: 0, // opencode does not distinguish 1h cache writes
            cacheRead: tokens?.cache?.read ?? 0
          },
          engineCostUsd: acc.cost ?? null,
          sessionId: this.openSessionId,
          messageId,
          source: 'live'
        })
      } else {
        // Child (subagent) message — attribute to the CHILD's own model + session.
        // If model info is absent, skip: never record a child under the parent model.
        if (!acc.model) {
          logger.debug('OpencodeSession', `Child accumulator ${messageId} has no model info — skipping metering`)
          continue
        }
        const childAccount = opencodeAuthProvider.buildAccountRef(acc.model.providerID)
        recordUsageEvent({
          engineId: 'opencode',
          vendorId: acc.model.providerID,
          accountId: childAccount?.accountId ?? null,
          accountUuid: null,
          modelId: acc.model.modelID,
          tokens: {
            input: tokens?.input ?? 0,
            output: outputTokens,
            cacheWrite: tokens?.cache?.write ?? 0,
            cacheWrite1h: 0,
            cacheRead: tokens?.cache?.read ?? 0
          },
          engineCostUsd: acc.cost ?? null,
          sessionId: acc.childSessionId ?? null,
          messageId,
          source: 'live'
        })
      }
    }
  }

  /**
   * Sum the cumulative tokens from all own (non-child) assistant accumulators.
   * Returns { input, output, cacheWrite, cacheRead }.
   * Extracted from sendMetering for reuse in buildStatusLine (DRY).
   */
  private sumSessionTokens(): { input: number; output: number; cacheWrite: number; cacheRead: number } {
    let input = 0
    let output = 0
    let cacheWrite = 0
    let cacheRead = 0
    for (const acc of this.accumulators.values()) {
      if (acc.role === 'user' || acc.role === 'system') continue
      if (acc.isChild) continue
      const t = acc.tokens
      if (!t) continue
      input += t.input ?? 0
      // Reasoning tokens are billed as output — fold them in, matching the
      // recordTurnUsage accounting (BD-j) so the status line agrees with usage.
      output += (t.output ?? 0) + (t.reasoning ?? 0)
      cacheWrite += t.cache?.write ?? 0
      cacheRead += t.cache?.read ?? 0
    }
    return { input, output, cacheWrite, cacheRead }
  }

  /**
   * Build a StatusLineData snapshot for the current session state.
   * Context "used" = lastContextLength (latest turn's input+cacheRead, NOT
   * the cumulative In/Out/Total sum). Context window size from the discovery
   * cache. usedPercentage is null when the window size is unknown (acceptable —
   * status line shows tokens, omits the %).
   */
  private buildStatusLine(): StatusLineData {
    const parsed = parseModelString(this._model)
    const sum = this.sumSessionTokens()
    const ctx = getOpencodeModelContextWindow(parsed.providerID, parsed.modelID)
    const usedPercentage =
      ctx > 0 && this.lastContextLength > 0
        ? Math.round((this.lastContextLength / ctx) * 100)
        : null
    const remainingPercentage = usedPercentage !== null ? 100 - usedPercentage : null
    const cachedTokens = sum.cacheRead + sum.cacheWrite
    const totalTokens = sum.input + sum.output + cachedTokens
    return {
      totalCostUsd: this.totalCostUsd,
      totalDurationMs: this.accTotalDurationMs,
      totalApiDurationMs: 0,
      totalInputTokens: sum.input,
      totalOutputTokens: sum.output,
      cachedTokens,
      totalTokens,
      contextWindowSize: ctx,
      usedPercentage,
      remainingPercentage,
      turnStartedAtMs: this.isProcessing && this.startTimeMs > 0 ? this.startTimeMs : null,
      modelCosts: [...this.modelCostEntries, ...this.dispatchedCostEntries()]
    }
  }

  /** Emit the status line to the renderer (parity with Claude's session:status-line). */
  private sendStatusLine(): void {
    this.send('session:status-line', this.buildStatusLine())
  }

  /**
   * Emit the engine-neutral MeteringSnapshot (Phase 7 Pass 2). opencode has no
   * window (no usage provider yet — foundation §7), so window is omitted; this
   * is the cumulative-meter case. Tokens summed across the turn's assistant
   * messages; equivalentCostUsd from the internal pricing table. Best-effort.
   */
  private sendMetering(): void {
    try {
      const parsed = parseModelString(this._model)
      const account = opencodeAuthProvider.buildAccountRef(parsed.providerID)
      const { input, output, cacheWrite, cacheRead } = this.sumSessionTokens()
      const equiv = equivalentCostUsd(parsed.providerID, parsed.modelID, {
        inputTokens: input,
        outputTokens: output,
        cacheWriteTokens: cacheWrite,
        cacheWrite1hTokens: 0,
        cacheReadTokens: cacheRead
      })
      const ctx = getOpencodeModelContextWindow(parsed.providerID, parsed.modelID)
      const snapshot: MeteringSnapshot = {
        engineId: 'opencode',
        vendorId: parsed.providerID,
        billingType: account?.billingType ?? 'unknown',
        tokens: { input, output, cacheWrite, cacheRead, total: input + output + cacheWrite + cacheRead },
        equivalentCostUsd: equiv,
        engineReportedCostUsd: this.totalCostUsd,
        contextWindow: { used: this.lastContextLength, size: ctx }
        // window omitted — opencode has no usage provider (cumulative meter)
      }
      this.send('session:metering', snapshot)
    } catch {
      /* advisory — never breaks the turn */
    }
  }

  /** ISession.discoverSkills — opencode sources skills from its GET /skill API. */
  discoverSkills(cwd: string): Promise<SkillInfo[]> {
    return discoverOpencodeSkills(cwd)
  }

  dispose(): void {
    this.cancel()
  }
}
