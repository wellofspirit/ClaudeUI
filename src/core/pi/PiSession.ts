import type { HostWindowHandle } from '../host'
import { existsSync } from 'node:fs'
import { join, delimiter } from 'node:path'
import { homedir } from 'node:os'
import { v4 as uuid } from 'uuid'
import { BaseSession } from '../providers/BaseSession'
import type { EngineSpawnOptions } from '../providers/ISession'
import type { ResolvedCapabilities } from '../../shared/model-capabilities'
import { resolvePiCapabilities } from '../../shared/model-capabilities'
import type {
  AttachmentUpload,
  AutoModeConfig,
  SharedAutoModeConfig,
  ChatMessage,
  ContentBlock,
  ImageMediaType,
  SessionStatus,
  ApprovalDecision,
  PermissionSuggestion,
  PendingApproval,
  StatusLineData
} from '../../shared/types'
import { engineMeta } from '../../shared/engine-meta'
import { PI_DEFAULT_MODEL } from '../../shared/engine-meta'
import { totalCosts, type TotalCosts } from '../../shared/cost-rule'
import { piCostInputs, resolvePiCosts, type PiCostInputs } from './message-cost'
import { logger } from '../services/logger'
import { internAttachments } from '../services/blob-store'
import { authErrorTranscriptMessage } from '../services/api-error'
import { piAuthProvider } from '../auth/PiAuthProvider'
import { harnessUnavailableMessage } from '../harness/resolve'
import { locatePiLaunch } from './pi-locate'
import { PiRpcClient } from './PiRpcClient'
import { mapPiEvent, createPiMapperState, finishPiMessage } from './event-mapper'
import type { PiMapperOutput, PiMapperState } from './event-mapper'
import type {
  PiCloneData,
  PiForkData,
  PiGetCommandsData,
  PiGetLastAssistantTextData,
  PiGetSessionStatsData,
  PiGetStateData,
  PiRpcCommand
} from './pi-protocol'
import { getPiModelCatalog, discoverPiModels, effortLevelsFromModel } from './model-discovery'
import {
  findPiSessionFile,
  loadPiAgentLinks,
  loadPiSessionHistory
} from '../services/pi-session-list'
import { PI_FORK_CLONE_LATEST_SENTINEL } from '../services/fork-anchor'
import { recordUsageEvent } from '../services/usage-recorder'
import { PiBridgeHost, writeBridgeExtension } from './PiBridgeHost'
import { HostedGrants, notApprovedHostedTool } from './hosted-grants'
import { piUsageEvent } from './usage-row'
// Host-run subagents (ADR-088): the manager owns the children; this session
// owns their gating (decideToolCall, parametrized by the child scope).
import { loadPiAgentRegistry, type PiAgentRegistry } from './pi-agent-registry'
import type { SpawnPiChildFn } from './pi-child-runner'
import { deliveryCommand, isReservedPiCommandText, type PiAgentDelivery } from './pi-delivery'
import { narrowMode, PiSubagentManager, type PiChildScope } from './pi-subagents'
import type {
  GateDecision,
  PiBridgeAbandoned,
  PiHostedToolHandler,
  PiHostedToolPayload,
  PiHostedToolResult,
  PiToolCallPayload
} from './PiBridgeHost'
// Hosted tools (M4a) — the SAME in-process MCP tool factories Claude/opencode
// use (mermaid-tool.ts/mockup-tool.ts); handleHostedTool below extracts
// `.tools[].handler` and calls it directly, exactly like
// opencode-hosted-tools.ts's identical reuse pattern.
import { createMermaidServer } from '../services/mermaid-tool'
import { createMockupServer } from '../services/mockup-tool'
// Cross-engine dispatch (M4b, ADR-033) — pi as a dispatch SOURCE here; pi as
// a TARGET is handled separately (M4c, shipped — see cross-engine-dispatcher.ts's
// gatePiTargetToolCall). CALLED, never modified — mirrors collab-tool.ts's
// Claude-side DispatchContext construction, NOT via MCP (pi has no MCP
// client of its own).
import {
  crossEngineDispatcher,
  crossEngineDispatchAvailable
} from '../services/cross-engine-dispatcher'
import { canDispatchInto } from '../services/dispatch-targets'
import type { DispatchContext, DispatchRequest } from '../services/cross-engine-dispatcher'
import {
  decideWithSource,
  piToolKind,
  mergedClaudeRulesFor,
  withoutAllowRules,
  sessionAllowKey,
  normalizeWhitespace,
  PI_TOOL_TO_CLAUDE_TOOL,
  PI_HOSTED_TOOL_NAMES,
  PLAN_MODE_DENY_REASON,
  PLAN_EXIT_OUTSIDE_PLAN_REASON
} from './permission-engine'
import type { MergedClaudeRules, PermissionVerdict } from './permission-engine'
// Auto mode (`auto`/`full` autonomy) — the engine-neutral classifier core plus
// ClaudeUI's own judge transport (docs/automode-rework-plan.md phase 4, ADR-081).
import type { ClassifyResult, EnvironmentInfo, JudgeTransport } from '../automode/classifier'
import {
  allowRuleReviewBlock,
  AutoModeDenialTracker,
  autoModeReviewBlock,
  readOnlyReviewBlock
} from '../automode/denial-tracker'
import { effectiveShellCwd } from '../automode/read-only-gate'
import type { AllowSkipAction } from '../automode/allow-rule-skip'
import { runJudgePipeline } from '../automode/judge-pipeline'
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
import { judgeRouteUnavailableMessage, makeSessionJudgeTransport } from '../automode/session-judge'
import { buildClassifierEnvironment } from '../automode/environment'
import { loadEngineConfig, loadSharedAutoModeConfig } from '../services/ui-config'
import { persistAllowSuggestions } from '../opencode/permission-compiler'
import { piAuthRequiredProviderId } from '../shared-providers/chatgpt-route'
// Reused AS-IS (not copied/forked — ADR-026 additive-only on shared seams):
// pure key/value dedup+throttle gate, no opencode-specific assumption baked
// in (verified — takes a caller-supplied emit callback and ambient
// setTimeout/clearTimeout only).
import { BashStreamGate } from '../opencode/bash-stream-gate'

/** Fail-closed default for an unrecognized /hosted-tool toolName (defense in depth — the bridge extension only ever sends the five names it registers, but handleHostedTool must never crash on an unexpected one). */
function unknownHostedTool(toolName: string): PiHostedToolResult {
  return { content: [{ type: 'text', text: `Unknown hosted tool "${toolName}"` }], isError: true }
}

// ---------------------------------------------------------------------------
// Auto mode — what one classification round can conclude.
// ---------------------------------------------------------------------------

/**
 * What ADR-085 §4's allow-rule skip checks for one pi tool call, or
 * `undefined` (no skip — the judge decides): `bash` → its command (pi's bash
 * has no `workdir`: an input carrying one — or a `cwd` — says the call runs
 * somewhere this check cannot tell, as the read-only gate refuses it); an
 * `mcp__<server>__<tool>` name → that server and tool (split at the FIRST `__`
 * after the prefix; pi compares rule tool names as written). Every other pi
 * tool (edit/write/read/find/ls/grep, the hosted tools, exit_plan, unknown):
 * no skip.
 */
function allowRuleActionFor(
  toolName: string,
  input: Record<string, unknown>
): AllowSkipAction | undefined {
  if (toolName === 'bash') {
    const has = (v: unknown): boolean => v !== undefined && v !== null && v !== ''
    if (has(input.workdir) || has(input.cwd)) return undefined
    return { kind: 'shell', command: typeof input.command === 'string' ? input.command : '' }
  }
  if (!toolName.startsWith('mcp__')) return undefined
  const rest = toolName.slice('mcp__'.length)
  const sep = rest.indexOf('__')
  const server = sep < 0 ? rest : rest.slice(0, sep)
  if (!server) return undefined
  const tool = sep < 0 ? '' : rest.slice(sep + 2)
  return { kind: 'mcp', server, ...(tool ? { tool } : {}) }
}

/**
 * `classifyAutoMode`'s result: either a decision to hand pi, or "ask the human"
 * with an optional one-line reason for the approval card. A plain `null` used
 * to mean the latter, which left nowhere to carry the reason — and an untyped
 * null is easy to conflate with "no verdict yet".
 */
type AutoModeOutcome =
  { kind: 'decided'; decision: GateDecision } | { kind: 'human'; reason?: string }

/** The reasonless handoff — no cap fired, the card just asks as usual. */
const ASK_HUMAN: AutoModeOutcome = { kind: 'human' }

const decided = (decision: GateDecision): AutoModeOutcome => ({ kind: 'decided', decision })

// ---------------------------------------------------------------------------
// Side question (/btw) — see PiSession.askSideQuestion's doc comment for the
// full design. Free functions (no `this`) so they're trivially unit-testable
// and reusable from the constant below without dragging class state in.
// ---------------------------------------------------------------------------

/** At most this many of the most-recent user/assistant messages feed the ephemeral's context. */
const SIDE_QUESTION_MAX_MESSAGES = 20
/** Hard cap on the assembled context string, chars — keeps the ephemeral's prompt (and its cost) bounded regardless of session length. */
const SIDE_QUESTION_MAX_CONTEXT_CHARS = 8_000
/** Overall bound on the whole ephemeral spawn+ask+dispose round trip (model call + process spawn overhead). */
const SIDE_QUESTION_TIMEOUT_MS = 60_000

/**
 * Render one retained ChatMessage as a single `user:`/`assistant:` context
 * line. Only `text` blocks and a compact tool-activity marker survive —
 * `thinking`/`image`/`document`/`cli_command`/`api_error`/`compact_separator`
 * are dropped: thinking is pi's own internal reasoning (out of scope for a
 * side question about WHAT is happening, not WHY the model privately
 * reasoned it), image/document blocks would otherwise put opaque blob refs
 * (ADR-087) into a text prompt, and the rest are ClaudeUI meta-transcript entries with no
 * conversational content. A message that reduces to nothing (e.g. a
 * tool-only turn whose blocks were all dropped) still gets a placeholder so
 * the line count/ordering stays intact.
 */
function formatSideQuestionContextLine(msg: ChatMessage): string {
  const parts: string[] = []
  for (const block of msg.content) {
    if (block.type === 'text') {
      parts.push(block.text)
    } else if (block.type === 'tool_use') {
      parts.push(`[called tool: ${block.toolName}]`)
    } else if (block.type === 'tool_result') {
      parts.push(block.isError ? '[tool result: error]' : '[tool result]')
    }
  }
  const text = parts.join(' ').trim()
  return `${msg.role}: ${text || '(no text)'}`
}

/**
 * The framing message sent as the ephemeral's ONLY prompt — instructs it to
 * observe rather than act, embeds the bounded transcript context, then the
 * user's actual question. Exact wording per the kickoff spec.
 */
function buildSideQuestionPrompt(context: string, question: string): string {
  return (
    'You are observing an ongoing coding session (you are NOT the agent running it and must NOT continue its task). ' +
    `Conversation so far:\n\n${context}\n\n---\n` +
    "The user has a side question about what's happening. Answer it directly and concisely; do not take any action or continue the task.\n\n" +
    `Side question: ${question}`
  )
}

/**
 * PiSession — engine-neutral session backend for the pi coding agent.
 *
 * Unlike opencode (one shared HTTP server per cwd), pi has no server mode: this
 * is the CLAUDE-shaped lifecycle — one `pi --mode rpc` child process per
 * ClaudeUI session, spawned lazily on first `run()`, killed on cancel/dispose
 * (see docs/protocol-pi/README.md "Transport"). Mirrors OpencodeSession's
 * overall structure (capabilities split, cost accumulation, status-line
 * building) with the RPC-child-process specifics swapped in for the HTTP/SSE
 * ones.
 *
 * M1 scope: full-auto chat (stream, tool cards, usage/cost, abort, cancel,
 * resume+replay). M2a ADDS the enforcement path: every spawn also starts a
 * PiBridgeHost (loopback HTTP, per-session bearer token) and writes the
 * ClaudeUI-owned bridge extension (pi-bridge-source.ts) to a temp file passed
 * via `-e`; the extension's `pi.on('tool_call', …)` hook calls back into
 * `gateToolCall`, which runs the pure PiPermissionEngine (permission-engine.ts)
 * against the live autonomy mode + the user's merged Claude permission rules
 * and either answers immediately (allow/deny) or surfaces a
 * `session:approval-request` and awaits the human via `resolveApproval`. M2b
 * ADDS interaction parity: mid-turn `steer` (not just queued follow-up),
 * spawn-time + live effort (`set_thinking_level`), slash-command/skill
 * discovery (`get_commands`), and live bash output streaming
 * (`tool_execution_update` → BashStreamGate, imported as-is from opencode).
 * M4a ADDS the hosted LLM tools (render_mermaid/create_mockup/show_mockup),
 * registered via `pi.registerTool()` in the SAME bridge extension, calling
 * back over a second PiBridgeHost route (`POST /hosted-tool`,
 * handleHostedTool) — auto-allowed by permission-engine.ts's
 * PI_AUTO_ALLOW_HOSTED_TOOLS. M4b ADDS pi as a cross-engine dispatch SOURCE
 * (`dispatch_agent`, the same mechanism, NORMAL mode-base gating) — see
 * PI_ENGINE_CAPABILITIES' doc comment for the full per-flag flip plan. M5c
 * ADDS fork ("branch off"): `resumeSessionAt`/`forkSession` (previously
 * ignored, Claude-only per EngineSpawnOptions' docs) now drive doStart()'s
 * clone/fork block — see that block's doc comment for the full choreography.
 */
export class PiSession extends BaseSession {
  readonly engineId = 'pi' as const

  private _capabilities: ResolvedCapabilities
  /**
   * ADR-030/ADR-033 M4-A: the STATIC PI_ENGINE_CAPABILITIES.crossEngineDispatch
   * flag is true (M4b shipped), but the HONEST per-session value additionally
   * requires crossEngineDispatchAvailable('pi') — some target (Claude Code,
   * opencode or Codex) being available, which ADR-082 made a live question.
   * ANDed at this GETTER (not baked into every `_capabilities` assignment
   * site — the constructor's sync+async assignments, resolveCapsForModel,
   * adoptEngineModel, setModel — since unlike OpencodeSession's single
   * resolveCapsForModel() choke point, PiSession has several; one computed
   * getter is the DRY single point of truth, mirroring ClaudeSession's
   * identical live-getter pattern instead of opencode's "bake into every
   * producer" pattern).
   */
  get capabilities(): ResolvedCapabilities {
    return {
      ...this._capabilities,
      crossEngineDispatch:
        this._capabilities.crossEngineDispatch && crossEngineDispatchAvailable('pi')
    }
  }

  private client: PiRpcClient | null = null
  /** pi's own session id (from `get_state`), once known. */
  private piSessionId: string | null = null
  private isProcessing = false
  /** Set true by cancel()/dispose(); guards a racing onEvent/onExit from acting on a torn-down session. */
  private _cancelled = false
  /** True after an unexpected process exit (crash) that wasn't our own cancel(). Cleared on the next successful spawn. */
  private disconnected = false
  /** Memoized spawn+init promise — see ensureStarted(). Cleared on cancel()/dispose() and on an unexpected exit so a later run() can respawn. */
  private startedPromise: Promise<void> | null = null
  /** Guards replayStoredHistory so a single PiSession object only ever replays once. */
  private replayedHistory = false

  private _model: string
  /** The model an explicit request actually carried (EngineSpawnOptions.model,
   *  or a pre-spawn setModel() — undefined when neither happened) — distinct
   *  from `_model`, which always has a value (defaulted). Only a present
   *  `requestedModel` triggers a `set_model` RPC call at spawn; see doStart()'s
   *  doc comment for why. */
  private requestedModel: string | undefined
  /** The effort an explicit request actually carried (EngineSpawnOptions.effort,
   *  or a pre-spawn setEffort() — undefined when neither happened). Mirrors
   *  `requestedModel`'s exact pattern: only a present value triggers a
   *  `set_thinking_level` RPC call, applied in doStart() (spawn-time) or
   *  immediately (live setEffort() with a running client). */
  private requestedEffort: string | undefined
  private permissionMode: string
  private resumeSessionId: string | undefined
  /**
   * Fork ("branch off", M5c): when set (only meaningful alongside
   * `resumeSessionId`, the SOURCE), the FIRST doStart() clones/forks the
   * resumed source into a brand-new pi session file BEFORE any
   * set_model/set_thinking_level application — see doStart()'s fork block
   * doc comment for the full choreography + the source-safety reasoning.
   * `resumeSessionAt` is either a real pi entryId (drop that user entry and
   * everything after via `fork`) or `PI_FORK_CLONE_LATEST_SENTINEL` (nothing
   * to drop — `clone` alone). Mirrors ClaudeSession's identical
   * resumeSessionAt/forkSession fields (ADR-010).
   */
  private resumeSessionAt: string | undefined
  private forkSession: boolean

