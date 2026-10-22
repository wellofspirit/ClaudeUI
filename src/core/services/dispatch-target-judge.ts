/**
 * ClaudeUI's auto-mode judge for ONE pi or opencode dispatch target (ADR-088).
 *
 * A target spun off a parent in auto mode inherits auto mode (ruling 3) and is
 * JUDGED (ruling 1): pi and opencode targets by ClaudeUI's own judge (ruling 2
 * — Claude targets keep cli.js's, Codex targets Codex's `auto_review`). The
 * steps are the shared {@link runJudgePipeline} (ruling 4: no third copy); this
 * class only supplies a target's hooks and holds what is per TARGET — the
 * denial caps, the tool-outcome map, the memoized session-start git facts and
 * the one-per-target banners — exactly what each session holds per session.
 *
 * What the judge reads (ADR-088, owner ruling D1): the DISPATCHING session's
 * transcript — the human turns there are the only real authorisation — and
 * its still-queued user turns, with the target's OWN assistant trajectory (its
 * earlier calls, user-role messages removed: the dispatch prompts are
 * agent-authored, never the user's words), all merged in time order (ADR-091
 * §4), with the action headed as the `dispatch:<engine>` subagent's, carrying
 * the latest dispatch prompt.
 *
 * Imports no session class (the dispatcher's require-cycle rule): only the
 * automode leaves and type-only shared types.
 */
import { v4 as uuid } from 'uuid'
import { HAND_BACK_TOOL } from '../../shared/dispatch-agent-description'
import { X_AGENT_MESSAGE_TOOL } from '../../shared/x-agent-message'
import type { ReportReview } from '../../shared/handback-review'
import type {
  AutoModeConfig,
  ChatMessage,
  ClaudePermissions,
  EngineConfig,
  EngineModelGroup,
  SharedAutoModeConfig,
  ToolReviewBlock
} from '../../shared/types'
import type { ClassifierAction, EnvironmentInfo, JudgeTransport } from '../automode/classifier'
import {
  allowRuleReviewBlock,
  AutoModeDenialTracker,
  autoModeBlockReason,
  autoModeReviewBlock,
  readOnlyReviewBlock
} from '../automode/denial-tracker'
import { buildClassifierEnvironment } from '../automode/environment'
import {
  captureGitRemotes,
  captureRepoVisibility,
  recordToolOutcome,
  shellCommandOf,
  type GitRemote,
  type RepoVisibility,
  type ToolOutcome
} from '../automode/ground-truth'
import {
  runJudgePipeline,
  runJudgePipelineDetailed,
  type JudgePipelineAction,
  type JudgePipelineDetail,
  type JudgePipelineHooks,
  type JudgePipelineOutcome,
  type JudgePipelineReview,
  type JudgePipelineStage
} from '../automode/judge-pipeline'
import { captureShellActionMeta } from '../automode/action-meta'
import {
  judgeRouteUnavailableMessage,
  makeSessionJudgeTransport,
  type SessionJudgeOptions
} from '../automode/session-judge'
import { inTimeOrder } from '../automode/trajectory'
import { blockGrantKey, type BlockedCallLedger } from '../automode/blocked-calls'
import { RESULT_REPORT_MAX } from './dispatch-result-text'
import { loadSharedAutoModeConfig } from './ui-config'

// The trajectory helper moved to a leaf (`automode/trajectory.ts`, ADR-089) so
// `pi/pi-child-runner.ts` can record a child's trajectory without importing
// this module; re-exported for its existing importers.
export { recordTrajectoryMessage, TARGET_TRAJECTORY_MAX } from '../automode/trajectory'

