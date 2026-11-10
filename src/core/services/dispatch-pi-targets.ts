/**
 * pi dispatch targets: one headless `pi --mode rpc` child per target plus its own loopback approval gate.
 * Split out of `cross-engine-dispatcher.ts`; the core is reached through `DispatchTargetHost`.
 */
import { existsSync } from 'node:fs'
import { v4 as uuidv4 } from 'uuid'
import { peekPiModels } from '../pi/model-discovery'
import { DispatchTargetJudge } from './dispatch-target-judge'
import { blockHoldMs } from '../automode/block-hold'
import {
  blockApprovalNotice,
  blockedCallDelivery,
  type BlockedCall
} from '../automode/blocked-calls'
import type {
  GateDecision,
  PiBridgeHandler,
  PiHostedToolResult,
  PiToolCallPayload
} from '../pi/PiBridgeHost'
import {
  defaultSpawnPiChild,
  PiChildRunner,
  type PiChildSpawnOpts,
  type PiTurnOutcome
} from '../pi/pi-child-runner'
import { collectClaudeMcpForPi, piMcpRuleKey } from '../pi/pi-mcp-bridge'
import { buildPiSkillDescriptors } from '../pi/pi-skill-bridge'
import { resolveClaudeSkillCatalog } from './claude-skill-catalog'
import { decideWithSource, sessionToolDenyRule } from '../pi/permission-engine'
import type { MergedClaudeRules } from '../pi/permission-engine'
import { buildPiPathScope, withPathGuard, type PiPathScope } from '../pi/pi-path-scope'
import {
  dispatchScratchpadKey,
  ensurePiScratchpad,
  scratchpadPromptArgs,
  type PiScratchpad
} from '../pi/pi-scratchpad'
import type { ResolvedCosts } from '../../shared/cost-rule'
import { piMessageCosts, type PiCostReport, type PiCostTokens } from '../pi/message-cost'
import { engineMeta } from '../../shared/engine-meta'
import { logger } from './logger'
import { piAuthProvider } from '../auth/PiAuthProvider'
import {
  dispatchPiSessionDir,
  type DispatchTargetRow,
  type DispatchTargetState
} from './dispatch-target-ledger'
import { runSessionTool, sessionToolsAvailable } from './session-tools'
import { xAgentSessionToolsEnv } from './session-tool-specs'
import { X_AGENT_MESSAGE_TOOL } from '../../shared/x-agent-message'
import { HAND_BACK_TOOL } from '../../shared/dispatch-agent-description'
import { type RunContext } from './dispatch-parent'
import type { PendingApproval } from '../../shared/types'
import { XENG_REQUEST_PREFIX } from './dispatch-target-types'
import type {
  DispatchContext,
  DispatchRequest,
  FreshLaunch,
  DispatchResult,
  SpawnPiTargetFn,
  DispatchTurnAccount,
  TurnTimeout,
  PiTargetEntry,
  TargetEntry,
  TurnReturn
} from './dispatch-target-types'
import {
  targetCwd,
  liveMode,
  resolveTurnLiveness,
  turnTimeoutText,
  keepTargetBlock,
  recordTargetBlock,
  errorResult,
  judgeDescription,
  errText,
  canonicalDispatchModel,
  cannotCountNote,
  emitDispatchNotification,
  settledWithin
} from './dispatch-target-shared'
import type { DispatchTargetHost } from './dispatch-target-host'

/**
 * Spawn opts for a headless pi dispatch target (ADR-033 M4c) — the shared
 * `PiChildSpawnOpts` (ADR-089). `gateHandler` is the two-stage approval gate
 * (see `CrossEngineDispatcher.gatePiTargetToolCall`); a target passes no
 * `hostedToolHandler`.
 */
export type PiTargetSpawnOpts = PiChildSpawnOpts

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

const PI_TIMEOUT_AFTERMATH =
  'the target agent was interrupted (the session survives; a fresh turn may still be dispatched against it).'