  // ── Live bash output streaming (M2b) ─────────────────────────────────────────
  /** Reused AS-IS from opencode (src/main/opencode/bash-stream-gate.ts) — pure
   *  dedup + trailing-edge throttle, no opencode-specific assumption. Dedups
   *  unchanged cumulative `tool_execution_update` snapshots and throttles
   *  emissions to ~100ms per toolUseId. Cancelled per-toolUseId on the
   *  matching tool_result, and entirely on cancel()/dispose()/an unexpected exit. */
  private bashStreamGate = new BashStreamGate((toolUseId, output) => {
    this.send('session:bash-output', {
      toolUseId,
      output,
      totalLines: output.split('\n').length,
      totalBytes: Buffer.byteLength(output, 'utf-8')
    })
  })

  // ── Approval bridge (M2a) ────────────────────────────────────────────────────
  /** Per-session loopback HTTP host the bridge extension calls into. Started in doStart(); disposed in cancel()/dispose() and on an unexpected exit. */
  private bridgeHost: PiBridgeHost | null = null
  /** One entry per in-flight 'ask' gate, keyed by a freshly minted requestId (NOT toolCallId — mirrors PendingApproval.requestId's own identity). Resolved by resolveApproval() or force-denied by interrupt()/cancel()/an unexpected exit. `toolCallId` rides along so a human REJECT can be recorded as the classifier's `rejected-by-user` ground truth. */
  private pendingGates = new Map<
    string,
    {
      resolve: (decision: GateDecision) => void
      toolName: string
      input: Record<string, unknown>
      toolCallId: string
      /** Where a human REJECT is recorded: the session's own map, or a child's (ADR-088). */
      outcomes: Map<string, ToolOutcome>
      /** The host-run child the card belongs to (ADR-088), or null for the session's own call. */
      scope: PiChildScope | null
    }
  >()
  /** "Allow for this session" entries — bare pi tool name, or `bash:<normalized command>` for bash (see permission-engine.ts's sessionAllowKey). */
  private sessionAllows = new Set<string>()
  /** Lazily loaded, cached merge of the user/project/local Claude permission scopes. Invalidated by notifySettingsChanged() and by persistAllowRules() (so a just-persisted rule is honored on the very next gate call in this same session). */
  private cachedRules: MergedClaudeRules | null = null

  // ── Auto mode (`auto`/`full`) LLM gatekeeper — phase 4 ───────────────────────
  /** Memoized `engines/pi.json#autoMode` (see autoModeConfig()). */
  private _autoModeConfig: AutoModeConfig | undefined
  /** Memoized `~/.claude/ui/automode.json` — the engine-SHARED trust lists
   *  (ADR-065 phase 4). Same lifetime as `_autoModeConfig`: one read per
   *  session, and a mid-session edit is not hot-reloaded. */
  private _sharedAutoMode: SharedAutoModeConfig | undefined
  /** Denial caps — 3 consecutive / 2 same-rule / 20 total blocks hand control
   *  back to the human. Shared with opencode (automode/denial-tracker.ts). */
  private autoDenials = new AutoModeDenialTracker()
  // One `session:error` per session for a CONFIGURED judge model that is gone —
  // the check runs on every gated approval (see judgeModelUnavailable).
  private staleJudgeModelReported = false
  // The same one-banner rule for a judge model ClaudeUI has no route to call
  // (ADR-081 §3) — the resolver runs on every judge call.
  private judgeRouteUnavailableReported = false
  /** How prior tool calls ended, keyed by toolCallId — the classifier's
   *  `{"outcome":…}` annotations. The ONLY channel by which a refusal reaches
   *  the judge, since the transcript slimmer drops tool RESULTS. Bounded by
   *  recordToolOutcome (MAX_TOOL_OUTCOMES). */
  private toolOutcomes = new Map<string, ToolOutcome>()
  /** SESSION-START git remotes — resolved once, lazily, then frozen. Never
   *  refreshed: a remote added mid-session is exactly what the exfiltration
   *  rules exist to catch (ref §9.1). */
  private sessionRemotes: GitRemote[] | null = null
  private sessionRemotesPromise: Promise<GitRemote[]> | null = null
  /** Repo visibility — also resolved at most once per session (a `gh` round trip). */
  private sessionRepoVisibility: RepoVisibility | null = null
  private sessionRepoVisibilityPromise: Promise<RepoVisibility> | null = null

  // ── Hosted tools (M4a) ───────────────────────────────────────────────────────
  /** Memoized once per session (constructing it is cheap, but there's no reason to redo it on every render_mermaid call — mockup is NOT memoized, see handleHostedTool's mockup case for why). */
  private mermaidServer: ReturnType<typeof createMermaidServer> | null = null
  /**
   * SECURITY (A1): one-shot `/hosted-tool` execution grants, `toolCallId ->
   * toolName`, minted by gateToolCall's wrapper (below) the instant `/tool-
   * call` decides 'allow' for a name in PI_HOSTED_TOOL_NAMES, and consumed
   * by handleHostedTool on first use. Without this, the bearer token alone
   * gated `/hosted-tool` — and that token sits in the pi child's env,
   * reachable from any ALREADY-APPROVED bash command (`curl
   * $CLAUDEUI_PI_BRIDGE_URL/hosted-tool -d '{"toolName":"dispatch_agent",...}'`),
   * bypassing dispatch_agent's own deliberate 'ask' gating entirely. Cleared
   * wholesale by rejectAllPendingGates (interrupt/cancel/unexpected exit) —
   * a grant minted for a turn that no longer exists must not survive it.
   *
   * SECURITY (abandonment race): `handleBridgeAbandoned` marks a `toolCallId`
   * whose `/tool-call` exchange PiBridgeHost abandoned while the gate decision
   * was still being computed, and the wrapper then WITHHOLDS the grant a late
   * `allow` would otherwise mint. Needed because the two events are not
   * ordered: `handleBridgeAbandoned` can only force-deny a `pendingGates`
   * entry, and an auto-mode-judged call has none — the judge runs for tens of
   * seconds inside `gateToolCallInner` with nothing registered anywhere, then
   * resolves 'allow' into `gateToolCall`'s wrapper long after the host stopped
   * waiting.
   *
   * The mint/consume/withhold rules and their 256-entry bounds live in
   * {@link HostedGrants}, shared with every host-run subagent's own bridge
   * (ADR-088).
   */
  private hostedGrants = new HostedGrants()

  /**
   * In-flight `dispatch_agent` tool-call ids (M4b; audit-residual B fix) —
   * added at the START of handleDispatchAgent, BEFORE the
   * `await crossEngineDispatcher.dispatch(...)` call, removed in a `finally`
   * once that call settles (success or error). interrupt() walks this set and
   * calls `crossEngineDispatcher.stopDispatch(id, this.routingId)` for each —
   * mirrors TaskCard's own Stop-button call — so pi's Esc-to-abort now
   * propagates into an in-flight dispatched child instead of leaving it
   * running/spending after the SOURCE turn was aborted (previously a
   * documented v1 limitation — see handleDispatchAgent's doc comment). A
   * plain `Set` (not bounded like hostedGrants above) —
   * entries live for, at most, the duration of one in-flight dispatch call,
   * never accumulate across a long-running session.
   */
  private inFlightDispatchIds = new Set<string>()

  // ── Host-run subagents (ADR-088) ─────────────────────────────────────────
  /** The user prompt request still waiting for pi's ack (Fact S8, see deliverAgentMessage). */
  private promptInFlight: Promise<unknown> | null = null
  /** FIFO chain of agent deliveries into this session (ADR-088 S3). */
  private deliveryChain: Promise<void> = Promise.resolve()
  /** Count of runs pi reported starting (`agent_start`) — run()'s refusal branch reads it (M-1). */
  private runStarts = 0
  /** A woken delivery marked the session running and its run has not started yet (M-2). */
  private wakePending = false
  /** Owns this session's `agent` children (pi-subagents.ts); gating stays here. */
  private readonly subagents: PiSubagentManager
  /** `loadPiAgentRegistry` (a test seam injects a fixed registry). */
  private readonly loadAgentRegistry: (cwd: string) => PiAgentRegistry

  // ── Cost / usage accounting ────────────────────────────────────────────────
  private mapperState: PiMapperState = createPiMapperState()
  /**
   * Cost from stored history, seeded ONCE on resume from `get_session_stats()`.
   *
   * ADR-071 §2: pi's own figure is a LIST-price computation whatever the
   * credential, so under a subscription it is what the usage was worth, not
   * what was billed. Both halves below hold cost INPUTS (piCostInputs); the
   * billing type is applied when a figure is read, because the auth probe
   * resolves asynchronously and a session that captured its history first must
   * not be stuck with what `unknown` made of it.
   *
   * pi reports history as one aggregate, so the base is at most one entry —
   * which also means an unpriced history counts as ONE unknown message rather
   * than however many it really held. The live half is exact.
   */
  private costBase: PiCostInputs[] = []
  /** One entry per assistant message metered in THIS process. */
  private liveCostInputs: PiCostInputs[] = []
  private sumInputTokens = 0
  private sumOutputTokens = 0
  private sumCacheReadTokens = 0
  private sumCacheWriteTokens = 0
  /** Latest assistant turn's prompt size (input + cacheRead), for "context used %". */
  private lastContextLength = 0
  /** Accumulated ACTIVE (turn-processing) duration of completed turns, ms. Not seeded on
   *  resume in M1 (only cost is — see the kickoff spec's resume bullet); starts at 0. */
  private accTotalDurationMs = 0

  constructor(
    routingId: string,
    win: HostWindowHandle | null,
    cwd: string,
    opts: EngineSpawnOptions = {},
    /** Test seams for the host-run subagents (ADR-088); production passes none. */
    deps: {
      spawnPiChild?: SpawnPiChildFn
      subagentsRoot?: string
      loadAgentRegistry?: (cwd: string) => PiAgentRegistry
    } = {}
  ) {
    super(routingId, win, cwd)
    this.loadAgentRegistry = deps.loadAgentRegistry ?? ((dir) => loadPiAgentRegistry({ cwd: dir }))
    // The host reads this session LIVE (routingId changes on a rekey).
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const session = this
    this.subagents = new PiSubagentManager(
      {
        get routingId() {
          return session.routingId
        },
        get cwd() {
          return session.cwd
        },
        currentModel: () => session._model,
        skillDirsEnv: () => session.computeSkillDirsEnv(),
        send: (channel, data) => session.send(channel, data),
        gateChild: (scope, payload) => session.gateChild(scope, payload),
        childAbandoned: (info) => {
          session.retractPendingGate(info.toolCallId)
        },
        retractChildGates: (scope) => session.retractChildGates(scope),
        deliverToSession: (payload) => session.deliverAgentMessage(payload),
        backgroundWorkChanged: () => {
          // Re-arm (or hold) the idle timer: it waits for background agents.
          if (!session.isProcessing) session.resetInactivityTimer()
        }
      },
      {
        ...(deps.spawnPiChild ? { spawn: deps.spawnPiChild } : {}),
        ...(deps.subagentsRoot ? { sessionsRoot: deps.subagentsRoot } : {})
      }
    )
    // sandboxConfig/thinkingMode are intentionally unread — Claude-only
    // options per EngineSpawnOptions' docs / ADR-030. `effort` IS consumed
    // (M2b) — see doStart()'s spawn-time effort application. resumeSessionAt/
    // forkSession are consumed (M5c) — see doStart()'s fork block.
    this.requestedModel = opts.model
    this.requestedEffort = opts.effort
    this._model = opts.model ?? PI_DEFAULT_MODEL
    this.permissionMode = opts.permissionMode ?? 'default'
    this.resumeSessionId = opts.resumeSessionId || undefined
    this.resumeSessionAt = opts.resumeSessionAt || undefined
    // Mirrors ClaudeSession's identical guard — forkSession is meaningless
    // without a resumeSessionAt anchor (and without a source to fork FROM).
    this.forkSession = !!opts.forkSession && !!this.resumeSessionAt && !!this.resumeSessionId
    this._capabilities = resolvePiCapabilities()
    this.seedDispatchedCosts()
    this.sendStatus()
    this.sendStatusLine()
    // Refine capabilities asynchronously once the model catalog resolves
    // (mirrors OpencodeSession's constructor-time discovery warm + recompute).
    this.resolveCapsForModel(this._model)
      .then((caps) => {
        this._capabilities = caps
        this.sendStatus()
        this.sendStatusLine()
      })
      .catch(() => {})
    // Warm the auth probe so status.account resolves shortly after construction
    // (mirrors OpencodeSession's opencodeAuthProvider.warmCache().then(sendStatus)
    // constructor call) — account stays null on the very first sendStatus() above
    // until this resolves. The status line goes out again too: its billed figure
    // depends on the vendor's billing type (ADR-071 §2), which is `unknown`
    // until the probe lands, and a reopened session may run no further turn.
    piAuthProvider
      .probe()
      .then(() => {
        this.sendStatus()
        this.sendStatusLine()
      })
      .catch(() => {})
  }

  get willQueue(): boolean {
    return this.isProcessing
  }

  /** History base + this process's messages, by the cost rule (ADR-071 §2). */
  private costTally(): TotalCosts {
    return totalCosts([...this.costBase, ...this.liveCostInputs].map(resolvePiCosts))
  }

  /** The headline figure: the known total, null when nothing could be priced. */
  private get totalCostUsd(): number | null {
    return this.costTally().displayCostUsd
  }

  get status(): SessionStatus {
    const model = engineMeta('pi').decodeModelValue(this._model)
    return {
      state: this.disconnected ? 'disconnected' : this.isProcessing ? 'running' : 'idle',
      sessionId: this.piSessionId,
      model,
      cwd: this.cwd,
      totalCostUsd: this.totalCostUsd,
      // From the LAST piAuthProvider.probe() snapshot (constructor warms it —
      // see below); null until that resolves or if the vendor has no auth.json
      // entry (mirrors OpencodeSession's identical buildAccountRef usage).
      account: piAuthProvider.buildPiAccountRef(model.vendorId),
      ...this.baseStatusFields()
    }
  }

  getSessionId(): string | null {
    return this.piSessionId
  }

  /** Public accessor for cross-engine dispatch (ADR-033) — used by
   *  handleDispatchAgent (M4b) to build DispatchContext.getAutonomyMode, mirroring
   *  OpencodeSession's identical accessor's call site (createOpencodeHostedToolsServer). */
  getAutonomyMode(): string {
    return this.permissionMode
  }

  protected override resetInactivityTimer(): void {
    this.clearInactivityTimer()
    // A live background agent keeps the session (ADR-088 S3): disposing would
    // kill it and lose its notification. backgroundWorkChanged re-arms this
    // once the last one ends.
    if (this.subagents.liveBackgroundCount > 0) return
    if (this.inactivityTimeoutMs > 0) {
      this.inactivityTimer = setTimeout(() => {
        logger.info('PiSession', 'Idle timeout — auto-disconnecting')
        this.cancel()
      }, this.inactivityTimeoutMs)
    }
  }

  protected override onDispatchedCostsChanged(): void {
    this.sendStatusLine()
  }

  /** Resolve ResolvedCapabilities for a model VALUE from the discovery catalog
   *  (contextWindow/maxOutput/vision/reasoning) — falls back to
   *  piModelCapabilities' bare defaults if the catalog is unavailable or has
   *  no matching entry. `reasoning` (M2b) drives the effort picker: true only
   *  when the CATALOG says this specific model accepts `set_thinking_level`.
   *  `effortLevels` (M3) is derived from the SAME match via
   *  `effortLevelsFromModel` — the full PiModel here carries
   *  `thinkingLevelMap`, so this post-connect resolve exposes xhigh/max
   *  exactly where the picker (model-discovery.ts, seeded from the identical
   *  helper) shows them; the two must never disagree. */
  private async resolveCapsForModel(modelValue: string): Promise<ResolvedCapabilities> {
    try {
      const ref = engineMeta('pi').decodeModelValue(modelValue)
      const catalog = await getPiModelCatalog()
      const match = catalog.find((m) => m.provider === ref.vendorId && m.id === ref.modelId)
      return resolvePiCapabilities(
        match
          ? {
              vision: match.input.includes('image'),
              contextWindow: match.contextWindow,
              maxOutput: match.maxTokens,
              reasoning: match.reasoning,
              effortLevels: effortLevelsFromModel(match)
            }
          : undefined
      )
    } catch {
      return resolvePiCapabilities()
    }
  }

  /**
   * Re-read pi's ACTUAL current model via a fresh `get_state` and adopt it
   * into `_model` (+ re-resolve capabilities), so status.model never lies.
   * Skips the "unknown" placeholder model pi reports when nothing is
   * configured (verified doc drift #3 — a placeholder object, never null).
   * Used after a failed set_model (both the spawn-time and live-setModel call
   * sites), where the optimistic `_model` assignment would otherwise keep the
   * failed/bogus value. Best-effort: returns false (leaving `_model`
   * unchanged) when the client is gone, get_state fails, or pi reports the
   * placeholder — callers decide the fallback.
   */
  private async adoptEngineModel(): Promise<boolean> {
    if (!this.client) return false
    try {
      const resp = await this.client.request<PiGetStateData>({ type: 'get_state' })
      const model = resp.success ? resp.data?.model : undefined
      if (!model || model.id === 'unknown') return false
      this._model = `${model.provider}/${model.id}`
      this._capabilities = await this.resolveCapsForModel(this._model).catch(
        () => this._capabilities
      )
      return true
    } catch {
      return false
    }
  }

