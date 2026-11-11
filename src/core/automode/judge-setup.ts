/**
 * The auto-mode judge's per-owner setup, once for every owner that judges with ClaudeUI's own
 * judge (ADR-081): PiSession, OpencodeSession and DispatchTargetJudge each hold ONE of these.
 *
 * It owns what is per owner object and engine-neutral: the engine's `autoMode` config and the
 * shared trust lists (memoized), the session-start git remotes and repo visibility (memoized,
 * promise-shared), the primary judge's model and transport, the fallback judge (model, account,
 * label, transport), and the four one-per-owner banners and the one fallback log line.
 *
 * What differs per owner is injected ({@link JudgeSetupOptions}); what is engine-specific stays
 * with the owner (the classifier environment, per-action ground truth, the model catalog the
 * primary check reads, the pipeline hooks). `routingId`, `model` and `sessionId` are thunks read
 * when a transport is built: a session is re-keyed and changes its model while it lives.
 */
import type { AutoModeConfig, EngineConfig, SharedAutoModeConfig } from '../../shared/types'
import { logger } from '../services/logger'
import { loadEngineConfig, loadSharedAutoModeConfig } from '../services/ui-config'
import type { JudgeTransport } from './classifier'
import {
  captureGitRemotes,
  captureRepoVisibility,
  type GitRemote,
  type RepoVisibility
} from './ground-truth'
import type { JudgeEngine } from './judge-route'
import {
  fallbackJudgeAccountFor,
  fallbackJudgeLabel,
  fallbackJudgeModelFor,
  fallbackUnavailableMessage,
  judgeUnavailableMessage,
  makeFallbackJudge,
  makeSessionJudgeTransport,
  staleJudgeModelMessage,
  type SessionJudgeOptions
} from './session-judge'

export interface JudgeSetupOptions {
  /** The judged engine: which `engines/<id>.json#autoMode` block is read, and the banners' wording. */
  engine: JudgeEngine
  /** The `logger` source of the one fallback log line. */
  logSource: string
  /** The owner's working directory, for the git facts. A value: readonly in every owner. */
  cwd: string
  /** The owner's own model — the judge model when `autoMode.judgeModel` is unset. Read per use. */
  model: () => string
  /** The owner's engine session id, handed to the transport (read per call there). */
  sessionId: () => string | null
  /** The routing id a judge usage row lands under. Read when a transport is built (re-key). */
  routingId: () => string
  /** The `session:error` sink: a banner's text. */
  report: (message: string) => void
  /** The engine's model values as the FALLBACK check reads them; empty validates nothing. */
  catalogValues: () => readonly string[]
  /** Default {@link loadEngineConfig}; read once, on first use. */
  loadEngineConfig?: (id: string) => EngineConfig
  /** Default {@link loadSharedAutoModeConfig}; read once, on first use. */
  loadSharedConfig?: () => SharedAutoModeConfig
  /** Default {@link makeSessionJudgeTransport}; used for the primary AND the fallback transport. */
  makeTransport?: (opts: SessionJudgeOptions) => JudgeTransport
}

export class JudgeSetup {
  private autoMode: AutoModeConfig | undefined
  private sharedConfig: SharedAutoModeConfig | undefined
  private remotes: GitRemote[] | undefined
  private remotesPromise: Promise<GitRemote[]> | undefined
  private visibility: RepoVisibility | undefined
  private visibilityPromise: Promise<RepoVisibility> | undefined
  private staleJudgeModelReported = false
  private routeUnavailableReported = false
  /** The fallback judge's own one banner, apart from the primary's. */
  private fallbackRouteUnavailableReported = false
  private staleFallbackJudgeLogged = false

  constructor(private readonly opts: JudgeSetupOptions) {}

  /** The engine's `autoMode` block, memoized for the owner's life (a mid-session edit is not hot-reloaded). */
  config(): AutoModeConfig {
    if (this.autoMode === undefined) {
      try {
        this.autoMode =
          (this.opts.loadEngineConfig ?? loadEngineConfig)(this.opts.engine).autoMode ?? {}
      } catch {
        this.autoMode = {}
      }
    }
    return this.autoMode
  }

  /** The engine-shared trust lists (ADR-065 § Shared trust lists), memoized like {@link config}. */
  shared(): SharedAutoModeConfig {
    if (this.sharedConfig === undefined) {
      try {
        this.sharedConfig = (this.opts.loadSharedConfig ?? loadSharedAutoModeConfig)()
      } catch {
        this.sharedConfig = {}
      }
    }
    return this.sharedConfig
  }

  /** Auto mode is active for `auto`/`full` autonomy unless explicitly disabled. */
  active(mode: string): boolean {
    return (mode === 'full' || mode === 'auto') && this.config().enabled !== false
  }

  /**
   * Session-start git remotes, captured ONCE and frozen. Never refreshed: a remote added
   * mid-session is exactly what the exfiltration rules exist to catch. The promise is memoized
   * too, so two approvals racing the first classifier call share a single `git remote -v`. Never
   * throws: an empty list is the policy's restrictive fallback.
   */
  async gitRemotes(): Promise<GitRemote[]> {
    if (this.remotes) return this.remotes
    this.remotesPromise ??= captureGitRemotes(this.opts.cwd)
    this.remotes = await this.remotesPromise
    return this.remotes
  }

