import type { ResolvedCapabilities } from '../model-capabilities'
import type { AccountRef } from './auth'
import type { ActiveTask, TaskNotification } from './tasks'
import type { BillingType, EngineId, ModelRef, VendorId } from './engine'
import type { ChatMessage } from './content'

export interface SessionStatus {
  state: 'idle' | 'running' | 'error' | 'disconnected'
  sessionId: string | null
  /** Vendor-qualified model identity. Null until the engine reports a model. */
  model: ModelRef | null
  cwd: string | null
  /**
   * Session cost in USD, or null when the engine cannot price the turn (no
   * published price for the model). Null means UNKNOWN — 0 means known to be
   * zero (a free model, or nothing metered yet on an engine that does price
   * its models). Renderers show a placeholder for null, never "$0.00".
   */
  totalCostUsd: number | null
  engineId: EngineId
  capabilities: ResolvedCapabilities
  /** Resolved account descriptor from the engine auth provider. Null until probed. */
  account: AccountRef | null
}

export interface SessionResult {
  /** The session's headline cost at turn end — same contract (and same null
   *  meaning "unknown, not free") as {@link SessionStatus.totalCostUsd}. */
  totalCostUsd: number | null
  durationMs: number
  result: string
  sessionId?: string | null
  /**
   * Claude only: cli.js is about to start ANOTHER turn on its own at this
   * result, to deliver a subagent's `SubagentHandback` that reached its queue
   * after the last model round began. Not a turn end for the user; the extra
   * turn's own result decides (docs/protocol-cc/03-inbound-messages.md §3.7).
   */
  pendingWake?: boolean
}

export interface SessionInfo {
  sessionId: string
  cwd: string
  projectKey: string
  title: string
  timestamp: number
  lastActivityAt: number
  /** cli.js-generated session title (from `{type:"ai-title"}` JSONL records). */
  aiTitle?: string | null
  /** Which engine produced this session. Defaults to 'claude' when absent (legacy records). */
  engineId?: EngineId
}

// ---------------------------------------------------------------------------
// Domain-specific API interfaces (composed into ClaudeAPI)
// ---------------------------------------------------------------------------

export interface ForkAnchorResult {
  /** JSONL line uuid to pass to cli.js `--resume-session-at`, or null if the
   *  message could not be resolved on disk (e.g. not yet flushed). */
  anchorUuid: string | null
  reason?: string
}

/** The options object of `session:load-history` (its 4th wire arg). */
export interface LoadSessionHistoryOptions {
  deferStatusLine?: boolean
}

/**
 * Engine-neutral session-level status metrics (cost, tokens, duration),
 * refreshed on every turn. `totalDurationMs` is the accumulated ACTIVE
 * (turn-processing) duration of COMPLETED turns, in milliseconds — idle time
 * between turns (waiting on the user) never counts, and both engines share
 * this semantic. Pair with `turnStartedAtMs` to reconstruct the live,
 * in-flight total while a turn is still running:
 *   totalDurationMs + (turnStartedAtMs ? Date.now() - turnStartedAtMs : 0)
 */
export interface StatusLineData {
  /** Cumulative session cost in USD; null when unpriced/unknown (see
   *  {@link SessionStatus.totalCostUsd} — 0 still means known-zero).
   *
   *  ADR-071 §2: the figure a headline shows for this session's billing type —
   *  the list-price equivalent of the tokens under a subscription, the engine's
   *  billed figure under an API key. Messages with no known price are NOT
   *  counted as zero; they are counted in {@link unknownCostMessages}. */
  totalCostUsd: number | null
  /** What actually left a wallet, by the same rule: `0` under a subscription or
   *  a free vendor, the engine's figure under an API key, null when unknown.
   *  Optional because only the engines that follow ADR-071 §2 report it — a
   *  Claude status line leaves it (and `unknownCostMessages`) unset,
   *  and the tooltip shows the extra rows only when they are present. */
  billedCostUsd?: number | null
  /** How many of this session's messages had no known cost. Omitted when none:
   *  a total that hides unknowns is a total that understates itself (ADR-030). */
  unknownCostMessages?: number
  totalDurationMs: number
  totalApiDurationMs: number
  totalInputTokens: number
  totalOutputTokens: number
  cachedTokens: number
  totalTokens: number
  /** Context consumed and the model's window, both in tokens — the same
   *  vocabulary as {@link MeteringSnapshot.contextWindow}, deliberately, so one
   *  reading serves both payloads. `size: 0` means the window is unknown for
   *  this engine/model, in which case the engine also sends
   *  `usedPercentage: null`; it never means a zero-sized window.
   *
   *  Replaced a flat `contextWindowSize` that three engines filled with the
   *  window and Claude filled with the consumption — the name said window, so
   *  Claude was the one lying, and the field was one careless read away from a
   *  context meter that sat near 100%. */
  contextWindow: { used: number; size: number }
  usedPercentage: number | null
  remainingPercentage: number | null
  /** Epoch ms when the currently in-flight turn started; null/undefined when idle. */
  turnStartedAtMs?: number | null
  /** Per-model cost breakdown (Slice B). Sums to totalCostUsd (± float). Always
   *  emitted once cost is known; the renderer hides the breakdown when a single
   *  non-dispatched entry would just repeat the headline Cost figure. */
  modelCosts?: ModelCostEntry[]
}