/** Default for `DispatcherDeps.piAbortSettleGraceMs` — see that field's doc comment. */
const PI_ABORT_SETTLE_GRACE_MS = 3_000

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
  report: PiCostReport
): ResolvedCosts {
  const { vendorId, modelId } = engineMeta('pi').decodeModelValue(model)
  return piMessageCosts(vendorId, modelId, tokens, report)
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
 * Real default for `DispatcherDeps.spawnPiTarget` (ADR-033 M4c):
 * `defaultSpawnPiChild` (pi-child-runner.ts, ADR-089), which mirrors
 * `PiSession.doStart()`'s spawn shape (bridge host first, then the version-
 * keyed extension file, then the child), with two deliberate differences for
 * a headless DISPATCH target:
 *  - a persisted but HIDDEN session (ADR-105; was `--no-session`): `--session-dir
 *    ~/.claude/ui/dispatch/pi/<ledgerId> --session-id <id>`, outside the
 *    `~/.pi/agent/sessions` the sidebar lists, so the target can be resumed
 *    from its ledger row after its parent restarts.
 *  - NO `CLAUDEUI_PI_HOSTED_TOOLS` / `CLAUDEUI_PI_DISPATCH_ENABLED`
 *    in the target's env — `buildPiTargetChildEnv`
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
 *  - The Claude skill catalog for the dispatch cwd IS listed (`CLAUDEUI_PI_SKILLS=1`, the
 *    descriptors handed to the target's bridge host at the spawn site); a skill is a file
 *    the model reads, not a recursion path.
 */
/**
 * The env vars a pi dispatch TARGET's child process gets. Extracted as a pure
 * function (rather than inlined into `defaultSpawnPiTarget`) so the
 * recursion-guard property is DIRECTLY unit-testable without mocking
 * PiRpcClient/PiBridgeHost/locatePiLaunch: NO `CLAUDEUI_PI_HOSTED_TOOLS` /
 * `CLAUDEUI_PI_DISPATCH_ENABLED` — see
 * `defaultSpawnPiTarget`'s doc comment for the full rationale.
 *
 * The gate vars are set to `''` EXPLICITLY, not merely left out of this
 * object: `PiRpcClient` spawns with `{...process.env, ...opts.env}` (this
 * object is `opts.env`), so plain omission would let the flag leak straight
 * through from the ClaudeUI process's OWN env if IT happens to carry one
 * (e.g. a dev shell that exports `CLAUDEUI_PI_HOSTED_TOOLS=1` for its own pi
 * session) — the target would then see hosted tools registered (still unable
 * to execute them, see `defaultSpawnPiTarget`'s doc comment, but visible and
 * always-erroring to the model). The bridge extension's gates are plain
 * truthiness/`=== '1'` checks (pi-bridge-source.ts) — `''` is falsy against
 * both, so this reliably disables them regardless of what the parent
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
    // ADR-089: a dispatch target never gets the host-run `agent` or
    // `send_message` tools (same leak argument as the three above).
    CLAUDEUI_PI_AGENT_TOOL: '',
    CLAUDEUI_PI_SEND_MESSAGE: '',
    // ADR-105 §3: the one tool a target is for — the report that ends its run.
    CLAUDEUI_PI_HAND_BACK: handBack ? '1' : '',
    // ADR-096: a dispatch target registers the shared MCP catalog, as an
    // opencode target does; the configs come from the target's own bridge
    // host (`mcpServers` at the spawn site), never from this env.
    CLAUDEUI_PI_MCP: '1',
    // The shared Claude skill catalog for the dispatch cwd, likewise served by the target's own
    // bridge host (`skills` at the spawn site).
    CLAUDEUI_PI_SKILLS: '1'
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
  messaging: boolean,
  scratchpadDir?: string
): Pick<PiTargetSpawnOpts, 'args' | 'env'> {
  return {
    // Persisted and hidden (ADR-105, the ADR-089 sub-agent precedent): the same two
    // flags create the session and resume it (pi opens the file when it exists). The target is
    // told about its own scratchpad (ADR-110), when it has one.
    args: [
      '--session-dir',
      sessionDir,
      '--session-id',
      sessionId,
      ...scratchpadPromptArgs(scratchpadDir)
    ],
    env: (bridge) => buildPiTargetChildEnv(bridge, handBack, messaging)
  }
}

const defaultSpawnPiTarget: SpawnPiTargetFn = defaultSpawnPiChild

export class PiTargets {
  private readonly host: DispatchTargetHost
  private readonly piAbortSettleGraceMs: number
  private readonly spawnPiTarget: SpawnPiTargetFn
  private readonly piSessionDirExists: (dir: string) => boolean
  private readonly piScratchpad: (cwd: string, key: string) => PiScratchpad | undefined

  constructor(host: DispatchTargetHost) {
    this.host = host
    const deps = host.deps
    this.piAbortSettleGraceMs = deps.piAbortSettleGraceMs ?? PI_ABORT_SETTLE_GRACE_MS
    this.spawnPiTarget = deps.spawnPiTarget ?? defaultSpawnPiTarget
    this.piSessionDirExists = deps.piSessionDirExists ?? existsSync
    this.piScratchpad = deps.piScratchpad ?? ((cwd, key) => ensurePiScratchpad(cwd, key))
  }

  /** `session_message` from a pi target, answered as the engine's tool result. */
  private async xAgentMessage(
    entry: TargetEntry,
    input: Record<string, unknown>,
    toolUseId?: string
  ): Promise<{ text: string; isError: boolean }> {
    const result = await runSessionTool(
      this.host.xAgentCaller(entry, toolUseId),
      X_AGENT_MESSAGE_TOOL,
      input
    )
    return { text: result.text, isError: result.isError === true }
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
      {
        totalUsd: rawTurnCostUsd,
        fromProvider: entry.runner.turnCostFromProvider,
        componentsUsd: entry.runner.turnCostComponentsUsd
      }
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
  async resolveAndRunPi(
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
    const dispatchCfg = this.host.deps.loadEngineConfig('pi').dispatch
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
      const cont = this.host.findContinuation(req.sessionId, ctx, 'pi')
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
      const spent = this.host.continuationSpend(cont, dispatchCfg, req.sessionId, 'pi')
      if ('text' in spent) return spent
      if ('row' in cont) {
        const refusal = this.host.resumeModelRefusal('pi', cont.row.model, dispatchCfg)
        if (refusal) return refusal
      }
      if ('live' in cont) {
        this.host.bindContinuation(ctx, cont)
        cont.live.ctx = ctx
        entry = cont.live
      } else {
        // The child is gone: respawn it on the same session dir and id — pi opens the
        // session file it finds there, in the directory the target was created in.
        model = cont.row.model
        // pi given an id it cannot find CREATES a session under it, silently dropping the
        // conversation: a directory that is gone is the end of this target, not a fresh start.
        if (!this.piSessionDirExists(dispatchPiSessionDir(cont.row.id))) {
          this.host.ledgerSet(cont.row.id, { state: 'failed' })
          return errorResult(
            `Dispatch session "${req.sessionId}" cannot be resumed — its pi session directory no longer exists. ` +
              'Start a new X-Agent with dispatch_agent.',
            req.sessionId
          )
        }
        this.host.bindContinuation(ctx, cont)
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
      this.host.ledgerTurnState(entry, 'running')
      entry.turnEngineCostUsd = null
      const turnStartedAt = this.host.now()
      entry.runner.beginTurn(turnStartedAt)

      // ── Run the turn ──────────────────────────────────────────────────────
      const heartbeat = this.host.startHeartbeat(ctx)

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
      const watchdog = this.host.startTurnWatchdog(entry.runner, caps, turnStartedAt, () =>
        this.host.hasPendingApprovalFor(entry.sessionId)
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
                durationMs: this.host.now() - turnStartedAt,
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
          if (entry.sessionId) this.host.dismissPendingForTarget(entry.sessionId)
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
            this.host.safeRecordUsage({
              ts: this.host.now(),
              fromRoutingId: ctx.fromRoutingId,
              targetEngine: 'pi',
              targetModel: model,
              targetSessionId: entry.sessionId,
              toolUseId: ctx.toolUseId ?? null,
              tokens: entry.runner.turnTokens,
              engineCostUsd: entry.turnEngineCostUsd,
              account: piDispatchAccount(model),
              // pi's figure is a list price UNLESS the turn carried an
              // OpenRouter-billed total (pi 1.5.0 `totalFromProvider`), which
              // is money charged and must be read as the billed figure.
              engineCostIsEquivalent: !entry.runner.turnCostFromProvider
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
          if (entry.sessionId) this.host.dismissPendingForTarget(entry.sessionId)
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
          this.host.safeRecordUsage({
            ts: this.host.now(),
            fromRoutingId: ctx.fromRoutingId,
            targetEngine: 'pi',
            targetModel: model,
            targetSessionId: entry.sessionId,
            toolUseId: ctx.toolUseId ?? null,
            tokens: entry.runner.turnTokens,
            engineCostUsd: entry.turnEngineCostUsd,
            account: piDispatchAccount(model),
            engineCostIsEquivalent: !entry.runner.turnCostFromProvider
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

        await this.host.settleReview(ctx.run)
        const done = this.host.finishTurn(ctx, 'pi', model, entry, entry.sessionId ?? '', {
          finalText,
          outText,
          usage: {
            totalTokens: entry.runner.turnTotalTokens,
            toolUses: entry.runner.turnToolUseIds.size,
            durationMs: outcome.durationMs
          }
        })
        this.host.safeRecordUsage({
          ts: this.host.now(),
          fromRoutingId: ctx.fromRoutingId,
          targetEngine: 'pi',
          targetModel: model,
          targetSessionId: entry.sessionId,
          toolUseId: ctx.toolUseId ?? null,
          tokens: entry.runner.turnTokens,
          // pi reports a LIST PRICE, not a charge (S1b) — the ledger must not
          // read it as money that left a wallet — unless the turn carried an
          // OpenRouter-billed total (pi 1.5.0 `totalFromProvider`), which IS
          // money charged.
          engineCostUsd: entry.turnEngineCostUsd,
          account: piDispatchAccount(model),
          engineCostIsEquivalent: !entry.runner.turnCostFromProvider
        })
        return done
      } finally {
        entry.runner.flush()
        entry.busy = false
        this.host.ledgerTurnState(entry, endState)
        clearInterval(heartbeat)
        watchdog.dispose()
        if (signal && abortListener) signal.removeEventListener('abort', abortListener)
      }
    }
    return this.host.runWithNudges(
      ctx,
      {
        sessionId: () => entry.sessionId ?? '',
        engine: 'pi',
        toolName: HAND_BACK_TOOL,
        cumulativeCostUsd: () => entry.cumulativeCostUsd
      },
      this.host.taskText(entry, ctx, req.prompt, HAND_BACK_TOOL),
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
    fresh?: FreshLaunch
  ): Promise<PiTargetEntry> {
    // The session id is minted here and the ledger row written BEFORE the child spawns
    // (ADR-105); a resume reuses both, in the directory the target was created in.
    const harnessId = resume?.harnessRef ?? uuidv4()
    const cwd = targetCwd(ctx, resume, fresh)
    const row =
      resume ??
      this.host.recordTarget(ctx, {
        engine: 'pi',
        harnessRef: harnessId,
        cwd,
        model,
        accountKey: piDispatchAccount(model).accountKey,
        fresh,
        handBack: this.host.requireHandBack
      })
    const entry: PiTargetEntry = {
      kind: 'pi',
      sessionId: null,
      ledgerId: row.id,
      released: false,
      handBack: this.host.requireHandBack,
      canMessage: sessionToolsAvailable(),
      fromRoutingId: ctx.fromRoutingId,
      cwd,
      // The ledger row id is stable across resumes (and what ending the X-Agent removes it by).
      scratchpad: this.piScratchpad(cwd, dispatchScratchpadKey(row.id)),
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
      loadEngineConfig: this.host.deps.loadEngineConfig,
      peekModels: peekPiModels,
      ...(this.host.deps.makeJudgeTransport
        ? { makeTransport: this.host.deps.makeJudgeTransport }
        : {})
    })

    const gateHandler: PiBridgeHandler = (payload) => this.gatePiTargetToolCall(entry, payload)

    // The runner streams the target's live turn output as engine-neutral
    // subagent events under the CURRENT dispatching tool_use (both read live:
    // `entry.ctx` is replaced on every continuation), byte-matching
    // `forwardClaudeTargetMessage`'s / `handleOpencodeTargetStream`'s payload
    // shapes, and accumulates the turn's tokens even with no tool_use to
    // stream to (see `PiChildRunner`'s output handler).
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
          skills: buildPiSkillDescriptors(resolveClaudeSkillCatalog(cwd)),
          ...piTargetSpawnFlags(
            dispatchPiSessionDir(row.id),
            harnessId,
            entry.handBack,
            entry.canMessage,
            entry.scratchpad?.dir
          )
        },
        ownerToolUseId: () => entry.ctx.toolUseId,
        emit: () => entry.ctx.emit,
        exitMessage: 'pi target process exited unexpectedly',
        logTag: 'CrossEngineDispatcher',
        now: () => this.host.now()
      })
    } catch (err) {
      // A new target that never started is over; a resume that failed to start is retried.
      if (!resume) this.host.ledgerSet(row.id, { state: 'failed' })
      throw err
    }
    entry.sessionId = entry.runner.sessionId
    // The model continues this target by the id pi reports; the row answers to it.
    if (entry.sessionId !== harnessId) this.host.ledgerSet(row.id, { harnessRef: entry.sessionId })
    this.host.targets.set(entry.sessionId, entry)
    return entry
  }

  /** A pi target's `hand_back` call as its bridge host answers it (the one hosted tool a target has). */
  private piHandBackResult(
    entry: PiTargetEntry,
    input: Record<string, unknown>,
    toolCallId: string
  ): PiHostedToolResult {
    const answer = this.host.receiveHandBack(entry, input.report, toolCallId)
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
   * With pi's judge disabled, auto/full read the `default` base over the same rules
   * (H2): the target's asks are forwarded to the human, not allowed.
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
  private gatePiTargetToolCall(
    entry: PiTargetEntry,
    payload: PiToolCallPayload
  ): Promise<GateDecision> {
    // Path containment's bookends (pi/pi-path-scope.ts), as on PiSession: an allowed path-tool
    // call is pinned to the path that was gated, and one that sat on a forwarded human approval is
    // re-checked afterwards.
    return withPathGuard(payload.toolName, payload.input, this.piTargetPathScope(entry), () =>
      this.gatePiTargetToolCallLadder(entry, payload)
    )
  }

  /**
   * The rules the pi target's judge reads its environment from: `targetRules`, plus the target's
   * own scratchpad listed with the directories (as `PiSession.classifierEnvironment` does for a
   * session): the file tools may use it without a prompt, so the judge must not read a write
   * there as outside the granted directories.
   */
  private piTargetJudgeRules(entry: PiTargetEntry): MergedClaudeRules {
    const rules = this.host.targetRules(
      entry.cwd,
      entry.ctx.cwd,
      entry.ctx.callerRestriction,
      entry.ctx.originCwd
    )
    const scratchpad = entry.scratchpad?.dir
    return scratchpad
      ? { ...rules, additionalDirectories: [...rules.additionalDirectories, scratchpad] }
      : rules
  }

  /** The target's workspace for path containment: its cwd + `targetRules`' scope (the user's additional directories, the dispatching session's directory). */
  private piTargetPathScope(entry: PiTargetEntry): PiPathScope {
    return buildPiPathScope({
      cwd: entry.cwd,
      rules: this.host.targetRules(
        entry.cwd,
        entry.ctx.cwd,
        entry.ctx.callerRestriction,
        entry.ctx.originCwd
      ),
      scratchpad: entry.scratchpad?.dir,
      projectTemp: entry.scratchpad?.projectTemp
    })
  }

  private async gatePiTargetToolCallLadder(
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
        this.host.targetRules(
          entry.cwd,
          entry.ctx.cwd,
          entry.ctx.callerRestriction,
          entry.ctx.originCwd
        ),
        entry.cwd
      )
      if (denied) return { behavior: 'deny', reason: `Denied by permission rule: ${denied}` }
      if (!auto) return { behavior: 'allow' }
    }
    // The ladder gets the parent's live mode and whether the target's judge is on, and derives
    // the base from the pair: judged auto -> `acceptEdits` (its asks go to the judge below);
    // judge off -> the `default` base over the target's own rules (`allow: []` stays: a
    // target never inherits what the user pre-approved), so a bash call is a forwarded ask
    // and not the old allow-everything base (H2).
    const verdict = decideWithSource(payload.toolName, payload.input, {
      mode,
      judge: auto,
      rules: this.host.targetRules(
        entry.cwd,
        entry.ctx.cwd,
        entry.ctx.callerRestriction,
        entry.ctx.originCwd
      ),
      sessionAllows: EMPTY_PI_SESSION_ALLOWS,
      scope: this.piTargetPathScope(entry),
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
            : verdict.source === 'path-scope' && verdict.message
              ? verdict.message
              : 'Denied by dispatch autonomy mode'
      }
    }

    // A human-only ask from the containment rung: the dispatching user decides, in every mode (the
    // judge never sees it).
    if (verdict.source === 'path-scope') {
      return this.forwardPiTargetAsk(entry, payload, verdict.message)
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
          this.host.targets.get(entry.sessionId) === entry,
        honoursWorkdir: false,
        permissions: () => this.piTargetJudgeRules(entry)
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
      this.host.targets.get(entry.sessionId) !== entry
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
        ? this.host.armForwardedHold(requestId, entry.ctx, entry.judge, payload.toolCallId, block)
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
      this.host.pendingApprovals.set(requestId, {
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
}
