/**
 * Claude Code dispatch targets: a raw `sdkQuery()` kept alive across turns, driven by a manual iterator loop.
 * Split out of `cross-engine-dispatcher.ts`; the core is reached through `DispatchTargetHost`.
 */
import { v4 as uuidv4 } from 'uuid'
import { denyAskHit } from '../permissions/shell-rules'
import { isShellToolName } from '../automode/shell-lexical'
import { existingDirectories } from './additional-directories'
import { collectToolUseIds } from '../automode/trajectory'
import { claudeSpawnPrep } from '../providers/claude-spawn-prep'
import { claudeBehaviorSettings, claudeSandboxOption } from '../sdk/args'
import { loadEngineConfig } from './ui-config'
import { appSetting } from './app-settings'
import { cachedClaudeModels } from './claude-model-cache'
import { transformAssistantMessage } from './assistant-message'
import { claudeToolResults, claudeUsageTokens } from './claude-transcript'
import { ClaudeItemStreamLifecycle, streamEventParent } from './claude-item-stream'
import { modelFallbackText, retractedMessageIds, retractionKey } from './claude-model-fallback'
import {
  claudeThinkingRequest,
  resolveAutomationEffort,
  type EffortLevel
} from '../../shared/model-capabilities'
import { query as sdkQuery } from '../sdk'
import { ensureHostTokenFresh } from '../sdk/host-token'
import type {
  CanUseTool,
  CanUseToolContext,
  CanUseToolResult,
  PermissionMode,
  QueryHandle,
  ResultMessage,
  SDKMessage,
  SystemMessage
} from '../sdk'
import { logger } from './logger'
import type { UsageTurnTokens } from './usage-recorder'
import { usageFetcher } from './usage-fetcher'
import { activeClaudeAttribution } from './usage-windows'
import { buildClaudeAccountRef } from '../host'
import { type DispatchTargetState } from './dispatch-target-ledger'
import { locateClaudeTranscript } from './claude-transcript-locator'
import {
  CLAUDE_HAND_BACK_TOOL,
  createHandBackServer,
  HAND_BACK_SERVER_NAME
} from './dispatch-hand-back-server'
import {
  handBackReviewOf,
  handBackReviewOfAsk,
  readPermissionDecisionFrame
} from './claude-permission-decision'
import { ToolUseOwners } from './tool-use-owners'
import { sessionToolsAvailable } from './session-tools'
import {
  createSessionToolsServer,
  SESSION_TOOLS_PREFIX,
  SESSION_TOOLS_SERVER_NAME
} from './session-tools-server'
import { X_AGENT_MESSAGE_TOOL } from '../../shared/x-agent-message'
import { isHandbackPointerResult } from './task-notification-xml'
import {
  HAND_BACK_SUBAGENT_TEXT,
  HAND_BACK_UNATTRIBUTED_TEXT
} from '../../shared/dispatch-agent-description'
import { type RunContext } from './dispatch-parent'
import type { ChatMessage, PendingApproval, SandboxSettings } from '../../shared/types'
import { XENG_REQUEST_PREFIX } from './dispatch-target-types'
import type {
  DispatchRequest,
  DispatchResult,
  ClaudeQuerySpawnOpts,
  SpawnClaudeQueryFn,
  DispatchTurnAccount,
  TurnTimeout,
  ClaudeTargetEntry,
  TurnReturn
} from './dispatch-target-types'
import {
  targetCwd,
  liveMode,
  resolveTurnLiveness,
  turnTimeoutText,
  errorResult,
  errText,
  emitDispatchNotification,
  settledWithin,
  ClaudeInputChannel,
  buildClaudeDispatchMessage
} from './dispatch-target-shared'
import type { DispatchTargetHost } from './dispatch-target-host'

/** Aftermath clauses for `turnTimeoutText`, per direction. Claude targets die
 *  with their process; opencode/pi targets survive for a continuation. */
const CLAUDE_TIMEOUT_AFTERMATH = 'the target agent was aborted.'

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