/**
 * One session-cost line attributed to a model (Slice B — per-model session cost
 * breakdown, durable across reloads). Sorted/labelled in the renderer (TopBar).
 * ADR-033 cross-engine dispatch (Slice C) adds rows with `dispatched: true` for
 * spend that happened in a dispatched call to a different engine.
 */
export interface ModelCostEntry {
  /** 'claude' | 'opencode' (Slice C adds dispatch target engines) */
  engineId: EngineId
  /** Raw model id, e.g. 'claude-fable-5' */
  modelId: string
  costUsd: number
  /** true when this spend happened in a cross-engine dispatched call (Slice C). */
  dispatched?: boolean
}

/**
 * What a cold history read returns for the engines whose transcript lives
 * outside our own store (opencode, pi).
 *
 * The status line rides along because everything it reports — cost, tokens,
 * active duration, context used — is reconstructed from the very messages
 * this read already has; without it a reopened session showed no cost and no
 * tokens until its first new prompt (S1d). `null` means the read failed or
 * found nothing, which is not the same as a session that has cost zero.
 *
 * It deliberately carries no `ok` field: preload/web `unwrap` reads any object
 * with one as the transport envelope and would hand the renderer `undefined`.
 */
export interface EngineHistoryLoad {
  messages: ChatMessage[]
  statusLine: StatusLineData | null
  /**
   * The model the transcript's LAST assistant message names, or null when it
   * names none. A session created outside this app has no persisted model
   * entry, so without this it reopens on the configured default — a model it
   * never ran and will not resume on. Null/absent leaves the existing
   * fallback in place.
   */
  lastModel?: ModelRef | null
  /**
   * Host-run pi subagent transcripts (ADR-089), by the parent `agent` call id
   * — the key `session:subagent-message` uses live. pi only; absent when the
   * session ran no agents.
   */
  subagentMessages?: Record<string, ChatMessage[]>
  /**
   * The session's X-Agents that are running now (ADR-105 §5), keyed by the launching
   * tool_use id: records no transcript holds, added from the dispatch ledger.
   */
  activeTasks?: Record<string, ActiveTask>
  /**
   * Host-run pi subagents' terminal events (ADR-089 S3), from the task
   * notifications ClaudeUI delivered into the parent and child files — read
   * from the stored message's `details`, never parsed from its text. A
   * background launch with no notification reads `unfinished`. pi only.
   */
  taskNotifications?: TaskNotification[]
}

/**
 * MeteringSnapshot — engine-neutral session-level usage metric (foundation §3,
 * Phase 7 Pass 2). Emitted by BOTH engines on `session:metering` ALONGSIDE the
 * existing StatusLineData (which is unchanged — behavior-preserving for the
 * Claude status line). The headline metric is `equivalentCostUsd` (tokens ×
 * the internal pricing table); `engineReportedCostUsd` is the engine's own cost
 * (real spend for apiKey accounts). `window` is present only for subscription
 * accounts that expose a usage provider (Claude); apiKey/free get a cumulative
 * meter with no window. Per-billingType behavior is driven by `billingType`.
 */
export interface MeteringSnapshot {
  engineId: EngineId
  vendorId: VendorId
  billingType: BillingType
  tokens: {
    input: number
    output: number
    cacheWrite: number
    cacheRead: number
    total: number
  }
  /** tokens × internal pricing — the primary metric; null when the model is unpriced. */
  equivalentCostUsd: number | null
  /** cli.js total_cost_usd / opencode info.cost — real spend when billingType==='apiKey'. */
  engineReportedCostUsd?: number
  contextWindow: { used: number; size: number }
  /** Subscription-only; absent for apiKey/free/unknown. */
  window?: {
    usedPercent: number
    resetsAt: string | null
    /** The WLS capacity projection (subscription windows with a usage provider). */
    projection?: { maxTokens: number; costUsd: number }
  }
}
