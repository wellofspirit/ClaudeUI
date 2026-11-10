/**
 * opencode dispatch targets: an opencode session on a turn-running lease of the server manager, followed on the shared event feed.
 * Split out of `cross-engine-dispatcher.ts`; the core is reached through `DispatchTargetHost`.
 */
import { v4 as uuidv4 } from 'uuid'
import type { ServerConnection } from '../opencode/OpencodeServerManager'
import { isOpencodeApiError, type PermissionReply } from '../opencode/OpencodeClient'
import type { Agent_Info } from '../opencode/protocol-v2/openapi'
import {
  eventSessionID,
  type OpencodeEvent as OpencodeV2Event
} from '../opencode/protocol-v2/events'
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
  WORKTREE_TOOLS_DENY_RULES,
  wireOrder,
  type V2Rule
} from '../opencode/permission-v2'
import { ChildRulesetKeeper } from '../opencode/child-rulesets'
import { resolveOpencodeOwnDirAllows } from '../opencode/own-dirs'
import {
  locationWorktree,
  stopOpencodeSessions,
  TEARDOWN_GRACE_MS
} from '../opencode/session-support'
import { hostPrecheck, type HostPrecheckContext } from '../opencode/host-precheck'
import { type CallerRestriction } from '../opencode/caller-restriction'
import { OpencodeSessionAllows } from '../opencode/session-allows'
import { opencodeAuthHooks } from '../opencode/opencode-auth-hooks'
import { collectClaudeMcpForOpencode } from '../opencode/claude-mcp-bridge'
import { parseModelString, peekOpencodeModels } from '../opencode/model-discovery'
import { editClearsAgentControl } from '../opencode/agent-control-gate'
import { DispatchTargetJudge } from './dispatch-target-judge'
import { blockHoldMs } from '../automode/block-hold'
import { collectToolUseIds, recordTrajectoryMessage } from '../automode/trajectory'
import type { ItemStreamOpen, ItemStreamSeal, ItemStreamTarget } from '../shared/sync/item-stream'
import { PLAN_MODE_DENY_REASON_NO_EXIT_TOOL } from '../pi/permission-engine'
import { opencodeMessageCosts } from '../opencode/message-cost'
import { logger } from './logger'
import type { UsageTurnTokens } from './usage-recorder'
import { opencodeAuthProvider } from '../auth/OpencodeAuthProvider'
import { OPENCODE_DISPATCH_SESSION_TITLE } from '../../shared/dispatch-session'
import { type DispatchTargetRow, type DispatchTargetState } from './dispatch-target-ledger'
import { sessionToolsAvailable } from './session-tools'
import { X_AGENT_MESSAGE_TOOL } from '../../shared/x-agent-message'
import { SESSION_TOOL_NAMES } from '../../shared/session-tools-description'
import { HAND_BACK_TOOL } from '../../shared/dispatch-agent-description'
import { type RunContext } from './dispatch-parent'
import type { ChatMessage, PendingApproval } from '../../shared/types'
import { XENG_REQUEST_PREFIX } from './dispatch-target-types'
import type {
  DispatchRequest,
  FreshLaunch,
  DispatchResult,
  DispatchTargetClient,
  DispatchTurnAccount,
  TargetRuleInputs,
  OpencodeTargetEntry,
  OpencodeTurnOutcome,
  ConnRecord,
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
  replyTargetPermission,
  errText,
  canonicalDispatchModel,
  cannotCountNote,
  emitDispatchNotification
} from './dispatch-target-shared'
import type { DispatchTargetHost } from './dispatch-target-host'

const OPENCODE_TIMEOUT_AFTERMATH = 'the target agent was aborted.'

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

/** An opencode target's account, off opencode's credential snapshot and auth probe. */
function opencodeDispatchAccount(model: string): DispatchTurnAccount {
  const { providerID } = parseModelString(model)
  return {
    ...opencodeAuthProvider.accountIdentity(providerID),
    billingType: opencodeAuthProvider.buildAccountRef(providerID)?.billingType ?? 'unknown'
  }
}

