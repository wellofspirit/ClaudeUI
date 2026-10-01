/**
 * One headless `pi --mode rpc` child, driven turn by turn (ADR-033 M4c,
 * ADR-088): the transport the cross-engine dispatcher's pi TARGET and a pi
 * session's host-run SUBAGENTS share.
 *
 * TRANSPORT IS SHARED; POLICY IS NOT. The runner owns the process and its own
 * loopback `PiBridgeHost`, the event mapper, turn driving (`runTurn`), the
 * abort-and-drain race (`abortTurn`, `draining`), the per-turn accumulators,
 * the ADR-087 D1 trajectory and the stream forwarding
 * ({@link forwardPiChildStream}). The GATE POLICY stays with each consumer
 * and is injected as `spawnOpts.gateHandler`: the dispatcher passes
 * `gatePiTargetToolCall` (the user's deny/ask rules only, then
 * `DispatchTargetJudge`), and a subagent passes its parent PiSession's gate.
 * The dispatch-specific cost rule and cap (`applyPiTurnCost`, `piTurnCost`,
 * `addDispatchedCost`), the ledger row, the error texts, the watchdog race
 * and the busy-reject also stay in the dispatcher. That is deliberately
 * narrower than "extract gatePiTargetToolCall": the gate is where the two
 * consumers differ, so it is the part that is NOT shared.
 *
 * Imports no session class and not the dispatcher (require-cycle rule): only
 * the pi transport leaves, the automode trajectory leaf and the logger.
 */
import { v4 as uuidv4 } from 'uuid'
import type { ChatMessage } from '../../shared/types'
import { engineMeta } from '../../shared/engine-meta'
import { collectToolUseIds, recordTrajectoryMessage } from '../automode/trajectory'
import { harnessUnavailableMessage } from '../harness/resolve'
import { logger } from '../services/logger'
import type { UsageTurnTokens } from '../services/usage-recorder'
import { createPiMapperState, finishPiMessage, mapPiEvent } from './event-mapper'
import type { PiMapperOutput, PiMapperState } from './event-mapper'
import { PiBridgeHost, writeBridgeExtension } from './PiBridgeHost'
import type { PiBridgeAbandoned, PiBridgeHandler, PiHostedToolHandler } from './PiBridgeHost'
import { locatePiLaunch } from './pi-locate'
import { deliveryCommand, isReservedPiCommandText, PI_RESERVED_COMMAND_PREFIX } from './pi-delivery'
import type { PiAgentDelivery } from './pi-delivery'
import type {
  PiGetLastAssistantTextData,
  PiGetSessionStatsData,
  PiGetStateData
} from './pi-protocol'
import { PiRpcClient } from './PiRpcClient'

/** Spawn opts for one headless pi child (a dispatch target or a subagent). */
export interface PiChildSpawnOpts {
  cwd: string
  /**
   * Gate handler for the child's own PiBridgeHost `/tool-call` route — the
   * consumer's approval gate (the dispatcher's `gatePiTargetToolCall`, or a
   * subagent's parent-session gate). Threaded in rather than constructed
   * inside the spawn function so the SAME closure (bound to the consumer's
   * entry) is used regardless of which spawn implementation (real or
   * test-injected) is active.
   */
  gateHandler: PiBridgeHandler
  /** The child's `/hosted-tool` handler (subagents: the child's own `agent` tool). Absent = every hosted call fails closed. */
  hostedToolHandler?: PiHostedToolHandler
  /** The child bridge's abandonment hook (see `PiBridgeHostOptions.onAbandoned`). */
  onAbandoned?: (info: PiBridgeAbandoned) => void
  /** Flags after `--mode rpc -e <bridge>` (dispatch: `['--no-session']`). */
  args?: string[]
  /**
   * Child env, built once the bridge's url/token are known. Absent = the
   * bridge vars plus explicit `''` for the hosted-tool and dispatch gates
   * (fail closed: `PiRpcClient` spawns with `{...process.env, ...opts.env}`,
   * so plain omission would let the ClaudeUI process's own flags leak in).
   */
  env?: (bridge: { url: string; token: string }) => NodeJS.ProcessEnv
}

/** The two live primitives a pi child owns — one PiRpcClient (the headless
 *  child) and its OWN PiBridgeHost (approval gate transport). */
export interface PiChildPrimitives {
  client: PiRpcClient
  bridgeHost: PiBridgeHost
}

/**
 * Spawns a headless pi child's PiRpcClient + its own PiBridgeHost.
 * Injectable so tests drive a fake child without a real binary.
 */
