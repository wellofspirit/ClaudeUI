/**
 * Types and constants shared by the dispatcher core and the per-engine dispatch target modules.
 */
import type { EmitSessionEvent } from '../shared/sync/events'
import type { ServerConnection } from '../opencode/OpencodeServerManager'
import { OpencodeClient } from '../opencode/OpencodeClient'
import type { Agent_Info } from '../opencode/protocol-v2/openapi'
import { OpencodeEventMapper, type OpencodeStepUsage } from '../opencode/event-mapper'
import { type V2Rule } from '../opencode/permission-v2'
import type { OpencodePermissionRule } from '../opencode/permission-compiler'
import { ChildRulesetKeeper } from '../opencode/child-rulesets'
import { type CallerRestriction } from '../opencode/caller-restriction'
import type { DispatchTargetJudge } from './dispatch-target-judge'
import { type BlockedCallLedger } from '../automode/blocked-calls'
import { type JudgeTransport } from '../automode/classifier'
import type { SessionJudgeOptions } from '../automode/session-judge'
import { ClaudeItemStreamLifecycle } from './claude-item-stream'
import type { ItemStreamTarget } from '../shared/sync/item-stream'
import { PiChildRunner, type SpawnPiChildFn } from '../pi/pi-child-runner'
import type { MergedClaudeRules } from '../pi/permission-engine'
import { type PiScratchpad } from '../pi/pi-scratchpad'
import type {
  CanUseTool,
  McpServerConfig,
  PermissionMode,
  QueryHandle,
  SDKMessage,
  SdkToolExtra,
  ThinkingConfig
} from '../sdk'
import type { UsageTurnEvent, UsageTurnTokens } from './usage-recorder'
import { type DispatchLedgerStore, type DispatchTargetRow } from './dispatch-target-ledger'
import { type DispatchReportStore } from './dispatch-report-store'
import { type ReportReview } from '../../shared/handback-review'
import { ToolUseOwners } from './tool-use-owners'
import { type DispatchParentLookup, type RunContext } from './dispatch-parent'
import type {
  ApprovalDecision,
  BillingType,
  ChatMessage,
  EngineConfig,
  EngineId,
  PendingApproval
} from '../../shared/types'
import type { ClaudeInputChannel } from './dispatch-target-shared'

// ── Public surface ────────────────────────────────────────────────────────────

export interface DispatchContext {
  fromEngine: EngineId
  fromRoutingId: string
  /**
   * The DISPATCHING session's CURRENT working directory (the worktree it entered, else its cwd), on
   * every context (a launch's, and the one a message
   * to a finished X-Agent rebuilds from its row's `parentCwd`). Where a target runs is its own
   * (`entry.cwd`, the row's `cwd`): its `workdir`, else this.
   */
  cwd: string
  /**
   * The dispatching session's identity (spawn) directory when it differs from {@link cwd}: its
   * settings' deny and ask rules still bind a target (`targetRules`). Absent on a context rebuilt
   * from a ledger row, which stores only `cwd`.
   */
  originCwd?: string
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
  emit: EmitSessionEvent
  /**
   * BaseSession.addDispatchedCost — folds a completed dispatch turn's spend
   * into the dispatching session's own cost breakdown (ADR-033 Slice C).
   * Optional (never fail a dispatch over a missing wiring, same philosophy
   * as `toolUseId` below) — every production caller (the Claude, opencode
   * and pi session paths) sets it; only test doubles omit it.
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
   * The directory the target runs in (a git worktree, say), as the caller gave it: absolute, or
   * relative to the parent's working directory. The host registrations pass it through trimmed
   * (an empty or blank value is absent) and unchecked; the dispatcher resolves it and requires it
   * to lie inside the parent's working directory or one of the user's additional directories.
   * Absent: the target runs in the parent's working directory.
   */
  workdir?: string
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

/**
 * What a NEW target takes from its launch: its two labels, for the ledger row, and the `workdir`
 * `launchRun` resolved and checked (absent: it runs in its parent's directory).
 */
export type FreshLaunch = Pick<DispatchRequest, 'name' | 'description' | 'workdir'>

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
   * `--settings <json>` for the target: ClaudeUI's two behaviour switches
   * (`claudeBehaviorSettings`, always) plus `permissions: { deny, ask }` when
   * the user has any deny/ask rule (ADR-085 §3). It is cli.js's `flagSettings`
   * source, independent of `settingSources: []` (`docs/protocol-cc/02-cli-
   * flags.md` §2.6; `sdk/args.ts` emits `options.settings` as `--settings`).
   */
  settings?: Record<string, unknown>
  /**
   * `--add-dir` for each: the target's scope (`targetRules`), absolute and existing only. The
   * process loads no settings source (`settingSources: []`), so this is the ONLY way cli.js learns
   * of the user's additional directories.
   */
  additionalDirectories?: string[]
  /** In-process MCP servers for the target: its `hand_back` (ADR-105 §3). */
  mcpServers?: Record<string, McpServerConfig>
  /** Tools the process may call without asking (`--allowedTools`): `hand_back` and `session_message`, only in `dontAsk`/`bypassPermissions`. */
  allowedTools?: string[]
  /** Every stream-json frame as it is read off the wire, before the dispatcher's own loop (who made a tool call). */
  onInboundFrame?: (frame: Record<string, unknown>) => void
  /**
   * `--thinking` / `--thinking-display` (`claudeThinkingRequest`): a root session's default
   * (adaptive, summarized), so the card shows the target's thinking. Without the display the
   * target's Opus 4.7+ thinking arrives as a bare signature with no text.
   */
  thinking?: ThinkingConfig
}