export interface DispatchTargetJudgeOptions {
  /** The TARGET engine — which is also the judge engine (except for a Codex target's report review, below). */
  engine: 'opencode' | 'pi'
  /**
   * Whose `autoMode` block applies, when that is not the judge engine's: a Codex target has no
   * judge of its own, so its REPORT is reviewed through pi's route (`engine: 'pi'`, the ChatGPT
   * subscription) under the Codex engine's switches (ADR-105 §3, slice B-3c).
   */
  configEngine?: string
  /**
   * The judge model for every call, whatever `autoMode.judgeModel` says: a Codex target's own
   * model (no judge picker exists for Codex, and a model id of another engine's namespace would
   * not route). Read per call.
   */
  fixedModel?: () => string
  cwd: string
  /**
   * The DISPATCHING session's routing id (`fromRoutingId`) — judge usage rows land under it.
   * A thunk when the dispatcher can be re-keyed under a running target (ADR-105): read per call.
   */
  routingId: string | (() => string)
  /** The target's engine session id, read per call. */
  sessionId: () => string | null
  /** The target's model — the judge model when `autoMode.judgeModel` is unset. */
  model: () => string
  /** `entry.ctx.emit`, read live (the ctx is replaced on every continuation). */
  emit: () => (channel: string, data: unknown) => void
  /** `entry.ctx.getMessages()` — the dispatching session's transcript, read live. */
  messages: () => ChatMessage[]
  /**
   * The same transcript when it may have to be READ: a disconnected dispatching parent
   * has no transcript in memory (ADR-105), so the run's facade reads the engine's history.
   * Returns undefined for a plain call context — `messages()` then.
   */
  loadMessages?: () => Promise<ChatMessage[]> | undefined
  /** The dispatching session's still-queued user turns (ADR-091 §4), read live; omitted → none. */
  queuedTurns?: () => ChatMessage[]
  /**
   * `entry.ctx.blockedCalls` — the dispatching session's grants (ADR-091 part
   * 6), read live: an approved block of this exact call clears it once,
   * before the judge. Omitted / undefined → no grants.
   */
  blockedCalls?: () => BlockedCallLedger | undefined
  /** The target's own assistant trajectory (see {@link recordTrajectoryMessage}), read live. */
  trajectory: () => Iterable<ChatMessage>
  /** `{ type: 'dispatch:<engine>', description?, prompt }`, read live (the latest dispatch prompt). */
  subagent: () => ClassifierAction['subagent']
  /** `DispatcherDeps.loadEngineConfig` — the TARGET engine's `autoMode` block is read from it. */
  loadEngineConfig: (id: string) => EngineConfig
  /** Cache-only catalog peek for the stale-judge-model check (`peekOpencodeModels` / `peekPiModels`). */
  peekModels: () => EngineModelGroup[] | null
  /** Default {@link makeSessionJudgeTransport}; tests inject a scripted one. */
  makeTransport?: (opts: SessionJudgeOptions) => JudgeTransport
  /** Default {@link loadSharedAutoModeConfig}, read once. */
  loadSharedConfig?: () => SharedAutoModeConfig
}

export interface DispatchTargetJudgeCall {
  /** The dispatching session's live mode (`entry.ctx.getAutonomyMode()`). */
  currentMode: () => string
  /** False once the ask was answered elsewhere / the dispatch stopped → `settled`. */
  stillPending?: (stage: JudgePipelineStage) => boolean
  /** Whether the engine's shell honours `input.workdir` (opencode true, pi false). */
  honoursWorkdir: boolean
  /** The caller cannot vouch for the shell command's working directory → no read-only gate. */
  skipReadOnlyGate?: boolean
  /** The target's rules — the user's deny/ask tiers, allow empty (`userDenyAsk`). */
  permissions: () => Pick<ClaudePermissions, 'allow' | 'ask' | 'deny' | 'additionalDirectories'>
}

/** What {@link DispatchTargetJudge.reviewHandBack} needs of its caller. */
export interface HandBackReviewCall {
  /** The mode the report is judged under (auto mode left meanwhile: no verdict). */
  currentMode: () => string
  /** False once the run was stopped or abandoned: no verdict. */
  stillPending?: (stage: JudgePipelineStage) => boolean
  /** Aborts the in-flight judge request once nobody is waiting for the review any more. */
  signal?: AbortSignal
  permissions: () => Pick<ClaudePermissions, 'allow' | 'ask' | 'deny' | 'additionalDirectories'>
}