export type SpawnPiChildFn = (opts: PiChildSpawnOpts) => Promise<PiChildPrimitives>

function defaultChildEnv(bridge: { url: string; token: string }): NodeJS.ProcessEnv {
  return {
    CLAUDEUI_PI_BRIDGE_URL: bridge.url,
    CLAUDEUI_PI_BRIDGE_TOKEN: bridge.token,
    CLAUDEUI_PI_HOSTED_TOOLS: '',
    CLAUDEUI_PI_DISPATCH_ENABLED: ''
  }
}

/**
 * The real spawn: mirrors `PiSession.doStart()`'s shape (bridge host first,
 * then the version-keyed extension file, then the child). The consumer's
 * flags follow `--mode rpc -e <bridge>`.
 */
export const defaultSpawnPiChild: SpawnPiChildFn = async (opts) => {
  const launch = locatePiLaunch()
  if (!launch) throw new Error(harnessUnavailableMessage('pi'))
  const bridgeHost = new PiBridgeHost(
    opts.gateHandler,
    opts.hostedToolHandler,
    opts.onAbandoned ? { onAbandoned: opts.onAbandoned } : undefined
  )
  let bridge: { url: string; token: string }
  try {
    bridge = await bridgeHost.start()
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err))
  }
  const bridgePath = writeBridgeExtension()
  const client = new PiRpcClient(launch, {
    cwd: opts.cwd,
    args: ['--mode', 'rpc', '-e', bridgePath, ...(opts.args ?? [])],
    env: (opts.env ?? defaultChildEnv)(bridge)
  })
  try {
    await client.start()
  } catch (err) {
    bridgeHost.dispose()
    throw err instanceof Error ? err : new Error(String(err))
  }
  return { client, bridgeHost }
}

/** What a pi child turn settles with — see `PiChildRunner.settled`. */
export type PiTurnOutcome =
  | { kind: 'ok'; totalCostUsd: number; durationMs: number; sessionId: string | null }
  | { kind: 'error'; message: string }

export interface PiChildRunnerOpts {
  cwd: string
  /** Picker value (e.g. "openai-codex/gpt-5.6-luna"), applied by `set_model` at start. */
  model: string
  spawn: SpawnPiChildFn
  spawnOpts: Omit<PiChildSpawnOpts, 'cwd'>
  /** Stream owner (the spawning tool_use id) and emitter, both read LIVE (dispatch replaces ctx per continuation). */
  ownerToolUseId: () => string | undefined
  emit: () => (channel: string, data: unknown) => void
  /** Accounting hook for every `usage` output (dispatch: nothing extra; subagents: a child usage row). */
  onUsage?: (out: Extract<PiMapperOutput, { kind: 'usage' }>) => void
  /** Every `tool_result` output (subagents record the judge's ground-truth outcome). */
  onToolResult?: (out: Extract<PiMapperOutput, { kind: 'tool_result' }>) => void
  /** Called last when the process exits (after the turn was settled and the bridge disposed). */
  onExit?: () => void
  /** The error a turn in flight settles with when the process dies. */
  exitMessage?: string
  /** Logger tag for the runner's own warnings (the dispatcher keeps its own). */
  logTag?: string
  /** Clock for `lastActivityAt` (the watchdog's). */
  now?: () => number
  /**
   * The D1 trajectory to record into. A subagent passes its agent's own map so
   * a resumed run's judge still sees the agent's earlier actions (ADR-088 S3b);
   * absent = a fresh map for this runner.
   */
  trajectory?: Map<string, ChatMessage>
}

function zeroTurnTokens(): UsageTurnTokens {
  return { input: 0, output: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0 }
}

/**
 * A live pi child: ONE persistent headless `pi --mode rpc` process, alive
 * across turns — but its EVENT model is not an async iterable:
 * `PiRpcClient.onEvent()` is a single ambient callback registered ONCE for the
 * child's whole lifetime (installed in {@link PiChildRunner.start}), not
 * something a turn-loop can manually `.next()` through. `settled` is how a
 * turn currently in flight gets resolved by that ambient callback.
 *
 * ABORT SEMANTICS (verified empirically — see the M4c kickoff investigation):
 * pi's `abort` command is TURN-scoped — the process and session survive an
 * abort, then happily serve a fresh `prompt`.
 */
