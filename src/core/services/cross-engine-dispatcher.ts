/**
 * Cross-engine agent dispatch (ADR-033).
 *
 * A single main-process service owning the core of `dispatch_agent`: guards
 * (concurrency cap, per-dispatch timeout, model allowlist), the target ledger,
 * parent/caller bookkeeping, result await, cancellation and cleanup. Each
 * engine's target mechanics live in its own module, reached through
 * `DispatchTargetHost` (dispatch-target-host.ts); shared types and constants
 * are in dispatch-target-types.ts:
 *  - dispatch-claude-targets.ts: a raw `sdkQuery()` kept alive across turns.
 *  - dispatch-opencode-targets.ts: an opencode 2.x session on a turn-running
 *    lease of the server manager (ADR-097), followed on the shared event feed.
 *  - dispatch-pi-targets.ts: one headless `pi --mode rpc` child per target
 *    plus its own loopback PiBridgeHost approval gate.
 *
 * Targets are headless dispatcher-owned mini-sessions — NOT SessionManager/
 * ISession. All failures come back as `isError` tool text — nothing throws
 * across the MCP boundary.
 */
import { existsSync } from 'node:fs'
import { v4 as uuidv4 } from 'uuid'
import { opencodeServerManager } from '../opencode/OpencodeServerManager'

import { OpencodeClient } from '../opencode/OpencodeClient'

// Leaf modules of the opencode 2.x stack (no session class): the S4 mapper and
// reconnect re-read, the S6 rulesets and the child keeper, the S5 teardown.
// OpencodeSession.ts imports THIS module (cancel() disposes owned targets), so
// nothing here may import it back.

import {
  mergeRestrictions,
  restrictionCovers,
  type CallerRestriction
} from '../opencode/caller-restriction'

// ADR-088 — ClaudeUI's judge for pi/opencode targets. Leaf modules (the
// automode pipeline + the judge transport), no session class.
import { DispatchTargetJudge } from './dispatch-target-judge'
import { resolveAdditionalDirectories, uniqueDirs } from './additional-directories'
import { armBlockHold } from '../automode/block-hold'

import { STAGE2_TIMEOUT_MS } from '../automode/classifier'

import { loadEngineConfig } from './ui-config'
import { appSetting } from './app-settings'
import { worktreeCwdKey } from '../../shared/linked-worktree'
import { resolveDispatchMaxConcurrent } from '../../shared/dispatch-concurrency'

// pi target primitives (ADR-033 M4c — pi as a dispatch TARGET). None of these
// leaf modules import THIS file (or PiSession.ts, which does), so — same
// reasoning as the opencode imports above — this is a one-way edge, not a
// cycle. Reused verbatim, never reimplemented (per the M4c kickoff spec). The
// process/transport half of a pi target lives in `PiChildRunner` (ADR-089),
// shared with PiSession's host-run subagents; the gate policy stays here.

import { type PiChildPrimitives } from '../pi/pi-child-runner'

import { harnessAvailable } from '../harness/resolve'
import { mergedClaudeRulesFor } from '../pi/permission-engine'
import type { MergedClaudeRules } from '../pi/permission-engine'

import { ENGINE_META } from '../../shared/engine-meta'

import { sendProgress } from '../sdk'

import type { SdkToolExtra } from '../sdk'
import { logger } from './logger'
// The ADR-071 §1 ledger half of a dispatched turn. Every one of these modules
// is ALREADY in this file's transitive import graph (`assistant-message` ->
// `session-history` -> `block-usage` -> `usage-fetcher` -> `claude-session`,
// which imports this module back), so naming them directly adds no import
// edge that was not there — and nothing below is touched at module-init time,
// only from a turn's own code path.
import { recordUsageEvent } from './usage-recorder'
import type { UsageTurnEvent } from './usage-recorder'

import { DISPATCH_TARGETS } from './dispatch-targets'

import { UNKNOWN_ACCOUNT_KEY } from '../../shared/account-key'

import {
  dispatchLedger,
  type DispatchLedgerStore,
  type DispatchTargetRow,
  type DispatchTargetState
} from './dispatch-target-ledger'