  /**
   * Spawn the pi process, resolve state, apply the requested model, and wire
   * event dispatch — memoized so concurrent/repeated calls (run(null) eager
   * warm-up racing a real run(prompt)) share one spawn. On an unexpected exit,
   * the memo is cleared so the NEXT run() can respawn a fresh process rather
   * than being permanently stuck.
   */
  private ensureStarted(): Promise<void> {
    if (!this.startedPromise) {
      this.startedPromise = this.doStart().catch((err) => {
        this.startedPromise = null
        throw err
      })
    }
    return this.startedPromise
  }

  /**
   * Shared-skills discovery (M3): the concrete, EXISTING skill directories to
   * hand the bridge extension's `resources_discover` handler via env var
   * (`CLAUDEUI_PI_SKILL_DIRS`, `path.delimiter`-joined — the extension just
   * splits it, no fs access there; see pi-bridge-source.ts). Claude skills are
   * SKILL.md dirs under `~/.claude/skills/*` and `<cwd>/.claude/skills/*` — the
   * same agentskills convention pi itself uses
   * (vendor/pi-src/packages/coding-agent/docs/skills.md's "Using Skills from
   * Other Harnesses" documents exactly this
   * `["~/.claude/skills", "../.claude/skills"]`-style settings array).
   *
   * Returns `{}` (key entirely ABSENT, not an empty-string value) when neither
   * dir exists — keeps the bridge extension's own env-var-presence gate
   * meaningful (an empty string would still be "present").
   */
  private computeSkillDirsEnv(): Record<string, string> {
    const candidates = [join(homedir(), '.claude', 'skills'), join(this.cwd, '.claude', 'skills')]
    const existing = candidates.filter((dir) => {
      try {
        return existsSync(dir)
      } catch {
        return false
      }
    })
    return existing.length > 0 ? { CLAUDEUI_PI_SKILL_DIRS: existing.join(delimiter) } : {}
  }

