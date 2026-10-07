/**
 * One ClaudeUI chat on opencode 2.x (ADR-093 S5). The 1.x session survives
 * verbatim as `OpencodeV1Session` until S10.
 *
 * Lifecycle. A lease from the S2 manager (a turn-running `acquire`, so the
 * `claudeui-xeng` permission guard is probed and a missing plugin surfaces as
 * `OpencodePermissionGuardError`), an `OpencodeClient` scoped to the chat's
 * directory, ONE `OpencodeEventMapper` for the chat's opencode session and the
 * S3 event feed. A new session is created with its ruleset, agent and model
 * in the body (`location` = the chat's cwd); a resumed one is read once
 * (cold history → the transcript the judge reads, the status-line seed, and
 * `mapper.seed`) and caught up with `reconcileAfterReconnect` on its first
 * `connected`, exactly as after any feed gap. Every mapper output is
 * dispatched to the engine-neutral channels in {@link dispatch}.
 *
 * Prompts and the queue (ADR-093 §9). Every prompt ClaudeUI posts carries a
 * ClaudeUI-chosen inbox id (`msg_claudeui_…`). A prompt typed while a turn
 * runs is still ADR-053's queue item (the queue card, take-back on ArrowUp),
 * but the engine holds it: the item is posted to opencode's inbox at once
 * with `delivery: 'steer'` — ADR-053 §1's timing, the next step boundary of
 * the running turn — and stays cancellable until opencode delivers it.
 * Delivered → the item is consumed; cancelled → recalled; take-back →
 * `DELETE …/inbox/:id`, then the stored row decides who won the race.
 * `setQueuedItemDelivery` switches an item between steer and queue (`PATCH`).
 * The host-held forward of 1.x is gone for opencode.
 *
 * Permissions (ADR-093 §3, S6). The session ruleset is
 * `buildSessionRuleset` (created with it, PATCHed when it changes; PATCH
 * replaces), the plan agent is `switchAgent`. Every `permission.asked` goes
 * through the host pre-check, the session-allow set, the auto-mode judge or
 * the card, as in 1.x; the reply goes to the ASKING session (a subagent child
 * answers its own asks). Every reject and every form cancel carries a
 * message (a messageless one ends the turn and keeps its execution claim).
 * Subagent children get `childSessionRuleset(parent, agent)` PATCHed on
 * `session.created`, again on every parent re-apply and on an agent switch;
 * `evaluateChildCall` refuses a child ask its own agent denies (the window
 * before that PATCH lands).
 *
 * Synthetic inbox items (`synthetic`: plan-mode reminders, background
 * completion notices, "continue" nudges) are neither rendered live nor cold:
 * the cold converter skips the stored `synthetic` rows, and live they only
 * reach the queue bookkeeping, which ignores every non-user item.
 */
import type { HostWindowHandle } from '../host'
import { parse as parsePath } from 'node:path'
import { v4 as uuid } from 'uuid'
import { opencodeServerManager, OpencodePermissionGuardError } from './OpencodeServerManager'
import type { ServerConnection } from './OpencodeServerManager'
import { OpencodeClient, type PermissionReply } from './OpencodeClient'
import type { OpencodeEvent } from './protocol-v2/events'
import type { Agent_Info, Form_Answer, Model_Ref, Session_Info } from './protocol-v2/openapi'
import {
  OpencodeEventMapper,
  type OpencodeApprovalRoute,
  type OpencodeMapperOutput,
  type OpencodeStepUsage,
  type OpencodeStopReason
} from './v2-event-mapper'
import type { OpencodeFormField, OpencodeToolResult } from './v2-content'
import { reconcileAfterReconnect } from './v2-reconnect'
import { convertOpencodeHistory, readOpencodeHistory } from './v2-history'
import { ShellOutputPoller } from './shell-output-poller'
import { BaseSession } from '../providers/BaseSession'
import type { EngineSpawnOptions } from '../providers/ISession'
import type { ResolvedCapabilities } from '../../shared/model-capabilities'
import type { AccountIdentity } from '../../shared/account-key'
import { resolveOpencodeCapabilities } from '../../shared/model-capabilities'
import type {
  AttachmentUpload,
  ChatMessage,
  SessionStatus,
  ApprovalDecision,
  PermissionSuggestion,
  PendingApproval,
  PermissionDenialBlock,
  AccountRef,
  MeteringSnapshot,
  AutoModeConfig,
  SharedAutoModeConfig,
  AskUserQuestion,
  StatusLineData,
  SkillInfo,
  ModelCostEntry,
  QueuedItem,
  ToolReviewBlock
} from '../../shared/types'
import { opencodeModel } from '../../shared/types'
import {
  getOpencodeModelContextWindow,
  getOpencodeModelCapabilities,
  discoverOpencodeModels,
  peekOpencodeModels,
  parseModelString
} from './model-discovery'
import { equivalentCostUsd } from '../../shared/pricing'
import { totalCosts, type TotalCosts } from '../../shared/cost-rule'
import { opencodeCostInputs, resolveOpencodeCosts, type OpencodeCostInputs } from './message-cost'
import { opencodeV2HistorySeed, type OpencodeHistoryTokens } from './history-status-line'
import { logger } from '../services/logger'
import { authErrorTranscriptMessage } from '../services/api-error'
import { opencodeAuthHooks } from './opencode-auth-hooks'
import type { ItemStreamTarget } from '../shared/sync/item-stream'
import { BashStreamGate } from './bash-stream-gate'
import { discoverOpencodeSkills } from './command-skill-discovery'
import { opencodeAuthProvider } from '../auth/OpencodeAuthProvider'
import { recordUsageEvent } from '../services/usage-recorder'
import { loadClaudePermissions } from '../services/claude-settings'
import {
  opencodeMcpKey,
  persistAllowSuggestions,
  sanitizeMcpName,
  suggestOpencodeAllowRule
} from './permission-compiler'
import type { OpencodePermissionRule } from './permission-compiler'
import {
  asHostPrecheckRules,
  buildSessionRuleset,
  compileClaudeRulesV2,
  opencodeOwnDirAllows,
  THROWAWAY_RULESET,
  type V2Rule
} from './permission-v2'
import { isV2BuiltinAction } from './permission-keys'
import { childSessionRuleset, evaluateChildCall } from './subagent-permissions'
import { hostPrecheck, type HostPrecheckContext } from './host-precheck'
import { OpencodeSessionAllows } from './session-allows'
import { reviewRationale } from '../shared/tool-review'
import {
  type ClassifyResult,
  type EnvironmentInfo,
  type JudgeTransport
} from '../automode/classifier'
import { runJudgePipeline } from '../automode/judge-pipeline'
import { armBlockHold, blockHoldMs } from '../automode/block-hold'
import { blockGrantKey } from '../automode/blocked-calls'
import { judgeRouteUnavailableMessage, makeSessionJudgeTransport } from '../automode/session-judge'
import { buildClassifierEnvironment } from '../automode/environment'
import {
  allowRuleReviewBlock,
  AutoModeDenialTracker,
  autoModeReviewBlock,
  readOnlyReviewBlock
} from '../automode/denial-tracker'
import { effectiveShellCwd } from '../automode/read-only-gate'
import type { AllowSkipAction } from '../automode/allow-rule-skip'
import { isShellToolName } from '../automode/shell-lexical'
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
import { loadEngineConfig, loadSharedAutoModeConfig } from '../services/ui-config'
import type { ClaudePermissions, PermissionScope } from '../../shared/types'
import { blockUsageService } from '../services/block-usage'
import { opencodeAuthRequiredProviderId } from '../shared-providers/chatgpt-route'
import {
  crossEngineDispatcher,
  crossEngineDispatchAvailable
} from '../services/cross-engine-dispatcher'
import { CLAUDEUI_MCP_SERVER } from './permission-ruleset'
import { editClearsAgentControl } from './agent-control-gate'
import { collectClaudeMcpForOpencode } from './claude-mcp-bridge'
import { PLAN_MODE_DENY_REASON_NO_EXIT_TOOL } from '../pi/permission-engine'

const DEFAULT_MODEL = 'opencode/mimo-v2.5-free'

/**
 * The inbox delivery of a ClaudeUI queue item. ADR-053 §1 (Claude Code
 * parity): a message typed while a turn runs is live feedback, folded in at
 * the agent's next sub-turn boundary — opencode's `steer` (`queue` would hold
 * it until the turn ends, which ADR-053 rejected). `setQueuedItemDelivery`
 * moves a single item to `queue` and back.
 */
export const QUEUE_ITEM_DELIVERY = 'steer' as const

/** The prefix of every inbox id ClaudeUI chooses (2.x requires `msg_`). */
export const CLAUDEUI_INBOX_PREFIX = 'msg_claudeui_'

/** A fresh ClaudeUI inbox id (`^msg_`, unique; opencode orders by sequence, not id). */
function newInboxId(): string {
  return `${CLAUDEUI_INBOX_PREFIX}${uuid().replaceAll('-', '')}`
}

/** The reason a host-sent reject carries when nothing better is known (never empty). */
const DEFAULT_REJECT_MESSAGE = 'The user denied this tool call'

/** A form the user dismissed (every cancel carries a message, ADR-093 §3). */
const FORM_DISMISSED_MESSAGE = 'The user dismissed the question without answering'

/**
 * Test seam: hold every child ruleset PATCH until the returned promise
 * settles (the contract proves the plugin hook closes the create → PATCH
 * window without winning a race). Null in production.
 */
let childPatchGate: ((childID: string) => Promise<void>) | null = null
export function __holdChildPatchesForTests(
  gate: ((childID: string) => Promise<void>) | null
): void {
  childPatchGate = gate
}

/** Child sessions a resumed chat reads, at most (nested ones included). */
const MAX_ADOPTED_CHILD_READS = 50

/** How long a teardown waits for its interrupt/cancels before ending the lease. */
const TEARDOWN_GRACE_MS = 5_000

/** Why a turn that opencode stopped on its own ended (ADR-090: a user stop shows nothing). */
const STOP_NOTICES: Partial<Record<OpencodeStopReason, string>> = {
  shutdown:
    'opencode stopped this turn while shutting down; it resumes the turn on its next start.',
  superseded: 'opencode stopped this turn: another execution of this session took over.',
  inactivity: 'opencode stopped this turn after a period of inactivity.',
  unknown: 'The opencode turn was stopped.'
}

/** One permission ask waiting for its answer, keyed by request id. */
interface PendingAsk {
  /** The call the ask is about (undefined when opencode named none). */
  toolUseId?: string
  approval: PendingApproval
  /** false when a user ask rule (or a held block) keeps it for the human — never swept. */
  sweepable: boolean
  /** Set while the card holds an auto-mode judge block (ADR-091 §3). */
  hold?: { reason: string; cancel: () => void }
}

/** One pending form (AskUserQuestion). */
interface PendingForm {
  sessionID: string
  formID: string
  fields: readonly OpencodeFormField[]
  questions: readonly AskUserQuestion[]
}

/** A subagent child of this chat (or of one of its children). */
interface ChildSession {
  readonly parentID: string
  /** The child's agent id (`session.created.agent`, then `session.agent.selected`). */
  agent?: string
  /** The ruleset last computed for it (what a grandchild's ruleset builds on). */
  rules?: V2Rule[]
  /** What was last PATCHed (skip an unchanged one). */
  patchedKey?: string
  /** The parent ruleset (its key) the child's rules were last computed from. */
  parentKey?: string
  /** PATCHes for this child run one at a time, in order (never a stale one last). */
  chain: Promise<void>
  /**
   * Its ruleset could not be applied (twice): the child was interrupted and
   * every ask it raises is refused until a PATCH lands (fail closed).
   */
  unpatched?: boolean
}

/** One metered request of this process (a step, a compaction's own request, overhead). */
interface LiveUsage {
  readonly inputs: OpencodeCostInputs
  readonly modelId: string
  readonly engineCostUsd: number
  readonly tokens: OpencodeHistoryTokens
}