import { stricterMode } from '../../shared/mode-class'
import { removeHarnessState } from './dispatch-target-end'
import { DispatchRun, DispatchRunRegistry } from './dispatch-runs'
import { type HandBackAnswer } from './dispatch-hand-back-server'
import {
  dispatchReports,
  type DispatchReportStatus,
  type DispatchReportStore
} from './dispatch-report-store'
import { capReport, frameHandBack } from '../../shared/handback-frame'
import { dispositionOf, type ReportReview } from '../../shared/handback-review'

import {
  failedResultText,
  reportResultText,
  sentenceLabel,
  statusLine,
  stoppedResultText
} from './dispatch-result-text'

import {
  type SessionToolCaller,
  type XAgentMessageOutcome,
  type XAgentMessageRequest
} from './session-tools'

import { resolveDispatchWorkdir, type WorkdirResolution } from './dispatch-workdir'
import { agentNoteMessage } from './agent-note'
import { isReservedXAgentName } from '../../shared/session-links'
import {
  MESSAGE_RUN_ENDED_TEXT,
  messageNotTakenText,
  X_AGENT_INPUT_FRAGMENT_LABEL,
  xAgentInputNoteTitle,
  xAgentMessageFrame,
  xAgentNewRunPrompt
} from '../../shared/x-agent-message'

import {
  HAND_BACK_DONE_TEXT,
  HAND_BACK_EMPTY_TEXT,
  HAND_BACK_ENDED_TEXT,
  HAND_BACK_FALLBACK_WARNING,
  LAUNCH_ACK_MARKER,
  HAND_BACK_NOT_TARGET_TEXT,
  HAND_BACK_REPEAT_TEXT,
  handBackNudge,
  handBackTaskSuffix,
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
  DispatchConfig,
  EngineId,
  PermissionSuggestion
} from '../../shared/types'
import { isEngineId } from '../../shared/engine-label'
import { XENG_REQUEST_PREFIX } from './dispatch-target-types'
import type {
  DispatchContext,
  DispatchRequest,
  FreshLaunch,
  DispatchResult,
  DispatcherDeps,
  DispatchTurnAccount,
  DispatchedTurnRecord,
  TurnTimeout,
  TurnLivenessCaps,
  TargetLedgerFields,
  ClaudeTargetEntry,
  TargetEntry,
  ForwardedBlockHold,
  PendingForwardedApproval,
  TurnReturn
} from './dispatch-target-types'
import {
  liveMode,
  keepTargetBlock,
  errorResult,
  replyTargetPermission,
  errText,
  canonicalDispatchModel,
  runIndexField,
  emitDispatchNotification,
  settledWithin,
  buildClaudeDispatchMessage
} from './dispatch-target-shared'
import { PiTargets } from './dispatch-pi-targets'
import { ClaudeTargets } from './dispatch-claude-targets'
import { OpencodeTargets } from './dispatch-opencode-targets'
import type { DispatchTargetHost } from './dispatch-target-host'

// Names that moved to the target modules, still exported from here.
export { XENG_REQUEST_PREFIX, DISPATCH_PROMPT_PREAMBLE } from './dispatch-target-types'
export type {
  DispatchContext,
  DispatchRequest,
  DispatchResult,
  DispatchTargetClient,
  ClaudeQuerySpawnOpts,
  SpawnClaudeQueryFn,
  SpawnPiTargetFn,
  DispatcherDeps
} from './dispatch-target-types'
export { buildPiTargetChildEnv } from './dispatch-pi-targets'
export type { PiTargetSpawnOpts } from './dispatch-pi-targets'

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
 * the dispatcher's own per-request guards report. Before it, the opencode
 * branch answered `true` because Claude Code was always bundled, and
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

/** The longest `name` and `description` a launch may carry (they reach the roster, the ledger and notification titles). */
const MAX_XAGENT_NAME_CHARS = 64
const MAX_XAGENT_DESCRIPTION_CHARS = 200

