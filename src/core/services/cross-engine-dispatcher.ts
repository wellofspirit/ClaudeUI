/**
 * Cross-engine agent dispatch (ADR-033).
 *
 * A single main-process service owning all `dispatch_agent` logic: target
 * creation, guards (concurrency cap, per-dispatch timeout, model allowlist),
 * approval forwarding, result await, and cancellation.
 *
 * Targets are headless dispatcher-owned mini-sessions built on engine client
 * primitives — NOT SessionManager/ISession. Two directions are supported:
 *  - Claude → opencode (M1): targets use OpencodeClient directly (the
 *    askSideQuestion / judge precedent), with a synchronous
 *    `POST /session/{id}/message` per turn.
 *  - opencode → Claude (M2): targets use a raw `sdkQuery()` (the
 *    service-session.ts precedent) kept alive across turns via a pushable
 *    streaming-input channel, driven by a manual iterator loop (see the
 *    `.return()`-kills-the-process hazard noted on `driveClaudeTurn`).
 *
 * All failures come back as `isError` tool text — nothing throws across the
 * MCP boundary.
 */
import { resolve as resolvePath } from 'node:path'
import { v4 as uuidv4 } from 'uuid'
import { opencodeServerManager } from '../opencode/OpencodeServerManager'
import { OpencodeClient } from '../opencode/OpencodeClient'
// NOT imported from OpencodeSession.ts — that module now imports
// crossEngineDispatcher (ADR-033 M2 — cancel() disposes owned targets), so
// importing it here would form a require-cycle. permission-ruleset.ts holds
// the same buildRuleset/PermissionRule, re-exported from OpencodeSession.ts
// for any other existing importer.
import { buildRuleset } from '../opencode/permission-ruleset'
import type { PermissionRule } from '../opencode/permission-ruleset'
import { parseModelString } from '../opencode/model-discovery'
import { claudeSpawnPrep } from '../providers/claude-spawn-prep'
import { loadEngineConfig } from './ui-config'
import { transformAssistantMessage } from './assistant-message'
import { extractToolResultContent } from './tool-result-content'
// event-mapper.ts is a leaf module (no cycle risk — it does not import
// OpencodeSession.ts/OpencodeServerManager.ts/this module). Reused here so the
// opencode-target streaming tap (ADR-033 M3) shares the exact same
// message.part.delta/updated → {stream|message} logic OpencodeSession.ts uses
// for its own turns, instead of a second hand-rolled implementation.
import { mapEvent } from '../opencode/event-mapper'
import type { MessageAccumulator } from '../opencode/event-mapper'
import type { OpencodeEvent } from '../opencode/protocol/types'
// pi target primitives (ADR-033 M4c — pi as a dispatch TARGET). None of these
// leaf modules import THIS file (or PiSession.ts, which does), so — same
// reasoning as the opencode imports above — this is a one-way edge, not a
// cycle. Reused verbatim, never reimplemented (per the M4c kickoff spec).
import { locatePiBinary, piBinaryAvailable } from '../pi/pi-locate'
import { PiRpcClient } from '../pi/PiRpcClient'
import { PiBridgeHost, writeBridgeExtension } from '../pi/PiBridgeHost'
import type { GateDecision, PiBridgeHandler, PiToolCallPayload } from '../pi/PiBridgeHost'
import { mapPiEvent, createPiMapperState } from '../pi/event-mapper'
import type { PiMapperOutput, PiMapperState } from '../pi/event-mapper'
import { decide, EMPTY_RULES as EMPTY_PI_RULES } from '../pi/permission-engine'
import type { PiGetStateData, PiGetLastAssistantTextData, PiGetSessionStatsData } from '../pi/pi-protocol'
import { engineMeta } from '../../shared/engine-meta'
import { query as sdkQuery, locateBunClaude, sendProgress } from '../sdk'
import type {
  CanUseTool,
  CanUseToolContext,
  CanUseToolResult,
  PermissionMode,
  QueryHandle,
  ResultMessage,
  SDKMessage,
  SdkToolExtra
} from '../sdk'
import { logger } from './logger'
import { insertDispatchedUsage } from './db'
import type { DispatchedUsageRow } from './db'
import type {
  ApprovalDecision,
  ChatMessage,
  EngineConfig,
  EngineId,
  PendingApproval,
  PermissionSuggestion
} from '../../shared/types'

/**
 * Whether cross-engine dispatch is a real, honest capability for `engineId`
 * (ADR-030 + ADR-033 M4-A): "this engine can host the dispatch tool AND at
 * least one OTHER installed engine can be a target." Lives here (not in
 * shared/model-capabilities.ts, which must stay renderer-safe / import-free
 * of main-process-only modules) — both ClaudeSession.ts and OpencodeSession.ts
 * already import THIS module (for `crossEngineDispatcher`/`disposeFor`), so
 * adding one more named export here forms no new import edge, let alone a
 * cycle.
 *  - 'claude' hosts the tool for opencode-originated dispatches into Claude;
 *    the only other engine is opencode, so honesty requires the opencode
 *    binary actually being vendored/available.
 *  - 'opencode' hosts the tool for Claude-originated dispatches into opencode;
 *    the only other engine is Claude, which is ClaudeUI's bundled default
 *    engine — always present, so always true.
 *  - 'pi' (ADR-033 M4c) hosts the tool for Claude/opencode-originated
 *    dispatches into pi — gates on the vendored pi binary actually being
 *    present, mirroring the 'claude' branch's opencode-binary check.
 */
export function crossEngineDispatchAvailable(engineId: EngineId): boolean {
  if (engineId === 'claude') return opencodeServerManager.isBinaryAvailable()
  if (engineId === 'pi') return piBinaryAvailable()
  return true
}

/**
 * Collect the `tool_use` block IDS from a forwarded assistant message into the
 * per-turn set — the best-effort `toolUses` figure in `TaskNotification.usage`
 * (ADR-033 M4-B) is that set's size at turn end. A SET (not a counter) because
 * the same assistant message is forwarded repeatedly: Claude targets run
 * `includePartialMessages` (each partial re-carries the same blocks under the
 * same betaMessage id), and the opencode SSE tap re-emits the whole rebuilt
 * message on every `message.part.updated` (event-mapper's upsert-by-message-id
 * model). A counter would re-count the same tool_use on every emission.
 * Shared by both directions' streaming taps.
 */
function collectToolUseIds(message: ChatMessage, into: Set<string>): void {
  for (const block of message.content) {
    if (block.type === 'tool_use') into.add(block.toolUseId)
  }
}

// ── Public surface ────────────────────────────────────────────────────────────

export interface DispatchContext {
  fromEngine: EngineId
  fromRoutingId: string
  cwd: string
  /** Dispatching session's permission mode (Claude-style string). */
  autonomyMode: string
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
  extra?: SdkToolExtra
}

export interface DispatchRequest {
  engine: EngineId
  prompt: string
  model?: string
  sessionId?: string
}

export interface DispatchResult {
  text: string
  sessionId: string
  isError?: boolean
}

/**
 * Structural subset of OpencodeClient the dispatcher uses — injectable so
 * tests can stub the transport without HTTP.
 */
export interface DispatchTargetClient {
  createSession(req?: { title?: string }): Promise<{ id: string }>
  patchSession(
    sessionId: string,
    patch: { permission?: Array<{ permission: string; pattern: string; action: string }> }
  ): Promise<unknown>
  prompt(
    sessionId: string,
    req: {
      model?: { providerID: string; modelID: string }
      parts: Array<{ type: 'text'; text: string }>
    }
  ): Promise<unknown>
  deleteSession(sessionId: string): Promise<boolean>
  abortSession(sessionId: string): Promise<boolean>
  replyPermission(
    requestId: string,
    reply: 'once' | 'always' | 'reject',
    message?: string
  ): Promise<unknown>
  subscribeEvents(
    signal?: AbortSignal
  ): AsyncGenerator<{ id: string; type: string; properties: Record<string, unknown> }>
}

/** Spawn opts for a headless Claude dispatch target (ADR-033 M2). */
export interface ClaudeQuerySpawnOpts {
  cwd: string
  model: string
  permissionMode: PermissionMode
  allowDangerouslySkipPermissions: boolean
  canUseTool: CanUseTool
  abortController: AbortController
  prompt: AsyncIterable<Record<string, unknown>>
}

/**
 * Spawns the headless Claude target's `sdkQuery()`. Injectable so tests
 * exercise the dispatcher without touching real cli.js / process env
 * (claudeSpawnPrep mutates module-scoped proxy/endpoint/model env slots —
 * see claude-spawn-prep.ts's HAZARD comment).
 */
export type SpawnClaudeQueryFn = (opts: ClaudeQuerySpawnOpts) => Promise<QueryHandle>

/** Spawn opts for a headless pi dispatch target (ADR-033 M4c). */
export interface PiTargetSpawnOpts {
  cwd: string
  /**
   * Gate handler for the per-target PiBridgeHost's `/tool-call` route — the
   * two-stage approval gate (see `CrossEngineDispatcher.gatePiTargetToolCall`).
   * Threaded in rather than constructed inside the default spawn function so
   * the SAME closure (bound to the target's `entry`) is used regardless of
   * which spawn implementation (real or test-injected) is active.
   */
  gateHandler: PiBridgeHandler
}

/** The two live primitives a pi dispatch target owns — one PiRpcClient (the
 *  headless child) and its OWN PiBridgeHost (approval gate transport). */
export interface PiTargetPrimitives {
  client: PiRpcClient
  bridgeHost: PiBridgeHost
}

/**
 * Spawns a headless pi dispatch target's PiRpcClient + its own PiBridgeHost.
 * Injectable so tests drive a fake target without a real binary (mirrors
 * `SpawnClaudeQueryFn`/`defaultSpawnClaudeQuery`).
 */
export type SpawnPiTargetFn = (opts: PiTargetSpawnOpts) => Promise<PiTargetPrimitives>

export interface DispatcherDeps {
  serverManager: {
    acquire(cwd: string): Promise<{ baseUrl: string; authHeader: string }>
    release(cwd: string): void
  }
  makeClient: (baseUrl: string, authHeader: string) => DispatchTargetClient
  loadEngineConfig: (engineId: string) => EngineConfig
  /** Defaults to the real sdkQuery + claudeSpawnPrep. */
  spawnClaudeQuery?: SpawnClaudeQueryFn
  /** Defaults to the real PiRpcClient + PiBridgeHost construction (ADR-033 M4c). */
  spawnPiTarget?: SpawnPiTargetFn
  maxConcurrent?: number
  dispatchTimeoutMs?: number
  heartbeatMs?: number
  /**
   * ADR-033 M4c: how long `resolveAndRunPi`'s give-up path (timeout/abort/
   * stop) waits for the ABANDONED turn's own terminal pi events to drain
   * before releasing the target's `busy` flag — see `PiTargetEntry.settled`'s
   * "RACE NOTE" doc comment for why this exists (pi's `abort` is turn-scoped,
   * not process-killing, and its wire has no per-event turn correlation).
   * Bounded so a hung/never-arriving settle can't wedge the stop path
   * forever. Defaults to a value comfortably above pi's observed real-world
   * abort→agent_settled latency (single-digit ms, verified) so the common
   * case never actually waits the full duration.
   */
  piAbortSettleGraceMs?: number
  /** Delay between opencode SSE reconnect attempts after a dropped subscription
   *  (see runSseLoop). Small enough to recover approval forwarding quickly, big
   *  enough that a dead server can't hot-spin the loop. Injectable for tests. */
  sseReconnectDelayMs?: number
  /** Clock, injectable for the pendingStops TTL tests. Defaults to Date.now. */
  now?: () => number
  /**
   * Persist one dispatched-agent-turn usage row (ADR-033 M4-B). Defaults to
   * the real `insertDispatchedUsage` (db.ts) — tests inject a spy instead of
   * exercising the (in-memory-under-vitest, but still real) operational DB.
   * Called for 'completed'/'failed' outcomes only, never for a turn stopped
   * before it produced any usage (see the call sites).
   */
  recordDispatchedUsage?: (row: Omit<DispatchedUsageRow, 'id'>) => void
}

// ── Internals ─────────────────────────────────────────────────────────────────

/** Reserved requestId prefix routing approvals to the dispatcher (ADR-033). */
export const XENG_REQUEST_PREFIX = 'xeng:'

/**
 * A pi dispatch target's gate never has a per-session "always allow"
 * escalation set — UNLIKE PiSession's own interactive sessionAllows, a
 * dispatched target's `gatePiTargetToolCall` treats 'allowForSession'
 * IDENTICALLY to a one-off 'allow' (see its resolve callback): each tool_call
 * runs `decide()` fresh, matching `awaitClaudeTargetApproval`, which ALSO
 * never persists any escalation state across a Claude target's tool calls.
 * One shared, frozen, empty Set — never mutated — so no per-target
 * allocation is needed.
 */
const EMPTY_PI_SESSION_ALLOWS: ReadonlySet<string> = new Set()

const MAX_CONCURRENT = 3
const DISPATCH_TIMEOUT_MS = 10 * 60 * 1000
const HEARTBEAT_MS = 15 * 1000
/** How long an armed stop-intent (see `pendingStops`) stays valid. Generous —
 *  it only needs to outlive the MCP tools/call round-trip + handler prelude. */