/** See {@link DispatcherDeps.ownWorkWaitMs}. */
const OWN_WORK_WAIT_MS = 30 * 60_000

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
 * The `sandbox` option a Claude target is spawned with (ADR-116): the Claude engine's sandbox
 * settings through the mapping a session uses (`claudeSandboxOption`), except that sandboxed
 * commands are never auto-approved. A session's auto-approve would take a target's Bash away
 * from everything that gates it: the forwarded card, cli.js's classifier in auto, and the
 * host's deny/ask matcher in `awaitClaudeTargetApproval` (ADR-085). cli.js also suspends the
 * auto-approve in plan mode, which a target never runs in (`plan` maps to `default` above), so
 * a plan-mode parent's target would run commands a plan-mode session asks about. Sent as an
 * explicit `false`: cli.js reads an absent key as true. `undefined` when the sandbox is off.
 */
export function claudeTargetSandbox(
  config: SandboxSettings | null | undefined
): Record<string, unknown> | undefined {
  const sandbox = claudeSandboxOption(config)
  return sandbox && { ...sandbox, autoAllowBashIfSandboxed: false }
}

/**
 * Real default for `DispatcherDeps.claudeTargetEffort` (ADR-116): the effort a NEW Claude
 * session gets for `model` with no pick of its own, by the sessions' ladder for a headless
 * Claude run (`resolveAutomationEffort`, which an automation run uses too): the user's saved
 * starting effort for the model, else the model's default, clamped to the levels it accepts.
 *
 * `undefined` sends no `--effort`, so cli.js uses its own default: when the model takes no
 * effort, and when it cannot be judged. `default` names no model by itself, so until the
 * catalog cli.js reported has its row, neither its saved effort nor its default is knowable,
 * and a guess would replace cli.js's own answer with a worse one. The catalog is the cached
 * one: no wait and no cli.js spawn on the dispatch path. Never throws: a failure to resolve
 * an effort must not fail a dispatch.
 */
export function defaultClaudeTargetEffort(model: string): EffortLevel | undefined {
  try {
    const catalog = cachedClaudeModels()
    if (model === 'default' && !catalog.some((row) => row.value === model)) return undefined
    return (
      resolveAutomationEffort({
        explicit: undefined,
        modelValue: model,
        catalog,
        modelEffortDefaults: appSetting('modelEffortDefaults')
      }) ?? undefined
    )
  } catch (err) {
    logger.warn(
      'CrossEngineDispatcher',
      `claude target: starting effort not resolved (${errText(err)})`
    )
    return undefined
  }
}

/** How much of a target process's stderr a failure quotes: its last lines, each cut short. */
const CLAUDE_STDERR_TAIL_LINES = 12
const CLAUDE_STDERR_LINE_CHARS = 400