/**
 * The pipeline's detail as a report review (ADR-105 §3): a block is a block, an allow an allow,
 * and everything else (no route, a timeout, a transport error, a stale judge model, auto mode
 * left meanwhile, a reply that could not be read, a cancelled review) is "could not review".
 * `routeReason` is the route resolver's sentence when the judge model had no route.
 */
export function reviewFromPipeline(
  detail: JudgePipelineDetail,
  routeReason?: string
): ReportReview {
  switch (detail.kind) {
    case 'verdict':
      // Only an unparseable reply carries `raw`: no verdict, whatever its fail-closed `block` says.
      if (detail.result.raw !== undefined)
        return { kind: 'unavailable', why: "the reviewer's answer could not be read" }
      return detail.result.block
        ? { kind: 'block', reason: autoModeBlockReason(detail.result) }
        : { kind: 'allow' }
    case 'unavailable':
      if (detail.cause === 'model')
        return { kind: 'unavailable', why: 'the configured judge model is no longer available' }
      if (detail.cause === 'mode')
        return { kind: 'unavailable', why: 'auto mode was switched off while it was reviewed' }
      return {
        kind: 'unavailable',
        why: routeReason ?? detail.error ?? 'the reviewer gave no answer'
      }
    case 'none':
      return { kind: 'unavailable', why: 'the review was cancelled' }
  }
}

export class DispatchTargetJudge {
  private readonly autoMode: AutoModeConfig
  private readonly denials = new AutoModeDenialTracker()
  private readonly outcomes = new Map<string, ToolOutcome>()
  private sharedConfig: SharedAutoModeConfig | undefined
  private remotes: GitRemote[] | undefined
  private remotesPromise: Promise<GitRemote[]> | undefined
  private visibility: RepoVisibility | undefined
  private visibilityPromise: Promise<RepoVisibility> | undefined
  private staleJudgeModelReported = false
  private routeUnavailableReported = false
  /** The target judge's construction time: redirect mtimes at or after it are
   *  `modifiedSinceSessionStart`. A resumed session restarts the clock. */
  private readonly sessionStartMs = Date.now()

  constructor(private readonly opts: DispatchTargetJudgeOptions) {
    // Memoized for the target's life, like each session memoizes its own
    // (a mid-dispatch config edit is not hot-reloaded).
    let autoMode: AutoModeConfig = {}
    try {
      autoMode = opts.loadEngineConfig(opts.configEngine ?? opts.engine).autoMode ?? {}
    } catch {
      autoMode = {}
    }
    this.autoMode = autoMode
  }

  /**
   * `(mode === 'auto' || mode === 'full') && autoMode.enabled !== false` —
   * the TARGET engine's switch (its judge is the one that would run). With it
   * off, an auto parent's target keeps the historical no-judge behaviour.
   */
  autoModeActive(mode: string): boolean {
    return (mode === 'auto' || mode === 'full') && this.autoMode.enabled !== false
  }

  /** Record how one of the target's own calls ended (the judge's `{"outcome":…}` lines). */
  recordOutcome(toolUseId: string, outcome: ToolOutcome): void {
    recordToolOutcome(this.outcomes, toolUseId, outcome)
  }

  /**
   * The user approved a held block anyway (ADR-091 §3): the denial streak the
   * block counted resets, exactly as a judge allow resets it.
   */
  recordHoldApproved(): void {
    this.denials.recordAllow()
  }