const PENDING_STOP_TTL_MS = 60 * 1000
/** Default for `DispatcherDeps.piAbortSettleGraceMs` — see that field's doc comment. */
const PI_ABORT_SETTLE_GRACE_MS = 3_000

/** Default for `DispatcherDeps.sseReconnectDelayMs` — see runSseLoop. */
const SSE_RECONNECT_DELAY_MS = 1_000
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
  expiresAt: number
}

/** A live opencode dispatch target — persists across turns for `session_id` continuation. */
interface OpencodeTargetEntry {
  kind: 'opencode'
  sessionId: string
  fromRoutingId: string
  cwd: string
  cwdKey: string
  client: DispatchTargetClient
  /** Latest dispatching context — used to forward approvals mid-turn. */
  ctx: DispatchContext
  /**
   * True while a `prompt()` turn is in flight (ADR-033 M3). Gates the SSE
   * stream tap (`handleOpencodeTargetStream`) — stray events from a PRIOR
   * turn (or the server's own trailing chatter) must never emit stream
   * deltas for a turn that already returned its result.
   */
  busy: boolean
  /**
   * Per-messageId part accumulators for the SSE streaming tap — same shape
   * `OpencodeSession` keeps for its own turns (event-mapper.ts's
   * `MessageAccumulator`). Scoped to this target so a fresh turn's
   * message ids never collide with a previous turn's.
   */
  accumulators: Map<string, MessageAccumulator>
  /** Cumulative cost across every turn this target has run (ADR-033 M4-C —
   *  the per-dispatch cost cap). Never decreases; reset only by creating a
   *  fresh target (a new session_id). */
  cumulativeCostUsd: number
  /** DISTINCT tool_use ids seen in the turn CURRENTLY in flight (ADR-033
   *  M4-B). A fresh Set at every turn start, populated by the streaming tap
   *  (`collectToolUseIds` — a Set, not a counter, because the tap re-emits the
   *  same rebuilt message on every part update), `.size` read once at turn
   *  end for the notification/usage-record `toolUses` figure. */
  turnToolUseIds: Set<string>
}

/**
 * A live Claude dispatch target (ADR-033 M2). The `sdkQuery()` process stays
 * alive across turns (persistSession:false → no transcript, so re-spawning
 * would lose context — see the plan doc's M2-A analysis); `channel` feeds the
 * streaming-input mode and `iterator` is the ONE iterator obtained from the
 * query handle for its whole lifetime.
 *
 * HAZARD: `QueryHandle[Symbol.asyncIterator]().return()` KILLS the child
 * process (see sdk/query.ts `makeHandle` — `return: async () => { killChild(); ... }`).
 * A `for await...of` loop that `break`s early triggers `.return()` via the
 * language's iterator-closing protocol. We therefore NEVER use `for await` on
 * `entry.query` — `driveClaudeTurn` calls `entry.iterator.next()` manually in
 * a plain loop, so ending a turn early (we stop as soon as we see `result`)
 * never closes the iterator or kills the process.
 */
interface ClaudeTargetEntry {
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
   * activeDispatches slot reservation guards), so a busy target REJECTS the
   * second call instead of interleaving (reject, don't queue: queueing hides
   * latency and muddies timeout attribution; the model can just retry).
   */
  busy: boolean
  /** Latest dispatching context — used to forward approvals mid-turn. */
  ctx: DispatchContext
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
   * continuation with an unknown sessionId errors instead of respawning, so
   * the cumulative counter can never restart under a live entry.
   */
  lastReportedTotalCostUsd: number
  /** DISTINCT tool_use ids seen in the turn CURRENTLY in flight (ADR-033
   *  M4-B) — same Set-not-counter rationale as OpencodeTargetEntry (Claude
   *  targets run includePartialMessages, so the same assistant message is
   *  forwarded repeatedly under the same betaMessage id). */
  turnToolUseIds: Set<string>
}

/**
 * A live pi dispatch target (ADR-033 M4c). pi is Claude-shaped at the process
 * level — ONE persistent headless `pi --mode rpc --no-session` child per
 * target, alive across turns — but its EVENT model is not an async iterable:
 * `PiRpcClient.onEvent()` is a single ambient callback registered ONCE for the
 * target's whole lifetime (installed in `createPiTarget`), not something a
 * turn-loop can manually `.next()` through. There is therefore no
 * `driveClaudeTurn`-style pull loop and no `.return()`-kills-the-process
 * hazard to guard against — see `drivePiTurn`'s doc comment for the full
 * divergence. `settled` is how a turn currently in flight gets resolved by
 * that ambient callback.
 *
 * ABORT SEMANTICS DIVERGE FROM CLAUDE TOO (verified empirically — see the
 * M4c kickoff investigation): pi's `abort` command is TURN-scoped like
 * opencode's `abortSession` — the process and session survive an abort, then
 * happily serve a fresh `prompt`. This is UNLIKE Claude, whose
 * `abortController.abort()` kills the whole process (forcing
 * resolveAndRunClaude to delete the entry on timeout/abort/stop). pi's
 * timeout/abort/stop handling therefore keeps the entry alive for
 * continuation, matching the opencode target's survive-the-process pattern.
 */
interface PiTargetEntry {
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
  client: PiRpcClient
  /** This target's OWN loopback approval-gate host (ADR-033 §4 — a dispatch
   *  target gets its own bridge, never shares the dispatching session's). */
  bridgeHost: PiBridgeHost
  /** Latest dispatching context — used to forward approvals/stream events mid-turn. */
  ctx: DispatchContext
  /**
   * Fixed at target creation from `ctx.autonomyMode` — a continuation call's
   * (possibly different) `ctx.autonomyMode` is IGNORED for gating purposes,
   * mirroring the Claude target's `permissionMode`, which is baked into the
   * spawned process at creation and can never change later either. Passed
   * DIRECTLY (no translation) as `permission-engine.ts`'s `decide()` `mode`
   * param — `modeBaseDecision` already natively accepts this exact vocabulary
   * ('auto'/'bypassPermissions' → allow-all, 'acceptEdits' → partial,
   * 'plan'/'default'/anything else → conservative), so unlike
   * `mapAutonomyToClaudeTargetMode` (which translates into a DIFFERENT
   * vocabulary — `PermissionMode` + a boolean — for `sdkQuery`), pi needs no
   * translation function at all: this is the identity mapping.
   */
  autonomyMode: string
  /** True while a turn is being driven — same busy-reject rationale as
   *  ClaudeTargetEntry (a single ambient event stream per process; two
   *  concurrent turns would have no way to tell which `result` belongs to
   *  which caller). */
  busy: boolean
  /** Cumulative cost across every turn this target has run (ADR-033 M4-C). */
  cumulativeCostUsd: number
  /**
   * Mirrors `ClaudeTargetEntry.lastReportedTotalCostUsd` — VERIFIED WIRE FACT
   * (event-mapper.ts's `agent_settled` case echoes `state.totalCostUsd`, which
   * only grows via `+=` in the assistant `message_end` branch): the mapper's
   * `result` output's `totalCostUsd` is CUMULATIVE across this target's WHOLE
   * process lifetime, not per-turn. Converts each turn's reported running
   * total into a per-turn delta against this baseline — the exact same
   * pattern as the Claude target (same wire-cumulative-total hazard).
   */
  lastReportedTotalCostUsd: number
  /** DISTINCT tool_use ids seen in the turn CURRENTLY in flight (ADR-033
   *  M4-B) — same Set-not-counter rationale as the other two target kinds. */
  turnToolUseIds: Set<string>
  /** Sum of input+output+reasoning tokens across the turn CURRENTLY in flight
   *  (ADR-033 M4-B) — pi's `usage` MapperOutput fires once per ASSISTANT
   *  MESSAGE (a multi-tool-call turn can have several), so this accumulates
   *  across them; reset to 0 at the start of every turn. */
  turnTotalTokens: number
  /** Pure per-process mapper state (event-mapper.ts) — NOT reset between
   *  turns (its `totalCostUsd` is the cumulative baseline `lastReportedTotalCostUsd`
   *  is diffed against; `currentMessageId` is message-scoped bookkeeping that
   *  naturally clears itself on every assistant `message_end`). */
  mapperState: PiMapperState
  /** The model this target was created with (picker-value string, e.g.
   *  "openai-codex/gpt-5.6-luna") — fixed for the target's lifetime, same as
   *  Claude/opencode targets (a continuation call cannot switch models). */
  model: string
  /**
   * Resolver for the turn CURRENTLY in flight; null when idle. Set by
   * `drivePiTurn` just before sending `prompt`, invoked EXACTLY ONCE per turn
   * by `forwardPiTargetMessage`'s `result`/`error` handling, or by the
   * `onExit` handler if the process dies mid-turn. See `drivePiTurn`'s doc
   * comment for why pi needs this event-driven settle instead of Claude's
   * manual iterator pull.
   *
   * RACE NOTE (pi-specific — Claude/opencode don't have this): on timeout/
   * abort/stop, pi's target process SURVIVES (see the class doc comment) and
   * its OWN terminal event sequence for the ABANDONED turn is still in
   * flight (message_end→turn_end→agent_end→agent_settled, triggered by the
   * `abort` command). pi's wire has NO per-event turn correlation — whatever
   * wrapper is CURRENTLY installed here receives the NEXT settle-shaped
   * event, whichever turn actually produced it — so `resolveAndRunPi`'s
   * give-up path WAITS (briefly, bounded) for this field to go quiet before
   * releasing `busy`, instead of returning immediately, so a fast-enough
   * continuation can never install a new wrapper while a stale one is still
   * pending delivery. See `resolveAndRunPi`'s stop/timeout/abort branch.
   */
  settled: ((outcome: PiTurnOutcome) => void) | null
  /**
   * RACE NOTE (pi-specific, same root cause as `settled`'s RACE NOTE above):
   * the ABANDONED turn's own in-flight terminal event sequence can carry a
   * `/tool-call` 'ask' that lands AFTER `resolveAndRunPi`'s timeout/abort/stop
   * branch has already run `dismissPendingForTarget` — pi's wire has no
   * per-event turn correlation, so the gate has no other way to recognize
   * that ask as belonging to a turn the caller was already told is
   * stopped/failed. Without this flag, that late ask would register a FRESH
   * `pendingApprovals` entry and emit a `session:approval-request` for a
   * dispatch that already settled — orphaned until a manual deny or
   * `disposeFor`. Set true as the FIRST action in the timeout/abort/stop
   * winner branch (before the `abort` RPC even sends, so no event can race
   * ahead of it); `gatePiTargetToolCall` checks this FIRST and short-circuits
   * to `deny` — never registers a pending approval while draining. Cleared at
   * the start of `drivePiTurn` — a fresh continuation turn is no longer
   * draining.
   */
  draining: boolean
}

/** What a pi dispatch turn settles with — see `PiTargetEntry.settled`. */
type PiTurnOutcome =
  | { kind: 'ok'; totalCostUsd: number; durationMs: number; sessionId: string | null }
  | { kind: 'error'; message: string }

type TargetEntry = OpencodeTargetEntry | ClaudeTargetEntry | PiTargetEntry

/** One shared opencode server connection (+ SSE loop) per cwd with live targets. */
interface ConnRecord {
  client: DispatchTargetClient
  sseAbort: AbortController
  targetCount: number
}