export class PiChildRunner {
  readonly client: PiRpcClient
  /** This child's OWN loopback approval-gate host (ADR-033 §4 — a dispatch
   *  target gets its own bridge, never shares the dispatching session's). */
  readonly bridgeHost: PiBridgeHost
  private _sessionId = ''
  /**
   * `this.now()` at the last pi RPC event received for this child — the
   * inactivity watchdog's clock. Fed by the ambient `onEvent` callback
   * installed in `start`, BEFORE the mapper runs, so an event the mapper
   * drops as `ignore` still counts as proof of life; refreshed by the
   * dispatcher's watchdog itself while a forwarded approval is unanswered.
   * See `CrossEngineDispatcher.startTurnWatchdog`; reset to turn start by
   * `beginTurn`.
   */
  lastActivityAt = 0
  /**
   * RACE NOTE (pi-specific, same root cause as `settled`'s RACE NOTE below):
   * the ABANDONED turn's own in-flight terminal event sequence can carry a
   * `/tool-call` 'ask' that lands AFTER the consumer's timeout/abort/stop
   * branch has already dismissed its pending approvals (the dispatcher's
   * `dismissPendingForTarget`) — pi's wire has no per-event turn correlation,
   * so the gate has no other way to recognize that ask as belonging to a turn
   * the caller was already told is stopped/failed. Without this flag, that
   * late ask would register a FRESH `pendingApprovals` entry and emit a
   * `session:approval-request` for a dispatch that already settled — orphaned
   * until a manual deny or `disposeFor`. Set true as the FIRST action of
   * `abortTurn` (before the `abort` RPC even sends, so no event can race
   * ahead of it); the consumer's gate (`gatePiTargetToolCall`) checks this
   * FIRST and short-circuits to `deny` — never registers a pending approval
   * while draining. Cleared at the start of `runTurn` — a fresh continuation
   * turn is no longer draining.
   */
  draining = false
  /**
   * Agent messages sent to this child (`deliver`) that pi has not delivered
   * yet: an id leaves when its own `custom` message_end arrives (ADR-088 S3).
   * The subagent drive keeps the child alive while any remain (a delivery that
   * landed while pi was settling starts a deferred run, see `awaitTurn`).
   */
  readonly pendingDeliveries = new Set<string>()
  /**
   * pi is inside a run: set by `agent_start`, cleared by `agent_settled`. A run
   * pi started on its own after the settle we consumed (a deferred delivery)
   * shows here even when its delivery is already confirmed.
   */
  runActive = false
  /** The child's own assistant messages for the judge (ADR-087 D1, see
   *  `recordTrajectoryMessage`). */
  readonly trajectory: Map<string, ChatMessage>
  /** Pure per-process mapper state (event-mapper.ts) — NOT reset between
   *  turns (its `totalCostUsd` is the cumulative baseline `lastReportedTotalCostUsd`
   *  is diffed against; `currentMessageId` is message-scoped bookkeeping that
   *  naturally clears itself on every assistant `message_end`). */
  readonly mapperState: PiMapperState = createPiMapperState()
  /** DISTINCT tool_use ids seen in the turn CURRENTLY in flight (ADR-033
   *  M4-B) — same Set-not-counter rationale as the other two target kinds. */
  turnToolUseIds = new Set<string>()
  /** Sum of input+output+reasoning tokens across the turn CURRENTLY in flight
   *  (ADR-033 M4-B) — pi's `usage` MapperOutput fires once per ASSISTANT
   *  MESSAGE (a multi-tool-call turn can have several), so this accumulates
   *  across them; reset to 0 at the start of every turn. */
  turnTotalTokens = 0
  /** The same accumulation as `turnTotalTokens`, kept SPLIT for the ledger row
   *  (ADR-071 §1) — pi's `usage` output carries the breakdown the total throws
   *  away, and `usage_event` has a column per part. Reset with it. */
  turnTokens: UsageTurnTokens = zeroTurnTokens()
  /** The turn's reasoning tokens, kept beside `turnTokens` because the ledger
   *  has no column for them (they are billed as output) but `piCostInputs`
   *  prices them — the same fold `PiSession` makes for its own turns. */
  turnReasoningTokens = 0
  /**
   * Mirrors `ClaudeTargetEntry.lastReportedTotalCostUsd` — VERIFIED WIRE FACT
   * (event-mapper.ts's `agent_settled` case echoes `state.totalCostUsd`, which
   * only grows via `+=` in the assistant `message_end` branch): the mapper's
   * `result` output's `totalCostUsd` is CUMULATIVE across this child's WHOLE
   * process lifetime, not per-turn. Converts each turn's reported running
   * total into a per-turn delta against this baseline (`takeCostDelta`) — the
   * exact same pattern as the Claude target (same wire-cumulative-total
   * hazard).
   */
  lastReportedTotalCostUsd = 0
  /**
   * Resolver for the turn CURRENTLY in flight; null when idle. Set by
   * `runTurn` just before sending `prompt`, invoked EXACTLY ONCE per turn by
   * the output handler's `result`/`error` handling, or by the `onExit`
   * handler if the process dies mid-turn. See `runTurn`'s doc comment for why
   * pi needs this event-driven settle instead of Claude's manual iterator
   * pull.
   *
   * RACE NOTE (pi-specific — Claude/opencode don't have this): on timeout/
   * abort/stop, pi's child process SURVIVES (see the class doc comment) and
   * its OWN terminal event sequence for the ABANDONED turn is still in
   * flight (message_end→turn_end→agent_end→agent_settled, triggered by the
   * `abort` command). pi's wire has NO per-event turn correlation — whatever
   * wrapper is CURRENTLY installed here receives the NEXT settle-shaped
   * event, whichever turn actually produced it — so `abortTurn` WAITS
   * (briefly, bounded) for this field to go quiet before the consumer
   * releases its `busy`, instead of returning immediately, so a fast-enough
   * continuation can never install a new wrapper while a stale one is still
   * pending delivery. See `abortTurn` and the dispatcher's
   * `resolveAndRunPi` stop/timeout/abort branch.
   */
  private settled: ((outcome: PiTurnOutcome) => void) | null = null
  /** The turn in flight's promise, for `abortTurn`'s bounded wait. */
  private currentTurn: Promise<PiTurnOutcome> | null = null
  private disposed = false
  private readonly now: () => number
  private readonly logTag: string