  /**
   * Judge one target call. G9 (a user ask rule → the human) is the CALLER's,
   * run before this; there are no allow rules on a target, so the allow-rule
   * gate never runs (no `allowRuleAction` hook).
   */
  judge(action: JudgePipelineAction, call: DispatchTargetJudgeCall): Promise<JudgePipelineOutcome> {
    return runJudgePipeline(
      action,
      this.hooks(call, this.denials, () => this.transport(), true)
    )
  }

  /**
   * Review the report an X-Agent hands back (ADR-105 §3, slice B-3c): the same pipeline as a
   * tool call, run on a synthetic `hand_back` call framed as agent-authored output (the
   * classifier's hand-back variant, evaluation rule 15). It FLAGS, never blocks, so the
   * result is a {@link ReportReview}, not an outcome.
   *
   * Differences from {@link judge}: a THROWAWAY denial tracker (a review is not one of the
   * target's own actions, so it never counts toward its caps, and a one-block tracker never
   * trips them), no card (`toolUseId: ''`), no grant, no read-only gate, and a route problem
   * becomes the report's note instead of the target's one-per-target banner. The judge sees the
   * first {@link RESULT_REPORT_MAX} characters, the cut a delivery uses; the whole report is
   * still stored and delivered. Never throws.
   */
  async reviewHandBack(report: string, call: HandBackReviewCall): Promise<ReportReview> {
    return this.reviewText(
      { toolName: HAND_BACK_TOOL, input: (shown) => ({ report: shown }), handBack: true },
      report,
      call
    )
  }

  /**
   * Review a message an X-Agent sends the agent that spawned it (`session_message`, ADR-105 §4) before
   * it is delivered: the hand-back review applied to a message (the pipeline, framing, throwaway
   * tracker and cut are the same, the label and rule 15's wording are a message's). For a target
   * whose own gate cannot see the call (Codex's dynamic tools); a pi or opencode target is gated by
   * {@link judge} like any other action.
   */
  async reviewAgentMessage(message: string, call: HandBackReviewCall): Promise<ReportReview> {
    return this.reviewText(
      {
        toolName: X_AGENT_MESSAGE_TOOL,
        input: (shown) => ({ message: shown }),
        agentMessage: true
      },
      message,
      call
    )
  }

  private async reviewText(
    kind: {
      toolName: string
      input: (shown: string) => Record<string, unknown>
      handBack?: boolean
      agentMessage?: boolean
    },
    report: string,
    call: HandBackReviewCall
  ): Promise<ReportReview> {
    let routeReason: string | undefined
    try {
      const shown =
        report.length > RESULT_REPORT_MAX
          ? `${report.slice(0, RESULT_REPORT_MAX)}\n[the report continues; only its first ${RESULT_REPORT_MAX} characters are shown here]`
          : report
      const { detail } = await runJudgePipelineDetailed(
        {
          toolUseId: '',
          toolName: kind.toolName,
          input: kind.input(shown),
          ...(kind.handBack ? { handBack: true } : {}),
          ...(kind.agentMessage ? { agentMessage: true } : {})
        },
        this.hooks(
          {
            currentMode: call.currentMode,
            honoursWorkdir: false,
            skipReadOnlyGate: true,
            permissions: call.permissions,
            ...(call.stillPending ? { stillPending: call.stillPending } : {})
          },
          new AutoModeDenialTracker(),
          () => {
            const judge = this.transport((reason) => {
              routeReason ??= reason
            })
            const { signal } = call
            if (!signal) return judge
            return (req) =>
              judge({ ...req, signal: req.signal ? AbortSignal.any([req.signal, signal]) : signal })
          },
          false
        )
      )
      return reviewFromPipeline(detail, routeReason)
    } catch (err) {
      return { kind: 'unavailable', why: err instanceof Error ? err.message : String(err) }
    }
  }