  private async doStart(): Promise<void> {
    const launch = locatePiLaunch()
    if (!launch) throw new Error(harnessUnavailableMessage('pi'))

    // Approval bridge (M2a): a fresh loopback host + version-keyed extension
    // file per spawn (docs/protocol-pi/README.md "Extensions"; pi-bridge-
    // source.ts). Started BEFORE the pi child so the URL/token are ready to
    // hand to it via env. If the child then fails to spawn, the orphaned host
    // is disposed below rather than leaked.
    // Hosted tools + dispatch (M4a+b): ONE PiBridgeHost serves BOTH routes —
    // gateToolCall (/tool-call, M2a) and handleHostedTool (/hosted-tool,
    // M4a+b). The bridge extension registers the four hosted tools only when
    // CLAUDEUI_PI_HOSTED_TOOLS=1 (below); dispatch_agent additionally needs
    // CLAUDEUI_PI_DISPATCH_ENABLED=1. Both env vars are computed from the
    // RESOLVED capability (this.capabilities — the public getter, ANDed with
    // crossEngineDispatchAvailable('pi') for crossEngineDispatch) so the
    // extension never registers a tool ClaudeUI itself considers unavailable.
    // Belt-and-braces (A1 security fix): only wire the /hosted-tool handler
    // when the capability is actually on — even though handleHostedTool
    // itself now fails closed without a matching grant regardless (see
    // hostedGrants below), a session with hostedMcp off should never expose a
    // working /hosted-tool route at all, matching what the bridge extension
    // itself is told to register (CLAUDEUI_PI_HOSTED_TOOLS below).
    // The THIRD arg is the long-poll options bag (PiBridgeHost's "Long-poll
    // protocol"): hold/abandon budgets stay at their defaults, but the
    // abandonment callback is wired so a pi child that stops polling can't
    // leave a live approval card or an orphaned dispatched child behind.
    const bridgeHost = new PiBridgeHost(
      this.gateToolCall,
      this.capabilities.hostedMcp ? this.handleHostedTool : undefined,
      { onAbandoned: this.handleBridgeAbandoned }
    )
    let bridge: { url: string; token: string }
    try {
      bridge = await bridgeHost.start()
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err))
    }

    // Everything from here through a successful client.start() can throw
    // (writeBridgeExtension does real fs I/O) with `bridgeHost` already
    // listening — dispose it on ANY failure in this block rather than leaking
    // the port/process.
    let client: PiRpcClient
    try {
      const bridgePath = writeBridgeExtension()

      const args = ['--mode', 'rpc', '-e', bridgePath]
      // Host-run subagents (ADR-088): the agent registry is a spawn-time
      // snapshot (Claude Code loads its definitions at start too) — a
      // definition added mid-session takes effect at the next spawn. Never
      // throws (unreadable files become diagnostics).
      if (this.capabilities.subagents) {
        const registry = this.loadAgentRegistry(this.cwd)
        this.subagents.setRegistry(registry)
        if (registry.diagnostics.length > 0) {
          logger.debug(
            'PiSession',
            `agent registry: ${registry.list().length} type(s), ${registry.diagnostics.length} definition file(s) skipped or adjusted`
          )
        }
      }
      if (this.resumeSessionId) {
        // Resolve the on-disk file for the resume id; fall back to the raw id
        // (verified: --session accepts an absolute file path) if not found —
        // pi will then report whatever it can, rather than us refusing to spawn.
        const resolvedPath = findPiSessionFile(this.resumeSessionId)
        args.push('--session', resolvedPath ?? this.resumeSessionId)
      }

      client = new PiRpcClient(launch, {
        cwd: this.cwd,
        args,
        env: {
          CLAUDEUI_PI_BRIDGE_URL: bridge.url,
          CLAUDEUI_PI_BRIDGE_TOKEN: bridge.token,
          ...(this.capabilities.hostedMcp ? { CLAUDEUI_PI_HOSTED_TOOLS: '1' } : {}),
          ...(this.capabilities.crossEngineDispatch ? { CLAUDEUI_PI_DISPATCH_ENABLED: '1' } : {}),
          // Plan mode (M5a): registers exit_plan + the cui-plan-enter/exit
          // commands in the bridge extension (inactive until entered) —
          // gated on the STATIC capability, mirroring hostedMcp above, NOT
          // on whether this session's mode happens to be 'plan' right now
          // (that's a separate, later step — see the re-entry send below).
          ...(this.capabilities.plan ? { CLAUDEUI_PI_PLAN_TOOLS: '1' } : {}),
          // Host-run subagents (ADR-088): the bridge's own `agent` (+
          // `task_stop`) and `send_message` tools, and the agent types for
          // the `agent` description. No second `-e`.
          ...(this.capabilities.subagents
            ? {
                CLAUDEUI_PI_AGENT_TOOL: '1',
                CLAUDEUI_PI_AGENT_LISTING: this.subagents.listing(),
                CLAUDEUI_PI_SEND_MESSAGE: '1'
              }
            : {}),
          ...this.computeSkillDirsEnv()
        }
      })
      await client.start()
    } catch (err) {
      bridgeHost.dispose()
      throw err instanceof Error ? err : new Error(String(err))
    }
    this.bridgeHost = bridgeHost
    this.client = client
    this.disconnected = false

    client.onEvent((ev) => {
      if (this._cancelled) return
      // H19: a cancel()→run() respawn installs a NEW client; the OLD client's
      // in-flight events can still arrive after `_cancelled` was reset to false
      // by the new run(). Only the currently-attached client may feed the live
      // stream — a stale event from a superseded client must be dropped.
      if (this.client !== client) return
      const outputs = mapPiEvent(ev, this.mapperState)
      this.dispatchOutputs(outputs)
    })
    client.onExit(() => {
      if (this._cancelled) return
      // H19: the OLD client's OS exit event can still be in flight when a
      // cancel()→run() respawn has already installed a NEW client + bridge
      // host (cancel() set `_cancelled`, but run() reset it to false before
      // this fires — so the `_cancelled` guard above no longer catches it).
      // Without this identity guard the stale handler would dispose the NEW
      // bridge host (every later tool_call → "approval service unreachable"),
      // null the live client, and null startedPromise (so the next run spawns a
      // THIRD process, leaking the second). Only the attached client's own exit
      // may run this teardown.
      if (this.client !== client) return
      this.dispatchOutputs(finishPiMessage(this.mapperState))
      this.isProcessing = false
      this.disconnected = true
      this.endUserStop()
      this.client = null
      // The process is gone — any pending gate can never be resolved by it;
      // deny is the only sane resolution (also prevents a ghost approval card
      // from silently persisting-a-rule for a tool call that no longer exists
      // if the user later clicks it). Also drops any outstanding hosted-tool
      // grants — a /hosted-tool POST racing this exit has nothing left to
      // execute against anyway.
      this.rejectAllPendingGates('Interrupted')
      // Foreground children belong to the turn that just died with it.
      this.subagents.stopAll('dispose')
      if (this.bridgeHost) {
        this.bridgeHost.dispose()
        this.bridgeHost = null
      }
      // Nothing left to flush to once the process is gone — a firing timer
      // after this would send() to a session whose engine is disconnected.
      this.bashStreamGate.cancelAll()
      // Same reasoning for held queue items: no engine left to forward them to
      // (ADR-053 §engine death).
      this.recallQueuedOnEngineLoss()
      // Allow a later run() to respawn instead of being wedged forever.
      this.startedPromise = null
      this.sendStatus()
    })

    // `this.client`/`this.bridgeHost` are now live — an uncaught rejection
    // from here on (e.g. get_state hanging/erroring) would otherwise leave a
    // running process + open port that the NEXT doStart() respawn overwrites
    // without ever disposing. client.dispose() below asynchronously fires the
    // onExit handler above once the OS reports the exit; that handler
    // null-checks everything it touches, so this synchronous cleanup and that
    // later async one are safe to both run (dispose() is documented idempotent).
    try {
      const stateResp = await client.request<PiGetStateData>({ type: 'get_state' })
      if (stateResp.success && stateResp.data) {
        this.piSessionId = stateResp.data.sessionId ?? null
        this.mapperState.sessionId = this.piSessionId

        // No explicit model request → pi keeps its OWN model (settings.json
        // default, or the one restored from a resumed session's model_change
        // entries). Adopt what the engine actually reports so status.model is
        // honest instead of parroting the PI_DEFAULT_MODEL constructor fallback
        // that never reached the wire. The "unknown" placeholder (no model
        // configured — verified doc drift #3) is skipped: keep the local default
        // rather than reporting a non-model.
        const engineModel = stateResp.data.model
        if (!this.requestedModel && engineModel && engineModel.id !== 'unknown') {
          this._model = `${engineModel.provider}/${engineModel.id}`
          this._capabilities = await this.resolveCapsForModel(this._model).catch(
            () => this._capabilities
          )
          this.sendStatus()
        }
      }
    } catch (err) {
      this.client?.dispose()
      this.client = null
      if (this.bridgeHost) {
        this.bridgeHost.dispose()
        this.bridgeHost = null
      }
      throw err instanceof Error ? err : new Error(String(err))
    }

    // Fork ("branch off", M5c) — BEFORE any set_model/set_thinking_level
    // application below, so configuring the session never mutates the
    // resumed SOURCE (`this.client` is currently attached to whatever
    // `--session <file>` resumed above, i.e. the source, until this block
    // switches it). Choreography verified against the real vendored binary
    // (a throwaway --session-dir probe, never ~/.pi/agent/sessions — see the
    // M5c kickoff notes):
    //   - `fork {entryId}` ALONE — no preceding `clone` — already creates a
    //     brand-new session file and switches the live client to it, leaving
    //     the resumed source file byte-unchanged. The kickoff spec's assumed
    //     clone-then-fork-on-the-clone two-step is unnecessary for this
    //     branch: `fork` already gives "new file, source untouched", the
    //     same guarantee `clone` gives.
    //   - `clone` is still needed for the OTHER branch: forking the LATEST
    //     message (PI_FORK_CLONE_LATEST_SENTINEL) has no target user entry
    //     for `fork` to drop at, so `clone` (duplicate the active branch at
    //     its current position) is the only primitive that applies.
    //   - Both `clone` and `fork` can report `cancelled: true` if a
    //     `session_before_fork` extension handler vetoes the operation
    //     (ClaudeUI registers none itself, so this is always false in
    //     practice) — treated as a failure, same as `success: false`.
    // Any failure here throws, hits the SAME catch/cleanup contract as the
    // get_state block above (dispose the orphaned client/bridgeHost) — a
    // fork that can't be verified must never fall through to configuring
    // (and thus mutating) the source.
    if (this.forkSession && this.resumeSessionAt) {
      try {
        if (this.resumeSessionAt === PI_FORK_CLONE_LATEST_SENTINEL) {
          const cloneResp = await client.request<PiCloneData>({ type: 'clone' })
          if (!cloneResp.success || cloneResp.data?.cancelled) {
            throw new Error(cloneResp.error ?? 'pi cancelled the session clone (fork failed)')
          }
        } else {
          const forkResp = await client.request<PiForkData>({
            type: 'fork',
            entryId: this.resumeSessionAt
          })
          if (!forkResp.success || forkResp.data?.cancelled) {
            throw new Error(forkResp.error ?? 'pi cancelled the fork (fork failed)')
          }
        }

        // Adopt the NEW (post-clone/fork) sessionId — this.piSessionId
        // currently still holds the SOURCE's id from the get_state above.
        const forkedState = await client.request<PiGetStateData>({ type: 'get_state' })
        if (!forkedState.success || !forkedState.data?.sessionId) {
          throw new Error('pi did not report a session id after the fork (fork failed)')
        }
        this.piSessionId = forkedState.data.sessionId
        this.mapperState.sessionId = this.piSessionId
      } catch (err) {
        this.client?.dispose()
        this.client = null
        if (this.bridgeHost) {
          this.bridgeHost.dispose()
          this.bridgeHost = null
        }
        throw err instanceof Error ? err : new Error(String(err))
      }
    }

    // Only set_model when the CALLER explicitly requested one — an omitted
    // model means "use whatever pi already has" (see the adoption above).
    // Forcing PI_DEFAULT_MODEL's hardcoded guess here would fail loudly for a
    // user who has only authenticated a DIFFERENT provider.
    if (this.requestedModel) {
      const ref = engineMeta('pi').decodeModelValue(this.requestedModel)
      let applied = false
      try {
        const setResp = await client.request({
          type: 'set_model',
          provider: ref.vendorId,
          modelId: ref.modelId
        })
        applied = setResp.success
        if (!setResp.success) {
          this.send(
            'session:error',
            setResp.error ?? `Failed to set model "${this.requestedModel}"`
          )
        }
      } catch (err) {
        this.send('session:error', err instanceof Error ? err.message : String(err))
      }
      // The requested model did NOT take — re-sync _model from the engine's
      // actual state so status.model reports what pi is really running rather
      // than the failed value. Best-effort: an unreadable state keeps the
      // current value (nothing better to report).
      if (!applied) {
        const adopted = await this.adoptEngineModel()
        if (adopted) this.sendStatus()
      }
    }

    // Spawn-time effort (M2b): apply EngineSpawnOptions.effort (or a
    // setEffort() call that arrived before this spawn finished) once the
    // model this session actually ended up running with is known. Re-resolve
    // caps for `this._model` RIGHT NOW rather than trusting `this._capabilities`
    // — the constructor's OWN resolveCapsForModel().then() runs concurrently
    // with this whole doStart() and may not have landed yet, and the
    // `requestedModel` branch above never re-resolves caps on a SUCCESSFUL
    // set_model (only the "adopt" fallback does), so `this._capabilities`
    // can still be stale for the just-applied model at this exact point.
    if (this.requestedEffort) {
      const effort = this.requestedEffort
      this._capabilities = await this.resolveCapsForModel(this._model).catch(
        () => this._capabilities
      )
      this.sendStatus()
      if (this._capabilities.reasoning.effort != null) {
        this.setEffort(effort)
      }
    }

    // Plan-mode re-entry (M5a): a fresh process starts with fresh
    // (non-plan) in-extension-instance state — pi restarting extensions on a
    // respawn (crash, or this being the VERY FIRST spawn of a session
    // constructed with permissionMode:'plan' already) loses the tool-set
    // restriction the extension was enforcing. Re-send the enter command
    // whenever this session's OWN mode is already 'plan' once the client is
    // confirmed up, so the restriction is reinstated before any real prompt
    // can reach the model. Best-effort — mirrors get_commands' identical
    // "never block the session" treatment below.
    if (this.permissionMode === 'plan') {
      await this.sendPlanModeCommand('cui-plan-enter')
    }

    // Slash commands + skills (M2b): get_commands lists extension commands,
    // prompt templates, and skill:* entries (vendor/pi-src/packages/coding-agent/docs/rpc.md
    // "get_commands"). Once per spawn, best-effort — a failure here must
    // never block the session (discovery is optional, mirrors
    // OpencodeSession.eagerConnect's identical treatment of
    // listCommands/listSkills).
    try {
      const resp = await client.request<PiGetCommandsData>({ type: 'get_commands' })
      if (resp.success && resp.data) {
        // sourceInfo.scope === 'temporary' entries are per-spawn extension
        // artifacts (verified doc drift — docs/protocol-pi/README.md
        // "Extensions": a `-e <file.ts>` extension "appears in get_commands
        // with sourceInfo.scope: 'temporary'"). Our OWN bridge extension
        // (pi-bridge-source.ts) registers no commands today, so none of
        // these are ours in practice — filtered defensively anyway, so a
        // future bridge change (or another -e extension) never leaks a
        // ClaudeUI-internal or otherwise-ephemeral artifact into the
        // user-facing slash menu.
        const persistent = resp.data.commands.filter((c) => c.sourceInfo?.scope !== 'temporary')

        logger.debug('PiSession', `get_commands discovered ${persistent.length} command(s)`)

        // EXACT contract as OpencodeSession.eagerConnect (names get the '/'
        // prefix; renderer slash menu is engine-neutral).
        const slashCommands = persistent.map((c) => ({
          name: '/' + c.name,
          description: c.description
        }))
        this.send('session:slash-commands', slashCommands)

        // session:skills — name list only, `skill:` prefix stripped (same
        // bare-name contract as OpencodeSession.eagerConnect's skillNames).
        const skillNames = persistent
          .filter((c) => c.source === 'skill')
          .map((c) => c.name.replace(/^skill:/, ''))
        this.send('session:skills', skillNames)
      }
    } catch (err) {
      logger.warn(
        'PiSession',
        `get_commands failed (best-effort, discovery is optional): ${err instanceof Error ? err.message : String(err)}`
      )
    }

    // Fork excluded (mirrors ClaudeSession's identical "forks excluded" cost-
    // seeding posture — see its constructor doc comment): the renderer
    // already has the correct TRUNCATED history from the store's own
    // optimistic seed (session-store.ts's forkFromMessage slices
    // messages[0..idx] before this session ever spawns). Replaying
    // `this.resumeSessionId` here would replay the SOURCE's history — for a
    // fork that's the pre-truncation, UNTRUNCATED transcript, which would
    // leak post-fork-point messages into what's supposed to be a fresh
    // branch. The new (cloned/forked) session's own cost/token base also
    // starts fresh at 0 rather than double-counting the source's totals.
    if (this.resumeSessionId && !this.forkSession) {
      await this.replayStoredHistory(this.resumeSessionId)
    }
  }

  /**
   * Load stored messages for a resumed session and replay them to the renderer
   * as `session:message` (and `session:tool-result`) events, in order, BEFORE
   * the first new prompt — mirrors OpencodeSession.replayStoredHistory.
   *
   * Reuses `loadPiSessionHistory` (pi-session-list.ts) — the SAME conversion
   * path the sidebar loader uses — so live and replayed history render
   * identically. Best-effort: any failure is swallowed and logged; it NEVER
   * blocks the new prompt. Run-once: a single PiSession only ever replays once.
   */
  private async replayStoredHistory(sessionId: string): Promise<void> {
    if (this.replayedHistory) return
    this.replayedHistory = true
    try {
      // The status line the loader also returns is for a COLD open (no session
      // object): this one seeds its own base from pi's tally below.
      const { messages, subagentMessages, taskNotifications } =
        await loadPiSessionHistory(sessionId)
      logger.info('PiSession', `Replaying ${messages.length} stored messages for ${sessionId}`)

      for (const msg of messages) {
        const idx = this.messageHistory.findIndex((m) => m.id === msg.id)
        if (idx >= 0) this.messageHistory[idx] = msg
        else this.messageHistory.push(msg)

        this.send('session:message', msg)

        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            this.send('session:tool-result', {
              toolUseId: block.toolUseId,
              result: block.toolResult,
              isError: block.isError ?? false
            })
          }
        }
      }

      // Host-run subagent transcripts (ADR-088), after the parent's messages
      // so each lands under the `agent` card that spawned it. Never into
      // messageHistory: the judge and /btw read the parent's own turns only.
      for (const [toolUseId, childMessages] of Object.entries(subagentMessages ?? {})) {
        this.send('session:subagent-message-batch', { toolUseId, messages: childMessages })
      }
      // Their terminal events (ADR-088 S3), after the batches; the reducer
      // folds them idempotently per (toolUseId, runIndex).
      for (const notification of taskNotifications ?? []) {
        this.send('session:task-notification', notification)
      }
      // ADR-088 S3b (G7): the depth-1 agents of earlier runs, so send_message
      // can address (and resume) them across an app restart.
      try {
        for (const link of loadPiAgentLinks(sessionId)) this.subagents.adoptRecord(link)
      } catch (err) {
        logger.warn(
          'PiSession',
          `agent record rebuild failed: ${err instanceof Error ? err.constructor.name : 'Error'}`
        )
      }

      // Seed the durable cost base from pi's own tally so totalCostUsd
      // continues from the prior total instead of restarting at 0.
      if (this.client) {
        const statsResp = await this.client.request<PiGetSessionStatsData>({
          type: 'get_session_stats'
        })
        if (statsResp.success && statsResp.data) {
          const model = engineMeta('pi').decodeModelValue(this._model)
          // Nothing metered means there is no history to price — an empty base,
          // not an unpriced one. Seeding an entry here would report a session
          // that has cost nothing yet as "unknown" on any unpriced model.
          const metered = statsResp.data.cost > 0 || statsResp.data.tokens.total > 0
          this.costBase = metered
            ? [
                piCostInputs(
                  model.vendorId,
                  model.modelId,
                  statsResp.data.tokens,
                  statsResp.data.cost
                )
              ]
            : []
          this.sumInputTokens = statsResp.data.tokens.input
          this.sumOutputTokens = statsResp.data.tokens.output
          this.sumCacheReadTokens = statsResp.data.tokens.cacheRead
          this.sumCacheWriteTokens = statsResp.data.tokens.cacheWrite
        }
      }
      this.sendStatusLine()
    } catch (err) {
      logger.warn(
        'PiSession',
        `replayStoredHistory failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Build the ContentBlock[] for a locally-recorded user ChatMessage. pi has
   * no document/PDF input (unlike Claude/opencode) — non-image attachments
   * are silently dropped, matching run()'s prompt-building rule. Like every
   * ChatMessage, the blocks carry blob refs, not bytes (ADR-087).
   */
  private buildUserContent(prompt: string, attachments?: AttachmentUpload[]): ContentBlock[] {
    const content: ContentBlock[] = []
    const images = attachments?.filter((att) => att.mediaType.startsWith('image/')) // pi has no document input — PDFs silently dropped
    for (const att of internAttachments(images) ?? []) {
      content.push({
        type: 'image',
        mediaType: att.mediaType as ImageMediaType,
        blobId: att.blobId,
        bytes: att.bytes,
        fileName: att.fileName
      })
    }
    if (prompt) content.push({ type: 'text', text: prompt })
    return content
  }

  async run(prompt: string | null, attachments?: AttachmentUpload[]): Promise<void> {
    // The bridge's commands are ClaudeUI's alone (ADR-088 S3): a typed
    // `/cui-deliver …` would mint a row marked as an agent's message, and the
    // plan commands are PiSession's own toggle channel (it sends them itself,
    // not through run()). Every `/cui-` start is refused before anything else,
    // so nothing is sent and no state moves.
    if (prompt !== null && isReservedPiCommandText(prompt)) {
      this.send('session:error', 'That command is reserved for ClaudeUI.')
      // A queued copy is dropped after this one refusal (M-3): left queued, it
      // would be retried — and refused again — at every boundary.
      let dropped = false
      for (const item of this.queue.pending()) {
        if (item.text !== prompt) continue
        this.queue.setState(item, 'recalled')
        dropped = true
      }
      if (dropped) this.queue.emit()
      return
    }

    this.clearInactivityTimer()
    this._cancelled = false

    // run(null): eager warm-up only (mirrors Claude/opencode's spawn-on-create
    // pattern) — spawns the process (and replays history on resume) before the
    // first real prompt arrives. Failures degrade silently; a real run(prompt)
    // will surface them via session:error.
    if (prompt === null) {
      this.ensureStarted().catch((err) => {
        logger.warn(
          'PiSession',
          `eager ensureStarted failed: ${err instanceof Error ? err.message : String(err)}`
        )
      })
      this.resetInactivityTimer()
      return
    }

    try {
      await this.ensureStarted()
    } catch (err) {
      this.send('session:error', err instanceof Error ? err.message : String(err))
      this.sendStatus()
      this.resetInactivityTimer()
      return
    }
    if (this._cancelled || !this.client) {
      this.sendStatus()
      this.resetInactivityTimer()
      return
    }

    // M-PI1: read the busy state AFTER `await ensureStarted()`, never before.
    // Two run()s landing during the spawn window both awaited the SAME
    // startedPromise; run #1's continuation runs first and synchronously sets
    // isProcessing=true (below) before yielding at its own `await
    // client.request`, so run #2 observes busy here and steers instead of
    // sending a bare `prompt` — which pi rejects while streaming, and whose
    // failure branch would flip isProcessing=false mid-turn (UI idle, queueing
    // stops). Reading it before the await snapshotted false for both.
    const wasBusy = this.isProcessing

    // Record the user message locally (for getMessages()). Do NOT emit
    // session:message — the renderer adds it optimistically (addUserMessage).
    const userMsg: ChatMessage = {
      id: uuid(),
      role: 'user',
      content: this.buildUserContent(prompt, attachments),
      timestamp: Date.now()
    }
    this.messageHistory.push(userMsg)

    const images = (attachments ?? [])
      .filter((att) => att.mediaType.startsWith('image/'))
      .map((att) => ({ type: 'image' as const, data: att.base64Data, mimeType: att.mediaType }))

    const command: PiRpcCommand = { type: 'prompt', message: prompt }
    if (images.length > 0) command.images = images
    // A prompt sent while already streaming REQUIRES streamingBehavior or pi
    // rejects it (verified — README.md "Commands"). 'steer' (M2b — Claude
    // parity): delivered after the CURRENT tool calls finish, before the next
    // LLM call within the SAME turn (verified), not 'followUp' (queued until
    // the whole run settles) — see PI_ENGINE_CAPABILITIES' doc comment for why
    // `queue` stays true alongside `steer`.
    if (wasBusy) command.streamingBehavior = 'steer'

    if (!wasBusy) this.mapperState.startTimeMs = Date.now()
    // A fresh turn closes the user-stop window (ADR-089); a steer while the
    // stopped turn drains keeps it.
    if (!wasBusy) this.endUserStop()
    this.isProcessing = true
    this.sendStatus()
    // A run pi starts on its own while this ack is pending (M-1, see below).
    const runsBefore = this.runStarts

    try {
      // Kept while in flight (Fact S8): a delivery that started a run inside
      // this prompt's pre-run awaits would make pi refuse it as "already
      // processing", so deliverAgentMessage waits for this ack first.
      const request = this.client.request(command)
      this.promptInFlight = request
      const resp = await request.finally(() => {
        if (this.promptInFlight === request) this.promptInFlight = null
      })
      if (!resp.success) {
        // wasBusy (steer path): the ORIGINAL turn is still streaming — a
        // rejected steer must not flip isProcessing back to false out from
        // under it. Flipping it here would report idle mid-turn AND, worse,
        // let a subsequent run() send a bare `prompt` with no
        // `streamingBehavior`, which pi rejects outright while still
        // streaming (README.md "Commands"). Only a non-busy failure (this
        // WAS the turn) resets processing/the inactivity timer. Nor when pi
        // started a run of its own meanwhile (a delivery, ADR-088 S3): the
        // refusal is then "already processing", and that run is live.
        if (!wasBusy && this.runStarts === runsBefore) {
          this.isProcessing = false
          this.resetInactivityTimer()
        }
        this.send('session:error', resp.error ?? 'pi rejected the prompt')
        this.sendStatus()
        return
      }
      // Delivery ack (ADR-053). Fired on BOTH paths, not just the busy one: a
      // queue flush at the previous turn's end arrives here with wasBusy=false
      // and must still consume its item. A never-queued prompt is a no-op.
      this.onPromptDelivered(prompt)
    } catch (err) {
      // Same carve-outs as the !resp.success branch above.
      if (!wasBusy && this.runStarts === runsBefore) {
        this.isProcessing = false
        this.resetInactivityTimer()
      }
      this.send('session:error', err instanceof Error ? err.message : String(err))
      this.sendStatus()
    }
  }

  /**
   * Put an agent-authored message into this session (ADR-088 S3): a
   * background agent's notification whose owner is the root, and (S3b) a
   * `send_message` to `main`. The ONLY path is the bridge's `/cui-deliver`
   * command (pi-delivery.ts, the marking rule): never run(), never a plain
   * `prompt`, `steer` or `follow_up`. Nothing is recorded or emitted here —
   * the row arrives as pi's own `custom` message through dispatchOutput, at
   * the moment pi actually delivers it (a running turn gets it at its next
   * tool boundary; an idle session appends it, and starts a turn when `wake`).
   * Serialized FIFO; never throws.
   */
  deliverAgentMessage(payload: PiAgentDelivery): void {
    this.deliveryChain = this.deliveryChain
      .then(() => this.sendDelivery(payload))
      .catch((err) => {
        logger.warn(
          'PiSession',
          `delivery ${payload.deliveryId} failed: ${err instanceof Error ? err.constructor.name : 'Error'}`
        )
      })
  }

  private async sendDelivery(payload: PiAgentDelivery): Promise<void> {
    const ids = `delivery ${payload.deliveryId} (agent ${payload.details.agentId})`
    // No process: its children are already gone with it (cancel/exit dispose
    // them), and respawning would open a fresh pi session. Dropped.
    if (!this.client || this._cancelled) {
      logger.info('PiSession', `${ids} dropped: the session has no pi process`)
      return
    }
    // Fact S8: a user prompt whose ack is not in yet may still be in pi's
    // pre-run awaits; once its ack is in, a delivery steers it.
    if (this.promptInFlight) await this.promptInFlight.catch(() => {})
    const client = this.client
    if (!client || this._cancelled) {
      logger.info('PiSession', `${ids} dropped: the session has no pi process`)
      return
    }
    const waking = payload.wake && !this.isProcessing
    if (waking) {
      // pi starts the turn itself (P-S3): the session reads as running now.
      this.wakePending = true
      this.isProcessing = true
      this.mapperState.startTimeMs = Date.now()
      this.clearInactivityTimer()
      this.sendStatus()
    }
    let ok = false
    try {
      const resp = await client.request({ type: 'prompt', message: deliveryCommand(payload) })
      ok = resp.success
    } catch {
      ok = false
    }
    if (ok) return
    logger.warn('PiSession', `${ids} was not accepted by pi`)
    if (waking && this.wakePending) this.undoWake()
  }

  /** A woken delivery will start no run after all: back to idle (M-2). */
  private undoWake(): void {
    this.wakePending = false
    this.isProcessing = false
    this.resetInactivityTimer()
    this.sendStatus()
  }

  private dispatchOutputs(outputs: PiMapperOutput[]): void {
    for (const output of outputs) this.dispatchOutput(output)
  }

  private dispatchOutput(output: PiMapperOutput): void {
    switch (output.kind) {
      case 'item_open':
        this.rememberPiMessage(output.message)
        this.send('session:item-open', {
          target: output.target,
          message: output.message,
          ...(output.startedAt === undefined ? {} : { startedAt: output.startedAt })
        })
        break

      case 'item_delta':
        this.rememberPiMessage(output.message)
        this.send('session:item-delta', { target: output.target, chunk: output.chunk })
        break

      case 'item_seal': {
        this.rememberPiMessage(output.message)
        this.send('session:item-seal', {
          message: output.message,
          ...(output.target ? { target: output.target } : {})
        })
        break
      }

      case 'message': {
        const idx = this.messageHistory.findIndex((m) => m.id === output.message.id)
        if (idx >= 0) this.messageHistory[idx] = output.message
        else this.messageHistory.push(output.message)
        this.send('session:message', output.message)
        break
      }

      case 'tool_result':
        // Live bash output streaming (M2b): drop this toolUseId's throttle
        // tracking now that the final result is in — a no-op for any
        // non-bash / never-streamed toolUseId (BashStreamGate.cancel on an
        // absent key is a harmless no-op).
        this.bashStreamGate.cancel(output.toolUseId)
        // Auto-mode ground truth: how this call actually ended. `ok` is NOT a
        // safety verdict (ref §5) and never overwrites a recorded
        // `rejected-by-user`/`automode-blocked` decision — recordToolOutcome
        // enforces that stickiness.
        this.recordToolOutcome(output.toolUseId, output.isError ? 'error' : 'ok')
        this.send('session:tool-result', {
          toolUseId: output.toolUseId,
          result: output.result,
          isError: output.isError,
          ...(output.fileDiffs ? { fileDiffs: output.fileDiffs } : {}),
          ...(output.images ? { images: output.images } : {})
        })
        // ADR-053 sub-turn boundary: a tool call just finished, so held queue
        // items may be forwarded now (as a `steer`, since the turn is running).
        void this.flushQueuedItems()
        break

      case 'bash_output':
        // Mirrors OpencodeSession's own call-site guard (event-mapper.ts
        // always emits this kind for a bash tool_execution_update — even one
        // with empty accumulated text — so the length check belongs here,
        // not in the pure mapper).
        if (output.output.length > 0) {
          this.bashStreamGate.update(output.toolUseId, output.output)
        }
        break

      case 'usage': {
        // The session's own row (the shared builder — ADR-088 D6: a
        // subagent's row is the same shape with origin 'child').
        recordUsageEvent(
          piUsageEvent(output, {
            sessionId: this.piSessionId,
            origin: 'session',
            parentRoutingId: null
          })
        )
        // ADR-071 §2: the headline follows the cost rule, so what this message
        // adds is its DISPLAY cost — pi's own figure only when the rule says
        // that is what the user was charged. The ledger row above keeps pi's
        // raw figure as `engineCostUsd`, unchanged.
        this.liveCostInputs.push(
          piCostInputs(output.provider, output.modelId, output.tokens, output.costUsd)
        )
        this.sumInputTokens += output.tokens.input
        this.sumOutputTokens += output.tokens.output
        this.sumCacheReadTokens += output.tokens.cacheRead
        this.sumCacheWriteTokens += output.tokens.cacheWrite
        this.lastContextLength = output.tokens.input + output.tokens.cacheRead
        this.sendStatusLine()
        break
      }

      case 'result':
        this.isProcessing = false
        this.wakePending = false
        this.accTotalDurationMs += output.durationMs
        this.sendStatusLine()
        this.send('session:result', {
          // output.totalCostUsd is the LIVE-only value (mapperState has no
          // notion of the seeded historical base) — override with the getter
          // so a resumed session's result payload reports the same durable
          // total as the status line / session:status (mirrors OpencodeSession).
          totalCostUsd: this.totalCostUsd,
          durationMs: output.durationMs,
          result: '',
          sessionId: output.sessionId
        })
        this.sendStatus()
        this.resetInactivityTimer()
        // The stopped turn (if any) has ended: the user-stop window closes (ADR-089).
        this.endUserStop()
        // ADR-053: turn end is also a boundary — anything still held forwards
        // now as the next turn's prompt (isProcessing is already false, so
        // run() sends a bare `prompt` rather than a `steer`).
        void this.flushQueuedItems()
        break

      case 'auth-required': {
        // ADR-068 §4: one event for every engine, naming the PROVIDER the
        // sign-in dialog can act on rather than pi's own vendor id.
        //
        // ADR-070 §1: pi's verbatim message rides ON the event and the companion
        // `session:error` is GONE — it was a second, separately dismissable card
        // for the same fact. The words survive twice over: as the row's in-place
        // disclosure, and as the neutral transcript block below, which is the
        // permanent record a floating card never was.
        //
        // Deliberately NO processing-state work here, unlike OpencodeSession's
        // twin: opencode's `session.error` IS the turn's end, while pi's
        // failed turn still runs on to `agent_settled` → the 'result' case
        // above, which owns isProcessing/status/inactivity/queue-flush. This
        // arm therefore does exactly what pi's own 'error' arm below does —
        // emit, and let the turn end itself.
        const providerId = piAuthRequiredProviderId(output.vendorId)
        this.send('session:auth-required', { providerId, message: output.message })
        // The SAME providerId on the block, so the row still names the provider
        // once the live `authRequired` has settled (ADR-070 §4).
        const message = authErrorTranscriptMessage(uuid(), output.message, providerId)
        this.rememberPiMessage(message)
        this.send('session:message', message)
        break
      }

      case 'error':
        // ADR-089: the teardown of a turn the user stopped is not news.
        if (this.suppressedAfterUserStop('PiSession', output.message)) break
        this.send('session:error', output.message)
        break

      case 'turn_start':
        this.runStarts++
        this.wakePending = false
        // A run pi started on its own (a delivery that landed while pi was
        // settling, ADR-088 S3) must not read as idle. A run started by run()
        // or a woken delivery already set this.
        if (!this.isProcessing) {
          this.isProcessing = true
          this.mapperState.startTimeMs = Date.now()
          this.clearInactivityTimer()
          this.sendStatus()
        }
        break

      case 'agent_delivery':
        // The row itself came through `message`; nothing waits on this here.
        logger.debug('PiSession', `delivery ${output.deliveryId} arrived`)
        break

      case 'delivery_error':
        // The bridge refused a payload (M-2): no run will start for it, so a
        // woken delivery must not leave the session reading "running".
        logger.warn('PiSession', 'pi refused an agent delivery (cui-deliver failed)')
        if (this.wakePending) this.undoWake()
        break

      case 'send_message_error':
        // An extension's sendMessage failed asynchronously (review F3). While
        // our woken delivery is pending it is that one: undo the wake. Any
        // other extension's failure stays an ordinary error and undoes nothing.
        if (this.wakePending) {
          logger.warn('PiSession', 'a woken agent delivery failed inside pi')
          this.undoWake()
        } else {
          this.send('session:error', output.message)
        }
        break

      case 'ignore':
        break
    }
  }

  private rememberPiMessage(message: ChatMessage): void {
    const index = this.messageHistory.findIndex((candidate) => candidate.id === message.id)
    if (index >= 0) this.messageHistory[index] = message
    else this.messageHistory.push(message)
  }

  async interrupt(): Promise<void> {
    // ADR-089: open the user-stop window before anything else, and only for a
    // live turn — pi can report the abort as a turn error (an aborted model
    // request ends `stopReason: 'error'`, docs/protocol-pi) before the abort
    // RPC even replies.
    if (this.isProcessing) this.beginUserStop()
    // Deny FIRST (synchronous, local) — a hanging extension fetch would
    // otherwise wedge pi's turn forever waiting on a human who just hit stop.
    // Only the session's OWN cards (ADR-088 S3, Q9): a background agent's
    // cards survive the interrupt with it, and every foreground child stopped
    // below retracts its own.
    this.rejectOwnPendingGates('Interrupted')
    // Audit-residual B fix: pi's own turn-abort (the `abort` RPC below) does
    // NOT cancel a `dispatch_agent` child this turn started — the bridge's
    // /hosted-tool handler is just a JS promise awaiting
    // crossEngineDispatcher.dispatch(), which pi's abort has no way to reach.
    // Turn-scoped stop (mirrors TaskCard's own Stop-button call — NOT
    // disposeFor, which tears down reusable targets; a turn interrupt should
    // only abort the CURRENT turn, leaving the target alive for a later
    // continuation, same as a manual Stop click would). Idempotent: a
    // dispatch that already settled is simply absent from the map
    // (dispatchInner's `activeByToolUseId` entry is deleted in its own
    // `finally`), so `stopDispatch` harmlessly misses — see the doc comment
    // on `inFlightDispatchIds` and cancel()'s later disposeFor call, which
    // remains safe to run afterward regardless (PiRpcClient.dispose()/
    // PiBridgeHost.dispose() are both documented idempotent).
    for (const id of this.inFlightDispatchIds) {
      crossEngineDispatcher.stopDispatch(id, this.routingId)
    }
    this.inFlightDispatchIds.clear()
    // Host-run subagents (ADR-088 S3, Q9 — Claude Code's Esc spares
    // background agents too): a foreground child belongs to the turn being
    // aborted; a background one does not.
    this.subagents.stopForeground('interrupt')
    if (!this.client) return
    try {
      await this.client.request({ type: 'abort' })
    } catch (err) {
      logger.warn('PiSession', `abort failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  cancel(): void {
    this.clearInactivityTimer()
    this.dispatchOutputs(finishPiMessage(this.mapperState))
    this._cancelled = true
    this.isProcessing = false
    this.wakePending = false
    this.disconnected = false
    this.endUserStop()
    this.rejectAllPendingGates('Interrupted')
    this.subagents.stopAll('dispose')
    if (this.client) {
      this.client.dispose()
      this.client = null
    }
    if (this.bridgeHost) {
      this.bridgeHost.dispose()
      this.bridgeHost = null
    }
    // Tear down any cross-engine dispatch targets owned by this session
    // (ADR-033 M4b — mirrors ClaudeSession.cancel()/OpencodeSession.cancel()'s
    // identical call; without this, a pi-sourced dispatch_agent's opencode/
    // Claude target would leak past this session's own lifetime).
    crossEngineDispatcher.disposeFor(this.routingId)
    // Drop all pending bash-output throttle timers — nothing left to flush to
    // once the session is torn down (mirrors OpencodeSession.cancel()'s
    // identical call).
    this.bashStreamGate.cancelAll()
    // Nothing left to serve the queue (ADR-053 §engine death).
    this.recallQueuedOnEngineLoss()
    this.startedPromise = null
    this.sendStatus()
  }

  // ── Side question (/btw) ─────────────────────────────────────────────────────

  /**
   * Build the bounded transcript context fed to the ephemeral side-question
   * process. Context source: THIS session's own retained `messageHistory`
   * (BaseSession field, kept live by run()'s user-message push and
   * dispatchOutput's 'message' case) — NOT a re-read of the on-disk session
   * file. That's a deliberate choice over `findPiSessionFile` +
   * `activeBranchEntries` (pi-session-list.ts): messageHistory IS the exact
   * live transcript already, with zero extra fs I/O and no risk of a
   * mid-write race against the file the live session is concurrently
   * appending to. It also degrades gracefully pre-replay (a resumed session
   * whose replayStoredHistory hasn't landed yet simply has a shorter history
   * to draw from, never an error).
   *
   * Bounded on two axes (kept independent so either alone is a meaningful
   * cap): at most SIDE_QUESTION_MAX_MESSAGES of the most recent user/
   * assistant messages (system entries — compact separators — excluded, they
   * carry no conversational content), then the assembled string is capped to
   * SIDE_QUESTION_MAX_CONTEXT_CHARS, trimmed from the FRONT so the kept slice
   * is always the most RECENT text (matches the kickoff spec: "keep the most
   * RECENT messages").
   */
  private buildTranscriptContext(): string {
    const candidates = this.messageHistory.filter(
      (m) => m.role === 'user' || m.role === 'assistant'
    )
    const recent = candidates.slice(-SIDE_QUESTION_MAX_MESSAGES)
    const joined = recent.map((m) => formatSideQuestionContextLine(m)).join('\n\n')
    return joined.length > SIDE_QUESTION_MAX_CONTEXT_CHARS
      ? joined.slice(joined.length - SIDE_QUESTION_MAX_CONTEXT_CHARS)
      : joined
  }

  /**
   * ISession.askSideQuestion (the `/btw` command) — a question ABOUT the
   * running session ("why are you doing X"), answered from that session's own
   * recent context. pi has no in-session, non-persisting "ask" RPC (prompt/
   * steer/followUp all persist to the active branch — using one would
   * pollute the live session's history) and no equivalent of Claude's
   * in-session `side_question` control_request, so v1 uses a TRANSCRIPT-FED
   * EPHEMERAL pi process instead of a blank one:
   *
   *   1. Not connected (`this.client` unset) or no `piSessionId` yet → null,
   *      no spawn — mirrors BaseSession's default "unusable state" behavior.
   *   2. Build a bounded context string from THIS session's own retained
   *      history (`buildTranscriptContext` above) — what makes the answer
   *      grounded in the running session instead of blank.
   *   3. Spawn a brand-new, fully isolated `pi --mode rpc --no-session
   *      --no-tools --no-extensions --no-skills --no-context-files
   *      --no-prompt-templates` process — the spawn shape model-discovery.ts's
   *      `fetchPiModelCatalog` uses (locatePiLaunch, no `-e` bridge
   *      extension, no CLAUDEUI_PI_* hosted/dispatch env), PLUS the isolation
   *      flags below.
   *      TOOL EXECUTION DISABLED AT THE PROCESS LEVEL: `--no-tools` (pi
   *      usage.md:211 — "Disable all tools") means bash/edit/write are never
   *      registered for this process, so the ephemeral CANNOT mutate the live
   *      session's cwd even if the model ignores the observe-only framing —
   *      the enforced safety guarantee, not framing-dependent. This is why
   *      the ephemeral needs none of the tool-call gating PiBridgeHost
   *      provides the live session (and is simpler + strictly safer than
   *      opencode's deny-all-permission-patch approach — no bridge extension
   *      at all). A side QUESTION answers from the transcript context in
   *      text and needs no tools regardless.
   *      DISCOVERY DISABLED: pi otherwise loads the repository's own
   *      `AGENTS.md`/`CLAUDE.md` into the system prompt (usage.md:106),
   *      advertises project skills from `.pi/skills` (skills.md), and executes
   *      project extensions from `.pi/extensions` (extensions.md) — all content
   *      the very agent this ephemeral is being asked ABOUT can write. That
   *      turns "answer a question about the session" into an injection channel
   *      steering the observer's answer (or, for extensions, running code).
   *      `--no-context-files`, `--no-skills`, `--no-extensions` and
   *      `--no-prompt-templates` close them; the transcript context this
   *      feature needs is passed explicitly in the prompt, so nothing is lost.
   *      (Residual: a repo-local `.pi/SYSTEM.md`/`APPEND_SYSTEM.md` still
   *      applies — pi has no flag for it; only passing our own
   *      `--system-prompt` would displace it.)
   *      Best-effort `set_model` to this session's OWN model so
   *      the observer answers from a comparable vantage point; failure is
   *      swallowed (the ephemeral just runs with pi's own default instead).
   *      Runs fully independent of (and safely alongside) the live session's
   *      own process — separate child, separate `--no-session` (never
   *      touches the live session's file on disk).
   *   4. Sends ONE prompt: the framing message (buildSideQuestionPrompt) —
   *      explicitly tells the model it is observing, not continuing the task,
   *      and to answer directly. Waits for `agent_settled` (registered via
   *      `client.onEvent` BEFORE the prompt is sent, so a fast settle can
   *      never race ahead of the listener), then reads
   *      `get_last_assistant_text` and returns it.
   *   5. Disposes the ephemeral client exactly once (guarded by `settled`),
   *      whichever of success/failure/the bounded SIDE_QUESTION_TIMEOUT_MS
   *      overall timeout fires first. Never throws — every failure mode
   *      (binary missing, spawn error, rejected prompt, a timed-out or
   *      errored `get_last_assistant_text`) resolves null, which the UI
   *      already handles gracefully (no BtwCard answer shown).
   *
   * FIDELITY LIMITATION (honest, not a bug): the ephemeral only ever sees the
   * VISIBLE transcript already rendered into `messageHistory` — never pi's
   * internal live state (a tool call the live turn has started but not yet
   * flushed as a `message`, or the live model's hidden reasoning for the
   * CURRENT in-flight turn). A live turn's in-progress activity therefore
   * will not show up in the answer until it lands as a message. Upgrading
   * this would require pi to expose an in-session, non-persisting
   * side-question RPC (it does not, as of this writing) — tracked as a
   * follow-up, not a v1 blocker.
   */
  async askSideQuestion(question: string): Promise<string | null> {
    if (!this.client || !this.piSessionId) return null

    const launch = locatePiLaunch()
    if (!launch) return null

    const prompt = buildSideQuestionPrompt(this.buildTranscriptContext(), question)
    // `--no-tools` (pi usage.md:211 — "Disable all tools"; probed: accepted
    // cleanly in `--mode rpc --no-session`) is the ACTUAL safety guarantee —
    // see the doc comment's "TOOL EXECUTION DISABLED" note. With no tools
    // registered, bash/edit/write simply don't exist for this process, so the
    // ephemeral cannot mutate the live session's cwd regardless of whether
    // the model heeds the observe-only framing.
    //
    // The `--no-*` discovery flags close the repo-writable input paths (see the
    // doc comment's "DISCOVERY DISABLED" note). All probed accepted together in
    // `--mode rpc` against the vendored pi.
    const client = new PiRpcClient(launch, {
      cwd: this.cwd,
      args: [
        '--mode',
        'rpc',
        '--no-session',
        '--no-tools',
        '--no-extensions',
        '--no-skills',
        '--no-context-files',
        '--no-prompt-templates'
      ]
    })

    return new Promise<string | null>((resolve) => {
      let settled = false
      const finish = (value: string | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        client.dispose()
        resolve(value)
      }
      const timer = setTimeout(() => finish(null), SIDE_QUESTION_TIMEOUT_MS)

      void (async () => {
        try {
          await client.start()

          // Best-effort — point the ephemeral at the SAME model the live
          // session runs, but never let a failure here abort the ask.
          try {
            const ref = engineMeta('pi').decodeModelValue(this._model)
            await client.request({
              type: 'set_model',
              provider: ref.vendorId,
              modelId: ref.modelId
            })
          } catch {
            // best-effort — the ephemeral just runs with pi's own default model.
          }

          // Registered BEFORE sending the prompt so a fast agent_settled can
          // never race ahead of the listener (mirrors cross-engine-dispatcher's
          // drivePiTurn's identical "install the resolver, then send" ordering).
          const settledEvent = new Promise<void>((res) => {
            const unsubscribe = client.onEvent((ev) => {
              if (ev.type === 'agent_settled') {
                unsubscribe()
                res()
              }
            })
          })

          const resp = await client.request({ type: 'prompt', message: prompt })
          if (!resp.success) {
            finish(null)
            return
          }

          await settledEvent
          const textResp = await client.request<PiGetLastAssistantTextData>({
            type: 'get_last_assistant_text'
          })
          finish(textResp.success && textResp.data?.text ? textResp.data.text : null)
        } catch (err) {
          logger.debug(
            'PiSession',
            `askSideQuestion ephemeral failed (best-effort, returns null): ${err instanceof Error ? err.message : String(err)}`
          )
          finish(null)
        }
      })()
    })
  }

  // ── Approval bridge (M2a) ────────────────────────────────────────────────────

  /**
   * The actual gating decision — runs the pure PiPermissionEngine against the
   * live autonomy mode + the user's merged Claude permission rules;
   * 'allow'/'deny' answer immediately, 'ask' goes to the auto-mode classifier
   * (when auto mode is active) and otherwise surfaces a
   * `session:approval-request` and awaits the human via resolveApproval().
   * Wrapped by the public `gateToolCall` field below (SECURITY, A1) — this
   * inner fn only decides; it never mints a hosted-tool grant itself.
   *
   * AUTO MODE'S BASE (phase 4, mirrors OpencodeSession.applyPermissionMode's
   * `const baseMode = this.isAutoMode(mode) ? 'acceptEdits' : mode`): with the
   * classifier active, the mode BASE fed to the engine is `acceptEdits`, not
   * `auto`. Without this the wiring would be dead code — `modeBaseDecision`
   * answers 'allow' for every kind under `auto`/`full`, so nothing except a
   * user-authored ask rule could ever reach the branch below, and those go
   * straight to the human by G9. The downgrade is what routes bash/dispatch/
   * unknown-kind calls into the judge while reads and edits stay auto-allowed
   * (cli.js's fast-path-A equivalence). With auto mode DISABLED, `auto` keeps
   * its historical allow-everything base — there would be no classifier to
   * compensate for a tightening.
   *
   * AUTO MODE'S RULES (cli.js §3 step 2 parity): the user's ALLOW rules are
   * filtered out of what the engine decides on, so the actions they would have
   * silently auto-allowed fall through to the `acceptEdits` base's 'ask' and
   * reach the classifier instead of bypassing it. Applied HERE, at the
   * composition seam, rather than inside the pure ladder — see
   * `withoutAllowRules` for the full reasoning, the live evasion that motivated
   * it, and why this leaves G9's `source: 'ask-rule'` provenance exact (deny and
   * ask are both evaluated before the allow tier, so filtering the allow tier
   * cannot change which of them answers).
   */
  private gateToolCallInner = (payload: PiToolCallPayload): Promise<GateDecision> =>
    this.decideToolCall(payload, null)

  /**
   * The gate for a host-run subagent's tool call (ADR-088 D2): the SAME ladder
   * as the session's own calls (`decideToolCall`), parametrized by the child
   * scope — the parent's LIVE mode narrowed by the definition (D3), the
   * parent's rules and session allows, and the judge with the child's own
   * trajectory, outcomes and denial caps.
   */
  gateChild(scope: PiChildScope, payload: PiToolCallPayload): Promise<GateDecision> {
    return this.decideToolCall(payload, scope)
  }

  /**
   * The one gate ladder (gateToolCallInner's body, shared with `gateChild`).
   * `scope` null = this session's own call, byte-identical to before ADR-088.
   * With a scope the mode is `narrowMode(parent mode, definition mode)`, read
   * on EVERY call (live, owner ruling 1), and every deny reason uses it where
   * the session's own call reads `this.permissionMode`.
   */
  private async decideToolCall(
    payload: PiToolCallPayload,
    scope: PiChildScope | null
  ): Promise<GateDecision> {
    const { toolName, input } = payload
    const mode = this.gateMode(scope)
    const rules = this.currentRules()
    const autoMode = this.isAutoMode(mode)
    const verdict = decideWithSource(toolName, input, {
      mode: autoMode ? 'acceptEdits' : mode,
      rules: autoMode ? withoutAllowRules(rules) : rules,
      sessionAllows: this.sessionAllows,
      cwd: this.cwd
    })

    // Spawn-call rung (ADR-088 Q1, Claude Code parity): launching an agent
    // needs no card in any non-auto mode, plan included — every action the
    // child takes is gated by this same live mode anyway. After the deny-rule
    // check, before the mode base. In auto mode it falls through: the `task`
    // kind under the `acceptEdits` base asks, and the judge decides.
    // (The deny-rule guard cannot fire yet: no rule row maps Agent/Task to a
    // pi kind — permission-engine.ts CLAUDE_TOOL_TO_KIND.)
    // `send_message` takes the same rung (ADR-088 S3b, Q6): a message that
    // resumes or redirects an agent is delegation, judged like a spawn in auto.
    // (As above, the deny-rule guard cannot fire yet: no rule row maps a
    // Claude tool to the `detail`/`note` kinds these two tools carry.)
    if (
      (toolName === 'agent' || toolName === 'send_message') &&
      !autoMode &&
      verdict.source !== 'deny-rule'
    ) {
      return { behavior: 'allow' }
    }
    // `task_stop` only stops work: allowed in every mode, auto included, with
    // no judge call (Q6). Who may stop whom is the manager's check.
    if (toolName === 'task_stop' && verdict.source !== 'deny-rule') {
      return { behavior: 'allow' }
    }

    const decision = verdict.decision

    if (decision === 'allow') return { behavior: 'allow' }

    if (decision === 'deny') {
      if (verdict.source === 'deny-rule' && verdict.rule) {
        return { behavior: 'deny', reason: `Denied by permission rule: ${verdict.rule}` }
      }
      // exit_plan OUTSIDE plan mode (M5a addendum): registerTool
      // auto-activates the tool, so the model can see/call exit_plan in any
      // mode until the extension's session_start hook hides it —
      // modeBaseDecision denies it and this attaches the distinct,
      // model-actionable reason (there is no plan mode to exit).
      if (piToolKind(toolName) === 'plan' && mode !== 'plan') {
        return { behavior: 'deny', reason: PLAN_EXIT_OUTSIDE_PLAN_REASON }
      }
      // Plan mode's own base denies (a mutating kind, or an unsafe bash
      // command — permission-engine.ts's planModeBaseDecision) carry a
      // distinct, model-actionable reason instead of the generic fallback
      // below — still beaten by an explicit user deny RULE, checked above.
      if (mode === 'plan') {
        return { behavior: 'deny', reason: PLAN_MODE_DENY_REASON }
      }
      return { behavior: 'deny', reason: 'Denied by permission rules' }
    }

    // 'ask' — in auto mode the classifier gets first refusal; anything it
    // cannot decide falls through to the human below, optionally explaining why
    // (the denial caps do).
    if (autoMode) {
      const auto = await this.classifyAutoMode(payload, verdict, scope)
      if (auto.kind === 'decided') return auto.decision
      return this.askHuman(payload, auto.reason, scope)
    }

    return this.askHuman(payload, undefined, scope)
  }

  /** The mode a call is gated under: the session's, narrowed for a child (ADR-088 D3). */
  private gateMode(scope: PiChildScope | null): string {
    return scope
      ? narrowMode(this.permissionMode, scope.definition.permissionMode)
      : this.permissionMode
  }

  /**
   * Surface a `session:approval-request` and park until `resolveApproval()`
   * answers it. Extracted from gateToolCallInner so auto mode's several
   * "fall back to the human" exits all land on the SAME path (ADR-023's
   * `fallbackToHuman`).
   *
   * `decisionReason` is the one-line explanation the approval card renders
   * above the buttons (ApprovalButtons / FloatingApproval read
   * `PendingApproval.decisionReason`) — set on the denial-cap handoffs, where
   * "auto mode gave up on this" is not otherwise visible.
   */
  private askHuman(
    payload: PiToolCallPayload,
    decisionReason?: string,
    scope: PiChildScope | null = null
  ): Promise<GateDecision> {
    const { toolCallId, toolName, input } = payload
    return new Promise<GateDecision>((resolve) => {
      const requestId = uuid()
      // A child's card (ADR-088) is raised under THIS session with the
      // child's own call id: it renders floating and on the nested card.
      this.pendingGates.set(requestId, {
        resolve,
        toolName,
        input,
        toolCallId,
        outcomes: scope ? scope.outcomes : this.toolOutcomes,
        scope
      })
      const suggestions = this.buildApprovalSuggestions(toolName, input)
      const approval: PendingApproval = {
        requestId,
        toolUseId: toolCallId,
        toolName,
        input,
        // ADR-088 review F4: a child's card names the agent whose action it is.
        ...(scope
          ? {
              agent: {
                agentId: scope.agentId,
                label: scope.label,
                subagentType: scope.definition.name
              }
            }
          : {}),
        ...(suggestions ? { suggestions } : {}),
        ...(decisionReason ? { decisionReason } : {})
      }
      this.send('session:approval-request', approval)
    })
  }

  /**
   * Handler passed to PiBridgeHost — invoked once per `tool_call` hook firing
   * in the pi child. Bound as a class field (not a prototype method) so
   * passing a bare reference to `new PiBridgeHost(this.gateToolCall)` keeps
   * `this` correct.
   *
   * SECURITY (A1): wraps gateToolCallInner's decision and, iff it allowed a
   * name in PI_HOSTED_TOOL_NAMES, mints a one-shot `/hosted-tool` execution
   * grant for this EXACT `toolCallId` + `toolName` — the ONLY seam that ever
   * populates hostedGrants, covering both the immediate-allow path and the
   * human-approved 'ask' path (resolveApproval's `pending.resolve()` below
   * resumes the awaited promise gateToolCallInner returned, which resolves
   * right back through here before the caller ever sees it). See
   * handleHostedTool for the consuming side.
   *
   * SECURITY (abandonment race): the decision can land AFTER PiBridgeHost gave
   * up on the exchange — an auto-mode judge takes tens of seconds and has no
   * `pendingGates` entry for `handleBridgeAbandoned` to force-deny, so nothing
   * else stops this wrapper from minting a grant for a `toolCallId` pi already
   * failed closed. The host itself drops such a late result, but the GRANT
   * would survive as a live one-shot `/hosted-tool` ticket usable by anything
   * holding the bearer token (which sits in the pi child's env, reachable from
   * any already-approved shell command). Hence the
   * {@link recentlyAbandonedToolCallIds} check below.
   */
  private gateToolCall = async (payload: PiToolCallPayload): Promise<GateDecision> => {
    const decision = await this.gateToolCallInner(payload)
    if (decision.behavior === 'allow' && PI_HOSTED_TOOL_NAMES.has(payload.toolName)) {
      // A withheld mint (false) means this exact exchange was abandoned, so
      // the allow is authority for a call pi will never make. A LATER
      // exchange that legitimately reuses the id is unaffected. The decision
      // itself is still returned unchanged — only the grant is withheld.
      if (!this.hostedGrants.mint(payload.toolCallId, payload.toolName)) {
        logger.debug(
          'PiSession',
          `withholding the hosted-tool grant for ${payload.toolName} (${payload.toolCallId}) — pi abandoned that exchange before the gate resolved`
        )
      }
    }
    return decision
  }

  /**
   * Resolve every in-flight 'ask' gate with a deny (used by interrupt/cancel/
   * an unexpected exit) and clear the map. Also clears hostedGrants — a grant
   * minted for a turn that's being torn down must not survive it (e.g. a
   * cancel racing an in-flight `/hosted-tool` POST).
   */
  private rejectAllPendingGates(reason: string): void {
    for (const pending of this.pendingGates.values()) {
      pending.resolve({ behavior: 'deny', reason })
    }
    this.pendingGates.clear()
    this.hostedGrants.clear()
  }

  /**
   * interrupt()'s twin of {@link rejectAllPendingGates}: only the session's
   * OWN cards (`scope === null`) are denied; host-run children's cards are
   * left to their own stop (ADR-088 S3, Q9). hostedGrants (the session's own)
   * are cleared as before.
   */
  private rejectOwnPendingGates(reason: string): void {
    for (const [requestId, pending] of [...this.pendingGates]) {
      if (pending.scope !== null) continue
      this.pendingGates.delete(requestId)
      pending.resolve({ behavior: 'deny', reason })
    }
    this.hostedGrants.clear()
  }

  /**
   * PiBridgeHost's `onAbandoned` (its "Long-poll protocol" section): the pi
   * child stopped polling a bridge exchange, so nothing on the other side is
   * waiting for our answer any more. Bound as a class field so a bare
   * reference can be handed to the constructor.
   *
   * Without this the abandonment was invisible: the approval card stayed on
   * screen and a late click resolved a promise whose response socket was
   * already dead (Node no-ops the write), gateToolCall still minted a
   * `hostedGrants` entry for a toolCallId pi had already failed, and a
   * dispatched child kept running — and spending — with no consumer.
   */
  private handleBridgeAbandoned = (info: PiBridgeAbandoned): void => {
    if (info.route === 'tool-call') {
      const requestId = this.retractPendingGate(info.toolCallId)
      // Auto-mode ground truth: the call never ran and nobody refused it. pi
      // reports it as a failed tool moments from now; `unanswered` is a
      // sticky decision outcome so that `error` cannot overwrite it, and the
      // judge reads a re-attempt as a fresh proposal rather than a retry of a
      // denied one (Transient Retry stays available).
      this.recordToolOutcome(info.toolCallId, 'unanswered')
      // A grant minted for this call (the allow may have landed just as pi
      // gave up) must not survive as a usable /hosted-tool ticket, and one
      // that has NOT been minted yet must never be: an auto-mode-judged call
      // has no pendingGates entry to force-deny above, so its 'allow' can
      // arrive seconds from now, after the host already dropped the exchange
      // (see `hostedGrants`).
      this.hostedGrants.abandon(info.toolCallId)
      logger.warn(
        'PiSession',
        `pi abandoned the /tool-call gate for ${info.toolName} (${info.toolCallId})` +
          (requestId !== null ? ' — dismissed its approval card' : '')
      )
      return
    }

    if (this.inFlightDispatchIds.has(info.toolCallId)) {
      // The same call interrupt() and TaskCard's Stop button make — the child
      // has no consumer left, so letting it run would only burn tokens.
      crossEngineDispatcher.stopDispatch(info.toolCallId, this.routingId)
    }
    // A host-run subagent (ADR-088) whose `agent` exchange pi stopped
    // waiting for has no consumer either.
    if (info.toolName === 'agent') this.subagents.stop(info.toolCallId, 'interrupt')
    logger.warn(
      'PiSession',
      `pi abandoned the /hosted-tool call for ${info.toolName} (${info.toolCallId})`
    )
  }

  /**
   * Force-deny and retract the approval card parked for `toolCallId`, if any
   * (pi stopped polling its `/tool-call` exchange). pendingGates is keyed by
   * requestId, so the entry is found by its toolCallId; resolving it (rather
   * than just dropping it) is what releases whatever gate promise is still
   * awaited. Shared by the session's own bridge and its subagents' (ADR-088).
   * Returns the retracted requestId, or null.
   */
  private retractPendingGate(toolCallId: string): string | null {
    for (const [requestId, pending] of this.pendingGates) {
      if (pending.toolCallId === toolCallId) {
        this.retractGate(requestId, 'pi stopped waiting for this approval')
        return requestId
      }
    }
    return null
  }

  /**
   * A host-run child was stopped (ADR-088): every card it still has open is
   * retracted and its gate denied 'Agent stopped'.
   */
  private retractChildGates(scope: PiChildScope): void {
    for (const [requestId, pending] of [...this.pendingGates]) {
      if (pending.scope === scope) this.retractGate(requestId, 'Agent stopped')
    }
  }

  /** Deny one parked gate and retract its card. */
  private retractGate(requestId: string, reason: string): void {
    const pending = this.pendingGates.get(requestId)
    if (!pending) return
    this.pendingGates.delete(requestId)
    pending.resolve({ behavior: 'deny', reason })
    // Same channel claude/opencode use to retract an approval the user can
    // no longer usefully answer.
    this.send('session:approval-dismiss', { requestId })
  }

  /** Lazily load (and cache) the merged user/project/local Claude permission rules for this session's cwd. */
  private currentRules(): MergedClaudeRules {
    if (!this.cachedRules) this.cachedRules = mergedClaudeRulesFor(this.cwd)
    return this.cachedRules
  }

  /**
   * Build "always allow" suggestions for an 'ask' approval — mirrors the
   * opencode event-mapper's permission.asked suggestion shape (one
   * PermissionSuggestion per destination) but offers ALL three persistable
   * scopes (user/project/local) rather than opencode's single default, giving
   * the user the same 3-way choice Claude's native prompts do. bash gets a
   * PREFIX rule (`Bash(<command>:*)` — the whole typed command plus a
   * trailing glob, matching Claude's own suggestion convention and round-
   * tripping through permission-engine.ts's bash prefix matcher); every other
   * mapped tool gets a bare tool rule. Returns undefined for a pi tool with no
   * Claude analog (mcp/custom/unknown) — nothing persistable to suggest.
   */
  private buildApprovalSuggestions(
    toolName: string,
    input: Record<string, unknown>
  ): PermissionSuggestion[] | undefined {
    const claudeTool = PI_TOOL_TO_CLAUDE_TOOL[toolName]
    if (!claudeTool) return undefined

    const ruleContent =
      toolName === 'bash' ? `${normalizeWhitespace(String(input.command ?? ''))}:*` : undefined
    const rule = { toolName: claudeTool, ...(ruleContent ? { ruleContent } : {}) }

    const destinations = ['userSettings', 'projectSettings', 'localSettings'] as const
    return destinations.map((destination) => ({
      type: 'addRules',
      behavior: 'allow',
      destination,
      rules: [rule]
    }))
  }

  /**
   * Resolve a pending 'ask' gate — the human's continuation choice from the
   * renderer (e.g. ExitPlanModeCard's four buttons, all of which route
   * through `session:approval-response` → here; see
   * src/renderer/src/components/chat/ExitPlanModeCard/ExitPlanModeCard.tsx).
   *
   * exit_plan (M5a) contract, discovered by reading ExitPlanModeCard.tsx +
   * its utils.ts: "Start fresh" and "Keep planning" both call
   * respondApproval(…, 'deny') — "Start fresh" additionally cancels this
   * WHOLE session and spins up a brand-new one, so what happens to THIS
   * session's gate/extension state is moot; "Keep planning" sends
   * `{feedback}` as the deny reason so the model sees it and drafts again.
   * "Continue, auto-accept edits" / "Continue, approve manually" both call
   * respondApproval(…, 'allow') and ONLY AFTER that resolves + a
   * waitForModeChange() broadcast — see below — do they separately call
   * `window.api.setPermissionMode(sessionId, 'acceptEdits'|'default')`; the
   * two buttons are indistinguishable at THIS layer (no answers field
   * encodes which one was clicked) — the continuation mode is carried
   * entirely by that SEPARATE, later setPermissionMode IPC call, not by
   * anything passed into resolveApproval.
   */
  resolveApproval(
    requestId: string,
    decision: ApprovalDecision,
    answers?: Record<string, string>,
    updatedPermissions?: PermissionSuggestion[]
  ): void {
    const pending = this.pendingGates.get(requestId)
    if (!pending) {
      logger.warn('PiSession', `resolveApproval(${requestId}) called but no matching pending gate`)
      return
    }
    this.pendingGates.delete(requestId)

    if (decision === 'deny') {
      // Auto-mode ground truth: a HUMAN refusal is the strongest signal the
      // judge can get — it makes the Transient Retry exception inapplicable to
      // a re-attempt and turns the retry into a consent question. Only a reject
      // maps here; an allow leaves the call to report its own ok/error.
      recordToolOutcome(pending.outcomes, pending.toolCallId, 'rejected-by-user')
      pending.resolve({ behavior: 'deny', reason: answers?.feedback || 'User denied' })
      return
    }

    // allow / allowForSession
    if (decision === 'allowForSession') {
      this.sessionAllows.add(sessionAllowKey(pending.toolName, pending.input))
    }
    pending.resolve({ behavior: 'allow' })

    // exit_plan (M5a): emulate the Claude SDK's own documented behavior
    // (ported note, ExitPlanModeCard/utils.ts: "When ExitPlanMode is
    // allowed, the SDK sends a status change back to 'default'") — the
    // bridge extension's exit_plan.execute() (which pi runs right after this
    // 'allow' resolves the tool_call gate) already restores the tool set
    // LOCALLY, so this deliberately does NOT send `/cui-plan-exit` — that
    // would be a redundant round-trip. It's still harmless if it somehow
    // did: setPermissionMode's own `mode === prevMode` / `prevMode ===
    // 'plan'` checks mean the renderer's FOLLOW-UP setPermissionMode call
    // (fired after waitForModeChange() observes this broadcast) sees
    // `prevMode` already 'default', not 'plan', and skips re-sending exit.
    if (pending.toolName === 'exit_plan') {
      this.permissionMode = 'default'
      this.send('session:permission-mode', 'default')
    }

    if (updatedPermissions && updatedPermissions.length > 0) {
      this.persistAllowRules(updatedPermissions)
    }
  }

  /**
   * Write "always allow" suggestions to the shared Claude permission store (the
   * one copy lives in permission-compiler.ts) and invalidate the rules cache so
   * the newly-persisted rule is honored on the VERY NEXT gate call in this same
   * session, without waiting for an explicit notifySettingsChanged().
   */
  private persistAllowRules(suggestions: PermissionSuggestion[]): void {
    if (persistAllowSuggestions(suggestions, this.cwd, 'PiSession')) this.cachedRules = null
  }

  /** Hot-reload parity with Claude: invalidate the cached rules so the NEXT gate call re-reads the (just-edited) permission files from disk. */
  async notifySettingsChanged(): Promise<void> {
    this.cachedRules = null
  }

  // ── Auto mode (`auto`/`full`) LLM gatekeeper ─────────────────────────────────
  // Phase 4 of docs/automode-rework-plan.md. The POLICY is engine-neutral
  // (src/core/automode/) and shared verbatim with opencode, and so is the judge
  // transport since ADR-081 (automode/session-judge.ts: ClaudeUI calls the judge
  // model itself). Only two seams below are pi's own: the permission intercept
  // (gateToolCallInner's 'ask' branch) and the ground-truth capture points.
  // This block deliberately mirrors OpencodeSession's equivalents
  // method-for-method so the two wirings stay comparable.

  /** `engines/pi.json#autoMode`, memoized for the session's lifetime (a
   *  mid-session config edit is not hot-reloaded — same as opencode). */
  private autoModeConfig(): AutoModeConfig {
    if (this._autoModeConfig === undefined) {
      try {
        this._autoModeConfig = loadEngineConfig('pi').autoMode ?? {}
      } catch {
        this._autoModeConfig = {}
      }
    }
    return this._autoModeConfig
  }

  /** The engine-shared trust lists, DERIVED into this session's classifier
   *  environment at session start (ADR-065 § Shared trust lists). One file for
   *  every engine, so they are read from there rather than from
   *  `autoModeConfig()`, which is pi's own judge block. */
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

  /** Auto mode is active for `auto`/`full` autonomy unless explicitly disabled. */
  private isAutoMode(mode: string): boolean {
    return (mode === 'full' || mode === 'auto') && this.autoModeConfig().enabled !== false
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
   *  (ADR-083 §3/§4). What the judge is told is
   *  {@link buildClassifierEnvironment}'s job, shared with opencode; this
   *  method only gathers the inputs. The trust and guidance lists come from the
   *  engine-SHARED `~/.claude/ui/automode.json` (read once per session); the
   *  user's permission rules are the SAME `currentRules()` the permission
   *  engine decides with, so the judge and the engine never disagree about what
   *  the rules say — including across a `cachedRules` invalidation.
   *
   *  pi has no `additionalDirectories` enforcement of its own
   *  (permission-engine.ts documents the deliberate deferral), but the user's
   *  configured list is still the honest answer to "which directories did the
   *  user grant?", so it is reported to the judge exactly as opencode reports
   *  it. */
  private async classifierEnvironment(): Promise<EnvironmentInfo> {
    const remotes = await this.sessionGitRemotes()
    return buildClassifierEnvironment({
      cwd: this.cwd,
      platform: process.platform,
      remotes,
      repoVisibility: this.sessionRepoVisibility,
      permissions: this.currentRules(),
      shared: this.sharedAutoModeConfig()
    })
  }

  /** Per-ACTION measured ground truth → the classifier's `{"meta":{…}}` line
   *  (ref §5). Only shell-like actions qualify (`shellCommandOf` already knows
   *  pi's `bash`), only the command shapes the reference names trigger a
   *  capture, and a capture that fails contributes NOTHING — a fabricated
   *  `{"clean":true}` would clear the policy's dirty-tree presumption on no
   *  evidence. */
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
      additionalDirectories: this.currentRules().additionalDirectories
    })
    if (redirects) meta.redirects = redirects
    // ADR-084 §2 — repo-local git config that makes git run a program. pi's
    // bash always runs in the session cwd (it has no `workdir`). Only a
    // non-empty list is emitted: `[]` (clean) and `null` (not measured) both
    // say nothing, per this method's rule that absence is never "fine".
    if (hasGitSegment(command)) {
      const runIn = effectiveShellCwd(this.cwd, input, false)
      const armed = runIn === null ? null : await captureGitConfigArmed(runIn)
      if (armed && armed.length > 0) meta.gitConfigArmed = armed
    }
    return Object.keys(meta).length > 0 ? meta : undefined
  }

  /** One banner per session, whatever made the configured judge model unusable. */
  private reportStaleJudgeModel(configured: string): void {
    if (this.staleJudgeModelReported) return
    this.staleJudgeModelReported = true
    this.send(
      'session:error',
      `Auto-mode judge model "${configured}" is no longer available — every gated action will ask you instead. ` +
        `Change it in Settings › Sessions & autonomy › Auto-mode judge (pi).`
    )
  }

  /**
   * True when `autoMode.judgeModel` names a model pi's catalog no longer has.
   *
   * Fail-closed: the caller drops to the human instead of judging with a
   * substitute, and specifically instead of falling through to
   * `?? this._model` — silently promoting the SESSION's model to security judge
   * is not what "I picked a cheaper/stronger judge" asked for.
   *
   * `discoverPiModels()` rather than a cache-only peek because pi has no groups
   * cache until someone calls it; the underlying catalog fetch is already warm
   * from `resolveCapsForModel` at connect, so this costs a regroup, not a spawn.
   * An EMPTY catalog (no auth / probe failed) validates nothing and passes
   * through — it cannot tell "removed" from "never discovered".
   */
  private async judgeModelUnavailable(): Promise<boolean> {
    const configured = this.autoModeConfig().judgeModel
    if (!configured) return false
    let values: string[] = []
    try {
      values = (await discoverPiModels()).flatMap((g) => g.models.map((m) => m.value))
    } catch {
      return false
    }
    if (values.length === 0) return false
    if (values.includes(configured)) return false
    this.reportStaleJudgeModel(configured)
    return true
  }

  /** One banner per session for a judge model ClaudeUI can't call (ADR-081 §3). */
  private reportJudgeRouteUnavailable(reason: string): void {
    if (this.judgeRouteUnavailableReported) return
    this.judgeRouteUnavailableReported = true
    this.send('session:error', judgeRouteUnavailableMessage('pi', reason))
  }

  /**
   * The judge transport: ClaudeUI's own HTTP call to the judge model (ADR-081)
   * — no second pi process, so the judge prompt is exactly the policy, the
   * stage budgets and stop sequence apply, and the call's usage lands on the
   * ledger as a `judge` row under this session. Stateless: nothing to dispose.
   *
   * Judge model = `autoMode.judgeModel` or this session's own, resolved per
   * call, so a live `setModel()` applies to the next judge call. A model no
   * ClaudeUI route covers is not judged by anyone else: the call fails,
   * `classify()` returns unavailable, the human decides, and the session says
   * why once.
   */
  private judgeTransport(): JudgeTransport {
    return makeSessionJudgeTransport({
      engine: 'pi',
      modelValue: () => this.autoModeConfig().judgeModel ?? this._model,
      sessionId: () => this.piSessionId,
      routingId: this.routingId,
      onUnavailable: (reason) => this.reportJudgeRouteUnavailable(reason)
    })
  }

  /**
   * Classify one would-be-`ask` tool call. Returns the decision to send pi, or
   * an `ask-human` outcome — every uncertain path (user ask rule, judge
   * unavailable, denial cap, mode changed, thrown error) funnels through that
   * one shape. Its optional `decisionReason` rides the approval card (see
   * {@link askHuman}); only the denial caps set it, because "auto mode gave up
   * on this action" is not otherwise visible to the user.
   *
   * G9 is pi's own (the one place pi does better than opencode); every step
   * after it is the shared {@link runJudgePipeline} (ADR-087).
   */
  private async classifyAutoMode(
    payload: PiToolCallPayload,
    verdict: PermissionVerdict,
    scope: PiChildScope | null = null
  ): Promise<AutoModeOutcome> {
    const { toolCallId, toolName, input } = payload

    // G9 — an explicit USER-authored `ask` rule outranks the classifier (ref §3
    // step 1 / porting note #1): auto mode must not become a permission
    // DOWNGRADE for exactly the actions the user singled out. NATIVE here —
    // PiPermissionEngine is ours, so `verdict.source` is the evaluator's own
    // answer rather than opencode's host-side re-match of a discarded rule.
    // Checked before the fast path: an ask the user wrote on `read` must still
    // reach them. Zero judge calls on a match.
    if (verdict.source === 'ask-rule') {
      logger.info(
        'PiSession',
        `auto-mode → human: user ask rule matches ${toolName} (${verdict.rule})`
      )
      return ASK_HUMAN
    }

    // Everything after G9 is the shared pipeline (automode/judge-pipeline.ts,
    // ADR-087), with pi's hooks. Notes specific to pi:
    //
    // G8, ANSWERED FOR pi (plan §7 Q2): pi's ask path does NOT fire for
    // read/grep/find/ls under auto mode, so the pipeline's category fast path
    // is defense in depth rather than a hot path. Verified by reading the
    // evaluator rather than inheriting opencode's argument: with auto mode
    // active the base is `acceptEdits` (see gateToolCallInner), whose
    // `modeBaseDecision` allows fileRead and search outright; the only other
    // route to 'ask' for those kinds is a user ask rule, which G9 above has
    // already sent to the human. Note also that the shared allowlist speaks
    // opencode's category vocabulary (`glob`/`list`), so pi's `find`/`ls` would
    // not match it anyway — left alone deliberately: widening a SHARED allow set
    // to cover a path that cannot be reached would be risk with no benefit.
    //
    // ADR-084 §1 read-only gate: pi's `bash` has no `workdir` — it runs in the
    // session cwd — so the gate refuses an input that carries one
    // (`honoursWorkdir: false`). `currentRules()` is the ruleset the permission
    // engine just decided with, deny rules included; the ADR-085 §4 allow-rule
    // gate reads it in FULL (only the ladder's copy had its allow rules
    // stripped by `withoutAllowRules`).
    //
    // A host-run subagent's call (ADR-088 D2.4) changes only what is the
    // child's: its header (`subagent`), its transcript — this session's (the
    // ROOT, whose human turns are the only real authorisation) followed by
    // the acting child's own assistant-only trajectory (D1; an intermediate
    // agent's trajectory is not included: its prompts to the child are
    // agent-authored, and the acting child's own calls are what is being
    // judged) — its outcomes and denial caps, its narrowed live mode (G10
    // re-reads it), and `stillPending` (a stopped or draining child). With no
    // scope every hook is exactly what it was before ADR-088.
    const childHooks = scope
      ? {
          subagent: {
            type: scope.definition.name,
            description: scope.description,
            prompt: scope.prompt
          },
          messages: (): ChatMessage[] => [
            ...this.messageHistory,
            ...(scope.runner()?.trajectory.values() ?? [])
          ],
          outcomes: () => (scope.outcomes.size ? Object.fromEntries(scope.outcomes) : undefined),
          recordOutcome: (id: string, result: ToolOutcome) =>
            recordToolOutcome(scope.outcomes, id, result),
          denials: scope.denials,
          stillPending: () => !scope.stopped && !(scope.runner()?.draining ?? true)
        }
      : null
    const outcome = await runJudgePipeline(
      { toolUseId: toolCallId, toolName, input },
      {
        logSource: 'PiSession',
        cwd: this.cwd,
        currentMode: () => this.gateMode(scope),
        autoModeActive: () => this.isAutoMode(this.gateMode(scope)),
        permissions: () => this.currentRules(),
        honoursWorkdir: false,
        allowRuleAction: allowRuleActionFor,
        // A configured judge model that no longer exists fails CLOSED — never
        // judged by a stand-in (see judgeModelUnavailable).
        judgeAvailable: async () => !(await this.judgeModelUnavailable()),
        judgeTransport: () => this.judgeTransport(),
        messages: () => this.messageHistory,
        environment: () => this.classifierEnvironment(),
        captureActionMeta: (name, args) => this.captureActionMeta(name, args),
        outcomes: () =>
          this.toolOutcomes.size ? Object.fromEntries(this.toolOutcomes) : undefined,
        recordOutcome: (id, result) => this.recordToolOutcome(id, result),
        denials: this.autoDenials,
        twoStageMode: () => this.autoModeConfig().twoStageMode ?? 'both',
        sendReview: (id, review) => this.sendToolReview(id, review),
        ...childHooks
      }
    )
    switch (outcome.kind) {
      case 'allow':
        return decided({ behavior: 'allow' })
      case 'deny':
        return decided({ behavior: 'deny', reason: outcome.reason })
      case 'human':
        return outcome.reason ? { kind: 'human', reason: outcome.reason } : ASK_HUMAN
      case 'settled':
        // A host-run subagent was stopped (or is draining) while its call was
        // judged (ADR-088): refuse. For the session's own call this stays
        // unreachable — no `stillPending` hook is passed (pi's gate is a
        // single awaited HTTP request — nothing answers the call elsewhere
        // while it is judged) — and fail-safe: ask the human.
        return scope ? decided({ behavior: 'deny', reason: 'Agent stopped' }) : ASK_HUMAN
    }
  }

  /**
   * The judge's verdict on the card it judged (F18).
   *
   * `toolCallId` is pi's own call id, which is EXACTLY the `toolUseId` the
   * transcript's `tool_use` block carries (`event-mapper.ts` maps
   * `toolCall → tool_use { toolUseId: id }`), so the reducer binds it to the
   * right card. No hold is needed the way Codex needs one: the assistant
   * `message_end` that mints the block precedes `tool_execution_*` on pi's own
   * verified event order, and the judge round-trip that produced this verdict
   * sits on top of that.
   *
   * Only a real verdict reaches here — a fast-path allow returns before the
   * judge, an `unavailable` result and a denial cap both return ASK_HUMAN, and
   * the human's approval card carries its own reason — plus `'read-only'`, the
   * static path's fixed review (ADR-084 §1), and `{ allowRule }`, the
   * allow-rule skip's (ADR-085 §4).
   */
  private sendToolReview(
    toolCallId: string,
    result: ClassifyResult | 'read-only' | { allowRule: string }
  ): void {
    const reviewId = uuid()
    this.send('session:tool-review', {
      toolUseId: toolCallId,
      review:
        result === 'read-only'
          ? readOnlyReviewBlock(toolCallId, reviewId)
          : 'allowRule' in result
            ? allowRuleReviewBlock(toolCallId, reviewId, result.allowRule)
            : autoModeReviewBlock(toolCallId, reviewId, result)
    })
  }

  // ── Hosted tools + cross-engine dispatch (M4a+b) ─────────────────────────────

  /**
   * Handler passed to PiBridgeHost as the SECOND (hosted-tool) constructor
   * arg — invoked once per `POST /hosted-tool`.
   *
   * SECURITY (A1): the FIRST thing this does is require a matching one-shot
   * grant in `hostedGrants` — `toolCallId -> toolName` minted by gateToolCall
   * ONLY when `/tool-call` (permission-engine.ts's PI_AUTO_ALLOW_HOSTED_TOOLS
   * / mode-base ladder) already decided 'allow' for this exact call. Without
   * this check, the bearer token alone gated `/hosted-tool` — and that token
   * lives in the pi child's env, reachable from any already-approved bash
   * command, bypassing dispatch_agent's deliberate 'ask' gating entirely
   * (verified — pi's tool_call hook fires for registered tools too, but
   * nothing stops a direct POST that skips it). A present-but-mismatched
   * grant (e.g. granted for render_mermaid, executed as dispatch_agent with
   * the same toolCallId) fails closed identically to an absent one. The
   * grant is consumed (deleted) on the FIRST matching lookup — a second
   * execute() with the same toolCallId fails closed too, even though pi
   * itself would never legitimately send one.
   *
   * render_mermaid/create_mockup/show_mockup delegate to the SAME in-process
   * MCP tool handlers Claude/opencode use (mermaid-tool.ts/mockup-tool.ts —
   * extracting `.tools[].handler`, exactly like opencode-hosted-tools.ts's
   * reuse pattern) and pass their `{content, isError?}` result through
   * verbatim. Mockups land under `this.cwd`/.claude/ui/mockups — parity with
   * Claude/opencode (createMockupServer bakes `cwd` into its returned
   * server's mockupsRoot at construction time, so cwd MUST be `this.cwd`).
   */
  private handleHostedTool: PiHostedToolHandler = async (
    payload: PiHostedToolPayload
  ): Promise<PiHostedToolResult> => {
    const { toolName, input, toolCallId } = payload

    // One-shot — consumed on first (matching) use.
    if (!this.hostedGrants.consume(toolCallId, toolName)) return notApprovedHostedTool()

    switch (toolName) {
      case 'render_mermaid': {
        if (!this.mermaidServer) this.mermaidServer = createMermaidServer()
        const tool = this.mermaidServer.tools.find((t) => t.name === 'render_mermaid')
        if (!tool) return unknownHostedTool(toolName)
        return (await tool.handler(input, undefined)) as unknown as PiHostedToolResult
      }

      case 'create_mockup':
      case 'show_mockup': {
        // NOT memoized (unlike the mermaid server above) — createMockupServer's
        // only per-instance state is the mockupsRoot path derived from
        // `this.cwd`, which never changes mid-session; re-deriving it per call
        // is cheap (a couple of `join()` calls) and avoids caching a stale
        // server if `this.cwd` were ever to matter differently across calls.
        const server = createMockupServer(this.cwd)
        const tool = server.tools.find((t) => t.name === toolName)
        if (!tool) return unknownHostedTool(toolName)
        return (await tool.handler(input, undefined)) as unknown as PiHostedToolResult
      }

      case 'dispatch_agent':
        return this.handleDispatchAgent(input, toolCallId)

      // Host-run subagents (ADR-088): this session is the parent (depth 0).
      case 'agent':
        return this.subagents.run(input, toolCallId, null)
      // ADR-088 S3b: messaging and stopping, as the session (caller null).
      case 'send_message':
        return this.subagents.sendMessage(input, null)
      case 'task_stop':
        return this.subagents.taskStop(input, null)

      default:
        return unknownHostedTool(toolName)
    }
  }

  /**
   * dispatch_agent (M4b, ADR-033) — pi as a dispatch SOURCE (this method).
   * pi as a dispatch TARGET is handled separately, in
   * cross-engine-dispatcher.ts's `gatePiTargetToolCall` (M4c, shipped);
   * same-engine (pi→pi) dispatch still stays rejected regardless of which
   * side initiates — the dispatcher's own engine guard rejects 'pi' as
   * `req.engine` here. Mirrors collab-tool.ts's Claude-side
   * DispatchContext construction verbatim (fromEngine/fromRoutingId/cwd/
   * getAutonomyMode/getMessages/emit/addDispatchedCost/toolUseId), NOT via MCP — pi has no
   * MCP client of its own, so this calls crossEngineDispatcher.dispatch()
   * directly. Result text formatting (the `[dispatch session_id: …]` success
   * suffix) is copied verbatim from collab-tool.ts too, so a pi-sourced
   * dispatch reads identically to a Claude-sourced one.
   *
   * `extra` (SdkToolExtra) is intentionally OMITTED — DispatchContext.extra is
   * optional, and pi's execute() DOES receive its own `signal`, but
   * PiBridgeHost's request/response contract has no channel to thread an
   * abort through mid-flight (the POST body is just
   * `{toolName, input, toolCallId}` — no signal). Every read site in
   * cross-engine-dispatcher.ts already treats a missing `extra` as "no abort
   * channel, no progress token" (`ctx.extra?.signal` → a permanently-pending
   * race arm that never wins; `sendProgress(ctx.extra, …)` → no-op), so this
   * is a safe, honest omission — not a fabricated never-aborting stub.
   * Stop-from-CALLER still works regardless: TaskCard's Stop button routes
   * through `crossEngineDispatcher.stopDispatch`, keyed by toolUseId +
   * routingId, entirely independent of this signal. pi's OWN Esc-to-abort
   * mid-turn ALSO now propagates into an in-flight dispatch (audit-residual B
   * fix) — see `inFlightDispatchIds`'s doc comment and `interrupt()`, which
   * calls the SAME `stopDispatch` the TaskCard Stop button does for every id
   * tracked here.
   */
  private async handleDispatchAgent(
    input: Record<string, unknown>,
    toolCallId: string
  ): Promise<PiHostedToolResult> {
    const engine = input.engine
    const prompt = input.prompt
    if (!canDispatchInto('pi', engine) || typeof prompt !== 'string') {
      return {
        content: [
          {
            type: 'text',
            text: 'dispatch_agent requires "engine" (one of "claude"|"opencode"|"codex") and a string "prompt".'
          }
        ],
        isError: true
      }
    }

    const req: DispatchRequest = {
      engine,
      prompt,
      model: typeof input.model === 'string' ? input.model : undefined,
      sessionId: typeof input.session_id === 'string' ? input.session_id : undefined
    }
    const ctx: DispatchContext = {
      fromEngine: 'pi',
      fromRoutingId: this.routingId,
      cwd: this.cwd,
      // Live (ADR-087): the target follows this session's mode switches, and
      // the judge of a pi/opencode target reads this transcript.
      getAutonomyMode: () => this.getAutonomyMode(),
      getMessages: () => this.messageHistory,
      emit: (channel, data) => this.send(channel, data),
      addDispatchedCost: (engineId, modelId, costUsd) =>
        this.addDispatchedCost(engineId, modelId, costUsd),
      toolUseId: toolCallId
    }

    // Audit-residual B fix: tracked from BEFORE the dispatch() await starts
    // (so a Stop/interrupt racing this exact instant still sees it) until it
    // settles either way — see inFlightDispatchIds' doc comment.
    this.inFlightDispatchIds.add(toolCallId)
    let result: Awaited<ReturnType<typeof crossEngineDispatcher.dispatch>>
    try {
      result = await crossEngineDispatcher.dispatch(req, ctx)
    } finally {
      this.inFlightDispatchIds.delete(toolCallId)
    }
    const text = result.isError
      ? result.text
      : `${result.text}\n\n[dispatch session_id: ${result.sessionId} — pass it as session_id to continue this agent]`
    return {
      content: [{ type: 'text', text }],
      ...(result.isError ? { isError: true } : {})
    }
  }

  /**
   * ISession.backgroundTask — "Send to background" on a host-run subagent's
   * TaskCard (ADR-088 S3b, Q7; `handlers-core.backgroundTask`, gated on
   * `capabilities.backgroundTasks`): the waiting `agent` call returns the
   * async-launched text now, and the run notifies when it ends.
   */
  async backgroundTask(toolUseId: string): Promise<{ success: boolean; error?: string }> {
    return this.subagents.background(toolUseId)
  }

  /**
   * ISession.stopTask — the per-agent Stop on a host-run subagent's TaskCard
   * (ADR-088; `handlers-core.stopTask`, gated on `capabilities.backgroundTasks`).
   * Stops that agent and its descendants; its run returns "Agent stopped by
   * user." to the parent. A run already past its end (closing) is not stopped.
   */
  async stopTask(toolUseId: string): Promise<{ success: boolean; error?: string }> {
    return this.subagents.stop(toolUseId)
      ? { success: true }
      : { success: false, error: 'No running agent for that card' }
  }

  async setModel(model: string): Promise<void> {
    const prevModel = this._model
    this._model = model
    if (this.client) {
      const ref = engineMeta('pi').decodeModelValue(model)
      let applied = false
      try {
        const resp = await this.client.request({
          type: 'set_model',
          provider: ref.vendorId,
          modelId: ref.modelId
        })
        applied = resp.success
        if (!resp.success) {
          this.send('session:error', resp.error ?? `Failed to set model "${model}"`)
        }
      } catch (err) {
        this.send('session:error', err instanceof Error ? err.message : String(err))
      }
      // Failed switch: never keep the bogus value in status.model. Prefer the
      // engine's actual current model (fresh get_state); if that read also
      // fails, fall back to the pre-switch value — both are honest, the failed
      // value is not.
      if (!applied) {
        const adopted = await this.adoptEngineModel()
        if (!adopted) this._model = prevModel
      }
    } else {
      // Pre-spawn model change: also update the pending spawn request so the
      // eventual doStart() applies the user's LATEST choice, not the stale
      // constructor value.
      this.requestedModel = model
    }
    this._capabilities = await this.resolveCapsForModel(this._model).catch(() => this._capabilities)
    this.sendStatus()
    this.sendStatusLine()
  }

  /**
   * ISession.setEffort (M2b) — sends `set_thinking_level {level: effort}`.
   * Void, not async (ISession's optional-member contract): callers
   * (handlers-core.ts's setEffort) invoke this WITHOUT awaiting, so the RPC
   * round-trip below is genuinely fire-and-forget from the caller's
   * perspective — both failure paths (success:false AND a thrown/rejected
   * request) are caught and reported internally, mirroring setModel's
   * session:error failure shape, so neither becomes an unhandled rejection.
   */
  setEffort(effort: string): void {
    if (!this.client) {
      // Pre-spawn: record for application in doStart() (mirrors setModel's
      // identical pre-spawn branch) — the eventual doStart() applies the
      // user's LATEST choice, not a stale constructor value.
      this.requestedEffort = effort
      return
    }
    this.client
      .request({ type: 'set_thinking_level', level: effort })
      .then((resp) => {
        if (!resp.success) {
          this.send('session:error', resp.error ?? `Failed to set thinking level "${effort}"`)
        }
      })
      .catch((err) => {
        logger.warn(
          'PiSession',
          `setEffort(set_thinking_level) failed: ${err instanceof Error ? err.message : String(err)}`
        )
        this.send('session:error', err instanceof Error ? err.message : String(err))
      })
  }

  /**
   * Send `/cui-plan-enter` or `/cui-plan-exit` as a normal RPC `prompt`
   * message — verified (docs/protocol-pi/README.md "Extensions" +
   * rpc.md:67): an extension command "executes immediately even during
   * streaming", so this needs no `streamingBehavior` and works mid-turn.
   * Fire-and-log-failure (mirrors setEffort's identical treatment) — a
   * dropped toggle degrades to the gate-layer bash/mutating-kind deny still
   * doing its job (defense in depth), not a broken session.
   */
  private async sendPlanModeCommand(command: 'cui-plan-enter' | 'cui-plan-exit'): Promise<void> {
    if (!this.client) return
    try {
      const resp = await this.client.request({ type: 'prompt', message: `/${command}` })
      if (!resp.success) {
        logger.warn('PiSession', `${command} rejected: ${resp.error ?? 'unknown error'}`)
      }
    } catch (err) {
      logger.warn(
        'PiSession',
        `${command} failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Set the live permission mode. Store + broadcast only for every mode
   * EXCEPT plan mode transitions — gateToolCall reads this.permissionMode
   * live on every tool_call, so a mode switch takes effect on the very next
   * gate with no RPC round-trip needed (unlike opencode's patchSession).
   *
   * Plan mode (M5a) is the one exception: entering/leaving 'plan' ALSO
   * toggles the bridge extension's tool set (pi-bridge-source.ts), which
   * needs the `/cui-plan-enter`/`/cui-plan-exit` round-trip below. No-op
   * transitions (mode === the current mode) are skipped entirely — a
   * second identical `setPermissionMode('plan')` must not re-send the enter
   * command. Exiting via the ExitPlanModeCard's "allow" path does NOT come
   * through here (resolveApproval sets `this.permissionMode` directly and
   * skips the RPC call — the extension's exit_plan.execute() already
   * restored the tool set locally; see resolveApproval's doc comment) — by
   * the time the renderer's follow-up setPermissionMode('acceptEdits'|
   * 'default') call lands here, `prevMode` is already NOT 'plan', so the
   * "leaving plan" branch below correctly does not fire a second time.
   */
  async setPermissionMode(mode: string): Promise<void> {
    const prevMode = this.permissionMode
    this.permissionMode = mode
    this.send('session:permission-mode', mode)

    if (mode === prevMode) return

    if (mode === 'plan') {
      await this.sendPlanModeCommand('cui-plan-enter')
    } else if (prevMode === 'plan') {
      await this.sendPlanModeCommand('cui-plan-exit')
    }
  }

  sendStatus(): void {
    this.send('session:status', this.status)
  }

  /**
   * Build a StatusLineData snapshot. Context "used" = lastContextLength (latest
   * turn's input+cacheRead), matching OpencodeSession's semantic. modelCosts
   * carries only cross-engine dispatched entries (always empty in M1 — pi is
   * not a valid dispatch source/target yet) — no own-model cost breakdown
   * (deliberately simplified: pi's `get_session_stats` seed on resume gives a
   * single total, not a per-model split, so a synthesized breakdown could
   * under-report against the headline totalCostUsd; deferred to a follow-up).
   */
  private buildStatusLine(): StatusLineData {
    const ctx = this._capabilities.contextWindow
    const usedPercentage =
      ctx > 0 && this.lastContextLength > 0
        ? Math.round((this.lastContextLength / ctx) * 100)
        : null
    const remainingPercentage = usedPercentage !== null ? 100 - usedPercentage : null
    const cachedTokens = this.sumCacheReadTokens + this.sumCacheWriteTokens
    const totalTokens = this.sumInputTokens + this.sumOutputTokens + cachedTokens
    const costs = this.costTally()
    return {
      totalCostUsd: costs.displayCostUsd,
      billedCostUsd: costs.billedCostUsd,
      ...(costs.unknownMessages > 0 ? { unknownCostMessages: costs.unknownMessages } : {}),
      totalDurationMs: this.accTotalDurationMs,
      totalApiDurationMs: 0,
      totalInputTokens: this.sumInputTokens,
      totalOutputTokens: this.sumOutputTokens,
      cachedTokens,
      totalTokens,
      contextWindow: { used: this.lastContextLength, size: ctx },
      usedPercentage,
      remainingPercentage,
      turnStartedAtMs:
        this.isProcessing && this.mapperState.startTimeMs > 0 ? this.mapperState.startTimeMs : null,
      modelCosts: this.dispatchedCostEntries()
    }
  }

  private sendStatusLine(): void {
    this.send('session:status-line', this.buildStatusLine())
  }

  dispose(): void {
    this.cancel()
  }
}