function tokensOf(t: {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}): OpencodeHistoryTokens {
  // Reasoning is billed as output (the fold every opencode figure applies).
  return {
    input: t.input,
    output: t.output + t.reasoning,
    cacheWrite: t.cache.write,
    cacheRead: t.cache.read
  }
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export class OpencodeSession extends BaseSession {
  readonly engineId = 'opencode' as const

  private _capabilities: ResolvedCapabilities
  get capabilities(): ResolvedCapabilities {
    return this._capabilities
  }

  private conn: ServerConnection | null = null
  private client: OpencodeClient | null = null
  private openSessionId: string | null = null
  /** The chat's mapper; created with the opencode session, kept across feed gaps and reconnects. */
  private mapper: OpencodeEventMapper | null = null
  /** The next `connected` must re-read state (a resumed session, a restarted feed). */
  private needsCatchUp = false
  private feedAbort: AbortController | null = null
  /** Resolves at the feed's first `connected` (after its catch-up). */
  private feedReady: Promise<void> | null = null
  private isProcessing = false
  /** Drives the `'disconnected'` status (the renderer's only signal to clear `sdkActive`). */
  private disconnected = false
  private unsubscribeServerExit: (() => void) | null = null
  /** ClaudeUI changed opencode's config (S8): the agent list is re-read. */
  private unsubscribeConfigChanged: (() => void) | null = null

  // ── Cost and context (history base + this process) ─────────────────────────
  private costBase: OpencodeCostInputs[] = []
  private modelCostBase = new Map<string, number>()
  private rawCostBaseUsd = 0
  private tokenBase: OpencodeHistoryTokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }
  /** Every request this process metered: own and child steps, compactions, overhead (S4's rule). */
  private liveUsage: LiveUsage[] = []
  private startTimeMs = 0
  private accTotalDurationMs = 0
  /** The last OWN step's prompt size (input + cache read) — the context meter. */
  private lastContextLength = 0

  private _model: string
  private permissionMode: string
  private reasoningVariant: string | null = null
  /** The `provider/model#variant` the opencode session was last set to. */
  private appliedModelKey: string | null = null
  /** The opencode session's current agent (create, `switchAgent`, `agent-selected`). */
  private currentAgent: string | null = null

  private pendingApprovals = new Map<string, PendingAsk>()
  private pendingForms = new Map<string, PendingForm>()
  /** request/form id → the session that asked (replies go there). Until `approval-resolved`. */
  private routes = new Map<string, string>()
  private readonly sessionAllows = new OpencodeSessionAllows()

  /** Inbox ids of prompts THIS chat posted directly (their user rows are already shown). */
  private ownInboxIds = new Set<string>()
  /** inbox id → queue item id, for items posted to the inbox and not settled. */
  private inboxToItem = new Map<string, string>()
  private itemToInbox = new Map<string, string>()
  /** Queue items whose POST is in flight: a take-back waits for it (else its DELETE could land first). */
  private posting = new Map<string, Promise<void>>()
  /** Commands posted (`runCommand` takes no id): their expansion's user row is ours too. */
  private pendingCommandEchoes = 0
  /** Posts go out one at a time, in call order (a queued item never overtakes its turn's prompt). */
  private postChain: Promise<void> = Promise.resolve()
  /** The inbox may hold ClaudeUI items nothing stands behind (after a teardown or a resume). */
  private needsPurge = false

  /** call id → tool input, from the tool_use blocks the mapper emitted (own and child). */
  private toolInputs = new Map<string, Record<string, unknown>>()
  /** Open item streams, so a teardown can seal them with what streamed so far. */
  private openItems = new Map<string, { target: ItemStreamTarget; message: ChatMessage }>()

  private bashStreamGate = new BashStreamGate((toolUseId, output) => {
    this.send('session:bash-output', {
      toolUseId,
      output,
      totalLines: output.split('\n').length,
      totalBytes: Buffer.byteLength(output, 'utf-8')
    })
  })
  /** 2.x pushes no shell output: own shell calls are followed by polling (S4). */
  private shellPoller = new ShellOutputPoller({
    onOutput: (toolUseId, output) => this.bashStreamGate.update(toolUseId, output)
  })

  // ── Permissions ────────────────────────────────────────────────────────────
  /** The ruleset last applied to the opencode session (create or PATCH). */
  private applied: { sessionId: string; rules: V2Rule[]; key: string } | null = null
  /** The user's compiled rules (all tiers) of the last build — the pre-check's provenance set. */
  private lastUserRules: V2Rule[] | null = null
  private children = new Map<string, ChildSession>()
  /** A resumed chat lists its stored children on the next connect. */
  private adoptChildrenOnConnect = false
  /** Permission applies run one at a time (see applyPermissionMode). */
  private applyChain: Promise<void> = Promise.resolve()
  private knownMcpServers: string[] | null = null
  private mcpStatusWarned = false
  /** `GET /api/agent` (cached per connection; a failure is not cached). */
  private agentList: Agent_Info[] | null = null
  private agentsWarned = false
  /** The location's git worktree root (`GET /api/location` project directory); null = none/unknown. */
  private worktree: string | null | undefined = undefined

  // ── Auto mode (ADR-023) ────────────────────────────────────────────────────
  private _autoModeConfig: AutoModeConfig | undefined
  private _sharedAutoMode: SharedAutoModeConfig | undefined
  private autoDenials = new AutoModeDenialTracker()
  private staleJudgeModelReported = false
  private judgeRouteUnavailableReported = false
  private toolOutcomes = new Map<string, ToolOutcome>()
  private sessionRemotes: GitRemote[] | null = null
  private sessionRemotesPromise: Promise<GitRemote[]> | null = null
  private sessionRepoVisibility: RepoVisibility | null = null
  private sessionRepoVisibilityPromise: Promise<RepoVisibility> | null = null

  private knownCommandNames = new Set<string>()
  private _cancelled = false
  private connectingPromise: Promise<void> | null = null
  private establishingPromise: Promise<void> | null = null
  private resuming: Promise<void> | null = null
  private replayInFlight: Promise<void> | null = null
  private replayedSessionId: string | null = null
  private resumeSessionId: string | undefined
  /** The last turn was held before sending for a ChatGPT sign-in (ADR-093 §5). */
  private authHeld = false

  constructor(
    routingId: string,
    win: HostWindowHandle | null,
    cwd: string,
    opts: EngineSpawnOptions = {}
  ) {
    super(routingId, win, cwd)
    this._model = opts.model ?? DEFAULT_MODEL
    this.permissionMode = opts.permissionMode ?? 'default'
    this.resumeSessionId = opts.resumeSessionId || undefined
    this._capabilities = this.resolveCapsForModel()
    this.sendStatus()
    this.sendStatusLine()
    opencodeAuthProvider
      .warmCache()
      .then(() => {
        this.sendStatus()
        this.sendStatusLine()
      })
      .catch(() => {})
  }

  private resolveCapsForModel(): ResolvedCapabilities {
    const { providerID, modelID } = parseModelString(this._model)
    const base = resolveOpencodeCapabilities(getOpencodeModelCapabilities(providerID, modelID))
    return {
      ...base,
      crossEngineDispatch: base.crossEngineDispatch && crossEngineDispatchAvailable('opencode')
    }
  }

  get willQueue(): boolean {
    return this.isProcessing
  }

  get status(): SessionStatus {
    const parsed = parseModelString(this._model)
    const account: AccountRef | null = opencodeAuthProvider.buildAccountRef(parsed.providerID)
    return {
      state: this.disconnected ? 'disconnected' : this.isProcessing ? 'running' : 'idle',
      sessionId: this.openSessionId,
      model: opencodeModel(parsed.providerID, parsed.modelID),
      cwd: this.cwd,
      totalCostUsd: this.totalCostUsd,
      account,
      ...this.baseStatusFields()
    }
  }

  getSessionId(): string | null {
    return this.openSessionId
  }

  /** Cross-engine dispatch reads the caller's autonomy (ADR-033 M2). */
  getAutonomyMode(): string {
    return this.permissionMode
  }

  protected override resetInactivityTimer(): void {
    this.clearInactivityTimer()
    if (this.inactivityTimeoutMs > 0) {
      this.inactivityTimer = setTimeout(() => {
        logger.info('OpencodeSession', `Idle timeout — auto-disconnecting`)
        this.cancel()
      }, this.inactivityTimeoutMs)
    }
  }

  protected override onDispatchedCostsChanged(): void {
    this.sendStatusLine()
  }

  // ── Model ──────────────────────────────────────────────────────────────────

  private modelRef(): Model_Ref {
    const { providerID, modelID } = parseModelString(this._model)
    return {
      providerID,
      id: modelID,
      ...(this.reasoningVariant != null ? { variant: this.reasoningVariant } : {})
    }
  }

  private modelKey(ref: Model_Ref): string {
    return `${ref.providerID}/${ref.id}#${ref.variant ?? ''}`
  }

  /** Put the chat's model (and reasoning variant) on the opencode session before a request. */
  private async syncModel(): Promise<void> {
    if (!this.client || !this.openSessionId) return
    const ref = this.modelRef()
    const key = this.modelKey(ref)
    if (this.appliedModelKey === key) return
    await this.client.switchModel(this.openSessionId, ref)
    this.appliedModelKey = key
  }

  // ── Turns ──────────────────────────────────────────────────────────────────

  async run(prompt: string | null, attachments?: AttachmentUpload[]): Promise<void> {
    this.clearInactivityTimer()
    this._cancelled = false
    this.disconnected = false

    if (prompt === null) {
      void this.eagerConnect()
      this.resetInactivityTimer()
      return
    }

    // A prompt during another prompt's connect window rides into the ONE
    // session that establish creates (M-OC1): never a second createSession.
    if (this.establishingPromise) {
      try {
        await this.establishingPromise
      } catch {
        return // the first prompt already surfaced its error
      }
      if (this._cancelled || !this.client || !this.openSessionId) return
      return this.steer(prompt, attachments)
    }

    // A turn is running: the prompt goes into it (the inbox steers it at the
    // next step boundary). The send path normally queues instead.
    if (this.isProcessing && this.client && this.openSessionId) {
      return this.steer(prompt, attachments)
    }

    this.endUserStop()
    this.isProcessing = true
    this.authHeld = false
    this.sendStatus()

    // ADR-093 §5 rule 2: a ChatGPT turn goes only on a token with time left.
    // Inside the establishing window, so a prompt queued meanwhile waits for
    // the answer (and is never posted ahead of this turn's prompt).
    const gate: { notice: string | null } = { notice: null }
    const establishing = this.establishSession().then(async () => {
      if (!this.client || this._cancelled || !this.openSessionId) return
      gate.notice = await opencodeAuthHooks()
        .beforeTurn(this.modelRef().providerID)
        .catch(() => null)
      if (gate.notice !== null) this.authHeld = true
    })
    this.establishingPromise = establishing
    try {
      await establishing
      if (!this.client || this._cancelled || !this.openSessionId) {
        this.isProcessing = false
        if (!this.conn) this.disconnected = true
        this.sendStatus()
        this.resetInactivityTimer()
        return
      }
      if (gate.notice !== null) {
        this.holdForAuth(gate.notice)
        return
      }
      this.startTimeMs = Date.now()
      await this.postUserPrompt(prompt, attachments)
    } catch (err) {
      logger.error('OpencodeSession', `run() error: ${errText(err)}`)
      this.isProcessing = false
      if (!this.conn) this.disconnected = true
      this.send('session:error', errText(err))
      this.sendStatus()
      this.resetInactivityTimer()
    } finally {
      this.establishingPromise = null
      // Items queued during the connect window go to the inbox now — not
      // while the turn is held for a ChatGPT sign-in: they would start one.
      if (!this.authHeld) void this.flushQueuedItems()
    }
  }

  /** A prompt into a running turn; a failed post is surfaced, never silently dropped. */
  private async steer(prompt: string, attachments?: AttachmentUpload[]): Promise<void> {
    try {
      await this.postUserPrompt(prompt, attachments)
    } catch (err) {
      logger.warn('OpencodeSession', `steer send failed: ${errText(err)}`)
      this.send('session:error', errText(err))
    }
  }

  /**
   * Post one user prompt the renderer already shows (the send path relays
   * `session:user-message`), under a ClaudeUI inbox id so its delivered row is
   * recognized as ours. History is rolled back when the post fails.
   */
  private async postUserPrompt(prompt: string, attachments?: AttachmentUpload[]): Promise<void> {
    const inboxID = newInboxId()
    const userMsg: ChatMessage = {
      id: uuid(),
      role: 'user',
      content: this.userMessageContent(prompt, attachments),
      timestamp: Date.now()
    }
    this.messageHistory.push(userMsg)
    this.ownInboxIds.add(inboxID)
    try {
      await this.postPrompt(prompt, attachments, inboxID, 'steer')
    } catch (err) {
      this.messageHistory = this.messageHistory.filter((m) => m !== userMsg)
      this.ownInboxIds.delete(inboxID)
      throw err
    }
  }

  /**
   * `POST …/prompt` (or `…/command` for a known `/command`, which takes no id
   * and falls back to a plain prompt when opencode refuses it).
   */
  private postPrompt(
    text: string,
    attachments: AttachmentUpload[] | undefined,
    inboxID: string,
    delivery: 'steer' | 'queue'
  ): Promise<void> {
    const post = this.postChain.then(() => this.postPromptNow(text, attachments, inboxID, delivery))
    this.postChain = post.catch(() => {})
    return post
  }

  private async postPromptNow(
    text: string,
    attachments: AttachmentUpload[] | undefined,
    inboxID: string,
    delivery: 'steer' | 'queue'
  ): Promise<void> {
    const client = this.client
    const sessionID = this.openSessionId
    if (!client || !sessionID) throw new Error('opencode session is not connected')
    await this.syncModel()
    const files = (attachments ?? []).map((att) => ({
      uri: `data:${att.mediaType};base64,${att.base64Data}`,
      ...(att.fileName ? { name: att.fileName } : {})
    }))
    const slash = text.match(/^\/(\S+)\s*([\s\S]*)$/)
    if (slash && this.knownCommandNames.has(slash[1])) {
      this.pendingCommandEchoes++
      try {
        await client.runCommand(sessionID, {
          name: slash[1],
          text: (slash[2] ?? '').trim(),
          ...(files.length > 0 ? { files } : {}),
          delivery
        })
        return
      } catch (err) {
        this.pendingCommandEchoes--
        logger.warn(
          'OpencodeSession',
          `runCommand(${slash[1]}) failed, sending the text as a prompt: ${errText(err)}`
        )
      }
    }
    await client.prompt(sessionID, {
      id: inboxID,
      text,
      ...(files.length > 0 ? { files } : {}),
      delivery
    })
  }

  /**
   * Connect, create or resume the opencode session, start the feed and apply
   * the permission mode — memoized by `run()` so a second prompt during the
   * connect window shares it (M-OC1).
   */
  private async establishSession(): Promise<void> {
    await this.ensureConnected()
    if (!this.client || this._cancelled) return

    // An eager resume in flight has set the id already: wait for its replay
    // (the mapper must be seeded before the feed starts).
    if (this.resuming) await this.resuming
    else if (!this.openSessionId && this.resumeSessionId) await this.resume(this.resumeSessionId)
    if (!this.client || this._cancelled) return

    if (!this.openSessionId) {
      const built = await this.buildRuleset(this.permissionMode)
      const agent = built.agent ?? (await this.defaultAgentId())
      const model = this.modelRef()
      // No title: opencode's default placeholder gates its own title generation.
      const created = await this.client.createSession({
        ...(agent ? { agent } : {}),
        model,
        permissions: built.rules
      })
      this.adoptSession(created)
      this.applied = {
        sessionId: created.id,
        rules: built.rules,
        key: JSON.stringify(built.rules)
      }
      this.lastUserRules = built.userRules
      this.appliedModelKey = this.modelKey(model)
      this.sendStatus()
    }

    await this.ensureFeed()
    if (this.needsPurge) await this.purgeStaleInbox()
    if (this.adoptChildrenOnConnect) await this.adoptStoredChildren()
    await this.applyPermissionMode()
  }

  /** Take an opencode session as this chat's (fresh mapper). */
  private adoptSession(info: Session_Info): void {
    this.openSessionId = info.id
    this.currentAgent = info.agent ?? null
    this.appliedModelKey = info.model ? this.modelKey(info.model) : null
    this.mapper = new OpencodeEventMapper({
      sessionID: info.id,
      ...(info.model ? { model: info.model } : {}),
      suggest: (action, resources) => suggestOpencodeAllowRule(action, [...resources])
    })
    this.needsCatchUp = false
  }

  /**
   * Resume `sessionId` if it still exists: replay its history, seed the
   * status line and the mapper, and arm the catch-up read for the feed's first
   * `connected`. A missing session falls back to a fresh one.
   */
  private resume(sessionId: string): Promise<void> {
    // Eager connect and the first prompt may both resume: one read, one replay,
    // and neither starts the feed before the mapper is seeded.
    this.resuming ??= this.resumeOnce(sessionId).finally(() => {
      this.resuming = null
    })
    return this.resuming
  }

  private async resumeOnce(sessionId: string): Promise<void> {
    if (!this.client) return
    let info: Session_Info
    try {
      info = await this.client.getSession(sessionId)
    } catch (err) {
      logger.warn(
        'OpencodeSession',
        `Resume session ${sessionId} not found — creating a fresh session: ${errText(err)}`
      )
      this.resumeSessionId = undefined
      return
    }
    if (this.openSessionId) return
    this.adoptSession(info)
    this.needsCatchUp = true
    this.needsPurge = true
    this.adoptChildrenOnConnect = true
    logger.info('OpencodeSession', `Resuming opencode session ${info.id}`)
    this.sendStatus()
    await this.replayStoredHistory(info)
  }

  /** Replay a resumed session's history once (memoized against eager connect + run racing). */
  private async replayStoredHistory(info: Session_Info): Promise<void> {
    if (this.replayedSessionId === info.id) return
    if (this.replayInFlight) return this.replayInFlight
    this.replayInFlight = this.replayStoredHistoryInner(info)
    try {
      await this.replayInFlight
      this.replayedSessionId = info.id
    } finally {
      this.replayInFlight = null
    }
  }

  private async replayStoredHistoryInner(info: Session_Info): Promise<void> {
    const client = this.client
    if (!client) return
    try {
      const { rows, children } = await readOpencodeHistory((id) => client.listMessages(id), info.id)
      const sessionTotals = { cost: info.cost, tokens: info.tokens }
      this.mapper?.seed(rows, { sessionTotals })
      const parsed = parseModelString(this._model)
      const seed = opencodeV2HistorySeed(rows, parsed, {
        children: children.values(),
        sessionTotals
      })
      this.costBase = seed.costInputs
      this.rawCostBaseUsd = seed.engineReportedCostUsd
      this.modelCostBase = seed.modelCosts
      this.tokenBase = seed.tokens
      this.lastContextLength = seed.lastContextLength
      this.accTotalDurationMs = seed.totalDurationMs
      this.seedDispatchedCosts()
      this.sendStatusLine()
      const history = convertOpencodeHistory(rows, children)
      logger.info(
        'OpencodeSession',
        `Replaying ${history.messages.length} stored messages for ${info.id}`
      )
      for (const message of history.messages) {
        this.rememberOpencodeMessage(message)
        this.send('session:message', message)
        for (const block of message.content) {
          if (block.type === 'tool_use' && block.toolInput)
            this.toolInputs.set(block.toolUseId, block.toolInput)
          if (block.type === 'tool_result')
            this.recordToolOutcome(block.toolUseId, block.isError ? 'error' : 'ok')
        }
      }
    } catch (err) {
      logger.warn('OpencodeSession', `replayStoredHistory failed for ${info.id}: ${errText(err)}`)
    }
  }

  /** Acquire the lease and build the client, exactly once (memoized, cancel-safe). */
  private async ensureConnected(): Promise<void> {
    if (this.conn) return
    if (!this.connectingPromise) {
      this.connectingPromise = (async () => {
        const c = await opencodeServerManager.acquire(this.cwd)
        if (this._cancelled) {
          opencodeServerManager.releaseIfCurrent(this.cwd, c)
          return
        }
        this.conn = c
        this.client = new OpencodeClient(c)
        // A new lease may be a different server (another config): re-read
        // what is per server, and re-assert the session's rules.
        this.knownMcpServers = null
        this.agentList = null
        this.worktree = undefined
        this.applied = null
        this.disconnected = false
        this.unsubscribeServerExit?.()
        this.unsubscribeServerExit = opencodeServerManager.subscribeExit(
          this.cwd,
          () => this.markDisconnected('opencode server exited', { serverGone: true }),
          c
        )
        this.unsubscribeConfigChanged?.()
        this.unsubscribeConfigChanged =
          opencodeServerManager.onConfigChanged?.(() => {
            this.agentList = null
          }) ?? null
      })().finally(() => {
        this.connectingPromise = null
      })
    }
    await this.connectingPromise
  }

  /** Warm the connection, publish commands/skills, replay a resumed session. Never throws. */
  private async eagerConnect(): Promise<void> {
    try {
      await this.ensureConnected()
      const client = this.client
      if (!client || this._cancelled) return
      const [commands, skills] = await Promise.all([
        client.commands().catch((err) => {
          logger.warn('OpencodeSession', `commands() failed: ${errText(err)}`)
          return []
        }),
        client.skills().catch((err) => {
          logger.warn('OpencodeSession', `skills() failed: ${errText(err)}`)
          return []
        })
      ])
      this.knownCommandNames = new Set(commands.map((c) => c.name))
      this.send(
        'session:slash-commands',
        commands.map((c) => ({ name: '/' + c.name, description: c.description }))
      )
      this.send(
        'session:skills',
        skills.map((s) => s.name)
      )
      if (this.resumeSessionId && !this.openSessionId) {
        await this.resume(this.resumeSessionId)
        // Follow a resumed session at once: a turn opencode resumes on its own
        // (a claim kept by a shutdown) and its pending asks show without a prompt.
        if (this.openSessionId && !this._cancelled) await this.ensureFeed()
      }
      // On ClaudeUI's own (global) server, never this session's: project
      // config must not leak into the global catalog. With the same config it
      // is this very server (one per config, S2), and it lingers after reads.
      await discoverOpencodeModels().catch(() => [])
      const nextCaps = this.resolveCapsForModel()
      if (
        nextCaps.vision !== this._capabilities.vision ||
        nextCaps.contextWindow !== this._capabilities.contextWindow
      ) {
        this._capabilities = nextCaps
        this.sendStatus()
        this.sendStatusLine()
      }
    } catch (err) {
      const detail =
        err instanceof OpencodePermissionGuardError
          ? `permission guard not active: ${err.reason}`
          : errText(err)
      logger.warn('OpencodeSession', `eagerConnect failed: ${detail}`)
    }
  }

  // ── The event feed ─────────────────────────────────────────────────────────

  /** Start the feed (once per lease) and wait for its first `connected` (+ catch-up). */
  private ensureFeed(): Promise<void> {
    if (this.feedAbort && this.feedReady) return this.feedReady
    const client = this.client
    if (!client || !this.mapper) return Promise.resolve()
    const abort = new AbortController()
    this.feedAbort = abort
    let ready!: () => void
    this.feedReady = new Promise<void>((resolve) => (ready = resolve))
    const readyNow = ready
    void this.consumeFeed(client, abort, readyNow).finally(() => readyNow())
    return this.feedReady
  }

  private async consumeFeed(
    client: OpencodeClient,
    abort: AbortController,
    ready: () => void
  ): Promise<void> {
    const { signal } = abort
    try {
      for await (const item of client.subscribeEvents({ signal })) {
        if (signal.aborted) break
        if (item.kind === 'connected') {
          if (item.reconnected || this.needsCatchUp) {
            this.needsCatchUp = false
            await this.catchUp(client)
          }
          ready()
          continue
        }
        if (item.kind === 'disconnected') {
          logger.info(
            'OpencodeSession',
            `event feed dropped (${item.error.message}); retrying in ${item.retryInMs} ms`
          )
          continue
        }
        this.handleEvent(item.event)
      }
    } catch (err) {
      if (!signal.aborted) logger.error('OpencodeSession', `event feed failed: ${errText(err)}`)
    } finally {
      const deliberate = signal.aborted
      if (this.feedAbort === abort) {
        this.feedAbort = null
        this.feedReady = null
      }
      if (!deliberate) this.markDisconnected('opencode connection lost — resend to reconnect')
    }
  }

  /** Re-read what a gap (or a resume) hid and apply it like live output (S4 contract). */
  private async catchUp(client: OpencodeClient): Promise<void> {
    const mapper = this.mapper
    if (!mapper) return
    try {
      const outputs = await reconcileAfterReconnect(client, mapper)
      for (const output of outputs) this.dispatch(output)
      await this.adoptUnknownChildren()
    } catch (err) {
      logger.warn('OpencodeSession', `reconnect catch-up failed: ${errText(err)}`)
    }
  }

  /** Raw hooks the mapper does not cover, then every mapper output. */
  private handleEvent(event: OpencodeEvent): void {
    if (event.type === 'session.created') this.onSessionCreated(event.data)
    else if (event.type === 'session.agent.selected') this.onAgentSelected(event.data)
    const mapper = this.mapper
    if (!mapper) return
    for (const output of mapper.map(event)) this.dispatch(output)
  }

  /** Dispatch one mapper output (the S4 results table). */
  private dispatch(o: OpencodeMapperOutput): void {
    switch (o.kind) {
      case 'turn-start':
        if (!this.isProcessing) {
          this.isProcessing = true
          this.startTimeMs = Date.now()
          this.clearInactivityTimer()
          this.sendStatus()
        }
        return
      case 'item-open': {
        const { target } = o.open
        this.openItems.set(this.itemKey(target), {
          target,
          message: structuredClone(o.open.message)
        })
        if (!target.ownerToolUseId) this.rememberOpencodeMessage(o.open.message)
        this.send('session:item-open', o.open)
        return
      }
      case 'item-delta': {
        const open = this.openItems.get(this.itemKey(o.target))
        const block = open?.message.content[o.target.blockIndex]
        if (block && (block.type === 'text' || block.type === 'thinking')) block.text += o.chunk
        this.send('session:item-delta', { target: o.target, chunk: o.chunk })
        return
      }
      case 'item-seal': {
        const { seal } = o
        if (seal.target) this.openItems.delete(this.itemKey(seal.target))
        else
          for (const [key, open] of this.openItems)
            if (open.target.messageId === seal.message.id) this.openItems.delete(key)
        if (!seal.ownerToolUseId && !seal.target?.ownerToolUseId)
          this.rememberOpencodeMessage(seal.message)
        this.send('session:item-seal', seal)
        return
      }
      case 'message':
        this.noteToolInputs(o.message)
        if (o.ownerToolUseId) {
          this.send('session:subagent-message', {
            toolUseId: o.ownerToolUseId,
            message: o.message
          })
        } else {
          this.rememberOpencodeMessage(o.message)
          this.send('session:message', o.message)
        }
        return
      case 'user-message':
        this.onUserMessage(o.inboxID, o.message)
        return
      case 'tool-input-delta':
        return
      case 'tool-result':
        this.onToolResult(o.result, o.ownerToolUseId)
        return
      case 'permission-denial':
        // A child's call is not a top-level block the reducer can attach to.
        if (!o.ownerToolUseId)
          this.send('session:permission-denial', { toolUseId: o.toolUseId, denial: o.denial })
        return
      case 'shell-started':
        if (!o.ownerToolUseId && this.client)
          this.shellPoller.start(o.toolUseId, o.shellID, this.client)
        return
      case 'subagent-started':
        // A resumed child re-links under a newer call: re-assert its ruleset.
        if (this.children.has(o.childSessionId)) void this.patchChild(o.childSessionId)
        else void this.adoptUnknownChildren()
        return
      case 'task-notification':
        this.send('session:task-notification', o.notification)
        return
      case 'approval':
        this.onApproval(o.approval, o.route)
        return
      case 'approval-resolved':
        this.takePendingAsk(o.requestId)
        this.pendingForms.delete(o.requestId)
        this.routes.delete(o.requestId)
        this.send('session:approval-dismiss', { requestId: o.requestId })
        return
      case 'step-usage':
        this.meterStep(o.usage)
        return
      case 'session-usage':
        return
      case 'overhead-usage': {
        const { providerID, modelID } = parseModelString(this._model)
        this.addLiveUsage(providerID, modelID, o.cost, o.tokens, false)
        this.sendStatusLine()
        return
      }
      case 'compaction':
        if (o.usage) {
          const fallback = parseModelString(this._model)
          this.addLiveUsage(
            o.usage.model?.providerID ?? fallback.providerID,
            o.usage.model?.id ?? fallback.modelID,
            o.usage.cost,
            o.usage.tokens,
            false
          )
          this.sendStatusLine()
        }
        return
      case 'retry':
        logger.info(
          'OpencodeSession',
          `opencode retries the request (attempt ${o.attempt}): ${o.error.message}`
        )
        return
      case 'inbox':
        this.onInbox(o)
        return
      case 'agent-selected':
        this.currentAgent = o.agent
        return
      case 'model-selected':
        this.appliedModelKey = this.modelKey(o.model)
        return
      case 'session-renamed':
        return
      case 'session-deleted':
        logger.warn('OpencodeSession', `opencode session ${this.openSessionId} was deleted`)
        return
      case 'result':
        this.endTurn(o.durationMs, o.sessionId)
        return
      case 'stopped':
        this.onStopped(o.reason)
        this.endTurn(o.durationMs, o.sessionId)
        return
      case 'error':
        // ADR-090: a turn the user stopped may still end in an error; not news.
        if (!this.suppressedAfterUserStop('OpencodeSession', o.message))
          this.send('session:error', o.message)
        this.endTurn(o.durationMs, o.sessionId)
        return
      case 'auth-required': {
        // ADR-068 §4 / ADR-070 §1: one event naming the provider, BEFORE the
        // status leaves `running` (the reducer captures the retry while running).
        const providerId = opencodeAuthRequiredProviderId(o.vendorId)
        this.send('session:auth-required', { providerId, message: o.message })
        // §5 rule 3: refresh and rotate now (the vault decides whether it is ours).
        opencodeAuthHooks().authFailed(o.vendorId)
        this.rememberAndSend(authErrorTranscriptMessage(uuid(), o.message, providerId))
        this.endTurn(o.durationMs, o.sessionId)
        return
      }
    }
  }

  /**
   * A turn held before it was sent (§5 rule 2): the same auth notice a failed
   * turn gives, BEFORE the status leaves running, and nothing is posted.
   */
  private holdForAuth(message: string): void {
    const providerId = opencodeAuthRequiredProviderId(this.modelRef().providerID)
    this.send('session:auth-required', { providerId, message })
    this.rememberAndSend(authErrorTranscriptMessage(uuid(), message, providerId))
    this.isProcessing = false
    this.sendStatus()
    this.resetInactivityTimer()
  }

  private itemKey(target: ItemStreamTarget): string {
    return JSON.stringify([target.messageId, target.blockIndex, target.ownerToolUseId ?? ''])
  }

  private noteToolInputs(message: ChatMessage): void {
    for (const block of message.content) {
      if (block.type === 'tool_use' && block.toolInput && Object.keys(block.toolInput).length > 0)
        this.toolInputs.set(block.toolUseId, block.toolInput)
    }
  }

  /**
   * A user row opencode delivered. Ours (a direct prompt, a queue item — the
   * queue's consume paints it — or a command expansion) is already shown; a
   * prompt another client posted into this session is painted here.
   */
  private onUserMessage(inboxID: string, message: ChatMessage): void {
    if (this.ownInboxIds.delete(inboxID) || this.inboxToItem.has(inboxID)) return
    if (inboxID.startsWith(CLAUDEUI_INBOX_PREFIX)) return
    if (this.pendingCommandEchoes > 0) {
      this.pendingCommandEchoes--
      return
    }
    this.rememberAndSend(message)
  }

  private onToolResult(result: OpencodeToolResult, ownerToolUseId: string | undefined): void {
    const extras = {
      ...(result.fileDiffs ? { fileDiffs: result.fileDiffs } : {}),
      ...(result.images ? { images: result.images } : {})
    }
    if (ownerToolUseId) {
      this.send('session:subagent-tool-result', {
        toolUseId: ownerToolUseId,
        toolResultToolUseId: result.toolUseId,
        result: result.result,
        isError: result.isError,
        ...extras
      })
      return
    }
    this.shellPoller.stop(result.toolUseId)
    this.bashStreamGate.cancel(result.toolUseId)
    this.recordToolOutcome(result.toolUseId, result.isError ? 'error' : 'ok')
    this.send('session:tool-result', {
      toolUseId: result.toolUseId,
      result: result.result,
      isError: result.isError,
      ...extras
    })
  }

  /** A turn that opencode stopped (ADR-090: the user's own stop shows nothing). */
  private onStopped(reason: OpencodeStopReason): void {
    if (reason === 'user') return
    if (reason === 'denied' || reason === 'form-cancelled') {
      // ClaudeUI never sends a messageless reject or cancel; another client did.
      logger.warn('OpencodeSession', `turn ended by a messageless ${reason} reply`)
      return
    }
    const notice = STOP_NOTICES[reason]
    if (notice && !this.suppressedAfterUserStop('OpencodeSession', notice))
      this.send('session:warning', notice)
  }

  /** The turn's end bookkeeping, whatever ended it (result, stop, error, auth). */
  private endTurn(durationMs: number, sessionId: string): void {
    this.isProcessing = false
    this.accTotalDurationMs += durationMs
    this.sendMetering()
    this.sendStatusLine()
    blockUsageService.recalculate().catch(() => {})
    this.send('session:result', {
      totalCostUsd: this.totalCostUsd,
      durationMs,
      result: '',
      sessionId
    })
    this.sendStatus()
    this.resetInactivityTimer()
    this.endUserStop()
    // A queued item whose post failed gets another chance at every turn end.
    void this.flushQueuedItems()
  }

  // ── Queue (ADR-093 §9 over ADR-053's queue of record) ──────────────────────

  /** A prompt typed while busy: posted to the inbox at once (see the file header). */
  protected override onPromptQueued(item: QueuedItem): void {
    void this.postQueuedItem(item)
  }

  /** Post every queued item not in the inbox yet (after a connect, a failed post). */
  protected override async flushQueuedItems(): Promise<void> {
    for (const item of this.queue.pending()) {
      if (!this.queue.isForwarded(item)) await this.postQueuedItem(item)
    }
  }

  private async postQueuedItem(item: QueuedItem): Promise<void> {
    if (this.establishingPromise) await this.establishingPromise.catch(() => {})
    // Held for a ChatGPT sign-in (§5 rule 2): it stays queued for the next prompt.
    if (this.authHeld) return
    if (item.state !== 'queued' || this.queue.isForwarded(item)) return
    if (!this.client || !this.openSessionId) return // the next connect flushes it
    const inboxID = newInboxId()
    this.queue.markForwarded(item)
    this.inboxToItem.set(inboxID, item.itemId)
    this.itemToInbox.set(item.itemId, inboxID)
    const post = this.postPrompt(item.text, this.queuedUploads(item), inboxID, QUEUE_ITEM_DELIVERY)
    this.posting.set(
      item.itemId,
      post.catch(() => {})
    )
    try {
      await post
    } catch (err) {
      this.queue.unmarkForwarded(item)
      this.inboxToItem.delete(inboxID)
      this.itemToInbox.delete(item.itemId)
      logger.warn('OpencodeSession', `queued prompt not posted: ${errText(err)}`)
      this.send('session:error', `The queued message could not be sent: ${errText(err)}`)
    } finally {
      this.posting.delete(item.itemId)
    }
  }

  /**
   * Take back one item. Held only by core → yes. In the inbox → `DELETE`;
   * opencode answers 204 even when the item was delivered meanwhile, so the
   * stored row decides: a user row with the inbox id = delivered (not taken
   * back; its `delivered` event consumes it).
   */
  protected override async tryRecallQueuedItem(item: QueuedItem): Promise<boolean> {
    await this.posting.get(item.itemId)
    if (!this.queue.isForwarded(item)) return true
    const inboxID = this.itemToInbox.get(item.itemId)
    const client = this.client
    const sessionID = this.openSessionId
    if (!inboxID || !client || !sessionID) return false
    try {
      await client.cancelInbox(sessionID, inboxID)
    } catch (err) {
      logger.warn('OpencodeSession', `inbox cancel failed: ${errText(err)}`)
      return false
    }
    try {
      await client.call('session.message.get', { params: { sessionID, messageID: inboxID } })
      return false
    } catch (err) {
      if ((err as { status?: unknown }).status !== 404) return false
    }
    this.inboxToItem.delete(inboxID)
    this.itemToInbox.delete(item.itemId)
    return true
  }

  /**
   * Take back ONE queued item (by id) — the engine half of a per-item dequeue.
   * Returns whether it was taken back (false: delivered, or unknown).
   */
  async dequeueItem(itemId: string): Promise<boolean> {
    const item = this.queue.pending().find((candidate) => candidate.itemId === itemId)
    if (!item) return false
    const taken = await this.tryRecallQueuedItem(item)
    if (taken && item.state === 'queued') {
      this.queue.setState(item, 'recalled')
      this.queue.emit()
    }
    return taken
  }

  /** Move a posted queue item between `steer` and `queue` (`PATCH …/inbox/:id`). */
  async setQueuedItemDelivery(itemId: string, delivery: 'steer' | 'queue'): Promise<boolean> {
    const inboxID = this.itemToInbox.get(itemId)
    if (!inboxID || !this.client || !this.openSessionId) return false
    try {
      await this.client.setInboxDelivery(this.openSessionId, inboxID, delivery)
      return true
    } catch (err) {
      logger.warn('OpencodeSession', `inbox delivery change failed: ${errText(err)}`)
      return false
    }
  }

  private onInbox(o: Extract<OpencodeMapperOutput, { kind: 'inbox' }>): void {
    const itemId = this.inboxToItem.get(o.inboxID)
    if (!itemId) return
    if (o.change === 'delivered') {
      const item = this.queue.pending().find((candidate) => candidate.itemId === itemId)
      if (item) {
        // The judge's transcript gets the user's word where the model read it.
        this.messageHistory.push({
          id: `steer-${itemId}`,
          role: 'user',
          content: this.userMessageContent(item.text, this.queuedUploads(item)),
          timestamp: Date.now()
        })
      }
      this.inboxToItem.delete(o.inboxID)
      this.itemToInbox.delete(itemId)
      if (this.queue.consumeById(itemId)) this.queue.emit()
    } else if (o.change === 'cancelled') {
      this.inboxToItem.delete(o.inboxID)
      this.itemToInbox.delete(itemId)
      if (this.queue.recallById(itemId)) this.queue.emit()
    }
  }

  /**
   * Cancel ClaudeUI inbox items no queue item stands behind any more (a
   * teardown or a dead server left them): delivered later they would run a
   * message the queue card already reported as taken back.
   */
  private async purgeStaleInbox(): Promise<void> {
    const client = this.client
    const sessionID = this.openSessionId
    if (!client || !sessionID) return
    this.needsPurge = false
    try {
      const inbox = await client.listInbox(sessionID)
      for (const item of inbox) {
        if (!item.id.startsWith(CLAUDEUI_INBOX_PREFIX) || this.inboxToItem.has(item.id)) continue
        if (item.type === 'user' && this.ownInboxIds.has(item.id)) continue
        await client.cancelInbox(sessionID, item.id).catch(() => {})
        logger.info('OpencodeSession', `cancelled a stale queued inbox item`)
      }
    } catch (err) {
      logger.debug('OpencodeSession', `inbox read skipped: ${errText(err)}`)
    }
  }

  // ── Interrupt / teardown ───────────────────────────────────────────────────

  async interrupt(): Promise<void> {
    // ADR-090: open the window before the request — the end can beat the reply.
    if (this.isProcessing) this.beginUserStop()
    if (!this.client || !this.openSessionId) return
    try {
      // `resume`: queued steers still run after the stop, as 1.x flushed them
      // at the stopped turn's end; ArrowUp takes them back first.
      await this.client.interrupt(this.openSessionId, { resume: true })
    } catch (err) {
      logger.warn('OpencodeSession', `interrupt failed: ${errText(err)}`)
    }
  }

  /**
   * Idempotent teardown for every connection LOSS (server death, a feed that
   * gave up): drop the lease (exactly — another session may hold a
   * replacement server), retract what can no longer be answered.
   */
  private markDisconnected(reason: string, options: { serverGone?: boolean } = {}): void {
    if (this.disconnected && !this.conn) return
    this.disconnected = true
    this.feedAbort?.abort()
    this.feedAbort = null
    this.feedReady = null
    this.needsCatchUp = true
    this.needsPurge = true
    this.shellPoller.stopAll()
    this.sealOpenItems()
    if (this.isProcessing) {
      this.isProcessing = false
      this.send('session:error', reason)
    }
    this.unsubscribeServerExit?.()
    this.unsubscribeServerExit = null
    this.unsubscribeConfigChanged?.()
    this.unsubscribeConfigChanged = null
    const conn = this.conn
    const client = this.client
    this.conn = null
    this.client = null
    // A feed that gave up may sit on a LIVE server: stop and take back like a
    // teardown. A dead server has nothing left to stop.
    if (conn) this.endLease(conn, options.serverGone ? null : client)
    this.recallQueuedOnEngineLoss()
    this.dismissAllCards()
    // The cards are gone; asks still pending server-side must come back on the
    // next connect's re-read.
    this.mapper?.forgetRequests()
    this.sendStatus()
  }

  cancel(): void {
    this.clearInactivityTimer()
    this._cancelled = true
    this.isProcessing = false
    this.endUserStop()
    this.disconnected = true
    this.lastContextLength = 0
    this.feedAbort?.abort()
    this.feedAbort = null
    this.feedReady = null
    this.needsCatchUp = true
    this.needsPurge = true
    this.sealOpenItems()
    this.shellPoller.stopAll()
    this.bashStreamGate.cancelAll()
    this.applied = null
    crossEngineDispatcher.disposeFor(this.routingId)
    this.unsubscribeServerExit?.()
    this.unsubscribeServerExit = null
    this.unsubscribeConfigChanged?.()
    this.unsubscribeConfigChanged = null
    const conn = this.conn
    const client = this.client
    this.conn = null
    this.client = null
    if (conn) this.endLease(conn, client)
    this.recallQueuedOnEngineLoss()
    this.dropBlockHolds()
    this.sendStatus()
  }

  /**
   * End a lease, stopping first what this chat runs on the server: the last
   * lease ends the server, and a shutdown keeps a running execution's claim —
   * opencode would resume it headless on its next start (`execution.ts`), and
   * a parked inbox item would run with it.
   *
   * So, best-effort and bounded by TEARDOWN_GRACE_MS: interrupt the own
   * session and every child whose call is still open (idle or not — an idle
   * interrupt is a no-op upstream, and a turn ClaudeUI has not seen yet or a
   * background child runs anyway), cancel ClaudeUI's undelivered inbox items,
   * then wait until `GET /api/session/active` lists none of them (the
   * interrupt route answers before its cleanup settles). `client` null = the
   * server is gone: just release.
   */
  private endLease(conn: ServerConnection, client: OpencodeClient | null): void {
    const release = () => opencodeServerManager.releaseIfCurrent(this.cwd, conn)
    const sessionID = this.openSessionId
    const inboxIDs = [...this.inboxToItem.keys()]
    this.inboxToItem.clear()
    this.itemToInbox.clear()
    if (!client || !sessionID) {
      release()
      return
    }
    const followed = this.mapper?.followedSessions() ?? []
    const sessions = [sessionID, ...followed.filter((id) => id !== sessionID)]
    let over = false
    const stop = (async () => {
      await Promise.allSettled([
        ...sessions.map((id) => Promise.resolve().then(() => client.interrupt(id))),
        ...inboxIDs.map((id) => Promise.resolve().then(() => client.cancelInbox(sessionID, id)))
      ])
      while (!over) {
        const active = await client.activeSessions()
        if (!sessions.some((id) => id in active)) return
        await new Promise((done) => setTimeout(done, 100))
      }
    })()
    let timer: ReturnType<typeof setTimeout> | undefined
    const grace = new Promise<void>((done) => (timer = setTimeout(done, TEARDOWN_GRACE_MS)))
    void Promise.race([stop.catch(() => {}), grace]).finally(() => {
      over = true
      clearTimeout(timer)
      release()
    })
  }

  dispose(): void {
    this.cancel()
  }

  /** Seal every open item stream with what streamed so far (nothing will finish it). */
  private sealOpenItems(): void {
    for (const { target, message } of this.openItems.values()) {
      this.send('session:item-seal', {
        target,
        message,
        ...(target.ownerToolUseId ? { ownerToolUseId: target.ownerToolUseId } : {})
      })
    }
    this.openItems.clear()
  }

  /** The engine is gone: no pending ask or form can be answered any more. */
  private dismissAllCards(): void {
    const ids = new Set([...this.pendingApprovals.keys(), ...this.pendingForms.keys()])
    for (const requestId of ids) {
      this.takePendingAsk(requestId)
      this.pendingForms.delete(requestId)
      this.routes.delete(requestId)
      this.send('session:approval-dismiss', { requestId })
    }
  }

  // ── Approvals and forms ────────────────────────────────────────────────────

  private onApproval(approval: PendingApproval, route: OpencodeApprovalRoute): void {
    this.routes.set(approval.requestId, route.sessionID)
    if (route.form) {
      const input = approval.input as { questions?: AskUserQuestion[] }
      this.pendingForms.set(approval.requestId, {
        sessionID: route.sessionID,
        formID: route.form.formID,
        fields: route.form.fields,
        questions: input.questions ?? []
      })
      // A question is the human's, in every autonomy mode.
      this.send('session:approval-request', approval)
      return
    }
    this.pendingApprovals.set(approval.requestId, {
      toolUseId: approval.toolUseId,
      approval,
      sweepable: true
    })
    if (approval.subagent && this.refuseByChildAgent(approval, route.sessionID)) return
    this.routePermissionAsk(approval)
  }

  /**
   * S6 backstop: a child's ask its OWN agent denies (the window before the
   * child's ruleset PATCH lands, or a deny the agent carves itself) is
   * refused here with the agent's verdict.
   */
  private refuseByChildAgent(approval: PendingApproval, childID: string): boolean {
    const child = this.children.get(childID)
    if (!child) return false
    if (child.unpatched) {
      logger.info(
        'OpencodeSession',
        `child ask ${approval.toolName} refused: its ruleset is not applied`
      )
      this.autoReply(approval.requestId, {
        decision: 'reject',
        message:
          "ClaudeUI could not apply this subagent's permission rules, so its tool calls are refused"
      })
      return true
    }
    const agent = this.agentInfo(child.agent)
    if (!agent) return false
    const resources = approval.patterns && approval.patterns.length > 0 ? approval.patterns : ['*']
    const denied = resources.find(
      (resource) => evaluateChildCall(agent.permissions, approval.toolName, resource) === 'deny'
    )
    if (denied === undefined) return false
    const reason = `Denied by the ${agent.id} agent's permission rules: ${approval.toolName}(${denied})`
    logger.info(
      'OpencodeSession',
      `child ask ${approval.toolName} refused by its agent ${agent.id}`
    )
    this.autoReply(approval.requestId, { decision: 'reject', message: reason })
    return true
  }

  resolveApproval(
    requestId: string,
    decision: ApprovalDecision,
    answers?: Record<string, string>,
    updatedPermissions?: PermissionSuggestion[]
  ): void {
    const form = this.pendingForms.get(requestId)
    if (form) {
      this.pendingForms.delete(requestId)
      this.answerForm(form, decision, answers)
      return
    }
    const pending = this.takePendingAsk(requestId)
    const toolUseId = pending?.toolUseId
    if (!this.client) return
    const allow = decision === 'allow' || decision === 'allowForSession'

    // A held auto-mode block (ADR-091 §3): override this ONE call either way.
    if (pending?.hold) {
      if (allow) {
        this.autoDenials.recordAllow()
        if (toolUseId) this.blockedCalls.approveHeld(toolUseId)
        this.replyPermission(requestId, { decision: 'once' })
      } else {
        this.keepBlocked(requestId, toolUseId, pending.hold.reason)
      }
      return
    }
    const persist = allow && !!updatedPermissions && updatedPermissions.length > 0
    if (!allow && toolUseId) this.recordToolOutcome(toolUseId, 'rejected-by-user')
    // ADR-085 S2: never `always` (opencode's saved table is shared with the
    // user's own opencode); a session allow is remembered host-side. A reject
    // always carries the model-visible reason (ADR-093 §3).
    this.replyPermission(
      requestId,
      allow
        ? { decision: 'once' }
        : { decision: 'reject', message: answers?.feedback?.trim() || DEFAULT_REJECT_MESSAGE }
    )
    if (allow && (decision === 'allowForSession' || persist) && pending?.approval.always) {
      this.sessionAllows.add(pending.approval.toolName, pending.approval.always)
      this.sweepSessionAllows()
    }
    if (persist) persistAllowSuggestions(updatedPermissions!, this.cwd, 'OpencodeSession')
  }

  /**
   * Answer a form: `{<field key>: value}` — a string for a single choice, a
   * list for a multiselect, the OPTION VALUE for a chosen label. Anything else
   * cancels it WITH a message (a messageless cancel ends the turn).
   */
  private answerForm(
    form: PendingForm,
    decision: ApprovalDecision,
    answers?: Record<string, string>
  ): void {
    const client = this.client
    if (!client) return
    const cancel = (message: string) => {
      try {
        void client.cancelForm(form.sessionID, form.formID, message).catch((err) => {
          logger.warn('OpencodeSession', `form cancel failed: ${errText(err)}`)
        })
      } catch (err) {
        logger.warn('OpencodeSession', `form cancel refused: ${errText(err)}`)
      }
    }
    const allow = decision === 'allow' || decision === 'allowForSession'
    if (!allow || !answers) {
      cancel(answers?.feedback?.trim() || FORM_DISMISSED_MESSAGE)
      return
    }
    const answer: Record<string, string | string[]> = {}
    form.fields.forEach((field, i) => {
      const question = form.questions[i]
      const raw = answers[question?.question || `q${i}`] ?? ''
      const value = (label: string) => field.values?.[label] ?? label
      // The card joins a multiselect's labels with ', '.
      answer[field.key] = field.multiSelect ? (raw ? raw.split(', ').map(value) : []) : value(raw)
    })
    void client.replyForm(form.sessionID, form.formID, answer as Form_Answer).catch((err) => {
      // An answer opencode refuses would leave the tool waiting: cancel it, with a reason.
      logger.warn('OpencodeSession', `form reply failed: ${errText(err)}`)
      cancel('The answer could not be submitted')
    })
  }

  /** Reply to a permission ask on the session that asked. Never throws. */
  private replyPermission(requestId: string, reply: PermissionReply): void {
    const client = this.client
    const sessionID = this.routes.get(requestId) ?? this.openSessionId
    if (!client || !sessionID) return
    const safe: PermissionReply =
      reply.decision === 'reject'
        ? { decision: 'reject', message: reply.message.trim() || DEFAULT_REJECT_MESSAGE }
        : reply
    try {
      void client.replyPermission(sessionID, requestId, safe).catch((err) => {
        logger.warn('OpencodeSession', `replyPermission failed: ${errText(err)}`)
      })
    } catch (err) {
      logger.warn('OpencodeSession', `replyPermission refused: ${errText(err)}`)
    }
  }

  /** Settle one ask programmatically (pre-check, session allow, judge). */
  private autoReply(requestId: string, reply: PermissionReply): void {
    this.takePendingAsk(requestId)
    this.replyPermission(requestId, reply)
  }

  // ── Model / mode / settings ────────────────────────────────────────────────

  async setModel(model: string): Promise<void> {
    this._model = model
    this._capabilities = this.resolveCapsForModel()
    this.reasoningVariant = null
    this.sendStatus()
    this.sendStatusLine()
  }

  setReasoningVariant(variant: string | null): void {
    this.reasoningVariant = variant
  }

  async setPermissionMode(mode: string): Promise<void> {
    this.permissionMode = mode
    if (this.openSessionId && this.client) {
      // Fail closed at the PROMPT boundary (run re-applies); here a failure is a banner.
      try {
        await this.applyPermissionMode()
      } catch (err) {
        this.send('session:error', errText(err))
      }
    }
    this.send('session:permission-mode', mode)
  }

  async notifySettingsChanged(): Promise<void> {
    if (!this.client || !this.openSessionId) return
    try {
      await this.applyPermissionMode()
    } catch (err) {
      logger.warn(
        'OpencodeSession',
        `notifySettingsChanged: rule refresh failed, keeping the active ruleset: ${errText(err)}`
      )
    }
  }

  /**
   * Put the CURRENT mode's ruleset and agent on the opencode session (S6).
   * Serialized: a mode switch racing a turn's establish applies in call order,
   * each reading the mode when it runs, so the last one leaves the session on
   * the mode the UI shows.
   */
  private applyPermissionMode(): Promise<void> {
    const apply = this.applyChain.then(() => this.applyPermissionModeNow())
    this.applyChain = apply.catch(() => {})
    return apply
  }

  /**
   * PATCH (which REPLACES) only when the rules changed, then every child whose
   * rules were computed from another parent ruleset (settled ones too: a later
   * call can resume them), then `switchAgent` (`plan` in plan mode, else the
   * default). PATCH first: every half-applied state that leaves is the
   * stricter one. Fails CLOSED (throws) — run() then never posts the prompt; a
   * failed `switchAgent` is retried by the next apply (the agent is compared,
   * not remembered as done).
   */
  private async applyPermissionModeNow(): Promise<void> {
    const client = this.client
    const sessionId = this.openSessionId
    if (!client || !sessionId) return
    const mode = this.permissionMode
    const fail = (err: unknown): Error => {
      const detail = errText(err)
      logger.error(
        'OpencodeSession',
        `permission apply failed (refusing to run ungated): ${detail}`
      )
      return new Error(
        `Could not apply permission mode "${mode}" to the opencode session: ${detail}`
      )
    }
    const built = await this.buildRuleset(mode)
    this.lastUserRules = built.userRules
    const key = JSON.stringify(built.rules)
    const agent = built.agent ?? (await this.defaultAgentId())
    if (!(this.applied?.sessionId === sessionId && this.applied.key === key)) {
      try {
        await client.setSessionPermissions(sessionId, built.rules)
      } catch (err) {
        throw fail(err)
      }
      this.applied = { sessionId, rules: built.rules, key }
    } else {
      logger.debug('OpencodeSession', 'permission ruleset unchanged — no PATCH')
    }
    this.repatchChildren()
    if (agent && this.currentAgent !== agent) {
      try {
        await client.switchAgent(sessionId, agent)
      } catch (err) {
        throw fail(err)
      }
      this.currentAgent = agent
    }
  }

  /** The session ruleset for `mode` (S6 `buildSessionRuleset` with this chat's inputs). */
  private async buildRuleset(mode: string): Promise<ReturnType<typeof buildSessionRuleset>> {
    const autoMode = this.isAutoMode(mode)
    const [mcpServers, worktree, externalDirAllows] = await Promise.all([
      this.resolveMcpServers(),
      this.resolveWorktree(),
      autoMode ? this.primaryAgentDirAllows(mode) : Promise.resolve(undefined)
    ])
    return buildSessionRuleset({
      mode,
      autoMode,
      permissions: this.mergedUserPermissions(),
      mcpServers,
      cwd: this.cwd,
      ...(worktree ? { worktree } : {}),
      ...(externalDirAllows ? { externalDirAllows } : {})
    })
  }

  private mergedUserPermissions(): ClaudePermissions {
    const merged: ClaudePermissions = {
      allow: [],
      deny: [],
      ask: [],
      additionalDirectories: [],
      defaultMode: undefined
    }
    try {
      const scopes: PermissionScope[] = ['user', 'project', 'local']
      for (const scope of scopes) {
        const p = loadClaudePermissions(scope, this.cwd)
        merged.allow.push(...p.allow)
        merged.ask.push(...p.ask)
        merged.deny.push(...p.deny)
        merged.additionalDirectories.push(...p.additionalDirectories)
      }
    } catch (err) {
      logger.warn('OpencodeSession', `loading user permission rules failed: ${errText(err)}`)
    }
    return merged
  }

  private staticMcpServers(): string[] {
    return [
      ...new Set([...Object.keys(collectClaudeMcpForOpencode(this.cwd)), CLAUDEUI_MCP_SERVER])
    ]
  }

  /** Bridged + `claudeui` + `GET /api/mcp` names (cached per lease; a failure is not). */
  private async resolveMcpServers(): Promise<string[]> {
    if (this.knownMcpServers) return this.knownMcpServers
    const known = this.staticMcpServers()
    try {
      const servers = (await this.client?.mcpServers()) ?? []
      this.knownMcpServers = [...new Set([...known, ...servers.map((s) => s.name)])]
      return this.knownMcpServers
    } catch (err) {
      if (!this.mcpStatusWarned) {
        this.mcpStatusWarned = true
        logger.warn(
          'OpencodeSession',
          `GET /api/mcp failed — bridged servers only: ${errText(err)}`
        )
      }
      return known
    }
  }

  /** The location's git worktree root — where 2.x stops spelling paths relatively. */
  private async resolveWorktree(): Promise<string | undefined> {
    if (this.worktree !== undefined) return this.worktree ?? undefined
    try {
      const location = await this.client?.call('location.get', {})
      const dir = location?.project?.directory
      // A location outside any repository reports the filesystem root, which
      // 2.x does not treat as a worktree either (`file-access.ts`).
      this.worktree =
        typeof dir === 'string' && dir !== '' && parsePath(dir).root !== dir ? dir : null
    } catch (err) {
      logger.debug('OpencodeSession', `GET /api/location failed: ${errText(err)}`)
      return undefined
    }
    return this.worktree ?? undefined
  }

  private async loadAgents(): Promise<Agent_Info[] | null> {
    if (this.agentList) return this.agentList
    try {
      const listed = await this.client?.agents()
      if (!Array.isArray(listed)) throw new Error('GET /api/agent did not return a list')
      this.agentList = [...listed]
      return this.agentList
    } catch (err) {
      if (!this.agentsWarned) {
        this.agentsWarned = true
        logger.warn('OpencodeSession', `GET /api/agent failed: ${errText(err)}`)
      }
      return null
    }
  }

  /** opencode's default primary agent: `agent.list()` puts it first. */
  private async defaultAgentId(): Promise<string | undefined> {
    const agents = await this.loadAgents()
    const first = agents?.[0]
    return first && first.mode !== 'subagent' ? first.id : undefined
  }

  /** A cached agent by id (the default agent for an unnamed one). */
  private agentInfo(id: string | undefined): Agent_Info | undefined {
    const agents = this.agentList
    if (!agents) return undefined
    return id ? agents.find((agent) => agent.id === id) : agents[0]
  }

  /** Auto mode: the primary agent's allows for opencode's own directories (S6). */
  private async primaryAgentDirAllows(mode: string): Promise<V2Rule[]> {
    const agents = await this.loadAgents()
    if (!agents) return []
    const agent =
      mode === 'plan'
        ? agents.find((a) => a.id === 'plan')
        : agents.find((a) => a.mode !== 'subagent')
    return agent ? opencodeOwnDirAllows(agent.permissions) : []
  }

  // ── Subagent children (S6 seam) ────────────────────────────────────────────

  private onSessionCreated(data: { sessionID: string; parentID?: string; agent?: string }): void {
    const { sessionID, parentID } = data
    if (!parentID || sessionID === this.openSessionId) return
    if (parentID !== this.openSessionId && !this.children.has(parentID)) return
    if (!this.children.has(sessionID))
      this.children.set(sessionID, {
        parentID,
        chain: Promise.resolve(),
        ...(data.agent ? { agent: data.agent } : {})
      })
    void this.patchChild(sessionID)
  }

  private onAgentSelected(data: { sessionID: string; agent: string }): void {
    const child = this.children.get(data.sessionID)
    if (!child || child.agent === data.agent) return
    child.agent = data.agent
    void this.patchChild(data.sessionID, true)
  }

  /** Re-derive every direct child (each cascades to its own); unchanged parents are skipped. */
  private repatchChildren(): void {
    for (const [childID, child] of this.children)
      if (child.parentID === this.openSessionId) void this.patchChild(childID)
  }

  /**
   * PATCH `childSessionRuleset(parent's rules, its agent's rules)` onto a
   * child, then onto its own children — skipped when the parent ruleset it was
   * computed from is unchanged (`force`: its agent changed). Serialized per
   * child, and the parent's rules are read only after every await, so the
   * last PATCH to land is always the newest one.
   */
  private patchChild(childID: string, force = false): Promise<void> {
    const child = this.children.get(childID)
    if (!child) return Promise.resolve()
    const next = child.chain.then(() => this.patchChildNow(childID, force))
    child.chain = next.catch(() => {})
    return next
  }

  private async patchChildNow(childID: string, force: boolean): Promise<void> {
    const child = this.children.get(childID)
    const client = this.client
    if (!child || !client) return
    if (childPatchGate) await childPatchGate(childID)
    await this.loadAgents()
    const parentRules =
      child.parentID === this.openSessionId
        ? this.applied?.rules
        : this.children.get(child.parentID)?.rules
    if (!parentRules) return
    const parentKey = JSON.stringify(parentRules)
    if (!force && !child.unpatched && child.parentKey === parentKey) return
    const agent = this.agentInfo(child.agent)
    if (!agent)
      logger.warn(
        'OpencodeSession',
        `subagent ${child.agent ?? '(default)'}: agent rules unknown — the child gets the parent's rules (its agent's own rules still hold in the plugin hook)`
      )
    const rules = childSessionRuleset(parentRules, agent?.permissions ?? [])
    child.rules = rules
    child.parentKey = parentKey
    const key = JSON.stringify(rules)
    if (child.patchedKey !== key || child.unpatched) {
      let failure: unknown
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await client.setSessionPermissions(childID, rules)
          failure = undefined
          break
        } catch (err) {
          failure = err
        }
      }
      if (failure === undefined) {
        child.patchedKey = key
        child.unpatched = false
      } else {
        // FAIL CLOSED: a child left on a stale (looser) snapshot must not run on.
        child.unpatched = true
        logger.error(
          'OpencodeSession',
          `child ruleset PATCH failed twice (${childID}) — interrupting it: ${errText(failure)}`
        )
        void Promise.resolve()
          .then(() => client.interrupt(childID))
          .catch((err) => logger.warn('OpencodeSession', `child interrupt failed: ${errText(err)}`))
      }
    }
    for (const [grandchildID, grandchild] of this.children)
      if (grandchild.parentID === childID) void this.patchChild(grandchildID)
  }

  /**
   * A resumed chat's children from an earlier process (any of them can be
   * resumed by a later call with its `sessionID`): learn them all and bring
   * their rulesets to this process's parent rules.
   */
  private async adoptStoredChildren(): Promise<void> {
    const client = this.client
    const own = this.openSessionId
    if (!client || !own) return
    this.adoptChildrenOnConnect = false
    const queue = [own]
    for (let read = 0; queue.length > 0 && read < MAX_ADOPTED_CHILD_READS; read++) {
      const parentID = queue.shift()!
      let listed: Session_Info[]
      try {
        listed = await client.listSessions({ parentID })
      } catch (err) {
        logger.debug('OpencodeSession', `children of ${parentID} not listed: ${errText(err)}`)
        continue
      }
      for (const info of listed) {
        if (this.children.has(info.id) || info.id === own) continue
        this.children.set(info.id, {
          parentID,
          chain: Promise.resolve(),
          ...(info.agent ? { agent: info.agent } : {})
        })
        queue.push(info.id)
      }
    }
  }

  /** A re-read linked children whose `session.created` fell in a gap: learn and PATCH them. */
  private async adoptUnknownChildren(): Promise<void> {
    const client = this.client
    const mapper = this.mapper
    if (!client || !mapper) return
    for (const id of mapper.followedSessions()) {
      if (id === this.openSessionId || this.children.has(id)) continue
      try {
        const info = await client.getSession(id)
        if (!info.parentID) continue
        this.onSessionCreated({
          sessionID: id,
          parentID: info.parentID,
          ...(info.agent ? { agent: info.agent } : {})
        })
      } catch (err) {
        logger.debug('OpencodeSession', `child ${id} not readable: ${errText(err)}`)
      }
    }
  }

  // ── Auto mode (full) LLM permission gatekeeper (ADR-023) ──────────────────

  private autoModeConfig(): AutoModeConfig {
    if (this._autoModeConfig === undefined) {
      try {
        this._autoModeConfig = loadEngineConfig('opencode').autoMode ?? {}
      } catch {
        this._autoModeConfig = {}
      }
    }
    return this._autoModeConfig
  }

  private sharedAutoModeConfig(): SharedAutoModeConfig {
    if (this._sharedAutoMode === undefined) {
      try {
        this._sharedAutoMode = loadSharedAutoModeConfig()
      } catch {
        this._sharedAutoMode = {}
      }
    }
    return this._sharedAutoMode
  }

  /** The user's compiled rules (all tiers), compiled on demand before the first apply. */
  private userOriginRules(): OpencodePermissionRule[] {
    if (this.lastUserRules === null) {
      this.lastUserRules = compileClaudeRulesV2(this.mergedUserPermissions(), {
        mcpServers: this.knownMcpServers ?? this.staticMcpServers(),
        cwd: this.cwd,
        ...(this.worktree ? { worktree: this.worktree } : {})
      })
    }
    return asHostPrecheckRules(this.lastUserRules)
  }

  private recordToolOutcome(toolUseId: string, outcome: ToolOutcome): void {
    recordToolOutcome(this.toolOutcomes, toolUseId, outcome)
  }

  private async sessionGitRemotes(): Promise<GitRemote[]> {
    if (this.sessionRemotes) return this.sessionRemotes
    this.sessionRemotesPromise ??= captureGitRemotes(this.cwd)
    this.sessionRemotes = await this.sessionRemotesPromise
    return this.sessionRemotes
  }

  private async sessionVisibility(): Promise<RepoVisibility> {
    if (this.sessionRepoVisibility) return this.sessionRepoVisibility
    this.sessionRepoVisibilityPromise ??= captureRepoVisibility(this.cwd)
    this.sessionRepoVisibility = await this.sessionRepoVisibilityPromise
    return this.sessionRepoVisibility
  }

  private async classifierEnvironment(): Promise<EnvironmentInfo> {
    const remotes = await this.sessionGitRemotes()
    return buildClassifierEnvironment({
      cwd: this.cwd,
      platform: process.platform,
      remotes,
      repoVisibility: this.sessionRepoVisibility,
      permissions: this.mergedUserPermissions(),
      shared: this.sharedAutoModeConfig()
    })
  }

  /** Measured ground truth for a shell action (absence is never "fine"). */
  private async captureActionMeta(
    toolName: string,
    input: Record<string, unknown>
  ): Promise<Record<string, unknown> | undefined> {
    const command = shellCommandOf(toolName, input)
    if (!command) return undefined
    const meta: Record<string, unknown> = {}
    if (needsGitStatus(command)) {
      const gitStatus = await captureGitStatus(this.cwd)
      if (gitStatus) meta.gitStatus = gitStatus
    }
    if (needsRepoVisibility(command)) meta.repoVisibility = await this.sessionVisibility()
    const redirects = analyzeRedirects(command, {
      cwd: this.cwd,
      tempDirs: tempDirRoots(),
      additionalDirectories: this.mergedUserPermissions().additionalDirectories
    })
    if (redirects) meta.redirects = redirects
    if (hasGitSegment(command)) {
      const runIn = effectiveShellCwd(this.cwd, input, true)
      const armed = runIn === null ? null : await captureGitConfigArmed(runIn)
      if (armed && armed.length > 0) meta.gitConfigArmed = armed
    }
    return Object.keys(meta).length > 0 ? meta : undefined
  }

  /**
   * The read-only gate's input (ADR-084 §1): the shell call's own input. 2.x
   * publishes `session.tool.called` (with the input) BEFORE it runs the tool
   * (`runner/step.ts`), so the ask always carries it — no wait as in 1.x.
   */
  private readOnlyInput(approval: PendingApproval): Record<string, unknown> | null {
    if (!isShellToolName(approval.toolName)) return null
    if (!this.isAutoMode(this.permissionMode)) return null
    const input = approval.input as Record<string, unknown> | undefined
    if (!input || typeof input.command !== 'string') {
      logger.debug('OpencodeSession', 'auto-mode read-only bypass refused (input:unverified)')
      return null
    }
    return input
  }

  /** What the allow-rule skip checks for this ask, or undefined (the judge decides). */
  private allowRuleAction(
    approval: PendingApproval
  ): { action: AllowSkipAction; mcpToolKey?: (ruleTool: string) => string } | undefined {
    const category = approval.toolName
    const patterns = approval.patterns ?? []
    const input = (approval.input ?? {}) as Record<string, unknown>
    const str = (v: unknown): string | undefined =>
      typeof v === 'string' && v !== '' ? v : undefined
    if (isShellToolName(category)) {
      const command = input.command
      if (typeof command !== 'string') return undefined
      const workdir = input.workdir
      if (workdir !== undefined && workdir !== null && typeof workdir !== 'string') return undefined
      const dir = str(workdir)
      return { action: { kind: 'shell', command, ...(dir ? { workdir: dir } : {}) } }
    }
    switch (category) {
      case 'webfetch': {
        const url = str(input.url) ?? str(patterns[0])
        return url ? { action: { kind: 'webfetch', url } } : undefined
      }
      case 'websearch':
        return { action: { kind: 'websearch' } }
      case 'skill': {
        const name = str(patterns[0])
        return name ? { action: { kind: 'skill', name } } : undefined
      }
    }
    // An MCP tool asks under `<server>_<tool>` (2.x `tool/mcp.ts`).
    if (isV2BuiltinAction((key) => key === category) || !this.knownMcpServers) return undefined
    const servers = this.knownMcpServers.filter((s) =>
      category.startsWith(opencodeMcpKey(s).slice(0, -1))
    )
    if (servers.length !== 1) return undefined
    const server = servers[0]
    const tool = category.slice(opencodeMcpKey(server).length - 1)
    return tool ? { action: { kind: 'mcp', server, tool }, mcpToolKey: sanitizeMcpName } : undefined
  }

  private isAutoMode(mode: string): boolean {
    return (mode === 'full' || mode === 'auto') && this.autoModeConfig().enabled !== false
  }

  /** A CONFIGURED judge model opencode no longer offers: fail closed to the human. */
  private judgeModelUnavailable(): boolean {
    const configured = this.autoModeConfig().judgeModel
    if (!configured) return false
    const all = (peekOpencodeModels() ?? []).flatMap((g) => g.models)
    if (all.length === 0) return false
    if (all.some((m) => m.value === configured)) return false
    if (!this.staleJudgeModelReported) {
      this.staleJudgeModelReported = true
      this.send(
        'session:error',
        `Auto-mode judge model "${configured}" is no longer available — every gated action will ask you instead. ` +
          `Change it in Settings › Sessions & autonomy › Auto-mode judge (opencode).`
      )
    }
    return true
  }

  private reportJudgeRouteUnavailable(reason: string): void {
    if (this.judgeRouteUnavailableReported) return
    this.judgeRouteUnavailableReported = true
    this.send('session:error', judgeRouteUnavailableMessage('opencode', reason))
  }

  /** ClaudeUI's own judge call (ADR-081), on `autoMode.judgeModel` or the session's model. */
  private makeJudgeFn(): JudgeTransport | null {
    if (this.judgeModelUnavailable()) return null
    return makeSessionJudgeTransport({
      engine: 'opencode',
      modelValue: () => this.autoModeConfig().judgeModel ?? this._model,
      sessionId: () => this.openSessionId,
      routingId: this.routingId,
      onUnavailable: (reason) => this.reportJudgeRouteUnavailable(reason)
    })
  }

  // ── ADR-085: host pre-check + session allows ───────────────────────────────

  /**
   * Route one permission ask (own or a child's): the host pre-check ladder
   * (deny rules, plan mode, user ask rules, session allows — ADR-085), then
   * the judge in auto mode or the card. An `external_directory` ask is an
   * ordinary ask here (card, or the judge in auto mode). 2.x children inherit
   * the parent's rules, so the 1.x parent rung is not used.
   */
  private routePermissionAsk(approval: PendingApproval): void {
    const category = approval.toolName
    const autoMode = this.isAutoMode(this.permissionMode)
    const verdict = hostPrecheck(approval, this.precheckContext())
    if (approval.subagent) {
      logger.debug(
        'OpencodeSession',
        `child ask ${category} from subagent session ${approval.subagent.sessionId} → ${verdict.kind}`
      )
    }
    switch (verdict.kind) {
      case 'deny':
        this.denyByRule(approval, verdict.rule)
        return
      case 'plan-refuse':
        this.autoReply(approval.requestId, {
          decision: 'reject',
          message: PLAN_MODE_DENY_REASON_NO_EXIT_TOOL
        })
        logger.info(
          'OpencodeSession',
          `plan mode refused ${category}${approval.subagent ? ' (subagent)' : ''}`
        )
        if (approval.toolUseId && !approval.subagent)
          this.sendDenial(approval.toolUseId, 'mode', PLAN_MODE_DENY_REASON_NO_EXIT_TOOL)
        return
      case 'user-ask': {
        const pending = this.pendingApprovals.get(approval.requestId)
        if (pending) pending.sweepable = false
        if (autoMode) {
          logger.info(
            'OpencodeSession',
            `auto-mode → human: user ask rule matches ${category}${verdict.rule ? ` (rule ${verdict.rule})` : ''}`
          )
          this.fallbackToHuman(approval)
        } else {
          this.send('session:approval-request', approval)
        }
        return
      }
      case 'session-allow':
        if (!this.sessionAllowApplies(approval)) break
        logger.debug('OpencodeSession', `session allow ${category}`)
        this.autoReply(approval.requestId, { decision: 'once' })
        return
      case 'allow-rule':
        logger.info(
          'OpencodeSession',
          `plan mode: allow rule covers a read-only ${category} (rule ${verdict.rule})`
        )
        this.autoReply(approval.requestId, { decision: 'once' })
        return
      case 'parent-allow':
        this.autoReply(approval.requestId, { decision: 'once' })
        return
      case 'continue':
        break
    }
    if (autoMode) void this.handleAutoModeApproval(approval)
    else this.send('session:approval-request', approval)
  }

  private precheckContext(): HostPrecheckContext {
    const permissions = this.mergedUserPermissions()
    return {
      mode: this.permissionMode,
      rules: { deny: permissions.deny, ask: permissions.ask, allow: permissions.allow },
      cwd: this.cwd,
      additionalDirectories: permissions.additionalDirectories,
      userRules: this.userOriginRules(),
      sessionAllows: this.sessionAllows,
      onError: (err) =>
        logger.warn('OpencodeSession', `host pre-check failed — asking the human: ${errText(err)}`)
    }
  }

  /** The subagent call that spawned a child (its 2.x input: `agent`, `description`, `prompt`). */
  private subagentTask(marker: {
    parentToolUseId: string
  }): { type: string; description?: string; prompt?: string } | undefined {
    const input = this.toolInputs.get(marker.parentToolUseId)
    if (!input) return undefined
    const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
    const description = str(input.description)
    const prompt = str(input.prompt)
    return {
      type: str(input.agent) ?? str(input.subagent_type) ?? 'unknown',
      ...(description !== undefined ? { description } : {}),
      ...(prompt !== undefined ? { prompt } : {})
    }
  }

  /** An auto-mode edit on an agent-control path always sees the gate/judge (ADR-084 §3). */
  private sessionAllowApplies(approval: PendingApproval): boolean {
    return !(
      this.isAutoMode(this.permissionMode) &&
      approval.toolName === 'edit' &&
      !editClearsAgentControl(approval.patterns, approval.input, this.cwd)
    )
  }

  /** Refuse an ask a user deny rule hits, with the rule as the reason. */
  private denyByRule(approval: PendingApproval, rule: string): void {
    const reason = `Denied by permission rule: ${rule}`
    this.autoReply(approval.requestId, { decision: 'reject', message: reason })
    logger.info('OpencodeSession', `permission rule deny ${approval.toolName} — ${rule}`)
    if (approval.toolUseId && !approval.subagent)
      this.sendDenial(approval.toolUseId, 'rule', reason)
  }

  /** A host denial on the call's card (its `tool_use` is already out: tool.called precedes the ask). */
  private sendDenial(
    toolUseId: string,
    source: PermissionDenialBlock['source'],
    reason: string
  ): void {
    const clipped = reviewRationale(reason)
    const denial: PermissionDenialBlock = {
      type: 'permission_denial',
      toolUseId,
      denialId: uuid(),
      source,
      ...(clipped ? { reason: clipped } : {})
    }
    this.send('session:permission-denial', { toolUseId, denial })
  }

  /** Answer every pending ask (own and child) a new session allow covers. */
  private sweepSessionAllows(): void {
    if (this.sessionAllows.size === 0 || this.pendingApprovals.size === 0) return
    const ctx = this.precheckContext()
    for (const [requestId, rec] of [...this.pendingApprovals]) {
      if (!rec.sweepable) continue
      if (hostPrecheck(rec.approval, ctx).kind !== 'session-allow') continue
      if (!this.sessionAllowApplies(rec.approval)) continue
      logger.debug('OpencodeSession', `session allow ${rec.approval.toolName} — pending ask swept`)
      this.autoReply(requestId, { decision: 'once' })
    }
  }

  /** The auto-mode decision: the edit fast path, then the shared judge pipeline (ADR-088). */
  private async handleAutoModeApproval(approval: PendingApproval): Promise<void> {
    const category = approval.toolName
    if (
      category === 'edit' &&
      editClearsAgentControl(approval.patterns, approval.input, this.cwd)
    ) {
      this.autoReply(approval.requestId, { decision: 'once' })
      return
    }
    let transport: JudgeTransport | null = null
    const outcome = await runJudgePipeline(
      { toolUseId: approval.toolUseId ?? '', toolName: category, input: approval.input },
      {
        logSource: 'OpencodeSession',
        cwd: this.cwd,
        currentMode: () => this.permissionMode,
        autoModeActive: () => this.isAutoMode(this.permissionMode),
        permissions: () => this.mergedUserPermissions(),
        honoursWorkdir: true,
        inputFor: async (stage) =>
          stage === 'read-only' ? this.readOnlyInput(approval) : approval.input,
        allowRuleAction: () => this.allowRuleAction(approval)?.action,
        mcpToolKey: sanitizeMcpName,
        subagent: approval.subagent
          ? (this.subagentTask(approval.subagent) ?? { type: 'unknown' })
          : undefined,
        judgeAvailable: () => {
          transport = this.makeJudgeFn()
          return transport !== null
        },
        judgeTransport: () => transport!,
        messages: () => this.messageHistory,
        environment: () => this.classifierEnvironment(),
        captureActionMeta: (name, input) => this.captureActionMeta(name, input),
        outcomes: () =>
          this.toolOutcomes.size ? Object.fromEntries(this.toolOutcomes) : undefined,
        denials: this.autoDenials,
        twoStageMode: () => this.autoModeConfig().twoStageMode ?? 'both',
        sendReview: (_id, review) => this.sendToolReview(approval.toolUseId, review),
        consumeGrant: (name, input) =>
          this.blockedCalls.consumeGrant(blockGrantKey('opencode', name, input, this.cwd, true)),
        stillPending: (stage) => {
          if (this.pendingApprovals.has(approval.requestId)) return true
          logger.debug('OpencodeSession', `auto-mode ${stage}: ask already settled — not replying`)
          return false
        }
      }
    )
    switch (outcome.kind) {
      case 'allow':
        this.autoReply(approval.requestId, { decision: 'once' })
        return
      case 'hold':
        this.holdBlock(approval, outcome.reason, outcome.review)
        return
      case 'human':
        this.fallbackToHuman(approval, outcome.reason)
        return
      case 'settled':
        return
    }
  }

  /** The judge's verdict (or a static review) on the call's card. */
  private sendToolReview(
    toolUseId: string | undefined,
    result: ClassifyResult | 'read-only' | { allowRule: string }
  ): ToolReviewBlock | undefined {
    if (!toolUseId) return undefined
    const reviewId = uuid()
    const review =
      result === 'read-only'
        ? readOnlyReviewBlock(toolUseId, reviewId)
        : 'allowRule' in result
          ? allowRuleReviewBlock(toolUseId, reviewId, result.allowRule)
          : autoModeReviewBlock(toolUseId, reviewId, result)
    this.send('session:tool-review', { toolUseId, review })
    return review
  }

  private fallbackToHuman(approval: PendingApproval, decisionReason?: string): void {
    this.send(
      'session:approval-request',
      decisionReason ? { ...approval, decisionReason } : approval
    )
  }

  /** A judge block (ADR-091 §3): kept at once, or held on the card for the user's window. */
  private holdBlock(approval: PendingApproval, reason: string, review?: ToolReviewBlock): void {
    const rec = this.pendingApprovals.get(approval.requestId)
    if (!rec) return
    const { requestId } = approval
    const ms = blockHoldMs()
    if (review && approval.toolUseId) {
      const task = approval.subagent ? this.subagentTask(approval.subagent) : undefined
      const agentLabel = approval.subagent ? (task?.description ?? task?.type) : undefined
      this.blockedCalls.record(
        approval.toolUseId,
        {
          toolName: approval.toolName,
          input: approval.input,
          review,
          grantKey: blockGrantKey('opencode', approval.toolName, approval.input, this.cwd, true),
          ...(agentLabel ? { agentLabel } : {})
        },
        ms > 0
      )
    }
    if (ms === 0) {
      this.keepBlocked(requestId, approval.toolUseId, reason)
      return
    }
    const timer = armBlockHold(() => {
      this.resolveApproval(requestId, 'deny')
      this.send('session:approval-dismiss', { requestId })
    }, ms)
    rec.hold = { reason, cancel: timer.cancel }
    rec.sweepable = false
    const { suggestions: _suggestions, ...card } = approval
    this.send('session:approval-request', {
      ...card,
      autoModeBlock: { expiresAt: timer.expiresAt },
      decisionReason: reason
    } satisfies PendingApproval)
  }

  /** A judge block that stands: the model reads the judge's text. */
  private keepBlocked(requestId: string, toolUseId: string | undefined, reason: string): void {
    if (toolUseId) this.recordToolOutcome(toolUseId, 'automode-blocked')
    this.autoReply(requestId, { decision: 'reject', message: reason })
  }

  /** The ONE way an ask leaves `pendingApprovals` (disarms a held block). */
  private takePendingAsk(requestId: string): PendingAsk | undefined {
    const rec = this.pendingApprovals.get(requestId)
    if (!rec) return undefined
    this.pendingApprovals.delete(requestId)
    if (rec.hold) {
      rec.hold.cancel()
      if (rec.toolUseId) this.blockedCalls.settle(rec.toolUseId)
    }
    return rec
  }

  private dropBlockHolds(): void {
    for (const [requestId, rec] of [...this.pendingApprovals]) {
      if (!rec.hold) continue
      this.takePendingAsk(requestId)
      this.send('session:approval-dismiss', { requestId })
    }
  }

  // ── Side question ──────────────────────────────────────────────────────────

  /**
   * `/btw`: one transient completion (`POST …/generate`, 240 s) — from this
   * chat's own context when its opencode session exists (nothing is written
   * to its history), else from a throwaway session with every tool hidden.
   * Never throws.
   */
  override async askSideQuestion(question: string): Promise<string | null> {
    try {
      await this.ensureConnected()
      const client = this.client
      if (!client || this._cancelled) return null
      const prompt = `Answer the following question concisely and directly. Do not use tools.\n\n${question}`
      if (this.openSessionId) {
        // Never switch the model under a running turn: then the question rides
        // the session's current model. Idle, the switch is the one the next
        // prompt makes anyway.
        if (!this.isProcessing) await this.syncModel().catch(() => {})
        return (await client.generate(this.openSessionId, prompt)).trim() || null
      }
      const throwaway = await client.createSession({
        title: 'side-question',
        model: this.modelRef(),
        permissions: [...THROWAWAY_RULESET]
      })
      try {
        return (await client.generate(throwaway.id, prompt)).trim() || null
      } finally {
        // Awaited: the data dir is shared with the user's own opencode.
        await client.deleteSession(throwaway.id).catch((err) => {
          logger.warn('OpencodeSession', `side-question session not deleted: ${errText(err)}`)
        })
      }
    } catch (err) {
      logger.warn('OpencodeSession', `askSideQuestion failed: ${errText(err)}`)
      return null
    }
  }

  // ── Status, cost, metering ─────────────────────────────────────────────────

  sendStatus(): void {
    this.send('session:status', this.status)
  }

  private rememberOpencodeMessage(message: ChatMessage): void {
    const index = this.messageHistory.findIndex((entry) => entry.id === message.id)
    if (index >= 0) this.messageHistory[index] = message
    else this.messageHistory.push(message)
  }

  private rememberAndSend(message: ChatMessage): void {
    this.rememberOpencodeMessage(message)
    this.send('session:message', message)
  }

  private addLiveUsage(
    providerID: string,
    modelID: string,
    cost: number,
    tokens: OpencodeStepUsage['tokens'],
    context: boolean
  ): void {
    this.liveUsage.push({
      inputs: opencodeCostInputs(providerID, modelID, tokens, cost),
      modelId: modelID,
      engineCostUsd: cost,
      tokens: tokensOf(tokens)
    })
    if (context) this.lastContextLength = tokens.input + tokens.cache.read
  }

  /**
   * One step's usage (own or a child's — Claude's status line folds subagent
   * spend in, S4): the headline, the context meter (own steps only) and one
   * ledger row per step, under the model that ran it.
   */
  private meterStep(u: OpencodeStepUsage): void {
    const fallback = parseModelString(this._model)
    const providerID = u.model?.providerID ?? fallback.providerID
    const modelID = u.model?.id ?? fallback.modelID
    const child = u.ownerToolUseId !== undefined
    this.addLiveUsage(providerID, modelID, u.cost, u.tokens, !child)
    const account = opencodeAuthProvider.buildAccountRef(providerID)
    const identity: AccountIdentity = opencodeAuthProvider.accountIdentity(providerID)
    const t = tokensOf(u.tokens)
    recordUsageEvent({
      engineId: 'opencode',
      vendorId: providerID,
      accountId: account?.accountId ?? null,
      accountUuid: null,
      modelId: modelID,
      tokens: {
        input: t.input,
        output: t.output,
        cacheWrite: t.cacheWrite,
        cacheWrite1h: 0,
        cacheRead: t.cacheRead
      },
      engineCostUsd: u.cost,
      sessionId: u.sessionId,
      messageId: u.messageId,
      source: 'live',
      accountKey: identity.accountKey,
      accountLabel: identity.accountLabel,
      billingType: account?.billingType ?? 'unknown',
      origin: child ? 'child' : 'session',
      parentRoutingId: child ? this.routingId : null,
      engineCostIsEquivalent: false
    })
    this.sendStatusLine()
  }

  private costTally(): TotalCosts {
    return totalCosts(
      [...this.costBase, ...this.liveUsage.map((u) => u.inputs)].map(resolveOpencodeCosts)
    )
  }

  private get totalCostUsd(): number | null {
    return this.costTally().displayCostUsd
  }

  private get engineReportedCostUsd(): number {
    return this.rawCostBaseUsd + this.liveUsage.reduce((sum, u) => sum + u.engineCostUsd, 0)
  }

  private get modelCostEntries(): ModelCostEntry[] {
    const merged = new Map<string, number>(this.modelCostBase)
    for (const usage of this.liveUsage) {
      const display = resolveOpencodeCosts(usage.inputs).displayCostUsd
      if (display === null) continue
      merged.set(usage.modelId, (merged.get(usage.modelId) ?? 0) + display)
    }
    return [...merged.entries()].map(([modelId, costUsd]) => ({
      engineId: 'opencode' as const,
      modelId,
      costUsd
    }))
  }

  /** This process's tokens (the status line adds the history base). */
  private sumLiveTokens(): OpencodeHistoryTokens {
    const sum: OpencodeHistoryTokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }
    for (const { tokens } of this.liveUsage) {
      sum.input += tokens.input
      sum.output += tokens.output
      sum.cacheWrite += tokens.cacheWrite
      sum.cacheRead += tokens.cacheRead
    }
    return sum
  }

  private buildStatusLine(): StatusLineData {
    const parsed = parseModelString(this._model)
    const live = this.sumLiveTokens()
    const sum = {
      input: this.tokenBase.input + live.input,
      output: this.tokenBase.output + live.output,
      cacheWrite: this.tokenBase.cacheWrite + live.cacheWrite,
      cacheRead: this.tokenBase.cacheRead + live.cacheRead
    }
    const ctx = getOpencodeModelContextWindow(parsed.providerID, parsed.modelID)
    const usedPercentage =
      ctx > 0 && this.lastContextLength > 0
        ? Math.round((this.lastContextLength / ctx) * 100)
        : null
    const cachedTokens = sum.cacheRead + sum.cacheWrite
    const costs = this.costTally()
    return {
      totalCostUsd: costs.displayCostUsd,
      billedCostUsd: costs.billedCostUsd,
      ...(costs.unknownMessages > 0 ? { unknownCostMessages: costs.unknownMessages } : {}),
      totalDurationMs: this.accTotalDurationMs,
      totalApiDurationMs: 0,
      totalInputTokens: sum.input,
      totalOutputTokens: sum.output,
      cachedTokens,
      totalTokens: sum.input + sum.output + cachedTokens,
      contextWindow: { used: this.lastContextLength, size: ctx },
      usedPercentage,
      remainingPercentage: usedPercentage !== null ? 100 - usedPercentage : null,
      turnStartedAtMs: this.isProcessing && this.startTimeMs > 0 ? this.startTimeMs : null,
      modelCosts: [...this.modelCostEntries, ...this.dispatchedCostEntries()]
    }
  }

  private sendStatusLine(): void {
    this.send('session:status-line', this.buildStatusLine())
  }

  /** The engine-neutral MeteringSnapshot (cumulative meter; opencode has no window). */
  private sendMetering(): void {
    try {
      const parsed = parseModelString(this._model)
      const account = opencodeAuthProvider.buildAccountRef(parsed.providerID)
      const { input, output, cacheWrite, cacheRead } = this.sumLiveTokens()
      const snapshot: MeteringSnapshot = {
        engineId: 'opencode',
        vendorId: parsed.providerID,
        billingType: account?.billingType ?? 'unknown',
        tokens: {
          input,
          output,
          cacheWrite,
          cacheRead,
          total: input + output + cacheWrite + cacheRead
        },
        equivalentCostUsd: equivalentCostUsd(parsed.providerID, parsed.modelID, {
          inputTokens: input,
          outputTokens: output,
          cacheWriteTokens: cacheWrite,
          cacheWrite1hTokens: 0,
          cacheReadTokens: cacheRead
        }),
        engineReportedCostUsd: this.engineReportedCostUsd,
        contextWindow: {
          used: this.lastContextLength,
          size: getOpencodeModelContextWindow(parsed.providerID, parsed.modelID)
        }
      }
      this.send('session:metering', snapshot)
    } catch {
      /* advisory — never breaks the turn */
    }
  }

  discoverSkills(cwd: string): Promise<SkillInfo[]> {
    return discoverOpencodeSkills(cwd)
  }
}