  /** The pipeline's hooks for one call; `grants` — whether a user's approved block clears it (tool calls only). */
  private hooks(
    call: DispatchTargetJudgeCall,
    denials: AutoModeDenialTracker,
    transport: () => JudgeTransport,
    grants: boolean
  ): JudgePipelineHooks {
    const subagent = this.opts.subagent()
    return {
      logSource: 'CrossEngineDispatcher',
      cwd: this.opts.cwd,
      currentMode: call.currentMode,
      autoModeActive: () => this.autoModeActive(call.currentMode()),
      permissions: call.permissions,
      honoursWorkdir: call.honoursWorkdir,
      ...(call.skipReadOnlyGate ? { skipReadOnlyGate: true } : {}),
      ...(subagent ? { subagent } : {}),
      judgeAvailable: () => this.judgeAvailable(),
      judgeTransport: transport,
      messages: () => {
        const loading = this.opts.loadMessages?.()
        return loading ? loading.then((parent) => this.mergeMessages(parent)) : this.judgeMessages()
      },
      environment: () => this.environment(call.permissions()),
      captureActionMeta: (toolName, input) =>
        this.captureActionMeta(toolName, input, call.honoursWorkdir, call.permissions()),
      outcomes: () => (this.outcomes.size ? Object.fromEntries(this.outcomes) : undefined),
      denials,
      twoStageMode: () => this.autoMode.twoStageMode ?? 'both',
      sendReview: (id, review) => this.sendReview(id, review),
      ...(grants
        ? {
            consumeGrant: (toolName: string, input: Record<string, unknown>): boolean =>
              this.opts
                .blockedCalls?.()
                ?.consumeGrant(
                  blockGrantKey(
                    this.opts.engine,
                    toolName,
                    input,
                    this.opts.cwd,
                    call.honoursWorkdir
                  )
                ) ?? false
          }
        : {}),
      ...(call.stillPending ? { stillPending: call.stillPending } : {})
    }
  }

  /**
   * Parent transcript, its still-queued user turns and the target's own
   * assistant trajectory (ADR-088 D1), merged in time order (ADR-091 §4).
   */
  judgeMessages(): ChatMessage[] {
    return this.mergeMessages(this.opts.messages())
  }

  private mergeMessages(parent: ChatMessage[]): ChatMessage[] {
    const own = [...this.opts.trajectory()].filter((m) => m.role === 'assistant')
    return inTimeOrder(parent, this.opts.queuedTurns?.() ?? [], own)
  }

  /**
   * Fail-closed stale-judge check (ADR-023), the sessions' rule on a cache-only
   * peek: no configured judge model → available; a cold/empty catalog cannot
   * tell "removed" from "not discovered" → available; listed → available;
   * configured but missing → the human decides, with ONE banner per target.
   */
  judgeAvailable(): boolean {
    const configured = this.opts.fixedModel ? undefined : this.autoMode.judgeModel
    if (!configured) return true
    const all = (this.opts.peekModels() ?? []).flatMap((g) => g.models)
    if (all.length === 0) return true
    if (all.some((m) => m.value === configured)) return true
    if (!this.staleJudgeModelReported) {
      this.staleJudgeModelReported = true
      this.opts.emit()(
        'session:error',
        `Auto-mode judge model "${configured}" is no longer available — every gated action will ask you instead. ` +
          `Change it in Settings › Sessions & autonomy › Auto-mode judge (${this.opts.engine}).`
      )
    }
    return false
  }

  /**
   * ClaudeUI's own judge call (ADR-081), stateless. Judge model =
   * `autoMode.judgeModel` of the TARGET engine, else the target's model,
   * resolved per call; every call is a `judge` usage row under the
   * DISPATCHING session's routing id (the target has no routing of its own).
   */
  private transport(onUnavailable?: (reason: string) => void): JudgeTransport {
    const make = this.opts.makeTransport ?? makeSessionJudgeTransport
    return make({
      engine: this.opts.engine,
      modelValue: () => this.opts.fixedModel?.() ?? this.autoMode.judgeModel ?? this.opts.model(),
      sessionId: this.opts.sessionId,
      routingId:
        typeof this.opts.routingId === 'function' ? this.opts.routingId() : this.opts.routingId,
      // A report review tells the REPORT why it was not reviewed (its note); the target's
      // one banner is for the target's own gated actions.
      onUnavailable:
        onUnavailable ??
        ((reason) => {
          if (this.routeUnavailableReported) return
          this.routeUnavailableReported = true
          this.opts.emit()('session:error', judgeRouteUnavailableMessage(this.opts.engine, reason))
        })
    })
  }

