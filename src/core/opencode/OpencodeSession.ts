import type { HostWindowHandle } from '../host'
import { v4 as uuid } from 'uuid'
import { opencodeServerManager } from './OpencodeServerManager'
import type { ServerConnection } from './OpencodeServerManager'
import { OpencodeClient } from './OpencodeClient'
import type { OpencodeEvent } from './protocol/types'
import { BaseSession } from '../providers/BaseSession'
import type { EngineSpawnOptions } from '../providers/ISession'
import type { ResolvedCapabilities } from '../../shared/model-capabilities'
import type { AccountIdentity } from '../../shared/account-key'
import { resolveOpencodeCapabilities } from '../../shared/model-capabilities'
import type {
  AttachmentUpload,
  ChatMessage,
  SessionStatus,
  ApprovalDecision,
  PermissionSuggestion,
  PendingApproval,
  PermissionDenialBlock,
  AccountRef,
  MeteringSnapshot,
  AutoModeConfig,
  SharedAutoModeConfig,
  AskUserQuestion,
  StatusLineData,
  SkillInfo,
  ModelCostEntry,
  TaskNotification,
  ToolReviewBlock
} from '../../shared/types'
import { opencodeModel } from '../../shared/types'
import {
  getOpencodeModelContextWindow,
  getOpencodeModelCapabilities,
  discoverOpencodeModels,
  peekOpencodeModels,
  parseModelString
} from './model-discovery'
import { equivalentCostUsd } from '../../shared/pricing'
import { totalCosts, type TotalCosts } from '../../shared/cost-rule'
import { opencodeCostInputs, resolveOpencodeCosts, type OpencodeCostInputs } from './message-cost'
import { opencodeHistorySeed, type OpencodeHistoryTokens } from './history-status-line'
import { logger } from '../services/logger'
import { authErrorTranscriptMessage } from '../services/api-error'
import {
  mapEvent,
  buildChatMessage,
  extractToolResult,
  convertStoredMessage,
  findToolInput,
  storedCompactionMessages
} from './event-mapper'
import type { MapperOutput, MessageAccumulator, PartSnapshot } from './event-mapper'
import type { OpencodeStreamItem } from './event-mapper'
import type { ItemStreamTarget } from '../shared/sync/item-stream'
import { BashStreamGate } from './bash-stream-gate'
import { discoverOpencodeSkills } from './command-skill-discovery'
import { opencodeAuthProvider } from '../auth/OpencodeAuthProvider'
import { recordUsageEvent } from '../services/usage-recorder'
import { loadClaudePermissions } from '../services/claude-settings'
import {
  compileClaudeRulesToOpencode,
  isOpencodeBuiltinPermissionKey,
  opencodeMcpKey,
  persistAllowSuggestions,
  sanitizeMcpName,
  withoutAllowRules,
  withoutMutatingAllowRules
} from './permission-compiler'
import type { OpencodePermissionRule } from './permission-compiler'
import { hostPrecheck, type HostPrecheckContext } from './host-precheck'
import {
  CHILD_GATED_CATEGORIES,
  subagentBackstopRules,
  TASK_BACKSTOP_FAIL_CLOSED_RULE
} from './subagent-permissions'
import type { OpencodeAgentInfo } from './OpencodeClient'
import { OpencodeSessionAllows } from './session-allows'
import { reviewRationale } from '../shared/tool-review'
import {
  type ClassifyResult,
  type EnvironmentInfo,
  type JudgeTransport
} from '../automode/classifier'
import { runJudgePipeline } from '../automode/judge-pipeline'
import { armBlockHold, blockHoldMs } from '../automode/block-hold'
import { blockGrantKey } from '../automode/blocked-calls'
import { judgeRouteUnavailableMessage, makeSessionJudgeTransport } from '../automode/session-judge'
import { buildClassifierEnvironment } from '../automode/environment'
import {
  allowRuleReviewBlock,
  AutoModeDenialTracker,
  autoModeReviewBlock,
  readOnlyReviewBlock
} from '../automode/denial-tracker'
import { effectiveShellCwd } from '../automode/read-only-gate'
import type { AllowSkipAction } from '../automode/allow-rule-skip'
import { isShellToolName } from '../automode/shell-lexical'
import {
  analyzeRedirects,
  captureGitConfigArmed,
  captureGitRemotes,
  captureGitStatus,
  captureRepoVisibility,
  hasGitSegment,
  needsGitStatus,
  needsRepoVisibility,
  recordToolOutcome,
  shellCommandOf,
  tempDirRoots,
  type GitRemote,
  type RepoVisibility,
  type ToolOutcome
} from '../automode/ground-truth'
import { loadEngineConfig, loadSharedAutoModeConfig } from '../services/ui-config'
import type { ClaudePermissions, PermissionScope } from '../../shared/types'
import { blockUsageService } from '../services/block-usage'
import { opencodeAuthRequiredProviderId } from '../shared-providers/chatgpt-route'
import {
  crossEngineDispatcher,
  crossEngineDispatchAvailable
} from '../services/cross-engine-dispatcher'
// Permission ruleset helper — extracted to permission-ruleset.ts so
// cross-engine-dispatcher.ts can depend on it without importing THIS module
// (which would cycle back now that this file imports crossEngineDispatcher
// above). Re-exported here for back-compat with any other existing importer.
import {
  buildAutoModeRuleset,
  buildRuleset,
  CLAUDEUI_MCP_SERVER,
  opencodeWireRuleset
} from './permission-ruleset'
import { editClearsAgentControl } from './agent-control-gate'
import { collectClaudeMcpForOpencode } from './claude-mcp-bridge'
import { PLAN_MODE_DENY_REASON_NO_EXIT_TOOL } from '../pi/permission-engine'
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
 * prompted (`/btw` side questions; agent-generate patches the same one). Both
 * are tool-LESS by design — they must answer from text alone — and both are
 * hazardous without this patch, for two independent reasons:
 *
 *  1. SECURITY. A fresh opencode session inherits the vendor's `{*: allow}`
 *     default (verified: agent.ts's `defaults` = `Permission.fromConfig({"*":
 *     "allow", …})`), so an unpatched throwaway could really run bash/edit,
 *     with no human and no gate. With deny-all patched, upstream hides every
 *     tool from the request itself (`session/llm/request.ts` `resolveTools`,
 *     lines 208-214 in `vendor/opencode-src` v1.18.32: a tool whose last
 *     matching rule is a `*` deny is filtered out before the model sees the
 *     tool list), so there is nothing to call — and nothing an instance-global
 *     "always" approval could re-enable, because that list is not part of the
 *     ruleset the filter reads. (ClaudeUI no longer sends `always` at all —
 *     ADR-085 S2 keeps session approvals host-side, `session-allows.ts`.)
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
 * The patch body for a throwaway session: the deny-all ruleset above, nothing
 * else. It hides every tool from the throwaway's request upstream (reason 1),
 * so nothing can be called or "always"-approved, and it keeps the synchronous
 * prompt hang-proof (reason 2). The auto-mode judge no longer runs through
 * opencode at all (ADR-081: ClaudeUI makes that call itself).
 */
const DENY_ALL_THROWAWAY_PATCH = {
  permission: DENY_ALL_TOOLS_RULESET
} as const

/**
 * ADR-084 §1 — how long the read-only gate waits for a shell call's tool part
 * to carry its input when the call's `permission.asked` got there first.
 *
 * The two race: the processor publishes the part's input from its `tool-call`
 * handler (vendor/opencode-src/packages/opencode/src/session/processor.ts,
 * `updateToolCall` → `state: {status: 'running', input}`) while the AI SDK is
 * already running the tool's `execute`, and the shell tool's `execute` parses
 * the command and asks straight away (src/tool/shell.ts `execute` → `ask`). So
 * the ask regularly lands while the part is still `pending` with `input: {}`,
 * the part following a moment later. Past the bound the call goes to the judge,
 * exactly as with no part at all.
 */
export const TOOL_INPUT_WAIT_MS = 1000
let toolInputWaitMs = TOOL_INPUT_WAIT_MS

/** Tests shorten (or lengthen) the wait; no argument restores the default. */
export function __setToolInputWaitMsForTests(ms?: number): void {
  toolInputWaitMs = ms ?? TOOL_INPUT_WAIT_MS
}

/** How one wait for a tool part's input ended. `closed` = cancel()/dispose(). */
type ToolInputWait = 'input' | 'timeout' | 'closed'

/** One permission ask (or question) waiting for its answer, keyed by requestId. */
interface PendingAsk {
  /** The tool part's callID (`undefined` when the engine carried none) — what
   *  lets resolveApproval annotate the RIGHT call when the human rejects. */
  toolUseId?: string
  approval: PendingApproval
  /** false when a user ask rule holds it for the human — a session allow must never sweep it. */
  sweepable: boolean
  /**
   * Set while the card holds an auto-mode judge block (ADR-091 §3): the
   * judge's deny text a kept block answers with, and the expiry timer.
   */
  hold?: { reason: string; cancel: () => void }
}

/**
 * An errored tool part that was aborted rather than failed — `stopped`, as
 * Claude maps killed and Codex interrupted. Two opencode markers:
 * - `metadata.interrupted` (+ error 'Tool execution aborted'): the processor
 *   aborting an in-flight tool (session/processor.ts, ~602). Structural, so
 *   preferred.
 * - error 'Task cancelled': the task tool's cancelled child
 *   (tool/task.ts:340), which sets no metadata — only the string identifies it.
 */
function wasAborted(snap: PartSnapshot): boolean {
  return snap.state?.metadata?.interrupted === true || snap.state?.error === 'Task cancelled'
}

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
   * Set on server death, SSE stream loss, and deliberate teardown (cancel()).
   * Drives the `'disconnected'` status state, which is the renderer's ONLY
   * signal to clear `sdkActive` (useClaudeEvents' session:status handler) —
   * i.e. the only way the sidebar's green activity dot ever turns off. Cleared
   * on every fresh connect. Mirrors PiSession's `disconnected`.
   */
  private disconnected = false
  /** Unsubscribe from the CURRENT server handle's unexpected-exit fan-out. */
  private unsubscribeServerExit: (() => void) | null = null
  /**
   * Cost tracking — base + live overlay (Slice B, durable across reloads,
   * mirrors ClaudeSession's costBaseUsd/liveTotalCostUsd split).
   *
   * - costBase / modelCostBase: cost from stored history, seeded ONCE at
   *   replayStoredHistory (a single OpencodeSession object only ever replays
   *   once — replayStoredHistory is gated on `!this.openSessionId`/`!this.
   *   openSessionId` branches that can't re-fire after openSessionId is set —
   *   so no respawn-fold is needed here, unlike Claude's spawn-per-turn model).
   * - the live half is recomputed from `accumulators` on demand (costTally),
   *   which is why the historical base MUST live in a separate field: a live
   *   recompute knows nothing about the messages that preceded this process.
   *
   * ADR-071 §2: the headline is not opencode's own `info.cost` — under a
   * subscription opencode charges zero and the session is worth the list price
   * of its tokens. What is stored is each message's cost INPUTS
   * (opencodeCostInputs); the billing type is applied when a figure is read,
   * because the auth probe resolves asynchronously and a session opened before
   * it lands must not be stuck with what `unknown` made of its history. The
   * engine's raw figures survive alongside, in rawCostBaseUsd /
   * liveTotalCostUsd, for the one consumer that asks for what the ENGINE
   * reported (sendMetering).
   *
   * this.totalCostUsd (below) is a getter over base + live.
   */
  private costBase: OpencodeCostInputs[] = []
  private modelCostBase = new Map<string, number>()
  /** Engine-reported cost from stored history — MeteringSnapshot's input. */
  private rawCostBaseUsd = 0
  /** Engine-reported cost of this live process, synced from the mapper's
   *  sumAccumulatorCosts ref. Not the headline (see the block comment). */
  private liveTotalCostUsd = 0
  /** modelId → summed display cost, own (non-child) messages only, populated in
   *  recordTurnUsage at the same point each message's cost is finalized. */
  private liveModelCosts = new Map<string, number>()
  /** messageId → the cost inputs a message settled on at turn end. Frozen so a
   *  mid-session model switch cannot re-price a finished message under a model
   *  that never produced it (the per-model breakdown attributes it to the model
   *  that did). The billing type is NOT frozen with them. */
  private settledCostInputs = new Map<string, OpencodeCostInputs>()
  /**
   * Token totals from stored history, seeded on resume beside the cost base.
   *
   * The status line reports history + live, the way cost does; `sendMetering`
   * deliberately does not add it, because a MeteringSnapshot describes what
   * THIS process metered and the ledger rows behind it are per-turn.
   */
  private tokenBase: OpencodeHistoryTokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }
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
  // Pending permission approvals (and questions), requestId → the ask. Its
  // toolUseId is what lets resolveApproval annotate the RIGHT tool call when the
  // human rejects (phase 3 outcome annotations); the approval itself is what the
  // session-allow sweep re-checks (ADR-085 S2).
  private pendingApprovals = new Map<string, PendingAsk>()
  // ADR-085 S2 — the host-side "allow for this session" memory, replacing
  // opencode's instance-global `always` (see session-allows.ts). Lives as long
  // as this OpencodeSession, like PiSession.sessionAllows; cancel() keeps it.
  private readonly sessionAllows = new OpencodeSessionAllows()
  // Pending model-elicitation questions (question.asked) keyed by requestId.
  // Stored so resolveApproval can map the ordered answers Record→string[][].
  private pendingQuestions = new Map<string, AskUserQuestion[]>()
  // Per-message part accumulator keyed by messageId
  private accumulators = new Map<string, MessageAccumulator>()
  // ADR-084 §1 — readOnlyInput calls waiting for a tool part's input, keyed by
  // the part's callID. Settled from consumeEvents right after mapEvent applied a
  // `message.part.updated` to `accumulators`, by their own timeout, or by
  // cancel(); each settle removes itself, so an empty set never lingers.
  private toolInputWaiters = new Map<string, Set<(outcome: ToolInputWait) => void>>()
  private activeStreamItems = new Map<
    string,
    { target: ItemStreamTarget; ownerSessionId: string; partId: string }
  >()
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
  // state.metadata.sessionId. An entry lives as long as the PARENT's task call:
  // it is removed when that task part reaches a terminal state
  // (settleTaskChildren), NOT on the child's session.idle/session.error — a
  // child keeps running after a ContextOverflowError (auto-compaction), and
  // its later permission.asked must still route here. (A background call's
  // entry ends at the child's idle instead.) Cleared in cancel().
  private childSessions = new Map<string, string>()
  // Task callIDs whose part completed as a BACKGROUND task
  // (`metadata.background`): the child keeps running, so its session.idle —
  // not the part — carries that call's one terminal notification. Cleared in
  // cancel().
  private backgroundTaskCalls = new Set<string>()
  // Auto-mode (full) LLM gatekeeper state (ADR-023).
  private _autoModeConfig: AutoModeConfig | undefined
  /** Memoized `~/.claude/ui/automode.json` — the engine-SHARED trust lists
   *  (ADR-065 phase 4). Same lifetime as `_autoModeConfig`: one read per
   *  session, and a mid-session edit is not hot-reloaded. */
  private _sharedAutoMode: SharedAutoModeConfig | undefined
  // Consecutive / same-rule / total denial caps, shared with pi (denial-tracker.ts).
  private autoDenials = new AutoModeDenialTracker()
  // One `session:error` per session for a CONFIGURED judge model that no longer
  // exists — the check runs on every gated approval, and a banner per tool call
  // would bury the transcript.
  private staleJudgeModelReported = false
  // The same one-banner rule for a judge model ClaudeUI has no route to call
  // (ADR-081 §3) — the resolver runs on every judge call.
  private judgeRouteUnavailableReported = false
  // The USER-authored half of the last ruleset we patched onto the session
  // (compiled allow/ask/deny). Kept so the auto-mode gatekeeper can re-match a
  // pending approval against the user's own `ask` rules, which outrank the
  // classifier (ADR-023 G9). opencode discards the matched rule before it
  // publishes `permission.asked`, so this is the only way to recover provenance.
  // `null` = not compiled yet. The SSE consumer starts BEFORE the first
  // applyPermissionMode, so an approval can race it — see userOriginRules().
  private lastCompiledUserRules: OpencodePermissionRule[] | null = null
  // ADR-085 §3 — the MCP server names this session's server can reach: the
  // bridged Claude servers, `claudeui`, and the `GET /mcp` keys (the user's own
  // opencode-config servers). Resolved by the first applyPermissionMode whose
  // `GET /mcp` succeeds, then kept: the server's MCP config is fixed at its
  // spawn. Feeds the auto-mode per-server MCP asks and the compiler's
  // server-level MCP allow gate. `null` = not resolved yet.
  private knownMcpServers: string[] | null = null
  // One warn per session for a failing `GET /mcp` (the static set is used).
  private mcpStatusWarned = false
  // ADR-085 S4 — the server's agents with their COMPUTED rulesets (`GET
  // /agent`), for the parent-side `task:<name>` backstop. Cached like
  // `knownMcpServers` (the server's agent config is fixed at its spawn) and
  // reset with it on a reconnect. `null` = not resolved yet (a failing GET is
  // not cached: the next apply retries).
  private subagentAgents: OpencodeAgentInfo[] | null = null
  // One warn per session for a failing `GET /agent` (every task spawn asks then).
  private agentsWarned = false
  // ADR-085 S4 — the ruleset the last SUCCESSFUL patch put on the opencode
  // session, keyed by that session's id: what a task child's ask is answered
  // with (host-precheck.ts `parentRuleset`), and what `applyPermissionMode`
  // compares against to skip an unchanged PATCH (S3b verifier F3 — see there).
  // Reset on a reconnect and on cancel().
  private lastPatchedRuleset: { sessionId: string; rules: PermissionRule[]; key: string } | null =
    null
  // ADR-085 S4 — the categories the spawn put a static child ask on (see
  // childGatedCategories()). Memoized per connection — it reads the Claude MCP
  // config, and the pre-check runs on every ask — and reset with
  // `knownMcpServers` on a reconnect.
  private childGated: string[] | null = null
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
    // ANDed with the honest runtime check: some target (Claude Code, pi or
    // Codex) is available. No longer a given since ADR-082 made Claude Code a
    // selectable harness that can resolve to nothing.
    return {
      ...base,
      crossEngineDispatch: base.crossEngineDispatch && crossEngineDispatchAvailable('opencode')
    }
  }

  constructor(
    routingId: string,
    win: HostWindowHandle | null,
    cwd: string,
    opts: EngineSpawnOptions = {}
  ) {
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
    opencodeAuthProvider
      .warmCache()
      .then(() => {
        this.sendStatus()
        this.sendStatusLine()
      })
      .catch(() => {})
  }

  get willQueue(): boolean {
    return this.isProcessing
  }

  /**
   * The session's costs: history base + this process's own messages, each one
   * resolved by the cost rule (see the field doc comment for the split).
   *
   * A message the pricing table cannot price is counted as unknown, never as
   * zero (ADR-030) — `totalCosts` keeps the known part and the unknown count
   * apart so the status line can report both.
   */
  private costTally(): TotalCosts {
    return totalCosts([...this.costBase, ...this.liveCostInputs()].map(resolveOpencodeCosts))
  }

  /**
   * Cost inputs for this process's own (non-child) assistant messages.
   *
   * Own messages carry no per-message model of their own, so they are priced
   * under the session's CURRENT model — the same simplification (and the same
   * reason) as recordTurnUsage's attribution. Messages that already settled at
   * a turn end keep the inputs they settled on.
   */
  private liveCostInputs(): OpencodeCostInputs[] {
    const parsed = parseModelString(this._model)
    const out: OpencodeCostInputs[] = []
    for (const [messageId, acc] of this.accumulators) {
      if (acc.isChild) continue
      if (acc.role === 'user' || acc.role === 'system') continue
      // Nothing metered yet — not an unpriced message, an empty one. Same
      // condition recordTurnUsage skips on, deliberately: a message that has
      // only just been announced must not flash through the headline as an
      // unpriced one on its way to being metered.
      if (!acc.cost && !acc.tokens) continue
      const settled = this.settledCostInputs.get(messageId)
      out.push(
        settled ??
          opencodeCostInputs(parsed.providerID, parsed.modelID, acc.tokens, acc.cost ?? null)
      )
    }
    return out
  }

  /** What opencode itself reported spending, history + live. */
  private get engineReportedCostUsd(): number {
    return this.rawCostBaseUsd + this.liveTotalCostUsd
  }

  /** The headline figure: the known total, null when nothing could be priced. */
  private get totalCostUsd(): number | null {
    return this.costTally().displayCostUsd
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
      state: this.disconnected ? 'disconnected' : this.isProcessing ? 'running' : 'idle',
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

  async run(prompt: string | null, attachments?: AttachmentUpload[]): Promise<void> {
    this.clearInactivityTimer()
    // Reset the cancel flag so it only guards THIS run's connect window. cancel()
    // is also fired by the idle timeout; without this reset a session that
    // idle-timed-out would refuse to reconnect on a subsequent prompt.
    this._cancelled = false
    // Same for the disconnect flag: this run reconnects, so the status it is
    // about to emit ('running') must not be overridden by a prior loss.
    this.disconnected = false

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
    // runLoop re-reads the message list each step and picks it up — then ack it
    // so a queued item (ADR-053) transitions to `consumed` and the renderer
    // moves the card into chat.
    // We do NOT touch isProcessing / startTimeMs / createSession / ensureSSEConsumer /
    // applyPermissionMode — the ongoing turn already owns all of that.
    if (this.isProcessing && this.client && this.openSessionId) {
      const userMsg: ChatMessage = {
        id: uuid(),
        role: 'user',
        content: this.userMessageContent(prompt, attachments),
        timestamp: Date.now()
      }
      this.messageHistory.push(userMsg)
      try {
        await this.sendPrompt(prompt, attachments)
      } catch (err) {
        // The steer was NOT delivered. Acking here (the pre-fix behavior) told
        // the renderer the message was sent while it silently vanished (M-OC9).
        // Roll back the optimistic history push and surface the failure instead
        // — do NOT consume the message.
        logger.warn(
          'OpencodeSession',
          `steer send failed: ${err instanceof Error ? err.message : String(err)}`
        )
        this.messageHistory = this.messageHistory.filter((m) => m !== userMsg)
        this.send('session:error', err instanceof Error ? err.message : String(err))
        return
      }
      this.onPromptDelivered(prompt)
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

    // A fresh turn closes the user-stop window (ADR-090); the steer path above keeps it.
    this.endUserStop()
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
        // No connection ever landed → this is a disconnect as far as the
        // renderer's sdkActive/green-dot contract goes (on the _cancelled path
        // cancel() already set the flag, so this stays consistent).
        if (!this.conn) this.disconnected = true
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
        content: this.userMessageContent(prompt, attachments),
        timestamp: Date.now()
      }
      this.messageHistory.push(userMsg)

      // 6. Send prompt — route slash commands to runCommand when the name is known
      this.startTimeMs = Date.now()
      await this.sendPrompt(prompt, attachments)
      // Reached the engine. A no-op unless this run() was a queue flush at the
      // previous turn's end (ADR-053) — then it consumes the forwarded item.
      this.onPromptDelivered(prompt)
    } catch (err) {
      logger.error(
        'OpencodeSession',
        `run() error: ${err instanceof Error ? err.message : String(err)}`
      )
      this.isProcessing = false
      // A turn that failed before a connection exists (acquire rejected) is a
      // disconnect for the renderer's sdkActive/green-dot contract — 'idle'
      // here would leave the sidebar dot green forever.
      if (!this.conn) this.disconnected = true
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
      logger.info(
        'OpencodeSession',
        `Replaying ${storedMessages.length} stored messages for ${sessionId}`
      )

      // Slice B — cost durability across reloads: seed the cost base, the
      // per-model breakdown, the token base, the context meter and the
      // active-duration baseline from stored history BEFORE ensureSSEConsumer()
      // starts (run()/eagerConnect() both call replayStoredHistory before
      // starting the SSE consumer) and before any new turn runs, so neither
      // overlay has to catch up from zero.
      //
      // S1d: the reconstruction itself lives in history-status-line.ts, which
      // is also what a COLD sidebar open builds its status line from — one
      // loop, so a reopened session and the same session after its first new
      // turn cannot report different histories.
      const seed = opencodeHistorySeed(storedMessages, parseModelString(this._model))
      this.costBase = seed.costInputs
      this.rawCostBaseUsd = seed.engineReportedCostUsd
      this.modelCostBase = seed.modelCosts
      this.tokenBase = seed.tokens
      this.lastContextLength = seed.lastContextLength
      this.accTotalDurationMs = seed.totalDurationMs
      // Slice C — cross-engine dispatched cost durability: seed from
      // the usage ledger, keyed by this.routingId (the STABLE id a later
      // reopen constructs this session object with — see seedDispatchedCosts'
      // doc comment on BaseSession).
      this.seedDispatchedCosts()
      // Push the seeded totals to the renderer NOW — otherwise the durable
      // cost sits in memory but never reaches the TopBar tooltip until the
      // next live cost_update/result event (which may be turns away, or never,
      // if the user just reopens a session to look at it).
      this.sendStatusLine()

      for (const stored of storedMessages) {
        // Compaction parts ride an ordinary message but render as their own
        // system row (see storedCompactionMessages); replayed ahead of it.
        for (const separator of storedCompactionMessages(stored)) {
          this.rememberOpencodeMessage(separator)
          this.send('session:message', separator)
        }
        const msg = convertStoredMessage(stored)
        if (!msg) continue

        // Add to local history (for getMessages() and future turns), then emit.
        this.rememberOpencodeMessage(msg)
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
              ...(block.fileDiffs ? { fileDiffs: block.fileDiffs } : {}),
              ...(block.images ? { images: block.images } : {})
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
        // A (re)spawned server may carry a different MCP config (ADR-085 §3)
        // and different agents (ADR-085 S4) — and the next apply must PATCH
        // again rather than trust what the previous connection sent.
        this.knownMcpServers = null
        this.subagentAgents = null
        this.lastPatchedRuleset = null
        this.childGated = null
        this.disconnected = false
        // Server death is otherwise INVISIBLE to a session with no SSE
        // consumer: ensureSSEConsumer() only starts at the first prompt, so an
        // eagerly-connected, never-prompted session would sit on a dead server
        // showing a green dot forever. The manager fans this out only for
        // unexpected deaths. Drop any prior subscription first — a leftover
        // would keep a listener alive on a handle we no longer hold.
        this.unsubscribeServerExit?.()
        this.unsubscribeServerExit = opencodeServerManager.subscribeExit(
          this.cwd,
          () => this.markDisconnected('opencode server exited'),
          c
        )
      })().finally(() => {
        this.connectingPromise = null
      })
    }
    await this.connectingPromise
  }

  /**
   * Idempotent teardown for every connection-LOSS path (unexpected server
   * death, SSE stream end). Surfaces `'disconnected'` so the renderer clears
   * `sdkActive`, and drops our connection so the next run() reacquires — which
   * respawns the server, since the manager already dropped the dead handle.
   *
   * Releases via releaseIfCurrent, never release(): by the time we get here
   * another same-cwd session may already have spawned a REPLACEMENT server, and
   * a key-only release would decrement that live handle's refcount (see
   * OpencodeServerManager.releaseIfCurrent).
   */
  private markDisconnected(reason: string): void {
    if (this.disconnected && !this.conn) return
    this.disconnected = true
    this.sealStreamItems()
    if (this.isProcessing) {
      // A turn was in flight — unwedge it and tell the user why it stopped.
      this.isProcessing = false
      this.send('session:error', reason)
    }
    this.unsubscribeServerExit?.()
    this.unsubscribeServerExit = null
    if (this.conn) {
      opencodeServerManager.releaseIfCurrent(this.cwd, this.conn)
      this.conn = null
      this.client = null
    }
    // No engine left to forward held items to (ADR-053 §engine death).
    this.recallQueuedOnEngineLoss()
    this.dropBlockHolds()
    this.sendStatus()
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
          logger.warn(
            'OpencodeSession',
            `listCommands failed: ${err instanceof Error ? err.message : String(err)}`
          )
          return []
        }),
        this.client.listSkills().catch((err) => {
          logger.warn(
            'OpencodeSession',
            `listSkills failed: ${err instanceof Error ? err.message : String(err)}`
          )
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
      if (
        nextCaps.vision !== this._capabilities.vision ||
        nextCaps.contextWindow !== this._capabilities.contextWindow
      ) {
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
  private async sendPrompt(prompt: string, attachments?: AttachmentUpload[]): Promise<void> {
    const parsed = parseModelString(this._model)

    // Build file parts once — they ride along with BOTH the runCommand and the
    // promptAsync path so attachments are never dropped on a slash command.
    const fileParts: Array<{ type: 'file'; mime: string; url: string }> = (attachments ?? []).map(
      (att) => ({
        type: 'file',
        mime: att.mediaType,
        url: `data:${att.mediaType};base64,${att.base64Data}`
      })
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
    const parts: Array<
      { type: 'text'; text: string } | { type: 'file'; mime: string; url: string }
    > = [{ type: 'text', text: prompt }, ...fileParts]
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
        logger.error(
          'OpencodeSession',
          `SSE consumer error: ${err instanceof Error ? err.message : String(err)}`
        )
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
    // The ENGINE-reported live total (what opencode says it charged), not the
    // headline — the headline is the cost rule's answer and is recomputed from
    // the accumulators on demand (costTally). Starts at liveTotalCostUsd (0 for
    // a fresh/just-resumed session) and never at the history base, because
    // sumAccumulatorCosts (event-mapper.ts) always REPLACES this ref with a
    // full recompute over the (base-less) live accumulators map; a base seeded
    // here would just get discarded on the first cost_update.
    const totalCostRef = { value: this.liveTotalCostUsd }

    try {
      for await (const ev of this.client.subscribeEvents(signal)) {
        if (signal.aborted) break
        if (!this.openSessionId) continue

        const output = mapEvent(
          ev,
          this.openSessionId,
          this.accumulators,
          this.startTimeMs,
          totalCostRef,
          this.childSessions
        )
        this.liveTotalCostUsd = totalCostRef.value
        this.settleToolInputWaiters(ev)

        this.dispatchMapperOutput(output)
      }
    } catch (err) {
      if (!signal.aborted) {
        logger.error(
          'OpencodeSession',
          `SSE stream error: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    } finally {
      // The event stream ended. opencode holds this subscription open for the
      // whole session, so a NON-aborted end means the server died or the
      // transport broke (the vendor also ends the stream on instance dispose).
      // Pre-fix, sseAbort stayed non-null → ensureSSEConsumer() no-opped forever,
      // isProcessing stayed stuck true, interrupt() waited on a session.idle that
      // never comes, and every later run() steered into a dead session (H20).
      // Clear the guard so the next run() re-establishes the consumer; on an
      // unexpected end, go through the shared disconnect teardown — which
      // unwedges isProcessing and surfaces the drop when a turn was in flight,
      // and (crucially) reports 'disconnected' even when the stream dies while
      // IDLE, the only status the renderer acts on to clear the green dot.
      // No resetInactivityTimer(): that timer exists solely to release the
      // server ref on an idle session, and markDisconnected already released
      // it — arming it would only queue a redundant cancel() against a session
      // the user may be about to resend on. The next run() re-arms it anyway.
      const deliberate = signal.aborted
      if (this.sseAbort === abort) this.sseAbort = null
      if (!deliberate) {
        this.markDisconnected('opencode connection lost — resend to reconnect')
      }
    }
  }

  /**
   * Upsert one row into `messageHistory` by id — the ONE copy of that rule for
   * this class (mirrors `PiSession.rememberPiMessage`). It had grown five
   * identical hand-written copies, which is four chances for the next one to
   * push a duplicate instead.
   */
  private rememberOpencodeMessage(message: ChatMessage): void {
    const index = this.messageHistory.findIndex((entry) => entry.id === message.id)
    if (index >= 0) this.messageHistory[index] = message
    else this.messageHistory.push(message)
  }

  /**
   * Put one row THIS class authored (not the mapper) into history and on the
   * wire — the same upsert-by-id the mapper's `message` case does, minus the
   * tool-part accumulator bookkeeping, which only applies to a message opencode
   * itself produced.
   */
  private rememberAndSend(message: ChatMessage): void {
    this.rememberOpencodeMessage(message)
    this.send('session:message', message)
  }

  private sendTaskNotification(notification: TaskNotification): void {
    this.sealStreamItems(notification.taskId)
    this.send('session:task-notification', notification)
  }

  /**
   * A tool call reached a terminal state. If it was a `task` call, this is the
   * ONE source of that call's terminal notification, and its child mapping
   * ends here. Only the part knows the outcome: a child's session.error may
   * be a recovered context overflow, while the part fails with `Subagent
   * failed (task_id: …): <msg>` exactly when the child ended on an error
   * (opencode tool/task.ts runTask) — `failed`, unless the call was aborted
   * (`stopped`, see wasAborted). The reason is the part's own error text,
   * which reaches the TaskCard as the tool_result. A late child idle then
   * finds no mapping and is ignored. Matching by VALUE keeps a resumed child (`task_id`) re-registered
   * under a NEWER callID intact.
   *
   * A background task (`metadata.background`, opencode's experimental
   * background subagents) completes its part while the child keeps running:
   * its mapping stays, and the child's session.idle sends the notification.
   */
  private settleTaskChildren(
    toolRes: { toolUseId: string; isError: boolean },
    snap: PartSnapshot
  ): void {
    const callId = toolRes.toolUseId
    if (snap.state?.metadata?.background === true) {
      if ([...this.childSessions.values()].includes(callId)) this.backgroundTaskCalls.add(callId)
      return
    }
    for (const [childSessionId, mappedCallId] of this.childSessions) {
      if (mappedCallId !== callId) continue
      this.sendTaskNotification({
        taskId: childSessionId,
        toolUseId: callId,
        status: !toolRes.isError ? 'completed' : wasAborted(snap) ? 'stopped' : 'failed',
        outputFile: '',
        summary: ''
      })
      this.childSessions.delete(childSessionId)
    }
  }

  private dispatchMapperOutput(output: MapperOutput): void {
    switch (output.kind) {
      case 'stream':
        this.appendStreamItem(output.item, output.delta)
        break

      case 'message': {
        const msg = output.message
        this.rememberOpencodeMessage(msg)
        if (output.item) this.updateStreamItem(output.item, msg)
        else this.send('session:message', msg)

        // Check for newly completed tool parts in the accumulator
        const acc = this.accumulators.get(msg.id)
        // ADR-053 sub-turn boundary: a tool call of THIS turn just finished, so
        // held queue items may now be forwarded (see the flush below).
        let toolCompleted = false
        if (acc) {
          for (const [partId, snap] of acc.parts) {
            const cacheKey = `${msg.id}:${partId}`
            if (!this.emittedToolResults.has(cacheKey)) {
              const toolRes = extractToolResult(partId, snap)
              if (toolRes) {
                this.emittedToolResults.add(cacheKey)
                toolCompleted = true
                // Phase 3: the classifier's `{"outcome":…}` annotation for this
                // call. Recorded HERE rather than derived from messageHistory at
                // classify time because live assistant messages carry no
                // tool_result blocks at all (buildChatMessage emits tool_use
                // only — results are a separate channel); deriving would work
                // only for replayed history and miss the in-turn retry, which is
                // precisely what Transient Retry needs to see.
                this.recordToolOutcome(toolRes.toolUseId, toolRes.isError ? 'error' : 'ok')
                this.send('session:tool-result', toolRes)
                this.settleTaskChildren(toolRes, snap)
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
        if (toolCompleted) void this.flushQueuedItems()
        break
      }

      case 'approval': {
        const approval = output.approval
        this.pendingApprovals.set(approval.requestId, {
          toolUseId: approval.toolUseId,
          approval,
          // A question is the human's alone — no session allow ever answers it.
          sweepable: approval.toolName !== 'AskUserQuestion'
        })

        if (approval.toolName === 'AskUserQuestion') {
          // Model-elicitation questions (question.asked) must ALWAYS go to the
          // human regardless of autonomy mode — the auto-mode classifier judges
          // tool PERMISSIONS, not user-facing structured questions. Store the
          // question list so resolveApproval can map answers in order.
          const input = approval.input as { questions?: AskUserQuestion[] }
          this.pendingQuestions.set(approval.requestId, input.questions ?? [])
          this.send('session:approval-request', approval)
        } else {
          this.routePermissionAsk(approval)
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
        this.takePendingAsk(requestId)
        this.pendingQuestions.delete(requestId)
        this.send('session:approval-dismiss', { requestId })
        break
      }

      case 'result':
        this.sealStreamItems(this.openSessionId ?? undefined)
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
        // The stopped turn (if any) has ended: the user-stop window closes (ADR-090).
        this.endUserStop()
        // ADR-053: turn end is also a boundary — anything still held forwards
        // now, as the next turn's prompt (isProcessing is already false, so
        // run() takes the fresh-turn path rather than the steer path).
        void this.flushQueuedItems()
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

      case 'auth-required': {
        this.isProcessing = false
        // ADR-068 §4: one event for every engine, naming the PROVIDER the
        // sign-in dialog can act on rather than opencode's own vendor id.
        //
        // ADR-070 §1: opencode's verbatim message rides ON the event and the
        // companion `session:error` is GONE — it was a second, separately
        // dismissable card for the same fact. The words are not lost: the row
        // discloses them in place, and the neutral transcript block below gives
        // them a permanent home the floating card never had.
        //
        // ORDER: before `sendStatus()` below. The reducer captures the retry only
        // while the canonical status still reads `running`.
        const providerId = opencodeAuthRequiredProviderId(output.vendorId)
        this.send('session:auth-required', { providerId, message: output.message })
        // The SAME providerId on the block, so the row still names the provider
        // once the live `authRequired` has settled (ADR-070 §4).
        this.rememberAndSend(authErrorTranscriptMessage(uuid(), output.message, providerId))
        this.sendStatus()
        this.resetInactivityTimer()
        break
      }

      case 'error':
        this.sealStreamItems(this.openSessionId ?? undefined)
        this.isProcessing = false
        // ADR-090: a turn the user stopped ends in opencode's
        // MessageAbortedError — the abort's aftermath, not news. The window is
        // the rule (an abort outside a user stop is unexplained and still shows).
        if (!this.suppressedAfterUserStop('OpencodeSession', output.message)) {
          this.send('session:error', output.message)
        }
        this.sendStatus()
        this.resetInactivityTimer()
        break

      case 'subagent-stream':
        this.appendStreamItem(output.item, output.delta, output.toolUseId)
        break

      case 'subagent-message': {
        const { toolUseId, message } = output
        if (output.item) this.updateStreamItem(output.item, message, toolUseId)
        else this.send('session:subagent-message', { toolUseId, message })

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
                  ...(toolRes.fileDiffs ? { fileDiffs: toolRes.fileDiffs } : {}),
                  ...(toolRes.images ? { images: toolRes.images } : {})
                })
                // A child's own `task` call ended: its grandchild's mapping
                // ends with it (same lifetime rule as the parent's calls).
                this.settleTaskChildren(toolRes, snap)
              }
            }
          }
        }
        break
      }

      case 'task-notification': {
        // A child's session.idle: the child's streams are done either way, but
        // the notification is terminal only for a background call — a
        // foreground call's comes from its task part (settleTaskChildren), the
        // only place that knows the outcome.
        const { taskId, toolUseId } = output.notification
        if (!toolUseId || !this.backgroundTaskCalls.delete(toolUseId)) {
          this.sealStreamItems(taskId)
          break
        }
        if (this.childSessions.get(taskId) === toolUseId) this.childSessions.delete(taskId)
        this.sendTaskNotification(output.notification)
        break
      }

      case 'todos':
        // Feed the floating Todo widget via the existing session:plan channel,
        // which is already wired through preload → useClaudeEvents.onPlanSteps → setTodos.
        this.send('session:plan', output.items)
        break

      case 'ignore':
        break
    }
  }

  private streamItemKey(ownerSessionId: string, partId: string): string {
    return JSON.stringify([ownerSessionId, partId])
  }

  private streamTarget(item: OpencodeStreamItem, ownerToolUseId?: string): ItemStreamTarget {
    return {
      messageId: item.messageId,
      blockIndex: item.blockIndex,
      kind: item.kind,
      ...(ownerToolUseId ? { ownerToolUseId } : {})
    }
  }

  private updateStreamItem(
    item: OpencodeStreamItem,
    message: ChatMessage,
    ownerToolUseId?: string
  ): void {
    const ownerSessionId = ownerToolUseId
      ? ([...this.childSessions].find(([, toolUseId]) => toolUseId === ownerToolUseId)?.[0] ?? '')
      : (this.openSessionId ?? '')
    const key = this.streamItemKey(ownerSessionId, item.partId)
    const target = this.streamTarget(item, ownerToolUseId)
    const active = this.activeStreamItems.get(key)
    const snap = this.accumulators.get(item.messageId)?.parts.get(item.partId)
    if (snap?.sealed) {
      if (item.completed)
        this.send('session:item-seal', {
          target,
          message,
          ...(ownerToolUseId ? { ownerToolUseId } : {})
        })
      return
    }
    const block = message.content[item.blockIndex]
    if (
      !active &&
      item.kind === 'thinking' &&
      block?.type === 'thinking' &&
      block.text.length === 0
    )
      return
    if (!active) {
      this.activeStreamItems.set(key, { target, ownerSessionId, partId: item.partId })
      this.send('session:item-open', {
        target,
        message,
        // opencode times its own reasoning parts; fall back to now when the
        // snapshot has no start yet.
        ...(item.kind === 'thinking' ? { startedAt: snap?.time?.start ?? Date.now() } : {})
      })
    }
    if (item.completed) {
      this.send('session:item-seal', {
        target,
        message,
        ...(ownerToolUseId ? { ownerToolUseId } : {})
      })
      this.activeStreamItems.delete(key)
      if (snap) snap.sealed = true
    }
  }

  private appendStreamItem(item: OpencodeStreamItem, chunk: string, ownerToolUseId?: string): void {
    const ownerSessionId = ownerToolUseId
      ? ([...this.childSessions].find(([, toolUseId]) => toolUseId === ownerToolUseId)?.[0] ?? '')
      : (this.openSessionId ?? '')
    const acc = this.accumulators.get(item.messageId)
    const key = this.streamItemKey(ownerSessionId, item.partId)
    let active = this.activeStreamItems.get(key)
    if (!active && acc && !acc.parts.get(item.partId)?.sealed) {
      const target = this.streamTarget(item, ownerToolUseId)
      const message = buildChatMessage(item.messageId, acc)
      const content = [...message.content]
      content[item.blockIndex] =
        item.kind === 'thinking' ? { type: 'thinking', text: '' } : { type: 'text', text: '' }
      this.send('session:item-open', {
        target,
        message: { ...message, content },
        ...(item.kind === 'thinking'
          ? { startedAt: acc.parts.get(item.partId)?.time?.start ?? Date.now() }
          : {})
      })
      active = { target, ownerSessionId, partId: item.partId }
      this.activeStreamItems.set(key, active)
    }
    if (!active) return
    this.send('session:item-delta', { target: active.target, chunk })
    if (acc && !ownerToolUseId) this.rememberOpencodeMessage(buildChatMessage(item.messageId, acc))
  }

  private sealStreamItems(ownerSessionId?: string): void {
    for (const [key, active] of this.activeStreamItems) {
      if (ownerSessionId !== undefined && active.ownerSessionId !== ownerSessionId) continue
      const acc = this.accumulators.get(active.target.messageId)
      if (acc) {
        const snap = acc.parts.get(active.partId)
        if (snap) {
          snap.sealed = true
          if (snap.type === 'reasoning' && typeof snap.time?.end !== 'number') {
            const end = Date.now()
            snap.time = { start: snap.time?.start ?? end, end }
          }
        }
        this.send('session:item-seal', {
          target: active.target,
          message: buildChatMessage(active.target.messageId, acc),
          ...(active.target.ownerToolUseId ? { ownerToolUseId: active.target.ownerToolUseId } : {})
        })
      }
      this.activeStreamItems.delete(key)
    }
  }

  async interrupt(): Promise<void> {
    // ADR-090: open the user-stop window for a live turn BEFORE the abort —
    // the SSE `session.error` (MessageAbortedError) can beat the HTTP reply.
    if (this.isProcessing) this.beginUserStop()
    if (this.client && this.openSessionId) {
      try {
        await this.client.abortSession(this.openSessionId)
        this.sealStreamItems(this.openSessionId)
      } catch (err) {
        logger.warn(
          'OpencodeSession',
          `abort failed: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
  }

  cancel(): void {
    this.clearInactivityTimer()
    this.sealStreamItems()
    this._cancelled = true
    this.isProcessing = false
    this.endUserStop()
    // Deliberate teardown (window close, idle timeout) is still a disconnect as
    // far as the renderer is concerned — Claude broadcasts 'disconnected' from
    // its own cancel() (claude-session.ts). Without it an idle-timed-out
    // opencode session keeps `sdkActive` set and the sidebar dot stays green.
    this.disconnected = true
    this.lastContextLength = 0
    this.sseAbort?.abort()
    this.sseAbort = null
    // No SSE consumer is left to deliver a tool part, so nothing waiting on one
    // may sit out its timer (ADR-084 §1): settle every wait as closed.
    for (const waiters of [...this.toolInputWaiters.values()]) {
      for (const settle of [...waiters]) settle('closed')
    }
    this.childSessions.clear()
    this.backgroundTaskCalls.clear()
    // ADR-085 S4 — the next run() reconnects and re-PATCHes (F3's skip must
    // not trust a ruleset from before the teardown).
    this.lastPatchedRuleset = null
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
    this.unsubscribeServerExit?.()
    this.unsubscribeServerExit = null
    if (this.conn) {
      // Exact, never by cwd alone: one server serves many directories, and a
      // config change can leave two servers holding this cwd (ADR-093 §2).
      opencodeServerManager.releaseIfCurrent(this.cwd, this.conn)
      this.conn = null
      this.client = null
    }
    // Nothing left to serve the queue (ADR-053 §engine death).
    this.recallQueuedOnEngineLoss()
    this.dropBlockHolds()
    this.sendStatus()
  }

  resolveApproval(
    requestId: string,
    decision: ApprovalDecision,
    answers?: Record<string, string>,
    updatedPermissions?: PermissionSuggestion[]
  ): void {
    // Read BEFORE the delete: the record's approval carries the `always`
    // patterns an allow-for-session remembers (ADR-085 S2).
    const pending = this.takePendingAsk(requestId)
    const approvalToolUseId = pending?.toolUseId
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
          logger.warn(
            'OpencodeSession',
            `replyQuestion failed: ${err instanceof Error ? err.message : String(err)}`
          )
        })
      } else {
        // deny or allow without answers → reject the question
        this.client.rejectQuestion(requestId).catch((err) => {
          logger.warn(
            'OpencodeSession',
            `rejectQuestion failed: ${err instanceof Error ? err.message : String(err)}`
          )
        })
      }
      return
    }

    // ── Permission approval (permission.asked) ───────────────────────────────
    const allow = decision === 'allow' || decision === 'allowForSession'

    // A held auto-mode block (ADR-091 §3) — Keep blocked (or its expiry) /
    // Approve anyway. An override of this ONE call: `once` either way, no
    // session allow, no persisted rule.
    if (pending?.hold) {
      if (allow) {
        // The user overrode the block: the streak it counted resets, the
        // review reads "approved by you", and the call reports its own
        // outcome when it runs.
        this.autoDenials.recordAllow()
        if (approvalToolUseId) this.blockedCalls.approveHeld(approvalToolUseId)
        this.autoReply(requestId, 'once')
      } else {
        this.keepBlocked(requestId, approvalToolUseId, pending.hold.reason)
      }
      return
    }
    // "always allow" = the user checked persist-rule suggestions in the dialog.
    const persist = allow && !!updatedPermissions && updatedPermissions.length > 0
    // ADR-085 S2 — never `always`, for any category. opencode stores an
    // `always` reply's patterns in an INSTANCE-global `approved` list
    // (vendor permission/index.ts `reply()`), which `ask()` evaluates AFTER the
    // session ruleset with last-match-wins: one approval then outranks the
    // user's deny/ask rules for every chat, child and dispatch target in this
    // folder until the server exits, and the judge never sees those calls. An
    // allow-for-session or a ticked "always allow" is remembered host-side
    // instead (sessionAllows, below) and the reply is `once`.
    const reply = allow ? 'once' : 'reject'
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
      logger.warn(
        'OpencodeSession',
        `replyPermission failed: ${err instanceof Error ? err.message : String(err)}`
      )
    })

    // ADR-085 S2 — what `always` used to buy, kept host-side: remember the
    // ask's `always` patterns for THIS chat, then answer the pending asks they
    // now cover (the vendor's same-session `always` cascade, which a `once`
    // reply does not run). An ask with no `always` cannot be remembered.
    if (allow && (decision === 'allowForSession' || persist) && pending?.approval.always) {
      this.sessionAllows.add(pending.approval.toolName, pending.approval.always)
      this.sweepSessionAllows()
    }

    // Persist the rule to the shared store so it recompiles onto opencode next
    // spawn + shows in PermissionsDialog (session + shared store — ADR-022).
    // 'session' destinations are skipped by the shared persister — the host
    // session-allow set above already covers them (session-allows.ts).
    if (persist) persistAllowSuggestions(updatedPermissions!, this.cwd, 'OpencodeSession')
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

  /**
   * Settings files changed on disk — recompile the user's permission rules into
   * the live session ruleset (parity with ClaudeSession/PiSession, which both
   * hot-reload rules mid-session). `mergedUserPermissions` reads user/project/
   * local fresh on every call, so re-applying the CURRENT mode is enough to
   * pick up the edit; the mode itself is untouched.
   */
  async notifySettingsChanged(): Promise<void> {
    // Nothing to patch yet — establishSession applies the mode (and reads the
    // rules) once the session exists.
    if (!this.client || !this.openSessionId) return
    try {
      await this.applyPermissionMode(this.permissionMode)
    } catch (err) {
      // applyPermissionMode fails CLOSED to gate a TURN. This is a background
      // refresh with no turn behind it: the previously-applied ruleset stays in
      // force and the next run() re-applies (and fails the turn if it still
      // can't), so surfacing a session:error here would be noise.
      logger.warn(
        'OpencodeSession',
        `notifySettingsChanged: rule refresh failed, keeping the active ruleset: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }

  /**
   * Patch the session's permission ruleset for `mode`: the mode base, the
   * user's compiled rules (mode-filtered), the subagent backstop (ADR-085 S4)
   * and the dispatch-tool ask.
   *
   * ADR-085 S4 / S3b verifier F3 — an UNCHANGED ruleset is not re-sent. The
   * PATCH APPENDS (`vendor/opencode-src/packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:194-198`,
   * `Permission.merge(current, payload)`), and every `run()` applies the mode,
   * so re-sending the same rules grew the stored ruleset without bound (116 →
   * 2705 rules in ~21 turns) — and opencode's DeniedError renders every
   * matching rule, the user's own included, into the tool result the model
   * reads. A NEW opencode session id, a reconnect (`ensureConnected` resets the
   * record), or a changed mode / settings / MCP set / agent set re-PATCHes;
   * so does a retry after a failed PATCH (the record is only written on
   * success).
   */
  private async applyPermissionMode(mode: string): Promise<void> {
    if (!this.client || !this.openSessionId) return
    // Plan mode additionally switches to opencode's read-only `plan` agent
    // (its planning system prompt + plan_exit flow); all other modes use the
    // default `build` agent. We ALWAYS patch a ruleset (including plan) so the
    // session's effective permissions are deterministic and never inherit a
    // stale override from a previous mode. See buildRuleset / ADR-022.
    this.agent = mode === 'plan' ? 'plan' : null
    // In auto mode (full + classifier enabled) we use the acceptEdits base so the
    // ruleset auto-allows reads and only bash/webfetch raise `permission.asked`
    // → the classifier judges just those (the acceptEdits-equivalence
    // fast-path, parity with cli.js). Edits ask too, but only so the host-side
    // agent-control gate in handleAutoModeApproval sees them: an ordinary edit
    // is allowed there with no judge call (buildAutoModeRuleset, ADR-084 §3).
    // Classifier-disabled `full` falls through to buildRuleset('full') = the
    // gated `default` (ADR-023).
    const autoMode = this.isAutoMode(mode)
    const mcpServers = await this.resolveMcpServers()
    // ADR-085 §3: auto mode adds one MCP ask per known server, so MCP calls
    // reach the host (the user's MCP rules, then the judge).
    const base = autoMode ? buildAutoModeRuleset({ mcpServers }) : buildRuleset(mode)
    // Compose: autonomy-mode base ruleset + the user's neutral permission rules
    // (Claude's allow/ask/deny + additionalDirectories) compiled to opencode and
    // appended AFTER the base so they override it (last-match-wins). This makes
    // the SAME configured rules apply to opencode as to Claude. See ADR-022.
    const userRules = this.compiledUserRules(mcpServers)
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
    // unchanged.
    // PLAN MODE (ADR-085 ruling 7): the user's `edit`, `bash` and `task` ALLOW
    // rules are patched out too — appended after the plan base they would turn
    // its `edit`/`bash`/`task:general` asks back into server-side allows
    // (last-match-wins), so an edit, `git commit` or a `general` subagent never
    // asked and the host's plan refusal never saw it. The bash allows are
    // applied host-side instead, for plan-safe commands only (host-precheck.ts
    // `allow-rule`); see `withoutMutatingAllowRules`. Every other mode keeps
    // the full compiled set.
    const effectiveUserRules = autoMode
      ? withoutAllowRules(userRules)
      : mode === 'plan'
        ? withoutMutatingAllowRules(userRules)
        : userRules
    // ADR-085 S4 — the `task:<name>` asks for subagents a gated category may
    // still be allowed under (see resolveSubagentBackstop). AFTER the user
    // rules on purpose: a user `Task`/`Task(x)` allow must not un-gate an
    // agent whose bash is ungated — the ask is about the agent, not the user's
    // task preference (in plan mode `withoutMutatingAllowRules` strips task
    // allows anyway).
    const backstop = await this.resolveSubagentBackstop(autoMode, mcpServers)
    const ruleset = [...base, ...effectiveUserRules, ...backstop, DISPATCH_AGENT_ASK_RULE]
    const sessionId = this.openSessionId
    const key = JSON.stringify(ruleset)
    if (
      this.lastPatchedRuleset &&
      this.lastPatchedRuleset.sessionId === sessionId &&
      this.lastPatchedRuleset.key === key
    ) {
      logger.debug('OpencodeSession', 'permission ruleset unchanged — no PATCH')
      return
    }
    try {
      // The server gets no narrow bash/edit/webfetch deny — each is an ask the
      // host pre-check refuses (rung 1b), because opencode's DeniedError dumps
      // the ruleset into the model's context — and its whole-category denies
      // last, so they hide the tool (`opencodeWireRuleset`). The host keeps
      // `ruleset` itself: `parentRuleset` and the unchanged-key check read it.
      await this.client.patchSession(sessionId, {
        permission: opencodeWireRuleset(ruleset, CHILD_GATED_CATEGORIES)
      })
      this.lastPatchedRuleset = { sessionId, rules: ruleset, key }
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
      throw new Error(
        `Could not apply permission mode "${mode}" to the opencode session: ${detail}`
      )
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
   *  rather than breaking the turn. `mcpServers` gates server-level MCP allow
   *  rules (ADR-085 §3). */
  private compiledUserRules(
    mcpServers: readonly string[]
  ): ReturnType<typeof compileClaudeRulesToOpencode> {
    try {
      return compileClaudeRulesToOpencode(this.mergedUserPermissions(), { mcpServers })
    } catch (err) {
      logger.warn(
        'OpencodeSession',
        `compiling user permission rules failed: ${err instanceof Error ? err.message : String(err)}`
      )
      return []
    }
  }

  /**
   * The MCP server names ClaudeUI knows without asking the server: the Claude
   * servers it bridges (`collectClaudeMcpForOpencode`, the same call the spawn
   * uses) and its own `claudeui`. Never throws (the collector returns `{}` on
   * failure).
   */
  private staticMcpServers(): string[] {
    return [
      ...new Set([...Object.keys(collectClaudeMcpForOpencode(this.cwd)), CLAUDEUI_MCP_SERVER])
    ]
  }

  /**
   * The live MCP server set (see `knownMcpServers`): the static set plus the
   * `GET /mcp` keys. A failing `GET /mcp` warns once per session and yields
   * the static set for this call; it is not cached, so the next apply retries.
   */
  private async resolveMcpServers(): Promise<string[]> {
    if (this.knownMcpServers) return this.knownMcpServers
    const known = this.staticMcpServers()
    try {
      const status = (await this.client?.mcpStatus()) ?? {}
      this.knownMcpServers = [...new Set([...known, ...Object.keys(status)])]
      return this.knownMcpServers
    } catch (err) {
      if (!this.mcpStatusWarned) {
        this.mcpStatusWarned = true
        logger.warn(
          'OpencodeSession',
          `GET /mcp failed — MCP rules use the bridged servers only: ${err instanceof Error ? err.message : String(err)}`
        )
      }
      return known
    }
  }

  /**
   * ADR-085 S4 — the categories a task child's ask may be answered with the
   * parent's rules for (host-precheck.ts `childGatedCategories`): exactly the
   * ones the spawn put a static ask on — the gated built-ins plus the bridged
   * MCP servers' keys (the spawn's `collectClaudeMcpForOpencode` set, minus
   * `claudeui`). A `GET /mcp`-only server got no injected ask, so a child ask
   * for it stays the card's / judge's, as does every other category.
   */
  private childGatedCategories(): string[] {
    this.childGated ??= [
      ...CHILD_GATED_CATEGORIES,
      ...this.staticMcpServers()
        .filter((server) => server !== CLAUDEUI_MCP_SERVER)
        .map((server) => opencodeMcpKey(server))
    ]
    return this.childGated
  }

  /**
   * ADR-085 S4 — the parent-side subagent backstop for this apply: one
   * `{task, <name>, ask}` per subagent whose computed ruleset (`GET /agent`)
   * may still ALLOW a gated category (`subagentBackstopRules`) — an agent the
   * spawn-time scan could not give its static asks. Gated = bash/edit/webfetch,
   * plus in auto mode (the one mode whose parent base gates MCP) the MCP key
   * of every known server except `claudeui`. The agent list is cached per
   * session (see `subagentAgents`); a failing `GET /agent` warns once per
   * session and fails CLOSED for this apply (`task * ask` — every spawn asks),
   * not cached, so the next apply retries.
   */
  private async resolveSubagentBackstop(
    autoMode: boolean,
    mcpServers: readonly string[]
  ): Promise<PermissionRule[]> {
    let agents = this.subagentAgents
    if (!agents) {
      try {
        const listed = await this.client?.agents()
        if (!Array.isArray(listed)) throw new Error('GET /agent did not return a list')
        agents = listed
        this.subagentAgents = listed
      } catch (err) {
        if (!this.agentsWarned) {
          this.agentsWarned = true
          logger.warn(
            'OpencodeSession',
            `GET /agent failed — every task spawn asks: ${err instanceof Error ? err.message : String(err)}`
          )
        }
        return [TASK_BACKSTOP_FAIL_CLOSED_RULE]
      }
    }
    const gated: string[] = [
      ...CHILD_GATED_CATEGORIES,
      ...(autoMode
        ? mcpServers
            .filter((server) => server !== CLAUDEUI_MCP_SERVER)
            .map((server) => opencodeMcpKey(server))
        : [])
    ]
    const rules = subagentBackstopRules(agents, gated)
    if (rules.length > 0) {
      logger.debug(
        'OpencodeSession',
        `subagent backstop: task ask for ${rules.map((r) => r.pattern).join(', ')}`
      )
    }
    return rules
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

  /** The engine-shared trust lists, DERIVED into this session's classifier
   *  environment at session start (ADR-065 § Shared trust lists). They live in
   *  one file for every engine, so they are read from there rather than from
   *  `autoModeConfig()`, which is opencode's own judge block. */
  private sharedAutoModeConfig(): SharedAutoModeConfig {
    if (this._sharedAutoMode === undefined) {
      try {
        this._sharedAutoMode = loadSharedAutoModeConfig()
      } catch {
        this._sharedAutoMode = {}
      }
    }
    return this._sharedAutoMode
  }

  /** The user-authored (compiled) rules the last patched ruleset carried. Falls
   *  back to compiling them on demand: the SSE consumer is started before the
   *  first `applyPermissionMode`, so a `permission.asked` can arrive before the
   *  cache is warm, and G9 must not silently degrade to "no user rules". The
   *  cold-start compile is synchronous, so it sees the static MCP server set
   *  (bridged servers + `claudeui`), or the live one once resolved. */
  private userOriginRules(): OpencodePermissionRule[] {
    if (this.lastCompiledUserRules === null) {
      this.lastCompiledUserRules = this.compiledUserRules(
        this.knownMcpServers ?? this.staticMcpServers()
      )
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
   *  (plan phase 2 + 3, ADR-083 §3/§4). What the judge is told is
   *  {@link buildClassifierEnvironment}'s job, shared with pi; this method only
   *  gathers the inputs. The trust and guidance lists come from the
   *  engine-SHARED `~/.claude/ui/automode.json` (read once per session); the
   *  user's permission rules are read FRESH on every approval, like the rules
   *  the engine enforces, so a settings.json edit mid-session reaches the judge
   *  on the next action. */
  private async classifierEnvironment(): Promise<EnvironmentInfo> {
    const remotes = await this.sessionGitRemotes()
    return buildClassifierEnvironment({
      cwd: this.cwd,
      platform: process.platform,
      remotes,
      repoVisibility: this.sessionRepoVisibility,
      permissions: this.mergedUserPermissions(),
      shared: this.sharedAutoModeConfig()
    })
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
    // ADR-084 §2 — repo-local git config that makes git run a program, in the
    // directory the command runs in (opencode honours `workdir`). Only a
    // non-empty list is emitted: `[]` (clean) and `null` (not measured) both
    // say nothing, per this method's rule that absence is never "fine".
    if (hasGitSegment(command)) {
      const runIn = effectiveShellCwd(this.cwd, input, true)
      const armed = runIn === null ? null : await captureGitConfigArmed(runIn)
      if (armed && armed.length > 0) meta.gitConfigArmed = armed
    }
    return Object.keys(meta).length > 0 ? meta : undefined
  }

  /**
   * ADR-084 §1 — the input the pipeline's read-only gate reads
   * (`inputFor('read-only')`), run after the category fast path and before any
   * judge is resolved. `null` → no read-only gate (the call goes on to the
   * allow-rule skip and the judge exactly as before); `'settled'` → the ask
   * went away meanwhile (nothing replied, no judge asked).
   *
   * The command is read from the TOOL PART's own input, never from the ask's
   * `metadata` fallback: opencode's shell ask carries only `{command}` there
   * (vendor/opencode-src/packages/opencode/src/tool/shell.ts `ask`), so a
   * `workdir` would be lost and every relative path checked against the wrong
   * directory. The shell tool asks from its own `execute`, concurrently with
   * the processor publishing the part's input, so the ask can arrive first:
   * when the part carries no input yet, wait up to TOOL_INPUT_WAIT_MS for it.
   * Still no tool part → no read-only gate (the judge decides).
   */
  private async readOnlyInput(
    approval: PendingApproval
  ): Promise<Record<string, unknown> | null | 'settled'> {
    if (!isShellToolName(approval.toolName)) return null
    if (!this.isAutoMode(this.permissionMode)) return null
    let input = findToolInput(this.accumulators, undefined, approval.toolUseId)
    if (!input && approval.toolUseId) {
      logger.debug('OpencodeSession', 'auto-mode read-only bypass: waiting for the tool part input')
      const outcome = await this.waitForToolInput(approval.toolUseId)
      // The session closed under the wait: the ask went with it, so nothing is
      // replied and no judge is asked.
      if (outcome === 'closed') {
        logger.debug(
          'OpencodeSession',
          'auto-mode read-only bypass: session closed while waiting — not replying'
        )
        return 'settled'
      }
      // Answered server-side during the wait: settled, so handled — the same
      // rule as the pipeline's check after the gate (`stillPending`).
      if (!this.pendingApprovals.has(approval.requestId)) {
        logger.debug(
          'OpencodeSession',
          'auto-mode read-only bypass: ask resolved while it ran — not replying'
        )
        return 'settled'
      }
      input = findToolInput(this.accumulators, undefined, approval.toolUseId)
    }
    if (!input) {
      logger.debug('OpencodeSession', 'auto-mode read-only bypass refused (input:unverified)')
      return null
    }
    return input
  }

  /**
   * The allow-rule review on the call's card. A shell ask only gets here once
   * its tool part is known (readOnlyInput waited), but an MCP / webfetch ask
   * can precede its part, and the reducer DROPS a block whose `tool_use` is in
   * no message yet — so, like sendDenial, hold it until the part's input
   * arrives (≤ TOOL_INPUT_WAIT_MS). The reply is never delayed.
   */
  private sendAllowRuleReview(toolUseId: string | undefined, rule: string): void {
    if (!toolUseId) return
    const send = (): void => {
      this.sendToolReview(toolUseId, { allowRule: rule })
    }
    if (this.hasToolPart(toolUseId)) {
      send()
      return
    }
    void this.waitForToolInput(toolUseId).then((outcome) => {
      if (outcome === 'input' || (outcome === 'timeout' && this.hasToolPart(toolUseId))) send()
    })
  }

  /**
   * What the allow-rule skip checks for this ask, or `undefined` (no skip —
   * the judge decides). Paths below are under
   * `vendor/opencode-src/packages/opencode/src/`.
   * - shell: the TOOL PART's input only (readOnlyInput already waited for
   *   it; the ask's `{command}` metadata would lose `workdir`);
   * - `webfetch`: the url (`tool/webfetch.ts:39-47` asks with
   *   `patterns: [params.url]`, `metadata: {url, …}`); `websearch`
   *   (`tool/websearch.ts:119-124`, bare rules only); `skill`: its name
   *   (`tool/skill.ts:27-32`, `patterns: [name]`);
   * - an MCP key (`session/tools.ts:408` asks with
   *   `permission: <sanitize(server)>_<sanitize(tool)>`, `patterns: ["*"]`,
   *   `metadata: {}`; the sanitiser is `mcp/catalog.ts:117-119`): not a
   *   built-in permission key, and exactly ONE known server (the S3 resolved
   *   set) whose `sanitize(s)_` prefixes it — two (`a` and `a_b` over `a_b_x`,
   *   or `a.b` and `a_b`) leave the call's server unknown, so no skip. The
   *   rule's tool name is compared in the key's form (`mcpToolKey`);
   * - `edit`, `task`, `doom_loop`, `read`, `external_directory`, anything
   *   else: no skip.
   */
  private allowRuleAction(
    approval: PendingApproval
  ): { action: AllowSkipAction; mcpToolKey?: (ruleTool: string) => string } | undefined {
    const category = approval.toolName
    const patterns = approval.patterns ?? []
    const str = (v: unknown): string | undefined =>
      typeof v === 'string' && v !== '' ? v : undefined
    if (isShellToolName(category)) {
      const input = approval.toolUseId
        ? findToolInput(this.accumulators, undefined, approval.toolUseId)
        : undefined
      const command = input?.command
      if (!input || typeof command !== 'string') return undefined
      const workdir = input.workdir
      if (workdir !== undefined && workdir !== null && typeof workdir !== 'string') return undefined
      const dir = str(workdir)
      return { action: { kind: 'shell', command, ...(dir ? { workdir: dir } : {}) } }
    }
    switch (category) {
      case 'webfetch': {
        const url = str(approval.input?.url) ?? str(patterns[0])
        return url ? { action: { kind: 'webfetch', url } } : undefined
      }
      case 'websearch':
        return { action: { kind: 'websearch' } }
      case 'skill': {
        const name = str(patterns[0])
        return name ? { action: { kind: 'skill', name } } : undefined
      }
    }
    if (isOpencodeBuiltinPermissionKey(category) || !this.knownMcpServers) return undefined
    const servers = this.knownMcpServers.filter((s) =>
      category.startsWith(opencodeMcpKey(s).slice(0, -1))
    )
    if (servers.length !== 1) return undefined
    const server = servers[0]
    const tool = category.slice(opencodeMcpKey(server).length - 1)
    return tool ? { action: { kind: 'mcp', server, tool }, mcpToolKey: sanitizeMcpName } : undefined
  }

  /**
   * The approval the judge sees, with the tool part's input when the ask
   * carried none — an MCP tool asks straight from its `execute` with
   * `metadata: {}` (`vendor/opencode-src/packages/opencode/src/session/tools.ts:408`)
   * and never calls `ctx.metadata` first (which is what sets the part's
   * `input: args`, `:67-80`), so its part input comes only from the
   * processor's `tool-call` handler (`session/processor.ts:331-351`), which
   * runs concurrently with `execute` — the ask can win (M-OC6). Waits up to
   * TOOL_INPUT_WAIT_MS, like readOnlyInput for shell. `null` when the session
   * closed or the ask was settled during the wait (nothing to reply); the
   * approval unchanged when it already carries input, has no tool part, or the
   * wait timed out (the judge then sees `{}`, as before).
   */
  private async inputForJudge(approval: PendingApproval): Promise<PendingApproval | null> {
    const hasInput = (input: unknown): boolean =>
      !!input && typeof input === 'object' && Object.keys(input).length > 0
    if (hasInput(approval.input) || !approval.toolUseId) return approval
    const found = findToolInput(this.accumulators, undefined, approval.toolUseId)
    if (found) return { ...approval, input: found }
    const outcome = await this.waitForToolInput(approval.toolUseId)
    if (outcome === 'closed' || !this.pendingApprovals.has(approval.requestId)) {
      logger.debug(
        'OpencodeSession',
        `auto-mode ${approval.toolName}: settled while waiting for input`
      )
      return null
    }
    const input = findToolInput(this.accumulators, undefined, approval.toolUseId)
    return input ? { ...approval, input } : approval
  }

  /**
   * Resolve once the tool part for `callId` carries a non-empty input
   * (`input`), after TOOL_INPUT_WAIT_MS (`timeout`), or on cancel()
   * (`closed`). The caller re-reads the input from the accumulators either way.
   */
  private waitForToolInput(callId: string): Promise<ToolInputWait> {
    return new Promise((resolve) => {
      let waiters = this.toolInputWaiters.get(callId)
      if (!waiters) {
        waiters = new Set()
        this.toolInputWaiters.set(callId, waiters)
      }
      const settle = (outcome: ToolInputWait): void => {
        clearTimeout(timer)
        const current = this.toolInputWaiters.get(callId)
        current?.delete(settle)
        if (current?.size === 0) this.toolInputWaiters.delete(callId)
        resolve(outcome)
      }
      const timer = setTimeout(() => settle('timeout'), toolInputWaitMs)
      waiters.add(settle)
    })
  }

  /**
   * Wake the waits for a tool part whose input just arrived. Called right
   * after mapEvent applied the event to the accumulators, and it reads the
   * accumulators rather than the raw part, so a wake means `findToolInput`
   * will find it.
   */
  private settleToolInputWaiters(ev: OpencodeEvent): void {
    if (this.toolInputWaiters.size === 0 || ev.type !== 'message.part.updated') return
    const part = ev.properties.part as { type?: unknown; callID?: unknown } | undefined
    if (part?.type !== 'tool' || typeof part.callID !== 'string') return
    const waiters = this.toolInputWaiters.get(part.callID)
    if (!waiters || !findToolInput(this.accumulators, undefined, part.callID)) return
    for (const settle of [...waiters]) settle('input')
  }

  /** Auto mode is active for `full`/`auto` autonomy unless explicitly disabled. */
  private isAutoMode(mode: string): boolean {
    return (mode === 'full' || mode === 'auto') && this.autoModeConfig().enabled !== false
  }

  /**
   * True when `autoMode.judgeModel` names a model opencode no longer offers.
   *
   * Fail-closed on purpose: the caller drops to the human instead of judging
   * with a substitute, and specifically instead of falling through to
   * `?? this._model` — silently promoting the SESSION's model to security judge
   * is not what "I picked a cheaper/stronger judge" asked for.
   *
   * Cache-only (`peekOpencodeModels`): a cold or empty catalog cannot tell
   * "removed" from "not discovered yet", so it validates nothing and the
   * configured model passes through. eagerConnect already awaits
   * `discoverOpencodeModels()`, so the cache is warm by the time approvals flow.
   */
  private judgeModelUnavailable(): boolean {
    const configured = this.autoModeConfig().judgeModel
    if (!configured) return false
    const all = (peekOpencodeModels() ?? []).flatMap((g) => g.models)
    if (all.length === 0) return false
    if (all.some((m) => m.value === configured)) return false
    if (!this.staleJudgeModelReported) {
      this.staleJudgeModelReported = true
      this.send(
        'session:error',
        `Auto-mode judge model "${configured}" is no longer available — every gated action will ask you instead. ` +
          `Change it in Settings › Sessions & autonomy › Auto-mode judge (opencode).`
      )
    }
    return true
  }

  /** One banner per session for a judge model ClaudeUI can't call (ADR-081 §3). */
  private reportJudgeRouteUnavailable(reason: string): void {
    if (this.judgeRouteUnavailableReported) return
    this.judgeRouteUnavailableReported = true
    this.send('session:error', judgeRouteUnavailableMessage('opencode', reason))
  }

  /**
   * The judge transport: ClaudeUI's own HTTP call to the judge model (ADR-081),
   * NOT an opencode session — so the judge prompt is exactly the policy, the
   * stage budgets and stop sequence apply, and the call's usage lands on the
   * ledger as a `judge` row under this session.
   *
   * Judge model = `autoMode.judgeModel`, else the session's own model (ADR-023),
   * resolved per call. A model no ClaudeUI route covers is not judged by anyone
   * else: the call fails, `classify()` returns unavailable, the human decides,
   * and the session says why once.
   */
  private makeJudgeFn(): JudgeTransport | null {
    if (this.judgeModelUnavailable()) return null
    return makeSessionJudgeTransport({
      engine: 'opencode',
      modelValue: () => this.autoModeConfig().judgeModel ?? this._model,
      sessionId: () => this.openSessionId,
      routingId: this.routingId,
      onUnavailable: (reason) => this.reportJudgeRouteUnavailable(reason)
    })
  }

  // ── ADR-085 S2: host pre-check + session allows ───────────────────────────

  /**
   * Route one permission ask (own session or task child). Before the
   * auto/human split, the host looks at it (host-precheck.ts): the user's
   * deny/ask rules hold in EVERY mode (owner ruling 3) — a deny the server's
   * glob missed is refused here, and an ask rule sends the call to the human,
   * never the judge (G9: letting the judge auto-approve exactly what the user
   * singled out would make auto mode a permission downgrade; it runs before
   * both fast paths, so an ask the user wrote on `read` still reaches them).
   * Only then may this chat's session-allow set answer it; otherwise today's
   * split: auto mode → the judge path, else the card.
   *
   * Plan mode's refusal (ADR-085 §3, ruling 7) is a rung of the pre-check,
   * right after the deny rules: any `edit`, `task:general`, and a shell
   * command `isPlanReadOnlyCommand` cannot vouch for — regardless of the
   * user's ask rules, session allows and allow rules. The plan ruleset ASKS
   * for `edit`/`task:general`/`bash` rather than denying them server-side (a
   * PATCHed deny outlives the mode and binds every task child —
   * permission-ruleset.ts `buildRuleset('plan')`), so the refusal is made
   * here, for own and child asks alike. The mode is read at ask time: a
   * mid-turn switch is visible here at once, while the server keeps the
   * ruleset its runLoop snapshotted. A plan-safe command a user allow rule
   * covers is answered `once` host-side (`allow-rule`), because plan mode
   * sends no `edit`/`bash` allow to the server (`withoutMutatingAllowRules`).
   *
   * ADR-085 S4 (owner ruling 4) — a task CHILD's ask is answered with the
   * PARENT's rules: its agent always asks for the gated categories (static
   * asks injected at spawn, `subagent-permissions.ts`), and once the rungs
   * above have not spoken, the ruleset last PATCHed onto this session decides
   * (`parent-allow` → `once` silently; a deny → refused with the rule; an ask
   * → today's split, so in auto mode the fast path, the agent-control gate,
   * the read-only bypass and the judge — told which subagent proposed the
   * call — all apply).
   */
  private routePermissionAsk(approval: PendingApproval): void {
    const category = approval.toolName
    const autoMode = this.isAutoMode(this.permissionMode)
    const verdict = hostPrecheck(approval, this.precheckContext())
    if (approval.subagent) {
      logger.debug(
        'OpencodeSession',
        `child ask ${category} from subagent session ${approval.subagent.sessionId} (task ${approval.subagent.parentToolUseId}) → ${verdict.kind}`
      )
    }
    switch (verdict.kind) {
      case 'deny':
        this.denyByRule(approval, verdict.rule)
        return
      case 'plan-refuse':
        this.autoReply(approval.requestId, 'reject', PLAN_MODE_DENY_REASON_NO_EXIT_TOOL)
        // No command text on an info line (ADR-084 logging rule).
        logger.info(
          'OpencodeSession',
          `plan mode refused ${category}${approval.subagent ? ' (subagent)' : ''}`
        )
        if (approval.toolUseId) {
          this.sendDenial(approval.toolUseId, 'mode', PLAN_MODE_DENY_REASON_NO_EXIT_TOOL)
        }
        return
      case 'user-ask': {
        const pending = this.pendingApprovals.get(approval.requestId)
        if (pending) pending.sweepable = false
        if (autoMode) {
          // No command text on an info line (ADR-084 logging rule).
          logger.info(
            'OpencodeSession',
            `auto-mode → human: user ask rule matches ${category}${verdict.rule ? ` (rule ${verdict.rule})` : ''}`
          )
          this.fallbackToHuman(approval)
        } else {
          this.send('session:approval-request', approval)
        }
        return
      }
      case 'session-allow':
        // ADR-084 §3: in auto mode an agent-control edit always sees the
        // gate/judge — a session allow on `edit *` must not skip it.
        if (!this.sessionAllowApplies(approval)) break
        logger.debug('OpencodeSession', `session allow ${category}`)
        this.autoReply(approval.requestId, 'once')
        return
      case 'allow-rule':
        // Plan mode only (ruling 7): a plan-safe command the user's allow
        // rules cover. The rule text is the user's own; no command text.
        logger.info(
          'OpencodeSession',
          `plan mode: allow rule covers a read-only ${category} (rule ${verdict.rule})`
        )
        this.autoReply(approval.requestId, 'once')
        return
      case 'parent-allow': {
        // ADR-085 S4 (ruling 4): the parent's rules allow this child call.
        // The subagent type when known; never the command, patterns or the
        // task prompt (ADR-084 logging rule).
        const type = approval.subagent ? this.subagentTask(approval.subagent)?.type : undefined
        logger.info(
          'OpencodeSession',
          `child ask ${category} allowed by the parent's rules${type ? ` (subagent ${type})` : ''}`
        )
        this.autoReply(approval.requestId, 'once')
        return
      }
      case 'continue':
        break
    }
    // Permission approval: auto mode (full) → LLM gatekeeper; else → human.
    // See ADR-023.
    if (autoMode) {
      void this.handleAutoModeApproval(approval)
    } else {
      this.send('session:approval-request', approval)
    }
  }

  /**
   * What the pre-check reads: the permission mode at ask time, the user's
   * deny/ask (and, read in plan mode only, allow) rules FRESH per call (as
   * the pipeline's read-only gate reads them — a settings edit mid-session binds the next
   * ask; best-effort, so a load failure leaves only plan-refuse/session-allow/
   * continue), G9's compiled user-origin rules, this chat's session-allow set,
   * and (for child asks, ADR-085 S4) the ruleset last patched onto this
   * opencode session.
   */
  private precheckContext(): HostPrecheckContext {
    const permissions = this.mergedUserPermissions()
    return {
      mode: this.permissionMode,
      rules: { deny: permissions.deny, ask: permissions.ask, allow: permissions.allow },
      // Plan mode's second read-only oracle (ADR-085 S3b, `isPlanReadOnlyCommand`).
      cwd: this.cwd,
      additionalDirectories: permissions.additionalDirectories,
      userRules: this.userOriginRules(),
      sessionAllows: this.sessionAllows,
      // ADR-085 S4 — what a CHILD ask is answered with: the ruleset on THIS
      // opencode session, never one patched onto a previous session id.
      parentRuleset:
        this.lastPatchedRuleset?.sessionId === this.openSessionId
          ? this.lastPatchedRuleset.rules
          : undefined,
      // …and only for the categories the spawn put a static ask on: the gated
      // built-ins plus the bridged MCP servers' keys (the spawn's
      // `collectClaudeMcpForOpencode` set — `GET /mcp`-only servers got no
      // injected ask, so their child asks stay the card/judge's).
      childGatedCategories: this.childGatedCategories(),
      onError: (err) =>
        logger.warn(
          'OpencodeSession',
          `host pre-check failed — asking the human: ${err instanceof Error ? err.message : String(err)}`
        )
    }
  }

  /**
   * ADR-085 S4 — the parent `task` call that spawned a child, read from its
   * tool part at the time it is needed (the mapper's marker carries only
   * `{sessionId, parentToolUseId}` — one resolution site, and the task part's
   * input is certainly there by then): the subagent type (`'unknown'` when the
   * part has none), plus the description and prompt when they are strings.
   * `undefined` when the part carries no input at all.
   */
  private subagentTask(marker: {
    parentToolUseId: string
  }): { type: string; description?: string; prompt?: string } | undefined {
    const input = findToolInput(this.accumulators, undefined, marker.parentToolUseId)
    if (!input) return undefined
    const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
    const description = str(input.description)
    const prompt = str(input.prompt)
    return {
      type: str(input.subagent_type) ?? 'unknown',
      ...(description !== undefined ? { description } : {}),
      ...(prompt !== undefined ? { prompt } : {})
    }
  }

  /** False for the one ask a session allow never answers: an auto-mode edit
   *  that touches (or may touch) an agent-control path (ADR-084 §3). */
  private sessionAllowApplies(approval: PendingApproval): boolean {
    return !(
      this.isAutoMode(this.permissionMode) &&
      approval.toolName === 'edit' &&
      !editClearsAgentControl(approval.patterns, approval.input, this.cwd)
    )
  }

  /**
   * Refuse an ask a user deny rule hits. The reject cascades server-side to
   * this opencode session's other pending asks (vendor permission/index.ts
   * `reply()`), which `approval-resolved` already turns into card dismissals.
   * Same wording as pi (PiSession `gateToolCallInner`) and Codex.
   *
   * No outcome is recorded for the judge's transcript annotations:
   * `rejected-by-user` is the HUMAN's signal and would lie here, and no other
   * outcome kind fits a rule denial (S5 may add one).
   */
  private denyByRule(approval: PendingApproval, rule: string): void {
    const reason = `Denied by permission rule: ${rule}`
    this.autoReply(approval.requestId, 'reject', reason)
    // No command text on an info line (ADR-084 logging rule, read-only-gate.ts).
    logger.info('OpencodeSession', `permission rule deny ${approval.toolName} — ${rule}`)
    if (approval.toolUseId) this.sendDenial(approval.toolUseId, 'rule', reason)
  }

  /**
   * A host denial on the call's card — a user rule (`source: 'rule'`) or plan
   * mode's refusal (`'mode'`), parity with ClaudeSession's
   * `session:permission-denial`. The reducer DROPS a block whose `tool_use` is
   * in no message yet, and a shell ask can precede its tool part (M-OC6), so
   * the producer holds: sent now when the part is already known, else once its
   * input arrives (≤ TOOL_INPUT_WAIT_MS) — consumeEvents settles that wait
   * right after mapEvent and BEFORE dispatchMapperOutput synchronously sends
   * the part's message, and this continuation runs after both. A timeout still
   * sends when the part turned up without input (its `tool_use` exists); no
   * part at all, or a closed session, drops it. The reject is never delayed.
   */
  private sendDenial(
    toolUseId: string,
    source: PermissionDenialBlock['source'],
    reason: string
  ): void {
    const clipped = reviewRationale(reason)
    const denial: PermissionDenialBlock = {
      type: 'permission_denial',
      toolUseId,
      denialId: uuid(),
      source,
      ...(clipped ? { reason: clipped } : {})
    }
    const send = (): void => this.send('session:permission-denial', { toolUseId, denial })
    if (this.hasToolPart(toolUseId)) {
      send()
      return
    }
    void this.waitForToolInput(toolUseId).then((outcome) => {
      if (outcome === 'input' || (outcome === 'timeout' && this.hasToolPart(toolUseId))) {
        send()
        return
      }
      logger.debug('OpencodeSession', `${source} denial not shown: no tool part (${outcome})`)
    })
  }

  /** A tool part with this callID is in the accumulators (so its `tool_use` is on the wire). */
  private hasToolPart(callId: string): boolean {
    for (const acc of this.accumulators.values()) {
      for (const snap of acc.parts.values()) {
        if (snap.type === 'tool' && snap.callID === callId) return true
      }
    }
    return false
  }

  /**
   * After a session allow was added: answer `once` every pending ask of THIS
   * chat (own and child) it now covers — the vendor's same-session `always`
   * cascade (`reply()`), limited to this ClaudeUI session, never another chat
   * in the folder. The full pre-check is re-run per ask, so a deny/ask rule
   * still wins; an ask a user ask rule holds (`sweepable: false`), a question,
   * and an auto-mode agent-control edit are never swept. The swept card is
   * retracted by `permission.replied` → `approval-resolved`.
   */
  private sweepSessionAllows(): void {
    if (this.sessionAllows.size === 0 || this.pendingApprovals.size === 0) return
    const ctx = this.precheckContext()
    for (const [requestId, rec] of [...this.pendingApprovals]) {
      if (!rec.sweepable || this.pendingQuestions.has(requestId)) continue
      if (hostPrecheck(rec.approval, ctx).kind !== 'session-allow') continue
      if (!this.sessionAllowApplies(rec.approval)) continue
      logger.debug('OpencodeSession', `session allow ${rec.approval.toolName} — pending ask swept`)
      this.autoReply(requestId, 'once')
    }
  }

  /**
   * The auto-mode decision for one ask: the edit fast path here, then the
   * shared judge pipeline (`automode/judge-pipeline.ts`, ADR-088) with
   * opencode's hooks. G9 (a USER-authored ask rule outranks the classifier)
   * runs before this, for every mode: the host pre-check in
   * routePermissionAsk (ADR-085 S2).
   */
  private async handleAutoModeApproval(approval: PendingApproval): Promise<void> {
    const category = approval.toolName
    // ADR-084 §3 — the auto-mode ruleset asks for EVERY edit so this gate sees
    // it: an edit whose targets (patterns, the edit/write path, apply_patch
    // move destinations) are all clear of agent-control paths is the
    // acceptEdits auto-allow, with no judge call and no denial-cap bookkeeping,
    // exactly as when opencode allowed it server-side. Anything else — a
    // control path, or targets that cannot all be told — goes to the judge.
    // Before the pipeline: its category fast path never covers `edit`, so the
    // order between the two is unobservable.
    if (
      category === 'edit' &&
      editClearsAgentControl(approval.patterns, approval.input, this.cwd)
    ) {
      this.autoReply(approval.requestId, 'once')
      return
    }
    // The approval the judge and the human card see: the ask itself, or — for
    // an ask that came without input (an MCP tool) — with the tool part's
    // input once `inputFor('judge')` has found it.
    let judgedApproval = approval
    let transport: JudgeTransport | null = null
    const outcome = await runJudgePipeline(
      { toolUseId: approval.toolUseId ?? '', toolName: category, input: approval.input },
      {
        logSource: 'OpencodeSession',
        cwd: this.cwd,
        currentMode: () => this.permissionMode,
        autoModeActive: () => this.isAutoMode(this.permissionMode),
        permissions: () => this.mergedUserPermissions(),
        honoursWorkdir: true,
        // ADR-084 §1 — the read-only gate reads the TOOL PART's input (it may
        // wait for it, see readOnlyInput). ADR-085 S3 — an ask with no input
        // yet (an MCP tool) gives the judge the tool part's real input; asked
        // only after the allow-rule skip, which needs none, so a skippable ask
        // is answered at once.
        inputFor: async (stage) => {
          if (stage === 'read-only') return this.readOnlyInput(approval)
          const judged = await this.inputForJudge(approval)
          if (!judged) return 'settled'
          judgedApproval = judged
          return judged.input
        },
        // ADR-085 §4 — a narrow user allow rule skips the judge (Claude Code
        // parity plus safety checks, allow-rule-skip.ts). Same bookkeeping as
        // the read-only path: no recordAllow(), no usage row, no tool outcome.
        // A child ask takes it too, with the PARENT's rules (ruling 4). The
        // engine ruleset stripped every allow rule in auto mode
        // (`withoutAllowRules`), so an allowed call still asks and the host
        // decides here, from `mergedUserPermissions()` (allow rules included,
        // read fresh). allowRuleAction reads the ask's own data (patterns, the
        // MCP key, the tool part's shell input the read-only stage already
        // waited for); the gate applies `mcpToolKey` to MCP actions only.
        allowRuleAction: () => this.allowRuleAction(approval)?.action,
        mcpToolKey: sanitizeMcpName,
        // ADR-085 S4 — a child's call is judged as the assistant's own,
        // against the parent's task that spawned it.
        subagent: approval.subagent
          ? (this.subagentTask(approval.subagent) ?? { type: 'unknown' })
          : undefined,
        // A stale configured judge model fails closed (one session:error);
        // no transport → the human decides.
        judgeAvailable: () => {
          transport = this.makeJudgeFn()
          return transport !== null
        },
        judgeTransport: () => transport!,
        messages: () => this.messageHistory,
        environment: () => this.classifierEnvironment(),
        captureActionMeta: (name, input) => this.captureActionMeta(name, input),
        outcomes: () =>
          this.toolOutcomes.size ? Object.fromEntries(this.toolOutcomes) : undefined,
        denials: this.autoDenials,
        twoStageMode: () => this.autoModeConfig().twoStageMode ?? 'both',
        // The allow-rule review waits for the tool part (sendAllowRuleReview);
        // every other review goes out at once (sendToolReview). Both are
        // no-ops without a toolUseId.
        sendReview: (_id, review) =>
          typeof review === 'object' && 'allowRule' in review
            ? this.sendAllowRuleReview(approval.toolUseId, review.allowRule)
            : this.sendToolReview(approval.toolUseId, review),
        // ADR-091 part 6 — the user approved an earlier block of this exact
        // call (own or a task child's): allowed once, no judge call.
        consumeGrant: (name, input) =>
          this.blockedCalls.consumeGrant(blockGrantKey('opencode', name, input, this.cwd, true)),
        // ADR-085 S2 — the ask may have been settled meanwhile: a session-allow
        // sweep answered it `once`, or a server-side cascade
        // (`approval-resolved`) dropped it. Replying now would 404 and paint a
        // verdict on a call that already ran. Each stage keeps its own line.
        stillPending: (stage) => {
          if (this.pendingApprovals.has(approval.requestId)) return true
          const line =
            stage === 'read-only'
              ? 'auto-mode read-only bypass: ask resolved while it ran — not replying'
              : stage === 'allow-rule'
                ? 'auto-mode allow-rule skip: ask already settled — not replying'
                : stage === 'judge'
                  ? 'auto-mode verdict for an ask already settled — not replying'
                  : null
          if (line) logger.debug('OpencodeSession', line)
          return false
        }
      }
    )
    switch (outcome.kind) {
      case 'allow':
        this.autoReply(approval.requestId, 'once')
        return
      case 'hold':
        this.holdBlock(judgedApproval, outcome.reason, outcome.review)
        return
      case 'human':
        this.fallbackToHuman(judgedApproval, outcome.reason)
        return
      case 'settled':
        return
    }
  }

  /**
   * The judge's verdict on the card it judged (F18).
   *
   * `approval.toolUseId` is `permission.asked`'s `tool.callID`, which is EXACTLY
   * the id `buildChatMessage` puts on the `tool_use` block (`snap.callID`), so
   * the reducer binds it to the right card. No hold is needed here the way Codex
   * needs one: the tool part carrying `state.input` is published
   * (`message.part.updated`, which emits the whole assistant message) BEFORE the
   * tool calls `ctx.ask` — the fact M-OC6 already relies on to read the real
   * input off the accumulator — and the judge call that produced this verdict
   * took a model round-trip on top of that.
   *
   * `'read-only'` is the static path's fixed review (ADR-084 §1). It has no
   * round-trip to wait on, but needs none: that path only runs once it has
   * found the tool part in the accumulator, so the card already exists.
   * `{ allowRule }` is the allow-rule skip's (ADR-085 §4), held until the
   * tool part exists (sendAllowRuleReview).
   */
  private sendToolReview(
    toolUseId: string | undefined,
    result: ClassifyResult | 'read-only' | { allowRule: string }
  ): ToolReviewBlock | undefined {
    if (!toolUseId) return undefined
    const reviewId = uuid()
    const review =
      result === 'read-only'
        ? readOnlyReviewBlock(toolUseId, reviewId)
        : 'allowRule' in result
          ? allowRuleReviewBlock(toolUseId, reviewId, result.allowRule)
          : autoModeReviewBlock(toolUseId, reviewId, result)
    this.send('session:tool-review', { toolUseId, review })
    return review
  }

  /**
   * Resolve a pending approval programmatically (the classifier's decision).
   * A reject `message` becomes model-visible feedback (CorrectedError) so the
   * turn survives the denial and the agent can see why it was blocked.
   */
  private autoReply(requestId: string, reply: 'once' | 'reject', message?: string): void {
    this.takePendingAsk(requestId)
    const replied = message
      ? this.client?.replyPermission(requestId, reply, message)
      : this.client?.replyPermission(requestId, reply)
    replied?.catch((err) => {
      logger.warn(
        'OpencodeSession',
        `replyPermission failed: ${err instanceof Error ? err.message : String(err)}`
      )
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
    this.send(
      'session:approval-request',
      decisionReason ? { ...approval, decisionReason } : approval
    )
  }

  /**
   * A judge block (ADR-091 §3), recorded first so the user can approve it
   * after the fact (ADR-091 part 6). The user's live hold window decides the
   * rest: zero — kept at once through {@link keepBlocked}, the path a Keep
   * blocked click and the expiry take; above zero — the human card, flagged as
   * an auto-mode block (Keep blocked / Approve anyway, no "always allow"
   * suggestions), under the review the pipeline already sent. Unanswered, it
   * resolves exactly as a Keep blocked click — through `resolveApproval` —
   * when the window passes; the reject's `permission.replied` then withdraws
   * the card, and the explicit dismiss covers a reply that never comes back
   * (a lost connection). `reason` is the judge's deny text.
   */
  private holdBlock(approval: PendingApproval, reason: string, review?: ToolReviewBlock): void {
    const rec = this.pendingApprovals.get(approval.requestId)
    // Settled between the verdict and here — nothing left to hold.
    if (!rec) return
    const { requestId } = approval
    const ms = blockHoldMs()
    // No `deliver`: a task child cannot take a delivery, so the nudge goes to
    // this session's queue, which flushes once the child's task call returns.
    if (review && approval.toolUseId) {
      const task = approval.subagent ? this.subagentTask(approval.subagent) : undefined
      const agentLabel = approval.subagent ? (task?.description ?? task?.type) : undefined
      this.blockedCalls.record(
        approval.toolUseId,
        {
          toolName: approval.toolName,
          input: approval.input,
          review,
          grantKey: blockGrantKey('opencode', approval.toolName, approval.input, this.cwd, true),
          ...(agentLabel ? { agentLabel } : {})
        },
        ms > 0
      )
    }
    if (ms === 0) {
      this.keepBlocked(requestId, approval.toolUseId, reason)
      return
    }
    const timer = armBlockHold(() => {
      this.resolveApproval(requestId, 'deny')
      this.send('session:approval-dismiss', { requestId })
    }, ms)
    rec.hold = { reason, cancel: timer.cancel }
    // A held block is never swept by a session allow: it is the human's call.
    rec.sweepable = false
    const { suggestions: _suggestions, ...card } = approval
    this.send('session:approval-request', {
      ...card,
      autoModeBlock: { expiresAt: timer.expiresAt },
      // The card states why it is held: the review strip sits on the tool
      // card, which a floating approval may not be next to.
      decisionReason: reason
    } satisfies PendingApproval)
  }

  /**
   * A judge block that stands — Keep blocked, its expiry, or no hold at all
   * (ADR-091 §3 / part 6): the model reads the judge's own text, and the call
   * is annotated as this monitor's block, not a human one.
   */
  private keepBlocked(requestId: string, toolUseId: string | undefined, reason: string): void {
    if (toolUseId) this.recordToolOutcome(toolUseId, 'automode-blocked')
    this.autoReply(requestId, 'reject', reason)
  }

  /**
   * Remove one pending ask, disarming a held block's expiry (ADR-091 §3). The
   * ONE way an entry leaves `pendingApprovals`, so no resolution path — a
   * reply, the server's cascade, the human — leaks a timer, and every one of
   * them leaves the block approvable after the fact (part 6).
   */
  private takePendingAsk(requestId: string): PendingAsk | undefined {
    const rec = this.pendingApprovals.get(requestId)
    if (!rec) return undefined
    this.pendingApprovals.delete(requestId)
    if (rec.hold) {
      rec.hold.cancel()
      if (rec.toolUseId) this.blockedCalls.settle(rec.toolUseId)
    }
    return rec
  }

  /**
   * Teardown / connection loss: no reply can reach the engine any more, so
   * every held block is disarmed and its card withdrawn (ADR-091 §3: no hold
   * outlives the connection that would answer it).
   */
  private dropBlockHolds(): void {
    for (const [requestId, rec] of [...this.pendingApprovals]) {
      if (!rec.hold) continue
      this.takePendingAsk(requestId)
      this.send('session:approval-dismiss', { requestId })
    }
  }

  /**
   * Ask a one-off question outside the main conversation history (the `/btw`
   * command). Uses a fresh throwaway opencode session so the question never
   * pollutes the main session's history. Returns the joined assistant text, or
   * null on any failure. Never throws.
   *
   * `client.prompt` runs a SYNCHRONOUS server-side turn (POST /session/{id}/message
   * blocks until the turn fully completes). Claude's `/btw` is tool-less; ours
   * must match — and critically, must be HANG-PROOF: if the model called a tool
   * that needed approval, opencode would emit `permission.asked` for THIS
   * throwaway session, which our main SSE consumer filters out (foreign
   * sessionID) and never answers → the synchronous prompt would hang forever
   * (spinner stuck). So we patch a deny-all ruleset on the throwaway session
   * BEFORE prompting (DENY_ALL_THROWAWAY_PATCH): upstream then hides every tool
   * from the request, and its permission evaluator short-circuits a matching
   * `deny` WITHOUT publishing `permission.asked` (permission/index.ts `ask()`
   * returns DeniedError before the Event.Asked path; `{permission:'*',
   * pattern:'*'}` matches every tool via Wildcard.match → regex `.*`). The model
   * therefore just answers in text — tool-less, hang-proof. The system prompt is
   * a belt-and-suspenders nudge. (We deliberately avoid the prompt body's
   * `tools` field, which opencode marks as deprecated.)
   */
  override async askSideQuestion(question: string): Promise<string | null> {
    try {
      await this.ensureConnected()
      if (!this.client || this._cancelled) return null

      const parsed = parseModelString(this._model)
      const js = await this.client.createSession({ title: 'side-question' })
      try {
        // Deny (and so hide) every tool — see DENY_ALL_THROWAWAY_PATCH.
        // Best-effort; the system prompt still discourages tools if the patch
        // were to fail.
        await this.client.patchSession(js.id, DENY_ALL_THROWAWAY_PATCH)
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
    // ADR-071 §3: which account this vendor's turns run under, read per TURN
    // (so a sign-in change between turns attributes each turn to the account
    // that actually ran it) but once per provider id, not once per message —
    // a turn's child accumulators are usually all on the same provider.
    const identities = new Map<string, AccountIdentity>()
    const identityFor = (providerID: string): AccountIdentity => {
      let identity = identities.get(providerID)
      if (!identity) {
        identity = opencodeAuthProvider.accountIdentity(providerID)
        identities.set(providerID, identity)
      }
      return identity
    }
    const ownIdentity = identityFor(parsed.providerID)

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
        //
        // ADR-071 §2: the figure is the DISPLAY cost, not opencode's own —
        // the breakdown has to add up to the headline. The message's inputs are
        // frozen here so a later model switch cannot silently re-price it.
        const inputs = opencodeCostInputs(
          parsed.providerID,
          parsed.modelID,
          tokens,
          acc.cost ?? null
        )
        this.settledCostInputs.set(messageId, inputs)
        const displayCostUsd = resolveOpencodeCosts(inputs).displayCostUsd
        if (displayCostUsd !== null) {
          this.liveModelCosts.set(
            parsed.modelID,
            (this.liveModelCosts.get(parsed.modelID) ?? 0) + displayCostUsd
          )
        }

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
          source: 'live',
          accountKey: ownIdentity.accountKey,
          accountLabel: ownIdentity.accountLabel,
          billingType: ownAccount?.billingType ?? 'unknown',
          origin: 'session',
          parentRoutingId: null,
          // opencode's `cost` is what it charged, not a list-price estimate.
          engineCostIsEquivalent: false
        })
      } else {
        // Child (subagent) message — attribute to the CHILD's own model + session.
        // If model info is absent, skip: never record a child under the parent model.
        if (!acc.model) {
          logger.debug(
            'OpencodeSession',
            `Child accumulator ${messageId} has no model info — skipping metering`
          )
          continue
        }
        const childAccount = opencodeAuthProvider.buildAccountRef(acc.model.providerID)
        const childIdentity = identityFor(acc.model.providerID)
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
          source: 'live',
          accountKey: childIdentity.accountKey,
          accountLabel: childIdentity.accountLabel,
          billingType: childAccount?.billingType ?? 'unknown',
          // A subagent's spend is its own row, attributed back to the session
          // that spawned it (ADR-071 §1).
          origin: 'child',
          parentRoutingId: this.routingId,
          engineCostIsEquivalent: false
        })
      }
    }
  }

  /**
   * Sum the cumulative tokens from all own (non-child) assistant accumulators.
   * Returns { input, output, cacheWrite, cacheRead }.
   *
   * THIS PROCESS only — buildStatusLine adds the history base on top (see
   * tokenBase), sendMetering deliberately does not.
   */
  private sumSessionTokens(): {
    input: number
    output: number
    cacheWrite: number
    cacheRead: number
  } {
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
    const live = this.sumSessionTokens()
    // History + live, the same split cost uses: a resumed session's tokens are
    // not this process's alone, and the figure must not drop back to one
    // turn's worth the moment a reopened session is prompted.
    const sum = {
      input: this.tokenBase.input + live.input,
      output: this.tokenBase.output + live.output,
      cacheWrite: this.tokenBase.cacheWrite + live.cacheWrite,
      cacheRead: this.tokenBase.cacheRead + live.cacheRead
    }
    const ctx = getOpencodeModelContextWindow(parsed.providerID, parsed.modelID)
    const usedPercentage =
      ctx > 0 && this.lastContextLength > 0
        ? Math.round((this.lastContextLength / ctx) * 100)
        : null
    const remainingPercentage = usedPercentage !== null ? 100 - usedPercentage : null
    const cachedTokens = sum.cacheRead + sum.cacheWrite
    const totalTokens = sum.input + sum.output + cachedTokens
    const costs = this.costTally()
    return {
      totalCostUsd: costs.displayCostUsd,
      billedCostUsd: costs.billedCostUsd,
      ...(costs.unknownMessages > 0 ? { unknownCostMessages: costs.unknownMessages } : {}),
      totalDurationMs: this.accTotalDurationMs,
      totalApiDurationMs: 0,
      totalInputTokens: sum.input,
      totalOutputTokens: sum.output,
      cachedTokens,
      totalTokens,
      contextWindow: { used: this.lastContextLength, size: ctx },
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
        tokens: {
          input,
          output,
          cacheWrite,
          cacheRead,
          total: input + output + cacheWrite + cacheRead
        },
        equivalentCostUsd: equiv,
        // What opencode itself reported, NOT the headline — the headline is the
        // cost rule's answer now (ADR-071 §2) and this field's one job is to
        // carry the engine's raw claim beside the equivalent.
        engineReportedCostUsd: this.engineReportedCostUsd,
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
