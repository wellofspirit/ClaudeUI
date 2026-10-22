/**
 * Cross-engine agent dispatch (ADR-033).
 *
 * A single main-process service owning all `dispatch_agent` logic: target
 * creation, guards (concurrency cap, per-dispatch timeout, model allowlist),
 * approval forwarding, result await, and cancellation.
 *
 * Targets are headless dispatcher-owned mini-sessions built on engine client
 * primitives — NOT SessionManager/ISession. Two directions are supported:
 *  - Claude → opencode (M1, opencode 2.x since ADR-097 S9): a target is an
 *    opencode session on a turn-running lease of the S2 server manager, driven
 *    with the S3 `OpencodeClient` — an inbox prompt answered at once, the turn
 *    followed on the SERVER's shared event feed through the target's own S4
 *    mapper, which also yields its text, usage and asks. Asks go through the
 *    session's host pre-check (S6 rules), then ClaudeUI's judge or a card.
 *  - opencode → Claude (M2): targets use a raw `sdkQuery()` (the
 *    service-session.ts precedent) kept alive across turns via a pushable
 *    streaming-input channel, driven by a manual iterator loop (see the
 *    `.return()`-kills-the-process hazard noted on `driveClaudeTurn`).
 *  - claude/opencode → pi (M4c): one headless `pi --mode rpc` child per
 *    target plus its own loopback PiBridgeHost approval gate.
 *  - anything → CODEX (slice H, re-shaped by ADR-069 §7): one
 *    `thread/start`-created thread on the CALLER's host — no child of its own —
 *    with ClaudeUI's own permission engine answering the native approval
 *    requests that thread raises. Codex is a target AND (slice E) a source, and
 *    codex → codex is now allowed: it is one more thread on the process the
 *    caller already runs on, so the same-engine guard it used to hit has
 *    nothing left to protect. The guard stands for the other three.
 *
 * All failures come back as `isError` tool text — nothing throws across the
 * MCP boundary.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  isAbsolute as isAbsolutePath,
  relative as relativePath,
  resolve as resolvePath
} from 'node:path'
import { v4 as uuidv4 } from 'uuid'
import { opencodeServerManager } from '../opencode/OpencodeServerManager'
import type { ServerConnection } from '../opencode/OpencodeServerManager'
import {
  isOpencodeApiError,
  OpencodeClient,
  type PermissionReply
} from '../opencode/OpencodeClient'
import type { Agent_Info } from '../opencode/protocol-v2/openapi'
import {
  eventSessionID,
  type OpencodeEvent as OpencodeV2Event
} from '../opencode/protocol-v2/events'
// Leaf modules of the opencode 2.x stack (no session class): the S4 mapper and
// reconnect re-read, the S6 rulesets and the child keeper, the S5 teardown.
// OpencodeSession.ts imports THIS module (cancel() disposes owned targets), so
// nothing here may import it back.
import {
  OpencodeEventMapper,
  type OpencodeApprovalRoute,
  type OpencodeMapperOutput,
  type OpencodeStepUsage
} from '../opencode/event-mapper'
import { reconcileAfterReconnect } from '../opencode/reconnect'
import {
  asHostPrecheckRules,
  buildSessionRuleset,
  CLAUDEUI_MCP_SERVER,
  HAND_BACK_ALLOW_RULE,
  SESSION_TOOLS_DENY_RULE,
  wireOrder,
  type V2Rule
} from '../opencode/permission-v2'
import type { OpencodePermissionRule } from '../opencode/permission-compiler'
import { ChildRulesetKeeper } from '../opencode/child-rulesets'
import { resolveOpencodeOwnDirAllows } from '../opencode/own-dirs'
import {
  locationWorktree,
  stopOpencodeSessions,
  TEARDOWN_GRACE_MS
} from '../opencode/session-support'
import { hostPrecheck, type HostPrecheckContext } from '../opencode/host-precheck'
import {
  mergeRestrictions,
  restrictionCovers,
  restrictionNote,
  type CallerRestriction
} from '../opencode/caller-restriction'
import { OpencodeSessionAllows } from '../opencode/session-allows'
import { effectiveClaudeSkillCatalog } from '../opencode/effective-claude-skills'
import { opencodeAuthHooks } from '../opencode/opencode-auth-hooks'
import { collectClaudeMcpForOpencode } from '../opencode/claude-mcp-bridge'
import {
  expandClaudeSkillInvocation,
  renderClaudeSkillCatalog,
  resolveClaudeSkills,
  type ClaudeSkillCatalog
} from '../skills/claude-skills'
import { denyAskHit } from '../permissions/shell-rules'
import { isShellToolName } from '../automode/shell-lexical'
import { parseModelString, peekOpencodeModels } from '../opencode/model-discovery'
import { peekPiModels } from '../pi/model-discovery'
import { editClearsAgentControl } from '../opencode/agent-control-gate'
// ADR-088 — ClaudeUI's judge for pi/opencode targets. Leaf modules (the
// automode pipeline + the judge transport), no session class.
import { DispatchTargetJudge } from './dispatch-target-judge'
import { armBlockHold, blockHoldMs } from '../automode/block-hold'
import {
  blockApprovalNotice,
  blockedCallDelivery,
  blockGrantKey,
  type BlockedCall,
  type BlockedCallLedger
} from '../automode/blocked-calls'
import { collectToolUseIds, recordTrajectoryMessage } from '../automode/trajectory'
import { STAGE2_TIMEOUT_MS, type JudgeTransport } from '../automode/classifier'
import type { SessionJudgeOptions } from '../automode/session-judge'
import { claudeSpawnPrep } from '../providers/claude-spawn-prep'
import { loadEngineConfig, loadSettings } from './ui-config'
import { resolveDispatchMaxConcurrent } from '../../shared/dispatch-concurrency'
import { transformAssistantMessage } from './assistant-message'
import { extractToolResultContent } from './tool-result-content'
import { ClaudeItemStreamLifecycle, streamEventParent } from './claude-item-stream'
import type { ItemStreamOpen, ItemStreamSeal, ItemStreamTarget } from '../shared/sync/item-stream'
// pi target primitives (ADR-033 M4c — pi as a dispatch TARGET). None of these
// leaf modules import THIS file (or PiSession.ts, which does), so — same
// reasoning as the opencode imports above — this is a one-way edge, not a
// cycle. Reused verbatim, never reimplemented (per the M4c kickoff spec). The
// process/transport half of a pi target lives in `PiChildRunner` (ADR-089),
// shared with PiSession's host-run subagents; the gate policy stays here.
import type {
  GateDecision,
  PiBridgeHandler,
  PiHostedToolResult,
  PiToolCallPayload
} from '../pi/PiBridgeHost'
import {
  defaultSpawnPiChild,
  PiChildRunner,
  type PiChildPrimitives,
  type PiChildSpawnOpts,
  type PiTurnOutcome,
  type SpawnPiChildFn
} from '../pi/pi-child-runner'
import { collectClaudeMcpForPi, piMcpRuleKey } from '../pi/pi-mcp-bridge'
// Codex target primitives (ADR-033 slice H — Codex as a dispatch TARGET). Same
// one-way-edge reasoning as the opencode/pi imports above: none of these leaf
// modules import THIS file. CodexSession.ts DOES (it is a dispatch SOURCE,
// slice E), which is exactly why the mode->policy table and the turn-input
// mapping live in `codex-turn-policy.ts` rather than being exported from
// CodexSession.ts — importing that module here would be a require-cycle.
import { CodexMethodNotFound, type CodexTransportError } from '../codex/CodexAppServerClient'
import {
  codexHostRegistry,
  type CodexHostIdentity,
  type CodexHostSource,
  type CodexThreadConnection,
  type CodexThreadOwner
} from '../codex/CodexHost'
import { harnessAvailable } from '../harness/resolve'
import { codexHandBackSpec, codexXAgentMessageSpec } from '../codex/codex-hand-back-spec'
import { codexModePolicy, codexTurnInput, codexTurnPolicy } from '../codex/codex-turn-policy'
import { withOriginalSkillInput } from '../codex/skill-input'
import { assertCodexProvider, selectCodexModel } from '../codex/model-selection'
import { codexItemId, mapCodexDelta, mapCodexItem } from '../codex/event-mapper'
import { readCodexImageView } from '../codex/codex-image-view'
import { codexDisjointTokens } from '../codex/usage-ledger'
import type { CodexMappedEvent } from '../codex/event-mapper'
import { unwrapShellCommand } from '../codex/command-text'
import {
  decideWithSource,
  sessionToolDenyRule,
  mergedClaudeRulesFor,
  PLAN_MODE_DENY_REASON_NO_EXIT_TOOL
} from '../pi/permission-engine'
import type { MergedClaudeRules, PermissionDecision } from '../pi/permission-engine'
import type { CodexMethods } from '../codex/protocol/methods'
import type { Model } from '../codex/protocol/v2/Model'
import type { ThreadItem } from '../codex/protocol/v2/ThreadItem'
import type { Turn } from '../codex/protocol/v2/Turn'
import type { TokenUsageBreakdown } from '../codex/protocol/v2/TokenUsageBreakdown'
import type { ThreadTokenUsage } from '../codex/protocol/v2/ThreadTokenUsage'
import type { CommandExecutionRequestApprovalParams } from '../codex/protocol/v2/CommandExecutionRequestApprovalParams'
import { equivalentCostUsd } from '../../shared/pricing'
import type { ResolvedCosts } from '../../shared/cost-rule'
import { opencodeMessageCosts } from '../opencode/message-cost'
import { piMessageCosts, type PiCostTokens } from '../pi/message-cost'
import { ENGINE_META, engineMeta } from '../../shared/engine-meta'
import { query as sdkQuery, sendProgress } from '../sdk'
import { ensureHostTokenFresh } from '../sdk/host-token'
import type {
  CanUseTool,
  CanUseToolContext,
  CanUseToolResult,
  McpServerConfig,
  PermissionMode,
  QueryHandle,
  ResultMessage,
  SDKMessage,
  SdkToolExtra
} from '../sdk'
import { logger } from './logger'
// The ADR-071 §1 ledger half of a dispatched turn. Every one of these modules
// is ALREADY in this file's transitive import graph (`assistant-message` ->
// `session-history` -> `block-usage` -> `usage-fetcher` -> `claude-session`,
// which imports this module back), so naming them directly adds no import
// edge that was not there — and nothing below is touched at module-init time,
// only from a turn's own code path.
import { recordUsageEvent } from './usage-recorder'
import type { UsageTurnEvent, UsageTurnTokens } from './usage-recorder'
import { usageFetcher } from './usage-fetcher'
import { activeClaudeAttribution } from './usage-windows'
import { buildClaudeAccountRef } from '../host'
import { DISPATCH_TARGETS } from './dispatch-targets'
import { opencodeAuthProvider } from '../auth/OpencodeAuthProvider'
import { piAuthProvider } from '../auth/PiAuthProvider'
import { credentialSync } from '../auth/vault/CredentialSync'
import { codexNativeIdentity } from '../auth/account-identity'
import { UNKNOWN_ACCOUNT_KEY } from '../../shared/account-key'
import { OPENCODE_DISPATCH_SESSION_TITLE } from '../../shared/dispatch-session'
import {
  dispatchLedger,
  dispatchPiSessionDir,
  type DispatchLedgerStore,
  type DispatchTargetRow,
  type DispatchTargetState
} from './dispatch-target-ledger'
import { locateClaudeTranscript } from './claude-transcript-locator'
import { stricterMode } from '../../shared/mode-class'
import { removeHarnessState } from './dispatch-target-end'
import { DispatchRun, DispatchRunRegistry } from './dispatch-runs'
import {
  CLAUDE_HAND_BACK_TOOL,
  createHandBackServer,
  HAND_BACK_SERVER_NAME,
  type HandBackAnswer
} from './dispatch-hand-back-server'
import {
  dispatchReports,
  type DispatchReportStatus,
  type DispatchReportStore
} from './dispatch-report-store'
import { capReport, frameHandBack } from '../../shared/handback-frame'
import { dispositionOf, type ReportReview } from '../../shared/handback-review'
import {
  handBackReviewOf,
  handBackReviewOfAsk,
  readPermissionDecisionFrame
} from './claude-permission-decision'
import {
  failedResultText,
  recordSummary,
  reportResultText,
  sentenceLabel,
  statusLine,
  stoppedResultText
} from './dispatch-result-text'
import { ToolUseOwners } from './tool-use-owners'
import {
  runSessionTool,
  sessionToolsAvailable,
  type SessionToolCaller,
  type XAgentMessageOutcome,
  type XAgentMessageRequest
} from './session-tools'
import {
  createSessionToolsServer,
  SESSION_TOOLS_PREFIX,
  SESSION_TOOLS_SERVER_NAME
} from './session-tools-server'
import { xAgentSessionToolsEnv } from './session-tool-specs'
import { agentNoteMessage } from './agent-note'
import { isReservedXAgentName } from '../../shared/session-links'
import {
  MESSAGE_RUN_ENDED_TEXT,
  messageNotTakenText,
  MESSAGE_UNREVIEWED_TEXT,
  messageBlockedText,
  X_AGENT_INPUT_FRAGMENT_LABEL,
  X_AGENT_MESSAGE_TOOL,
  xAgentInputNoteTitle,
  xAgentMessageFrame,
  xAgentNewRunPrompt
} from '../../shared/x-agent-message'
import { SESSION_TOOL_NAMES } from '../../shared/session-tools-description'
import { isHandbackPointerResult } from './task-notification-xml'
import {
  HAND_BACK_DONE_TEXT,
  HAND_BACK_EMPTY_TEXT,
  HAND_BACK_ENDED_TEXT,
  HAND_BACK_FALLBACK_WARNING,
  LAUNCH_ACK_MARKER,
  HAND_BACK_NOT_TARGET_TEXT,
  HAND_BACK_REPEAT_TEXT,
  HAND_BACK_SUBAGENT_TEXT,
  HAND_BACK_UNATTRIBUTED_TEXT,
  handBackNudge,
  handBackTaskSuffix,
  HAND_BACK_TOOL,
  handBackWithheldText
} from '../../shared/dispatch-agent-description'
import {
  makeRunContext,
  type DispatchParentLookup,
  type LiveParentSession,
  type RunContext
} from './dispatch-parent'
import type {
  ApprovalDecision,
  BillingType,
  ChatMessage,
  DispatchConfig,
  EngineConfig,
  EngineId,
  FileDiff,
  PendingApproval,
  PermissionSuggestion,
  TaskHandback,
  ToolReviewBlock
} from '../../shared/types'

/**
 * Whether cross-engine dispatch is a real, honest capability for `engineId`
 * (ADR-030 + ADR-033 M4-A): "a session on this engine hosts the dispatch tool
 * AND at least one engine it can dispatch into is available." Lives here (not
 * in shared/model-capabilities.ts, which must stay renderer-safe / import-free
 * of main-process-only modules) — every session class already imports THIS
 * module (for `crossEngineDispatcher`/`disposeFor`), so the export forms no new
 * import edge, let alone a cycle.
 *
 * One rule for every engine since ADR-082: ANY target being available makes
 * the tool honest; the ones that are not only narrow the useful list, which
 * the dispatcher's own per-request guards report. Before it, the opencode and
 * Codex branches answered `true` because Claude Code was always bundled, and
 * pi's asked about pi itself. Neither holds any more: a harness is chosen,
 * installed and removed while the app runs, and a Claude Code selection can
 * resolve to nothing. Callers read this when a session's capabilities are
 * computed, so a session spawned after a harness change sees the new answer.
 */
export function crossEngineDispatchAvailable(engineId: EngineId): boolean {
  // `harnessAvailable` is cached by the resolver: this runs on every
  // ClaudeSession status emit and must do no filesystem work.
  return DISPATCH_TARGETS[engineId].some((target) => harnessAvailable(target))
}

// ── Public surface ────────────────────────────────────────────────────────────

export interface DispatchContext {
  fromEngine: EngineId
  fromRoutingId: string
  cwd: string
  /**
   * The dispatching session's permission mode (Claude-style string), read LIVE
   * (ADR-088 ruling 3): every decision point calls it again, so a target
   * follows the parent's mode switches instead of a creation-time snapshot.
   * `entry.ctx` is replaced on every continuation, so `entry.ctx.getAutonomyMode()`
   * is always the latest caller's accessor.
   */
  getAutonomyMode: () => string
  /**
   * The DISPATCHING session's transcript (`messageHistory`), read live — the
   * live array, never a copy. What ClaudeUI's judge reads the user's intent
   * from when it judges a pi/opencode target's call (ADR-088; the ADR-085 S4
   * precedent: a delegated call is judged against the parent transcript).
   */
  getMessages: () => ChatMessage[]
  /**
   * The same transcript for the judge, which may wait for it: a live-parent facade
   * (ADR-105) reads the engine's own history when the parent is disconnected and its
   * canonical copy was evicted. Absent on a plain call context: `getMessages()` then.
   */
  loadMessages?: () => Promise<ChatMessage[]>
  /**
   * The DISPATCHING session's still-queued user turns
   * (`BaseSession.queuedUserTurns`), read live — merged in time order into
   * that judge's transcript (ADR-091 §4): a "go ahead" typed while the parent
   * waits on this dispatch is queued, not yet in `getMessages()`. Optional
   * like `addDispatchedCost`; every production caller sets it.
   */
  getQueuedUserTurns?: () => ChatMessage[]
  /**
   * The DISPATCHING session's approvable blocks and grants
   * (`BaseSession.blockedCalls`, ADR-091 part 6): a pi/opencode target's judge
   * block is recorded there, so the user approves it from the dispatching
   * chat, and that session's grants clear the target's next identical call.
   * Optional like `getQueuedUserTurns`; every production caller sets it.
   */
  blockedCalls?: BlockedCallLedger
  /** Re-emits under the dispatching session's routing (BaseSession.send). */
  emit: (channel: string, data: unknown) => void
  /**
   * BaseSession.addDispatchedCost — folds a completed dispatch turn's spend
   * into the dispatching session's own cost breakdown (ADR-033 Slice C).
   * Optional (never fail a dispatch over a missing wiring, same philosophy
   * as `toolUseId` below) — both production callers (collab-tool.ts,
   * opencode-hosted-tools.ts) always set it; only test doubles omit it.
   */
  addDispatchedCost?: (engineId: EngineId, modelId: string, costUsd: number) => void
  /**
   * The dispatching assistant's own tool_use id for this `dispatch_agent`
   * call (ADR-033 M3). Claude side: `extra.meta['claudecode/toolUseId']`
   * (cli.js stamps this on every MCP tools/call). opencode side: the
   * `claudeui-xeng` plugin's `__xeng_call_id` (the calling tool part's
   * `callID`). Optional — a missing id means the dispatch still WORKS, it
   * just runs without live streaming/progress/notification (every emit is
   * gated on this being set; never fail a dispatch over it).
   */
  toolUseId?: string
  /**
   * The VAULT ChatGPT account the DISPATCHING session runs as (ADR-068 §2), when
   * it is a Codex session with a per-session pin. A headless target must bill the
   * same subscription the human's session bills — otherwise a pinned session's
   * delegated work quietly lands on the active account instead.
   *
   * Absent (or null) on every other caller and on an unpinned Codex session:
   * the target then runs as the ACTIVE account, exactly as slice 2a left it.
   */
  chatgptAccountId?: string | null
  /**
   * The calling SUBAGENT's own restriction (ADR-097 S9, option a): set when an
   * opencode subagent child called `dispatch_agent` (the dispatch belongs to
   * its chat, whose mode and rules the target runs under). Claude-form deny/ask
   * rules added to the user's on every target engine — only ever tighter — and
   * shown to the target's judge. A target keeps the restriction it was created
   * with; a continuation cannot loosen it.
   */
  callerRestriction?: CallerRestriction
  /**
   * The launching MCP request's handle. Only the BLOCKING form reads it: its abort stops
   * the run (Esc on a waiting call) and its progress token gets the heartbeat. A run never
   * holds it (ADR-105 §2): a background launch ignores it.
   */
  extra?: SdkToolExtra
}

export interface DispatchRequest {
  engine: EngineId
  prompt: string
  model?: string
  sessionId?: string
  /** The caller's short handle for the agent (ADR-105); stored on the ledger row of a NEW target. */
  name?: string
  /** The caller's short summary of the task (ADR-105); stored the same way. */
  description?: string
  /**
   * The call came from a SUBAGENT of the parent session (it asked for the background
   * explicitly): the report goes to the parent's top-level agent, so the launch answer must
   * not promise it to the caller. Set by the registration that knows who called.
   */
  fromSubagent?: boolean
  /**
   * Launch the run in the background (ADR-105 §2): the call returns at once with the
   * X-Agent's id, and the result arrives on its task record. Absent / false waits for
   * the result, as dispatch always did.
   */
  runInBackground?: boolean
  /**
   * Internal, set by {@link CrossEngineDispatcher.messageXAgent}: this run is started by a
   * `session_message` to an X-Agent that was not running (ADR-105 §4), through the same continuation
   * path (`sessionId` is the X-Agent's harness id). The prompt arrives already framed, so a Claude target
   * gets no delegation preamble; the run is a background run even when the origin card has no tool-call
   * id (its result is delivered to the parent either way); and it is run `runIndex` of that card.
   */
  message?: { runIndex: number }
}

/** The two labels a dispatch may carry onto its ledger row. */
type DispatchLabels = Pick<DispatchRequest, 'name' | 'description'>

/** The longest `name` and `description` a launch may carry (they reach the roster, the ledger and notification titles). */
const MAX_XAGENT_NAME_CHARS = 64
const MAX_XAGENT_DESCRIPTION_CHARS = 200

/** A label as the ledger keeps it: trimmed, and nothing at all when it is blank. */
function labelOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * The dispatching session's LIVE permission mode as every target path reads it
 * (ADR-088), with the legacy `full` normalised to `auto`. Sessions speak `auto`
 * today, so this is defensive — but `CODEX_TURN_POLICY` has no `full` row (a
 * `full` parent would run a Codex thread with no guardian) and `full` is not a
 * cli.js permission mode, so no target path may see it raw.
 */
function liveMode(ctx: DispatchContext): string {
  const mode = ctx.getAutonomyMode()
  return mode === 'full' ? 'auto' : mode
}

export interface DispatchResult {
  text: string
  sessionId: string
  isError?: boolean
  /**
   * The X-Agent's ledger ref (`s-xxxxxx`) on the answer of a BLOCKING run whose target exists:
   * the id `session_message` takes to talk to it again (ADR-105 §4). `sessionId` stays the
   * harness's own id, which nothing addresses an X-Agent by any more.
   */
  agentRef?: string
}

/**
 * Structural subset of the opencode 2.x `OpencodeClient` (ADR-097 S3) an
 * opencode dispatch target uses — injectable so tests stub the transport
 * without HTTP. One per target, scoped to the caller's directory.
 */
export type DispatchTargetClient = Pick<
  OpencodeClient,
  | 'createSession'
  | 'deleteSession'
  | 'getSession'
  | 'listSessions'
  | 'setSessionPermissions'
  | 'switchAgent'
  | 'prompt'
  | 'interrupt'
  | 'cancelInbox'
  | 'activeSessions'
  | 'replyPermission'
  | 'cancelForm'
  | 'agents'
  | 'mcpServers'
  | 'call'
  | 'listMessages'
  | 'listPermissionRequests'
  | 'listForms'
  | 'listInbox'
  | 'subscribeEvents'
>

/** Spawn opts for a headless Claude dispatch target (ADR-033 M2). */
export interface ClaudeQuerySpawnOpts {
  cwd: string
  model: string
  permissionMode: PermissionMode
  allowDangerouslySkipPermissions: boolean
  canUseTool: CanUseTool
  abortController: AbortController
  prompt: AsyncIterable<Record<string, unknown>>
  /**
   * The harness session id a NEW target is created under (`--session-id`, a uuid v4).
   * The dispatcher mints it and records the ledger row BEFORE the spawn, so the
   * transcript is hidden (ADR-105) from its first byte.
   */
  sessionId?: string
  /** The harness session a RESUMED target continues (`--resume`); exclusive with `sessionId`. */
  resume?: string
  /**
   * `--settings <json>` for the target (ADR-085 §3): `{ permissions: { deny,
   * ask } }` when the user has any deny/ask rule, absent otherwise. It is
   * cli.js's `flagSettings` source, independent of `settingSources: []`
   * (`docs/protocol-cc/02-cli-flags.md` §2.6; `sdk/args.ts` emits
   * `options.settings` as `--settings`).
   */
  settings?: Record<string, unknown>
  /** In-process MCP servers for the target: its `hand_back` (ADR-105 §3). */
  mcpServers?: Record<string, McpServerConfig>
  /** Tools the process may call without asking (`--allowedTools`): `hand_back` and `session_message`, only in `dontAsk`/`bypassPermissions`. */
  allowedTools?: string[]
  /** Every stream-json frame as it is read off the wire, before the dispatcher's own loop (who made a tool call). */
  onInboundFrame?: (frame: Record<string, unknown>) => void
}

/**
 * Spawns the headless Claude target's `sdkQuery()`. Injectable so tests
 * exercise the dispatcher without touching real cli.js / process env
 * (claudeSpawnPrep mutates module-scoped proxy/endpoint/model env slots —
 * see claude-spawn-prep.ts's HAZARD comment).
 */
export type SpawnClaudeQueryFn = (opts: ClaudeQuerySpawnOpts) => Promise<QueryHandle>

/**
 * Spawn opts for a headless pi dispatch target (ADR-033 M4c) — the shared
 * `PiChildSpawnOpts` (ADR-089). `gateHandler` is the two-stage approval gate
 * (see `CrossEngineDispatcher.gatePiTargetToolCall`); a target passes no
 * `hostedToolHandler`.
 */
export type PiTargetSpawnOpts = PiChildSpawnOpts

/** The two live primitives a pi dispatch target owns — one PiRpcClient (the
 *  headless child) and its OWN PiBridgeHost (approval gate transport). */
export type PiTargetPrimitives = PiChildPrimitives

/**
 * Spawns a headless pi dispatch target's PiRpcClient + its own PiBridgeHost.
 * Injectable so tests drive a fake target without a real binary (mirrors
 * `SpawnClaudeQueryFn`/`defaultSpawnClaudeQuery`).
 */
export type SpawnPiTargetFn = SpawnPiChildFn

/**
 * The four native server-request methods a Codex dispatch TARGET answers
 * (ADR-033 slice H) — the same approval surface `CodexSession` handles. Its
 * `item/tool/call` is answered apart (`toolCallFromCodex`): the two tools a target is
 * started with (`hand_back`, ADR-105 §3, and `session_message` to its dispatcher, §4) and
 * nothing else.
 *
 * That narrowing is half the recursion scrub. Until ADR-069 the TRANSPORT
 * enforced it — the target owned its own process and registered only these four
 * methods, so `item/tool/call` was answered `-32601` before any handler ran. A
 * target is a thread on a SHARED host now, and the host's registered list is the
 * union its owners need, so this list is enforced by
 * `gateCodexTargetRequest` instead, which answers anything outside it with the
 * very same `-32601`. The other half is `thread/start` being sent with only
 * those `dynamicTools`, so the target has neither `dispatch_agent` nor any other hosted
 * tool to call in the first place — belt (no tool offered) and braces (no route to
 * run one if it somehow were).
 */
const CODEX_TARGET_SERVER_METHODS = [
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/tool/requestUserInput',
  'item/permissions/requestApproval'
] as const

/**
 * What `defaultAttachCodexTarget` is handed: where the thread lives, who it
 * belongs to, and which ChatGPT identity its host runs as.
 *
 * No `env` and no `serverMethods`. The host owns both — it inherits
 * `process.env` like every other Codex process, and the TRANSPORT then pins an
 * explicit `CODEX_HOME` onto whatever it inherited
 * (`CodexAppServerClient.childEnv`), so the child can never resolve a different
 * home than the one ClaudeUI computed. NEVER set `CODEX_HOME` here: an env on
 * these opts REPLACES inheritance wholesale, and the integration test already
 * points a real binary at an isolated home through its own injected attach
 * function. The registered server-method list is the union of what its owners
 * answer.
 */
export type CodexTargetAttachOpts = {
  cwd: string
  label: string
  /** Absent = never read the vault (the hermetic default). */
  identity?: CodexHostIdentity
} & CodexThreadOwner

/**
 * Puts a dispatch target's thread on a host (ADR-069 §7). Injectable so the
 * unit suite drives a target without the real binary (mirrors
 * `SpawnClaudeQueryFn`/`SpawnPiTargetFn`) and so the integration test can point
 * it at an isolated home.
 */
export type AttachCodexTargetFn = (opts: CodexTargetAttachOpts) => Promise<CodexThreadConnection>

/**
 * The real one: the caller's host (its pin, else the active account), one more
 * thread on it. The read lease is dropped immediately — `attach` is what holds
 * the host for as long as the target lives.
 */
const defaultAttachCodexTarget =
  (registry: CodexHostSource): AttachCodexTargetFn =>
  async ({ cwd, label, identity, ...owner }) => {
    const handle = await registry.acquire({ cwd, label, ...(identity ? { identity } : {}) })
    try {
      return handle.host.attach(owner)
    } finally {
      handle.release()
    }
  }

export interface DispatcherDeps {
  /**
   * The opencode 2.x server manager (S2). Every target takes a turn-running
   * lease (the `claudeui-xeng` guard is required) and releases it EXACTLY
   * (`releaseIfCurrent`): one server serves every directory and a config
   * change starts a new one, so a cwd no longer names a server.
   */
  serverManager: {
    acquire(cwd: string): Promise<ServerConnection>
    releaseIfCurrent(cwd: string, conn: ServerConnection): void
    subscribeExit(cwd: string, cb: () => void, conn?: ServerConnection): () => void
  }
  makeClient: (conn: ServerConnection) => DispatchTargetClient
  loadEngineConfig: (engineId: string) => EngineConfig
  /** Defaults to the real sdkQuery + claudeSpawnPrep. */
  spawnClaudeQuery?: SpawnClaudeQueryFn
  /**
   * The user's merged Claude permission rules for a cwd (ADR-085 §3 — every
   * target gets their deny/ask tiers, never their allow tier). Defaults to
   * `mergedClaudeRulesFor`, which reads the user's settings files; tests inject
   * a stub to stay hermetic.
   */
  loadUserRules?: (cwd: string) => MergedClaudeRules
  /**
   * The judge transport factory for pi/opencode targets in auto mode
   * (ADR-088). Defaults to `makeSessionJudgeTransport` (ClaudeUI's own HTTP
   * judge, ADR-081); tests inject a scripted transport.
   */
  makeJudgeTransport?: (opts: SessionJudgeOptions) => JudgeTransport
  /** Defaults to the real PiRpcClient + PiBridgeHost construction (ADR-033 M4c). */
  spawnPiTarget?: SpawnPiTargetFn
  /** Defaults to a thread on the caller's host (ADR-033 slice H, ADR-069 §7). */
  attachCodexTarget?: AttachCodexTargetFn
  /**
   * Do Codex dispatch targets run under a VAULT ChatGPT account (ADR-068 §1/§2)?
   *
   * False by default — a dispatcher built without it asks its hosts for NO
   * identity and never reads the vault, which is what keeps the real-binary
   * target integration hermetic. The singleton below turns it on, and the
   * account asked for is then the caller's pin, else the active one.
   */
  codexVaultAccounts?: boolean
  /**
   * The app-wide concurrent-dispatch cap, as a THUNK: it is called at the gate
   * on every dispatch, not read once in the constructor, because the setting
   * behind it is user-editable while the app runs (ADR-033, 2026-09-18).
   * `Infinity` means no limit. Defaults to
   * {@link defaultResolveMaxConcurrent}, which reads
   * `AppSettings.dispatchMaxConcurrent` through
   * {@link resolveDispatchMaxConcurrent}.
   */
  resolveMaxConcurrent?: () => number
  heartbeatMs?: number
  /**
   * ADR-033 M4c: how long `resolveAndRunPi`'s give-up path (timeout/abort/
   * stop) waits for the ABANDONED turn's own terminal pi events to drain
   * before releasing the target's `busy` flag — see `PiChildRunner.settled`'s
   * "RACE NOTE" doc comment for why this exists (pi's `abort` is turn-scoped,
   * not process-killing, and its wire has no per-event turn correlation).
   * Bounded so a hung/never-arriving settle can't wedge the stop path
   * forever. Defaults to a value comfortably above pi's observed real-world
   * abort→agent_settled latency (single-digit ms, verified) so the common
   * case never actually waits the full duration.
   */
  piAbortSettleGraceMs?: number
  /**
   * ADR-033 slice H: the bound on the two short waits `resolveAndRunCodex`'s
   * give-up path (timeout/abort/stop) makes — first for an in-flight
   * `turn/start` to hand back the turn id (without it the turn CANNOT be
   * interrupted and would keep running headless, and the next continuation's
   * `turn/start` would STEER that zombie rather than open a new turn — the
   * app-server routes both through `start_or_steer_turn`), then for the
   * `turn/interrupt` it sends to be acknowledged. Bounded so a wedged target
   * can never hold the stop path open. Injectable for tests.
   */
  codexAbortSettleGraceMs?: number
  /** Clock, injectable for tests. Defaults to Date.now. */
  now?: () => number
  /**
   * Persist the ledger row for one dispatched-agent turn (ADR-071 §1).
   * Defaults to the real `recordUsageEvent` (usage-recorder.ts) — tests inject
   * a spy, both to stay off the (in-memory-under-vitest, but still real)
   * operational DB and to prove that a throwing ledger write cannot reach the
   * dispatch flow. Called for 'completed'/'failed' outcomes only, never for a
   * turn stopped before it produced any usage (see the call sites).
   */
  recordUsageEvent?: (event: UsageTurnEvent) => void
  /**
   * The X-Agent ledger (ADR-105): one durable row per target, which is what a
   * continuation resumes from once the in-memory entry is gone. Defaults to the
   * operational-DB store; tests inject a fake to stay off the DB.
   */
  ledger?: DispatchLedgerStore
  /**
   * How a run reaches its dispatching session (ADR-105 §1): events, the judge's mode and
   * transcript, blocked calls and cost are resolved through it AT EACH READ, so a run
   * outlives the call that launched it. Wired from `core-services.ts` (a service module
   * cannot import the session manager); absent, a run uses the launching call's own
   * context, which is what the unit suites' doubles are.
   */
  parents?: DispatchParentLookup
  /**
   * Where a Claude transcript lives (a resume must not `--resume` a missing one).
   * Defaults to `locateClaudeTranscript`.
   */
  locateClaudeTranscript?: (sessionId: string, cwd: string) => string | null
  /**
   * How long a Codex resume waits out `-32600 already has an active writer` — a
   * released target's thread stays loaded (and locked) in the process that held it
   * until the binary unloads it, about a minute after the last subscriber left
   * (ADR-069 §4) — and how often it retries. Defaults to the interactive session's
   * 75 s and 2 s.
   */
  codexResumeLockWindowMs?: number
  codexResumeLockRetryMs?: number
  /**
   * Does a live Codex host in this process still hold `threadId`? A resume refused with
   * `-32600` is waited out ONLY while one does (the lock is then a normal step that ends
   * about a minute after the holder lets go); the same code also means "no rollout
   * found", which no wait can fix (ADR-069 §4). Defaults to `codexHostRegistry.holdsThread`.
   */
  codexHoldsThread?: (threadId: string) => boolean
  /** Does a pi target's session directory still exist? Defaults to `fs.existsSync`. */
  piSessionDirExists?: (dir: string) => boolean
  /**
   * Remove the harness-side state of an X-Agent that ended for good (opencode's session,
   * pi's session directory). Defaults to `removeHarnessState`; tests inject a spy.
   */
  removeHarnessState?: (
    row: Pick<DispatchTargetRow, 'id' | 'engine' | 'harnessRef'>
  ) => Promise<void>
  /**
   * End every run in a report the X-Agent hands back (ADR-105 §3): targets get the
   * `hand_back` tool, a turn that ends without a report is nudged up to three times and
   * then withheld, and a blocking call returns the framed report instead of the last
   * message. Off by default, so the dispatcher's own suites keep asserting on a turn's
   * text; the singleton below turns it on.
   */
  requireHandBack?: boolean
  /** Where reports are kept (ADR-105 §3). Defaults to the operational-DB store. */
  reports?: DispatchReportStore
  /**
   * The longest an opencode or Codex target's turn is left running after a `hand_back` call
   * while the dispatcher waits for the call's own tool item to complete on the feed (an
   * interrupt that landed first would cancel the call itself). The turn ends sooner when the
   * item completes, or when the turn ends by itself. Defaults to {@link HAND_BACK_SETTLE_MS}.
   */
  handBackSettleMs?: number
  /**
   * The longest a Claude target's turn is waited for while it has background work of its own
   * that will wake it, and the age at which such work is taken to be stale and forgotten;
   * after it the run is nudged or withheld as if the work were gone. Defaults to
   * {@link OWN_WORK_WAIT_MS}.
   */
  ownWorkWaitMs?: number
  /**
   * The longest a turn body waits for the review of an X-Agent's report by its own judge before
   * the run ends with a "could not be reviewed" note instead (ADR-105 §3, slice B-3c). Defaults
   * to {@link HAND_BACK_REVIEW_MS}.
   */
  handBackReviewMs?: number
  /**
   * The longest a message to an X-Agent waits for its running run to end when the run can no longer
   * take a steer (its report was taken, a Stop is pending), before the message starts the next run
   * (ADR-105 §4). Defaults to {@link MESSAGE_RUN_END_WAIT_MS}.
   */
  messageRunEndWaitMs?: number
  /**
   * The longest a message waits for an X-Agent whose run is still starting up (its process not yet
   * live, or between two turns of the run) before it is told to send the message again. Defaults to
   * {@link MESSAGE_START_WAIT_MS}.
   */
  messageStartWaitMs?: number
}

// ── Internals ─────────────────────────────────────────────────────────────────

/** The account a dispatched turn ran under, as a ledger row records it. */
interface DispatchTurnAccount {
  accountKey: string
  accountLabel: string | null
  billingType: BillingType
}

/**
 * What a target hands {@link CrossEngineDispatcher.safeRecordUsage}: one
 * dispatched turn, as the ledger records it (ADR-071 §1).
 *
 * This used to be `dispatched_usage`'s row plus the ledger's extras. ADR-071
 * §1 retired that table, and with it the four fields only its columns wanted — a
 * duration, a turn total beside the split, the dispatching engine, and a cost
 * the dispatcher resolved for itself. The ledger derives a turn's costs from
 * the raw inputs below, by the same rule every other row follows.
 *
 * The last four are optional: a give-up path that knows nothing about the turn
 * still records it, and a missing split records zeros rather than an invented
 * figure.
 */
interface DispatchedTurnRecord {
  /** When the turn ended — the dispatcher's clock, not the target's. */
  ts: number
  /** The DISPATCHING session, the ledger's `parent_routing_id`. */
  fromRoutingId: string
  targetEngine: string
  /** The target model as the engine ENCODES it (`<vendor>/<model>` or bare). */
  targetModel: string
  targetSessionId: string | null
  /** The dispatching tool_use id, part of the ledger's dedup key. */
  toolUseId: string | null
  /** The turn's tokens. Absent means UNKNOWN, not zero — see safeRecordUsage. */
  tokens?: UsageTurnTokens
  /** Absent means the target could not name its account (`UNKNOWN_ACCOUNT_KEY`). */
  account?: DispatchTurnAccount
  /** The engine's OWN cost figure for the turn, raw. Null when it reported none. */
  engineCostUsd?: number | null
  /** See `CostInputsForRow.engineCostIsEquivalent`. Defaults to false. */
  engineCostIsEquivalent?: boolean
}

/** Reserved requestId prefix routing approvals to the dispatcher (ADR-033). */
export const XENG_REQUEST_PREFIX = 'xeng:'

/**
 * A pi dispatch target's gate never has a per-session "always allow"
 * escalation set — UNLIKE PiSession's own interactive sessionAllows, a
 * dispatched target's `gatePiTargetToolCall` treats 'allowForSession'
 * IDENTICALLY to a one-off 'allow' (see its resolve callback): each tool_call
 * runs `decideWithSource()` fresh, matching `awaitClaudeTargetApproval`, which ALSO
 * never persists any escalation state across a Claude target's tool calls.
 * One shared, frozen, empty Set — never mutated — so no per-target
 * allocation is needed.
 */
const EMPTY_PI_SESSION_ALLOWS: ReadonlySet<string> = new Set()

/**
 * The Codex analogue of `EMPTY_PI_SESSION_ALLOWS` — a dispatch target's gate
 * has no per-session "always allow" escalation set, so 'allowForSession' is
 * handled identically to a one-off 'allow' and every request is decided fresh.
 * One shared, frozen, never-mutated Set.
 *
 * An opencode target is the same (ADR-085 S2): its 'allowForSession' replies
 * `once` like a plain 'allow' (`resolveApproval`) — never opencode's `always`,
 * whose instance-global memory would outrank the user's deny/ask rules — and
 * the dispatcher keeps no host-side session-allow set for it either.
 */
const EMPTY_CODEX_SESSION_ALLOWS: ReadonlySet<string> = new Set()

/**
 * The default app-wide dispatch cap, read fresh on EVERY dispatch call so a
 * Settings change binds the next one without an app restart — the same
 * re-read-per-call contract `loadEngineConfig(engine).dispatch` already has for
 * the per-target cost/timeout gates. `loadSettings` is a small JSON read and a
 * dispatch is a rare, expensive event, so there is nothing to cache.
 */
const defaultResolveMaxConcurrent = (): number =>
  resolveDispatchMaxConcurrent(loadSettings().dispatchMaxConcurrent)

const HEARTBEAT_MS = 15 * 1000
/**
 * How often the turn watchdog re-checks the two configured caps. A polling
 * interval rather than two `setTimeout`s because the inactivity deadline MOVES
 * (every sign of life from a busy target bumps `lastActivityAt`) — re-arming a
 * timer on every event would be far more churn for no extra precision at this
 * granularity. All the arithmetic goes through `this.now()` so fake-timer tests
 * control it. Never armed at all when both caps are unlimited — see
 * `startTurnWatchdog`.
 */
export const DISPATCH_WATCHDOG_INTERVAL_MS = 10_000

/** Which of the two liveness caps ended a turn. */
type TurnTimeoutReason = 'absolute' | 'inactivity'

/** The watchdog's only outcome — shaped to drop straight into each direction's
 *  `Raced` union. */
type TurnTimeout = { kind: 'timeout'; reason: TurnTimeoutReason }

/**
 * The two per-turn liveness caps, in ms, resolved for ONE dispatch turn.
 * `0` is the canonical "unlimited" here: `resolveTurnLiveness` folds the
 * undefined case into it, so every consumer has exactly one comparison to make.
 */
interface TurnLivenessCaps {
  turnTimeoutMs: number
  idleTimeoutMs: number
}

/**
 * Resolve one dispatch turn's liveness caps from the TARGET engine's
 * `DispatchConfig` (ADR-033's 2026-09-18 amendment — Daniel's ruling).
 *
 * THERE IS NO BUILT-IN DEFAULT, in any direction. An unset field and an
 * explicit `0` both mean UNLIMITED: the only things that end a dispatched turn
 * early are the user stopping it, the caller aborting it, one of these
 * user-configured caps, or `dispatch.maxCostUsd`. The previous behaviour — a
 * fixed 10 minutes for claude/pi/codex and 60/15-minute defaults for opencode —
 * silently killed legitimately long agent runs, which is the bug this closes.
 */
function resolveTurnLiveness(cfg: DispatchConfig | undefined): TurnLivenessCaps {
  return {
    // A negative value is impossible from the Settings editor (it drops the key
    // rather than persisting one) but a hand-edited config could carry one;
    // clamped to 0 = unlimited so the watchdog's `> 0` gates read uniformly.
    turnTimeoutMs: Math.max(0, cfg?.turnTimeoutMs ?? 0),
    idleTimeoutMs: Math.max(0, cfg?.idleTimeoutMs ?? 0)
  }
}

/**
 * The give-up text for a fired cap: WHICH cap it was and the minutes the user
 * configured for it, plus the direction's own aftermath clause (whether the
 * target survives for a continuation turn). Every direction's timeout message
 * is built here so the two reasons are never conflated in one of them.
 */
function turnTimeoutText(
  reason: TurnTimeoutReason,
  caps: TurnLivenessCaps,
  aftermath: string
): string {
  const minutes = Math.round(
    (reason === 'absolute' ? caps.turnTimeoutMs : caps.idleTimeoutMs) / 60000
  )
  const head =
    reason === 'absolute'
      ? `Dispatch timed out after ${minutes} minutes (absolute limit)`
      : `Dispatch timed out after ${minutes} minutes with no activity from the target agent`
  return `${head} — ${aftermath}`
}

/** Aftermath clauses for `turnTimeoutText`, per direction. Claude targets die
 *  with their process; opencode/pi/codex targets survive for a continuation. */
const CLAUDE_TIMEOUT_AFTERMATH = 'the target agent was aborted.'
const OPENCODE_TIMEOUT_AFTERMATH = 'the target agent was aborted.'
const PI_TIMEOUT_AFTERMATH =
  'the target agent was interrupted (the session survives; a fresh turn may still be dispatched against it).'
const CODEX_TIMEOUT_AFTERMATH =
  'the target agent was interrupted (the thread survives; a fresh turn may still be dispatched against it).'
/** Task kinds of a Claude target's own that wake it when they end (its agents and workflows). */
const CLAUDE_OWN_WORK_TASK_TYPES: ReadonlySet<string> = new Set([
  'local_agent',
  'remote_agent',
  'in_process_teammate',
  'local_workflow'
])
const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'killed',
  'stopped'
])
/** See {@link DispatcherDeps.handBackSettleMs}. */
const HAND_BACK_SETTLE_MS = 2_000
/** See {@link DispatcherDeps.ownWorkWaitMs}. */
const OWN_WORK_WAIT_MS = 30 * 60_000
/**
 * See {@link DispatcherDeps.handBackReviewMs}: the report review's hard deadline. A hand-back
 * always goes straight to stage 2 in `both` mode (stage 1 is skipped, `requiresFullReview`), whose
 * budget is {@link STAGE2_TIMEOUT_MS} (120 s), and in `fast` mode stage 1 alone (60 s) decides. The
 * deadline is twice the stage-2 budget (a block is confirmed by a second stage-2 sample, ADR-106 §2)
 * plus 10 s for what runs outside the transport (loading the parent
 * transcript, resolving the route), so a slow verdict is not cut by a shorter clock and the stage's
 * own timeout, with its cause, fires first.
 */
export const HAND_BACK_REVIEW_MS = 2 * STAGE2_TIMEOUT_MS + 10_000
/** See {@link DispatcherDeps.messageRunEndWaitMs}. */
const MESSAGE_RUN_END_WAIT_MS = 20_000
/** See {@link DispatcherDeps.messageStartWaitMs}. */
const MESSAGE_START_WAIT_MS = 10_000
/** How often a message polls an X-Agent that is starting up. */
const MESSAGE_START_POLL_MS = 25
/** Steer records kept (answered and requeued ones are forgotten first once past it). */
const MAX_STEER_RECORDS = 64
/** How long after its run ended a message the X-Agent still holds can start a turn we end as a stray one. */
const STRAY_STEER_WINDOW_MS = 60_000
/** Times a message looks for a run to steer before it starts one (a run can end, and another begin, in between). */
const MESSAGE_RUN_ATTEMPTS = 3
/** Follow-ups sent to a run that ended without a report before it is withheld (ADR-105 §3). */
const MAX_HAND_BACK_NUDGES = 3
/** How often a running opencode target turn checks the parent's live mode. */
const MODE_WATCH_MS = 250
/** The reject a target's ask gets while no turn of its own is running (a woken execution, a give-up winding down). */
const TARGET_NOT_RUNNING_MESSAGE =
  "The dispatched agent's turn is not running (it was stopped, or it already ended), so this call is not allowed."
/** How long an opencode target's first prompt waits for its server's feed to connect. */
const FEED_READY_WAIT_MS = 10_000
/**
 * Rules every opencode target carries after its mode's: it can never call the
 * dispatch tool back (ADR-033 §4), and it asks no questions — a headless
 * target has nobody to answer them (both hidden: whole-category denies).
 */
const TARGET_DISPATCH_DENY: V2Rule = {
  action: 'claudeui_dispatch_agent',
  resource: '*',
  effect: 'deny'
}
const TARGET_QUESTION_DENY: V2Rule = { action: 'question', resource: '*', effect: 'deny' }

/** `claudeui_session_message`, the one session tool a dispatch target has (ADR-105 §4). */
const SESSION_MESSAGE_RULE_ACTION = `${CLAUDEUI_MCP_SERVER}_${X_AGENT_MESSAGE_TOOL}`

/**
 * What a target's ruleset says of the session tools. They are for the root agent of an interactive
 * session (slice 2), so a target that has none gets the whole family denied. One that has
 * `session_message` (ADR-105 §4) gets the other eight denied by name (hidden from the model, and the
 * service refuses them anyway) and that one allowed, so a message to its dispatcher needs no card, as
 * its `hand_back` needs none, outside a judged auto mode. In one, no allow is written: the family's
 * ask rule then makes opencode ask, and the ask goes to ClaudeUI's judge like any other action of the
 * target (`judgeOpencodeTargetAsk`; a block refuses the send).
 */
function targetSessionToolRules(canMessage: boolean, judgedAuto: boolean): V2Rule[] {
  if (!canMessage) return [SESSION_TOOLS_DENY_RULE]
  return [
    ...SESSION_TOOL_NAMES.filter((name) => name !== X_AGENT_MESSAGE_TOOL).map((name): V2Rule => ({
      action: `${CLAUDEUI_MCP_SERVER}_${name}`,
      resource: '*',
      effect: 'deny'
    })),
    ...(judgedAuto
      ? []
      : [{ action: SESSION_MESSAGE_RULE_ACTION, resource: '*', effect: 'allow' } as V2Rule])
  ]
}
/** A target's form (should one still come — `question` is hidden): cancelled WITH a message. */
const TARGET_FORM_CANCEL_MESSAGE =
  'No user can answer questions in a dispatched agent — continue without asking, and state any assumption you make.'
/** A target has no session allows (ADR-085 S2: 'allowForSession' replies `once`). Never added to. */
const NO_SESSION_ALLOWS = new OpencodeSessionAllows()
/** Default for `DispatcherDeps.piAbortSettleGraceMs` — see that field's doc comment. */
const PI_ABORT_SETTLE_GRACE_MS = 3_000
/** Default for `DispatcherDeps.codexAbortSettleGraceMs` — see that field's doc comment. */
const CODEX_ABORT_SETTLE_GRACE_MS = 3_000
/** `CodexSession`'s writer-lock wait on a resume (ADR-069 §4), for a released target's thread. */
const CODEX_RESUME_LOCK_WINDOW_MS = 75_000
const CODEX_RESUME_LOCK_RETRY_MS = 2_000
const CODEX_RESUME_LOCK_REFUSAL = 'rpc-error--32600'
/** Hard stop on `model/list` paging while building a Codex target's catalog
 *  (mirrors `CodexSession.start`'s identical guard against a server that pages
 *  forever). A real catalog is one page. */
const CODEX_CATALOG_PAGE_LIMIT = 100

/**
 * Bounded timeout for the BEST-EFFORT `get_session_stats` reconciliation read
 * in `accountPiNonSuccessCostReconciled` (audit-residual C fix) — short,
 * mirroring `piAbortSettleGraceMs` above, because the target may be wedged
 * (that's often WHY the turn is on the err/timeout path in the first place)
 * and this must never meaningfully delay an already-failed turn's error
 * return. A local RPC to an already-spawned child is normally sub-100ms; this
 * only bites when the process is genuinely stuck.
 */
const GET_SESSION_STATS_RECONCILE_TIMEOUT_MS = 3_000

/** A durable stop-intent armed BEFORE the dispatch registered (ADR-033 M3). */
interface PendingStop {
  /** Owning session at arm time — must match ctx.fromRoutingId to fire. */
  routingId?: string
}

/**
 * What every live target entry carries of its ledger row (ADR-105). The entry is a
 * cache of the row: when it leaves memory (a parent's restart, an idle release) the
 * row is what a continuation rebuilds it from.
 */
interface TargetLedgerFields {
  /** The ledger row's id (`s-xxxxxx`). */
  ledgerId: string
  /**
   * `disposeFor` / a lost server released this entry and wrote its row's state: the
   * turn that was in flight when it happened must not overwrite that on its way out.
   */
  released: boolean
  /**
   * The target was started with the `hand_back` tool (ADR-105 §3). False for a Codex thread
   * from before it existed (a thread keeps the tool set it was started with): its run ends
   * in its last message, flagged as such.
   */
  handBack: boolean
  /**
   * The target was offered `session_message` to the session that dispatched it (ADR-105 §4): the session
   * tools were on when it was created. The ledger does not record it, so a Codex thread resumed from its
   * row is taken to have it when they are on now (a thread from before B-4 has no such tool to call).
   */
  canMessage: boolean
}

/** What a target's ruleset is built from — cached per target (a failed read is not cached). */
interface TargetRuleInputs {
  client: DispatchTargetClient
  cwd: string
  /** `GET /api/agent` — the default agent. */
  agents: Agent_Info[] | null
  /** Bridged + `claudeui` + `GET /api/mcp` server names (MCP rule keys, the auto catch-all). */
  mcpServers: string[] | null
  /** The location's git worktree root; undefined = not read yet, null = none. */
  worktree: string | null | undefined
  /** opencode's own-directory `external_directory` allows (`own-dirs.ts`); null = not resolved yet. */
  ownDirAllows: V2Rule[] | null
}

/**
 * A live opencode dispatch target (opencode 2.x, ADR-097 S9) — persists across
 * turns for `session_id` continuation. It holds its OWN lease (released
 * exactly, `releaseIfCurrent`) and shares its server's feed record.
 */
interface OpencodeTargetEntry extends TargetRuleInputs, TargetLedgerFields {
  kind: 'opencode'
  skillCatalog: ClaudeSkillCatalog
  /** `claudeui_hand_back` tool calls the target made this turn (tool_use ids), to see them complete. */
  reportToolIds: Set<string>
  /** Resolves the turn's wait for the report's own tool call to complete on the feed. */
  reportToolDone: (() => void) | null
  sessionId: string
  fromRoutingId: string
  cwd: string
  /** This target's lease (the server it was created on). */
  conn: ServerConnection
  /** The server's shared feed. */
  rec: ConnRecord
  /** Latest dispatching context — used to forward approvals mid-turn. */
  ctx: RunContext
  /**
   * True while a turn is in flight (from the turn's first await to its
   * return). Busy-rejects a concurrent continuation and gates the card's
   * stream: a finished turn's trailing events must never emit.
   */
  busy: boolean
  /**
   * Resolver for the turn CURRENTLY in flight; null when idle. Installed
   * before the prompt is sent; invoked EXACTLY ONCE by the target's own
   * terminal mapper output (`settleTargetTurn`) or a lost connection. Every
   * settler and every give-up path reads-and-nulls it first, so the
   * `stopped` output our own interrupt produces is a no-op.
   */
  settled: ((outcome: OpencodeTurnOutcome) => void) | null
  /**
   * THIS turn's prompt reached the model: opencode delivered its inbox item
   * (`turnInboxId`), as a fresh execution's first input or steered into one
   * already running (a woken parent, a give-up still winding down). Only then
   * may a terminal output settle the turn — one before it belongs to another
   * execution (the 1.x "stale idle settles the next turn" residual is gone),
   * and a joined execution has no `execution.started` of its own.
   */
  turnStarted: boolean
  /** The inbox id of the turn's prompt (`msg_claudeui_…`). */
  turnInboxId: string | null
  /** The turn's prompt POST while it may still be in flight (a give-up waits for it, then cancels it). */
  pendingPrompt: { posted: Promise<unknown>; inboxID: string } | null
  /**
   * A give-up (stop, timeout, abort, a refused prompt) is winding down: any
   * execution that starts on the session is interrupted again, and any ask is
   * refused with a message — nobody is waiting for this turn any more.
   * Cleared when the next turn begins.
   */
  draining: boolean
  /** The live mode the applied ruleset was built for (a mid-turn switch re-applies). */
  appliedMode: string | null
  /** A ruleset re-apply in flight (one at a time). */
  applying: Promise<void> | null
  /**
   * A give-up's interrupt still settling (bounded); the next turn awaits it so
   * its prompt cannot steer into the interrupted execution.
   */
  stopping: Promise<void> | null
  /** `this.now()` at turn start — the ABSOLUTE watchdog's baseline. */
  turnStartedAt: number
  /**
   * `this.now()` at the last sign of life from this target (any event of its
   * session or a followed child) while busy — the inactivity watchdog's clock.
   * The watchdog itself refreshes it while a forwarded approval is unanswered.
   */
  lastActivityAt: number
  /** The S4 mapper for this target's session and its subagent children. */
  mapper: OpencodeEventMapper
  /** The S6 child rulesets (shared with `OpencodeSession`). */
  children: ChildRulesetKeeper
  /** The agent the session is on (`plan` in plan mode, else the default). */
  agent: string | null
  /** The ruleset last applied (created with, or PATCHed — 2.x's PATCH replaces). */
  applied: { rules: V2Rule[]; key: string } | null
  /** The user's compiled deny/ask rules — the host pre-check's provenance set. */
  hostRules: OpencodePermissionRule[]
  /** Item streams open on the dispatch card, keyed by `targetItemKey`. */
  openItems: Map<string, { target: ItemStreamTarget; message: ChatMessage }>
  /** This turn's steps (own and children's) — its tokens and cost. */
  turnSteps: OpencodeStepUsage[]
  /** This turn's own assistant messages (per step), in first-seen order — its text. */
  turnMessages: Map<string, ChatMessage>
  /** Cumulative cost across every turn this target has run (ADR-033 M4-C). */
  cumulativeCostUsd: number
  /** Turns whose cost the rule could not resolve (not in `cumulativeCostUsd`). */
  unpricedTurns: number
  /** DISTINCT tool_use ids seen in the turn in flight (ADR-033 M4-B). */
  turnToolUseIds: Set<string>
  /** ClaudeUI's judge for this target's asks under auto mode (ADR-088). */
  judge: DispatchTargetJudge
  /**
   * The resolved canonical model this target was created with — the judge's
   * fallback model and its subagent label. A continuation that passes a
   * different `model` keeps this one.
   */
  model: string
  /** The latest dispatch prompt (set at every turn start) — the judge's subagent task. */
  lastPrompt: string
  /**
   * Permission ids under judgement. An id leaves on the verdict, on the
   * mapper's `approval-resolved` (answered elsewhere) and on stop/dispose, so
   * a verdict that lands afterwards replies nothing.
   */
  judging: Set<string>
  /** The target's own assistant messages (bounded) — what the judge reads after the parent transcript (ADR-088 D1). */
  trajectory: Map<string, ChatMessage>
}

/** What an opencode dispatch turn settles with — see `OpencodeTargetEntry.settled`. */
type OpencodeTurnOutcome = { kind: 'done' } | { kind: 'failed'; message: string }

/**
 * A live Claude dispatch target (ADR-033 M2). The `sdkQuery()` process stays
 * alive across turns; since ADR-105 its session is persisted (a hidden transcript
 * under a ledger-recorded `--session-id`), so a process that ended is re-spawned
 * with `--resume` and loses no context. `channel` feeds the streaming-input mode
 * and `iterator` is the ONE iterator obtained from the query handle for its whole
 * lifetime.
 *
 * HAZARD: `QueryHandle[Symbol.asyncIterator]().return()` KILLS the child
 * process (see sdk/query.ts `makeHandle` — `return: async () => { killChild(); ... }`).
 * A `for await...of` loop that `break`s early triggers `.return()` via the
 * language's iterator-closing protocol. We therefore NEVER use `for await` on
 * `entry.query` — `driveClaudeTurn` calls `entry.iterator.next()` manually in
 * a plain loop, so ending a turn early (we stop as soon as we see `result`)
 * never closes the iterator or kills the process.
 */
interface ClaudeTargetEntry extends TargetLedgerFields {
  kind: 'claude'
  /** Claude session UUID from `system/init` — null until the first turn's init arrives. */
  sessionId: string | null
  fromRoutingId: string
  cwd: string
  channel: ClaudeInputChannel
  query: QueryHandle
  iterator: AsyncIterator<SDKMessage>
  abortController: AbortController
  /**
   * True while a turn is being driven on `iterator`. There is exactly ONE
   * iterator per target for its whole lifetime, so two concurrent
   * `driveClaudeTurn` loops would each steal the other's messages via
   * `next()` (turn A could consume turn B's `result` — answers cross). A
   * model CAN issue two dispatch_agent calls with the same session_id in one
   * assistant turn (their MCP handlers run concurrently — the same race the
   * run registry's slot reservation guards), so a busy target REJECTS the
   * second call instead of interleaving (reject, don't queue: queueing hides
   * latency and muddies timeout attribution; the model can just retry).
   */
  busy: boolean
  /** Latest dispatching context — used to forward approvals mid-turn. */
  ctx: RunContext
  /**
   * The permission mode the target's cli.js process currently runs under
   * (ADR-088): the spawn's `permissionMode`, then whatever
   * `syncClaudeTargetMode` last applied with `set_permission_mode`.
   */
  appliedPermissionMode: PermissionMode
  /**
   * Spawned with `allowDangerouslySkipPermissions` (a `bypassPermissions`
   * parent). The skip flag is a SPAWN option, so a process spawned without it
   * is never switched into `bypassPermissions` later (see `syncClaudeTargetMode`).
   */
  bypassSpawned: boolean
  /** The one "auto mode was rejected" warning was sent; `auto` is not retried on this process. */
  autoRejectedReported: boolean
  /** In-flight `syncClaudeTargetMode`, so concurrent callers serialize on it. */
  modeSync: Promise<void> | null
  /**
   * The Claude account this target's turns are billed to (ADR-071 §3),
   * resolved ONCE at creation. A dispatched cli.js process reads the app's
   * credentials when it is spawned and holds them for its whole life, so
   * re-reading the app's active account per turn could only misattribute a
   * turn the target was already running when the user switched accounts.
   */
  account: DispatchTurnAccount
  /**
   * Background work of the target's OWN that will wake it again (its agents and workflows,
   * task id → when it started): a turn that ends while any runs is not nudged for its report
   * (ADR-105 §3). An entry older than `ownWorkWaitMs` is taken to be stale and forgotten.
   */
  ownTasks: Map<string, number>
  /**
   * Own tasks that just ended (task id → when): cli.js starts a turn of its own to tell the
   * model, which can begin after the turn we are reading ended. Cleared when the next
   * main-agent model round starts (`system/status requesting`).
   */
  pendingWake: Map<string, number>
  /** Who made each tool call (the report is the X-Agent's own, never one of its subagents'). */
  toolUseOwners: ToolUseOwners
  /**
   * The `report` input of the X-Agent's own `hand_back` calls as the stream announced them (call id →
   * text), kept for the classifier's verdict: a BLOCKED call never reaches the handler, so this is
   * where the report is taken from (ADR-105 §3, slice B-3c). Bounded, oldest out.
   */
  handBackCalls: Map<string, string>
  /**
   * The review of a `hand_back` call cli.js ASKED the host about while the target ran in auto
   * (call id → review): in auto it asks only when its classifier did not allow the call, so the
   * report must not go out as clean. Taken by the handler, cleared on release. Bounded, oldest out.
   */
  askedHandBacks: Map<string, ReportReview>
  /** The uuids of the frames pushed into the target that cli.js has not yet reported `started`. */
  pushedUuids: Set<string>
  /**
   * cli.js reported one of our frames `started` (it drained into a turn: a fresh one, or folded
   * into a running one) and no result has ended that turn yet: the next result is OURS.
   */
  ownTurnStarted: boolean
  /** The iterator's pending `next()`, kept so a read with a deadline loses no frame. */
  nextFrame: Promise<IteratorResult<SDKMessage>> | null
  /** The report whose tool result already went by and got the turn interrupted. */
  interruptedReport: object | null
  /** Cumulative cost across every turn this target has run (ADR-033 M4-C). */
  cumulativeCostUsd: number
  /**
   * The last `result.total_cost_usd` seen from this target's process.
   * VERIFIED WIRE FACT: `total_cost_usd` (and `modelUsage`) are CUMULATIVE
   * within one cli.js process — only `usage` and `duration_ms` are per-turn
   * (see claude-session.ts's costBaseUsd/liveTotalCostUsd doc for the full
   * story; the naive `+=` was exactly Slice B's double-count bug). This
   * baseline converts each result's running total into a per-turn delta.
   * Initialized to 0 at entry creation — safe because a ClaudeTargetEntry is
   * strictly one-process for its whole lifetime: every failure path
   * (timeout/abort/stop/err) kills the process AND deletes the entry, and a
   * continuation re-spawns a FRESH entry (`--resume`; cli.js reports only the
   * post-resume spend, so a new baseline of 0 is the right one), so the
   * cumulative counter can never restart under a live entry.
   */
  lastReportedTotalCostUsd: number
  /**
   * `this.now()` at the last SDK message read off this target's iterator while
   * busy — the inactivity watchdog's clock. Fed by `driveClaudeTurn` for EVERY
   * message (`stream_event` deltas included, which is what makes a streaming
   * target provably alive) and refreshed by the watchdog itself while a
   * forwarded approval for this target is still unanswered. See
   * `startTurnWatchdog`; reset to turn start at the start of every turn.
   */
  lastActivityAt: number
  /** DISTINCT tool_use ids seen in the turn CURRENTLY in flight (ADR-033
   *  M4-B) — same Set-not-counter rationale as OpencodeTargetEntry (Claude
   *  targets run includePartialMessages, so the same assistant message is
   *  forwarded repeatedly under the same betaMessage id). */
  turnToolUseIds: Set<string>
  itemStreams: ClaudeItemStreamLifecycle
  /**
   * task_id → the tool_use id that first started it, learned from the
   * target's own `system/task_started` frames — the ORIGIN, which is what the
   * relay parents a resumed agent's snapshots to. Lets an agent_id-only
   * `stream_event` (an idle self-resume inside the target) reach the lane its
   * snapshots use. Lives as long as the target's process, like the agents.
   */
  agentOrigins: Map<string, string>
  /**
   * A later run's tool_use id (the SendMessage call that resumed an agent) →
   * that agent's origin, learned from a second `task_started` for a known
   * task_id (ADR-073 §1; `ClaudeSession.runAliasByToolUseId`). That run's
   * stream events carry the run's id while its snapshots carry the origin's;
   * resolving both through this map puts them on one item-lane state.
   */
  agentRunAliases: Map<string, string>
}

/**
 * A live pi dispatch target (ADR-033 M4c). pi is Claude-shaped at the process
 * level — ONE persistent headless `pi --mode rpc --no-session` child per
 * target, alive across turns — but its EVENT model is not an async iterable:
 * `PiRpcClient.onEvent()` is a single ambient callback registered ONCE for the
 * target's whole lifetime (installed by `PiChildRunner.start`, called from
 * `createPiTarget`), not something a turn-loop can manually `.next()`
 * through. There is therefore no `driveClaudeTurn`-style pull loop and no
 * `.return()`-kills-the-process hazard to guard against — see
 * `PiChildRunner.runTurn`'s doc comment for the full divergence. The runner's
 * `settled` is how a turn currently in flight gets resolved by that ambient
 * callback.
 *
 * ABORT SEMANTICS DIVERGE FROM CLAUDE TOO (verified empirically — see the
 * M4c kickoff investigation): pi's `abort` command is TURN-scoped like
 * opencode's interrupt — the process and session survive an abort, then
 * happily serve a fresh `prompt`. This is UNLIKE Claude, whose
 * `abortController.abort()` kills the whole process (forcing
 * resolveAndRunClaude to delete the entry on timeout/abort/stop). pi's
 * timeout/abort/stop handling therefore keeps the entry alive for
 * continuation, matching the opencode target's survive-the-process pattern.
 *
 * The process, its bridge, the mapper, the per-turn accumulators, the
 * trajectory and the abort-and-drain race live on `runner` (ADR-089, shared
 * with PiSession's host-run subagents); the gate, the cost rule and cap, the
 * ledger row and the busy-reject stay on this entry and in the dispatcher.
 */
interface PiTargetEntry extends TargetLedgerFields {
  kind: 'pi'
  /**
   * pi's own session id, from `get_state` — UNLIKE Claude (whose session_id
   * only arrives with the first turn's `system/init`), pi's `get_state`
   * returns a real in-memory session id immediately after spawn (VERIFIED —
   * even under `--no-session`), so this is set EAGERLY in `createPiTarget`
   * and the entry is registered in `this.targets` before the first turn ever
   * runs. Typed nullable only for structural parity with ClaudeTargetEntry —
   * a successfully-created PiTargetEntry always has this populated
   * (createPiTarget throws instead of returning one without it).
   */
  sessionId: string | null
  fromRoutingId: string
  cwd: string
  /** The child process + its OWN loopback approval-gate host (ADR-033 §4 — a
   *  dispatch target gets its own bridge, never shares the dispatching
   *  session's), driven by the shared `PiChildRunner` (ADR-089). */
  runner: PiChildRunner
  /**
   * Latest dispatching context — used to forward approvals/stream events
   * mid-turn. The gate reads the mode LIVE from it
   * (`ctx.getAutonomyMode()`, ADR-088 ruling 3) — there is no creation-time
   * mode snapshot on this entry: pi's gate is ClaudeUI's own (the bridge
   * asks per call), so nothing native has to agree with it. The mode is
   * passed DIRECTLY (no translation) as `permission-engine.ts`'s
   * `decideWithSource()` `mode`, except that a judged auto mode decides from
   * the `acceptEdits` base (see `gatePiTargetToolCall`).
   */
  ctx: RunContext
  /** True while a turn is being driven — same busy-reject rationale as
   *  ClaudeTargetEntry (a single ambient event stream per process; two
   *  concurrent turns would have no way to tell which `result` belongs to
   *  which caller). */
  busy: boolean
  /** Cumulative cost across every turn this target has run (ADR-033 M4-C). */
  cumulativeCostUsd: number
  /** Turns whose cost the rule could not resolve — see the opencode target's
   *  field of the same name. On this target only a non-finite figure from pi
   *  gets here; there is no message-read-back path to fail. */
  unpricedTurns: number
  /** pi's OWN figure for the turn in flight (the delta `applyPiTurnCost` was
   *  handed), for the ledger row. Null until that runs. Reset per turn. */
  turnEngineCostUsd: number | null
  /** The model this target was created with (picker-value string, e.g.
   *  "openai-codex/gpt-5.6-luna") — fixed for the target's lifetime, same as
   *  Claude/opencode targets (a continuation call cannot switch models). */
  model: string
  /** ClaudeUI's judge for this target's asks under auto mode (ADR-088). */
  judge: DispatchTargetJudge
  /** The latest dispatch prompt (set at every turn start) — the judge's subagent task. */
  lastPrompt: string
}

/**
 * A live Codex dispatch target (ADR-033 slice H).
 *
 * Shaped like pi (alive across turns, a single ambient notification callback
 * rather than an iterable), so there is no `driveClaudeTurn`-style pull loop and
 * no `.return()`-kills-the-process hazard — but since ADR-069 §7 it owns no
 * process at all: it is one more thread on the CALLER's host. Three things make
 * it NOT pi:
 *
 *  - EVENTS CARRY THEIR TURN ID. pi's wire has no per-event turn correlation,
 *    which is why `PiTargetEntry` needs `settled`'s RACE NOTE and a grace
 *    period on every give-up. Codex stamps `turnId` on every notification, so
 *    an abandoned turn's trailing events are recognised by id
 *    (`endedTurns`) and simply dropped — no timing window to lose.
 *  - THE APPROVAL GATE IS THE TRANSPORT'S OWN SERVER-REQUEST CHANNEL. There is
 *    no loopback bridge to own and dispose: `onServerRequest` IS the gate.
 *  - INTERRUPT NEEDS THE TURN ID. `turn/interrupt` is `{threadId, turnId}`,
 *    so a stop that lands before `turn/start` has answered must first learn
 *    the id — see `DispatcherDeps.codexAbortSettleGraceMs`.
 *
 * Like pi (and unlike Claude), an interrupt is TURN-scoped: the process and
 * thread survive, so the entry is kept alive for continuation.
 */
interface CodexTargetEntry extends TargetLedgerFields {
  kind: 'codex'
  /** Exact cwd snapshot delivered to this native thread. */
  skillCatalog: ClaudeSkillCatalog
  /** A live resume may ignore changed developerInstructions; replace on the first input. */
  skillCatalogUpdatePending: boolean
  /** Resolves the turn's wait for the report's own tool call (`dynamicToolCall`) to complete. */
  reportToolDone: (() => void) | null
  /**
   * The native thread id, from `thread/start`. Null only inside
   * `createCodexTarget` before that call returns — a successfully-created
   * entry always has it (creation throws instead of returning one without),
   * and the entry is registered in `this.targets` under it. Typed nullable for
   * structural parity with the other two process-backed entries.
   */
  sessionId: string | null
  fromRoutingId: string
  cwd: string
  /** This target's view of the host it is a thread on (ADR-069 §2). */
  connection: CodexThreadConnection
  /** Latest dispatching context — used to forward approvals/stream events mid-turn. */
  ctx: RunContext
  /**
   * The mode the thread's NATIVE policy currently runs under (ADR-088): set
   * from `ctx.getAutonomyMode()` at creation (`thread/start`'s baseline) and
   * REFRESHED at every `turn/start`, which sends `codexTurnPolicy(mode)` so
   * the thread follows the parent's live mode turn by turn.
   *
   * The gate (`decideCodexTargetRequest`) reads THIS, never the live
   * accessor: the native half of the envelope (`approvalPolicy`/`sandbox`/
   * `approvalsReviewer`) only changes at a turn start, so a mid-turn switch
   * into `auto` must not make the gate allow by mode-base while the thread
   * still runs `approvalsReviewer: 'user'` — no guardian would be reviewing.
   * A mid-turn switch therefore binds at the next turn.
   *
   * Passed DIRECTLY (no translation) as `decideWithSource`'s `mode` — the
   * shared engine natively speaks this vocabulary.
   */
  autonomyMode: string
  /** Resolved native model id (`thread/start`'s echo), fixed for the target's life. */
  model: string
  /** The latest dispatch prompt (set at every turn start) — the report review's subagent task. */
  lastPrompt: string
  /**
   * ClaudeUI's judge for this target's REPORT (ADR-105 §3, slice B-3c), built on first use: Codex's own
   * reviewer does not review dynamic-tool calls, so the report is judged by the target's own model
   * on ClaudeUI's ChatGPT judge route. It judges nothing else.
   */
  reportJudge?: DispatchTargetJudge
  /**
   * The subscription this target's turns are billed to (ADR-071 §3), resolved
   * ONCE at creation. Unlike opencode and pi — whose credential is read per
   * turn off a file — a Codex target's account is decided when its thread is
   * opened: the host it lands on IS one identity (ADR-069 §2), and a later
   * vault change cannot move a thread that is already running.
   */
  account: DispatchTurnAccount
  /** True while a turn is being driven — same busy-reject rationale as pi. */
  busy: boolean
  /** The turn CURRENTLY in flight, once its id is known; null when idle. */
  turnId: string | null
  /** Resolves with the in-flight turn's id (or null) as soon as `turn/start`
   *  answers — the stop path's only way to interrupt a turn whose id has not
   *  landed on `entry.turnId` yet. */
  turnStarted: Promise<string | null>
  /** Turn ids already settled or abandoned. A `turn/completed` for one of these
   *  is dropped rather than allowed to settle whatever turn is in flight now. */
  endedTurns: Set<string>
  /**
   * Resolver for the turn CURRENTLY in flight; null when idle. Installed by
   * `driveCodexTurn` BEFORE `turn/start` is sent (synchronously, so no
   * notification can arrive first), invoked EXACTLY ONCE by the `turn/completed`
   * branch of `handleCodexTargetNotification`, by the `turn/start` rejection
   * path, or by `onDisconnect` if the process dies mid-turn.
   */
  settled: ((outcome: CodexTurnOutcome) => void) | null
  /**
   * A late approval request from an already stopped/timed-out/aborted turn must
   * never register a fresh pending approval on the caller. Set as the FIRST
   * action of the give-up branch, cleared at the start of the next turn — same
   * contract as `PiChildRunner.draining`, and belt-and-braces next to
   * `endedTurns` (a request whose turn id we never learned still has this).
   */
  draining: boolean
  /**
   * `this.now()` at the last app-server notification addressed to this target's
   * thread while busy — the inactivity watchdog's clock. Fed by
   * `handleCodexTargetNotification` for every notification that passes its
   * threadId guard (item events, deltas, usage snapshots), and refreshed by the
   * watchdog itself while a forwarded approval is unanswered. See
   * `startTurnWatchdog`; reset to turn start at the start of every turn.
   */
  lastActivityAt: number
  /** DISTINCT tool_use ids seen in the turn CURRENTLY in flight (ADR-033 M4-B). */
  turnToolUseIds: Set<string>
  /** Latest CUMULATIVE thread usage (`thread/tokenUsage/updated`'s `total`) —
   *  `last` is the last REQUEST's context, not a per-turn figure, so a turn's
   *  own numbers are this minus `usageBaseline`. */
  usageTotal: TokenUsageBreakdown | null
  /** `usageTotal` as of the END of the previous turn — the baseline this turn's
   *  delta is taken against. */
  usageBaseline: TokenUsageBreakdown | null
  /**
   * A thread resumed from its ledger row carries its earlier turns in the cumulative
   * total: the first `tokenUsage/updated` it shows becomes the baseline, and writes no
   * spend (`CodexSession`'s `observed` thread, ADR-071 §4).
   */
  observeUsageBaseline: boolean
  /** Cumulative API-rate-EQUIVALENT spend across every turn this target has run
   *  (ADR-033 M4-C's cap). Equivalent, not a charge: a ChatGPT-subscription
   *  turn's true cost is unknowable from here (ADR-066). */
  cumulativeCostUsd: number
  /** `sha256(item)` per completed item id — the same replay dedupe
   *  `CodexSession.item` keeps, so `turn/completed`'s authoritative `turn.items`
   *  replay re-emits only what actually changed. */
  completedItems: Map<string, string>
  /** First-seen timestamp per item id, so a replayed item keeps its original
   *  one instead of jumping to now. */
  itemTimestamps: Map<string, number>
  activeStreamItems: Map<
    string,
    {
      target: ItemStreamTarget
      text: string
      timestamp: number
      ownerToolUseId: string
      startedAt?: number
    }
  >
  /**
   * The changed-file list of each mapped `fileChange` item, by item id.
   * `FileChangeRequestApprovalParams` carries NO changes of its own
   * (threadId/turnId/itemId/startedAtMs/reason/grantRoot only), so this is the
   * gate's ONLY source of the paths it must decide about — exactly the lookup
   * `CodexSession.requestApproval` does against its own transcript.
   */
  fileChanges: Map<string, FileDiff[]>
  /** Text of the most recent completed `agentMessage` — the turn's result. */
  lastAgentText: string
  /** Wall clock at `turn/start`, the fallback when the turn reports no duration. */
  turnStartedAtMs: number
}

/**
 * A message accepted as a steer into a running turn (ADR-105 §4). The engine's acceptance is not an
 * answer: the model may be writing its `hand_back` call, after which the turn is ended and the
 * message was never read (or was read and never answered). The record tracks it from the wire until
 * the run's report is accepted (or the run ends), when it is decided: `consumed` (the engine took it
 * into the turn BEFORE the report call, so the model wrote its report with it in view) is answered;
 * anything else is unanswered, taken back from the engine where it can be, and sent again as the
 * next run's input (`requeueSteers`).
 */
interface SteerRecord {
  /** The engine's id for it: Claude's frame uuid, pi's `deliveryId`, opencode's inbox id, Codex's `clientUserMessageId`. */
  token: string
  ledgerId: string
  run: DispatchRun
  /** The message as the X-Agent was sent it (already framed). */
  framed: string
  from: { routingId: string; title: string }
  /** The engine reported it taken into the turn. */
  consumed: boolean
  fate: 'pending' | 'answered' | 'unanswered' | 'requeued' | 'dropped'
  /** When its run ended with it unanswered (it is sent again, or dropped): a turn it starts afterwards is a stray one. */
  endedAt?: number
}

/** What a Codex dispatch turn settles with — see `CodexTargetEntry.settled`. */
type CodexTurnOutcome =
  { kind: 'ok'; text: string; durationMs: number } | { kind: 'error'; message: string }

type TargetEntry = OpencodeTargetEntry | ClaudeTargetEntry | PiTargetEntry | CodexTargetEntry

/**
 * One opencode SERVER's event feed, shared by every dispatch target on it
 * (ADR-097 §2: one server serves every directory, so records are keyed by
 * server identity, never by cwd — a config change while a target lives can
 * no longer pair one server's client with another's lease).
 */
interface ConnRecord {
  /** `serverKey(conn)` — unique per spawn. */
  key: string
  /** The client the feed is read with (the feed is server-wide). */
  client: DispatchTargetClient
  abort: AbortController
  targets: Set<OpencodeTargetEntry>
  /** Targets being created on it (not in `targets` yet): the record must outlive them. */
  creating: number
  /** Resolves on the feed's first `connected` (or its end): prompts wait for it. */
  ready: Promise<void>
  unsubscribeExit: () => void
}

interface OpencodePendingApproval {
  kind: 'opencode'
  /** Raw opencode request id (no prefix). */
  permissionId: string
  /** The session that asked — the target's own, or a task child's. Replies go there. */
  askingSessionId: string
  targetSessionId: string
  client: DispatchTargetClient
  emit: (channel: string, data: unknown) => void
}

interface ClaudePendingApproval {
  kind: 'claude'
  /** Null only in the vanishingly unlikely case a tool call landed before
   *  session_id was known — dismissPendingForTarget matches by string, so
   *  such an entry simply never gets swept by target-scoped dismissal (it
   *  still resolves via the abort-listener / explicit resolveApproval). */
  targetSessionId: string | null
  emit: (channel: string, data: unknown) => void
  resolve: (decision: ApprovalDecision, answers?: Record<string, string>) => void
}

/** Same shape/handling as ClaudePendingApproval — a resolve-callback, no
 *  remote client/permissionId (mirrors a pi dispatch target's gate, which
 *  resolves a local Promise exactly like a Claude target's canUseTool does).
 *  Kept as its own sibling variant (not a rename of ClaudePendingApproval) so
 *  the claude/opencode branches stay byte-identical — this is a pure addition. */
interface PiPendingApproval {
  kind: 'pi'
  targetSessionId: string | null
  emit: (channel: string, data: unknown) => void
  resolve: (decision: ApprovalDecision, answers?: Record<string, string>) => void
}

/** Same shape/handling as `PiPendingApproval` — a Codex target's gate also
 *  resolves a local Promise (the parked `onServerRequest`) rather than replying
 *  to a remote permission id. Its own variant, not a rename, so the other three
 *  branches stay byte-identical. */
interface CodexPendingApproval {
  kind: 'codex'
  targetSessionId: string | null
  emit: (channel: string, data: unknown) => void
  resolve: (decision: ApprovalDecision, answers?: Record<string, string>) => void
}

/**
 * A forwarded card that holds a pi/opencode target's auto-mode judge block
 * (ADR-091 §3). `resolveApproval` turns the answer into the hold's semantics
 * before the kind's own reply: Keep blocked (or the expiry) → the judge's deny
 * text + `automode-blocked` on the target's outcomes; Approve anyway → allow +
 * the target's denial streak reset.
 */
interface ForwardedBlockHold {
  /** The judge's model-visible deny text. */
  reason: string
  /** The target-side call id the outcome annotates (the judged `toolUseId`). */
  toolUseId: string
  judge: DispatchTargetJudge
  /** The dispatching session's ledger the block is recorded in (ADR-091 part 6). */
  ledger: () => BlockedCallLedger | undefined
  cancel: () => void
}

type PendingForwardedApproval = (
  OpencodePendingApproval | ClaudePendingApproval | PiPendingApproval | CodexPendingApproval
) & {
  hold?: ForwardedBlockHold
  /**
   * The card exactly as the parent was shown it. A pending approval outlives its
   * parent's session object (a background run's ask stays pending across a respawn), so
   * the dispatcher has to be able to put the card back: it is kept, not rebuilt.
   */
  card: PendingApproval
}

/**
 * A pi/opencode target's judge block that stands — Keep blocked, its expiry,
 * or no hold at all (ADR-091 §3 / part 6): the block is annotated on the
 * target's outcomes (post-block consent inheritance), never as a human
 * refusal, and the judge's own deny text is what the target's model reads —
 * returned for the caller's reply.
 */
function keepTargetBlock(judge: DispatchTargetJudge, toolUseId: string, reason: string): string {
  judge.recordOutcome(toolUseId, 'automode-blocked')
  return reason
}

/**
 * Record a target's judge block at the DISPATCHING session (ADR-091 part 6),
 * so the user can approve it from there: the grant clears the target's next
 * identical call (keyed on the target's cwd), and the nudge goes to the target
 * itself while it can take one (`deliver`, a pi target in flight), else to the
 * dispatching agent, told the target's session id so it can dispatch the call
 * back. No review (the call had no tool block to bind one to) → nothing to
 * approve from.
 */
function recordTargetBlock(
  ctx: DispatchContext,
  toolUseId: string,
  toolName: string,
  input: Record<string, unknown>,
  review: ToolReviewBlock | undefined,
  target: {
    engine: 'pi' | 'opencode'
    label: string
    cwd: string
    /** The X-Agent's ledger ref: what `session_message` addresses it by. */
    xAgentRef: string
    held: boolean
    deliver?: (call: BlockedCall) => string | null
  }
): void {
  if (!review || !ctx.blockedCalls) return
  ctx.blockedCalls.record(
    toolUseId,
    {
      toolName,
      input,
      review,
      grantKey: blockGrantKey(
        target.engine,
        toolName,
        input,
        target.cwd,
        target.engine === 'opencode'
      ),
      agentLabel: target.label,
      xAgentRef: target.xAgentRef,
      ...(target.deliver ? { deliver: target.deliver } : {})
    },
    target.held
  )
}

function errorResult(text: string, sessionId = ''): DispatchResult {
  return { text, sessionId, isError: true }
}

/**
 * A ledger row's stored caller restriction: undefined when it holds none, null when
 * it holds something unreadable (the caller must refuse, never read that as "none").
 */
function parseCallerRestriction(json: string | null): CallerRestriction | undefined | null {
  if (json === null) return undefined
  try {
    const value: unknown = JSON.parse(json)
    const strings = (v: unknown): v is string[] =>
      Array.isArray(v) && v.every((s) => typeof s === 'string')
    if (isRecord(value) && strings(value.agents) && strings(value.deny) && strings(value.ask))
      return { agents: value.agents, deny: value.deny, ask: value.ask }
  } catch {
    // fall through
  }
  return null
}

/** Narrow an unknown wire value to a plain object (mirrors CodexSession's own). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * The refusal shape for `method`, used when a Codex target is DRAINING (its
 * turn was already stopped/timed out/abandoned): every native request is
 * answered, never left hanging, and none of them is answered with consent.
 */
function codexRefusal(method: string): unknown {
  if (method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' }
  if (method === 'item/tool/requestUserInput') return { answers: {} }
  return { decision: 'decline' }
}

/** Is `target` inside `cwd`? Same containment test `CodexSession.insideWorkspace`
 *  makes — duplicated rather than lifted because CodexSession.ts is not this
 *  slice's to refactor beyond the policy table it already exports. */
function insideCodexWorkspace(cwd: string, target: string): boolean {
  const rel = relativePath(cwd, resolvePath(cwd, target))
  return rel !== '' && !rel.startsWith('..') && !isAbsolutePath(rel)
}

/**
 * `model` measured against a user-configured dispatch allowlist, or null when
 * it passes (or when there is no allowlist / nothing to measure). Same sentence
 * the claude/opencode/pi branches produce, so one refusal reads identically
 * whichever engine the caller aimed at.
 */
function codexModelAllowlistDenial(
  model: string | undefined,
  allowedModels: string[] | undefined
): string | null {
  if (model === undefined || !allowedModels || allowedModels.length === 0) return null
  if (allowedModels.includes(model)) return null
  return (
    `Model "${model}" is not in the user-configured allowlist for codex dispatch. ` +
    `Allowed models: ${allowedModels.join(', ')}`
  )
}

/** Zero usage — the implicit baseline before a target's first turn. */
const CODEX_ZERO_USAGE: TokenUsageBreakdown = {
  totalTokens: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0
}

/** One turn's own tokens: the thread's cumulative `total` minus the baseline
 *  the previous turn left. Clamped at zero per field — a thread whose usage is
 *  re-reported lower (a compaction) must never produce a negative row. */
function codexUsageDelta(
  total: TokenUsageBreakdown | null,
  baseline: TokenUsageBreakdown | null
): TokenUsageBreakdown | null {
  if (!total) return null
  const base = baseline ?? CODEX_ZERO_USAGE
  return {
    totalTokens: Math.max(0, total.totalTokens - base.totalTokens),
    inputTokens: Math.max(0, total.inputTokens - base.inputTokens),
    cachedInputTokens: Math.max(0, total.cachedInputTokens - base.cachedInputTokens),
    cacheWriteInputTokens: Math.max(0, total.cacheWriteInputTokens - base.cacheWriteInputTokens),
    outputTokens: Math.max(0, total.outputTokens - base.outputTokens),
    reasoningOutputTokens: Math.max(0, total.reasoningOutputTokens - base.reasoningOutputTokens)
  }
}

/**
 * The API-rate equivalent of one turn's tokens, or null when the model has no
 * published price. The token mapping is Codex's, and it differs from
 * Anthropic's in a way that matters: `inputTokens` is the TOTAL prompt with
 * `cachedInputTokens`/`cacheWriteInputTokens` as SUBSETS of it (the OpenAI
 * Responses API's `input_tokens` / `input_tokens_details`), so the billable
 * base rate is what is left after both — and `reasoningOutputTokens` is a
 * subset of `outputTokens`, already counted once. Identical arithmetic to
 * `CodexSession.equivalentCost`; kept here rather than shared because that
 * method is bound to the session's own account/provider state.
 */
function codexTurnCostUsd(model: string, delta: TokenUsageBreakdown): number | null {
  return equivalentCostUsd('openai', model, {
    inputTokens: Math.max(
      0,
      delta.inputTokens - delta.cachedInputTokens - delta.cacheWriteInputTokens
    ),
    outputTokens: delta.outputTokens,
    cacheWriteTokens: delta.cacheWriteInputTokens,
    // OpenAI publishes ONE cache-write rate; the 5m/1h split is Anthropic's.
    cacheWrite1hTokens: 0,
    cacheReadTokens: delta.cachedInputTokens
  })
}

/**
 * The judge's subagent description for a target: its model, plus what the
 * calling subagent may not do when a restricted child dispatched (ADR-097 S9).
 */
function judgeDescription(model: string, restriction: CallerRestriction | undefined): string {
  const note = restrictionNote(restriction)
  return note ? `${model} — ${note}` : model
}

/** One opencode dispatch turn's spend, summed over its steps (own and children's). */
interface OpencodeTurnUsage {
  steps: number
  /** The ledger's disjoint split (opencode's tokens are already disjoint; reasoning bills as output). */
  tokens: UsageTurnTokens
  /** input + output + reasoning (the notification's figure; cache excluded, as before). */
  totalTokens: number
  /** opencode's own charge, summed; null when no step reported one. */
  engineCostUsd: number | null
  /**
   * What the cap and the dispatching session's breakdown count (ADR-071 §2,
   * `opencodeMessageCosts` per step); null when any step's model has no known
   * price — the cap cannot count it at all (ADR-030). A turn with no step is a
   * known zero.
   */
  costUsd: number | null
}

/**
 * An opencode dispatch turn's usage from the mapper's per-step metering (S4:
 * one `step-usage` per assistant message, a subagent child's included — the
 * rule Claude's status line follows). Each step is priced under the model
 * that ran it (falling back to the target's), by the same module an opencode
 * session's own headline uses.
 */
function opencodeTurnUsage(model: string, steps: readonly OpencodeStepUsage[]): OpencodeTurnUsage {
  const fallback = parseModelString(model)
  const tokens: UsageTurnTokens = {
    input: 0,
    output: 0,
    cacheWrite: 0,
    // opencode publishes one cache-write rate; the 5m/1h split is Anthropic's.
    cacheWrite1h: 0,
    cacheRead: 0
  }
  let totalTokens = 0
  let engineCostUsd: number | null = null
  let costUsd: number | null = 0
  for (const step of steps) {
    const t = step.tokens
    tokens.input += t.input
    tokens.output += t.output + t.reasoning
    tokens.cacheWrite += t.cache.write
    tokens.cacheRead += t.cache.read
    totalTokens += t.input + t.output + t.reasoning
    engineCostUsd = (engineCostUsd ?? 0) + step.cost
    const display = opencodeMessageCosts(
      step.model?.providerID ?? fallback.providerID,
      step.model?.id ?? fallback.modelID,
      t,
      step.cost
    ).displayCostUsd
    costUsd = costUsd === null || display === null ? null : costUsd + display
  }
  return { steps: steps.length, tokens, totalTokens, engineCostUsd, costUsd }
}

/** The text of the turn's last own step that said anything (its final answer). */
function lastTurnText(messages: ReadonlyMap<string, ChatMessage>): string {
  const all = [...messages.values()]
  for (let i = all.length - 1; i >= 0; i--) {
    const text = all[i].content.map((block) => (block.type === 'text' ? block.text : '')).join('')
    if (text) return text
  }
  return ''
}

/** A server's identity: its URL and password are unique per spawn. */
function serverKey(conn: Pick<ServerConnection, 'baseUrl' | 'password'>): string {
  return `${conn.baseUrl}#${conn.password}`
}

/** The key of an item stream on the dispatch card. */
function targetItemKey(target: ItemStreamTarget): string {
  return JSON.stringify([target.messageId, target.blockIndex])
}

/** The dispatch card a target streams onto right now, or undefined (no turn of its own running, no id). */
function streamOwner(entry: OpencodeTargetEntry): string | undefined {
  return entry.busy && entry.turnStarted ? entry.ctx.toolUseId : undefined
}

/** An agent by id from a target's cached list (the default agent for an unnamed one). */
function agentById(
  agents: readonly Agent_Info[] | null,
  id: string | undefined
): Agent_Info | undefined {
  if (!agents) return undefined
  return id ? agents.find((agent) => agent.id === id) : agents[0]
}

/** A dispatch prompt's inbox id (2.x requires `msg_`; ClaudeUI's own prefix). */
function newDispatchInboxId(): string {
  return `msg_claudeui_${uuidv4().replaceAll('-', '')}`
}

/** Reply to a target's permission ask on the session that asked. Never throws. */
function replyTargetPermission(
  client: DispatchTargetClient,
  sessionID: string,
  requestID: string,
  reply: PermissionReply
): void {
  try {
    void client.replyPermission(sessionID, requestID, reply).catch((err) => {
      logger.warn('CrossEngineDispatcher', `replyPermission failed: ${errText(err)}`)
    })
  } catch (err) {
    logger.warn('CrossEngineDispatcher', `replyPermission refused: ${errText(err)}`)
  }
}

/** `promise`, or nothing once `ms` pass first (the timer never outlives the race). */
async function withinMs(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    promise,
    new Promise<void>((done) => {
      timer = setTimeout(done, ms)
    })
  ])
  clearTimeout(timer)
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * A pi dispatch turn's costs from the per-turn delta of pi's own cumulative
 * figure — again the rule an ordinary pi turn follows, from the same module.
 * pi prices from its own catalog whatever credential is behind it, so that
 * figure IS the list-price equivalent, and `piCostInputs` takes it as one.
 *
 * The turn's tokens go in with it. pi reporting `0` on a turn that really
 * moved tokens (an unpriced model in pi's own catalog) would otherwise be a
 * known zero the cap counts as free while the ledger prices the same tokens
 * off our table — one turn, two answers. `piCostInputs` only reaches for the
 * tokens when pi reported no positive charge, so a real figure still wins.
 * `reasoning` is folded in there, as output, exactly as it is for a pi
 * session's own messages.
 *
 * A turn whose tokens were never observed passes `undefined` and pi's figure
 * stands alone: a reported `0` stays a known zero, and the one way a pi turn
 * ends up unpriced is a non-finite figure (`usage.cost.total` arriving as
 * something the mapper's `+=` turns into NaN), which `resolveCosts` refuses to
 * count — the right answer.
 */
function piTurnCost(
  model: string,
  tokens: PiCostTokens | undefined,
  engineCostUsd: number
): ResolvedCosts {
  const { vendorId, modelId } = engineMeta('pi').decodeModelValue(model)
  return piMessageCosts(vendorId, modelId, tokens, engineCostUsd)
}

// ── Who a dispatched turn is billed to (ADR-071 §1 / §3) ────────────────────
// One helper per target, each reading the SAME source that engine's own
// sessions read, so a turn's row names the same account whether the work was
// dispatched or typed by a human.
//
// WHEN each is read follows what can actually change under the target. The
// opencode and pi helpers run PER TURN, off a credential file a sign-in can
// rewrite between turns while the target process keeps serving. The Codex and
// Claude helpers run ONCE at target creation (`CodexTargetEntry.account`,
// `ClaudeTargetEntry.account`), because those targets hold their credential
// from the moment they start: a Codex thread is pinned to the host it landed
// on (ADR-069 §2), and a dispatched cli.js process reads the app's
// credentials at spawn and never again.

/** The `unknown` account — a target that cannot name the account it ran under. */
const UNKNOWN_DISPATCH_ACCOUNT: DispatchTurnAccount = {
  accountKey: UNKNOWN_ACCOUNT_KEY,
  accountLabel: null,
  billingType: 'unknown'
}

/** An opencode target's account, off opencode's credential snapshot and auth probe. */
function opencodeDispatchAccount(model: string): DispatchTurnAccount {
  const { providerID } = parseModelString(model)
  return {
    ...opencodeAuthProvider.accountIdentity(providerID),
    billingType: opencodeAuthProvider.buildAccountRef(providerID)?.billingType ?? 'unknown'
  }
}

/** A pi target's account, off pi's own `auth.json` and auth probe. */
function piDispatchAccount(model: string): DispatchTurnAccount {
  const { vendorId } = engineMeta('pi').decodeModelValue(model)
  return {
    ...piAuthProvider.accountIdentity(vendorId),
    billingType: piAuthProvider.buildPiAccountRef(vendorId)?.billingType ?? 'unknown'
  }
}

/**
 * A Claude target's account: the one ClaudeUI itself is signed in as, since a
 * dispatched cli.js process inherits the app's active credential.
 *
 * The key and the label come from `activeClaudeAttribution`, the same rule
 * ADR-011's time-based attribution puts a TRANSCRIPT row through — run here
 * over the live active account instead of a log lookup, because the turn is
 * happening now and the log only records changes. Both halves of
 * `anthropic:<org>:<account>` or neither: that guard lives in the rule.
 *
 * The billing type is the ACTIVE ACCOUNT's, which `UsageFetcher` resolves
 * from `oauthAccount.billingType` — the only signal that tells a `usage_based`
 * OAuth account (billed per token, so its turns really do cost money) apart
 * from a plan. `ClaudeAuthProvider`'s probe-cached ref through the host seam
 * stays as the fallback for the window before the profile has been read at
 * all: for an OAuth account it can only ever answer `subscription` or
 * `unknown`, so reading it first would record a `usage_based` account's spend
 * as covered.
 */
function claudeDispatchAccount(): DispatchTurnAccount {
  // The same helper the usage fetcher and the limits provider attribute the
  // live account with, so a dispatched turn, a session's own turn and a limits
  // reading cannot disagree about the key, the label or the billing type.
  const attribution = activeClaudeAttribution(
    usageFetcher.getActiveAccount(),
    buildClaudeAccountRef()?.billingType
  )
  return {
    accountKey: attribution.accountKey,
    accountLabel: attribution.accountLabel,
    billingType: attribution.billingType
  }
}

// ── A dispatched turn's tokens, in the ledger's disjoint shape ──────────────
// (The pi target's fresh per-turn accumulator is `PiChildRunner.beginTurn`'s.)

// ── A dispatched turn as a ledger row (ADR-071 §1) ─────────────────────────

/**
 * The vendor/model split of a recorded row's `targetModel`, parsed the way the
 * TARGET engine encodes it (`engineMeta(...).decodeModelValue`): a bare model
 * id under a fixed vendor on Claude and Codex, `<vendor>/<model>` split on the
 * first slash on opencode and pi. An engine id this build does not know —
 * impossible from the call sites, which all pass a literal or an `EngineId` —
 * yields an `unknown` vendor rather than throwing inside a usage write.
 */
/**
 * The CANONICAL spelling of a target model value, for the one engine that
 * accepts more than one spelling of the same model.
 *
 * opencode and pi encode a model as `<vendor>/<model>` but decode a bare id by
 * supplying their default vendor, so `gpt-5-codex` and `opencode/gpt-5-codex`
 * name the same model while being different strings. That string is a KEY in
 * four places — the per-target cap, `ctx.addDispatchedCost`'s live breakdown
 * (`<engine>:<model>`), the notification text, and the ledger row, which
 * stores the decoded halves and whose reader re-encodes them. Canonicalising
 * once, here, is what makes the round trip exact: without it a session that
 * dispatched under a bare id shows the target twice after a reload, once per
 * spelling.
 *
 * It is wire-neutral. Every engine-facing call decodes the value again
 * (`parseModelString` for opencode, `decodeModelValue` before pi's
 * `set_model`), and decode is what both spellings already agreed on. Claude
 * and Codex encode a bare id, so for them this is the identity.
 *
 * `ENGINE_META` rather than `engineMeta()`: an unregistered engine must read
 * back verbatim, not throw inside a dispatch.
 */
function canonicalDispatchModel(engine: string, model: string): string {
  const meta = ENGINE_META[engine as keyof typeof ENGINE_META]
  if (!meta) return model
  return meta.encodeModelValue(meta.decodeModelValue(model))
}

function dispatchModelRef(
  targetEngine: string,
  targetModel: string
): { vendorId: string; modelId: string } {
  const meta = ENGINE_META[targetEngine as EngineId]
  if (!meta) return { vendorId: 'unknown', modelId: targetModel }
  const ref = meta.decodeModelValue(targetModel)
  return { vendorId: ref.vendorId, modelId: ref.modelId }
}

/**
 * The ledger's dedup key for a dispatched turn: `dispatch:<who>:<ts>:<seq>`.
 *
 * ONE ROW PER TURN, not per dispatch call. The tool_use id alone looked like
 * the natural key — it is minted by the caller model for this `dispatch_agent`
 * call — but a single call can run SEVERAL turns against the same target (a
 * continuation passes the same `sessionId`, and the model can reissue the same
 * tool call), and every one of them spends. Collapsing them onto one
 * `message_id` would hand the UNIQUE constraint every turn after the first to
 * drop, silently, while the cap counted them.
 *
 * So the id names the turn, not the call: whoever we can identify (the
 * tool_use id, else the target session, else nothing), the turn's timestamp,
 * and a per-dispatcher sequence number that separates two turns landing in the
 * same millisecond. It is deliberately NOT stable across app restarts — the
 * ledger's dedup exists to stop ONE write being replayed, and a dispatched
 * turn is written exactly once, live, by the process that ran it.
 */
function dispatchMessageId(row: DispatchedTurnRecord, seq: number): string {
  const who = row.toolUseId ?? row.targetSessionId ?? 'unknown'
  return `dispatch:${who}:${row.ts}:${seq}`
}

/**
 * One dispatched turn as the ledger records it.
 *
 * `origin: 'dispatch'` and `parentRoutingId` are what make the row findable as
 * delegated work — they are how the Delegated section and a session's own
 * dispatched-cost breakdown find it. The costs are derived by `rowCosts`
 * inside the recorder, from the same inputs every other writer hands it, so a
 * dispatched row is priced by exactly the rule a session's own row is.
 *
 * A MISSING TOKEN SPLIT RECORDS ZEROS. Several give-up paths know a turn
 * happened and nothing else (a refused prompt, a history read that failed),
 * and there is no "unknown" the token columns can hold. A reader must
 * therefore not treat a zero split as a free turn: `api_cost_usd` is where a
 * turn's worth lives, and it is null — not zero — when nothing could price it.
 */
function dispatchLedgerEvent(row: DispatchedTurnRecord, seq: number): UsageTurnEvent {
  const { vendorId, modelId } = dispatchModelRef(row.targetEngine, row.targetModel)
  const account = row.account ?? UNKNOWN_DISPATCH_ACCOUNT
  return {
    // The dispatcher's clock at the turn's end, not the write's — see
    // UsageTurnEvent.ts.
    ts: row.ts,
    engineId: row.targetEngine,
    vendorId,
    // A dispatch target is not one of the app's own sessions, so neither
    // local-account column applies; `accountKey` is the identity (ADR-071 §3).
    accountId: null,
    accountUuid: null,
    modelId,
    tokens: {
      input: row.tokens?.input ?? 0,
      output: row.tokens?.output ?? 0,
      cacheWrite: row.tokens?.cacheWrite ?? 0,
      // Only the Claude target reports the 1h-TTL cache-write SUBSET (cli.js's
      // `usage.cache_creation.ephemeral_1h_input_tokens`, billed at 2× input);
      // opencode, pi and Codex publish one cache-write rate and report none.
      cacheWrite1h: row.tokens?.cacheWrite1h ?? 0,
      cacheRead: row.tokens?.cacheRead ?? 0
    },
    engineCostUsd: row.engineCostUsd ?? null,
    sessionId: row.targetSessionId,
    messageId: dispatchMessageId(row, seq),
    source: 'live',
    accountKey: account.accountKey,
    accountLabel: account.accountLabel,
    billingType: account.billingType,
    origin: 'dispatch',
    parentRoutingId: row.fromRoutingId,
    engineCostIsEquivalent: row.engineCostIsEquivalent ?? false
  }
}

/**
 * The line a turn's tool result carries when the cap is configured but this
 * turn's cost could not be resolved (ADR-030 / ADR-071 §2): the dispatching
 * model is told the limit is not counting, instead of being left to assume a
 * silent zero was a real one.
 */
function cannotCountNote(model: string): string {
  return `\n\n[dispatch cost cap cannot count this turn: ${model} has no known price]`
}

/** Appended to a cap rejection whose spent figure is missing `n` turns. */
function unpricedSuffix(n: number): string {
  return n > 0
    ? ` ${n} turn(s) on this session could not be counted and are not in that figure.`
    : ''
}

/**
 * Piggybacks the existing per-dispatch heartbeat (ADR-033 M3): feeds
 * TaskCard's elapsed-time display via the engine-neutral subagent/task
 * pipeline. No-ops when `ctx.toolUseId` is unset (never fail a dispatch over
 * a missing id).
 */
function emitDispatchProgress(ctx: DispatchContext, elapsedTimeSeconds: number): void {
  if (!ctx.toolUseId) return
  ctx.emit('session:task-progress', {
    toolUseId: ctx.toolUseId,
    toolName: 'dispatch_agent',
    parentToolUseId: null,
    elapsedTimeSeconds
  })
}

/**
 * The run's `session:task-started` (ADR-105 §2): the same lifecycle the parent's own
 * background agents have, so the card, the roster and the attention gate read a
 * dispatch the way they read an agent. `taskId` is the X-Agent's ledger id.
 */
function dispatchTaskStartedRecord(
  run: DispatchRun,
  ledgerId: string
): Record<string, unknown> | null {
  if (!run.toolUseId) return null
  return {
    toolUseId: run.toolUseId,
    taskId: ledgerId,
    taskType: 'dispatch',
    // A run a message started is run n of the card the X-Agent was launched from (ADR-073's resume).
    ...runIndexField(run),
    ...(run.init.description ? { description: run.init.description } : {}),
    isBackgrounded: run.background,
    // A blocking run's end is its tool_result; a background run's end is a `dispatch-result`
    // delivered into the parent (ADR-105 §3), which starts a turn of its own. Either way the
    // parent is not waiting on the user while the record is armed, so the attention gate
    // holds back "Ready for input" (a result that has to wait raises its own attention).
    wakesParent: true,
    startedAt: run.init.startedAt
  }
}

/** `runIndex` on the card's records for run 2 and later; the first run carries none. */
function runIndexField(run: DispatchRun): { runIndex?: number } {
  const index = run.init.runIndex
  return index !== undefined && index > 1 ? { runIndex: index } : {}
}

function emitDispatchTaskStarted(ctx: RunContext, ledgerId: string): void {
  const record = dispatchTaskStartedRecord(ctx.run, ledgerId)
  if (record) ctx.emit('session:task-started', record)
}

/**
 * Final completion signal for a dispatch (ADR-033 M3) — mirrors
 * ClaudeSession's `session:task-notification` shape exactly (TaskCard reads
 * both identically). `usage` (ADR-033 M4-B) is populated only on paths that
 * have real per-turn numbers (success outcomes) — timeouts/stops/errors pass
 * it undefined rather than fabricate zeros for a turn that never returned.
 *
 * `taskId` is the run's ledger id (ADR-105). `summary` is the run's text for a
 * background run, cut at the delivery cap (`recordSummary`): the card draws it, and
 * §3's delivery puts the same words (framed) into the parent. A blocking run keeps the
 * short summary: its tool_result already carries the text, and the record rides every
 * sync-full.
 */
function emitDispatchNotification(
  ctx: RunContext,
  targetSessionId: string,
  status: 'completed' | 'failed' | 'stopped',
  summary: string,
  usage?: { totalTokens: number; toolUses: number; durationMs: number },
  report?: { handback: TaskHandback; warning?: string }
): void {
  ctx.run.notified = true
  ctx.run.terminalStatus = status
  ctx.run.terminalSummary = summary
  if (!ctx.toolUseId) return
  ctx.emit('session:task-notification', {
    taskId: ctx.run.ledgerId ?? targetSessionId,
    toolUseId: ctx.toolUseId,
    ...runIndexField(ctx.run),
    status,
    outputFile: '',
    // A report is the card's body (the `HandbackReport` component): whole, for a blocking run too, up to the
    // delivery cap (the record rides every sync-full; the full report is in `dispatch_report`).
    summary: recordSummary(ctx.run.background || report ? summary : summary.slice(0, 100)),
    // The card cannot tell from the tool input: a root agent's call runs in the background
    // without saying so (ADR-105 §2), and its result is only the launch acknowledgement.
    ...(ctx.run.background ? { isBackgrounded: true } : {}),
    ...(report
      ? { handback: report.handback, ...(report.warning ? { warning: report.warning } : {}) }
      : {}),
    usage
  })
}

/**
 * A turn's outcome as the run loop reads it. `needsReport`: the turn ended without a report
 * from an agent that has the `hand_back` tool, so nothing was announced yet — the loop nudges
 * it or withholds (ADR-105 §3).
 */
type TurnReturn = DispatchResult & { needsReport?: true; capNote?: string }

/** Wait for `promise` for at most `ms`; undefined when it did not settle in time. */
async function settledWithin<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Minimal pushable async iterable feeding Claude's streaming-input mode —
 * mirrors claude-session.ts's private `MessageChannel` (duplicated rather
 * than imported: importing from claude-session.ts here would form a
 * require-cycle, since claude-session.ts imports THIS module for
 * `crossEngineDispatcher`/`createCollabServer` wiring).
 */
class ClaudeInputChannel implements AsyncIterable<Record<string, unknown>> {
  private queue: Record<string, unknown>[] = []
  private waiting: ((result: IteratorResult<Record<string, unknown>>) => void) | null = null
  private isDone = false

  push(msg: Record<string, unknown>): void {
    if (this.isDone) return
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = null
      resolve({ value: msg, done: false })
    } else {
      this.queue.push(msg)
    }
  }

  end(): void {
    this.isDone = true
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = null
      resolve({ value: undefined as unknown as Record<string, unknown>, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<Record<string, unknown>> {
    return this as unknown as AsyncIterator<Record<string, unknown>>
  }

  async next(): Promise<IteratorResult<Record<string, unknown>>> {
    if (this.queue.length > 0) {
      return { value: this.queue.shift()!, done: false }
    }
    if (this.isDone) {
      return { value: undefined as unknown as Record<string, unknown>, done: true }
    }
    return new Promise((resolve) => {
      this.waiting = resolve
    })
  }
}

/**
 * Prefixed to every prompt a Claude TARGET receives (ADR-088). cli.js's own
 * auto-mode judge sees only the target's transcript, where the dispatch prompt
 * is a `user` message — without this it would read another agent's words as
 * the user's own authorisation. pi/opencode targets need none (ClaudeUI's
 * judge reads the PARENT transcript with a `dispatch:<engine>` subagent
 * header); Codex's guardian is left alone.
 */
export const DISPATCH_PROMPT_PREAMBLE =
  'Task delegated to you by another agent acting for the user:\n\n'

/** Build the `{type:'user', ...}` SDK message shape cli.js expects on the
 *  streaming-input channel — mirrors claude-session.ts's `run()`, with the
 *  {@link DISPATCH_PROMPT_PREAMBLE} in front of the prompt. */
function buildClaudeDispatchMessage(
  prompt: string,
  sessionId: string | null,
  preamble = true,
  /** The client uuid cli.js reports the frame's fate under (`command_lifecycle`, 03 §3.21); without one it reports nothing. */
  uuid?: string
): Record<string, unknown> {
  return {
    type: 'user' as const,
    ...(uuid ? { uuid } : {}),
    session_id: sessionId ?? '',
    message: {
      role: 'user' as const,
      content: (preamble ? DISPATCH_PROMPT_PREAMBLE : '') + prompt
    },
    parent_tool_use_id: null
  }
}

/**
 * Are the Claude target's own tools (`hand_back`, `session_message`) in the process's
 * `allowedTools`? Only in the modes where cli.js would deny them unasked: `dontAsk` turns every ask
 * into a denial and `bypassPermissions` needs no ask. In every other mode `canUseTool` allows them
 * (in auto only the report; a message there is reviewed like any other action), and an allow rule
 * would skip the auto-mode classifier for a target that is, or later is switched, into auto (B-3c,
 * B-4). One function for both tools, so they cannot disagree.
 */
function claudeOwnToolsPreAllowed(mode: PermissionMode): boolean {
  return mode === 'dontAsk' || mode === 'bypassPermissions'
}

/** The Claude target's `session_message`, as cli.js names it: `mcp__claude-ui-sessions__session_message`. */
const CLAUDE_SESSION_MESSAGE_TOOL = `${SESSION_TOOLS_PREFIX}${X_AGENT_MESSAGE_TOOL}`

/**
 * Map the dispatching session's inherited autonomy (a Claude-style
 * permission-mode string) to the Claude TARGET's permissionMode (ADR-033 M2
 * item 5, amended by ADR-088).
 *  - 'auto' → cli.js `auto`: the target is JUDGED by cli.js's own auto-mode
 *    classifier (ADR-088 rulings 1-2), never run allow-all. No skip flag —
 *    `auto` needs none.
 *  - 'bypassPermissions' → bypassPermissions + allowDangerouslySkipPermissions:
 *    a parent that is itself in bypass is not in auto, and its target is
 *    allow-all too, except the user's deny/ask rules (ADR-085 §3, passed as
 *    `--settings`): cli.js returns an ask for a bare or specifier ask rule
 *    BEFORE its bypassPermissions mode-allow branch, and a deny before that
 *    (cli.js 2.1.280 `kNt`, verified 2026-09-30).
 *  - 'plan' → 'default': a strictly read-only dispatched agent can't do any
 *    useful work, so we fall back to the conservative ask-everything mode
 *    instead of inheriting plan's refusal-by-default.
 *  - anything else passes through unchanged ('default', 'acceptEdits', ...).
 */
function mapAutonomyToClaudeTargetMode(autonomyMode: string): {
  permissionMode: PermissionMode
  allowDangerouslySkipPermissions: boolean
} {
  switch (autonomyMode) {
    case 'auto':
      return { permissionMode: 'auto', allowDangerouslySkipPermissions: false }
    case 'bypassPermissions':
      return { permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true }
    case 'plan':
      return { permissionMode: 'default', allowDangerouslySkipPermissions: false }
    default:
      return {
        permissionMode: autonomyMode as PermissionMode,
        allowDangerouslySkipPermissions: false
      }
  }
}

/**
 * Real default for `DispatcherDeps.spawnClaudeQuery`. Duplicates
 * `getSdkExecutableOpts()` (claude-session.ts) inline rather than importing
 * it — claude-session.ts imports THIS module (for the collab server /
 * disposeFor wiring), so importing back would form a require-cycle. Like it,
 * this names no executable: `query()` spawns the resolver's Claude Code launch
 * (ADR-082 §2).
 */
async function defaultSpawnClaudeQuery(opts: ClaudeQuerySpawnOpts): Promise<QueryHandle> {
  const engineCfg = loadEngineConfig('claude')
  await claudeSpawnPrep(opts.model, engineCfg)
  // After the spawn prep: it is what sets an endpoint profile, which decides
  // whether this spawn carries a host token at all.
  await ensureHostTokenFresh()
  return sdkQuery({
    prompt: opts.prompt as AsyncIterable<never>,
    options: {
      standaloneExecutable: true,
      env: {},
      cwd: opts.cwd,
      model: opts.model,
      permissionMode: opts.permissionMode,
      ...(opts.allowDangerouslySkipPermissions ? { allowDangerouslySkipPermissions: true } : {}),
      // Persisted (ADR-105), never `--no-session-persistence`: the transcript is what a
      // later `--resume` continues. The ledger row naming this id exists BEFORE the
      // spawn, so every transcript reader already skips it.
      ...(opts.resume
        ? { resume: opts.resume }
        : opts.sessionId
          ? { sessionId: opts.sessionId }
          : {}),
      settingSources: [],
      ...(opts.settings ? { settings: opts.settings } : {}),
      ...(opts.mcpServers ? { mcpServers: opts.mcpServers } : {}),
      ...(opts.allowedTools ? { allowedTools: opts.allowedTools } : {}),
      ...(opts.onInboundFrame ? { onInboundFrame: opts.onInboundFrame } : {}),
      abortController: opts.abortController,
      canUseTool: opts.canUseTool,
      // ADR-033 M3: stream_event text/thinking deltas so driveClaudeTurn can
      // forward them as item open/delta/seal events under the dispatch TaskCard.
      includePartialMessages: true
    }
  })
}

/**
 * Real default for `DispatcherDeps.spawnPiTarget` (ADR-033 M4c):
 * `defaultSpawnPiChild` (pi-child-runner.ts, ADR-089), which mirrors
 * `PiSession.doStart()`'s spawn shape (bridge host first, then the version-
 * keyed extension file, then the child), with two deliberate differences for
 * a headless DISPATCH target:
 *  - a persisted but HIDDEN session (ADR-105; was `--no-session`): `--session-dir
 *    ~/.claude/ui/dispatch/pi/<ledgerId> --session-id <id>`, outside the
 *    `~/.pi/agent/sessions` the sidebar lists, so the target can be resumed
 *    from its ledger row after its parent restarts.
 *  - NO `CLAUDEUI_PI_HOSTED_TOOLS` / `CLAUDEUI_PI_DISPATCH_ENABLED` /
 *    `CLAUDEUI_PI_SKILL_DIRS` in the target's env — `buildPiTargetChildEnv`
 *    both OMITS them from what it builds AND explicitly overrides them to
 *    `''` in the returned env object (PiRpcClient spawns with `{...process.
 *    env, ...opts.env}`, so omission ALONE would leak through whatever the
 *    ClaudeUI process's OWN env happens to carry — see buildPiTargetChildEnv's
 *    doc comment for the full recursion-guard rationale). The bridge
 *    extension's hosted-tool registrations (render_mermaid/create_mockup/
 *    show_mockup/dispatch_agent) are gated on the first two
 *    (pi-bridge-source.ts); disabling them means the target's OWN pi process
 *    never has a `dispatch_agent` tool to call in the first place — recursion
 *    is impossible at the wire level, not just by policy (mirrors ADR-033
 *    §4's "dispatcher-created targets never get the collab server"). Belt-
 *    and-suspenders even if a hosted tool were somehow still registered: the
 *    target's `PiBridgeHost` has a `hostedToolHandler` for its two tools only
 *    (`hand_back`, ADR-105 §3, and `session_message` to its dispatcher, §4 — both
 *    registered under their own gates), so a `/hosted-tool` execute of any other
 *    tool fails closed with an isError result — never actually runs anything. The
 *    approval gate (the extension's `tool_call`
 *    hook) still activates normally — it depends ONLY on
 *    `CLAUDEUI_PI_BRIDGE_URL`/`TOKEN`, independent of the hosted-tools gate
 *    (verified against pi-bridge-source.ts's own independence design).
 *  - The shared MCP catalog IS registered (ADR-096, `CLAUDEUI_PI_MCP=1`, the
 *    servers handed to the target's bridge host at the spawn site), as an
 *    opencode target gets it — MCP tools are not a recursion path.
 */
/**
 * The env vars a pi dispatch TARGET's child process gets. Extracted as a pure
 * function (rather than inlined into `defaultSpawnPiTarget`) so the
 * recursion-guard property is DIRECTLY unit-testable without mocking
 * PiRpcClient/PiBridgeHost/locatePiLaunch: NO `CLAUDEUI_PI_HOSTED_TOOLS` /
 * `CLAUDEUI_PI_DISPATCH_ENABLED` / `CLAUDEUI_PI_SKILL_DIRS` — see
 * `defaultSpawnPiTarget`'s doc comment for the full rationale.
 *
 * The three gate vars are set to `''` EXPLICITLY, not merely left out of this
 * object: `PiRpcClient` spawns with `{...process.env, ...opts.env}` (this
 * object is `opts.env`), so plain omission would let the flag leak straight
 * through from the ClaudeUI process's OWN env if IT happens to carry one
 * (e.g. a dev shell that exports `CLAUDEUI_PI_HOSTED_TOOLS=1` for its own pi
 * session) — the target would then see hosted tools registered (still unable
 * to execute them, see `defaultSpawnPiTarget`'s doc comment, but visible and
 * always-erroring to the model). The bridge extension's gates are plain
 * truthiness/`=== '1'` checks (pi-bridge-source.ts) — `''` is falsy against
 * both, so this reliably disables all three regardless of what the parent
 * process happens to have set.
 */
export function buildPiTargetChildEnv(
  bridge: { url: string; token: string },
  handBack = false,
  messaging = false
): NodeJS.ProcessEnv {
  return {
    CLAUDEUI_PI_BRIDGE_URL: bridge.url,
    CLAUDEUI_PI_BRIDGE_TOKEN: bridge.token,
    CLAUDEUI_PI_HOSTED_TOOLS: '',
    CLAUDEUI_PI_DISPATCH_ENABLED: '',
    CLAUDEUI_PI_DISPATCH_DESCRIPTION: '',
    // The session tools are for a session's root agent (slice 2); a target gets the one tool that
    // reaches its dispatcher (ADR-105 §4), as a one-element array: the bridge registers exactly
    // what the array holds, so there is no gate of its own.
    CLAUDEUI_PI_SESSION_TOOLS: messaging ? xAgentSessionToolsEnv() : '',
    CLAUDEUI_PI_SKILL_DIRS: '',
    // ADR-089: a dispatch target never gets the host-run `agent` or
    // `send_message` tools (same leak argument as the three above).
    CLAUDEUI_PI_AGENT_TOOL: '',
    CLAUDEUI_PI_SEND_MESSAGE: '',
    // ADR-105 §3: the one tool a target is for — the report that ends its run.
    CLAUDEUI_PI_HAND_BACK: handBack ? '1' : '',
    // ADR-096: a dispatch target registers the shared MCP catalog, as an
    // opencode target does; the configs come from the target's own bridge
    // host (`mcpServers` at the spawn site), never from this env.
    CLAUDEUI_PI_MCP: '1'
  }
}

/**
 * The flags a pi dispatch target's spawn carries after `--mode rpc -e
 * <bridge>` and its env — see `defaultSpawnPiTarget`'s doc comment above.
 * Handed to whichever spawn is active (real or test-injected) in the spawn
 * opts, so the dispatcher states them once.
 */
function piTargetSpawnFlags(
  sessionDir: string,
  sessionId: string,
  handBack: boolean,
  messaging: boolean
): Pick<PiTargetSpawnOpts, 'args' | 'env'> {
  return {
    // Persisted and hidden (ADR-105, the ADR-089 sub-agent precedent): the same two
    // flags create the session and resume it (pi opens the file when it exists).
    args: ['--session-dir', sessionDir, '--session-id', sessionId],
    env: (bridge) => buildPiTargetChildEnv(bridge, handBack, messaging)
  }
}

const defaultSpawnPiTarget: SpawnPiTargetFn = defaultSpawnPiChild

export class CrossEngineDispatcher {
  private readonly deps: DispatcherDeps
  private readonly resolveMaxConcurrent: () => number
  private readonly heartbeatMs: number
  private readonly piAbortSettleGraceMs: number
  private readonly codexAbortSettleGraceMs: number
  private readonly spawnClaudeQuery: SpawnClaudeQueryFn
  private readonly loadUserRules: (cwd: string) => MergedClaudeRules
  private readonly spawnPiTarget: SpawnPiTargetFn
  private readonly attachCodexTarget: AttachCodexTargetFn
  private readonly codexVaultAccounts: boolean
  private readonly recordLedgerEvent: (event: UsageTurnEvent) => void
  /** The X-Agent ledger (ADR-105). */
  private readonly ledger: DispatchLedgerStore
  private readonly locateTranscript: (sessionId: string, cwd: string) => string | null
  private readonly codexResumeLockWindowMs: number
  private readonly codexResumeLockRetryMs: number
  private readonly codexHoldsThread: (threadId: string) => boolean
  private readonly piSessionDirExists: (dir: string) => boolean
  private readonly requireHandBack: boolean
  private readonly reports: DispatchReportStore
  private readonly handBackSettleMs: number
  private readonly ownWorkWaitMs: number
  private readonly handBackReviewMs: number
  private readonly messageRunEndWaitMs: number
  private readonly messageStartWaitMs: number

  /**
   * Monotonic per-dispatcher counter, one tick per ledger row — the tiebreak
   * in {@link dispatchMessageId}, so two turns that land in the same
   * millisecond are still two rows.
   */
  private ledgerSeq = 0

  /** The steers accepted into running turns and not yet forgotten (bounded; see {@link SteerRecord}). */
  private readonly steers = new Map<string, SteerRecord>()
  /** The messages to each X-Agent in flight, one after another (see {@link messageXAgent}). */
  private readonly messageChains = new Map<string, Promise<unknown>>()
  /** Keyed by target session id (opencode session id, or Claude session UUID). */
  private targets = new Map<string, TargetEntry>()
  /** opencode feed records, keyed by SERVER (`serverKey`), never by cwd. */
  private connections = new Map<string, ConnRecord>()
  /** Target sessions to delete once a server is reachable (lost with theirs). */
  private orphanSessions = new Set<string>()
  /** Per dispatching session, bumped by `disposeFor`: a target created across one is disposed too. */
  private disposals = new Map<string, number>()
  /**
   * Harness session ids a continuation is rebuilding from the ledger right now: a
   * second call naming one is busy-rejected instead of resuming the same session twice.
   */
  private resuming = new Set<string>()
  /** Keyed by prefixed requestId ('xeng:<id>'). */
  private pendingApprovals = new Map<string, PendingForwardedApproval>()
  /**
   * Every run in flight (ADR-105 §2), by ledger id and by launching tool_use id, for
   * the run's whole life: `stopDispatch` resolves a run through it, and the
   * concurrency cap counts its size. Replaces the per-call `activeByToolUseId` /
   * `activeDispatches` pair, which died with the call frame.
   */
  private readonly runs = new DispatchRunRegistry()
  /** How runs reach their dispatching session; see {@link DispatcherDeps.parents}. */
  private parents: DispatchParentLookup | undefined
  private unsubscribeRekey: () => void = (): void => {}
  /**
   * Durable stop-intents (ADR-033 M3), keyed by dispatching tool_use id.
   * Closes the LAST stop race window — the one UPSTREAM of the dispatcher:
   * opencode marks the tool part "running" (and the renderer's Stop becomes
   * clickable) milliseconds after `ctx.ask` resolves, while the MCP
   * tools/call HTTP round-trip + handler prelude can take much longer, so a
   * Stop click can arrive before `dispatch()` is even invoked and NO
   * registration timing inside the dispatcher can win it. `stopDispatch`
   * with `armIfUnknown` records the intent here; `launchRun` consumes it
   * first thing and refuses the call before any target, ledger row or run exists.
   *
   * An intent has no clock: the call it waits for may not start for as long as the
   * calls before it run — cli.js runs a first-party MCP call such as `dispatch_agent`
   * only when nothing else of its assistant message is executing, so a second dispatch
   * behind a blocking one starts when that one ends, minutes later. It lives until it is
   * consumed, or until the turn it was armed in is over ({@link dropPendingStops}: the
   * parent's `session:result`, its disposal, its deletion), after which the call it was
   * armed for can no longer start.
   *
   * Accepted residual: a queued dispatch call of a BACKGROUND subagent is armed under the main
   * session too, so the main turn's end drops its intent, and a call that starts after that is
   * not stopped (it runs, and the user can Stop it again from its card).
   */
  private pendingStops = new Map<string, PendingStop>()
  private readonly now: () => number

  constructor(deps: DispatcherDeps) {
    this.deps = deps
    this.resolveMaxConcurrent = deps.resolveMaxConcurrent ?? defaultResolveMaxConcurrent
    this.heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS
    this.piAbortSettleGraceMs = deps.piAbortSettleGraceMs ?? PI_ABORT_SETTLE_GRACE_MS
    this.codexAbortSettleGraceMs = deps.codexAbortSettleGraceMs ?? CODEX_ABORT_SETTLE_GRACE_MS
    this.spawnClaudeQuery = deps.spawnClaudeQuery ?? defaultSpawnClaudeQuery
    this.loadUserRules = deps.loadUserRules ?? mergedClaudeRulesFor
    this.spawnPiTarget = deps.spawnPiTarget ?? defaultSpawnPiTarget
    this.attachCodexTarget = deps.attachCodexTarget ?? defaultAttachCodexTarget(codexHostRegistry)
    this.codexVaultAccounts = deps.codexVaultAccounts ?? false
    this.now = deps.now ?? Date.now
    this.recordLedgerEvent = deps.recordUsageEvent ?? recordUsageEvent
    this.ledger = deps.ledger ?? dispatchLedger
    this.locateTranscript = deps.locateClaudeTranscript ?? locateClaudeTranscript
    this.codexResumeLockWindowMs = deps.codexResumeLockWindowMs ?? CODEX_RESUME_LOCK_WINDOW_MS
    this.codexResumeLockRetryMs = deps.codexResumeLockRetryMs ?? CODEX_RESUME_LOCK_RETRY_MS
    this.codexHoldsThread =
      deps.codexHoldsThread ?? ((threadId) => codexHostRegistry.holdsThread(threadId))
    this.piSessionDirExists = deps.piSessionDirExists ?? existsSync
    this.requireHandBack = deps.requireHandBack ?? false
    this.reports = deps.reports ?? dispatchReports
    this.handBackSettleMs = deps.handBackSettleMs ?? HAND_BACK_SETTLE_MS
    this.ownWorkWaitMs = deps.ownWorkWaitMs ?? OWN_WORK_WAIT_MS
    this.handBackReviewMs = deps.handBackReviewMs ?? HAND_BACK_REVIEW_MS
    this.messageRunEndWaitMs = deps.messageRunEndWaitMs ?? MESSAGE_RUN_END_WAIT_MS
    this.messageStartWaitMs = deps.messageStartWaitMs ?? MESSAGE_START_WAIT_MS
    this.parents = deps.parents
  }

  /**
   * Wire how runs reach their dispatching session (the singleton is built at module
   * load, before the session manager exists) and follow its re-keys: a run's parent id
   * is cached, never read from the ledger per event. Returns the unsubscribe.
   */
  configureParents(
    parents: DispatchParentLookup,
    onRekey?: (observer: (oldId: string, newId: string) => void) => () => void,
    onHostEvent?: (observer: (channel: string, args: unknown[]) => void) => () => void
  ): () => void {
    this.releaseParents()
    this.parents = parents
    const stopRekey = onRekey?.((oldId, newId) => this.runs.rekey(oldId, newId)) ?? ((): void => {})
    // A parent's disconnect clears the task records and approval cards its X-Agents
    // announced; its deletion ends them (ADR-105 §5).
    const stopEvents =
      onHostEvent?.((channel, args) => this.onHostEvent(channel, args)) ?? ((): void => {})
    this.unsubscribeRekey = (): void => {
      stopRekey()
      stopEvents()
    }
    return () => this.releaseParents()
  }

  /** Stop following the previous wiring's rekeys and events (a reconfigure, or the host's teardown). */
  private releaseParents(): void {
    this.unsubscribeRekey()
    this.unsubscribeRekey = (): void => {}
  }

  /**
   * The two events of a parent's life that concern its X-Agents (a host observer: it runs
   * after the reducer folded the event and before clients see it).
   *
   *  - `session:status` `disconnected`: the reducer has just cleared the session's
   *    `activeTasks` and `pendingApprovals`, which are all the parent's cards of its
   *    running X-Agents. {@link reRaiseFor} puts them back. This status — and not the
   *    creation of a new session object — is the trigger: a `cancel()` on the SAME object
   *    clears them with no re-creation, while a replacement by `SessionManager.create`
   *    clears nothing (the old object's `dispose()` sends no status), so re-raising on
   *    re-creation would double every approval card.
   *
   * A parent's DELETION is not read from `session:removed`: the delete paths announce it
   * before the engine has accepted the delete, and a refused delete must leave the
   * X-Agents alone. They call {@link endParent} once the engine said yes.
   */
  private onHostEvent(channel: string, args: unknown[]): void {
    const parentId = args[0]
    if (typeof parentId !== 'string') return
    try {
      if (
        channel === 'session:status' &&
        (args[1] as { state?: string } | undefined)?.state === 'disconnected'
      )
        this.reRaiseFor(parentId)
      // A turn's end settles every call of it: one that never started (cli.js answers it
      // with an error result) has nothing left to stop.
      if (channel === 'session:result') this.dropPendingStops(parentId)
    } catch (err) {
      logger.warn('CrossEngineDispatcher', `parent event "${channel}" failed: ${errText(err)}`)
    }
  }

  /** Forget the stop-intents armed in `parentId`'s turn: see the `pendingStops` field doc. */
  private dropPendingStops(parentId: string): void {
    const parent = this.runs.parentOf(parentId)
    for (const [key, intent] of this.pendingStops) {
      if (intent.routingId !== undefined && this.runs.parentOf(intent.routingId) === parent) {
        this.pendingStops.delete(key)
      }
    }
  }

  /**
   * Put back what a parent's disconnect cleared: the task record of every running run it
   * launched, and every approval card a target of its still waits on. Only ever called
   * right after such a clear (see {@link onHostEvent}), so nothing shows twice.
   */
  private reRaiseFor(parentId: string): void {
    const parents = this.parents
    if (!parents) return
    const parent = this.runs.parentOf(parentId)
    for (const run of this.runs.ofParent(parent)) {
      if (!run.bound || !run.ledgerId) continue
      const record = dispatchTaskStartedRecord(run, run.ledgerId)
      if (record) parents.emit(parent, 'session:task-started', record)
    }
    for (const pending of this.pendingApprovals.values()) {
      const target =
        pending.targetSessionId === null ? undefined : this.targets.get(pending.targetSessionId)
      if (target && this.ownedBy(target, parent)) {
        parents.emit(parent, 'session:approval-request', { ...pending.card, reRaised: true })
      }
    }
  }

  /**
   * A parent session was deleted — and its engine accepted the delete: every X-Agent it
   * owns ends, running or not. A running one is stopped first and ends when its turn has
   * settled (the run's own close); the rest end now. One that fails to end does not keep
   * the others from it.
   */
  endParent(parentId: string): void {
    const parent = this.runs.parentOf(parentId)
    this.dropPendingStops(parentId)
    const running = new Set<string>()
    for (const run of this.runs.ofParent(parent)) {
      run.endRequested = true
      run.parentEnded = true
      try {
        run.stopController.abort()
      } catch (err) {
        logger.warn('CrossEngineDispatcher', `could not stop a run of ${parent}: ${errText(err)}`)
      }
      if (run.ledgerId) running.add(run.ledgerId)
    }
    let rows: DispatchTargetRow[] = []
    try {
      rows = this.ledger.byParent(parent)
    } catch (err) {
      logger.warn('CrossEngineDispatcher', `dispatch ledger lookup failed: ${errText(err)}`)
    }
    for (const row of rows) {
      if (running.has(row.id) || row.state === 'stopped') continue
      try {
        this.endTarget(row.id, row)
      } catch (err) {
        logger.warn('CrossEngineDispatcher', `could not end X-Agent ${row.id}: ${errText(err)}`)
      }
    }
  }

  /** A re-keyed parent's old id now means its durable one (also what `configureParents` wires). */
  noteParentRekey(oldId: string, newId: string): void {
    this.runs.rekey(oldId, newId)
  }

  /** For tests: current in-flight dispatch count (runs registered). */
  get inFlightCount(): number {
    return this.runs.size
  }

  /**
   * The user's deny and ask rules for `cwd`, with an EMPTY allow tier (ADR-085
   * §3, owner ruling 3: deny/ask rules hold in every mode, dispatch targets
   * included). Targets never get the user's allow rules or additional
   * directories — a dispatched agent is governed by its autonomy mode, not by
   * what the user pre-approved for their own chats (ADR-033). Read fresh per
   * call, like the interactive sessions' gates.
   */
  private userDenyAsk(cwd: string, restriction?: CallerRestriction): MergedClaudeRules {
    const rules = this.loadUserRules(cwd)
    return {
      deny: [...rules.deny, ...(restriction?.deny ?? [])],
      ask: [...rules.ask, ...(restriction?.ask ?? [])],
      allow: [],
      additionalDirectories: [],
      defaultMode: undefined
    }
  }

  /**
   * Record one dispatched turn in the ledger (ADR-071 §1) — the only record of
   * it there now is. `dispatched_usage` was a second, poorer copy: no token
   * split, no account, no billing type, one cost the dispatcher resolved on
   * its own. Its readers moved to `origin = 'dispatch'` and migration v20
   * dropped the table.
   *
   * FAILURES ARE ISOLATED (ADR-033 M4-B). The default is a real DB write — if
   * it throws (locked DB, disk error), the exception must never propagate into
   * the dispatch flow, where `dispatch()`'s catch would report a COMPLETED turn
   * back to the caller model as `Dispatch failed: …`. Usage accounting is
   * best-effort by design; the turn result is not.
   */
  private safeRecordUsage(row: DispatchedTurnRecord): void {
    try {
      this.recordLedgerEvent(dispatchLedgerEvent(row, ++this.ledgerSeq))
    } catch (err) {
      logger.warn(
        'CrossEngineDispatcher',
        `dispatched usage_event failed (ledger row dropped): ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  // ── The X-Agent ledger (ADR-105) ───────────────────────────────────────────

  /**
   * Record a NEW target before its harness session is used. The row is what makes
   * every transcript reader skip the session, so it must exist before the first
   * byte is written; a ledger that cannot take it fails the dispatch (an unrecorded
   * target could neither be hidden nor resumed).
   */
  private recordTarget(
    ctx: RunContext,
    spec: {
      engine: EngineId
      harnessRef: string
      model: string
      accountKey: string | null
      codexAccountId?: string | null
      labels?: DispatchLabels
      /** The target was started with the `hand_back` tool. */
      handBack: boolean
    }
  ): DispatchTargetRow {
    const row = this.ledger.create({
      engine: spec.engine,
      harnessRef: spec.harnessRef,
      parentSessionId: ctx.fromRoutingId,
      parentEngine: ctx.fromEngine,
      parentToolUseId: ctx.toolUseId ?? null,
      cwd: ctx.cwd,
      model: spec.model,
      launchMode: liveMode(ctx),
      accountKey: spec.accountKey,
      codexAccountId: spec.codexAccountId ?? null,
      callerRestriction: ctx.callerRestriction ? JSON.stringify(ctx.callerRestriction) : null,
      name: labelOf(spec.labels?.name),
      description: labelOf(spec.labels?.description),
      handBack: spec.handBack
    })
    ctx.run.createdTarget = true
    this.bindRun(ctx, row.id, row.harnessRef, row)
    return row
  }

  /** A continuation's target is known (and accepted): the run answers to its existing row. */
  private bindContinuation(
    ctx: RunContext,
    cont: { live: TargetEntry } | { row: DispatchTargetRow }
  ): void {
    if ('row' in cont) {
      this.bindRun(ctx, cont.row.id, cont.row.harnessRef, cont.row)
      return
    }
    let row: DispatchTargetRow | undefined
    try {
      row = this.ledger.get(cont.live.ledgerId)
    } catch {
      row = undefined
    }
    this.bindRun(ctx, cont.live.ledgerId, cont.live.sessionId ?? '', row)
  }

  /**
   * The run's target is known (its ledger row exists): the run answers to the row's id
   * from here on, announces itself to the parent as a task, and a background launch may
   * return. Called at the last point a launch can still be REFUSED synchronously — after
   * that, a failure ends the run `failed` (a notification) instead of failing the call.
   */
  private bindRun(
    ctx: RunContext,
    ledgerId: string,
    harnessId: string,
    row?: Pick<DispatchTargetRow, 'launchMode'>
  ): void {
    const { run } = ctx
    if (run.bound) return
    // A parent whose engine is down is judged under the mode the target LAUNCHED under (the
    // row's) — but never a looser one than this call's own, which a parent that tightened
    // since the launch has just made: a continuation does not loosen it either way.
    if (row) run.launchMode = stricterMode(row.launchMode, run.init.launchMode)
    this.runs.bind(run, ledgerId, harnessId)
    emitDispatchTaskStarted(ctx, ledgerId)
  }

  /**
   * Update a target's row. Best effort: the row records the target, it is never a
   * reason to fail or abandon a turn that ran.
   */
  private ledgerSet(ledgerId: string, patch: Parameters<DispatchLedgerStore['update']>[1]): void {
    try {
      this.ledger.update(ledgerId, { lastActiveAt: this.now(), ...patch })
    } catch (err) {
      logger.warn('CrossEngineDispatcher', `dispatch ledger update failed: ${errText(err)}`)
    }
  }

  /** A live (not released) target's row takes the state its turn started or ended in. */
  private ledgerTurnState(
    entry: Pick<TargetLedgerFields, 'ledgerId' | 'released'>,
    state: DispatchTargetState
  ): void {
    if (!entry.released) this.ledgerSet(entry.ledgerId, { state })
  }

  /**
   * Does `routingId` own this target? Its in-memory owner id, else its ledger row's:
   * `SessionManager.rekey` moves the row to the parent's durable id, not the entry.
   */
  private ownedBy(entry: TargetEntry, routingId: string): boolean {
    if (entry.fromRoutingId === routingId) return true
    try {
      return this.ledger.get(entry.ledgerId)?.parentSessionId === routingId
    } catch {
      return false
    }
  }

  /**
   * Where a continuation (`session_id`) goes: the live entry this caller owns, else the
   * ledger row this caller owns (a target released by its parent's restart, or left by a
   * restart of the app), else null — the "Unknown dispatch session" refusal.
   *
   * Only a row whose `parent_session_id` is the CALLER's resumes. `req.sessionId` is
   * model-authored text: resuming whatever it names would let a dispatching agent reopen
   * any Codex thread or Claude session on disk (the Codex rule, below), with no owner
   * check to refuse it. A row with an unreadable caller restriction is refused too —
   * reading it as "none" would loosen a restricted target.
   */
  private findContinuation<K extends TargetEntry['kind']>(
    sessionId: string,
    ctx: DispatchContext,
    kind: K
  ): { live: Extract<TargetEntry, { kind: K }> } | { row: DispatchTargetRow } | null {
    const existing = this.targets.get(sessionId)
    if (existing) {
      if (existing.kind !== kind || !this.ownedBy(existing, ctx.fromRoutingId)) return null
      existing.fromRoutingId = ctx.fromRoutingId
      return { live: existing as Extract<TargetEntry, { kind: K }> }
    }
    let row: DispatchTargetRow | undefined
    try {
      row = this.ledger.getByHarnessRef(kind, sessionId)
    } catch (err) {
      logger.warn('CrossEngineDispatcher', `dispatch ledger lookup failed: ${errText(err)}`)
    }
    if (!row || row.parentSessionId !== ctx.fromRoutingId || row.state === 'stopped') return null
    if (row.callerRestriction !== null && parseCallerRestriction(row.callerRestriction) === null)
      return null
    return { row }
  }

  /**
   * The restriction a continuation's target holds: its live entry's, else (a released
   * target) its ledger row's — only for the owner; anyone else holds nothing here and is
   * refused by the engine path. Null = a row whose restriction cannot be read.
   */
  private heldRestriction(
    req: DispatchRequest & { sessionId: string },
    ctx: DispatchContext
  ): CallerRestriction | undefined {
    const live = this.targets.get(req.sessionId)
    if (live) return live.ctx.callerRestriction
    const cont = this.findContinuation(req.sessionId, ctx, req.engine as TargetEntry['kind'])
    if (!cont || !('row' in cont)) return undefined
    return parseCallerRestriction(cont.row.callerRestriction) ?? undefined
  }

  /**
   * What a continuation starts the cost cap from, or the refusal it gets (ADR-033 M4-C):
   * a live entry's running figure, or — for a target rebuilt from its row — the
   * API-equivalent sum of its recorded turns (the measure the live gate counts, ADR-071).
   * A cap that is configured while that sum cannot be read FAILS CLOSED: seeding 0 would
   * let a target past a limit it has already crossed.
   */
  private continuationSpend(
    cont: { live: TargetEntry } | { row: DispatchTargetRow },
    cfg: DispatchConfig | undefined,
    sessionId: string,
    engine: EngineId
  ): { costUsd: number; unpricedTurns: number } | DispatchResult {
    let spent: { costUsd: number; unpricedTurns: number }
    if ('live' in cont) {
      spent = {
        costUsd: cont.live.cumulativeCostUsd,
        unpricedTurns: (cont.live as { unpricedTurns?: number }).unpricedTurns ?? 0
      }
    } else {
      try {
        spent = this.ledger.spend(cont.row.harnessRef)
      } catch (err) {
        logger.warn('CrossEngineDispatcher', `dispatch spend lookup failed: ${errText(err)}`)
        if (cfg?.maxCostUsd === undefined) return { costUsd: 0, unpricedTurns: 0 }
        return errorResult(
          `Dispatch session "${sessionId}" cannot be continued: its recorded spend could not be read, ` +
            `and a cost cap ($${cfg.maxCostUsd}) is configured. Try again, or start a fresh dispatch.`,
          sessionId
        )
      }
    }
    if (cfg?.maxCostUsd !== undefined && spent.costUsd >= cfg.maxCostUsd) {
      return errorResult(
        `Dispatch cost cap ($${cfg.maxCostUsd}) reached for this session ` +
          `(spent $${spent.costUsd.toFixed(4)}) — further turns are rejected. ` +
          `Raise dispatch.maxCostUsd in engines/${engine}.json, or start a fresh dispatch.` +
          unpricedSuffix(spent.unpricedTurns),
        sessionId
      )
    }
    return spent
  }

  /**
   * A target resumed from its row runs the model it was created with, which must still
   * pass the engine's allowlist as a fresh dispatch's would (refused with the same text).
   */
  private resumeModelRefusal(
    engine: 'claude' | 'opencode' | 'pi' | 'codex',
    model: string,
    cfg: DispatchConfig | undefined
  ): DispatchResult | null {
    const allowed = cfg?.allowedModels
    if (!allowed || allowed.length === 0) return null
    const canonical = engine === 'opencode' || engine === 'pi'
    if (
      canonical
        ? allowed.some((a) => canonicalDispatchModel(engine, a) === model)
        : allowed.includes(model)
    )
      return null
    const label = engine === 'claude' ? 'Claude' : engine
    return errorResult(
      `Model "${model}" is not in the user-configured allowlist for ${label} dispatch. ` +
        `Allowed models: ${allowed.join(', ')}`
    )
  }

  /**
   * Stop a running dispatch by its launching tool_use id OR its ledger id (ADR-033 M3 —
   * TaskCard's Stop button, routed here BEFORE the session's own stopTask by
   * the `session:stop-task` IPC handler). The run is found in the registry for its
   * whole life (ADR-105 §2), so a Stop lands on a background run long after its launch
   * call returned. Returns false for an unknown id (not a dispatch, or already
   * finished) — the caller falls through to the session's normal stop path in that case.
   *
   * `routingId`, when provided (both IPC call sites pass it), must match the
   * DISPATCHING session that started the run (its durable id: a re-key is followed) —
   * the native stopTask path is implicitly session-scoped via `manager.get(routingId)`,
   * and without this check any session (including a remote client on a different
   * session) could stop a dispatch it doesn't own. On mismatch we return false; the
   * caller falls through to the session path, which won't know the id either.
   *
   * `opts.armIfUnknown` (set when the RENDERER knows the card is a dispatch —
   * TaskCard's `isDispatch`): on a registry miss, record a durable stop-intent
   * in `pendingStops` and return true — the dispatch may not have been invoked
   * yet (see the pendingStops field doc); `launchRun` consumes the intent
   * and refuses the call before it creates anything.
   *
   * A registry miss on the card (or ledger) id of a `running` row the caller owns is a row nothing
   * here runs: see {@link endPhantomRow} (it is ended, no intent is armed).
   *
   * `opts.blockingOnly` is the parent's OWN interrupt (Esc, pi's and Codex's interrupt):
   * it ends the blocking calls the parent is waiting on and never a background run,
   * which is the user's to stop from its card.
   */
  stopDispatch(
    id: string,
    routingId?: string,
    opts?: { armIfUnknown?: boolean; blockingOnly?: boolean }
  ): boolean {
    const toolUseId = id
    const run = this.runs.find(id)
    if (!run) {
      // Not necessarily an error (most stop-task calls target native tasks) —
      // but when a dispatch stop misroutes, this is the breadcrumb.
      logger.debug(
        'CrossEngineDispatcher',
        `stopDispatch miss: id=${id} not among ${this.runs.size} run(s)`
      )
      if (routingId !== undefined && !opts?.blockingOnly && this.endPhantomRow(id, routingId))
        return true
      if (opts?.armIfUnknown) {
        this.pendingStops.set(toolUseId, { routingId })
        logger.debug(
          'CrossEngineDispatcher',
          `stopDispatch armed pending stop-intent for toolUseId=${toolUseId}`
        )
        return true
      }
      return false
    }
    if (
      routingId !== undefined &&
      this.runs.parentOf(run.init.parentId) !== this.runs.parentOf(routingId)
    ) {
      logger.debug(
        'CrossEngineDispatcher',
        `stopDispatch ownership mismatch: routingId=${routingId} owner=${run.init.parentId}`
      )
      return false
    }
    // The parent's own interrupt ends the calls it is waiting on, never a background run.
    if (opts?.blockingOnly && run.background) return false
    // The user's Stop on the card ENDS the X-Agent (Claude Code does not resume a stopped
    // agent either); the parent's interrupt of a blocking call leaves it resumable.
    if (!opts?.blockingOnly) run.endRequested = true
    run.stopController.abort()
    return true
  }

  /**
   * Stop on an X-Agent the ledger says is `running` and nothing in this process runs: a row a crash
   * left behind whose recorded owner pid was then handed to an unrelated process (the boot pass
   * reads that as a live owner and leaves it), or one a second instance sharing the DB is running.
   * Nothing would ever end it, so the user's Stop does: the row is `stopped` and the parent gets
   * the terminal notification (the card, the roster and the dot clear). It arms no intent.
   *
   * The harness's own state (pi's directory, opencode's session) goes only when no other live
   * instance owns the row: a real second instance may be running the agent on it. `stopped` is
   * final in the store, so that instance's run end cannot write over the Stop.
   */
  private endPhantomRow(id: string, routingId: string): boolean {
    let row: DispatchTargetRow | undefined
    try {
      row = this.ledger
        .byParent(this.runs.parentOf(routingId))
        .find((r) => r.state === 'running' && (r.parentToolUseId === id || r.id === id))
    } catch (err) {
      logger.warn('CrossEngineDispatcher', `dispatch ledger lookup failed: ${errText(err)}`)
      return false
    }
    if (!row || this.runs.byLedgerId(row.id)) return false
    let foreign = false
    try {
      foreign = this.ledger.ownedByOtherLiveInstance(row.id)
    } catch (err) {
      logger.warn('CrossEngineDispatcher', `dispatch owner lookup failed: ${errText(err)}`)
    }
    try {
      if (foreign) this.ledgerSet(row.id, { state: 'stopped' })
      else this.endTarget(row.id, row)
    } catch (err) {
      logger.warn('CrossEngineDispatcher', `could not end X-Agent ${row.id}: ${errText(err)}`)
    }
    // A row with no launching call has no card to clear (the notification is keyed by that call).
    if (row.parentToolUseId) {
      this.parents?.emit(this.runs.parentOf(routingId), 'session:task-notification', {
        taskId: row.id,
        toolUseId: row.parentToolUseId,
        status: 'stopped',
        outputFile: '',
        summary: 'Dispatch stopped by user.',
        isBackgrounded: true
      })
    }
    return true
  }

  async dispatch(req: DispatchRequest, ctx: DispatchContext): Promise<DispatchResult> {
    try {
      const launch = this.launchRun(req, ctx)
      if ('refused' in launch) return launch.refused
      const { run } = launch
      // The blocking form waits for the run — the contract every caller had before.
      if (!run.background) {
        const done = await run.done
        return run.ledgerId && !done.isError ? { ...done, agentRef: run.ledgerId } : done
      }
      // A background launch returns as soon as the target's row exists and the run goes on
      // by itself. A run that ends first (a refusal, a target that would not start) is its
      // own answer: the call fails, nothing was launched.
      await Promise.race([run.launched, run.done])
      return run.bound ? this.launchAck(run, req) : await run.done
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn('CrossEngineDispatcher', `dispatch failed: ${msg}`)
      return errorResult(`Dispatch failed: ${msg}`, req.sessionId ?? '')
    }
  }

  // ── session_message to an X-Agent (ADR-105 §4) ─────────────────────────────

  /**
   * A message from the session that dispatched an X-Agent, once the tool service has decided that
   * it may send it (ownership is the service's refusal, in every mode; this re-checks only that the
   * row is the sender's). Never throws.
   *
   *  - A RUNNING X-Agent takes it as a steer into its running turn, on each engine's own path
   *    (Claude: a frame pushed into its channel under a uuid of its own, which the turn accounting
   *    ignores; pi: `/cui-deliver`, marked as agent text, appended, never woken; opencode: a steer
   *    prompt; Codex: `turn/steer` on the live turn id).
   *  - An idle, released, interrupted or ended-with-a-report one is resumed through the one run
   *    engine: a new run of its harness session (`findContinuation`, the cost cap, the model
   *    allowlist), in the background, with the message as its input, run n+1 of the card the X-Agent
   *    was launched from. Its report goes to the parent like any other run's.
   *  - A run that cannot take a steer any more (its report was taken, a Stop is pending, the engine
   *    refused the steer) is waited out, bounded, and the message then starts a new run.
   *
   * Messages to one X-Agent are serialised, so two in a row see the run the first one started.
   */
  async messageXAgent(request: XAgentMessageRequest): Promise<XAgentMessageOutcome> {
    const previous = this.messageChains.get(request.ledgerId) ?? Promise.resolve()
    const work = previous.then(() => this.messageXAgentNow(request))
    const tail = work.catch(() => undefined)
    this.messageChains.set(request.ledgerId, tail)
    void tail.then(() => {
      if (this.messageChains.get(request.ledgerId) === tail)
        this.messageChains.delete(request.ledgerId)
    })
    try {
      return await work
    } catch (err) {
      logger.warn('CrossEngineDispatcher', `message to X-Agent failed: ${errText(err)}`)
      return { kind: 'refused', text: `Could not deliver the message: ${errText(err)}` }
    }
  }

  private async messageXAgentNow(request: XAgentMessageRequest): Promise<XAgentMessageOutcome> {
    const refuse = (text: string): XAgentMessageOutcome => ({ kind: 'refused', text })
    const read = (): DispatchTargetRow | undefined => {
      try {
        return this.ledger.get(request.ledgerId)
      } catch (err) {
        logger.warn('CrossEngineDispatcher', `dispatch ledger lookup failed: ${errText(err)}`)
        return undefined
      }
    }
    let row = read()
    if (!row) return refuse(`There is no X-Agent ${request.ledgerId}.`)
    if (this.runs.parentOf(row.parentSessionId) !== this.runs.parentOf(request.from.routingId))
      return refuse('That X-Agent belongs to another session; you can message only your own.')
    const framed = xAgentMessageFrame(request.from.title, request.text)
    const ctx = this.contextForRow(row)
    const stopped = (r: DispatchTargetRow): string =>
      `X-Agent ${r.name ?? r.id} was stopped; it cannot be messaged.`
    const delivered = (
      r: DispatchTargetRow,
      outcome: XAgentMessageOutcome
    ): XAgentMessageOutcome => {
      this.noteXAgentInput(ctx, r, request.from.title, request.text)
      return outcome
    }
    for (let attempt = 0; attempt < MESSAGE_RUN_ATTEMPTS; attempt++) {
      row = read()
      if (!row) return refuse(`There is no X-Agent ${request.ledgerId}.`)
      if (row.state === 'stopped') return refuse(stopped(row))
      const run = this.runs.byLedgerId(row.id)
      if (!run) break
      const steered = await this.steerWhenReady(row, run, framed, request.from)
      if (steered === 'steered') return delivered(row, { kind: 'steered' })
      if (steered === 'not-ready') {
        return refuse(
          `X-Agent ${row.name ?? row.id} is starting up; send the message again in a moment.`
        )
      }
      // Its run is over or ending (or the engine refused the steer): the message starts the next
      // run, once this one has settled.
      if ((await settledWithin(run.done, this.messageRunEndWaitMs)) === undefined) {
        return refuse(
          `X-Agent ${row.name ?? row.id} is still finishing its run; send the message again in a moment.`
        )
      }
    }
    row = read()
    if (!row) return refuse(`There is no X-Agent ${request.ledgerId}.`)
    if (row.state === 'stopped') return refuse(stopped(row))
    if (this.runs.byLedgerId(row.id))
      return refuse(`X-Agent ${row.name ?? row.id} is busy; send the message again in a moment.`)
    const outcome = await this.launchMessageRun(row, framed, ctx)
    return outcome.kind === 'refused' ? outcome : delivered(row, outcome)
  }

  /**
   * Start the X-Agent's next run on a message (its harness session resumed, in the background, run
   * n+1 of the origin card). Refused with the launch's own reason (cap, cost, allowlist, a resume the
   * harness cannot do).
   */
  private async launchMessageRun(
    row: DispatchTargetRow,
    framed: string,
    ctx: DispatchContext
  ): Promise<XAgentMessageOutcome> {
    const description = row.description ?? row.name
    const launch = this.launchRun(
      {
        engine: row.engine,
        prompt: xAgentNewRunPrompt(framed),
        sessionId: row.harnessRef,
        runInBackground: true,
        ...(description ? { description } : {}),
        message: { runIndex: this.runsOf(row.id) + 1 }
      },
      ctx
    )
    if ('refused' in launch) return { kind: 'refused', text: launch.refused.text }
    // The launch answers once the run is bound to the X-Agent (a refusal of the resume itself ends
    // the run first and is the answer).
    await Promise.race([launch.run.launched, launch.run.done])
    if (launch.run.bound) return { kind: 'started' }
    return { kind: 'refused', text: (await launch.run.done).text }
  }

  /** How many runs of this X-Agent ended with a stored outcome: the next run is the one after. */
  private runsOf(ledgerId: string): number {
    try {
      return this.reports.count(ledgerId)
    } catch {
      return 0
    }
  }

  /**
   * The dispatching context of a run a message starts, from the X-Agent's row alone: there is no
   * tool call. With a live-parent lookup wired (`makeRunContext` replaces these accessors by reads
   * of whatever session answers to the parent now) they are only the fallback of a unit double.
   */
  private contextForRow(row: DispatchTargetRow): DispatchContext {
    const parentId = (): string => this.runs.parentOf(row.parentSessionId)
    const live = (): LiveParentSession | undefined => this.parents?.session(parentId())
    return {
      fromEngine: row.parentEngine,
      fromRoutingId: row.parentSessionId,
      cwd: row.cwd,
      getAutonomyMode: () => live()?.getAutonomyMode?.() ?? row.launchMode,
      getMessages: () => live()?.getMessages() ?? [],
      emit: (channel, data) => this.parents?.emit(parentId(), channel, data),
      addDispatchedCost: (engineId, modelId, costUsd) =>
        live()?.addDispatchedCost?.(engineId, modelId, costUsd),
      ...(row.parentToolUseId ? { toolUseId: row.parentToolUseId } : {}),
      chatgptAccountId: row.codexAccountId
    }
  }

  /** The message as the X-Agent's card shows it: a framed input row in the child stream (no one typed it there). */
  private noteXAgentInput(
    ctx: DispatchContext,
    row: DispatchTargetRow,
    fromTitle: string,
    text: string
  ): void {
    const toolUseId = row.parentToolUseId
    if (!toolUseId) return
    try {
      ctx.emit('session:subagent-message', {
        toolUseId,
        message: agentNoteMessage({
          id: `xagent-input-${uuidv4()}`,
          title: xAgentInputNoteTitle(fromTitle),
          text,
          timestamp: this.now(),
          label: X_AGENT_INPUT_FRAGMENT_LABEL
        })
      })
    } catch (err) {
      logger.warn('CrossEngineDispatcher', `could not show a message on the card: ${errText(err)}`)
    }
  }

  /**
   * Steer a message into the X-Agent's running turn, waiting (bounded) for one that is starting up:
   * a run whose process is not live yet, or that is between two turns of its own nudges, has nothing
   * to steer into for a moment. `ending`: the run can take no steer (its report was taken, a Stop is
   * pending, the engine refused it) and the message starts the next run once this one has ended.
   * `not-ready`: it did not become live in time.
   */
  private async steerWhenReady(
    row: DispatchTargetRow,
    run: DispatchRun,
    framed: string,
    from: { routingId: string; title: string }
  ): Promise<'steered' | 'ending' | 'not-ready'> {
    const deadline = this.now() + this.messageStartWaitMs
    for (;;) {
      // The run it waited on ended meanwhile (a launch that failed, a run that finished): there is
      // nothing to start up, the caller starts or refuses the next run with the real reason.
      if (this.runs.byLedgerId(row.id) !== run) return 'ending'
      const outcome = await this.steerXAgent(row, run, framed, from)
      if (outcome !== 'not-ready') return outcome
      if (this.now() >= deadline) return 'not-ready'
      await new Promise<void>((resolve) => setTimeout(resolve, MESSAGE_START_POLL_MS))
    }
  }

  /** Can this run no longer take a message into its turn? (Its report was taken, a Stop or an abandoned call is pending.) */
  private runIsEnding(run: DispatchRun): boolean {
    return (
      !!run.report ||
      run.steersSettled ||
      run.endRequested ||
      run.stopController.signal.aborted ||
      run.cancelController.signal.aborted
    )
  }

  /**
   * Put a message into the turn an X-Agent is running, if it has one that can take it now. The
   * steer is recorded first (the engine's signals can beat its own acknowledgement), and dropped
   * again when the engine refuses it. See {@link SteerRecord} for how it is decided.
   */
  private async steerXAgent(
    row: DispatchTargetRow,
    run: DispatchRun,
    framed: string,
    from: { routingId: string; title: string }
  ): Promise<'steered' | 'not-ready' | 'ending'> {
    if (this.runIsEnding(run)) return 'ending'
    const entry = this.liveEntry(row.id)?.entry
    if (!entry || entry.released || !entry.busy || entry.ctx.run !== run) return 'not-ready'
    const token = uuidv4()
    const record: SteerRecord = {
      token,
      ledgerId: row.id,
      run,
      framed,
      from,
      consumed: false,
      fate: 'pending'
    }
    this.rememberSteer(record)
    const refused = (): 'ending' => {
      this.steers.delete(token)
      return 'ending'
    }
    switch (entry.kind) {
      case 'claude':
        // A frame of its own uuid, kept out of `pushedUuids`: cli.js folds it into the running turn
        // at a tool boundary or runs it as a turn of its own, and neither is the run's turn, so the
        // turn accounting (`ownTurnStarted`, which a pushed uuid's `started` sets) must not see it.
        entry.channel.push(buildClaudeDispatchMessage(framed, entry.sessionId, false, token))
        return 'steered'
      case 'pi': {
        // `/cui-deliver`: pi marks the text as an agent's, never a plain prompt. Appended without a
        // wake (`triggerTurn: false`): pi defers it to the end of the current step
        // (agent-session.ts `sendCustomMessage`, "Defer to the end of the turn"), so it reaches the
        // model only if the loop goes on, and it starts no turn of its own.
        // Quiet: the card's one row for it is the dispatcher's own (`noteXAgentInput`), not pi's echo
        // of the framed text.
        const accepted = await entry.runner.deliver(
          {
            v: 1,
            deliveryId: token,
            kind: 'agent-message',
            text: framed,
            wake: false,
            title: xAgentInputNoteTitle(from.title),
            details: {
              agentId: entry.sessionId ?? '',
              toolUseId: row.parentToolUseId ?? '',
              from: from.title,
              fromId: from.routingId
            }
          },
          { quiet: true }
        )
        // A delivery pi refused (or a dead transport) is lost: not reported as steered.
        return accepted ? 'steered' : refused()
      }
      case 'opencode':
        try {
          await entry.client.prompt(entry.sessionId, { id: token, text: framed, delivery: 'steer' })
          return 'steered'
        } catch (err) {
          logger.info('CrossEngineDispatcher', `opencode steer refused: ${errText(err)}`)
          return refused()
        }
      case 'codex': {
        // `turn/steer` names the turn it expects; one that has not announced its id yet is waited for.
        const turnId = entry.turnId ?? (await this.withinCodexGrace(entry.turnStarted)) ?? null
        if (!turnId || !entry.sessionId || entry.draining || entry.endedTurns.has(turnId)) {
          this.steers.delete(token)
          return 'not-ready'
        }
        try {
          await entry.connection.request('turn/steer', {
            threadId: entry.sessionId,
            expectedTurnId: turnId,
            clientUserMessageId: token,
            input: codexTurnInput(this.codexDispatchSkillInput(entry, framed))
          })
          entry.skillCatalogUpdatePending = false
          return 'steered'
        } catch (err) {
          logger.info('CrossEngineDispatcher', `codex steer refused: ${errText(err)}`)
          return refused()
        }
      }
    }
  }

  // ── steers: answered, or sent again (ADR-105 §4) ───────────────────────────

  /** Forget the records whose run ended longer ago than the stray window: nothing can start a turn on them now. */
  private sweepSteers(): void {
    for (const [token, record] of this.steers)
      if (record.endedAt !== undefined && this.now() - record.endedAt >= STRAY_STEER_WINDOW_MS)
        this.steers.delete(token)
  }

  private rememberSteer(record: SteerRecord): void {
    this.sweepSteers()
    this.steers.set(record.token, record)
    if (this.steers.size <= MAX_STEER_RECORDS) return
    for (const [token, old] of this.steers) {
      if (old.fate === 'answered' || old.fate === 'requeued') this.steers.delete(token)
      if (this.steers.size <= MAX_STEER_RECORDS) return
    }
  }

  /** The engine took a steer into the turn it was sent to (its own signal, by the id we gave it). */
  private noteSteerConsumed(token: string): void {
    const record = this.steers.get(token)
    if (record) record.consumed = true
  }

  /**
   * Is this a message the X-Agent was sent for a run that is over, and that its engine may still
   * start a turn on? (Recent enough: an idle X-Agent's later, legitimate wake-up is not a stray.)
   */
  private isStraySteer(record: SteerRecord): boolean {
    return (
      (record.fate === 'unanswered' || record.fate === 'requeued' || record.fate === 'dropped') &&
      record.endedAt !== undefined &&
      this.now() - record.endedAt < STRAY_STEER_WINDOW_MS
    )
  }

  /** A turn that starts with NO run in flight, while the X-Agent holds such a message, is a stray one. */
  private hasStraySteers(ledgerId: string): boolean {
    if (this.runs.byLedgerId(ledgerId)) return false
    for (const record of this.steers.values())
      if (record.ledgerId === ledgerId && this.isStraySteer(record)) return true
    return false
  }

  /**
   * What cli.js says of a frame we sent as a steer (wire order, off the stream's reader): `started`
   * is it taken into a turn. One taken into a turn after its run was over, with nothing running, is
   * a turn nobody observes: it is ended at once and the message is sent again as a run.
   */
  private noteSteerFrame(entry: ClaudeTargetEntry, frame: Record<string, unknown>): void {
    if (frame.type !== 'command_lifecycle' || typeof frame.command_uuid !== 'string') return
    const record = this.steers.get(frame.command_uuid)
    if (!record || frame.state !== 'started') return
    record.consumed = true
    if (this.isStraySteer(record) && !this.runs.byLedgerId(entry.ledgerId)) {
      logger.info(
        'CrossEngineDispatcher',
        'claude target: stray turn on a sent-again message ended'
      )
      void entry.query.interrupt().catch(() => {})
    }
  }

  /**
   * Decide the pending steers of a run whose report was just accepted (or whose turn ended without
   * one): the engine took it into the turn first → ANSWERED (the model had it in view when it wrote
   * the report); otherwise → unanswered, and, at the report, taken back from the engine so the turn
   * the report ends does not fold it in or run it afterwards. pi's deferred copy cannot be taken back
   * (it is context only); Codex clears it on the interrupt that follows the report.
   */
  private settleSteers(run: DispatchRun, entry: TargetEntry | undefined, takeBack: boolean): void {
    for (const record of this.steers.values()) {
      if (record.run !== run || record.fate !== 'pending') continue
      const consumed =
        record.consumed ||
        (entry?.kind === 'pi' && entry.runner.arrivedDeliveries.has(record.token))
      if (consumed) {
        record.fate = 'answered'
        continue
      }
      record.fate = 'unanswered'
      if (takeBack && entry) this.takeBackSteer(entry, record)
    }
  }

  private takeBackSteer(entry: TargetEntry, record: SteerRecord): void {
    try {
      if (entry.kind === 'claude') void entry.query.cancelAsyncMessage(record.token).catch(() => {})
      else if (entry.kind === 'opencode')
        void entry.client.cancelInbox(entry.sessionId, record.token).catch(() => {})
    } catch (err) {
      logger.warn('CrossEngineDispatcher', `could not take a message back: ${errText(err)}`)
    }
  }

  /**
   * The run's last turn is over (before its result is delivered): decide its pending steers, take back
   * from the engine what it still holds and stamp when they ended, which arms the stray-turn backstop.
   * Whether they are sent again is decided later, by {@link requeueSteers}.
   */
  private endRunSteers(run: DispatchRun): void {
    run.steersSettled = true
    try {
      this.settleSteers(run, run.ledgerId ? this.liveEntry(run.ledgerId)?.entry : undefined, true)
      for (const record of this.steers.values())
        if (record.run === run && record.fate === 'unanswered' && record.endedAt === undefined)
          record.endedAt = this.now()
    } catch (err) {
      logger.warn(
        'CrossEngineDispatcher',
        `could not settle the messages of a run: ${errText(err)}`
      )
    }
  }

  /**
   * The run has settled: a message it never answered starts the X-Agent's next run, once, with the
   * messages in the order they were sent. Not after a Stop, a deleted parent or a failed run (those
   * end or break the X-Agent; the message would be sent into nothing). A launch that is refused says
   * so to the parent, which is the only one who can resend.
   */
  private requeueSteers(run: DispatchRun): void {
    try {
      this.sweepSteers()
      const mine = [...this.steers.values()].filter((record) => record.run === run)
      const lost = mine.filter((record) => record.fate === 'unanswered')
      const ledgerId = run.ledgerId
      let row: DispatchTargetRow | undefined
      try {
        row = ledgerId ? this.ledger.get(ledgerId) : undefined
      } catch {
        row = undefined
      }
      // Nothing to send again after a Stop, a deleted parent, a failed run or a stopped X-Agent: the
      // messages are dropped with their records (the run ended for a reason the message cannot fix).
      const sendAgain =
        lost.length > 0 &&
        !!row &&
        row.state !== 'stopped' &&
        run.terminalStatus === 'completed' &&
        !run.endRequested &&
        !run.parentEnded &&
        !run.stopController.signal.aborted
      for (const record of mine) {
        if (record.fate === 'unanswered') {
          // Sent again as a run, or dropped: either way the engine may still hold it for a moment.
          record.fate = sendAgain ? 'requeued' : 'dropped'
          record.endedAt ??= this.now()
        } else this.steers.delete(record.token)
      }
      if (!sendAgain || !row) return
      const framed = lost.map((record) => record.framed).join('\n\n')
      const target = row
      void this.launchMessageRun(target, framed, this.contextForRow(target)).then(
        (outcome) => {
          if (outcome.kind === 'refused') this.tellParentMessageLost(run, target, outcome.text)
        },
        (err: unknown) => this.tellParentMessageLost(run, target, errText(err))
      )
    } catch (err) {
      logger.warn('CrossEngineDispatcher', `could not send a message again: ${errText(err)}`)
    }
  }

  /** The X-Agent could not take a message it was sent while it finished: the parent hears why (it can resend). */
  private tellParentMessageLost(run: DispatchRun, row: DispatchTargetRow, reason: string): void {
    const parents = this.parents
    if (!parents?.deliver) return
    const name = row.name ?? row.id
    void parents
      .deliver(this.runs.parentOf(run.init.parentId), {
        from: { key: row.id, title: name },
        text: messageNotTakenText(name, reason)
      })
      .catch((err: unknown) =>
        logger.warn('CrossEngineDispatcher', `could not tell the parent: ${errText(err)}`)
      )
  }

  /**
   * Validate a launch synchronously and start its run (ADR-105 §2): engine, guards,
   * caller restriction, slot cap, name uniqueness, the harness being installed (a
   * background launch). Returns the refusal, or the registered run; nothing past the
   * registration awaits before the slot is held.
   */
  private launchRun(
    req: DispatchRequest,
    callCtx: DispatchContext
  ): { run: DispatchRun } | { refused: DispatchResult } {
    let ctx = callCtx
    // A Stop armed before this call started (the renderer's Stop is clickable while the call
    // is still queued behind another, or in the MCP round-trip) is honoured FIRST, before any
    // guard, ledger row or target: a target created only to be torn down is a process spawned
    // for nothing (a pi RPC subprocess lives ~0.4 s). Consumed whatever the outcome, so a
    // LATER dispatch reusing the id is never spuriously stopped; fires only when the same
    // session armed it. A run a message starts reuses the origin card's id: a Stop armed on
    // that card while nothing was registered is not meant for it.
    if (callCtx.toolUseId && !req.message) {
      const intent = this.pendingStops.get(callCtx.toolUseId)
      if (intent) {
        this.pendingStops.delete(callCtx.toolUseId)
        if (intent.routingId === undefined || intent.routingId === callCtx.fromRoutingId) {
          logger.debug(
            'CrossEngineDispatcher',
            `consuming pending stop-intent for toolUseId=${callCtx.toolUseId} - refused before any target`
          )
          const text = 'Dispatch stopped by user.'
          callCtx.emit('session:task-notification', {
            taskId: callCtx.toolUseId,
            toolUseId: callCtx.toolUseId,
            status: 'stopped',
            outputFile: '',
            summary: text,
            ...(req.runInBackground === true ? { isBackgrounded: true } : {})
          })
          return { refused: errorResult(text, req.sessionId ?? '') }
        }
      }
    }
    // ── Guards ────────────────────────────────────────────────────────────
    // ADR-069 §7 lifts this for CODEX alone: a codex → codex dispatch is one more
    // `thread/start` on the process the caller is already running on, which is
    // what the guard existed to prevent when it meant a second app-server per
    // dispatch. Every other engine still pays a whole server or CLI for a
    // same-engine target and still has a native subagent of its own.
    if (req.engine === ctx.fromEngine && req.engine !== 'codex') {
      return {
        refused: errorResult(
          `dispatch_agent targets a different engine — this session already runs on "${ctx.fromEngine}". ` +
            'Use your own tools (or a native subagent) for same-engine work.'
        )
      }
    }
    if (
      req.engine !== 'opencode' &&
      req.engine !== 'claude' &&
      req.engine !== 'pi' &&
      req.engine !== 'codex'
    ) {
      return {
        refused: errorResult(`Dispatching into engine "${req.engine}" is not supported yet.`)
      }
    }
    // A continuation keeps the restriction its target was created with, and
    // may not loosen it: a caller restricted further than the target was
    // starts a fresh dispatch (ADR-097 S9, option a).
    if (req.sessionId) {
      // A released target's restriction is its ledger row's (ADR-105).
      const held = this.heldRestriction({ ...req, sessionId: req.sessionId }, ctx)
      if (held || ctx.callerRestriction) {
        if (!restrictionCovers(held, ctx.callerRestriction)) {
          return {
            refused: errorResult(
              `Dispatch session "${req.sessionId}" was started without the calling subagent's restrictions — ` +
                'start a new X-Agent with dispatch_agent.',
              req.sessionId
            )
          }
        }
        ctx = { ...ctx, callerRestriction: mergeRestrictions(held, ctx.callerRestriction) }
      }
    }
    const background = req.runInBackground === true
    // A run is shown, stopped and reported through its launching tool call's card: with no
    // call id there is no card, no record and nowhere for its result to go.
    if (background && !ctx.toolUseId && !req.message) {
      return {
        refused: errorResult(
          'A background dispatch needs the id of the tool call that launches it, and this call ' +
            'carries none. Call dispatch_agent without run_in_background to wait for the result.'
        )
      }
    }
    // A background launch returns before the harness has been touched, so the cheap
    // "is it even installed" answer has to come now (a blocking call fails on its spawn).
    if (background && !harnessAvailable(req.engine)) {
      return {
        refused: errorResult(
          `Cannot launch a ${req.engine} X-Agent: the ${req.engine} harness is not installed or not usable. ` +
            'Ask the user to check Settings › Harnesses.'
        )
      }
    }
    // Read the cap HERE, not in the constructor: the user can raise it in
    // Settings mid-run and the next dispatch has to honour the new number.
    // `Infinity` (the "no limit" pick) can never satisfy the comparison, so the
    // refusal text below never has to render it. The cap counts RUNS (a background
    // run holds its slot after its launch call has returned), and a launch over it is
    // refused, never queued (ADR-105).
    const maxConcurrent = this.resolveMaxConcurrent()
    if (this.runs.size >= maxConcurrent) {
      return {
        refused: errorResult(
          `Too many concurrent dispatches (max ${maxConcurrent}). Wait for one to finish and retry, ` +
            'or raise "Max concurrent dispatches" in Settings › Cross-engine dispatch ' +
            '(0 means no limit).'
        )
      }
    }
    // A new X-Agent's name is unique among its parent's children that are not stopped
    // (ADR-105 §1); an absent name is never checked.
    const name = req.sessionId ? null : labelOf(req.name)
    if (name && name.length > MAX_XAGENT_NAME_CHARS) {
      return {
        refused: errorResult(
          `The name is ${name.length} characters long; an X-Agent's name is at most ` +
            `${MAX_XAGENT_NAME_CHARS}. Choose a shorter name.`
        )
      }
    }
    const description = labelOf(req.description)
    // Every registration marks `description` required, but an engine need not enforce its schema
    // (a Codex dynamic tool may not): a NEW launch without one is refused here. A continuation or
    // a message to an existing X-Agent keeps the description its row already has.
    if (!description && !req.sessionId) {
      return {
        refused: errorResult(
          'The description is required: give a 3-5 word summary of the task (e.g. "Review auth diff").'
        )
      }
    }
    if (description && description.length > MAX_XAGENT_DESCRIPTION_CHARS) {
      return {
        refused: errorResult(
          `The description is ${description.length} characters long; an X-Agent's description is at most ` +
            `${MAX_XAGENT_DESCRIPTION_CHARS}. Use a 3-5 word summary.`
        )
      }
    }
    if (name && isReservedXAgentName(name)) {
      return {
        refused: errorResult(
          `The name "${name}" is reserved: main, origin, parent, self and ids like s-k3m9qx address ` +
            'sessions, so an X-Agent cannot carry them. Choose a different name.'
        )
      }
    }
    if (name) {
      const held = this.nameHeldBy(ctx.fromRoutingId, name)
      if (held) {
        return {
          refused: errorResult(
            `The name "${name}" is already held by ${held.id ? `X-Agent ${held.id}` : 'an X-Agent still being launched'}` +
              `${held.state ? ` (${held.state})` : ''}. Choose a different name.`
          )
        }
      }
    }

    // A continuation of a target the ledger will rebuild (ADR-105) holds its name
    // here, synchronously, until the run ends: a second call naming the same session
    // meanwhile is busy-rejected rather than resuming it twice.
    const resumingRef = req.sessionId && !this.targets.has(req.sessionId) ? req.sessionId : null
    if (resumingRef) {
      if (this.resuming.has(resumingRef)) {
        return {
          refused: errorResult(
            `Dispatch session "${resumingRef}" is already running a turn — wait for it to finish before continuing it.`,
            resumingRef
          )
        }
      }
      this.resuming.add(resumingRef)
    }

    // Register the run SYNCHRONOUSLY, before the first await: Claude can issue several
    // dispatch_agent calls in one assistant turn, whose handlers run concurrently —
    // checking the cap without reserving would let them all pass. The registry entry
    // is the slot, the Stop handle and the lookup by tool_use id at once (ADR-033 M3):
    // TaskCard's Stop button is clickable as soon as the dispatch tool part renders
    // "running", potentially SECONDS before target creation finishes (a cold opencode
    // server spawn), and a stop landing then aborts the controller PRE-race — every
    // direction's race arm handles that via `signal.aborted ? Promise.resolve({kind:
    // 'stop'}) : …`, so the turn still ends in the 'stopped' branch (isError +
    // notification) the moment the race starts. Removed when the run ends, on every path.
    const run = new DispatchRun({
      parentId: ctx.fromRoutingId,
      toolUseId: ctx.toolUseId,
      background,
      engine: req.engine,
      name,
      description: labelOf(req.description) ?? name ?? undefined,
      continuation: !!req.sessionId,
      launchMode: liveMode(ctx),
      startedAt: this.now(),
      ...(req.message ? { runIndex: req.message.runIndex } : {})
    })
    run.handBackRequired = this.requireHandBack
    this.runs.add(run)
    try {
      const runCtx = makeRunContext({
        base: ctx,
        run,
        registry: this.runs,
        parents: this.parents,
        launchMode: () => run.launchMode,
        now: () => this.now()
      })
      // The request that launched a BLOCKING call is the only thing that may reach into the
      // run: its abort ends the run, its progress token gets the heartbeat.
      const release = background ? (): void => {} : this.followCaller(run, ctx.extra)
      run.done = this.executeRun(req, runCtx, () => {
        release()
        if (resumingRef) this.resuming.delete(resumingRef)
      })
    } catch (err) {
      // Nothing past here may leak the slot (the run's own end frees it otherwise).
      this.runs.remove(run)
      if (resumingRef) this.resuming.delete(resumingRef)
      throw err
    }
    return { run }
  }

  /** Is `name` held by one of the parent's children that is not stopped (or one being launched)? */
  private nameHeldBy(
    parentId: string,
    name: string
  ): { id: string | null; state: DispatchTargetState | null } | undefined {
    const launching = this.runs.holdingName(parentId, name)
    if (launching) return { id: launching.ledgerId, state: null }
    let rows: DispatchTargetRow[] = []
    try {
      rows = this.ledger.byParent(this.runs.parentOf(parentId))
    } catch (err) {
      logger.warn('CrossEngineDispatcher', `dispatch ledger lookup failed: ${errText(err)}`)
    }
    // A name belongs to a LIVE child: running, idle, or interrupted (still that agent, and
    // resumable). A `failed` target never ran (or ended unusable) and a `stopped` one is
    // over; either frees its name, so the retry of a launch that failed reuses it.
    const row = rows.find(
      (r) =>
        r.name === name &&
        (r.state === 'running' || r.state === 'idle' || r.state === 'interrupted')
    )
    return row ? { id: row.id, state: row.state } : undefined
  }

  /**
   * Tie a BLOCKING run to the MCP request that is waiting on it: the request's abort
   * (Esc on the waiting call, a cancelled tools/call, teardown) abandons the run, and
   * the heartbeat pings the request's progress token so the caller's call timeout keeps
   * resetting. Returns the detach.
   */
  private followCaller(run: DispatchRun, extra: SdkToolExtra | undefined): () => void {
    if (!extra) return () => {}
    run.onHeartbeat = (beats): void => {
      void sendProgress(extra, {
        progress: beats,
        message: 'Dispatched agent is still working…'
      }).catch(() => {})
    }
    const signal = extra.signal
    if (!signal) return () => {}
    if (signal.aborted) {
      run.cancelController.abort()
      return () => {}
    }
    const onAbort = (): void => run.cancelController.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    return () => signal.removeEventListener('abort', onAbort)
  }

  /**
   * Drive one run to its end and settle it: the target engine's body, then the task
   * lifecycle's last word, then the slot. Never rejects.
   */
  private async executeRun(
    req: DispatchRequest,
    ctx: RunContext,
    cleanup: () => void
  ): Promise<DispatchResult> {
    const { run } = ctx
    let result: DispatchResult = errorResult('Dispatch failed.', req.sessionId ?? '')
    try {
      try {
        result = await this.runBody(req, ctx)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.warn('CrossEngineDispatcher', `dispatch run failed: ${msg}`)
        result = errorResult(`Dispatch failed: ${msg}`, req.sessionId ?? '')
      }
      // Nobody waits for the report's review any more, whichever way the body ended (a failure, a
      // timeout or a Stop can land after the report was accepted and before `settleReview` ran): its
      // judge request must not run on, billed. A no-op once the review has finished.
      run.reviewAbort?.abort()
      // The run's turns are over: what the X-Agent was sent and had not read is decided NOW, before the
      // result is delivered to the parent (which can take a while), so a turn the engine starts
      // meanwhile on such a message is a stray one, ended by the backstop, and nothing it consumes
      // after this point is counted as read.
      this.endRunSteers(run)
      try {
        this.closeRun(ctx, result)
      } catch (err) {
        logger.warn('CrossEngineDispatcher', `dispatch run close failed: ${errText(err)}`)
      }
      try {
        this.recordRunOutcome(run)
      } catch (err) {
        logger.warn('CrossEngineDispatcher', `dispatch run record failed: ${errText(err)}`)
      }
      // Its own try: a Stop on the card must still end the X-Agent when the close threw.
      try {
        this.settleTarget(run)
      } catch (err) {
        logger.warn('CrossEngineDispatcher', `dispatch run settle failed: ${errText(err)}`)
      }
    } finally {
      // Whatever threw above, the slot is freed, the idle timer armed again and the run
      // never rejects: a background run's `done` has nobody to catch it.
      try {
        this.runs.remove(run)
        cleanup()
      } catch (err) {
        logger.warn('CrossEngineDispatcher', `dispatch run cleanup failed: ${errText(err)}`)
      }
      // Before the idle timer is armed again: a delivery that wakes the parent restarts it.
      await this.deliverRunResult(run)
      // Messages the run never answered start its next run (before the idle timer is re-armed).
      this.requeueSteers(run)
      // Nothing continues the target now: its process is released (a message resumes it).
      try {
        this.releaseAfterRun(run)
      } catch (err) {
        logger.warn('CrossEngineDispatcher', `dispatch run release failed: ${errText(err)}`)
      }
      this.rearmParentIdle(run)
    }
    return result
  }

  private runBody(req: DispatchRequest, ctx: RunContext): Promise<DispatchResult> {
    const stop = ctx.run.stopController
    if (req.engine === 'claude') return this.resolveAndRunClaude(req, ctx, stop)
    if (req.engine === 'pi') return this.resolveAndRunPi(req, ctx, stop)
    if (req.engine === 'codex') return this.resolveAndRunCodex(req, ctx, stop)
    return this.resolveAndRunOpencode(req, ctx, stop)
  }

  /**
   * A run whose target was announced (the task record exists) must end its record. A turn
   * body does that itself on every path it handles; one that failed before or between
   * turns (a spawn that would not start, a resume that failed, an unexpected throw) did
   * not, so the run ends `failed` here and a target it created is marked so in the ledger.
   */
  private closeRun(ctx: RunContext, result: DispatchResult): void {
    const { run } = ctx
    if (!run.bound || run.notified) return
    emitDispatchNotification(
      ctx,
      run.harnessId ?? '',
      result.isError ? 'failed' : 'completed',
      result.text
    )
    if (result.isError && run.createdTarget && run.ledgerId)
      this.ledgerSet(run.ledgerId, { state: 'failed' })
  }

  /** What a background launch answers: the X-Agent's identities, not its result. */
  private launchAck(run: DispatchRun, req: DispatchRequest): DispatchResult {
    const ledgerId = run.ledgerId ?? ''
    const harnessId = run.harnessId ?? ''
    let row: DispatchTargetRow | undefined
    try {
      row = this.ledger.get(ledgerId)
    } catch {
      row = undefined
    }
    const label = row?.name ?? run.init.name ?? ledgerId
    const head =
      `X-Agent ${label} launched on ${req.engine}${row ? ` · ${row.model}` : ''} ` +
      `(id ${ledgerId}). ${LAUNCH_ACK_MARKER}`
    return {
      text: req.fromSubagent
        ? // Delivered to the root agent's conversation, never back to a subagent.
          `${head}; its report is delivered to the top-level agent of this session, not to ` +
          'you, so you will not receive it. Finish your own work without it.'
        : `${head} and you can keep working: its report is not returned here, it arrives ` +
          'later as a message from it (untrusted output, framed as such). To talk to it meanwhile ' +
          `or afterwards, message it with session_message (session: ${JSON.stringify(label)} or ` +
          `"${ledgerId}").`,
      sessionId: harnessId
    }
  }

  /**
   * Resolve a forwarded approval coming back from the approve IPC. Returns
   * true when the requestId belongs to the dispatcher (the reserved `xeng:`
   * prefix) — the IPC handler then skips the session's own resolveApproval.
   */
  resolveApproval(
    requestId: string,
    decision: ApprovalDecision,
    answers?: Record<string, string>,
    _updatedPermissions?: PermissionSuggestion[]
  ): boolean {
    if (!requestId.startsWith(XENG_REQUEST_PREFIX)) return false
    const pending = this.takePendingApproval(requestId)
    // Prefixed ids are exclusively dispatcher-owned: consume even when stale
    // (e.g. already cascade-rejected) so no session ever sees an xeng id.
    if (!pending) return true

    // A held auto-mode block (ADR-091 §3): an override of this ONE call, so
    // `allowForSession` is a plain allow; a deny answers with the judge's own
    // text and records the block on the target's outcomes, never a human
    // refusal.
    let answer = { decision, answers }
    if (pending.hold) {
      const { hold } = pending
      if (decision === 'deny') {
        answer = {
          decision,
          answers: { feedback: keepTargetBlock(hold.judge, hold.toolUseId, hold.reason) }
        }
      } else {
        hold.judge.recordHoldApproved()
        // The review reads "approved by you" (ADR-091 part 6).
        hold.ledger()?.approveHeld(hold.toolUseId)
        answer = { decision: 'allow', answers: undefined }
      }
    }

    if (pending.kind === 'claude' || pending.kind === 'pi' || pending.kind === 'codex') {
      pending.resolve(answer.decision, answer.answers)
      return true
    }

    const allow = answer.decision === 'allow' || answer.decision === 'allowForSession'
    // Never `always` (ADR-085 S2): opencode's saved table is shared with the
    // user's own opencode and would outrank the user's deny/ask rules for every
    // chat. No session-allow set is kept for a target (`NO_SESSION_ALLOWS`).
    // A reject always carries the model-visible reason (ADR-097 §3).
    replyTargetPermission(
      pending.client,
      pending.askingSessionId,
      pending.permissionId,
      allow
        ? { decision: 'once' }
        : { decision: 'reject', message: answer.answers?.feedback?.trim() || 'User denied' }
    )
    return true
  }

  /**
   * A dispatching session's object is going away (cancel, respawn, Disconnect): split
   * what it owns three ways (ADR-105 §5).
   *
   *  - A BACKGROUND run keeps running. It belongs to the parent's durable id, not to the
   *    object that is dying; its facade finds the parent's next object by itself. Nothing
   *    of it is dismissed, settled or killed here.
   *  - An IDLE target is released (+ feeds / server leases). The process goes; the
   *    harness session stays, and the ledger row says `idle` — its parent's next
   *    continuation resumes it.
   *  - A BLOCKING run (a call someone is waiting on) ends with its consumer: the
   *    waiting MCP request or hosted-tool call is gone. Its row says `interrupted`.
   *
   * The generation bump only matters to blocking runs: a target created across a dispose
   * is rolled back for them, never for a background run.
   */
  disposeFor(routingId: string): void {
    // Keyed by the durable id: a creation reads it under the id its facade answers to.
    const parent = this.runs.parentOf(routingId)
    this.disposals.set(parent, (this.disposals.get(parent) ?? 0) + 1)
    this.dropPendingStops(routingId)
    for (const [sessionId, entry] of [...this.targets]) {
      if (!this.ownedBy(entry, routingId)) continue
      if (entry.busy && this.runs.byLedgerId(entry.ledgerId)?.background) continue
      this.releaseEntry(sessionId, entry, entry.busy ? 'interrupted' : 'idle')
    }
  }

  /**
   * Take a live target out of service: out of the table, its approvals dismissed, its
   * row set to `state` (null leaves the row as the last turn wrote it), and its process
   * or connection released per engine. The harness SESSION stays; ending it for good is
   * {@link endTarget}'s.
   */
  private releaseEntry(
    sessionId: string,
    entry: TargetEntry,
    state: DispatchTargetState | null
  ): void {
    this.targets.delete(sessionId)
    this.dismissPendingForTarget(sessionId)
    entry.released = true
    if (state) this.ledgerSet(entry.ledgerId, { state })
    if (entry.kind === 'opencode') {
      // A verdict still in flight sees the entry gone from `this.targets`
      // (its `stillPending`), so it replies nothing (ADR-088).
      this.sealOpencodeTargetItems(entry)
      // Settle a turn still in flight (ADR-033's 2026-09-01 amendment): the
      // entry has just left `this.targets`, so nothing else can.
      const settle = entry.settled
      entry.settled = null
      settle?.({ kind: 'failed', message: 'the dispatching session was disposed' })
      this.teardownOpencodeTarget(entry)
    } else if (entry.kind === 'claude') {
      entry.itemStreams.sealAll()
      entry.askedHandBacks.clear()
      // Killing the process is the only teardown a Claude target needs —
      // no server ref, no remote session to delete.
      entry.abortController.abort()
    } else if (entry.kind === 'pi') {
      entry.runner.flush()
      // pi (ADR-033 M4c): kill the child + its OWN per-target bridge host
      // (mirrors PiSession.cancel()'s identical teardown order). Both calls
      // are idempotent (PiRpcClient.dispose()/PiBridgeHost.dispose() no-op
      // if already torn down), so this is safe even if the process already
      // exited on its own (onExit already disposed the bridge host).
      entry.runner.dispose()
    } else {
      if (entry.ctx.toolUseId) this.sealCodexTargetItems(entry, entry.ctx.toolUseId)
      // codex (slice H, ADR-069 §7): a target is a THREAD on the caller's
      // host, so teardown is an interrupt and a detach — never a kill, which
      // would take every other session on that account down with it. The
      // native thread is left on disk (a dispatch target's thread is an
      // ordinary Codex thread; deleting it is the user's call, not a disposal
      // side effect) and unsubscribed, which is what lets the binary unload it
      // and release its writer lock.
      //
      // A turn still in flight has to be settled HERE: the process no longer
      // dies, so no `onDisconnect` will do it, and the dispatch would hold its
      // run slot until the watchdog fired.
      if (entry.sessionId && entry.turnId)
        void entry.connection
          .request('turn/interrupt', { threadId: entry.sessionId, turnId: entry.turnId })
          .catch(() => {})
      entry.connection.detach()
      const settle = entry.settled
      entry.settled = null
      settle?.({ kind: 'error', message: 'the dispatching session was disposed' })
    }
  }

  /** The live (not yet released) target a ledger row is, if the dispatcher holds one. */
  private liveEntry(ledgerId: string): { sessionId: string; entry: TargetEntry } | undefined {
    for (const [sessionId, entry] of this.targets) {
      if (entry.ledgerId === ledgerId) return { sessionId, entry }
    }
    return undefined
  }

  /**
   * End an X-Agent for good (ADR-105 §5): its process released and approvals dismissed,
   * its row `stopped` (never resumed again) and the harness's own session removed where
   * the engine allows (opencode's session, pi's directory; Claude's transcript and
   * Codex's thread stay). The run, if there was one, has already settled.
   */
  private endTarget(ledgerId: string, known?: DispatchTargetRow): void {
    let row = known
    if (!row) {
      try {
        row = this.ledger.get(ledgerId)
      } catch {
        row = undefined
      }
    }
    const live = this.liveEntry(ledgerId)
    if (live) this.releaseEntry(live.sessionId, live.entry, 'stopped')
    else this.ledgerSet(ledgerId, { state: 'stopped' })
    const target =
      row ?? (live ? { id: ledgerId, engine: live.entry.kind, harnessRef: live.sessionId } : null)
    if (!target?.harnessRef) return
    // After the release: pi's process must be gone before its directory is.
    void (this.deps.removeHarnessState ?? removeHarnessState)(target)
  }

  /**
   * A run has settled (its body returned and its notification went out): decide what
   * becomes of its target.
   *  - The user stopped it from its card, or its parent was deleted: it ends.
   *  - Otherwise it stays for now: the process is released later, by {@link releaseAfterRun}, once the
   *    result is delivered. (Nothing continues a target but a message, `session_message`, and that
   *    resumes a released one from its row just as well, so a blocking run parks nothing either.)
   */
  private settleTarget(run: DispatchRun): void {
    if (!run.ledgerId) return
    if (run.endRequested) this.endTarget(run.ledgerId)
  }

  /**
   * The last step of a run, background or blocking, after its result is delivered and its unanswered
   * messages are sent again: its target's process goes, whether or not the parent is live (ADR-105 §5 —
   * nothing else bounds the parked processes of a long session, and a message is the only thing
   * that continues an X-Agent). The row stays as the turn wrote it (`idle`, or `failed`) and the
   * next message resumes it from the row, through the one run engine, like any released target.
   *
   * Not while another run holds the target: a message that arrived while the result was being
   * delivered, or the run `requeueSteers` just launched, is already registered (launching is
   * synchronous) and continues on the live process; that run's own end releases it. A run that is
   * stopped from its card has been ended by {@link settleTarget} already (nothing live to find).
   */
  private releaseAfterRun(run: DispatchRun): void {
    if (!run.ledgerId || run.endRequested) return
    if (this.runs.byLedgerId(run.ledgerId)) return
    const live = this.liveEntry(run.ledgerId)
    if (live) this.releaseEntry(live.sessionId, live.entry, null)
  }

  /**
   * A run is over: the parent's idle timer, held while it owned running X-Agents, is armed
   * again (the session decides whether anything still holds it). Best effort.
   */
  private rearmParentIdle(run: DispatchRun): void {
    try {
      this.parents?.session(this.runs.parentOf(run.init.parentId))?.rearmIdleTimer?.()
    } catch (err) {
      logger.warn('CrossEngineDispatcher', `idle timer re-arm failed: ${errText(err)}`)
    }
  }

  // ── hand_back: the report that ends a run (ADR-105 §3) ─────────────────────

  /** The task as the target is given it: with how to finish, when this run ends in a report. */
  private taskText(
    entry: Pick<TargetLedgerFields, 'handBack'>,
    ctx: RunContext,
    prompt: string,
    toolName: string
  ): string {
    return ctx.run.handBackRequired && entry.handBack
      ? prompt + handBackTaskSuffix(toolName)
      : prompt
  }

  /** The X-Agent's name as a report says it: its label, else its id. */
  private xAgentName(run: DispatchRun): string {
    let row: DispatchTargetRow | undefined
    try {
      row = run.ledgerId ? this.ledger.get(run.ledgerId) : undefined
    } catch {
      row = undefined
    }
    return row?.name ?? run.init.name ?? run.ledgerId ?? 'unnamed'
  }

  /**
   * Keep how a run ended (ADR-105 §3): one row per run, whatever the end — a report, a
   * withhold, a fallback, a stop, a failure or a timeout — keyed by the call that launched
   * or continued the run, so a reload puts each outcome on its own card. Written once, at
   * the run's end: a report whose run was then stopped is a `stopped` row. Best effort: the
   * row records the end, it never fails the run.
   */
  private recordRunOutcome(run: DispatchRun): void {
    if (!run.handBackRequired || !run.ledgerId) return
    let status: DispatchReportStatus
    let report: string | null = null
    let warning: string | null = null
    if (run.finishedAs) {
      status = run.finishedAs.status
      report = run.finishedAs.report
      // A fallback's warning is a constant the reload derives; a review's words are stored.
      if (status !== 'fallback') warning = run.finishedAs.warning ?? null
    } else if (run.terminalStatus === 'stopped') status = 'stopped'
    else if (run.terminalStatus === 'failed') status = run.timedOut ? 'timeout' : 'failed'
    else return
    try {
      const row = this.reports.add({
        targetId: run.ledgerId,
        toolUseId: run.toolUseId ?? null,
        status,
        report,
        ...(warning ? { warning } : {}),
        createdAt: this.now()
      })
      run.reportRun = row?.run ?? null
    } catch (err) {
      logger.warn('CrossEngineDispatcher', `dispatch report store failed: ${errText(err)}`)
    }
  }

  // ── delivery into the parent (ADR-105 §3, slice B-3b) ──────────────────────

  /**
   * A BACKGROUND run has ended: tell its parent, once. The result is one `dispatch-result`
   * item through the parent's inbox (by durable id, so a parent with no live object holds it
   * and a later flush delivers it). A blocking run's report is already its tool result, so it
   * never comes here; a run whose launch failed before the target existed answered its call
   * with the error and has nothing to deliver; a deleted parent has nobody to tell.
   *
   * A result that could not be delivered now (held, refused, a throw) raises the parent's
   * attention instead (`session:dispatch-result-held`): its `wakesParent` record has just
   * left, so without this the turn end it suppressed would never be announced.
   */
  private async deliverRunResult(run: DispatchRun): Promise<void> {
    // Never throws (a sanitiser or ledger failure included): the run's end must not reject.
    try {
      await this.deliverRunResultNow(run)
    } catch (err) {
      logger.warn(
        'CrossEngineDispatcher',
        `delivering the result of run ${run.ledgerId ?? '?'} failed: ${errText(err)}`
      )
    }
  }

  private async deliverRunResultNow(run: DispatchRun): Promise<void> {
    // A blocking run's report is its tool result, which goes back as this settles: its row
    // is stamped now, unless the call was abandoned (the parent's Esc) and nobody gets it.
    if (!run.background) {
      if (!run.cancelController.signal.aborted) this.stampDelivered(run)
      return
    }
    const parents = this.parents
    if (!parents?.deliver || !run.bound || !run.ledgerId) return
    if (run.parentEnded || run.resultSent) return
    if (this.stoppedElsewhere(run)) {
      logger.info(
        'CrossEngineDispatcher',
        `X-Agent ${run.ledgerId} was stopped from another instance: its report is not delivered`
      )
      return
    }
    const text = this.resultTextFor(run)
    if (text === null) return
    run.resultSent = true
    const parent = this.runs.parentOf(run.init.parentId)
    const name = this.xAgentName(run)
    let handed = false
    try {
      const outcome = await parents.deliver(parent, {
        from: { key: run.ledgerId, title: name },
        text,
        ...(run.reportRun !== null ? { reportRun: run.reportRun } : {})
      })
      handed = outcome.result === 'delivered' || outcome.result === 'queued'
      if (!handed)
        logger.info(
          'CrossEngineDispatcher',
          `result of X-Agent ${run.ledgerId} is waiting in the inbox of ${parent}: ${outcome.result}${'why' in outcome ? ` (${outcome.why})` : ''}`
        )
    } catch (err) {
      logger.warn(
        'CrossEngineDispatcher',
        `delivering the result of ${run.ledgerId} failed: ${errText(err)}`
      )
    }
    if (handed) {
      this.stampDelivered(run)
      return
    }
    try {
      parents.emit(parent, 'session:dispatch-result-held', { name: sentenceLabel(name) })
    } catch (err) {
      logger.warn('CrossEngineDispatcher', `held-result event failed: ${errText(err)}`)
    }
  }

  /**
   * The row reads `stopped` though this run was never asked to end: a Stop the user gave from
   * another instance sharing the DB (`endPhantomRow`). The parent was told "stopped", so this
   * run's report is not delivered or held.
   */
  private stoppedElsewhere(run: DispatchRun): boolean {
    if (run.endRequested || !run.ledgerId) return false
    try {
      return this.ledger.get(run.ledgerId)?.state === 'stopped'
    } catch {
      return false
    }
  }

  private stampDelivered(run: DispatchRun): void {
    if (!run.ledgerId || run.reportRun === null) return
    try {
      this.reports.markDelivered(run.ledgerId, run.reportRun, this.now())
    } catch (err) {
      logger.warn('CrossEngineDispatcher', `report delivery stamp failed: ${errText(err)}`)
    }
  }

  /** What the parent reads for this run's end; null when the run ended without a recorded end. */
  private resultTextFor(run: DispatchRun): string | null {
    const name = this.xAgentName(run)
    let row: DispatchTargetRow | undefined
    try {
      row = run.ledgerId ? this.ledger.get(run.ledgerId) : undefined
    } catch {
      row = undefined
    }
    const framed = (report: string, warning?: string): string =>
      reportResultText({
        name,
        report,
        status: statusLine({ name, usage: run.usage, ...this.spendOf(row) }),
        frame: (body) =>
          frameHandBack({
            name,
            engine: run.init.engine,
            model: row?.model ?? '',
            report: body,
            ...(warning ? { warning } : {})
          })
      })
    const done = run.finishedAs
    if ((done?.status === 'delivered' || done?.status === 'flagged') && done.report !== null)
      return framed(done.report, done.warning)
    if (done?.status === 'fallback' && done.report !== null)
      return framed(done.report, HAND_BACK_FALLBACK_WARNING)
    if (done?.status === 'withheld') return handBackWithheldText(sentenceLabel(name))
    if (run.terminalStatus === 'stopped') return stoppedResultText(name)
    if (run.terminalStatus === 'failed') return failedResultText(name, run.terminalSummary)
    // A run that does not hand a report back (the dispatcher's own suites): its last message.
    if (run.terminalStatus === 'completed' && run.terminalSummary !== null)
      return framed(run.terminalSummary)
    return null
  }

  /** What the X-Agent has spent in all its runs, from the usage rows; nothing when that cannot be read. */
  private spendOf(row: DispatchTargetRow | undefined): {
    costUsd?: number
    unpricedTurns?: number
  } {
    if (!row?.harnessRef) return {}
    try {
      const spent = this.ledger.spend(row.harnessRef)
      return { costUsd: spent.costUsd, unpricedTurns: spent.unpricedTurns }
    } catch {
      return {}
    }
  }

  /** A report as another model reads it: the sanitised, indented frame (never the raw text). */
  private frameFor(
    ctx: RunContext,
    engine: EngineId,
    model: string,
    report: string,
    warning?: string
  ): string {
    return frameHandBack({
      name: this.xAgentName(ctx.run),
      engine,
      model,
      report,
      ...(warning ? { warning } : {})
    })
  }

  /**
   * THE door of every `hand_back` call, whatever the engine delivers it through: the Claude
   * target's own MCP server, pi's bridge, the shared opencode server, Codex's dynamic tool.
   * Each passes the target the call arrived on (resolved its own way, but never from the
   * model's say-so); `undefined` is a caller that is not a dispatch target, and is refused.
   *
   * The first call of a run stores the report and answers that the run is over; the turn is
   * then ended by its own body (a race arm on `run.reported`). A second call is refused.
   */
  private receiveHandBack(
    entry: TargetEntry | undefined,
    report: unknown,
    callId: string | undefined,
    observed?: ReportReview
  ): HandBackAnswer {
    const run = entry?.ctx.run
    if (!entry || !run || !run.handBackRequired || !entry.handBack)
      return { text: HAND_BACK_NOT_TARGET_TEXT, isError: true }
    // A target of this dispatcher whose run is over (or was replaced): its tool is still there.
    if (this.runs.byLedgerId(entry.ledgerId) !== run)
      return { text: HAND_BACK_ENDED_TEXT, isError: true }
    if (typeof report !== 'string' || report.trim() === '')
      return { text: HAND_BACK_EMPTY_TEXT, isError: true }
    if (!run.acceptReport(capReport(report), callId))
      return { text: HAND_BACK_REPEAT_TEXT, isError: true }
    // The report is in: a message the model had not read when it wrote it is taken back from the
    // engine now, before this answer goes out, and sent again as the next run's input.
    this.settleSteers(run, entry, true)
    // The review runs beside the turn's end (the bodies await it before the run's end is decided):
    // a Claude target's came with the call (Claude Code's own classifier blocked it), the others'
    // is the target's own judge, started now.
    if (observed) run.reviewed = observed
    else this.startReview(entry, run)
    return { text: HAND_BACK_DONE_TEXT, isError: false }
  }

  // ── the review of a report by the X-Agent's own judge (ADR-105 §3, slice B-3c) ─────────

  /**
   * Who reviews THIS target's report, when anyone does: only a target running in a judged auto
   * mode. pi and opencode: ClaudeUI's judge for that engine (`autoModeActive` reads the live
   * mode and the engine's own switch). Codex: its native reviewer does not look at dynamic-tool
   * calls (`codex-rs/core/src/tools/handlers/dynamic.rs` asks no approval), so, while the thread
   * runs `auto` (`entry.autonomyMode`, as its other gates read it), the target's OWN model judges
   * through ClaudeUI's judge on its ChatGPT route. Claude: cli.js's classifier decides inside the
   * process and its verdict is read off the stream (`takeBlockedClaudeReport`), not asked here.
   */
  private reviewerFor(
    entry: TargetEntry
  ): ((report: string, signal: AbortSignal) => Promise<ReportReview>) | undefined {
    const run = entry.ctx.run
    const live = (): boolean =>
      !run.stopController.signal.aborted && !run.cancelController.signal.aborted
    const through =
      (judge: DispatchTargetJudge, mode: () => string) =>
      (report: string, signal: AbortSignal): Promise<ReportReview> =>
        judge.reviewHandBack(report, {
          currentMode: mode,
          stillPending: live,
          signal,
          permissions: () => this.userDenyAsk(entry.cwd, entry.ctx.callerRestriction)
        })
    switch (entry.kind) {
      case 'opencode':
      case 'pi':
        return entry.judge.autoModeActive(liveMode(entry.ctx))
          ? through(entry.judge, () => liveMode(entry.ctx))
          : undefined
      case 'codex': {
        // The thread's own mode (as its other gates read it), under the Codex engine's switch.
        const judge = this.codexReportJudge(entry)
        return judge.autoModeActive(entry.autonomyMode)
          ? through(judge, () => entry.autonomyMode)
          : undefined
      }
      case 'claude':
        return undefined
    }
  }

  /** The judge of a Codex target's report: pi's ChatGPT route, the target's own model, the Codex engine's switches. */
  private codexReportJudge(entry: CodexTargetEntry): DispatchTargetJudge {
    entry.reportJudge ??= new DispatchTargetJudge({
      engine: 'pi',
      configEngine: 'codex',
      fixedModel: () => entry.model,
      cwd: entry.cwd,
      routingId: () => entry.ctx.fromRoutingId,
      // The usage row is a pi-route row: it must not name a Codex thread as a pi session.
      sessionId: () => null,
      model: () => entry.model,
      emit: () => entry.ctx.emit,
      messages: () => entry.ctx.getMessages(),
      loadMessages: () => entry.ctx.loadMessages?.(),
      queuedTurns: () => entry.ctx.getQueuedUserTurns?.() ?? [],
      trajectory: () => [],
      subagent: () => ({
        type: 'dispatch:codex',
        description: judgeDescription(entry.model, entry.ctx.callerRestriction),
        prompt: entry.lastPrompt
      }),
      loadEngineConfig: this.deps.loadEngineConfig,
      peekModels: () => null,
      ...(this.deps.makeJudgeTransport ? { makeTransport: this.deps.makeJudgeTransport } : {})
    })
    return entry.reportJudge
  }

  /** Start the review of the report just accepted (a no-op for a target that is not judged). Never throws. */
  private startReview(entry: TargetEntry, run: DispatchRun): void {
    try {
      const review = run.report ? this.reviewerFor(entry) : undefined
      if (!review || !run.report) return
      const text = run.report.text
      // The judge request stops with the wait (`settleReview`: deadline, Stop, abandon).
      const ctl = new AbortController()
      run.reviewAbort = ctl
      run.review = review(text, ctl.signal).catch((err: unknown): ReportReview => ({
        kind: 'unavailable',
        why: errText(err)
      }))
    } catch (err) {
      logger.warn('CrossEngineDispatcher', `report review could not start: ${errText(err)}`)
      run.review = Promise.resolve({ kind: 'unavailable', why: errText(err) })
    }
  }

  /**
   * The turn bodies' wait for the review, just before the run's end is decided. Bounded by the
   * review deadline; a Stop or an abandoned blocking call ends the wait at once. Whatever
   * happens, the report is kept: the review only decides the words above it (`finishTurn`).
   */
  private async settleReview(run: DispatchRun): Promise<void> {
    const pending = run.review
    if (!pending || run.reviewed) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const detach: Array<() => void> = []
    const aborted = (signal: AbortSignal, why: string): Promise<ReportReview> =>
      new Promise((resolve) => {
        const done = (): void => resolve({ kind: 'unavailable', why })
        if (signal.aborted) return done()
        signal.addEventListener('abort', done, { once: true })
        detach.push(() => signal.removeEventListener('abort', done))
      })
    try {
      run.reviewed = await Promise.race([
        pending,
        new Promise<ReportReview>((resolve) => {
          timer = setTimeout(
            () => resolve({ kind: 'unavailable', why: 'the review took too long' }),
            this.handBackReviewMs
          )
        }),
        aborted(run.stopController.signal, 'the run was stopped before the review finished'),
        aborted(run.cancelController.signal, 'the call was abandoned before the review finished')
      ])
    } finally {
      if (timer) clearTimeout(timer)
      for (const off of detach) off()
      // Nobody waits for the judge any more: its request must not run on, billed (a no-op when
      // the review has finished).
      run.reviewAbort?.abort()
    }
  }

  /**
   * `hand_back` from the shared opencode server (wired in `core-services.ts`). The caller is
   * the session opencode's `_meta` names; only the dispatch target's OWN session may hand
   * back (a subagent child of the target, an interactive chat or an unknown id is refused).
   */
  handBackFromOpencode(
    sessionId: string,
    report: unknown,
    callId: string | undefined
  ): HandBackAnswer {
    const entry = this.targets.get(sessionId)
    return this.receiveHandBack(entry?.kind === 'opencode' ? entry : undefined, report, callId)
  }

  // ── session_message: an X-Agent talks to its dispatcher (ADR-105 §4) ───────────────────────

  /**
   * The permission mode an X-Agent runs under right now, which is its caller class for the session
   * tools: a Claude target's process mode, a Codex thread's native-policy mode, the parent's live
   * mode for pi and opencode (their gates read it live).
   */
  private targetMode(entry: TargetEntry): string {
    if (entry.kind === 'claude') return entry.appliedPermissionMode
    if (entry.kind === 'codex') return entry.autonomyMode
    return liveMode(entry.ctx)
  }

  /**
   * An X-Agent as the session tools' caller: its harness id is the routing id, its ledger id is the
   * actor of every audit row, and the service lets it run `session_message` to its dispatcher only.
   * A Claude target's calls carry the stream's owner map (a subagent of the target is refused); the
   * other engines' hosted paths only ever reach this with the X-Agent's own calls.
   */
  private xAgentCaller(entry: TargetEntry, toolUseId?: string): SessionToolCaller {
    return {
      routingId: entry.sessionId ?? '',
      engine: entry.kind,
      cwd: entry.cwd,
      permissionMode: this.targetMode(entry),
      xAgent: { ledgerId: entry.ledgerId, refuse: () => this.xAgentMessageRefusal(entry) },
      ...(toolUseId ? { toolUseId } : {}),
      ...(entry.kind === 'claude'
        ? { callOwner: (id: string | undefined) => entry.toolUseOwners.ownerOf(id) }
        : {})
    }
  }

  /** Why this X-Agent may not speak now: its run is over (the report was taken, or it was stopped). */
  private xAgentMessageRefusal(entry: TargetEntry): string | null {
    const run = entry.ctx.run
    return this.runs.byLedgerId(entry.ledgerId) !== run || run.report
      ? MESSAGE_RUN_ENDED_TEXT
      : null
  }

  /** `session_message` from a pi or Codex target, answered as the engine's tool result. */
  private async xAgentMessage(
    entry: TargetEntry,
    input: Record<string, unknown>,
    toolUseId?: string
  ): Promise<{ text: string; isError: boolean }> {
    const result = await runSessionTool(
      this.xAgentCaller(entry, toolUseId),
      X_AGENT_MESSAGE_TOOL,
      input
    )
    return { text: result.text, isError: result.isError === true }
  }

  /**
   * The caller of `claudeui_session_message` for an opencode session that is a dispatch target's
   * own (wired in `core-services.ts`, like `handBackFromOpencode`); undefined for anything else, so a
   * subagent child of the target, an interactive chat or an unknown id is not an X-Agent.
   */
  xAgentCallerFromOpencode(sessionId: string): SessionToolCaller | undefined {
    const entry = this.targets.get(sessionId)
    if (entry?.kind !== 'opencode' || !entry.canMessage) return undefined
    return this.xAgentCaller(entry)
  }

  /**
   * A turn ended successfully: say how the RUN ends.
   *  - Not a report run (the dispatcher's own suites): the turn's text, as always.
   *  - A report was handed back: the report is the result, in the terminal notification
   *    (`handback: 'send'`) and, framed, as a blocking call's answer. The turn's own last
   *    text is dropped. The framed answer keeps the cost-cap note the turn appended.
   *  - The target has no `hand_back` tool (a Codex thread from before it existed): its last
   *    message stands in, flagged as such.
   *  - Otherwise nothing is announced: the loop nudges the agent or withholds.
   */
  private finishTurn(
    ctx: RunContext,
    engine: EngineId,
    model: string,
    entry: Pick<TargetLedgerFields, 'handBack'>,
    sessionId: string,
    turn: {
      finalText: string
      outText: string
      usage: { totalTokens: number; toolUses: number; durationMs: number }
    }
  ): TurnReturn {
    const run = ctx.run
    if (!run.handBackRequired) {
      emitDispatchNotification(ctx, sessionId, 'completed', turn.finalText, turn.usage)
      return { text: turn.outText, sessionId }
    }
    run.usage.totalTokens += turn.usage.totalTokens
    run.usage.toolUses += turn.usage.toolUses
    run.usage.durationMs += turn.usage.durationMs
    const note = turn.outText.slice(turn.finalText.length)
    if (run.report) {
      const text = run.report.text
      // The review's words above the report (B-3c): a flag or a note; the report itself always goes.
      const disposition = dispositionOf(run.reviewed)
      run.finishedAs = {
        status: disposition.status,
        report: text,
        ...(disposition.warning ? { warning: disposition.warning } : {})
      }
      emitDispatchNotification(ctx, sessionId, 'completed', text, run.usage, {
        handback: disposition.handback,
        ...(disposition.warning ? { warning: disposition.warning } : {})
      })
      return {
        text: this.frameFor(ctx, engine, model, text, disposition.warning) + note,
        sessionId
      }
    }
    if (!entry.handBack) {
      run.finishedAs = { status: 'fallback', report: capReport(turn.finalText) }
      emitDispatchNotification(ctx, sessionId, 'completed', turn.finalText, run.usage, {
        handback: 'flagged',
        warning: HAND_BACK_FALLBACK_WARNING
      })
      return {
        text: this.frameFor(ctx, engine, model, turn.finalText, HAND_BACK_FALLBACK_WARNING) + note,
        sessionId
      }
    }
    return { text: turn.outText, sessionId, needsReport: true, capNote: note }
  }

  /**
   * After a `hand_back` call on an opencode or Codex target: how long to leave the turn
   * running. The tool result has to reach the agent before the turn is interrupted (an
   * interrupt that landed first would cancel the call), so this waits for the call's own tool
   * item to COMPLETE on the feed (`tool`); the turn may end by itself first (`turn`: nothing
   * to interrupt); and `handBackSettleMs` is only the ceiling for a feed that never says.
   */
  private async untilReportToolDone(
    toolDone: Promise<unknown>,
    turnEnded: Promise<unknown>
  ): Promise<'tool' | 'turn' | 'ceiling'> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        toolDone.then(() => 'tool' as const),
        turnEnded.then(() => 'turn' as const),
        new Promise<'ceiling'>((resolve) => {
          timer = setTimeout(() => resolve('ceiling'), this.handBackSettleMs)
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * The run ends with no report: nothing of the agent's unsent text is delivered. `note` is
   * what the last turn appended for the caller (the cost-cap line: why no nudge came).
   */
  private withholdReport(ctx: RunContext, sessionId: string, note = ''): DispatchResult {
    const run = ctx.run
    const text = handBackWithheldText(this.xAgentName(run))
    run.finishedAs = { status: 'withheld', report: null }
    emitDispatchNotification(ctx, sessionId, 'completed', text, run.usage, {
      handback: 'withheld'
    })
    return { text: text + note, sessionId }
  }

  /**
   * Run turns until the run has its end (ADR-105 §3): the task's turn, then — while it
   * ends without a report — a follow-up asking for it, at most three times, and then the
   * run is withheld. A target that waits on background work of its own (Claude's own
   * agents) is not nudged: the turn its work wakes is waited for instead. A target past
   * its `dispatch.maxCostUsd` is not nudged either (a nudge is a paid turn). A turn that
   * fails, is stopped or times out ends the run as it always did.
   */
  private async runWithNudges(
    ctx: RunContext,
    who: {
      sessionId: () => string
      engine: EngineId
      /** What the engine calls the tool (the nudge names it). */
      toolName: string
      cumulativeCostUsd: () => number
      waitingOnOwnWork?: () => boolean
    },
    first: string,
    turn: (prompt: string | null, nudge: boolean) => Promise<TurnReturn>
  ): Promise<DispatchResult> {
    let result = await turn(first, false)
    for (;;) {
      if (!result.needsReport) return result
      const run = ctx.run
      if (who.waitingOnOwnWork?.()) {
        result = await turn(null, false)
        continue
      }
      const cap = this.deps.loadEngineConfig(who.engine).dispatch?.maxCostUsd
      const overCap = cap !== undefined && who.cumulativeCostUsd() >= cap
      if (run.nudges >= MAX_HAND_BACK_NUDGES || overCap)
        return this.withholdReport(ctx, who.sessionId(), result.capNote)
      run.nudges++
      result = await turn(handBackNudge(who.toolName), true)
    }
  }

  // ── opencode direction (M1, opencode 2.x — ADR-097 S9) ────────────────────

  /** Everything past the guards for engine:'opencode' — runs with an
   *  a run slot held and the Stop handle already registered
   *  (the run, with its `stopController`, is registered in `launchRun`, BEFORE any
   *  await, so a Stop click during target creation is not lost).
   *
   *  The turn is an inbox prompt (`POST …/prompt`, answered at once) followed
   *  on the server's event feed through the target's own S4 mapper: its
   *  `result`/`error`/`auth-required`/`stopped` output settles the turn, and
   *  the turn's text and usage come from the same mapper outputs. Nothing
   *  waits header-silently on a model turn (ADR-033's 2026-09-01 amendment). */
  private async resolveAndRunOpencode(
    req: DispatchRequest,
    ctx: RunContext,
    stopController: AbortController
  ): Promise<DispatchResult> {
    // ── Model resolution ──────────────────────────────────────────────────
    const dispatchCfg = this.deps.loadEngineConfig(req.engine).dispatch
    const requestedModel = req.model ?? dispatchCfg?.defaultModel
    if (!requestedModel) {
      return errorResult(
        'No model is configured for cross-engine dispatch into opencode. Ask the user to set ' +
          'Settings › Cross-engine dispatch › Dispatch into › opencode (the `dispatch.defaultModel` field in ' +
          '~/.claude/ui/engines/opencode.json), or pass `model` explicitly.'
      )
    }
    const allowed = dispatchCfg?.allowedModels
    if (allowed && allowed.length > 0 && !allowed.includes(requestedModel)) {
      return errorResult(
        `Model "${requestedModel}" is not in the user-configured allowlist for opencode dispatch. ` +
          `Allowed models: ${allowed.join(', ')}`
      )
    }
    // Everything below keys on the CANONICAL spelling — the allowlist is
    // checked against what the user actually wrote, and nothing else is.
    const model = canonicalDispatchModel(req.engine, requestedModel)

    // ── Target resolution ─────────────────────────────────────────────────
    let entry: OpencodeTargetEntry
    if (req.sessionId) {
      const cont = this.findContinuation(req.sessionId, ctx, 'opencode')
      if (!cont) {
        return errorResult(
          `Unknown dispatch session "${req.sessionId}" — it may have been disposed. ` +
            'Start a new X-Agent with dispatch_agent.'
        )
      }
      // M-XE1: busy-reject BEFORE touching entry state — two concurrent
      // same-session_id calls would both pass the cost cap and the first
      // finisher's `finally` would clear the second turn's state.
      if ('live' in cont && cont.live.busy) {
        return errorResult(
          `Dispatch session "${req.sessionId}" is already running a turn — wait for it to finish before continuing it.`,
          req.sessionId
        )
      }
      // ADR-033 M4-C: reject a continuation turn once this target's tracked
      // cumulative cost has met/exceeded the configured cap. The target stays
      // alive — raising dispatch.maxCostUsd or starting a fresh dispatch both
      // recover. A brand-new target always starts at 0; one rebuilt from its
      // ledger row starts at what its recorded turns cost.
      const spent = this.continuationSpend(cont, dispatchCfg, req.sessionId, 'opencode')
      if ('text' in spent) return spent
      if ('row' in cont) {
        const refusal = this.resumeModelRefusal('opencode', cont.row.model, dispatchCfg)
        if (refusal) return refusal
      }
      this.bindContinuation(ctx, cont)
      if ('live' in cont) {
        cont.live.ctx = ctx
        entry = cont.live
      } else {
        try {
          entry = await this.createOpencodeTarget(ctx, cont.row.model, cont.row)
        } catch (err) {
          // A session opencode no longer has will never resume; any other failure (a
          // server that would not start, a lost feed) is worth another try.
          if (isOpencodeApiError(err) && err.status === 404)
            this.ledgerSet(cont.row.id, { state: 'failed' })
          return errorResult(
            `Could not resume dispatch session "${req.sessionId}": ${errText(err)}`,
            req.sessionId
          )
        }
        entry.cumulativeCostUsd = spent.costUsd
        entry.unpricedTurns = spent.unpricedTurns
      }
    } else {
      entry = await this.createOpencodeTarget(ctx, model, undefined, req)
    }
    // The judge's subagent task is the LATEST dispatch prompt (ADR-088).
    entry.lastPrompt = req.prompt
    // Reserve the target before the first await below, so a concurrent
    // continuation is busy-rejected rather than racing this one.
    entry.busy = true
    this.ledgerTurnState(entry, 'running')
    let started = false
    try {
      // A previous turn's give-up is still settling: a prompt now would steer
      // into the interrupted execution instead of starting this one.
      if (entry.stopping) await entry.stopping
      entry.draining = false

      // The LIVE mode's ruleset (a continuation follows the parent's mode
      // switches — 2.x's PATCH replaces). Fail closed: no rules, no turn.
      try {
        await this.applyTargetRules(entry)
      } catch (err) {
        const msg = `could not apply the dispatch permissions: ${errText(err)}`
        emitDispatchNotification(ctx, entry.sessionId, 'failed', `Dispatched turn failed: ${msg}`)
        return errorResult(`Dispatched turn failed: ${msg}`, entry.sessionId)
      }
      // ADR-097 §5 rule 2: a ChatGPT turn goes only on a token with time left.
      const notice = await opencodeAuthHooks()
        .beforeTurn(parseModelString(model).providerID)
        .catch(() => null)
      if (notice !== null) {
        emitDispatchNotification(ctx, entry.sessionId, 'failed', notice)
        return errorResult(notice, entry.sessionId)
      }
      // The feed has no replay: follow it before the prompt goes out.
      await withinMs(entry.rec.ready, FEED_READY_WAIT_MS)
      started = true
      return await this.runWithNudges(
        ctx,
        {
          sessionId: () => entry.sessionId,
          engine: 'opencode',
          toolName: `${CLAUDEUI_MCP_SERVER}_${HAND_BACK_TOOL}`,
          cumulativeCostUsd: () => entry.cumulativeCostUsd
        },
        this.taskText(entry, ctx, req.prompt, `${CLAUDEUI_MCP_SERVER}_${HAND_BACK_TOOL}`),
        (prompt, nudge) => {
          if (nudge) {
            // The turn before it released the target: a nudge is a turn of the same run.
            entry.busy = true
            this.ledgerTurnState(entry, 'running')
          }
          return this.runOpencodeTurn(entry, req, ctx, model, stopController, prompt as string)
        }
      )
    } finally {
      if (!started) {
        entry.busy = false
        this.ledgerTurnState(entry, 'idle')
      }
    }
  }

  /**
   * The run's progress heartbeat, turn-scoped: feeds TaskCard's elapsed clock under the
   * run's launching tool_use id, and — for a BLOCKING run only — pings the waiting MCP
   * request so the caller's call timeout keeps resetting (opencode as the source holds
   * the call under a hard wall otherwise).
   */
  private startHeartbeat(ctx: RunContext): ReturnType<typeof setInterval> {
    let beats = 0
    return setInterval(() => {
      beats++
      ctx.run.heartbeat(beats)
      emitDispatchProgress(ctx, (beats * this.heartbeatMs) / 1000)
    }, this.heartbeatMs)
  }

  /** One dispatch turn on a ready target (`busy` already set; cleared here). */
  private async runOpencodeTurn(
    entry: OpencodeTargetEntry,
    req: DispatchRequest,
    ctx: RunContext,
    model: string,
    stopController: AbortController,
    prompt: string
  ): Promise<TurnReturn> {
    const dispatchCfg = this.deps.loadEngineConfig(req.engine).dispatch
    const heartbeat = this.startHeartbeat(ctx)

    const signal = ctx.run.cancelController.signal
    let abortListener: (() => void) | undefined

    // Per-turn state. `turnStarted` gates the settle: a terminal output seen
    // before THIS turn's prompt was delivered belongs to another execution.
    const inboxID = newDispatchInboxId()
    entry.turnInboxId = inboxID
    entry.turnStarted = false
    entry.turnToolUseIds = new Set()
    entry.turnSteps = []
    entry.turnMessages = new Map()
    entry.openItems.clear()
    const turnStartedAt = this.now()
    entry.turnStartedAt = turnStartedAt
    entry.lastActivityAt = turnStartedAt

    type Raced =
      | { kind: 'done' }
      | { kind: 'failed'; message: string }
      | { kind: 'err'; err: unknown }
      | { kind: 'timeout'; reason: 'absolute' | 'inactivity' }
      | { kind: 'abort' }
      | { kind: 'stop' }
      | { kind: 'report' }

    // Installed BEFORE the prompt goes out, so no terminal output can find it null.
    const settledPromise = new Promise<Raced>((resolve) => {
      entry.settled = (outcome): void => resolve(outcome)
    })
    entry.reportToolIds.clear()
    const reportToolDone = new Promise<void>((resolve) => {
      entry.reportToolDone = resolve
    })
    // The prompt answers at once with the inbox item; only a REFUSAL is a race
    // outcome (the turn itself ends on the feed). NEVER posted once the turn
    // was given up (a Stop armed before it, the caller's abort): an interrupt
    // cannot stop a turn that has not started yet.
    const givenUp = stopController.signal.aborted || signal?.aborted === true
    let promptPromise: Promise<Raced> = new Promise<Raced>(() => {})
    entry.pendingPrompt = null
    if (!givenUp) {
      const posted = entry.client.prompt(entry.sessionId, {
        id: inboxID,
        text: expandClaudeSkillInvocation(prompt, entry.skillCatalog)?.text ?? prompt,
        delivery: 'steer'
      })
      entry.pendingPrompt = { posted, inboxID }
      promptPromise = posted.then(
        () => new Promise<Raced>(() => {}),
        (err): Raced => ({ kind: 'err', err })
      )
    }
    // A switch of the parent's mode mid-turn re-applies the ruleset at once,
    // as an opencode chat does (2.x's PATCH replaces; the plugin re-reads the
    // session's rules on every ask).
    const modeWatch = setInterval(() => this.followTargetMode(entry), MODE_WATCH_MS)
    const caps = resolveTurnLiveness(dispatchCfg)
    const watchdog = this.startTurnWatchdog(entry, caps, turnStartedAt, () =>
      this.hasPendingApprovalFor(entry.sessionId)
    )
    const abortPromise: Promise<Raced> = signal
      ? signal.aborted
        ? Promise.resolve({ kind: 'abort' })
        : new Promise((resolve) => {
            abortListener = (): void => resolve({ kind: 'abort' })
            signal.addEventListener('abort', abortListener, { once: true })
          })
      : new Promise(() => {})
    const stopPromise: Promise<Raced> = stopController.signal.aborted
      ? Promise.resolve({ kind: 'stop' })
      : new Promise((resolve) => {
          stopController.signal.addEventListener('abort', () => resolve({ kind: 'stop' }), {
            once: true
          })
        })
    // The agent handed its report back (ADR-105 §3): the run is over, the turn is to end.
    const reportPromise: Promise<Raced> = ctx.run.reported.then((): Raced => ({ kind: 'report' }))

    /** The ledger row + cap + breakdown for whatever this turn spent so far. */
    const account = (record: boolean): { costUsd: number | null; usage: OpencodeTurnUsage } => {
      const usage = opencodeTurnUsage(model, entry.turnSteps)
      if (usage.costUsd === null) entry.unpricedTurns++
      else {
        entry.cumulativeCostUsd += usage.costUsd
        if (usage.costUsd > 0) ctx.addDispatchedCost?.(req.engine, model, usage.costUsd)
      }
      if (record)
        this.safeRecordUsage({
          ts: this.now(),
          fromRoutingId: ctx.fromRoutingId,
          targetEngine: req.engine,
          targetModel: model,
          targetSessionId: entry.sessionId,
          toolUseId: ctx.toolUseId ?? null,
          ...(usage.steps > 0 ? { tokens: usage.tokens } : {}),
          engineCostUsd: usage.engineCostUsd,
          account: opencodeDispatchAccount(model),
          // opencode reports what it CHARGED, not an equivalent (ADR-071 §1).
          engineCostIsEquivalent: false
        })
      return { costUsd: usage.costUsd, usage }
    }

    // The last turn failed (a refused prompt, a server-side failure): the row says so, and
    // a continuation may still retry it.
    let endState: DispatchTargetState = 'idle'
    try {
      const winner = await Promise.race([
        settledPromise,
        promptPromise,
        watchdog.promise,
        abortPromise,
        stopPromise,
        reportPromise
      ])

      if (winner.kind === 'report') {
        // Let the tool result reach the agent (an interrupt first would cancel the call
        // itself), then end its turn: the report is the result, whatever it would say next.
        // A turn that ended by itself meanwhile needs no interrupt.
        const how = await this.untilReportToolDone(reportToolDone, settledPromise)
        entry.settled = null
        if (how !== 'turn') {
          entry.draining = true
          void this.stopTargetTurn(entry, entry.pendingPrompt)
        }
        this.dismissPendingForTarget(entry.sessionId)
      } else if (winner.kind === 'stop' || winner.kind === 'timeout' || winner.kind === 'abort') {
        // The session survives for a continuation; only this turn is
        // interrupted. Drop the resolver FIRST: the interrupt's own
        // `stopped` output must find nothing to settle.
        entry.settled = null
        entry.draining = true
        void this.stopTargetTurn(entry, entry.pendingPrompt)
        this.dismissPendingForTarget(entry.sessionId)
        const text =
          winner.kind === 'stop'
            ? 'Dispatch stopped by user.'
            : winner.kind === 'abort'
              ? 'Dispatch cancelled.'
              : turnTimeoutText(winner.reason, caps, OPENCODE_TIMEOUT_AFTERMATH)
        const status = winner.kind === 'timeout' ? 'failed' : 'stopped'
        ctx.run.timedOut = winner.kind === 'timeout'
        // A timeout is a failed turn (always a row); a stop or cancel is a row
        // only when the turn already spent something (ADR-033 M4-B).
        account(status === 'failed' || entry.turnSteps.length > 0)
        emitDispatchNotification(ctx, entry.sessionId, status, text)
        return errorResult(text, entry.sessionId)
      }

      if (winner.kind === 'err') {
        endState = 'failed'
        // The server refused the prompt. ZOMBIE GUARD: a transport failure on
        // an accepted request is indistinguishable from a refusal out here,
        // and an interrupt of an idle session is a no-op upstream.
        entry.settled = null
        entry.draining = true
        void this.stopTargetTurn(entry, entry.pendingPrompt)
        this.dismissPendingForTarget(entry.sessionId)
        const msg = errText(winner.err)
        account(true)
        emitDispatchNotification(ctx, entry.sessionId, 'failed', `Dispatched turn failed: ${msg}`)
        return errorResult(`Dispatched turn failed: ${msg}`, entry.sessionId)
      }

      if (winner.kind === 'failed') {
        endState = 'failed'
        // The turn RAN and failed server-side; it already ended (no interrupt).
        // Its spend still counts toward the cap and the breakdown.
        this.dismissPendingForTarget(entry.sessionId)
        account(true)
        emitDispatchNotification(
          ctx,
          entry.sessionId,
          'failed',
          `Dispatched turn failed: ${winner.message}`
        )
        return errorResult(`Dispatched turn failed: ${winner.message}`, entry.sessionId)
      }

      // ── The turn succeeded ──────────────────────────────────────────────
      const finalText =
        lastTurnText(entry.turnMessages) || '(the dispatched agent returned no text)'
      const maxCostUsd = dispatchCfg?.maxCostUsd
      const wasUnderCap = maxCostUsd === undefined || entry.cumulativeCostUsd < maxCostUsd
      const { costUsd, usage } = account(true)
      let outText = finalText
      if (costUsd === null) {
        // An unpriced turn can never trip the cap: say so on the turn itself.
        if (maxCostUsd !== undefined) outText += cannotCountNote(model)
      } else if (maxCostUsd !== undefined && wasUnderCap && entry.cumulativeCostUsd >= maxCostUsd) {
        outText +=
          '\n\n[dispatch cost cap reached — further turns on this session will be rejected]'
      }
      await this.settleReview(ctx.run)
      return this.finishTurn(ctx, 'opencode', model, entry, entry.sessionId, {
        finalText,
        outText,
        usage: {
          totalTokens: usage.totalTokens,
          toolUses: entry.turnToolUseIds.size,
          durationMs: this.now() - turnStartedAt
        }
      })
    } finally {
      this.sealOpencodeTargetItems(entry)
      entry.reportToolDone = null
      entry.busy = false
      this.ledgerTurnState(entry, endState)
      entry.pendingPrompt = null
      // Settle-once: no LATER output may resolve a turn that has returned.
      entry.settled = null
      clearInterval(heartbeat)
      clearInterval(modeWatch)
      watchdog.dispose()
      if (signal && abortListener) signal.removeEventListener('abort', abortListener)
    }
  }

  /**
   * A new opencode dispatch target: a turn-running lease (so the
   * `claudeui-xeng` permission guard is required), a client scoped to the
   * caller's directory, a session created WITH its ruleset, agent and model,
   * and the server's shared feed. Its own mapper follows the session and its
   * subagent children; the child keeper narrows those children (S6).
   */
  private async createOpencodeTarget(
    ctx: RunContext,
    model: string,
    resume?: DispatchTargetRow,
    labels?: DispatchLabels
  ): Promise<OpencodeTargetEntry> {
    // A dispose of the dispatching chat while this target is being created
    // disposes the new target too.
    const generation = this.disposals.get(this.runs.parentOf(ctx.fromRoutingId)) ?? 0
    // A resumed target runs where it was created (ADR-105): the stored directory.
    const cwd = resume?.cwd ?? ctx.cwd
    const conn = await this.deps.serverManager.acquire(cwd)
    let skillCatalog = conn.skillCatalog ?? resolveClaudeSkills(cwd)
    let rec: ConnRecord | null = null
    let client: DispatchTargetClient | null = null
    let createdId: string | null = null
    try {
      client = this.deps.makeClient(conn)
      const exposedSkills = (await (client as OpencodeClient).skills?.().catch(() => [])) ?? []
      skillCatalog = effectiveClaudeSkillCatalog(skillCatalog, exposedSkills)
      rec = this.connectionFor(conn, client)
      rec.creating++
      const inputs: TargetRuleInputs = {
        client,
        cwd,
        agents: null,
        mcpServers: null,
        worktree: undefined,
        ownDirAllows: null
      }
      // ADR-088 — the judge reads the target through `entry`, declared below
      // (it is only ever called once the target runs a turn).
      const judge = new DispatchTargetJudge({
        engine: 'opencode',
        cwd,
        routingId: () => entry.ctx.fromRoutingId,
        sessionId: () => entry.sessionId,
        model: () => entry.model,
        emit: () => entry.ctx.emit,
        messages: () => entry.ctx.getMessages(),
        loadMessages: () => entry.ctx.loadMessages?.(),
        queuedTurns: () => entry.ctx.getQueuedUserTurns?.() ?? [],
        blockedCalls: () => entry.ctx.blockedCalls,
        trajectory: () => entry.trajectory.values(),
        subagent: () => ({
          type: 'dispatch:opencode',
          description: judgeDescription(entry.model, entry.ctx.callerRestriction),
          prompt: entry.lastPrompt
        }),
        loadEngineConfig: this.deps.loadEngineConfig,
        peekModels: peekOpencodeModels,
        ...(this.deps.makeJudgeTransport ? { makeTransport: this.deps.makeJudgeTransport } : {})
      })
      const mode = liveMode(ctx)
      const built = await this.buildTargetRuleset(
        inputs,
        mode,
        judge.autoModeActive(mode),
        ctx.callerRestriction,
        sessionToolsAvailable()
      )
      const { providerID, modelID } = parseModelString(model)
      // The title is load-bearing, not cosmetic: this is a real top-level
      // opencode session, so `usage-reconciler.ts` would otherwise import every
      // assistant message under it a SECOND time, as an ordinary `origin:
      // 'session'` row beside the `dispatch` row this dispatcher writes. It
      // skips sessions carrying this exact title — see the constant's doc.
      // A resumed target re-reads its session (the one the ledger names) instead of
      // creating one; its ruleset is re-applied at the next turn start (`applied: null`).
      const session = resume
        ? await client.getSession(resume.harnessRef)
        : await client.createSession({
            title: OPENCODE_DISPATCH_SESSION_TITLE,
            model: { providerID, id: modelID },
            permissions: built.rules,
            ...(built.agent ? { agent: built.agent } : {})
          })
      // Only a session created here is this call's to roll back.
      if (!resume) createdId = session.id
      // A feed lost meanwhile would never deliver this target's events, and a
      // chat disposed meanwhile owns no target any more: fail, roll back.
      if (rec.abort.signal.aborted) throw new Error('the opencode event feed was lost')
      // A BACKGROUND run belongs to its parent's durable id, not to the session object that
      // launched it (ADR-105): a dispose across its creation does not undo it.
      if (
        !ctx.run.background &&
        (this.disposals.get(this.runs.parentOf(ctx.fromRoutingId)) ?? 0) !== generation
      )
        throw new Error('the dispatching session was disposed')
      const targetClient = client
      // The durable record (ADR-105): written once the session is known to be ours
      // to keep — after the checks above, whose rollback deletes it instead.
      const ledgerId =
        resume?.id ??
        this.recordTarget(ctx, {
          engine: 'opencode',
          harnessRef: session.id,
          model,
          accountKey: opencodeDispatchAccount(model).accountKey,
          labels,
          handBack: this.requireHandBack
        }).id
      const entry: OpencodeTargetEntry = {
        kind: 'opencode',
        skillCatalog,
        reportToolIds: new Set(),
        reportToolDone: null,
        sessionId: session.id,
        ledgerId,
        released: false,
        handBack: this.requireHandBack,
        canMessage: sessionToolsAvailable(),
        fromRoutingId: ctx.fromRoutingId,
        conn,
        rec,
        ...inputs,
        ctx,
        busy: false,
        settled: null,
        turnStarted: false,
        turnInboxId: null,
        pendingPrompt: null,
        draining: false,
        appliedMode: resume ? null : mode,
        applying: null,
        stopping: null,
        turnStartedAt: 0,
        lastActivityAt: 0,
        mapper: new OpencodeEventMapper({
          sessionID: session.id,
          model: session.model ?? { providerID, id: modelID }
        }),
        children: new ChildRulesetKeeper({
          client: () => targetClient,
          rootSessionId: () => entry.sessionId,
          rootRules: () => entry.applied?.rules,
          loadAgents: () => this.targetAgents(entry),
          agentInfo: (id) => agentById(entry.agents, id),
          logSource: 'CrossEngineDispatcher'
        }),
        agent: session.agent ?? built.agent ?? null,
        applied: resume ? null : { rules: built.rules, key: JSON.stringify(built.rules) },
        hostRules: asHostPrecheckRules(built.userRules),
        openItems: new Map(),
        turnSteps: [],
        turnMessages: new Map(),
        cumulativeCostUsd: 0,
        unpricedTurns: 0,
        turnToolUseIds: new Set(),
        judge,
        model,
        lastPrompt: '',
        judging: new Set(),
        trajectory: new Map()
      }
      rec.targets.add(entry)
      rec.creating--
      this.targets.set(session.id, entry)
      this.reapOrphanSessions(client)
      return entry
    } catch (err) {
      // Roll back the session, the lease and the record (when it was the only
      // reason for one).
      if (rec) {
        rec.creating--
        this.releaseRecord(rec)
      }
      const rollback =
        client && createdId ? this.deleteTargetSession(client, createdId) : Promise.resolve()
      void rollback.finally(() => this.deps.serverManager.releaseIfCurrent(cwd, conn))
      throw err
    }
  }

  /** The server's shared feed record, started on first use (one per server, not per cwd). */
  private connectionFor(conn: ServerConnection, client: DispatchTargetClient): ConnRecord {
    const key = serverKey(conn)
    const existing = this.connections.get(key)
    if (existing) return existing
    let markReady!: () => void
    const ready = new Promise<void>((resolve) => (markReady = resolve))
    const rec: ConnRecord = {
      key,
      client,
      abort: new AbortController(),
      targets: new Set(),
      creating: 0,
      ready,
      unsubscribeExit: () => {}
    }
    this.connections.set(key, rec)
    // A server that dies takes every target on it down with it.
    rec.unsubscribeExit = this.deps.serverManager.subscribeExit(
      conn.directory,
      () => this.loseConnection(rec, 'the opencode server exited'),
      conn
    )
    void this.runTargetFeed(rec, markReady)
    return rec
  }

  /** Drop a record once no target uses it: its feed ends. */
  private releaseRecord(rec: ConnRecord): void {
    if (rec.targets.size > 0 || rec.creating > 0) return
    if (this.connections.get(rec.key) === rec) this.connections.delete(rec.key)
    rec.abort.abort()
    rec.unsubscribeExit()
  }

  /**
   * A server's feed or process is gone: every target on it fails its turn in
   * flight and is dropped (nothing can be answered on it now), after a
   * best-effort interrupt, and its lease is released exactly. The sessions stay
   * (ADR-105): the ledger rows say how each was left, and a continuation
   * re-reads the session through a fresh server.
   */
  private loseConnection(rec: ConnRecord, reason: string): void {
    if (this.connections.get(rec.key) === rec) this.connections.delete(rec.key)
    rec.abort.abort()
    rec.unsubscribeExit()
    for (const entry of [...rec.targets]) {
      rec.targets.delete(entry)
      if (this.targets.get(entry.sessionId) === entry) this.targets.delete(entry.sessionId)
      this.dismissPendingForTarget(entry.sessionId)
      entry.released = true
      this.ledgerSet(entry.ledgerId, { state: entry.busy ? 'interrupted' : 'idle' })
      const settle = entry.settled
      entry.settled = null
      settle?.({ kind: 'failed', message: reason })
      logger.warn('CrossEngineDispatcher', `opencode target ${entry.sessionId} dropped: ${reason}`)
      // A server still up (only its feed was lost) must not run on unwatched;
      // against a dead one the requests fail at once.
      entry.draining = true
      void this.stopTargetTurn(entry, entry.pendingPrompt).finally(() =>
        this.deps.serverManager.releaseIfCurrent(entry.cwd, entry.conn)
      )
    }
  }

  /**
   * Interrupt a target's turn — its own session and every subagent child the
   * mapper still follows — and wait (bounded) until the server no longer lists
   * them active. Recorded on the entry so the next turn waits for it.
   */
  private stopTargetTurn(
    entry: OpencodeTargetEntry,
    pending?: { posted: Promise<unknown>; inboxID: string } | null
  ): Promise<void> {
    const stopping = (async () => {
      // A prompt still in flight is admitted (or refused) first; only then can
      // its inbox item be cancelled and the execution it started interrupted.
      if (pending)
        await withinMs(
          pending.posted.catch(() => {}),
          TEARDOWN_GRACE_MS
        )
      await stopOpencodeSessions(
        entry.client,
        entry.mapper.followedSessions(),
        pending ? { sessionID: entry.sessionId, ids: [pending.inboxID] } : undefined
      )
    })()
    entry.stopping = stopping
    void stopping.finally(() => {
      if (entry.stopping === stopping) entry.stopping = null
    })
    return stopping
  }

  /**
   * Release a disposed target (already out of `this.targets`): stop what runs on
   * it, then release its lease exactly and its feed record. Its session is KEPT
   * (ADR-105): the ledger row resumes it, and `deleteTargetSession` runs only for
   * a session that never became a row (a creation rolled back).
   */
  private teardownOpencodeTarget(entry: OpencodeTargetEntry): void {
    entry.rec.targets.delete(entry)
    this.releaseRecord(entry.rec)
    entry.draining = true
    void this.stopTargetTurn(entry, entry.pendingPrompt).finally(() =>
      this.deps.serverManager.releaseIfCurrent(entry.cwd, entry.conn)
    )
  }

  /**
   * Delete an opencode session this dispatcher created (the data dir is shared
   * with the user's own opencode); one that cannot be deleted now (its server is
   * gone) is remembered and deleted through the next target's server. The ONE
   * place a target's session is ever deleted.
   */
  private async deleteTargetSession(
    client: DispatchTargetClient,
    sessionId: string
  ): Promise<void> {
    try {
      await client.deleteSession(sessionId)
      this.orphanSessions.delete(sessionId)
    } catch (err) {
      // A 404 means it is gone already.
      if (isOpencodeApiError(err) && err.status === 404) this.orphanSessions.delete(sessionId)
      else this.orphanSessions.add(sessionId)
    }
  }

  /** Delete the sessions of targets lost with their server, through a live one. */
  private reapOrphanSessions(client: DispatchTargetClient): void {
    for (const sessionId of [...this.orphanSessions])
      void this.deleteTargetSession(client, sessionId)
  }

  // ── Target permissions (S6 rulesets, recomputed per turn) ────────────────

  /**
   * The target's ruleset for `mode`: the interactive session's
   * `buildSessionRuleset` over the user's deny/ask rules ONLY (ADR-085 §3,
   * ADR-033: never their allow rules or additional directories), then
   * the target-only rules (`TARGET_DISPATCH_DENY`, `targetSessionToolRules`, `TARGET_QUESTION_DENY`) — no dispatch back (ADR-033 §4) and no questions
   * (nobody to answer them). Whole-category denies go last (hidden tools).
   */
  private async buildTargetRuleset(
    inputs: TargetRuleInputs,
    mode: string,
    autoMode: boolean,
    restriction: CallerRestriction | undefined,
    canMessage: boolean
  ): Promise<{ rules: V2Rule[]; userRules: V2Rule[]; agent: string | undefined }> {
    const [mcpServers, worktree, agents, externalDirAllows] = await Promise.all([
      this.targetMcpServers(inputs),
      this.targetWorktree(inputs),
      this.targetAgents(inputs),
      this.targetOwnDirAllows(inputs)
    ])
    const built = buildSessionRuleset({
      mode,
      autoMode,
      permissions: this.userDenyAsk(inputs.cwd, restriction),
      mcpServers,
      cwd: inputs.cwd,
      ...(worktree ? { worktree } : {}),
      externalDirAllows,
      // The dispatch target is who `claudeui_hand_back` is for: it gets the allow in every
      // mode (auto's classifier and the asking modes must never put the report behind an
      // approval) instead of the deny every other session of the server has.
      handBackTarget: this.requireHandBack
    })
    const first = agents?.[0]
    const defaultAgent = first && first.mode !== 'subagent' ? first.id : undefined
    return {
      rules: wireOrder([
        ...built.rules,
        TARGET_DISPATCH_DENY,
        ...targetSessionToolRules(canMessage, autoMode),
        TARGET_QUESTION_DENY,
        ...(this.requireHandBack ? [HAND_BACK_ALLOW_RULE] : [])
      ]),
      userRules: built.userRules,
      agent: built.agent ?? defaultAgent
    }
  }

  /**
   * Put the LIVE mode's ruleset and agent on the target before a turn: PATCH
   * (which replaces) only when it changed, re-derive the children, switch the
   * agent (`plan` in plan mode). Throws — the turn then does not run.
   */
  private applyTargetRules(entry: OpencodeTargetEntry): Promise<void> {
    const run = (entry.applying ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.applyTargetRulesNow(entry))
    entry.applying = run
    void run
      .finally(() => {
        if (entry.applying === run) entry.applying = null
      })
      .catch(() => {})
    return run
  }

  private async applyTargetRulesNow(entry: OpencodeTargetEntry): Promise<void> {
    const mode = liveMode(entry.ctx)
    const built = await this.buildTargetRuleset(
      entry,
      mode,
      entry.judge.autoModeActive(mode),
      entry.ctx.callerRestriction,
      entry.canMessage
    )
    entry.hostRules = asHostPrecheckRules(built.userRules)
    const key = JSON.stringify(built.rules)
    if (entry.applied?.key !== key) {
      await entry.client.setSessionPermissions(entry.sessionId, built.rules)
      entry.applied = { rules: built.rules, key }
    }
    entry.children.repatchChildren()
    if (built.agent && entry.agent !== built.agent) {
      await entry.client.switchAgent(entry.sessionId, built.agent)
      entry.agent = built.agent
    }
    entry.appliedMode = mode
  }

  /**
   * Mid-turn: the parent's mode moved off the one the ruleset was built for →
   * re-apply now (a switch to plan or default tightens at once). Fails CLOSED:
   * a ruleset that cannot be applied ends the turn (interrupted).
   */
  private followTargetMode(entry: OpencodeTargetEntry): void {
    if (!entry.busy || entry.draining || entry.applying) return
    if (liveMode(entry.ctx) === entry.appliedMode) return
    void this.applyTargetRules(entry).catch((err) => {
      logger.error(
        'CrossEngineDispatcher',
        `opencode target ${entry.sessionId}: mode switch not applied — ending the turn: ${errText(err)}`
      )
      const settle = entry.settled
      entry.settled = null
      entry.draining = true
      void this.stopTargetTurn(entry, entry.pendingPrompt)
      settle?.({
        kind: 'failed',
        message: `could not apply the new permission mode: ${errText(err)}`
      })
    })
  }

  /**
   * A step outside any turn of the dispatcher's (an execution woken by a
   * background subagent's completion, a step landing after a give-up): its
   * spend is still the dispatch's — one ledger row, the cap and the
   * dispatching session's breakdown.
   */
  private meterStrayStep(entry: OpencodeTargetEntry, step: OpencodeStepUsage): void {
    const usage = opencodeTurnUsage(entry.model, [step])
    if (usage.costUsd === null) entry.unpricedTurns++
    else {
      entry.cumulativeCostUsd += usage.costUsd
      if (usage.costUsd > 0) entry.ctx.addDispatchedCost?.('opencode', entry.model, usage.costUsd)
    }
    this.safeRecordUsage({
      ts: this.now(),
      fromRoutingId: entry.fromRoutingId,
      targetEngine: 'opencode',
      targetModel: entry.model,
      targetSessionId: entry.sessionId,
      toolUseId: entry.ctx.toolUseId ?? null,
      tokens: usage.tokens,
      engineCostUsd: usage.engineCostUsd,
      account: opencodeDispatchAccount(entry.model),
      engineCostIsEquivalent: false
    })
  }

  /** Bridged + `claudeui` + `GET /api/mcp` names (cached; a failed read is not). */
  private async targetMcpServers(inputs: TargetRuleInputs): Promise<string[]> {
    if (inputs.mcpServers) return inputs.mcpServers
    const known = [
      ...new Set([...Object.keys(collectClaudeMcpForOpencode(inputs.cwd)), CLAUDEUI_MCP_SERVER])
    ]
    try {
      const servers = await inputs.client.mcpServers()
      inputs.mcpServers = [...new Set([...known, ...servers.map((server) => server.name)])]
      return inputs.mcpServers
    } catch (err) {
      logger.debug('CrossEngineDispatcher', `opencode target: GET /api/mcp failed: ${errText(err)}`)
      return known
    }
  }

  /** The location's worktree root (cached; a failed read is not). */
  private async targetWorktree(inputs: TargetRuleInputs): Promise<string | undefined> {
    if (inputs.worktree !== undefined) return inputs.worktree ?? undefined
    try {
      inputs.worktree = await locationWorktree(inputs.client)
    } catch (err) {
      logger.debug(
        'CrossEngineDispatcher',
        `opencode target: GET /api/location failed: ${errText(err)}`
      )
      return undefined
    }
    return inputs.worktree ?? undefined
  }

  /**
   * opencode's own directories as `external_directory` allows, in every mode
   * (cached; an `/api/info` failure is not). The target's user rules carry no
   * `additionalDirectories` (ADR-033), so these are the only allows under the ask.
   */
  private async targetOwnDirAllows(inputs: TargetRuleInputs): Promise<V2Rule[]> {
    if (inputs.ownDirAllows) return inputs.ownDirAllows
    let failed = false
    const allows = await resolveOpencodeOwnDirAllows(inputs.client, {
      onError: (message) => {
        failed = true
        logger.debug('CrossEngineDispatcher', `opencode target: ${message}`)
      }
    })
    if (!failed) inputs.ownDirAllows = allows
    return allows
  }

  /** `GET /api/agent` (cached; a failed read is not, and answers null). */
  private async targetAgents(inputs: TargetRuleInputs): Promise<Agent_Info[] | null> {
    if (inputs.agents) return inputs.agents
    try {
      const listed = await inputs.client.agents()
      if (!Array.isArray(listed)) throw new Error('GET /api/agent did not return a list')
      inputs.agents = [...listed]
      return inputs.agents
    } catch (err) {
      logger.warn(
        'CrossEngineDispatcher',
        `opencode target: GET /api/agent failed: ${errText(err)}`
      )
      return null
    }
  }

  // ── The feed (one per server, shared by its targets) ──────────────────────

  private async runTargetFeed(rec: ConnRecord, markReady: () => void): Promise<void> {
    const { signal } = rec.abort
    try {
      // Reconnects are the feed's own (no replay: `connected{reconnected}`
      // means re-read). It ends only on abort, or when the server refuses the
      // subscription outright (not ours any more) — then the targets are lost.
      for await (const item of rec.client.subscribeEvents({
        signal,
        maxConsecutiveFailures: Infinity
      })) {
        if (signal.aborted) break
        if (item.kind === 'connected') {
          // The read pauses the feed, so live events never interleave with it.
          if (item.reconnected) await this.reconcileTargets(rec)
          markReady()
          continue
        }
        if (item.kind === 'disconnected') {
          logger.info(
            'CrossEngineDispatcher',
            `opencode event feed dropped (${item.error.message}); retrying in ${item.retryInMs} ms`
          )
          continue
        }
        this.handleTargetEvent(rec, item.event)
      }
    } catch (err) {
      if (!signal.aborted)
        logger.warn('CrossEngineDispatcher', `opencode event feed failed: ${errText(err)}`)
    } finally {
      markReady()
      if (!signal.aborted) this.loseConnection(rec, 'the opencode event feed was lost')
    }
  }

  /** After a gap: re-read every target's sessions and apply what the gap hid (S4 contract). */
  private async reconcileTargets(rec: ConnRecord): Promise<void> {
    for (const entry of [...rec.targets]) {
      try {
        const outputs = await reconcileAfterReconnect(entry.client, entry.mapper)
        for (const output of outputs) this.onTargetOutput(entry, output)
        await entry.children.adoptUnknown(entry.mapper.followedSessions())
      } catch (err) {
        logger.warn(
          'CrossEngineDispatcher',
          `opencode target ${entry.sessionId}: reconnect catch-up failed (the watchdog still runs): ${errText(err)}`
        )
      }
    }
  }

  /** One feed event: the child keeper's raw hooks, liveness, then each target's mapper. */
  private handleTargetEvent(rec: ConnRecord, event: OpencodeV2Event): void {
    const sessionID = eventSessionID(event)
    for (const entry of [...rec.targets]) {
      if (event.type === 'session.created') entry.children.onSessionCreated(event.data)
      else if (event.type === 'session.agent.selected') entry.children.onAgentSelected(event.data)
      // ANY event of a busy target's session or child proves it alive (a turn
      // parked on a human is refreshed by the watchdog itself).
      if (entry.busy && sessionID && entry.mapper.followedSessions().includes(sessionID))
        entry.lastActivityAt = this.now()
      for (const output of entry.mapper.map(event)) this.onTargetOutput(entry, output)
    }
  }

  /**
   * One mapper output of a target (live or re-read). Only the target's OWN
   * output streams onto the dispatch card (a task child's stays off it, as
   * before); approvals, usage and turn ends come from every followed session.
   */
  private onTargetOutput(entry: OpencodeTargetEntry, o: OpencodeMapperOutput): void {
    switch (o.kind) {
      case 'turn-start':
        // An execution starting while a give-up winds down is interrupted
        // again (nobody is waiting for it).
        if (entry.draining) void this.stopTargetTurn(entry)
        // A turn nobody asked for, started by a message the X-Agent was sent for a run that is over:
        // not observed, not recorded, so it is ended at once (the message is sent again as a run).
        else if (this.hasStraySteers(entry.ledgerId)) {
          logger.info(
            'CrossEngineDispatcher',
            `opencode target ${entry.sessionId}: stray turn ended`
          )
          void this.stopTargetTurn(entry)
        }
        return
      case 'inbox':
        if (o.change === 'delivered') {
          this.markTurnDelivered(entry, o.inboxID)
          this.noteSteerConsumed(o.inboxID)
        }
        return
      case 'user-message':
        this.markTurnDelivered(entry, o.inboxID)
        this.noteSteerConsumed(o.inboxID)
        return
      case 'item-open':
        if (!o.open.target.ownerToolUseId) this.openOpencodeTargetItem(entry, o.open)
        return
      case 'item-delta':
        if (!o.target.ownerToolUseId) this.appendOpencodeTargetItem(entry, o.target, o.chunk)
        return
      case 'item-seal':
        if (!o.seal.ownerToolUseId && !o.seal.target?.ownerToolUseId)
          this.sealOpencodeTargetItem(entry, o.seal)
        return
      case 'message': {
        if (o.ownerToolUseId) return
        for (const block of o.message.content)
          if (
            block.type === 'tool_use' &&
            block.toolName === `${CLAUDEUI_MCP_SERVER}_${HAND_BACK_TOOL}`
          )
            entry.reportToolIds.add(block.toolUseId)
        this.noteTargetMessage(entry, o.message)
        const owner = streamOwner(entry)
        if (!owner) return
        collectToolUseIds(o.message, entry.turnToolUseIds)
        entry.ctx.emit('session:subagent-message', { toolUseId: owner, message: o.message })
        return
      }
      case 'tool-result': {
        // The report's own call has completed: the agent has its answer, the turn may end. Only
        // once the report was ACCEPTED (an earlier, refused call completing says nothing): the
        // hosted call carries no id, so it is the first hand_back result after acceptance.
        if (
          !o.ownerToolUseId &&
          entry.ctx.run.report &&
          entry.reportToolIds.has(o.result.toolUseId)
        )
          entry.reportToolDone?.()
        const owner = streamOwner(entry)
        if (o.ownerToolUseId || !owner) return
        entry.ctx.emit('session:subagent-tool-result', {
          toolUseId: owner,
          toolResultToolUseId: o.result.toolUseId,
          result: o.result.result,
          isError: o.result.isError,
          ...(o.result.fileDiffs ? { fileDiffs: o.result.fileDiffs } : {}),
          ...(o.result.images ? { images: o.result.images } : {})
        })
        return
      }
      case 'subagent-started':
        // A resumed child re-links under a newer call: re-assert its ruleset.
        if (entry.children.has(o.childSessionId)) void entry.children.patchChild(o.childSessionId)
        else void entry.children.adoptUnknown(entry.mapper.followedSessions())
        return
      case 'approval':
        this.onTargetApproval(entry, o.approval, o.route)
        return
      case 'approval-resolved': {
        // Answered elsewhere (a cascade, an interrupt, the execution's end):
        // a verdict still being judged replies nothing (ADR-088), the card goes.
        entry.judging.delete(o.requestId)
        const key = XENG_REQUEST_PREFIX + o.requestId
        const pending = this.takePendingApproval(key)
        if (pending) pending.emit('session:approval-dismiss', { requestId: key })
        return
      }
      case 'step-usage':
        if (entry.settled && entry.turnStarted) entry.turnSteps.push(o.usage)
        else this.meterStrayStep(entry, o.usage)
        return
      case 'result':
        this.settleTargetTurn(entry, o.sessionId, { kind: 'done' })
        return
      case 'error':
        this.settleTargetTurn(entry, o.sessionId, { kind: 'failed', message: o.message })
        return
      case 'auth-required':
        // §5 rule 3: refresh and rotate now (the vault decides whether it is ours).
        opencodeAuthHooks().authFailed(o.vendorId)
        this.settleTargetTurn(entry, o.sessionId, {
          kind: 'failed',
          message:
            `Authentication required for "${o.vendorId}": ${o.message}` +
            ' — re-authorize in Settings › Vendors.'
        })
        return
      case 'stopped':
        // Not ours (our own give-ups drop the resolver first): another client
        // interrupted it, or opencode ended it.
        this.settleTargetTurn(entry, o.sessionId, {
          kind: 'failed',
          message: `the dispatched turn was stopped (${o.reason})`
        })
        return
      default:
        return
    }
  }

  /** THIS turn's prompt was delivered (promoted into an execution): the turn has started. */
  private markTurnDelivered(entry: OpencodeTargetEntry, inboxID: string): void {
    if (entry.busy && !entry.draining && inboxID === entry.turnInboxId) entry.turnStarted = true
  }

  /** Settle the turn in flight on its own session's end — only after THIS turn started. */
  private settleTargetTurn(
    entry: OpencodeTargetEntry,
    sessionId: string,
    outcome: OpencodeTurnOutcome
  ): void {
    if (sessionId !== entry.sessionId || !entry.turnStarted) return
    const settle = entry.settled
    entry.settled = null
    settle?.(outcome)
  }

  /** The target's own assistant message: the turn's text source and the judge's trajectory. */
  private noteTargetMessage(entry: OpencodeTargetEntry, message: ChatMessage): void {
    // ADR-088 D1 — whether or not the card streams.
    recordTrajectoryMessage(entry.trajectory, message)
    if (entry.busy && entry.turnStarted) entry.turnMessages.set(message.id, message)
  }

  // ── Approvals (the host ladder, then the judge or a card) ─────────────────

  /**
   * One ask of the target or a task child. In order: a form is cancelled
   * (nobody can answer it; `question` is hidden from targets, so this is a
   * backstop); a child's ask its own agent denies is refused (S6 backstop);
   * the host pre-check (`host-precheck.ts`, the session's ladder: the user's
   * deny rules, plan mode, the user's ask rules) — a deny rule or plan mode
   * refuses, an ask rule goes to the human in every mode; else ClaudeUI's
   * judge under a judged auto parent (ADR-088), else a card on the
   * dispatching chat. Every reject and cancel carries a message (ADR-097 §3).
   */
  private onTargetApproval(
    entry: OpencodeTargetEntry,
    approval: PendingApproval,
    route: OpencodeApprovalRoute
  ): void {
    if (route.form) {
      this.cancelTargetForm(entry.client, route.sessionID, route.form.formID)
      return
    }
    const reply = (reply: PermissionReply): void =>
      replyTargetPermission(entry.client, route.sessionID, approval.requestId, reply)
    // No turn of the dispatcher's is running (a woken execution, a give-up
    // winding down): nobody may answer — refused, never judged or carded.
    if (!entry.busy || entry.draining) {
      logger.info(
        'CrossEngineDispatcher',
        `opencode target ${entry.sessionId}: ${approval.toolName} asked with no turn running — refused`
      )
      reply({ decision: 'reject', message: TARGET_NOT_RUNNING_MESSAGE })
      return
    }
    if (approval.subagent) {
      const refusal = entry.children.refusal(approval, route.sessionID)
      if (refusal !== undefined) {
        reply({ decision: 'reject', message: refusal })
        return
      }
    }
    const verdict = hostPrecheck(approval, this.targetPrecheckContext(entry))
    switch (verdict.kind) {
      case 'deny':
        // No command text on an info line (ADR-084 logging rule).
        logger.info(
          'CrossEngineDispatcher',
          `opencode target: permission rule deny ${approval.toolName} — ${verdict.rule}`
        )
        reply({ decision: 'reject', message: `Denied by permission rule: ${verdict.rule}` })
        return
      case 'plan-refuse':
        logger.info(
          'CrossEngineDispatcher',
          `opencode target: plan mode refused ${approval.toolName}`
        )
        reply({ decision: 'reject', message: PLAN_MODE_DENY_REASON_NO_EXIT_TOOL })
        return
      case 'user-ask':
        if (entry.judge.autoModeActive(liveMode(entry.ctx)))
          logger.info(
            'CrossEngineDispatcher',
            `opencode target: auto-mode → human: user ask rule matches ${approval.toolName}`
          )
        this.forwardOpencodeTargetAsk(entry, approval, route)
        return
      case 'session-allow':
      case 'allow-rule':
        // Unreachable for a target (no allows, no session allows); answered as the verdict says.
        reply({ decision: 'once' })
        return
      case 'continue':
        break
    }
    if (entry.judge.autoModeActive(liveMode(entry.ctx))) {
      void this.judgeOpencodeTargetAsk(entry, approval, route)
      return
    }
    this.forwardOpencodeTargetAsk(entry, approval, route)
  }

  /** The host pre-check over a target: the user's deny/ask tiers only, no session allows. */
  private targetPrecheckContext(entry: OpencodeTargetEntry): HostPrecheckContext {
    const rules = this.userDenyAsk(entry.cwd, entry.ctx.callerRestriction)
    return {
      mode: liveMode(entry.ctx),
      rules: { deny: rules.deny, ask: rules.ask, allow: [] },
      userRules: entry.hostRules,
      sessionAllows: NO_SESSION_ALLOWS,
      cwd: entry.cwd,
      // Targets get no additional directories (ADR-033, as `userDenyAsk` says).
      additionalDirectories: [],
      onError: (err) =>
        logger.warn(
          'CrossEngineDispatcher',
          `opencode target: host pre-check failed — asking the human: ${errText(err)}`
        )
    }
  }

  /** Cancel a target's form WITH a message (a messageless cancel ends the turn). */
  private cancelTargetForm(client: DispatchTargetClient, sessionID: string, formID: string): void {
    try {
      void client.cancelForm(sessionID, formID, TARGET_FORM_CANCEL_MESSAGE).catch((err) => {
        logger.warn('CrossEngineDispatcher', `opencode target: form cancel failed: ${errText(err)}`)
      })
    } catch (err) {
      logger.warn('CrossEngineDispatcher', `opencode target: form cancel refused: ${errText(err)}`)
    }
  }

  /**
   * An opencode target's ask to the human: a card on the dispatching chat.
   *
   * `toolUseId` is the TARGET-side tool call this ask belongs to. The target's
   * stream is replayed on the dispatching client under the dispatch tool card,
   * so this id is the one the nested tool block there carries — binding it lets
   * the approval render INLINE on that block instead of only floating (both
   * surfaces share `requestId`). Absent for a non-tool-scoped ask; never
   * invent one. `decisionReason` is auto mode's denial-cap sentence when the
   * judge handed the call back (ADR-088), or the judge's deny text on a held
   * block. `block` makes it a held judge block (ADR-091 §3) — the deny text a
   * kept block answers with, and the hold window; a kept block is annotated on
   * the id the judge was given (the call id, else the request id).
   */
  private forwardOpencodeTargetAsk(
    entry: OpencodeTargetEntry,
    approval: PendingApproval,
    route: OpencodeApprovalRoute,
    decisionReason?: string,
    block?: { reason: string; ms: number }
  ): void {
    const requestId = XENG_REQUEST_PREFIX + approval.requestId
    const held = block
      ? this.armForwardedHold(
          requestId,
          entry.ctx,
          entry.judge,
          approval.toolUseId ?? approval.requestId,
          block
        )
      : null
    const card: PendingApproval = {
      requestId,
      ...(approval.toolUseId ? { toolUseId: approval.toolUseId } : {}),
      toolName: `dispatch:${approval.toolName}`,
      input: {
        ...(approval.input as Record<string, unknown>),
        ...(approval.patterns ? { patterns: approval.patterns } : {})
      },
      agent: { agentId: entry.sessionId, label: entry.model, subagentType: 'dispatch:opencode' },
      ...(held ? { autoModeBlock: held.autoModeBlock } : {}),
      ...(decisionReason ? { decisionReason } : {})
    }
    this.pendingApprovals.set(requestId, {
      kind: 'opencode',
      permissionId: approval.requestId,
      askingSessionId: route.sessionID,
      // The TARGET's id even for a child's ask, so disposal and the turn
      // watchdog's "parked on a human" check see it.
      targetSessionId: entry.sessionId,
      client: entry.client,
      emit: entry.ctx.emit,
      card,
      ...(held ? { hold: held.hold } : {})
    })
    // The dispatching session's emit puts its own routingId on the wire, so
    // the approval card shows on the dispatching chat with zero renderer changes.
    entry.ctx.emit('session:approval-request', card)
  }

  /**
   * ADR-088 — an opencode target's ask under a judged auto mode: ClaudeUI's
   * judge (the shared pipeline, `DispatchTargetJudge`) decides, the human only
   * when the judge cannot. (A user ask rule never reaches here: the host
   * pre-check sent it to the human — G9.)
   *
   * 1. An edit clear of every agent-control path → `once` (the acceptEdits
   *    auto-allow the auto ruleset asks for so this host check runs, ADR-084 §3).
   * 2. The judge's input is the call's own (2.x publishes `tool.called` before
   *    the ask, so the mapper has it — a child's too); a shell ask without a
   *    command text skips the read-only gate (nothing can vouch for it).
   * 3. allow → `once`; hold → the card as a held block (ADR-091 §3: Keep
   *    blocked / Approve anyway, Keep blocked on expiry); human → the card
   *    (with the denial cap's sentence); settled (the ask was answered
   *    elsewhere, or the target stopped / was disposed meanwhile) → nothing.
   */
  private async judgeOpencodeTargetAsk(
    entry: OpencodeTargetEntry,
    approval: PendingApproval,
    route: OpencodeApprovalRoute
  ): Promise<void> {
    const id = approval.requestId
    const permission = approval.toolName
    const input = { ...(approval.input as Record<string, unknown>) }
    const reply = (reply: PermissionReply): void =>
      replyTargetPermission(entry.client, route.sessionID, id, reply)

    if (permission === 'edit' && editClearsAgentControl(approval.patterns, input, entry.cwd)) {
      logger.info(
        'CrossEngineDispatcher',
        'opencode target: edit clear of agent-control paths — allowed'
      )
      reply({ decision: 'once' })
      return
    }

    const toolUseId = approval.toolUseId ?? id
    entry.judging.add(id)
    let outcome: Awaited<ReturnType<DispatchTargetJudge['judge']>>
    // The X-Agent's message to its dispatcher is the target's own action, judged as the
    // agent-authored message to the spawning agent it is (ADR-105 §4).
    const isMessage = permission === SESSION_MESSAGE_RULE_ACTION && entry.canMessage
    try {
      outcome = await entry.judge.judge(
        { toolUseId, toolName: permission, input, ...(isMessage ? { agentMessage: true } : {}) },
        {
          currentMode: () => liveMode(entry.ctx),
          stillPending: () => entry.judging.has(id) && this.targets.get(entry.sessionId) === entry,
          honoursWorkdir: true,
          ...(typeof input.command === 'string' ? {} : { skipReadOnlyGate: true }),
          permissions: () => this.userDenyAsk(entry.cwd, entry.ctx.callerRestriction)
        }
      )
    } finally {
      entry.judging.delete(id)
    }
    switch (outcome.kind) {
      case 'allow':
        reply({ decision: 'once' })
        return
      case 'hold': {
        // ADR-091 part 6 — recorded at the dispatching session; with no hold
        // window it is kept at once, through the Keep blocked path.
        const ms = blockHoldMs()
        // An opencode target takes no delivery: the nudge goes to the
        // dispatching agent.
        recordTargetBlock(entry.ctx, toolUseId, permission, input, outcome.review, {
          engine: 'opencode',
          label: entry.model,
          cwd: entry.cwd,
          xAgentRef: entry.ledgerId,
          held: ms > 0
        })
        if (ms === 0) {
          reply({
            decision: 'reject',
            message: keepTargetBlock(entry.judge, toolUseId, outcome.reason)
          })
          return
        }
        this.forwardOpencodeTargetAsk(entry, approval, route, outcome.reason, {
          reason: outcome.reason,
          ms
        })
        return
      }
      case 'human':
        this.forwardOpencodeTargetAsk(entry, approval, route, outcome.reason)
        return
      case 'settled':
        return
    }
  }

  // ── The dispatch card's item streams (the target's own items) ─────────────

  private openOpencodeTargetItem(entry: OpencodeTargetEntry, open: ItemStreamOpen): void {
    this.noteTargetMessage(entry, open.message)
    const owner = streamOwner(entry)
    if (!owner) return
    const target: ItemStreamTarget = { ...open.target, ownerToolUseId: owner }
    entry.openItems.set(targetItemKey(target), { target, message: structuredClone(open.message) })
    entry.ctx.emit('session:item-open', { ...open, target })
  }

  private appendOpencodeTargetItem(
    entry: OpencodeTargetEntry,
    target: ItemStreamTarget,
    chunk: string
  ): void {
    const open = entry.openItems.get(targetItemKey(target))
    if (!open || !streamOwner(entry)) return
    const block = open.message.content[target.blockIndex]
    if (block && (block.type === 'text' || block.type === 'thinking')) block.text += chunk
    entry.ctx.emit('session:item-delta', { target: open.target, chunk })
  }

  private sealOpencodeTargetItem(entry: OpencodeTargetEntry, seal: ItemStreamSeal): void {
    this.noteTargetMessage(entry, seal.message)
    const owner = streamOwner(entry)
    if (!owner) return
    if (seal.target) {
      const key = targetItemKey(seal.target)
      const target = entry.openItems.get(key)?.target ?? { ...seal.target, ownerToolUseId: owner }
      entry.openItems.delete(key)
      entry.ctx.emit('session:item-seal', { ...seal, target, ownerToolUseId: owner })
      return
    }
    for (const [key, open] of entry.openItems)
      if (open.target.messageId === seal.message.id) entry.openItems.delete(key)
    entry.ctx.emit('session:item-seal', { ...seal, ownerToolUseId: owner })
  }

  /** Seal every item still open on the card with what streamed so far (the turn returned). */
  private sealOpencodeTargetItems(entry: OpencodeTargetEntry): void {
    for (const { target, message } of entry.openItems.values())
      entry.ctx.emit('session:item-seal', {
        target,
        message,
        ownerToolUseId: target.ownerToolUseId
      })
    entry.openItems.clear()
  }

  // ── Claude direction (M2) ─────────────────────────────────────────────────

  /** Everything past the guards for engine:'claude' — runs with an
   *  a run slot held and the Stop handle already registered
   *  (the run, with its `stopController`, is registered in `launchRun`, BEFORE any
   *  await, so a Stop click during spawnClaudeQuery is not lost). */
  private async resolveAndRunClaude(
    req: DispatchRequest,
    ctx: RunContext,
    stopController: AbortController
  ): Promise<DispatchResult> {
    // ── Model resolution ──────────────────────────────────────────────────
    const dispatchCfg = this.deps.loadEngineConfig('claude').dispatch
    const requestedModel = req.model ?? dispatchCfg?.defaultModel
    if (!requestedModel) {
      return errorResult(
        'No model is configured for cross-engine dispatch into Claude. Ask the user to set ' +
          'Settings › Cross-engine dispatch › Dispatch into › Claude (the `dispatch.defaultModel` field in ' +
          '~/.claude/ui/engines/claude.json), or pass `model` explicitly.'
      )
    }
    const allowed = dispatchCfg?.allowedModels
    if (allowed && allowed.length > 0 && !allowed.includes(requestedModel)) {
      return errorResult(
        `Model "${requestedModel}" is not in the user-configured allowlist for Claude dispatch. ` +
          `Allowed models: ${allowed.join(', ')}`
      )
    }
    // A target resumed from its ledger row runs (and is recorded) under the model it
    // was created with, as a live one does; the request's only gates the allowlist.
    let model: string = requestedModel

    // ── Target resolution ─────────────────────────────────────────────────
    let entry: ClaudeTargetEntry
    if (req.sessionId) {
      const cont = this.findContinuation(req.sessionId, ctx, 'claude')
      if (!cont) {
        return errorResult(
          `Unknown dispatch session "${req.sessionId}" — it may have been disposed. ` +
            'Start a new X-Agent with dispatch_agent.'
        )
      }
      // Busy-reject BEFORE pushing a prompt or touching entry state (see the
      // `busy` doc comment on ClaudeTargetEntry). The running turn is left
      // completely undisturbed — no abort, no entry removal, no ctx swap.
      if ('live' in cont && cont.live.busy) {
        return errorResult(
          `Dispatch session "${req.sessionId}" is already running a turn — wait for it to finish before continuing it.`,
          req.sessionId
        )
      }
      // ADR-033 M4-C: reject a continuation turn once this target's tracked
      // cumulative cost has met/exceeded the configured cap (same semantics
      // as the opencode direction above). A brand-new target always starts at
      // cumulativeCostUsd 0; one rebuilt from its ledger row, at what its
      // recorded turns cost.
      const spent = this.continuationSpend(cont, dispatchCfg, req.sessionId, 'claude')
      if ('text' in spent) return spent
      const spentUsd = spent.costUsd
      if ('row' in cont) {
        const refusal = this.resumeModelRefusal('claude', cont.row.model, dispatchCfg)
        if (refusal) return refusal
      }
      if ('live' in cont) {
        this.bindContinuation(ctx, cont)
        cont.live.ctx = ctx
        entry = cont.live
        // ADR-088 ruling 3 — the parent's mode is read live: bring the process
        // to it before the turn's prompt is pushed. The run is bound (a background launch
        // is acknowledged) before this await, so the target is busy from here: a second
        // continuation is refused and `disposeFor` cannot release it from under the run.
        entry.busy = true
        try {
          await this.syncClaudeTargetMode(entry)
        } catch (err) {
          entry.busy = false
          throw err
        }
      } else {
        // The process is gone (its parent restarted, or the app did): `--resume` the
        // transcript the ledger row names, in the directory it was created in. A
        // missing transcript (its project was deleted) is a clear end, not a fresh start.
        const { row } = cont
        if (!this.locateTranscript(row.harnessRef, row.cwd)) {
          this.ledgerSet(row.id, { state: 'failed' })
          return errorResult(
            `Dispatch session "${req.sessionId}" cannot be resumed — its transcript no longer exists. ` +
              'Start a new X-Agent with dispatch_agent.',
            req.sessionId
          )
        }
        model = row.model
        const account = claudeDispatchAccount()
        this.bindContinuation(ctx, cont)
        const shell = this.createClaudeTargetShell(ctx, row.id, account, row.cwd)
        entry = shell.entry
        entry.cumulativeCostUsd = spentUsd
        try {
          await this.spawnClaudeTarget(shell, ctx, model, row.cwd, { resume: row.harnessRef })
        } catch (err) {
          // Transient (the transcript was checked above): the row keeps the state it had.
          return errorResult(
            `Failed to resume dispatched Claude agent: ${errText(err)}`,
            req.sessionId
          )
        }
        // A fresh process reads the app's CURRENT credential: the row follows it.
        this.ledgerSet(row.id, { accountKey: account.accountKey })
      }
    } else {
      // The harness id is minted HERE and the ledger row written BEFORE the spawn: the
      // transcript is hidden (ADR-105) from its first byte, so no watcher pass can
      // read it before the readers know to skip it.
      const harnessId = uuidv4()
      const account = claudeDispatchAccount()
      let ledgerId: string | null = null
      try {
        ledgerId = this.recordTarget(ctx, {
          engine: 'claude',
          harnessRef: harnessId,
          model,
          accountKey: account.accountKey,
          labels: req,
          handBack: this.requireHandBack
        }).id
        const shell = this.createClaudeTargetShell(ctx, ledgerId, account, ctx.cwd)
        entry = shell.entry
        await this.spawnClaudeTarget(shell, ctx, model, ctx.cwd, { sessionId: harnessId })
      } catch (err) {
        if (ledgerId) this.ledgerSet(ledgerId, { state: 'failed' })
        return errorResult(`Failed to start dispatched Claude agent: ${errText(err)}`)
      }
    }

    const turn = async (prompt: string | null, nudge: boolean): Promise<TurnReturn> => {
      // Mark busy BEFORE the push: driveClaudeTurn registers the entry in
      // this.targets as soon as session_id arrives (mid-turn), making it
      // continuable — a concurrent same-session_id dispatch must already see
      // busy=true at that point. Cleared in the finally below on EVERY path
      // (success, turn error, timeout, abort) — including the paths that
      // remove the entry, where it's harmless.
      entry.busy = true
      this.ledgerTurnState(entry, 'running')
      // Per-turn distinct tool_use id set (ADR-033 M4-B) — fresh at the start of
      // every turn, populated by forwardClaudeTargetMessage, .size read at turn end.
      entry.turnToolUseIds = new Set()
      const turnStartedAt = this.now()
      entry.lastActivityAt = turnStartedAt
      // `null`: nothing to send — the target's own work woke it, and its next turn is awaited.
      if (prompt !== null) {
        // Named, so cli.js says when it consumed the frame: only the result of the turn that
        // did is this turn's (`driveClaudeTurn`).
        const uuid = uuidv4()
        entry.pushedUuids.add(uuid)
        // A message from the dispatching session is framed as one already (no delegation preamble).
        entry.channel.push(
          buildClaudeDispatchMessage(prompt, entry.sessionId, !nudge && !req.message, uuid)
        )
      }

      // ── Run the turn ──────────────────────────────────────────────────────
      const heartbeat = this.startHeartbeat(ctx)

      const signal = ctx.run.cancelController.signal
      let abortListener: (() => void) | undefined

      type Raced =
        | { kind: 'ok'; msg: ResultMessage | null }
        | { kind: 'err'; err: unknown }
        | TurnTimeout
        | { kind: 'abort' }
        | { kind: 'stop' }

      // Waiting for the turn its own work wakes (`prompt === null`) is bounded: past the
      // ceiling the work is taken to be gone (a stale entry must not park the run).
      const turnPromise: Promise<Raced> = this.driveClaudeTurn(
        entry,
        prompt === null
          ? { wake: true, deadlineAt: this.now() + this.ownWorkWaitMs }
          : { wake: false }
      ).then(
        (msg): Raced => ({ kind: 'ok', msg }),
        (err): Raced => ({ kind: 'err', err })
      )
      // Turn liveness: the TARGET engine's two configured caps, unlimited unless
      // the user set them (ADR-033's 2026-09-18 amendment) — the same watchdog
      // the opencode direction runs, which is why `driveClaudeTurn` bumps
      // `entry.lastActivityAt` on every message it reads off the iterator.
      const caps = resolveTurnLiveness(dispatchCfg)
      const watchdog = this.startTurnWatchdog(entry, caps, turnStartedAt, () =>
        this.hasPendingApprovalFor(entry.sessionId)
      )
      const timeoutPromise: Promise<Raced> = watchdog.promise
      const abortPromise: Promise<Raced> = signal
        ? signal.aborted
          ? Promise.resolve({ kind: 'abort' })
          : new Promise((resolve) => {
              abortListener = (): void => resolve({ kind: 'abort' })
              signal.addEventListener('abort', abortListener, { once: true })
            })
        : new Promise(() => {})
      const stopPromise: Promise<Raced> = stopController.signal.aborted
        ? Promise.resolve({ kind: 'stop' })
        : new Promise((resolve) => {
            stopController.signal.addEventListener('abort', () => resolve({ kind: 'stop' }), {
              once: true
            })
          })

      // How this turn leaves the row. A killed process keeps its transcript, so the target
      // is `interrupted` (resumable); a turn that failed to run is `failed`.
      let endState: DispatchTargetState = 'idle'
      try {
        const winner = await Promise.race([turnPromise, timeoutPromise, abortPromise, stopPromise])

        if (winner.kind === 'timeout' || winner.kind === 'abort' || winner.kind === 'stop') {
          // Unlike opencode (an interrupt stops the turn, session survives),
          // aborting a Claude target's AbortController KILLS THE PROCESS — so the
          // entry goes entirely. Its transcript stays (ADR-105): the NEXT
          // continuation re-spawns it with `--resume`.
          endState = 'interrupted'
          entry.abortController.abort()
          if (entry.sessionId) {
            this.dismissPendingForTarget(entry.sessionId)
            this.targets.delete(entry.sessionId)
          }
          const text =
            winner.kind === 'timeout'
              ? turnTimeoutText(winner.reason, caps, CLAUDE_TIMEOUT_AFTERMATH)
              : winner.kind === 'stop'
                ? 'Dispatch stopped by user.'
                : 'Dispatch cancelled.'
          const status = winner.kind === 'timeout' ? 'failed' : 'stopped'
          ctx.run.timedOut = winner.kind === 'timeout'
          emitDispatchNotification(ctx, entry.sessionId ?? '', status, text)
          // Recorded for 'failed' (timeout) only — 'stopped' (abort/user-stop)
          // is never recorded (ADR-033 M4-B: no usage numbers exist for a turn
          // that never returned a result).
          if (status === 'failed') {
            this.safeRecordUsage({
              ts: this.now(),
              fromRoutingId: ctx.fromRoutingId,
              targetEngine: 'claude',
              targetModel: model,
              targetSessionId: entry.sessionId,
              toolUseId: ctx.toolUseId ?? null,
              account: entry.account,
              engineCostIsEquivalent: true
            })
          }
          return errorResult(text, entry.sessionId ?? '')
        }
        if (winner.kind === 'err') {
          endState = 'failed'
          entry.abortController.abort()
          if (entry.sessionId) {
            this.dismissPendingForTarget(entry.sessionId)
            this.targets.delete(entry.sessionId)
          }
          const msg = winner.err instanceof Error ? winner.err.message : String(winner.err)
          emitDispatchNotification(
            ctx,
            entry.sessionId ?? '',
            'failed',
            `Dispatched turn failed: ${msg}`
          )
          this.safeRecordUsage({
            ts: this.now(),
            fromRoutingId: ctx.fromRoutingId,
            targetEngine: 'claude',
            targetModel: model,
            targetSessionId: entry.sessionId,
            toolUseId: ctx.toolUseId ?? null,
            account: entry.account,
            engineCostIsEquivalent: true
          })
          return errorResult(`Dispatched turn failed: ${msg}`, entry.sessionId ?? '')
        }

        const result = winner.msg
        if (result === null) {
          // The wait for the turn its own work was to wake ran out: forget that work, and let
          // the loop nudge (or withhold) as if it had never been there.
          entry.ownTasks.clear()
          entry.pendingWake.clear()
          return { text: '', sessionId: entry.sessionId ?? '', needsReport: true }
        }
        // ── Usage capture (ADR-033 M4-B) ────────────────────────────────────
        // VERIFIED WIRE FACT: `result.total_cost_usd` (and `modelUsage`) are
        // CUMULATIVE within one cli.js process; only `usage` and `duration_ms`
        // are per-turn (see claude-session.ts's costBaseUsd/liveTotalCostUsd
        // doc — the naive `+=` over the running total was exactly Slice B's
        // double-count bug). The dispatched target is a persistent process
        // serving multiple turns, so convert the running total into a per-turn
        // delta against the entry's baseline HERE, at the single point the
        // result is received — the failed-subtype capture, cap accumulation,
        // DB record, and Slice C fold-in below all consume the same delta.
        // Math.max(0, …) guards against a pathological backwards total.
        const usageFields = result.usage as
          | {
              input_tokens?: number
              output_tokens?: number
              cache_creation_input_tokens?: number
              cache_read_input_tokens?: number
              cache_creation?: { ephemeral_1h_input_tokens?: number }
            }
          | undefined
        const totalTokens = usageFields
          ? (usageFields.input_tokens ?? 0) + (usageFields.output_tokens ?? 0)
          : 0
        // The LEDGER's split (ADR-071 §1). Anthropic's `usage` is disjoint —
        // `input_tokens` already excludes both cache figures — so the fields map
        // straight onto the ledger's shape. `totalTokens` above deliberately
        // stays input+output: it is what the task notification shows.
        //
        // `cache_creation.ephemeral_1h_input_tokens` is the 1h-TTL SUBSET of
        // `cache_creation_input_tokens`, billed at 2× input rather than 1.25×;
        // block-usage reads it off the transcripts for exactly this reason, and
        // dropping it here would underprice every dispatched Claude turn that
        // used the 1h cache. An older cli.js omits the breakdown, which the
        // recorder reads as all-5m — the same fallback block-usage makes.
        const turnTokens: UsageTurnTokens = {
          input: usageFields?.input_tokens ?? 0,
          output: usageFields?.output_tokens ?? 0,
          cacheWrite: usageFields?.cache_creation_input_tokens ?? 0,
          cacheWrite1h: usageFields?.cache_creation?.ephemeral_1h_input_tokens ?? 0,
          cacheRead: usageFields?.cache_read_input_tokens ?? 0
        }
        const reportedTotalCostUsd = result.total_cost_usd ?? entry.lastReportedTotalCostUsd
        const turnCostUsd = Math.max(0, reportedTotalCostUsd - entry.lastReportedTotalCostUsd)
        entry.lastReportedTotalCostUsd = reportedTotalCostUsd
        const durationMs = result.duration_ms ?? null

        // A turn-level error (see docs/protocol-cc/03-inbound-messages.md §result
        // subtypes) does NOT kill the process — the target stays alive for
        // continuation, parity with the opencode info.error handling above.
        // (After a report the turn was interrupted, which cli.js ends with an error result.)
        if (result.subtype && result.subtype !== 'success' && !ctx.run.report) {
          const detail =
            (result.errors && result.errors.length > 0 && result.errors.join('; ')) ||
            result.subtype ||
            'the dispatched agent reported an error'
          emitDispatchNotification(
            ctx,
            entry.sessionId ?? '',
            'failed',
            `Dispatched turn failed: ${detail}`
          )
          // Best-effort: a failed-subtype result still carries real cost/usage
          // fields (the turn ran, it just didn't finish cleanly) — capture them
          // rather than fabricate nulls.
          this.safeRecordUsage({
            ts: this.now(),
            fromRoutingId: ctx.fromRoutingId,
            targetEngine: 'claude',
            targetModel: model,
            targetSessionId: entry.sessionId,
            toolUseId: ctx.toolUseId ?? null,
            tokens: turnTokens,
            engineCostUsd: turnCostUsd,
            account: entry.account,
            // cli.js's `total_cost_usd` is an API-EQUIVALENT whatever plan is
            // behind it (ADR-034), so the ledger must not read it as a bill.
            engineCostIsEquivalent: true
          })
          // Slice C — fold-in parity with the DB record above: this row IS
          // included by seedDispatchedCosts() on reload, so the live breakdown
          // must include it too or live vs reloaded values disagree.
          if (Number.isFinite(turnCostUsd) && turnCostUsd > 0) {
            ctx.addDispatchedCost?.('claude', model, turnCostUsd)
          }
          // The cap is a SPEND limit, not a success limit (ADR-034): a failed
          // turn burned real tokens, so it counts toward maxCostUsd like any
          // other — otherwise a dispatch session whose turns keep erroring
          // could spend past the cap without ever tripping it. (The crossing
          // note is only appended on success turns; a failed turn that crosses
          // simply causes the NEXT turn to be rejected by the cap check.)
          entry.cumulativeCostUsd += turnCostUsd
          return errorResult(`Dispatched turn failed: ${detail}`, entry.sessionId ?? '')
        }
        const finalText = result.result || '(the dispatched agent returned no text)'

        // ── Cost cap crossing note (ADR-033 M4-C) ───────────────────────────
        const maxCostUsd = dispatchCfg?.maxCostUsd
        const wasUnderCap = maxCostUsd === undefined || entry.cumulativeCostUsd < maxCostUsd
        entry.cumulativeCostUsd += turnCostUsd
        let outText = finalText
        if (maxCostUsd !== undefined && wasUnderCap && entry.cumulativeCostUsd >= maxCostUsd) {
          outText +=
            '\n\n[dispatch cost cap reached — further turns on this session will be rejected]'
        }

        // ── Fold into the dispatching session's own cost breakdown (Slice C) ──
        if (Number.isFinite(turnCostUsd) && turnCostUsd > 0) {
          ctx.addDispatchedCost?.('claude', model, turnCostUsd)
        }

        await this.settleReview(ctx.run)
        const done = this.finishTurn(ctx, 'claude', model, entry, entry.sessionId ?? '', {
          finalText,
          outText,
          usage: {
            totalTokens,
            toolUses: entry.turnToolUseIds.size,
            durationMs: durationMs ?? 0
          }
        })
        this.safeRecordUsage({
          ts: this.now(),
          fromRoutingId: ctx.fromRoutingId,
          targetEngine: 'claude',
          targetModel: model,
          targetSessionId: entry.sessionId,
          toolUseId: ctx.toolUseId ?? null,
          tokens: turnTokens,
          engineCostUsd: turnCostUsd,
          account: entry.account,
          engineCostIsEquivalent: true
        })
        return done
      } finally {
        entry.itemStreams.sealAll()
        entry.busy = false
        this.ledgerTurnState(entry, endState)
        clearInterval(heartbeat)
        watchdog.dispose()
        if (signal && abortListener) signal.removeEventListener('abort', abortListener)
      }
    }
    return this.runWithNudges(
      ctx,
      {
        sessionId: () => entry.sessionId ?? '',
        engine: 'claude',
        toolName: CLAUDE_HAND_BACK_TOOL,
        cumulativeCostUsd: () => entry.cumulativeCostUsd,
        waitingOnOwnWork: () => this.claudeWaitsOnOwnWork(entry)
      },
      this.taskText(entry, ctx, req.prompt, CLAUDE_HAND_BACK_TOOL),
      turn
    )
  }

  /**
   * Read messages from the target's ONE iterator until `result` arrives,
   * capturing session_id (and registering the entry in `this.targets`) the
   * first time it's seen. NEVER uses `for await` — see the `.return()`
   * hazard documented on `ClaudeTargetEntry`.
   *
   * cli.js writes results that are not the turn we asked for, and a run must not count them
   * (ADR-105 §3): the zero-turn pointer result of a hand-back notification is skipped; and so
   * is any result before cli.js has reported one of OUR frames `started` (`command_lifecycle`,
   * named by the uuid the frame carried: 03 §3.21) — a stray turn an earlier run's work
   * started, or a notification's turn that ends before our prompt is drained. A result AFTER
   * that `started` is ours even when a notification led the turn and our prompt was folded
   * into it. A read that waits for the turn own work wakes (`wake`) takes the next result.
   * `deadlineAt` bounds a wait: past it nothing was read and `null` comes back (the pending
   * `next()` is kept, no frame is lost).
   */
  private async driveClaudeTurn(
    entry: ClaudeTargetEntry,
    opts: { wake?: boolean; deadlineAt?: number } = {}
  ): Promise<ResultMessage | null> {
    for (;;) {
      const pending = (entry.nextFrame ??= entry.iterator.next())
      let read: IteratorResult<SDKMessage> | undefined
      try {
        read =
          opts.deadlineAt === undefined
            ? await pending
            : await settledWithin(pending, Math.max(0, opts.deadlineAt - this.now()))
      } catch (err) {
        entry.nextFrame = null
        throw err
      }
      if (read === undefined) return null
      entry.nextFrame = null
      const { value, done } = read
      if (done) {
        throw new Error('Claude target process ended unexpectedly')
      }
      const msg = value as SDKMessage
      // Proof of life for the inactivity watchdog — EVERY message counts,
      // `stream_event` deltas included (see ClaudeTargetEntry.lastActivityAt).
      entry.lastActivityAt = this.now()
      if (msg.session_id && !entry.sessionId) {
        entry.sessionId = msg.session_id
        this.targets.set(msg.session_id, entry)
        // The model continues this target by the id it is told — init's. The row is
        // looked up by it, so it must answer to it (it already does when cli.js
        // honoured `--session-id` / `--resume`, which it does).
        try {
          if (this.ledger.get(entry.ledgerId)?.harnessRef !== msg.session_id)
            this.ledgerSet(entry.ledgerId, { harnessRef: msg.session_id })
        } catch (err) {
          logger.warn('CrossEngineDispatcher', `dispatch ledger read failed: ${errText(err)}`)
        }
      }
      this.forwardClaudeTargetMessage(entry, msg)
      this.trackClaudeHandBack(entry, msg)
      if (msg.type === 'command_lifecycle') {
        this.trackClaudeLifecycle(entry, msg)
        continue
      }
      if (msg.type === 'result') {
        const result = msg as ResultMessage
        if (isHandbackPointerResult(result)) continue
        // Not ours: no frame of ours has been consumed into the turn this result ends.
        if (!opts.wake && entry.ctx.run.handBackRequired && !entry.ownTurnStarted) continue
        if (!opts.wake) entry.ownTurnStarted = false
        return result
      }
    }
  }

  /**
   * What cli.js says became of one of our frames (03 §3.21): `started` — it was drained into a
   * turn, so the result that ends that turn is ours; refused, discarded, or cancelled before it
   * started — it never will be, so the turn fails instead of waiting for a result that is not
   * coming. Frames named by other uuids (cli.js's own queue) are none of ours.
   */
  private trackClaudeLifecycle(entry: ClaudeTargetEntry, msg: SDKMessage): void {
    const frame = msg as unknown as { command_uuid?: string; state?: string }
    if (!frame.command_uuid || !entry.pushedUuids.has(frame.command_uuid)) return
    if (frame.state === 'started') {
      entry.pushedUuids.delete(frame.command_uuid)
      entry.ownTurnStarted = true
    } else if (
      frame.state === 'refused' ||
      frame.state === 'discarded' ||
      frame.state === 'cancelled'
    ) {
      entry.pushedUuids.delete(frame.command_uuid)
      throw new Error(`the Claude target did not take the message (${frame.state})`)
    }
  }

  /** Does the target have own work whose end will start a turn of its own? Stale entries are forgotten. */
  private claudeWaitsOnOwnWork(entry: ClaudeTargetEntry): boolean {
    const cutoff = this.now() - this.ownWorkWaitMs
    for (const tasks of [entry.ownTasks, entry.pendingWake])
      for (const [id, since] of tasks) if (since < cutoff) tasks.delete(id)
    return entry.ownTasks.size + entry.pendingWake.size > 0
  }

  /**
   * Two things a Claude target's stream tells the run about its report (ADR-105 §3).
   *
   *  - Its own background work: a (backgrounded) task of a waking kind — an agent or workflow
   *    of its own — will wake it again, so a turn that ends meanwhile is waited out rather
   *    than nudged. When such a task ends it moves to `pendingWake` until the next
   *    main-agent model round starts (`system/status requesting`): cli.js starts a turn of its
   *    own to tell the model, and that turn can begin AFTER the one we are reading ended.
   *    A task that was killed or stopped is simply dropped (nothing was promised).
   *  - The end of the turn after the report: the `hand_back` call's tool_result is the frame
   *    that says the agent has been told it is done, so that is when the turn is
   *    interrupted (an interrupt inside the handler would cancel the call itself). The
   *    process survives the interrupt; its turn ends with an `error_during_execution`
   *    result that `resolveAndRunClaude` reads as the end it is.
   */
  private trackClaudeHandBack(entry: ClaudeTargetEntry, msg: SDKMessage): void {
    if (msg.type === 'system') {
      const task = msg as unknown as {
        subtype?: string
        status?: string
        task_id?: string
        task_type?: string
        is_backgrounded?: boolean
        parent_tool_use_id?: string | null
        agent_id?: string
        patch?: { status?: string }
      }
      if (task.subtype === 'status') {
        if (task.status === 'requesting' && !task.parent_tool_use_id && !task.agent_id)
          entry.pendingWake.clear()
        return
      }
      if (task.subtype === 'permission_denied') {
        this.takeBlockedClaudeReport(entry, msg as unknown as Record<string, unknown>)
        return
      }
      if (!task.task_id) return
      const ended = (status: string | undefined): void => {
        if (!status || !TERMINAL_TASK_STATUSES.has(status)) return
        const was = entry.ownTasks.delete(task.task_id!)
        if (status === 'killed' || status === 'stopped') entry.pendingWake.delete(task.task_id!)
        else if (was || entry.pendingWake.has(task.task_id!))
          entry.pendingWake.set(task.task_id!, this.now())
      }
      if (task.subtype === 'task_started') {
        if (CLAUDE_OWN_WORK_TASK_TYPES.has(task.task_type ?? '') && task.is_backgrounded !== false)
          entry.ownTasks.set(task.task_id, this.now())
      } else if (task.subtype === 'task_notification') ended(task.status)
      else if (task.subtype === 'task_updated') ended(task.patch?.status)
      return
    }
    if (msg.type === 'assistant') {
      this.noteClaudeHandBackCalls(entry, msg)
      return
    }
    const report = entry.ctx.run.report
    if (!report || entry.interruptedReport === report || msg.type !== 'user') return
    const content = (msg as { message?: { content?: unknown } }).message?.content
    if (!Array.isArray(content)) return
    const answered = (content as Array<Record<string, unknown>>).some(
      (block) =>
        block?.type === 'tool_result' &&
        (report.callId === undefined || block.tool_use_id === report.callId)
    )
    if (!answered) return
    entry.interruptedReport = report
    void entry.query.interrupt().catch((err: unknown) => {
      logger.warn('CrossEngineDispatcher', `could not end the turn after a report: ${errText(err)}`)
    })
  }

  /** Remember the `report` of the X-Agent's own `hand_back` calls as the stream announces them (for a blocked one). */
  private noteClaudeHandBackCalls(entry: ClaudeTargetEntry, msg: SDKMessage): void {
    const frame = msg as unknown as {
      parent_tool_use_id?: string | null
      agent_id?: string
      message?: { content?: unknown }
    }
    if (frame.parent_tool_use_id || frame.agent_id || !Array.isArray(frame.message?.content)) return
    for (const block of frame.message.content as Array<Record<string, unknown>>) {
      if (block?.type !== 'tool_use' || block.name !== CLAUDE_HAND_BACK_TOOL) continue
      const input = block.input as { report?: unknown } | undefined
      if (typeof block.id !== 'string' || typeof input?.report !== 'string') continue
      entry.handBackCalls.set(block.id, input.report)
      if (entry.handBackCalls.size > 8)
        entry.handBackCalls.delete(entry.handBackCalls.keys().next().value as string)
    }
  }

  /**
   * Claude Code's own classifier BLOCKED the X-Agent's `hand_back` call (auto mode; the call never
   * reaches its handler, and the model is told it was denied). The report is a flag, never a block
   * (ADR-105 §3, slice B-3c): it is taken from the `report` the announcing assistant frame carried,
   * accepted as the run's report with the classifier's verdict as its review, and the turn is ended
   * when the call's tool_result goes by (`trackClaudeHandBack`), so the X-Agent is not left to argue
   * with the denial. Only the X-Agent's own call and only a classifier decision count: a rule's
   * denial of the tool, or a subagent's call, takes nothing.
   */
  private takeBlockedClaudeReport(entry: ClaudeTargetEntry, msg: Record<string, unknown>): void {
    const frame = readPermissionDecisionFrame(msg)
    if (!frame || frame.agentId) return
    const report = entry.handBackCalls.get(frame.toolUseId)
    if (report === undefined || entry.toolUseOwners.ownerNow(frame.toolUseId) !== 'root') return
    const review = handBackReviewOf(
      frame,
      typeof msg.message === 'string' ? msg.message : undefined
    )
    if (!review) return
    const answer = this.receiveHandBack(entry, report, frame.toolUseId, review)
    if (answer.isError)
      logger.info('CrossEngineDispatcher', `blocked hand_back report not taken: ${answer.text}`)
  }

  /**
   * Forward a Claude dispatch target's live turn output as engine-neutral
   * subagent events (ADR-033 M3), keyed by the CURRENT dispatching tool_use
   * id (`entry.ctx.toolUseId` — refreshed on every continuation call, so a
   * mid-turn message always lands on whichever call is actively driving it).
   * Emits nothing when the id is unset — never fail a dispatch over it.
   *
   * `includePartialMessages: true` (set in `defaultSpawnClaudeQuery`) makes
   * cli.js emit `stream_event` deltas exactly like a native subagent's
   * `parent_tool_use_id`-routed frames (claude-session.ts's
   * `handleStreamEvent`) — this mirrors that mapping, just re-keyed: an
   * agent_id-only frame resolves through `entry.agentOrigins` to the same lane
   * key its snapshots use, and one no task_started placed is dropped. A
   * SendMessage-resumed run's frames and snapshots both resolve through
   * `entry.agentRunAliases` onto the agent's origin.
   */
  private forwardClaudeTargetMessage(entry: ClaudeTargetEntry, msg: SDKMessage): void {
    // Learned whether or not a card is listening: it is the target's own
    // identity, and a later turn's card needs it.
    if (msg.type === 'system' && msg.subtype === 'task_started') {
      if (msg.task_id && msg.tool_use_id) {
        const origin = entry.agentOrigins.get(msg.task_id)
        if (origin === undefined) entry.agentOrigins.set(msg.task_id, msg.tool_use_id)
        else if (origin !== msg.tool_use_id) entry.agentRunAliases.set(msg.tool_use_id, origin)
      }
      return
    }
    const runOwner = (id: string | undefined): string | undefined =>
      id === undefined ? id : (entry.agentRunAliases.get(id) ?? id)

    const toolUseId = entry.ctx.toolUseId
    if (!toolUseId) return

    if (msg.type === 'stream_event') {
      if (!msg.event) return
      const owner = streamEventParent(msg, (agentId) => entry.agentOrigins.get(agentId))
      if (owner !== null) entry.itemStreams.handleEvent(msg.event, runOwner(owner))
      return
    }

    if (msg.type === 'assistant') {
      const chatMsg = transformAssistantMessage(msg as unknown as Record<string, unknown>)
      if (chatMsg) {
        collectToolUseIds(chatMsg, entry.turnToolUseIds)
        const nativeOwner = runOwner(
          (msg as unknown as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? undefined
        )
        if (entry.itemStreams.handleSnapshot(chatMsg, nativeOwner) === 'none')
          entry.ctx.emit('session:subagent-message', { toolUseId, message: chatMsg })
      }
      return
    }

    if (msg.type === 'user') {
      // Tool-result mirror of claude-session.ts's extractToolResultsFromContent
      // (parentToolUseId branch) — cheap to forward alongside the message.
      const messageParam = (msg as { message?: { content?: unknown } }).message
      const content = messageParam?.content
      if (!Array.isArray(content)) return
      for (const block of content as Array<Record<string, unknown>>) {
        if (!block || block.type !== 'tool_result') continue
        const toolResultToolUseId = block.tool_use_id as string | undefined
        if (!toolResultToolUseId) continue
        const { text: resultText, images } = extractToolResultContent(block.content)
        entry.ctx.emit('session:subagent-tool-result', {
          toolUseId,
          toolResultToolUseId,
          result: resultText,
          isError: !!block.is_error,
          ...(images ? { images } : {})
        })
      }
    }
  }

  /**
   * Spawn the process behind a Claude target shell — under a new `--session-id`, or
   * `--resume` of the session its ledger row names — and wire its iterator.
   */
  private async spawnClaudeTarget(
    shell: { entry: ClaudeTargetEntry; canUseTool: CanUseTool },
    ctx: RunContext,
    model: string,
    cwd: string,
    ids: { sessionId: string } | { resume: string }
  ): Promise<void> {
    const { entry } = shell
    const mode = mapAutonomyToClaudeTargetMode(liveMode(ctx))
    // ADR-085 §3 — the user's deny/ask rules as the target's flag
    // settings (never the allow tier); omitted when there are none.
    const { deny, ask } = this.userDenyAsk(cwd, ctx.callerRestriction)
    entry.query = await this.spawnClaudeQuery({
      cwd,
      model,
      permissionMode: mode.permissionMode,
      allowDangerouslySkipPermissions: mode.allowDangerouslySkipPermissions,
      canUseTool: shell.canUseTool,
      abortController: entry.abortController,
      prompt: entry.channel,
      ...ids,
      ...(deny.length > 0 || ask.length > 0 ? { settings: { permissions: { deny, ask } } } : {}),
      // The target's report channel (ADR-105 §3): a one-tool server of its own. It is in the
      // process's `allowedTools` only where cli.js would otherwise DENY it: `dontAsk` (an ask is a
      // denial there) and `bypassPermissions` (never asks). Every asking mode leaves it out:
      // `canUseTool` allows it (a report is not an action to approve), and an allow rule would
      // also skip the classifier in auto, which reviews the report (probed on cli.js 2.1.293 with
      // Haiku: an allowed call runs with no ask and no frame, a blocked one is a
      // `permission_denied` frame after the announcing assistant frame and before the tool_result).
      // `session_message` (ADR-105 §4) rides a `claude-ui-sessions` server of its own with that one
      // tool, so its name, label and the user's deny rules are a root session's. Under the same
      // pre-allow rule as the report (see `claudeOwnToolsPreAllowed`); in the asking modes
      // `awaitClaudeTargetApproval` allows it, and in auto cli.js's classifier reviews it as the
      // X-Agent's own action (a block is cli.js's denial: the handler never runs).
      ...(entry.handBack || entry.canMessage
        ? {
            mcpServers: {
              ...(entry.handBack
                ? {
                    [HAND_BACK_SERVER_NAME]: createHandBackServer(async (report, callId) => {
                      // cli.js hands a subagent the in-process MCP tools too: only the X-Agent's own
                      // call is its report (the owner comes from the stream, as for the session tools).
                      const owner = await entry.toolUseOwners.ownerOf(callId)
                      if (owner === 'subagent')
                        return { text: HAND_BACK_SUBAGENT_TEXT, isError: true }
                      if (owner === 'unknown')
                        return { text: HAND_BACK_UNATTRIBUTED_TEXT, isError: true }
                      const asked =
                        callId === undefined ? undefined : entry.askedHandBacks.get(callId)
                      if (callId !== undefined) entry.askedHandBacks.delete(callId)
                      return this.receiveHandBack(entry, report, callId, asked)
                    })
                  }
                : {}),
              ...(entry.canMessage
                ? {
                    [SESSION_TOOLS_SERVER_NAME]: createSessionToolsServer({
                      xAgent: true,
                      getCaller: () => this.xAgentCaller(entry)
                    })
                  }
                : {})
            },
            ...(claudeOwnToolsPreAllowed(mode.permissionMode)
              ? {
                  allowedTools: [
                    ...(entry.handBack ? [CLAUDE_HAND_BACK_TOOL] : []),
                    ...(entry.canMessage ? [CLAUDE_SESSION_MESSAGE_TOOL] : [])
                  ]
                }
              : {})
          }
        : {}),
      onInboundFrame: (frame) => {
        entry.toolUseOwners.noteFrame(frame)
        this.noteSteerFrame(entry, frame)
      }
    })
    entry.iterator = entry.query[Symbol.asyncIterator]()
    entry.appliedPermissionMode = mode.permissionMode
    entry.bypassSpawned = mode.allowDangerouslySkipPermissions
  }

  /**
   * Build the entry shell + its canUseTool BEFORE spawning: canUseTool must
   * exist to pass into spawnClaudeQuery, but it needs to read the entry's
   * LIVE fields (sessionId, ctx) — which aren't known until after spawn. The
   * closure below captures `entry` by reference (not by value), so by the
   * time a real tool call fires (always after spawn completes), the shell's
   * `query`/`iterator` fields are already populated by the caller.
   */
  private createClaudeTargetShell(
    ctx: RunContext,
    ledgerId: string,
    account: DispatchTurnAccount,
    cwd: string
  ): {
    entry: ClaudeTargetEntry
    canUseTool: CanUseTool
  } {
    const abortController = new AbortController()
    const channel = new ClaudeInputChannel()
    const entry: ClaudeTargetEntry = {
      kind: 'claude',
      sessionId: null,
      ledgerId,
      released: false,
      handBack: this.requireHandBack,
      canMessage: sessionToolsAvailable(),
      fromRoutingId: ctx.fromRoutingId,
      cwd,
      channel,
      // Populated by the caller immediately after spawnClaudeQuery resolves.
      query: undefined as unknown as QueryHandle,
      iterator: undefined as unknown as AsyncIterator<SDKMessage>,
      abortController,
      busy: false,
      ctx,
      // Set by the caller from the spawn's mode (resolveAndRunClaude).
      appliedPermissionMode: 'default',
      bypassSpawned: false,
      autoRejectedReported: false,
      modeSync: null,
      account,
      ownTasks: new Map(),
      pendingWake: new Map(),
      toolUseOwners: new ToolUseOwners(),
      handBackCalls: new Map(),
      askedHandBacks: new Map(),
      pushedUuids: new Set(),
      ownTurnStarted: false,
      nextFrame: null,
      interruptedReport: null,
      cumulativeCostUsd: 0,
      lastReportedTotalCostUsd: 0,
      lastActivityAt: 0,
      turnToolUseIds: new Set(),
      itemStreams: undefined as unknown as ClaudeItemStreamLifecycle,
      agentOrigins: new Map(),
      agentRunAliases: new Map()
    }
    entry.itemStreams = new ClaudeItemStreamLifecycle({
      open: (target, message, startedAt) => {
        const ownerToolUseId = entry.ctx.toolUseId
        if (ownerToolUseId)
          entry.ctx.emit('session:item-open', {
            target: { ...target, ownerToolUseId },
            message,
            ...(startedAt === undefined ? {} : { startedAt })
          })
      },
      delta: (target, chunk) => {
        const ownerToolUseId = entry.ctx.toolUseId
        if (ownerToolUseId)
          entry.ctx.emit('session:item-delta', {
            target: { ...target, ownerToolUseId },
            chunk
          })
      },
      seal: (target, message) => {
        const ownerToolUseId = entry.ctx.toolUseId
        if (ownerToolUseId)
          entry.ctx.emit('session:item-seal', {
            ...(target ? { target: { ...target, ownerToolUseId } } : {}),
            ownerToolUseId,
            message
          })
      },
      updateLocal: () => {},
      // The dispatched target's transcript reaches the caller's card through the
      // subagent channel; a tool_use block has to arrive there before its result
      // does, for the same reason it does on the root session.
      publish: (message) => {
        const ownerToolUseId = entry.ctx.toolUseId
        if (ownerToolUseId)
          entry.ctx.emit('session:subagent-message', { toolUseId: ownerToolUseId, message })
      },
      // A cut-off call was published to the caller's card like any other, so it
      // has to be taken back there too (see ClaudeItemStreamSink.retractToolUses).
      retractToolUses: (messageId, toolUseIds) => {
        const ownerToolUseId = entry.ctx.toolUseId
        if (ownerToolUseId)
          entry.ctx.emit('session:tool-uses-retracted', { messageId, toolUseIds, ownerToolUseId })
      }
    })
    const canUseTool: CanUseTool = async (
      toolName: string,
      input: Record<string, unknown>,
      opts: CanUseToolContext
    ): Promise<CanUseToolResult> => this.awaitClaudeTargetApproval(entry, toolName, input, opts)
    return { entry, canUseTool }
  }

  /**
   * Bring a Claude target's process to the parent's LIVE mode (ADR-088 ruling
   * 3) with cli.js's `set_permission_mode` control request.
   *
   * Pull model: called at a continuation turn's start and at the target's
   * every tool ask — there is no push hook from the dispatching session, so a
   * mid-turn switch takes effect at the target's next tool ask or next turn.
   * An ask already parked on the human when the parent switches into auto
   * stays with the human (owner ruling; out of scope).
   *
   * - Wanted = `mapAutonomyToClaudeTargetMode(live mode)`; equal to what the
   *   process runs under → nothing to send.
   * - `bypassPermissions` on a process spawned without the skip flag → apply
   *   `default` instead (the flag is a spawn option; conservative).
   * - A rejected `auto` (cli.js: "set_permission_mode:auto rejected — gate not
   *   enabled") → `default`, ONE `session:warning` per target, and `auto` is not
   *   retried on this process (the gate does not open mid-process) — the
   *   precedent is `ClaudeSession.setPermissionMode`. Any other rejection →
   *   logged, `appliedPermissionMode` kept.
   *
   * Concurrent callers (two asks in one assistant message) serialize on
   * `entry.modeSync`; each re-reads the live mode once the previous sync ends.
   */
  private async syncClaudeTargetMode(entry: ClaudeTargetEntry): Promise<void> {
    while (entry.modeSync) await entry.modeSync
    let wanted = mapAutonomyToClaudeTargetMode(liveMode(entry.ctx)).permissionMode
    if (wanted === 'auto' && entry.autoRejectedReported) wanted = 'default'
    if (wanted === 'bypassPermissions' && !entry.bypassSpawned) {
      if (entry.appliedPermissionMode !== 'default') {
        logger.info(
          'CrossEngineDispatcher',
          'claude target: bypassPermissions needs a spawn-time flag — applying default instead'
        )
      }
      wanted = 'default'
    }
    if (wanted === entry.appliedPermissionMode) return
    const run = async (): Promise<void> => {
      try {
        await entry.query.setPermissionMode(wanted)
        entry.appliedPermissionMode = wanted
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (wanted !== 'auto') {
          logger.warn(
            'CrossEngineDispatcher',
            `claude target: set_permission_mode ${wanted} failed — ${msg}`
          )
          return
        }
        logger.info('CrossEngineDispatcher', `claude target: auto mode rejected — ${msg}`)
        try {
          await entry.query.setPermissionMode('default')
          entry.appliedPermissionMode = 'default'
        } catch (fallbackErr) {
          logger.warn(
            'CrossEngineDispatcher',
            `claude target: set_permission_mode default failed — ${
              fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)
            }`
          )
        }
        if (!entry.autoRejectedReported) {
          entry.autoRejectedReported = true
          entry.ctx.emit(
            'session:warning',
            'Dispatched Claude agent: auto mode was rejected (disabled by your organization?) — its actions will ask you instead.'
          )
        }
      }
    }
    const pending = run()
    entry.modeSync = pending
    try {
      await pending
    } finally {
      if (entry.modeSync === pending) entry.modeSync = null
    }
  }

  /**
   * Forward a Claude target's tool-approval request into the dispatching
   * session's chat (ADR-033 M2 item 7) — the Claude-target mirror of the SSE
   * loop's `permission.asked` handling for opencode targets.
   *
   * ADR-085 §3 — first, a shell command a user DENY rule hits by the §1
   * matcher is refused with the rule, no card: cli.js got the same rules as
   * `--settings` but matches them by its own text prefix, which a reordered
   * form evades. Residual: under `bypassPermissions` (a bypass target) and
   * `auto` (cli.js's own judge decides first, ADR-088) only what cli.js itself
   * asks reaches this gate, so there cli.js's own matcher decides the rest.
   */
  private async awaitClaudeTargetApproval(
    entry: ClaudeTargetEntry,
    toolName: string,
    input: Record<string, unknown>,
    opts: CanUseToolContext
  ): Promise<CanUseToolResult> {
    // ADR-088 — a parent switch since the turn started reaches the process at
    // its next ask. The ask in hand was produced under the OLD mode and is
    // decided below as usual (a human answers it; an ask already parked on
    // the human stays with the human).
    // Read BEFORE the sync: the mode the ask was produced under (an ask of auto's classifier).
    const wasAuto = entry.appliedPermissionMode === 'auto'
    await this.syncClaudeTargetMode(entry)
    if (opts.toolUseId) entry.toolUseOwners.note(opts.toolUseId, !!opts.agentId)
    // The report is the run's end, never an action to approve. In auto, though, cli.js asks only
    // when its classifier did not allow the call (a denial cap or a missing verdict turned the
    // block into an ask): the report is allowed through but not as a clean one (B-3c).
    if (toolName === CLAUDE_HAND_BACK_TOOL) {
      if (wasAuto && opts.toolUseId && !opts.agentId) {
        entry.askedHandBacks.set(opts.toolUseId, handBackReviewOfAsk(opts))
        if (entry.askedHandBacks.size > 8)
          entry.askedHandBacks.delete(entry.askedHandBacks.keys().next().value as string)
      }
      return { behavior: 'allow', updatedInput: input }
    }
    // The X-Agent's message to its dispatcher (ADR-105 §4): the service enforces who it may reach, so
    // the asking modes need no card for it. In auto it is not allowed here: cli.js asks only when its
    // classifier did not allow the call (a denial cap, no verdict), and that ask is the human's, like
    // any other tool's (it is not stashed or waved through as the report is).
    if (toolName === CLAUDE_SESSION_MESSAGE_TOOL && entry.canMessage && !wasAuto) {
      return { behavior: 'allow', updatedInput: input }
    }
    if (isShellToolName(toolName) && typeof input.command === 'string') {
      const hit = denyAskHit(
        input.command,
        this.userDenyAsk(entry.cwd, entry.ctx.callerRestriction)
      )
      if (hit?.tier === 'deny') {
        logger.info(
          'CrossEngineDispatcher',
          `claude target: permission rule deny ${toolName} — ${hit.rule}`
        )
        return Promise.resolve({
          behavior: 'deny',
          message: `Denied by permission rule: ${hit.rule}`
        })
      }
    }
    return new Promise<CanUseToolResult>((resolve) => {
      const requestId = XENG_REQUEST_PREFIX + uuidv4()
      const approval: PendingApproval = {
        requestId,
        toolName,
        input,
        toolUseId: opts.toolUseId,
        suggestions: opts.suggestions as PendingApproval['suggestions'],
        decisionReason: opts.decisionReason,
        blockedPath: opts.blockedPath
      }
      this.pendingApprovals.set(requestId, {
        kind: 'claude',
        targetSessionId: entry.sessionId,
        emit: entry.ctx.emit,
        card: approval,
        resolve: (decision, answers) => {
          if (decision === 'allow' || decision === 'allowForSession') {
            resolve({ behavior: 'allow', updatedInput: input })
          } else {
            resolve({ behavior: 'deny', message: answers?.feedback || 'User denied' })
          }
        }
      })
      entry.ctx.emit('session:approval-request', approval)

      opts.signal.addEventListener(
        'abort',
        () => {
          if (!this.takePendingApproval(requestId)) return
          entry.ctx.emit('session:approval-dismiss', { requestId })
          resolve({ behavior: 'deny', message: 'Dispatch cancelled' })
        },
        { once: true }
      )
    })
  }

  /**
   * Is a forwarded approval for this dispatch target still awaiting a human?
   * Read by the turn watchdog to keep an approval-PARKED turn's inactivity
   * clock rolling (see `startTurnWatchdog`). NOT scoped to any target kind: as
   * of ADR-033's 2026-09-18 amendment all four directions run on that
   * watchdog, and a Claude/pi/codex target blocked on its gate is exactly as
   * silent as an opencode one blocked on `ctx.ask`. A plain scan: the map holds
   * at most a handful of live approvals. A null session id (a Claude target
   * whose `system/init` has not landed yet) can own no approval by definition.
   */
  private hasPendingApprovalFor(targetSessionId: string | null): boolean {
    if (targetSessionId === null) return false
    for (const pending of this.pendingApprovals.values()) {
      if (pending.targetSessionId === targetSessionId) return true
    }
    return false
  }

  /**
   * Remove one forwarded approval, disarming a held block's expiry (ADR-091
   * §3). The ONE way an entry leaves `pendingApprovals`, so no resolution path
   * — the human, the cascade, a stop, disposal — leaks a timer.
   */
  private takePendingApproval(requestId: string): PendingForwardedApproval | undefined {
    const pending = this.pendingApprovals.get(requestId)
    if (!pending) return undefined
    this.pendingApprovals.delete(requestId)
    if (pending.hold) {
      pending.hold.cancel()
      // Approvable after the fact from here on (ADR-091 part 6).
      pending.hold.ledger()?.settle(pending.hold.toolUseId)
    }
    return pending
  }

  /**
   * Arm a forwarded card's held-block expiry (ADR-091 §3), `block.ms` away:
   * unanswered, it resolves exactly as a Keep blocked click — through
   * `resolveApproval` — and the card is withdrawn. Returns the pending entry's
   * `hold` and the card's `autoModeBlock`.
   */
  private armForwardedHold(
    requestId: string,
    ctx: DispatchContext,
    judge: DispatchTargetJudge,
    toolUseId: string,
    block: { reason: string; ms: number }
  ): { hold: ForwardedBlockHold; autoModeBlock: { expiresAt: number } } {
    // Both read the parent through the run's facade AT USE (ADR-105): a hold outlives the
    // session object that was live when it was armed.
    const timer = armBlockHold(() => {
      this.resolveApproval(requestId, 'deny')
      ctx.emit('session:approval-dismiss', { requestId })
    }, block.ms)
    return {
      hold: {
        reason: block.reason,
        toolUseId,
        judge,
        ledger: () => ctx.blockedCalls,
        cancel: timer.cancel
      },
      autoModeBlock: { expiresAt: timer.expiresAt }
    }
  }

  /**
   * Arm one dispatch turn's liveness watchdog — the SINGLE implementation
   * shared by all four directions (ADR-033's 2026-09-18 amendment; before it
   * only the opencode direction had one, and claude/pi/codex raced a fixed
   * 10-minute `setTimeout` no user could change).
   *
   * Returns a promise that resolves ONLY when one of the two configured caps
   * fires, plus a `dispose` the caller MUST run in its `finally`. With both
   * caps unlimited — which is the default, since `resolveTurnLiveness` has no
   * built-in fallback — NO interval is armed at all and the promise never
   * resolves: the turn then ends only on its own completion, the caller's
   * abort, the user's stop, or `dispatch.maxCostUsd`.
   *
   * `entry` is taken BY REFERENCE, not snapshotted: the inactivity deadline
   * MOVES as the target streams (each direction bumps `lastActivityAt` from its
   * own event feed), and the parked-on-an-approval refresh below WRITES it.
   */
  private startTurnWatchdog(
    entry: { lastActivityAt: number },
    caps: TurnLivenessCaps,
    turnStartedAt: number,
    isApprovalParked: () => boolean
  ): { promise: Promise<TurnTimeout>; dispose: () => void } {
    const { turnTimeoutMs, idleTimeoutMs } = caps
    if (turnTimeoutMs <= 0 && idleTimeoutMs <= 0) {
      // Unlimited in both dimensions — nothing to poll for.
      return { promise: new Promise<TurnTimeout>(() => {}), dispose: (): void => {} }
    }
    let timer: ReturnType<typeof setInterval> | undefined
    const promise = new Promise<TurnTimeout>((resolve) => {
      timer = setInterval(() => {
        const now = this.now()
        // A target BLOCKED on a forwarded approval is alive but SILENT — an
        // opencode target parked on `ctx.ask` emits no session events at all
        // (the server's keepalives carry no sessionID), and a Claude/pi/codex
        // target parked on its gate is just as quiet. The inactivity clock
        // would otherwise run out on a turn whose only fault is that its human
        // is slow, aborting it and dismissing the very card they were reading.
        // Keep the clock rolling while the ask is outstanding; answering it
        // therefore also starts a FRESH inactivity window for the resumed
        // turn. The ABSOLUTE cap deliberately keeps running: an approval nobody
        // ever answers still ends the turn.
        if (isApprovalParked()) entry.lastActivityAt = now
        if (turnTimeoutMs > 0 && now - turnStartedAt > turnTimeoutMs) {
          resolve({ kind: 'timeout', reason: 'absolute' })
        } else if (idleTimeoutMs > 0 && now - entry.lastActivityAt > idleTimeoutMs) {
          resolve({ kind: 'timeout', reason: 'inactivity' })
        }
      }, DISPATCH_WATCHDOG_INTERVAL_MS)
    })
    return {
      promise,
      dispose: (): void => {
        if (timer) clearInterval(timer)
      }
    }
  }

  /** Dismiss all forwarded approvals for one target (timeout/abort/dispose).
   *  Claude/pi/codex-kind resolvers are ALSO resolved with deny — never leave a
   *  hanging canUseTool/gate/server-request promise (ADR-033 M2 item 7,
   *  extended to pi in M4c and to codex in slice H). */
  private dismissPendingForTarget(targetSessionId: string): void {
    // An opencode target's asks still under judgement reply nothing once the
    // turn is stopped (ADR-088, `OpencodeTargetEntry.judging`).
    const target = this.targets.get(targetSessionId)
    if (target?.kind === 'opencode') target.judging.clear()
    for (const [key, pending] of [...this.pendingApprovals]) {
      if (pending.targetSessionId !== targetSessionId) continue
      this.takePendingApproval(key)
      pending.emit('session:approval-dismiss', { requestId: key })
      if (pending.kind === 'claude' || pending.kind === 'pi' || pending.kind === 'codex') {
        pending.resolve('deny')
      }
    }
  }

  /**
   * Shared cost-delta bookkeeping for a NON-success pi turn outcome (timeout/
   * stop/err) — mirrors the Claude target's failed-subtype handling (§ "the
   * cap is a SPEND limit, not a success limit", :1797-1802): a turn that
   * streamed real spend before erroring/timing-out/being stopped must still
   * count that spend toward the cap and the dispatching session's cost
   * breakdown, exactly like a successful turn does. `entry.runner.mapperState.
   * totalCostUsd` is the right source here (NOT anything derived from the
   * turn's own outcome, since a non-success outcome carries no such number):
   * it is the mapper's per-PROCESS running total, incremented by `mapPiEvent`
   * on every cost-bearing assistant message REGARDLESS of which turn produced
   * it or how that turn ended (see event-mapper.ts's `PiMapperState.
   * totalCostUsd` doc) — so it already reflects whatever the abandoned turn
   * actually spent by the time the caller reads it. Returns the turn's own
   * resolved cost for the caller to fold into a usage row, or null when the
   * rule could not price it.
   */
  private accountPiNonSuccessCost(
    entry: PiTargetEntry,
    ctx: DispatchContext,
    model: string
  ): number | null {
    // The delta against the mapper's running total, advancing the baseline.
    const rawTurnCostUsd = entry.runner.takeCostDelta()
    return this.applyPiTurnCost(entry, ctx, model, rawTurnCostUsd)
  }

  /**
   * Put one pi turn's raw delta through the cost rule (`piTurnCost`) and fold
   * the result into the cap + the dispatching session's breakdown. The single
   * place the pi target counts spend, so the rule is stated once for all four
   * of its outcomes. Returns what was counted, or null when the turn was
   * unpriced — which is recorded on the entry instead and never added as a
   * silent zero.
   */
  private applyPiTurnCost(
    entry: PiTargetEntry,
    ctx: DispatchContext,
    model: string,
    rawTurnCostUsd: number
  ): number | null {
    // Keep pi's RAW figure for the ledger row: it is a list-price equivalent
    // (pi prices from its own catalog whatever the credential — S1b), and it
    // knows long-context tiers our table does not, so a row that dropped it
    // would price the turn worse than pi already did.
    entry.turnEngineCostUsd = rawTurnCostUsd
    const turnCostUsd = piTurnCost(
      model,
      { ...entry.runner.turnTokens, reasoning: entry.runner.turnReasoningTokens },
      rawTurnCostUsd
    ).displayCostUsd
    if (turnCostUsd === null) {
      entry.unpricedTurns++
      return null
    }
    entry.cumulativeCostUsd += turnCostUsd
    if (turnCostUsd > 0) {
      ctx.addDispatchedCost?.('pi', model, turnCostUsd)
    }
    return turnCostUsd
  }

  /**
   * Same cost-delta bookkeeping as `accountPiNonSuccessCost` above, but for
   * the err/timeout non-success paths ONLY (audit-residual C fix — NEVER the
   * stop/abort path, which stays unreconciled by design: ADR-033 M4-B already
   * records no usage row for a turn that never returned, and this file's own
   * call sites below only ever invoke this method from the err/timeout
   * branches). `entry.runner.mapperState.totalCostUsd` only grows via cost-bearing
   * assistant `message_end`s the mapper actually SAW — a turn that dies
   * before its first one (e.g. erroring inside the very first LLM call, or
   * timing out before any assistant message streams back) can still have
   * spent real money that pi's own backend recorded but never surfaced as a
   * mapped event. `get_session_stats` is pi's authoritative cumulative cost
   * (the SAME RPC PiSession's resume-seed already trusts — see
   * PiSession.replayStoredHistory) — read here, BOUNDED
   * (`GET_SESSION_STATS_RECONCILE_TIMEOUT_MS`) and swallowed on failure (a
   * wedged target — plausible, since that's often why the turn is on this
   * path at all — must never block the error return on a follow-up RPC): if
   * the read succeeds AND reports MORE than `entry.runner.mapperState.totalCostUsd`,
   * that authoritative number is used IN PLACE OF the mapper's total for the
   * delta + baseline advance below; otherwise this is behaviorally IDENTICAL
   * to `accountPiNonSuccessCost`.
   */
  private async accountPiNonSuccessCostReconciled(
    entry: PiTargetEntry,
    ctx: DispatchContext,
    model: string
  ): Promise<number | null> {
    // The read, its bound, the swallow-and-fall-back and the warning live in
    // `PiChildRunner.reconciledTotalCostUsd` (logged under this module's tag).
    const totalCostUsd = await entry.runner.reconciledTotalCostUsd(
      GET_SESSION_STATS_RECONCILE_TIMEOUT_MS
    )
    const rawTurnCostUsd = entry.runner.takeCostDelta(totalCostUsd)
    return this.applyPiTurnCost(entry, ctx, model, rawTurnCostUsd)
  }

  // ── pi direction (M4c) ────────────────────────────────────────────────────

  /**
   * Everything past the guards for engine:'pi' — runs with a run slot
   * slot held and the Stop handle already registered (mirrors
   * resolveAndRunClaude/resolveAndRunOpencode's identical preamble).
   */
  private async resolveAndRunPi(
    req: DispatchRequest,
    ctx: RunContext,
    stopController: AbortController
  ): Promise<DispatchResult> {
    // ── Model resolution ──────────────────────────────────────────────────
    // A model is REQUIRED (req.model or dispatch.defaultModel) — same as the
    // Claude branch, DELIBERATELY UNLIKE PiSession's own "no requested model →
    // keep pi's own settings default" behavior (doStart() skips set_model
    // entirely when unset). That soft-degrade exists for an INTERACTIVE
    // session's UX; a headless dispatch target has no such benefit, and
    // letting a model-less dispatch silently fall through to "whatever pi
    // happens to be configured with" would make a configured allowedModels
    // allowlist UNENFORCEABLE (we'd never know the actual model until AFTER
    // spawn). Requiring a model keeps the allowlist honest, matching Claude.
    const dispatchCfg = this.deps.loadEngineConfig('pi').dispatch
    const requestedModel = req.model ?? dispatchCfg?.defaultModel
    if (!requestedModel) {
      return errorResult(
        'No model is configured for cross-engine dispatch into pi. Ask the user to set ' +
          'Settings › Cross-engine dispatch › Dispatch into › pi (the `dispatch.defaultModel` field in ' +
          '~/.claude/ui/engines/pi.json), or pass `model` explicitly.'
      )
    }
    const allowed = dispatchCfg?.allowedModels
    if (allowed && allowed.length > 0 && !allowed.includes(requestedModel)) {
      return errorResult(
        `Model "${requestedModel}" is not in the user-configured allowlist for pi dispatch. ` +
          `Allowed models: ${allowed.join(', ')}`
      )
    }
    // Canonical from here on — see canonicalDispatchModel. (A target resumed from its
    // ledger row runs under the model it was created with.)
    let model = canonicalDispatchModel('pi', requestedModel)

    // ── Target resolution ─────────────────────────────────────────────────
    let entry: PiTargetEntry
    if (req.sessionId) {
      const cont = this.findContinuation(req.sessionId, ctx, 'pi')
      if (!cont) {
        return errorResult(
          `Unknown dispatch session "${req.sessionId}" — it may have been disposed. ` +
            'Start a new X-Agent with dispatch_agent.'
        )
      }
      // Busy-reject BEFORE touching entry state — same rationale as the
      // Claude target (one ambient event stream per process; interleaving two
      // turns would have no way to tell which `result` belongs to which caller).
      if ('live' in cont && cont.live.busy) {
        return errorResult(
          `Dispatch session "${req.sessionId}" is already running a turn — wait for it to finish before continuing it.`,
          req.sessionId
        )
      }
      const spent = this.continuationSpend(cont, dispatchCfg, req.sessionId, 'pi')
      if ('text' in spent) return spent
      if ('row' in cont) {
        const refusal = this.resumeModelRefusal('pi', cont.row.model, dispatchCfg)
        if (refusal) return refusal
      }
      if ('live' in cont) {
        this.bindContinuation(ctx, cont)
        cont.live.ctx = ctx
        entry = cont.live
      } else {
        // The child is gone: respawn it on the same session dir and id — pi opens the
        // session file it finds there, in the directory the target was created in.
        model = cont.row.model
        // pi given an id it cannot find CREATES a session under it, silently dropping the
        // conversation: a directory that is gone is the end of this target, not a fresh start.
        if (!this.piSessionDirExists(dispatchPiSessionDir(cont.row.id))) {
          this.ledgerSet(cont.row.id, { state: 'failed' })
          return errorResult(
            `Dispatch session "${req.sessionId}" cannot be resumed — its pi session directory no longer exists. ` +
              'Start a new X-Agent with dispatch_agent.',
            req.sessionId
          )
        }
        this.bindContinuation(ctx, cont)
        try {
          entry = await this.createPiTarget(ctx, model, cont.row)
        } catch (err) {
          return errorResult(`Failed to resume dispatched pi agent: ${errText(err)}`, req.sessionId)
        }
        entry.cumulativeCostUsd = spent.costUsd
        entry.unpricedTurns = spent.unpricedTurns
      }
    } else {
      try {
        entry = await this.createPiTarget(ctx, model, undefined, req)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return errorResult(`Failed to start dispatched pi agent: ${msg}`)
      }
    }
    // The judge's subagent task is the LATEST dispatch prompt (ADR-088).
    entry.lastPrompt = req.prompt

    const turn = async (prompt: string | null): Promise<TurnReturn> => {
      // Mark busy BEFORE the prompt is sent — fresh per-turn accumulators.
      entry.busy = true
      this.ledgerTurnState(entry, 'running')
      entry.turnEngineCostUsd = null
      const turnStartedAt = this.now()
      entry.runner.beginTurn(turnStartedAt)

      // ── Run the turn ──────────────────────────────────────────────────────
      const heartbeat = this.startHeartbeat(ctx)

      const signal = ctx.run.cancelController.signal
      let abortListener: (() => void) | undefined

      type Raced =
        | { kind: 'ok'; outcome: Extract<PiTurnOutcome, { kind: 'ok' }> }
        | { kind: 'err'; message: string }
        | TurnTimeout
        | { kind: 'abort' }
        | { kind: 'stop' }
        | { kind: 'report' }

      const turnPromise: Promise<Raced> = entry.runner
        .runTurn(prompt as string)
        .then((outcome): Raced =>
          outcome.kind === 'ok'
            ? { kind: 'ok', outcome }
            : { kind: 'err', message: outcome.message }
        )
      // Turn liveness: the TARGET engine's two configured caps, unlimited unless
      // the user set them (ADR-033's 2026-09-18 amendment). The ambient `onEvent`
      // callback `PiChildRunner.start` installs is what bumps
      // `entry.runner.lastActivityAt`.
      const caps = resolveTurnLiveness(dispatchCfg)
      const watchdog = this.startTurnWatchdog(entry.runner, caps, turnStartedAt, () =>
        this.hasPendingApprovalFor(entry.sessionId)
      )
      const timeoutPromise: Promise<Raced> = watchdog.promise
      const abortPromise: Promise<Raced> = signal
        ? signal.aborted
          ? Promise.resolve({ kind: 'abort' })
          : new Promise((resolve) => {
              abortListener = (): void => resolve({ kind: 'abort' })
              signal.addEventListener('abort', abortListener, { once: true })
            })
        : new Promise(() => {})
      const stopPromise: Promise<Raced> = stopController.signal.aborted
        ? Promise.resolve({ kind: 'stop' })
        : new Promise((resolve) => {
            stopController.signal.addEventListener('abort', () => resolve({ kind: 'stop' }), {
              once: true
            })
          })

      // The agent handed its report back (ADR-105 §3): the run is over, the turn is to end.
      const reportPromise: Promise<Raced> = ctx.run.reported.then((): Raced => ({ kind: 'report' }))

      let endState: DispatchTargetState = 'idle'
      try {
        const raced = await Promise.race([
          turnPromise,
          timeoutPromise,
          abortPromise,
          stopPromise,
          reportPromise
        ])
        // The report's tool result carries pi's `terminate`, so the turn ends by itself right
        // after it; a model that kept going is aborted. Either way the turn's own outcome is
        // read when it has one, else the turn is as long as the clock says.
        let winner: Exclude<Raced, { kind: 'report' }>
        if (raced.kind === 'report') {
          const ended = await settledWithin(turnPromise, this.piAbortSettleGraceMs)
          if (ended?.kind === 'ok') winner = ended
          else {
            if (!ended) await entry.runner.abortTurn(this.piAbortSettleGraceMs)
            winner = {
              kind: 'ok',
              outcome: {
                kind: 'ok',
                totalCostUsd: entry.runner.mapperState.totalCostUsd,
                durationMs: this.now() - turnStartedAt,
                sessionId: entry.sessionId
              }
            }
          }
        } else winner = raced

        if (winner.kind === 'timeout' || winner.kind === 'abort' || winner.kind === 'stop') {
          // `PiChildRunner.abortTurn`: `draining` FIRST, synchronously, before
          // the `abort` RPC even sends, so no late 'ask' from this turn can
          // possibly race ahead of it (see `PiChildRunner.draining`). DIVERGES
          // FROM CLAUDE: pi's `abort` interrupts the CURRENT TURN only (session
          // survives — verified; see PiTargetEntry's doc comment) — mirrors the
          // OPENCODE target's survive-the-process pattern, so the entry is kept
          // alive for continuation rather than torn down. RACE GUARD (see
          // `PiChildRunner.settled`'s "RACE NOTE"): it waits, BOUNDED, for the
          // ABANDONED turn's own terminal event sequence (still in flight —
          // triggered by the abort just sent) to drain and settle the runner's
          // `settled` back to null BEFORE `busy` is released in the `finally`
          // below. Without this, a fast-enough continuation could install a NEW
          // settle wrapper while the stale one is still pending delivery — pi's
          // wire has no per-event turn correlation, so whichever wrapper is
          // CURRENTLY installed receives the next settle-shaped event
          // regardless of which turn actually produced it.
          await entry.runner.abortTurn(this.piAbortSettleGraceMs)
          // Read AFTER the grace-period wait, not before — the abandoned turn's
          // own trailing cost-bearing events can still land during that window
          // (see the RACE GUARD above), so this is the earliest point the
          // mapper's running total can be trusted as final for this turn.
          // Audit-residual C fix: ONLY the 'timeout' outcome reconciles against
          // get_session_stats (a genuine failure — it gets a usage row below).
          // 'stop'/'abort' deliberately do NOT — ADR-033 M4-B already records no
          // usage row for either, and a follow-up RPC to a target the user just
          // asked to stop would be pure latency for no observable benefit.
          // Called for the ACCOUNTING, not for a figure: both fold the turn's
          // spend into the cap and the dispatching session's breakdown, and the
          // ledger row prices the split itself.
          if (winner.kind === 'timeout') {
            await this.accountPiNonSuccessCostReconciled(entry, ctx, model)
          } else {
            this.accountPiNonSuccessCost(entry, ctx, model)
          }
          if (entry.sessionId) this.dismissPendingForTarget(entry.sessionId)
          const text =
            winner.kind === 'timeout'
              ? turnTimeoutText(winner.reason, caps, PI_TIMEOUT_AFTERMATH)
              : winner.kind === 'stop'
                ? 'Dispatch stopped by user.'
                : 'Dispatch cancelled.'
          const status = winner.kind === 'timeout' ? 'failed' : 'stopped'
          ctx.run.timedOut = winner.kind === 'timeout'
          emitDispatchNotification(ctx, entry.sessionId ?? '', status, text)
          // Row vs spend accounting are DELIBERATELY split here: a 'stopped' turn
          // gets no usage ROW (ADR-033 M4-B: no usage numbers for a turn that
          // never returned) — but its cost/cap accounting above (`entry.
          // cumulativeCostUsd` / `addDispatchedCost`) still applies regardless of
          // status, via `accountPiNonSuccessCost` — a stopped turn can have
          // burned real spend before the stop landed, and that spend counts
          // toward the cap exactly like a timeout's or a success's does.
          if (status === 'failed') {
            this.safeRecordUsage({
              ts: this.now(),
              fromRoutingId: ctx.fromRoutingId,
              targetEngine: 'pi',
              targetModel: model,
              targetSessionId: entry.sessionId,
              toolUseId: ctx.toolUseId ?? null,
              tokens: entry.runner.turnTokens,
              engineCostUsd: entry.turnEngineCostUsd,
              account: piDispatchAccount(model),
              engineCostIsEquivalent: true
            })
          }
          return errorResult(text, entry.sessionId ?? '')
        }

        if (winner.kind === 'err') {
          endState = 'failed'
          // Also NOT torn down — pi's own error surface (a rejected prompt ack,
          // an extension_error) mostly leaves the process alive; a genuinely
          // dead process (the onExit case) self-diagnoses cleanly on the NEXT
          // continuation attempt instead (PiRpcClient.request() already guards
          // "process is not running"), so no extra liveness tracking is needed
          // here — see the M4c report for the full rationale.
          if (entry.sessionId) this.dismissPendingForTarget(entry.sessionId)
          // Audit-residual C fix: reconcile against get_session_stats — an
          // extension_error/rejected-ack can land before ANY cost-bearing
          // message_end streamed back, in which case entry.runner.mapperState.
          // totalCostUsd is still the pre-turn value even though pi's backend
          // may have genuinely spent something.
          await this.accountPiNonSuccessCostReconciled(entry, ctx, model)
          emitDispatchNotification(
            ctx,
            entry.sessionId ?? '',
            'failed',
            `Dispatched turn failed: ${winner.message}`
          )
          this.safeRecordUsage({
            ts: this.now(),
            fromRoutingId: ctx.fromRoutingId,
            targetEngine: 'pi',
            targetModel: model,
            targetSessionId: entry.sessionId,
            toolUseId: ctx.toolUseId ?? null,
            tokens: entry.runner.turnTokens,
            engineCostUsd: entry.turnEngineCostUsd,
            account: piDispatchAccount(model),
            engineCostIsEquivalent: true
          })
          return errorResult(`Dispatched turn failed: ${winner.message}`, entry.sessionId ?? '')
        }

        // ── Success ────────────────────────────────────────────────────────
        const { outcome } = winner
        const rawTurnCostUsd = entry.runner.takeCostDelta(outcome.totalCostUsd)

        // get_last_assistant_text — simpler + more reliable than accumulating
        // `message` MapperOutputs across the turn ourselves (see
        // `PiChildRunner.runTurn`'s doc comment). Best-effort: a failure here
        // still returns a result (with a placeholder text) rather than failing
        // an otherwise-successful turn over a follow-up RPC call.
        const finalText =
          (await entry.runner.lastAssistantText()) ?? '(the dispatched agent returned no text)'

        // ── Cost cap crossing note (ADR-033 M4-C) ───────────────────────────
        // applyPiTurnCost does the fold into the cap AND the dispatching
        // session's breakdown (Slice C), so the cap state is read before it.
        const maxCostUsd = dispatchCfg?.maxCostUsd
        const wasUnderCap = maxCostUsd === undefined || entry.cumulativeCostUsd < maxCostUsd
        const turnCostUsd = this.applyPiTurnCost(entry, ctx, model, rawTurnCostUsd)
        let outText = finalText
        if (turnCostUsd === null) {
          if (maxCostUsd !== undefined) outText += cannotCountNote(model)
        } else if (
          maxCostUsd !== undefined &&
          wasUnderCap &&
          entry.cumulativeCostUsd >= maxCostUsd
        ) {
          outText +=
            '\n\n[dispatch cost cap reached — further turns on this session will be rejected]'
        }

        await this.settleReview(ctx.run)
        const done = this.finishTurn(ctx, 'pi', model, entry, entry.sessionId ?? '', {
          finalText,
          outText,
          usage: {
            totalTokens: entry.runner.turnTotalTokens,
            toolUses: entry.runner.turnToolUseIds.size,
            durationMs: outcome.durationMs
          }
        })
        this.safeRecordUsage({
          ts: this.now(),
          fromRoutingId: ctx.fromRoutingId,
          targetEngine: 'pi',
          targetModel: model,
          targetSessionId: entry.sessionId,
          toolUseId: ctx.toolUseId ?? null,
          tokens: entry.runner.turnTokens,
          // pi reports a LIST PRICE, not a charge (S1b) — the ledger must not
          // read it as money that left a wallet.
          engineCostUsd: entry.turnEngineCostUsd,
          account: piDispatchAccount(model),
          engineCostIsEquivalent: true
        })
        return done
      } finally {
        entry.runner.flush()
        entry.busy = false
        this.ledgerTurnState(entry, endState)
        clearInterval(heartbeat)
        watchdog.dispose()
        if (signal && abortListener) signal.removeEventListener('abort', abortListener)
      }
    }
    return this.runWithNudges(
      ctx,
      {
        sessionId: () => entry.sessionId ?? '',
        engine: 'pi',
        toolName: HAND_BACK_TOOL,
        cumulativeCostUsd: () => entry.cumulativeCostUsd
      },
      this.taskText(entry, ctx, req.prompt, HAND_BACK_TOOL),
      turn
    )
  }

  /**
   * Build the target shell + start its `PiChildRunner` (spawn its PiRpcClient
   * + PiBridgeHost, resolve `get_state` — capturing session_id EAGERLY, see
   * PiTargetEntry's doc comment — then apply the requested model via
   * `set_model`), and register it. Any failure along the way tears down
   * whatever was already created and re-throws — `resolveAndRunPi` turns
   * that into a friendly isError.
   */
  private async createPiTarget(
    ctx: RunContext,
    model: string,
    resume?: DispatchTargetRow,
    labels?: DispatchLabels
  ): Promise<PiTargetEntry> {
    // The session id is minted here and the ledger row written BEFORE the child spawns
    // (ADR-105); a resume reuses both, in the directory the target was created in.
    const harnessId = resume?.harnessRef ?? uuidv4()
    const row =
      resume ??
      this.recordTarget(ctx, {
        engine: 'pi',
        harnessRef: harnessId,
        model,
        accountKey: piDispatchAccount(model).accountKey,
        labels,
        handBack: this.requireHandBack
      })
    const cwd = resume?.cwd ?? ctx.cwd
    const entry: PiTargetEntry = {
      kind: 'pi',
      sessionId: null,
      ledgerId: row.id,
      released: false,
      handBack: this.requireHandBack,
      canMessage: sessionToolsAvailable(),
      fromRoutingId: ctx.fromRoutingId,
      cwd,
      // Populated below, once the runner has started — the gate handler and
      // stream closures capture `entry` BY REFERENCE (mirrors
      // createClaudeTargetShell), so it's safe to construct before this field
      // is filled in: a real tool_call can only fire after the child has
      // actually spawned and been prompted.
      runner: undefined as unknown as PiChildRunner,
      ctx,
      busy: false,
      cumulativeCostUsd: 0,
      unpricedTurns: 0,
      turnEngineCostUsd: null,
      model,
      // ClaudeUI's judge for this target (ADR-088) — its closures read the
      // entry live (the ctx is replaced on every continuation).
      judge: undefined as unknown as DispatchTargetJudge,
      lastPrompt: ''
    }
    entry.judge = new DispatchTargetJudge({
      engine: 'pi',
      cwd,
      routingId: () => entry.ctx.fromRoutingId,
      sessionId: () => entry.sessionId,
      model: () => entry.model,
      emit: () => entry.ctx.emit,
      messages: () => entry.ctx.getMessages(),
      loadMessages: () => entry.ctx.loadMessages?.(),
      queuedTurns: () => entry.ctx.getQueuedUserTurns?.() ?? [],
      blockedCalls: () => entry.ctx.blockedCalls,
      trajectory: () => entry.runner.trajectory.values(),
      subagent: () => ({
        type: 'dispatch:pi',
        description: judgeDescription(entry.model, entry.ctx.callerRestriction),
        prompt: entry.lastPrompt
      }),
      loadEngineConfig: this.deps.loadEngineConfig,
      peekModels: peekPiModels,
      ...(this.deps.makeJudgeTransport ? { makeTransport: this.deps.makeJudgeTransport } : {})
    })

    const gateHandler: PiBridgeHandler = (payload) => this.gatePiTargetToolCall(entry, payload)

    // The runner streams the target's live turn output as engine-neutral
    // subagent events under the CURRENT dispatching tool_use (both read live:
    // `entry.ctx` is replaced on every continuation), byte-matching
    // `forwardClaudeTargetMessage`'s / `handleOpencodeTargetStream`'s payload
    // shapes, and accumulates the turn's tokens even with no tool_use to
    // stream to (see `PiChildRunner`'s output handler).
    const piSkillCatalog = resolveClaudeSkills(cwd)
    try {
      entry.runner = await PiChildRunner.start({
        cwd,
        model,
        spawn: this.spawnPiTarget,
        // The shared MCP catalog (ADR-096), read at target creation and served
        // by the target's bridge host; its calls hit this target's gate, which
        // spells Claude MCP rules in pi's form (`mcpRuleKey`).
        spawnOpts: {
          gateHandler,
          // The hosted tools a target has: `hand_back` (ADR-105 §3), whose result carries pi's
          // `terminate` (the turn ends right after the report), and `session_message` to its
          // dispatcher (§4; the extension's gate has judged it first). Anything else fails closed.
          ...(entry.handBack || entry.canMessage
            ? {
                hostedToolHandler: async (payload) => {
                  if (entry.handBack && payload.toolName === HAND_BACK_TOOL)
                    return this.piHandBackResult(entry, payload.input, payload.toolCallId)
                  if (entry.canMessage && payload.toolName === X_AGENT_MESSAGE_TOOL) {
                    const sent = await this.xAgentMessage(entry, payload.input, payload.toolCallId)
                    return {
                      content: [{ type: 'text' as const, text: sent.text }],
                      ...(sent.isError ? { isError: true } : {})
                    }
                  }
                  return {
                    content: [
                      { type: 'text' as const, text: `${payload.toolName} is not available here` }
                    ],
                    isError: true
                  }
                }
              }
            : {}),
          mcpServers: collectClaudeMcpForPi(cwd).servers,
          skills: piSkillCatalog.skills,
          skillSourceRoots: piSkillCatalog.sourceRoots,
          ...piTargetSpawnFlags(
            dispatchPiSessionDir(row.id),
            harnessId,
            entry.handBack,
            entry.canMessage
          )
        },
        ownerToolUseId: () => entry.ctx.toolUseId,
        emit: () => entry.ctx.emit,
        exitMessage: 'pi target process exited unexpectedly',
        logTag: 'CrossEngineDispatcher',
        now: () => this.now()
      })
    } catch (err) {
      // A new target that never started is over; a resume that failed to start is retried.
      if (!resume) this.ledgerSet(row.id, { state: 'failed' })
      throw err
    }
    entry.sessionId = entry.runner.sessionId
    // The model continues this target by the id pi reports; the row answers to it.
    if (entry.sessionId !== harnessId) this.ledgerSet(row.id, { harnessRef: entry.sessionId })
    this.targets.set(entry.sessionId, entry)
    return entry
  }

  /** A pi target's `hand_back` call as its bridge host answers it (the one hosted tool a target has). */
  private piHandBackResult(
    entry: PiTargetEntry,
    input: Record<string, unknown>,
    toolCallId: string
  ): PiHostedToolResult {
    const answer = this.receiveHandBack(entry, input.report, toolCallId)
    return {
      content: [{ type: 'text', text: answer.text }],
      ...(answer.isError ? { isError: true } : { terminate: true })
    }
  }

  /**
   * Gate handler for a pi dispatch target's PiBridgeHost (the two-stage
   * approval gate, ADR-033 M4c) — mirrors `awaitClaudeTargetApproval`'s
   * ROLE (forward an 'ask' to the dispatching session, resolve a local
   * Promise) with an extra stage IN FRONT of it: `permission-engine.decideWithSource()`
   * runs FIRST against the parent's LIVE mode (`entry.ctx.getAutonomyMode()`,
   * ADR-088 ruling 3) with the user's DENY and ASK rules only (ADR-085 §3 —
   * never their allow rules or "allow for this session" clicks: a dispatched
   * target does not inherit what the user pre-approved for their own chats)
   * + an empty sessionAllows set — so 'allow' resolves immediately (no
   * round-trip). The ask-rule rung precedes the mode base, so a user ask rule
   * still asks and a user deny rule refuses with the rule in every mode.
   *
   * ADR-088 — under a JUDGED auto mode (the parent in `auto`/`full` and pi's
   * `autoMode.enabled` not false) the ladder decides from the `acceptEdits`
   * base, exactly as PiSession does for itself, and an 'ask' goes to
   * ClaudeUI's judge (`DispatchTargetJudge`, the shared pipeline) instead of
   * the human: a user ask rule (G9) still reaches the human with zero judge
   * calls; the judge's allow is the decision, and its block is held on the
   * forwarded card (ADR-091 §3: Keep blocked / Approve anyway, Keep blocked on
   * expiry); anything it cannot decide (unavailable, denial cap, the mode left
   * auto meanwhile) goes to the human.
   * With pi's judge disabled, auto stays the historical allow-all base.
   *
   * A 'deny' is either a user deny rule (reported with the rule) or the mode
   * base (plan mode's read-only refusals, `exit_plan` outside plan mode) —
   * 'Denied by dispatch autonomy mode'.
   *
   * `toolUseId` on the forwarded approval is the pi tool call's OWN id
   * (`payload.toolCallId`), NOT the outer dispatching `ctx.toolUseId` —
   * verified against the renderer's `FloatingApproval.useUnmatchedApprovals`,
   * which only ever matches a `PendingApproval.toolUseId` against TOP-LEVEL
   * message tool_use ids; a dispatch target's inner tool_use ids never appear
   * there (they live in the subagent-scoped message bucket), so an inner id is
   * required for the approval to render at all (as a floating card) — this is
   * exactly what `awaitClaudeTargetApproval` does with `opts.toolUseId`
   * (the target's own tool_use id), not `entry.ctx.toolUseId`.
   *
   * `suggestions` ("always allow" scope checkboxes) are deliberately OMITTED:
   * Claude's mirror gets them for free via cli.js's canUseTool context;
   * building the pi equivalent would mean either reimplementing PiSession's
   * private `buildApprovalSuggestions` here or exporting/refactoring it out
   * of PiSession.ts, which the kickoff spec says not to revisit for M4c. The
   * approval still fully functions via Allow/Deny — only the persistent
   * "always allow" convenience is missing, and it would write an ALLOW rule to
   * the shared Claude permission files, whose allow tier a dispatch target's
   * gate deliberately does NOT consult, so its practical value would be
   * limited to a future INTERACTIVE pi session, not this or a future dispatch.
   */
  private async gatePiTargetToolCall(
    entry: PiTargetEntry,
    payload: PiToolCallPayload
  ): Promise<GateDecision> {
    // The report is the run's end, not an action: never judged, never asked (ADR-105 §3).
    // (A call after the run ended is refused by the hosted-tool handler itself.)
    if (payload.toolName === HAND_BACK_TOOL && entry.handBack) return { behavior: 'allow' }
    // See PiChildRunner.draining's doc comment — a late 'ask' from an already
    // stopped/timed-out/aborted turn must never register a pending approval.
    if (entry.runner.draining) return { behavior: 'deny', reason: 'Dispatch stopped' }
    const mode = liveMode(entry.ctx)
    const auto = entry.judge.autoModeActive(mode)
    // The X-Agent's message to its dispatcher (ADR-105 §4) is the X-Agent's own action. Outside a
    // judged auto mode it needs no card (the service enforces who it may reach), as `hand_back`
    // needs none; in one it goes through the ladder below and its judge like any other tool, as the
    // agent-authored message to the spawning agent it is (a block refuses the send: nothing is
    // delivered, and the denial counts toward the target's caps).
    const isMessage = payload.toolName === X_AGENT_MESSAGE_TOOL && entry.canMessage
    if (isMessage) {
      // The user's deny rule for the tool (written for Claude's spelling of it) holds here as it
      // does for the other engines' targets, whatever the mode.
      const denied = sessionToolDenyRule(
        X_AGENT_MESSAGE_TOOL,
        payload.input,
        this.userDenyAsk(entry.cwd, entry.ctx.callerRestriction),
        entry.cwd
      )
      if (denied) return { behavior: 'deny', reason: `Denied by permission rule: ${denied}` }
      if (!auto) return { behavior: 'allow' }
    }
    // `userDenyAsk` carries no allow tier, so PiSession's `withoutAllowRules`
    // step would be a no-op here — not called.
    const verdict = decideWithSource(payload.toolName, payload.input, {
      mode: auto ? 'acceptEdits' : mode,
      rules: this.userDenyAsk(entry.cwd, entry.ctx.callerRestriction),
      sessionAllows: EMPTY_PI_SESSION_ALLOWS,
      // The acceptEdits base matches agent-control paths cwd-relative
      // (ADR-084 §3); without it an absolute path inside a target running in a
      // `.claude/worktrees/<name>` checkout would ask on every edit.
      cwd: entry.cwd,
      // pi sanitizes MCP tool names (its own mcp.json servers run here too):
      // a user's Claude-form deny/ask rule must still match (ADR-096).
      mcpRuleKey: piMcpRuleKey
    })

    if (verdict.decision === 'allow') return { behavior: 'allow' }
    if (verdict.decision === 'deny') {
      return {
        behavior: 'deny',
        reason:
          verdict.source === 'deny-rule'
            ? `Denied by permission rule: ${verdict.rule}`
            : 'Denied by dispatch autonomy mode'
      }
    }

    if (!auto) return this.forwardPiTargetAsk(entry, payload)
    // G9 — a user-authored ask rule outranks the judge (zero judge calls).
    if (verdict.source === 'ask-rule') {
      logger.info(
        'CrossEngineDispatcher',
        `pi target: auto-mode → human: user ask rule matches ${payload.toolName} (${verdict.rule})`
      )
      return this.forwardPiTargetAsk(entry, payload)
    }
    const outcome = await entry.judge.judge(
      {
        toolUseId: payload.toolCallId,
        toolName: payload.toolName,
        input: payload.input,
        ...(isMessage ? { agentMessage: true } : {})
      },
      {
        currentMode: () => liveMode(entry.ctx),
        stillPending: () =>
          !entry.runner.draining &&
          entry.sessionId !== null &&
          this.targets.get(entry.sessionId) === entry,
        honoursWorkdir: false,
        permissions: () => this.userDenyAsk(entry.cwd, entry.ctx.callerRestriction)
      }
    )
    // Stopped while the judge ran: never forward a drained ask.
    if (entry.runner.draining) return { behavior: 'deny', reason: 'Dispatch stopped' }
    switch (outcome.kind) {
      case 'allow':
        return { behavior: 'allow' }
      case 'hold': {
        // ADR-091 part 6 — recorded at the dispatching session; with no hold
        // window it is kept at once, through the Keep blocked path.
        const ms = blockHoldMs()
        recordTargetBlock(
          entry.ctx,
          payload.toolCallId,
          payload.toolName,
          payload.input,
          outcome.review,
          {
            engine: 'pi',
            label: entry.model,
            cwd: entry.cwd,
            xAgentRef: entry.ledgerId,
            held: ms > 0,
            deliver: (call) => this.deliverToPiTarget(entry, call)
          }
        )
        if (ms === 0) {
          return {
            behavior: 'deny',
            reason: keepTargetBlock(entry.judge, payload.toolCallId, outcome.reason)
          }
        }
        return this.forwardPiTargetAsk(entry, payload, outcome.reason, {
          reason: outcome.reason,
          ms
        })
      }
      case 'human':
        return this.forwardPiTargetAsk(entry, payload, outcome.reason)
      case 'settled':
        return { behavior: 'deny', reason: 'Dispatch stopped' }
    }
  }

  /**
   * ADR-091 part 6 — the user approved one of a pi target's blocked calls
   * after the fact. While that dispatch is still in flight the target takes
   * the nudge itself, through its runner's `/cui-deliver` (the pi child
   * delivery path), at its next tool round; returns who took it. Null once
   * the dispatch finished (or is stopping): the dispatching agent is nudged
   * instead, and can dispatch the call back with the same session id.
   */
  private deliverToPiTarget(entry: PiTargetEntry, call: BlockedCall): string | null {
    if (
      !entry.busy ||
      entry.runner.draining ||
      entry.sessionId === null ||
      this.targets.get(entry.sessionId) !== entry
    ) {
      return null
    }
    const deliveryId = uuidv4()
    logger.info(
      'CrossEngineDispatcher',
      `pi target: block approval ${deliveryId} → ${entry.sessionId}`
    )
    void entry.runner.deliver({
      v: 1,
      deliveryId,
      kind: 'agent-message',
      text: blockApprovalNotice(blockedCallDelivery(call, true)),
      wake: true,
      title: 'Message from you',
      details: {
        agentId: entry.sessionId,
        toolUseId: entry.ctx.toolUseId ?? '',
        from: 'user',
        fromId: 'user'
      }
    })
    return `"${entry.model}"`
  }

  /**
   * A pi target's ask to the human: a card on the DISPATCHING session, mirrors
   * awaitClaudeTargetApproval. `decisionReason` is auto mode's denial-cap
   * sentence when the judge handed the call back (ADR-088), or the judge's deny
   * text on a held block; `block` makes it a held judge block (ADR-091 §3) —
   * the deny text a kept block answers with, and the hold window.
   */
  private forwardPiTargetAsk(
    entry: PiTargetEntry,
    payload: PiToolCallPayload,
    decisionReason?: string,
    block?: { reason: string; ms: number }
  ): Promise<GateDecision> {
    return new Promise((resolve) => {
      const requestId = XENG_REQUEST_PREFIX + uuidv4()
      const held = block
        ? this.armForwardedHold(requestId, entry.ctx, entry.judge, payload.toolCallId, block)
        : null
      const approval: PendingApproval = {
        requestId,
        toolUseId: payload.toolCallId,
        toolName: payload.toolName,
        input: payload.input,
        ...(entry.sessionId
          ? { agent: { agentId: entry.sessionId, label: entry.model, subagentType: 'dispatch:pi' } }
          : {}),
        ...(held ? { autoModeBlock: held.autoModeBlock } : {}),
        ...(decisionReason ? { decisionReason } : {})
      }
      this.pendingApprovals.set(requestId, {
        kind: 'pi',
        targetSessionId: entry.sessionId,
        emit: entry.ctx.emit,
        card: approval,
        ...(held ? { hold: held.hold } : {}),
        resolve: (decision, answers) => {
          if (decision === 'allow' || decision === 'allowForSession') {
            resolve({ behavior: 'allow' })
          } else {
            resolve({ behavior: 'deny', reason: answers?.feedback || 'User denied' })
          }
        }
      })
      entry.ctx.emit('session:approval-request', approval)
    })
  }

  // ── codex direction (slice H) ─────────────────────────────────────────────

  /**
   * Everything past the guards for engine:'codex' — runs with an
   * run slot held and the Stop handle already registered (same
   * preamble as the other three directions).
   */
  private async resolveAndRunCodex(
    req: DispatchRequest,
    ctx: RunContext,
    stopController: AbortController
  ): Promise<DispatchResult> {
    // ── Model resolution ──────────────────────────────────────────────────
    // DELIBERATELY UNLIKE the claude and pi branches, a model is NOT required
    // here. Those two must demand one because a spawned target's actual model
    // is unknowable until after the process is up, which would make a
    // configured `allowedModels` unenforceable. Codex has no such problem: the
    // catalog (`model/list`) and the user's own configured default
    // (`config/read`) both arrive on the target's connection BEFORE any thread
    // exists, so `createCodexTarget` resolves the model first and checks the
    // allowlist against the RESOLVED id — the allowlist stays exactly as
    // honest, and a user who has not configured `engines/codex.json` can still
    // be dispatched into.
    const dispatchCfg = this.deps.loadEngineConfig('codex').dispatch
    const requestedModel = req.model ?? dispatchCfg?.defaultModel
    const allowed = dispatchCfg?.allowedModels
    // Checked HERE as well as post-resolution so an explicitly-requested model
    // outside the allowlist is refused with the SAME bare sentence the other
    // targets use, before a process is even spawned. The post-resolution check
    // inside `createCodexTarget` is what covers the fall-back-to-the-catalog
    // -default path, where there is nothing to check until the catalog lands.
    const earlyDenial = codexModelAllowlistDenial(requestedModel, allowed)
    if (earlyDenial) return errorResult(earlyDenial)

    // ── Target resolution ─────────────────────────────────────────────────
    let entry: CodexTargetEntry
    if (req.sessionId) {
      // NOT a `thread/resume` of whatever the id names. `req.sessionId` is
      // model-authored text: resuming it blindly would let a dispatched-from agent
      // reopen ANY Codex thread on disk — including the user's own interactive
      // sessions — under a dispatch target's policy envelope, with no ownership
      // check available to refuse it. Only a live entry this caller owns, or a LEDGER
      // row this caller owns (a thread this dispatcher created for it), continues
      // (ADR-066's caller-bound identity); `findContinuation` refuses everything else.
      const cont = this.findContinuation(req.sessionId, ctx, 'codex')
      if (!cont) {
        return errorResult(
          `Unknown dispatch session "${req.sessionId}" — it may have been disposed. ` +
            'Start a new X-Agent with dispatch_agent.'
        )
      }
      if ('live' in cont && cont.live.busy) {
        return errorResult(
          `Dispatch session "${req.sessionId}" is already running a turn — wait for it to finish before continuing it.`,
          req.sessionId
        )
      }
      const spent = this.continuationSpend(cont, dispatchCfg, req.sessionId, 'codex')
      if ('text' in spent) return spent
      const spentUsd = spent.costUsd
      if ('row' in cont) {
        const refusal = this.resumeModelRefusal('codex', cont.row.model, dispatchCfg)
        if (refusal) return refusal
      }
      if ('live' in cont) {
        this.bindContinuation(ctx, cont)
        cont.live.ctx = ctx
        entry = cont.live
      } else {
        try {
          // The wait for the thread's lock ends at once on a Stop or the caller's abort.
          this.bindContinuation(ctx, cont)
          entry = await this.createCodexTarget(ctx, undefined, undefined, cont.row, [
            stopController.signal,
            ctx.run.cancelController.signal
          ])
        } catch (err) {
          // A thread Codex has no rollout for will never resume; a busy host, a lost
          // connection or a stop is worth another try.
          if (/no rollout found/i.test(errText(err)))
            this.ledgerSet(cont.row.id, { state: 'failed' })
          return errorResult(
            `Failed to resume dispatched codex agent: ${errText(err)}`,
            req.sessionId
          )
        }
        entry.cumulativeCostUsd = spentUsd
      }
    } else {
      try {
        entry = await this.createCodexTarget(ctx, requestedModel, allowed, undefined, [], req)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return errorResult(`Failed to start dispatched codex agent: ${msg}`)
      }
    }

    const model = entry.model
    // The report review's subagent task is the LATEST dispatch prompt (ADR-088's rule for the judge).
    entry.lastPrompt = req.prompt
    const turn = async (prompt: string | null): Promise<TurnReturn> => {
      entry.busy = true
      this.ledgerTurnState(entry, 'running')
      entry.turnToolUseIds = new Set()
      const turnStartedAt = this.now()
      entry.lastActivityAt = turnStartedAt

      // ── Run the turn ──────────────────────────────────────────────────────
      const heartbeat = this.startHeartbeat(ctx)

      const signal = ctx.run.cancelController.signal
      let abortListener: (() => void) | undefined

      type Raced =
        | { kind: 'ok'; outcome: Extract<CodexTurnOutcome, { kind: 'ok' }> }
        | { kind: 'err'; message: string }
        | TurnTimeout
        | { kind: 'abort' }
        | { kind: 'stop' }
        | { kind: 'report' }

      const reportToolDone = new Promise<void>((resolve) => {
        entry.reportToolDone = resolve
      })
      const turnPromise: Promise<Raced> = this.driveCodexTurn(entry, prompt as string).then(
        (outcome): Raced =>
          outcome.kind === 'ok'
            ? { kind: 'ok', outcome }
            : { kind: 'err', message: outcome.message }
      )
      // Turn liveness: the TARGET engine's two configured caps, unlimited unless
      // the user set them (ADR-033's 2026-09-18 amendment).
      // `handleCodexTargetNotification` is what bumps `entry.lastActivityAt`.
      const caps = resolveTurnLiveness(dispatchCfg)
      const watchdog = this.startTurnWatchdog(entry, caps, turnStartedAt, () =>
        this.hasPendingApprovalFor(entry.sessionId)
      )
      const timeoutPromise: Promise<Raced> = watchdog.promise
      const abortPromise: Promise<Raced> = signal
        ? signal.aborted
          ? Promise.resolve({ kind: 'abort' })
          : new Promise((resolve) => {
              abortListener = (): void => resolve({ kind: 'abort' })
              signal.addEventListener('abort', abortListener, { once: true })
            })
        : new Promise(() => {})
      const stopPromise: Promise<Raced> = stopController.signal.aborted
        ? Promise.resolve({ kind: 'stop' })
        : new Promise((resolve) => {
            stopController.signal.addEventListener('abort', () => resolve({ kind: 'stop' }), {
              once: true
            })
          })

      // The agent handed its report back (ADR-105 §3): the run is over, the turn is to end.
      const reportPromise: Promise<Raced> = ctx.run.reported.then((): Raced => ({ kind: 'report' }))

      let endState: DispatchTargetState = 'idle'
      try {
        const raced = await Promise.race([
          turnPromise,
          timeoutPromise,
          abortPromise,
          stopPromise,
          reportPromise
        ])
        let winner: Exclude<Raced, { kind: 'report' }>
        if (raced.kind === 'report') {
          // Let the tool result reach the agent (an interrupt first would cancel the call
          // itself), then end the turn: the report is the result, whatever it would say next.
          // A turn that ended by itself meanwhile needs no interrupt (and its own outcome stands).
          const how = await this.untilReportToolDone(reportToolDone, turnPromise)
          let ended: Raced | undefined
          if (how === 'turn') ended = await turnPromise
          else {
            entry.draining = true
            await this.interruptCodexTurn(entry)
          }
          winner =
            ended?.kind === 'ok'
              ? ended
              : {
                  kind: 'ok',
                  outcome: {
                    kind: 'ok',
                    text: entry.lastAgentText || '(the dispatched agent returned no text)',
                    durationMs: Math.max(0, Date.now() - entry.turnStartedAtMs)
                  }
                }
        } else winner = raced

        if (winner.kind === 'timeout' || winner.kind === 'abort' || winner.kind === 'stop') {
          // FIRST and synchronously, before any RPC leaves: no approval request
          // from this turn can then race ahead of the flag.
          entry.draining = true
          await this.interruptCodexTurn(entry)
          const usage = this.accountCodexTurn(entry, ctx)
          if (entry.sessionId) this.dismissPendingForTarget(entry.sessionId)
          const text =
            winner.kind === 'timeout'
              ? turnTimeoutText(winner.reason, caps, CODEX_TIMEOUT_AFTERMATH)
              : winner.kind === 'stop'
                ? 'Dispatch stopped by user.'
                : 'Dispatch cancelled.'
          const status = winner.kind === 'timeout' ? 'failed' : 'stopped'
          ctx.run.timedOut = winner.kind === 'timeout'
          emitDispatchNotification(ctx, entry.sessionId ?? '', status, text)
          // Same row-vs-spend split as the pi direction: a 'stopped' turn gets no
          // usage ROW (ADR-033 M4-B), but whatever it spent before the stop is
          // still folded into the cap and the caller's breakdown above.
          if (status === 'failed') {
            this.safeRecordUsage({
              ts: this.now(),
              fromRoutingId: ctx.fromRoutingId,
              targetEngine: 'codex',
              targetModel: model,
              targetSessionId: entry.sessionId,
              toolUseId: ctx.toolUseId ?? null,
              ...(usage.tokens ? { tokens: usage.tokens } : {}),
              account: entry.account,
              // codexTurnCostUsd is OUR table's equivalent, not a charge
              // (ADR-066: a ChatGPT-subscription charge is unknowable here),
              // so the ledger derives the API cost from the split above.
              engineCostIsEquivalent: true
            })
          }
          return errorResult(text, entry.sessionId ?? '')
        }

        if (winner.kind === 'err') {
          endState = 'failed'
          // The thread is NOT torn down: a failed turn (a refused `turn/start`, a
          // `turn/completed` carrying an error) leaves the app-server and the
          // thread alive, and a genuinely dead process self-diagnoses on the next
          // continuation (`CodexAppServerClient.request` rejects `not-ready`).
          if (entry.sessionId) this.dismissPendingForTarget(entry.sessionId)
          const usage = this.accountCodexTurn(entry, ctx)
          emitDispatchNotification(
            ctx,
            entry.sessionId ?? '',
            'failed',
            `Dispatched turn failed: ${winner.message}`
          )
          this.safeRecordUsage({
            ts: this.now(),
            fromRoutingId: ctx.fromRoutingId,
            targetEngine: 'codex',
            targetModel: model,
            targetSessionId: entry.sessionId,
            toolUseId: ctx.toolUseId ?? null,
            ...(usage.tokens ? { tokens: usage.tokens } : {}),
            account: entry.account,
            // codexTurnCostUsd is OUR table's equivalent, not a charge
            // (ADR-066: a ChatGPT-subscription charge is unknowable here),
            // so the ledger derives the API cost from the split above.
            engineCostIsEquivalent: true
          })
          return errorResult(`Dispatched turn failed: ${winner.message}`, entry.sessionId ?? '')
        }

        // ── Success ────────────────────────────────────────────────────────
        const { outcome } = winner
        const maxCostUsd = dispatchCfg?.maxCostUsd
        const wasUnderCap = maxCostUsd === undefined || entry.cumulativeCostUsd < maxCostUsd
        const usage = this.accountCodexTurn(entry, ctx)
        let outText = outcome.text
        if (maxCostUsd !== undefined && wasUnderCap && entry.cumulativeCostUsd >= maxCostUsd) {
          outText +=
            '\n\n[dispatch cost cap reached — further turns on this session will be rejected]'
        }

        await this.settleReview(ctx.run)
        const done = this.finishTurn(ctx, 'codex', model, entry, entry.sessionId ?? '', {
          finalText: outcome.text,
          outText,
          usage: {
            totalTokens: usage.totalTokens ?? 0,
            toolUses: entry.turnToolUseIds.size,
            durationMs: outcome.durationMs
          }
        })
        this.safeRecordUsage({
          ts: this.now(),
          fromRoutingId: ctx.fromRoutingId,
          targetEngine: 'codex',
          targetModel: model,
          targetSessionId: entry.sessionId,
          toolUseId: ctx.toolUseId ?? null,
          ...(usage.tokens ? { tokens: usage.tokens } : {}),
          account: entry.account,
          // codexTurnCostUsd is OUR table's equivalent, not a charge
          // (ADR-066: a ChatGPT-subscription charge is unknowable here),
          // so the ledger derives the API cost from the split above.
          engineCostIsEquivalent: true
        })
        return done
      } finally {
        if (ctx.toolUseId) this.sealCodexTargetItems(entry, ctx.toolUseId)
        entry.reportToolDone = null
        entry.busy = false
        this.ledgerTurnState(entry, endState)
        clearInterval(heartbeat)
        watchdog.dispose()
        if (signal && abortListener) signal.removeEventListener('abort', abortListener)
      }
    }
    return this.runWithNudges(
      ctx,
      {
        sessionId: () => entry.sessionId ?? '',
        engine: 'codex',
        toolName: HAND_BACK_TOOL,
        cumulativeCostUsd: () => entry.cumulativeCostUsd
      },
      this.taskText(entry, ctx, req.prompt, HAND_BACK_TOOL),
      turn
    )
  }

  /** Bounded wait — `promise`, or `undefined` once the grace period elapses. */
  private async withinCodexGrace<T>(promise: Promise<T>): Promise<T | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        promise,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), this.codexAbortSettleGraceMs)
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * End the turn currently in flight on a give-up path (timeout/abort/stop) and
   * retire it so nothing it still emits can settle a LATER turn.
   *
   * The turn id is the whole problem. `turn/interrupt` is `{threadId, turnId}`,
   * and a stop can land while `turn/start` is still in flight — at which point
   * `entry.turnId` is null and the turn cannot be named. Leaving it at that
   * would be worse than a leaked promise: the turn keeps running headless, and
   * the next continuation's `turn/start` would STEER that zombie instead of
   * opening a fresh turn (the app-server routes both through
   * `start_or_steer_turn`). So the id is waited for, BOUNDED, and so is the
   * interrupt's own acknowledgement — `turn/interrupt` only answers once the
   * native `TurnAborted` has landed, which is the signal that a continuation is
   * safe; a wedged target must not hold the user's Stop open for it.
   */
  private async interruptCodexTurn(entry: CodexTargetEntry): Promise<void> {
    const turnId = entry.turnId ?? (await this.withinCodexGrace(entry.turnStarted)) ?? null
    if (turnId && entry.sessionId) {
      entry.endedTurns.add(turnId)
      entry.connection.abortServerRequests(entry.sessionId, turnId)
      await this.withinCodexGrace(
        entry.connection
          .request('turn/interrupt', { threadId: entry.sessionId, turnId })
          .then(() => undefined)
          .catch(() => undefined)
      )
    }
    // Belt-and-braces if the id never arrived: `draining` (already set by the
    // caller) still refuses late approval requests, and nulling the resolver
    // here means a stale `turn/completed` cannot settle anything.
    entry.settled = null
    entry.turnId = null
  }

  /**
   * Close this turn's token/cost accounting and return what the turn spent.
   * Shared by EVERY outcome (success, error, timeout, stop) — a
   * turn that spent real tokens before dying still counts toward the cap and
   * the dispatching session's own breakdown, exactly like a successful one.
   *
   * `thread/tokenUsage/updated` reports the thread's CUMULATIVE `total` (its
   * `last` is the last REQUEST's context window, not a per-turn figure — see
   * `CodexSession.emitMetering`, which uses it for exactly that), so a turn's
   * own numbers are the delta against the baseline left by the previous turn.
   *
   * The USD figure is the API-rate EQUIVALENT, never a charge: a
   * ChatGPT-subscription turn's true cost is unknowable from here (ADR-066), so
   * this is the same number Codex's own status line shows. A model with no
   * published price yields `null`, which means UNKNOWN and is deliberately not
   * coerced to 0: the cap must not count a guess, and a 0 reads as a free
   * turn. The ledger row prices the SPLIT rather than taking this figure, by
   * the same rule as every other row. `ctx.addDispatchedCost` does take
   * `?? 0`, because its signature is a plain number with no "unknown" and a
   * guessed price would be worse than a missing one.
   */
  private accountCodexTurn(
    entry: CodexTargetEntry,
    ctx: DispatchContext
  ): { totalTokens: number | null; tokens?: UsageTurnTokens } {
    const delta = codexUsageDelta(entry.usageTotal, entry.usageBaseline)
    entry.usageBaseline = entry.usageTotal
    // No frame has been seen for this thread at all — the turn's tokens are
    // UNKNOWN, which is why the split is left off the ledger row entirely
    // rather than recorded as four zeros.
    if (!delta) return { totalTokens: null }
    const costUsd = codexTurnCostUsd(entry.model, delta)
    if (costUsd !== null && costUsd > 0) {
      entry.cumulativeCostUsd += costUsd
      ctx.addDispatchedCost?.('codex', entry.model, costUsd)
    }
    return {
      totalTokens: delta.totalTokens > 0 ? delta.totalTokens : null,
      // A Codex turn's split is `CodexSession`'s own mapping, imported rather
      // than restated: the row's priced API cost then cannot drift from the
      // figure `codexTurnCostUsd` just put through the cap.
      tokens: codexDisjointTokens(delta)
    }
  }

  /**
   * Which ChatGPT subscription a Codex target's turns are billed to (ADR-071
   * §3) — the SAME account the thread is attached under, so the ledger agrees
   * with who actually pays: the caller's pin when it has one, the vault's
   * active account otherwise (ADR-068 §2).
   *
   * Without vault accounts (`codexVaultAccounts` false — every unit test, and
   * any build that does not own Codex's credentials) the vault is not read at
   * all and the answer is `codex:openai:native`: Codex signed in on its own,
   * which is exactly what ADR-071 §3's native key means.
   *
   * The billing type is `subscription` only when the identity really is a
   * ChatGPT one. A native sign-in is NOT assumed to be an API key: Codex's own
   * login is usually a ChatGPT plan too, and calling it `apiKey` would put an
   * API-equivalent figure into `billed_cost_usd` as though money had moved
   * (ADR-030 — unknown is never dressed up as a fact).
   */
  private async codexDispatchAccount(accountId: string | null): Promise<DispatchTurnAccount> {
    if (!this.codexVaultAccounts) return { ...codexNativeIdentity(), billingType: 'unknown' }
    try {
      const identity = await credentialSync.accountIdentity(accountId)
      return {
        ...identity,
        billingType: identity.accountKey.startsWith('chatgpt:') ? 'subscription' : 'unknown'
      }
    } catch (err) {
      // Never fail a dispatch over an attribution read (and never log what it
      // was reading) — an unattributed row is the honest fallback.
      logger.debug(
        'CrossEngineDispatcher',
        `codex account identity unavailable: ${err instanceof Error ? err.message : String(err)}`
      )
      return UNKNOWN_DISPATCH_ACCOUNT
    }
  }

  /**
   * Spawn the target's app-server, resolve its model against the native
   * catalog, and open the thread its policy envelope is written into. Any
   * failure disposes whatever was created and re-throws — `resolveAndRunCodex`
   * turns that into a friendly isError.
   *
   * THE POLICY ENVELOPE (ADR-066, slice H). All three native knobs are set
   * HERE, on `thread/start`, as the creation-time baseline — and, since
   * ADR-088, re-sent on every `turn/start` for the parent's LIVE mode
   * (`driveCodexTurn`; `TurnStartParams` overrides all three "for this turn and
   * subsequent turns"). The rows come from the
   * SAME table `CodexSession` uses (`codex-turn-policy.ts`), so a dispatched
   * agent is policed exactly like an interactive one:
   *
   *   plan        -> untrusted + read-only        + reviewer 'user'
   *   default     -> untrusted + workspace-write  + reviewer 'user'
   *   acceptEdits -> untrusted + workspace-write  + reviewer 'user'
   *   auto        -> on-request + workspace-write + reviewer 'auto_review'
   *
   * `untrusted` is what makes the three non-auto rows work for a target with no
   * human of its own: it is the one policy the pinned binary asks before
   * running ANYTHING, so every command and patch arrives as a server request
   * for `gateCodexTargetRequest` to answer — under `plan` the shared engine
   * denies every write/command outright (nothing is forwarded, nothing waits),
   * and under `default`/`acceptEdits` an `ask` is forwarded to the CALLER's
   * client, where a human is already watching the dispatching session. `auto`
   * is the one row that does NOT route to us: `auto_review` answers natively
   * and only escalations reach the gate. NEVER `never`/bypass — an autonomous
   * mode must still be reviewed by someone, which is precisely what
   * `auto_review` is.
   *
   * `dynamicTools`: only `hand_back` (ADR-105 §3) and `session_message` (§4) — the target has no
   * `dispatch_agent` (no recursion) and no other hosted tools. See `CODEX_TARGET_SERVER_METHODS` for the
   * transport-level half of the same scrub.
   */
  private async createCodexTarget(
    ctx: RunContext,
    requestedModel: string | undefined,
    allowedModels: string[] | undefined,
    resume?: DispatchTargetRow,
    signals: ReadonlyArray<AbortSignal | undefined> = [],
    labels?: DispatchLabels
  ): Promise<CodexTargetEntry> {
    // A resumed thread lives on the host of the account it was created under (ADR-105):
    // the row's vault account id, not the (possibly different) caller's pin now.
    const accountId = resume ? resume.codexAccountId : (ctx.chatgptAccountId ?? null)
    const cwd = resume?.cwd ?? ctx.cwd
    const skillCatalog = resolveClaudeSkills(cwd)
    if (skillCatalog.warnings.length)
      logger.warn('CrossEngineDispatcher', skillCatalog.warnings.join('\n'))
    const entry: CodexTargetEntry = {
      kind: 'codex',
      skillCatalog,
      skillCatalogUpdatePending: !!resume,
      reportToolDone: null,
      sessionId: null,
      // Set once the thread exists (a new target's row needs its id).
      ledgerId: resume?.id ?? '',
      released: false,
      // A thread keeps the tools it was started with: a resumed row has the tool only if it was started with it.
      handBack: this.requireHandBack && (resume ? resume.handBack : true),
      canMessage: sessionToolsAvailable(),
      fromRoutingId: ctx.fromRoutingId,
      cwd,
      // Filled in below, once the attach resolves. The notification and gate
      // closures capture `entry` BY REFERENCE (mirrors createPiTarget), so
      // building them first is safe: nothing is routed to this owner before it
      // claims a thread anyway.
      connection: undefined as unknown as CodexThreadConnection,
      ctx,
      autonomyMode: liveMode(ctx),
      model: '',
      lastPrompt: '',
      // Replaced below, once the account behind the host is known.
      account: UNKNOWN_DISPATCH_ACCOUNT,
      busy: false,
      turnId: null,
      turnStarted: Promise.resolve(null),
      endedTurns: new Set(),
      settled: null,
      draining: false,
      lastActivityAt: 0,
      turnToolUseIds: new Set(),
      usageTotal: null,
      usageBaseline: null,
      observeUsageBaseline: !!resume,
      cumulativeCostUsd: 0,
      completedItems: new Map(),
      itemTimestamps: new Map(),
      activeStreamItems: new Map(),
      fileChanges: new Map(),
      lastAgentText: '',
      turnStartedAtMs: 0
    }

    // A dispatch target bills the same subscription the caller runs on: the
    // caller's PIN when it has one, the ACTIVE account otherwise (ADR-068 §2).
    // Which is also which HOST it lands on, since a host IS one identity.
    entry.account = await this.codexDispatchAccount(accountId)
    entry.connection = await this.attachCodexTarget({
      cwd,
      label: 'dispatch-target',
      ...(this.codexVaultAccounts ? { identity: { accountId } } : {}),
      onNotification: (method, params) => this.handleCodexTargetNotification(entry, method, params),
      onServerRequest: (method, params, context) =>
        this.gateCodexTargetRequest(entry, method, params, context),
      onDisconnect: (error: CodexTransportError) => {
        // If a turn is in flight, nothing else will ever settle it — mirrors
        // the pi target's onExit.
        const settle = entry.settled
        entry.settled = null
        settle?.({ kind: 'error', message: `codex target disconnected (${error.code})` })
      }
    })

    try {
      if (resume) {
        const policy = codexModePolicy(entry.autonomyMode)
        const response = await this.resumeCodexThread(
          entry.connection,
          {
            threadId: resume.harnessRef,
            cwd,
            model: resume.model,
            developerInstructions: this.codexDispatchSkillGuidance(entry),
            approvalPolicy: policy.approvalPolicy,
            sandbox: policy.sandbox,
            approvalsReviewer: policy.approvalsReviewer,
            excludeTurns: true
          },
          signals
        )
        assertCodexProvider(response.modelProvider)
        if (response.thread.id !== resume.harnessRef)
          throw new Error('Codex resumed a different native thread')
        if (response.thread.parentThreadId)
          throw new Error('Codex resumed a dispatch target as a native child thread')
        entry.model = response.model
        entry.sessionId = response.thread.id
        entry.connection.claim(entry.sessionId)
        this.targets.set(entry.sessionId, entry)
        return entry
      }
      const { config } = await entry.connection.request('config/read', {
        cwd,
        includeLayers: false
      })
      assertCodexProvider(config.model_provider)
      const catalog: Model[] = []
      const cursors = new Set<string>()
      let cursor: string | null = null
      for (let page = 0; ; page++) {
        if (page === CODEX_CATALOG_PAGE_LIMIT) throw new Error('Codex catalog page limit')
        const result = await entry.connection.request('model/list', {
          cursor,
          limit: 100,
          includeHidden: false
        })
        catalog.push(...result.data)
        if (!result.nextCursor) break
        if (cursors.has(result.nextCursor)) throw new Error('Codex repeated catalog cursor')
        cursors.add(result.nextCursor)
        cursor = result.nextCursor
      }
      const model = selectCodexModel(catalog, config.model, requestedModel)
      if (model === undefined) {
        throw new Error(
          'Codex reported no usable model for a dispatch target. Ask the user to set ' +
            'Settings › Cross-engine dispatch › Dispatch into › Codex (the `dispatch.defaultModel` field in ' +
            '~/.claude/ui/engines/codex.json), or pass `model` explicitly.'
        )
      }
      // The catalog-default path: `requestedModel` was undefined, so nothing
      // was checkable until now. An explicitly requested model was already
      // refused by `resolveAndRunCodex` before this process was spawned.
      const denial = codexModelAllowlistDenial(model, allowedModels)
      if (denial) throw new Error(denial)

      const policy = codexModePolicy(entry.autonomyMode)
      const response = await entry.connection.request('thread/start', {
        cwd,
        model,
        developerInstructions: this.codexDispatchSkillGuidance(entry),
        approvalPolicy: policy.approvalPolicy,
        sandbox: policy.sandbox,
        approvalsReviewer: policy.approvalsReviewer,
        allowProviderModelFallback: false,
        historyMode: 'paginated',
        // The target's tools: the report that ends its run (ADR-105 §3) and `session_message` to its
        // dispatcher (§4). A thread keeps the tools it is started with, so only threads started with
        // them have them.
        ...(entry.handBack || entry.canMessage
          ? {
              dynamicTools: [
                ...(entry.handBack ? [codexHandBackSpec()] : []),
                ...(entry.canMessage ? [codexXAgentMessageSpec()] : [])
              ]
            }
          : {})
      })
      assertCodexProvider(response.modelProvider)
      if (response.model !== model) throw new Error('Codex silently changed the requested model')
      if (response.thread.parentThreadId)
        throw new Error('Codex opened a dispatch target as a native child thread')
      entry.model = response.model
      entry.sessionId = response.thread.id
      // The durable record (ADR-105), as soon as the thread exists: the Codex history
      // list skips ledger thread ids.
      entry.ledgerId = this.recordTarget(ctx, {
        engine: 'codex',
        harnessRef: entry.sessionId,
        model: entry.model,
        accountKey: entry.account.accountKey,
        codexAccountId: accountId,
        labels,
        handBack: this.requireHandBack
      }).id
      // Everything stamped with this thread id is this target's from here on,
      // and nothing else is (ADR-069 §2).
      entry.connection.claim(entry.sessionId)
      this.targets.set(entry.sessionId, entry)
    } catch (err) {
      if (entry.sessionId) this.targets.delete(entry.sessionId)
      entry.connection.detach()
      throw err instanceof Error ? err : new Error(String(err))
    }

    return entry
  }

  /**
   * `thread/resume` of a released target's thread, waiting out the writer lock of the
   * process that has not let go of it yet (ADR-069 §4): the thread stays LOADED — and
   * locked — until the binary unloads it, about a minute after its last subscriber
   * left, and a refusal (`-32600`) meanwhile is a normal step, not a failure. Bounded
   * by {@link DispatcherDeps.codexResumeLockWindowMs}; any other error fails at once.
   */
  private async resumeCodexThread(
    connection: CodexThreadConnection,
    params: CodexMethods['thread/resume']['params'],
    signals: ReadonlyArray<AbortSignal | undefined>
  ): Promise<CodexMethods['thread/resume']['result']> {
    const deadline = Date.now() + this.codexResumeLockWindowMs
    for (;;) {
      try {
        return await connection.request('thread/resume', params)
      } catch (err) {
        const code = isRecord(err) || err instanceof Error ? (err as { code?: unknown }).code : null
        // `-32600` is also "no rollout found": only a live host that still holds the thread
        // explains a lock, and only then is waiting worth it. Anything else fails at once.
        if (
          code !== CODEX_RESUME_LOCK_REFUSAL ||
          !this.codexHoldsThread(params.threadId) ||
          Date.now() >= deadline
        )
          throw err
        await this.abortableDelay(this.codexResumeLockRetryMs, signals)
      }
    }
  }

  /** Wait `ms`, or throw the moment one of `signals` aborts (a Stop, the caller's cancel). */
  private abortableDelay(
    ms: number,
    signals: ReadonlyArray<AbortSignal | undefined>
  ): Promise<void> {
    const live = signals.filter((signal): signal is AbortSignal => !!signal)
    const stopped = (): Error => new Error('the dispatch was stopped while waiting for the thread')
    if (live.some((signal) => signal.aborted)) return Promise.reject(stopped())
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        clearTimeout(timer)
        cleanup()
        reject(stopped())
      }
      const cleanup = (): void =>
        live.forEach((signal) => signal.removeEventListener('abort', onAbort))
      const timer = setTimeout(() => {
        cleanup()
        resolve()
      }, ms)
      live.forEach((signal) => signal.addEventListener('abort', onAbort, { once: true }))
    })
  }

  private codexDispatchSkillGuidance(entry: CodexTargetEntry): string {
    return [
      renderClaudeSkillCatalog(entry.skillCatalog),
      'When this thread is resumed, a later shared_claude_skills_update message with a revision replaces this catalog, including when its skill list is empty. Treat only the latest catalog as active.'
    ].join('\n\n')
  }

  private codexDispatchSkillInput(entry: CodexTargetEntry, prompt: string): string {
    const expanded = expandClaudeSkillInvocation(prompt, entry.skillCatalog)
    const catalog = entry.skillCatalogUpdatePending
      ? `<shared_claude_skills_update revision="${entry.skillCatalog.revision}">\n${renderClaudeSkillCatalog(entry.skillCatalog)}\nThis catalog supersedes earlier shared Claude skill catalogs for this thread.\n</shared_claude_skills_update>\n\n`
      : ''
    return expanded || catalog
      ? withOriginalSkillInput(prompt, catalog + (expanded?.text ?? prompt))
      : prompt
  }

  /**
   * Send `turn/start` and await turn completion.
   *
   * Shaped like `PiChildRunner.runTurn`, not `driveClaudeTurn`: notifications arrive on a
   * single ambient callback registered once for the target's lifetime, so there
   * is nothing to pull and no `.return()` hazard. Install `entry.settled` as
   * this promise's resolver BEFORE the request leaves (synchronously, so no
   * notification can beat it), then let the already-running
   * `handleCodexTargetNotification` pipeline settle it on `turn/completed`.
   *
   * The response's own `turn.status` is checked too: a turn that is already
   * terminal when `turn/start` answers has had its `turn/completed` either
   * delivered (in which case `entry.settled` is already null and the check is a
   * no-op) or folded into the response, and settling from here is the only
   * thing that would ever settle it.
   *
   * The native policy is sent on EVERY turn (`codexTurnPolicy(mode)` — the
   * same call `CodexSession` makes; `turn/start` overrides it "for this turn
   * and subsequent turns"), so the thread follows the parent's LIVE mode at
   * each turn start (ADR-088 ruling 3). `thread/start` still carries the
   * creation-time baseline. `entry.autonomyMode` is refreshed to the mode sent
   * here — the mode the gate decides by (see that field: a mid-turn switch
   * binds at the next turn).
   */
  private driveCodexTurn(entry: CodexTargetEntry, prompt: string): Promise<CodexTurnOutcome> {
    const mode = liveMode(entry.ctx)
    entry.autonomyMode = mode
    entry.draining = false
    entry.turnStartedAtMs = Date.now()
    entry.lastAgentText = ''
    return new Promise<CodexTurnOutcome>((resolve) => {
      entry.settled = resolve
      let announceTurnId: (id: string | null) => void = () => {}
      entry.turnStarted = new Promise<string | null>((r) => {
        announceTurnId = r
      })
      entry.connection
        .request('turn/start', {
          threadId: entry.sessionId!,
          clientUserMessageId: uuidv4(),
          input: codexTurnInput(this.codexDispatchSkillInput(entry, prompt)),
          ...codexTurnPolicy(mode)
        })
        .then(
          (result) => {
            entry.skillCatalogUpdatePending = false
            announceTurnId(result.turn.id)
            if (!entry.endedTurns.has(result.turn.id)) entry.turnId = result.turn.id
            if (result.turn.status !== 'inProgress') this.settleCodexTurn(entry, result.turn)
          },
          (err) => {
            announceTurnId(null)
            if (entry.settled === resolve) {
              entry.settled = null
              resolve({
                kind: 'error',
                message: err instanceof Error ? err.message : String(err)
              })
            }
          }
        )
    })
  }

  /** Retire `turn` and settle the dispatch waiting on it (exactly once). */
  private settleCodexTurn(entry: CodexTargetEntry, turn: Turn): void {
    if (entry.endedTurns.has(turn.id)) return
    entry.endedTurns.add(turn.id)
    // The authoritative replay: `turn.items` is the turn's final item list, and
    // re-running it through the fingerprint dedupe is what fills in anything
    // that only ever arrived as an `item/started` (mirrors
    // `CodexSession.finishTurn`).
    for (const item of turn.items ?? [])
      this.handleCodexTargetItem(entry, turn.id, item, true, true)
    if (entry.turnId === turn.id) entry.turnId = null
    const settle = entry.settled
    entry.settled = null
    if (!settle) return
    if (turn.status === 'failed') {
      settle({ kind: 'error', message: turn.error?.message ?? 'the dispatched turn failed' })
      return
    }
    settle({
      kind: 'ok',
      text: entry.lastAgentText || '(the dispatched agent returned no text)',
      durationMs: turn.durationMs ?? Math.max(0, Date.now() - entry.turnStartedAtMs)
    })
  }

  /**
   * The target's single ambient notification callback.
   *
   * Notifications for ANY other thread id are dropped. A dispatch target is
   * offered no `dispatch_agent` and no hosted tools beyond its own two, but Codex's collaboration
   * tools are NATIVE, so a target can still spawn a child thread of its own;
   * its items would arrive here stamped with the CHILD's `threadId`. Rendering
   * a grandchild's transcript inside the caller's TaskCard has no home in the
   * renderer's subagent model (one dispatch = one card), so the child runs
   * natively and unwatched rather than half-shown. Its approval requests are
   * refused for the same reason — see `gateCodexTargetRequest`.
   */
  private handleCodexTargetNotification(
    entry: CodexTargetEntry,
    method: string,
    value: unknown
  ): void {
    if (!isRecord(value) || !entry.sessionId || value.threadId !== entry.sessionId) return
    // Proof of life for the inactivity watchdog: ANY notification addressed to
    // this thread counts (see CodexTargetEntry.lastActivityAt).
    entry.lastActivityAt = this.now()
    if (method === 'turn/started' && isRecord(value.turn) && typeof value.turn.id === 'string') {
      if (!entry.endedTurns.has(value.turn.id)) entry.turnId = value.turn.id
      // A turn nobody asked for (no run in flight) after a message was sent for a run that is over:
      // ended at once, the message is sent again as a run.
      if (this.hasStraySteers(entry.ledgerId) && entry.sessionId) {
        logger.info('CrossEngineDispatcher', `codex target ${entry.sessionId}: stray turn ended`)
        void entry.connection
          .request('turn/interrupt', { threadId: entry.sessionId, turnId: value.turn.id })
          .catch(() => {})
      }
      return
    }
    if (method === 'thread/tokenUsage/updated' && isRecord(value.tokenUsage)) {
      entry.usageTotal = (value.tokenUsage as ThreadTokenUsage).total
      // A resumed thread shows its earlier turns' totals first: that is history, the
      // baseline, not this turn's work.
      if (entry.observeUsageBaseline) {
        entry.observeUsageBaseline = false
        entry.usageBaseline = entry.usageTotal
      }
      return
    }
    if (method === 'turn/completed' && isRecord(value.turn)) {
      this.settleCodexTurn(entry, value.turn as Turn)
      return
    }
    if (typeof value.turnId !== 'string') return
    const turnId = value.turnId
    if (entry.endedTurns.has(turnId)) return
    if (method === 'item/started' || method === 'item/completed') {
      if (!isRecord(value.item) || typeof value.item.id !== 'string') return
      this.handleCodexTargetItem(
        entry,
        turnId,
        value.item as ThreadItem,
        method === 'item/completed'
      )
      return
    }
    if (typeof value.itemId === 'string' && typeof value.delta === 'string') {
      for (const event of mapCodexDelta(method, {
        threadId: entry.sessionId,
        turnId,
        itemId: value.itemId,
        delta: value.delta
      }))
        this.forwardCodexTargetEvent(
          entry,
          event,
          codexItemId(entry.sessionId, turnId, value.itemId)
        )
    }
  }

  /**
   * Map one thread item and forward what it produces, with the same
   * fingerprint dedupe `CodexSession.item` keeps so the authoritative
   * `turn/completed` replay re-emits only what actually changed.
   */
  private handleCodexTargetItem(
    entry: CodexTargetEntry,
    turnId: string,
    item: ThreadItem,
    completed: boolean,
    authoritative = false
  ): void {
    if (!entry.sessionId) return
    // A steer the thread took into the turn comes back as the user message that carries its id.
    if (item.type === 'userMessage' && item.clientId) this.noteSteerConsumed(item.clientId)
    const id = codexItemId(entry.sessionId, turnId, item.id)
    const fingerprint = completed
      ? createHash('sha256').update(JSON.stringify(item)).digest('hex')
      : undefined
    if (
      entry.completedItems.has(id) &&
      (!authoritative || entry.completedItems.get(id) === fingerprint)
    )
      return
    if (fingerprint !== undefined) entry.completedItems.set(id, fingerprint)
    // The turn's result text is the LAST completed `agentMessage`.
    if (item.type === 'agentMessage' && completed) entry.lastAgentText = item.text
    // The report's own call has completed: the agent has its answer, the turn may end. Only the
    // call that was ACCEPTED (an earlier, refused one completing says nothing).
    if (
      item.type === 'dynamicToolCall' &&
      completed &&
      item.tool === HAND_BACK_TOOL &&
      item.id === entry.ctx.run.report?.callId
    )
      entry.reportToolDone?.()
    const timestamp = entry.itemTimestamps.get(id) ?? Date.now()
    entry.itemTimestamps.set(id, timestamp)
    const streamable =
      item.type === 'agentMessage' || item.type === 'reasoning' || item.type === 'plan'
    if (item.type === 'plan' && !completed && item.text && entry.ctx.toolUseId) {
      this.appendCodexTargetItem(entry, id, { type: 'plan', text: item.text }, entry.ctx.toolUseId)
      return
    }
    // `imageView` carries a PATH and no bytes: its (empty) mapped result is held
    // back and replaced by ONE result carrying the file once it is read — the
    // subagent-tool-result reducer appends rather than keeping the first, so
    // forwarding both would show the empty one beside the picture. Mirrors
    // `CodexSession.item`.
    const deferredRead = completed && item.type === 'imageView'
    for (const event of mapCodexItem(entry.sessionId, turnId, item, completed, timestamp)) {
      if (deferredRead && event.kind === 'toolResult') continue
      // Taken from the MAPPED block rather than re-deriving it from
      // `item.changes`, so the gate decides about exactly the paths the caller
      // was shown. `FileChangeRequestApprovalParams` carries no changes at all,
      // which makes this the gate's only source for them.
      if (event.kind === 'message') {
        for (const block of event.message.content) {
          if (
            block.type === 'tool_use' &&
            block.toolName === 'fileChange' &&
            Array.isArray(block.toolInput?.files)
          )
            entry.fileChanges.set(block.toolUseId, block.toolInput.files as FileDiff[])
        }
      }
      this.forwardCodexTargetEvent(entry, event, undefined, streamable && completed)
    }
    // Not awaited: the read is best-effort and must not stall the notification pump.
    if (completed && item.type === 'imageView')
      void this.attachCodexTargetImageView(entry, id, item.path)
  }

  /** The ONE result a Codex target's completed `imageView` gets — the bytes when the file could be read, none otherwise. */
  private async attachCodexTargetImageView(
    entry: CodexTargetEntry,
    toolUseId: string,
    path: string
  ): Promise<void> {
    const image = await readCodexImageView(path)
    // Disposed while the file was read: nothing is listening for this target.
    if (!entry.sessionId || this.targets.get(entry.sessionId) !== entry) return
    this.forwardCodexTargetEvent(entry, {
      kind: 'toolResult',
      toolUseId,
      result: '',
      isError: false,
      ...(image ? { images: [image] } : {})
    })
  }

  /**
   * Forward a Codex target's live turn output as engine-neutral subagent
   * events — byte-matches `forwardPiChildStream`'s payload shapes, which are
   * themselves the Claude/opencode ones. `commandDelta` is skipped: the
   * caller's TaskCard does not stream a dispatch target's raw bash output, same
   * as every other direction.
   */
  private forwardCodexTargetEvent(
    entry: CodexTargetEntry,
    event: CodexMappedEvent,
    nativeMessageId?: string,
    forceItemSeal = false
  ): void {
    const toolUseId = entry.ctx.toolUseId
    if (!toolUseId) return
    switch (event.kind) {
      case 'message':
        collectToolUseIds(event.message, entry.turnToolUseIds)
        if (!this.sealCodexTargetItem(entry, event.message, toolUseId, forceItemSeal))
          entry.ctx.emit('session:subagent-message', { toolUseId, message: event.message })
        break
      case 'stream':
        if (nativeMessageId)
          this.appendCodexTargetItem(entry, nativeMessageId, event.delta, toolUseId)
        break
      case 'planDelta':
        if (nativeMessageId)
          this.appendCodexTargetItem(
            entry,
            nativeMessageId,
            { type: 'plan', text: event.delta },
            toolUseId
          )
        break
      case 'toolResult':
        entry.ctx.emit('session:subagent-tool-result', {
          toolUseId,
          toolResultToolUseId: event.toolUseId,
          result: event.result,
          isError: event.isError,
          ...(event.fileDiffs ? { fileDiffs: event.fileDiffs } : {}),
          ...(event.images ? { images: event.images } : {})
        })
        break
      case 'commandDelta':
        break
    }
  }

  private appendCodexTargetItem(
    entry: CodexTargetEntry,
    messageId: string,
    delta: { type: 'text' | 'thinking' | 'plan'; text: string },
    ownerToolUseId: string
  ): void {
    if (!delta.text || entry.completedItems.has(messageId)) return
    const key = JSON.stringify([ownerToolUseId, messageId, delta.type])
    let active = entry.activeStreamItems.get(key)
    if (!active) {
      const target: ItemStreamTarget = {
        messageId,
        blockIndex: 0,
        kind: delta.type,
        ownerToolUseId
      }
      active = {
        target,
        text: '',
        timestamp: entry.itemTimestamps.get(messageId) ?? Date.now(),
        ownerToolUseId,
        ...(delta.type === 'thinking' ? { startedAt: Date.now() } : {})
      }
      entry.activeStreamItems.set(key, active)
      entry.ctx.emit('session:item-open', {
        target,
        ...(active.startedAt === undefined ? {} : { startedAt: active.startedAt }),
        message: {
          id: messageId,
          role: 'assistant',
          content: [
            delta.type === 'plan'
              ? {
                  type: 'tool_use',
                  toolUseId: messageId,
                  toolName: 'plan',
                  toolInput: { plan: '' }
                }
              : delta.type === 'thinking'
                ? { type: 'thinking', text: '' }
                : { type: 'text', text: '' }
          ],
          timestamp: active.timestamp
        }
      })
    }
    active.text += delta.text
    entry.ctx.emit('session:item-delta', { target: active.target, chunk: delta.text })
  }

  private sealCodexTargetItem(
    entry: CodexTargetEntry,
    message: ChatMessage,
    ownerToolUseId: string,
    forceItemSeal = false
  ): boolean {
    const matches = [...entry.activeStreamItems].filter(
      ([, active]) =>
        active.ownerToolUseId === ownerToolUseId && active.target.messageId === message.id
    )
    if (!matches.length) {
      if (forceItemSeal) {
        entry.ctx.emit('session:item-seal', { ownerToolUseId, message })
        return true
      }
      return false
    }
    for (const [key, active] of matches) {
      let sealed = message
      if (active.target.kind === 'thinking' && active.startedAt !== undefined) {
        sealed = {
          ...message,
          content: message.content.map((block, index) =>
            index === active.target.blockIndex && block.type === 'thinking'
              ? { ...block, durationMs: Math.max(0, Date.now() - active.startedAt!) }
              : block
          )
        }
      }
      entry.ctx.emit('session:item-seal', {
        ownerToolUseId,
        target: active.target,
        message: sealed
      })
      entry.activeStreamItems.delete(key)
    }
    return true
  }

  private sealCodexTargetItems(entry: CodexTargetEntry, ownerToolUseId: string): void {
    for (const [key, active] of entry.activeStreamItems) {
      if (active.ownerToolUseId !== ownerToolUseId) continue
      entry.ctx.emit('session:item-seal', {
        ownerToolUseId,
        message: {
          id: active.target.messageId,
          role: 'assistant',
          content: [
            active.target.kind === 'plan'
              ? {
                  type: 'tool_use',
                  toolUseId: active.target.messageId,
                  toolName: 'plan',
                  toolInput: { plan: active.text }
                }
              : active.target.kind === 'thinking'
                ? {
                    type: 'thinking',
                    text: active.text,
                    ...(active.startedAt !== undefined
                      ? { durationMs: Math.max(0, Date.now() - active.startedAt) }
                      : {})
                  }
                : { type: 'text', text: active.text }
          ],
          timestamp: active.timestamp
        }
      })
      entry.activeStreamItems.delete(key)
    }
  }

  /**
   * `item/tool/call` on a Codex target: it was started with `hand_back` and `session_message` (to its
   * dispatcher), nothing else. Anything else keeps getting the `-32601` the host answered before the
   * target had a tool.
   */
  private async toolCallFromCodex(
    entry: CodexTargetEntry,
    value: unknown,
    context: { id: unknown; signal: AbortSignal }
  ): Promise<unknown> {
    if (isRecord(value) && value.tool === X_AGENT_MESSAGE_TOOL && entry.canMessage)
      return this.messageFromCodex(entry, value, context)
    return this.handBackFromCodex(entry, value, context)
  }

  /**
   * A Codex target's `session_message`. Codex's own reviewer does not see dynamic-tool calls
   * (`codex-rs/core/src/tools/handlers/dynamic.rs` asks no approval), so, while the thread runs `auto`,
   * the target's own model judges the message through ClaudeUI's judge on its ChatGPT route BEFORE
   * it is delivered (the report judge, framed as a message to the spawning agent): allow delivers,
   * a block refuses the send with the reason, and a review that could not run refuses it too (fail
   * closed: the report path, `hand_back`, is reviewed or noted). Outside auto it is delivered unasked.
   * The judge's request is aborted when the call is abandoned or the run stops.
   */
  private async messageFromCodex(
    entry: CodexTargetEntry,
    value: Record<string, unknown>,
    context: { id: unknown; signal: AbortSignal }
  ): Promise<unknown> {
    // The guards of `handBackFromCodex`: this thread's own live turn, a call id, no namespace.
    if (entry.draining || context.signal.aborted || !entry.sessionId || value.namespace != null)
      throw new CodexMethodNotFound()
    if (
      value.threadId !== entry.sessionId ||
      typeof value.turnId !== 'string' ||
      value.turnId !== entry.turnId ||
      entry.endedTurns.has(value.turnId) ||
      typeof value.callId !== 'string'
    )
      throw new Error('Codex session_message call has no live owning dispatch turn')
    const args = isRecord(value.arguments) ? value.arguments : {}
    const answer = (text: string, isError: boolean): unknown => ({
      contentItems: [{ type: 'inputText', text }],
      success: !isError
    })
    // The user's deny rule for the tool (written for Claude's spelling of it) holds here as it does
    // for the other engines' targets, in every mode and BEFORE the judge: a Codex target's dynamic
    // tool call never reaches the approval ladder (ADR-085 §3, ADR-105 §4).
    const denied = sessionToolDenyRule(
      X_AGENT_MESSAGE_TOOL,
      args,
      this.userDenyAsk(entry.cwd, entry.ctx.callerRestriction),
      entry.cwd
    )
    if (denied) return answer(`Denied by permission rule: ${denied}`, true)
    // A run that is over takes no message: refused here, before a paid review of it (the service
    // refuses it too, with the same words, for the engines that have no judge in front).
    const over = this.xAgentMessageRefusal(entry)
    if (over) return answer(over, true)
    const message = typeof args.message === 'string' ? args.message : ''
    const judge = this.codexReportJudge(entry)
    if (message.trim() !== '' && judge.autoModeActive(entry.autonomyMode)) {
      const run = entry.ctx.run
      const review = await judge.reviewAgentMessage(message, {
        currentMode: () => entry.autonomyMode,
        stillPending: () =>
          !context.signal.aborted &&
          !run.stopController.signal.aborted &&
          !run.cancelController.signal.aborted,
        signal: AbortSignal.any([
          context.signal,
          run.stopController.signal,
          run.cancelController.signal
        ]),
        permissions: () => this.userDenyAsk(entry.cwd, entry.ctx.callerRestriction)
      })
      if (review.kind === 'block') return answer(messageBlockedText(review.reason), true)
      if (review.kind !== 'allow') return answer(MESSAGE_UNREVIEWED_TEXT, true)
    }
    const sent = await this.xAgentMessage(entry, args, value.callId)
    return answer(sent.text, sent.isError)
  }

  /**
   * `item/tool/call` for `hand_back` on a Codex target.
   * The same guards as `CodexSession.hostedToolCall`: this target's own thread (a native
   * child thread it spawned is refused), its live turn, a call id, no namespace. Anything
   * else keeps getting the `-32601` the host answered before the target had a tool.
   */
  private async handBackFromCodex(
    entry: CodexTargetEntry,
    value: unknown,
    context: { id: unknown; signal: AbortSignal }
  ): Promise<unknown> {
    if (
      !entry.handBack ||
      entry.draining ||
      context.signal.aborted ||
      !entry.sessionId ||
      !isRecord(value) ||
      value.tool !== HAND_BACK_TOOL ||
      value.namespace != null
    )
      throw new CodexMethodNotFound()
    if (
      value.threadId !== entry.sessionId ||
      typeof value.turnId !== 'string' ||
      value.turnId !== entry.turnId ||
      entry.endedTurns.has(value.turnId) ||
      typeof value.callId !== 'string'
    )
      throw new Error('Codex hand_back call has no live owning dispatch turn')
    const args = isRecord(value.arguments) ? value.arguments : {}
    const answer = this.receiveHandBack(entry, args.report, value.callId)
    return { contentItems: [{ type: 'inputText', text: answer.text }], success: !answer.isError }
  }

  /**
   * Answer one native approval request on behalf of a target that has no human
   * of its own — the Codex equivalent of `gatePiTargetToolCall`, and a
   * deliberately narrowed copy of `CodexSession.requestApproval`'s gating half.
   *
   * The shared permission engine runs FIRST, against `entry.autonomyMode` —
   * the mode the thread's native policy runs under THIS turn (refreshed at
   * every turn start, ADR-088; never the live accessor, see that field) —
   * with the user's DENY and ASK rules only (ADR-085 §3) and an
   * empty session-allow set: a dispatched target does not inherit the user's
   * allow rules or their "allow for this session" clicks (same reasoning as
   * the pi target's gate). Only an `ask` ever reaches a human, and it reaches the CALLER's
   * client, bound to the target ITEM's own id — `FloatingApproval
   * .useUnmatchedApprovals` matches a `PendingApproval.toolUseId` against
   * TOP-LEVEL message tool_use ids only, and a target's inner ids live in the
   * subagent bucket, so an inner id is what makes the card render (floating).
   *
   * A user deny rule refuses (with the rule) and a user ask rule asks, in
   * EVERY mode — both rungs precede the mode base — except that in plan mode a
   * write or a command that is not plan-read-only is refused before the ask
   * rule (ADR-085 ruling 7, `planModeOutranksRules`). Past them, per mode:
   *  - plan: `planModeBaseDecision` DENIES every write and every command that
   *    is not plan-read-only (`isPlanReadOnlyCommand`). Nothing is forwarded and nothing waits — which is the
   *    whole point for a target with no human: a read-only dispatch cannot
   *    park forever on a question.
   *  - default / acceptEdits: reads and searches allow; the rest asks, and the
   *    ask is forwarded to the caller.
   *  - auto: gates as `default`, like `CodexSession.gate`. The thread runs
   *    `approvalsReviewer: 'auto_review'`, so the native reviewer has already
   *    approved everything it was willing to and the only requests that reach
   *    this gate are the ones it ESCALATED — and escalations belong to the
   *    caller's human, never to a silent mode-base allow. It is also why `auto`
   *    never maps to `never`/bypass: the native reviewer, not nobody, decides
   *    first. A user ask rule still asks the caller's human.
   *
   * `suggestions` ("always allow" checkboxes) are deliberately omitted, same as
   * the pi target: they would write allow rules to the shared permission
   * files, whose allow tier this gate deliberately does not read.
   */
  private gateCodexTargetRequest(
    entry: CodexTargetEntry,
    method: string,
    value: unknown,
    context: { id: unknown; signal: AbortSignal }
  ): Promise<unknown> {
    if (method === 'item/tool/call') return this.toolCallFromCodex(entry, value, context)
    if (
      !CODEX_TARGET_SERVER_METHODS.includes(method as (typeof CODEX_TARGET_SERVER_METHODS)[number])
    )
      // The transport used to refuse this for us (the target's own process
      // registered these four methods and nothing else). On a shared host the
      // registered list is the union its owners need, so the scrub is made here
      // — with the SAME `-32601` an unregistered method earns, which is what
      // `item/tool/call` must keep getting outside the two tools of a target
      // (`toolCallFromCodex`): a dispatch target has no other hosted tool and no
      // `dispatch_agent`.
      return Promise.reject(new CodexMethodNotFound())
    if (entry.draining) return Promise.resolve(codexRefusal(method))
    if (
      !entry.sessionId ||
      context.signal.aborted ||
      !isRecord(value) ||
      // A native CHILD thread this target spawned raised it. Its transcript is
      // not shown (see handleCodexTargetNotification), so there is no card for
      // a card-bound approval to attach to and no honest way to describe what
      // is being asked about — refuse rather than forward something blind.
      value.threadId !== entry.sessionId ||
      typeof value.turnId !== 'string' ||
      typeof value.itemId !== 'string' ||
      entry.endedTurns.has(value.turnId)
    )
      return Promise.reject(new Error('Codex request has no live owning dispatch turn'))

    if (method === 'item/permissions/requestApproval') {
      // Native permission-profile GRANTS are never made on a dispatch target's
      // behalf: they widen what the sandbox allows for the rest of the thread,
      // which is not something a caller's one-off approval can meaningfully
      // consent to. Answered with an empty grant (the same refusal
      // CodexSession makes), not an error, so the turn continues.
      return Promise.resolve({ permissions: {}, scope: 'turn' })
    }
    if (method === 'item/tool/requestUserInput') {
      // There is no question UI across a dispatch: the caller's approval card
      // carries a decision, not free-text answers, and no other target
      // direction forwards questions either. Answered empty so the tool can
      // proceed (or give up) rather than left hanging.
      return Promise.resolve({ answers: {} })
    }

    const itemId = codexItemId(entry.sessionId, value.turnId, value.itemId)
    let toolName: string
    let input: Record<string, unknown>
    let gated: Array<{ tool: string; input: Record<string, unknown>; path?: string }>
    if (method === 'item/commandExecution/requestApproval') {
      const params = value as unknown as CommandExecutionRequestApprovalParams
      const rawCommand = params.command ?? ''
      // Codex wraps every model command in the user's login shell, so the wire
      // string is `/bin/zsh -lc <script>`. Gating that verbatim would make a
      // `Bash(rm -rf:*)` deny rule dead on this engine.
      const command = unwrapShellCommand(rawCommand)
      toolName = 'commandExecution'
      input = {
        command,
        ...(command === rawCommand ? {} : { rawCommand }),
        cwd: params.cwd ?? ''
      }
      gated = [{ tool: 'bash', input: { command } }]
    } else if (method === 'item/fileChange/requestApproval') {
      toolName = 'fileChange'
      const files = entry.fileChanges.get(itemId) ?? []
      input = { files }
      gated = files.map((file) => ({
        // `add` is a Write; update/move/delete edit a file that already exists
        // — the same split Claude's own Write/Edit tools make.
        tool: file.changeType === 'add' ? 'write' : 'edit',
        input: { path: file.path },
        path: file.path
      }))
    } else return Promise.reject(new Error('Unsupported Codex server request'))

    const verdict = this.decideCodexTargetRequest(entry, gated)
    if (verdict.decision === 'allow') return Promise.resolve({ decision: 'accept' })
    if (verdict.decision === 'deny') {
      // Neither native response type has a reason field, so a denial would be
      // invisible to the caller's human without this line — the same
      // visibility choice `PiChildRunner` makes for a target error.
      if (entry.ctx.toolUseId) {
        entry.ctx.emit('session:subagent-message', {
          toolUseId: entry.ctx.toolUseId,
          message: {
            id: uuidv4(),
            role: 'assistant',
            content: [{ type: 'text', text: `[denied: ${verdict.reason}]` }],
            timestamp: Date.now()
          }
        })
      }
      // `decline` is honoured on both request kinds even though it never
      // appears in `availableDecisions` (docs/codex-spike.md, "Other
      // observations"), so that list is deliberately not consulted.
      return Promise.resolve({ decision: 'decline' })
    }

    return new Promise((resolve) => {
      const requestId = XENG_REQUEST_PREFIX + uuidv4()
      const approval: PendingApproval = { requestId, toolUseId: itemId, toolName, input }
      this.pendingApprovals.set(requestId, {
        kind: 'codex',
        targetSessionId: entry.sessionId,
        emit: entry.ctx.emit,
        card: approval,
        resolve: (decision) => {
          const allow = decision === 'allow' || decision === 'allowForSession'
          // 'allowForSession' is treated as a one-off 'allow': a dispatch
          // target never persists an escalation, matching every other
          // direction's gate (and why `sessionAllows` above is empty).
          resolve({ decision: allow ? 'accept' : 'decline' })
        }
      })
      entry.ctx.emit('session:approval-request', approval)
    })
  }

  /**
   * Collapse the shared engine's verdicts over every action ONE native request
   * covers (a command, or every file in one patch): any deny denies, else any
   * ask asks, else allow. A request with nothing resolvable to gate ASKS —
   * never allows.
   */
  private decideCodexTargetRequest(
    entry: CodexTargetEntry,
    gated: Array<{ tool: string; input: Record<string, unknown>; path?: string }>
  ): { decision: PermissionDecision; reason?: string } {
    if (gated.length === 0) return { decision: 'ask' }
    const engineCtx = {
      // `auto` gates as `default` — the interactive rule (`CodexSession.gate()`):
      // under `auto_review` the native guardian has already approved everything
      // it was willing to, so whatever reaches this gate is what it ESCALATED,
      // and escalations belong to the human, never to a silent mode-base allow.
      mode: entry.autonomyMode === 'auto' ? 'default' : entry.autonomyMode,
      rules: this.userDenyAsk(entry.cwd, entry.ctx.callerRestriction),
      sessionAllows: EMPTY_CODEX_SESSION_ALLOWS,
      cwd: entry.cwd
    }
    let decision: PermissionDecision = 'allow'
    for (const item of gated) {
      const verdict = decideWithSource(item.tool, item.input, engineCtx)
      let step = verdict.decision
      // The same composition-seam narrowing `CodexSession.gate` makes, for the
      // same reason: `acceptEdits`' mode base allows fileEdit/fileWrite
      // unconditionally, which on this engine would silently apply a patch
      // ANYWHERE on disk, while Codex's own workspaceWrite sandbox draws the
      // line at the workspace. A mode-base allow outside cwd is downgraded to a
      // human ask. (Only mode-base verdicts — a target's allow tier is empty,
      // so mode-base is the only rung that can allow here at all.)
      if (
        step === 'allow' &&
        verdict.source === 'mode-base' &&
        item.path !== undefined &&
        !insideCodexWorkspace(entry.cwd, item.path)
      )
        step = 'ask'
      if (step === 'deny')
        return {
          decision: 'deny',
          reason:
            verdict.source === 'deny-rule'
              ? `Denied by permission rule: ${verdict.rule}`
              : entry.autonomyMode === 'plan'
                ? PLAN_MODE_DENY_REASON_NO_EXIT_TOOL
                : 'Denied by dispatch autonomy mode'
        }
      if (step === 'ask') decision = 'ask'
    }
    return { decision }
  }
}

export const crossEngineDispatcher = new CrossEngineDispatcher({
  serverManager: opencodeServerManager,
  makeClient: (conn) => new OpencodeClient(conn),
  loadEngineConfig,
  codexVaultAccounts: true,
  requireHandBack: true
})