  private shared(): SharedAutoModeConfig {
    if (this.sharedConfig === undefined) {
      try {
        this.sharedConfig = (this.opts.loadSharedConfig ?? loadSharedAutoModeConfig)()
      } catch {
        this.sharedConfig = {}
      }
    }
    return this.sharedConfig
  }

  /** Session-start git remotes, captured once per target (PiSession's shape). Never throws. */
  private async gitRemotes(): Promise<GitRemote[]> {
    if (this.remotes) return this.remotes
    this.remotesPromise ??= captureGitRemotes(this.opts.cwd)
    this.remotes = await this.remotesPromise
    return this.remotes
  }

  /** Repo visibility, resolved at most once per target. */
  private async repoVisibility(): Promise<RepoVisibility> {
    if (this.visibility) return this.visibility
    this.visibilityPromise ??= captureRepoVisibility(this.opts.cwd)
    this.visibility = await this.visibilityPromise
    return this.visibility
  }

  /**
   * The classifier's Environment section. `permissions` is the target's
   * `userDenyAsk(cwd)` — the user's deny/ask rules, allow empty — which is
   * exactly what the engine enforces for a target, so the judge is told the
   * rules that actually bind it.
   */
  private async environment(
    permissions: Pick<ClaudePermissions, 'allow' | 'ask' | 'deny' | 'additionalDirectories'>
  ): Promise<EnvironmentInfo> {
    const remotes = await this.gitRemotes()
    return buildClassifierEnvironment({
      cwd: this.opts.cwd,
      platform: process.platform,
      remotes,
      repoVisibility: this.visibility,
      permissions,
      shared: this.shared()
    })
  }

  /** Per-action measured ground truth — PiSession's `captureActionMeta`, with the workdir rule passed in. */
  private async captureActionMeta(
    toolName: string,
    input: Record<string, unknown>,
    honoursWorkdir: boolean,
    permissions: Pick<ClaudePermissions, 'additionalDirectories'>
  ): Promise<Record<string, unknown> | undefined> {
    const command = shellCommandOf(toolName, input)
    if (!command) return undefined
    return captureShellActionMeta({
      command,
      input,
      cwd: this.opts.cwd,
      honoursWorkdir,
      // The TARGET engine's shell decides the dialect (pi's bash is POSIX;
      // opencode's is PowerShell on win32, POSIX elsewhere).
      shell:
        this.opts.engine === 'opencode' && process.platform === 'win32' ? 'powershell' : 'posix',
      additionalDirectories: permissions.additionalDirectories,
      sessionStartMs: this.sessionStartMs,
      repoVisibility: () => this.repoVisibility()
    })
  }

  /**
   * The verdict on the TARGET's own tool block (the sessions' `sendToolReview`
   * body), emitted under the dispatching session's routing with the nested
   * tool id: the reducer searches every subagent bucket for it, so it lands on
   * the TaskCard's inner card (`attachToToolUse`).
   */
  private sendReview(toolUseId: string, review: JudgePipelineReview): ToolReviewBlock | undefined {
    if (!toolUseId) return undefined
    const reviewId = uuid()
    const block =
      review === 'read-only'
        ? readOnlyReviewBlock(toolUseId, reviewId)
        : 'allowRule' in review
          ? allowRuleReviewBlock(toolUseId, reviewId, review.allowRule)
          : autoModeReviewBlock(toolUseId, reviewId, review)
    this.opts.emit()('session:tool-review', { toolUseId, review: block })
    return block
  }
}