/**
 * Real default for `DispatcherDeps.spawnClaudeQuery`. Duplicates
 * `getSdkExecutableOpts()` (claude-session.ts) inline rather than importing
 * it — claude-session.ts imports cross-engine-dispatcher.ts, which imports
 * THIS module, so importing back would form a require-cycle. Like it,
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
      ...(opts.additionalDirectories?.length
        ? { additionalDirectories: opts.additionalDirectories }
        : {}),
      ...(opts.mcpServers ? { mcpServers: opts.mcpServers } : {}),
      ...(opts.allowedTools ? { allowedTools: opts.allowedTools } : {}),
      ...(opts.onInboundFrame ? { onInboundFrame: opts.onInboundFrame } : {}),
      ...(opts.thinking ? { thinking: opts.thinking } : {}),
      // ADR-116: `buildArgs` folds `sandbox` into the one `--settings` JSON beside `settings`
      // and requires the sandbox to start (`failIfUnavailable`), as it does for a session.
      ...(opts.sandbox ? { sandbox: opts.sandbox } : {}),
      ...(opts.effort ? { effort: opts.effort } : {}),
      ...(opts.stderr ? { stderr: opts.stderr } : {}),
      abortController: opts.abortController,
      canUseTool: opts.canUseTool,
      // ADR-033 M3: stream_event text/thinking deltas so driveClaudeTurn can
      // forward them as item open/delta/seal events under the dispatch TaskCard.
      includePartialMessages: true
    }
  })
}

export class ClaudeTargets {
  private readonly host: DispatchTargetHost
  private readonly spawnClaudeQuery: SpawnClaudeQueryFn
  private readonly claudeTargetEffort: (model: string) => EffortLevel | undefined
  private readonly locateTranscript: (sessionId: string, cwd: string) => string | null
  private readonly ownWorkWaitMs: number

  constructor(host: DispatchTargetHost) {
    this.host = host
    const deps = host.deps
    this.spawnClaudeQuery = deps.spawnClaudeQuery ?? defaultSpawnClaudeQuery
    this.claudeTargetEffort = deps.claudeTargetEffort ?? defaultClaudeTargetEffort
    this.locateTranscript = deps.locateClaudeTranscript ?? locateClaudeTranscript
    this.ownWorkWaitMs = deps.ownWorkWaitMs ?? OWN_WORK_WAIT_MS
  }

  // ── Claude direction (M2) ─────────────────────────────────────────────────

  /** Everything past the guards for engine:'claude' — runs with an
   *  a run slot held and the Stop handle already registered
   *  (the run, with its `stopController`, is registered in `launchRun`, BEFORE any
   *  await, so a Stop click during spawnClaudeQuery is not lost). */
  async resolveAndRunClaude(
    req: DispatchRequest,
    ctx: RunContext,
    stopController: AbortController
  ): Promise<DispatchResult> {
    // ── Model resolution ──────────────────────────────────────────────────
    const dispatchCfg = this.host.deps.loadEngineConfig('claude').dispatch
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
      const cont = this.host.findContinuation(req.sessionId, ctx, 'claude')
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
      const spent = this.host.continuationSpend(cont, dispatchCfg, req.sessionId, 'claude')
      if ('text' in spent) return spent
      const spentUsd = spent.costUsd
      if ('row' in cont) {
        const refusal = this.host.resumeModelRefusal('claude', cont.row.model, dispatchCfg)
        if (refusal) return refusal
      }
      if ('live' in cont) {
        this.host.bindContinuation(ctx, cont)
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
          this.host.ledgerSet(row.id, { state: 'failed' })
          return errorResult(
            `Dispatch session "${req.sessionId}" cannot be resumed — its transcript no longer exists. ` +
              'Start a new X-Agent with dispatch_agent.',
            req.sessionId
          )
        }
        model = row.model
        const account = claudeDispatchAccount()
        this.host.bindContinuation(ctx, cont)
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
        this.host.ledgerSet(row.id, { accountKey: account.accountKey })
      }
    } else {
      // The harness id is minted HERE and the ledger row written BEFORE the spawn: the
      // transcript is hidden (ADR-105) from its first byte, so no watcher pass can
      // read it before the readers know to skip it.
      const harnessId = uuidv4()
      const account = claudeDispatchAccount()
      let ledgerId: string | null = null
      try {
        const cwd = targetCwd(ctx, undefined, req)
        ledgerId = this.host.recordTarget(ctx, {
          engine: 'claude',
          harnessRef: harnessId,
          cwd,
          model,
          accountKey: account.accountKey,
          fresh: req,
          handBack: this.host.requireHandBack
        }).id
        const shell = this.createClaudeTargetShell(ctx, ledgerId, account, cwd)
        entry = shell.entry
        await this.spawnClaudeTarget(shell, ctx, model, cwd, { sessionId: harnessId })
      } catch (err) {
        if (ledgerId) this.host.ledgerSet(ledgerId, { state: 'failed' })
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
      this.host.ledgerTurnState(entry, 'running')
      // Per-turn distinct tool_use id set (ADR-033 M4-B) — fresh at the start of
      // every turn, populated by forwardClaudeTargetMessage, .size read at turn end.
      entry.turnToolUseIds = new Set()
      const turnStartedAt = this.host.now()
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
      const heartbeat = this.host.startHeartbeat(ctx)

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
          ? { wake: true, deadlineAt: this.host.now() + this.ownWorkWaitMs }
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
      const watchdog = this.host.startTurnWatchdog(entry, caps, turnStartedAt, () =>
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
            this.host.dismissPendingForTarget(entry.sessionId)
            this.host.targets.delete(entry.sessionId)
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
            this.host.safeRecordUsage({
              ts: this.host.now(),
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
            this.host.dismissPendingForTarget(entry.sessionId)
            this.host.targets.delete(entry.sessionId)
          }
          const msg = winner.err instanceof Error ? winner.err.message : String(winner.err)
          emitDispatchNotification(
            ctx,
            entry.sessionId ?? '',
            'failed',
            `Dispatched turn failed: ${msg}`
          )
          this.host.safeRecordUsage({
            ts: this.host.now(),
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
        //
        // The LEDGER's split (ADR-071 §1). Anthropic's `usage` is disjoint —
        // `input_tokens` already excludes both cache figures — so the fields map
        // straight onto the ledger's shape. `totalTokens` below deliberately
        // stays input+output: it is what the task notification shows.
        //
        // `cache_creation.ephemeral_1h_input_tokens` is the 1h-TTL SUBSET of
        // `cache_creation_input_tokens`, billed at 2× input rather than 1.25×;
        // block-usage reads it off the transcripts for exactly this reason, and
        // dropping it here would underprice every dispatched Claude turn that
        // used the 1h cache. An older cli.js omits the breakdown, which the
        // recorder reads as all-5m — the same fallback block-usage makes.
        const turnTokens: UsageTurnTokens = claudeUsageTokens(result.usage)
        const totalTokens = turnTokens.input + turnTokens.output
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
          this.host.safeRecordUsage({
            ts: this.host.now(),
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

        await this.host.settleReview(ctx.run)
        const done = this.host.finishTurn(ctx, 'claude', model, entry, entry.sessionId ?? '', {
          finalText,
          outText,
          usage: {
            totalTokens,
            toolUses: entry.turnToolUseIds.size,
            durationMs: durationMs ?? 0
          }
        })
        this.host.safeRecordUsage({
          ts: this.host.now(),
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
        engine: 'claude',
        toolName: CLAUDE_HAND_BACK_TOOL,
        cumulativeCostUsd: () => entry.cumulativeCostUsd,
        waitingOnOwnWork: () => this.claudeWaitsOnOwnWork(entry)
      },
      this.host.taskText(entry, ctx, req.prompt, CLAUDE_HAND_BACK_TOOL),
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
            : await settledWithin(pending, Math.max(0, opts.deadlineAt - this.host.now()))
      } catch (err) {
        entry.nextFrame = null
        throw this.claudeProcessFailure(entry, err)
      }
      if (read === undefined) return null
      entry.nextFrame = null
      const { value, done } = read
      if (done) {
        throw this.claudeProcessFailure(
          entry,
          new Error('Claude target process ended unexpectedly')
        )
      }
      const msg = value as SDKMessage
      // Proof of life for the inactivity watchdog — EVERY message counts,
      // `stream_event` deltas included (see ClaudeTargetEntry.lastActivityAt).
      entry.lastActivityAt = this.host.now()
      if (msg.session_id && !entry.sessionId) {
        entry.sessionId = msg.session_id
        this.host.targets.set(msg.session_id, entry)
        // The model continues this target by the id it is told — init's. The row is
        // looked up by it, so it must answer to it (it already does when cli.js
        // honoured `--session-id` / `--resume`, which it does).
        try {
          if (this.host.ledger.get(entry.ledgerId)?.harnessRef !== msg.session_id)
            this.host.ledgerSet(entry.ledgerId, { harnessRef: msg.session_id })
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
   * Keep the last lines the target's process wrote to stderr, and log them (a session logs its
   * own). Nothing else records them: the run reads the process through its stdout frames.
   */
  private noteClaudeStderr(entry: ClaudeTargetEntry, chunk: Buffer): void {
    for (const raw of chunk.toString().split('\n')) {
      const line = raw.trim()
      if (!line) continue
      // The voice patch's own chatter, as `ClaudeSession` files it.
      if (line.includes('[Voice:Patch]')) {
        logger.debug('Voice', line)
        continue
      }
      logger.warn('CrossEngineDispatcher', `claude target ${entry.ledgerId} stderr: ${line}`)
      entry.stderrTail.push(line.slice(0, CLAUDE_STDERR_LINE_CHARS))
    }
    if (entry.stderrTail.length > CLAUDE_STDERR_TAIL_LINES)
      entry.stderrTail.splice(0, entry.stderrTail.length - CLAUDE_STDERR_TAIL_LINES)
  }

  /**
   * The error of a target whose process died, with what it last wrote to stderr. cli.js says
   * why it refused to start only there (a required sandbox that cannot run on this machine,
   * ADR-116), and without it the run reports a bare exit code.
   */
  private claudeProcessFailure(entry: ClaudeTargetEntry, err: unknown): Error {
    if (entry.stderrTail.length === 0) return err instanceof Error ? err : new Error(errText(err))
    return new Error(`${errText(err)}\nClaude Code stderr:\n${entry.stderrTail.join('\n')}`)
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
    const cutoff = this.host.now() - this.ownWorkWaitMs
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
          entry.pendingWake.set(task.task_id!, this.host.now())
      }
      if (task.subtype === 'task_started') {
        if (CLAUDE_OWN_WORK_TASK_TYPES.has(task.task_type ?? '') && task.is_backgrounded !== false)
          entry.ownTasks.set(task.task_id, this.host.now())
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
    const answer = this.host.receiveHandBack(entry, report, frame.toolUseId, review)
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
        if (nativeOwner === undefined && typeof msg.uuid === 'string')
          entry.wireUuids.set(retractionKey(msg.uuid), chatMsg.id)
        if (entry.itemStreams.handleSnapshot(chatMsg, nativeOwner) === 'none')
          entry.ctx.emit('session:subagent-message', { toolUseId, message: chatMsg })
      }
      return
    }

    if (
      msg.type === 'system' &&
      (msg.subtype === 'model_refusal_fallback' || msg.subtype === 'model_fallback')
    ) {
      this.noteClaudeTargetFallback(entry, msg, toolUseId)
      return
    }

    if (msg.type === 'user') {
      // Tool-result mirror of claude-session.ts's extractToolResultsFromContent
      // (parentToolUseId branch) — cheap to forward alongside the message.
      const messageParam = (msg as { message?: { content?: unknown } }).message
      const content = messageParam?.content
      if (!Array.isArray(content)) return
      for (const r of claudeToolResults(content)) {
        entry.ctx.emit('session:subagent-tool-result', {
          toolUseId,
          toolResultToolUseId: r.toolUseId,
          result: r.text,
          isError: r.isError,
          ...(r.images ? { images: r.images } : {})
        })
      }
    }
  }

  /**
   * The target's Claude Code switched models (docs/protocol-cc/04-system-subtypes.md §4.20–4.21):
   * a refusal swaps it for the rest of its session, an availability error for the turn. A root
   * session says so in a warning (`ClaudeSession.handleModelFallback`); here it goes on the
   * card, as a notice in the target's transcript, so the user knows which model the X-Agent's
   * work came from. A refusal also takes the refused partial off the card first, scoped to this
   * card: the parent's own transcript and streams are not the target's.
   */
  private noteClaudeTargetFallback(
    entry: ClaudeTargetEntry,
    msg: SystemMessage,
    toolUseId: string
  ): void {
    logger.warn(
      'CrossEngineDispatcher',
      `target ${entry.ledgerId} ${msg.subtype}: ${msg.original_model} -> ${msg.fallback_model} (trigger=${msg.trigger})`
    )
    if (msg.subtype === 'model_refusal_fallback') {
      const messageIds = retractedMessageIds(msg, (key) => entry.wireUuids.get(key))
      entry.itemStreams.retract(messageIds)
      // Only what it names. cli.js has already closed the refused message's streams (§4.20
      // "Ordering"), so an empty list could only clear the card's OTHER live streams (the
      // target's own agents), and an older reducer would read it as "clear the parent's".
      if (messageIds.length > 0)
        entry.ctx.emit('session:messages-retracted', { messageIds, ownerToolUseId: toolUseId })
    }
    const notice: ChatMessage = {
      id: `notice-${typeof msg.uuid === 'string' && msg.uuid ? msg.uuid : uuidv4()}`,
      role: 'system',
      content: [{ type: 'notice', text: modelFallbackText(msg) }],
      timestamp: this.host.now()
    }
    entry.ctx.emit('session:subagent-message', { toolUseId, message: notice })
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
    const { deny, ask, additionalDirectories } = this.host.targetRules(
      cwd,
      ctx.cwd,
      ctx.callerRestriction,
      ctx.originCwd
    )
    const addDirs = existingDirectories(additionalDirectories, 'CrossEngineDispatcher')
    // The target is a cli.js of ours too, so it carries the Claude engine's two
    // behaviour switches (`engines/claude.json#claudeConfig`, read per spawn):
    // the same `--settings` object as the permission tiers below, never inside
    // them.
    const claudeConfig = this.host.deps.loadEngineConfig('claude')
    const behavior = claudeBehaviorSettings(claudeConfig.claudeConfig)
    // And the engine's sandbox and a new session's starting effort for the model (ADR-116),
    // both read here, per spawn: a target resumed after a setting changed runs under the
    // setting of the moment, as its `--settings` rules and `--add-dir` scope do.
    const sandbox = claudeTargetSandbox(claudeConfig.sandbox)
    const effort = this.claudeTargetEffort(model)
    entry.query = await this.spawnClaudeQuery({
      cwd,
      model,
      thinking: claudeThinkingRequest(model, 'adaptive'),
      ...(sandbox ? { sandbox } : {}),
      ...(effort ? { effort } : {}),
      stderr: (chunk) => this.noteClaudeStderr(entry, chunk),
      permissionMode: mode.permissionMode,
      allowDangerouslySkipPermissions: mode.allowDangerouslySkipPermissions,
      canUseTool: shell.canUseTool,
      abortController: entry.abortController,
      prompt: entry.channel,
      ...ids,
      settings: {
        ...behavior,
        ...(deny.length > 0 || ask.length > 0 ? { permissions: { deny, ask } } : {})
      },
      // The target's scope as `--add-dir` (ADR-108 as amended): cli.js loads no settings here.
      ...(addDirs.length > 0 ? { additionalDirectories: addDirs } : {}),
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
                      return this.host.receiveHandBack(entry, report, callId, asked)
                    })
                  }
                : {}),
              ...(entry.canMessage
                ? {
                    [SESSION_TOOLS_SERVER_NAME]: createSessionToolsServer({
                      xAgent: true,
                      getCaller: () => this.host.xAgentCaller(entry)
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
        this.host.noteSteerFrame(entry, frame)
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
      handBack: this.host.requireHandBack,
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
      stderrTail: [],
      interruptedReport: null,
      cumulativeCostUsd: 0,
      lastReportedTotalCostUsd: 0,
      lastActivityAt: 0,
      turnToolUseIds: new Set(),
      itemStreams: undefined as unknown as ClaudeItemStreamLifecycle,
      agentOrigins: new Map(),
      agentRunAliases: new Map(),
      wireUuids: new Map()
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
        this.host.targetRules(
          entry.cwd,
          entry.ctx.cwd,
          entry.ctx.callerRestriction,
          entry.ctx.originCwd
        )
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
      this.host.pendingApprovals.set(requestId, {
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
          if (!this.host.takePendingApproval(requestId)) return
          entry.ctx.emit('session:approval-dismiss', { requestId })
          resolve({ behavior: 'deny', message: 'Dispatch cancelled' })
        },
        { once: true }
      )
    })
  }
}