interface OpencodePendingApproval {
  kind: 'opencode'
  /** Raw opencode permission id (no prefix). */
  permissionId: string
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

type PendingForwardedApproval = OpencodePendingApproval | ClaudePendingApproval | PiPendingApproval

function errorResult(text: string, sessionId = ''): DispatchResult {
  return { text, sessionId, isError: true }
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
 * Final completion signal for a dispatch (ADR-033 M3) — mirrors
 * ClaudeSession's `session:task-notification` shape exactly (TaskCard reads
 * both identically). `usage` (ADR-033 M4-B) is populated only on paths that
 * have real per-turn numbers (success outcomes) — timeouts/stops/errors pass
 * it undefined rather than fabricate zeros for a turn that never returned.
 */
function emitDispatchNotification(
  ctx: DispatchContext,
  targetSessionId: string,
  status: 'completed' | 'failed' | 'stopped',
  summary: string,
  usage?: { totalTokens: number; toolUses: number; durationMs: number }
): void {
  if (!ctx.toolUseId) return
  ctx.emit('session:task-notification', {
    taskId: targetSessionId,
    toolUseId: ctx.toolUseId,
    status,
    outputFile: '',
    summary: summary.slice(0, 100),
    usage
  })
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

/** Build the `{type:'user', ...}` SDK message shape cli.js expects on the
 *  streaming-input channel — mirrors claude-session.ts's `run()`. */
function buildClaudeDispatchMessage(
  prompt: string,
  sessionId: string | null
): Record<string, unknown> {
  return {
    type: 'user' as const,
    session_id: sessionId ?? '',
    message: { role: 'user' as const, content: prompt },
    parent_tool_use_id: null
  }
}

/**
 * Map the dispatching session's inherited autonomy (a Claude-style
 * permission-mode string) to the Claude TARGET's permissionMode (ADR-033 M2
 * item 5).
 *  - 'auto' / 'bypassPermissions' → bypassPermissions + allowDangerouslySkipPermissions:
 *    no LLM judge is spun up for dispatched targets in v1 (ADR-033 §5) —
 *    "full" autonomy on the caller means allow-all on the target too.
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
    case 'bypassPermissions':
      return { permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true }
    case 'plan':
      return { permissionMode: 'default', allowDangerouslySkipPermissions: false }
    default:
      return { permissionMode: autonomyMode as PermissionMode, allowDangerouslySkipPermissions: false }
  }
}

/**
 * Real default for `DispatcherDeps.spawnClaudeQuery`. Duplicates
 * `getSdkExecutableOpts()` (claude-session.ts) inline rather than importing
 * it — claude-session.ts imports THIS module (for the collab server /
 * disposeFor wiring), so importing back would form a require-cycle. The
 * duplicated shape is 5 fields wide and changes only if the Bun-binary spawn
 * pipeline itself changes (ADR-006).
 */
async function defaultSpawnClaudeQuery(opts: ClaudeQuerySpawnOpts): Promise<QueryHandle> {
  const engineCfg = loadEngineConfig('claude')
  await claudeSpawnPrep(opts.model, engineCfg)
  const bunClaude = locateBunClaude()
  return sdkQuery({
    prompt: opts.prompt as AsyncIterable<never>,
    options: {
      pathToClaudeCodeExecutable: bunClaude,
      executable: bunClaude,
      executableArgs: [],
      standaloneExecutable: true,
      env: {},
      cwd: opts.cwd,
      model: opts.model,
      permissionMode: opts.permissionMode,
      ...(opts.allowDangerouslySkipPermissions ? { allowDangerouslySkipPermissions: true } : {}),
      persistSession: false,
      settingSources: [],
      abortController: opts.abortController,
      canUseTool: opts.canUseTool,
      // ADR-033 M3: stream_event text/thinking deltas so driveClaudeTurn can
      // forward them as session:subagent-stream for the dispatch TaskCard.
      includePartialMessages: true
    }
  })
}

/**
 * Real default for `DispatcherDeps.spawnPiTarget` (ADR-033 M4c). Mirrors
 * `PiSession.doStart()`'s spawn shape (bridge host first, then the version-
 * keyed extension file, then the child) with two deliberate differences for
 * a headless DISPATCH target:
 *  - `--no-session`: ephemeral — no `~/.pi/agent/sessions` write (verified:
 *    `get_state`/`set_model`/`prompt`/`get_last_assistant_text`/`abort` all
 *    work normally under `--no-session`, same as `model-discovery.ts`'s own
 *    ephemeral-probe precedent).
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
 *    and-suspenders even if a hosted tool were somehow still registered: this
 *    `PiBridgeHost` below is constructed with ONLY `opts.gateHandler` (no
 *    `hostedToolHandler`), so any `/hosted-tool` execute against this target
 *    fails closed with an isError result — never actually runs anything (see
 *    `PiBridgeHost.processHostedToolBody`'s own documented no-handler
 *    fail-closed default). The approval gate (the extension's `tool_call`
 *    hook) still activates normally — it depends ONLY on
 *    `CLAUDEUI_PI_BRIDGE_URL`/`TOKEN`, independent of the hosted-tools gate
 *    (verified against pi-bridge-source.ts's own independence design).
 */
/**
 * The env vars a pi dispatch TARGET's child process gets. Extracted as a pure
 * function (rather than inlined into `defaultSpawnPiTarget`) so the
 * recursion-guard property is DIRECTLY unit-testable without mocking
 * PiRpcClient/PiBridgeHost/locatePiBinary: NO `CLAUDEUI_PI_HOSTED_TOOLS` /
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
export function buildPiTargetChildEnv(bridge: { url: string; token: string }): NodeJS.ProcessEnv {
  return {
    CLAUDEUI_PI_BRIDGE_URL: bridge.url,
    CLAUDEUI_PI_BRIDGE_TOKEN: bridge.token,
    CLAUDEUI_PI_HOSTED_TOOLS: '',
    CLAUDEUI_PI_DISPATCH_ENABLED: '',
    CLAUDEUI_PI_SKILL_DIRS: ''
  }
}

async function defaultSpawnPiTarget(opts: PiTargetSpawnOpts): Promise<PiTargetPrimitives> {
  const bin = locatePiBinary()
  if (!bin) {
    throw new Error(
      'pi binary not found — run `bun run ensure-pi` to vendor it ' +
        `(vendor/pi-cli/pi${process.platform === 'win32' ? '.exe' : ''} is missing).`
    )
  }
  const bridgeHost = new PiBridgeHost(opts.gateHandler)
  let bridge: { url: string; token: string }
  try {
    bridge = await bridgeHost.start()
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err))
  }
  const bridgePath = writeBridgeExtension()
  const client = new PiRpcClient(bin, {
    cwd: opts.cwd,
    args: ['--mode', 'rpc', '--no-session', '-e', bridgePath],
    env: buildPiTargetChildEnv(bridge)
  })
  try {
    await client.start()
  } catch (err) {
    bridgeHost.dispose()
    throw err instanceof Error ? err : new Error(String(err))
  }
  return { client, bridgeHost }
}

export class CrossEngineDispatcher {
  private readonly deps: DispatcherDeps
  private readonly maxConcurrent: number
  private readonly dispatchTimeoutMs: number
  private readonly heartbeatMs: number
  private readonly piAbortSettleGraceMs: number
  private readonly sseReconnectDelayMs: number
  private readonly spawnClaudeQuery: SpawnClaudeQueryFn
  private readonly spawnPiTarget: SpawnPiTargetFn
  private readonly recordDispatchedUsage: (row: Omit<DispatchedUsageRow, 'id'>) => void

  /** Keyed by target session id (opencode session id, or Claude session UUID). */
  private targets = new Map<string, TargetEntry>()
  /** Keyed by resolved cwd — opencode connections only. */
  private connections = new Map<string, ConnRecord>()
  /** Keyed by prefixed requestId ('xeng:<id>'). */
  private pendingApprovals = new Map<string, PendingForwardedApproval>()
  private activeDispatches = 0
  /**
   * One entry per turn currently in flight, keyed by the dispatching tool_use
   * id (ADR-033 M3 — `stopDispatch`/TaskCard's Stop button). Populated for the
   * duration of `resolveAndRunClaude`/`resolveAndRunOpencode` ONLY when
   * `ctx.toolUseId` is set (an id-less dispatch cannot be targeted by Stop —
   * there is no way to key it from the renderer either). Removed in that
   * call's `finally`, so a stale id can never resolve to a dead turn.
   * `fromRoutingId` scopes Stop to the OWNING session — see `stopDispatch`.
   */
  private activeByToolUseId = new Map<string, { fromRoutingId: string; stop: () => void }>()
  /**
   * Durable stop-intents (ADR-033 M3), keyed by dispatching tool_use id.
   * Closes the LAST stop race window — the one UPSTREAM of the dispatcher:
   * opencode marks the tool part "running" (and the renderer's Stop becomes
   * clickable) milliseconds after `ctx.ask` resolves, while the MCP
   * tools/call HTTP round-trip + handler prelude can take much longer, so a
   * Stop click can arrive before `dispatch()` is even invoked and NO
   * registration timing inside the dispatcher can win it. `stopDispatch`
   * with `armIfUnknown` records the intent here; `dispatchInner` consumes it
   * at stop-handle registration and aborts immediately. Entries lazy-expire
   * (checked on consume; purged whenever a new one is armed — no timer).
   */
  private pendingStops = new Map<string, PendingStop>()
  private readonly now: () => number

  constructor(deps: DispatcherDeps) {
    this.deps = deps
    this.maxConcurrent = deps.maxConcurrent ?? MAX_CONCURRENT
    this.dispatchTimeoutMs = deps.dispatchTimeoutMs ?? DISPATCH_TIMEOUT_MS
    this.heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS
    this.piAbortSettleGraceMs = deps.piAbortSettleGraceMs ?? PI_ABORT_SETTLE_GRACE_MS
    this.sseReconnectDelayMs = deps.sseReconnectDelayMs ?? SSE_RECONNECT_DELAY_MS
    this.spawnClaudeQuery = deps.spawnClaudeQuery ?? defaultSpawnClaudeQuery
    this.spawnPiTarget = deps.spawnPiTarget ?? defaultSpawnPiTarget
    this.now = deps.now ?? Date.now
    this.recordDispatchedUsage = deps.recordDispatchedUsage ?? insertDispatchedUsage
  }

  /** For tests: current in-flight dispatch count. */
  get inFlightCount(): number {
    return this.activeDispatches
  }

  /**
   * Record one dispatched-usage row, ISOLATING failures (ADR-033 M4-B): the
   * default `recordDispatchedUsage` is a real better-sqlite3 insert — if it
   * throws (locked DB, disk error), the exception must never propagate into
   * the dispatch flow, where `dispatch()`'s catch would report a COMPLETED
   * turn back to the caller model as `Dispatch failed: …`. Usage accounting
   * is best-effort by design; the turn result is not.
   */
  private safeRecordUsage(row: Omit<DispatchedUsageRow, 'id'>): void {
    try {
      this.recordDispatchedUsage(row)
    } catch (err) {
      logger.warn(
        'CrossEngineDispatcher',
        `recordDispatchedUsage failed (usage row dropped): ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Stop a running dispatch by its dispatching tool_use id (ADR-033 M3 —
   * TaskCard's Stop button, routed here BEFORE the session's own stopTask by
   * the `session:stop-task` IPC handler). Returns false for an unknown id
   * (not a dispatch, or already finished) — the caller falls through to the
   * session's normal stop path in that case.
   *
   * `routingId`, when provided (both IPC call sites pass it), must match the
   * DISPATCHING session that started the turn — the native stopTask path is
   * implicitly session-scoped via `manager.get(routingId)`, and without this
   * check any session (including a remote client on a different session)
   * could stop a dispatch it doesn't own. On mismatch we return false; the
   * caller falls through to the session path, which won't know the id either.
   *
   * `opts.armIfUnknown` (set when the RENDERER knows the card is a dispatch —
   * TaskCard's `isDispatch`): on a registry miss, record a durable stop-intent
   * in `pendingStops` and return true — the dispatch may not have been invoked
   * yet (see the pendingStops field doc); `dispatchInner` consumes the intent
   * at registration and aborts the turn immediately.
   */
  stopDispatch(
    toolUseId: string,
    routingId?: string,
    opts?: { armIfUnknown?: boolean }
  ): boolean {
    const active = this.activeByToolUseId.get(toolUseId)
    if (!active) {
      // Not necessarily an error (most stop-task calls target native tasks) —
      // but when a dispatch stop misroutes, this is the breadcrumb.
      logger.debug(
        'CrossEngineDispatcher',
        `stopDispatch miss: toolUseId=${toolUseId} not in [${[...this.activeByToolUseId.keys()].join(', ')}]`
      )
      if (opts?.armIfUnknown) {
        // Purge expired intents whenever a new one is armed (no timer).
        const now = this.now()
        for (const [key, intent] of this.pendingStops) {
          if (intent.expiresAt <= now) this.pendingStops.delete(key)
        }
        this.pendingStops.set(toolUseId, {
          routingId,
          expiresAt: now + PENDING_STOP_TTL_MS
        })
        logger.debug(
          'CrossEngineDispatcher',
          `stopDispatch armed pending stop-intent for toolUseId=${toolUseId}`
        )
        return true
      }
      return false
    }
    if (routingId !== undefined && active.fromRoutingId !== routingId) {
      logger.debug(
        'CrossEngineDispatcher',
        `stopDispatch ownership mismatch: routingId=${routingId} owner=${active.fromRoutingId}`
      )
      return false
    }
    active.stop()
    return true
  }

  async dispatch(req: DispatchRequest, ctx: DispatchContext): Promise<DispatchResult> {
    try {
      return await this.dispatchInner(req, ctx)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn('CrossEngineDispatcher', `dispatch failed: ${msg}`)
      return errorResult(`Dispatch failed: ${msg}`, req.sessionId ?? '')
    }
  }

  private async dispatchInner(req: DispatchRequest, ctx: DispatchContext): Promise<DispatchResult> {
    // ── Guards ────────────────────────────────────────────────────────────
    if (req.engine === ctx.fromEngine) {
      return errorResult(
        `dispatch_agent targets a different engine — this session already runs on "${ctx.fromEngine}". ` +
          'Use your own tools (or a native subagent) for same-engine work.'
      )
    }
    if (req.engine !== 'opencode' && req.engine !== 'claude' && req.engine !== 'pi') {
      return errorResult(`Dispatching into engine "${req.engine}" is not supported yet.`)
    }
    if (this.activeDispatches >= this.maxConcurrent) {
      return errorResult(
        `Too many concurrent dispatches (max ${this.maxConcurrent}). Wait for one to finish and retry.`
      )
    }

    // Reserve the slot SYNCHRONOUSLY, before the first await: Claude can issue
    // several dispatch_agent calls in one assistant turn, whose handlers run
    // concurrently — checking the cap without reserving would let them all
    // pass. Every path from here on releases the slot via the finally below.
    this.activeDispatches++

    // Register the Stop handle IMMEDIATELY — before ANY await (ADR-033 M3).
    // TaskCard's Stop button is clickable as soon as the dispatch tool part
    // renders "running" (opencode marks it running when ctx.ask resolves),
    // which is potentially SECONDS before model resolution + target creation
    // finish (a cold per-cwd opencode server spawn can take ~15s). Registering
    // inside resolveAndRun* left that whole window unstoppable — the stop
    // missed the registry, fell through to the session path, and the dispatch
    // ran to completion (live-reproduced). A stop landing during target
    // creation aborts the controller PRE-race; both directions' race arms
    // handle that via `signal.aborted ? Promise.resolve({kind:'stop'}) : …`,
    // so the turn still ends in the 'stopped' branch (isError + notification)
    // the moment the race starts. Deleted in the finally below on every path.
    const stopController = new AbortController()
    if (ctx.toolUseId) {
      this.activeByToolUseId.set(ctx.toolUseId, {
        fromRoutingId: ctx.fromRoutingId,
        stop: () => stopController.abort()
      })
      // Consume a durable stop-intent armed BEFORE this dispatch was invoked
      // (the renderer's Stop can be clicked before the MCP tools/call even
      // reaches us — see the pendingStops field doc). Consumed regardless of
      // outcome so a LATER dispatch reusing the id is never spuriously
      // stopped; fires only when unexpired and owned by the same session.
      const intent = this.pendingStops.get(ctx.toolUseId)
      if (intent) {
        this.pendingStops.delete(ctx.toolUseId)
        const expired = intent.expiresAt <= this.now()
        const owned = intent.routingId === undefined || intent.routingId === ctx.fromRoutingId
        if (!expired && owned) {
          logger.debug(
            'CrossEngineDispatcher',
            `consuming pending stop-intent for toolUseId=${ctx.toolUseId} — aborting at start`
          )
          stopController.abort()
        }
      }
    }

    try {
      if (req.engine === 'claude') return await this.resolveAndRunClaude(req, ctx, stopController)
      if (req.engine === 'pi') return await this.resolveAndRunPi(req, ctx, stopController)
      return await this.resolveAndRunOpencode(req, ctx, stopController)
    } finally {
      this.activeDispatches--
      if (ctx.toolUseId) this.activeByToolUseId.delete(ctx.toolUseId)
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
    const pending = this.pendingApprovals.get(requestId)
    // Prefixed ids are exclusively dispatcher-owned: consume even when stale
    // (e.g. already cascade-rejected) so no session ever sees an xeng id.
    if (!pending) return true
    this.pendingApprovals.delete(requestId)

    if (pending.kind === 'claude' || pending.kind === 'pi') {
      pending.resolve(decision, answers)
      return true
    }

    const allow = decision === 'allow' || decision === 'allowForSession'
    const reply = !allow ? 'reject' : decision === 'allowForSession' ? 'always' : 'once'
    // Deny feedback is model-visible (CorrectedError, non-fatal) — parity with
    // OpencodeSession.resolveApproval.
    const message = !allow ? answers?.feedback || 'User denied' : undefined
    const replied = message
      ? pending.client.replyPermission(pending.permissionId, reply, message)
      : pending.client.replyPermission(pending.permissionId, reply)
    replied.catch((err) => {
      logger.warn(
        'CrossEngineDispatcher',
        `replyPermission failed: ${err instanceof Error ? err.message : String(err)}`
      )
    })
    return true
  }

  /** Tear down every target (+ SSE subs / server refs) owned by a dispatching session. */
  disposeFor(routingId: string): void {
    for (const [sessionId, entry] of [...this.targets]) {
      if (entry.fromRoutingId !== routingId) continue
      this.targets.delete(sessionId)
      this.dismissPendingForTarget(sessionId)
      if (entry.kind === 'opencode') {
        entry.client.deleteSession(sessionId).catch(() => {})
        this.releaseConnection(entry)
      } else if (entry.kind === 'claude') {
        // Killing the process is the only teardown a Claude target needs —
        // no server ref, no remote session to delete.
        entry.abortController.abort()
      } else {
        // pi (ADR-033 M4c): kill the child + its OWN per-target bridge host
        // (mirrors PiSession.cancel()'s identical teardown order). Both calls
        // are idempotent (PiRpcClient.dispose()/PiBridgeHost.dispose() no-op
        // if already torn down), so this is safe even if the process already
        // exited on its own (onExit already disposed the bridge host).
        entry.client.dispose()
        entry.bridgeHost.dispose()
      }
    }
  }

  // ── opencode direction (M1) ───────────────────────────────────────────────

  /** Everything past the guards for engine:'opencode' — runs with an
   *  activeDispatches slot held and the Stop handle already registered
   *  (`stopController` is created + registered in dispatchInner, BEFORE any
   *  await, so a Stop click during target creation is not lost). */
  private async resolveAndRunOpencode(
    req: DispatchRequest,
    ctx: DispatchContext,
    stopController: AbortController
  ): Promise<DispatchResult> {
    // ── Model resolution ──────────────────────────────────────────────────
    const dispatchCfg = this.deps.loadEngineConfig(req.engine).dispatch
    const model = req.model ?? dispatchCfg?.defaultModel
    if (!model) {
      return errorResult(
        'No model is configured for cross-engine dispatch into opencode. Ask the user to set ' +
          'Engines › opencode › Cross-engine dispatch (the `dispatch.defaultModel` field in ' +
          '~/.claude/ui/engines/opencode.json), or pass `model` explicitly.'
      )
    }
    const allowed = dispatchCfg?.allowedModels
    if (allowed && allowed.length > 0 && !allowed.includes(model)) {
      return errorResult(
        `Model "${model}" is not in the user-configured allowlist for opencode dispatch. ` +
          `Allowed models: ${allowed.join(', ')}`
      )
    }

    // ── Target resolution ─────────────────────────────────────────────────
    let entry: OpencodeTargetEntry
    if (req.sessionId) {
      const existing = this.targets.get(req.sessionId)
      if (!existing || existing.kind !== 'opencode' || existing.fromRoutingId !== ctx.fromRoutingId) {
        return errorResult(
          `Unknown dispatch session "${req.sessionId}" — it may have been disposed. ` +
            'Start a fresh dispatch without session_id.'
        )
      }
      // M-XE1: busy-reject BEFORE touching entry state — same rationale as the
      // Claude/pi targets. opencode drives ONE turn per session over a single
      // ambient SSE tap gated by `entry.busy`; two concurrent same-session_id
      // dispatch_agent calls (their MCP handlers overlap within one assistant
      // turn) would both clear the cost-cap check before either records spend,
      // both prompt() the same session, and the first finisher's `finally`
      // would flip `busy` off and reset `turnToolUseIds` out from under the
      // still-running second turn. Reject the second call; the running turn is
      // left completely undisturbed (no abort, no removal, no ctx swap).
      if (existing.busy) {
        return errorResult(
          `Dispatch session "${req.sessionId}" is already running a turn — wait for it to finish before continuing it.`,
          req.sessionId
        )
      }
      // ADR-033 M4-C: reject a continuation turn once this target's tracked
      // cumulative cost has met/exceeded the configured cap. The target stays
      // alive — raising dispatch.maxCostUsd or starting a fresh dispatch both
      // recover. A brand-new target (the `else` branch below) always starts
      // at cumulativeCostUsd 0, so no check is needed there.
      if (dispatchCfg?.maxCostUsd !== undefined && existing.cumulativeCostUsd >= dispatchCfg.maxCostUsd) {
        return errorResult(
          `Dispatch cost cap ($${dispatchCfg.maxCostUsd}) reached for this session ` +
            `(spent $${existing.cumulativeCostUsd.toFixed(4)}) — further turns are rejected. ` +
            'Raise dispatch.maxCostUsd in engines/opencode.json, or start a fresh dispatch.',
          existing.sessionId
        )
      }
      existing.ctx = ctx
      entry = existing
    } else {
      entry = await this.createOpencodeTarget(ctx)
    }

    // ── Run the turn ──────────────────────────────────────────────────────
    // Progress heartbeat: resets opencode's MCP callTool timeout on the
    // reverse direction later, and feeds TaskCard progress. Harmless no-op
    // for Claude-side dispatch today (in-process MCP sets no progressToken).
    let beats = 0
    const heartbeat = setInterval(() => {
      beats++
      void sendProgress(ctx.extra, {
        progress: beats,
        message: 'Dispatched agent is still working…'
      }).catch(() => {})
      emitDispatchProgress(ctx, (beats * this.heartbeatMs) / 1000)
    }, this.heartbeatMs)

    let timeoutTimer: ReturnType<typeof setTimeout> | undefined
    const signal = ctx.extra?.signal
    let abortListener: (() => void) | undefined

    // Only while a turn is actually running: gates the SSE stream tap so
    // stray events after this turn ends never emit stale deltas (ADR-033 M3).
    entry.busy = true
    // Per-turn distinct tool_use id set (ADR-033 M4-B) — fresh at the start of
    // every turn, populated by the SSE streaming tap, .size read at turn end.
    entry.turnToolUseIds = new Set()
    const turnStartedAt = this.now()

    type Raced =
      | { kind: 'ok'; resp: unknown }
      | { kind: 'err'; err: unknown }
      | { kind: 'timeout' }
      | { kind: 'abort' }
      | { kind: 'stop' }

    const promptPromise: Promise<Raced> = entry.client
      .prompt(entry.sessionId, {
        model: parseModelString(model),
        parts: [{ type: 'text', text: req.prompt }]
      })
      .then(
        (resp): Raced => ({ kind: 'ok', resp }),
        (err): Raced => ({ kind: 'err', err })
      )
    const timeoutPromise = new Promise<Raced>((resolve) => {
      timeoutTimer = setTimeout(() => resolve({ kind: 'timeout' }), this.dispatchTimeoutMs)
    })
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

    try {
      const winner = await Promise.race([promptPromise, timeoutPromise, abortPromise, stopPromise])

      if (winner.kind === 'stop') {
        // Session survives (parity with the timeout path) — abortSession
        // only interrupts THIS turn server-side; the still-pending prompt
        // promise settles via its own handlers (no unhandled rejection).
        entry.client.abortSession(entry.sessionId).catch(() => {})
        this.dismissPendingForTarget(entry.sessionId)
        emitDispatchNotification(ctx, entry.sessionId, 'stopped', 'Dispatch stopped by user.')
        return errorResult('Dispatch stopped by user.', entry.sessionId)
      }

      if (winner.kind === 'timeout' || winner.kind === 'abort') {
        // Interrupt the target turn server-side; the still-pending prompt
        // promise settles via its own handlers (no unhandled rejection).
        entry.client.abortSession(entry.sessionId).catch(() => {})
        this.dismissPendingForTarget(entry.sessionId)
        const text =
          winner.kind === 'timeout'
            ? `Dispatch timed out after ${Math.round(this.dispatchTimeoutMs / 60000)} minutes — the target agent was aborted.`
            : 'Dispatch cancelled.'
        const status = winner.kind === 'timeout' ? 'failed' : 'stopped'
        emitDispatchNotification(ctx, entry.sessionId, status, text)
        // Recorded for 'failed' (timeout) only — 'stopped' (abort/cancel) is
        // never recorded (ADR-033 M4-B: "not for stopped-before-start" — no
        // usage numbers exist for a turn that never returned a result).
        if (status === 'failed') {
          this.safeRecordUsage({
            ts: this.now(),
            fromRoutingId: ctx.fromRoutingId,
            fromEngine: ctx.fromEngine,
            targetEngine: req.engine,
            targetModel: model,
            targetSessionId: entry.sessionId,
            toolUseId: ctx.toolUseId ?? null,
            totalTokens: null,
            costUsd: null,
            durationMs: this.now() - turnStartedAt
          })
        }
        return errorResult(text, entry.sessionId)
      }
      if (winner.kind === 'err') {
        this.dismissPendingForTarget(entry.sessionId)
        const msg = winner.err instanceof Error ? winner.err.message : String(winner.err)
        emitDispatchNotification(ctx, entry.sessionId, 'failed', `Dispatched turn failed: ${msg}`)
        this.safeRecordUsage({
          ts: this.now(),
          fromRoutingId: ctx.fromRoutingId,
          fromEngine: ctx.fromEngine,
          targetEngine: req.engine,
          targetModel: model,
          targetSessionId: entry.sessionId,
          toolUseId: ctx.toolUseId ?? null,
          totalTokens: null,
          costUsd: null,
          durationMs: this.now() - turnStartedAt
        })
        return errorResult(`Dispatched turn failed: ${msg}`, entry.sessionId)
      }

      const resp = winner.resp as
        | {
            info?: {
              error?: { name?: string; data?: { message?: string } }
              tokens?: { input?: number; output?: number; reasoning?: number }
              cost?: number
            }
            parts?: Array<{ type?: string; text?: string }>
          }
        | undefined
      // opencode's POST /session/{id}/message RESOLVES even when the model turn
      // errors — the failure lives on info.error (a named-error union, each
      // { name, data?: { message? } }). Surface it as an isError instead of
      // silently returning the empty-text fallback (hiding a hard failure like
      // "Key limit exceeded" as an apparent success). Target stays alive for
      // continuation, so return its sessionId (parity with other error paths).
      const turnError = resp?.info?.error
      if (turnError) {
        this.dismissPendingForTarget(entry.sessionId)
        const detail =
          turnError.data?.message || turnError.name || 'the dispatched agent reported an error'
        emitDispatchNotification(ctx, entry.sessionId, 'failed', `Dispatched turn failed: ${detail}`)
        // opencode RESOLVES the prompt with real `info.tokens`/`info.cost` even
        // when the turn reports an error (the turn ran, it just didn't finish
        // cleanly) — capture that spend instead of fabricating nulls, and fold
        // it into the cap + Slice-C breakdown. Mirrors the Claude failed-subtype
        // path; without it a target whose turns keep erroring spends real tokens
        // that never count toward maxCostUsd or the dispatching session's cost.
        const errInfoTokens = resp?.info?.tokens
        const errTotalTokens = errInfoTokens
          ? (errInfoTokens.input ?? 0) + (errInfoTokens.output ?? 0) + (errInfoTokens.reasoning ?? 0)
          : 0
        const errTurnCostUsd = resp?.info?.cost ?? 0
        this.safeRecordUsage({
          ts: this.now(),
          fromRoutingId: ctx.fromRoutingId,
          fromEngine: ctx.fromEngine,
          targetEngine: req.engine,
          targetModel: model,
          targetSessionId: entry.sessionId,
          toolUseId: ctx.toolUseId ?? null,
          totalTokens: errTotalTokens > 0 ? errTotalTokens : null,
          costUsd: errTurnCostUsd > 0 ? errTurnCostUsd : null,
          durationMs: this.now() - turnStartedAt
        })
        if (Number.isFinite(errTurnCostUsd) && errTurnCostUsd > 0) {
          ctx.addDispatchedCost?.(req.engine, model, errTurnCostUsd)
          entry.cumulativeCostUsd += errTurnCostUsd
        }
        return errorResult(`Dispatched turn failed: ${detail}`, entry.sessionId)
      }
      const text = (resp?.parts ?? [])
        .filter((p) => p?.type === 'text')
        .map((p) => p?.text ?? '')
        .join('')
      const finalText = text || '(the dispatched agent returned no text)'

      // ── Usage capture (ADR-033 M4-B) ────────────────────────────────────
      // opencode's `info.tokens`/`info.cost` are a per-MESSAGE (i.e. per-turn
      // — each turn creates a new message id) cumulative snapshot, same shape
      // event-mapper.ts reads for OpencodeSession's own metering.
      const infoTokens = resp?.info?.tokens
      const totalTokens = infoTokens
        ? (infoTokens.input ?? 0) + (infoTokens.output ?? 0) + (infoTokens.reasoning ?? 0)
        : 0
      const turnCostUsd = resp?.info?.cost ?? 0
      const durationMs = this.now() - turnStartedAt

      // ── Cost cap crossing note (ADR-033 M4-C) ───────────────────────────
      const maxCostUsd = dispatchCfg?.maxCostUsd
      const wasUnderCap = maxCostUsd === undefined || entry.cumulativeCostUsd < maxCostUsd
      entry.cumulativeCostUsd += turnCostUsd
      let outText = finalText
      if (maxCostUsd !== undefined && wasUnderCap && entry.cumulativeCostUsd >= maxCostUsd) {
        outText += '\n\n[dispatch cost cap reached — further turns on this session will be rejected]'
      }

      // ── Fold into the dispatching session's own cost breakdown (Slice C) ──
      if (Number.isFinite(turnCostUsd) && turnCostUsd > 0) {
        ctx.addDispatchedCost?.(req.engine, model, turnCostUsd)
      }

      emitDispatchNotification(ctx, entry.sessionId, 'completed', finalText, {
        totalTokens,
        toolUses: entry.turnToolUseIds.size,
        durationMs
      })
      this.safeRecordUsage({
        ts: this.now(),
        fromRoutingId: ctx.fromRoutingId,
        fromEngine: ctx.fromEngine,
        targetEngine: req.engine,
        targetModel: model,
        targetSessionId: entry.sessionId,
        toolUseId: ctx.toolUseId ?? null,
        totalTokens,
        costUsd: turnCostUsd,
        durationMs
      })
      return { text: outText, sessionId: entry.sessionId }
    } finally {
      entry.busy = false
      clearInterval(heartbeat)
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (signal && abortListener) signal.removeEventListener('abort', abortListener)
    }
  }

  private async createOpencodeTarget(ctx: DispatchContext): Promise<OpencodeTargetEntry> {
    const cwdKey = resolvePath(ctx.cwd)
    // One serverManager ref per target; the per-cwd client + SSE loop are shared.
    const conn = await this.deps.serverManager.acquire(ctx.cwd)
    let rec = this.connections.get(cwdKey)
    if (!rec) {
      rec = {
        client: this.deps.makeClient(conn.baseUrl, conn.authHeader),
        sseAbort: new AbortController(),
        targetCount: 0
      }
      this.connections.set(cwdKey, rec)
      void this.runSseLoop(rec)
    }
    rec.targetCount++

    try {
      const session = await rec.client.createSession({ title: 'xeng-dispatch' })
      // Inherit the dispatcher's autonomy mode, plus a structural recursion
      // guard: the target can never call the dispatch tool back (ADR-033 §4).
      const ruleset: PermissionRule[] = [
        ...buildRuleset(ctx.autonomyMode),
        { permission: 'claudeui_dispatch_agent*', pattern: '*', action: 'deny' }
      ]
      await rec.client.patchSession(session.id, { permission: ruleset })

      const entry: OpencodeTargetEntry = {
        kind: 'opencode',
        sessionId: session.id,
        fromRoutingId: ctx.fromRoutingId,
        cwd: ctx.cwd,
        cwdKey,
        client: rec.client,
        ctx,
        busy: false,
        accumulators: new Map(),
        cumulativeCostUsd: 0,
        turnToolUseIds: new Set()
      }
      this.targets.set(session.id, entry)
      return entry
    } catch (err) {
      // Roll back the ref we took for this target.
      this.releaseConnection({ cwd: ctx.cwd, cwdKey })
      throw err
    }
  }

  private releaseConnection(entry: Pick<OpencodeTargetEntry, 'cwd' | 'cwdKey'>): void {
    this.deps.serverManager.release(entry.cwd)
    const rec = this.connections.get(entry.cwdKey)
    if (!rec) return
    rec.targetCount--
    if (rec.targetCount <= 0) {
      this.connections.delete(entry.cwdKey)
      rec.sseAbort.abort()
    }
  }

  // ── SSE approval forwarding (opencode targets only) ──────────────────────

  private async runSseLoop(rec: ConnRecord): Promise<void> {
    // opencode holds /event open for the server's lifetime, so a non-aborted end
    // (stream close or transport error) means the subscription DROPPED, not that
    // we are done. Un-retried, `permission.asked` forwarding for EVERY target on
    // this cwd dies silently and their dispatches hang to the 10-min timeout with
    // no card ever shown. Reconnect until the record is torn down —
    // releaseConnection() aborts `sseAbort` when the last target leaves, which
    // both ends the for-await and breaks this loop.
    while (!rec.sseAbort.signal.aborted) {
      try {
        // subscribeEvents is UNFILTERED — we filter by registered target ids.
        for await (const ev of rec.client.subscribeEvents(rec.sseAbort.signal)) {
          if (rec.sseAbort.signal.aborted) break
          this.handleSseEvent(ev)
        }
      } catch (err) {
        if (!rec.sseAbort.signal.aborted) {
          logger.warn(
            'CrossEngineDispatcher',
            `SSE loop error (will reconnect): ${err instanceof Error ? err.message : String(err)}`
          )
        }
      }
      if (rec.sseAbort.signal.aborted) break
      // Stream ended/broke while targets are still live. Pause briefly before
      // re-subscribing so a genuinely dead server can't hot-spin the loop (the
      // pending dispatches' own 10-min timeouts still bound the worst case).
      await this.sseReconnectDelay(rec.sseAbort.signal)
    }
  }

  /** Abortable delay between SSE reconnect attempts (see runSseLoop). Resolves
   *  early if the record is torn down mid-wait, and never leaks its abort
   *  listener. Overridable via deps for tests. */
  private sseReconnectDelay(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const onAbort = (): void => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, this.sseReconnectDelayMs)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  private handleSseEvent(ev: OpencodeEvent): void {
    const props = ev.properties

    if (ev.type === 'message.part.delta' || ev.type === 'message.part.updated') {
      this.handleOpencodeTargetStream(ev)
      return
    }

    if (ev.type === 'permission.asked') {
      const sessionID = props.sessionID as string | undefined
      const id = props.id as string | undefined
      if (!sessionID || !id) return
      const entry = this.targets.get(sessionID)
      if (!entry || entry.kind !== 'opencode') return // foreign session — not an opencode dispatch target

      const requestId = XENG_REQUEST_PREFIX + id
      const permission = (props.permission as string | undefined) ?? 'tool'
      const metadata = (props.metadata as Record<string, unknown> | undefined) ?? {}
      const patterns = props.patterns as string[] | undefined
      const approval: PendingApproval = {
        requestId,
        toolName: `dispatch:${permission}`,
        input: { ...metadata, ...(patterns ? { patterns } : {}) }
      }
      this.pendingApprovals.set(requestId, {
        kind: 'opencode',
        permissionId: id,
        targetSessionId: sessionID,
        client: entry.client,
        emit: entry.ctx.emit
      })
      // The dispatching session's emit puts its own routingId on the wire, so
      // the approval card shows on the dispatching chat with zero renderer changes.
      entry.ctx.emit('session:approval-request', approval)
      return
    }

    if (ev.type === 'permission.replied') {
      // opencode resolved a permission without us — its deny-cascade bare-rejects
      // every other pending ask in the session (ADR-033). Reconcile: drop our
      // pending entry and dismiss the renderer card. (When WE replied, the entry
      // was already deleted in resolveApproval, so this is a no-op.)
      const requestID = props.requestID as string | undefined
      if (!requestID) return
      const key = XENG_REQUEST_PREFIX + requestID
      const pending = this.pendingApprovals.get(key)
      if (!pending) return
      this.pendingApprovals.delete(key)
      pending.emit('session:approval-dismiss', { requestId: key })
    }
  }

  /**
   * Forward an opencode dispatch target's live turn output as engine-neutral
   * subagent events (ADR-033 M3). Reuses `mapEvent` (event-mapper.ts) by
   * treating the TARGET's session id as the "own" session — the exact same
   * message.part.delta/updated → {stream|message} logic OpencodeSession.ts
   * uses for its own turns, just re-keyed to the dispatching tool_use id.
   *
   * Gated on `entry.busy` (a completed/aborted turn's trailing SSE chatter
   * must never emit) and `entry.ctx.toolUseId` (no id → no way to key the
   * event on the renderer side — never fail the dispatch over it, just skip).
   */
  private handleOpencodeTargetStream(ev: OpencodeEvent): void {
    const sessionID = ev.properties.sessionID as string | undefined
    if (!sessionID) return
    const entry = this.targets.get(sessionID)
    if (!entry || entry.kind !== 'opencode' || !entry.busy) return
    const toolUseId = entry.ctx.toolUseId
    if (!toolUseId) return

    // startTimeMs/totalCostUsd are only consumed by mapEvent's cost_update /
    // result branches — irrelevant here (completion comes from the `prompt()`
    // promise, not SSE), so dummy values are fine.
    const output = mapEvent(ev, sessionID, entry.accumulators, Date.now(), { value: 0 })
    if (output.kind === 'stream') {
      entry.ctx.emit('session:subagent-stream', {
        toolUseId,
        type: output.streamType,
        text: output.delta
      })
    } else if (output.kind === 'message') {
      collectToolUseIds(output.message, entry.turnToolUseIds)
      entry.ctx.emit('session:subagent-message', { toolUseId, message: output.message })
    }
  }

  // ── Claude direction (M2) ─────────────────────────────────────────────────

  /** Everything past the guards for engine:'claude' — runs with an
   *  activeDispatches slot held and the Stop handle already registered
   *  (`stopController` is created + registered in dispatchInner, BEFORE any
   *  await, so a Stop click during spawnClaudeQuery is not lost). */
  private async resolveAndRunClaude(
    req: DispatchRequest,
    ctx: DispatchContext,
    stopController: AbortController
  ): Promise<DispatchResult> {
    // ── Model resolution ──────────────────────────────────────────────────
    const dispatchCfg = this.deps.loadEngineConfig('claude').dispatch
    const model = req.model ?? dispatchCfg?.defaultModel
    if (!model) {
      return errorResult(
        'No model is configured for cross-engine dispatch into Claude. Ask the user to set ' +
          'Engines › Claude › Cross-engine dispatch (the `dispatch.defaultModel` field in ' +
          '~/.claude/ui/engines/claude.json), or pass `model` explicitly.'
      )
    }
    const allowed = dispatchCfg?.allowedModels
    if (allowed && allowed.length > 0 && !allowed.includes(model)) {
      return errorResult(
        `Model "${model}" is not in the user-configured allowlist for Claude dispatch. ` +
          `Allowed models: ${allowed.join(', ')}`
      )
    }

    // ── Target resolution ─────────────────────────────────────────────────
    let entry: ClaudeTargetEntry
    if (req.sessionId) {
      const existing = this.targets.get(req.sessionId)
      if (!existing || existing.kind !== 'claude' || existing.fromRoutingId !== ctx.fromRoutingId) {
        return errorResult(
          `Unknown dispatch session "${req.sessionId}" — it may have been disposed. ` +
            'Start a fresh dispatch without session_id.'
        )
      }
      // Busy-reject BEFORE pushing a prompt or touching entry state (see the
      // `busy` doc comment on ClaudeTargetEntry). The running turn is left
      // completely undisturbed — no abort, no entry removal, no ctx swap.
      if (existing.busy) {
        return errorResult(
          `Dispatch session "${req.sessionId}" is already running a turn — wait for it to finish before continuing it.`,
          req.sessionId
        )
      }
      // ADR-033 M4-C: reject a continuation turn once this target's tracked
      // cumulative cost has met/exceeded the configured cap (same semantics
      // as the opencode direction above). A brand-new target always starts at
      // cumulativeCostUsd 0.
      if (dispatchCfg?.maxCostUsd !== undefined && existing.cumulativeCostUsd >= dispatchCfg.maxCostUsd) {
        return errorResult(
          `Dispatch cost cap ($${dispatchCfg.maxCostUsd}) reached for this session ` +
            `(spent $${existing.cumulativeCostUsd.toFixed(4)}) — further turns are rejected. ` +
            'Raise dispatch.maxCostUsd in engines/claude.json, or start a fresh dispatch.',
          req.sessionId
        )
      }
      existing.ctx = ctx
      entry = existing
    } else {
      const shell = this.createClaudeTargetShell(ctx)
      entry = shell.entry
      try {
        const mode = mapAutonomyToClaudeTargetMode(ctx.autonomyMode)
        entry.query = await this.spawnClaudeQuery({
          cwd: ctx.cwd,
          model,
          permissionMode: mode.permissionMode,
          allowDangerouslySkipPermissions: mode.allowDangerouslySkipPermissions,
          canUseTool: shell.canUseTool,
          abortController: entry.abortController,
          prompt: entry.channel
        })
        entry.iterator = entry.query[Symbol.asyncIterator]()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return errorResult(`Failed to start dispatched Claude agent: ${msg}`)
      }
    }

    // Mark busy BEFORE the push: driveClaudeTurn registers the entry in
    // this.targets as soon as session_id arrives (mid-turn), making it
    // continuable — a concurrent same-session_id dispatch must already see
    // busy=true at that point. Cleared in the finally below on EVERY path
    // (success, turn error, timeout, abort) — including the paths that
    // remove the entry, where it's harmless.
    entry.busy = true
    // Per-turn distinct tool_use id set (ADR-033 M4-B) — fresh at the start of
    // every turn, populated by forwardClaudeTargetMessage, .size read at turn end.
    entry.turnToolUseIds = new Set()
    entry.channel.push(buildClaudeDispatchMessage(req.prompt, entry.sessionId))

    // ── Run the turn ──────────────────────────────────────────────────────
    let beats = 0
    const heartbeat = setInterval(() => {
      beats++
      void sendProgress(ctx.extra, {
        progress: beats,
        message: 'Dispatched agent is still working…'
      }).catch(() => {})
      emitDispatchProgress(ctx, (beats * this.heartbeatMs) / 1000)
    }, this.heartbeatMs)

    let timeoutTimer: ReturnType<typeof setTimeout> | undefined
    const signal = ctx.extra?.signal
    let abortListener: (() => void) | undefined

    type Raced =
      | { kind: 'ok'; msg: ResultMessage }
      | { kind: 'err'; err: unknown }
      | { kind: 'timeout' }
      | { kind: 'abort' }
      | { kind: 'stop' }

    const turnPromise: Promise<Raced> = this.driveClaudeTurn(entry).then(
      (msg): Raced => ({ kind: 'ok', msg }),
      (err): Raced => ({ kind: 'err', err })
    )
    const timeoutPromise = new Promise<Raced>((resolve) => {
      timeoutTimer = setTimeout(() => resolve({ kind: 'timeout' }), this.dispatchTimeoutMs)
    })
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

    try {
      const winner = await Promise.race([turnPromise, timeoutPromise, abortPromise, stopPromise])

      if (winner.kind === 'timeout' || winner.kind === 'abort' || winner.kind === 'stop') {
        // Unlike opencode (abortSession stops the turn, session survives),
        // aborting a Claude target's AbortController KILLS THE PROCESS — so
        // continuation is impossible either way. Remove the entry entirely.
        entry.abortController.abort()
        if (entry.sessionId) {
          this.dismissPendingForTarget(entry.sessionId)
          this.targets.delete(entry.sessionId)
        }
        const text =
          winner.kind === 'timeout'
            ? `Dispatch timed out after ${Math.round(this.dispatchTimeoutMs / 60000)} minutes — the target agent was aborted.`
            : winner.kind === 'stop'
              ? 'Dispatch stopped by user.'
              : 'Dispatch cancelled.'
        const status = winner.kind === 'timeout' ? 'failed' : 'stopped'
        emitDispatchNotification(ctx, entry.sessionId ?? '', status, text)
        // Recorded for 'failed' (timeout) only — 'stopped' (abort/user-stop)
        // is never recorded (ADR-033 M4-B: no usage numbers exist for a turn
        // that never returned a result).
        if (status === 'failed') {
          this.safeRecordUsage({
            ts: this.now(),
            fromRoutingId: ctx.fromRoutingId,
            fromEngine: ctx.fromEngine,
            targetEngine: 'claude',
            targetModel: model,
            targetSessionId: entry.sessionId,
            toolUseId: ctx.toolUseId ?? null,
            totalTokens: null,
            costUsd: null,
            durationMs: null
          })
        }
        return errorResult(text, entry.sessionId ?? '')
      }
      if (winner.kind === 'err') {
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
          fromEngine: ctx.fromEngine,
          targetEngine: 'claude',
          targetModel: model,
          targetSessionId: entry.sessionId,
          toolUseId: ctx.toolUseId ?? null,
          totalTokens: null,
          costUsd: null,
          durationMs: null
        })
        return errorResult(`Dispatched turn failed: ${msg}`, entry.sessionId ?? '')
      }

      const result = winner.msg
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
        | { input_tokens?: number; output_tokens?: number }
        | undefined
      const totalTokens = usageFields
        ? (usageFields.input_tokens ?? 0) + (usageFields.output_tokens ?? 0)
        : 0
      const reportedTotalCostUsd = result.total_cost_usd ?? entry.lastReportedTotalCostUsd
      const turnCostUsd = Math.max(0, reportedTotalCostUsd - entry.lastReportedTotalCostUsd)
      entry.lastReportedTotalCostUsd = reportedTotalCostUsd
      const durationMs = result.duration_ms ?? null

      // A turn-level error (see docs/protocol-cc/03-inbound-messages.md §result
      // subtypes) does NOT kill the process — the target stays alive for
      // continuation, parity with the opencode info.error handling above.
      if (result.subtype && result.subtype !== 'success') {
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
          fromEngine: ctx.fromEngine,
          targetEngine: 'claude',
          targetModel: model,
          targetSessionId: entry.sessionId,
          toolUseId: ctx.toolUseId ?? null,
          totalTokens,
          costUsd: turnCostUsd,
          durationMs
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
        outText += '\n\n[dispatch cost cap reached — further turns on this session will be rejected]'
      }

      // ── Fold into the dispatching session's own cost breakdown (Slice C) ──
      if (Number.isFinite(turnCostUsd) && turnCostUsd > 0) {
        ctx.addDispatchedCost?.('claude', model, turnCostUsd)
      }

      emitDispatchNotification(ctx, entry.sessionId ?? '', 'completed', finalText, {
        totalTokens,
        toolUses: entry.turnToolUseIds.size,
        durationMs: durationMs ?? 0
      })
      this.safeRecordUsage({
        ts: this.now(),
        fromRoutingId: ctx.fromRoutingId,
        fromEngine: ctx.fromEngine,
        targetEngine: 'claude',
        targetModel: model,
        targetSessionId: entry.sessionId,
        toolUseId: ctx.toolUseId ?? null,
        totalTokens,
        costUsd: turnCostUsd,
        durationMs
      })
      return {
        text: outText,
        sessionId: entry.sessionId ?? ''
      }
    } finally {
      entry.busy = false
      clearInterval(heartbeat)
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (signal && abortListener) signal.removeEventListener('abort', abortListener)
    }
  }

  /**
   * Read messages from the target's ONE iterator until `result` arrives,
   * capturing session_id (and registering the entry in `this.targets`) the
   * first time it's seen. NEVER uses `for await` — see the `.return()`
   * hazard documented on `ClaudeTargetEntry`.
   */
  private async driveClaudeTurn(entry: ClaudeTargetEntry): Promise<ResultMessage> {
    for (;;) {
      const { value, done } = await entry.iterator.next()
      if (done) {
        throw new Error('Claude target process ended unexpectedly')
      }
      const msg = value as SDKMessage
      if (msg.session_id && !entry.sessionId) {
        entry.sessionId = msg.session_id
        this.targets.set(msg.session_id, entry)
      }
      this.forwardClaudeTargetMessage(entry, msg)
      if (msg.type === 'result') {
        return msg as ResultMessage
      }
    }
  }

  /**
   * Forward a Claude dispatch target's live turn output as engine-neutral
   * subagent events (ADR-033 M3), keyed by the CURRENT dispatching tool_use
   * id (`entry.ctx.toolUseId` — refreshed on every continuation call, so a
   * mid-turn message always lands on whichever call is actively driving it).
   * No-ops entirely when the id is unset — never fail a dispatch over it.
   *
   * `includePartialMessages: true` (set in `defaultSpawnClaudeQuery`) makes
   * cli.js emit `stream_event` deltas exactly like a native subagent's
   * `parent_tool_use_id`-routed frames (claude-session.ts's
   * `handleStreamEvent`) — this mirrors that mapping verbatim, just re-keyed.
   */
  private forwardClaudeTargetMessage(entry: ClaudeTargetEntry, msg: SDKMessage): void {
    const toolUseId = entry.ctx.toolUseId
    if (!toolUseId) return

    if (msg.type === 'stream_event') {
      const event = (msg as { event?: { type?: string; delta?: Record<string, unknown> } }).event
      if (!event || event.type !== 'content_block_delta' || !event.delta) return
      const delta = event.delta
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        entry.ctx.emit('session:subagent-stream', { toolUseId, type: 'text', text: delta.text })
      } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        entry.ctx.emit('session:subagent-stream', {
          toolUseId,
          type: 'thinking',
          text: delta.thinking
        })
      }
      return
    }

    if (msg.type === 'assistant') {
      const chatMsg = transformAssistantMessage(msg as unknown as Record<string, unknown>)
      if (chatMsg) {
        collectToolUseIds(chatMsg, entry.turnToolUseIds)
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
   * Build the entry shell + its canUseTool BEFORE spawning: canUseTool must
   * exist to pass into spawnClaudeQuery, but it needs to read the entry's
   * LIVE fields (sessionId, ctx) — which aren't known until after spawn. The
   * closure below captures `entry` by reference (not by value), so by the
   * time a real tool call fires (always after spawn completes), the shell's
   * `query`/`iterator` fields are already populated by the caller.
   */
  private createClaudeTargetShell(ctx: DispatchContext): {
    entry: ClaudeTargetEntry
    canUseTool: CanUseTool
  } {
    const abortController = new AbortController()
    const channel = new ClaudeInputChannel()
    const entry: ClaudeTargetEntry = {
      kind: 'claude',
      sessionId: null,
      fromRoutingId: ctx.fromRoutingId,
      cwd: ctx.cwd,
      channel,
      // Populated by the caller immediately after spawnClaudeQuery resolves.
      query: undefined as unknown as QueryHandle,
      iterator: undefined as unknown as AsyncIterator<SDKMessage>,
      abortController,
      busy: false,
      ctx,
      cumulativeCostUsd: 0,
      lastReportedTotalCostUsd: 0,
      turnToolUseIds: new Set()
    }
    const canUseTool: CanUseTool = async (
      toolName: string,
      input: Record<string, unknown>,
      opts: CanUseToolContext
    ): Promise<CanUseToolResult> => this.awaitClaudeTargetApproval(entry, toolName, input, opts)
    return { entry, canUseTool }
  }

  /**
   * Forward a Claude target's tool-approval request into the dispatching
   * session's chat (ADR-033 M2 item 7) — the Claude-target mirror of the SSE
   * loop's `permission.asked` handling for opencode targets.
   */
  private awaitClaudeTargetApproval(
    entry: ClaudeTargetEntry,
    toolName: string,
    input: Record<string, unknown>,
    opts: CanUseToolContext
  ): Promise<CanUseToolResult> {
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
          const pending = this.pendingApprovals.get(requestId)
          if (!pending) return
          this.pendingApprovals.delete(requestId)
          entry.ctx.emit('session:approval-dismiss', { requestId })
          resolve({ behavior: 'deny', message: 'Dispatch cancelled' })
        },
        { once: true }
      )
    })
  }

  /** Dismiss all forwarded approvals for one target (timeout/abort/dispose).
   *  Claude/pi-kind resolvers are ALSO resolved with deny — never leave a
   *  hanging canUseTool/gate promise (ADR-033 M2 item 7, extended to pi in M4c). */
  private dismissPendingForTarget(targetSessionId: string): void {
    for (const [key, pending] of [...this.pendingApprovals]) {
      if (pending.targetSessionId !== targetSessionId) continue
      this.pendingApprovals.delete(key)
      pending.emit('session:approval-dismiss', { requestId: key })
      if (pending.kind === 'claude' || pending.kind === 'pi') {
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
   * breakdown, exactly like a successful turn does. `entry.mapperState.
   * totalCostUsd` is the right source here (NOT anything derived from the
   * turn's own outcome, since a non-success outcome carries no such number):
   * it is the mapper's per-PROCESS running total, incremented by `mapPiEvent`
   * on every cost-bearing assistant message REGARDLESS of which turn produced
   * it or how that turn ended (see event-mapper.ts's `PiMapperState.
   * totalCostUsd` doc) — so it already reflects whatever the abandoned turn
   * actually spent by the time the caller reads it. Returns the turn's own
   * delta (>= 0) for the caller to fold into a usage row.
   */
  private accountPiNonSuccessCost(entry: PiTargetEntry, ctx: DispatchContext, model: string): number {
    const turnCostUsd = Math.max(0, entry.mapperState.totalCostUsd - entry.lastReportedTotalCostUsd)
    entry.lastReportedTotalCostUsd = entry.mapperState.totalCostUsd
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
   * branches). `entry.mapperState.totalCostUsd` only grows via cost-bearing
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
   * the read succeeds AND reports MORE than `entry.mapperState.totalCostUsd`,
   * that authoritative number is used IN PLACE OF the mapper's total for the
   * delta + baseline advance below; otherwise this is behaviorally IDENTICAL
   * to `accountPiNonSuccessCost`.
   */
  private async accountPiNonSuccessCostReconciled(
    entry: PiTargetEntry,
    ctx: DispatchContext,
    model: string
  ): Promise<number> {
    let totalCostUsd = entry.mapperState.totalCostUsd
    try {
      const statsResp = await entry.client.request<PiGetSessionStatsData>(
        { type: 'get_session_stats' },
        GET_SESSION_STATS_RECONCILE_TIMEOUT_MS
      )
      if (statsResp.success && statsResp.data && statsResp.data.cost > totalCostUsd) {
        totalCostUsd = statsResp.data.cost
      }
    } catch (err) {
      logger.warn(
        'CrossEngineDispatcher',
        `pi get_session_stats cost reconciliation failed (falling back to streamed cost): ${err instanceof Error ? err.message : String(err)}`
      )
    }
    const turnCostUsd = Math.max(0, totalCostUsd - entry.lastReportedTotalCostUsd)
    entry.lastReportedTotalCostUsd = totalCostUsd
    entry.cumulativeCostUsd += turnCostUsd
    if (turnCostUsd > 0) {
      ctx.addDispatchedCost?.('pi', model, turnCostUsd)
    }
    return turnCostUsd
  }

  // ── pi direction (M4c) ────────────────────────────────────────────────────

  /**
   * Everything past the guards for engine:'pi' — runs with an activeDispatches
   * slot held and the Stop handle already registered (mirrors
   * resolveAndRunClaude/resolveAndRunOpencode's identical preamble).
   */
  private async resolveAndRunPi(
    req: DispatchRequest,
    ctx: DispatchContext,
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
    const model = req.model ?? dispatchCfg?.defaultModel
    if (!model) {
      return errorResult(
        'No model is configured for cross-engine dispatch into pi. Ask the user to set ' +
          'Engines › pi › Cross-engine dispatch (the `dispatch.defaultModel` field in ' +
          '~/.claude/ui/engines/pi.json), or pass `model` explicitly.'
      )
    }
    const allowed = dispatchCfg?.allowedModels
    if (allowed && allowed.length > 0 && !allowed.includes(model)) {
      return errorResult(
        `Model "${model}" is not in the user-configured allowlist for pi dispatch. ` +
          `Allowed models: ${allowed.join(', ')}`
      )
    }

    // ── Target resolution ─────────────────────────────────────────────────
    let entry: PiTargetEntry
    if (req.sessionId) {
      const existing = this.targets.get(req.sessionId)
      if (!existing || existing.kind !== 'pi' || existing.fromRoutingId !== ctx.fromRoutingId) {
        return errorResult(
          `Unknown dispatch session "${req.sessionId}" — it may have been disposed. ` +
            'Start a fresh dispatch without session_id.'
        )
      }
      // Busy-reject BEFORE touching entry state — same rationale as the
      // Claude target (one ambient event stream per process; interleaving two
      // turns would have no way to tell which `result` belongs to which caller).
      if (existing.busy) {
        return errorResult(
          `Dispatch session "${req.sessionId}" is already running a turn — wait for it to finish before continuing it.`,
          req.sessionId
        )
      }
      if (dispatchCfg?.maxCostUsd !== undefined && existing.cumulativeCostUsd >= dispatchCfg.maxCostUsd) {
        return errorResult(
          `Dispatch cost cap ($${dispatchCfg.maxCostUsd}) reached for this session ` +
            `(spent $${existing.cumulativeCostUsd.toFixed(4)}) — further turns are rejected. ` +
            'Raise dispatch.maxCostUsd in engines/pi.json, or start a fresh dispatch.',
          req.sessionId
        )
      }
      existing.ctx = ctx
      entry = existing
    } else {
      try {
        entry = await this.createPiTarget(ctx, model)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return errorResult(`Failed to start dispatched pi agent: ${msg}`)
      }
    }

    // Mark busy BEFORE the prompt is sent — fresh per-turn accumulators.
    entry.busy = true
    entry.turnToolUseIds = new Set()
    entry.turnTotalTokens = 0

    // ── Run the turn ──────────────────────────────────────────────────────
    let beats = 0
    const heartbeat = setInterval(() => {
      beats++
      void sendProgress(ctx.extra, {
        progress: beats,
        message: 'Dispatched agent is still working…'
      }).catch(() => {})
      emitDispatchProgress(ctx, (beats * this.heartbeatMs) / 1000)
    }, this.heartbeatMs)

    let timeoutTimer: ReturnType<typeof setTimeout> | undefined
    const signal = ctx.extra?.signal
    let abortListener: (() => void) | undefined

    type Raced =
      | { kind: 'ok'; outcome: Extract<PiTurnOutcome, { kind: 'ok' }> }
      | { kind: 'err'; message: string }
      | { kind: 'timeout' }
      | { kind: 'abort' }
      | { kind: 'stop' }

    const turnPromise: Promise<Raced> = this.drivePiTurn(entry, req.prompt).then(
      (outcome): Raced =>
        outcome.kind === 'ok' ? { kind: 'ok', outcome } : { kind: 'err', message: outcome.message }
    )
    const timeoutPromise = new Promise<Raced>((resolve) => {
      timeoutTimer = setTimeout(() => resolve({ kind: 'timeout' }), this.dispatchTimeoutMs)
    })
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

    try {
      const winner = await Promise.race([turnPromise, timeoutPromise, abortPromise, stopPromise])

      if (winner.kind === 'timeout' || winner.kind === 'abort' || winner.kind === 'stop') {
        // See PiTargetEntry.draining's doc comment — set FIRST, synchronously,
        // before the `abort` RPC even sends, so no late 'ask' from this turn
        // can possibly race ahead of it.
        entry.draining = true
        // DIVERGES FROM CLAUDE: pi's `abort` interrupts the CURRENT TURN only
        // (session survives — verified; see PiTargetEntry's doc comment) —
        // mirrors the OPENCODE target's survive-the-process pattern, so the
        // entry is kept alive for continuation rather than torn down.
        void entry.client.request({ type: 'abort' }).catch(() => {})
        // RACE GUARD (see PiTargetEntry.settled's "RACE NOTE"): wait, BOUNDED,
        // for the ABANDONED turn's own terminal event sequence (still in
        // flight — triggered by the abort just sent) to drain and settle
        // `entry.settled` back to null BEFORE releasing `busy` in the
        // `finally` below. Without this, a fast-enough continuation could
        // install a NEW settle wrapper here while the stale one is still
        // pending delivery — pi's wire has no per-event turn correlation, so
        // whichever wrapper is CURRENTLY installed receives the next
        // settle-shaped event regardless of which turn actually produced it.
        let graceTimer: ReturnType<typeof setTimeout> | undefined
        await Promise.race([
          turnPromise,
          new Promise<void>((r) => {
            graceTimer = setTimeout(r, this.piAbortSettleGraceMs)
          })
        ])
        if (graceTimer) clearTimeout(graceTimer)
        entry.settled = null // belt-and-suspenders if the grace period elapsed first
        // Read AFTER the grace-period wait, not before — the abandoned turn's
        // own trailing cost-bearing events can still land during that window
        // (see the RACE GUARD above), so this is the earliest point the
        // mapper's running total can be trusted as final for this turn.
        // Audit-residual C fix: ONLY the 'timeout' outcome reconciles against
        // get_session_stats (a genuine failure — it gets a usage row below).
        // 'stop'/'abort' deliberately do NOT — ADR-033 M4-B already records no
        // usage row for either, and a follow-up RPC to a target the user just
        // asked to stop would be pure latency for no observable benefit.
        const turnCostUsd =
          winner.kind === 'timeout'
            ? await this.accountPiNonSuccessCostReconciled(entry, ctx, model)
            : this.accountPiNonSuccessCost(entry, ctx, model)
        if (entry.sessionId) this.dismissPendingForTarget(entry.sessionId)
        const text =
          winner.kind === 'timeout'
            ? `Dispatch timed out after ${Math.round(this.dispatchTimeoutMs / 60000)} minutes — the target agent was interrupted (the session survives; a fresh turn may still be dispatched against it).`
            : winner.kind === 'stop'
              ? 'Dispatch stopped by user.'
              : 'Dispatch cancelled.'
        const status = winner.kind === 'timeout' ? 'failed' : 'stopped'
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
            fromEngine: ctx.fromEngine,
            targetEngine: 'pi',
            targetModel: model,
            targetSessionId: entry.sessionId,
            toolUseId: ctx.toolUseId ?? null,
            totalTokens: entry.turnTotalTokens > 0 ? entry.turnTotalTokens : null,
            costUsd: turnCostUsd > 0 ? turnCostUsd : null,
            durationMs: null
          })
        }
        return errorResult(text, entry.sessionId ?? '')
      }

      if (winner.kind === 'err') {
        // Also NOT torn down — pi's own error surface (a rejected prompt ack,
        // an extension_error) mostly leaves the process alive; a genuinely
        // dead process (the onExit case) self-diagnoses cleanly on the NEXT
        // continuation attempt instead (PiRpcClient.request() already guards
        // "process is not running"), so no extra liveness tracking is needed
        // here — see the M4c report for the full rationale.
        if (entry.sessionId) this.dismissPendingForTarget(entry.sessionId)
        // Audit-residual C fix: reconcile against get_session_stats — an
        // extension_error/rejected-ack can land before ANY cost-bearing
        // message_end streamed back, in which case entry.mapperState.
        // totalCostUsd is still the pre-turn value even though pi's backend
        // may have genuinely spent something.
        const turnCostUsd = await this.accountPiNonSuccessCostReconciled(entry, ctx, model)
        emitDispatchNotification(
          ctx,
          entry.sessionId ?? '',
          'failed',
          `Dispatched turn failed: ${winner.message}`
        )
        this.safeRecordUsage({
          ts: this.now(),
          fromRoutingId: ctx.fromRoutingId,
          fromEngine: ctx.fromEngine,
          targetEngine: 'pi',
          targetModel: model,
          targetSessionId: entry.sessionId,
          toolUseId: ctx.toolUseId ?? null,
          totalTokens: entry.turnTotalTokens > 0 ? entry.turnTotalTokens : null,
          costUsd: turnCostUsd > 0 ? turnCostUsd : null,
          durationMs: null
        })
        return errorResult(`Dispatched turn failed: ${winner.message}`, entry.sessionId ?? '')
      }

      // ── Success ────────────────────────────────────────────────────────
      const { outcome } = winner
      const turnCostUsd = Math.max(0, outcome.totalCostUsd - entry.lastReportedTotalCostUsd)
      entry.lastReportedTotalCostUsd = outcome.totalCostUsd

      // get_last_assistant_text — simpler + more reliable than accumulating
      // `message` MapperOutputs across the turn ourselves (see drivePiTurn's
      // doc comment). Best-effort: a failure here still returns a result
      // (with a placeholder text) rather than failing an otherwise-successful
      // turn over a follow-up RPC call.
      let finalText = '(the dispatched agent returned no text)'
      try {
        const textResp = await entry.client.request<PiGetLastAssistantTextData>({
          type: 'get_last_assistant_text'
        })
        if (textResp.success && textResp.data?.text) finalText = textResp.data.text
      } catch (err) {
        logger.warn(
          'CrossEngineDispatcher',
          `pi get_last_assistant_text failed (using placeholder text): ${err instanceof Error ? err.message : String(err)}`
        )
      }

      // ── Cost cap crossing note (ADR-033 M4-C) ───────────────────────────
      const maxCostUsd = dispatchCfg?.maxCostUsd
      const wasUnderCap = maxCostUsd === undefined || entry.cumulativeCostUsd < maxCostUsd
      entry.cumulativeCostUsd += turnCostUsd
      let outText = finalText
      if (maxCostUsd !== undefined && wasUnderCap && entry.cumulativeCostUsd >= maxCostUsd) {
        outText += '\n\n[dispatch cost cap reached — further turns on this session will be rejected]'
      }

      // ── Fold into the dispatching session's own cost breakdown (Slice C) ──
      if (Number.isFinite(turnCostUsd) && turnCostUsd > 0) {
        ctx.addDispatchedCost?.('pi', model, turnCostUsd)
      }

      emitDispatchNotification(ctx, entry.sessionId ?? '', 'completed', finalText, {
        totalTokens: entry.turnTotalTokens,
        toolUses: entry.turnToolUseIds.size,
        durationMs: outcome.durationMs
      })
      this.safeRecordUsage({
        ts: this.now(),
        fromRoutingId: ctx.fromRoutingId,
        fromEngine: ctx.fromEngine,
        targetEngine: 'pi',
        targetModel: model,
        targetSessionId: entry.sessionId,
        toolUseId: ctx.toolUseId ?? null,
        totalTokens: entry.turnTotalTokens,
        costUsd: turnCostUsd,
        durationMs: outcome.durationMs
      })
      return { text: outText, sessionId: entry.sessionId ?? '' }
    } finally {
      entry.busy = false
      clearInterval(heartbeat)
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (signal && abortListener) signal.removeEventListener('abort', abortListener)
    }
  }

  /**
   * Build the target shell + spawn its PiRpcClient + PiBridgeHost, resolve
   * `get_state` (capturing session_id EAGERLY — see PiTargetEntry's doc
   * comment), then apply the requested model via `set_model`. Any failure
   * along the way tears down whatever was already created and re-throws —
   * `resolveAndRunPi` turns that into a friendly isError.
   */
  private async createPiTarget(ctx: DispatchContext, model: string): Promise<PiTargetEntry> {
    const entry: PiTargetEntry = {
      kind: 'pi',
      sessionId: null,
      fromRoutingId: ctx.fromRoutingId,
      cwd: ctx.cwd,
      // Populated below, once spawnPiTarget resolves — the gate handler
      // closure captures `entry` BY REFERENCE (mirrors createClaudeTargetShell),
      // so it's safe to construct before these fields are filled in: a real
      // tool_call can only fire after the child has actually spawned.
      client: undefined as unknown as PiRpcClient,
      bridgeHost: undefined as unknown as PiBridgeHost,
      ctx,
      autonomyMode: ctx.autonomyMode,
      busy: false,
      cumulativeCostUsd: 0,
      lastReportedTotalCostUsd: 0,
      turnToolUseIds: new Set(),
      turnTotalTokens: 0,
      mapperState: createPiMapperState(),
      model,
      settled: null,
      draining: false
    }

    const gateHandler: PiBridgeHandler = (payload) => this.gatePiTargetToolCall(entry, payload)

    let primitives: PiTargetPrimitives
    try {
      primitives = await this.spawnPiTarget({ cwd: ctx.cwd, gateHandler })
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err))
    }
    entry.client = primitives.client
    entry.bridgeHost = primitives.bridgeHost

    entry.client.onEvent((ev) => {
      const outputs = mapPiEvent(ev, entry.mapperState)
      for (const output of outputs) this.forwardPiTargetMessage(entry, output)
    })
    entry.client.onExit(() => {
      // If a turn is in flight, nothing else will ever settle it — mirrors
      // the Claude target's process-exit-kills-the-turn outcome. ALSO dispose
      // the bridge host here (not just on disposeFor) — an unexpected process
      // death must not leak the loopback HTTP server's port (mirrors
      // PiSession's own onExit teardown of its bridgeHost).
      const settle = entry.settled
      entry.settled = null
      settle?.({ kind: 'error', message: 'pi target process exited unexpectedly' })
      entry.bridgeHost.dispose()
    })

    try {
      const stateResp = await entry.client.request<PiGetStateData>({ type: 'get_state' })
      if (!stateResp.success || !stateResp.data?.sessionId) {
        throw new Error(stateResp.error ?? 'pi target did not report a session id')
      }
      entry.sessionId = stateResp.data.sessionId
      entry.mapperState.sessionId = entry.sessionId
      this.targets.set(entry.sessionId, entry)

      const ref = engineMeta('pi').decodeModelValue(model)
      const setModelResp = await entry.client.request({
        type: 'set_model',
        provider: ref.vendorId,
        modelId: ref.modelId
      })
      if (!setModelResp.success) {
        throw new Error(setModelResp.error ?? `Failed to set pi model "${model}"`)
      }
    } catch (err) {
      if (entry.sessionId) this.targets.delete(entry.sessionId)
      entry.client.dispose()
      entry.bridgeHost.dispose()
      throw err instanceof Error ? err : new Error(String(err))
    }

    return entry
  }

  /**
   * Send the `prompt` command and await turn completion.
   *
   * DIVERGES FROM `driveClaudeTurn`: Claude's `sdkQuery()` hands back an
   * AsyncIterable the dispatcher manually pulls (`iterator.next()`) until it
   * sees `result` — necessary there because `for await` would `.return()` the
   * iterator on early exit and kill the process (see ClaudeTargetEntry's
   * hazard doc). pi's `PiRpcClient` has NO such iterable: agent events arrive
   * via a single ambient `onEvent` callback registered ONCE for the target's
   * whole lifetime (wired in `createPiTarget`), so there is nothing to pull
   * from and no `.return()` hazard to guard against. "Driving a turn" here
   * instead means: install `entry.settled` as this promise's resolver BEFORE
   * sending `prompt` (synchronously, so no event or ack can possibly arrive
   * first), then let the ALREADY-RUNNING onEvent → forwardPiTargetMessage
   * pipeline settle it once the mapper produces a `result` (agent_settled) or
   * `error` (extension_error) output. A turn is guaranteed unique in flight by
   * the busy-reject in `resolveAndRunPi`, mirroring the single-iterator
   * exclusivity Claude's `busy` flag protects.
   *
   * `streamingBehavior` (pi's steer/follow-up mode for a prompt sent while
   * already streaming) is deliberately NEVER set: a dispatch target only ever
   * has ONE caller (the dispatcher itself) and the busy-reject above
   * guarantees at most one turn in flight, so pi is never "already streaming"
   * when this fires — unlike PiSession.run(), which drives an INTERACTIVE
   * session where the human can send a follow-up mid-turn.
   */
  private drivePiTurn(entry: PiTargetEntry, prompt: string): Promise<PiTurnOutcome> {
    entry.mapperState.startTimeMs = Date.now()
    // A fresh turn (first turn, or a continuation after a prior stop/timeout/
    // abort) is never draining — see PiTargetEntry.draining's doc comment.
    entry.draining = false
    return new Promise<PiTurnOutcome>((resolve) => {
      entry.settled = resolve
      entry.client.request({ type: 'prompt', message: prompt }).then(
        (resp) => {
          // Only the ACK that the prompt was accepted — the real outcome
          // arrives later via the ambient onEvent pipeline UNLESS pi rejected
          // it outright (e.g. malformed command), in which case nothing else
          // will ever settle this promise.
          if (!resp.success && entry.settled === resolve) {
            entry.settled = null
            resolve({ kind: 'error', message: resp.error ?? 'pi rejected the prompt' })
          }
        },
        (err) => {
          if (entry.settled === resolve) {
            entry.settled = null
            resolve({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
          }
        }
      )
    })
  }

  /**
   * Forward a pi dispatch target's live turn output as engine-neutral
   * subagent events — byte-matches `forwardClaudeTargetMessage`'s /
   * `handleOpencodeTargetStream`'s payload shapes exactly (subagent-stream /
   * subagent-message / subagent-tool-result). ALSO owns turn-completion:
   * `result`/`error` MapperOutputs settle `entry.settled` (see `drivePiTurn`'s
   * doc comment) and `usage` outputs accumulate this turn's token total.
   * `bash_output`/`ignore` are skipped — the caller's TaskCard doesn't stream
   * a dispatch target's raw bash output (same as the other two directions).
   */
  private forwardPiTargetMessage(entry: PiTargetEntry, out: PiMapperOutput): void {
    if (out.kind === 'result') {
      entry.settled?.({
        kind: 'ok',
        totalCostUsd: out.totalCostUsd,
        durationMs: out.durationMs,
        sessionId: out.sessionId
      })
      entry.settled = null
      return
    }
    if (out.kind === 'error') {
      entry.settled?.({ kind: 'error', message: out.message })
      entry.settled = null
      // Falls through — also forwarded as a visible stream chunk below (if a
      // toolUseId is set) so a live-watching human sees WHY the turn ended,
      // not just the eventual "Dispatched turn failed" summary.
    }

    const toolUseId = entry.ctx.toolUseId
    if (!toolUseId) return

    switch (out.kind) {
      case 'stream':
        entry.ctx.emit('session:subagent-stream', {
          toolUseId,
          type: out.streamType,
          text: out.delta
        })
        break
      case 'message':
        collectToolUseIds(out.message, entry.turnToolUseIds)
        entry.ctx.emit('session:subagent-message', { toolUseId, message: out.message })
        break
      case 'tool_result':
        entry.ctx.emit('session:subagent-tool-result', {
          toolUseId,
          toolResultToolUseId: out.toolUseId,
          result: out.result,
          isError: out.isError
        })
        break
      case 'usage':
        entry.turnTotalTokens += out.tokens.input + out.tokens.output + (out.tokens.reasoning ?? 0)
        break
      case 'error':
        entry.ctx.emit('session:subagent-stream', {
          toolUseId,
          type: 'text',
          text: `\n[error: ${out.message}]`
        })
        break
      case 'bash_output':
      case 'ignore':
        break
    }
  }

  /**
   * Gate handler for a pi dispatch target's PiBridgeHost (the two-stage
   * approval gate, ADR-033 M4c) — mirrors `awaitClaudeTargetApproval`'s
   * ROLE (forward an 'ask' to the dispatching session, resolve a local
   * Promise) with an extra stage IN FRONT of it: `permission-engine.decide()`
   * runs FIRST against the target's fixed `autonomyMode` with EMPTY Claude
   * rules + an empty sessionAllows set — a dispatched target does not
   * inherit the user's interactive-session rules (see PiTargetEntry.autonomyMode's
   * doc comment) — so ONLY an 'ask' decision ever reaches a human; 'allow'
   * resolves immediately (no round-trip), and a full-autonomy dispatch target
   * (mode 'auto'/'bypassPermissions') NEVER prompts, matching the Claude
   * target's allow-all under bypassPermissions.
   *
   * NOTE: with EMPTY rules, `decide()` can structurally never return 'deny'
   * (`modeBaseDecision`'s own return type is `'allow' | 'ask'` — rules-based
   * deny is the ONLY source of a 'deny' verdict, and the rules are empty
   * here). The 'deny' branch below is kept anyway for defensive completeness
   * against `decide()`'s full return type (and in case a future change starts
   * passing real rules) — see the M4c report for the full discussion of this
   * tension against the kickoff spec's phrasing.
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
   * "always allow" convenience is missing, and it would write to the SAME
   * shared Claude permission files a dispatch target's gate deliberately does
   * NOT consult (rules are empty here), so its practical value would be
   * limited to a future INTERACTIVE pi session, not this or a future dispatch.
   */
  private gatePiTargetToolCall(entry: PiTargetEntry, payload: PiToolCallPayload): Promise<GateDecision> {
    // See PiTargetEntry.draining's doc comment — a late 'ask' from an already
    // stopped/timed-out/aborted turn must never register a pending approval.
    if (entry.draining) {
      return Promise.resolve({ behavior: 'deny', reason: 'Dispatch stopped' })
    }
    const decision = decide(payload.toolName, payload.input, {
      mode: entry.autonomyMode,
      rules: EMPTY_PI_RULES,
      sessionAllows: EMPTY_PI_SESSION_ALLOWS
    })

    if (decision === 'allow') return Promise.resolve({ behavior: 'allow' })
    if (decision === 'deny') {
      return Promise.resolve({ behavior: 'deny', reason: 'Denied by dispatch autonomy mode' })
    }

    // 'ask' — forward to the DISPATCHING session, mirrors awaitClaudeTargetApproval.
    return new Promise((resolve) => {
      const requestId = XENG_REQUEST_PREFIX + uuidv4()
      const approval: PendingApproval = {
        requestId,
        toolUseId: payload.toolCallId,
        toolName: payload.toolName,
        input: payload.input
      }
      this.pendingApprovals.set(requestId, {
        kind: 'pi',
        targetSessionId: entry.sessionId,
        emit: entry.ctx.emit,
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
}

export const crossEngineDispatcher = new CrossEngineDispatcher({
  serverManager: opencodeServerManager,
  makeClient: (baseUrl, authHeader) => new OpencodeClient(baseUrl, authHeader),
  loadEngineConfig
})
