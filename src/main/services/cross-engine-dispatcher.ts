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
// event-mapper.ts is a leaf module (no cycle risk — it does not import
// OpencodeSession.ts/OpencodeServerManager.ts/this module). Reused here so the
// opencode-target streaming tap (ADR-033 M3) shares the exact same
// message.part.delta/updated → {stream|message} logic OpencodeSession.ts uses
// for its own turns, instead of a second hand-rolled implementation.
import { mapEvent } from '../opencode/event-mapper'
import type { MessageAccumulator } from '../opencode/event-mapper'
import type { OpencodeEvent } from '../opencode/protocol/types'
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
import type {
  ApprovalDecision,
  EngineConfig,
  EngineId,
  PendingApproval,
  PermissionSuggestion
} from '../../shared/types'

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

export interface DispatcherDeps {
  serverManager: {
    acquire(cwd: string): Promise<{ baseUrl: string; authHeader: string }>
    release(cwd: string): void
  }
  makeClient: (baseUrl: string, authHeader: string) => DispatchTargetClient
  loadEngineConfig: (engineId: string) => EngineConfig
  /** Defaults to the real sdkQuery + claudeSpawnPrep. */
  spawnClaudeQuery?: SpawnClaudeQueryFn
  maxConcurrent?: number
  dispatchTimeoutMs?: number
  heartbeatMs?: number
  /** Clock, injectable for the pendingStops TTL tests. Defaults to Date.now. */
  now?: () => number
}

// ── Internals ─────────────────────────────────────────────────────────────────

/** Reserved requestId prefix routing approvals to the dispatcher (ADR-033). */
export const XENG_REQUEST_PREFIX = 'xeng:'

const MAX_CONCURRENT = 3
const DISPATCH_TIMEOUT_MS = 10 * 60 * 1000
const HEARTBEAT_MS = 15 * 1000
/** How long an armed stop-intent (see `pendingStops`) stays valid. Generous —
 *  it only needs to outlive the MCP tools/call round-trip + handler prelude. */
const PENDING_STOP_TTL_MS = 60 * 1000

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
}

type TargetEntry = OpencodeTargetEntry | ClaudeTargetEntry

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

type PendingForwardedApproval = OpencodePendingApproval | ClaudePendingApproval

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
 * both identically). `usage` is left unset here; M4 populates it from the
 * target's per-turn cost/token result.
 */
function emitDispatchNotification(
  ctx: DispatchContext,
  targetSessionId: string,
  status: 'completed' | 'failed' | 'stopped',
  summary: string
): void {
  if (!ctx.toolUseId) return
  ctx.emit('session:task-notification', {
    taskId: targetSessionId,
    toolUseId: ctx.toolUseId,
    status,
    outputFile: '',
    summary: summary.slice(0, 100),
    usage: undefined
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

export class CrossEngineDispatcher {
  private readonly deps: DispatcherDeps
  private readonly maxConcurrent: number
  private readonly dispatchTimeoutMs: number
  private readonly heartbeatMs: number
  private readonly spawnClaudeQuery: SpawnClaudeQueryFn

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
    this.spawnClaudeQuery = deps.spawnClaudeQuery ?? defaultSpawnClaudeQuery
    this.now = deps.now ?? Date.now
  }

  /** For tests: current in-flight dispatch count. */
  get inFlightCount(): number {
    return this.activeDispatches
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
    if (req.engine !== 'opencode' && req.engine !== 'claude') {
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
      return req.engine === 'claude'
        ? await this.resolveAndRunClaude(req, ctx, stopController)
        : await this.resolveAndRunOpencode(req, ctx, stopController)
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

    if (pending.kind === 'claude') {
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
      } else {
        // Killing the process is the only teardown a Claude target needs —
        // no server ref, no remote session to delete.
        entry.abortController.abort()
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
        emitDispatchNotification(
          ctx,
          entry.sessionId,
          winner.kind === 'timeout' ? 'failed' : 'stopped',
          text
        )
        return errorResult(text, entry.sessionId)
      }
      if (winner.kind === 'err') {
        this.dismissPendingForTarget(entry.sessionId)
        const msg = winner.err instanceof Error ? winner.err.message : String(winner.err)
        emitDispatchNotification(ctx, entry.sessionId, 'failed', `Dispatched turn failed: ${msg}`)
        return errorResult(`Dispatched turn failed: ${msg}`, entry.sessionId)
      }

      const resp = winner.resp as
        | {
            info?: { error?: { name?: string; data?: { message?: string } } }
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
        return errorResult(`Dispatched turn failed: ${detail}`, entry.sessionId)
      }
      const text = (resp?.parts ?? [])
        .filter((p) => p?.type === 'text')
        .map((p) => p?.text ?? '')
        .join('')
      const finalText = text || '(the dispatched agent returned no text)'
      emitDispatchNotification(ctx, entry.sessionId, 'completed', finalText)
      return { text: finalText, sessionId: entry.sessionId }
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
        accumulators: new Map()
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
          `SSE loop error: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
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
        emitDispatchNotification(
          ctx,
          entry.sessionId ?? '',
          winner.kind === 'timeout' ? 'failed' : 'stopped',
          text
        )
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
        return errorResult(`Dispatched turn failed: ${msg}`, entry.sessionId ?? '')
      }

      const result = winner.msg
      // A turn-level error (see docs/protocol/03-inbound-messages.md §result
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
        return errorResult(`Dispatched turn failed: ${detail}`, entry.sessionId ?? '')
      }
      const finalText = result.result || '(the dispatched agent returned no text)'
      emitDispatchNotification(ctx, entry.sessionId ?? '', 'completed', finalText)
      return {
        text: finalText,
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
      if (chatMsg) entry.ctx.emit('session:subagent-message', { toolUseId, message: chatMsg })
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
        let resultText = ''
        const blockContent = block.content
        if (typeof blockContent === 'string') {
          resultText = blockContent
        } else if (Array.isArray(blockContent)) {
          resultText = (blockContent as Array<Record<string, unknown>>)
            .map((c) => (c.text as string) || '')
            .join('\n')
        }
        entry.ctx.emit('session:subagent-tool-result', {
          toolUseId,
          toolResultToolUseId,
          result: resultText,
          isError: !!block.is_error
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
      ctx
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
   *  Claude-kind resolvers are ALSO resolved with deny — never leave a
   *  hanging canUseTool promise (ADR-033 M2 item 7). */
  private dismissPendingForTarget(targetSessionId: string): void {
    for (const [key, pending] of [...this.pendingApprovals]) {
      if (pending.targetSessionId !== targetSessionId) continue
      this.pendingApprovals.delete(key)
      pending.emit('session:approval-dismiss', { requestId: key })
      if (pending.kind === 'claude') {
        pending.resolve('deny')
      }
    }
  }
}

export const crossEngineDispatcher = new CrossEngineDispatcher({
  serverManager: opencodeServerManager,
  makeClient: (baseUrl, authHeader) => new OpencodeClient(baseUrl, authHeader),
  loadEngineConfig
})
