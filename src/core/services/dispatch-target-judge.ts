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
 * transcript — the human turns there are the only real authorisation — then
 * the target's OWN assistant trajectory (its earlier calls, user-role messages
 * removed: the dispatch prompts are agent-authored, never the user's words),
 * with the action headed as the `dispatch:<engine>` subagent's, carrying the
 * latest dispatch prompt.
 *
 * Imports no session class (the dispatcher's require-cycle rule): only the
 * automode leaves and type-only shared types.
 */
import { v4 as uuid } from 'uuid'
import type {
  AutoModeConfig,
  ChatMessage,
  ClaudePermissions,
  EngineConfig,
  EngineModelGroup,
  SharedAutoModeConfig
} from '../../shared/types'
import type { ClassifierAction, EnvironmentInfo, JudgeTransport } from '../automode/classifier'
import {
  allowRuleReviewBlock,
  AutoModeDenialTracker,
  autoModeReviewBlock,
  readOnlyReviewBlock
} from '../automode/denial-tracker'
import { buildClassifierEnvironment } from '../automode/environment'
import {
  analyzeRedirects,
  captureGitConfigArmed,
  captureGitRemotes,
  captureGitStatus,
  captureRepoVisibility,
  hasGitSegment,
  needsGitStatus,
  needsRepoVisibility,
  recordToolOutcome,
  shellCommandOf,
  tempDirRoots,
  type GitRemote,
  type RepoVisibility,
  type ToolOutcome
} from '../automode/ground-truth'
import {
  runJudgePipeline,
  type JudgePipelineAction,
  type JudgePipelineOutcome,
  type JudgePipelineReview,
  type JudgePipelineStage
} from '../automode/judge-pipeline'
import { effectiveShellCwd } from '../automode/read-only-gate'
import {
  judgeRouteUnavailableMessage,
  makeSessionJudgeTransport,
  type SessionJudgeOptions
} from '../automode/session-judge'
import { loadSharedAutoModeConfig } from './ui-config'

// The trajectory helper moved to a leaf (`automode/trajectory.ts`, ADR-089) so
// `pi/pi-child-runner.ts` can record a child's trajectory without importing
// this module; re-exported for its existing importers.
export { recordTrajectoryMessage, TARGET_TRAJECTORY_MAX } from '../automode/trajectory'

export interface DispatchTargetJudgeOptions {
  /** The TARGET engine — which is also the judge engine. */
  engine: 'opencode' | 'pi'
  cwd: string
  /** The DISPATCHING session's routing id (`fromRoutingId`) — judge usage rows land under it. */
  routingId: string
  /** The target's engine session id, read per call. */
  sessionId: () => string | null
  /** The target's model — the judge model when `autoMode.judgeModel` is unset. */
  model: () => string
  /** `entry.ctx.emit`, read live (the ctx is replaced on every continuation). */
  emit: () => (channel: string, data: unknown) => void
  /** `entry.ctx.getMessages()` — the dispatching session's transcript, read live. */
  messages: () => ChatMessage[]
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

  constructor(private readonly opts: DispatchTargetJudgeOptions) {
    // Memoized for the target's life, like each session memoizes its own
    // (a mid-dispatch config edit is not hot-reloaded).
    let autoMode: AutoModeConfig = {}
    try {
      autoMode = opts.loadEngineConfig(opts.engine).autoMode ?? {}
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
   * Judge one target call. G9 (a user ask rule → the human) is the CALLER's,
   * run before this; there are no allow rules on a target, so the allow-rule
   * gate never runs (no `allowRuleAction` hook).
   */
  judge(action: JudgePipelineAction, call: DispatchTargetJudgeCall): Promise<JudgePipelineOutcome> {
    const subagent = this.opts.subagent()
    return runJudgePipeline(action, {
      logSource: 'CrossEngineDispatcher',
      cwd: this.opts.cwd,
      currentMode: call.currentMode,
      autoModeActive: () => this.autoModeActive(call.currentMode()),
      permissions: call.permissions,
      honoursWorkdir: call.honoursWorkdir,
      ...(call.skipReadOnlyGate ? { skipReadOnlyGate: true } : {}),
      ...(subagent ? { subagent } : {}),
      judgeAvailable: () => this.judgeAvailable(),
      judgeTransport: () => this.transport(),
      messages: () => this.judgeMessages(),
      environment: () => this.environment(call.permissions()),
      captureActionMeta: (toolName, input) =>
        this.captureActionMeta(toolName, input, call.honoursWorkdir, call.permissions()),
      outcomes: () => (this.outcomes.size ? Object.fromEntries(this.outcomes) : undefined),
      recordOutcome: (id, outcome) => this.recordOutcome(id, outcome),
      denials: this.denials,
      twoStageMode: () => this.autoMode.twoStageMode ?? 'both',
      sendReview: (id, review) => this.sendReview(id, review),
      ...(call.stillPending ? { stillPending: call.stillPending } : {})
    })
  }

  /** Parent transcript, then the target's own assistant trajectory (ADR-088 D1). */
  judgeMessages(): ChatMessage[] {
    const own = [...this.opts.trajectory()].filter((m) => m.role === 'assistant')
    return [...this.opts.messages(), ...own]
  }

  /**
   * Fail-closed stale-judge check (ADR-023), the sessions' rule on a cache-only
   * peek: no configured judge model → available; a cold/empty catalog cannot
   * tell "removed" from "not discovered" → available; listed → available;
   * configured but missing → the human decides, with ONE banner per target.
   */
  judgeAvailable(): boolean {
    const configured = this.autoMode.judgeModel
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
  private transport(): JudgeTransport {
    const make = this.opts.makeTransport ?? makeSessionJudgeTransport
    return make({
      engine: this.opts.engine,
      modelValue: () => this.autoMode.judgeModel ?? this.opts.model(),
      sessionId: this.opts.sessionId,
      routingId: this.opts.routingId,
      onUnavailable: (reason) => {
        if (this.routeUnavailableReported) return
        this.routeUnavailableReported = true
        this.opts.emit()('session:error', judgeRouteUnavailableMessage(this.opts.engine, reason))
      }
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
    const meta: Record<string, unknown> = {}
    if (needsGitStatus(command)) {
      const gitStatus = await captureGitStatus(this.opts.cwd)
      if (gitStatus) meta.gitStatus = gitStatus
    }
    if (needsRepoVisibility(command)) {
      meta.repoVisibility = await this.repoVisibility()
    }
    const redirects = analyzeRedirects(command, {
      cwd: this.opts.cwd,
      tempDirs: tempDirRoots(),
      additionalDirectories: permissions.additionalDirectories
    })
    if (redirects) meta.redirects = redirects
    if (hasGitSegment(command)) {
      const runIn = effectiveShellCwd(this.opts.cwd, input, honoursWorkdir)
      const armed = runIn === null ? null : await captureGitConfigArmed(runIn)
      if (armed && armed.length > 0) meta.gitConfigArmed = armed
    }
    return Object.keys(meta).length > 0 ? meta : undefined
  }

  /**
   * The verdict on the TARGET's own tool block (the sessions' `sendToolReview`
   * body), emitted under the dispatching session's routing with the nested
   * tool id: the reducer searches every subagent bucket for it, so it lands on
   * the TaskCard's inner card (`attachToToolUse`).
   */
  private sendReview(toolUseId: string, review: JudgePipelineReview): void {
    if (!toolUseId) return
    const reviewId = uuid()
    this.opts.emit()('session:tool-review', {
      toolUseId,
      review:
        review === 'read-only'
          ? readOnlyReviewBlock(toolUseId, reviewId)
          : 'allowRule' in review
            ? allowRuleReviewBlock(toolUseId, reviewId, review.allowRule)
            : autoModeReviewBlock(toolUseId, reviewId, review)
    })
  }
}