/** A label as the ledger keeps it: trimmed, and nothing at all when it is blank. */
function labelOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** The two live primitives a pi dispatch target owns — one PiRpcClient (the
 *  headless child) and its OWN PiBridgeHost (approval gate transport). */
export type PiTargetPrimitives = PiChildPrimitives

/**
 * The default app-wide dispatch cap, read fresh on EVERY dispatch call so a
 * Settings change binds the next one without an app restart — the same
 * re-read-per-call contract `loadEngineConfig(engine).dispatch` already has for
 * the per-target cost/timeout gates. Canonical state is current after any save or
 * settings.json watcher change, and `appSetting` is a lookup, so nothing is cached.
 */
const defaultResolveMaxConcurrent = (): number =>
  resolveDispatchMaxConcurrent(appSetting('dispatchMaxConcurrent'))

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
/** See {@link DispatcherDeps.handBackSettleMs}. */
const HAND_BACK_SETTLE_MS = 2_000
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

/** A durable stop-intent armed BEFORE the dispatch registered (ADR-033 M3). */
interface PendingStop {
  /** Owning session at arm time — must match ctx.fromRoutingId to fire. */
  routingId?: string
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
  /** The engine's id for it: Claude's frame uuid, pi's `deliveryId`, opencode's inbox id. */
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

/** Narrow an unknown wire value to a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

// ── Who a dispatched turn is billed to (ADR-071 §1 / §3) ────────────────────
// One helper per target, each reading the SAME source that engine's own
// sessions read, so a turn's row names the same account whether the work was
// dispatched or typed by a human.
//
// WHEN each is read follows what can actually change under the target. The
// opencode and pi helpers run PER TURN, off a credential file a sign-in can
// rewrite between turns while the target process keeps serving. The Claude
// helper runs ONCE at target creation (`ClaudeTargetEntry.account`), because
// a dispatched cli.js process reads the app's credentials at spawn and never
// again.

/** The `unknown` account — a target that cannot name the account it ran under. */
const UNKNOWN_DISPATCH_ACCOUNT: DispatchTurnAccount = {
  accountKey: UNKNOWN_ACCOUNT_KEY,
  accountLabel: null,
  billingType: 'unknown'
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
      // opencode and pi publish one cache-write rate and report none.
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

function emitDispatchTaskStarted(ctx: RunContext, ledgerId: string): void {
  const record = dispatchTaskStartedRecord(ctx.run, ledgerId)
  if (record) ctx.emit('session:task-started', record)
}

export class CrossEngineDispatcher {
  private readonly deps: DispatcherDeps
  private readonly resolveMaxConcurrent: () => number
  private readonly heartbeatMs: number
  private readonly loadUserRules: (cwd: string) => MergedClaudeRules
  private readonly recordLedgerEvent: (event: UsageTurnEvent) => void
  /** The X-Agent ledger (ADR-105). */
  private readonly ledger: DispatchLedgerStore
  private readonly targetCwdExists: (cwd: string) => boolean
  private readonly requireHandBack: boolean
  private readonly reports: DispatchReportStore
  private readonly handBackSettleMs: number
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
  private readonly piTargets: PiTargets
  private readonly claudeTargets: ClaudeTargets
  private readonly opencodeTargets: OpencodeTargets

  constructor(deps: DispatcherDeps) {
    this.deps = deps
    this.resolveMaxConcurrent = deps.resolveMaxConcurrent ?? defaultResolveMaxConcurrent
    this.heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS
    this.loadUserRules = deps.loadUserRules ?? mergedClaudeRulesFor
    this.now = deps.now ?? Date.now
    this.recordLedgerEvent = deps.recordUsageEvent ?? recordUsageEvent
    this.ledger = deps.ledger ?? dispatchLedger
    this.targetCwdExists = deps.targetCwdExists ?? existsSync
    this.requireHandBack = deps.requireHandBack ?? false
    this.reports = deps.reports ?? dispatchReports
    this.handBackSettleMs = deps.handBackSettleMs ?? HAND_BACK_SETTLE_MS
    this.handBackReviewMs = deps.handBackReviewMs ?? HAND_BACK_REVIEW_MS
    this.messageRunEndWaitMs = deps.messageRunEndWaitMs ?? MESSAGE_RUN_END_WAIT_MS
    this.messageStartWaitMs = deps.messageStartWaitMs ?? MESSAGE_START_WAIT_MS
    this.parents = deps.parents

    const host = this.targetHost()
    this.piTargets = new PiTargets(host)
    this.claudeTargets = new ClaudeTargets(host)
    this.opencodeTargets = new OpencodeTargets(host)
  }

  /**
   * The seam the engine target classes reach this core through. Every member is late-bound (an
   * arrow or a getter, read at call time): a test or a caller replacing a dispatcher member on the
   * instance stays effective for the engine classes. Built last in the constructor.
   */
  private targetHost(): DispatchTargetHost {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const d = this
    return {
      get deps() {
        return d.deps
      },
      get ledger() {
        return d.ledger
      },
      get requireHandBack() {
        return d.requireHandBack
      },
      get handBackSettleMs() {
        return d.handBackSettleMs
      },
      get targets() {
        return d.targets
      },
      get disposals() {
        return d.disposals
      },
      get pendingApprovals() {
        return d.pendingApprovals
      },
      get runs() {
        return d.runs
      },
      get now() {
        return d.now
      },
      targetRules: (...args) => d.targetRules(...args),
      safeRecordUsage: (...args) => d.safeRecordUsage(...args),
      recordTarget: (...args) => d.recordTarget(...args),
      bindContinuation: (...args) => d.bindContinuation(...args),
      ledgerSet: (...args) => d.ledgerSet(...args),
      ledgerTurnState: (...args) => d.ledgerTurnState(...args),
      findContinuation: (...args) => d.findContinuation(...args),
      continuationSpend: (...args) => d.continuationSpend(...args),
      resumeModelRefusal: (...args) => d.resumeModelRefusal(...args),
      noteSteerConsumed: (...args) => d.noteSteerConsumed(...args),
      hasStraySteers: (...args) => d.hasStraySteers(...args),
      noteSteerFrame: (...args) => d.noteSteerFrame(...args),
      taskText: (...args) => d.taskText(...args),
      receiveHandBack: (...args) => d.receiveHandBack(...args),
      settleReview: (...args) => d.settleReview(...args),
      xAgentCaller: (...args) => d.xAgentCaller(...args),
      finishTurn: (...args) => d.finishTurn(...args),
      runWithNudges: (...args) => d.runWithNudges(...args),
      startHeartbeat: (...args) => d.startHeartbeat(...args),
      hasPendingApprovalFor: (...args) => d.hasPendingApprovalFor(...args),
      takePendingApproval: (...args) => d.takePendingApproval(...args),
      armForwardedHold: (...args) => d.armForwardedHold(...args),
      startTurnWatchdog: (...args) => d.startTurnWatchdog(...args),
      dismissPendingForTarget: (...args) => d.dismissPendingForTarget(...args)
    }
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
   * The rules and scope a target runs under: the user's deny and ask rules with an EMPTY allow
   * tier (ADR-085 §3: deny/ask rules hold in every mode, dispatch targets included), and the
   * target's scope as `additionalDirectories`. A target is governed by its autonomy mode, not by
   * what the user pre-approved for their own chats, so it never gets the user's allow rules
   * (ADR-033); what it does get is a workspace (ADR-108 as amended): the user's additional
   * directories, plus the dispatching session's own directory when the target runs elsewhere (a
   * `workdir`, say a sibling git worktree, that cannot otherwise see the repo it came from). Read
   * fresh per call, like the interactive sessions' gates.
   *
   * `parentCwd` is the dispatching session's WORKING directory (a worktree it entered); `originCwd`
   * is its identity directory when that differs. The identity directory's settings join the union
   * (a deny that exists only in the main checkout still binds), but it is not itself added to the
   * target's scope: the session no longer works there.
   *
   * Both are the UNION of what is loaded for the PARENT's directory and for the TARGET's: the
   * parent's gitignored `.claude/settings.local.json` still binds a target that runs elsewhere,
   * and the target's own project settings still apply to it. A union of deny/ask only tightens;
   * the directories widen the scope, but never past what the user listed or the parent could
   * already reach (`workdir` is held to the same set, `resolveDispatchWorkdir`). Each additional
   * directory is resolved against the cwd of the settings that carried it BEFORE the union (a
   * relative entry in the target's project settings is relative to the target), then
   * de-duplicated. Parent's first, order-stable; the caller's restriction last.
   */
  private targetRules(
    targetCwd: string,
    parentCwd: string,
    restriction?: CallerRestriction,
    originCwd?: string
  ): MergedClaudeRules {
    const sources = uniqueDirs([parentCwd, ...(originCwd ? [originCwd] : []), targetCwd])
    const loaded = sources.map((dir) => ({ dir, rules: this.loadUserRules(dir) }))
    // Provenance for the read block (path containment): any source setting it binds the target,
    // and the directories only PROJECT settings listed do not count for reads. A rule loader
    // without provenance counts every entry.
    const blockReads = loaded.some((r) => r.rules.blockReadsOutsideWorkingDirectories === true)
    return {
      ...(blockReads ? { blockReadsOutsideWorkingDirectories: true } : {}),
      nonProjectAdditionalDirectories: uniqueDirs(
        [
          parentCwd,
          ...loaded.flatMap(({ dir, rules }) =>
            resolveAdditionalDirectories(
              rules.nonProjectAdditionalDirectories ?? rules.additionalDirectories,
              dir
            )
          )
        ],
        targetCwd
      ),
      deny: [...new Set([...loaded.flatMap((r) => r.rules.deny), ...(restriction?.deny ?? [])])],
      ask: [...new Set([...loaded.flatMap((r) => r.rules.ask), ...(restriction?.ask ?? [])])],
      allow: [],
      additionalDirectories: uniqueDirs(
        [
          parentCwd,
          ...loaded.flatMap(({ dir, rules }) =>
            resolveAdditionalDirectories(rules.additionalDirectories, dir)
          )
        ],
        targetCwd
      ),
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
      /** Where the target runs ({@link targetCwd}); the parent's own directory is `ctx.cwd`. */
      cwd: string
      model: string
      accountKey: string | null
      fresh?: FreshLaunch
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
      cwd: spec.cwd,
      parentCwd: ctx.cwd,
      model: spec.model,
      launchMode: liveMode(ctx),
      accountKey: spec.accountKey,
      callerRestriction: ctx.callerRestriction ? JSON.stringify(ctx.callerRestriction) : null,
      name: labelOf(spec.fresh?.name),
      description: labelOf(spec.fresh?.description),
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
   * any harness session on disk, with no owner
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
    engine: EngineId,
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
   * `opts.blockingOnly` is the parent's OWN interrupt (Esc, pi's interrupt):
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
   *    prompt).
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
    // A row an older build wrote for an engine this one does not ship (`codex`) has no run to resume.
    if (!isEngineId(row.engine))
      return refuse(`X-Agent ${row.name ?? row.id} ran on an engine that is no longer supported.`)
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
    // The row keeps only the directory the launch ran from; the parent's identity directory (its
    // settings still bind the target) is read from canonical state. An unknown parent: unset.
    const identity = this.parents?.identityCwd?.(parentId())
    return {
      fromEngine: row.parentEngine,
      fromRoutingId: row.parentSessionId,
      // The DISPATCHING session's directory, as on every other context; the target's own is `row.cwd`.
      cwd: row.parentCwd,
      ...(identity && worktreeCwdKey(identity) !== worktreeCwdKey(row.parentCwd)
        ? { originCwd: identity }
        : {}),
      getAutonomyMode: () => live()?.getAutonomyMode?.() ?? row.launchMode,
      getMessages: () => live()?.getMessages() ?? [],
      emit: (channel, data) => this.parents?.emit(parentId(), channel, data),
      addDispatchedCost: (engineId, modelId, costUsd) =>
        live()?.addDispatchedCost?.(engineId, modelId, costUsd),
      ...(row.parentToolUseId ? { toolUseId: row.parentToolUseId } : {})
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
   * (it is context only).
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
    if (req.engine === ctx.fromEngine) {
      return {
        refused: errorResult(
          `dispatch_agent targets a different engine — this session already runs on "${ctx.fromEngine}". ` +
            'Use your own tools (or a native subagent) for same-engine work.'
        )
      }
    }
    if (req.engine !== 'opencode' && req.engine !== 'claude' && req.engine !== 'pi') {
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
      const removed = this.removedCwdRefusal({ ...req, sessionId: req.sessionId }, ctx)
      if (removed) return { refused: removed }
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
    // (a hosted tool may not): a NEW launch without one is refused here. A continuation or
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

    // Where a NEW target runs. A continuation keeps the directory its target was created in, so a
    // `workdir` on one is refused, not ignored: the caller would believe the work happens there.
    // Resolved here, before anything is registered or spawned; every engine path then reads it as
    // `req.workdir` (`targetCwd`), already a real path inside the parent's reach.
    const launchReq: DispatchRequest = { ...req }
    delete launchReq.workdir
    const workdir = labelOf(req.workdir)
    if (workdir) {
      if (req.sessionId) {
        return {
          refused: errorResult(
            'dispatch_agent "workdir" cannot be given with "sessionId": a continued X-Agent keeps the ' +
              'directory it was started in. Start a new X-Agent to work in another directory.',
            req.sessionId
          )
        }
      }
      const resolved = this.resolveWorkdir(workdir, ctx.cwd)
      if (!resolved.ok) return { refused: errorResult(resolved.text) }
      launchReq.workdir = resolved.cwd
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
      run.done = this.executeRun(launchReq, runCtx, () => {
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

  /**
   * `workdir` as a directory the dispatching session may hand a target: inside its own working
   * directory or one of the user's additional directories (the user, project and local Claude
   * settings, merged for the parent's cwd). Rules that cannot be read grant nothing extra.
   */
  private resolveWorkdir(workdir: string, parentCwd: string): WorkdirResolution {
    let additional: readonly string[] = []
    try {
      additional = this.loadUserRules(parentCwd).additionalDirectories
    } catch (err) {
      logger.warn(
        'CrossEngineDispatcher',
        `could not read the additional directories: ${errText(err)}`
      )
    }
    return resolveDispatchWorkdir(workdir, parentCwd, additional)
  }

  /**
   * A continuation of a target the ledger will rebuild runs in the directory its row names. Once that
   * is gone (a removed git worktree) nothing is started in it, whatever the engine: the harness would
   * open in a cwd that does not exist, or in another, and the agent's files are gone with it. A live
   * target needs no check (its process is already there), nor does an unknown or foreign one: the
   * engine's own path answers those. The row keeps its state: restoring the directory makes it
   * resumable again.
   */
  private removedCwdRefusal(
    req: DispatchRequest & { sessionId: string },
    ctx: DispatchContext
  ): DispatchResult | null {
    if (this.targets.has(req.sessionId)) return null
    const cont = this.findContinuation(req.sessionId, ctx, req.engine as TargetEntry['kind'])
    if (!cont || !('row' in cont) || this.targetCwdExists(cont.row.cwd)) return null
    return errorResult(
      `Dispatch session "${req.sessionId}" cannot be resumed — the agent's working directory ` +
        `${cont.row.cwd} no longer exists (a removed worktree?). Start a new X-Agent with dispatch_agent.`,
      req.sessionId
    )
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
    let result: DispatchResult
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
    if (req.engine === 'claude') return this.claudeTargets.resolveAndRunClaude(req, ctx, stop)
    if (req.engine === 'pi') return this.piTargets.resolveAndRunPi(req, ctx, stop)
    return this.opencodeTargets.resolveAndRunOpencode(req, ctx, stop)
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

    if (pending.kind === 'claude' || pending.kind === 'pi') {
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
   * Release EVERY live target, background runs included (the quit-time worktree removal: a
   * target's process is a cwd holder, and `disposeFor` deliberately spares a running background
   * run). Idle targets keep their harness session and are resumable; a busy one's row says
   * `interrupted`. Returns how many were released.
   */
  releaseAllTargets(): number {
    let released = 0
    for (const [sessionId, entry] of [...this.targets]) {
      if (entry.released) continue
      this.releaseEntry(sessionId, entry, entry.busy ? 'interrupted' : 'idle')
      released++
    }
    return released
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
      this.opencodeTargets.sealOpencodeTargetItems(entry)
      // Settle a turn still in flight (ADR-033's 2026-09-01 amendment): the
      // entry has just left `this.targets`, so nothing else can.
      const settle = entry.settled
      entry.settled = null
      settle?.({ kind: 'failed', message: 'the dispatching session was disposed' })
      this.opencodeTargets.teardownOpencodeTarget(entry)
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
    }
  }

  /**
   * The live targets' ledger id, engine and working directory — a narrow read view for the
   * worktree manager (ADR-112: a live X-Agent holds its `cwd`), without exposing the entries.
   */
  liveTargetCwds(): Array<{ ledgerId: string; engine: EngineId; cwd: string }> {
    const out: Array<{ ledgerId: string; engine: EngineId; cwd: string }> = []
    for (const entry of this.targets.values()) {
      if (entry.released || !entry.cwd) continue
      out.push({ ledgerId: entry.ledgerId, engine: entry.kind, cwd: entry.cwd })
    }
    return out
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
   * the engine allows (opencode's session, pi's directory; Claude's transcript stays). The run, if there was one, has already settled.
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
   * target's own MCP server, pi's bridge, the shared opencode server.
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
   * mode and the engine's own switch). Claude: cli.js's classifier decides inside the
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
          permissions: () =>
            this.targetRules(
              entry.cwd,
              entry.ctx.cwd,
              entry.ctx.callerRestriction,
              entry.ctx.originCwd
            )
        })
    switch (entry.kind) {
      case 'opencode':
      case 'pi':
        return entry.judge.autoModeActive(liveMode(entry.ctx))
          ? through(entry.judge, () => liveMode(entry.ctx))
          : undefined
      case 'claude':
        return undefined
    }
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
   * tools: a Claude target's process mode, the parent's live
   * mode for pi and opencode (their gates read it live).
   */
  private targetMode(entry: TargetEntry): string {
    if (entry.kind === 'claude') return entry.appliedPermissionMode
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
   *  - The target has no `hand_back` tool (a target from before it existed): its last
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

  /**
   * Is a forwarded approval for this dispatch target still awaiting a human?
   * Read by the turn watchdog to keep an approval-PARKED turn's inactivity
   * clock rolling (see `startTurnWatchdog`). NOT scoped to any target kind: as
   * of ADR-033's 2026-09-18 amendment every direction runs on that
   * watchdog, and a Claude/pi target blocked on its gate is exactly as
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
   * shared by every direction (ADR-033's 2026-09-18 amendment; before it
   * only the opencode direction had one, and claude/pi raced a fixed
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
        // (the server's keepalives carry no sessionID), and a Claude/pi
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
   *  Claude/pi-kind resolvers are ALSO resolved with deny — never leave a
   *  hanging canUseTool/gate promise (ADR-033 M2 item 7, extended to pi in M4c). */
  private dismissPendingForTarget(targetSessionId: string): void {
    // An opencode target's asks still under judgement reply nothing once the
    // turn is stopped (ADR-088, `OpencodeTargetEntry.judging`).
    const target = this.targets.get(targetSessionId)
    if (target?.kind === 'opencode') target.judging.clear()
    for (const [key, pending] of [...this.pendingApprovals]) {
      if (pending.targetSessionId !== targetSessionId) continue
      this.takePendingApproval(key)
      pending.emit('session:approval-dismiss', { requestId: key })
      if (pending.kind === 'claude' || pending.kind === 'pi') {
        pending.resolve('deny')
      }
    }
  }
}

export const crossEngineDispatcher = new CrossEngineDispatcher({
  serverManager: opencodeServerManager,
  makeClient: (conn) => new OpencodeClient(conn),
  loadEngineConfig,
  requireHandBack: true
})