export class OpencodeTargets {
  private readonly host: DispatchTargetHost
  /** opencode feed records, keyed by SERVER (`serverKey`), never by cwd. */
  private connections = new Map<string, ConnRecord>()
  /** Target sessions to delete once a server is reachable (lost with theirs). */
  private orphanSessions = new Set<string>()

  constructor(host: DispatchTargetHost) {
    this.host = host
  }

  /**
   * After a `hand_back` call on an opencode target: how long to leave the turn
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
          timer = setTimeout(() => resolve('ceiling'), this.host.handBackSettleMs)
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
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
  async resolveAndRunOpencode(
    req: DispatchRequest,
    ctx: RunContext,
    stopController: AbortController
  ): Promise<DispatchResult> {
    // ── Model resolution ──────────────────────────────────────────────────
    const dispatchCfg = this.host.deps.loadEngineConfig(req.engine).dispatch
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
      const cont = this.host.findContinuation(req.sessionId, ctx, 'opencode')
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
      const spent = this.host.continuationSpend(cont, dispatchCfg, req.sessionId, 'opencode')
      if ('text' in spent) return spent
      if ('row' in cont) {
        const refusal = this.host.resumeModelRefusal('opencode', cont.row.model, dispatchCfg)
        if (refusal) return refusal
      }
      this.host.bindContinuation(ctx, cont)
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
            this.host.ledgerSet(cont.row.id, { state: 'failed' })
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
    this.host.ledgerTurnState(entry, 'running')
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
      return await this.host.runWithNudges(
        ctx,
        {
          sessionId: () => entry.sessionId,
          engine: 'opencode',
          toolName: `${CLAUDEUI_MCP_SERVER}_${HAND_BACK_TOOL}`,
          cumulativeCostUsd: () => entry.cumulativeCostUsd
        },
        this.host.taskText(entry, ctx, req.prompt, `${CLAUDEUI_MCP_SERVER}_${HAND_BACK_TOOL}`),
        (prompt, nudge) => {
          if (nudge) {
            // The turn before it released the target: a nudge is a turn of the same run.
            entry.busy = true
            this.host.ledgerTurnState(entry, 'running')
          }
          return this.runOpencodeTurn(entry, req, ctx, model, stopController, prompt as string)
        }
      )
    } finally {
      if (!started) {
        entry.busy = false
        this.host.ledgerTurnState(entry, 'idle')
      }
    }
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
    const dispatchCfg = this.host.deps.loadEngineConfig(req.engine).dispatch
    const heartbeat = this.host.startHeartbeat(ctx)

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
    const turnStartedAt = this.host.now()
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
        text: prompt,
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
    const watchdog = this.host.startTurnWatchdog(entry, caps, turnStartedAt, () =>
      this.host.hasPendingApprovalFor(entry.sessionId)
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
        this.host.safeRecordUsage({
          ts: this.host.now(),
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
        this.host.dismissPendingForTarget(entry.sessionId)
      } else if (winner.kind === 'stop' || winner.kind === 'timeout' || winner.kind === 'abort') {
        // The session survives for a continuation; only this turn is
        // interrupted. Drop the resolver FIRST: the interrupt's own
        // `stopped` output must find nothing to settle.
        entry.settled = null
        entry.draining = true
        void this.stopTargetTurn(entry, entry.pendingPrompt)
        this.host.dismissPendingForTarget(entry.sessionId)
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
        this.host.dismissPendingForTarget(entry.sessionId)
        const msg = errText(winner.err)
        account(true)
        emitDispatchNotification(ctx, entry.sessionId, 'failed', `Dispatched turn failed: ${msg}`)
        return errorResult(`Dispatched turn failed: ${msg}`, entry.sessionId)
      }

      if (winner.kind === 'failed') {
        endState = 'failed'
        // The turn RAN and failed server-side; it already ended (no interrupt).
        // Its spend still counts toward the cap and the breakdown.
        this.host.dismissPendingForTarget(entry.sessionId)
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
      await this.host.settleReview(ctx.run)
      return this.host.finishTurn(ctx, 'opencode', model, entry, entry.sessionId, {
        finalText,
        outText,
        usage: {
          totalTokens: usage.totalTokens,
          toolUses: entry.turnToolUseIds.size,
          durationMs: this.host.now() - turnStartedAt
        }
      })
    } finally {
      this.sealOpencodeTargetItems(entry)
      entry.reportToolDone = null
      entry.busy = false
      this.host.ledgerTurnState(entry, endState)
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
    fresh?: FreshLaunch
  ): Promise<OpencodeTargetEntry> {
    // A dispose of the dispatching chat while this target is being created
    // disposes the new target too.
    const generation = this.host.disposals.get(this.host.runs.parentOf(ctx.fromRoutingId)) ?? 0
    // A resumed target runs where it was created (ADR-105): the stored directory.
    const cwd = targetCwd(ctx, resume, fresh)
    const conn = await this.host.deps.serverManager.acquire(cwd)
    let rec: ConnRecord | null = null
    let client: DispatchTargetClient | null = null
    let createdId: string | null = null
    try {
      client = this.host.deps.makeClient(conn)
      rec = this.connectionFor(conn, client)
      rec.creating++
      const inputs: TargetRuleInputs = {
        client,
        cwd,
        parentCwd: ctx.cwd,
        ...(ctx.originCwd ? { originCwd: ctx.originCwd } : {}),
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
        loadEngineConfig: this.host.deps.loadEngineConfig,
        peekModels: peekOpencodeModels,
        ...(this.host.deps.makeJudgeTransport
          ? { makeTransport: this.host.deps.makeJudgeTransport }
          : {})
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
        (this.host.disposals.get(this.host.runs.parentOf(ctx.fromRoutingId)) ?? 0) !== generation
      )
        throw new Error('the dispatching session was disposed')
      const targetClient = client
      // The durable record (ADR-105): written once the session is known to be ours
      // to keep — after the checks above, whose rollback deletes it instead.
      const ledgerId =
        resume?.id ??
        this.host.recordTarget(ctx, {
          engine: 'opencode',
          harnessRef: session.id,
          cwd,
          model,
          accountKey: opencodeDispatchAccount(model).accountKey,
          fresh,
          handBack: this.host.requireHandBack
        }).id
      const entry: OpencodeTargetEntry = {
        kind: 'opencode',
        reportToolIds: new Set(),
        reportToolDone: null,
        sessionId: session.id,
        ledgerId,
        released: false,
        handBack: this.host.requireHandBack,
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
      this.host.targets.set(session.id, entry)
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
      void rollback.finally(() => this.host.deps.serverManager.releaseIfCurrent(cwd, conn))
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
    rec.unsubscribeExit = this.host.deps.serverManager.subscribeExit(
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
      if (this.host.targets.get(entry.sessionId) === entry)
        this.host.targets.delete(entry.sessionId)
      this.host.dismissPendingForTarget(entry.sessionId)
      entry.released = true
      this.host.ledgerSet(entry.ledgerId, { state: entry.busy ? 'interrupted' : 'idle' })
      const settle = entry.settled
      entry.settled = null
      settle?.({ kind: 'failed', message: reason })
      logger.warn('CrossEngineDispatcher', `opencode target ${entry.sessionId} dropped: ${reason}`)
      // A server still up (only its feed was lost) must not run on unwatched;
      // against a dead one the requests fail at once.
      entry.draining = true
      void this.stopTargetTurn(entry, entry.pendingPrompt).finally(() =>
        this.host.deps.serverManager.releaseIfCurrent(entry.cwd, entry.conn)
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
  teardownOpencodeTarget(entry: OpencodeTargetEntry): void {
    entry.rec.targets.delete(entry)
    this.releaseRecord(entry.rec)
    entry.draining = true
    void this.stopTargetTurn(entry, entry.pendingPrompt).finally(() =>
      this.host.deps.serverManager.releaseIfCurrent(entry.cwd, entry.conn)
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
   * `buildSessionRuleset` over the user's deny/ask rules and the target's scope
   * (`targetRules`: its additional directories compile to `external_directory`
   * allows; ADR-085 §3, ADR-033: never their allow rules), then
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
      permissions: this.host.targetRules(
        inputs.cwd,
        inputs.parentCwd,
        restriction,
        inputs.originCwd
      ),
      mcpServers,
      cwd: inputs.cwd,
      ...(worktree ? { worktree } : {}),
      externalDirAllows,
      // The dispatch target is who `claudeui_hand_back` is for: it gets the allow in every
      // mode (auto's classifier and the asking modes must never put the report behind an
      // approval) instead of the deny every other session of the server has.
      handBackTarget: this.host.requireHandBack
    })
    const first = agents?.[0]
    const defaultAgent = first && first.mode !== 'subagent' ? first.id : undefined
    return {
      rules: wireOrder([
        ...built.rules,
        TARGET_DISPATCH_DENY,
        ...WORKTREE_TOOLS_DENY_RULES,
        ...targetSessionToolRules(canMessage, autoMode),
        TARGET_QUESTION_DENY,
        ...(this.host.requireHandBack ? [HAND_BACK_ALLOW_RULE] : [])
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
    // The ctx is replaced on every continuation: the parent's rules are the latest one's.
    entry.parentCwd = entry.ctx.cwd
    if (entry.ctx.originCwd) entry.originCwd = entry.ctx.originCwd
    else delete entry.originCwd
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
    this.host.safeRecordUsage({
      ts: this.host.now(),
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
   * (cached; an `/api/info` failure is not). The only other allows under the ask
   * are the ones compiled from the target's scope (`targetRules`, ADR-108 as amended).
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
        entry.lastActivityAt = this.host.now()
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
        else if (this.host.hasStraySteers(entry.ledgerId)) {
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
          this.host.noteSteerConsumed(o.inboxID)
        }
        return
      case 'user-message':
        this.markTurnDelivered(entry, o.inboxID)
        this.host.noteSteerConsumed(o.inboxID)
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
        const pending = this.host.takePendingApproval(key)
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

  /** The host pre-check over a target: the user's deny/ask tiers and the target's scope, no allows. */
  private targetPrecheckContext(entry: OpencodeTargetEntry): HostPrecheckContext {
    const rules = this.host.targetRules(
      entry.cwd,
      entry.ctx.cwd,
      entry.ctx.callerRestriction,
      entry.ctx.originCwd
    )
    return {
      mode: liveMode(entry.ctx),
      rules: { deny: rules.deny, ask: rules.ask, allow: [] },
      userRules: entry.hostRules,
      sessionAllows: NO_SESSION_ALLOWS,
      cwd: entry.cwd,
      // The target's scope (`targetRules`): what the user listed plus the parent's directory.
      additionalDirectories: rules.additionalDirectories,
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
      ? this.host.armForwardedHold(
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
    this.host.pendingApprovals.set(requestId, {
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
          stillPending: () =>
            entry.judging.has(id) && this.host.targets.get(entry.sessionId) === entry,
          honoursWorkdir: true,
          ...(typeof input.command === 'string' ? {} : { skipReadOnlyGate: true }),
          permissions: () =>
            this.host.targetRules(
              entry.cwd,
              entry.ctx.cwd,
              entry.ctx.callerRestriction,
              entry.ctx.originCwd
            )
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
  sealOpencodeTargetItems(entry: OpencodeTargetEntry): void {
    for (const { target, message } of entry.openItems.values())
      entry.ctx.emit('session:item-seal', {
        target,
        message,
        ownerToolUseId: target.ownerToolUseId
      })
    entry.openItems.clear()
  }
}