/**
 * Spawns the headless Claude target's `sdkQuery()`. Injectable so tests
 * exercise the dispatcher without touching real cli.js / process env
 * (claudeSpawnPrep mutates module-scoped proxy/endpoint/model env slots —
 * see claude-spawn-prep.ts's HAZARD comment).
 */
export type SpawnClaudeQueryFn = (opts: ClaudeQuerySpawnOpts) => Promise<QueryHandle>

/**
 * Spawns a headless pi dispatch target's PiRpcClient + its own PiBridgeHost.
 * Injectable so tests drive a fake target without a real binary (mirrors
 * `SpawnClaudeQueryFn`/`defaultSpawnClaudeQuery`).
 */
export type SpawnPiTargetFn = SpawnPiChildFn

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
  /** Does a pi target's session directory still exist? Defaults to `fs.existsSync`. */
  piSessionDirExists?: (dir: string) => boolean
  /**
   * A pi target's own scratchpad (ADR-110) for a key stable across its resumes. Defaults to
   * `ensurePiScratchpad` under the OS temp dir; undefined = the target has none.
   */
  piScratchpad?: (cwd: string, key: string) => PiScratchpad | undefined
  /**
   * Does the directory an X-Agent was created in still exist? A resume is refused when it does not
   * (a removed git worktree): the harness would otherwise start in a cwd that is gone, or fall back
   * to another. Defaults to `fs.existsSync`.
   */
  targetCwdExists?: (cwd: string) => boolean
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
   * The longest an opencode target's turn is left running after a `hand_back` call
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
export interface DispatchTurnAccount {
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
export interface DispatchedTurnRecord {
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

/** Which of the two liveness caps ended a turn. */
export type TurnTimeoutReason = 'absolute' | 'inactivity'

/** The watchdog's only outcome — shaped to drop straight into each direction's
 *  `Raced` union. */
export type TurnTimeout = { kind: 'timeout'; reason: TurnTimeoutReason }

/**
 * The two per-turn liveness caps, in ms, resolved for ONE dispatch turn.
 * `0` is the canonical "unlimited" here: `resolveTurnLiveness` folds the
 * undefined case into it, so every consumer has exactly one comparison to make.
 */
export interface TurnLivenessCaps {
  turnTimeoutMs: number
  idleTimeoutMs: number
}

/**
 * What every live target entry carries of its ledger row (ADR-105). The entry is a
 * cache of the row: when it leaves memory (a parent's restart, an idle release) the
 * row is what a continuation rebuilds it from.
 */
export interface TargetLedgerFields {
  /** The ledger row's id (`s-xxxxxx`). */
  ledgerId: string
  /**
   * `disposeFor` / a lost server released this entry and wrote its row's state: the
   * turn that was in flight when it happened must not overwrite that on its way out.
   */
  released: boolean
  /**
   * The target was started with the `hand_back` tool (ADR-105 §3). False for a row
   * from before it existed (a thread keeps the tool set it was started with): its run ends
   * in its last message, flagged as such.
   */
  handBack: boolean
  /**
   * The target was offered `session_message` to the session that dispatched it (ADR-105 §4): the session
   * tools were on when it was created. The ledger does not record it, so a target resumed from its
   * row is taken to have it when they are on now (a thread from before B-4 has no such tool to call).
   */
  canMessage: boolean
}

/** What a target's ruleset is built from — cached per target (a failed read is not cached). */
export interface TargetRuleInputs {
  client: DispatchTargetClient
  /** Where the target runs. */
  cwd: string
  /** The dispatching session's directory (`ctx.cwd`): its rules and directories bind the target too (`targetRules`). */
  parentCwd: string
  /** The dispatching session's identity directory when it differs from `parentCwd` (`DispatchContext.originCwd`). */
  originCwd?: string
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
export interface OpencodeTargetEntry extends TargetRuleInputs, TargetLedgerFields {
  kind: 'opencode'
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
export type OpencodeTurnOutcome = { kind: 'done' } | { kind: 'failed'; message: string }

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
export interface ClaudeTargetEntry extends TargetLedgerFields {
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
  /**
   * The retraction key of each of the target's own assistant frames → its message id, so a
   * `model_refusal_fallback` takes the refused partial off the card (`ClaudeSession`'s
   * `wireUuidToMessageId`). Lives as long as the target's process.
   */
  wireUuids: Map<string, string>
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
export interface PiTargetEntry extends TargetLedgerFields {
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
  /**
   * The target's OWN scratchpad and the project temp dir of its cwd (ADR-110), keyed by its
   * ledger row id so a resume finds the same directory. Undefined when it could not be made.
   */
  scratchpad: PiScratchpad | undefined
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
   * `decideWithSource()` `mode`, with `judge` = whether the target's judge is on
   * (the ladder derives its base from the pair: see `gatePiTargetToolCall`).
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

export type TargetEntry = OpencodeTargetEntry | ClaudeTargetEntry | PiTargetEntry

/**
 * One opencode SERVER's event feed, shared by every dispatch target on it
 * (ADR-097 §2: one server serves every directory, so records are keyed by
 * server identity, never by cwd — a config change while a target lives can
 * no longer pair one server's client with another's lease).
 */
export interface ConnRecord {
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

export interface OpencodePendingApproval {
  kind: 'opencode'
  /** Raw opencode request id (no prefix). */
  permissionId: string
  /** The session that asked — the target's own, or a task child's. Replies go there. */
  askingSessionId: string
  targetSessionId: string
  client: DispatchTargetClient
  emit: EmitSessionEvent
}

export interface ClaudePendingApproval {
  kind: 'claude'
  /** Null only in the vanishingly unlikely case a tool call landed before
   *  session_id was known — dismissPendingForTarget matches by string, so
   *  such an entry simply never gets swept by target-scoped dismissal (it
   *  still resolves via the abort-listener / explicit resolveApproval). */
  targetSessionId: string | null
  emit: EmitSessionEvent
  resolve: (decision: ApprovalDecision, answers?: Record<string, string>) => void
}

/** Same shape/handling as ClaudePendingApproval — a resolve-callback, no
 *  remote client/permissionId (mirrors a pi dispatch target's gate, which
 *  resolves a local Promise exactly like a Claude target's canUseTool does).
 *  Kept as its own sibling variant (not a rename of ClaudePendingApproval) so
 *  the claude/opencode branches stay byte-identical — this is a pure addition. */
export interface PiPendingApproval {
  kind: 'pi'
  targetSessionId: string | null
  emit: EmitSessionEvent
  resolve: (decision: ApprovalDecision, answers?: Record<string, string>) => void
}

/**
 * A forwarded card that holds a pi/opencode target's auto-mode judge block
 * (ADR-091 §3). `resolveApproval` turns the answer into the hold's semantics
 * before the kind's own reply: Keep blocked (or the expiry) → the judge's deny
 * text + `automode-blocked` on the target's outcomes; Approve anyway → allow +
 * the target's denial streak reset.
 */
export interface ForwardedBlockHold {
  /** The judge's model-visible deny text. */
  reason: string
  /** The target-side call id the outcome annotates (the judged `toolUseId`). */
  toolUseId: string
  judge: DispatchTargetJudge
  /** The dispatching session's ledger the block is recorded in (ADR-091 part 6). */
  ledger: () => BlockedCallLedger | undefined
  cancel: () => void
}

export type PendingForwardedApproval = (
  OpencodePendingApproval | ClaudePendingApproval | PiPendingApproval
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
 * A turn's outcome as the run loop reads it. `needsReport`: the turn ended without a report
 * from an agent that has the `hand_back` tool, so nothing was announced yet — the loop nudges
 * it or withholds (ADR-105 §3).
 */
export type TurnReturn = DispatchResult & { needsReport?: true; capNote?: string }

/**
 * Prefixed to every prompt a Claude TARGET receives (ADR-088). cli.js's own
 * auto-mode judge sees only the target's transcript, where the dispatch prompt
 * is a `user` message — without this it would read another agent's words as
 * the user's own authorisation. pi/opencode targets need none (ClaudeUI's
 * judge reads the PARENT transcript with a `dispatch:<engine>` subagent
 * header).
 */
export const DISPATCH_PROMPT_PREAMBLE =
  'Task delegated to you by another agent acting for the user:\n\n'