  /** Repo visibility, resolved at most once ('unknown' included: it is a real answer). */
  async repoVisibility(): Promise<RepoVisibility> {
    if (this.visibility) return this.visibility
    this.visibilityPromise ??= captureRepoVisibility(this.opts.cwd)
    this.visibility = await this.visibilityPromise
    return this.visibility
  }

  /** What {@link repoVisibility} has resolved so far (the classifier environment reads it synchronously). */
  resolvedVisibility(): RepoVisibility | undefined {
    return this.visibility
  }

  /** The judge model the primary judge calls: `autoMode.judgeModel`, else the owner's own. */
  judgeModelValue(): string {
    return this.config().judgeModel ?? this.opts.model()
  }

  /**
   * True when `autoMode.judgeModel` names a model missing from `values`, with ONE banner. An
   * empty list validates nothing (it cannot tell "removed" from "never discovered"); no
   * configured model is never stale.
   */
  primaryStale(values: readonly string[]): boolean {
    const configured = this.config().judgeModel
    if (!configured) return false
    if (values.length === 0) return false
    if (values.includes(configured)) return false
    if (!this.staleJudgeModelReported) {
      this.staleJudgeModelReported = true
      this.opts.report(staleJudgeModelMessage(this.opts.engine, configured, this.fallbackLabel()))
    }
    return true
  }

  /**
   * The fallback judge model in effect (`autoMode.fallbackJudgeModel`), or undefined: none set,
   * the same as the primary, or gone from the catalog (one log line; the human decides). An
   * empty catalog passes, like the primary's check.
   */
  fallbackModel(): string | undefined {
    const model = fallbackJudgeModelFor(
      this.config().fallbackJudgeModel,
      this.judgeModelValue(),
      this.config().fallbackJudgeAccount
    )
    if (!model) return undefined
    const values = this.opts.catalogValues()
    if (values.length === 0 || values.includes(model)) return model
    if (!this.staleFallbackJudgeLogged) {
      this.staleFallbackJudgeLogged = true
      logger.warn(
        this.opts.logSource,
        `auto-mode fallback judge model "${model}" is no longer available — no fallback`
      )
    }
    return undefined
  }

  /** The ChatGPT vault account the fallback judge pays with (`autoMode.fallbackJudgeAccount`), if one is named. */
  fallbackAccount(): string | undefined {
    return fallbackJudgeAccountFor(this.config().fallbackJudgeAccount)
  }

  /** The fallback judge as a banner names it: its model, plus the named account's plan. */
  fallbackLabel(): string | undefined {
    const model = this.fallbackModel()
    return model ? fallbackJudgeLabel(model, this.fallbackAccount()) : undefined
  }

  /**
   * The pipeline's `fallbackJudgeTransport`: the fallback judge model, when one is in effect. Its
   * failure shows the owner's one fallback banner, or goes to `onUnavailable` (a report review's
   * note) with the fallback's label, computed when the failure is reported.
   */
  fallbackJudge(
    onUnavailable?: (label: string, reason: string) => void
  ): { transport: JudgeTransport; label: string } | undefined {
    const model = this.fallbackModel()
    if (!model) return undefined
    return makeFallbackJudge(
      model,
      {
        engine: this.opts.engine,
        sessionId: this.opts.sessionId,
        routingId: this.opts.routingId(),
        chatgptAccountId: () => this.fallbackAccount(),
        onUnavailable: (reason) => {
          if (onUnavailable)
            return onUnavailable(fallbackJudgeLabel(model, this.fallbackAccount()), reason)
          this.reportFallbackRouteUnavailable(model, reason)
        }
      },
      this.opts.makeTransport
    )
  }

  /**
   * ClaudeUI's own judge call (ADR-081), stateless: no second engine process, so the judge prompt
   * is exactly the policy and the stage budgets apply. The model is resolved per call, so a live
   * model change applies to the next judge call; every call is a `judge` usage row under the
   * routing id read now. A model no ClaudeUI route covers is not judged by anyone else: the call
   * fails, the human decides, and the owner says why once (its one banner), or the failure goes to
   * `onUnavailable` (a report review's note).
   */
  transport(onUnavailable?: (reason: string) => void): JudgeTransport {
    const make = this.opts.makeTransport ?? makeSessionJudgeTransport
    return make({
      engine: this.opts.engine,
      modelValue: () => this.judgeModelValue(),
      sessionId: this.opts.sessionId,
      routingId: this.opts.routingId(),
      onUnavailable: onUnavailable ?? ((reason) => this.reportRouteUnavailable(reason))
    })
  }

  /** One banner per owner for a judge model ClaudeUI can't call (ADR-081 §3). */
  reportRouteUnavailable(reason: string): void {
    if (this.routeUnavailableReported) return
    this.routeUnavailableReported = true
    this.opts.report(judgeUnavailableMessage(this.opts.engine, reason, this.fallbackLabel()))
  }

  /** The fallback judge's own one banner: it could not be called either. */
  reportFallbackRouteUnavailable(model: string, reason: string): void {
    if (this.fallbackRouteUnavailableReported) return
    this.fallbackRouteUnavailableReported = true
    this.opts.report(
      fallbackUnavailableMessage(
        this.opts.engine,
        fallbackJudgeLabel(model, this.fallbackAccount()),
        reason
      )
    )
  }
}