  private constructor(
    private readonly opts: PiChildRunnerOpts,
    primitives: PiChildPrimitives
  ) {
    this.client = primitives.client
    this.bridgeHost = primitives.bridgeHost
    this.now = opts.now ?? Date.now
    this.logTag = opts.logTag ?? 'PiChildRunner'
    this.trajectory = opts.trajectory ?? new Map()
  }

  /**
   * pi's own session id, from `get_state` — UNLIKE Claude (whose session_id
   * only arrives with the first turn's `system/init`), pi's `get_state`
   * returns a real in-memory session id immediately after spawn (VERIFIED —
   * even under `--no-session`), so it is set EAGERLY in `start`, before the
   * first turn ever runs. A successfully-started runner always has it
   * (`start` throws instead of returning one without it).
   */
  get sessionId(): string {
    return this._sessionId
  }

  /**
   * Spawn the child + its PiBridgeHost, wire the ambient event/exit
   * callbacks, resolve `get_state` (capturing the session id EAGERLY), then
   * apply the requested model via `set_model`. Any failure along the way
   * tears down whatever was already created and re-throws — the consumer
   * turns that into a friendly isError.
   */
  static async start(opts: PiChildRunnerOpts): Promise<PiChildRunner> {
    let primitives: PiChildPrimitives
    try {
      primitives = await opts.spawn({ ...opts.spawnOpts, cwd: opts.cwd })
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err))
    }
    const runner = new PiChildRunner(opts, primitives)
    runner.wire()
    try {
      const stateResp = await runner.client.request<PiGetStateData>({ type: 'get_state' })
      if (!stateResp.success || !stateResp.data?.sessionId) {
        throw new Error(stateResp.error ?? 'pi target did not report a session id')
      }
      runner._sessionId = stateResp.data.sessionId
      runner.mapperState.sessionId = runner._sessionId

      const ref = engineMeta('pi').decodeModelValue(opts.model)
      const setModelResp = await runner.client.request({
        type: 'set_model',
        provider: ref.vendorId,
        modelId: ref.modelId
      })
      if (!setModelResp.success) {
        throw new Error(setModelResp.error ?? `Failed to set pi model "${opts.model}"`)
      }
    } catch (err) {
      runner.dispose()
      throw err instanceof Error ? err : new Error(String(err))
    }
    return runner
  }

  private wire(): void {
    this.client.onEvent((ev) => {
      // Proof of life for the inactivity watchdog, taken BEFORE the mapper so
      // an event it drops as `ignore` still counts (see `lastActivityAt`).
      this.lastActivityAt = this.now()
      const outputs = mapPiEvent(ev, this.mapperState)
      for (const output of outputs) this.handleOutput(output)
    })
    this.client.onExit(() => {
      // If a turn is in flight, nothing else will ever settle it — mirrors
      // the Claude target's process-exit-kills-the-turn outcome. ALSO dispose
      // the bridge host here (not just on dispose) — an unexpected process
      // death must not leak the loopback HTTP server's port (mirrors
      // PiSession's own onExit teardown of its bridgeHost).
      this.flush()
      const settle = this.settled
      this.settled = null
      settle?.({
        kind: 'error',
        message: this.opts.exitMessage ?? 'pi child process exited unexpectedly'
      })
      this.bridgeHost.dispose()
      this.opts.onExit?.()
    })
  }

  /** Reset the per-turn accumulators (and the watchdog clock) for a fresh turn. */
  beginTurn(startedAt: number = this.now()): void {
    this.turnToolUseIds = new Set()
    this.turnTotalTokens = 0
    this.turnTokens = zeroTurnTokens()
    this.turnReasoningTokens = 0
    this.lastActivityAt = startedAt
  }

  /**
   * Send the `prompt` command and await turn completion.
   *
   * DIVERGES FROM `driveClaudeTurn`: Claude's `sdkQuery()` hands back an
   * AsyncIterable the dispatcher manually pulls (`iterator.next()`) until it
   * sees `result` — necessary there because `for await` would `.return()` the
   * iterator on early exit and kill the process (see ClaudeTargetEntry's
   * hazard doc). pi's `PiRpcClient` has NO such iterable: agent events arrive
   * via a single ambient `onEvent` callback registered ONCE for the child's
   * whole lifetime (wired in `start`), so there is nothing to pull from and
   * no `.return()` hazard to guard against. "Driving a turn" here instead
   * means: install `settled` as this promise's resolver BEFORE sending
   * `prompt` (synchronously, so no event or ack can possibly arrive first),
   * then let the ALREADY-RUNNING onEvent → output-handler pipeline settle it
   * once the mapper produces a `result` (agent_settled) or `error`
   * (extension_error) output. A turn is guaranteed unique in flight by the
   * consumer's busy-reject (the dispatcher's `resolveAndRunPi`), mirroring the
   * single-iterator exclusivity Claude's `busy` flag protects.
   *
   * `streamingBehavior` (pi's steer/follow-up mode for a prompt sent while
   * already streaming) is deliberately NEVER set: a child only ever has ONE
   * caller and the busy-reject above guarantees at most one turn in flight,
   * so pi is never "already streaming" when this fires — unlike
   * PiSession.run(), which drives an INTERACTIVE session where the human can
   * send a follow-up mid-turn.
   */
  runTurn(prompt: string): Promise<PiTurnOutcome> {
    // Model-authored text (an agent's or a dispatcher's prompt) must never run
    // a ClaudeUI bridge command in the child (ADR-088 S3): nothing is sent.
    if (isReservedPiCommandText(prompt)) {
      return Promise.resolve({
        kind: 'error',
        message: `A prompt may not start with "${PI_RESERVED_COMMAND_PREFIX}".`
      })
    }
    return this.sendTurn(prompt)
  }

  /**
   * Start a turn with a HOST-BUILT agent message instead of a prompt (ADR-088
   * S3b: `send_message` resuming a finished agent). The bridge command is built
   * here from the structured payload — never accepted as text, so `runTurn`'s
   * refusal of `/cui-` stays absolute for model-authored prompts. The command
   * starts the run itself (probe P-S3: one `agent_settled`); the payload's id
   * waits in `pendingDeliveries` like any delivery. Host code only.
   */
  resumeWithDelivery(payload: PiAgentDelivery): Promise<PiTurnOutcome> {
    this.pendingDeliveries.add(payload.deliveryId)
    return this.sendTurn(deliveryCommand(payload))
  }

  private sendTurn(prompt: string): Promise<PiTurnOutcome> {
    this.mapperState.startTimeMs = Date.now()
    this.mapperState.messageEnded = false
    // A fresh turn (first turn, or a continuation after a prior stop/timeout/
    // abort) is never draining — see `draining`'s doc comment.
    this.draining = false
    const turn = new Promise<PiTurnOutcome>((resolve) => {
      this.settled = resolve
      this.client.request({ type: 'prompt', message: prompt }).then(
        (resp) => {
          // Only the ACK that the prompt was accepted — the real outcome
          // arrives later via the ambient onEvent pipeline UNLESS pi rejected
          // it outright (e.g. malformed command), in which case nothing else
          // will ever settle this promise.
          if (!resp.success && this.settled === resolve) {
            this.settled = null
            resolve({ kind: 'error', message: resp.error ?? 'pi rejected the prompt' })
          }
        },
        (err) => {
          if (this.settled === resolve) {
            this.settled = null
            resolve({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
          }
        }
      )
    })
    this.currentTurn = turn
    return turn
  }

  /**
   * Put an agent-authored message into this child (ADR-088 S3): the bridge's
   * `/cui-deliver` command as an RPC `prompt` — never plain text, `steer` or
   * `follow_up` (pi-delivery.ts, the marking rule). pi steers a running turn
   * or, idle and `wake`, starts one; the id stays in `pendingDeliveries` until
   * the custom message itself arrives (the ack does not confirm it, P-S4).
   * Never rejects; a failed ack is logged with ids only.
   */
  async deliver(payload: PiAgentDelivery): Promise<void> {
    this.pendingDeliveries.add(payload.deliveryId)
    try {
      const resp = await this.client.request({ type: 'prompt', message: deliveryCommand(payload) })
      if (!resp.success) {
        this.pendingDeliveries.delete(payload.deliveryId)
        logger.warn(
          this.logTag,
          `delivery ${payload.deliveryId} (agent ${payload.details.agentId}) was not accepted`
        )
      }
    } catch (err) {
      this.pendingDeliveries.delete(payload.deliveryId)
      logger.warn(
        this.logTag,
        `delivery ${payload.deliveryId} (agent ${payload.details.agentId}) failed: ${err instanceof Error ? err.constructor.name : 'Error'}`
      )
    }
  }

  /**
   * Wait for a run pi starts ON ITS OWN (no prompt is sent): a delivery that
   * landed while pi was settling runs AFTER the `agent_settled` the caller
   * already consumed (agent-session.ts defers it, Facts S2/S3). Settles with
   * that run's outcome, or `{kind: 'idle'}` when no run has started
   * (`agent_start`) by the end of `idleGraceMs`. Once a run started, it waits
   * for its settle however long it takes. Keyed on the run rather than on any
   * event: a passive delivery appended at idle emits its message and no run.
   */
  awaitTurn(idleGraceMs: number): Promise<PiTurnOutcome | { kind: 'idle' }> {
    const turn = new Promise<PiTurnOutcome | { kind: 'idle' }>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const settle = (outcome: PiTurnOutcome): void => {
        if (timer) clearTimeout(timer)
        resolve(outcome)
      }
      this.settled = settle
      if (!this.runActive) {
        timer = setTimeout(() => {
          timer = undefined
          if (this.settled !== settle || this.runActive) return
          this.settled = null
          resolve({ kind: 'idle' })
        }, idleGraceMs)
      }
    })
    this.currentTurn = turn as Promise<PiTurnOutcome>
    return turn
  }

  /**
   * Give up on the turn in flight: `draining` FIRST, then the `abort` RPC,
   * then a BOUNDED wait for the abandoned turn to settle.
   */
  async abortTurn(graceMs: number): Promise<void> {
    // See `draining`'s doc comment — set FIRST, synchronously, before the
    // `abort` RPC even sends, so no late 'ask' from this turn can possibly
    // race ahead of it.
    this.draining = true
    // pi's `abort` interrupts the CURRENT TURN only (session survives —
    // verified; see the class doc comment), so the child is kept alive for
    // continuation rather than torn down.
    void this.client.request({ type: 'abort' }).catch(() => {})
    // RACE GUARD (see `settled`'s "RACE NOTE"): wait, BOUNDED, for the
    // ABANDONED turn's own terminal event sequence (still in flight —
    // triggered by the abort just sent) to drain and settle `settled` back to
    // null BEFORE the consumer releases its `busy`. Without this, a
    // fast-enough continuation could install a NEW settle wrapper here while
    // the stale one is still pending delivery — pi's wire has no per-event
    // turn correlation, so whichever wrapper is CURRENTLY installed receives
    // the next settle-shaped event regardless of which turn actually
    // produced it.
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      this.currentTurn ?? Promise.resolve(),
      new Promise<void>((r) => {
        graceTimer = setTimeout(r, graceMs)
      })
    ])
    if (graceTimer) clearTimeout(graceTimer)
    this.settled = null // belt-and-suspenders if the grace period elapsed first
  }

  /**
   * The turn's raw cost delta: `max(0, total - lastReportedTotalCostUsd)`,
   * advancing the baseline (see `lastReportedTotalCostUsd`). `total`
   * defaults to the mapper's per-PROCESS running total, the right source for
   * a non-success outcome (it carries no total of its own).
   */
  takeCostDelta(totalCostUsd: number = this.mapperState.totalCostUsd): number {
    const delta = Math.max(0, totalCostUsd - this.lastReportedTotalCostUsd)
    this.lastReportedTotalCostUsd = totalCostUsd
    return delta
  }

  /**
   * pi's authoritative cumulative cost (`get_session_stats`, the SAME RPC
   * PiSession's resume-seed already trusts), read BOUNDED and swallowed on
   * failure: the stats figure when it reports MORE than the mapper's total,
   * otherwise the mapper's total.
   */
  async reconciledTotalCostUsd(timeoutMs: number): Promise<number> {
    let totalCostUsd = this.mapperState.totalCostUsd
    try {
      const statsResp = await this.client.request<PiGetSessionStatsData>(
        { type: 'get_session_stats' },
        timeoutMs
      )
      if (statsResp.success && statsResp.data && statsResp.data.cost > totalCostUsd) {
        totalCostUsd = statsResp.data.cost
      }
    } catch (err) {
      logger.warn(
        this.logTag,
        `pi get_session_stats cost reconciliation failed (falling back to streamed cost): ${err instanceof Error ? err.message : String(err)}`
      )
    }
    return totalCostUsd
  }

  /**
   * `get_last_assistant_text` — simpler + more reliable than accumulating
   * `message` MapperOutputs across the turn ourselves. Best-effort: null on a
   * failure or an empty text, so the caller substitutes a placeholder rather
   * than failing an otherwise-successful turn over a follow-up RPC call.
   */
  async lastAssistantText(): Promise<string | null> {
    try {
      const textResp = await this.client.request<PiGetLastAssistantTextData>({
        type: 'get_last_assistant_text'
      })
      if (textResp.success && textResp.data?.text) return textResp.data.text
    } catch (err) {
      logger.warn(
        this.logTag,
        `pi get_last_assistant_text failed (using placeholder text): ${err instanceof Error ? err.message : String(err)}`
      )
    }
    return null
  }

  /** Seal whatever the mapper still holds open (dispose paths call it). */
  flush(): void {
    for (const output of finishPiMessage(this.mapperState)) this.handleOutput(output)
  }

  /**
   * Kill the child + its OWN bridge host (mirrors PiSession.cancel()'s
   * identical teardown order). Idempotent, and safe even if the process
   * already exited on its own (onExit already disposed the bridge host; both
   * underlying disposes no-op when already torn down).
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.client.dispose()
    this.bridgeHost.dispose()
  }

  /**
   * The child's live turn output. Owns turn-completion: `result`/`error`
   * MapperOutputs settle `settled` (see `runTurn`'s doc comment) and `usage`
   * outputs accumulate this turn's token total; then the trajectory, the
   * `onToolResult` hook and the stream ({@link forwardPiChildStream}).
   */
  private handleOutput(output: PiMapperOutput): void {
    let out = output
    if (out.kind === 'send_message_error') {
      // ADR-088 review F3: while one of our deliveries is pending this is its
      // async failure — not the turn's. With exactly one pending it is that
      // one (dropped, so the drive does not wait for it); otherwise it stays
      // an ordinary extension error.
      if (this.pendingDeliveries.size > 0) {
        logger.warn(this.logTag, 'a pending agent delivery failed inside pi')
        if (this.pendingDeliveries.size === 1) this.pendingDeliveries.clear()
        return
      }
      out = { kind: 'error', message: out.message }
    }
    if (out.kind === 'turn_start') {
      this.runActive = true
      return
    }
    if (out.kind === 'agent_delivery') {
      // The delivery's own custom message_end: THIS is delivery (the ack is not, P-S4).
      this.pendingDeliveries.delete(out.deliveryId)
      return
    }
    if (out.kind === 'result') {
      this.runActive = false
      this.settled?.({
        kind: 'ok',
        totalCostUsd: out.totalCostUsd,
        durationMs: out.durationMs,
        sessionId: out.sessionId
      })
      this.settled = null
      return
    }
    if (out.kind === 'error') {
      this.settled?.({ kind: 'error', message: out.message })
      this.settled = null
      // Falls through — also forwarded as a visible stream chunk below (if a
      // toolUseId is set) so a live-watching human sees WHY the turn ended,
      // not just the eventual "Dispatched turn failed" summary.
    }

    // ACCOUNTING IS NOT STREAMING, so it runs ABOVE the tool_use gate in
    // `forwardPiChildStream`: the cap and the ledger row need this turn's
    // tokens even for a dispatch with no caller tool_use to stream chunks to,
    // and a gated accumulator would report such a turn as a zero split and a
    // countable zero cost. `usage` is still never a visible chunk — the
    // return here is what keeps it out of the stream, exactly as the switch's
    // own `case` did.
    if (out.kind === 'usage') {
      this.turnTotalTokens += out.tokens.input + out.tokens.output + (out.tokens.reasoning ?? 0)
      // The split the ledger row needs, accumulated beside the total across
      // the turn's several assistant messages. The four fields pi reports
      // are the four `PiSession` records for its OWN turns — `reasoning` is
      // deliberately not folded into `output` here, for parity with it, and
      // is carried separately for the price lookup, which does fold it.
      this.turnTokens.input += out.tokens.input
      this.turnTokens.output += out.tokens.output
      this.turnTokens.cacheWrite += out.tokens.cacheWrite
      this.turnTokens.cacheRead += out.tokens.cacheRead
      this.turnReasoningTokens += out.tokens.reasoning ?? 0
      this.opts.onUsage?.(out)
      return
    }

    // ADR-087 D1 — the child's own assistant messages, for its judge; above
    // the tool_use gate like the accounting (the judge needs them either way).
    if (out.kind === 'message' || out.kind === 'item_seal') {
      recordTrajectoryMessage(this.trajectory, out.message)
    }
    if (out.kind === 'tool_result') this.opts.onToolResult?.(out)

    forwardPiChildStream(out, this.opts.ownerToolUseId(), this.opts.emit(), this.turnToolUseIds)
  }
}

/**
 * Forward a pi child's live turn output as engine-neutral subagent events —
 * byte-matches `forwardClaudeTargetMessage`'s / `handleOpencodeTargetStream`'s
 * payload shapes exactly (item-open / item-delta / item-seal,
 * subagent-message, subagent-tool-result), owned by `ownerToolUseId` (the
 * spawning tool_use; nothing is emitted without one). `bash_output`/`ignore`
 * are skipped — the caller's TaskCard doesn't stream a child's raw bash
 * output (same as the other two directions). `result`/`usage` never reach
 * here (the runner consumes them first).
 */
export function forwardPiChildStream(
  out: PiMapperOutput,
  ownerToolUseId: string | undefined,
  emit: (channel: string, data: unknown) => void,
  turnToolUseIds: Set<string>
): void {
  const toolUseId = ownerToolUseId
  if (!toolUseId) return

  switch (out.kind) {
    case 'item_open': {
      const target = { ...out.target, ownerToolUseId: toolUseId }
      // The mapper already measured the thought's start; forwarding it
      // unchanged is what makes the child's live timer match the parent's.
      emit('session:item-open', {
        target,
        message: out.message,
        ...(out.startedAt === undefined ? {} : { startedAt: out.startedAt })
      })
      break
    }
    case 'item_delta': {
      const target = { ...out.target, ownerToolUseId: toolUseId }
      emit('session:item-delta', { target, chunk: out.chunk })
      break
    }
    case 'item_seal': {
      const target = out.target ? { ...out.target, ownerToolUseId: toolUseId } : undefined
      collectToolUseIds(out.message, turnToolUseIds)
      emit('session:item-seal', {
        message: out.message,
        ownerToolUseId: toolUseId,
        ...(target ? { target } : {})
      })
      break
    }
    case 'message':
      collectToolUseIds(out.message, turnToolUseIds)
      emit('session:subagent-message', { toolUseId, message: out.message })
      break
    case 'tool_result':
      emit('session:subagent-tool-result', {
        toolUseId,
        toolResultToolUseId: out.toolUseId,
        result: out.result,
        isError: out.isError
      })
      break
    case 'error':
      emit('session:subagent-message', {
        toolUseId,
        message: {
          id: uuidv4(),
          role: 'assistant',
          content: [{ type: 'text', text: `[error: ${out.message}]` }],
          timestamp: Date.now()
        }
      })
      break
    // The runner consumes these (run start, delivery confirmation); no stream.
    case 'turn_start':
    case 'agent_delivery':
    case 'delivery_error':
    case 'send_message_error':
    case 'bash_output':
    case 'ignore':
      break
  }
}
